/**
 * Guerrilla Mail provider.
 *
 * All API calls happen here, server-side. A mailbox keeps its own sid_token in
 * `mailbox.providerData`, which is never serialised to clients. Messages are
 * mirrored into the same MailboxStore used by the self-hosted provider, so the
 * existing tabs / history / timer / WebSocket model works unchanged.
 */
import { normalizeLocalPart, validateLocalPart } from '../mailboxes.js';
import { htmlToText, sanitizeEmailHtml } from '../sanitize.js';
import { providerError } from './errors.js';
import { createGuerrillaClient } from './guerrilla-client.js';

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
};

/** Decode the HTML entities Guerrilla Mail uses in subjects/excerpts. */
export function decodeEntities(value) {
  return String(value ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _m;
    })
    .replace(/&#(\d+);/g, (_m, dec) => {
      const code = Number.parseInt(dec, 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _m;
    })
    .replace(/&([a-z]+);/gi, (match, name) => NAMED_ENTITIES[name.toLowerCase()] ?? match);
}

function splitAddress(address) {
  const at = String(address).indexOf('@');
  return at < 0
    ? { localPart: String(address), domain: '' }
    : { localPart: String(address).slice(0, at), domain: String(address).slice(at + 1) };
}

export function createGuerrillaProvider({ store, config, client, logger = console } = {}) {
  const cfg = config.guerrilla;
  const api = client ?? createGuerrillaClient(cfg);

  /** address -> in-flight sync promise (de-duplicates polling per inbox). */
  const inflight = new Map();
  let timer = null;

  function isGuerrilla(mailbox) {
    return mailbox?.provider === 'guerrilla';
  }

  function dataFor(mailbox) {
    if (!mailbox.providerData) mailbox.providerData = {};
    const data = mailbox.providerData;
    if (!(data.seen instanceof Set)) data.seen = new Set(data.seen ?? []);
    if (!(data.fetched instanceof Set)) data.fetched = new Set(data.fetched ?? []);
    if (!data.lastSyncAt) data.lastSyncAt = 0;
    if (!data.activeUntil) data.activeUntil = 0;
    return data;
  }

  function markActive(mailbox) {
    if (isGuerrilla(mailbox)) {
      dataFor(mailbox).activeUntil = Date.now() + cfg.activeWindowMs;
    }
  }

  function requireMailbox(address, sessionId) {
    const mailbox = store.get(address);
    if (!mailbox || mailbox.sessionId !== sessionId || !isGuerrilla(mailbox)) {
      throw providerError(404, 'Mailbox not found.', 'NOT_FOUND');
    }
    return mailbox;
  }

  function note(message) {
    // Never log a sid_token or message body: only a neutral status line.
    logger?.warn?.(`[guerrilla] ${message}`);
  }

  async function reRegister(mailbox, data) {
    const fresh = await api.getEmailAddress();
    data.sidToken = fresh.sid_token;
    const same = await api.setEmailUser({
      sidToken: data.sidToken,
      emailUser: mailbox.localPart,
    });
    const newAddress = String(same.email_addr).toLowerCase();
    if (newAddress !== mailbox.address) {
      throw providerError(
        409,
        'The Guerrilla Mail session changed; create a new inbox.',
        'GUERRILLA_ADDRESS_CHANGED',
      );
    }
    data.emailTimestamp = Number(same.email_timestamp) || data.emailTimestamp;
    data.lastSyncAt = 0;
    return same;
  }

  async function withAuthRetry(mailbox, task) {
    try {
      return await task();
    } catch (error) {
      if (error.code !== 'GUERRILLA_AUTH') throw error;
      const data = dataFor(mailbox);
      await reRegister(mailbox, data);
      return task();
    }
  }

  async function fetchRemoteList(mailbox, data, retried = false) {
    const seenIds = [...data.seen]
      .map((id) => Number.parseInt(id, 10))
      .filter((id) => Number.isFinite(id));
    const seq = seenIds.length ? Math.max(...seenIds) : 0;

    try {
      const remote = seq
        ? await api.checkEmail({ sidToken: data.sidToken, seq })
        : await api.getEmailList({ sidToken: data.sidToken, offset: 0 });

      if (remote.sid_token) data.sidToken = remote.sid_token;
      if (remote.email && String(remote.email).toLowerCase() !== mailbox.address) {
        await reRegister(mailbox, data);
        if (!retried) return fetchRemoteList(mailbox, data, true);
      }
      return remote;
    } catch (error) {
      if (error.code === 'GUERRILLA_AUTH' && !retried) {
        await reRegister(mailbox, data);
        return fetchRemoteList(mailbox, data, true);
      }
      throw error;
    }
  }

  function addRemoteMessage(mailbox, data, item) {
    const remoteId = String(item?.mail_id ?? '').trim();
    if (!remoteId || data.seen.has(remoteId)) return;
    if (!store.has(mailbox.address)) return;
    data.seen.add(remoteId);

    const timestamp = Number(item.mail_timestamp);
    const receivedAt =
      Number.isFinite(timestamp) && timestamp > 0 ? timestamp * 1000 : Date.now();

    store.addMessage(mailbox.address, {
      id: `g-${remoteId}`,
      providerMessageId: remoteId,
      from: decodeEntities(item.mail_from) || 'unknown@unknown',
      to: mailbox.address,
      subject: decodeEntities(item.mail_subject) || '(no subject)',
      date: new Date(receivedAt).toISOString(),
      receivedAt,
      text: decodeEntities(item.mail_excerpt || ''),
      html: '',
      attachments: [],
      size: 0,
      bodyLoaded: false,
    });
  }

  function applyRemoteList(mailbox, data, remote) {
    const items = Array.isArray(remote.list) ? remote.list : [];
    // The API returns newest first; insert oldest first so unshift() keeps the
    // newest message at the top, matching the self-hosted store.
    for (const item of [...items].reverse()) addRemoteMessage(mailbox, data, item);
  }

  async function syncMailbox(mailbox, { force = false } = {}) {
    const data = dataFor(mailbox);
    const now = Date.now();
    if (!force && data.lastSyncAt && now - data.lastSyncAt < cfg.minSyncIntervalMs) {
      return mailbox;
    }

    const pending = inflight.get(mailbox.address);
    if (pending) return pending;

    const run = (async () => {
      const remote = await fetchRemoteList(mailbox, data);
      applyRemoteList(mailbox, data, remote);
      data.lastSyncAt = Date.now();
      return mailbox;
    })();

    inflight.set(mailbox.address, run);
    try {
      return await run;
    } finally {
      inflight.delete(mailbox.address);
    }
  }

  async function pollOnce({ force = false } = {}) {
    const now = Date.now();
    const mailboxes = [...store.mailboxes.values()].filter(
      (mailbox) => isGuerrilla(mailbox) && mailbox.expiresAt > now,
    );

    for (const mailbox of mailboxes) {
      const data = dataFor(mailbox);
      if (!force && data.activeUntil <= Date.now()) continue;
      try {
        await syncMailbox(mailbox, { force: false });
      } catch (error) {
        note(`poll failed for an inbox (${error.code || 'ERROR'})`);
      }
    }
  }

  const provider = {
    id: 'guerrilla',
    label: 'Guerrilla Mail',
    description:
      'Third-party disposable inboxes from Guerrilla Mail. About one hour of retention; not operated by this app.',
    capabilities: {
      supportsDomainChoice: false,
      supportsCustomLocalPart: true,
      supportsExtend: false,
      supportsDeleteMessage: true,
      supportsAttachments: false,
      retentionMinutes: cfg.retentionMinutes,
      maxLifetimeMinutes: cfg.retentionMinutes,
      liveUpdates: 'polling',
    },

    /** Domain choice is not exposed by Guerrilla Mail's API. */
    listDomains() {
      return [];
    },

    async createMailbox({ sessionId, localPart: rawLocal, domain }) {
      if (!cfg.enabled) {
        throw providerError(503, 'The Guerrilla Mail provider is disabled.', 'PROVIDER_DISABLED');
      }
      if (domain !== undefined && domain !== null && String(domain).trim() !== '') {
        throw providerError(
          400,
          'Guerrilla Mail does not let this app choose the domain. Omit the domain.',
          'INVALID_DOMAIN',
        );
      }

      let localPart = null;
      if (rawLocal !== undefined && rawLocal !== null && String(rawLocal).trim() !== '') {
        localPart = normalizeLocalPart(rawLocal);
        const result = validateLocalPart(localPart);
        if (!result.ok) throw providerError(400, result.error, 'INVALID_LOCAL_PART');
      }

      const fresh = await api.getEmailAddress();
      const sidToken = fresh.sid_token;
      const remote = localPart
        ? await api.setEmailUser({ sidToken, emailUser: localPart })
        : fresh;

      const address = String(remote.email_addr).toLowerCase();
      if (!address.includes('@')) {
        throw providerError(
          502,
          'Guerrilla Mail returned an invalid address.',
          'GUERRILLA_INVALID_RESPONSE',
        );
      }

      if (store.has(address)) {
        // Do not leave a remote session pointing at an inbox we cannot own.
        await api.forgetMe({ sidToken, emailAddr: address }).catch(() => {});
        throw providerError(
          409,
          `"${address}" is already in use. Try another local part.`,
          'ADDRESS_TAKEN',
        );
      }

      const parts = splitAddress(address);
      const now = Date.now();
      let mailbox;
      try {
        mailbox = store.createMailbox({
          address,
          localPart: parts.localPart,
          domain: parts.domain,
          sessionId,
          provider: 'guerrilla',
          providerData: {
            sidToken,
            emailTimestamp: Number(remote.email_timestamp) || Math.floor(now / 1000),
            seen: new Set(),
            fetched: new Set(),
            lastSyncAt: 0,
            activeUntil: now + cfg.activeWindowMs,
          },
          ttlMs: cfg.retentionMs,
        });
      } catch (error) {
        await api.forgetMe({ sidToken, emailAddr: address }).catch(() => {});
        if (error.code === 'TOO_MANY_MAILBOXES') {
          throw providerError(429, error.message, 'TOO_MANY_MAILBOXES');
        }
        if (error.code === 'ADDRESS_TAKEN') {
          throw providerError(409, error.message, 'ADDRESS_TAKEN');
        }
        throw error;
      }

      return mailbox;
    },

    listMailboxes(sessionId) {
      return store.listForSession(sessionId).filter(isGuerrilla);
    },

    getMailbox(address, sessionId) {
      return requireMailbox(address, sessionId);
    },

    async listMessages(address, sessionId) {
      const mailbox = requireMailbox(address, sessionId);
      markActive(mailbox);
      try {
        await syncMailbox(mailbox);
      } catch (error) {
        // Serve the cache when we already have messages; only fail a cold load.
        if (!mailbox.messages.length) throw error;
        note(`inbox sync failed, serving cached messages (${error.code || 'ERROR'})`);
      }
      return mailbox.messages;
    },

    async getMessage(address, sessionId, messageId) {
      const mailbox = requireMailbox(address, sessionId);
      markActive(mailbox);
      const message = store.getMessage(address, messageId);
      if (!message) throw providerError(404, 'Message not found.', 'MESSAGE_NOT_FOUND');
      if (message.bodyLoaded) return message;

      const data = dataFor(mailbox);
      const remote = await withAuthRetry(mailbox, () =>
        api.fetchEmail({ sidToken: data.sidToken, emailId: message.providerMessageId }),
      );
      if (remote === false) {
        throw providerError(
          404,
          'This message is no longer available on Guerrilla Mail.',
          'MESSAGE_GONE',
        );
      }

      const contentType = String(remote.content_type || '').toLowerCase();
      const rawBody = typeof remote.mail_body === 'string' ? remote.mail_body : '';
      const html = contentType.includes('html') ? sanitizeEmailHtml(rawBody) : '';
      const text = contentType.includes('html') ? htmlToText(rawBody) : rawBody;

      if (remote.mail_subject) message.subject = decodeEntities(remote.mail_subject);
      if (remote.mail_from) message.from = decodeEntities(remote.mail_from) || message.from;
      if (html) message.html = html;
      if (text) message.text = text;
      message.bodyLoaded = true;
      data.fetched.add(String(message.providerMessageId));
      return message;
    },

    async deleteMessage(address, sessionId, messageId) {
      const mailbox = requireMailbox(address, sessionId);
      markActive(mailbox);
      const message = store.getMessage(address, messageId);
      if (!message) throw providerError(404, 'Message not found.', 'MESSAGE_NOT_FOUND');

      const data = dataFor(mailbox);
      if (message.providerMessageId) {
        await withAuthRetry(mailbox, () =>
          api.delEmail({ sidToken: data.sidToken, emailIds: [message.providerMessageId] }),
        );
        data.seen.delete(String(message.providerMessageId));
      }
      store.deleteMessage(address, messageId);
    },

    async deleteMailbox(address, sessionId) {
      const mailbox = requireMailbox(address, sessionId);
      const data = dataFor(mailbox);
      // forget_me only forgets the session's current address; best effort.
      await api.forgetMe({ sidToken: data.sidToken, emailAddr: mailbox.address }).catch(() => {});
      store.deleteMailbox(address);
    },

    async extendMailbox() {
      throw providerError(
        400,
        'Guerrilla Mail inboxes cannot be extended from this app.',
        'UNSUPPORTED',
      );
    },

    async getAttachment(address, sessionId) {
      requireMailbox(address, sessionId);
      throw providerError(
        400,
        'Guerrilla Mail does not expose attachment downloads through its API.',
        'ATTACHMENT_UNAVAILABLE',
      );
    },

    markSessionActive(sessionId) {
      for (const mailbox of store.listForSession(sessionId)) markActive(mailbox);
    },

    /** Test/manual helper: sync one inbox now, bypassing the min interval. */
    async syncNow(address) {
      const mailbox = store.get(address);
      if (!isGuerrilla(mailbox)) {
        throw providerError(404, 'Mailbox not found.', 'NOT_FOUND');
      }
      markActive(mailbox);
      return syncMailbox(mailbox, { force: true });
    },

    pollOnce,

    start() {
      if (timer || !cfg.enabled) return;
      timer = setInterval(() => {
        pollOnce().catch(() => {});
      }, cfg.pollIntervalMs);
      timer.unref?.();
    },

    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };

  // Drop remote-session bookkeeping when a mailbox goes away.
  store.on('mailbox:deleted', (mailbox) => {
    if (isGuerrilla(mailbox)) inflight.delete(mailbox.address);
  });
  store.on('mailbox:expired', (mailbox) => {
    if (isGuerrilla(mailbox)) inflight.delete(mailbox.address);
  });

  return provider;
}