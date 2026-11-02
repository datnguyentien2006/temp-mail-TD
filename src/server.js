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
import { createProviders } from './providers/index.js';

const config = loadConfig();
const store = new MailboxStore({
  ttlMs: config.ttlMs,
  maxMailboxesPerSession: config.maxMailboxesPerSession,
});

const providers = createProviders({ store, config });
const app = createApp({ store, config, providers });
const server = http.createServer(app);

// --- WebSocket hub: push new mail to the owning session ----------------
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (socket, req) => {
  const url = new URL(req.url, 'http://localhost');
  socket.sessionId = url.searchParams.get('sessionId') || null;
  if (socket.sessionId) providers.markSessionActive(socket.sessionId);

  socket.on('message', (raw) => {
    try {
      const payload = JSON.parse(raw.toString());
      if (payload?.type === 'subscribe' && payload.sessionId) {
        socket.sessionId = String(payload.sessionId);
        providers.markSessionActive(socket.sessionId);
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

store.on('mailbox:extended', (mailbox) => {
  broadcastToSession(mailbox.sessionId, {
    type: 'extended',
    address: mailbox.address,
    expiresAt: mailbox.expiresAt,
  });
});

// --- SMTP --------------------------------------------------------------
const smtpServer = createSmtpServer({ store, config });

// --- Background cleanup ------------------------------------------------
store.startSweeper(config.sweepIntervalMs);

// --- Guerrilla Mail polling (open inboxes only) -------------------------
providers.start();

// --- Start listening ---------------------------------------------------
if (config.domains.length === 0) {
  console.warn(
    '[config] DOMAINS is empty. Set DOMAINS=example.com,example.net in your environment/.env before creating mailboxes.',
  );
}

// A port clash is the most common startup failure, and the default crash dumps
// a stack from the WebSocketServer that says nothing useful. Report it plainly.
function reportListenError(err, label, port) {
  if (err.code === 'EADDRINUSE') {
    console.error(
      `[${label}] port ${port} is already in use. Another instance is probably still running.\n` +
        `  Windows: netstat -ano | findstr :${port}   then   taskkill /PID <pid> /F\n` +
        `  macOS/Linux: lsof -i :${port}   then   kill <pid>\n` +
        `  Or start on another port: PORT=3001 npm start`,
    );
  } else if (err.code === 'EACCES') {
    console.error(`[${label}] port ${port} needs elevated privileges. Use a port above 1024.`);
  } else {
    console.error(`[${label}] failed to listen on ${port}: ${err.message}`);
  }
  process.exit(1);
}

server.on('error', (err) => reportListenError(err, 'http', config.port));
wss.on('error', (err) => reportListenError(err, 'ws', config.port));
smtpServer.on('error', (err) => reportListenError(err, 'smtp', config.smtp.port));

server.listen(config.port, config.host, () => {
  console.log(`[http] Temp Mail UI/API on http://${config.host}:${config.port}`);
  console.log(`[http] WebSocket live updates on ws://${config.host}:${config.port}/ws`);
  console.log(`[smtp] listening on ${config.smtp.host}:${config.smtp.port}`);
  console.log(`[config] domains: ${config.domains.join(', ') || '(none configured)'}`);
  console.log(`[config] mailbox TTL: ${config.ttlMinutes} minute(s)`);
  console.log(
    `[config] providers: ${providers
      .list()
      .map((provider) => provider.id)
      .join(', ')}`,
  );
  if (config.guerrilla.enabled) {
    console.log(
      `[guerrilla] enabled; polling open inboxes every ${config.guerrilla.pollIntervalMs} ms`,
    );
  }
  if (config.resend.enabled && config.resend.domains.length > 0) {
    console.log(
      `[resend] receive-only provider on: ${config.resend.domains.join(', ')} (webhook POST ${config.resend.webhookPath})`,
    );
  }

  // Make configured-but-unusable providers loud in the console. They are also
  // flagged in GET /api/domains, but the reason is easy to miss there.
  for (const provider of providers.list()) {
    const status = provider.status?.();
    if (status && status.available === false) {
      console.warn(
        `[${provider.id}] unavailable: ${status.reason ?? 'unknown reason'} ` +
          '(note: .env is read once at boot — restart the server after editing it)',
      );
    }
  }

  // Probe the Resend key once, out of band, so a rejected key (e.g. a
  // sending-only key) is reported here instead of only when a mail arrives.
  Promise.resolve()
    .then(() => providers.get('resend')?.checkCredentials?.())
    .then((verdict) => {
      if (verdict?.ok === false && verdict.reason !== 'not-configured') {
        console.warn(`[resend] unavailable: ${verdict.reason}`);
      }
    })
    .catch(() => {});
});

smtpServer.listen(config.smtp.port, config.smtp.host, () => {
  console.log('[smtp] ready to receive mail');
});

// --- Graceful shutdown -------------------------------------------------
function shutdown(signal) {
  console.log(`\n[app] ${signal} received, shutting down...`);
  providers.stop();
  wss.close();
  server.close();
  smtpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
