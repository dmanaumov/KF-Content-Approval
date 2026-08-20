// Team cabinet — phase 1: Mattermost login + read-only "my tasks" list
// (filtered server-side by the "Исполнитель" property, see
// backend/src/index.js's GET /api/team/tasks). Editing (date/status/text),
// post creation, media upload, and comments are later phases — this file
// intentionally only renders what's already real.

const STATUS_LABELS = { waiting: 'На согласовании', approved: 'Согласовано', changes: 'Правки', published: 'Опубликовано' };
const STATUS_CLASS = { waiting: 'waiting', approved: 'approved', changes: 'changes', published: 'published' };

// Статусы, где нужны действия ответственного — подсвечиваются (чипы и бейджи
// тёплым цветом); остальные (НА СОГЛАСОВАНИИ, СДАЛИ, ЗАПЛАНИРОВАНО и т.п.)
// показываются серым.
const ACTIVE_STATUSES = ['В ПРОЦЕССЕ', 'КОРРЕКТИРОВКА'];
const GRAY_STATUSES = ['НА СОГЛАСОВАНИИ', 'СДАЛИ', 'ЗАПЛАНИРОВАНО'];
const PREFERRED_STATUS_ORDER = [...ACTIVE_STATUSES, ...GRAY_STATUSES];

const norm = (s) => String(s || '').trim().toLowerCase();

let currentTasks = [];
let activeStatuses = null;
const FILTERS_KEY = 'kf.team.filters.v1';

function saveFilters() {
  try { localStorage.setItem(FILTERS_KEY, JSON.stringify(activeStatuses ? [...activeStatuses] : [])); } catch (e) {}
}

// По умолчанию все статусы включены; выбранное пользователем запоминается и
// восстанавливается после перезагрузки страницы. Новые статусы (которых ещё
// не было при сохранении) включаются по умолчанию.
function loadSavedFilters(allStatuses) {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(FILTERS_KEY) || 'null'); } catch (e) {}
  if (Array.isArray(saved) && saved.length) {
    return new Set(allStatuses.filter((s) => saved.includes(s)));
  }
  return new Set(allStatuses);
}

function esc(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 3200);
}

const loginApp = document.getElementById('loginApp');
const teamApp = document.getElementById('teamApp');
const loginLogin = document.getElementById('loginLogin');
const loginPassword = document.getElementById('loginPassword');
const loginSubmit = document.getElementById('loginSubmit');
const loginError = document.getElementById('loginError');
const teamUserName = document.getElementById('teamUserName');
const teamLoading = document.getElementById('teamLoading');
const teamEmpty = document.getElementById('teamEmpty');
const teamList = document.getElementById('teamList');
const teamFilters = document.getElementById('teamFilters');
const taskModal = document.getElementById('taskModal');
const tmTitle = document.getElementById('tmTitle');

function showLogin() {
  loginApp.hidden = false;
  teamApp.hidden = true;
}

function showApp(user) {
  loginApp.hidden = true;
  teamApp.hidden = false;
  teamUserName.textContent = [user.firstName, user.lastName].filter(Boolean).join(' ') || user.username || 'Команда';
}

