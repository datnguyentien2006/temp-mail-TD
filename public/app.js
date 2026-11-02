/* Temp Mail frontend - vanilla JS, no build step.
 *
 * Talks to the same-origin REST API with an `x-session-id` header and listens
 * on the WebSocket for live updates, falling back to polling when it is down.
 */

const SESSION_KEY = 'tempmail.sessionId';
const HISTORY_KEY = 'tempmail.history';
const HISTORY_MAX = 20;

const state = {
  sessionId: getSessionId(),
  domains: [],
  providers: [],
  ttlMinutes: 30,
  maxMailboxLifetimeMinutes: 120,
  maxMailboxes: 5,
  pollIntervalMs: 8000,
  mailboxes: [],
  currentAddress: null,
  messages: [],
  currentMessageId: null,
  history: loadHistory(),
  socket: null,
  socketRetry: 0,
};

const el = {
  form: document.getElementById('createForm'),
  domainSelect: document.getElementById('domainSelect'),
  localPartInput: document.getElementById('localPartInput'),
  newBtn: document.getElementById('newBtn'),
  mailboxList: document.getElementById('mailboxList'),
  mailboxCount: document.getElementById('mailboxCount'),
  sidebarHint: document.getElementById('sidebarHint'),
  historyList: document.getElementById('historyList'),
  historyHint: document.getElementById('historyHint'),
  tabs: document.getElementById('tabs'),
  currentAddress: document.getElementById('currentAddress'),
  copyBtn: document.getElementById('copyBtn'),
  qrBtn: document.getElementById('qrBtn'),
  extendBtn: document.getElementById('extendBtn'),
  ttl: document.getElementById('ttl'),
  status: document.getElementById('status'),
  providerNotice: document.getElementById('providerNotice'),
  messageList: document.getElementById('messageList'),
  messageView: document.getElementById('messageView'),
  qrModal: document.getElementById('qrModal'),
  qrImage: document.getElementById('qrImage'),
  qrAddress: document.getElementById('qrAddress'),
  qrClose: document.getElementById('qrClose'),
};

/* --------------------------------------------------------------- utils */
function getSessionId() {
  let id = localStorage.getItem(SESSION_KEY);
  if (!id) {
    id = (crypto.randomUUID && crypto.randomUUID()) || `s-${Math.random().toString(36).slice(2)}${Date.now()}`;
    localStorage.setItem(SESSION_KEY, id);
  }
  return id;
}

function loadHistory() {
  try {
    const raw = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
    return Array.isArray(raw) ? raw.filter((a) => typeof a === 'string').slice(0, HISTORY_MAX) : [];
  } catch {
    return [];
  }
}

function saveHistory() {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(state.history.slice(0, HISTORY_MAX)));
  } catch { /* storage may be unavailable - non-fatal */ }
}

function rememberAddress(address) {
  state.history = [address, ...state.history.filter((a) => a !== address)].slice(0, HISTORY_MAX);
  saveHistory();
  renderHistory();
}

function forgetAddress(address) {
  state.history = state.history.filter((a) => a !== address);
  saveHistory();
  renderHistory();
}

