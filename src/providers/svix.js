/**
 * Svix-style webhook signature verification (the scheme Resend uses).
 *
 * Resend signs every webhook with the endpoint's signing secret and sends the
 * result in three headers:
 *   - `svix-id`         unique message id
 *   - `svix-timestamp`  unix seconds
 *   - `svix-signature`  space-separated list of `v1,<base64 hmac>` entries
 *
 * The signed content is `${id}.${timestamp}.${rawBody}` and the HMAC is
 * SHA-256 keyed with the base64-decoded secret (after the `whsec_` prefix).
 *
 * The signature is computed over the RAW request body, so callers must pass the
 * bytes exactly as received: re-serialising the JSON will break verification.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const DEFAULT_TOLERANCE_MS = 5 * 60 * 1000;

/** Decode a Resend/Svix signing secret into the raw HMAC key bytes. */
export function decodeSvixSecret(secret) {
  const raw = String(secret ?? '').trim();
  if (!raw) throw new Error('Missing webhook secret');
  const base64 = raw.startsWith('whsec_') ? raw.slice('whsec_'.length) : raw;
  const key = Buffer.from(base64, 'base64');
  if (key.length === 0) throw new Error('Invalid webhook secret');
  return key;
}

function asBytes(payload) {
  return Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload ?? ''), 'utf8');
}

/** Read a header from an Express `req.headers` object or a `Headers` instance. */
function readHeader(headers, name) {
  if (!headers) return '';
  const lower = name.toLowerCase();
  if (typeof headers.get === 'function') return String(headers.get(name) ?? '');
  return String(headers[lower] ?? headers[name] ?? '');
}

/** Build a `svix-signature` header value for a payload. Exported for tests. */
export function signSvixPayload({ payload, id, timestamp, secret }) {
  const key = decodeSvixSecret(secret);
  const signed = `${id}.${timestamp}.${asBytes(payload).toString('utf8')}`;
  return `v1,${createHmac('sha256', key).update(signed).digest('base64')}`;
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a), 'utf8');
  const right = Buffer.from(String(b), 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Verify a webhook request.
 *
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function verifySvixSignature({
  payload,
  headers,
  secret,
  toleranceMs = DEFAULT_TOLERANCE_MS,
  now = Date.now(),
} = {}) {
  if (!secret) return { ok: false, reason: 'no-secret' };

  const id = readHeader(headers, 'svix-id');
  const timestamp = readHeader(headers, 'svix-timestamp');
  const signature = readHeader(headers, 'svix-signature');
  if (!id || !timestamp || !signature) return { ok: false, reason: 'missing-headers' };

  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds)) return { ok: false, reason: 'invalid-timestamp' };
  if (toleranceMs > 0 && Math.abs(now - seconds * 1000) > toleranceMs) {
    return { ok: false, reason: 'timestamp-out-of-tolerance' };
  }

  let expected;
  try {
    expected = signSvixPayload({ payload, id, timestamp, secret });
  } catch {
    return { ok: false, reason: 'bad-secret' };
  }

  const candidates = signature
    .split(/\s+/)
    .map((entry) => entry.trim())
    .filter(Boolean);

  for (const candidate of candidates) {
    if (safeEqual(candidate, expected)) return { ok: true };
  }
  return { ok: false, reason: 'signature-mismatch' };
}
