import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { makeSetup, SESSION } from './helpers.js';

const OTHER_SESSION = 'session-test-0002';

function apiError(code, status, message) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  error.expose = true;
  return error;
}

/**
 * In-memory stand-in for the Guerrilla HTTP client. Every method mirrors the
 * real client; nothing here touches the network.
 */
function createFakeGuerrilla() {
  let counter = 0;
  const fake = {
    calls: [],
    listCalls: 0,
    addresses: new Map(), // sid -> address
    lists: new Map(), // sid -> newest-first items
    fetched: new Map(), // email id -> fetch_email payload
    deleted: [],
    forgotten: [],
    failAuth: false,
    failTransport: false,

    _guard() {
      if (fake.failTransport) {
        throw apiError('GUERRILLA_UNAVAILABLE', 502, 'Could not reach Guerrilla Mail.');
      }
    },

    async getEmailAddress() {
      fake.calls.push('get_email_address');
      fake._guard();
      counter += 1;
      const sid = `sid-${counter}`;
      const address = `random${counter}@guerrillamailblock.com`;
      fake.addresses.set(sid, address);
      fake.lists.set(sid, []);
      return {
        email_addr: address,
        email_timestamp: Math.floor(Date.now() / 1000),
        sid_token: sid,
      };
    },

    async setEmailUser({ sidToken, emailUser }) {
      fake.calls.push('set_email_user');
      fake._guard();
      const address = `${emailUser}@guerrillamailblock.com`;
      fake.addresses.set(sidToken, address);
      if (!fake.lists.has(sidToken)) fake.lists.set(sidToken, []);
      return {
        email_addr: address,
        email_timestamp: Math.floor(Date.now() / 1000),
        sid_token: sidToken,
        auth: { success: true, error_codes: [] },
      };
    },

    async getEmailList({ sidToken }) {
      fake.calls.push('get_email_list');
      return fake._list(sidToken);
    },

    async checkEmail({ sidToken }) {
      fake.calls.push('check_email');
      return fake._list(sidToken);
    },

    _list(sidToken) {
      fake.listCalls += 1;
      fake._guard();
      if (fake.failAuth) {
        throw apiError('GUERRILLA_AUTH', 502, 'Guerrilla Mail rejected the session.');
      }
      return {
        list: [...(fake.lists.get(sidToken) ?? [])],
        count: (fake.lists.get(sidToken) ?? []).length,
        email: fake.addresses.get(sidToken),
        ts: Math.floor(Date.now() / 1000),
        sid_token: sidToken,
        auth: { success: true, error_codes: [] },
      };
    },

    async fetchEmail({ emailId }) {
      fake.calls.push('fetch_email');
      fake._guard();
      const value = fake.fetched.get(String(emailId));
      return value === undefined ? false : value;
    },

    async delEmail({ sidToken, emailIds }) {
      fake.calls.push('del_email');
      fake._guard();
      fake.deleted.push(...emailIds.map(String));
      const list = fake.lists.get(sidToken) ?? [];
      fake.lists.set(
        sidToken,
        list.filter((item) => !emailIds.map(String).includes(String(item.mail_id))),
      );
      return { deleted_ids: emailIds };
    },

    async forgetMe({ sidToken }) {
      fake.calls.push('forget_me');
      fake.forgotten.push(sidToken);
      return true;
    },

    // --- test helpers ---------------------------------------------------
    add(sid, item) {
      fake.lists.get(sid).unshift(item);
    },
    sidFor(address, store) {
      return store.get(address)?.providerData?.sidToken;
    },
  };
  return fake;
}

async function createGuerrilla(app, session = SESSION, body = {}) {
  return request(app)
    .post('/api/mailboxes')
    .set('x-session-id', session)
    .send({ provider: 'guerrilla', ...body });
}

function remoteMessage(id, overrides = {}) {
  return {
    mail_id: String(id),
    mail_from: 'sender@sender.test',
    mail_subject: `Subject ${id}`,
    mail_excerpt: `Excerpt ${id}`,
    mail_timestamp: '1700000000',
    mail_read: '0',
    att: '0',
    ...overrides,
  };
}

