// Team cabinet — Mattermost login + "my tasks" list + the full post card
// modal (media/text/team chat/client chat/preview, status/date/network
// pickers, AI-generator entry point). See backend/src/index.js's
// /api/team/* routes for what each write here actually calls.

const STATUS_LABELS = { waiting: 'На согласовании', approved: 'Согласовано', changes: 'Правки', published: 'Опубликовано' };
const STATUS_CLASS = { waiting: 'waiting', approved: 'approved', changes: 'changes', published: 'published' };

// Статусы, где нужны действия ответственного — подсвечиваются (чипы и бейджи
// тёплым цветом); остальные (НА СОГЛАСОВАНИИ, СДАЛИ, ЗАПЛАНИРОВАНО и т.п.)
// показываются серым. Те же массивы используются и в модалке карточки для
// раскраски пилюли статуса.
const ACTIVE_STATUSES = ['В ПРОЦЕССЕ', 'КОРРЕКТИРОВКА'];
const GRAY_STATUSES = ['НА СОГЛАСОВАНИИ', 'СДАЛИ', 'ЗАПЛАНИРОВАНО'];
const PREFERRED_STATUS_ORDER = [...ACTIVE_STATUSES, ...GRAY_STATUSES];

// Соцсеть и AI-тег — тот же префикс-конвеншен, что frontend/app.js уже
// реально читает (SOCIAL_MAP/SOCIAL_PREFIX_RE/detectSocial там) для бейджа
// на карточке клиента, и backend/src/index.js пишет (updateTaskNetwork). Нет
// общего common.js между страницами (см. app.js/projects.js/team.js — каждая
// самодостаточна), поэтому здесь — тот же код, а не импорт.
const AI_TAG_RE = /\[ai\]/i;
function isAiPost(title) { return AI_TAG_RE.test(String(title || '')); }
function stripAiTag(title) { return String(title || '').replace(AI_TAG_RE, '').replace(/\s{2,}/g, ' ').trim(); }
const SOCIAL_MAP = {
  ig: { label: 'Instagram', short: 'IG', color: '#C13584' },
  tg: { label: 'Telegram', short: 'TG', color: '#229ED9' },
  vk: { label: 'ВКонтакте', short: 'VK', color: '#0077FF' },
  ok: { label: 'Одноклассники', short: 'OK', color: '#EE8208' },
  max: { label: 'MAX', short: 'MAX', color: '#7C3AED' },
};
const SOCIAL_PREFIX_RE = /^(ig|tg|vk|ok|max)\b[\s:\-–—]*/i;
function detectSocial(title) {
  const m = String(title || '').match(SOCIAL_PREFIX_RE);
  if (!m) return null;
  const key = m[1].toLowerCase();
  return { key, ...SOCIAL_MAP[key], matchedPrefix: m[0] };
}
// Отделяет префикс соцсети от читаемой части названия — используется и для
// показа/редактирования заголовка, и для текста, который копирует бейдж-
// ссылка на медиа.
function splitTitle(title) {
  const social = detectSocial(title);
  const bare = social ? String(title || '').slice(social.matchedPrefix.length) : String(title || '');
  return { social, bare };
}

const MONTHS_RU_FULL = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
const WEEKDAYS_RU = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

const norm = (s) => String(s || '').trim().toLowerCase();

let currentTasks = [];
let activeStatuses = null;
let statusOptions = []; // [{id,label}] — every raw "Статус" option, from GET /api/team/tasks
let keywordsPropertyFound = false;
let boardId = null; // only needed to build /api/files/:boardId/:fileId src urls — see loadTasks()
let currentUser = null;
const FILTERS_KEY = 'kf.team.filters.v1';

// --- Модалка карточки: состояние открытой карточки ---
let modalTaskId = null;
let activeTab = 'media';
let editingTitle = false;
let reorderMode = false;
let reorderIds = [];
let dateCalYear = null;
let dateCalMonth = null;
const scheduleCache = {}; // 'YYYY-MM' -> {days}, from GET /api/team/schedule
const teamCommentsCache = {}; // taskId -> [{id,authorId,authorName,text,createdAt}]

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

