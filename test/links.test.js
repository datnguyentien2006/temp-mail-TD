import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { extractLinks } from '../src/links.js';
import { makeSetup, SESSION } from './helpers.js';

/* --------------------------------------------------------------- unit ---- */

test('extractLinks returns anchor URLs with their visible label', () => {
  const links = extractLinks(
    '<p>Welcome! <a href="https://verify.test/confirm?t=abc">Confirm your email</a></p>',
    '',
  );
  assert.deepEqual(links, [
    { url: 'https://verify.test/confirm?t=abc', text: 'Confirm your email' },
  ]);
});

test('extractLinks only returns http(s) and drops dangerous schemes', () => {
  const links = extractLinks(
    '<a href="javascript:alert(1)">x</a>' +
      '<a href="data:text/html,hi">x</a>' +
      '<a href="mailto:hi@test.test">mail</a>' +
      '<a href="https://ok.test/path">ok</a>',
    '',
  );
  assert.deepEqual(links, [{ url: 'https://ok.test/path', text: 'ok' }]);
});

test('extractLinks deduplicates and keeps the first label', () => {
  const links = extractLinks(
    '<a href="https://verify.test/x">First</a>',
    'also see https://verify.test/x and https://other.test/y.',
  );
  assert.deepEqual(links, [
    { url: 'https://verify.test/x', text: 'First' },
    { url: 'https://other.test/y', text: '' },
  ]);
});

test('extractLinks finds bare URLs in the text part and trims punctuation', () => {
  const links = extractLinks('', 'Open https://verify.test/a?b=1&c=2. Then continue.');
  assert.deepEqual(links, [{ url: 'https://verify.test/a?b=1&c=2', text: '' }]);
});

test('extractLinks decodes entities in the href', () => {
  const links = extractLinks('<a href="https://verify.test/a?x=1&amp;y=2">go</a>', '');
  assert.equal(links[0].url, 'https://verify.test/a?x=1&y=2');
});

test('extractLinks ignores relative links and keeps balanced parentheses', () => {
  const links = extractLinks(
    '<a href="/local/path">relative</a><a href="https://x.test/a_(b)">paren</a>',
    '',
  );
  assert.deepEqual(links, [{ url: 'https://x.test/a_(b)', text: 'paren' }]);
});

test('extractLinks handles empty input', () => {
  assert.deepEqual(extractLinks('', ''), []);
  assert.deepEqual(extractLinks(undefined, undefined), []);
});

/* ---------------------------------------------------------------- API ---- */

test('message detail exposes machine-readable links', async () => {
  const { app, store } = makeSetup();
  const address = 'links@a.test';
  store.createMailbox({ address, localPart: 'links', domain: 'a.test', sessionId: SESSION });
  store.addMessage(address, {
    from: 'noreply@site.test',
    to: address,
    subject: 'Verify your account',
    text: 'Confirm here: https://verify.test/confirm?token=deadbeef',
    html: '<p>Confirm <a href="https://verify.test/confirm?token=deadbeef">your account</a></p>',
  });

  const list = await request(app)
    .get(`/api/mailboxes/${address}/messages`)
    .set('x-session-id', SESSION);
  assert.equal(list.status, 200);
  const messageId = list.body.messages[0].id;

  const detail = await request(app)
    .get(`/api/mailboxes/${address}/messages/${messageId}`)
    .set('x-session-id', SESSION);
  assert.equal(detail.status, 200);
  assert.deepEqual(detail.body.links, [
    { url: 'https://verify.test/confirm?token=deadbeef', text: 'your account' },
  ]);
});

test('message detail returns an empty links array when there are none', async () => {
  const { app, store } = makeSetup();
  const address = 'plain@a.test';
  store.createMailbox({ address, localPart: 'plain', domain: 'a.test', sessionId: SESSION });
  store.addMessage(address, {
    from: 'noreply@site.test',
    to: address,
    subject: 'No links',
    text: 'just text',
    html: '<p>just text</p>',
  });

  const detail = await request(app)
    .get(`/api/mailboxes/${address}/messages`)
    .set('x-session-id', SESSION);
  const messageId = detail.body.messages[0].id;
  const one = await request(app)
    .get(`/api/mailboxes/${address}/messages/${messageId}`)
    .set('x-session-id', SESSION);
  assert.deepEqual(one.body.links, []);
});

test('messages long-poll resolves as soon as new mail arrives', async () => {
  const { app, store } = makeSetup();
  const address = 'wait@a.test';
  store.createMailbox({ address, localPart: 'wait', domain: 'a.test', sessionId: SESSION });

  const pending = request(app)
    .get(`/api/mailboxes/${address}/messages`)
    .query({ wait: 5 })
    .set('x-session-id', SESSION)
    .then((res) => res);

  setTimeout(() => {
    store.addMessage(address, {
      from: 'noreply@site.test',
      to: address,
      subject: 'Arrived',
      text: 'hi',
      html: '<p>hi</p>',
    });
  }, 50);

  const res = await pending;
  assert.equal(res.status, 200);
  assert.equal(res.body.waited, true);
  assert.equal(res.body.timedOut, false);
  assert.equal(res.body.messages.length, 1);
});

test('messages long-poll times out without new mail', async () => {
  const { app, store } = makeSetup();
  const address = 'idle@a.test';
  store.createMailbox({ address, localPart: 'idle', domain: 'a.test', sessionId: SESSION });

  const res = await request(app)
    .get(`/api/mailboxes/${address}/messages`)
    .query({ wait: 0.3 })
    .set('x-session-id', SESSION);
  assert.equal(res.status, 200);
  assert.equal(res.body.waited, true);
  assert.equal(res.body.timedOut, true);
  assert.deepEqual(res.body.messages, []);
});
