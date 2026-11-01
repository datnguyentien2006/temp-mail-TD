import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { makeSetup, SESSION } from './helpers.js';
import { randomLocalPart, validateLocalPart } from '../src/mailboxes.js';

test('validateLocalPart accepts a normal name', () => {
  assert.equal(validateLocalPart('john.doe').ok, true);
  assert.equal(validateLocalPart('a1-b_c').ok, true);
});

test('validateLocalPart rejects bad characters and shapes', () => {
  assert.equal(validateLocalPart('has space').ok, false);
  assert.equal(validateLocalPart('.leading').ok, false);
  assert.equal(validateLocalPart('trailing.').ok, false);
  assert.equal(validateLocalPart('dou..ble').ok, false);
  assert.equal(validateLocalPart('a'.repeat(65)).ok, false);
  assert.equal(validateLocalPart('').ok, false);
});

test('validateLocalPart rejects reserved names', () => {
  for (const name of ['admin', 'postmaster', 'abuse', 'noreply']) {
    assert.equal(validateLocalPart(name).ok, false, `${name} should be reserved`);
  }
});

test('randomLocalPart is alphanumeric and sized', () => {
  const value = randomLocalPart(10);
  assert.match(value, /^[a-z0-9]{10}$/);
  assert.notEqual(randomLocalPart(10), randomLocalPart(10));
});

test('POST /api/mailboxes creates a random mailbox', async () => {
  const { app } = makeSetup();
  const res = await request(app)
    .post('/api/mailboxes')
    .set('x-session-id', SESSION)
    .send({ domain: 'a.test' });
  assert.equal(res.status, 201);
  assert.match(res.body.address, /^[a-z0-9]+@a\.test$/);
  assert.equal(res.body.domain, 'a.test');
  assert.ok(res.body.expiresAt > Date.now());
});

test('POST /api/mailboxes honours a custom local part', async () => {
  const { app } = makeSetup();
  const res = await request(app)
    .post('/api/mailboxes')
    .set('x-session-id', SESSION)
    .send({ domain: 'b.test', localPart: 'My.Name' });
  assert.equal(res.status, 201);
  assert.equal(res.body.address, 'my.name@b.test');
});

test('POST /api/mailboxes rejects invalid local parts', async () => {
  const { app } = makeSetup();
  const res = await request(app)
    .post('/api/mailboxes')
    .set('x-session-id', SESSION)
    .send({ domain: 'a.test', localPart: 'bad name!' });
  assert.equal(res.status, 400);
});

test('POST /api/mailboxes rejects reserved local parts', async () => {
  const { app } = makeSetup();
  const res = await request(app)
    .post('/api/mailboxes')
    .set('x-session-id', SESSION)
    .send({ domain: 'a.test', localPart: 'postmaster' });
  assert.equal(res.status, 400);
});

test('POST /api/mailboxes rejects a non-allowed domain', async () => {
  const { app } = makeSetup();
  const res = await request(app)
    .post('/api/mailboxes')
    .set('x-session-id', SESSION)
    .send({ domain: 'not-allowed.test', localPart: 'someone' });
  assert.equal(res.status, 400);
});

test('POST /api/mailboxes returns 409 for a taken custom address', async () => {
  const { app } = makeSetup();
  const body = { domain: 'a.test', localPart: 'taken' };
  const first = await request(app).post('/api/mailboxes').set('x-session-id', SESSION).send(body);
  assert.equal(first.status, 201);
  const second = await request(app).post('/api/mailboxes').set('x-session-id', SESSION).send(body);
  assert.equal(second.status, 409);
});

test('POST /api/mailboxes requires a session id', async () => {
  const { app } = makeSetup();
  const res = await request(app).post('/api/mailboxes').send({ domain: 'a.test' });
  assert.equal(res.status, 400);
});

test('GET /api/mailboxes lists only the session mailboxes', async () => {
  const { app } = makeSetup();
  await request(app).post('/api/mailboxes').set('x-session-id', SESSION).send({ domain: 'a.test' });
  const list = await request(app).get('/api/mailboxes').set('x-session-id', SESSION);
  assert.equal(list.status, 200);
  assert.equal(list.body.mailboxes.length, 1);

  const other = await request(app).get('/api/mailboxes').set('x-session-id', 'other-session-1234');
  assert.equal(other.body.mailboxes.length, 0);
});

test('DELETE /api/mailboxes removes the mailbox', async () => {
  const { app } = makeSetup();
  const created = await request(app)
    .post('/api/mailboxes')
    .set('x-session-id', SESSION)
    .send({ domain: 'a.test', localPart: 'deleteme' });
  const del = await request(app)
    .delete(`/api/mailboxes/${encodeURIComponent(created.body.address)}`)
    .set('x-session-id', SESSION);
  assert.equal(del.status, 204);
  const list = await request(app).get('/api/mailboxes').set('x-session-id', SESSION);
  assert.equal(list.body.mailboxes.length, 0);
});

test('DELETE /api/mailboxes refuses another session mailbox', async () => {
  const { app } = makeSetup();
  const created = await request(app)
    .post('/api/mailboxes')
    .set('x-session-id', SESSION)
    .send({ domain: 'a.test', localPart: 'mine' });
  const del = await request(app)
    .delete(`/api/mailboxes/${encodeURIComponent(created.body.address)}`)
    .set('x-session-id', 'intruder-session-1');
  assert.equal(del.status, 404);
});

