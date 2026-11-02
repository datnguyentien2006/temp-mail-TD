/**
 * Resend inbound provider (RECEIVE-ONLY).
 *
 * How it works:
 *  - Mail is *received* by Resend at a verified domain (or the account's
 *    `<id>.resend.app` subdomain). Resend has no per-address inbox object: it
 *    fires an `email.received` webhook for every message, to any username.
 *  - Creating a mailbox here is VIRTUAL: we only validate the address and store
 *    a normal mailbox record. No Resend API call is made to create it.
 *  - When the webhook fires, `handleReceivedEvent` looks up an active, owned
 *    mailbox for each recipient (`to`/`cc`/`bcc`). Unknown or expired addresses
 *    are dropped SILENTLY. For known mailboxes it fetches the body over the
 *    receiving API, sanitises it and stores it like any other provider.
 *
 * This module never sends mail. There is no reply/forward/compose path anywhere.
 *
 * Secrets (`apiKey`, `webhookSecret`) live only in config, are used only here
 * and in the webhook router, and are never logged or serialised.
 */
import { htmlToText, sanitizeEmailHtml } from '../sanitize.js';
import {
  buildAddress,
  normalizeLocalPart,
  randomLocalPart,
  validateDomain,
  validateLocalPart,
} from '../mailboxes.js';
import { providerError } from './errors.js';
import { QuotaTracker } from './quota.js';
import { createResendClient } from './resend-client.js';
import { verifySvixSignature } from './svix.js';

const RECIPIENT_FIELDS = ['to', 'cc', 'bcc'];

/** Collect the unique recipient addresses Resend reported for a message. */
export function recipientsOf(data) {
  const out = [];
  for (const field of RECIPIENT_FIELDS) {
    const value = data?.[field];
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      const address = String(item ?? '').trim().toLowerCase();
      if (address.includes('@') && !out.includes(address)) out.push(address);
    }
  }
  return out;
}

/**
 * Normalise a Resend received-email object into this app's message model.
 * The body is treated as untrusted and the HTML is sanitised server-side.
 *
 * @param {object} body result of GET /emails/receiving/{id}
 * @param {{recipient: string, fallback?: object}} options
 */
export function normaliseReceivedEmail(body, { recipient, fallback = {} } = {}) {
  const headers = body?.headers && typeof body.headers === 'object' ? body.headers : {};
  const from = String(headers.from || body?.from || fallback?.from || 'unknown@unknown');

  const rawHtml = typeof body?.html === 'string' ? body.html : '';
  const html = sanitizeEmailHtml(rawHtml);
  const text =
    typeof body?.text === 'string' && body.text.length > 0 ? body.text : htmlToText(rawHtml);

  const createdRaw = body?.created_at || fallback?.created_at;
  const parsed = createdRaw ? Date.parse(createdRaw) : NaN;
  const receivedAt = Number.isFinite(parsed) ? parsed : Date.now();

  const attachments = Array.isArray(body?.attachments)
    ? body.attachments
    : Array.isArray(fallback?.attachments)
      ? fallback.attachments
      : [];

  const emailId = String(body?.id || fallback?.email_id || '').trim();

  return {
    id: `r-${emailId}`,
    providerMessageId: emailId,
    from,
    to: recipient,
    subject: String(body?.subject || fallback?.subject || '(no subject)'),
    date: new Date(receivedAt).toISOString(),
    receivedAt,
    text: String(text || ''),
    html,
    // Metadata only: the app never downloads the bytes.
    attachments: attachments.map((attachment) => ({
      filename: String(attachment?.filename || 'attachment'),
      contentType: String(attachment?.content_type || attachment?.contentType || 'application/octet-stream'),
      size: Number(attachment?.size) || 0,
      contentId: attachment?.content_id ?? null,
      contentDisposition: attachment?.content_disposition ?? null,
    })),
    authentication: body?.authentication ?? null,
    size: Buffer.byteLength(rawHtml || text || '', 'utf8'),
    bodyLoaded: true,
  };
}

