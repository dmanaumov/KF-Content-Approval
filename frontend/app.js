// No build step, no framework — same approach as the original static
// prototype, just wired to a real API instead of hardcoded demo data.

const params = new URLSearchParams(location.search);
// /l/{token} — the short, rotatable client link (see backend linkTokens.js
// and index.js's /l/:token route). boardId/projectFilter start out unknown
// and get filled in by resolveLinkToken() below, entirely in memory — the
// whole point of this link shape is that neither ever appears in the URL,
// so a page reload always re-resolves the CURRENT token instead of ever
// showing/letting anyone copy the real underlying board/project ids.
const linkToken = (location.pathname.match(/^\/l\/([^/]+)/) || [])[1];
// /p/{boardId}?project=... — the older, direct link shape. Still supported
// (nothing was disabled server-side), just no longer what's handed out from
// the /projects staff page.
const directBoardId = (location.pathname.match(/^\/p\/([^/]+)/) || [])[1];
const deepLinkTaskId = params.get('task');

let boardId = directBoardId || null;
let projectFilter = params.get('project') || null; // which client this link is for, on a shared board

let state = { tasks: [], board: null };
let activeWeek = null;
let activeFilter = '';
let feedbackTaskId = '';
let busyTaskId = null;
let calYear = null; // calendar view's current year/month (0-indexed month) —
let calMonth = null; // set lazily to today's month the first time it opens.

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (s) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[s]));
}

function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 2600);
}

// resolvedName: passed explicitly by a /l/{token} link (the name came back
// from GET /api/links/:token, never from the URL) — falls back to the
// legacy ?name= query param for a direct /p/{boardId} link. Single place
// that sets the client name/logo letter so a /l/ link's resolved name can
// never get clobbered by an (absent) ?name= param afterwards.
function applyBranding(resolvedName) {
  const color = params.get('color');
  const logo = params.get('logo');
  const name = resolvedName || params.get('name');
  if (color && /^#[0-9a-fA-F]{6}$/.test(color)) {
    document.documentElement.style.setProperty('--accent', color);
  }
  if (name) document.getElementById('clientName').textContent = name;
  if (logo) {
    const el = document.getElementById('clientLogo');
    el.outerHTML = `<img id="clientLogo" src="${esc(logo)}" alt="">`;
  } else {
    // No logo image supplied — show the client/project's own first letter
    // in the placeholder frame instead of a hardcoded letter.
    const el = document.getElementById('clientLogo');
    const letter = (name || '').trim().charAt(0).toUpperCase();
    if (el) el.textContent = letter || 'К';
  }
}

