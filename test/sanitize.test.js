import test from 'node:test';
import assert from 'node:assert/strict';
import { htmlToText, sanitizeEmailHtml } from '../src/sanitize.js';

test('sanitizeEmailHtml strips scripts and event handlers', () => {
  const out = sanitizeEmailHtml('<p onclick="steal()">hi</p><script>alert(1)</script>');
  assert.doesNotMatch(out, /script/i);
  assert.doesNotMatch(out, /onclick/i);
  assert.match(out, /hi/);
});

test('sanitizeEmailHtml keeps basic formatting and hardens links', () => {
  const out = sanitizeEmailHtml('<a href="https://x.test">link</a> <b>bold</b>');
  assert.match(out, /<b>bold<\/b>/);
  assert.match(out, /rel="noopener noreferrer nofollow"/);
  assert.match(out, /target="_blank"/);
});

test('sanitizeEmailHtml drops javascript: URLs', () => {
  const out = sanitizeEmailHtml('<a href="javascript:alert(1)">x</a>');
  assert.doesNotMatch(out, /javascript:/i);
});

test('sanitizeEmailHtml removes dangerous CSS', () => {
  const out = sanitizeEmailHtml('<p style="background:url(javascript:alert(1))">x</p>');
  assert.doesNotMatch(out, /javascript:/i);
});

test('sanitizeEmailHtml handles empty input', () => {
  assert.equal(sanitizeEmailHtml(''), '');
  assert.equal(sanitizeEmailHtml(undefined), '');
});

test('htmlToText strips all markup', () => {
  assert.equal(htmlToText('<p>Hello <b>world</b></p>'), 'Hello world');
});
