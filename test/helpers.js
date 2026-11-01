import { loadConfig } from '../src/config.js';
import { MailboxStore } from '../src/store.js';
import { createApp } from '../src/app.js';

export const TEST_ENV = {
  DOMAINS: 'a.test,b.test',
  MAILBOX_TTL_MINUTES: '10',
  MAX_MAILBOXES_PER_SESSION: '3',
  CREATE_RATE_LIMIT_MAX: '1000',
  CREATE_RATE_LIMIT_WINDOW_MS: '60000',
  RANDOM_LOCAL_PART_LENGTH: '10',
};

export const SESSION = 'session-test-0001';

export function makeSetup(envOverrides = {}) {
  const config = loadConfig({ ...TEST_ENV, ...envOverrides });
  const store = new MailboxStore({
    ttlMs: config.ttlMs,
    maxMailboxesPerSession: config.maxMailboxesPerSession,
  });
  const app = createApp({ store, config });
  return { config, store, app };
}
