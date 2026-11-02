/**
 * Minimal, dependency-free client for Resend's *receiving* API.
 *
 * Docs: https://resend.com/docs/api-reference/emails/retrieve-received-email
 *
 * This client is deliberately one-way: it only exposes read endpoints used to
 * fetch a received message body. There is no send/reply/forward method here, by
 * design — the app is receive-only.
 *
 * Defensive choices:
 *  - backend-only (the API key never reaches the browser),
 *  - every request carries the mandatory `User-Agent` (Resend rejects requests
 *    without one with 403/1010),
 *  - per-request timeout, retries with exponential backoff on 429/5xx/network,
 *  - `Retry-After` is honoured when present,
 *  - every response is treated as untrusted and shape-checked,
 *  - a 404 means "gone/expired" and maps to `null`,
 *  - the authorized `Authorization` header is never logged.
 */
import { providerError } from './errors.js';

function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

export function createResendClient(cfg, { fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('A fetch implementation is required for the Resend client.');
  }
  const base = String(cfg.apiBase || 'https://api.resend.com').replace(/\/+$/, '');

  async function backoff(attempt, minMs = 0) {
    const baseMs = (Number(cfg.retryBaseMs) || 0) * 2 ** attempt;
    const jitter = (Number(cfg.retryBaseMs) || 0) * Math.random();
    await delay(Math.max(Number(minMs) || 0, baseMs + jitter));
  }

  function retryAfterMs(response) {
    const raw = response?.headers?.get?.('retry-after');
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, 30000);
    return 0;
  }

  function requestHeaders() {
    const headers = {
      Accept: 'application/json',
      // Mandatory: Resend answers 403 (error 1010) without a User-Agent.
      'User-Agent': cfg.userAgent || 'temp-mail-td/1.0',
    };
    if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
    return headers;
  }

  /** GET a JSON resource, with retries. Never used for anything but reads. */
  async function get(path) {
    const retries = Math.max(0, Number(cfg.maxRetries) || 0);
    let attempt = 0;

    for (;;) {
      let response;
      try {
        response = await fetchImpl(`${base}${path}`, {
          method: 'GET',
          headers: requestHeaders(),
          signal: AbortSignal.timeout(cfg.requestTimeoutMs || 10000),
        });
      } catch {
        if (attempt < retries) {
          await backoff(attempt);
          attempt += 1;
          continue;
        }
        throw providerError(
          502,
          'Could not reach Resend. Please try again later.',
          'RESEND_UNAVAILABLE',
        );
      }

      if (response.status === 404) return null;

      if (response.status === 401 || response.status === 403) {
        throw providerError(
          502,
          'Resend rejected the API key. Check RESEND_API_KEY and its permissions.',
          'RESEND_AUTH',
        );
      }

      if (response.status === 429) {
        if (attempt < retries) {
          await backoff(attempt, retryAfterMs(response));
          attempt += 1;
          continue;
        }
        throw providerError(
          503,
          'Resend is rate limiting this server. Please try again later.',
          'RESEND_RATE_LIMITED',
        );
      }

      if (response.status >= 500) {
        if (attempt < retries) {
          await backoff(attempt);
          attempt += 1;
          continue;
        }
        throw providerError(502, `Resend returned HTTP ${response.status}.`, 'RESEND_HTTP');
      }

      if (!response.ok) {
        throw providerError(502, `Resend returned HTTP ${response.status}.`, 'RESEND_HTTP');
      }

      let json;
      try {
        json = JSON.parse(await response.text());
      } catch {
        throw providerError(
          502,
          'Resend returned an unreadable response.',
          'RESEND_INVALID_RESPONSE',
        );
      }
      if (!json || typeof json !== 'object' || Array.isArray(json)) {
        throw providerError(
          502,
          'Resend returned an unreadable response.',
          'RESEND_INVALID_RESPONSE',
        );
      }
      return json;
    }
  }

  return {
    /**
     * Fetch one received email. Returns the object, or `null` when Resend says
     * it is gone (404 — e.g. the ~30-day retention elapsed).
     */
    getReceivedEmail(emailId, { htmlFormat } = {}) {
      const id = encodeURIComponent(String(emailId ?? '').trim());
      const query = htmlFormat ? `?html_format=${encodeURIComponent(htmlFormat)}` : '';
      return get(`/emails/receiving/${id}${query}`);
    },
  };
}
