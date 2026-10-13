// "Оповещения" tab (/ceo/notifications) — какие клиенты какими каналами
// напоминаний пользуются: каждая Web Push-подписка (устройство) и каждый
// Telegram-чат, подписанный на напоминания, с датами подключения и последней
// фактической отправки. Owner-only, как остальные /ceo/* (requireCeoAuth).
// Данные: GET /api/ceo/notifications (подписки сыро, без имён проектов) +
// GET /api/projects (staff список optionId → label, тот же борд) — сопоставляем
// тут, чтобы не тащить имена в источник (одно использование на странице).

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

let push = [];
let tg = [];
let projects = []; // [{ id, label }]
let filterProjectId = '';

function projectLabel(projectId) {
  const p = projects.find((x) => x.id === projectId);
  return p ? p.label : (projectId || '—');
}

function channelPill(channel) {
  return channel === 'push'
    ? '<span class="notify-channel-pill push">🔔 Push</span>'
    : '<span class="notify-channel-pill tg">✈️ Telegram</span>';
}

// User agent → краткий читаемый «что за устройство/браузер» (обычно там
// длинная строка, в таблице это шум). Достаём название браузера + платформу.
function shortUserAgent(agent) {
  const s = String(agent || '');
  if (!s) return '—';
  const name = (s.match(/Firefox\/\S+/) || s.match(/Chrome\/\S+/) || s.match(/Safari\/\S+/) || s.match(/Edg\/\S+/)) || [];
  const word = name[0] ? name[0].split('/')[0] : '';
  const platform = s.match(/\(([^)]+)\)/);
  const plat = platform ? platform[1].split(';')[0].trim() : '';
  const got = [word, plat].filter(Boolean).join(' · ');
  return got || s.slice(0, 40);
}

// Короткий «есть ли признаки жизни» по lastSentAt: уведомления реально
// доставлялись недавно / вообще / никогда.
function pushLifeLabel(r) {
  if (!r.lastSentAt) return '<span class="muted">ни разу не отправлено</span>';
  const days = (Date.now() - new Date(r.lastSentAt).getTime()) / 86400000;
  if (days < 14) return `<span class="live">активно (${msk(r.lastSentAt)})</span>`;
  if (days < 60) return `<span class="warn">недавно (${msk(r.lastSentAt)})</span>`;
  return `<span class="muted">давно (${msk(r.lastSentAt)})</span>`;
}

function render() {
  const filteredPush = filterProjectId ? push.filter((r) => r.projectId === filterProjectId) : push;
  const filteredTg = filterProjectId ? tg.filter((r) => r.projectId === filterProjectId) : tg;
  const all = [...filteredPush.map((r) => ({ ...r })), ...filteredTg.map((r) => ({ ...r }))]
    .sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt));

  const pushCount = filteredPush.length;
  const tgCount = filteredTg.length;

  const filterSelect = `<select id="notifyProjectFilter" class="stat-filter-select">
    <option value="">Все проекты</option>
    ${projects.map((p) => `<option value="${esc(p.id)}"${filterProjectId === p.id ? ' selected' : ''}>${esc(p.label)}</option>`).join('')}
  </select>`;

  const rowsHtml = all.length
    ? all.map((r) => r.channel === 'push'
        ? `<tr>
            <td>${channelPill('push')}</td>
            <td>${esc(projectLabel(r.projectId))}</td>
            <td><div class="endpoint-cell">${esc(r.endpoint.replace(/^https?:\/\//, '').slice(0, 60))}</div><div class="muted" style="font-size:10.5px;margin-top:2px">${esc(shortUserAgent(r.userAgent))}</div></td>
            <td>${msk(r.createdAt)}</td>
            <td>${pushLifeLabel(r)}</td>
          </tr>`
        : `<tr>
            <td>${channelPill('tg')}</td>
            <td>${esc(projectLabel(r.projectId))}</td>
            <td><div class="endpoint-cell">@chat ${esc(r.chatId)}</div></td>
            <td>${msk(r.createdAt)}</td>
            <td>${msk(r.updatedAt)}</td>
          </tr>`).join('')
    : '';

  const table = all.length
    ? `<table class="stat-table"><thead><tr><th>Канал</th><th>Проект</th><th>Подписчик</th><th>Подключён</th><th>Последняя активность</th></tr></thead><tbody>${rowsHtml}</tbody></table>`
    : '<div class="muted">Пока никто не подписан на напоминания. Клиенты подключают телефон (Web Push) или Telegram-напоминания прямо из кабинета /l/{токен}.</div>';

  root.innerHTML = `
    <div class="stat-cards">
      <div class="stat-card"><div class="stat-card-num">${pushCount}</div><div class="stat-card-label">устройств на Web Push</div></div>
      <div class="stat-card"><div class="stat-card-num">${tgCount}</div><div class="stat-card-label">чатов в Telegram</div></div>
      <div class="stat-card"><div class="stat-card-num">${all.length}</div><div class="stat-card-label">всего подписок</div></div>
    </div>
    <div class="stat-filters-row">${filterSelect}</div>
    <section class="stat-section"><h2>Подписки на оповещения</h2>${table}</section>
  `;

  document.getElementById('notifyProjectFilter').addEventListener('change', (e) => {
    filterProjectId = e.target.value;
    render();
  });
}

async function load() {
  try {
    const res = await fetch('/api/ceo/notifications');
    if (res.status === 401) {
      errorBox.innerHTML = 'Доступ только владельцу. Войдите в <a href="/team">кабинет команды</a> под своим Mattermost-аккаунтом и обновите страницу.';
      errorBox.hidden = false;
      loading.hidden = true;
      return;
    }
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || 'Ошибка загрузки');
    push = data.push || [];
    tg = data.tg || [];
    // Имена проектов — с того же борда (GET /api/projects), чтобы показывать
    // label вместо сырого option id. Если не загрузилось (например, борд
    // недоступен) — используем id как есть, таблица всё равно полезная.
    try {
      const projRes = await fetch('/api/projects');
      if (projRes.ok) {
        const projData = await projRes.json();
        projects = (projData.options || []).map((o) => ({ id: o.id, label: o.label }));
      }
    } catch (_) {
      projects = [];
    }
    loading.hidden = true;
    root.hidden = false;
    render();
  } catch (err) {
    loading.hidden = true;
    errorBox.textContent = 'Не удалось загрузить данные: ' + err.message;
    errorBox.hidden = false;
  }
}

load();