test('providers implement the same interface', () => {
  const fake = createFakeGuerrilla();
  const { providers } = makeSetup({}, { guerrillaClient: fake });
  const methods = [
    'listDomains',
    'createMailbox',
    'listMailboxes',
    'getMailbox',
    'listMessages',
    'getMessage',
    'deleteMessage',
    'deleteMailbox',
    'extendMailbox',
    'getAttachment',
  ];

  for (const id of ['selfhosted', 'guerrilla']) {
    const provider = providers.get(id);
    assert.ok(provider, `${id} should be registered`);
    for (const method of methods) {
      assert.equal(typeof provider[method], 'function', `${id}.${method} missing`);
    }
    assert.equal(typeof provider.capabilities, 'object');
  }
});

test('GET /api/domains groups domains by provider and keeps the flat list', async () => {
  const fake = createFakeGuerrilla();
  const { app } = makeSetup({}, { guerrillaClient: fake });
  const res = await request(app).get('/api/domains');

  assert.equal(res.status, 200);
  assert.deepEqual(res.body.domains, ['a.test', 'b.test']);

  const self = res.body.providers.find((provider) => provider.id === 'selfhosted');
  assert.deepEqual(self.domains, ['a.test', 'b.test']);
  assert.equal(self.capabilities.supportsDomainChoice, true);
  assert.equal(self.capabilities.supportsExtend, true);

  const guerrilla = res.body.providers.find((provider) => provider.id === 'guerrilla');
  assert.deepEqual(guerrilla.domains, []);
  assert.equal(guerrilla.capabilities.supportsDomainChoice, false);
  assert.equal(guerrilla.capabilities.supportsExtend, false);
  assert.equal(guerrilla.capabilities.supportsAttachments, false);
  assert.equal(guerrilla.capabilities.retentionMinutes, 60);
});

test('GET /api/domains hides Guerrilla Mail when the kill switch is off', async () => {
  const fake = createFakeGuerrilla();
  const { app } = makeSetup({ ENABLE_GUERRILLA: 'false' }, { guerrillaClient: fake });
  const res = await request(app).get('/api/domains');
  assert.deepEqual(
    res.body.providers.map((provider) => provider.id),
    ['selfhosted'],
  );

  const blocked = await createGuerrilla(app);
  assert.equal(blocked.status, 400);
  assert.equal(fake.calls.length, 0);
});

test('POST /api/mailboxes creates a Guerrilla inbox without leaking its sid', async () => {
  const fake = createFakeGuerrilla();
  const { app } = makeSetup({}, { guerrillaClient: fake });
  const res = await createGuerrilla(app);

  assert.equal(res.status, 201);
  assert.equal(res.body.provider, 'guerrilla');
  assert.match(res.body.address, /^random\d+@guerrillamailblock\.com$/);
  assert.equal(res.body.domain, 'guerrillamailblock.com');
  assert.ok(res.body.expiresAt > Date.now());

  const serialised = JSON.stringify(res.body);
  assert.ok(!serialised.includes('sid-'), 'sid_token must never reach the client');
  assert.ok(!('providerData' in res.body));
});

test('POST /api/mailboxes honours a custom local part for Guerrilla', async () => {
  const fake = createFakeGuerrilla();
  const { app } = makeSetup({}, { guerrillaClient: fake });
  const res = await createGuerrilla(app, SESSION, { localPart: 'My.Name' });

  assert.equal(res.status, 201);
  assert.equal(res.body.address, 'my.name@guerrillamailblock.com');
  assert.ok(fake.calls.includes('set_email_user'));
});

test('POST /api/mailboxes rejects a domain for Guerrilla (not selectable)', async () => {
  const fake = createFakeGuerrilla();
  const { app } = makeSetup({}, { guerrillaClient: fake });
  const res = await createGuerrilla(app, SESSION, { domain: 'grr.la' });
  assert.equal(res.status, 400);
  assert.equal(fake.calls.length, 0);
});

