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

/**
 * Build the runtime configuration from an environment object.
 * @param {Record<string, string|undefined>} env
 */
export function loadConfig(env = process.env) {
  const domains = parseDomainList(env.DOMAINS);
  const ttlMinutes = toInt(env.MAILBOX_TTL_MINUTES, 30);

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
    maxMailboxesPerSession: toInt(env.MAX_MAILBOXES_PER_SESSION, 10),
    sweepIntervalMs: toInt(env.SWEEP_INTERVAL_MS, 60 * 1000),
    randomLocalPartLength: toInt(env.RANDOM_LOCAL_PART_LENGTH, 10),

    createRateLimit: {
      windowMs: toInt(env.CREATE_RATE_LIMIT_WINDOW_MS, 10 * 60 * 1000),
      max: toInt(env.CREATE_RATE_LIMIT_MAX, 30),
    },

    corsOrigin: env.CORS_ORIGIN || '',
    trustProxy: env.TRUST_PROXY === 'true',
  };
}

export const config = loadConfig();
