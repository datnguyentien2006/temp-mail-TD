/**
 * Application entry point: wires the HTTP app, WebSocket hub and SMTP server.
 */
import 'dotenv/config';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { loadConfig } from './config.js';
import { MailboxStore } from './store.js';
import { createApp } from './app.js';
import { createSmtpServer } from './smtp.js';
import { toPublicMessageSummary } from './serialize.js';

const config = loadConfig();
const store = new MailboxStore({
  ttlMs: config.ttlMs,
  maxMailboxesPerSession: config.maxMailboxesPerSession,
});

const app = createApp({ store, config });
const server = http.createServer(app);

// --- WebSocket hub: push new mail to the owning session ----------------
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (socket, req) => {
  const url = new URL(req.url, 'http://localhost');
  socket.sessionId = url.searchParams.get('sessionId') || null;

  socket.on('message', (raw) => {
    try {
      const payload = JSON.parse(raw.toString());
      if (payload?.type === 'subscribe' && payload.sessionId) {
        socket.sessionId = String(payload.sessionId);
      }
    } catch {
      /* ignore malformed client frames */
    }
  });
});

function broadcastToSession(sessionId, payload) {
  if (!sessionId) return;
  const data = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === 1 && client.sessionId === sessionId) client.send(data);
  }
}

store.on('message', ({ mailbox, message }) => {
  broadcastToSession(mailbox.sessionId, {
    type: 'message',
    address: mailbox.address,
    message: toPublicMessageSummary(message),
  });
});

store.on('mailbox:expired', (mailbox) => {
  broadcastToSession(mailbox.sessionId, { type: 'expired', address: mailbox.address });
});

// --- SMTP --------------------------------------------------------------
const smtpServer = createSmtpServer({ store, config });
smtpServer.on('error', (err) => {
  console.error('[smtp] server error:', err.message);
});

// --- Background cleanup ------------------------------------------------
store.startSweeper(config.sweepIntervalMs);

// --- Start listening ---------------------------------------------------
if (config.domains.length === 0) {
  console.warn(
    '[config] DOMAINS is empty. Set DOMAINS=example.com,example.net in your environment/.env before creating mailboxes.',
  );
}

server.listen(config.port, config.host, () => {
  console.log(`[http] Temp Mail UI/API on http://${config.host}:${config.port}`);
  console.log(`[http] WebSocket live updates on ws://${config.host}:${config.port}/ws`);
  console.log(`[smtp] listening on ${config.smtp.host}:${config.smtp.port}`);
  console.log(`[config] domains: ${config.domains.join(', ') || '(none configured)'}`);
  console.log(`[config] mailbox TTL: ${config.ttlMinutes} minute(s)`);
});

smtpServer.listen(config.smtp.port, config.smtp.host, () => {
  console.log('[smtp] ready to receive mail');
});

// --- Graceful shutdown -------------------------------------------------
function shutdown(signal) {
  console.log(`\n[app] ${signal} received, shutting down...`);
  wss.close();
  server.close();
  smtpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
