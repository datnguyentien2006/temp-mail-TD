import test from 'node:test';
import assert from 'node:assert/strict';
import nodemailer from 'nodemailer';
import { loadConfig } from '../src/config.js';
import { MailboxStore } from '../src/store.js';
import { createSmtpServer } from '../src/smtp.js';

const SESSION = 'session-recv-0001';

async function startSmtp(config, store) {
  const server = createSmtpServer({ store, config });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.server.address().port;
  return { server, port };
}

function waitFor(predicate, timeoutMs = 4000) {
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
    }, 25);
  });
}

function transportFor(port) {
  return nodemailer.createTransport({ host: '127.0.0.1', port, secure: false, ignoreTLS: true });
}

test('SMTP stores inbound mail for an existing mailbox', async (t) => {
  const config = loadConfig({ DOMAINS: 'inbox.test' });
  const store = new MailboxStore({ ttlMs: config.ttlMs, maxMailboxesPerSession: 5 });
  const address = 'abc123@inbox.test';
  store.createMailbox({ address, localPart: 'abc123', domain: 'inbox.test', sessionId: SESSION });

  const { server, port } = await startSmtp(config, store);
  t.after(() => new Promise((resolve) => server.close(resolve)));

  await transportFor(port).sendMail({
    from: 'Alice <alice@sender.test>',
    to: address,
    subject: 'Hello there',
    text: 'plain body',
    html: '<p>hi <b>there</b></p>',
  });

  const message = await waitFor(() => store.get(address)?.messages[0]);
  assert.equal(message.subject, 'Hello there');
  assert.match(message.from, /alice@sender\.test/);
  assert.equal(message.to, address);
  assert.equal(message.text.trim(), 'plain body');
  assert.match(message.html, /<b>there<\/b>/);
  assert.ok(message.size > 0);
});

test('SMTP sanitises hostile HTML and captures attachments', async (t) => {
  const config = loadConfig({ DOMAINS: 'inbox.test' });
  const store = new MailboxStore({ ttlMs: config.ttlMs, maxMailboxesPerSession: 5 });
  const address = 'evil@inbox.test';
  store.createMailbox({ address, localPart: 'evil', domain: 'inbox.test', sessionId: SESSION });

  const { server, port } = await startSmtp(config, store);
  t.after(() => new Promise((resolve) => server.close(resolve)));

  await transportFor(port).sendMail({
    from: 'attacker@sender.test',
    to: address,
    subject: 'xss attempt',
    html: '<p>ok</p><script>alert(1)</script><img src=x onerror="alert(2)">',
    attachments: [{ filename: 'note.txt', content: Buffer.from('file-content') }],
  });

  const message = await waitFor(() => store.get(address)?.messages[0]);
  assert.doesNotMatch(message.html, /<script/i);
  assert.doesNotMatch(message.html, /onerror/i);
  assert.equal(message.attachments.length, 1);
  assert.equal(message.attachments[0].filename, 'note.txt');
  assert.equal(
    Buffer.from(message.attachments[0].content, 'base64').toString(),
    'file-content',
  );
});

test('SMTP rejects mail for an unknown mailbox (550)', async (t) => {
  const config = loadConfig({ DOMAINS: 'inbox.test' });
  const store = new MailboxStore({ ttlMs: config.ttlMs });

  const { server, port } = await startSmtp(config, store);
  t.after(() => new Promise((resolve) => server.close(resolve)));

  await assert.rejects(
    transportFor(port).sendMail({
      from: 'x@sender.test',
      to: 'ghost@inbox.test',
      subject: 'nope',
      text: 'nope',
    }),
  );
});

test('SMTP rejects mail for a domain outside the allow-list (550)', async (t) => {
  const config = loadConfig({ DOMAINS: 'inbox.test' });
  const store = new MailboxStore({ ttlMs: config.ttlMs });

  const { server, port } = await startSmtp(config, store);
  t.after(() => new Promise((resolve) => server.close(resolve)));

  await assert.rejects(
    transportFor(port).sendMail({
      from: 'x@sender.test',
      to: 'someone@other.test',
      subject: 'nope',
      text: 'nope',
    }),
  );
});