function setStatus(text, kind = '') {
  el.status.textContent = text || '';
  el.status.className = `status${kind ? ` ${kind}` : ''}`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

function formatTime(ts) {
  return new Date(Number(ts) || Date.now()).toLocaleString();
}

function relativeTime(ts) {
  const diff = Date.now() - Number(ts);
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return formatTime(ts);
}

function splitAddress(address) {
  const at = String(address).indexOf('@');
  return at < 0
    ? { local: address, domain: '' }
    : { local: address.slice(0, at), domain: address.slice(at + 1) };
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

/* ---------------------------------------------------------------- init */
function providerById(id) {
  return state.providers.find((provider) => provider.id === id) || null;
}

function selectedProviderId() {
  const value = el.domainSelect.value || '';
  const index = value.indexOf(':');
  return index < 0 ? '' : value.slice(0, index);
}

function providerLabel(id) {
  return providerById(id)?.label || id || 'provider';
}

function providerCapabilities(id) {
  return providerById(id)?.capabilities || {};
}

function providerTag(id) {
  if (!id || id === 'selfhosted') return '';
  return `<span class="provider-tag">${escapeHtml(providerLabel(id))}</span>`;
}

async function init() {
  try {
    const cfg = await api('/api/config');
    state.domains = cfg.domains || [];
    state.ttlMinutes = cfg.ttlMinutes || 30;
    state.maxMailboxLifetimeMinutes = cfg.maxMailboxLifetimeMinutes || state.ttlMinutes * 4;
    state.maxMailboxes = cfg.maxMailboxesPerSession || 5;
    state.pollIntervalMs = cfg.pollIntervalMs || 8000;
  } catch (err) {
    setStatus(`Could not load config: ${err.message}`, 'error');
  }

  try {
    const data = await api('/api/domains');
    state.providers = Array.isArray(data.providers) ? data.providers : [];
  } catch (err) {
    // Backwards-compatible fallback: treat the flat list as self-hosted.
    state.providers = state.domains.length
      ? [{
        id: 'selfhosted',
        label: 'Self-hosted mail',
        description: '',
        domains: state.domains,
        capabilities: {
          supportsDomainChoice: true,
          supportsCustomLocalPart: true,
          supportsExtend: true,
          retentionMinutes: state.ttlMinutes,
        },
      }]
      : [];
    setStatus(`Could not load providers: ${err.message}`, 'error');
  }

  renderDomainOptions();
  await refreshMailboxes();
  connectSocket();
  setInterval(tickTtl, 1000);
  setInterval(pollFallback, state.pollIntervalMs);
  updateCreateAvailability();
}

function renderDomainOptions() {
  el.domainSelect.innerHTML = '';

  if (state.providers.length === 0) {
    const none = document.createElement('option');
    none.value = '';
    none.textContent = 'No mailbox providers enabled';
    none.disabled = true;
    el.domainSelect.appendChild(none);
    return;
  }

  for (const provider of state.providers) {
    const caps = provider.capabilities || {};
    const group = document.createElement('optgroup');
    group.label = provider.label || provider.id;

    if (provider.status && provider.status.available === false) {
      // Configured but currently unusable (quota reached, missing credentials):
      // never offer an option that cannot work.
      const unavailable = document.createElement('option');
      unavailable.value = '';
      unavailable.textContent = `${provider.label || provider.id} (temporarily unavailable)`;
      unavailable.disabled = true;
      group.appendChild(unavailable);
      el.domainSelect.appendChild(group);
      continue;
    }

    const domains = Array.isArray(provider.domains) ? provider.domains : [];
    if (caps.supportsDomainChoice !== false && domains.length > 0) {
      const random = document.createElement('option');
      random.value = `${provider.id}:`;
      random.textContent = `Random ${provider.label || 'provider'} domain`;
      group.appendChild(random);

      for (const domain of domains) {
        const option = document.createElement('option');
        option.value = `${provider.id}:${domain}`;
        option.textContent = domain;
        group.appendChild(option);
      }
    } else if (caps.supportsDomainChoice !== false) {
      // Provider supports domain choice, but the server has none configured.
      const empty = document.createElement('option');
      empty.value = `${provider.id}:`;
      empty.textContent = '(no domains configured)';
      empty.disabled = true;
      group.appendChild(empty);
    } else {
      // Domain choice is not available: do not fake a list.
      const random = document.createElement('option');
      random.value = `${provider.id}:`;
      random.textContent = `Random (${provider.label || provider.id})`;
      group.appendChild(random);
    }

    el.domainSelect.appendChild(group);
  }

  syncFormToProvider();
}

function syncFormToProvider() {
  const caps = providerCapabilities(selectedProviderId());
  const supported = caps.supportsCustomLocalPart !== false;
  el.localPartInput.disabled = !supported;
  el.localPartInput.placeholder = supported ? 'custom name (optional)' : 'custom name not supported';
  if (!supported) el.localPartInput.value = '';
}

function hasCreatableOption() {
  return state.providers.some((provider) => {
    const caps = provider.capabilities || {};
    if (provider.status && provider.status.available === false) return false;
    if (caps.supportsDomainChoice === false) return true;
    return Array.isArray(provider.domains) && provider.domains.length > 0;
  });
}

function updateCreateAvailability() {
  const full = state.mailboxes.length >= state.maxMailboxes;
  const canCreate = hasCreatableOption();
  el.newBtn.disabled = !canCreate || full;
  el.mailboxCount.textContent = `${state.mailboxes.length}/${state.maxMailboxes}`;
  if (!canCreate) {
    setStatus('No mailbox provider is available.', 'error');
  } else if (full) {
    setStatus(`Limit reached (${state.maxMailboxes} active inboxes). Delete one to create another.`);
  }
}

/* ---------------------------------------------------- mailbox lifecycle */
el.domainSelect.addEventListener('change', syncFormToProvider);

el.form.addEventListener('submit', async (event) => {
  event.preventDefault();
  el.newBtn.disabled = true;
  setStatus('Creating address...');
  try {
    const localPart = el.localPartInput.value.trim();
    const selected = el.domainSelect.value || '';
    const sep = selected.indexOf(':');
    const provider = sep < 0 ? '' : selected.slice(0, sep);
    const domain = sep < 0 ? selected : selected.slice(sep + 1);
    const payload = { provider, domain };
    if (localPart) payload.localPart = localPart;

    const mailbox = await api('/api/mailboxes', { method: 'POST', body: JSON.stringify(payload) });
    el.localPartInput.value = '';
    rememberAddress(mailbox.address);
    await refreshMailboxes();
    await selectMailbox(mailbox.address);
    setStatus(`Address ${mailbox.address} is ready.`, 'ok');
  } catch (err) {
    setStatus(err.message, 'error');
  } finally {
    updateCreateAvailability();
  }
});

async function refreshMailboxes() {
  try {
    const data = await api('/api/mailboxes');
    state.mailboxes = data.mailboxes || [];
    // Keep the history in sync: newly seen addresses are remembered.
    for (const mailbox of [...state.mailboxes].reverse()) {
      if (!state.history.includes(mailbox.address)) {
        state.history = [mailbox.address, ...state.history].slice(0, HISTORY_MAX);
      }
    }
    saveHistory();
  } catch (err) {
    state.mailboxes = [];
    setStatus(err.message, 'error');
  }
  renderMailboxes();
  renderTabs();
  renderHistory();
  updateCreateAvailability();
}

function renderTabs() {
  el.tabs.innerHTML = '';
  for (const mailbox of state.mailboxes) {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = `tab${mailbox.address === state.currentAddress ? ' active' : ''}`;
    tab.setAttribute('role', 'tab');
    tab.title = mailbox.address;
    const { local } = splitAddress(mailbox.address);
    tab.innerHTML = `
      <span class="dot"></span>
      ${providerTag(mailbox.provider)}
      <span class="local">${escapeHtml(local)}</span>
      <span class="n">${mailbox.messageCount}</span>
      <span class="x" title="Delete">✕</span>`;
    tab.addEventListener('click', (e) => {
      if (e.target.closest('.x')) return;
      selectMailbox(mailbox.address);
    });
    tab.querySelector('.x').addEventListener('click', (e) => {
      e.stopPropagation();
      deleteMailbox(mailbox.address);
    });
    el.tabs.appendChild(tab);
  }
}

function renderMailboxes() {
  el.mailboxList.innerHTML = '';
  el.sidebarHint.style.display = state.mailboxes.length ? 'none' : 'block';

  for (const mailbox of state.mailboxes) {
    const { local, domain } = splitAddress(mailbox.address);
    const li = document.createElement('li');
    li.className = `mailbox-item${mailbox.address === state.currentAddress ? ' active' : ''}`;
    li.innerHTML = `
      <span>
        <span class="local">${escapeHtml(local)}</span>
        <span class="domain">@${escapeHtml(domain)}</span>
        ${providerTag(mailbox.provider)}
      </span>
      <span class="count">${mailbox.messageCount}</span>
      <button class="icon-btn" title="Delete" aria-label="Delete">✕</button>`;
    li.addEventListener('click', (e) => {
      if (e.target.closest('.icon-btn')) return;
      selectMailbox(mailbox.address);
    });
    li.querySelector('.icon-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      deleteMailbox(mailbox.address);
    });
    el.mailboxList.appendChild(li);
  }
}

function renderHistory() {
  el.historyList.innerHTML = '';
  el.historyHint.style.display = state.history.length ? 'none' : 'block';

  for (const address of state.history) {
    const mailbox = state.mailboxes.find((m) => m.address === address);
    const active = Boolean(mailbox);
    const { local, domain } = splitAddress(address);
    const li = document.createElement('li');
    li.className = `history-item${address === state.currentAddress ? ' active' : ''}${active ? '' : ' stale'}`;
    li.innerHTML = `
      <span>
        <span class="local">${escapeHtml(local)}</span>
        <span class="domain">@${escapeHtml(domain)}</span>
        ${providerTag(mailbox?.provider)}
      </span>
      ${active ? '' : '<span class="tag">expired</span>'}
      <button class="icon-btn" title="Forget" aria-label="Forget">✕</button>`;
    li.addEventListener('click', (e) => {
      if (e.target.closest('.icon-btn')) return;
      if (active) selectMailbox(address);
      else setStatus('That address has expired - create a new one.', 'error');
    });
    li.querySelector('.icon-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      forgetAddress(address);
    });
    el.historyList.appendChild(li);
  }
}

