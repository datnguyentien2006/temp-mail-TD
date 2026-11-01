/**
 * Inbound SMTP server.
 *
 * Accepts mail only for:
 *   1. domains in the configured allow-list, and
 *   2. mailboxes that currently exist in the store.
 * Everything else is rejected with 550 (no backscatter).
 */
import { Transform } from 'node:stream';
import { readFileSync } from 'node:fs';
import { SMTPServer } from 'smtp-server';
import { simpleParser } from 'mailparser';
import { sanitizeEmailHtml, htmlToText } from './sanitize.js';

export function buildMessage(parsed, recipient, size) {
  const text = parsed.text || htmlToText(parsed.html) || '';
  const attachments = (parsed.attachments ?? []).map((attachment) => ({
    filename: attachment.filename || 'attachment',
    contentType: attachment.contentType || 'application/octet-stream',
    size: attachment.size ?? attachment.content?.length ?? 0,
    content: attachment.content ? attachment.content.toString('base64') : '',
  }));

  return {
    from: parsed.from?.text || 'unknown@unknown',
    to: recipient,
    subject: parsed.subject || '(no subject)',
    date: parsed.date ? parsed.date.toISOString() : new Date().toISOString(),
    text,
    html: sanitizeEmailHtml(parsed.html || ''),
    attachments,
    size,
  };
}

/**
 * @param {{ store: import('./store.js').MailboxStore, config: object }} deps
 */
export function createSmtpServer({ store, config }) {
  const tlsConfigured = Boolean(config.smtp.tls?.key && config.smtp.tls?.cert);

  const options = {
    authOptional: true,
    disabledCommands: tlsConfigured ? ['AUTH'] : ['AUTH', 'STARTTLS'],
    hideSTARTTLS: !tlsConfigured,
    size: config.smtp.maxBytes,
    logger: false,

    onRcptTo(address, session, callback) {
      const domain = (address.address.split('@')[1] || '').toLowerCase();
      if (!config.domains.includes(domain)) {
        const error = new Error('Relay not permitted for this domain');
        error.responseCode = 550;
        return callback(error);
      }
      if (!store.has(address.address)) {
        const error = new Error('No such mailbox');
        error.responseCode = 550;
        return callback(error);
      }
      return callback();
    },

    onData(stream, session, callback) {
      let size = 0;
      const counter = new Transform({
        transform(chunk, _encoding, cb) {
          size += chunk.length;
          cb(null, chunk);
        },
      });

      stream.pipe(counter);

      simpleParser(counter)
        .then((parsed) => {
          const recipient = session.envelope.rcptTo[0]?.address;
          const mailbox = recipient ? store.get(recipient) : null;
          if (!mailbox) {
            const error = new Error('Mailbox no longer exists');
            error.responseCode = 550;
            return callback(error);
          }
          store.addMessage(recipient, buildMessage(parsed, recipient, size));
          return callback();
        })
        .catch(() => {
          const error = new Error('Failed to parse message');
          error.responseCode = 554;
          callback(error);
        });
    },
  };

  if (tlsConfigured) {
    options.key = readFileSync(config.smtp.tls.key);
    options.cert = readFileSync(config.smtp.tls.cert);
  }

  return new SMTPServer(options);
}