export function createResendProvider({ store, config, client, logger = console } = {}) {
  const cfg = config.resend;
  const api = client ?? createResendClient(cfg);
  const quota = new QuotaTracker({
    dailyLimit: cfg.dailyLimit,
    monthlyLimit: cfg.monthlyLimit,
    softLimitRatio: cfg.softLimitRatio,
  });

  /** email_id -> expiry timestamp, so webhook retries are processed once. */
  const seen = new Map();

  function isResend(mailbox) {
    return mailbox?.provider === 'resend';
  }

  function note(message) {
    // Never include a body, an address, the API key or the webhook secret.
    logger?.warn?.(`[resend] ${message}`);
  }

  function pruneSeen(now = Date.now()) {
    for (const [id, expiresAt] of seen) {
      if (expiresAt <= now) seen.delete(id);
    }
  }

  function requireMailbox(address, sessionId) {
    const mailbox = store.get(address);
    if (!mailbox || mailbox.sessionId !== sessionId || !isResend(mailbox)) {
      throw providerError(404, 'Mailbox not found.', 'NOT_FOUND');
    }
    return mailbox;
  }

  function providerData(mailbox) {
    if (!mailbox.providerData) mailbox.providerData = {};
    const data = mailbox.providerData;
    if (!(data.senderCounts instanceof Map)) {
      data.senderCounts = new Map(Object.entries(data.senderCounts ?? {}));
    }
    return data;
  }

  /** Current availability, surfaced to the UI through /api/domains. */
  function status() {
    if (!cfg.enabled) return { available: false, reason: 'Provider disabled.' };
    if (!cfg.apiKey) {
      return { available: false, reason: 'RESEND_API_KEY is not configured.' };
    }
    if (!cfg.webhookSecret) {
      return { available: false, reason: 'RESEND_WEBHOOK_SECRET is not configured.' };
    }
    const state = quota.state();
    if (state.level === 'hard') {
      return {
        available: false,
        reason: 'Resend quota reached for this period. Processing is paused.',
        quota: state,
      };
    }
    if (state.level === 'soft') {
      return { available: true, degraded: true, reason: 'Resend quota is nearly reached.', quota: state };
    }
    return { available: true, quota: state };
  }

  /**
   * Process one `email.received` webhook. Resolves even when the message is
   * dropped; it only rejects on an unexpected transport error after retries.
   */
  async function handleReceivedEvent(event) {
    if (!cfg.enabled) return { accepted: false, stored: 0, reason: 'disabled' };

    const data = event?.data ?? {};
    const emailId = String(data.email_id ?? '').trim();
    if (!emailId) {
      note('received a webhook without an email_id');
      return { accepted: false, stored: 0, reason: 'no-id' };
    }

    const now = Date.now();
    pruneSeen(now);
    if (seen.has(emailId)) {
      return { accepted: true, stored: 0, reason: 'duplicate' };
    }

    const recipients = recipientsOf(data);
    const targets = [];
    for (const address of recipients) {
      const mailbox = store.get(address);
      if (mailbox && isResend(mailbox) && mailbox.expiresAt > now && !targets.includes(mailbox)) {
        targets.push(mailbox);
      }
    }

    if (targets.length === 0) {
      // Unknown or expired address: drop silently. Remember the id so a retry
      // is not re-examined, but never reveal that the address is unknown.
      seen.set(emailId, now + cfg.dedupeTtlMs);
      return { accepted: true, stored: 0, reason: 'no-mailbox' };
    }

    const reservation = quota.tryAcquire();
    if (!reservation.allowed) {
      note('quota reached, dropping an inbound message');
      return { accepted: true, stored: 0, reason: 'quota', quota: reservation.state };
    }

    const body = await api.getReceivedEmail(emailId, { htmlFormat: 'data_uri' });
    if (!body) {
      seen.set(emailId, now + cfg.dedupeTtlMs);
      return { accepted: true, stored: 0, reason: 'gone' };
    }

    seen.set(emailId, now + cfg.dedupeTtlMs);

    let stored = 0;
    for (const mailbox of targets) {
      if (!store.has(mailbox.address)) continue; // deleted meanwhile
      if (mailbox.messages.length >= cfg.maxMessagesPerMailbox) {
        note('mailbox is full, dropping a message');
        continue;
      }

      const message = normaliseReceivedEmail(body, { recipient: mailbox.address, fallback: data });
      const data_ = providerData(mailbox);
      const sender = String(message.from || '').toLowerCase();
      const senderCount = data_.senderCounts.get(sender) ?? 0;
      if (cfg.maxMessagesPerSender > 0 && senderCount >= cfg.maxMessagesPerSender) {
        note('per-sender cap reached for a mailbox');
        continue;
      }
      data_.senderCounts.set(sender, senderCount + 1);

      store.addMessage(mailbox.address, message);
      stored += 1;
    }

    return { accepted: true, stored, reason: stored ? 'stored' : 'capped' };
  }

  return {
    id: 'resend',
    label: 'Resend',
    description:
      'Receive-only inboxes on domains verified with Resend. Mail arrives through a Resend receiving webhook and is not operated by this app.',
    capabilities: {
      supportsDomainChoice: true,
      supportsCustomLocalPart: true,
      supportsExtend: true,
      supportsDeleteMessage: true,
      // Attachment bytes are never fetched: metadata only.
      supportsAttachments: false,
      retentionMinutes: cfg.retentionMinutes,
      maxLifetimeMinutes: config.maxMailboxLifetimeMinutes,
      liveUpdates: 'webhook',
    },

    listDomains() {
      return [...cfg.domains];
    },

    status,

    async createMailbox({ sessionId, localPart: rawLocal, domain: rawDomain }) {
      const state = status();
      if (!state.available) {
        throw providerError(503, state.reason || 'The Resend provider is unavailable.', 'PROVIDER_UNAVAILABLE');
      }

      // --- domain: choose randomly or validate against RESEND_DOMAINS ----
      let domain;
      if (rawDomain === undefined || rawDomain === null || String(rawDomain).trim() === '') {
        domain = cfg.domains[Math.floor(Math.random() * cfg.domains.length)];
      } else {
        const result = validateDomain(rawDomain, cfg.domains);
        if (!result.ok) throw providerError(400, result.error, 'INVALID_DOMAIN');
        domain = result.domain;
      }

      // --- local part: same rules as the self-hosted provider ------------
      let localPart;
      const custom = rawLocal !== undefined && rawLocal !== null && String(rawLocal).trim() !== '';
      if (custom) {
        localPart = normalizeLocalPart(rawLocal);
        const result = validateLocalPart(localPart);
        if (!result.ok) throw providerError(400, result.error, 'INVALID_LOCAL_PART');
      } else {
        let attempts = 0;
        do {
          localPart = randomLocalPart(config.randomLocalPartLength);
          attempts += 1;
        } while (store.has(buildAddress(localPart, domain)) && attempts < 25);
      }

      const address = buildAddress(localPart, domain);
      if (store.has(address)) {
        throw providerError(
          409,
          `"${address}" is already taken. Try another local part.`,
          'ADDRESS_TAKEN',
        );
      }

      // The mailbox is virtual: no Resend API call is made here.
      try {
        return store.createMailbox({
          address,
          localPart,
          domain,
          sessionId,
          provider: 'resend',
          providerData: { senderCounts: new Map() },
        });
      } catch (error) {
        if (error.code === 'TOO_MANY_MAILBOXES') {
          throw providerError(429, error.message, 'TOO_MANY_MAILBOXES');
        }
        if (error.code === 'ADDRESS_TAKEN') {
          throw providerError(409, error.message, 'ADDRESS_TAKEN');
        }
        throw error;
      }
    },

    listMailboxes(sessionId) {
      return store.listForSession(sessionId).filter(isResend);
    },

    getMailbox(address, sessionId) {
      return requireMailbox(address, sessionId);
    },

    async listMessages(address, sessionId) {
      return requireMailbox(address, sessionId).messages;
    },

    async getMessage(address, sessionId, messageId) {
      requireMailbox(address, sessionId);
      const message = store.getMessage(address, messageId);
      if (!message) throw providerError(404, 'Message not found.', 'MESSAGE_NOT_FOUND');
      return message;
    },

    async deleteMessage(address, sessionId, messageId) {
      requireMailbox(address, sessionId);
      // Local only: Resend exposes no delete-received-email endpoint.
      if (!store.deleteMessage(address, messageId)) {
        throw providerError(404, 'Message not found.', 'MESSAGE_NOT_FOUND');
      }
    },

    async deleteMailbox(address, sessionId) {
      requireMailbox(address, sessionId);
      store.deleteMailbox(address);
    },

    async extendMailbox(address, sessionId) {
      requireMailbox(address, sessionId);
      const mailbox = store.extendMailbox(address, {
        ttlMs: config.ttlMs,
        maxLifetimeMs: config.maxMailboxLifetimeMs,
      });
      if (!mailbox) throw providerError(404, 'Mailbox not found.', 'NOT_FOUND');
      return mailbox;
    },

    async getAttachment(address, sessionId) {
      requireMailbox(address, sessionId);
      throw providerError(
        400,
        'Resend attachments are exposed as metadata only; downloads are not supported.',
        'ATTACHMENT_UNAVAILABLE',
      );
    },

    markSessionActive() {
      // Nothing to poll: mail is pushed by webhook.
    },

    /** Verify a webhook request against the raw body and the signing secret. */
    verifyWebhook(payload, headers) {
      if (!cfg.webhookSecret) return { ok: false, reason: 'no-secret' };
      return verifySvixSignature({
        payload,
        headers,
        secret: cfg.webhookSecret,
        toleranceMs: cfg.signatureToleranceMs,
      });
    },

    /** Exposed for the webhook router and for manual smoke tests. */
    handleReceivedEvent,
  };
}
