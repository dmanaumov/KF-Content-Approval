// "Бот" tab (/ceo/bot-chats) — every group/channel the bot is a member of,
// fed by n8n's my_chat_member handler (POST /api/bot/channels). Owner-only,
// same requireCeoAuth gate as the rest of /ceo/* — see index.js.

const loading = document.getElementById('loading');
const errorBox = document.getElementById('errorBox');
const root = document.getElementById('root');

function esc(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function msk(iso) {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
}

const CHAT_TYPE_LABELS = { group: 'группа', supergroup: 'группа', channel: 'канал', private: 'личка' };
// Everything except a genuine "still a member" status reads as "gone" —
// covers left/kicked and any other raw Mattermost/Telegram status text we
// haven't special-cased, rather than silently mis-labeling it as active.
const ACTIVE_STATUSES = new Set(['member', 'administrator', 'creator', 'restricted']);

function statusPill(status) {
  const active = ACTIVE_STATUSES.has(status);
  const label = active ? (status === 'administrator' ? 'админ' : status === 'creator' ? 'создатель' : 'участник') : (status || '—');
  return `<span class="bot-status-pill ${active ? 'active' : 'gone'}">${esc(label)}</span>`;
}

function addedByCell(c) {
  const name = c.added_by_name || '';
  const username = c.added_by_username ? `@${c.added_by_username}` : '';
  if (!name && !username) return '<span class="muted">—</span>';
  return `<span class="bot-added-by"><b>${esc(name || username)}</b>${name && username ? ` <span class="muted">${esc(username)}</span>` : ''}</span>`;
}

function render(chats) {
  const rowsHtml = chats.length
    ? chats.map((c) => `<tr>
        <td>${esc(c.title || c.chat_id)}<div class="muted" style="font-size:10.5px;margin-top:2px">${esc(c.chat_id)}</div></td>
        <td><span class="bot-chat-type">${esc(CHAT_TYPE_LABELS[c.chat_type] || c.chat_type || '?')}</span></td>
        <td>${statusPill(c.status)}</td>
        <td>${addedByCell(c)}</td>
        <td class="stat-nowrap">${msk(c.status_updated_at)}</td>
      </tr>`).join('')
    : '';
  const table = chats.length
    ? `<table class="stat-table"><thead><tr><th>Чат</th><th>Тип</th><th>Статус</th><th>Добавил</th><th>Когда</th></tr></thead><tbody>${rowsHtml}</tbody></table>`
    : '<div class="muted">Бот пока никуда не добавлен — или автоматизация ещё не настроена присылать сюда эти события.</div>';
  root.innerHTML = `
    <div class="stat-cards">
      <div class="stat-card"><div class="stat-card-num">${chats.filter((c) => ACTIVE_STATUSES.has(c.status)).length}</div><div class="stat-card-label">активных чатов</div></div>
      <div class="stat-card"><div class="stat-card-num">${chats.length}</div><div class="stat-card-label">всего когда-либо</div></div>
    </div>
    <section class="stat-section"><h2>Куда добавлен</h2>${table}</section>
  `;
}

async function load() {
  try {
    const res = await fetch('/api/ceo/telegram/chats');
    if (res.status === 401) {
      errorBox.innerHTML = 'Доступ только владельцу. Войдите в <a href="/team">кабинет команды</a> под своим Mattermost-аккаунтом и обновите страницу.';
      errorBox.hidden = false;
      loading.hidden = true;
      return;
    }
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || 'Ошибка загрузки');
    loading.hidden = true;
    root.hidden = false;
    render(data.chats || []);
  } catch (err) {
    loading.hidden = true;
    errorBox.textContent = 'Не удалось загрузить данные: ' + err.message;
    errorBox.hidden = false;
  }
}

load();
