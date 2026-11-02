/**
 * Third-party webhook endpoints.
 *
 * Mounted BEFORE the JSON body parser so the signature can be verified over the
 * RAW request body (re-serialising the JSON would break the HMAC).
 *
 * Resend's `email.received` webhook is the only event handled here. Other event
 * types are acknowledged and ignored. Invalid or missing signatures are
 * rejected with 401 and never processed.
 */
import { Router, raw } from 'express';

export function createWebhookRouter({ config, providers, logger = console } = {}) {
  const router = Router();
  const limit = config.resend?.webhookMaxBytes || 1024 * 1024;

  router.post('/api/webhooks/resend', raw({ type: () => true, limit }), (req, res) => {
    const provider = providers.get?.('resend');
    if (!provider || typeof provider.handleReceivedEvent !== 'function') {
      return res.status(404).json({ error: 'Not found.' });
    }

    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');

    // Verify FIRST, over the exact bytes received. Never echo why it failed.
    const verdict = provider.verifyWebhook(rawBody, req.headers);
    if (!verdict?.ok) {
      return res.status(401).json({ error: 'Invalid webhook signature.' });
    }

    let event;
    try {
      event = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return res.status(400).json({ error: 'Invalid JSON body.' });
    }

    if (!event || event.type !== 'email.received') {
      return res.status(200).json({ ok: true, ignored: true });
    }

    // Acknowledge quickly, then fetch the body out of band so Resend does not
    // time out and retry. Failures are logged without the message body.
    res.status(202).json({ ok: true });

    Promise.resolve()
      .then(() => provider.handleReceivedEvent(event))
      .catch((error) => {
        logger?.warn?.(`[resend] webhook processing failed (${error?.code || 'ERROR'})`);
      });
  });

  return router;
}
