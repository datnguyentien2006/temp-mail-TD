/**
 * REST API routes.
 */
import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import QRCode from 'qrcode';
import {
  buildAddress,
  normalizeLocalPart,
  randomLocalPart,
  validateDomain,
  validateLocalPart,
} from './mailboxes.js';
import {
  toPublicMailbox,
  toPublicMessage,
  toPublicMessageSummary,
} from './serialize.js';

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

export function createRouter({ store, config }) {
  const router = Router();
  const createLimiter = createCreateLimiter(config);
  const extendLimiter = createExtendLimiter();

  router.get('/api/health', (req, res) => {
    res.json({ status: 'ok', uptime: Math.round(process.uptime()) });
  });

  // Dedicated endpoint so the UI can fill its domain picker from the server's
  // configuration instead of hardcoding anything.
  router.get('/api/domains', (req, res) => {
    res.json({ domains: config.domains });
  });

  router.get('/api/config', (req, res) => {
    res.json({
      domains: config.domains,
      ttlMinutes: config.ttlMinutes,
      maxMailboxLifetimeMinutes: config.maxMailboxLifetimeMinutes,
      maxMailboxesPerSession: config.maxMailboxesPerSession,
      randomLocalPartLength: config.randomLocalPartLength,
      pollIntervalMs: config.pollIntervalMs,
    });
  });

  router.post('/api/mailboxes', createLimiter, (req, res) => {
    const sessionId = requireSession(req, res);
    if (!sessionId) return;

    const body = req.body ?? {};
    const rawLocal = body.localPart;
    const rawDomain = body.domain;

    // --- domain -------------------------------------------------------
    let domain;
    if (rawDomain === undefined || rawDomain === null || String(rawDomain).trim() === '') {
      if (config.domains.length === 0) {
        return res.status(503).json({ error: 'No mail domains are configured on this server.' });
      }
      domain = config.domains[Math.floor(Math.random() * config.domains.length)];
    } else {
      const result = validateDomain(rawDomain, config.domains);
      if (!result.ok) return res.status(400).json({ error: result.error });
      domain = result.domain;
    }

    // --- local part ---------------------------------------------------
    let localPart;
    const custom = rawLocal !== undefined && rawLocal !== null && String(rawLocal).trim() !== '';
    if (custom) {
      localPart = normalizeLocalPart(rawLocal);
      const result = validateLocalPart(localPart);
      if (!result.ok) return res.status(400).json({ error: result.error });
    } else {
      let attempts = 0;
      do {
        localPart = randomLocalPart(config.randomLocalPartLength);
        attempts += 1;
      } while (store.has(buildAddress(localPart, domain)) && attempts < 25);
    }

    const address = buildAddress(localPart, domain);
    if (store.has(address)) {
      return res.status(409).json({ error: `"${address}" is already taken. Try another local part.` });
    }

    try {
      const mailbox = store.createMailbox({ address, localPart, domain, sessionId });
      return res.status(201).json(toPublicMailbox(mailbox));
    } catch (error) {
      if (error.code === 'TOO_MANY_MAILBOXES') {
        return res.status(429).json({ error: error.message });
      }
      if (error.code === 'ADDRESS_TAKEN') {
        return res.status(409).json({ error: error.message });
      }
      throw error;
    }
  });

  router.get('/api/mailboxes', (req, res) => {
    const sessionId = requireSession(req, res);
    if (!sessionId) return;
    res.json({ mailboxes: store.listForSession(sessionId).map(toPublicMailbox) });
  });

  router.delete('/api/mailboxes/:address', (req, res) => {
    const sessionId = requireSession(req, res);
    if (!sessionId) return;
    const { address } = req.params;
    if (!store.owns(address, sessionId)) {
      return res.status(404).json({ error: 'Mailbox not found.' });
    }
    store.deleteMailbox(address);
    return res.status(204).end();
  });

  // Push the mailbox's expiry forward (bounded by MAX_MAILBOX_LIFETIME_MINUTES).
  router.post('/api/mailboxes/:address/extend', extendLimiter, (req, res) => {
    const sessionId = requireSession(req, res);
    if (!sessionId) return;
    const { address } = req.params;
    if (!store.owns(address, sessionId)) {
      return res.status(404).json({ error: 'Mailbox not found.' });
    }
    const mailbox = store.extendMailbox(address, {
      ttlMs: config.ttlMs,
      maxLifetimeMs: config.maxMailboxLifetimeMs,
    });
    if (!mailbox) return res.status(404).json({ error: 'Mailbox not found.' });
    return res.json({ mailbox: toPublicMailbox(mailbox) });
  });

  // QR code for the address, returned as a data URL so the client can render
  // it with the normal session header (no session id in an <img> URL).
  router.get('/api/mailboxes/:address/qr', async (req, res, next) => {
    const sessionId = requireSession(req, res);
    if (!sessionId) return;
    const { address } = req.params;
    if (!store.owns(address, sessionId)) {
      return res.status(404).json({ error: 'Mailbox not found.' });
    }
    try {
      const svg = await QRCode.toString(address, {
        type: 'svg',
        margin: 1,
        width: 240,
        errorCorrectionLevel: 'M',
      });
      const dataUrl = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
      return res.json({ address, dataUrl });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/api/mailboxes/:address/messages', (req, res) => {
    const sessionId = requireSession(req, res);
    if (!sessionId) return;
    const { address } = req.params;
    const mailbox = store.get(address);
    if (!mailbox || mailbox.sessionId !== sessionId) {
      return res.status(404).json({ error: 'Mailbox not found.' });
    }
    res.json({
      mailbox: toPublicMailbox(mailbox),
      messages: mailbox.messages.map(toPublicMessageSummary),
    });
  });

  router.get('/api/mailboxes/:address/messages/:messageId', (req, res) => {
    const sessionId = requireSession(req, res);
    if (!sessionId) return;
    const { address, messageId } = req.params;
    if (!store.owns(address, sessionId)) {
      return res.status(404).json({ error: 'Mailbox not found.' });
    }
    const message = store.getMessage(address, messageId);
    if (!message) return res.status(404).json({ error: 'Message not found.' });
    return res.json(toPublicMessage(message));
  });

  router.delete('/api/mailboxes/:address/messages/:messageId', (req, res) => {
    const sessionId = requireSession(req, res);
    if (!sessionId) return;
    const { address, messageId } = req.params;
    if (!store.owns(address, sessionId)) {
      return res.status(404).json({ error: 'Mailbox not found.' });
    }
    if (!store.deleteMessage(address, messageId)) {
      return res.status(404).json({ error: 'Message not found.' });
    }
    return res.status(204).end();
  });

  router.get('/api/mailboxes/:address/messages/:messageId/attachments/:index', (req, res) => {
    const sessionId = requireSession(req, res);
    if (!sessionId) return;
    const { address, messageId } = req.params;
    const index = Number.parseInt(req.params.index, 10);
    if (!store.owns(address, sessionId)) {
      return res.status(404).json({ error: 'Mailbox not found.' });
    }
    const message = store.getMessage(address, messageId);
    const attachment = message?.attachments?.[index];
    if (!attachment) return res.status(404).json({ error: 'Attachment not found.' });

    const buffer = Buffer.from(attachment.content || '', 'base64');
    res.setHeader('Content-Type', attachment.contentType || 'application/octet-stream');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${String(attachment.filename).replace(/["\\\r\n]/g, '_')}"`,
    );
    res.setHeader('Content-Length', buffer.length);
    return res.end(buffer);
  });

  return router;
}