async function login() {
  const login = loginLogin.value.trim();
  const password = loginPassword.value;
  loginError.hidden = true;
  if (!login || !password) {
    loginError.textContent = 'Введите логин и пароль.';
    loginError.hidden = false;
    return;
  }
  loginSubmit.disabled = true;
  const originalText = loginSubmit.textContent;
  loginSubmit.textContent = 'Входим…';
  try {
    const res = await fetch('/api/team/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ login, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || 'Не удалось войти');
    loginPassword.value = '';
    showApp(data.user);
    loadTasks();
  } catch (err) {
    loginError.textContent = err.message;
    loginError.hidden = false;
  } finally {
    loginSubmit.disabled = false;
    loginSubmit.textContent = originalText;
  }
}

async function logout() {
  try {
    await fetch('/api/team/logout', { method: 'POST' });
  } catch (err) {
    // best-effort — clearing the local view matters more than the network call
  }
  showLogin();
}

function daysUntil(publishDate) {
  const m = String(publishDate || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const target = new Date(+m[1], +m[2] - 1, +m[3]);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((target - today) / 86400000);
}

// "Горит" — задача, требующая действий ответственного (В ПРОЦЕССЕ /
// КОРРЕКТИРОВКА), с дедлайном на 3 дня ближе или уже просроченным — по
// аналогии с "горящими согласованиями" в кабинете клиента.
function isUrgentTask(task) {
  if (!task.publishDate) return false;
  if (!ACTIVE_STATUSES.some((s) => norm(s) === norm(task.statusLabel))) return false;
  const d = daysUntil(task.publishDate);
  return d !== null && d < 3;
}

// Самые срочные сверху — по мере приближения дедлайна (ближайшая дата первая,
// задачи без даты — в конец).
function byDeadline(a, b) {
  if (!a.publishDate) return b.publishDate ? 1 : 0;
  if (!b.publishDate) return -1;
  return a.publishDate.localeCompare(b.publishDate);
}

function statusBadgeHtml(task) {
  const label = (task.statusLabel || '').trim();
  if (!label) return '';
  if (ACTIVE_STATUSES.some((s) => norm(s) === norm(label))) {
    return `<span class="status active">${esc(label)}</span>`;
  }
  if (GRAY_STATUSES.some((s) => norm(s) === norm(label))) {
    return `<span class="status internal">${esc(label)}</span>`;
  }
  if (task.status && STATUS_LABELS[task.status]) {
    return `<span class="status ${STATUS_CLASS[task.status]}">${STATUS_LABELS[task.status]}</span>`;
  }
  return task.statusLabel ? `<span class="status internal">${esc(task.statusLabel)}</span>` : '';
}

function taskRowHtml(task) {
  const urgent = isUrgentTask(task);
  const dateBadge = task.publishDate
    ? `<div class="team-task-date">${esc(task.publishDate.split('-').reverse().join('.'))}</div>`
    : '';
  const urgentBadge = urgent ? '<span class="status urgent">🔥 ГОРИТ!</span>' : '';
  return `<div class="team-task${urgent ? ' urgent' : ''}" data-task-id="${esc(task.id)}">
    <div class="team-task-top">
      <div>
        ${task.projectLabel ? `<div class="team-task-project">${esc(task.projectLabel)}</div>` : ''}
        <div class="team-task-title">${esc(task.title)}</div>
      </div>
    </div>
    <div class="team-task-bottom">
      <div class="team-task-meta">
        <div class="team-task-status">${statusBadgeHtml(task)}${urgentBadge}</div>
        ${dateBadge}
      </div>
    </div>
  </div>`;
}

function renderChips() {
  const seen = [];
  currentTasks.forEach((t) => {
    const s = (t.statusLabel || '').trim();
    if (s && !seen.includes(s)) seen.push(s);
  });
  if (!seen.length) {
    teamFilters.hidden = true;
    activeStatuses = null;
    return;
  }
  seen.sort((a, b) => {
    const ia = PREFERRED_STATUS_ORDER.indexOf(a);
    const ib = PREFERRED_STATUS_ORDER.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });
  activeStatuses = loadSavedFilters(seen.map(norm));
  teamFilters.hidden = false;
  teamFilters.innerHTML = seen
    .map((s) => {
      const need = ACTIVE_STATUSES.some((x) => norm(x) === norm(s));
      return `<button type="button" class="chip ${need ? 'need' : 'wait'} active" data-status="${esc(s)}">${esc(s)}</button>`;
    })
    .join('');
}

function renderTasks() {
  const visible = activeStatuses
    ? currentTasks.filter((t) => activeStatuses.has(norm(t.statusLabel)))
    : currentTasks;
  if (!visible.length) {
    teamEmpty.textContent = currentTasks.length ? 'Нет задач с выбранными статусами.' : 'На вас пока нет ни одной задачи.';
    teamEmpty.hidden = false;
    teamList.innerHTML = '';
    return;
  }
  teamEmpty.hidden = true;
  teamList.innerHTML = visible.map(taskRowHtml).join('');
}

async function loadTasks() {
  teamLoading.hidden = false;
  teamEmpty.hidden = true;
  teamList.innerHTML = '';
  try {
    const res = await fetch('/api/team/tasks');
    if (res.status === 401) {
      showLogin();
      return;
    }
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || 'Не удалось загрузить задачи');
    teamLoading.hidden = true;
    currentTasks = (data.tasks || []).slice().sort(byDeadline);
    renderChips();
    renderTasks();
  } catch (err) {
    teamLoading.hidden = true;
    toast('Не удалось загрузить задачи: ' + err.message);
  }
}

async function init() {
  try {
    const res = await fetch('/api/team/me');
    if (!res.ok) {
      showLogin();
      return;
    }
    const data = await res.json();
    showApp(data.user);
    loadTasks();
  } catch (err) {
    showLogin();
  }
}

loginSubmit.addEventListener('click', login);
[loginLogin, loginPassword].forEach((el) => el.addEventListener('keydown', (e) => { if (e.key === 'Enter') login(); }));
document.getElementById('logoutBtn').addEventListener('click', logout);

teamFilters.addEventListener('click', (e) => {
  const btn = e.target.closest('.chip');
  if (!btn || !activeStatuses) return;
  const key = norm(btn.dataset.status);
  if (activeStatuses.has(key)) activeStatuses.delete(key);
  else activeStatuses.add(key);
  btn.classList.toggle('active');
  saveFilters();
  renderTasks();
});

teamList.addEventListener('click', (e) => {
  const row = e.target.closest('.team-task');
  if (!row) return;
  const t = currentTasks.find((x) => x.id === row.dataset.taskId);
  if (!t) return;
  tmTitle.textContent = t.title || '(без названия)';
  taskModal.hidden = false;
});

taskModal.addEventListener('click', (e) => {
  if (e.target.closest('#tmClose') || !e.target.closest('.tm-card')) taskModal.hidden = true;
});

init();