// Resolves a /l/{token} link into the {boardId, projectId, name} it
// currently points to, and fills in the module-level boardId/projectFilter
// used by everything else below. Throws with a user-facing message on an
// unknown/revoked token (404) or any other failure.
async function resolveLinkToken() {
  const res = await fetch(`/api/links/${encodeURIComponent(linkToken)}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || data.error || 'Не удалось открыть кабинет.');
  boardId = data.boardId;
  projectFilter = data.projectId;
  return data.name || '';
}

function statusInfo(status) {
  if (status === 'approved') return { cls: 'approved', text: 'Согласовано' };
  if (status === 'changes') return { cls: 'changes', text: 'Правки' };
  if (status === 'published') return { cls: 'published', text: 'Опубликовано' };
  return { cls: 'waiting', text: 'На согласовании' };
}

const MONTHS_RU_SHORT = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const MONTHS_RU_FULL = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
function formatDatePill(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) return dateStr;
  return `${d.getUTCDate()} ${MONTHS_RU_SHORT[d.getUTCMonth()]}`;
}

// Calendar-day difference between a task's publish date and today (local
// device time) — positive = still in the future, negative = already past.
function daysUntil(dateStr) {
  if (!dateStr) return null;
  const target = new Date(dateStr + 'T00:00:00');
  if (Number.isNaN(target.getTime())) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((target - today) / 86400000);
}

// "Горит" — waiting on client review with the publish date 3 days away or
// closer (including already overdue).
function isUrgent(task) {
  if (task.status !== 'waiting' || !task.publishDate) return false;
  const d = daysUntil(task.publishDate);
  return d !== null && d < 3;
}

function mediaHtml(task) {
  if (!task.media.length) {
    return '<div class="media"><div class="carousel"><div class="slide file-link"><div><b>Без вложений</b></div></div></div></div>';
  }
  const slides = task.media
    .map((m) => {
      // Two possible sources: an attachment on the Mattermost card itself
      // (Boards' own file storage, keyed by team+board), or a
      // disk.kontentferma.* share link found in the post text/URL and
      // proxied through our own disk-embed route instead.
      const fileUrl =
        m.source === 'disk'
          ? `/api/disk-embed?u=${encodeURIComponent(m.shareUrl)}`
          : `/api/files/${encodeURIComponent(boardId)}/${encodeURIComponent(m.fileId)}`;
      if (m.kind === 'image') {
        return `<div class="slide"><img src="${fileUrl}" alt="" loading="lazy"></div>`;
      }
      if (m.kind === 'video') {
        return `<div class="slide"><div class="video-frame"><video controls playsinline webkit-playsinline preload="metadata" src="${fileUrl}"></video></div></div>`;
      }
      // Unknown/generic file: for a disk link, send the client to the
      // original share page (Nextcloud's own preview UI) rather than our
      // raw download proxy; card attachments still use our own proxy link.
      const href = m.source === 'disk' ? m.shareUrl : fileUrl;
      return `<div class="slide file-link"><div><b>${esc(m.name || 'Файл')}</b><br><a href="${href}" target="_blank" rel="noopener">Открыть</a></div></div>`;
    })
    .join('');
  const counter = task.media.length > 1 ? `<div class="dots">1 / ${task.media.length}</div>` : '';
  return `<div class="media"><div class="carousel" data-count="${task.media.length}">${slides}</div>${counter}</div>`;
}

function cardHtml(task) {
  const st = statusInfo(task.status);
  const busy = busyTaskId === task.id;
  const urgent = isUrgent(task);
  let actions;
  if (task.status === 'approved') {
    actions = '<div class="actions"><div class="approved-box">✓ Согласовано</div></div>';
  } else if (task.status === 'published') {
    // Terminal state — nothing left for the client to do here.
    actions = '<div class="actions"><div class="approved-box published-box">🔗 Опубликовано</div></div>';
  } else {
    actions = `<div class="actions">
           <button class="btn approve" ${busy ? 'disabled' : ''} data-action="approve" data-id="${task.id}">Согласовать</button>
           <button class="btn changes" ${busy ? 'disabled' : ''} data-action="open-feedback" data-id="${task.id}">Есть правки</button>
         </div>`;
  }
  const dateBadge = task.publishDate
    ? `<span class="status date" title="Плановая дата публикации">${esc(formatDatePill(task.publishDate))}</span>`
    : '';
  const urlLink = task.url
    ? `<div class="post-link"><a href="${esc(task.url)}" target="_blank" rel="noopener">Открыть опубликованный пост →</a></div>`
    : '';
  const urgentBadge = urgent ? '<span class="status urgent">🔥 ГОРИТ!</span>' : '';
  return `<article class="card${busy ? ' pending-action' : ''}${urgent ? ' urgent' : ''}" id="task-${esc(task.id)}">
    <div class="meta">
      <div class="meta-left">
        ${task.format ? `<div class="eyebrow">${esc(task.format)}</div>` : ''}
        <h2>${esc(task.title)}</h2>
      </div>
      <div class="badges">
        ${urgentBadge}
        ${dateBadge}
        <span class="status ${st.cls}">${st.text}</span>
      </div>
    </div>
    ${mediaHtml(task)}
    ${task.caption && task.status !== 'changes' ? `<div class="caption-wrap"><div class="caption open">${esc(task.caption)}</div></div>` : ''}
    ${urlLink}
    ${task.feedback ? `<div class="feedback-note">${esc(task.feedback)}</div>` : ''}
    ${actions}
  </article>`;
}

// Besides the label, each week entry now also tracks whether it contains
// something still awaiting client approval (hasWaiting) and, more
// specifically, something urgent (hasUrgent — publish date within 3 days).
// hasUrgent is always a subset of hasWaiting (isUrgent() requires
// status === 'waiting'), so the period pill only needs one border-accent
// class; the icon (dot vs fire) is chosen from hasUrgent alone.
function weeksOf(tasks) {
  const map = new Map();
  for (const t of tasks) {
    if (!t.weekStart) continue;
    if (!map.has(t.weekStart)) {
      map.set(t.weekStart, { label: t.weekLabel, hasWaiting: false, hasUrgent: false });
    }
    const entry = map.get(t.weekStart);
    if (t.status === 'waiting') entry.hasWaiting = true;
    if (isUrgent(t)) entry.hasUrgent = true;
  }
  return [...map.entries()].sort((a, b) => b[0].localeCompare(a[0])); // newest first
}

// Calendar view — a month grid built entirely from the already-loaded
// state.tasks (no extra API call). Only tasks with a publishDate appear on
// it. Marker rule (agency's spec): urgent (waiting + due soon/overdue) shows
// 🔥 instead of a dot; otherwise a status-colored dot. Title is CSS-clamped
// to 3 lines so one long post name can't blow out a day cell on a phone.
const CAL_DOT_CLASS = { waiting: 'waiting', approved: 'approved', changes: 'changes', published: 'published' };
function calMarkerHtml(task) {
  if (isUrgent(task)) return '<span class="cal-mark fire" aria-hidden="true">🔥</span>';
  const cls = CAL_DOT_CLASS[task.status] || 'waiting';
  return `<span class="cal-mark dot ${cls}" aria-hidden="true"></span>`;
}

function scrollToTask(id) {
  const el = document.getElementById(`task-${id}`);
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function renderCalendar() {
  if (calYear == null) {
    const now = new Date();
    calYear = now.getFullYear();
    calMonth = now.getMonth();
  }
  document.getElementById('calTitle').textContent = `${MONTHS_RU_FULL[calMonth]} ${calYear}`;

  const byDate = new Map();
  for (const t of state.tasks) {
    if (!t.publishDate) continue;
    if (!byDate.has(t.publishDate)) byDate.set(t.publishDate, []);
    byDate.get(t.publishDate).push(t);
  }

  // Grid math done in UTC throughout (publishDate is a plain YYYY-MM-DD with
  // no time component, so there's no real timezone to respect here) —
  // avoids local-time DST/offset edge cases shifting a day into the wrong
  // cell near midnight.
  const first = new Date(Date.UTC(calYear, calMonth, 1));
  const leadDow = first.getUTCDay() || 7; // Mon=1..Sun=7
  const lead = leadDow - 1;
  const daysInMonth = new Date(Date.UTC(calYear, calMonth + 1, 0)).getUTCDate();
  const totalCells = Math.ceil((lead + daysInMonth) / 7) * 7;
  const gridStart = new Date(Date.UTC(calYear, calMonth, 1 - lead));

  // "Today" IS a local-calendar-day concept (same convention as isUrgent's
  // daysUntil), so computed from local date parts, not UTC/ISO.
  const now = new Date();
  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

  const cells = [];
  for (let i = 0; i < totalCells; i++) {
    const d = new Date(gridStart);
    d.setUTCDate(gridStart.getUTCDate() + i);
    const dateStr = d.toISOString().slice(0, 10);
    const inMonth = d.getUTCMonth() === calMonth;
    const dayTasks = byDate.get(dateStr) || [];
    const posts = dayTasks
      .map(
        (t) =>
          `<button type="button" class="cal-post" data-task-id="${esc(t.id)}">${calMarkerHtml(t)}<span class="cal-post-title">${esc(t.title)}</span></button>`
      )
      .join('');
    const cls = `cal-day${inMonth ? '' : ' other-month'}${dateStr === todayStr ? ' today' : ''}`;
    cells.push(`<div class="${cls}"><div class="cal-day-num">${d.getUTCDate()}</div>${posts}</div>`);
  }
  document.getElementById('calendarGrid').innerHTML = cells.join('');
}

function openCalendar() {
  document.getElementById('listHead').hidden = true;
  document.getElementById('listView').hidden = true;
  document.getElementById('calendarView').hidden = false;
  renderCalendar();
}

function closeCalendar() {
  document.getElementById('listHead').hidden = false;
  document.getElementById('listView').hidden = false;
  document.getElementById('calendarView').hidden = true;
}

function render() {
  const weeks = weeksOf(state.tasks);
  if (!activeWeek || !weeks.some(([w]) => w === activeWeek)) {
    activeWeek = weeks.length ? weeks[0][0] : null;
  }

  document.getElementById('weeks').innerHTML = weeks
    .map(([w, info]) => {
      const marker = info.hasUrgent
        ? '<span class="week-marker fire" aria-hidden="true">🔥</span>'
        : info.hasWaiting
        ? '<span class="week-marker dot" aria-hidden="true"></span>'
        : '';
      const cls = `week${w === activeWeek ? ' active' : ''}${info.hasWaiting ? ' has-waiting' : ''}`;
      return `<button class="${cls}" data-week="${w}">${marker}${esc(info.label)}</button>`;
    })
    .join('');

  const inWeek = state.tasks.filter((t) => t.weekStart === activeWeek);
  const approved = inWeek.filter((t) => t.status === 'approved').length;
  document.getElementById('progressFill').style.width = (inWeek.length ? (approved / inWeek.length) * 100 : 0) + '%';
  document.getElementById('progressText').textContent = `${approved} из ${inWeek.length} согласовано`;

  const visible = inWeek.filter((t) => !activeFilter || t.status === activeFilter);
  document.getElementById('stack').innerHTML = visible.map(cardHtml).join('') || '<div class="empty">Здесь пока ничего нет.</div>';

  if (deepLinkTaskId) {
    const el = document.getElementById(`task-${deepLinkTaskId}`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

async function loadTasks() {
  const loading = document.getElementById('loading');
  loading.hidden = false;
  try {
    const qs = projectFilter ? `?project=${encodeURIComponent(projectFilter)}` : '';
    const res = await fetch(`/api/boards/${encodeURIComponent(boardId)}/tasks${qs}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || data.error || 'Ошибка загрузки');
    state.tasks = data.tasks;
    state.board = data.board;
    if (deepLinkTaskId) {
      const t = state.tasks.find((x) => x.id === deepLinkTaskId);
      if (t) activeWeek = t.weekStart;
    }
    render();
  } catch (err) {
    document.getElementById('stack').innerHTML = `<div class="error-box">Не удалось загрузить задачи: ${esc(err.message)}</div>`;
  } finally {
    loading.hidden = true;
  }
}