async function deleteMailbox(address) {
  if (!confirm(`Delete ${address}?`)) return;
  try {
    await api(`/api/mailboxes/${encodeURIComponent(address)}`, { method: 'DELETE' });
    if (state.currentAddress === address) {
      state.currentAddress = null;
      state.messages = [];
      el.currentAddress.textContent = 'No address selected';
      renderMessages();
      renderMessageView(null);
      renderProviderNotice(null);
      tickTtl();
    }
    await refreshMailboxes();
    setStatus(`Deleted ${address}.`);
  } catch (err) {
    setStatus(err.message, 'error');
  }
}

function renderProviderNotice(mailbox) {
  if (!mailbox || !mailbox.provider || mailbox.provider === 'selfhosted') {
    el.providerNotice.hidden = true;
    el.providerNotice.textContent = '';
    return;
  }

  const provider = providerById(mailbox.provider);
  const caps = provider?.capabilities || {};
  const retention = caps.retentionMinutes || 60;

  let detail;
  if (mailbox.provider === 'resend') {
    detail = `Mail is delivered to this app by Resend, a third-party service, and is kept only
      for this mailbox's lifetime (about ${escapeHtml(retention)} minutes). This inbox is
      receive-only: you cannot send, reply or forward from it.`;
  } else {
    detail = `Third-party inbox. Mail is kept for about ${escapeHtml(retention)} minutes, is not
      operated by this app and is not under its control.`;
  }

  el.providerNotice.hidden = false;
  el.providerNotice.innerHTML = `
    <strong>${escapeHtml(provider?.label || mailbox.provider)}</strong>
    <span>${detail}</span>`;
}

