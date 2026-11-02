/**
 * Express application factory. Kept separate from server bootstrapping so it
 * can be exercised directly in tests (supertest) without binding ports.
 */
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRouter } from './routes.js';
import { createProviders } from './providers/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function corsMiddleware(corsOrigin) {
  return (req, res, next) => {
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Origin', corsOrigin);
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-session-id');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') return res.status(204).end();
    return next();
  };
}

export function createApp({ store, config, providers }) {
  const app = express();
  const mailboxProviders = providers ?? createProviders({ store, config });
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', 1);

  app.use(express.json({ limit: '100kb' }));

  // Minimal security headers (no helmet dependency needed for this app).
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    next();
  });

  if (config.corsOrigin) app.use(corsMiddleware(config.corsOrigin));

  app.use(createRouter({ store, config, providers: mailboxProviders }));

  app.use(express.static(PUBLIC_DIR, { index: 'index.html' }));

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err?.type === 'entity.too.large') {
      return res.status(413).json({ error: 'Request payload too large.' });
    }
    if (err?.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'Invalid JSON body.' });
    }
    // Provider errors already carry a safe status + message.
    if (err?.expose && Number.isInteger(Number(err.status))) {
      return res.status(Number(err.status)).json({ error: err.message });
    }
    console.error('[http] unhandled error:', err);
    return res.status(500).json({ error: 'Internal server error.' });
  });

  return app;
}
