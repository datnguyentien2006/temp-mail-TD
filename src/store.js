/**
 * In-memory mailbox store.
 *
 * Temp mail is disposable by design, so an in-memory store keeps the
 * deployment dependency-free and makes TTL eviction trivial. Swap this class
 * for a Redis/SQLite implementation without touching the HTTP/SMTP layers.
 *
 * Emits:
 *   - 'mailbox:created' (mailbox)
 *   - 'mailbox:deleted' (mailbox)
 *   - 'mailbox:expired' (mailbox)
 *   - 'mailbox:extended' (mailbox)
 *   - 'message'         ({ mailbox, message })
 */
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

export class MailboxStore extends EventEmitter {
  constructor({ ttlMs = 30 * 60 * 1000, maxMailboxesPerSession = Infinity } = {}) {
    super();
    this.ttlMs = ttlMs;
    this.maxMailboxesPerSession = maxMailboxesPerSession;
    /** @type {Map<string, object>} address(lowercase) -> mailbox */
    this.mailboxes = new Map();
    /** @type {Map<string, Set<string>>} sessionId -> Set<address> */
    this.sessions = new Map();
  }

  has(address) {
    return this.mailboxes.has(String(address ?? '').toLowerCase());
  }

  countForSession(sessionId) {
    return this.sessions.get(sessionId)?.size ?? 0;
  }

  createMailbox({ address, localPart, domain, sessionId, ttlMs = this.ttlMs }) {
    const key = String(address).toLowerCase();

    if (this.mailboxes.has(key)) {
      const error = new Error(`Address "${key}" is already in use.`);
      error.code = 'ADDRESS_TAKEN';
      throw error;
    }
    if (this.countForSession(sessionId) >= this.maxMailboxesPerSession) {
      const error = new Error('Too many active mailboxes for this session.');
      error.code = 'TOO_MANY_MAILBOXES';
      throw error;
    }

    const now = Date.now();
    const mailbox = {
      id: randomUUID(),
      address: key,
      localPart,
      domain,
      sessionId,
      createdAt: now,
      expiresAt: now + ttlMs,
      extendCount: 0,
      messages: [],
    };

    this.mailboxes.set(key, mailbox);
    if (!this.sessions.has(sessionId)) this.sessions.set(sessionId, new Set());
    this.sessions.get(sessionId).add(key);

    this.emit('mailbox:created', mailbox);
    return mailbox;
  }

  get(address) {
    return this.mailboxes.get(String(address ?? '').toLowerCase()) ?? null;
  }

  listForSession(sessionId) {
    const addresses = this.sessions.get(sessionId);
    if (!addresses) return [];
    return [...addresses]
      .map((address) => this.mailboxes.get(address))
      .filter(Boolean)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  owns(address, sessionId) {
    const mailbox = this.get(address);
    return Boolean(mailbox && mailbox.sessionId === sessionId);
  }

  /**
   * Push a mailbox's expiry forward by one TTL, never beyond `maxLifetimeMs`
   * measured from its creation. Returns the mailbox, or null if it is unknown.
   */
  extendMailbox(address, { ttlMs = this.ttlMs, maxLifetimeMs = Infinity } = {}) {
    const mailbox = this.get(address);
    if (!mailbox) return null;

    const now = Date.now();
    const hardCap = mailbox.createdAt + maxLifetimeMs;
    const target = Math.min(now + ttlMs, hardCap);

    if (target > mailbox.expiresAt) {
      mailbox.expiresAt = target;
      mailbox.extendCount = (mailbox.extendCount ?? 0) + 1;
      this.emit('mailbox:extended', mailbox);
    }
    return mailbox;
  }

  deleteMailbox(address) {
    const key = String(address ?? '').toLowerCase();
    const mailbox = this.mailboxes.get(key);
    if (!mailbox) return false;
    this.mailboxes.delete(key);
    this.sessions.get(mailbox.sessionId)?.delete(key);
    this.emit('mailbox:deleted', mailbox);
    return true;
  }

  /** @param {string} address @param {object} message fields from the SMTP layer */
  addMessage(address, message) {
    const mailbox = this.get(address);
    if (!mailbox) {
      const error = new Error('Unknown mailbox.');
      error.code = 'NO_MAILBOX';
      throw error;
    }
    const stored = {
      id: randomUUID(),
      receivedAt: Date.now(),
      ...message,
    };
    mailbox.messages.unshift(stored); // newest first
    this.emit('message', { mailbox, message: stored });
    return stored;
  }

  getMessage(address, messageId) {
    const mailbox = this.get(address);
    if (!mailbox) return null;
    return mailbox.messages.find((m) => m.id === messageId) ?? null;
  }

  deleteMessage(address, messageId) {
    const mailbox = this.get(address);
    if (!mailbox) return false;
    const index = mailbox.messages.findIndex((m) => m.id === messageId);
    if (index < 0) return false;
    mailbox.messages.splice(index, 1);
    return true;
  }

  /** Remove every mailbox whose TTL has elapsed. */
  sweep(now = Date.now()) {
    const expired = [];
    for (const [key, mailbox] of this.mailboxes) {
      if (mailbox.expiresAt <= now) {
        this.mailboxes.delete(key);
        this.sessions.get(mailbox.sessionId)?.delete(key);
        expired.push(mailbox);
      }
    }
    for (const mailbox of expired) this.emit('mailbox:expired', mailbox);
    return expired;
  }

  /** Start the periodic cleanup job. Returns the timer (unref'd). */
  startSweeper(intervalMs) {
    const timer = setInterval(() => this.sweep(), intervalMs);
    timer.unref?.();
    return timer;
  }
}