test('Guerrilla mailboxes are isolated per user session and sid', async () => {
  const fake = createFakeGuerrilla();
  const { app, store } = makeSetup({ MAX_MAILBOXES_PER_SESSION: '10' }, { guerrillaClient: fake });

  const a = await createGuerrilla(app, SESSION);
  const b = await createGuerrilla(app, OTHER_SESSION);
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);

  const sidA = fake.sidFor(a.body.address, store);
  const sidB = fake.sidFor(b.body.address, store);
  assert.ok(sidA && sidB);
  assert.notEqual(sidA, sidB, 'each mailbox gets its own remote session');

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

test('listMessages de-duplicates the same remote ids across syncs', async () => {
  const fake = createFakeGuerrilla();
  const { app, store, providers } = makeSetup({}, { guerrillaClient: fake });
  const created = await createGuerrilla(app);
  const address = created.body.address;
  const sid = fake.sidFor(address, store);

  fake.add(sid, remoteMessage(1, { mail_subject: 'Welcome' }));
  fake.add(sid, remoteMessage(2, { mail_subject: 'Hello' }));

  const guerrilla = providers.get('guerrilla');
  await guerrilla.syncNow(address);
  assert.equal(store.get(address).messages.length, 2);

  // Same remote list again: no duplicates.
  await guerrilla.syncNow(address);
  assert.equal(store.get(address).messages.length, 2);
  const ids = store.get(address).messages.map((message) => message.id);
  assert.equal(new Set(ids).size, ids.length);

  fake.add(sid, remoteMessage(3, { mail_subject: 'Third' }));
  await guerrilla.syncNow(address);
  assert.equal(store.get(address).messages.length, 3);
  assert.ok(store.get(address).messages.some((message) => message.subject === 'Third'));

  const viaApi = await request(app)
    .get(`/api/mailboxes/${encodeURIComponent(address)}/messages`)
    .set('x-session-id', SESSION);
  assert.equal(viaApi.status, 200);
  assert.equal(viaApi.body.messages.length, 3);
});

test('fetching a Guerrilla message sanitises HTML and decodes entities', async () => {
  const fake = createFakeGuerrilla();
  const { app, store, providers } = makeSetup({}, { guerrillaClient: fake });
  const created = await createGuerrilla(app);
  const address = created.body.address;
  const sid = fake.sidFor(address, store);

  fake.add(sid, remoteMessage(42, { mail_subject: 'Hi &amp; bye' }));
  await providers.get('guerrilla').syncNow(address);

  fake.fetched.set('42', {
    mail_id: 42,
    mail_from: 'Alice <alice@sender.test>',
    mail_subject: 'Hi &amp; bye',
    mail_body: '<p>hello</p><script>alert(1)</script><a href="javascript:alert(2)">x</a>',
    content_type: 'text/html',
    mail_timestamp: 1700000000,
  });

  const res = await request(app)
    .get(`/api/mailboxes/${encodeURIComponent(address)}/messages/g-42`)
    .set('x-session-id', SESSION);

  assert.equal(res.status, 200);
  assert.equal(res.body.subject, 'Hi & bye');
  assert.match(res.body.html, /<p>hello<\/p>/);
  assert.ok(!res.body.html.includes('<script'));
  assert.ok(!res.body.html.includes('javascript:'));
  assert.match(res.body.text, /hello/);
});

test('a Guerrilla message that fetch_email reports missing returns 404', async () => {
  const fake = createFakeGuerrilla();
  const { app, store, providers } = makeSetup({}, { guerrillaClient: fake });
  const created = await createGuerrilla(app);
  const address = created.body.address;
  const sid = fake.sidFor(address, store);

  fake.add(sid, remoteMessage(7));
  await providers.get('guerrilla').syncNow(address);
  // No fake.fetched entry => the fake returns false, like the real API.

  const res = await request(app)
    .get(`/api/mailboxes/${encodeURIComponent(address)}/messages/g-7`)
    .set('x-session-id', SESSION);
  assert.equal(res.status, 404);
});

test('an expired Guerrilla session is re-registered transparently', async () => {
  const fake = createFakeGuerrilla();
  const { app, store } = makeSetup({}, { guerrillaClient: fake });
  const created = await createGuerrilla(app);
  const address = created.body.address;
  const oldSid = fake.sidFor(address, store);

  fake.failAuth = true;
  const failed = await request(app)
    .get(`/api/mailboxes/${encodeURIComponent(address)}/messages`)
    .set('x-session-id', SESSION);
  assert.equal(failed.status, 502);

  // The provider attempted a re-registration before giving up.
  assert.ok(fake.calls.includes('get_email_address'));

  fake.failAuth = false;
  const recovered = await request(app)
    .get(`/api/mailboxes/${encodeURIComponent(address)}/messages`)
    .set('x-session-id', SESSION);
  assert.equal(recovered.status, 200);
  const newSid = fake.sidFor(address, store);
  assert.notEqual(newSid, oldSid, 'a fresh remote session replaces the expired one');
});

test('Guerrilla failures are graceful and cached messages still render', async () => {
  const fake = createFakeGuerrilla();
  const { app, store, providers } = makeSetup({}, { guerrillaClient: fake });
  const created = await createGuerrilla(app);
  const address = created.body.address;
  const sid = fake.sidFor(address, store);

  fake.add(sid, remoteMessage(9, { mail_subject: 'Cached' }));
  await providers.get('guerrilla').syncNow(address);

  // Force the next sync to hit the network, then take the API down.
  store.get(address).providerData.lastSyncAt = 0;
  fake.failTransport = true;

  const res = await request(app)
    .get(`/api/mailboxes/${encodeURIComponent(address)}/messages`)
    .set('x-session-id', SESSION);
  assert.equal(res.status, 200);
  assert.equal(res.body.messages[0].subject, 'Cached');

  // A cold inbox surfaces the error instead of pretending it is empty.
  fake.failTransport = false;
  const cold = await createGuerrilla(app, OTHER_SESSION);
  const coldAddress = cold.body.address;
  store.get(coldAddress).providerData.lastSyncAt = 0;
  fake.failTransport = true;
  const failed = await request(app)
    .get(`/api/mailboxes/${encodeURIComponent(coldAddress)}/messages`)
    .set('x-session-id', OTHER_SESSION);
  assert.equal(failed.status, 502);
});

test('the background poller only syncs inboxes marked active', async () => {
  const fake = createFakeGuerrilla();
  const { store, providers } = makeSetup({}, { guerrillaClient: fake });
  const provider = providers.get('guerrilla');

  const mailbox = store.createMailbox({
    address: 'idle@guerrillamailblock.com',
    localPart: 'idle',
    domain: 'guerrillamailblock.com',
    sessionId: SESSION,
    provider: 'guerrilla',
    providerData: {
      sidToken: 'sid-idle',
      seen: new Set(),
      fetched: new Set(),
      lastSyncAt: 0,
      activeUntil: 0,
    },
    ttlMs: 60 * 60 * 1000,
  });
  fake.addresses.set('sid-idle', mailbox.address);
  fake.lists.set('sid-idle', []);
  fake.add('sid-idle', remoteMessage(100));

  await provider.pollOnce();
  assert.equal(fake.listCalls, 0, 'inactive inboxes must not be polled');

  provider.markSessionActive(SESSION);
  await provider.pollOnce();
  assert.equal(fake.listCalls, 1);
  assert.equal(store.get(mailbox.address).messages.length, 1);
});

test('extend / attachments / delete follow Guerrilla capabilities', async () => {
  const fake = createFakeGuerrilla();
  const { app, store, providers } = makeSetup({}, { guerrillaClient: fake });
  const created = await createGuerrilla(app);
  const address = created.body.address;
  const sid = fake.sidFor(address, store);

  const extended = await request(app)
    .post(`/api/mailboxes/${encodeURIComponent(address)}/extend`)
    .set('x-session-id', SESSION);
  assert.equal(extended.status, 400);

  fake.add(sid, remoteMessage(55));
  await providers.get('guerrilla').syncNow(address);

  const attachment = await request(app)
    .get(`/api/mailboxes/${encodeURIComponent(address)}/messages/g-55/attachments/0`)
    .set('x-session-id', SESSION);
  assert.equal(attachment.status, 400);

  const removed = await request(app)
    .delete(`/api/mailboxes/${encodeURIComponent(address)}/messages/g-55`)
    .set('x-session-id', SESSION);
  assert.equal(removed.status, 204);
  assert.deepEqual(fake.deleted, ['55']);
  assert.equal(store.get(address).messages.length, 0);

  const deleted = await request(app)
    .delete(`/api/mailboxes/${encodeURIComponent(address)}`)
    .set('x-session-id', SESSION);
  assert.equal(deleted.status, 204);
  assert.ok(fake.forgotten.includes(sid));
  assert.equal(store.has(address), false);
});

test('Guerrilla send failures surface as 502, not a crash', async () => {
  const fake = createFakeGuerrilla();
  const { app } = makeSetup({}, { guerrillaClient: fake });
  fake.failTransport = true;
  const res = await createGuerrilla(app);
  assert.equal(res.status, 502);
  assert.match(res.body.error, /Guerrilla Mail/i);
});