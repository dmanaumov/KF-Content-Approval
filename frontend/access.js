// "Доступ" (/ceo/access) — матрица "проект × сотрудник команды", три роли:
// 'none' (нет записи — по умолчанию, нет доступа вообще), 'editor' (видит и
// правит все карточки проекта в /team), 'admin' (то же + настройки проекта
// на /projects, включая «Цербер»). См. backend/src/projectAccess.js для
// семантики и GET/PUT /api/ceo/project-access* в index.js. Owner-only,
// requireCeoAuth.
//
// UI сделан "мастер-детейл": слева — список проектов (с числом уже
// настроенных прав), справа — вся команда для выбранного проекта с
// сегментированным переключателем роли на каждого. Матрица "всё сразу" не
// взята специально — при десятке проектов и десятке людей она превращается
// в нечитаемую сетку; список + панель масштабируется куда приятнее.

const loading = document.getElementById('loading');
const errorBox = document.getElementById('errorBox');
const root = document.getElementById('root');
const projectListEl = document.getElementById('projectList');
const accessPanelEl = document.getElementById('accessPanel');
const accessStatsEl = document.getElementById('accessStats');
const projectSearchInput = document.getElementById('projectSearch');
const bootstrapBanner = document.getElementById('bootstrapBanner');
const bootstrapBtn = document.getElementById('bootstrapBtn');
const toastEl = document.getElementById('toast');

let projects = [];   // [{id, label, isArchived}]
let members = [];    // [{id, username, name}]
let accessRows = []; // [{projectId, userId, role, grantedBy, grantedAt}]
let accessMap = new Map(); // `${projectId}:${userId}` -> 'editor'|'admin'
let selectedProjectId = null;
let projectFilter = '';
let personFilter = '';

function esc(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function showToast(text) {
  toastEl.textContent = text;
  toastEl.classList.add('show');
  setTimeout(() => toastEl.classList.remove('show'), 2600);
}

const ICON_NONE = '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M4 4l16 16M20 4 4 20"></path></svg>';
const ICON_EDITOR = '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"></path></svg>';
const ICON_ADMIN = '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2 4 5v6c0 5 3.4 8.7 8 11 4.6-2.3 8-6 8-11V5z"></path></svg>';

// Небольшая, но не случайная палитра для аватарок-инициалов — на основе
// акцентов, уже используемых в приложении (--kf-green/--kf-coral/--ai/
// --spark и несколько дополнительных оттенков той же плотности), чтобы
// команда визуально не сливалась в одну кашу, но и не выглядела "рандомной".
const AVATAR_COLORS = ['#004643', '#DF6162', '#9B5AF6', '#3FA98F', '#C77D2E', '#2E6FC7', '#B23A6E', '#5A8F3E'];
function colorFor(seed) {
  let h = 0;
  const s = String(seed || '');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}
function initialsOf(name, username) {
  const base = (name && name.trim()) || username || '?';
  const parts = base.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return base.slice(0, 2).toUpperCase();
}

function rebuildAccessMap() {
  accessMap = new Map();
  for (const r of accessRows) accessMap.set(`${r.projectId}:${r.userId}`, r.role);
}

function countForProject(projectId) {
  let n = 0;
  for (const r of accessRows) if (r.projectId === projectId) n++;
  return n;
}

function renderStats() {
  accessStatsEl.textContent = `${projects.length} проектов · ${members.length} человек в команде · ${accessRows.length} назначений`;
}

function renderProjectList() {
  const q = projectFilter.trim().toLowerCase();
  const filtered = projects
    .filter((p) => !q || p.label.toLowerCase().includes(q))
    .sort((a, b) => a.label.localeCompare(b.label, 'ru'));
  if (!filtered.length) {
    projectListEl.innerHTML = '<div class="access-projects-empty">Ничего не найдено.</div>';
    return;
  }
  projectListEl.innerHTML = filtered
    .map((p) => {
      const count = countForProject(p.id);
      const active = p.id === selectedProjectId ? ' active' : '';
      return `<button type="button" class="access-project-item${active}" data-project="${esc(p.id)}">
        <span class="proj-avatar">${esc(p.label.slice(0, 2).toUpperCase())}</span>
        <span class="proj-name">${esc(p.label)}${p.isArchived ? ' <span style="opacity:.6">(архив)</span>' : ''}</span>
        <span class="proj-count${count ? ' has-access' : ''}">${count}</span>
      </button>`;
    })
    .join('');
  projectListEl.querySelectorAll('.access-project-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      selectedProjectId = btn.getAttribute('data-project');
      personFilter = '';
      renderProjectList();
      renderPanel();
    });
  });
}

