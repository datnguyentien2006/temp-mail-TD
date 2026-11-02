// MANUAL smoke test for the Resend RECEIVE-ONLY provider.
//
// This script is NOT part of `npm test` and is never run automatically.
// It performs READ-ONLY calls against the real Resend receiving API.
//
// Usage (the key is read ONLY from the environment, never from a file):
//   $env:RESEND_API_KEY = "re_..."          # PowerShell
//   node scripts/resend-smoke.mjs <received_email_id>
//
// It prints structural facts only (lengths, counts, auth results). It never
// prints the API key, the Authorization header, or the message body.
import { createResendClient } from '../src/providers/resend-client.js';

const emailId = process.argv[2];
if (!emailId) {
  console.error('Usage: node scripts/resend-smoke.mjs <received_email_id>');
  process.exit(2);
}

const apiKey = process.env.RESEND_API_KEY;
if (!apiKey) {
  console.error('RESEND_API_KEY is not set in the environment.');
  process.exit(2);
}

const client = createResendClient({
  apiBase: process.env.RESEND_API_BASE || 'https://api.resend.com',
  apiKey,
  userAgent: 'temp-mail-td/smoke (manual, receive-only)',
  requestTimeoutMs: 15000,
  maxRetries: 1,
  retryBaseMs: 500,
});

try {
  const email = await client.getReceivedEmail(emailId, { htmlFormat: 'data_uri' });
  if (!email) {
    console.log('Resend reports this email as gone (404).');
    process.exit(0);
  }
  console.log(JSON.stringify({
    id: email.id,
    subjectLength: (email.subject || '').length,
    htmlLength: (email.html || '').length,
    textLength: (email.text || '').length,
    attachmentCount: (email.attachments || []).length,
    authentication: email.authentication ?? null,
    // A deliberately narrow field whitelist: never dump the whole body.
  }, null, 2));
  console.log('SMOKE OK');
} catch (error) {
  console.error(`SMOKE FAILED: ${error.code || 'ERROR'}`);
  process.exit(1);
}