async function approve(taskId) {
  busyTaskId = taskId;
  render();
  try {
    const res = await fetch(`/api/boards/${encodeURIComponent(boardId)}/tasks/${encodeURIComponent(taskId)}/approve`, {
      method: 'POST',
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || data.error);
    state.tasks = state.tasks.map((t) => (t.id === taskId ? data.task : t));
    toast('Согласовано');
  } catch (err) {
    toast('Не удалось согласовать: ' + err.message);
  } finally {
    busyTaskId = null;
    render();
  }
}

async function sendFeedback(taskId, comment) {
  busyTaskId = taskId;
  render();
  try {
    const res = await fetch(`/api/boards/${encodeURIComponent(boardId)}/tasks/${encodeURIComponent(taskId)}/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ comment }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || data.error);
    state.tasks = state.tasks.map((t) => (t.id === taskId ? data.task : t));
    toast('Правки отправлены');
  } catch (err) {
    toast('Не удалось отправить правки: ' + err.message);
  } finally {
    busyTaskId = null;
    render();
  }
}

document.getElementById('weeks').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-week]');
  if (!btn) return;
  activeWeek = btn.dataset.week;
  render();
});

document.querySelectorAll('.filter').forEach((b) =>
  b.addEventListener('click', () => {
    activeFilter = b.dataset.filter;
    document.querySelectorAll('.filter').forEach((x) => x.classList.toggle('active', x === b));
    render();
  })
);

document.getElementById('stack').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const id = btn.dataset.id;
  if (btn.dataset.action === 'approve') approve(id);
  if (btn.dataset.action === 'open-feedback') {
    feedbackTaskId = id;
    const task = state.tasks.find((t) => t.id === id);
    document.getElementById('feedbackTitle').textContent = task ? task.title : '';
    document.getElementById('feedbackText').value = '';
    document.getElementById('feedbackModal').classList.add('show');
  }
});

document.querySelector('[data-action="close-feedback"]').addEventListener('click', () => {
  document.getElementById('feedbackModal').classList.remove('show');
});

document.querySelector('[data-action="send-feedback"]').addEventListener('click', () => {
  const text = document.getElementById('feedbackText').value.trim();
  if (!text) { toast('Напишите комментарий'); return; }
  document.getElementById('feedbackModal').classList.remove('show');
  sendFeedback(feedbackTaskId, text);
});

document.getElementById('calendarToggle').addEventListener('click', openCalendar);
document.getElementById('calBack').addEventListener('click', closeCalendar);
document.getElementById('calPrev').addEventListener('click', () => {
  calMonth--;
  if (calMonth < 0) { calMonth = 11; calYear--; }
  renderCalendar();
});
document.getElementById('calNext').addEventListener('click', () => {
  calMonth++;
  if (calMonth > 11) { calMonth = 0; calYear++; }
  renderCalendar();
});
document.getElementById('calendarGrid').addEventListener('click', (e) => {
  const btn = e.target.closest('.cal-post');
  if (!btn) return;
  const id = btn.dataset.taskId;
  const task = state.tasks.find((t) => t.id === id);
  closeCalendar();
  if (task) {
    activeWeek = task.weekStart;
    activeFilter = '';
    document.querySelectorAll('.filter').forEach((x) => x.classList.toggle('active', x.dataset.filter === ''));
  }
  render();
  scrollToTask(id);
});

async function init() {
  if (linkToken) {
    document.getElementById('loading').hidden = false;
    let name = '';
    try {
      name = await resolveLinkToken();
    } catch (err) {
      document.getElementById('loading').hidden = true;
      document.getElementById('stack').innerHTML = `<div class="error-box">${esc(err.message)}</div>`;
      return;
    }
    applyBranding(name);
    loadTasks();
    return;
  }
  if (!boardId) {
    document.getElementById('loading').hidden = true;
    document.getElementById('stack').innerHTML = '<div class="error-box">Ссылка неполная: не указан ID проекта Mattermost.</div>';
    return;
  }
  applyBranding();
  loadTasks();
}

init();