async function teamApi(path, opts) {
  opts = opts || {};
  const res = await fetch(`/api/team${path}`, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch (e) {}
  if (!res.ok) throw new Error(data.message || data.error || 'Ошибка запроса');
  return data;
}

// Two possible sources, same convention as frontend/app.js's mediaFileUrl:
// a Mattermost card attachment (old data / legacy path), or a
// disk.kontentferma.* share link (the only path team-added media now takes —
// see addTeamMediaLink in index.js), proxied through our own disk-embed route.
function mediaFileUrl(m) {
  return m.source === 'disk'
    ? `/api/disk-embed?u=${encodeURIComponent(m.shareUrl)}`
    : `/api/files/${encodeURIComponent(boardId)}/${encodeURIComponent(m.fileId)}`;
}

function mediaKindLabel(kind) {
  return kind === 'image' ? 'Фото' : kind === 'video' ? 'Видео' : 'Файл';
}

const loginApp = document.getElementById('loginApp');
const teamApp = document.getElementById('teamApp');
const loginLogin = document.getElementById('loginLogin');
const loginPassword = document.getElementById('loginPassword');
const loginSubmit = document.getElementById('loginSubmit');
const loginError = document.getElementById('loginError');
const teamUserName = document.getElementById('teamUserName');
const statLink = document.getElementById('statLink');
const teamLoading = document.getElementById('teamLoading');
const teamEmpty = document.getElementById('teamEmpty');
const teamList = document.getElementById('teamList');
const teamFilters = document.getElementById('teamFilters');
const teamSearch = document.getElementById('teamSearch');
const taskModal = document.getElementById('taskModal');
const tmHead = document.getElementById('tmHead');
const tmTabbar = document.getElementById('tmTabbar');
const tmBody = document.getElementById('tmBody');

function showLogin() {
  loginApp.hidden = false;
  teamApp.hidden = true;
}

function showApp(user, access) {
  loginApp.hidden = true;
  teamApp.hidden = false;
  teamUserName.textContent = [user.firstName, user.lastName].filter(Boolean).join(' ') || user.username || 'Команда';
  statLink.hidden = !(access && access.stat);
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
    currentUser = data.user;
    showApp(data.user, data.access);
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
  const { social, bare } = splitTitle(task.title);
  const socialBadge = social
    ? `<span class="social-badge" style="background:${esc(social.color)}" title="${esc(social.label)}">${esc(social.short)}</span>`
    : '';
  const displayTitle = stripAiTag(bare);
  // Короткая форма ID поста (первые 8 символов id карточки) — полный виден
  // в модалке и копируется оттуда; поиск в списке матчит подстроку полного
  // ID, так что набранные с чипа символы тоже находят карточку.
  return `<div class="team-task${urgent ? ' urgent' : ''}" data-task-id="${esc(task.id)}">
    <div class="team-task-top">
      <div>
        ${task.projectLabel ? `<div class="team-task-project">${esc(task.projectLabel)}</div>` : ''}
        <div class="team-task-title">${socialBadge}${esc(displayTitle)}</div>
      </div>
    </div>
    <div class="team-task-bottom">
      <div class="team-task-meta">
        <div class="team-task-status">${statusBadgeHtml(task)}${urgentBadge}</div>
        <span class="team-task-id" title="ID поста: ${esc(task.id)}">#${esc(String(task.id).slice(0, 8))}</span>
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
  // Поиск (название / клиент / подстрока ID поста, без учёта регистра)
  // сужает список ВНУТРИ выбранных статусных чипов — оба фильтра действуют
  // одновременно. "#" в начале запроса просто отбрасывается: чип на карточке
  // отображается как "#yoskwj9p", а искать хочется и так, и без решётки.
  const q = norm((teamSearch && teamSearch.value) || '').replace(/^#/, '');
  const bySearch = (t) =>
    !q ||
    norm(t.title).includes(q) ||
    norm(t.projectLabel || '').includes(q) ||
    norm(t.id).includes(q);
  const visible = currentTasks.filter(bySearch).filter((t) => (activeStatuses ? activeStatuses.has(norm(t.statusLabel)) : true));
  if (!visible.length) {
    teamEmpty.textContent = q
      ? `Ничего не найдено по запросу «${teamSearch.value.trim()}».`
      : currentTasks.length
      ? 'Нет задач с выбранными статусами.'
      : 'На вас пока нет ни одной задачи.';
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
    statusOptions = data.statusOptions || [];
    keywordsPropertyFound = !!data.keywordsPropertyFound;
    if (data.boardId) boardId = data.boardId;
    currentTasks = (data.tasks || []).slice().sort(byDeadline);
    renderChips();
    renderTasks();
    if (modalTaskId) renderModal(); // держим открытую карточку в актуальном состоянии после фонового обновления списка
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
    currentUser = data.user;
    showApp(data.user, data.access);
    loadTasks();
  } catch (err) {
    showLogin();
  }
}

// ============================== Модалка карточки ==============================

function currentModalTask() {
  return currentTasks.find((t) => t.id === modalTaskId) || null;
}

function applyUpdatedTask(updated) {
  const i = currentTasks.findIndex((x) => x.id === updated.id);
  if (i >= 0) currentTasks[i] = updated; else currentTasks.push(updated);
  renderChips();
  renderTasks();
  if (modalTaskId === updated.id) renderModal();
}

function openTaskModal(taskId) {
  modalTaskId = taskId;
  activeTab = 'media';
  reorderMode = false;
  editingTitle = false;
  taskModal.hidden = false;
  renderModal();
}

function closeTaskModal() {
  taskModal.hidden = true;
  modalTaskId = null;
}

function closeAllPopovers() {
  document.querySelectorAll('.tm-popover, .tm-ai-pop').forEach((el) => { el.hidden = true; });
}

function togglePopover(el) {
  if (!el) return;
  const shouldOpen = el.hidden;
  closeAllPopovers();
  el.hidden = !shouldOpen;
}

// Короткая вспышка рамки вокруг только что сохранённого поля/пилюли/строки
// (см. .tm-flash-save в team.css) — единая подсказка "сохранено" для всех
// действий в карточке, вместо тоста на каждое мелкое сохранение. Снимает и
// заново навешивает класс (а не просто добавляет) — иначе повторное
// сохранение того же поля подряд не переиграло бы анимацию, т.к. класс уже
// был бы на месте.
function flashSaved(el) {
  if (!el) return;
  el.classList.remove('tm-flash-save');
  void el.offsetWidth; // force reflow so re-adding the class restarts the animation
  el.classList.add('tm-flash-save');
  el.addEventListener('animationend', () => el.classList.remove('tm-flash-save'), { once: true });
}

function renderModal() {
  const t = currentModalTask();
  if (!t) { closeTaskModal(); return; }
  renderModalHead(t);
  renderModalTabbar(t);
  renderModalBody(t);
}

// --- Шапка: проект / название (+карандаш) / пилюли статус-дата-соцсеть ---

function statusPillHtml(t) {
  const label = t.statusLabel || '—';
  const need = ACTIVE_STATUSES.some((s) => norm(s) === norm(label));
  const wait = GRAY_STATUSES.some((s) => norm(s) === norm(label));
  const cls = need ? 'need' : wait ? 'wait' : '';
  return `<button type="button" class="tm-pill tm-status-pill ${cls}" data-action="toggle-status-pop">
    <span class="tm-pill-dot"></span>${esc(label)}
  </button>`;
}

function statusPopHtml(t) {
  if (!statusOptions.length) return '<div style="padding:8px;font-size:12px;color:var(--muted)">Статусы не загружены.</div>';
  return statusOptions
    .map((opt) => {
      const sel = norm(opt.label) === norm(t.statusLabel);
      const need = ACTIVE_STATUSES.some((s) => norm(s) === norm(opt.label));
      const wait = GRAY_STATUSES.some((s) => norm(s) === norm(opt.label));
      const color = need ? '#C94F2E' : wait ? '#4B5654' : '#B7BEBC';
      return `<button type="button" class="tm-pop-option${sel ? ' selected' : ''}" data-action="pick-status" data-label="${esc(opt.label)}">
        <span class="tm-pill-dot" style="background:${color}"></span>${esc(opt.label)}
      </button>`;
    })
    .join('');
}

function datePillHtml(t) {
  const label = t.publishDate ? t.publishDate.split('-').reverse().join('.') : 'Дата не задана';
  return `<button type="button" class="tm-pill tm-date-pill" data-action="toggle-date-pop">
    <span class="tm-pill-dot"></span>${esc(label)}
  </button>`;
}

function networkPillHtml(t) {
  const { social } = splitTitle(t.title);
  if (social) {
    return `<button type="button" class="tm-pill tm-network-pill" data-action="toggle-network-pop" style="border-color:${esc(social.color)};color:${esc(social.color)}">
      <span class="tm-pill-dot" style="background:${esc(social.color)}"></span>${esc(social.label)}
    </button>`;
  }
  return `<button type="button" class="tm-pill tm-network-pill empty" data-action="toggle-network-pop">＋ Соцсеть</button>`;
}

function networkPopHtml(t) {
  const { social } = splitTitle(t.title);
  const curKey = social ? social.key : '';
  const options = [{ key: '', label: 'Без соцсети', color: '#B7BEBC' }].concat(
    Object.keys(SOCIAL_MAP).map((k) => ({ key: k, label: SOCIAL_MAP[k].label, color: SOCIAL_MAP[k].color }))
  );
  return options
    .map(
      (o) => `<button type="button" class="tm-pop-option${curKey === o.key ? ' selected' : ''}" data-action="pick-network" data-network="${esc(o.key)}">
        <span class="tm-pill-dot" style="background:${esc(o.color)}"></span>${esc(o.label)}
      </button>`
    )
    .join('');
}

function renderModalHead(t) {
  const { bare } = splitTitle(t.title);
  const titleDisplay = stripAiTag(bare) || '(без названия)';
  const titleBlock = editingTitle
    ? `<div class="tm-title-editor">
        <textarea id="tmTitleInput">${esc(titleDisplay)}</textarea>
        <button type="button" class="tm-mini-btn" data-action="save-title" aria-label="Сохранить">✓</button>
        <button type="button" class="tm-mini-btn" data-action="cancel-title" aria-label="Отмена">✕</button>
      </div>`
    : `<div class="tm-title">${esc(titleDisplay)}</div>
       <button type="button" class="tm-title-edit-btn" data-action="edit-title" aria-label="Изменить название" title="Изменить название">✎</button>`;
  tmHead.innerHTML = `
    ${t.projectLabel ? `<div class="tm-project">${esc(t.projectLabel)}</div>` : ''}
    <div class="tm-title-row">${titleBlock}</div>
    <div class="tm-pills">
      <div class="tm-pill-wrap">
        ${statusPillHtml(t)}
        <div class="tm-popover" id="tmStatusPop" hidden>${statusPopHtml(t)}</div>
      </div>
      <div class="tm-pill-wrap">
        ${datePillHtml(t)}
        <div class="tm-popover tm-cal-pop" id="tmDatePop" hidden></div>
      </div>
      <div class="tm-pill-wrap">
        ${networkPillHtml(t)}
        <div class="tm-popover" id="tmNetworkPop" hidden>${networkPopHtml(t)}</div>
      </div>
    </div>
    <button type="button" class="tm-id-chip" data-action="copy-id" data-id="${esc(t.id)}"
            title="Нажмите, чтобы скопировать ID — по нему файл на диске и поиск в списке">
      ID: ${esc(t.id)}
    </button>
  `;
  if (editingTitle) {
    const input = document.getElementById('tmTitleInput');
    if (input) { input.focus(); input.selectionStart = input.selectionEnd = input.value.length; }
  }
}

// --- Мини-календарь в попапе даты — та же логика сетки, что renderCalendar()
// в frontend/app.js (UTC-математика, чтобы не плыло у полуночи), только
// компактнее и с "занятостью" по GET /api/team/schedule вместо статусных точек. ---

function buildCalGrid(year, month, selectedDateStr, days, todayStr) {
  const first = new Date(Date.UTC(year, month, 1));
  const leadDow = first.getUTCDay() || 7; // Mon=1..Sun=7
  const lead = leadDow - 1;
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const totalCells = Math.ceil((lead + daysInMonth) / 7) * 7;
  const gridStart = new Date(Date.UTC(year, month, 1 - lead));
  const cells = [];
  for (let i = 0; i < totalCells; i++) {
    const d = new Date(gridStart);
    d.setUTCDate(gridStart.getUTCDate() + i);
    const dateStr = d.toISOString().slice(0, 10);
    const inMonth = d.getUTCMonth() === month;
    const info = days[dateStr];
    // Не считаем саму эту задачу "занятостью" её же текущего дня — иначе
    // выбранный день всегда выглядел бы занятым сам собой.
    const otherCount = info ? info.count - (dateStr === selectedDateStr ? 1 : 0) : 0;
    const cls = ['tm-cal-day'];
    if (!inMonth) cls.push('other-month');
    if (dateStr === todayStr) cls.push('today');
    if (dateStr === selectedDateStr) cls.push('selected');
    if (otherCount > 0) cls.push('busy');
    const titleAttr = otherCount > 0
      ? ` title="${esc(`Уже запланировано: ${(days[dateStr].titles || []).join(', ')}${otherCount > days[dateStr].titles.length ? '…' : ''}`)}"`
      : '';
    cells.push(`<button type="button" class="${cls.join(' ')}" data-date="${dateStr}"${titleAttr}>${d.getUTCDate()}</button>`);
  }
  return cells.join('');
}

async function renderDateCalendar(t) {
  const pop = document.getElementById('tmDatePop');
  if (!pop) return;
  const monthKey = `${dateCalYear}-${String(dateCalMonth + 1).padStart(2, '0')}`;
  if (!scheduleCache[monthKey]) {
    try {
      const data = await teamApi(`/schedule?month=${monthKey}`);
      scheduleCache[monthKey] = data.days || {};
    } catch (err) {
      scheduleCache[monthKey] = {};
    }
  }
  // Попап мог закрыться, пока шёл запрос — не рисуем в пустоту.
  const popNow = document.getElementById('tmDatePop');
  if (!popNow || popNow.hidden) return;
  const days = scheduleCache[monthKey];
  const now = new Date();
  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  popNow.innerHTML = `
    <div class="tm-cal-head">
      <button type="button" class="tm-cal-nav-btn" data-action="cal-prev" aria-label="Предыдущий месяц">‹</button>
      <div class="tm-cal-title">${MONTHS_RU_FULL[dateCalMonth]} ${dateCalYear}</div>
      <button type="button" class="tm-cal-nav-btn" data-action="cal-next" aria-label="Следующий месяц">›</button>
    </div>
    <div class="tm-cal-weekdays">${WEEKDAYS_RU.map((w) => `<span>${w}</span>`).join('')}</div>
    <div class="tm-cal-grid">${buildCalGrid(dateCalYear, dateCalMonth, t.publishDate, days, todayStr)}</div>
    <div class="tm-cal-legend"><span class="dot"></span>Уже есть запланированные посты — чтобы не собрать всё в один день</div>
  `;
}

async function onToggleDatePop(t) {
  const pop = document.getElementById('tmDatePop');
  togglePopover(pop);
  if (pop.hidden) return;
  const base = t.publishDate ? new Date(`${t.publishDate}T00:00:00Z`) : new Date();
  dateCalYear = t.publishDate ? base.getUTCFullYear() : base.getFullYear();
  dateCalMonth = t.publishDate ? base.getUTCMonth() : base.getMonth();
  pop.innerHTML = '<div style="padding:10px;font-size:11.5px;color:var(--muted)">Загружаем…</div>';
  await renderDateCalendar(t);
}

// --- Вкладки + аватар ИИ-генератора ---

const TABS = [
  { key: 'media', label: 'Медиа' },
  { key: 'text', label: 'Текст' },
  { key: 'team', label: 'ЧАТ КОМАНДЫ' },
  { key: 'client', label: 'Чат с клиентом' },
  { key: 'preview', label: 'Предпросмотр поста' },
];

function renderModalTabbar() {
  tmTabbar.innerHTML = `
    <div class="tm-tabs">
      ${TABS.map((tb) => `<button type="button" class="tm-tab${activeTab === tb.key ? ' active' : ''}" data-tab="${tb.key}">${tb.label}</button>`).join('')}
    </div>
    <button type="button" class="tm-ai-avatar" id="tmAiBtn" title="ИИ-генератор" aria-label="ИИ-генератор">
      <img src="/ai-avatar.png" alt="">
    </button>
    <div class="tm-ai-pop" id="tmAiPop" hidden>
      <div class="tm-ai-pop-title">Что сгенерировать?</div>
      <button type="button" class="tm-ai-pop-option" data-action="ai-gen-text"><span class="tm-ai-pop-icon">📝</span>Текст поста — из темы, настроек клиента и ключевых слов</button>
      <button type="button" class="tm-ai-pop-option" data-action="ai-gen-image"><span class="tm-ai-pop-icon">🖼️</span>Картинку — из тех же вводных</button>
    </div>
  `;
}

// --- Медиа ---

function mediaThumbHtml(m, i) {
  const url = mediaFileUrl(m);
  let inner;
  if (m.kind === 'image') inner = `<img src="${url}" alt="" loading="lazy">`;
  else if (m.kind === 'video') inner = `<video muted preload="metadata" src="${url}"></video>`;
  else inner = `<div style="display:flex;align-items:center;justify-content:center;height:100%;padding:4px;text-align:center;font-size:10.5px;color:var(--muted)">${esc(m.name || 'Файл')}</div>`;
  const kindBadge = m.kind === 'video' ? '<span class="tm-media-kind">▶ видео</span>' : '';
  const linkBadge = m.source === 'disk' && m.shareUrl
    ? `<button type="button" class="tm-media-link-badge" data-action="copy-media" data-id="${esc(m.id)}" title="Материал на disk.kontentferma — нажмите, чтобы скопировать дату, тему и ссылку">🔗</button>`
    : '';
  return `<div class="tm-media-thumb"><span class="tm-media-pos">${i + 1}</span>${inner}${kindBadge}${linkBadge}</div>`;
}

function reorderRowHtml(m, i, total) {
  if (!m) return '';
  const url = mediaFileUrl(m);
  const thumb = m.kind === 'image'
    ? `<img src="${url}" alt="">`
    : m.kind === 'video'
    ? `<video muted preload="metadata" src="${url}"></video>`
    : '';
  return `<div class="tm-reorder-row">
    <div class="tm-reorder-thumb">${thumb}</div>
    <div class="tm-reorder-name">${i + 1}. ${esc(m.name || mediaKindLabel(m.kind))}</div>
    <div class="tm-reorder-btns">
      <button type="button" class="tm-mini-btn" data-action="mo-up" data-id="${esc(m.id)}" ${i === 0 ? 'disabled' : ''} aria-label="Выше">↑</button>
      <button type="button" class="tm-mini-btn" data-action="mo-down" data-id="${esc(m.id)}" ${i === total - 1 ? 'disabled' : ''} aria-label="Ниже">↓</button>
    </div>
  </div>`;
}

function attachBoxHtml() {
  // Реальная загрузка (перетащить файл или выбрать с устройства) идёт прямо
  // на disk.kontentferma через WebDAV (см. POST .../media-upload,
  // diskUpload.js) — если ключи ещё не настроены на сервере, роут вернёт
  // понятную ошибку "не настроено", а не молча ничего не сделает; поле для
  // вставки уже готовой ссылки остаётся ниже как резервный вариант всегда.
  return `<div class="tm-dropzone" id="tmDropzone">
    <div class="tm-dropzone-title">📎 Перетащите файл сюда или нажмите, чтобы выбрать</div>
    <div class="tm-dropzone-hint">Загрузится на disk.kontentferma — в карточку попадёт только ссылка, не сам файл</div>
    <input type="file" id="tmFileInput" accept="image/*,video/*">
  </div>
  <div class="tm-attach-sep">или вставьте готовую ссылку</div>
  <div class="tm-attach-box">
    <div class="tm-attach-row">
      <input type="text" id="tmAttachInput" placeholder="https://disk.kontentferma.ru/s/...">
      <button type="button" data-action="attach-link">Добавить</button>
    </div>
  </div>`;
}

function renderMediaPane(t) {
  const media = t.media || [];
  let toolbar = `<div class="tm-media-toolbar"><div class="tm-media-toolbar-title">Медиа (${media.length})</div>`;
  if (media.length > 1) {
    toolbar += reorderMode
      ? `<div style="display:flex;gap:6px">
          <button type="button" class="tm-reorder-toggle" data-action="save-reorder">Сохранить порядок</button>
          <button type="button" class="tm-reorder-toggle" data-action="cancel-reorder">Отмена</button>
        </div>`
      : `<button type="button" class="tm-reorder-toggle" data-action="toggle-reorder">Изменить порядок</button>`;
  }
  toolbar += `</div>`;
  let body;
  if (!media.length) {
    body = `<div class="tm-media-empty">Медиа ещё не добавлено — вставьте ссылку с диска ниже.</div>`;
  } else if (reorderMode) {
    const byId = new Map(media.map((m) => [m.id, m]));
    body = `<div class="tm-reorder-list">${reorderIds.map((id, i) => reorderRowHtml(byId.get(id), i, reorderIds.length)).join('')}</div>`;
  } else {
    body = `<div class="tm-media-grid">${media.map((m, i) => mediaThumbHtml(m, i)).join('')}</div>`;
  }
  return `${toolbar}${body}${attachBoxHtml()}`;
}

// --- Текст + ключевые слова ---

function renderTextPane(t) {
  let html = `<div>
    <div class="tm-field-label">Текст поста</div>
    <textarea class="tm-textarea" id="tmCaptionInput" spellcheck="true">${esc(t.caption || '')}</textarea>
    <div class="tm-save-row" style="margin-top:8px">
      <button type="button" class="btn changes" data-action="save-caption">Сохранить текст</button>
    </div>
  </div>`;
  if (keywordsPropertyFound) {
    html += `<div>
      <div class="tm-field-label">Ключевые слова / мысли</div>
      <textarea class="tm-textarea tm-keywords-textarea" id="tmKeywordsInput" spellcheck="true" placeholder="Вводные для копирайтера и для ИИ-генератора">${esc(t.keywords || '')}</textarea>
      <div class="tm-save-row" style="margin-top:8px">
        <button type="button" class="btn changes" data-action="save-keywords">Сохранить</button>
      </div>
    </div>`;
  }
  return html;
}

// --- ЧАТ КОМАНДЫ (внутренний, своя таблица в БД — не карточка Mattermost) ---

function renderTeamPane(t) {
  const list = teamCommentsCache[t.id];
  if (!list) {
    return `<div class="tm-chat"><div class="tm-chat-empty">Загружаем переписку…</div></div>`;
  }
  const items = list.length
    ? list
        .map((c) => {
          const mine = currentUser && c.authorId === currentUser.id;
          return `<div class="tm-chat-msg${mine ? ' mine' : ''}">
            <div class="tm-chat-msg-author">${esc(c.authorName || 'Команда')}</div>
            <div class="tm-chat-msg-text">${esc(c.text)}</div>
            <div class="tm-chat-msg-time">${formatDateTime(c.createdAt)}</div>
          </div>`;
        })
        .join('')
    : `<div class="tm-chat-empty">Пока нет сообщений — начните обсуждение поста здесь.</div>`;
  return `<div class="tm-chat">
    <div class="tm-chat-list">${items}</div>
    <div class="tm-chat-compose">
      <textarea id="tmTeamComposeInput" placeholder="Написать команде…"></textarea>
      <button type="button" class="tm-chat-send" data-action="send-team-comment" aria-label="Отправить">➤</button>
    </div>
  </div>`;
}

async function loadTeamComments(taskId) {
  try {
    const data = await teamApi(`/tasks/${encodeURIComponent(taskId)}/comments`);
    teamCommentsCache[taskId] = data.comments || [];
  } catch (err) {
    teamCommentsCache[taskId] = [];
    toast('Не удалось загрузить переписку: ' + err.message);
  }
  if (modalTaskId === taskId && activeTab === 'team') {
    const t = currentModalTask();
    if (t) renderModalBody(t);
  }
}

// --- Чат с клиентом (только чтение — реальная переписка из карточки Mattermost) ---

function formatDateTime(ms) {
  if (!ms) return '';
  try {
    return new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(ms));
  } catch (e) {
    return '';
  }
}

function clientCommentHtml(c) {
  if (c.kind === 'feedback') {
    return `<div class="tm-chat-msg">
      <div class="tm-chat-msg-author">Клиент</div>
      <div class="tm-chat-msg-text">${esc(c.text)}</div>
      <div class="tm-chat-msg-time">${formatDateTime(c.createdAt)}</div>
    </div>`;
  }
  // 'agency' — сообщение, отправленное командой отсюда же (см. compose box
  // ниже) — показываем как "своё" сообщение (справа), чат с клиентом
  // читается в обе стороны, а не только его правки.
  if (c.kind === 'agency') {
    return `<div class="tm-chat-msg mine">
      <div class="tm-chat-msg-author">Агентство</div>
      <div class="tm-chat-msg-text">${esc(c.text)}</div>
      <div class="tm-chat-msg-time">${formatDateTime(c.createdAt)}</div>
    </div>`;
  }
  const label = c.kind === 'approved' ? '✓ Клиент согласовал пост' : c.text;
  return `<div class="tm-chat-msg system">${esc(label)} · ${formatDateTime(c.createdAt)}</div>`;
}

function renderClientPane(t) {
  const items = t.clientComments || [];
  const list = items.length
    ? `<div class="tm-chat-list">${items.map(clientCommentHtml).join('')}</div>`
    : `<div class="tm-chat-empty">Переписки пока нет — можно написать клиенту первым.</div>`;
  // В отличие от предыдущей read-only версии — сюда всегда можно написать,
  // независимо от того, оставлял ли клиент что-то сам (реальная переписка
  // из карточки Mattermost, не только приём его правок).
  return `<div class="tm-chat">
    ${list}
    <div class="tm-chat-compose">
      <textarea id="tmClientComposeInput" placeholder="Написать клиенту…"></textarea>
      <button type="button" class="tm-chat-send" data-action="send-client-message" aria-label="Отправить">➤</button>
    </div>
  </div>`;
}

// --- Предпросмотр поста ---

function renderPreviewPane(t) {
  const media = (t.media || [])[0];
  const { social, bare } = splitTitle(t.title);
  const socialBadge = social ? `<span class="tm-preview-social" style="background:${esc(social.color)}">${esc(social.label)}</span>` : '';
  const mediaHtml = media
    ? media.kind === 'video'
      ? `<video muted controls preload="metadata" src="${mediaFileUrl(media)}"></video>`
      : `<img src="${mediaFileUrl(media)}" alt="">`
    : `<div class="tm-preview-empty" style="padding:60px 10px">Медиа не выбрано</div>`;
  const captionText = stripAiTag(t.caption || bare || '');
  const captionHtml = captionText ? esc(captionText) : '<span class="tm-preview-empty">Текст ещё не задан</span>';
  return `<div class="tm-preview-phone"><div class="tm-preview-inner">
    <div class="tm-preview-media">${mediaHtml}</div>
    <div class="tm-preview-text">${socialBadge}<div class="tm-preview-caption">${captionHtml}</div></div>
  </div></div>`;
}

function renderModalBody(t) {
  let html = '';
  if (activeTab === 'media') html = renderMediaPane(t);
  else if (activeTab === 'text') html = renderTextPane(t);
  else if (activeTab === 'team') html = renderTeamPane(t);
  else if (activeTab === 'client') html = renderClientPane(t);
  else if (activeTab === 'preview') html = renderPreviewPane(t);
  tmBody.innerHTML = html;
}

// --- Обработчики кликов внутри модалки (делегирование по трём зонам) ---

tmHead.addEventListener('click', async (e) => {
  const t = currentModalTask();
  if (!t) return;
  const btn = e.target.closest('button');
  if (!btn) return;
  const action = btn.dataset.action;

  if (action === 'edit-title') { editingTitle = true; renderModalHead(t); return; }
  if (action === 'cancel-title') { editingTitle = false; renderModalHead(t); return; }
  if (action === 'copy-id') {
    try {
      await navigator.clipboard.writeText(btn.dataset.id);
      toast('ID скопирован');
    } catch (err) {
      toast('Не удалось скопировать: ' + err.message);
    }
    return;
  }
  if (action === 'save-title') {
    const input = document.getElementById('tmTitleInput');
    const val = (input.value || '').trim();
    if (!val) { toast('Название не может быть пустым.'); return; }
    try {
      const data = await teamApi(`/tasks/${encodeURIComponent(t.id)}/title`, { method: 'POST', body: { title: val } });
      editingTitle = false;
      applyUpdatedTask(data.task);
      flashSaved(document.querySelector('#tmHead .tm-title'));
    } catch (err) {
      toast('Не удалось сохранить название: ' + err.message);
    }
    return;
  }
  if (action === 'toggle-status-pop') { togglePopover(document.getElementById('tmStatusPop')); return; }
  if (action === 'toggle-network-pop') { togglePopover(document.getElementById('tmNetworkPop')); return; }
  if (action === 'toggle-date-pop') { await onToggleDatePop(t); return; }
  if (action === 'pick-status') {
    try {
      const data = await teamApi(`/tasks/${encodeURIComponent(t.id)}/status`, { method: 'POST', body: { status: btn.dataset.label } });
      applyUpdatedTask(data.task);
      flashSaved(document.querySelector('#tmHead .tm-status-pill'));
    } catch (err) {
      toast('Не удалось изменить статус: ' + err.message);
    }
    return;
  }
  if (action === 'pick-network') {
    try {
      const data = await teamApi(`/tasks/${encodeURIComponent(t.id)}/network`, { method: 'POST', body: { network: btn.dataset.network } });
      applyUpdatedTask(data.task);
      flashSaved(document.querySelector('#tmHead .tm-network-pill'));
    } catch (err) {
      toast('Не удалось изменить соцсеть: ' + err.message);
    }
    return;
  }
  if (action === 'cal-prev' || action === 'cal-next') {
    dateCalMonth += action === 'cal-prev' ? -1 : 1;
    if (dateCalMonth < 0) { dateCalMonth = 11; dateCalYear--; }
    if (dateCalMonth > 11) { dateCalMonth = 0; dateCalYear++; }
    await renderDateCalendar(t);
    return;
  }
  if (btn.dataset.date) {
    try {
      const data = await teamApi(`/tasks/${encodeURIComponent(t.id)}/date`, { method: 'POST', body: { date: btn.dataset.date } });
      applyUpdatedTask(data.task);
      flashSaved(document.querySelector('#tmHead .tm-date-pill'));
    } catch (err) {
      toast('Не удалось изменить дату: ' + err.message);
    }
    return;
  }
});

tmTabbar.addEventListener('click', (e) => {
  const t = currentModalTask();
  if (!t) return;
  const tabBtn = e.target.closest('.tm-tab');
  if (tabBtn) {
    activeTab = tabBtn.dataset.tab;
    renderModalTabbar();
    renderModalBody(t);
    if (activeTab === 'team' && !teamCommentsCache[t.id]) loadTeamComments(t.id);
    return;
  }
  if (e.target.closest('#tmAiBtn')) {
    togglePopover(document.getElementById('tmAiPop'));
    return;
  }
  if (e.target.closest('[data-action="ai-gen-text"], [data-action="ai-gen-image"]')) {
    closeAllPopovers();
    toast('ИИ-генератор пока без провайдера — подключим, как только выберем сервис вместе с Дмитрием.');
    return;
  }
});

tmBody.addEventListener('click', async (e) => {
  const t = currentModalTask();
  if (!t) return;
  const btn = e.target.closest('button');
  if (!btn) return;
  const action = btn.dataset.action;

  if (action === 'toggle-reorder') {
    reorderMode = !reorderMode;
    if (reorderMode) reorderIds = (t.media || []).map((m) => m.id);
    renderModalBody(t);
    return;
  }
  if (action === 'mo-up' || action === 'mo-down') {
    const i = reorderIds.indexOf(btn.dataset.id);
    const j = i + (action === 'mo-up' ? -1 : 1);
    if (i < 0 || j < 0 || j >= reorderIds.length) return;
    [reorderIds[i], reorderIds[j]] = [reorderIds[j], reorderIds[i]];
    renderModalBody(t);
    return;
  }
  if (action === 'save-reorder') {
    try {
      const data = await teamApi(`/tasks/${encodeURIComponent(t.id)}/media-order`, { method: 'POST', body: { order: reorderIds } });
      reorderMode = false;
      applyUpdatedTask(data.task);
      flashSaved(document.querySelector('#tmBody .tm-media-grid'));
    } catch (err) {
      toast('Не удалось сохранить порядок: ' + err.message);
    }
    return;
  }
  if (action === 'cancel-reorder') { reorderMode = false; renderModalBody(t); return; }
  if (action === 'copy-media') {
    const m = (t.media || []).find((x) => x.id === btn.dataset.id);
    if (!m || !m.shareUrl) return;
    const dateStr = t.publishDate ? t.publishDate.split('-').reverse().join('.') : '';
    const { bare } = splitTitle(t.title);
    const text = [dateStr, stripAiTag(bare)].filter(Boolean).join(' ') + '  ' + m.shareUrl;
    // .catch(() => {}) — буфер обмена может быть недоступен (например, в
    // изолированном webview); визуальный "скопировано" всё равно покажем,
    // это лучше молчаливого сбоя. См. аналогичную оговорку в app.js.
    navigator.clipboard.writeText(text).catch(() => {});
    btn.classList.add('copied');
    btn.textContent = '✓';
    setTimeout(() => { btn.classList.remove('copied'); btn.textContent = '🔗'; }, 1400);
    return;
  }
  if (action === 'attach-link') {
    const input = document.getElementById('tmAttachInput');
    const url = (input.value || '').trim();
    if (!url) return;
    btn.disabled = true;
    try {
      const data = await teamApi(`/tasks/${encodeURIComponent(t.id)}/media-link`, { method: 'POST', body: { url } });
      input.value = '';
      applyUpdatedTask(data.task);
      flashSaved(document.querySelector('#tmBody .tm-media-grid'));
    } catch (err) {
      toast('Не удалось добавить ссылку: ' + err.message);
    } finally {
      btn.disabled = false;
    }
    return;
  }
  if (action === 'save-caption') {
    const val = document.getElementById('tmCaptionInput').value;
    try {
      const data = await teamApi(`/tasks/${encodeURIComponent(t.id)}/text`, { method: 'POST', body: { text: val } });
      applyUpdatedTask(data.task);
      flashSaved(document.getElementById('tmCaptionInput'));
    } catch (err) {
      toast('Не удалось сохранить текст: ' + err.message);
    }
    return;
  }
  if (action === 'save-keywords') {
    const val = document.getElementById('tmKeywordsInput').value;
    try {
      const data = await teamApi(`/tasks/${encodeURIComponent(t.id)}/keywords`, { method: 'POST', body: { text: val } });
      applyUpdatedTask(data.task);
      flashSaved(document.getElementById('tmKeywordsInput'));
    } catch (err) {
      toast('Не удалось сохранить: ' + err.message);
    }
    return;
  }
  if (action === 'send-team-comment') {
    const input = document.getElementById('tmTeamComposeInput');
    const text = (input.value || '').trim();
    if (!text) return;
    btn.disabled = true;
    try {
      const data = await teamApi(`/tasks/${encodeURIComponent(t.id)}/comments`, { method: 'POST', body: { text } });
      teamCommentsCache[t.id] = [...(teamCommentsCache[t.id] || []), data.comment];
      input.value = '';
      renderModalBody(t);
      const list = document.querySelector('#tmBody .tm-chat-list');
      if (list) flashSaved(list.lastElementChild || list);
    } catch (err) {
      toast('Не удалось отправить: ' + err.message);
    } finally {
      btn.disabled = false;
    }
    return;
  }
  if (action === 'send-client-message') {
    const input = document.getElementById('tmClientComposeInput');
    const text = (input.value || '').trim();
    if (!text) return;
    btn.disabled = true;
    try {
      // Unlike the team chat, clientComments already comes back embedded on
      // the task itself (see taskMapper.js) — applyUpdatedTask alone is
      // enough, no separate cache to update.
      const data = await teamApi(`/tasks/${encodeURIComponent(t.id)}/client-message`, { method: 'POST', body: { text } });
      input.value = '';
      applyUpdatedTask(data.task);
      const list = document.querySelector('#tmBody .tm-chat-list');
      if (list) flashSaved(list.lastElementChild || list);
    } catch (err) {
      toast('Не удалось отправить: ' + err.message);
    } finally {
      btn.disabled = false;
    }
    return;
  }
});

// Реальная загрузка файла — перетащить в #tmDropzone или выбрать через
// скрытый <input type="file"> внутри него (клик по зоне landing прямо на
// input, см. .tm-dropzone CSS). Оба пути ведут в uploadMediaFile().
async function uploadMediaFile(t, file) {
  const zone = document.getElementById('tmDropzone');
  const titleEl = zone && zone.querySelector('.tm-dropzone-title');
  if (zone) zone.classList.add('uploading');
  if (titleEl) titleEl.textContent = `Загружаем «${file.name}»…`;
  try {
    const form = new FormData();
    form.append('file', file);
    const res = await fetch(`/api/team/tasks/${encodeURIComponent(t.id)}/media-upload`, { method: 'POST', body: form });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast(
        data.error === 'disk_upload_not_configured'
          ? 'Загрузка ещё не настроена на сервере — вставьте готовую ссылку ниже.'
          : 'Не удалось загрузить файл: ' + (data.message || data.error || 'ошибка')
      );
      return;
    }
    applyUpdatedTask(data.task);
    flashSaved(document.querySelector('#tmBody .tm-media-grid'));
  } catch (err) {
    toast('Не удалось загрузить файл: ' + err.message);
  } finally {
    // На успехе applyUpdatedTask уже пересоздал #tmDropzone заново (обычным
    // состоянием) — ищем свежий узел, а не держимся за старую ссылку,
    // которая могла быть заменена перерисовкой.
    const freshZone = document.getElementById('tmDropzone');
    if (freshZone) {
      freshZone.classList.remove('uploading');
      const freshTitle = freshZone.querySelector('.tm-dropzone-title');
      if (freshTitle) freshTitle.textContent = '📎 Перетащите файл сюда или нажмите, чтобы выбрать';
    }
  }
}

tmBody.addEventListener('change', (e) => {
  const fileInput = e.target.closest('#tmFileInput');
  if (!fileInput) return;
  const t = currentModalTask();
  const file = fileInput.files && fileInput.files[0];
  fileInput.value = ''; // позволяет выбрать тот же файл повторно в будущем
  if (t && file) uploadMediaFile(t, file);
});

tmBody.addEventListener('dragover', (e) => {
  const zone = e.target.closest('#tmDropzone');
  if (!zone) return;
  e.preventDefault(); // без этого браузер блокирует drop по умолчанию
  zone.classList.add('drag-over');
});

tmBody.addEventListener('dragleave', (e) => {
  const zone = e.target.closest('#tmDropzone');
  if (!zone) return;
  zone.classList.remove('drag-over');
});

tmBody.addEventListener('drop', (e) => {
  const zone = e.target.closest('#tmDropzone');
  if (!zone) return;
  e.preventDefault();
  zone.classList.remove('drag-over');
  const t = currentModalTask();
  const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (t && file) uploadMediaFile(t, file);
});

// Клик вне пилюль/попапов/аватара ИИ закрывает все открытые попапы. Capture
// phase (3-й аргумент true), а не bubble — намеренно: действия ВНУТРИ
// попапов (выбор статуса, дата, стрелки календаря вперёд/назад) сами
// перерисовывают innerHTML своего контейнера в ответ на этот же клик, а
// перерисовка отключает кликнутый элемент от документа. На bubble-фазе,
// когда событие добралось бы досюда, e.target уже был бы отсоединён и
// closest() всегда возвращал бы null — читалось бы как "клик снаружи" и
// закрывало бы popover сразу после того, как он сам себя обновил (например,
// после клика по стрелке месяца). На capture-фазе этот обработчик срабатывает
// ПЕРВЫМ, раньше любых обработчиков на самих элементах модалки — до того,
// как что-либо успеет перерисоваться, так что e.target здесь всегда ещё
// живой узел.
document.addEventListener('click', (e) => {
  if (taskModal.hidden) return;
  if (!e.target.closest('.tm-pill-wrap') && !e.target.closest('.tm-ai-avatar') && !e.target.closest('.tm-ai-pop')) {
    closeAllPopovers();
  }
}, true);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !taskModal.hidden) closeTaskModal();
});

// =================================================================================

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

teamSearch.addEventListener('input', renderTasks);

teamList.addEventListener('click', (e) => {
  const row = e.target.closest('.team-task');
  if (!row) return;
  openTaskModal(row.dataset.taskId);
});

// Bound directly to the backdrop and the close button — NOT a delegated
// "closest('.tm-card') failed → must be outside" check on #taskModal as a
// whole. Reason: almost every action inside the card (tab switch, title
// save, status/date/network pick, reorder toggle, ...) re-renders its
// container's innerHTML in response to the very click that's still
// bubbling. That detaches the clicked element from the document before the
// event reaches an ancestor listener, so closest() on e.target there always
// comes back null — which used to read as "click was outside the card" and
// closed the modal on every single interaction. Listening on the backdrop
// itself (a stable element no render function ever touches) sidesteps the
// whole class of bug: a click can only ever reach it by literally landing
// on the backdrop. Matches how app.js's own modals (feedbackModal etc.)
// close — a dedicated button/element, not a wrapper-level inference.
document.querySelector('#taskModal .tm-backdrop').addEventListener('click', closeTaskModal);
document.getElementById('tmClose').addEventListener('click', closeTaskModal);

init();
