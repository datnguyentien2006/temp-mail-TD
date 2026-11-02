import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, parseDomainList } from '../src/config.js';
import { normalizeDomain, validateDomain } from '../src/mailboxes.js';

test('parseDomainList trims, lowercases and drops empties', () => {
  assert.deepEqual(parseDomainList(' A.com , b.net ,, '), ['a.com', 'b.net']);
  assert.deepEqual(parseDomainList(''), []);
  assert.deepEqual(parseDomainList(undefined), []);
});

test('loadConfig parses DOMAINS and numeric options', () => {
  const cfg = loadConfig({ DOMAINS: 'x.test,y.test', PORT: '8080', MAILBOX_TTL_MINUTES: '15' });
  assert.deepEqual(cfg.domains, ['x.test', 'y.test']);
  assert.equal(cfg.port, 8080);
  assert.equal(cfg.ttlMs, 15 * 60 * 1000);
});

test('loadConfig falls back to defaults for bad numeric values', () => {
  const cfg = loadConfig({ PORT: 'not-a-number', MAILBOX_TTL_MINUTES: '-5' });
  assert.equal(cfg.port, 3000);
  assert.equal(cfg.ttlMinutes, 30);
});

test('validateDomain accepts an allowed domain case-insensitively', () => {
  const result = validateDomain('Mail.A.Test', ['mail.a.test']);
  assert.equal(result.ok, true);
  assert.equal(result.domain, 'mail.a.test');
});

test('validateDomain rejects a domain outside the allow-list', () => {
  const result = validateDomain('evil.test', ['a.test']);
  assert.equal(result.ok, false);
});

test('validateDomain rejects an empty domain', () => {
  assert.equal(validateDomain('', ['a.test']).ok, false);
  assert.equal(validateDomain(undefined, ['a.test']).ok, false);
});

test('normalizeDomain strips surrounding whitespace and trailing dots', () => {
  assert.equal(normalizeDomain('  a.test.  '), 'a.test');
});

test('loadConfig defaults the mailbox cap to 100 and derives the lifetime cap', () => {
  const cfg = loadConfig({ DOMAINS: 'a.test', MAILBOX_TTL_MINUTES: '15' });
  assert.equal(cfg.maxMailboxesPerSession, 100);
  assert.equal(cfg.maxMailboxLifetimeMinutes, 60); // 4x TTL by default
  assert.equal(cfg.maxMailboxLifetimeMs, 60 * 60 * 1000);
});

test('loadConfig honours MAX_MAILBOX_LIFETIME_MINUTES and POLL_INTERVAL_MS', () => {
  const cfg = loadConfig({
    DOMAINS: 'a.test',
    MAILBOX_TTL_MINUTES: '10',
    MAX_MAILBOX_LIFETIME_MINUTES: '25',
    POLL_INTERVAL_MS: '3000',
  });
  assert.equal(cfg.maxMailboxLifetimeMinutes, 25);
  assert.equal(cfg.pollIntervalMs, 3000);
});
