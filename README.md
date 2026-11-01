# Temp Mail

A small, self-hosted **disposable email** web app. Generate throwaway addresses on demand and
receive anything sent to them — straight into the browser, live.

![status](https://img.shields.io/badge/tests-node%3Atest-brightgreen)

## Features

- **Domain dropdown, driven by the server** — the UI fills its picker from `GET /api/domains`
  (nothing is hardcoded in the HTML) and offers a **Random domain** option. The backend validates
  that every submitted domain is in the configured allow-list.
- **One-click mailbox creation** — random local part on the chosen domain, or a custom local part
  (format/length validated, reserved names blocked, uniqueness enforced).
- **Receive mail for real** — an inbound SMTP server accepts mail for the configured domains and
  stores it for the matching mailbox.
- **Live inbox** — new mail is pushed over WebSocket; falls back to polling automatically at a
  configurable interval (`POLL_INTERVAL_MS`).
- **Multiple inboxes** — keep several addresses open at once, switch with a tab/click and instant
  effect, delete any of them (cap: `MAX_MAILBOXES_PER_SESSION`).
- **Recent-address history** — the last 20 addresses are remembered in `localStorage`; still-valid
  ones can be switched back to, expired ones are marked as such.
- **Session timer** — the active address shows a live countdown to expiry, with an **Extend**
  button that pushes it forward by one TTL (bounded by `MAX_MAILBOX_LIFETIME_MINUTES`).
- **Temporary by design** — every mailbox and its messages expire after a configurable TTL, with a
  background cleanup job that also tells the UI when an address is gone.
- **Safe HTML rendering** — inbound HTML is sanitised server-side and rendered inside a
  sandboxed iframe (no scripts, no same-origin).
- **Attachments** — listed with name/size/type and downloadable on demand.
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
| Storage | in-memory `MailboxStore` | disposable by design; zero infra |

**Why in-memory?** Temp mail is ephemeral, so a database adds operational cost for no benefit here.
`MailboxStore` is a single class — swap it for Redis/SQLite if you want mailboxes to survive restarts.

### How a mailbox and its mail flow

1. The browser calls `GET /api/domains` to fill its domain picker (with a **Random** option), then
   `POST /api/mailboxes` with a `x-session-id` header (a UUID kept in `localStorage`) and a domain.
2. The server validates the domain against `DOMAINS`, validates/generates the local part, and stores
   a mailbox with `expiresAt = now + MAILBOX_TTL_MINUTES`.
3. When someone emails that address, the SMTP server checks `RCPT TO` — the domain must be allowed
   **and** the mailbox must exist, otherwise it answers `550`.
4. The message is MIME-parsed, HTML is sanitised, and it is stored on the mailbox.
5. The store emits an event; the WebSocket hub pushes it to the owning session, and the UI prepends
   it to the inbox (polling every `POLL_INTERVAL_MS` if the socket is down).
6. `POST /api/mailboxes/:address/extend` pushes a mailbox's expiry forward by one TTL, never beyond
   `MAX_MAILBOX_LIFETIME_MINUTES` from creation.
7. The TTL sweeper deletes expired mailboxes and notifies the UI.

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
| `GET` | `/api/domains` | The configured domain allow-list (public; fills the UI picker) |
| `GET` | `/api/config` | Domains, TTL, lifetime cap, per-session cap and polling interval (public) |
| `POST` | `/api/mailboxes` | Create a mailbox. Body `{ domain?, localPart? }`. Omit `domain` for a random one. `201` with the mailbox, `400` invalid, `409` taken, `429` rate/limit |
| `GET` | `/api/mailboxes` | List the session's mailboxes |
| `DELETE` | `/api/mailboxes/:address` | Delete a mailbox |
| `POST` | `/api/mailboxes/:address/extend` | Extend the mailbox by one TTL (capped by `MAX_MAILBOX_LIFETIME_MINUTES`) |
| `GET` | `/api/mailboxes/:address/qr` | QR code for the address as an SVG data URL |
| `GET` | `/api/mailboxes/:address/messages` | List message summaries |
| `GET` | `/api/mailboxes/:address/messages/:id` | Full message (sanitised HTML + text) |
| `DELETE` | `/api/mailboxes/:address/messages/:id` | Delete a message |
| `GET` | `/api/mailboxes/:address/messages/:id/attachments/:index` | Download an attachment |

WebSocket: `ws://host/ws?sessionId=<session>` — server pushes
`{type:"message",address,message}`, `{type:"extended",address,expiresAt}` and
`{type:"expired",address}`.

Example:

```bash
curl -s -X POST http://localhost:3000/api/mailboxes \
  -H 'content-type: application/json' -H 'x-session-id: demo-session-1234' \
  -d '{"domain":"example.com","localPart":"hello"}'
```

## Testing

```bash
npm test
```

Covers the domain list endpoint, random-domain selection, domain allow-listing (unknown domains
rejected), local-part/custom-username rules, reserved names, mailbox creation / duplication / limits /
deletion, session isolation, TTL eviction, expiry extension and its cap, the QR endpoint, **inbound
mail over a real SMTP connection**, attachment capture, HTML sanitisation, and 550 rejection for
unknown mailboxes and disallowed domains.

## Provenance

This project is an original, self-hosted implementation. It was *inspired* by the feature set of
other temp-mail front-ends, but contains **no** copied code, CSS, text or assets from them, and it
does **not** call any third-party mail API — it runs its own SMTP server and only ever uses the
domains you configure in `DOMAINS`.

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

## Security

- HTML email is sanitised with an allow-list **and** rendered in a sandboxed iframe (`sandbox=""`),
  so scripts, event handlers and `javascript:` URLs cannot run.
- Mailbox creation is rate-limited per IP and capped per session; local parts are validated and
  reserved names are refused.
- SMTP rejects unknown recipients and non-allowed domains (no open relay, no backscatter).
- The API is session-scoped: you can only read/delete your own mailboxes.
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

## License

MIT