async function selectMailbox(address) {
  state.currentAddress = address;
  state.currentMessageId = null;
  const mailbox = state.mailboxes.find((m) => m.address === address);
  el.currentAddress.textContent = address;
  el.copyBtn.disabled = false;
  el.qrBtn.disabled = false;
  renderProviderNotice(mailbox || null);
  renderMailboxes();
  renderTabs();
  renderHistory();
  renderMessageView(null);
  tickTtl();
  await loadMessages();
}

/* -------------------------------------------------------------- messages */
async function loadMessages() {
  if (!state.currentAddress) return;
  try {
    const data = await api(`/api/mailboxes/${encodeURIComponent(state.currentAddress)}/messages`);
    state.messages = data.messages || [];
    renderMessages();
  } catch (err) {
    setStatus(err.message, 'error');
  }
}

function renderMessages() {
  el.messageList.innerHTML = '';
  if (!state.currentAddress) {
    el.messageList.innerHTML = '<li class="empty">Select or create an address.</li>';
    return;
  }
  if (state.messages.length === 0) {
    el.messageList.innerHTML = '<li class="empty">Waiting for mail...</li>';
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
    setStatus(err.message, 'error');
  }
}

function renderMessageView(msg) {
  if (!msg) {
    el.messageView.hidden = true;
    el.messageView.innerHTML = '';
    return;
  }
  el.messageView.hidden = false;

  const mailbox = state.mailboxes.find((m) => m.address === state.currentAddress);
  const canDownload = providerCapabilities(mailbox?.provider).supportsAttachments !== false;
  const attachments = msg.attachments || [];
  const attachmentHtml = attachments.length
    ? `<div class="attachments"><strong>Attachments:</strong><ul>${attachments
        .map((a) => {
          const suffix = `(${escapeHtml(a.contentType)}, ${a.size} B)`;
          return canDownload
            ? `<li><a href="/api/mailboxes/${encodeURIComponent(state.currentAddress)}/messages/${msg.id}/attachments/${a.index}">${escapeHtml(a.filename)}</a> ${suffix}</li>`
            : `<li>${escapeHtml(a.filename)} ${suffix} <span class="tag">metadata only</span></li>`;
        })
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
        iframe.style.height = `${Math.min(iframe.contentDocument.body.scrollHeight + 40, 900)}px`;
      } catch { /* sandboxed - ignore */ }
    });
    host.appendChild(iframe);
  } else {
    const pre = document.createElement('pre');
    pre.textContent = msg.text || '(empty message)';
    host.appendChild(pre);
  }
}

/* ---------------------------------------------------------- extend / QR */
el.extendBtn.addEventListener('click', async () => {
  if (!state.currentAddress) return;
  el.extendBtn.disabled = true;
  try {
    const data = await api(`/api/mailboxes/${encodeURIComponent(state.currentAddress)}/extend`, {
      method: 'POST',
    });
    const idx = state.mailboxes.findIndex((m) => m.address === data.mailbox.address);
    if (idx >= 0) state.mailboxes[idx] = data.mailbox;
    tickTtl();
    setStatus(`Extended. Now expires in ${state.ttlMinutes} minute(s).`, 'ok');
  } catch (err) {
    setStatus(err.message, 'error');
  } finally {
    updateExtendAvailability();
  }
});

function updateExtendAvailability() {
  const mailbox = state.mailboxes.find((m) => m.address === state.currentAddress);
  if (!mailbox) {
    el.extendBtn.disabled = true;
    return;
  }

  const caps = providerCapabilities(mailbox.provider);
  if (caps.supportsExtend === false) {
    el.extendBtn.disabled = true;
    el.extendBtn.title = `${providerLabel(mailbox.provider)} inboxes cannot be extended`;
    return;
  }

  const hardCap = mailbox.createdAt + state.maxMailboxLifetimeMinutes * 60000;
  el.extendBtn.disabled = mailbox.expiresAt >= hardCap - 1000;
  el.extendBtn.title = el.extendBtn.disabled
    ? 'Maximum lifetime reached'
    : 'Extend by one TTL period';
}

el.qrBtn.addEventListener('click', async () => {
  if (!state.currentAddress) return;
  setStatus('Generating QR code...');
  try {
    const data = await api(`/api/mailboxes/${encodeURIComponent(state.currentAddress)}/qr`);
    el.qrImage.src = data.dataUrl;
    el.qrAddress.textContent = data.address;
    el.qrModal.hidden = false;
    setStatus('');
  } catch (err) {
    setStatus(err.message, 'error');
  }
});

function closeQrModal() {
  el.qrModal.hidden = true;
  el.qrImage.removeAttribute('src');
}
el.qrClose.addEventListener('click', closeQrModal);
el.qrModal.addEventListener('click', (e) => {
  if (e.target === el.qrModal) closeQrModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !el.qrModal.hidden) closeQrModal();
});

/* --------------------------------------------------------- live updates */
function connectSocket() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const socket = new WebSocket(`${proto}://${location.host}/ws?sessionId=${encodeURIComponent(state.sessionId)}`);
  state.socket = socket;

  socket.addEventListener('open', () => {
    state.socketRetry = 0;
  });

  socket.addEventListener('message', (event) => {
    let payload;
    try { payload = JSON.parse(event.data); } catch { return; }

    if (payload.type === 'message') {
      if (payload.address === state.currentAddress) {
        state.messages.unshift(payload.message);
        renderMessages();
        setStatus('New message received.', 'ok');
      }
      const mailbox = state.mailboxes.find((m) => m.address === payload.address);
      if (mailbox) {
        mailbox.messageCount += 1;
        renderMailboxes();
        renderTabs();
      }
    } else if (payload.type === 'extended') {
      const mailbox = state.mailboxes.find((m) => m.address === payload.address);
      if (mailbox) mailbox.expiresAt = payload.expiresAt;
      tickTtl();
    } else if (payload.type === 'expired') {
      state.mailboxes = state.mailboxes.filter((m) => m.address !== payload.address);
      if (state.currentAddress === payload.address) {
        state.currentAddress = null;
        state.messages = [];
        el.currentAddress.textContent = 'Address expired';
        el.copyBtn.disabled = true;
        el.qrBtn.disabled = true;
        renderMessages();
        renderMessageView(null);
        renderProviderNotice(null);
        setStatus('This address expired and was cleaned up.', 'error');
      }
      renderMailboxes();
      renderTabs();
      renderHistory();
      updateCreateAvailability();
      tickTtl();
    }
  });

  socket.addEventListener('close', () => {
    state.socket = null;
    state.socketRetry = Math.min(state.socketRetry + 1, 6);
    setTimeout(connectSocket, Math.min(3000 * state.socketRetry, 15000));
  });
}

function pollFallback() {
  if (state.socket && state.socket.readyState === WebSocket.OPEN) return;
  if (state.currentAddress) loadMessages();
}

/* ------------------------------------------------------------- misc UI */
el.copyBtn.addEventListener('click', async () => {
  if (!state.currentAddress) return;
  try {
    await navigator.clipboard.writeText(state.currentAddress);
    setStatus('Address copied to clipboard.', 'ok');
  } catch {
    setStatus('Copy failed - select the address manually.', 'error');
  }
});

function tickTtl() {
  const mailbox = state.mailboxes.find((m) => m.address === state.currentAddress);
  if (!mailbox) {
    el.ttl.textContent = '';
    updateExtendAvailability();
    return;
  }
  const remaining = mailbox.expiresAt - Date.now();
  if (remaining <= 0) {
    el.ttl.textContent = 'expiring...';
    el.ttl.classList.add('warn');
  } else {
    const mins = Math.floor(remaining / 60000);
    const secs = Math.floor((remaining % 60000) / 1000);
    el.ttl.textContent = `expires in ${mins}m ${String(secs).padStart(2, '0')}s`;
    el.ttl.classList.toggle('warn', remaining < 60000);
  }
  updateExtendAvailability();
}

init();
