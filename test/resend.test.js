import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { makeSetup, SESSION } from './helpers.js';
import { signSvixPayload, verifySvixSignature } from '../src/providers/svix.js';
import { createResendClient } from '../src/providers/resend-client.js';
import { QuotaTracker } from '../src/providers/quota.js';

const OTHER_SESSION = 'session-resend-0002';
const SECRET = `whsec_${Buffer.from('super-secret-signing-key').toString('base64')}`;

const RESEND_ENV = {
  ENABLE_RESEND: 'true',
  RESEND_DOMAINS: 'r.test,s.test',
  RESEND_API_KEY: 're_test_key_placeholder',
  RESEND_WEBHOOK_SECRET: SECRET,
  RESEND_MAX_RETRIES: '0',
  RESEND_RETRY_BASE_MS: '0',
  MAX_MAILBOXES_PER_SESSION: '10',
};

/* --------------------------------------------------------------- helpers */

function apiError(code, status, message) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  error.expose = true;
  return error;
}

/** In-memory stand-in for the Resend receiving client. Never hits the network. */
function createFakeResend() {
  const fake = {
    calls: [],
    bodies: new Map(),
    fail: null, // null | 'timeout' | 401 | 429 | 500
    async getReceivedEmail(emailId, options = {}) {
      fake.calls.push({ method: 'GET', path: `/emails/receiving/${emailId}`, options });
      if (fake.fail === 'timeout') {
        throw apiError('RESEND_UNAVAILABLE', 502, 'Could not reach Resend.');
      }
      if (fake.fail === 401) {
        throw apiError('RESEND_AUTH', 502, 'Resend rejected the API key.');
      }
      if (fake.fail === 429) {
        throw apiError('RESEND_RATE_LIMITED', 503, 'Resend is rate limiting this server.');
      }
      if (fake.fail === 500) {
        throw apiError('RESEND_HTTP', 502, 'Resend returned HTTP 500.');
      }
      const value = fake.bodies.get(String(emailId));
      return value === undefined ? null : value;
    },
  };
  return fake;
}

function setupResend(env = {}, options = {}) {
  const fake = options.fake ?? createFakeResend();
  const setup = makeSetup({ ...RESEND_ENV, ...env }, { ...options, resendClient: fake });
  return { ...setup, fake };
}

function receivedEvent(data = {}) {
  return {
    type: 'email.received',
    created_at: new Date().toISOString(),
    data: {
      email_id: 'em-1',
      from: 'sender@sender.test',
      to: ['hello@r.test'],
      cc: [],
      bcc: [],
      subject: 'Hi',
      message_id: '<1@sender.test>',
      attachments: [],
      ...data,
    },
  };
}

function receivedBody(overrides = {}) {
  return {
    object: 'email',
    id: 'em-1',
    to: ['hello@r.test'],
    from: 'sender@sender.test',
    created_at: new Date().toISOString(),
    subject: 'Hi',
    html: '<p>hello</p>',
    text: 'hello',
    headers: { from: 'Sender Name <sender@sender.test>' },
    attachments: [],
    authentication: { spf: 'pass', dkim: 'pass', dmarc: 'pass' },
    ...overrides,
  };
}

function signHeaders(raw, { id = 'msg_1', secret = SECRET } = {}) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  return {
    id,
    timestamp,
    signature: signSvixPayload({ payload: raw, id, timestamp, secret }),
  };
}

function postWebhook(app, raw, { id, timestamp, signature, contentType = 'application/json' } = {}) {
  const req = request(app).post('/api/webhooks/resend').set('Content-Type', contentType);
  if (id) req.set('svix-id', id);
  if (timestamp) req.set('svix-timestamp', timestamp);
  if (signature) req.set('svix-signature', signature);
  // Send the string verbatim: superagent would JSON-encode a Buffer, which
  // changes the raw bytes and breaks the signature over them.
  return req.send(String(raw));
}

async function createResendMailbox(app, session = SESSION, body = {}) {
  return request(app)
    .post('/api/mailboxes')
    .set('x-session-id', session)
    .send({ provider: 'resend', ...body });
}

