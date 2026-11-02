import { loadConfig } from '../src/config.js';
import { MailboxStore } from '../src/store.js';
import { createApp } from '../src/app.js';
import { createProviders } from '../src/providers/index.js';

export const TEST_ENV = {
  DOMAINS: 'a.test,b.test',
  MAILBOX_TTL_MINUTES: '10',
  MAX_MAILBOX_LIFETIME_MINUTES: '40',
  MAX_MAILBOXES_PER_SESSION: '3',
  CREATE_RATE_LIMIT_MAX: '1000',
  CREATE_RATE_LIMIT_WINDOW_MS: '60000',
  RANDOM_LOCAL_PART_LENGTH: '10',
  POLL_INTERVAL_MS: '8000',
  // Provider defaults used by the tests. Calls are always mocked; these keep
  // the scheduling logic out of the way.
  ENABLE_GUERRILLA: 'true',
  GUERRILLA_MIN_REQUEST_INTERVAL_MS: '0',
  GUERRILLA_MIN_SYNC_INTERVAL_MS: '2000',
  GUERRILLA_REQUEST_TIMEOUT_MS: '2000',
  // The Resend provider is off unless a test opts in explicitly, so the
  // existing provider expectations in the suite are unchanged.
  ENABLE_RESEND: 'false',
  RESEND_REQUEST_TIMEOUT_MS: '2000',
  RESEND_MAX_RETRIES: '0',
  RESEND_RETRY_BASE_MS: '0',
};

export const SESSION = 'session-test-0001';

export function makeSetup(envOverrides = {}, options = {}) {
  const config = loadConfig({ ...TEST_ENV, ...envOverrides });
  const store = new MailboxStore({
    ttlMs: config.ttlMs,
    maxMailboxesPerSession: config.maxMailboxesPerSession,
  });
  const providers = createProviders({
    store,
    config,
    guerrillaClient: options.guerrillaClient,
    resendClient: options.resendClient,
    logger: options.logger ?? { warn() {} },
  });
  const app = createApp({ store, config, providers });
  return { config, store, app, providers };
}
