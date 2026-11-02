/**
 * Minimal, dependency-free client for the public Guerrilla Mail JSON API.
 *
 * Docs: https://www.guerrillamail.com/GuerrillaMailAPI.html (v1.6, 2015)
 *
 * This client is deliberately defensive:
 *  - backend-only (the browser never sees the API or a sid_token),
 *  - a global concurrency cap and minimum spacing between requests,
 *  - per-request timeout and a clear User-Agent,
 *  - exponential backoff after transport/5xx/429 failures,
 *  - every response is treated as untrusted and shape-checked.
 */
import { providerError } from './errors.js';

function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

class Semaphore {
  constructor(max) {
    this.max = Math.max(1, max);
    this.active = 0;
    this.queue = [];
  }

  acquire() {
    if (this.active < this.max) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.queue.push(resolve));
  }

  release() {
    this.active -= 1;
    const next = this.queue.shift();
    if (next) {
      this.active += 1;
      next();
    }
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function createGuerrillaClient(cfg, { fetchImpl = globalThis.fetch } = {}) {
  const semaphore = new Semaphore(cfg.maxConcurrency);
  let queue = Promise.resolve();
  let lastRequestAt = 0;
  let failures = 0;
  let backoffUntil = 0;

  function noteFailure() {
    failures += 1;
    const wait = Math.min(cfg.maxBackoffMs, 1000 * 2 ** Math.min(failures, 10));
    backoffUntil = Date.now() + wait;
  }

  function noteSuccess() {
    failures = 0;
    backoffUntil = 0;
  }

  /** Serialise request starts so we never exceed the configured rate. */
  function schedule(task) {
    const run = queue.then(async () => {
      const wait = lastRequestAt + cfg.minRequestIntervalMs - Date.now();
      if (wait > 0) await delay(wait);
      lastRequestAt = Date.now();
      await semaphore.acquire();
      try {
        return await task();
      } finally {
        semaphore.release();
      }
    });
    // Keep the chain alive even if one request rejects.
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async function request(fn, params = {}, sidToken = '') {
    if (Date.now() < backoffUntil) {
      throw providerError(
        503,
        'Guerrilla Mail is temporarily unavailable. Please try again shortly.',
        'GUERRILLA_BACKOFF',
      );
    }

    let url;
    try {
      url = new URL(cfg.apiBase);
    } catch {
      throw providerError(502, 'Guerrilla Mail endpoint is misconfigured.', 'GUERRILLA_CONFIG');
    }
    url.searchParams.set('f', fn);
    url.searchParams.set('lang', params.lang || 'en');
    url.searchParams.set('agent', cfg.userAgent);
    if (sidToken) url.searchParams.set('sid_token', sidToken);
    for (const [key, value] of Object.entries(params)) {
      if (key === 'lang') continue;
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) {
        for (const item of value) url.searchParams.append(`${key}[]`, String(item));
      } else {
        url.searchParams.set(key, String(value));
      }
    }

    let response;
    try {
      response = await schedule(() =>
        fetchImpl(url, {
          method: 'GET',
          headers: {
            'User-Agent': cfg.userAgent,
            Accept: 'application/json',
          },
          signal: AbortSignal.timeout(cfg.requestTimeoutMs),
        }),
      );
    } catch {
      noteFailure();
      throw providerError(
        502,
        'Could not reach Guerrilla Mail. Please try again later.',
        'GUERRILLA_UNAVAILABLE',
      );
    }

    if (!response.ok) {
      noteFailure();
      if (response.status === 429) {
        throw providerError(
          429,
          'Guerrilla Mail is rate limiting this server. Please try again later.',
          'GUERRILLA_RATE_LIMITED',
        );
      }
      throw providerError(
        502,
        `Guerrilla Mail returned HTTP ${response.status}.`,
        'GUERRILLA_HTTP',
      );
    }

    let json;
    try {
      json = JSON.parse(await response.text());
    } catch {
      noteFailure();
      throw providerError(
        502,
        'Guerrilla Mail returned an unreadable response.',
        'GUERRILLA_INVALID_RESPONSE',
      );
    }

    noteSuccess();

    // The API reports authorisation problems inside the payload.
    if (isPlainObject(json) && isPlainObject(json.auth) && json.auth.success === false) {
      throw providerError(
        502,
        'Guerrilla Mail rejected the session. It may have expired.',
        'GUERRILLA_AUTH',
      );
    }

    return json;
  }

  return {
    request,

    async getEmailAddress({ lang = 'en' } = {}) {
      const result = await request('get_email_address', { lang });
      if (!isPlainObject(result) || typeof result.email_addr !== 'string' || !result.sid_token) {
        throw providerError(
          502,
          'Guerrilla Mail did not return a usable address.',
          'GUERRILLA_INVALID_RESPONSE',
        );
      }
      return result;
    },

    async setEmailUser({ sidToken, emailUser, lang = 'en' }) {
      const result = await request(
        'set_email_user',
        { email_user: emailUser, lang },
        sidToken,
      );
      if (!isPlainObject(result) || typeof result.email_addr !== 'string') {
        throw providerError(
          502,
          'Guerrilla Mail did not accept that address.',
          'GUERRILLA_INVALID_RESPONSE',
        );
      }
      return result;
    },

    async getEmailList({ sidToken, offset = 0 }) {
      const result = await request('get_email_list', { offset }, sidToken);
      if (!isPlainObject(result) || !Array.isArray(result.list)) {
        throw providerError(
          502,
          'Guerrilla Mail returned an unexpected inbox payload.',
          'GUERRILLA_INVALID_RESPONSE',
        );
      }
      return result;
    },

    async checkEmail({ sidToken, seq = 0 }) {
      const result = await request('check_email', { seq }, sidToken);
      if (!isPlainObject(result) || !Array.isArray(result.list)) {
        throw providerError(
          502,
          'Guerrilla Mail returned an unexpected inbox payload.',
          'GUERRILLA_INVALID_RESPONSE',
        );
      }
      return result;
    },

    async fetchEmail({ sidToken, emailId }) {
      const result = await request('fetch_email', { email_id: emailId }, sidToken);
      // Documented behaviour: literal `false` when the message is gone.
      if (result === false) return false;
      if (!isPlainObject(result)) {
        throw providerError(
          502,
          'Guerrilla Mail returned an unexpected message payload.',
          'GUERRILLA_INVALID_RESPONSE',
        );
      }
      return result;
    },

    async delEmail({ sidToken, emailIds }) {
      return request('del_email', { email_ids: emailIds }, sidToken);
    },

    async forgetMe({ sidToken, emailAddr }) {
      return request('forget_me', { email_addr: emailAddr }, sidToken);
    },
  };
}