function waitFor(predicate, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const timer = setInterval(() => {
      const value = predicate();
      if (value) {
        clearInterval(timer);
        resolve(value);
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(timer);
        reject(new Error('Timed out waiting for condition'));
      }
    }, 10);
  });
}

function response(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[String(name).toLowerCase()] ?? null },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

const CLIENT_CFG = {
  apiBase: 'https://api.resend.test',
  apiKey: 're_test_key_placeholder',
  userAgent: 'temp-mail-td/test',
  requestTimeoutMs: 50,
  maxRetries: 1,
  retryBaseMs: 0,
};

/* ------------------------------------------------------- /api/domains --- */

test('GET /api/domains lists Resend only when enabled and configured', async () => {
  const on = setupResend();
  const listed = await request(on.app).get('/api/domains');
  const resend = listed.body.providers.find((provider) => provider.id === 'resend');
  assert.ok(resend, 'Resend should be listed when enabled and configured');
  assert.deepEqual(resend.domains, ['r.test', 's.test']);
  assert.equal(resend.capabilities.supportsDomainChoice, true);
  assert.equal(resend.capabilities.supportsCustomLocalPart, true);
  assert.equal(resend.capabilities.supportsAttachments, false);
  assert.equal(resend.status.available, true);
  assert.ok(listed.body.domains.includes('r.test'));

  const disabled = setupResend({ ENABLE_RESEND: 'false' });
  const off = await request(disabled.app).get('/api/domains');
  assert.ok(!off.body.providers.some((provider) => provider.id === 'resend'));

  const unconfigured = setupResend({ RESEND_DOMAINS: '' });
  const none = await request(unconfigured.app).get('/api/domains');
  assert.ok(!none.body.providers.some((provider) => provider.id === 'resend'));
});

test('a configured-but-unkeyed Resend provider is reported unavailable', async () => {
  const { app } = setupResend({ RESEND_API_KEY: '' });
  const res = await request(app).get('/api/domains');
  const resend = res.body.providers.find((provider) => provider.id === 'resend');
  assert.equal(resend.status.available, false);
  assert.match(resend.status.reason, /RESEND_API_KEY/);
});

/* ------------------------------------------------ virtual mailbox create */

test('POST /api/mailboxes creates a virtual Resend mailbox without calling the API', async () => {
  const { app, fake } = setupResend();
  const res = await createResendMailbox(app, SESSION, { localPart: 'My.Name', domain: 'r.test' });

  assert.equal(res.status, 201);
  assert.equal(res.body.provider, 'resend');
  assert.equal(res.body.address, 'my.name@r.test');
  assert.ok(res.body.expiresAt > Date.now());
  assert.equal(fake.calls.length, 0, 'creating a mailbox is virtual');
  assert.ok(!('providerData' in res.body));
});

test('POST /api/mailboxes validates the Resend domain and local part', async () => {
  const { app } = setupResend();

  const badDomain = await createResendMailbox(app, SESSION, { domain: 'evil.test' });
  assert.equal(badDomain.status, 400);

  const badLocal = await createResendMailbox(app, SESSION, { localPart: 'admin' });
  assert.equal(badLocal.status, 400);

  const taken = await createResendMailbox(app, SESSION, { localPart: 'dup', domain: 'r.test' });
  assert.equal(taken.status, 201);
  const again = await createResendMailbox(app, SESSION, { localPart: 'dup', domain: 'r.test' });
  assert.equal(again.status, 409);
});

/* ------------------------------------------------------------ signature */

test('the webhook verifies the signature over the raw body', async () => {
  const { app, fake } = setupResend();
  const mailbox = await createResendMailbox(app);
  fake.bodies.set('em-1', receivedBody());

  const raw = JSON.stringify(receivedEvent({ to: [mailbox.body.address] }));
  const headers = signHeaders(raw);

  const ok = await postWebhook(app, raw, headers);
  assert.equal(ok.status, 202);

  await waitFor(() => fake.calls.length === 1);
});

