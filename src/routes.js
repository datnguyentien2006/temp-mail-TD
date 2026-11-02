/**
 * REST API routes.
 *
 * Mailbox operations are delegated to the provider registry (self-hosted SMTP
 * or Guerrilla Mail). Endpoint paths and the response shapes used by the
 * existing frontend are preserved.
 */
import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import QRCode from 'qrcode';
import { toPublicMailbox, toPublicMessage, toPublicMessageSummary } from './serialize.js';

const SESSION_RE = /^[a-zA-Z0-9_-]{8,128}$/;

function createCreateLimiter(config) {
  return rateLimit({
    windowMs: config.createRateLimit.windowMs,
    max: config.createRateLimit.max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many mailboxes created from this IP. Please slow down.' },
  });
}

/** A gentler limiter for the "extend lifetime" action. */
function createExtendLimiter() {
  return rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many extend requests. Please slow down.' },
  });
}

/** Resolve and validate the per-browser session id, replying 400 if invalid. */
function requireSession(req, res) {
  const raw = req.get('x-session-id') || req.query.sessionId;
  const sessionId = String(raw ?? '').trim();
  if (!SESSION_RE.test(sessionId)) {
    res.status(400).json({ error: 'Missing or invalid session id (x-session-id header).' });
    return null;
  }
  return sessionId;
}