test('enforces MAX_MAILBOXES_PER_SESSION', async () => {
  const { app } = makeSetup({ MAX_MAILBOXES_PER_SESSION: '2' });
  const one = await request(app).post('/api/mailboxes').set('x-session-id', SESSION).send({ domain: 'a.test', localPart: 'one' });
  const two = await request(app).post('/api/mailboxes').set('x-session-id', SESSION).send({ domain: 'a.test', localPart: 'two' });
  const three = await request(app).post('/api/mailboxes').set('x-session-id', SESSION).send({ domain: 'a.test', localPart: 'three' });
  assert.equal(one.status, 201);
  assert.equal(two.status, 201);
  assert.equal(three.status, 429);
});

test('store.sweep evicts expired mailboxes', async () => {
  const { store } = makeSetup({ MAILBOX_TTL_MINUTES: '1' });
  const mailbox = store.createMailbox({
    address: 'temp@a.test',
    localPart: 'temp',
    domain: 'a.test',
    sessionId: SESSION,
  });
  assert.equal(store.sweep(mailbox.expiresAt + 1).length, 1);
  assert.equal(store.has('temp@a.test'), false);
});

test('GET /api/domains returns the configured domain list', async () => {
  const { app } = makeSetup();
  const res = await request(app).get('/api/domains');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.domains, ['a.test', 'b.test']);
});

test('GET /api/config exposes the polling interval and limits', async () => {
  const { app } = makeSetup();
  const res = await request(app).get('/api/config');
  assert.equal(res.status, 200);
  assert.equal(res.body.pollIntervalMs, 8000);
  assert.equal(res.body.maxMailboxesPerSession, 3);
  assert.equal(res.body.maxMailboxLifetimeMinutes, 40);
});

test('POST /api/mailboxes with no domain picks a random allowed domain', async () => {
  const { app } = makeSetup({ MAX_MAILBOXES_PER_SESSION: '100' });
  const seen = new Set();
  for (let i = 0; i < 20; i += 1) {
    const res = await request(app)
      .post('/api/mailboxes')
      .set('x-session-id', SESSION)
      .send({});
    assert.equal(res.status, 201);
    const domain = res.body.address.split('@')[1];
    assert.ok(['a.test', 'b.test'].includes(domain), `unexpected domain ${domain}`);
    seen.add(domain);
  }
  // With 20 draws the chance of missing a domain is negligible (~2^-19).
  assert.deepEqual([...seen].sort(), ['a.test', 'b.test']);
});

test('POST /api/mailboxes/:address/extend pushes the expiry forward', async () => {
  const { app } = makeSetup();
  const created = await request(app)
    .post('/api/mailboxes')
    .set('x-session-id', SESSION)
    .send({ domain: 'a.test', localPart: 'extendme' });
  assert.equal(created.status, 201);

  const res = await request(app)
    .post(`/api/mailboxes/${encodeURIComponent(created.body.address)}/extend`)
    .set('x-session-id', SESSION);
  assert.equal(res.status, 200);
  assert.ok(res.body.mailbox.expiresAt > created.body.expiresAt);
  assert.equal(res.body.mailbox.extendCount, 1);
});

test('extend never exceeds MAX_MAILBOX_LIFETIME_MINUTES', async () => {
  const { store } = makeSetup({ MAILBOX_TTL_MINUTES: '10', MAX_MAILBOX_LIFETIME_MINUTES: '30' });
  const mailbox = store.createMailbox({
    address: 'capped@a.test',
    localPart: 'capped',
    domain: 'a.test',
    sessionId: SESSION,
  });

  // Pretend the mailbox is 25 minutes old and nearly expired: now + TTL would
  // overshoot the 30-minute hard cap, so the cap must win.
  mailbox.createdAt = Date.now() - 25 * 60 * 1000;
  mailbox.expiresAt = mailbox.createdAt + 10 * 60 * 1000; // 15 min ago
  const capped = store.extendMailbox('capped@a.test', {
    ttlMs: 10 * 60 * 1000,
    maxLifetimeMs: 30 * 60 * 1000,
  });
  assert.equal(capped.expiresAt, mailbox.createdAt + 30 * 60 * 1000);
  const cap = capped.expiresAt;

  // At the cap, further extends are no-ops.
  const again = store.extendMailbox('capped@a.test', {
    ttlMs: 10 * 60 * 1000,
    maxLifetimeMs: 30 * 60 * 1000,
  });
  assert.equal(again.expiresAt, cap);
});

test('extend refuses another session mailbox', async () => {
  const { app } = makeSetup();
  const created = await request(app)
    .post('/api/mailboxes')
    .set('x-session-id', SESSION)
    .send({ domain: 'a.test', localPart: 'notmine' });
  const res = await request(app)
    .post(`/api/mailboxes/${encodeURIComponent(created.body.address)}/extend`)
    .set('x-session-id', 'intruder-session-1');
  assert.equal(res.status, 404);
});

test('GET /api/mailboxes/:address/qr returns an SVG data URL', async () => {
  const { app } = makeSetup();
  const created = await request(app)
    .post('/api/mailboxes')
    .set('x-session-id', SESSION)
    .send({ domain: 'a.test', localPart: 'qrcode' });

  const res = await request(app)
    .get(`/api/mailboxes/${encodeURIComponent(created.body.address)}/qr`)
    .set('x-session-id', SESSION);
  assert.equal(res.status, 200);
  assert.equal(res.body.address, created.body.address);
  assert.match(res.body.dataUrl, /^data:image\/svg\+xml;base64,/);

  const denied = await request(app)
    .get(`/api/mailboxes/${encodeURIComponent(created.body.address)}/qr`)
    .set('x-session-id', 'intruder-session-1');
  assert.equal(denied.status, 404);
});
