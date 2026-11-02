# Temp Mail

A small, self-hosted **disposable email** web app with three interchangeable mailbox providers:
its own inbound SMTP server on domains you own, **Guerrilla Mail**'s public API, and **Resend
inbound** (receive-only). Generate throwaway addresses on demand and receive anything sent to them —
straight into the browser.

![status](https://img.shields.io/badge/tests-node%3Atest-brightgreen)

## Features

- **Three mailbox providers** — a self-hosted SMTP provider on domains you own, an optional
  Guerrilla Mail provider, and an optional Resend provider (receive-only). The picker is grouped by
  provider and driven by `GET /api/domains`; nothing is hardcoded in the HTML.
- **Server-driven domain dropdown** — the self-hosted provider lists only the domains in `DOMAINS`
  (plus a **Random** option) and rejects anything else. Providers that cannot choose a domain show
  a single **Random** entry instead of a fake list; providers that are configured but temporarily
  unusable (quota reached, missing credentials) are shown disabled rather than offering a dead option.
- **One-click mailbox creation** — random local part on the chosen domain, or a custom local part
  (format/length validated, reserved names blocked, uniqueness enforced).
- **Receive mail for real** — an inbound SMTP server accepts mail for the configured domains and
  stores it for the matching mailbox; the Guerrilla provider mirrors remote inboxes into the same
  model; the Resend provider ingests mail pushed by Resend's `email.received` webhook.
- **Live inbox** — new mail is pushed over WebSocket; falls back to polling automatically at a
  configurable interval (`POLL_INTERVAL_MS`). Guerrilla has no push API, so the backend polls open
  inboxes and then uses the same WebSocket; Resend pushes a webhook and the backend fetches the body.
- **Multiple inboxes** — keep several addresses open at once, switch with a tab/click and instant
  effect, delete any of them (cap: `MAX_MAILBOXES_PER_SESSION`).
- **Recent-address history** — the last 20 addresses are remembered in `localStorage`; still-valid
  ones can be switched back to, expired ones are marked as such.
- **Session timer** — the active address shows a live countdown to expiry, with an **Extend**
  button (self-hosted provider only) bounded by `MAX_MAILBOX_LIFETIME_MINUTES`.
- **Temporary by design** — every mailbox and its messages expire after a configurable TTL, with a
  background cleanup job that also tells the UI when an address is gone.
- **Safe HTML rendering** — HTML from either provider is sanitised server-side and rendered inside a
  sandboxed iframe (no scripts, no same-origin).
- **Attachments** — self-hosted mail lists name/size/type and downloads on demand; Resend mail lists
  metadata only (bytes are never fetched) and Guerrilla exposes none.
- **Convenience** — copy-address button and an on-demand QR code for the active address.
- **Hardening** — rate limiting on creation, strict input validation, no secrets in the repo.

## Architecture

```
                 ┌─────────────────────────── Node process ───────────────────────────┐
 inbound SMTP    │  smtp-server  ──▶ mailparser ──▶ sanitize ──▶ MailboxStore (memory)  │
 :25/:2525 ─────▶│        │                                            │              │
                 │        └── 550 for unknown mailbox / domain         │ events       │
 browser ───────▶│  Express  /api/*  ◀── routes ◀── serialize ◀─────────┘              │
   HTTP :3000    │  ws       /ws     ◀── live push (new mail / expiry)                 │
                 │  static   /       ── the frontend (public/)                         │
                 │  TTL sweeper (setInterval)                                          │
                 └─────────────────────────────────────────────────────────────────────┘
```

| Layer | Choice | Why |
|---|---|---|
| Runtime | Node.js ≥ 18 (ESM) | single language for HTTP + SMTP + WebSocket |
| HTTP | Express | ubiquitous, easy static + JSON |
| Inbound mail | [`smtp-server`](https://www.npmjs.com/package/smtp-server) | standards-compliant SMTP receiver |
| MIME parsing | [`mailparser`](https://www.npmjs.com/package/mailparser) | text/html/attachments |
| Live updates | [`ws`](https://www.npmjs.com/package/ws) | WebSocket push (+ polling fallback) |
| HTML safety | [`sanitize-html`](https://www.npmjs.com/package/sanitize-html) | allow-list sanitiser |
| QR code | [`qrcode`](https://www.npmjs.com/package/qrcode) | server-side SVG for the active address |
| Providers | `src/providers/*` | one interface for self-hosted mail and Guerrilla Mail |
| Storage | in-memory `MailboxStore` | disposable by design; zero infra |

**Why in-memory?** Temp mail is ephemeral, so a database adds operational cost for no benefit here.
`MailboxStore` is a single class — swap it for Redis/SQLite if you want mailboxes to survive restarts.

### Provider abstraction

`src/providers/index.js` registers interchangeable providers. All implement the same surface:

```
listDomains() · createMailbox() · listMailboxes() · getMailbox()
listMessages() · getMessage() · deleteMessage() · deleteMailbox()
extendMailbox() · getAttachment() · markSessionActive() · start()/stop()
```

Each provider also exposes `capabilities` (`supportsDomainChoice`, `supportsCustomLocalPart`,
`supportsExtend`, `supportsDeleteMessage`, `supportsAttachments`, `retentionMinutes`,
`liveUpdates`). The UI uses those flags to hide/disable actions instead of guessing.

- `providers/selfhosted.js` — wraps the existing `MailboxStore` + inbound SMTP server. Behaviour is
  unchanged from the single-provider version.
- `providers/guerrilla.js` — talks to Guerrilla Mail's public JSON API **from the backend only**
  and mirrors messages into the same store, so tabs/history/timer/WebSocket keep working.
- `providers/guerrilla-client.js` — defensive HTTP client: User-Agent, timeout, global concurrency
  cap, minimum spacing between calls, exponential backoff, response shape checks.
- `providers/resend.js` — **receive-only**. Mailboxes are virtual (no Resend API call on create);
  mail arrives as a signed `email.received` webhook, the body is fetched over the receiving API,
  sanitised and stored. There is no send/reply/forward path anywhere.
- `providers/resend-client.js` — read-only client for the receiving API (mandatory `User-Agent`,
  timeout, retries with backoff, `Retry-After`, 404→`null`, shape checks).
- `providers/svix.js` — Svix-style webhook signature verification (`svix-id`/`svix-timestamp`/
  `svix-signature`, HMAC-SHA256 over the raw body, replay window).
- `providers/quota.js` — global daily/monthly counters so the Resend free-plan allowance is not
  burned through, with a soft warning level.

### How a mailbox and its mail flow

1. The browser calls `GET /api/domains` to fill its **grouped** provider/domain picker, then
   `POST /api/mailboxes` with a `x-session-id` header (a UUID kept in `localStorage`), a `provider`
   and optionally a `domain` / `localPart`.
2. **Self-hosted:** the server validates the domain against `DOMAINS`, validates/generates the local
   part, and stores a mailbox with `expiresAt = now + MAILBOX_TTL_MINUTES`.
3. When someone emails that address, the SMTP server checks `RCPT TO` — the domain must be allowed
   **and** the mailbox must exist, otherwise it answers `550`.
4. The message is MIME-parsed, HTML is sanitised, and it is stored on the mailbox.
5. The store emits an event; the WebSocket hub pushes it to the owning session, and the UI prepends
   it to the inbox (polling every `POLL_INTERVAL_MS` if the socket is down).
6. `POST /api/mailboxes/:address/extend` pushes a self-hosted mailbox's expiry forward by one TTL,
   never beyond `MAX_MAILBOX_LIFETIME_MINUTES` from creation.
7. The TTL sweeper deletes expired mailboxes and notifies the UI.
8. **Guerrilla Mail:** the backend calls `get_email_address` (and `set_email_user` for a custom
   name), stores the returned `sid_token` on that mailbox only, and sets a ~60-minute local expiry.
   A conservative poller checks only open inboxes, maps remote list items into the same store, and
   the same WebSocket pushes new mail to the browser. `fetch_email` is called only when a message is
   opened; the body is sanitised exactly like self-hosted mail.
9. **Resend:** the backend verifies the webhook signature over the raw body, drops unknown/expired
   recipients silently (no per-address object exists on Resend), fetches the message body over the
   receiving API once, and copies it into every matching mailbox. The body is sanitised like any
   other mail. Attachment bytes are never downloaded — metadata only.

## Quick start (local dev)

```bash
git clone https://github.com/datnguyentien2006/temp-mail-TD.git
cd temp-mail-TD
npm install

cp .env.example .env
# edit .env — at minimum set DOMAINS to something you control (or use a dev domain)

npm start           # or: npm run dev  (auto-reload)
```

- Web UI / API: <http://localhost:3000>
- Inbound SMTP: `localhost:2525` (dev default; production uses port 25)
- Tests: `npm test`

> The default SMTP port for dev is **2525** so you don't need root. Point port 25 at it in
> production, or set `SMTP_PORT=25`.

## Configuration

All configuration is via environment variables (see [`.env.example`](.env.example)).

| Variable | Default | Description |
|---|---|---|
| `DOMAINS` | *(empty)* | Comma-separated allow-list of domains to receive mail for. **Required.** |
| `HOST` | `0.0.0.0` | HTTP bind address |
| `PORT` | `3000` | HTTP port |
| `SMTP_HOST` | `0.0.0.0` | SMTP bind address |
| `SMTP_PORT` | `2525` | SMTP port (use `25` in production) |
| `SMTP_MAX_MESSAGE_BYTES` | `10485760` | Max accepted message size |
| `SMTP_TLS_KEY` / `SMTP_TLS_CERT` | *(empty)* | Set **both** to enable STARTTLS on inbound SMTP |
| `MAILBOX_TTL_MINUTES` | `30` | Mailbox lifetime |
| `MAX_MAILBOX_LIFETIME_MINUTES` | `4 × TTL` | Hard ceiling on a mailbox's total life (caps `extend`) |
| `MAX_MAILBOXES_PER_SESSION` | `5` | Per-browser cap on simultaneous inboxes |
| `SWEEP_INTERVAL_MS` | `60000` | Cleanup job interval |
| `POLL_INTERVAL_MS` | `8000` | Client polling interval when the WebSocket is unavailable |
| `CREATE_RATE_LIMIT_WINDOW_MS` | `600000` | Creation rate-limit window |
| `CREATE_RATE_LIMIT_MAX` | `30` | Max creations per window per IP |
| `CORS_ORIGIN` | *(empty)* | Set to allow cross-origin API calls |
| `TRUST_PROXY` | `false` | `true` behind a reverse proxy |
| `RANDOM_LOCAL_PART_LENGTH` | `10` | Length of generated local parts |
| `ENABLE_GUERRILLA` | `true` | Kill switch for the Guerrilla Mail provider |
| `GUERRILLA_POLL_INTERVAL_MS` | `15000` | Background poll interval; clamped to **≥ 10000** |
| `GUERRILLA_MIN_SYNC_INTERVAL_MS` | `= poll interval` | Minimum gap between syncs of one inbox (≥ 2000) |
| `GUERRILLA_REQUEST_TIMEOUT_MS` | `10000` | Per-request API timeout |
| `GUERRILLA_MAX_CONCURRENCY` | `4` | Global cap on concurrent Guerrilla requests |
| `GUERRILLA_MIN_REQUEST_INTERVAL_MS` | `300` | Minimum spacing between outbound requests |
| `GUERRILLA_MAX_BACKOFF_MS` | `300000` | Exponential backoff ceiling after failures |
| `GUERRILLA_ACTIVE_WINDOW_MS` | `300000` | How long an inbox stays "open" for polling |
| `GUERRILLA_RETENTION_MINUTES` | `60` | Local lifetime for Guerrilla inboxes |
| `GUERRILLA_API_BASE` | official endpoint | Override the API URL (testing/proxy) |
| `GUERRILLA_USER_AGENT` | project UA | User-Agent sent to Guerrilla Mail |
| `ENABLE_RESEND` | `true` | Kill switch for the Resend provider (also needs `RESEND_DOMAINS`) |
| `RESEND_DOMAINS` | *(empty)* | Comma-separated domains verified for receiving in Resend. Empty ⇒ provider off |
| `RESEND_API_KEY` | *(empty)* | Resend API key (**full access**); secret, never sent to clients |
| `RESEND_WEBHOOK_SECRET` | *(empty)* | Signing secret of the receiving webhook (`whsec_…`); secret |
| `RESEND_REQUEST_TIMEOUT_MS` | `10000` | Per-request timeout for the receiving API |
| `RESEND_MAX_RETRIES` | `2` | Retries (exponential backoff) on 429/5xx/network errors |
| `RESEND_RETRY_BASE_MS` | `500` | Base delay for the retry backoff |
| `RESEND_SIGNATURE_TOLERANCE_MS` | `300000` | Reject webhooks older than this (replay protection; `0` disables) |
| `RESEND_WEBHOOK_MAX_BYTES` | `1048576` | Webhook body size cap |
| `RESEND_DEDUPE_TTL_MS` | `86400000` | How long a processed `email_id` is remembered |
| `RESEND_DAILY_LIMIT` | `100` | Daily processing cap (free plan); reaching it pauses the provider |
| `RESEND_MONTHLY_LIMIT` | `3000` | Monthly processing cap (free plan) |
| `RESEND_SOFT_LIMIT_RATIO` | `0.8` | Fraction of a limit at which the provider is flagged degraded |
| `RESEND_MAX_MESSAGES_PER_MAILBOX` | `50` | Per-mailbox stored-message cap |
| `RESEND_MAX_MESSAGES_PER_SENDER` | `20` | Per-sender cap within one mailbox |
| `RESEND_API_BASE` | `https://api.resend.com` | Override the API URL (testing/proxy) |
| `RESEND_USER_AGENT` | project UA | User-Agent sent to Resend (required by their API) |

## Mailbox providers

`GET /api/domains` returns both a flat legacy list and a grouped descriptor:

```json
{
  "domains": ["example.com"],
  "providers": [
    {
      "id": "selfhosted",
      "label": "Self-hosted mail",
      "capabilities": { "supportsDomainChoice": true, "supportsExtend": true, "retentionMinutes": 30 },
      "domains": ["example.com"]
    },
    {
      "id": "guerrilla",
      "label": "Guerrilla Mail",
      "capabilities": { "supportsDomainChoice": false, "supportsExtend": false, "retentionMinutes": 60 },
      "domains": []
    },
    {
      "id": "resend",
      "label": "Resend",
      "capabilities": {
        "supportsDomainChoice": true,
        "supportsExtend": true,
        "supportsAttachments": false,
        "liveUpdates": "webhook",
        "retentionMinutes": 30
      },
      "domains": ["inbox.example.com"],
      "status": { "available": true, "quota": { "daily": { "used": 3, "limit": 100 }, "monthly": { "used": 3, "limit": 3000 } } }
    }
  ]
}
```

Each provider entry also carries a `status` object. When a provider is configured but cannot be used
right now (missing `RESEND_API_KEY`/`RESEND_WEBHOOK_SECRET`, or the daily/monthly quota is reached)
`status.available` is `false` with a `reason`, and the UI shows it disabled instead of offering an
option that cannot work.

### Guerrilla Mail provider

- **No API key, no signup.** It uses the official public JSON API
  (<https://www.guerrillamail.com/GuerrillaMailAPI.html>) and is enabled by default; set
  `ENABLE_GUERRILLA=false` to remove it entirely.
- **The backend is the only client.** `api.guerrillamail.com` is never called from the browser, so
  there is no CORS problem and the `sid_token` never reaches the client, a URL, a log line or an
  error message. Each mailbox has its own remote session bound to the browser session that created
  it.
- **Domain choice is NOT possible.** Guerrilla's API has a `site` parameter, but it selects a
  **custom domain you registered with Guerrilla** — it cannot pick among their public domains. Real
  probes with `site=grr.la`, `domain=spam4.me` and `site=pokemail.net` all still returned
  `@guerrillamailblock.com`. The UI therefore shows only **“Random (Guerrilla Mail)”**; no fake list.
- **Retention is about one hour** (the API documents 60-minute message retention; `extend` is
  deprecated). Local inboxes expire after `GUERRILLA_RETENTION_MINUTES`.
- **Polling, not push.** The backend polls `get_email_list`/`check_email` every
  `GUERRILLA_POLL_INTERVAL_MS` (default 15 s, floor 10 s) and only for inboxes used within
  `GUERRILLA_ACTIVE_WINDOW_MS`. It de-duplicates by `mail_id`, collapses concurrent syncs per
  `sid_token`, backs off exponentially on errors/429/5xx, and enforces a global concurrency cap.
- **Graceful failures.** Expired remote sessions are re-registered with the same local part; a
  missing message (`fetch_email` returns `false`) becomes a 404; if the API is down cached messages
  still render and a cold inbox returns `502`.
- **Limitations:** no push API, no domain selection, no attachment download (documented as TODO by
  Guerrilla), no extend, and about one hour of retention. It is a third-party dependency: availability,
  retention and content are outside this app's control.
- **Terms & rate limits.** Guerrilla's docs say *“The API may be rate limited, but we do not publish
  our rate limits. Please use this API carefully.”* Their ToS prohibits over-using resources by
  repeatedly making many requests. This implementation is deliberately conservative (default 15 s
  polling, 300 ms between calls, max 4 concurrent, exponential backoff) and only polls open inboxes.
  Review Guerrilla's terms before deploying at scale.

### Resend provider (receive-only)

- **Receive-only by design.** This provider never sends, replies or forwards. It is enabled by
  default but stays hidden until you set at least one domain in `RESEND_DOMAINS`; set
  `ENABLE_RESEND=false` to remove it entirely.
- **How mail arrives.** Resend receives mail at a domain you verified (a custom domain with Resend's
  MX record, or your account's `<id>.resend.app` subdomain) for **any** username, then fires an
  `email.received` webhook. There is no per-address inbox object to create, so creating a mailbox
  here is **virtual** — no Resend API call is made. The backend then fetches the body once over
  `GET /emails/receiving/{id}` and stores it in every matching mailbox.
- **Webhook endpoint:** `POST /api/webhooks/resend`. Point Resend's receiving webhook at
  `https://<your-public-host>/api/webhooks/resend`. It is mounted **before** the JSON body parser so
  the signature is verified over the raw bytes. Invalid/missing signatures are rejected with `401`
  and never processed; non-`email.received` events are acknowledged and ignored; processing happens
  after a `202` so Resend does not time out and retry.
- **Required key permission:** `full_access`. A `sending_access` key cannot call the receiving
  retrieve endpoint. A sending-only key is detected and reported specifically: at startup the server
  probes the key once (a bogus id — a `404` means the key is usable, `401/403` means it is not) and
  logs the reason, and `/api/domains` reports the provider as unavailable with the same reason until
  a request succeeds. Secrets (`RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`) live only in the
  environment and are never logged or returned to clients.
- **Unknown or expired recipients are dropped silently** — no bounce, no reveal. Duplicate webhooks
  (same `email_id`) are processed once; a `svix-timestamp` outside
  `RESEND_SIGNATURE_TOLERANCE_MS` is rejected (replay protection).
- **Quota protection.** The free plan is **100/day, 3,000/month** (shared with sent mail, reset at
  midnight UTC), and every received message counts. The provider keeps global counters, warns at
  `RESEND_SOFT_LIMIT_RATIO`, and **stops processing** at the hard limit, marking itself unavailable
  in the UI. Per-mailbox and per-sender caps add a second layer.
- **Limitations:** attachments are metadata only (bytes are never downloaded), no domain selection
  beyond the domains you configure, and the Resend free plan's retention is about 30 days while this
  app keeps mail only for the mailbox lifetime. It is a third-party dependency: availability, quota
  and content are outside this app's control.

## Configuring domains & DNS

List **every domain you own and want to receive mail for** in `DOMAINS` (comma-separated). They all
share one inbound SMTP server. The UI reads this list at runtime from `GET /api/domains` and shows it
in a dropdown (plus a *Random* entry); the server rejects any domain that is not in the list, so you
cannot be tricked into accepting mail for someone else's domain.

For each domain you list in `DOMAINS`:

1. **MX record** → your mail server (so the world delivers mail to you):
   ```
   example.com.   MX   10   mail.example.com.
   ```
2. **A/AAAA record** for the mail host, pointing at the server's public IP:
   ```
   mail.example.com.   A   203.0.113.10
   ```
3. **SPF** (recommended — you're not sending, so hard-fail):
   ```
   example.com.   TXT   "v=spf1 -all"
   ```
4. **DMARC** (recommended):
   ```
   _dmarc.example.com.   TXT   "v=DMARC1; p=none; rua=mailto:dmarc@example.com"
   ```
5. Open **TCP 25** to the host (many clouds block 25 by default — request it to be unblocked, or use
   a relay/vPS that allows it).

The server does **not** send mail; it only receives. No MTA/relay is required.

## API

All endpoints except `/api/health`, `/api/config` and `/api/domains` require the `x-session-id` header
(any 8–128 char `[A-Za-z0-9_-]` string; the bundled frontend uses a UUID).

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/health` | Liveness probe |
| `GET` | `/api/domains` | Grouped provider/domain descriptor plus the flat `domains` list (public; fills the UI picker) |
| `GET` | `/api/config` | Domains, TTL, lifetime cap, per-session cap and polling interval (public) |
| `POST` | `/api/mailboxes` | Create a mailbox. Body `{ provider?, domain?, localPart? }`. `provider` defaults to `selfhosted`; omit `domain` for a random domain (self-hosted/Resend); omit it for Guerrilla (not selectable). `201` with the mailbox, `400` invalid, `409` taken, `429` rate/limit, `502` third-party failure, `503` provider temporarily unavailable |
| `GET` | `/api/mailboxes` | List the session's mailboxes (all providers) |
| `DELETE` | `/api/mailboxes/:address` | Delete a mailbox (Guerrilla: best-effort `forget_me`; Resend: local only) |
| `POST` | `/api/mailboxes/:address/extend` | Extend a **self-hosted** or **Resend** mailbox by one TTL (capped by `MAX_MAILBOX_LIFETIME_MINUTES`); `400` for Guerrilla |
| `GET` | `/api/mailboxes/:address/qr` | QR code for the address as an SVG data URL (any provider) |
| `GET` | `/api/mailboxes/:address/messages` | List message summaries (syncs Guerrilla inboxes first) |
| `GET` | `/api/mailboxes/:address/messages/:id` | Full message (sanitised HTML + text; fetches the Guerrilla body on demand) |
| `DELETE` | `/api/mailboxes/:address/messages/:id` | Delete a message (also removes it remotely for Guerrilla; Resend: local only) |
| `GET` | `/api/mailboxes/:address/messages/:id/attachments/:index` | Download a **self-hosted** attachment; `400` for Guerrilla and Resend |
| `POST` | `/api/webhooks/resend` | Resend inbound webhook (`email.received`). Signature-verified over the raw body; not session-authenticated |

Every mailbox object includes `provider: "selfhosted" | "guerrilla" | "resend"`. Secrets (`sid_token`,
`providerData`, the Resend API key and webhook secret) are never serialised.

WebSocket: `ws://host/ws?sessionId=<session>` — server pushes
`{type:"message",address,message}`, `{type:"extended",address,expiresAt}` and
`{type:"expired",address}`.

Example:

```bash
# Self-hosted address on a domain you own
curl -s -X POST http://localhost:3000/api/mailboxes \
  -H 'content-type: application/json' -H 'x-session-id: demo-session-1234' \
  -d '{"provider":"selfhosted","domain":"example.com","localPart":"hello"}'

# Guerrilla Mail address (domain is chosen by Guerrilla; custom names work)
curl -s -X POST http://localhost:3000/api/mailboxes \
  -H 'content-type: application/json' -H 'x-session-id: demo-session-1234' \
  -d '{"provider":"guerrilla","localPart":"hello"}'

# Resend address on a domain you verified for receiving (virtual; no API call)
curl -s -X POST http://localhost:3000/api/mailboxes \
  -H 'content-type: application/json' -H 'x-session-id: demo-session-1234' \
  -d '{"provider":"resend","domain":"inbox.example.com","localPart":"hello"}'
```

## Testing

```bash
npm test
```

Covers the grouped domain endpoint, random-domain selection, domain allow-listing (unknown domains
rejected), local-part/custom-username rules, reserved names, mailbox creation / duplication / limits /
deletion, session isolation, TTL eviction, expiry extension and its cap, the QR endpoint, **inbound
mail over a real SMTP connection**, attachment capture, HTML sanitisation, and 550 rejection for
unknown mailboxes and disallowed domains.

Provider tests (`test/providers.test.js`) use a **mocked Guerrilla HTTP client** — the suite never
touches the real API. They cover the provider interface, grouped `/api/domains`, the kill switch,
Guerrilla create/custom-name/domain rejection, `sid_token` isolation between two sessions, polling
de-duplication, HTML sanitisation, `fetch_email === false`, expired-session re-registration, graceful
cached responses, active-inbox-only polling, unsupported extend/attachments, delete/forget, and
third-party failure handling.

Resend tests (`test/resend.test.js`) use a **mocked receiving client and an in-memory fake store** —
no request ever leaves the process. They cover the enable/configure gating, the unavailable status,
virtual mailbox creation and validation, **signature verification over the raw body** (good,
tampered, stale, re-serialised and multi-candidate), non-`email.received` and disabled-provider
behaviour, silent dropping of unknown/expired recipients, de-duplication, HTML sanitisation with an
XSS payload, multi-recipient fan-out, session isolation, quota hard/soft limits and rollover,
per-mailbox/per-sender caps, client status mapping (404→null, 429/401/timeout), and that the client
exposes read endpoints only.

## Provenance

This project is an original, self-hosted implementation. It contains **no** copied code, CSS, text or
assets from other temp-mail projects. The optional Guerrilla Mail provider uses **Guerrilla Mail's
official public API** to create and read inboxes on their domains; the optional Resend provider uses
**Resend's official receiving API and webhooks** on domains you verified with Resend; the self-hosted
provider only ever accepts mail for the domains you configure in `DOMAINS`. No look-alike or
typosquatted domains are used.

## Deployment notes

1. Provision a host with a public IP and **inbound port 25 open**.
2. `git clone`, `npm ci --omit=dev`, create `.env` (`NODE_ENV=production`, `DOMAINS=...`,
   `TRUST_PROXY=true` if behind a proxy).
3. Run under a process manager (systemd, pm2, Docker) and keep the SMTP port privileged:
   - systemd: run as a user with `AmbientCapabilities=CAP_NET_BIND_SERVICE`, or use `SMTP_PORT=25`
     with the service running as root and dropping privileges afterwards.
4. Put Nginx/Caddy in front for TLS on the web port (WebSocket upgrade must be enabled:
   `proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade";`).
5. Enable STARTTLS on SMTP by setting `SMTP_TLS_KEY`/`SMTP_TLS_CERT` (e.g. Let's Encrypt).
6. Optional Docker:

   ```dockerfile
   FROM node:20-alpine
   WORKDIR /app
   COPY package*.json ./
   RUN npm ci --omit=dev
   COPY . .
   ENV NODE_ENV=production
   EXPOSE 3000 25
   CMD ["node", "src/server.js"]
   ```

   Run with `-p 3000:3000 -p 25:25 --env-file .env`.

> **Resend provider:** besides inbound port 25, Resend needs to reach your app over **public HTTPS**
> at `https://<your-public-host>/api/webhooks/resend` (use the reverse proxy in step 4, or a tunnel
> such as ngrok / VS Code port forwarding for local testing). Set `RESEND_DOMAINS`,
> `RESEND_API_KEY` and `RESEND_WEBHOOK_SECRET`, then add the receiving webhook in the Resend
> dashboard.

## Security

- HTML email is sanitised with an allow-list **and** rendered in a sandboxed iframe (`sandbox=""`),
  so scripts, event handlers and `javascript:` URLs cannot run.
- Mailbox creation is rate-limited per IP and capped per session; local parts are validated and
  reserved names are refused.
- SMTP rejects unknown recipients and non-allowed domains (no open relay, no backscatter).
- The API is session-scoped: you can only read/delete your own mailboxes.
- Guerrilla `sid_token`s are stored server-side on that mailbox and are never serialised, logged or
  placed in URLs; only the backend talks to the Guerrilla API.
- Resend webhooks are verified with an HMAC-SHA256 signature over the **raw** body before anything is
  processed; a missing/invalid signature is a `401`, a stale `svix-timestamp` is rejected (replay
  protection), and duplicate `email_id`s are processed once. The `RESEND_API_KEY` and
  `RESEND_WEBHOOK_SECRET` are backend-only and never serialised, logged or returned.
- Resend mail is **receive-only**: there is no send/reply/forward/draft code path in the client or the
  provider, so a leaked key cannot be used by this app to send mail.
- Secrets live only in `.env` (git-ignored); `.env.example` documents everything.

## Known limitations / next steps

- **In-memory storage** — a restart drops mailboxes. Add Redis/SQLite persistence if needed.
- **History is per-browser** — recent addresses live in `localStorage`, so they do not follow the
  user across devices.
- **No push for "extend" across tabs beyond the same session** — the WebSocket broadcast covers the
  owning session only.
- **Plaintext SMTP by default** — enable `SMTP_TLS_*` for encrypted inbound delivery.
- **No DKIM/outbound** — this app only receives.
- **In-process WebSocket fan-out** — for multiple instances, add a Redis pub/sub bridge.
- **No content spam/virus scanning** — consider an MTA (Postfix/`rspamd`) in front for production.
- Rate limiting is per-process; use a shared store behind multiple instances.
- Browser sessions are unauthenticated by design (disposable mail).
- **Guerrilla Mail is a third-party dependency** — about one hour of retention, polling instead of
  push, no domain choice, no attachment download, no extend. Availability, rate limits and content
  are outside this app's control; read their terms before relying on it.
- **Guerrilla polling is in-process** — with multiple instances each would poll independently. Run a
  single instance or share the poller/cache before scaling out.
- **Resend is a third-party dependency** — receive-only, attachment bytes are never downloaded
  (metadata only), domain choice is limited to the domains you configure, and the free plan is small
  (100/day, 3,000/month, shared with sent mail). Processing pauses at the configured quota.
- **Resend quota counters are in-process** — with multiple instances each keeps its own counters and
  could collectively exceed the account allowance. Run a single instance or share the counters before
  scaling out.

## License

MIT