test('a missing or invalid signature is rejected with 401 and never processed', async () => {
  const { app, fake } = setupResend();
  const mailbox = await createResendMailbox(app);
  fake.bodies.set('em-1', receivedBody());

  const raw = JSON.stringify(receivedEvent({ to: [mailbox.body.address] }));

  const missing = await postWebhook(app, raw, {});
  assert.equal(missing.status, 401);

  const headers = signHeaders(raw);
  const invalid = await postWebhook(app, raw, { ...headers, signature: 'v1,not-a-real-signature' });
  assert.equal(invalid.status, 401);

  // Signed with a different secret.
  const foreign = signHeaders(raw, { secret: `whsec_${Buffer.from('another-key').toString('base64')}` });
  const wrongSecret = await postWebhook(app, raw, foreign);
  assert.equal(wrongSecret.status, 401);

  assert.equal(fake.calls.length, 0, 'no message must be fetched without a valid signature');
});

test('a re-serialised body fails verification (raw bytes are signed)', async () => {
  const { app } = setupResend();
  const event = receivedEvent();
  const raw = JSON.stringify(event);
  const headers = signHeaders(raw);

  // A semantically identical body with different whitespace must NOT verify.
  const reformatted = JSON.stringify(event, null, 2);
  assert.notEqual(reformatted, raw);
  const res = await postWebhook(app, reformatted, headers);
  assert.equal(res.status, 401);

  // The original bytes still verify.
  const good = await postWebhook(app, raw, headers);
  assert.equal(good.status, 202);
});

test('non email.received events are acknowledged and ignored', async () => {
  const { app, fake } = setupResend();
  const raw = JSON.stringify({ type: 'email.delivered', data: { email_id: 'x' } });
  const res = await postWebhook(app, raw, signHeaders(raw));
  assert.equal(res.status, 200);
  assert.equal(res.body.ignored, true);
  assert.equal(fake.calls.length, 0);
});

test('the webhook is not exposed when the provider is disabled', async () => {
  const { app } = setupResend({ ENABLE_RESEND: 'false' });
  const raw = JSON.stringify(receivedEvent());
  const res = await postWebhook(app, raw, signHeaders(raw));
  assert.equal(res.status, 404);
});

/* -------------------------------------------------------------- ingest */

test('webhooks for unknown or expired addresses are dropped silently', async () => {
  const { app, store, providers, fake } = setupResend();
  const provider = providers.get('resend');

  const unknown = await provider.handleReceivedEvent(receivedEvent({ to: ['ghost@r.test'] }));
  assert.equal(unknown.stored, 0);
  assert.equal(unknown.reason, 'no-mailbox');
  assert.equal(fake.calls.length, 0);

  const created = await createResendMailbox(app, SESSION, { localPart: 'expired' });
  store.get(created.body.address).expiresAt = Date.now() - 1;
  fake.bodies.set('em-2', receivedBody({ id: 'em-2' }));

  const expired = await provider.handleReceivedEvent(
    receivedEvent({ email_id: 'em-2', to: [created.body.address] }),
  );
  assert.equal(expired.stored, 0);
  assert.equal(expired.reason, 'no-mailbox');
  assert.equal(fake.calls.length, 0, 'an expired mailbox must not trigger a fetch');
});

test('a duplicate email_id is processed only once', async () => {
  const { app, store, providers, fake } = setupResend();
  const created = await createResendMailbox(app);
  const address = created.body.address;
  fake.bodies.set('em-1', receivedBody());

  const provider = providers.get('resend');
  const event = receivedEvent({ to: [address] });

  const first = await provider.handleReceivedEvent(event);
  const second = await provider.handleReceivedEvent(event);

  assert.equal(first.stored, 1);
  assert.equal(second.reason, 'duplicate');
  assert.equal(fake.calls.length, 1);
  assert.equal(store.get(address).messages.length, 1);
});

