/* Temp Mail frontend — vanilla JS, no build step. */

const SESSION_KEY = 'tempmail.sessionId';
const POLL_INTERVAL_MS = 8000;

const state = {
  sessionId: getSessionId(),
  domains: [],
  ttlMinutes: 30,
  mailboxes: [],
  currentAddress: null,
  messages: [],
  currentMessageId: null,
  socket: null,
};

const el = {
  form: document.getElementById('createForm'),
  domainSelect: document.getElementById('domainSelect'),
  localPartInput: document.getElementById('localPartInput'),
  newBtn: document.getElementById('newBtn'),
  mailboxList: document.getElementById('mailboxList'),
  sidebarHint: document.getElementById('sidebarHint'),
  currentAddress: document.getElementById('currentAddress'),
  copyBtn: document.getElementById('copyBtn'),
  ttl: document.getElementById('ttl'),
  status: document.getElementById('status'),
  messageList: document.getElementById('messageList'),
  messageView: document.getElementById('messageView'),
};

function getSessionId() {
  let id = localStorage.getItem(SESSION_KEY);
  if (!id) {
    id = (crypto.randomUUID && crypto.randomUUID()) || `s-${Math.random().toString(36).slice(2)}${Date.now()}`;
    localStorage.setItem(SESSION_KEY, id);
  }
  return id;
}

function setStatus(text, isError = false) {
  el.status.textContent = text || '';
  el.status.classList.toggle('error', Boolean(isError));
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      'x-session-id': state.sessionId,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

function formatTime(ts) {
  const d = new Date(Number(ts) || Date.now());
  return d.toLocaleString();
}

function relativeTime(ts) {
  const diff = Date.now() - Number(ts);
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return formatTime(ts);
}

/* ------------------------------------------------------------------ init */
async function init() {
  try {
    const cfg = await api('/api/config');
    state.domains = cfg.domains || [];
    state.ttlMinutes = cfg.ttlMinutes || 30;
    renderDomains();
  } catch (err) {
    setStatus(`Could not load config: ${err.message}`, true);
  }
  await refreshMailboxes();
  connectSocket();
  setInterval(tickTtl, 1000);
  setInterval(pollFallback, POLL_INTERVAL_MS);
}

function renderDomains() {
  el.domainSelect.innerHTML = '';
  if (state.domains.length === 0) {
    const opt = document.createElement('option');
    opt.textContent = 'no domains configured';
    opt.disabled = true;
    el.domainSelect.appendChild(opt);
    el.newBtn.disabled = true;
    setStatus('No domains configured on the server (set DOMAINS).', true);
    return;
  }
  for (const domain of state.domains) {
    const opt = document.createElement('option');
    opt.value = domain;
    opt.textContent = domain;
    el.domainSelect.appendChild(opt);
  }
}

/* ----------------------------------------------------- mailbox lifecycle */
el.form.addEventListener('submit', async (event) => {
  event.preventDefault();
  el.newBtn.disabled = true;
  setStatus('Creating mailbox…');
  try {
    const localPart = el.localPartInput.value.trim();
    const mailbox = await api('/api/mailboxes', {
      method: 'POST',
      body: JSON.stringify({ domain: el.domainSelect.value, localPart: localPart || undefined }),
    });
    el.localPartInput.value = '';
    await refreshMailboxes();
    await selectMailbox(mailbox.address);
    setStatus(`Mailbox ${mailbox.address} is ready.`);
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    el.newBtn.disabled = state.domains.length === 0;
  }
});

async function refreshMailboxes() {
  try {
    const data = await api('/api/mailboxes');
    state.mailboxes = data.mailboxes || [];
  } catch (err) {
    state.mailboxes = [];
    setStatus(err.message, true);
  }
  renderMailboxes();
}

function renderMailboxes() {
  el.mailboxList.innerHTML = '';
  el.sidebarHint.style.display = state.mailboxes.length ? 'none' : 'block';
  for (const mailbox of state.mailboxes) {
    const li = document.createElement('li');
    li.className = `mailbox-item${mailbox.address === state.currentAddress ? ' active' : ''}`;
    li.innerHTML = `
      <span class="addr">${escapeHtml(mailbox.address)}</span>
      <span class="count">${mailbox.messageCount}</span>
      <button class="del ghost" title="Delete">✕</button>`;
    li.addEventListener('click', (e) => {
      if (e.target.closest('.del')) return;
      selectMailbox(mailbox.address);
    });
    li.querySelector('.del').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`Delete ${mailbox.address}?`)) return;
      try {
        await api(`/api/mailboxes/${encodeURIComponent(mailbox.address)}`, { method: 'DELETE' });
        if (state.currentAddress === mailbox.address) {
          state.currentAddress = null;
          state.messages = [];
          renderMessages();
          renderMessageView(null);
        }
        await refreshMailboxes();
      } catch (err) {
        setStatus(err.message, true);
      }
    });
    el.mailboxList.appendChild(li);
  }
}

async function selectMailbox(address) {
  state.currentAddress = address;
  state.currentMessageId = null;
  const mailbox = state.mailboxes.find((m) => m.address === address);
  el.currentAddress.textContent = address;
  el.copyBtn.disabled = false;
  renderMailboxes();
  renderMessageView(null);
  if (mailbox) tickTtl(mailbox);
  await loadMessages();
}

/* --------------------------------------------------------- messages */
async function loadMessages() {
  if (!state.currentAddress) return;
  try {
    const data = await api(`/api/mailboxes/${encodeURIComponent(state.currentAddress)}/messages`);
    state.messages = data.messages || [];
    renderMessages();
  } catch (err) {
    setStatus(err.message, true);
  }
}

