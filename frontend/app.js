// No build step, no framework — same approach as the original static
// prototype, just wired to a real API instead of hardcoded demo data.

const params = new URLSearchParams(location.search);
const boardId = (location.pathname.match(/^\/p\/([^/]+)/) || [])[1];
const projectFilter = params.get('project'); // which client this link is for, on a shared board
const deepLinkTaskId = params.get('task');

let state = { tasks: [], board: null };
let activeWeek = null;
let activeFilter = '';
let feedbackTaskId = '';
let busyTaskId = null;

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

function applyBranding() {
  const color = params.get('color');
  const name = params.get('name');
  const logo = params.get('logo');
  if (color && /^#[0-9a-fA-F]{6}$/.test(color)) {
    document.documentElement.style.setProperty('--accent', color);
  }
  if (name) document.getElementById('clientName').textContent = name;
  if (logo) {
    const el = document.getElementById('clientLogo');
    el.outerHTML = `<img id="clientLogo" src="${esc(logo)}" alt="">`;
  }
}

function statusInfo(status) {
  if (status === 'approved') return { cls: 'approved', text: 'Согласовано' };
  if (status === 'changes') return { cls: 'changes', text: 'Правки' };
  if (status === 'published') return { cls: 'published', text: 'Опубликовано' };
  return { cls: 'waiting', text: 'На согласовании' };
}

const MONTHS_RU_SHORT = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
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
      if (m.kind === 'image') {
        return `<div class="slide"><img src="/api/files/${encodeURIComponent(m.fileId)}" alt="" loading="lazy"></div>`;
      }
      if (m.kind === 'video') {
        return `<div class="slide"><div class="video-frame"><video controls playsinline webkit-playsinline preload="metadata" src="/api/files/${encodeURIComponent(m.fileId)}"></video></div></div>`;
      }
      return `<div class="slide file-link"><div><b>${esc(m.name || 'Файл')}</b><br><a href="/api/files/${encodeURIComponent(m.fileId)}" target="_blank" rel="noopener">Открыть</a></div></div>`;
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

function weeksOf(tasks) {
  const map = new Map();
  for (const t of tasks) {
    if (!t.weekStart) continue;
    if (!map.has(t.weekStart)) map.set(t.weekStart, t.weekLabel);
  }
  return [...map.entries()].sort((a, b) => b[0].localeCompare(a[0])); // newest first
}

function render() {
  const weeks = weeksOf(state.tasks);
  if (!activeWeek || !weeks.some(([w]) => w === activeWeek)) {
    activeWeek = weeks.length ? weeks[0][0] : null;
  }

  document.getElementById('weeks').innerHTML = weeks
    .map(([w, label]) => `<button class="week${w === activeWeek ? ' active' : ''}" data-week="${w}">${esc(label)}</button>`)
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

if (!boardId) {
  document.getElementById('loading').hidden = true;
  document.getElementById('stack').innerHTML = '<div class="error-box">Ссылка неполная: не указан ID проекта Mattermost.</div>';
} else {
  applyBranding();
  loadTasks();
}
