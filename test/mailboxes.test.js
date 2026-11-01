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
