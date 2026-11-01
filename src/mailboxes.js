/**
 * Mailbox address rules: local-part validation, domain allow-listing and
 * random address generation. All pure functions -> easy to unit-test.
 */
import { randomBytes } from 'node:crypto';

/** Names that must never be claimable by a user. */
export const RESERVED_LOCAL_PARTS = new Set([
  'admin',
  'administrator',
  'postmaster',
  'hostmaster',
  'webmaster',
  'abuse',
  'noreply',
  'no-reply',
  'mailer-daemon',
  'root',
  'support',
  'security',
  'info',
  'billing',
  'sales',
  'mail',
  'email',
  'tempmail',
  'temp-mail',
  'null',
  'void',
  'localhost',
  'test',
  'ftp',
  'smtp',
  'imap',
  'pop',
  'pop3',
  'www',
  'api',
  'help',
]);

// Must start and end with an alphanumeric; 1..64 chars; no leading/trailing dot.
const LOCAL_PART_RE = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;

export function normalizeLocalPart(value) {
  return String(value ?? '').trim().toLowerCase();
}

export function normalizeDomain(value) {
  return String(value ?? '').trim().toLowerCase().replace(/\.+$/, '');
}

/**
 * @param {string} localPart already normalised
 * @returns {{ok: true} | {ok: false, error: string}}
 */
export function validateLocalPart(localPart) {
  if (!localPart) return { ok: false, error: 'Local part is required.' };
  if (localPart.length > 64) {
    return { ok: false, error: 'Local part must be 64 characters or fewer.' };
  }
  if (localPart.includes('..')) {
    return { ok: false, error: 'Local part cannot contain consecutive dots.' };
  }
  if (!LOCAL_PART_RE.test(localPart)) {
    return {
      ok: false,
      error:
        'Local part may contain only letters, digits, dots, underscores and hyphens, and must start and end with a letter or digit.',
    };
  }
  if (RESERVED_LOCAL_PARTS.has(localPart)) {
    return { ok: false, error: `"${localPart}" is a reserved name.` };
  }
  return { ok: true };
}

/**
 * @param {string} domain
 * @param {string[]} allowedDomains
 * @returns {{ok: true, domain: string} | {ok: false, error: string}}
 */
export function validateDomain(domain, allowedDomains) {
  const normalized = normalizeDomain(domain);
  if (!normalized) return { ok: false, error: 'Domain is required.' };
  if (!Array.isArray(allowedDomains) || !allowedDomains.includes(normalized)) {
    return { ok: false, error: `Domain "${normalized}" is not one of the allowed domains.` };
  }
  return { ok: true, domain: normalized };
}

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** Cryptographically-random, unambiguous local part. */
export function randomLocalPart(length = 10) {
  const len = Math.max(6, Math.min(32, Number(length) || 10));
  const bytes = randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i += 1) {
    out += ALPHABET[bytes[i] % ALPHABET.length];
  }
  // Practically impossible, but never hand out a reserved name.
  if (RESERVED_LOCAL_PARTS.has(out)) return `x${out}`.slice(0, 64);
  return out;
}

export function buildAddress(localPart, domain) {
  return `${localPart}@${domain}`;
}