function roleSwitchHtml(projectId, userId, role) {
  const opt = (val, label, icon) =>
    `<button type="button" class="opt-${val}" aria-pressed="${role === val}" data-role="${val}" data-project="${esc(projectId)}" data-user="${esc(userId)}">${icon}${label}</button>`;
  return `<div class="role-switch">
    ${opt('none', 'Нет', ICON_NONE)}
    ${opt('editor', 'Редактор', ICON_EDITOR)}
    ${opt('admin', 'Админ', ICON_ADMIN)}
  </div>`;
}

function renderPanel() {
  if (!selectedProjectId) {
    accessPanelEl.innerHTML = '<div class="access-empty">Выберите проект слева.</div>';
    return;
  }
  const project = projects.find((p) => p.id === selectedProjectId);
  if (!project) {
    selectedProjectId = null;
    renderPanel();
    return;
  }
  const q = personFilter.trim().toLowerCase();
  const filteredMembers = members
    .filter((m) => !q || (m.name || '').toLowerCase().includes(q) || (m.username || '').toLowerCase().includes(q))
    .sort((a, b) => (a.name || a.username).localeCompare(b.name || b.username, 'ru'));

  const rowsHtml = filteredMembers.length
    ? filteredMembers
        .map((m) => {
          const role = accessMap.get(`${project.id}:${m.id}`) || 'none';
          const color = colorFor(m.username || m.id);
          return `<div class="access-person-row">
            <span class="person-avatar" style="background:${color}">${esc(initialsOf(m.name, m.username))}</span>
            <span class="person-meta">
              <span class="person-name">${esc(m.name || m.username)}</span>
              <span class="person-username">@${esc(m.username)}</span>
            </span>
            ${roleSwitchHtml(project.id, m.id, role)}
          </div>`;
        })
        .join('')
    : '<div class="access-people-empty">Никого не найдено.</div>';

  accessPanelEl.innerHTML = `
    <div class="access-panel-head">
      <div class="access-panel-title">${esc(project.label)}</div>
      <div class="access-panel-actions">
        <button type="button" class="access-bulk-btn" data-bulk="editor">Выдать всем «редактор»</button>
        <button type="button" class="access-bulk-btn danger" data-bulk="none">Сбросить всех до «нет»</button>
      </div>
    </div>
    <input class="access-person-search" type="search" placeholder="Найти человека…" value="${esc(personFilter)}" id="personSearchInput">
    <div class="access-people">${rowsHtml}</div>
  `;

  const searchInput = document.getElementById('personSearchInput');
  searchInput.addEventListener('input', (e) => {
    personFilter = e.target.value;
    renderPanel();
    const el = document.getElementById('personSearchInput');
    if (el) {
      el.focus();
      const pos = el.value.length;
      el.setSelectionRange(pos, pos);
    }
  });

  accessPanelEl.querySelectorAll('.role-switch button').forEach((btn) => {
    btn.addEventListener('click', () =>
      setRole(btn.getAttribute('data-project'), btn.getAttribute('data-user'), btn.getAttribute('data-role'))
    );
  });
  accessPanelEl.querySelectorAll('[data-bulk]').forEach((btn) => {
    btn.addEventListener('click', () => bulkSet(project.id, btn.getAttribute('data-bulk')));
  });
}