test('the body is fetched, normalised and HTML-sanitised (XSS payload)', async () => {
  const { app, store, providers, fake } = setupResend();
  const created = await createResendMailbox(app);
  const address = created.body.address;

  fake.bodies.set('em-1', receivedBody({
    html:
      '<p>ok</p><script>alert(1)</script><img src=x onerror="alert(2)">' +
      '<a href="javascript:alert(3)">x</a>',
    text: '',
    attachments: [
      { id: 'a1', filename: 'doc.pdf', content_type: 'application/pdf', size: 1234 },
    ],
  }));

  const result = await providers.get('resend').handleReceivedEvent(receivedEvent({ to: [address] }));
  assert.equal(result.stored, 1);
  assert.deepEqual(fake.calls[0], {
    method: 'GET',
    path: '/emails/receiving/em-1',
    options: { htmlFormat: 'data_uri' },
  });

  const stored = store.get(address).messages[0];
  assert.equal(stored.from, 'Sender Name <sender@sender.test>');
  assert.equal(stored.authentication.spf, 'pass');
  assert.doesNotMatch(stored.html, /<script/i);
  assert.doesNotMatch(stored.html, /onerror/i);
  assert.doesNotMatch(stored.html, /javascript:/i);
  assert.match(stored.text, /ok/);

  const viaApi = await request(app)
    .get(`/api/mailboxes/${encodeURIComponent(address)}/messages/r-em-1`)
    .set('x-session-id', SESSION);
  assert.equal(viaApi.status, 200);
  assert.doesNotMatch(viaApi.body.html, /<script/i);
  assert.equal(viaApi.body.attachmentCount, 1);
  assert.equal(viaApi.body.attachments[0].filename, 'doc.pdf');
  assert.equal(viaApi.body.attachments[0].size, 1234);

  // Metadata only: downloading is refused.
  const download = await request(app)
    .get(`/api/mailboxes/${encodeURIComponent(address)}/messages/r-em-1/attachments/0`)
    .set('x-session-id', SESSION);
  assert.equal(download.status, 400);
});

test('a message delivered to several recipients is stored once per mailbox', async () => {
  const { app, store, providers, fake } = setupResend();
  const a = await createResendMailbox(app, SESSION, { localPart: 'one' });
  const b = await createResendMailbox(app, SESSION, { localPart: 'two' });
  fake.bodies.set('em-1', receivedBody());

  const result = await providers.get('resend').handleReceivedEvent(
    receivedEvent({ to: [a.body.address], cc: [b.body.address] }),
  );

  assert.equal(result.stored, 2);
  assert.equal(fake.calls.length, 1, 'the body is fetched once and copied');
  assert.equal(store.get(a.body.address).messages.length, 1);
  assert.equal(store.get(b.body.address).messages.length, 1);
});

test('Resend mailboxes are isolated per user session', async () => {
  const { app } = setupResend();
  const a = await createResendMailbox(app, SESSION, { localPart: 'mine' });
  const b = await createResendMailbox(app, OTHER_SESSION, { localPart: 'theirs' });

  const listB = await request(app).get('/api/mailboxes').set('x-session-id', OTHER_SESSION);
  assert.deepEqual(
    listB.body.mailboxes.map((mailbox) => mailbox.address),
    [b.body.address],
  );

  const peek = await request(app)
    .get(`/api/mailboxes/${encodeURIComponent(a.body.address)}/messages`)
    .set('x-session-id', OTHER_SESSION);
  assert.equal(peek.status, 404);

  const remove = await request(app)
    .delete(`/api/mailboxes/${encodeURIComponent(a.body.address)}`)
    .set('x-session-id', OTHER_SESSION);
  assert.equal(remove.status, 404);
});

/* --------------------------------------------------------------- quota */

