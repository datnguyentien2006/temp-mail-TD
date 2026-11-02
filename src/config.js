/**
 * Configuration loading and validation.
 *
 * `loadConfig(env)` is a pure function so it can be unit-tested with a
 * synthetic environment instead of mutating `process.env`.
 */

/** Parse a comma-separated domain list into a normalised array. */
export function parseDomainList(raw) {
  return String(raw ?? '')
    .split(',')
    .map((domain) => domain.trim().toLowerCase().replace(/\.+$/, ''))
    .filter(Boolean);
}

function toInt(value, fallback, { min = 1 } = {}) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < min) return fallback;
  return parsed;
}

function toBool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return !['false', '0', 'no', 'off'].includes(String(value).trim().toLowerCase());
}

/**
 * Build the runtime configuration from an environment object.
 * @param {Record<string, string|undefined>} env
 */
export function loadConfig(env = process.env) {
  const domains = parseDomainList(env.DOMAINS);
  const ttlMinutes = toInt(env.MAILBOX_TTL_MINUTES, 30);
  const maxMailboxLifetimeMinutes = toInt(env.MAX_MAILBOX_LIFETIME_MINUTES, ttlMinutes * 4);

  // Second mailbox provider: Guerrilla Mail's public JSON API. The API is
  // conservative by policy ("please use this API carefully"), so the poll
  // interval is clamped to a sane floor rather than trusting the env blindly.
  const guerrillaPollIntervalMs = Math.max(
    10000,
    toInt(env.GUERRILLA_POLL_INTERVAL_MS, 15000),
  );

  return {
    env: env.NODE_ENV || 'development',
    host: env.HOST || '0.0.0.0',
    port: toInt(env.PORT, 3000),

    smtp: {
      host: env.SMTP_HOST || '0.0.0.0',
      port: toInt(env.SMTP_PORT, 2525),
      maxBytes: toInt(env.SMTP_MAX_MESSAGE_BYTES, 10 * 1024 * 1024),
      tls: {
        key: env.SMTP_TLS_KEY || '',
        cert: env.SMTP_TLS_CERT || '',
      },
    },

    domains,
    ttlMinutes,
    ttlMs: ttlMinutes * 60 * 1000,
    maxMailboxesPerSession: toInt(env.MAX_MAILBOXES_PER_SESSION, 5),
    // Hard ceiling on how long a single mailbox may live, however often it is
    // extended. Defaults to 4x the base TTL.
    maxMailboxLifetimeMinutes,
    maxMailboxLifetimeMs: maxMailboxLifetimeMinutes * 60 * 1000,
    sweepIntervalMs: toInt(env.SWEEP_INTERVAL_MS, 60 * 1000),
    randomLocalPartLength: toInt(env.RANDOM_LOCAL_PART_LENGTH, 10),
    // Polling fallback used by the client when the WebSocket is unavailable.
    pollIntervalMs: toInt(env.POLL_INTERVAL_MS, 8000),

    createRateLimit: {
      windowMs: toInt(env.CREATE_RATE_LIMIT_WINDOW_MS, 10 * 60 * 1000),
      max: toInt(env.CREATE_RATE_LIMIT_MAX, 30),
    },

    corsOrigin: env.CORS_ORIGIN || '',
    trustProxy: env.TRUST_PROXY === 'true',

    // --- second provider: Guerrilla Mail ------------------------------
    guerrilla: {
      enabled: toBool(env.ENABLE_GUERRILLA, true),
      apiBase: env.GUERRILLA_API_BASE || 'https://api.guerrillamail.com/ajax.php',
      userAgent:
        env.GUERRILLA_USER_AGENT ||
        'temp-mail-td/1.0 (self-hosted disposable mail; +https://github.com/datnguyentien2006/temp-mail-TD)',
      pollIntervalMs: guerrillaPollIntervalMs,
      // Never sync the same inbox more often than this, even if the client
      // polls faster than the background poller.
      minSyncIntervalMs: Math.max(
        2000,
        toInt(env.GUERRILLA_MIN_SYNC_INTERVAL_MS, guerrillaPollIntervalMs),
      ),
      requestTimeoutMs: toInt(env.GUERRILLA_REQUEST_TIMEOUT_MS, 10000),
      maxConcurrency: toInt(env.GUERRILLA_MAX_CONCURRENCY, 4),
      // Minimum spacing between any two outbound Guerrilla requests.
      minRequestIntervalMs: toInt(env.GUERRILLA_MIN_REQUEST_INTERVAL_MS, 300, { min: 0 }),
      maxBackoffMs: toInt(env.GUERRILLA_MAX_BACKOFF_MS, 5 * 60 * 1000),
      // How long an inbox counts as "open" after it is used. Only open
      // inboxes are polled in the background.
      activeWindowMs: toInt(env.GUERRILLA_ACTIVE_WINDOW_MS, 5 * 60 * 1000),
      // Mail is retained by Guerrilla Mail for roughly one hour.
      retentionMinutes: toInt(env.GUERRILLA_RETENTION_MINUTES, 60),
      retentionMs: toInt(env.GUERRILLA_RETENTION_MINUTES, 60) * 60 * 1000,
    },
  };
}

export const config = loadConfig();
