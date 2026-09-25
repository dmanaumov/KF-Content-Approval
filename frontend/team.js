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
let pendingDeepLinkTaskId = null;
let statusOptions = []; // [{id,label}] — every raw "Статус" option, from GET /api/team/tasks
let keywordsPropertyFound = false;
let referencePropertyFound = false;
// Id архивных проектов (см. GET /api/team/tasks -> archivedProjectIds) —
// прячем их из фильтра по проекту (renderProjectFilterOptions), чтобы не
// мешали, но НЕ трогаем уже существующие карточки под таким проектом — они
// продолжают показываться в списке/календаре как обычно (см. запрос
// пользователя 2026-09-08).
let archivedProjectIds = new Set();
let boardId = null; // only needed to build /api/files/:boardId/:fileId src urls — see loadTasks()
let currentUser = null;
let currentAccess = null; // {admin,stat,ceo,staffProjectsPath,canBulkDelete} — from GET/POST /api/team/me|login, see showApp()
let teamProjects = null; // [{id,label}] — cached lazily, from GET /api/team/projects (see openCreateModal)
let teamUsers = null; // [{id,name}] — cached lazily, from GET /api/team/users (see populateAssigneeSelect)
// Массовые операции — «Выбрать» → выделить несколько карточек кликом →
// «Удалить выбранное» (см. setSelectMode ниже). Общий и для календаря, и
// для перечня карточек (по прямому запросу пользователя, 2026-09-25: «а
// теперь и в перечне карточек, но только для админа») — оба переключателя
// (teamCalSelectToggle/teamListSelectToggle) зовут один и тот же
// setSelectMode(), т.к. одновременно видна только ОДНА из двух вкладок.
// selectMode переключает клик по карточке между "открыть" и "выделить";
// selectedTaskIds — id выбранных карточек, а не сами объекты, чтобы не
// держать устаревшие ссылки после перерисовки списка/сетки.
let selectMode = false;
let selectedTaskIds = new Set();
const DELETE_SELECTED_LABEL = '🗑 Удалить выбранное';
const FILTERS_KEY = 'kf.team.filters.v1';
// Фильтр по проекту — влияет и на список, и на календарь-обзор (в отличие
// от статус-чипсов, которые применяются только к списку). Храним ID опции
// проекта (не label — id стабилен, если проект переименуют), персистится
// в localStorage тем же паттерном, что и FILTERS_KEY.
let projectFilterId = '';
const PROJECT_FILTER_KEY = 'kf.team.projectFilter.v1';
try { projectFilterId = localStorage.getItem(PROJECT_FILTER_KEY) || ''; } catch (e) {}

// --- Модалка карточки: состояние открытой карточки ---
let modalTaskId = null;
let activeTab = 'media';
let editingTitle = false;
let reorderMode = false;
let reorderIds = [];
let dateCalYear = null;
let dateCalMonth = null;
// Отдельная от dateCalYear/dateCalMonth пара — та управляет мини-пикером
// ОДНОЙ даты внутри модалки карточки, эта — общим календарём-обзором всех
// своих задач (см. openTeamCalendarView ниже), который открывается по
// кнопке 🗓️ в шапке, как в кабинете клиента.
let tcalYear = null;
let tcalMonth = null;
// true во время (и сразу после) реального drag-жеста по календарю-обзору —
// не даёт клику, которым браузер завершает drop, тут же открыть модалку
// карточки поверх только что перетащенной даты.
let calDragActive = false;
// Какой вид был открыт до раздела "Комментарии" (см. openTeamCommentsView
// ниже) — список или календарь-обзор — чтобы вернуться туда же, а не всегда
// на список, когда закроют "Комментарии".
let preCommentsView = 'list';
const scheduleCache = {}; // 'YYYY-MM' -> {days}, from GET /api/team/schedule
const teamCommentsCache = {}; // taskId -> [{id,authorId,authorName,text,createdAt,imageUrl}]
// A photo picked/uploaded for the NEXT message in each chat, before Send is
// pressed — { shareUrl } once the upload finished, or null. Uploaded eagerly
// on file pick (not on Send) so the compose box can show a preview + let the
// user remove it before sending, same UX as the Медиа-tab dropzone.
let pendingTeamImage = null;
let pendingClientImage = null;

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

// Russian plural: plural(1,'пост','поста','постов') → "пост" etc. Same
// implementation as frontend/app.js's — no shared common.js between pages
// (each is self-contained), needed here for the bulk-delete confirm() text.
function plural(n, one, few, many) {
  const n10 = n % 10;
  const n100 = n % 100;
  if (n10 === 1 && n100 !== 11) return one;
  if (n10 >= 2 && n10 <= 4 && (n100 < 10 || n100 >= 20)) return few;
  return many;
}

function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 3200);
}

