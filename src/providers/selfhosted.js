/**
 * Self-hosted mail provider.
 *
 * Wraps the existing in-memory MailboxStore + inbound SMTP server. Behaviour is
 * intentionally identical to the pre-provider version of the app: same
 * allow-list, validation rules, limits and error statuses.
 */
import {
  buildAddress,
  normalizeLocalPart,
  randomLocalPart,
  validateDomain,
  validateLocalPart,
} from '../mailboxes.js';
import { providerError } from './errors.js';

export function createSelfHostedProvider({ store, config }) {
  return {
    id: 'selfhosted',
    label: 'Self-hosted mail',
    description: 'Mail delivered to this app’s own SMTP server on your own domains.',
    capabilities: {
      supportsDomainChoice: config.domains.length > 0,
      supportsCustomLocalPart: true,
      supportsExtend: true,
      supportsDeleteMessage: true,
      supportsAttachments: true,
      retentionMinutes: config.ttlMinutes,
      maxLifetimeMinutes: config.maxMailboxLifetimeMinutes,
      liveUpdates: 'websocket',
    },

    listDomains() {
      return [...config.domains];
    },

    async createMailbox({ sessionId, localPart: rawLocal, domain: rawDomain }) {
      // --- domain -------------------------------------------------------
      let domain;
      if (rawDomain === undefined || rawDomain === null || String(rawDomain).trim() === '') {
        if (config.domains.length === 0) {
          throw providerError(503, 'No mail domains are configured on this server.', 'NO_DOMAINS');
        }
        domain = config.domains[Math.floor(Math.random() * config.domains.length)];
      } else {
        const result = validateDomain(rawDomain, config.domains);
        if (!result.ok) throw providerError(400, result.error, 'INVALID_DOMAIN');
        domain = result.domain;
      }

      // --- local part ---------------------------------------------------
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

      try {
        return store.createMailbox({
          address,
          localPart,
          domain,
          sessionId,
          provider: 'selfhosted',
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
      return store.listForSession(sessionId);
    },

    getMailbox(address, sessionId) {
      const mailbox = store.get(address);
      if (!mailbox || mailbox.sessionId !== sessionId) {
        throw providerError(404, 'Mailbox not found.', 'NOT_FOUND');
      }
      return mailbox;
    },

    async listMessages(address, sessionId) {
      return this.getMailbox(address, sessionId).messages;
    },

    async getMessage(address, sessionId, messageId) {
      this.getMailbox(address, sessionId);
      const message = store.getMessage(address, messageId);
      if (!message) throw providerError(404, 'Message not found.', 'MESSAGE_NOT_FOUND');
      return message;
    },

    async deleteMessage(address, sessionId, messageId) {
      this.getMailbox(address, sessionId);
      if (!store.deleteMessage(address, messageId)) {
        throw providerError(404, 'Message not found.', 'MESSAGE_NOT_FOUND');
      }
    },

    async deleteMailbox(address, sessionId) {
      this.getMailbox(address, sessionId);
      store.deleteMailbox(address);
    },

    async extendMailbox(address, sessionId) {
      this.getMailbox(address, sessionId);
      const mailbox = store.extendMailbox(address, {
        ttlMs: config.ttlMs,
        maxLifetimeMs: config.maxMailboxLifetimeMs,
      });
      if (!mailbox) throw providerError(404, 'Mailbox not found.', 'NOT_FOUND');
      return mailbox;
    },

    async getAttachment(address, sessionId, messageId, index) {
      await this.getMessage(address, sessionId, messageId);
      const message = store.getMessage(address, messageId);
      const attachment = message?.attachments?.[index];
      if (!attachment) {
        throw providerError(404, 'Attachment not found.', 'ATTACHMENT_NOT_FOUND');
      }
      return {
        filename: attachment.filename,
        contentType: attachment.contentType || 'application/octet-stream',
        buffer: Buffer.from(attachment.content || '', 'base64'),
      };
    },
  };
}