function renderMessages() {
  el.messageList.innerHTML = '';
  if (!state.currentAddress) {
    el.messageList.innerHTML = '<li class="empty">Select or create an address.</li>';
    return;
  }
  if (state.messages.length === 0) {
    el.messageList.innerHTML = '<li class="empty">Waiting for mail…</li>';
    return;
  }
  for (const msg of state.messages) {
    const li = document.createElement('li');
    li.className = `message${msg.id === state.currentMessageId ? ' active' : ''}`;
    li.innerHTML = `
      <div class="from">${escapeHtml(msg.from)}</div>
      <div class="subject">${escapeHtml(msg.subject)}</div>
      <div class="meta">
        <span>${escapeHtml(relativeTime(msg.receivedAt))}</span>
        <span>${msg.attachmentCount ? `<span class="badge">📎 ${msg.attachmentCount}</span>` : ''}</span>
      </div>`;
    li.addEventListener('click', () => openMessage(msg.id));
    el.messageList.appendChild(li);
  }
}

async function openMessage(messageId) {
  state.currentMessageId = messageId;
  renderMessages();
  try {
    const msg = await api(
      `/api/mailboxes/${encodeURIComponent(state.currentAddress)}/messages/${messageId}`,
    );
    renderMessageView(msg);
  } catch (err) {
    setStatus(err.message, true);
  }
}

function renderMessageView(msg) {
  if (!msg) {
    el.messageView.hidden = true;
    el.messageView.innerHTML = '';
    return;
  }
  el.messageView.hidden = false;

  const attachments = msg.attachments || [];
  const attachmentHtml = attachments.length
    ? `<div class="attachments"><strong>Attachments:</strong><ul>${attachments
        .map(
          (a) =>
            `<li><a href="/api/mailboxes/${encodeURIComponent(state.currentAddress)}/messages/${msg.id}/attachments/${a.index}">${escapeHtml(a.filename)}</a> (${escapeHtml(a.contentType)}, ${a.size} B)</li>`,
        )
        .join('')}</ul></div>`
    : '';

  el.messageView.innerHTML = `
    <header>
      <h3>${escapeHtml(msg.subject)}</h3>
      <div class="headers">
        <div><strong>From:</strong> ${escapeHtml(msg.from)}</div>
        <div><strong>To:</strong> ${escapeHtml(msg.to)}</div>
        <div><strong>Date:</strong> ${escapeHtml(formatTime(msg.date ? Date.parse(msg.date) : msg.receivedAt))}</div>
      </div>
    </header>
    <div id="bodyHost"></div>
    ${attachmentHtml}`;

  const host = el.messageView.querySelector('#bodyHost');
  if (msg.html) {
    const iframe = document.createElement('iframe');
    iframe.setAttribute('sandbox', ''); // no scripts, no same-origin
    iframe.setAttribute('referrerpolicy', 'no-referrer');
    iframe.srcdoc = msg.html; // already sanitised by the server
    iframe.addEventListener('load', () => {
      try {
        iframe.style.height = `${Math.min(iframe.contentDocument.body.scrollHeight + 40, 800)}px`;
      } catch { /* sandboxed — ignore */ }
    });
    host.appendChild(iframe);
  } else {
    const pre = document.createElement('pre');
    pre.textContent = msg.text || '(empty message)';
    host.appendChild(pre);
  }
}

/* --------------------------------------------------- live updates */
function connectSocket() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const socket = new WebSocket(`${proto}://${location.host}/ws?sessionId=${encodeURIComponent(state.sessionId)}`);
  state.socket = socket;

  socket.addEventListener('message', (event) => {
    let payload;
    try { payload = JSON.parse(event.data); } catch { return; }
    if (payload.type === 'message') {
      if (payload.address === state.currentAddress) {
        state.messages.unshift(payload.message);
        renderMessages();
        setStatus('New message received.');
      }
      const mailbox = state.mailboxes.find((m) => m.address === payload.address);
      if (mailbox) {
        mailbox.messageCount += 1;
        renderMailboxes();
      }
    } else if (payload.type === 'expired') {
      state.mailboxes = state.mailboxes.filter((m) => m.address !== payload.address);
      if (state.currentAddress === payload.address) {
        state.currentAddress = null;
        state.messages = [];
        el.currentAddress.textContent = 'Address expired';
        el.copyBtn.disabled = true;
        renderMessages();
        renderMessageView(null);
        setStatus('This address expired and was cleaned up.', true);
      }
      renderMailboxes();
    }
  });

  socket.addEventListener('close', () => {
    state.socket = null;
    setTimeout(connectSocket, 3000);
  });
}

function pollFallback() {
  if (state.socket && state.socket.readyState === WebSocket.OPEN) return;
  if (state.currentAddress) loadMessages();
}

/* ----------------------------------------------------------- misc UI */
el.copyBtn.addEventListener('click', async () => {
  if (!state.currentAddress) return;
  try {
    await navigator.clipboard.writeText(state.currentAddress);
    setStatus('Address copied to clipboard.');
  } catch {
    setStatus('Copy failed — select the address manually.', true);
  }
});

function tickTtl() {
  const mailbox = state.mailboxes.find((m) => m.address === state.currentAddress);
  if (!mailbox) { el.ttl.textContent = ''; return; }
  const remaining = mailbox.expiresAt - Date.now();
  if (remaining <= 0) { el.ttl.textContent = 'expiring…'; return; }
  const mins = Math.floor(remaining / 60000);
  const secs = Math.floor((remaining % 60000) / 1000);
  el.ttl.textContent = `expires in ${mins}m ${String(secs).padStart(2, '0')}s`;
}

init();
