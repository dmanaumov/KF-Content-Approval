// Team cabinet — phase 1: Mattermost login + read-only "my tasks" list
// (filtered server-side by the "Ответственный" property, see
// backend/src/index.js's GET /api/team/tasks). Editing (date/status/text),
// post creation, media upload, and comments are later phases — this file
// intentionally only renders what's already real.

const STATUS_LABELS = { waiting: 'На согласовании', approved: 'Согласовано', changes: 'Правки', published: 'Опубликовано' };
const STATUS_CLASS = { waiting: 'waiting', approved: 'approved', changes: 'changes', published: 'published' };

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

function statusBadgeHtml(task) {
  if (task.status && STATUS_LABELS[task.status]) {
    return `<span class="status ${STATUS_CLASS[task.status]}">${STATUS_LABELS[task.status]}</span>`;
  }
  // Internal-only production stage (not one of the 5 client-facing states) —
  // still worth showing, just without a dedicated color.
  return task.statusLabel ? `<span class="status internal">${esc(task.statusLabel)}</span>` : '';
}

function taskRowHtml(task) {
  const dateBadge = task.publishDate
    ? `<span class="status date">${esc(task.publishDate.split('-').reverse().join('.'))}</span>`
    : '';
  return `<div class="team-task" data-task-id="${esc(task.id)}">
    <div class="team-task-top">
      <div>
        ${task.projectLabel ? `<div class="team-task-project">${esc(task.projectLabel)}</div>` : ''}
        <div class="team-task-title">${esc(task.title)}</div>
      </div>
    </div>
    <div class="team-task-bottom">
      ${statusBadgeHtml(task)}
      ${dateBadge}
    </div>
  </div>`;
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
    if (!data.tasks.length) {
      teamEmpty.hidden = false;
      return;
    }
    teamList.innerHTML = data.tasks.map(taskRowHtml).join('');
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

init();
