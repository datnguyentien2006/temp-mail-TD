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

function toFloat(value, fallback, { min = -Infinity, max = Infinity } = {}) {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) return fallback;
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

  // Third mailbox provider: Resend inbound (receive-only). The soft limit is a
  // ratio of the hard limits so the UI can warn before the hard stop.
  const resendSoftLimitRatio = toFloat(env.RESEND_SOFT_LIMIT_RATIO, 0.8, { min: 0.1, max: 1 });

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
    // Concurrent live inboxes allowed per browser session. The per-IP create
    // rate limit above still applies, so this is a cap on how many addresses
    // a single session can hold at once, not how fast they can be created.
    maxMailboxesPerSession: toInt(env.MAX_MAILBOXES_PER_SESSION, 100),
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

    // --- third provider: Resend inbound (receive-only) ----------------
    // Mail is never sent by this app. Resend posts an `email.received`
    // webhook; the backend fetches the body over the receiving API.
    resend: {
      // Kill switch: false removes the provider from /api/domains and the UI.
      enabled: toBool(env.ENABLE_RESEND, true),
      // Secrets live only here (from the environment) and are never logged,
      // serialised or returned to clients.
      apiKey: env.RESEND_API_KEY || '',
      webhookSecret: env.RESEND_WEBHOOK_SECRET || '',
      // Domains verified for receiving in Resend (custom domains and/or the
      // account's <id>.resend.app subdomain). Never hardcode these.
      domains: parseDomainList(env.RESEND_DOMAINS),
      apiBase: env.RESEND_API_BASE || 'https://api.resend.com',
      userAgent:
        env.RESEND_USER_AGENT ||
        'temp-mail-td/1.0 (self-hosted disposable mail; +https://github.com/datnguyentien2006/temp-mail-TD)',
      requestTimeoutMs: toInt(env.RESEND_REQUEST_TIMEOUT_MS, 10000),
      maxRetries: toInt(env.RESEND_MAX_RETRIES, 2, { min: 0 }),
      retryBaseMs: toInt(env.RESEND_RETRY_BASE_MS, 500, { min: 0 }),
      // Reject webhooks whose svix-timestamp is outside this window (replay
      // protection). Set to 0 to disable the check.
      signatureToleranceMs: toInt(env.RESEND_SIGNATURE_TOLERANCE_MS, 5 * 60 * 1000, { min: 0 }),
      webhookPath: '/api/webhooks/resend',
      webhookMaxBytes: toInt(env.RESEND_WEBHOOK_MAX_BYTES, 1024 * 1024),
      dedupeTtlMs: toInt(env.RESEND_DEDUPE_TTL_MS, 24 * 60 * 60 * 1000),
      // Free plan: 100/day and 3,000/month, shared with sent mail.
      dailyLimit: toInt(env.RESEND_DAILY_LIMIT, 100),
      monthlyLimit: toInt(env.RESEND_MONTHLY_LIMIT, 3000),
      softLimitRatio: resendSoftLimitRatio,
      maxMessagesPerMailbox: toInt(env.RESEND_MAX_MESSAGES_PER_MAILBOX, 50),
      maxMessagesPerSender: toInt(env.RESEND_MAX_MESSAGES_PER_SENDER, 20),
      // This app keeps mail only for the mailbox lifetime; Resend itself keeps
      // received mail for about 30 days.
      retentionMinutes: ttlMinutes,
      retentionMs: ttlMinutes * 60 * 1000,
    },
  };
}

export const config = loadConfig();