test('the hard quota limit stops processing and marks the provider unavailable', async () => {
  const { app, store, providers, fake } = setupResend({
    RESEND_DAILY_LIMIT: '1',
    RESEND_MONTHLY_LIMIT: '1',
  });
  const created = await createResendMailbox(app);
  const address = created.body.address;
  fake.bodies.set('em-1', receivedBody());
  fake.bodies.set('em-2', receivedBody({ id: 'em-2' }));

  const provider = providers.get('resend');
  const first = await provider.handleReceivedEvent(
    receivedEvent({ email_id: 'em-1', to: [address] }),
  );
  assert.equal(first.stored, 1);

  const second = await provider.handleReceivedEvent(
    receivedEvent({ email_id: 'em-2', to: [address] }),
  );
  assert.equal(second.reason, 'quota');
  assert.equal(second.stored, 0);
  assert.equal(fake.calls.length, 1, 'no fetch once the hard limit is reached');
  assert.equal(store.get(address).messages.length, 1);

  assert.equal(provider.status().available, false);

  const listed = await request(app).get('/api/domains');
  const resend = listed.body.providers.find((p) => p.id === 'resend');
  assert.equal(resend.status.available, false);
});

test('the soft quota limit warns without stopping', async () => {
  const { app, providers, fake } = setupResend({
    RESEND_DAILY_LIMIT: '10',
    RESEND_MONTHLY_LIMIT: '1000',
    RESEND_SOFT_LIMIT_RATIO: '0.1',
  });
  const created = await createResendMailbox(app);
  fake.bodies.set('em-1', receivedBody());

  const provider = providers.get('resend');
  await provider.handleReceivedEvent(receivedEvent({ to: [created.body.address] }));

  const status = provider.status();
  assert.equal(status.available, true);
  assert.equal(status.degraded, true);
});

test('per-mailbox and per-sender caps are enforced', async () => {
  const { app, providers, fake } = setupResend({
    RESEND_MAX_MESSAGES_PER_MAILBOX: '3',
    RESEND_MAX_MESSAGES_PER_SENDER: '2',
  });
  const created = await createResendMailbox(app);
  const address = created.body.address;
  const provider = providers.get('resend');

  for (const id of ['em-1', 'em-2', 'em-3']) {
    fake.bodies.set(id, receivedBody({ id }));
    await provider.handleReceivedEvent(receivedEvent({ email_id: id, to: [address] }));
  }

  // The same sender is capped at 2 even though the mailbox cap is 3.
  const mailbox = (await request(app).get('/api/mailboxes').set('x-session-id', SESSION)).body
    .mailboxes.find((m) => m.address === address);
  assert.equal(mailbox.messageCount, 2);
});

/* --------------------------------------------------- API failure paths */

test('the Resend client maps 404 to null, retries 5xx and never sends', async () => {
  const notFound = createResendClient(CLIENT_CFG, {
    fetchImpl: async () => response(404, 'nope'),
  });
  assert.equal(await notFound.getReceivedEmail('abc'), null);

  const calls = [];
  let attempt = 0;
  const retrying = createResendClient(CLIENT_CFG, {
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      attempt += 1;
      return attempt === 1 ? response(500, 'boom') : response(200, { id: 'abc', html: '<p>x</p>' });
    },
  });
  const body = await retrying.getReceivedEmail('abc');
  assert.equal(body.id, 'abc');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].init.method, 'GET');
  assert.match(calls[0].url, /^https:\/\/api\.resend\.test\/emails\/receiving\/abc$/);
  assert.match(calls[0].init.headers['User-Agent'], /temp-mail/);
  assert.equal(calls[0].init.headers.Authorization, 'Bearer re_test_key_placeholder');
});

test('the Resend client surfaces 429, 401 and timeouts as safe errors', async () => {
  const rateLimited = createResendClient(CLIENT_CFG, {
    fetchImpl: async () => response(429, 'slow down', { 'retry-after': '0' }),
  });
  await assert.rejects(rateLimited.getReceivedEmail('abc'), (error) => {
    assert.equal(error.code, 'RESEND_RATE_LIMITED');
    assert.equal(error.status, 503);
    assert.doesNotMatch(error.message, /re_test_key/);
    return true;
  });

  const unauthorized = createResendClient(CLIENT_CFG, {
    fetchImpl: async () => response(401, 'bad key'),
  });
  await assert.rejects(unauthorized.getReceivedEmail('abc'), (error) => {
    assert.equal(error.code, 'RESEND_AUTH');
    return true;
  });

  const timedOut = createResendClient(CLIENT_CFG, {
    fetchImpl: async () => {
      throw new Error('The operation was aborted');
    },
  });
  await assert.rejects(timedOut.getReceivedEmail('abc'), (error) => {
    assert.equal(error.code, 'RESEND_UNAVAILABLE');
    return true;
  });
});