async function putRole(projectId, userId, role) {
  const res = await fetch(`/api/ceo/project-access/${encodeURIComponent(projectId)}/${encodeURIComponent(userId)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || 'Ошибка сохранения');
  return data;
}

function applyLocalRole(projectId, userId, role) {
  if (role === 'none') {
    accessRows = accessRows.filter((r) => !(r.projectId === projectId && r.userId === userId));
  } else {
    const existing = accessRows.find((r) => r.projectId === projectId && r.userId === userId);
    if (existing) existing.role = role;
    else accessRows.push({ projectId, userId, role, grantedBy: '', grantedAt: new Date().toISOString() });
  }
  rebuildAccessMap();
}

// Один переключатель — сразу отражаем в UI (не дожидаясь ответа сервера),
// откатываем полной перезагрузкой данных, если запрос всё же не прошёл.
async function setRole(projectId, userId, role) {
  const prevRole = accessMap.get(`${projectId}:${userId}`) || 'none';
  if (prevRole === role) return;
  applyLocalRole(projectId, userId, role);
  renderProjectList();
  renderPanel();
  renderStats();
  try {
    await putRole(projectId, userId, role);
  } catch (err) {
    showToast('Не удалось сохранить: ' + err.message + ' — обновляю список.');
    await load({ silent: true });
  }
}

async function bulkSet(projectId, role) {
  const project = projects.find((p) => p.id === projectId);
  const changes = members
    .map((m) => ({ userId: m.id, cur: accessMap.get(`${projectId}:${m.id}`) || 'none' }))
    .filter((x) => x.cur !== role);
  if (!changes.length) {
    showToast('Менять нечего — у всех уже так.');
    return;
  }
  if (role === 'none' && !confirm(`Сбросить доступ ${changes.length} сотрудник(ов) к проекту «${project ? project.label : ''}» до «нет»?`)) {
    return;
  }
  changes.forEach(({ userId }) => applyLocalRole(projectId, userId, role));
  renderProjectList();
  renderPanel();
  renderStats();
  try {
    await Promise.all(changes.map(({ userId }) => putRole(projectId, userId, role)));
    showToast(role === 'none' ? 'Доступ сброшен.' : 'Роль «редактор» выдана всем.');
  } catch (err) {
    showToast('Часть изменений не сохранилась: ' + err.message + ' — обновляю список.');
    await load({ silent: true });
  }
}

bootstrapBtn.addEventListener('click', async () => {
  bootstrapBtn.disabled = true;
  const originalText = bootstrapBtn.textContent;
  bootstrapBtn.textContent = 'Импортирую…';
  try {
    const res = await fetch('/api/ceo/project-access/bootstrap', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || data.error || 'Ошибка импорта');
    showToast(data.inserted ? `Импортировано прав: ${data.inserted}.` : 'Новых прав не найдено — импортировать нечего.');
    await load({ silent: true });
  } catch (err) {
    showToast('Импорт не удался: ' + err.message);
  } finally {
    bootstrapBtn.disabled = false;
    bootstrapBtn.textContent = originalText;
  }
});

projectSearchInput.addEventListener('input', (e) => {
  projectFilter = e.target.value;
  renderProjectList();
});

async function load({ silent = false } = {}) {
  try {
    const res = await fetch('/api/ceo/project-access');
    if (res.status === 401) {
      errorBox.innerHTML = 'Доступ только владельцу. Войдите в <a href="/team">кабинет команды</a> под своим Mattermost-аккаунтом и обновите страницу.';
      errorBox.hidden = false;
      loading.hidden = true;
      return;
    }
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || data.error || 'Ошибка загрузки');
    projects = data.projects || [];
    members = data.members || [];
    accessRows = data.access || [];
    rebuildAccessMap();
    bootstrapBanner.hidden = accessRows.length > 0;
    if (!silent) {
      loading.hidden = true;
      root.hidden = false;
    }
    renderStats();
    renderProjectList();
    renderPanel();
  } catch (err) {
    if (!silent) {
      loading.hidden = true;
      errorBox.textContent = 'Не удалось загрузить данные: ' + err.message;
      errorBox.hidden = false;
    } else {
      showToast('Не удалось обновить: ' + err.message);
    }
  }
}

load();
