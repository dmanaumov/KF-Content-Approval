// "Переписка" tab (/ceo/bot-leads) — private chats with the bot (potential
// leads): who wrote, full thread, reply from the bot's name. Reply does NOT
// go out immediately — it's queued (status 'pending') and n8n actually
// delivers it via Telegram, see docs/N8N_AUTOMATION.md. Owner-only.

const loading = document.getElementById('loading');
const errorBox = document.getElementById('errorBox');
const root = document.getElementById('root');
const leadsListEl = document.getElementById('leadsList');
const threadEl = document.getElementById('thread');
const toast = document.getElementById('toast');

let leads = [];
let selectedChatId = null;

function esc(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function msk(iso) {
  if (!iso) return '';
  return new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
}

function showToast(text) {
  toast.textContent = text;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2400);
}

function renderLeadsList() {
  if (!leads.length) {
    leadsListEl.innerHTML = '<div class="leads-list-empty">Пока никто не писал боту.</div>';
    return;
  }
  leadsListEl.innerHTML = leads
    .map((l) => {
      const dirCls = l.lastDirection === 'in' ? 'in' : 'out';
      const dirMark = l.lastDirection === 'in' ? '←' : l.lastDirection === 'out' ? '→' : '';
      const rowCls = ['lead-row', l.awaitingReply ? 'awaiting' : '', l.chatId === selectedChatId ? 'selected' : ''].filter(Boolean).join(' ');
      return `<button type="button" class="${rowCls}" data-chat="${esc(l.chatId)}">
        <div class="lead-row-top">
          <span class="lead-name">${esc(l.title || l.chatId)}</span>
          <span class="lead-time">${esc(msk(l.lastAt))}</span>
        </div>
        <div class="lead-preview"><span class="dir ${dirCls}">${dirMark}</span><span>${esc((l.lastText || '').slice(0, 80)) || '—'}</span>${l.awaitingReply ? '<span class="lead-await-dot" title="Ждёт ответа"></span>' : ''}</div>
      </button>`;
    })
    .join('');
  leadsListEl.querySelectorAll('.lead-row').forEach((btn) => {
    btn.addEventListener('click', () => selectLead(btn.getAttribute('data-chat')));
  });
}

async function loadLeads({ keepSelection = true } = {}) {
  const res = await fetch('/api/ceo/telegram/leads');
  if (res.status === 401) {
    errorBox.innerHTML = 'Доступ только владельцу. Войдите в <a href="/team">кабинет команды</a> под своим Mattermost-аккаунтом и обновите страницу.';
    errorBox.hidden = false;
    loading.hidden = true;
    return;
  }
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || 'Ошибка загрузки');
  leads = data.leads || [];
  if (!keepSelection || (selectedChatId && !leads.some((l) => l.chatId === selectedChatId))) {
    selectedChatId = leads[0] ? leads[0].chatId : null;
  }
  renderLeadsList();
}

function msgBubble(m) {
  const mine = m.direction === 'out';
  const statusCls = mine ? ` ${m.status}` : '';
  let meta = msk(m.created_at);
  if (mine) {
    meta += m.status === 'pending' ? ' · отправляется…' : m.status === 'failed' ? '' : ' · доставлено';
  } else {
    meta = [m.from_name || m.from_username, meta].filter(Boolean).join(' · ');
  }
  const err = mine && m.status === 'failed' && m.error ? `<div class="err">Ошибка отправки: ${esc(m.error)}</div>` : '';
  return `<div class="lead-msg${mine ? ' out' : ''}${statusCls}">
    <div class="lead-msg-text">${esc(m.text)}</div>
    <div class="lead-msg-meta">${esc(meta)}${err}</div>
  </div>`;
}

function renderThread(chatId, lead, messages) {
  const msgsHtml = messages.length
    ? messages.map(msgBubble).join('')
    : '<div class="muted" style="padding:20px;text-align:center">Сообщений пока нет.</div>';
  threadEl.innerHTML = `
    <div class="lead-thread-head">
      <div>
        <div class="lead-thread-title">${esc((lead && lead.title) || chatId)}</div>
        <div class="lead-thread-sub">chat_id: ${esc(chatId)}</div>
      </div>
    </div>
    <div class="lead-msgs" id="leadMsgs">${msgsHtml}</div>
    <div class="lead-compose">
      <textarea id="composeText" placeholder="Ответить от имени бота…" rows="1"></textarea>
      <button type="button" class="lead-send-btn" id="sendBtn" title="Отправить">➤</button>
    </div>
    <div class="lead-compose-hint">Сообщение уходит не мгновенно — становится в очередь, и его реально доставляет n8n через Telegram.</div>
  `;
  const msgsBox = document.getElementById('leadMsgs');
  msgsBox.scrollTop = msgsBox.scrollHeight;
  const textarea = document.getElementById('composeText');
  const sendBtn = document.getElementById('sendBtn');
  const send = () => sendReply(chatId, textarea, sendBtn);
  sendBtn.addEventListener('click', send);
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
  textarea.focus();
}

async function sendReply(chatId, textarea, sendBtn) {
  const text = textarea.value.trim();
  if (!text) return;
  textarea.disabled = true;
  sendBtn.disabled = true;
  try {
    const res = await fetch(`/api/ceo/telegram/leads/${encodeURIComponent(chatId)}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || 'Не удалось отправить');
    textarea.value = '';
    showToast('Поставлено в очередь на отправку');
    await selectLead(chatId, { silent: true });
    await loadLeads();
  } catch (err) {
    showToast('Ошибка: ' + err.message);
  } finally {
    textarea.disabled = false;
    sendBtn.disabled = false;
    textarea.focus();
  }
}

async function selectLead(chatId, { silent = false } = {}) {
  selectedChatId = chatId;
  if (!silent) renderLeadsList();
  const lead = leads.find((l) => l.chatId === chatId);
  try {
    const res = await fetch(`/api/ceo/telegram/leads/${encodeURIComponent(chatId)}/messages`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || 'Ошибка загрузки переписки');
    renderThread(chatId, lead, data.messages || []);
  } catch (err) {
    threadEl.innerHTML = `<div class="lead-thread-empty">Не удалось загрузить переписку: ${esc(err.message)}</div>`;
  }
}

async function init() {
  try {
    await loadLeads({ keepSelection: false });
    loading.hidden = true;
    root.hidden = false;
    if (selectedChatId) await selectLead(selectedChatId);
  } catch (err) {
    loading.hidden = true;
    errorBox.textContent = 'Не удалось загрузить данные: ' + err.message;
    errorBox.hidden = false;
    return;
  }
  // Лёгкий фоновый опрос списка (не треда) — чтобы нашлёпка "ждёт ответа" не
  // протухала, пока страница открыта, без ручного обновления. Не трогает
  // выбранный тред, чтобы не сбивать набор текста в compose-поле.
  setInterval(() => { loadLeads().catch(() => {}); }, 60000);
}

init();