// БАГ (найден 2026-09-24, жалоба «при импорте вышла ошибка», без деталей):
// раньше эта функция на !res.ok просто бросала `data.message || data.error
// || 'Ошибка запроса'` — и если сервер ответил телом БЕЗ этих двух полей
// (например /tasks/bulk-import: он при полном провале батча отвечает
// 400 с {created, failed, results} — там есть подробности по каждой
// строке, но нет верхнеуровневых message/error), вызывающий код получал
// голый "Ошибка запроса" и терял всю диагностику. Плюс если тело ответа
// вообще не JSON (например прокси/сервер вернул HTML/пустой ответ на 500),
// сообщение было тем же неинформативным "Ошибка запроса" без статуса и
// текста ответа. Теперь: (1) сетевая ошибка (fetch не достучался до
// сервера) отделена от ответа с ошибкой и явно помечена как таковая;
// (2) на не-JSON тело в сообщение попадает код ответа и кусок сырого
// текста; (3) на любой !res.ok — распарсенное тело кладётся в err.body,
// чтобы вызывающий код (см. submitBulkImportForm/submitClipboardImportForm)
// мог показать details (например results) вместо общей фразы.
async function teamApi(path, opts) {
  opts = opts || {};
  let res;
  try {
    res = await fetch(`/api/team${path}`, {
      method: opts.method || 'GET',
      headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
  } catch (err) {
    throw new Error('Не удалось связаться с сервером: ' + err.message);
  }
  const raw = await res.text();
  let data = {};
  let parseFailed = false;
  if (raw) {
    try { data = JSON.parse(raw); } catch (e) { parseFailed = true; }
  }
  if (!res.ok) {
    const message = data.message || data.error
      || (parseFailed
        ? `Сервер ответил ошибкой ${res.status}, ответ не в ожидаемом формате: ${raw.slice(0, 200) || '(пусто)'}`
        : `Сервер ответил ошибкой ${res.status}.`);
    const err = new Error(message);
    err.status = res.status;
    err.body = data;
    throw err;
  }
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
const adminLink = document.getElementById('adminLink');
const teamLoading = document.getElementById('teamLoading');
const teamEmpty = document.getElementById('teamEmpty');
const teamList = document.getElementById('teamList');
const teamFilters = document.getElementById('teamFilters');
const teamListSelectToggle = document.getElementById('teamListSelectToggle');
const teamListSelectBar = document.getElementById('teamListSelectBar');
const teamListSelectCount = document.getElementById('teamListSelectCount');
const teamListDeleteSelected = document.getElementById('teamListDeleteSelected');
const taskModal = document.getElementById('taskModal');
const tmHead = document.getElementById('tmHead');
const tmTabbar = document.getElementById('tmTabbar');
const tmBody = document.getElementById('tmBody');
const fabCreate = document.getElementById('fabCreate');
const createModal = document.getElementById('createModal');
const createForm = document.getElementById('createForm');
const cfTitle = document.getElementById('cfTitle');
const cfProject = document.getElementById('cfProject');
const cfNetwork = document.getElementById('cfNetwork');
const cfDate = document.getElementById('cfDate');
const cfStatus = document.getElementById('cfStatus');
const cfText = document.getElementById('cfText');
const cfReference = document.getElementById('cfReference');
const createError = document.getElementById('createError');
const cfSubmit = document.getElementById('cfSubmit');
// «Один пост» / «Импорт из файла» — вкладки внутри той же модалки
// #createModal (по прямому запросу: импорт должен жить внутри кнопки
// «Запланировать публикацию», а не отдельной FAB-кнопкой/модалкой).
const createTabBtnSingle = document.getElementById('createTabBtnSingle');
const createTabBtnImport = document.getElementById('createTabBtnImport');
const createTabBtnClipboard = document.getElementById('createTabBtnClipboard');
const createTabSingle = document.getElementById('createTabSingle');
const createTabImport = document.getElementById('createTabImport');
const createTabClipboard = document.getElementById('createTabClipboard');
const biForm = document.getElementById('biForm');
const biProject = document.getElementById('biProject');
const biAssignee = document.getElementById('biAssignee');
const biFile = document.getElementById('biFile');
const biError = document.getElementById('biError');
const biResults = document.getElementById('biResults');
const biSubmit = document.getElementById('biSubmit');
const cpForm = document.getElementById('cpForm');
const cpProject = document.getElementById('cpProject');
const cpAssignee = document.getElementById('cpAssignee');
const cpNetwork = document.getElementById('cpNetwork');
const cpPasteArea = document.getElementById('cpPasteArea');
const cpParseBtn = document.getElementById('cpParseBtn');
const cpConfirmSection = document.getElementById('cpConfirmSection');
const cpConfirmRows = document.getElementById('cpConfirmRows');
const cpError = document.getElementById('cpError');
const cpResults = document.getElementById('cpResults');
const cpSubmit = document.getElementById('cpSubmit');
const teamCalendarToggle = document.getElementById('teamCalendarToggle');
const teamListView = document.getElementById('teamListView');
const teamCalendarView = document.getElementById('teamCalendarView');
const teamCalBack = document.getElementById('teamCalBack');
const teamCalPrev = document.getElementById('teamCalPrev');
const teamCalNext = document.getElementById('teamCalNext');
const teamCalTitle = document.getElementById('teamCalTitle');
const teamCalendarGrid = document.getElementById('teamCalendarGrid');
const teamCalSelectToggle = document.getElementById('teamCalSelectToggle');
const teamCalSelectBar = document.getElementById('teamCalSelectBar');
const teamCalSelectCount = document.getElementById('teamCalSelectCount');
const teamCalDeleteSelected = document.getElementById('teamCalDeleteSelected');
const teamProjectFilterRow = document.getElementById('teamProjectFilterRow');
const teamProjectFilter = document.getElementById('teamProjectFilter');
const teamCommentsToggle = document.getElementById('teamCommentsToggle');
const teamCommentsView = document.getElementById('teamCommentsView');
const teamCommentsBack = document.getElementById('teamCommentsBack');
const fabChat = document.getElementById('fabChat');
const chatPanel = document.getElementById('chatPanel');
const chatPanelClose = document.getElementById('chatPanelClose');
const chatMessages = document.getElementById('chatMessages');
const chatSendForm = document.getElementById('chatSendForm');
const chatInput = document.getElementById('chatInput');
const chatSendBtn = document.getElementById('chatSendBtn');

function showLogin() {
  loginApp.hidden = false;
  teamApp.hidden = true;
}

function showApp(user, access) {
  loginApp.hidden = true;
  teamApp.hidden = false;
  currentAccess = access;
  teamUserName.textContent = [user.firstName, user.lastName].filter(Boolean).join(' ') || user.username || 'Команда';
  statLink.hidden = !(access && access.stat);
  // Кнопка «Проекты/Админка» — для админов/CEO и для ЛЮБОГО участника
  // проекта (editor ИЛИ admin — доступ к /admin с видимостью только своих
  // проектов) — сервер отдаёт staffProjectsPath тем, кто может зайти (см.
  // staffAuth/staffAccessFor в index.js); кто не может — кнопки нет.
  // РАСШИРЕНО 2026-09-25 (раньше это было admin-only, по прямому запросу
  // пользователя «проавить может каждый член команды проекта» — editor'ам
  // тоже нужно попасть на /admin, чтобы увидеть «Секретики» своего
  // проекта).
  adminLink.hidden = !(access && access.staffProjectsPath);
  if (access && access.staffProjectsPath) adminLink.href = access.staffProjectsPath;
  // «Выбрать» (массовое удаление, календарь И перечень карточек) — ЭТОТ
  // сигнал admin-уровня НЕ расширяли вместе с кнопкой «Админка» выше (по
  // прямому запросу пользователя, 2026-09-25: сперва «в календаре у
  // админа», затем «а теперь и в перечне карточек, но только для админа» —
  // это решение отдельно от «Секретиков», массовое удаление остаётся
  // строго admin-only). Раньше здесь тоже стоял staffProjectsPath — с тех
  // пор как ту кнопку открыли editor'ам, для массового удаления теперь свой
  // отдельный флаг, canBulkDelete (см. staffAccessFor в index.js). Сервер
  // всё равно перепроверяет это же самое на каждый taskId в
  // POST /tasks/bulk-delete — эта видимость только про UI, не про
  // настоящую границу доступа.
  teamCalSelectToggle.hidden = !(access && access.canBulkDelete);
  teamListSelectToggle.hidden = !(access && access.canBulkDelete);
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
  clearInterval(chatPollTimer);
  closeChatPanel();
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
  // Режим выбора (selectMode) — тот же чекбокс/паттерн, что у .cal-post в
  // календаре (см. renderTeamCalendarGrid) — см. комментарий там.
  const checkboxHtml = selectMode
    ? `<span class="team-task-check${selectedTaskIds.has(task.id) ? ' checked' : ''}" aria-hidden="true"></span>`
    : '';
  const selectedCls = selectMode && selectedTaskIds.has(task.id) ? ' selected' : '';
  return `<div class="team-task${urgent ? ' urgent' : ''}${selectedCls}" data-task-id="${esc(task.id)}">
    ${checkboxHtml}
    <div class="team-task-top">
      <div>
        ${task.projectLabel ? `<div class="team-task-project">${esc(task.projectLabel)}</div>` : ''}
        <div class="team-task-title">${socialBadge}${esc(displayTitle)}</div>
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

// Фильтр по проекту (см. projectFilterId выше) — опции строятся из того,
// что реально есть в currentTasks (те же проекты, что видит этот участник
// команды), а не из полного справочника GET /api/team/projects — не нужен
// лишний запрос, и не будет пустых опций "проект без единой моей задачи".
function renderProjectFilterOptions() {
  const seen = new Map(); // id -> label
  currentTasks.forEach((t) => {
    // Архивный проект не предлагаем в фильтре (см. archivedProjectIds выше)
    // — карточки под ним по-прежнему в списке, просто саму опцию фильтра
    // прячем, чтобы архивные проекты не мешали среди активных.
    if (t.projectId && !archivedProjectIds.has(t.projectId) && !seen.has(t.projectId)) {
      seen.set(t.projectId, t.projectLabel || t.projectId);
    }
  });
  if (seen.size < 2) {
    teamProjectFilterRow.hidden = true;
    // Один проект (или ни одного) — фильтровать нечего, сбрасываем, чтобы
    // не залипнуть на пустом списке, если раньше был выбран проект, а
    // теперь у пользователя остались задачи только по одному другому.
    if (seen.size < 2 && projectFilterId && ![...seen.keys()].includes(projectFilterId)) {
      projectFilterId = '';
      try { localStorage.setItem(PROJECT_FILTER_KEY, ''); } catch (e) {}
    }
    return;
  }
  teamProjectFilterRow.hidden = false;
  const options = [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1], 'ru'));
  if (projectFilterId && !seen.has(projectFilterId)) projectFilterId = ''; // выбранного проекта больше нет среди задач
  teamProjectFilter.innerHTML =
    '<option value="">Все проекты</option>' +
    options.map(([id, label]) => `<option value="${esc(id)}"${id === projectFilterId ? ' selected' : ''}>${esc(label)}</option>`).join('');
}

function projectFiltered(tasks) {
  return projectFilterId ? tasks.filter((t) => t.projectId === projectFilterId) : tasks;
}

function renderTasks() {
  const byProject = projectFiltered(currentTasks);
  const visible = activeStatuses
    ? byProject.filter((t) => activeStatuses.has(norm(t.statusLabel)))
    : byProject;
  if (!visible.length) {
    teamEmpty.textContent = currentTasks.length ? 'Нет задач с выбранными статусами/проектом.' : 'На вас пока нет ни одной задачи.';
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
    referencePropertyFound = !!data.referencePropertyFound;
    archivedProjectIds = new Set(data.archivedProjectIds || []);
    if (data.boardId) boardId = data.boardId;
    currentTasks = (data.tasks || []).slice().sort(byDeadline);
    renderChips();
    renderProjectFilterOptions();
    renderTasks();
    if (teamCalendarView && !teamCalendarView.hidden) renderTeamCalendarGrid();
    if (modalTaskId) renderModal(); // держим открытую карточку в актуальном состоянии после фонового обновления списка
    if (pendingDeepLinkTaskId) {
      const id = pendingDeepLinkTaskId;
      pendingDeepLinkTaskId = null;
      openDeepLinkedTask(id);
    }
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
    startChatPolling();
  } catch (err) {
    showLogin();
  }
}

// ============================== Календарь-обзор (🗓️ в шапке) ==============================
// Тот же принцип, что renderCalendar() в frontend/app.js (кабинет клиента):
// месячная сетка, посты-кнопки в ячейке дня, цветной маркер по статусу.
// Данные — currentTasks (уже отфильтрованы по исполнителю сервером, см.
// loadTasks() выше), поэтому никакого отдельного запроса не требуется.
// Единственное принципиально новое здесь — перетаскивание карточки на
// другой день меняет её дату публикации через уже существующий
// POST /api/team/tasks/:id/date (тот же эндпоинт, что использует мини-
// пикер даты внутри модалки).
const TEAM_CAL_DOT_CLASS = { waiting: 'waiting', approved: 'approved', changes: 'changes', published: 'published' };
function teamCalMarkerHtml(task) {
  if (isUrgentTask(task)) return '<span class="cal-mark fire" aria-hidden="true">🔥</span>';
  // task.status — только 5 клиентских состояний (см. taskMapper.js); всё
  // остальное (В ПРОЦЕССЕ, ТЗ РАЙТЕРУ, ЗАПЛАНИРОВАНО, "Не начато"...) —
  // внутренние этапы, для которых в этом обзоре один общий серый маркер.
  const cls = TEAM_CAL_DOT_CLASS[task.status] || 'not-started';
  return `<span class="cal-mark dot ${cls}" aria-hidden="true"></span>`;
}

function renderTeamCalendarGrid() {
  if (tcalYear == null) {
    const now = new Date();
    tcalYear = now.getFullYear();
    tcalMonth = now.getMonth();
  }
  teamCalTitle.textContent = `${MONTHS_RU_FULL[tcalMonth]} ${tcalYear}`;

  const byDate = new Map();
  for (const t of projectFiltered(currentTasks)) {
    if (!t.publishDate) continue;
    if (!byDate.has(t.publishDate)) byDate.set(t.publishDate, []);
    byDate.get(t.publishDate).push(t);
  }

  const first = new Date(Date.UTC(tcalYear, tcalMonth, 1));
  const leadDow = first.getUTCDay() || 7; // Пн=1..Вс=7
  const lead = leadDow - 1;
  const daysInMonth = new Date(Date.UTC(tcalYear, tcalMonth + 1, 0)).getUTCDate();
  const totalCells = Math.ceil((lead + daysInMonth) / 7) * 7;
  const gridStart = new Date(Date.UTC(tcalYear, tcalMonth, 1 - lead));

  const now = new Date();
  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

  const cells = [];
  for (let i = 0; i < totalCells; i++) {
    const d = new Date(gridStart);
    d.setUTCDate(gridStart.getUTCDate() + i);
    const dateStr = d.toISOString().slice(0, 10);
    const inMonth = d.getUTCMonth() === tcalMonth;
    const dayTasks = (byDate.get(dateStr) || []).slice().sort(byDeadline);
    const posts = dayTasks
      .map((t) => {
        const { social, bare } = splitTitle(t.title);
        const socialBadge = social
          ? `<span class="social-badge" style="background:${esc(social.color)}" title="${esc(social.label)}">${esc(social.short)}</span>`
          : '';
        const title = stripAiTag(bare);
        // Всплывающая подсказка (нативный title, без доп. вёрстки) — карточка
        // в ячейке слишком мелкая, чтобы уместить всё сразу, а на клик уже
        // занят открытием модалки — поэтому вся сводка на наведение.
        const tipLines = [
          t.projectLabel || '',
          t.publishDate ? t.publishDate.split('-').reverse().join('.') : '',
          t.statusLabel || '',
          title,
          (t.keywords || '').trim(),
        ].filter(Boolean);
        // Режим выбора (selectMode) — маленький чекбокс перед маркером
        // статуса + подсветка всей кнопки классом .selected; drag выключен
        // (перетаскивание даты не должно случайно срабатывать посреди
        // выбора карточек для массового удаления).
        const checkboxHtml = selectMode
          ? `<span class="cal-post-check${selectedTaskIds.has(t.id) ? ' checked' : ''}" aria-hidden="true"></span>`
          : '';
        const selectedCls = selectMode && selectedTaskIds.has(t.id) ? ' selected' : '';
        return `<button type="button" class="cal-post${selectedCls}" draggable="${selectMode ? 'false' : 'true'}" data-task-id="${esc(t.id)}" title="${esc(tipLines.join('\n'))}">${checkboxHtml}${teamCalMarkerHtml(t)}<span class="cal-post-body"><span class="cal-post-title">${socialBadge}${esc(title)}</span></span></button>`;
      })
      .join('');
    const cls = `cal-day${inMonth ? '' : ' other-month'}${dateStr === todayStr ? ' today' : ''}`;
    cells.push(`<div class="${cls}" data-date="${dateStr}"><div class="cal-day-num">${d.getUTCDate()}</div>${posts}</div>`);
  }
  teamCalendarGrid.innerHTML = cells.join('');
}

// Иконка в шапке отражает вид, в который попадёшь по клику (не текущий) —
// на доске задач показываем 🗓️ "открыть календарь", в календаре — 📋
// "вернуться на доску задач".
function updateTeamCalendarToggleIcon(calendarOpen) {
  const icon = teamCalendarToggle.querySelector('span');
  if (calendarOpen) {
    icon.textContent = '📋';
    teamCalendarToggle.title = 'Доска задач';
    teamCalendarToggle.setAttribute('aria-label', 'Доска задач');
  } else {
    icon.textContent = '🗓️';
    teamCalendarToggle.title = 'Календарь публикаций';
    teamCalendarToggle.setAttribute('aria-label', 'Календарь публикаций');
  }
}

function openTeamCalendarView() {
  setSelectMode(false); // режим выбора не переживает переключение вкладок — проще и предсказуемее, чем тащить выбор между списком и календарём
  teamListView.hidden = true;
  fabCreate.hidden = true;
  teamCalendarView.hidden = false;
  updateTeamCalendarToggleIcon(true);
  renderTeamCalendarGrid();
}

function closeTeamCalendarView() {
  teamListView.hidden = false;
  fabCreate.hidden = false;
  teamCalendarView.hidden = true;
  updateTeamCalendarToggleIcon(false);
  setSelectMode(false); // уходя из календаря, не тащим выбор с собой на следующее открытие
}

function teamCalendarToggleClick() {
  if (teamCalendarView.hidden) openTeamCalendarView(); else closeTeamCalendarView();
}

// --- «Выбрать» / массовое удаление — общее для календаря (teamCalSelect*)
// и перечня карточек (teamListSelect*), видно только админам (см.
// showApp()). По прямому запросу пользователя: сперва календарь
// (2026-09-25: «в календаре у админа должна появиться кнопка ВЫБРАТЬ для
// массовых операций + последующее удаление выбранных постов»), затем в тот
// же день — «а теперь и в перечне карточек, но только для админа». Оба
// переключателя зовут один и тот же setSelectMode() — одновременно видна
// только ОДНА из двух вкладок (список/календарь), поэтому общее состояние
// (selectMode/selectedTaskIds) не конфликтует. ---
function updateSelectCounts() {
  const n = selectedTaskIds.size;
  teamCalSelectCount.textContent = `Выбрано: ${n}`;
  teamCalDeleteSelected.disabled = n === 0;
  teamListSelectCount.textContent = `Выбрано: ${n}`;
  teamListDeleteSelected.disabled = n === 0;
}

function setSelectMode(on) {
  selectMode = on;
  if (!on) selectedTaskIds.clear();
  const label = on ? 'Отмена' : 'Выбрать';
  teamCalSelectToggle.textContent = label;
  teamCalSelectToggle.classList.toggle('active', on);
  teamCalSelectBar.hidden = !on;
  teamListSelectToggle.textContent = label;
  teamListSelectToggle.classList.toggle('active', on);
  teamListSelectBar.hidden = !on;
  updateSelectCounts();
  // Перерисовать только видимую сейчас вкладку — с чекбоксами/без и (в
  // календаре) без drag; другая вкладка перерисуется сама при следующем
  // открытии (openTeamCalendarView/renderTasks уже читают актуальный
  // selectMode на тот момент).
  if (teamCalendarView && !teamCalendarView.hidden) renderTeamCalendarGrid();
  if (!teamListView.hidden) renderTasks();
}

function toggleTaskSelection(taskId) {
  if (selectedTaskIds.has(taskId)) selectedTaskIds.delete(taskId);
  else selectedTaskIds.add(taskId);
  updateSelectCounts();
}

async function deleteSelectedTasks() {
  const taskIds = [...selectedTaskIds];
  if (!taskIds.length) return;
  const word = plural(taskIds.length, 'пост', 'поста', 'постов');
  if (!confirm(`Удалить выбранные ${taskIds.length} ${word}? Это нельзя отменить.`)) return;
  const buttons = [teamCalDeleteSelected, teamListDeleteSelected];
  buttons.forEach((b) => { b.disabled = true; b.innerHTML = 'Удаляем…'; });
  toast('Удаляем выбранные посты — идёт обработка…');
  try {
    const data = await teamApi('/tasks/bulk-delete', { method: 'POST', body: { taskIds } });
    // Убираем удалённые карточки из currentTasks, чтобы не ждать полной
    // перезагрузки списка — тот же приём, что и у одиночного удаления
    // карточки в модалке.
    const deletedIds = new Set((data.results || []).filter((r) => r.ok).map((r) => r.taskId));
    currentTasks = currentTasks.filter((t) => !deletedIds.has(t.id));
    const failed = (data.results || []).filter((r) => !r.ok);
    if (data.deleted) {
      toast(`Удалено постов: ${data.deleted}${data.failed ? `, ошибок: ${data.failed}` : ''}`);
    }
    if (failed.length) {
      // Не проваливаемся молча — конкретные причины (например, «Нужны права
      // администратора на этот проект») важно показать, а не просто "N ошибок".
      toast(failed.map((r) => r.error).join('; '));
    }
    buttons.forEach((b) => { b.innerHTML = DELETE_SELECTED_LABEL; }); // иначе кнопка так и останется "Удаляем…" при следующем входе в режим выбора
    setSelectMode(false);
    renderProjectFilterOptions();
  } catch (err) {
    toast('Не удалось удалить посты: ' + err.message);
    buttons.forEach((b) => { b.disabled = selectedTaskIds.size === 0; b.innerHTML = DELETE_SELECTED_LABEL; });
  }
}

// Раздел "Комментарии" (заглушка — см. запрос пользователя 2026-09-08):
// в будущем сюда будет стекаться общая лента комментариев, которые
// посетители и гости оставляют на опубликованных постах, автоматически
// разобранная по тональности (позитив/нейтрально/негатив, последние —
// подсвечены, чтобы команда могла оперативно их отработать). Источники
// комментариев (соцсети клиента и т.п.) пока не подключены — сам источник
// данных и то, как именно их собирать, нужно обсудить отдельно, поэтому
// пока это просто видимая закладка с описанием будущей функциональности,
// без реальных данных.
//
// Третий полноэкранный вид наравне со списком и календарём-обзором —
// открывается поверх того, что было показано (список ИЛИ календарь), и
// при закрытии возвращает именно его, а не всегда список.
function openTeamCommentsView() {
  setSelectMode(false); // уходя в «Комментарии», не оставляем висящий режим выбора на список/календарь
  preCommentsView = (teamCalendarView && !teamCalendarView.hidden) ? 'calendar' : 'list';
  teamListView.hidden = true;
  teamCalendarView.hidden = true;
  fabCreate.hidden = true;
  teamCommentsView.hidden = false;
}

function closeTeamCommentsView() {
  teamCommentsView.hidden = true;
  fabCreate.hidden = false;
  if (preCommentsView === 'calendar') {
    teamCalendarView.hidden = false;
    renderTeamCalendarGrid();
  } else {
    teamListView.hidden = false;
  }
}

// ============================== Чат команды (💬 «Открыть чат») ==============================
// Панель поверх кабинета с реальной перепиской в команднОм канале Mattermost
// (config.smmTeamChannelName на бэкенде) — каждый видит и пишет как СВОЙ
// реальный аккаунт Mattermost (сервер использует токен именно этой сессии),
// не общий бот. Кнопка акцентная (фирменный градиент + дыхание тени, как у
// «Запланировать публикацию»), пока есть непрочитанные — опрашивается ниже.
const CHAT_POLL_MS = 25000;
let chatUnreadCount = 0;
let chatPollTimer = null;
let chatPanelOpen = false;

function updateChatButtonState() {
  fabChat.classList.toggle('fab-chat-unread', chatUnreadCount > 0);
  fabChat.setAttribute('aria-label', chatUnreadCount > 0 ? `Открыть чат (есть новые сообщения)` : 'Открыть чат');
}

async function refreshChatStatus() {
  if (chatPanelOpen) return; // пока панель открыта, счётчик и так будет обнулён при закрытии/загрузке сообщений
  try {
    const data = await teamApi('/chat/status');
    chatUnreadCount = data.unread || 0;
    updateChatButtonState();
  } catch (err) {
    // тихо — это фоновый опрос, не отвлекаем тостами на каждый неудачный тик
  }
}

function startChatPolling() {
  refreshChatStatus();
  clearInterval(chatPollTimer);
  chatPollTimer = setInterval(refreshChatStatus, CHAT_POLL_MS);
}

function formatChatTime(ms) {
  if (!ms) return '';
  try {
    return new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(ms));
  } catch (e) {
    return '';
  }
}

// Сообщения внутреннего «Цербер» (ИИ-ревью) в чате команды — автор пишется
// automation-API в POST /api/automation/tasks/:taskId/team-comment (backend/
// src/index.js, CERBERUS_AUTHOR_NAME). Помечаем золотым бейджем, как и «Клиент/
// Агентство» в чате клиента, чтобы сразу читался источник замечания. Проверка
// именно по имени (а не authorId) — authorId у Цербера сконстантён на бэкенде,
// но имя — единый распознаваемый договорной маркер между этим файлом и тем.
function authorIsCerberus(name) {
  return String(name || '').toLowerCase().includes('цербер');
}

function chatMessageHtml(m) {
  return `<div class="tm-chat-msg${m.mine ? ' mine' : ''}">
    <div class="tm-chat-msg-author${authorIsCerberus(m.authorName) ? ' cerberus' : ''}">${esc(m.authorName || 'Команда')}</div>
    <div class="tm-chat-msg-text">${esc(m.text || '')}</div>
    <div class="tm-chat-msg-time">${formatChatTime(m.createAt)}</div>
  </div>`;
}

function scrollChatToBottom() {
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

async function openChatPanel() {
  chatPanelOpen = true;
  chatPanel.hidden = false;
  chatMessages.innerHTML = '<div class="tm-chat-empty">Загружаем сообщения…</div>';
  try {
    const data = await teamApi('/chat/messages');
    const items = data.messages || [];
    chatMessages.innerHTML = items.length
      ? items.map(chatMessageHtml).join('')
      : '<div class="tm-chat-empty">Сообщений пока нет — напишите первым!</div>';
    scrollChatToBottom();
    chatUnreadCount = 0;
    updateChatButtonState();
  } catch (err) {
    chatMessages.innerHTML = `<div class="error-box">${esc(err.message)}</div>`;
  }
  chatInput.focus();
}

function closeChatPanel() {
  chatPanelOpen = false;
  chatPanel.hidden = true;
}

async function sendChatMessage(e) {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;
  chatSendBtn.disabled = true;
  try {
    const data = await teamApi('/chat/messages', { method: 'POST', body: { text } });
    const empty = chatMessages.querySelector('.tm-chat-empty');
    if (empty) empty.remove();
    chatMessages.insertAdjacentHTML('beforeend', chatMessageHtml(data.message));
    scrollChatToBottom();
    chatInput.value = '';
  } catch (err) {
    toast('Не удалось отправить: ' + err.message);
  } finally {
    chatSendBtn.disabled = false;
  }
}

fabChat.addEventListener('click', openChatPanel);
chatPanelClose.addEventListener('click', closeChatPanel);
chatPanel.querySelector('.chat-panel-backdrop').addEventListener('click', closeChatPanel);
chatSendForm.addEventListener('submit', sendChatMessage);
chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendChatMessage(e);
  }
});

async function moveTaskToDate(taskId, dateStr) {
  const task = currentTasks.find((t) => t.id === taskId);
  const prevDate = task ? task.publishDate : null;
  if (prevDate === dateStr) return;
  // Оптимистично — сразу перерисовываем сетку с постом на новом дне, не
  // дожидаясь ответа сервера (drag-and-drop должен ощущаться мгновенным);
  // при ошибке откатываем дату обратно и перерисовываем ещё раз.
  if (task) task.publishDate = dateStr;
  renderTeamCalendarGrid();
  try {
    const data = await teamApi(`/tasks/${encodeURIComponent(taskId)}/date`, { method: 'POST', body: { date: dateStr } });
    applyUpdatedTask(data.task);
    if (teamCalendarView && !teamCalendarView.hidden) renderTeamCalendarGrid();
    toast('Дата публикации изменена');
  } catch (err) {
    if (task) task.publishDate = prevDate;
    renderTeamCalendarGrid();
    toast('Не удалось изменить дату: ' + err.message);
  }
}

teamCalendarToggle.addEventListener('click', teamCalendarToggleClick);
teamCalBack.addEventListener('click', closeTeamCalendarView);
teamCalSelectToggle.addEventListener('click', () => setSelectMode(!selectMode));
teamCalDeleteSelected.addEventListener('click', deleteSelectedTasks);
teamListSelectToggle.addEventListener('click', () => setSelectMode(!selectMode));
teamListDeleteSelected.addEventListener('click', deleteSelectedTasks);
teamCommentsToggle.addEventListener('click', openTeamCommentsView);
teamCommentsBack.addEventListener('click', closeTeamCommentsView);
teamCalPrev.addEventListener('click', () => {
  tcalMonth--;
  if (tcalMonth < 0) { tcalMonth = 11; tcalYear--; }
  renderTeamCalendarGrid();
});
teamCalNext.addEventListener('click', () => {
  tcalMonth++;
  if (tcalMonth > 11) { tcalMonth = 0; tcalYear++; }
  renderTeamCalendarGrid();
});

// Если среди видимых этому участнику задач (currentTasks — тот же источник,
// что и у renderProjectFilterOptions) ровно ОДИН проект — однозначно ясно,
// куда класть быстро созданную карточку, спрашивать не нужно. Если проектов
// 0 или 2+ — не угадываем, см. quickCreatePost ниже.
function soleProjectId() {
  const seen = new Set();
  for (const t of currentTasks) { if (t.projectId) seen.add(t.projectId); }
  return seen.size === 1 ? [...seen][0] : null;
}

// Быстрое создание поста с пустой ячейки: первый клик по пустому месту дня
// показывает акцентную кнопку "+" (в этой самой ячейке), второй клик — уже
// по самой кнопке — создаёт карточку "Новый пост" на эту дату и сразу
// открывает её модалку для редактирования (без перехода куда-либо ещё).
// Проект берётся из фильтра сверху, если он выбран; иначе — если у этого
// участника видна работа только по ОДНОМУ проекту, берём его автоматически
// (частый случай — фильтр в принципе скрыт, когда проектов меньше двух, см.
// renderProjectFilterOptions). Если проект неоднозначен (несколько проектов
// и фильтр не выбран, либо вообще нет ни одной задачи, откуда угадать) —
// РАНЬШЕ здесь просто отказывали созданием toast'ом, из-за чего клик по "+"
// выглядел как "ничего не произошло" всякий раз, когда участник видит
// задачи только одного проекта БЕЗ фильтра (тот скрыт при <2 проектах) —
// теперь вместо отказа открываем полную форму "Запланировать публикацию"
// (см. openCreateModal), предзаполненную датой и заголовком — так клик по
// "+" гарантированно к чему-то приводит.
async function quickCreatePost(dateStr) {
  teamCalendarGrid.querySelectorAll('.cal-day-add-btn').forEach((b) => b.remove());
  const projectId = projectFilterId || soleProjectId();
  if (!projectId) {
    openCreateModal({ date: dateStr, title: 'Новый пост' });
    return;
  }
  try {
    const data = await teamApi('/tasks', {
      method: 'POST',
      body: { title: 'Новый пост', projectId, publishDate: dateStr, status: resolveStatusLabel(QUICK_CREATE_STATUS_LABEL) },
    });
    applyUpdatedTask(data.task);
    renderProjectFilterOptions();
    if (teamCalendarView && !teamCalendarView.hidden) renderTeamCalendarGrid();
    openTaskModal(data.task.id);
  } catch (err) {
    toast('Не удалось создать пост: ' + err.message);
  }
}

// Клик по карточке в календаре — открыть её же модалку (как в списке), но
// не сразу после drag-жеста (см. calDragActive: браузер шлёт click следом
// за drop на том же элементе). Клик по ПУСТОМУ месту ячейки дня — см.
// quickCreatePost выше.
teamCalendarGrid.addEventListener('click', (e) => {
  if (calDragActive) return;
  const post = e.target.closest('.cal-post');
  // Режим выбора — клик по карточке переключает выделение вместо открытия
  // модалки; клик по пустой ячейке (кнопка "+" быстрого добавления) в этом
  // режиме тоже отключён — добавлять новые посты посреди массового
  // удаления не имеет смысла.
  if (selectMode) {
    if (post) {
      post.classList.toggle('selected');
      post.querySelector('.cal-post-check')?.classList.toggle('checked');
      toggleTaskSelection(post.dataset.taskId);
    }
    return;
  }
  const addBtn = e.target.closest('.cal-day-add-btn');
  if (addBtn) {
    quickCreatePost(addBtn.closest('.cal-day').dataset.date);
    return;
  }
  if (post) {
    openTaskModal(post.dataset.taskId);
    return;
  }
  const day = e.target.closest('.cal-day');
  if (!day) return;
  const already = day.querySelector('.cal-day-add-btn');
  teamCalendarGrid.querySelectorAll('.cal-day-add-btn').forEach((b) => b.remove());
  if (already) return; // повторный клик по той же ячейке — просто убрать "+"
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'cal-day-add-btn';
  btn.setAttribute('aria-label', 'Добавить пост на этот день');
  btn.textContent = '+';
  day.appendChild(btn);
});

// Клик мимо календаря вообще — убрать зависшую кнопку "+", если её не
// использовали.
document.addEventListener('click', (e) => {
  if (teamCalendarGrid && !teamCalendarGrid.contains(e.target)) {
    teamCalendarGrid.querySelectorAll('.cal-day-add-btn').forEach((b) => b.remove());
  }
});

// --- Drag-and-drop переноса даты: HTML5 native DnD, делегировано на грид
// целиком (ячейки/карточки перерисовываются при каждом render, поэтому
// именно делегирование, а не listener на каждой карточке). ---
teamCalendarGrid.addEventListener('dragstart', (e) => {
  if (selectMode) return; // draggable="false" в разметке уже не должен пускать сюда браузер, но на всякий случай
  const btn = e.target.closest('.cal-post');
  if (!btn) return;
  calDragActive = true;
  btn.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', btn.dataset.taskId);
});
teamCalendarGrid.addEventListener('dragend', (e) => {
  const btn = e.target.closest('.cal-post');
  if (btn) btn.classList.remove('dragging');
  teamCalendarGrid.querySelectorAll('.cal-day.drag-over').forEach((el) => el.classList.remove('drag-over'));
  // Сброс calDragActive с небольшой задержкой — click, которым браузер
  // завершает drag, приходит уже ПОСЛЕ dragend.
  setTimeout(() => { calDragActive = false; }, 50);
});
teamCalendarGrid.addEventListener('dragover', (e) => {
  const day = e.target.closest('.cal-day');
  if (!day) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  day.classList.add('drag-over');
});
teamCalendarGrid.addEventListener('dragleave', (e) => {
  const day = e.target.closest('.cal-day');
  if (day && !day.contains(e.relatedTarget)) day.classList.remove('drag-over');
});
teamCalendarGrid.addEventListener('drop', (e) => {
  const day = e.target.closest('.cal-day');
  if (!day) return;
  e.preventDefault();
  day.classList.remove('drag-over');
  const taskId = e.dataTransfer.getData('text/plain');
  const dateStr = day.dataset.date;
  if (taskId && dateStr) moveTaskToDate(taskId, dateStr);
});

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

// Deep link: отражение ?task=<id> в URL кабинета команды (ссылку на карточку
// сотрудник видит в шапке модалки — см. copy-card-link). Карточка может не
// быть в currentTasks (она not "моя"), поэтому при несовпадении дёргаем
// GET /api/team/tasks/:taskId (тот же список, но одну) и открываем её.
async function openDeepLinkedTask(taskId) {
  const existing = currentTasks.find((t) => t.id === taskId);
  if (existing) { openTaskModal(taskId); return; }
  try {
    const res = await fetch(`/api/team/tasks/${encodeURIComponent(taskId)}`);
    if (res.status === 401) { showLogin(); return; }
    const data = await res.json();
    if (!res.ok) { toast(data.message || 'Не удалось открыть карточку'); return; }
    currentTasks.push(data.task);
    renderTasks();
    openTaskModal(taskId);
  } catch (err) {
    toast('Не удалось открыть карточку: ' + err.message);
  }
}

function closeTaskModal() {
  taskModal.hidden = true;
  modalTaskId = null;
}

// --- «Запланировать публикацию» — создание НОВОЙ карточки с нуля ---
// (см. POST /api/team/tasks в backend/src/index.js). Единственное место в
// этом кабинете, где карточки ещё не существует — везде остальном (медиа,
// текст, статус/дата/сеть, чаты) речь об уже существующей.

// "ЗАПЛАНИРОВАНО" — реальная опция на свойстве "Статус" этого борда,
// отдельная от 5 клиентских статусов (см. GRAY_STATUSES выше) — то, что
// команда сама называет "запланировано" в своём внутреннем пайплайне.
// Подставляется по умолчанию в форму, если такая опция вообще есть на
// борде; если нет (переименовали/убрали) — просто первая опция в списке,
// форма всё равно рабочая, просто без "умного" дефолта.
const DEFAULT_CREATE_STATUS_LABEL = 'ЗАПЛАНИРОВАНО';

// Быстрое создание кликом по "+" в ячейке календаря (см. quickCreatePost) —
// карточка создаётся МГНОВЕННО, без формы, поэтому статус должен быть
// заведомо существующим на КАЖДОМ борде, а не специфичным для конкретного
// проекта названием вроде "ЗАПЛАНИРОВАНО" (которое на части бордов зовётся
// иначе, например "Сдали/Запланировано" — именно так и падал POST /tasks
// с ошибкой "Статус не найден"). "Не начато" — тот же статус, что бэкенд
// использует для показа карточек в клиентском календаре без старта работы
// (см. config.notStartedLabel), обязан существовать на борде для этой
// фичи — и по смыслу отлично подходит для только что созданной пустой
// карточки. resolveStatusLabel ниже всё равно подстрахован fallback'ом.
const QUICK_CREATE_STATUS_LABEL = 'Не начато';

// Сопоставляет желаемое название статуса с реальной опцией на борде
// (регистр/пробелы не важны — см. norm) и подстраховывается на случай,
// если такой опции вообще нет (переименовали/убрали на конкретном борде):
// тогда просто берём первую доступную опцию, лишь бы запрос не упал.
function resolveStatusLabel(preferredLabel) {
  const match = statusOptions.find((o) => norm(o.label) === norm(preferredLabel));
  if (match) return match.label;
  return statusOptions.length ? statusOptions[0].label : preferredLabel;
}

function populateNetworkSelectInto(selectEl) {
  selectEl.innerHTML = '<option value="">Не выбрана</option>' +
    Object.entries(SOCIAL_MAP).map(([key, s]) => `<option value="${esc(key)}">${esc(s.label)}</option>`).join('');
}

function populateNetworkSelect() {
  populateNetworkSelectInto(cfNetwork);
}

function populateStatusSelect() {
  if (!statusOptions.length) {
    cfStatus.innerHTML = '<option value="">(нет опций статуса на борде)</option>';
    return;
  }
  cfStatus.innerHTML = statusOptions.map((o) => `<option value="${esc(o.label)}">${esc(o.label)}</option>`).join('');
  const preferred = statusOptions.find((o) => norm(o.label) === norm(DEFAULT_CREATE_STATUS_LABEL));
  cfStatus.value = preferred ? preferred.label : statusOptions[0].label;
}

// Общая реализация — см. populateProjectSelectInto() ниже (введена вместе
// с импортом контент-плана, чтобы оба select'а, cfProject и biProject,
// читали один и тот же кэш teamProjects вместо двух независимых походов за
// GET /api/team/projects).
// По тому же запросу, что и автоподстановка проекта в буфере обмена (см.
// populateClipboardImportProjectSelect) — раз уже завели этот приём для
// одной вкладки модалки, логично не оставлять его несогласованным с
// остальными двумя: подставляем текущий проект из общего фильтра списка/
// календаря и здесь.
async function populateProjectSelect() {
  await populateProjectSelectInto(cfProject);
  if (projectFilterId && teamProjects && teamProjects.some((p) => p.id === projectFilterId)) {
    cfProject.value = projectFilterId;
  }
}

function todayIsoDate() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

// Дата поста должна быть в будущем, но не дальше чем на 2 месяца — та же
// граница, что сервер проверяет через validateTeamPublishDate() (по
// московскому времени); это клиентская копия для мгновенной подсказки в UI,
// финальную проверку всё равно делает сервер.
function maxIsoDate() {
  const d = new Date();
  d.setMonth(d.getMonth() + 2);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Вкладки внутри #createModal — «Одиночный» (createForm) / «Пакетный» (biForm,
// JSON-файл) / «Буфер обмена» (cpForm, вставка из Google Таблиц), см.
// .create-tabs/.create-tab в team.css. Переключение не сбрасывает формы —
// только показывает/прячет нужную панель и не мешает уже введённым данным
// на другой вкладке, пока модалка открыта.
function setCreateTab(tab) {
  const btns = { single: createTabBtnSingle, import: createTabBtnImport, clipboard: createTabBtnClipboard };
  const panels = { single: createTabSingle, import: createTabImport, clipboard: createTabClipboard };
  Object.keys(btns).forEach((key) => {
    const active = key === tab;
    btns[key].classList.toggle('active', active);
    btns[key].setAttribute('aria-selected', String(active));
    panels[key].hidden = !active;
  });
  if (tab === 'single') setTimeout(() => cfTitle.focus(), 60);
}

// prefill — опционально {date, title}: используется при переходе сюда из
// quickCreatePost (клик "+" в пустой ячейке календаря, когда проект
// неоднозначен) — дата и заголовок уже известны, остаётся только выбрать
// проект и подтвердить, а не заполнять форму с нуля.
function openCreateModal(prefill = {}) {
  createForm.reset();
  createError.hidden = true;
  cfDate.min = todayIsoDate();
  cfDate.max = maxIsoDate();
  cfDate.value = prefill.date || '';
  if (prefill.title) cfTitle.value = prefill.title;
  populateNetworkSelect();
  populateStatusSelect();
  populateProjectSelect(); // async — fine, form is usable the moment it resolves
  biForm.reset();
  biError.hidden = true;
  biResults.hidden = true;
  biResults.innerHTML = '';
  populateBulkImportProjectSelect();
  populateAssigneeSelect(biAssignee);
  cpForm.reset();
  cpError.hidden = true;
  cpResults.hidden = true;
  cpResults.innerHTML = '';
  resetCpConfirm();
  populateNetworkSelectInto(cpNetwork);
  populateClipboardImportProjectSelect();
  populateAssigneeSelect(cpAssignee);
  setCreateTab('single');
  createModal.hidden = false;
  // Чуть отложенный фокус — модалка ещё доигрывает открытие (см. tm-modal),
  // мгновенный focus() на некоторых мобильных браузерах дёргает раскладку.
  setTimeout(() => cfTitle.focus(), 60);
}

function closeCreateModal() {
  createModal.hidden = true;
}

async function submitCreateForm(e) {
  e.preventDefault();
  createError.hidden = true;
  const title = cfTitle.value.trim();
  const projectId = cfProject.value;
  const date = cfDate.value;
  if (!title || !projectId || !date) {
    createError.textContent = 'Заполните заголовок, проект и дату публикации.';
    createError.hidden = false;
    return;
  }
  cfSubmit.disabled = true;
  const originalLabel = cfSubmit.innerHTML;
  cfSubmit.innerHTML = 'Планируем…';
  try {
    const data = await teamApi('/tasks', {
      method: 'POST',
      body: {
        title,
        projectId,
        network: cfNetwork.value || undefined,
        publishDate: date,
        status: cfStatus.value || undefined,
        text: cfText.value.trim() || undefined,
        reference: cfReference.value.trim() || undefined,
      },
    });
    applyUpdatedTask(data.task);
    closeCreateModal();
    toast('Публикация запланирована на ' + date.split('-').reverse().join('.'));
    // Сразу открываем свежесозданную карточку — обычно после «запланировать»
    // логично сразу докинуть медиа/текст, а не искать её в списке заново.
    openTaskModal(data.task.id);
  } catch (err) {
    createError.textContent = err.message;
    createError.hidden = false;
  } finally {
    cfSubmit.disabled = false;
    cfSubmit.innerHTML = originalLabel;
  }
}

// --- «Импорт контент-плана» — пакетное создание карточек из JSON-файла
// (POST /api/team/tasks/bulk-import, см. его комментарий в index.js). Одна
// запись файла = { date?, network?, text?, keywords? } — без отдельного
// заголовка: бэкенд сам собирает его из keywords (если есть) или первых 60
// символов text. Проект выбирается один раз на весь файл, в самих записях
// его нет (см. GET /content-plan-example.json — статическая заготовка,
// открывается прямо по ссылке «Скачать пример файла» под полем выбора
// файла, ничего дополнительно готовить не нужно).
async function populateBulkImportProjectSelect() {
  await populateProjectSelectInto(biProject);
  if (projectFilterId && teamProjects && teamProjects.some((p) => p.id === projectFilterId)) {
    biProject.value = projectFilterId;
  }
}

// populateProjectSelect() уже кэширует teamProjects — вынесено в общую
// функцию, чтобы оба select'а (cfProject и biProject) читали один и тот же
// кэш вместо двух независимых походов за GET /api/team/projects.
async function populateProjectSelectInto(selectEl) {
  if (!teamProjects) {
    try {
      const data = await teamApi('/projects');
      teamProjects = data.projects || [];
    } catch (err) {
      selectEl.innerHTML = '<option value="" disabled selected>Не удалось загрузить проекты</option>';
      toast('Не удалось загрузить список проектов: ' + err.message);
      return;
    }
  }
  if (!teamProjects.length) {
    selectEl.innerHTML = '<option value="" disabled selected>Нет ни одного проекта на борде</option>';
    return;
  }
  selectEl.innerHTML = '<option value="" disabled selected>Выберите проект…</option>' +
    teamProjects.map((p) => `<option value="${esc(p.id)}">${esc(p.label)}</option>`).join('');
}

// «Ответственный» — GET /api/team/users (id+имя всей команды), общий кэш
// teamUsers, тем же паттерном, что populateProjectSelectInto выше для
// teamProjects. Добавлено 2026-09-25 по прямому запросу: «при массовой
// загрузке нам надо выбирать ответственного за создаваемые карточки» —
// раньше POST /tasks/bulk-import всегда молча назначал импортируемые
// карточки на того, кто нажал «Импортировать»/«Создать пост» (см.
// комментарий у самого роута в index.js), что неверно всякий раз, когда
// человек импортирует план ЗА коллегу. По умолчанию выбран сам текущий
// пользователь — тот же результат, что и раньше, если поле не трогать.
async function populateAssigneeSelect(selectEl) {
  if (!teamUsers) {
    try {
      const data = await teamApi('/users');
      teamUsers = data.users || [];
    } catch (err) {
      selectEl.innerHTML = '<option value="" disabled selected>Не удалось загрузить команду</option>';
      toast('Не удалось загрузить список команды: ' + err.message);
      return;
    }
  }
  if (!teamUsers.length) {
    selectEl.innerHTML = '<option value="" disabled selected>В команде никого не нашлось</option>';
    return;
  }
  selectEl.innerHTML = teamUsers.map((u) => `<option value="${esc(u.id)}">${esc(u.name)}</option>`).join('');
  if (currentUser && teamUsers.some((u) => u.id === currentUser.id)) {
    selectEl.value = currentUser.id;
  }
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Не удалось прочитать файл.'));
    reader.readAsText(file, 'utf-8');
  });
}

function renderBulkImportResults(data) {
  const rows = (data.results || []).map((r) => {
    const cls = r.ok ? 'bi-row-ok' : 'bi-row-fail';
    const mark = r.ok ? '✓' : '✗';
    const label = r.ok ? esc(r.title) : esc(r.error);
    return `<div class="${cls}">${mark} Строка ${r.row}: ${label}</div>`;
  });
  biResults.innerHTML =
    `<div><strong>Создано: ${data.created}, ошибок: ${data.failed}</strong></div>` + rows.join('');
  biResults.hidden = false;
}

async function submitBulkImportForm(e) {
  e.preventDefault();
  biError.hidden = true;
  biResults.hidden = true;
  const projectId = biProject.value;
  const assigneeUserId = biAssignee.value;
  const file = biFile.files[0];
  if (!projectId || !file) {
    biError.textContent = 'Выберите проект и файл.';
    biError.hidden = false;
    return;
  }

  // Кнопку блокируем и показываем «идёт обработка» СРАЗУ, до чтения файла
  // (тоже асинхронное — на медленном устройстве/большом файле в это окно
  // раньше можно было успеть кликнуть повторно, пока кнопка ещё активна).
  // По прямому запросу пользователя, 2026-09-25: «деактивировать кнопку» +
  // «выдать уведомление/попап, что идёт обработка».
  biSubmit.disabled = true;
  const originalLabel = biSubmit.innerHTML;
  biSubmit.innerHTML = 'Импортируем…';
  toast('Импортируем публикации — идёт обработка, подождите…');

  let items;
  try {
    const text = await readFileAsText(file);
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed) || !parsed.length) {
      throw new Error('Файл должен содержать непустой JSON-массив постов — см. пример файла.');
    }
    items = parsed;
  } catch (err) {
    biError.textContent = 'Не удалось прочитать файл: ' + err.message;
    biError.hidden = false;
    biSubmit.disabled = false;
    biSubmit.innerHTML = originalLabel;
    return;
  }

  try {
    const data = await teamApi('/tasks/bulk-import', { method: 'POST', body: { projectId, assigneeUserId: assigneeUserId || undefined, items } });
    renderBulkImportResults(data);
    if (data.created) {
      toast(`Импортировано постов: ${data.created}${data.failed ? `, ошибок: ${data.failed}` : ''}`);
      await loadTasks();
    }
  } catch (err) {
    // Раньше при ПОЛНОМ провале батча (сервер отвечает 400, created:0) сюда
    // прилетал голый "Ошибка запроса" без единой подробности — см. коммент
    // над teamApi(). Теперь err.body — это как раз то самое {created,
    // failed, results}, просто пришедшее через catch вместо try; показываем
    // его тем же способом, что и частичный успех, а не общей фразой.
    if (err.body && Array.isArray(err.body.results) && err.body.results.length) {
      renderBulkImportResults(err.body);
      toast(`Импортировано постов: ${err.body.created || 0}, ошибок: ${err.body.failed || err.body.results.length}`);
    } else {
      biError.textContent = err.message;
      biError.hidden = false;
    }
  } finally {
    biSubmit.disabled = false;
    biSubmit.innerHTML = originalLabel;
  }
}

// --- «Буфер обмена» — импорт вставкой из Google Таблиц (по прямому запросу
// 2026-09-24, переработано в тот же день по прямой правке пользователя:
// "копируем ВСЕГДА только день поста — один столбец, без подписей строк
// слева, структура одна и та же" — вместо парсинга по подписям в отдельной
// колонке, теперь позиционная разметка по фиксированному порядку строк
// таблицы + ОБЯЗАТЕЛЬНОЕ подтверждение пользователем перед созданием
// карточки: показываем каждую вставленную строку с выпадающим списком поля
// (по умолчанию — позиционная догадка), пользователь может поправить любую
// строку, прежде чем нажать «Создать пост». Так не рискуем молча создать
// карточку с перепутанными полями, если в реальной ячейке (например "О чём
// контент") оказалось на пару строк больше/меньше, чем в обычной раскладке
// — частый случай, если в самой ячейке Google Sheets есть перенос строки.
async function populateClipboardImportProjectSelect() {
  await populateProjectSelectInto(cpProject);
  // По запросу: в области копи-паст импорта сразу подставляем тот же
  // проект, что выбран в основном фильтре списка/календаря — чтобы не
  // выбирать его второй раз вручную при каждой вставке. Ставим только если
  // такой проект реально есть среди загруженных (борд мог измениться).
  if (projectFilterId && teamProjects && teamProjects.some((p) => p.id === projectFilterId)) {
    cpProject.value = projectFilterId;
  }
}

const CP_DATE_RE = /^(\d{2})\.(\d{2})\.(\d{4})$/;
function cpParseDate(raw) {
  const m = CP_DATE_RE.exec(String(raw || '').trim());
  if (!m) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

// Поля карточки, которые можно назначить строке, и позиционный порядок по
// умолчанию — ровно та же структура таблицы пользователя (дата/день недели/
// формат/stories/о чём контент/заголовок/text/раскадровка/референс), но
// теперь это только НАЧАЛЬНАЯ догадка, а не жёсткая привязка — подтверждает
// пользователь. 'skip' — строка не идёт ни в одно поле карточки (день
// недели, раскадровка, и всё, что осталось после этих 9 строк).
const CP_FIELD_LABELS = {
  skip: 'Пропустить',
  date: 'Дата',
  format: 'Формат',
  stories: 'Stories',
  about: 'О чём контент',
  title: 'Заголовок',
  text: 'Text',
  reference: 'Референс',
};
const CP_DEFAULT_ORDER = ['date', 'skip', 'format', 'stories', 'about', 'title', 'text', 'skip', 'reference'];
function cpDefaultFieldForIndex(i) {
  return CP_DEFAULT_ORDER[i] || 'skip';
}

let cpParsedLines = []; // текущие строки вставки — по ним submitClipboardImportForm читает актуальные значения выпадающих списков

function cpConfirmRowHtml(line, i) {
  const field = cpDefaultFieldForIndex(i);
  const options = Object.entries(CP_FIELD_LABELS)
    .map(([key, label]) => `<option value="${esc(key)}"${key === field ? ' selected' : ''}>${esc(label)}</option>`)
    .join('');
  const trimmed = line.trim();
  const valueHtml = trimmed ? esc(line) : '(пусто)';
  return `<div class="cp-confirm-row" data-line-index="${i}">
    <select class="cp-confirm-select">${options}</select>
    <div class="cp-confirm-value${trimmed ? '' : ' empty'}" title="${esc(line)}">${valueHtml}</div>
  </div>`;
}

function renderCpConfirmRows() {
  cpConfirmRows.innerHTML = cpParsedLines.map((line, i) => cpConfirmRowHtml(line, i)).join('');
}

function resetCpConfirm() {
  cpParsedLines = [];
  cpConfirmRows.innerHTML = '';
  cpConfirmSection.hidden = true;
  cpSubmit.hidden = true;
}

// Клик «Разобрать» — только разбивает вставленный текст на строки и
// показывает разметку для проверки, карточку ещё не создаёт.
function handleCpParseClick() {
  cpError.hidden = true;
  cpResults.hidden = true;
  const pasted = cpPasteArea.value.replace(/\r\n/g, '\n');
  if (!pasted.trim()) {
    cpError.textContent = 'Сначала вставьте скопированный столбец одного дня.';
    cpError.hidden = false;
    return;
  }
  cpParsedLines = pasted.split('\n');
  renderCpConfirmRows();
  cpConfirmSection.hidden = false;
  cpSubmit.hidden = false;
}

function renderClipboardResult(result) {
  const cls = result.ok ? 'bi-row-ok' : 'bi-row-fail';
  const mark = result.ok ? '✓' : '✗';
  const label = result.ok ? esc(result.title) : esc(result.error);
  cpResults.innerHTML = `<div class="${cls}">${mark} ${label}</div>`;
  cpResults.hidden = false;
}

async function submitClipboardImportForm(e) {
  e.preventDefault();
  cpError.hidden = true;
  cpResults.hidden = true;
  const projectId = cpProject.value;
  if (!projectId) {
    cpError.textContent = 'Выберите проект.';
    cpError.hidden = false;
    return;
  }
  if (!cpParsedLines.length) {
    cpError.textContent = 'Сначала нажмите «Разобрать».';
    cpError.hidden = false;
    return;
  }

  // Читаем ТЕКУЩИЕ значения выпадающих списков (не то, что было при разборе
  // — пользователь мог поправить), группируем по полю; несколько строк на
  // одно и то же поле склеиваются переносом строки (например, если абзац из
  // ячейки Google Sheets разъехался на несколько вставленных строк).
  const buckets = { date: [], format: [], stories: [], about: [], title: [], text: [], reference: [] };
  cpConfirmRows.querySelectorAll('.cp-confirm-row').forEach((row) => {
    const idx = Number(row.dataset.lineIndex);
    const field = row.querySelector('.cp-confirm-select').value;
    if (field === 'skip' || !buckets[field]) return;
    const val = (cpParsedLines[idx] || '').trim();
    if (val) buckets[field].push(val);
  });

  const dateRaw = buckets.date[0] || '';
  const date = cpParseDate(dateRaw);
  if (!date) {
    cpError.textContent = dateRaw
      ? `Не разобрал дату «${dateRaw}» — ожидается формат ДД.ММ.ГГГГ.`
      : 'Ни одна строка не отмечена как «Дата» — выберите её в выпадающем списке.';
    cpError.hidden = false;
    return;
  }
  // Быстрая клиентская подсказка — та же граница (будущее, не дальше 2
  // месяцев), что сервер всё равно перепроверит через validateTeamPublishDate().
  if (date < todayIsoDate() || date > maxIsoDate()) {
    cpError.textContent = `Дата «${dateRaw}» вне допустимого диапазона — публикация должна быть в будущем и не дальше чем через 2 месяца.`;
    cpError.hidden = false;
    return;
  }
  const formatRaw = buckets.format.join(' ');
  const titleRaw = buckets.title.join('\n');
  // «формат — добавляем к названию большими буквами» (решение пользователя).
  const title = titleRaw ? (formatRaw ? `${formatRaw.toUpperCase()}: ${titleRaw}` : titleRaw) : (formatRaw ? formatRaw.toUpperCase() : '');
  // «о чём контент — ключевые слова»; stories добавляется отдельной строкой
  // туда же — отдельного поля карточки под него нет.
  const keywordsParts = [];
  if (buckets.about.length) keywordsParts.push(buckets.about.join('\n'));
  if (buckets.stories.length) keywordsParts.push(`Stories: ${buckets.stories.join('\n')}`);

  const item = {
    date,
    network: cpNetwork.value || undefined,
    title: title || undefined,
    text: buckets.text.join('\n') || undefined,
    keywords: keywordsParts.length ? keywordsParts.join('\n') : undefined,
    reference: buckets.reference.join('\n') || undefined,
  };

  cpSubmit.disabled = true;
  const originalLabel = cpSubmit.innerHTML;
  cpSubmit.innerHTML = 'Создаём…';
  toast('Создаём пост — идёт обработка, подождите…');
  try {
    const data = await teamApi('/tasks/bulk-import', { method: 'POST', body: { projectId, assigneeUserId: cpAssignee.value || undefined, items: [item] } });
    const result = (data.results || [])[0] || { ok: false, error: 'Пустой ответ сервера.' };
    renderClipboardResult(result);
    if (result.ok) {
      toast(`Пост создан: ${result.title}`);
      cpPasteArea.value = '';
      resetCpConfirm();
      await loadTasks();
    }
  } catch (err) {
    // Тот же случай, что и в submitBulkImportForm выше: на 400 (строка не
    // создалась) err.body уже содержит results[0].error с конкретной
    // причиной — показываем его вместо общего "Ошибка запроса".
    const result = err.body && Array.isArray(err.body.results) ? err.body.results[0] : null;
    if (result) {
      renderClipboardResult(result);
    } else {
      cpError.textContent = err.message;
      cpError.hidden = false;
    }
  } finally {
    cpSubmit.disabled = false;
    cpSubmit.innerHTML = originalLabel;
  }
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
    <div class="tm-head-row">
      ${t.projectLabel ? `<div class="tm-project">${esc(t.projectLabel)}</div>` : ''}
      <a class="proj-mmid tm-card-link" data-action="copy-card-link" href="/team?task=${encodeURIComponent(t.id)}" target="_blank" rel="noopener" title="Ссылка на карточку — по клику копируется, можно отправить команде">MM ID: <code>${esc(t.id)}</code></a>
    </div>
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
      <button type="button" class="tm-delete-btn" data-action="delete-task" aria-label="Удалить пост" title="Удалить пост">
        <svg viewBox="0 0 24 24" aria-hidden="true" width="13" height="13"><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m-9 0 1 13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
        Удалить
      </button>
    </div>
  `;
  if (editingTitle) {
    const input = document.getElementById('tmTitleInput');
    if (input) { input.focus(); input.selectionStart = input.selectionEnd = input.value.length; }
  }
}

// --- Мини-календарь в попапе даты — та же логика сетки, что renderCalendar()
// в frontend/app.js (UTC-математика, чтобы не плыло у полуночи), только
// компактнее и с "занятостью" по GET /api/team/schedule вместо статусных точек. ---

function buildCalGrid(year, month, selectedDateStr, days, todayStr, maxDateStr) {
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
    // Дата публикации — обязательно в будущем, не дальше 2 месяцев (тот же
    // диапазон, что проверяет сервер в validateTeamPublishDate) — серым и
    // некликабельным, а не просто "попробуй — сервер откажет". Не трогаем
    // уже выбранный день (если у старой карточки дата вне диапазона —
    // всё равно показываем, что на ней стоит, просто без "busy"-логики).
    const outOfRange = dateStr < todayStr || dateStr > maxDateStr;
    const disabledAttr = outOfRange && dateStr !== selectedDateStr ? ' disabled' : '';
    const titleAttr = otherCount > 0
      ? ` title="${esc(`Уже запланировано: ${(days[dateStr].titles || []).join(', ')}${otherCount > days[dateStr].titles.length ? '…' : ''}`)}"`
      : '';
    cells.push(`<button type="button" class="${cls.join(' ')}" data-date="${dateStr}"${titleAttr}${disabledAttr}>${d.getUTCDate()}</button>`);
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
  const maxDateStr = maxIsoDate();
  popNow.innerHTML = `
    <div class="tm-cal-head">
      <button type="button" class="tm-cal-nav-btn" data-action="cal-prev" aria-label="Предыдущий месяц">‹</button>
      <div class="tm-cal-title">${MONTHS_RU_FULL[dateCalMonth]} ${dateCalYear}</div>
      <button type="button" class="tm-cal-nav-btn" data-action="cal-next" aria-label="Следующий месяц">›</button>
    </div>
    <div class="tm-cal-weekdays">${WEEKDAYS_RU.map((w) => `<span>${w}</span>`).join('')}</div>
    <div class="tm-cal-grid">${buildCalGrid(dateCalYear, dateCalMonth, t.publishDate, days, todayStr, maxDateStr)}</div>
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
      <button type="button" class="tm-mini-btn tm-mini-btn-danger" data-action="mo-delete" data-id="${esc(m.id)}" aria-label="Удалить фото" title="Удалить это фото/видео из карточки">🗑</button>
    </div>
  </div>`;
}

function attachBoxHtml() {
  // Реальная загрузка (перетащить файл или выбрать с устройства) идёт прямо
  // на disk.kontentferma через WebDAV (см. POST .../media-upload,
  // diskUpload.js) — если ключи ещё не настроены на сервере, роут вернёт
  // понятную ошибку "не настроено", а не молча ничего не сделает; поле для
  // вставки уже готовой ссылки остаётся ниже как резервный вариант всегда.
  // Обе части — один визуальный блок (карточка), а не два разрозненных.
  return `<div class="tm-attach-card">
    <div class="tm-dropzone" id="tmDropzone">
      <div class="tm-dropzone-icon">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 17a4.5 4.5 0 0 1-.4-8.98A5.5 5.5 0 0 1 17.2 9.5 4 4 0 0 1 17 17H7z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M12 20v-7m0 0-2.6 2.6M12 13l2.6 2.6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </div>
      <div class="tm-dropzone-title">Перетащите файл сюда или нажмите, чтобы выбрать</div>
      <div class="tm-dropzone-hint">Фото или видео — загрузится на disk.kontentferma, в карточку попадёт только ссылка</div>
      <input type="file" id="tmFileInput" accept="image/*,video/*">
    </div>
    <div class="tm-attach-link-row">
      <span class="tm-attach-link-label">или ссылка</span>
      <input type="text" id="tmAttachInput" placeholder="https://disk.kontentferma.ru/s/...">
      <button type="button" class="tm-attach-link-btn" data-action="attach-link" aria-label="Добавить ссылку" title="Добавить ссылку">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>
      </button>
    </div>
  </div>`;
}

function renderMediaPane(t) {
  const media = t.media || [];
  let toolbar = `<div class="tm-media-toolbar"><div class="tm-media-toolbar-title">Медиа (${media.length})</div>`;
  // Гейт ослаблен с ">1" до ">=1" 2026-09-25 — эта же вкладка теперь ещё и
  // единственное место с кнопкой «удалить фото» (см. reorderRowHtml), так
  // что она должна быть доступна и когда медиа всего одно (стрелки ↑/↓ на
  // единственной строке просто останутся задизейбленными — это ожидаемо,
  // менять там всё равно нечего, но удалить нужно уметь).
  if (media.length >= 1) {
    toolbar += reorderMode
      ? `<div style="display:flex;gap:6px">
          <button type="button" class="tm-reorder-toggle" data-action="save-reorder">Сохранить порядок</button>
          <button type="button" class="tm-reorder-toggle" data-action="cancel-reorder">Отмена</button>
        </div>`
      : `<button type="button" class="tm-reorder-toggle" data-action="toggle-reorder">Изменить порядок / удалить</button>`;
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
  if (referencePropertyFound) {
    html += `<div>
      <div class="tm-field-label">Референс</div>
      <textarea class="tm-textarea tm-keywords-textarea" id="tmReferenceInput" spellcheck="true" placeholder="Ссылка на пример поста/визуала">${esc(t.reference || '')}</textarea>
      <div class="tm-save-row" style="margin-top:8px">
        <button type="button" class="btn changes" data-action="save-reference">Сохранить</button>
      </div>
    </div>`;
  }
  return html;
}

// --- ЧАТ КОМАНДЫ (внутренний, своя таблица в БД — не карточка Mattermost) ---

// Небольшая картинка-миниатюра внутри сообщения чата (если есть) — клик
// открывает её на весь экран (см. openLightbox). Общая для обоих чатов.
function chatMsgImageHtml(imageUrl) {
  if (!imageUrl) return '';
  return `<img class="tm-chat-img" src="${esc(imageUrl)}" alt="" loading="lazy" data-action="open-lightbox" data-src="${esc(imageUrl)}">`;
}

// Превью ещё не отправленной картинки над полем ввода + кнопка убрать —
// общая для обоих compose-боксов, различаются только data-scope ('team' /
// 'client') и тем, какая переменная (pendingTeamImage/pendingClientImage)
// её держит.
function pendingImageHtml(pending, scope) {
  if (!pending) return '';
  return `<div class="tm-chat-pending-img${pending.uploading ? ' uploading' : ''}">
    ${pending.shareUrl ? `<img src="${esc(pending.shareUrl)}" alt="">` : ''}
    <button type="button" class="tm-chat-pending-remove" data-action="remove-pending-image" data-scope="${scope}" aria-label="Убрать фото">✕</button>
  </div>`;
}

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
            <div class="tm-chat-msg-author${authorIsCerberus(c.authorName) ? ' cerberus' : ''}">${esc(c.authorName || 'Команда')}</div>
            ${c.text ? `<div class="tm-chat-msg-text">${esc(c.text)}</div>` : ''}
            ${chatMsgImageHtml(c.imageUrl)}
            <div class="tm-chat-msg-time">${formatDateTime(c.createdAt)}</div>
          </div>`;
        })
        .join('')
    : `<div class="tm-chat-empty">Пока нет сообщений — начните обсуждение поста здесь.</div>`;
  return `<div class="tm-chat">
    <div class="tm-chat-list">${items}</div>
    <div class="tm-chat-compose">
      ${pendingImageHtml(pendingTeamImage, 'team')}
      <div class="tm-chat-compose-row">
        <button type="button" class="tm-chat-attach" data-action="pick-chat-image" data-scope="team" aria-label="Прикрепить фото" title="Прикрепить фото">
          <svg viewBox="0 0 24 24" aria-hidden="true" width="17" height="17"><path d="M21 12.5l-8.5 8.5a5 5 0 0 1-7-7l9-9a3.5 3.5 0 0 1 5 5l-9 9a2 2 0 0 1-3-3l8-8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <textarea id="tmTeamComposeInput" placeholder="Написать команде…"></textarea>
        <button type="button" class="tm-chat-send" data-action="send-team-comment" aria-label="Отправить">➤</button>
      </div>
      <input type="file" id="tmTeamChatFileInput" data-scope="team" accept="image/*" hidden>
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
      ${c.text ? `<div class="tm-chat-msg-text">${esc(c.text)}</div>` : ''}
      ${chatMsgImageHtml(c.imageUrl)}
      <div class="tm-chat-msg-time">${formatDateTime(c.createdAt)}</div>
    </div>`;
  }
  // 'agency' — сообщение, отправленное командой отсюда же (см. compose box
  // ниже) — показываем как "своё" сообщение (справа), чат с клиентом
  // читается в обе стороны, а не только его правки.
  if (c.kind === 'agency') {
    return `<div class="tm-chat-msg mine">
      <div class="tm-chat-msg-author">Агентство</div>
      ${c.text ? `<div class="tm-chat-msg-text">${esc(c.text)}</div>` : ''}
      ${chatMsgImageHtml(c.imageUrl)}
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
      ${pendingImageHtml(pendingClientImage, 'client')}
      <div class="tm-chat-compose-row">
        <button type="button" class="tm-chat-attach" data-action="pick-chat-image" data-scope="client" aria-label="Прикрепить фото" title="Прикрепить фото">
          <svg viewBox="0 0 24 24" aria-hidden="true" width="17" height="17"><path d="M21 12.5l-8.5 8.5a5 5 0 0 1-7-7l9-9a3.5 3.5 0 0 1 5 5l-9 9a2 2 0 0 1-3-3l8-8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <textarea id="tmClientComposeInput" placeholder="Написать клиенту…"></textarea>
        <button type="button" class="tm-chat-send" data-action="send-client-message" aria-label="Отправить">➤</button>
      </div>
      <input type="file" id="tmClientChatFileInput" data-scope="client" accept="image/*" hidden>
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
  // "Ключевые слова/мысли" — та же вводная для копирайтера/ИИ, что уже
  // редактируется во вкладке "Текст" (см. renderTextPane выше), но здесь —
  // мелким серым текстом под самим постом, чтобы бриф был виден с одного
  // взгляда на превью, не заходя в отдельную вкладку.
  const keywordsText = (t.keywords || '').trim();
  const keywordsHtml = keywordsText ? `<div class="tm-preview-keywords">💡 ${esc(keywordsText)}</div>` : '';
  return `<div class="tm-preview-phone"><div class="tm-preview-inner">
    <div class="tm-preview-media">${mediaHtml}</div>
    <div class="tm-preview-text">${socialBadge}<div class="tm-preview-caption">${captionHtml}</div>${keywordsHtml}</div>
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
  const mmEl = e.target.closest('[data-action="copy-card-link"]');
  if (mmEl) {
    e.preventDefault();
    navigator.clipboard.writeText(`${location.origin}/team?task=${encodeURIComponent(t.id)}`).catch(() => {});
    toast('Ссылка на карточку скопирована');
    return;
  }
  const btn = e.target.closest('button');
  if (!btn) return;
  const action = btn.dataset.action;

  if (action === 'edit-title') { editingTitle = true; renderModalHead(t); return; }
  if (action === 'cancel-title') { editingTitle = false; renderModalHead(t); return; }
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
    closeAllPopovers();
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
    closeAllPopovers();
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
  if (action === 'delete-task') {
    const { bare } = splitTitle(t.title);
    const label = stripAiTag(bare) || '(без названия)';
    const sure = confirm(`Удалить пост «${label}»?\n\nЭто действие нельзя отменить — карточка будет удалена из Mattermost навсегда.`);
    if (!sure) return;
    btn.disabled = true;
    try {
      await teamApi(`/tasks/${encodeURIComponent(t.id)}/delete`, { method: 'POST' });
      currentTasks = currentTasks.filter((x) => x.id !== t.id);
      closeTaskModal();
      renderChips();
      renderTasks();
      if (teamCalendarView && !teamCalendarView.hidden) renderTeamCalendarGrid();
      toast('Пост удалён.');
    } catch (err) {
      btn.disabled = false;
      toast('Не удалось удалить: ' + err.message);
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
  if (action === 'mo-delete') {
    const m = (t.media || []).find((x) => x.id === btn.dataset.id);
    if (!m) return;
    if (!confirm(`Удалить это ${m.kind === 'video' ? 'видео' : 'фото'} из карточки?\n\nЭто необратимо.`)) return;
    btn.disabled = true;
    try {
      const data = await teamApi(`/tasks/${encodeURIComponent(t.id)}/media/${encodeURIComponent(btn.dataset.id)}`, { method: 'DELETE' });
      reorderIds = reorderIds.filter((id) => id !== btn.dataset.id);
      applyUpdatedTask(data.task);
      toast('Материал удалён');
    } catch (err) {
      toast('Не удалось удалить: ' + err.message);
      btn.disabled = false;
    }
    return;
  }
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
  if (action === 'save-reference') {
    const val = document.getElementById('tmReferenceInput').value;
    try {
      const data = await teamApi(`/tasks/${encodeURIComponent(t.id)}/reference`, { method: 'POST', body: { text: val } });
      applyUpdatedTask(data.task);
      flashSaved(document.getElementById('tmReferenceInput'));
    } catch (err) {
      toast('Не удалось сохранить: ' + err.message);
    }
    return;
  }
  if (action === 'pick-chat-image') {
    const inputId = btn.dataset.scope === 'client' ? 'tmClientChatFileInput' : 'tmTeamChatFileInput';
    const input = document.getElementById(inputId);
    if (input) input.click();
    return;
  }
  if (action === 'remove-pending-image') {
    if (btn.dataset.scope === 'client') pendingClientImage = null; else pendingTeamImage = null;
    renderModalBody(t);
    return;
  }
  if (action === 'send-team-comment') {
    const input = document.getElementById('tmTeamComposeInput');
    const text = (input.value || '').trim();
    const imageUrl = pendingTeamImage && pendingTeamImage.shareUrl;
    if (!text && !imageUrl) return;
    if (pendingTeamImage && pendingTeamImage.uploading) { toast('Фото ещё загружается…'); return; }
    btn.disabled = true;
    try {
      const data = await teamApi(`/tasks/${encodeURIComponent(t.id)}/comments`, { method: 'POST', body: { text, imageUrl: imageUrl || '' } });
      teamCommentsCache[t.id] = [...(teamCommentsCache[t.id] || []), data.comment];
      input.value = '';
      pendingTeamImage = null;
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
    const imageUrl = pendingClientImage && pendingClientImage.shareUrl;
    if (!text && !imageUrl) return;
    if (pendingClientImage && pendingClientImage.uploading) { toast('Фото ещё загружается…'); return; }
    btn.disabled = true;
    try {
      // Unlike the team chat, clientComments already comes back embedded on
      // the task itself (see taskMapper.js) — applyUpdatedTask alone is
      // enough, no separate cache to update.
      const data = await teamApi(`/tasks/${encodeURIComponent(t.id)}/client-message`, { method: 'POST', body: { text, imageUrl: imageUrl || '' } });
      input.value = '';
      pendingClientImage = null;
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

// Клик по миниатюре фото в чате — открывает её на весь экран (см.
// openLightbox ниже). Отдельный слушатель, а не часть делегата кликов по
// button выше: миниатюра — это <img>, не кнопка.
tmBody.addEventListener('click', (e) => {
  const img = e.target.closest('.tm-chat-img');
  if (!img) return;
  openLightbox(img.dataset.src || img.src);
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
      if (freshTitle) freshTitle.textContent = 'Перетащите файл сюда или нажмите, чтобы выбрать';
    }
  }
}

tmBody.addEventListener('change', (e) => {
  const fileInput = e.target.closest('#tmFileInput');
  if (fileInput) {
    const t = currentModalTask();
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = ''; // позволяет выбрать тот же файл повторно в будущем
    if (t && file) uploadMediaFile(t, file);
    return;
  }
  const chatFileInput = e.target.closest('#tmTeamChatFileInput, #tmClientChatFileInput');
  if (chatFileInput) {
    const t = currentModalTask();
    const file = chatFileInput.files && chatFileInput.files[0];
    const scope = chatFileInput.dataset.scope;
    chatFileInput.value = '';
    if (t && file) uploadChatImage(t, file, scope);
  }
});

// Фото для СЛЕДУЮЩЕГО сообщения в чате — грузится сразу при выборе файла
// (не при нажатии "Отправить"), результат складывается в
// pendingTeamImage/pendingClientImage и показывается превью над полем
// ввода; сам текст+ссылка уходят вместе только при отправке (см.
// send-team-comment/send-client-message ниже).
async function uploadChatImage(t, file, scope) {
  const setPending = (v) => { if (scope === 'team') pendingTeamImage = v; else pendingClientImage = v; };
  setPending({ uploading: true, shareUrl: '' });
  renderModalBody(t);
  try {
    const form = new FormData();
    form.append('file', file);
    const res = await fetch(`/api/team/tasks/${encodeURIComponent(t.id)}/chat-upload`, { method: 'POST', body: form });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setPending(null);
      toast(
        data.error === 'disk_upload_not_configured'
          ? 'Загрузка ещё не настроена на сервере.'
          : 'Не удалось загрузить фото: ' + (data.message || data.error || 'ошибка')
      );
      renderModalBody(t);
      return;
    }
    setPending({ uploading: false, shareUrl: data.shareUrl });
    renderModalBody(t);
  } catch (err) {
    setPending(null);
    toast('Не удалось загрузить фото: ' + err.message);
    renderModalBody(t);
  }
}

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

// Полноэкранный просмотр фото из чата — маленькая миниатюра в сообщении,
// по клику "всплывает" до 80% экрана (см. .lightbox img в team.css), фон и
// крестик закрывают. history.pushState при открытии + popstate — чтобы
// аппаратная/жестовая кнопка "назад" тоже просто закрывала фото, а не
// уводила с кабинета (важно на телефоне).
const lightboxEl = document.getElementById('lightbox');
const lightboxImgEl = document.getElementById('lightboxImg');
let lightboxOpenedViaHistory = false;

function openLightbox(url) {
  if (!lightboxEl || !url) return;
  lightboxImgEl.src = url;
  lightboxEl.hidden = false;
  lightboxOpenedViaHistory = true;
  history.pushState({ lightbox: true }, '');
}

function closeLightbox() {
  if (!lightboxEl || lightboxEl.hidden) return;
  lightboxEl.hidden = true;
  lightboxImgEl.src = '';
  if (lightboxOpenedViaHistory) {
    lightboxOpenedViaHistory = false;
    history.back();
  }
}

if (lightboxEl) {
  lightboxEl.querySelector('.lightbox-backdrop').addEventListener('click', closeLightbox);
  lightboxEl.querySelector('.lightbox-close').addEventListener('click', closeLightbox);
}
window.addEventListener('popstate', () => {
  if (lightboxEl && !lightboxEl.hidden) {
    lightboxOpenedViaHistory = false; // история уже сдвинулась сама, повторно back() не нужен
    closeLightbox();
  }
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
  if (e.key !== 'Escape') return;
  if (lightboxEl && !lightboxEl.hidden) { closeLightbox(); return; }
  if (!createModal.hidden) { closeCreateModal(); return; }
  if (!taskModal.hidden) closeTaskModal();
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

teamProjectFilter.addEventListener('change', () => {
  projectFilterId = teamProjectFilter.value;
  try { localStorage.setItem(PROJECT_FILTER_KEY, projectFilterId); } catch (e) {}
  renderTasks();
  if (teamCalendarView && !teamCalendarView.hidden) renderTeamCalendarGrid();
});

teamList.addEventListener('click', (e) => {
  const row = e.target.closest('.team-task');
  if (!row) return;
  if (selectMode) {
    row.classList.toggle('selected');
    row.querySelector('.team-task-check')?.classList.toggle('checked');
    toggleTaskSelection(row.dataset.taskId);
    return;
  }
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

// () => openCreateModal(), не openCreateModal напрямую — иначе addEventListener
// передал бы сюда сам объект клика как prefill (openCreateModal теперь его
// принимает, см. выше).
fabCreate.addEventListener('click', () => openCreateModal());
document.querySelector('#createModal .tm-backdrop').addEventListener('click', closeCreateModal);
document.getElementById('createClose').addEventListener('click', closeCreateModal);
createForm.addEventListener('submit', submitCreateForm);
createTabBtnSingle.addEventListener('click', () => setCreateTab('single'));
createTabBtnImport.addEventListener('click', () => setCreateTab('import'));
createTabBtnClipboard.addEventListener('click', () => setCreateTab('clipboard'));

biForm.addEventListener('submit', submitBulkImportForm);
cpParseBtn.addEventListener('click', handleCpParseClick);
cpForm.addEventListener('submit', submitClipboardImportForm);

// Ссылка на конкретную карточку (?task=<id>, см. openDeepLinkedTask) — из
// ссылки в шапке модалки (copy-card-link) или любым другим способом.
const deepLinkTaskId = new URLSearchParams(location.search).get('task');
if (deepLinkTaskId) pendingDeepLinkTaskId = deepLinkTaskId;

init();