/** Express 4 does not catch rejected async handlers, so do it explicitly. */
function wrap(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

export function createRouter({ store, config, providers }) {
  const router = Router();
  const createLimiter = createCreateLimiter(config);
  const extendLimiter = createExtendLimiter();

  /** Return the mailbox if it belongs to this session, otherwise null. */
  function ownedMailbox(address, sessionId) {
    const mailbox = store.get(address);
    if (!mailbox || mailbox.sessionId !== sessionId) return null;
    return mailbox;
  }

  router.get('/api/health', (req, res) => {
    res.json({ status: 'ok', uptime: Math.round(process.uptime()) });
  });

  // Grouped by provider so the UI can build a nested picker. `domains` is the
  // flat list kept for backwards compatibility.
  router.get('/api/domains', (req, res) => {
    res.json({
      domains: providers.listAllDomains(),
      providers: providers.descriptor(),
    });
  });

  router.get('/api/config', (req, res) => {
    res.json({
      domains: providers.listAllDomains(),
      ttlMinutes: config.ttlMinutes,
      maxMailboxLifetimeMinutes: config.maxMailboxLifetimeMinutes,
      maxMailboxesPerSession: config.maxMailboxesPerSession,
      randomLocalPartLength: config.randomLocalPartLength,
      pollIntervalMs: config.pollIntervalMs,
    });
  });

  router.post(
    '/api/mailboxes',
    createLimiter,
    wrap(async (req, res) => {
      const sessionId = requireSession(req, res);
      if (!sessionId) return;

      const body = req.body ?? {};
      const provider = providers.resolve(body.provider, body.domain);
      const mailbox = await provider.createMailbox({
        sessionId,
        localPart: body.localPart,
        domain: body.domain,
      });
      return res.status(201).json(toPublicMailbox(mailbox));
    }),
  );

  router.get('/api/mailboxes', (req, res) => {
    const sessionId = requireSession(req, res);
    if (!sessionId) return;
    res.json({ mailboxes: providers.listForSession(sessionId).map(toPublicMailbox) });
  });

  router.delete(
    '/api/mailboxes/:address',
    wrap(async (req, res) => {
      const sessionId = requireSession(req, res);
      if (!sessionId) return;
      const { address } = req.params;
      const mailbox = ownedMailbox(address, sessionId);
      if (!mailbox) return res.status(404).json({ error: 'Mailbox not found.' });

      await providers.forMailbox(mailbox).deleteMailbox(address, sessionId);
      return res.status(204).end();
    }),
  );

  // Push the mailbox's expiry forward (self-hosted only; Guerrilla Mail has no
  // supported extend operation).
  router.post(
    '/api/mailboxes/:address/extend',
    extendLimiter,
    wrap(async (req, res) => {
      const sessionId = requireSession(req, res);
      if (!sessionId) return;
      const { address } = req.params;
      const mailbox = ownedMailbox(address, sessionId);
      if (!mailbox) return res.status(404).json({ error: 'Mailbox not found.' });

      const provider = providers.forMailbox(mailbox);
      if (!provider.capabilities?.supportsExtend) {
        return res.status(400).json({ error: 'This provider does not support extending mailboxes.' });
      }
      const updated = await provider.extendMailbox(address, sessionId);
      return res.json({ mailbox: toPublicMailbox(updated) });
    }),
  );

  // QR code for the address, returned as a data URL so the client can render
  // it with the normal session header (no session id in an <img> URL).
  router.get(
    '/api/mailboxes/:address/qr',
    wrap(async (req, res) => {
      const sessionId = requireSession(req, res);
      if (!sessionId) return;
      const { address } = req.params;
      if (!store.owns(address, sessionId)) {
        return res.status(404).json({ error: 'Mailbox not found.' });
      }
      const svg = await QRCode.toString(address, {
        type: 'svg',
        margin: 1,
        width: 240,
        errorCorrectionLevel: 'M',
      });
      const dataUrl = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
      return res.json({ address, dataUrl });
    }),
  );

  router.get(
    '/api/mailboxes/:address/messages',
    wrap(async (req, res) => {
      const sessionId = requireSession(req, res);
      if (!sessionId) return;
      const { address } = req.params;
      const mailbox = ownedMailbox(address, sessionId);
      if (!mailbox) return res.status(404).json({ error: 'Mailbox not found.' });

      const messages = await providers
        .forMailbox(mailbox)
        .listMessages(address, sessionId);
      return res.json({
        mailbox: toPublicMailbox(store.get(address) ?? mailbox),
        messages: messages.map(toPublicMessageSummary),
      });
    }),
  );

  router.get(
    '/api/mailboxes/:address/messages/:messageId',
    wrap(async (req, res) => {
      const sessionId = requireSession(req, res);
      if (!sessionId) return;
      const { address, messageId } = req.params;
      const mailbox = ownedMailbox(address, sessionId);
      if (!mailbox) return res.status(404).json({ error: 'Mailbox not found.' });

      const message = await providers
        .forMailbox(mailbox)
        .getMessage(address, sessionId, messageId);
      return res.json(toPublicMessage(message));
    }),
  );

  router.delete(
    '/api/mailboxes/:address/messages/:messageId',
    wrap(async (req, res) => {
      const sessionId = requireSession(req, res);
      if (!sessionId) return;
      const { address, messageId } = req.params;
      const mailbox = ownedMailbox(address, sessionId);
      if (!mailbox) return res.status(404).json({ error: 'Mailbox not found.' });

      await providers.forMailbox(mailbox).deleteMessage(address, sessionId, messageId);
      return res.status(204).end();
    }),
  );

  router.get(
    '/api/mailboxes/:address/messages/:messageId/attachments/:index',
    wrap(async (req, res) => {
      const sessionId = requireSession(req, res);
      if (!sessionId) return;
      const { address, messageId } = req.params;
      const index = Number.parseInt(req.params.index, 10);
      const mailbox = ownedMailbox(address, sessionId);
      if (!mailbox) return res.status(404).json({ error: 'Mailbox not found.' });

      const attachment = await providers
        .forMailbox(mailbox)
        .getAttachment(address, sessionId, messageId, index);

      res.setHeader('Content-Type', attachment.contentType || 'application/octet-stream');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${String(attachment.filename).replace(/["\\\r\n]/g, '_')}"`,
      );
      res.setHeader('Content-Length', attachment.buffer.length);
      return res.end(attachment.buffer);
    }),
  );

  return router;
}