test('ingest survives a failing fetch without crashing', async () => {
  const { app, store, providers, fake } = setupResend();
  const created = await createResendMailbox(app);
  fake.fail = 500;

  await assert.rejects(
    providers.get('resend').handleReceivedEvent(receivedEvent({ to: [created.body.address] })),
  );
  assert.equal(store.get(created.body.address).messages.length, 0);

  // A later retry (same email_id) still succeeds.
  fake.fail = null;
  fake.bodies.set('em-1', receivedBody());
  const retry = await providers.get('resend').handleReceivedEvent(
    receivedEvent({ to: [created.body.address] }),
  );
  assert.equal(retry.stored, 1);
});

test('the Resend client exposes read endpoints only (no send/reply/forward)', () => {
  const client = createResendClient(CLIENT_CFG, { fetchImpl: async () => response(404, 'x') });
  for (const key of Object.keys(client)) {
    assert.doesNotMatch(key, /send|reply|forward|compose|draft/i);
  }
  assert.deepEqual(Object.keys(client), ['getReceivedEmail']);
});

/* ------------------------------------------------------- svix / quota */

test('verifySvixSignature handles good, tampered and stale payloads', () => {
  const payload = '{"hello":"world"}';
  const id = 'msg_abc';
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = signSvixPayload({ payload, id, timestamp, secret: SECRET });
  const headers = { 'svix-id': id, 'svix-timestamp': timestamp, 'svix-signature': signature };

  assert.equal(verifySvixSignature({ payload, headers, secret: SECRET }).ok, true);
  assert.equal(verifySvixSignature({ payload: `${payload} `, headers, secret: SECRET }).ok, false);
  assert.equal(verifySvixSignature({ payload, headers: { ...headers, 'svix-id': 'other' }, secret: SECRET }).ok, false);
  assert.equal(verifySvixSignature({ payload, headers, secret: SECRET, now: Date.now() + 10 * 60 * 1000 }).ok, false);
  assert.equal(verifySvixSignature({ payload, headers: {}, secret: SECRET }).ok, false);

  // Multiple candidate signatures, one valid.
  const multi = { ...headers, 'svix-signature': `v1,AAAA ${signature}` };
  assert.equal(verifySvixSignature({ payload, headers: multi, secret: SECRET }).ok, true);
});

test('QuotaTracker rolls over at UTC midnight and month boundaries', () => {
  let now = Date.UTC(2026, 0, 1, 23, 0, 0);
  const quota = new QuotaTracker({ dailyLimit: 2, monthlyLimit: 5, softLimitRatio: 0.5, now: () => now });

  assert.equal(quota.tryAcquire().allowed, true);
  assert.equal(quota.tryAcquire().allowed, true);
  assert.equal(quota.state().daily.used, 2);
  assert.equal(quota.state().monthly.used, 2);
  assert.equal(quota.tryAcquire().allowed, false, 'daily hard limit reached');
  assert.equal(quota.state().monthly.used, 2, 'a blocked acquire must not be counted');

  now = Date.UTC(2026, 0, 2, 0, 1, 0); // next day, same month
  assert.equal(quota.state().daily.used, 0, 'daily window reset at UTC midnight');
  assert.equal(quota.state().monthly.used, 2, 'the monthly window persists across days');
  assert.equal(quota.tryAcquire().allowed, true, 'the daily reset unblocks processing');

  now = Date.UTC(2026, 1, 1, 0, 1, 0); // next month
  assert.equal(quota.state().monthly.used, 0, 'monthly window reset');
});
