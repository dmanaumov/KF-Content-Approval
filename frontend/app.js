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
// the /admin staff page.
const directBoardId = (location.pathname.match(/^\/p\/([^/]+)/) || [])[1];
const deepLinkTaskId = params.get('task');
// ?calendar=1 (or really any query key starting with "calend", case-
// insensitive — ?calend, ?Calendar, ?CALENDAR=1 all match, since the point
// is a link a human can type/paste in a hurry without getting the exact
// spelling right) — the cabinet opens straight into the calendar view
// instead of the default list. See openCalendar() call in loadTasks().
const wantsCalendarView = [...params.keys()].some((k) => k.toLowerCase().startsWith('calend'));

let boardId = directBoardId || null;
let projectFilter = params.get('project') || null; // which client this link is for, on a shared board

let state = { tasks: [], board: null };
let activeWeek = null;
let activeFilter = 'waiting'; // default view: only what actually needs the client's attention
let feedbackTaskId = '';
let busyTaskId = null;
let editingTextTaskId = '';
let reorderTaskId = ''; // task currently open in the media-order modal, '' = closed
let reorderIds = []; // working copy of that task's media ids, in the order being edited
let expandedDialogIds = new Set(); // task ids whose client<->agency dialog is expanded
// Photo attached to the правки being composed in feedbackModal, before
// "Отправить правки" is pressed — { uploading: true } while in flight, or
// { shareUrl } once done, or null. Uploaded eagerly on file pick (see
// uploadFeedbackImage), same UX as the team cabinet's chat attach.
let pendingFeedbackImage = null;
let calYear = null; // calendar view's current year/month (0-indexed month) —
let calMonth = null; // set lazily to today's month the first time it opens.

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (s) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[s]));
}

// Russian plural: plural(1,'пост','поста','постов') → "пост" etc.
function plural(n, one, few, many) {
  const n10 = n % 10;
  const n100 = n % 100;
  if (n10 === 1 && n100 !== 11) return one;
  if (n10 >= 2 && n10 <= 4 && (n100 < 10 || n100 >= 20)) return few;
  return many;
}

// The post text is written in Telegram's markdown (staff compose in Telegram,
// then paste into the card description under "Для клиента"): **bold**, *italic*, __underline__,
// ~/~~strikethrough~~, `code`, ```pre``` and [text](url). Without rendering
// the client sees the raw asterisks. Order matters for safety: escape ALL
// HTML first, only then apply the formatting tokens — so nothing unescaped
// can ever reach innerHTML.
function formatTelegram(text) {
  if (!text) return '';
  let s = esc(text);
  // Code/pre blocks are stashed away so their content is never re-processed
  // by the inline rules below (a pre block contains its own backticks).
  const stash = [];
  const hide = (html) => {
    const ph = `\u0000T${stash.length}\u0000`;
    stash.push(html);
    return ph;
  };
  s = s.replace(/```([\s\S]*?)```/g, (m, body) => hide(`<pre>${body.replace(/\n/g, '<br>')}</pre>`));
  s = s.replace(/`([^`\n]+)`/g, (m, code) => hide(`<code>${code}</code>`));

  // Inline styling — flat token pairs, the way Telegram's own parser handles
  // them. Each is replaced in turn so `**bold**` never trips the *italic* rule.
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
  s = s.replace(/__([^_\n]+)__/g, '<u>$1</u>');
  s = s.replace(/~~([^~\n]+)~~/g, '<s>$1</s>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>');
  s = s.replace(/(^|[^~])~([^~\n]+)~/g, '$1<s>$2</s>');

  // Links — only http(s) targets are accepted, never a javascript: URL.
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

  s = s.replace(/\n/g, '<br>');
  for (let i = 0; i < stash.length; i++) s = s.split(`\u0000T${i}\u0000`).join(stash[i]);
  return s;
}

function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 2600);
}

// resolvedName/resolvedLogoUrl: passed explicitly by a /l/{token} link (both
// came back from GET /api/links/:token, never from the URL) — fall back to
// the legacy ?name=/?logo= query params for a direct /p/{boardId} link.
// Single place that sets the client name/logo so a /l/ link's resolved
// values can never get clobbered by an (absent) query param afterwards.
function applyBranding(resolvedName, resolvedLogoUrl) {
  const color = params.get('color');
  const logo = resolvedLogoUrl || params.get('logo');
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

// Resolves a /l/{token} link into the {boardId, projectId, name, logoUrl}
// it currently points to, and fills in the module-level boardId/projectFilter
// used by everything else below. Throws with a user-facing message on an
// unknown/revoked token (404) or any other failure.
async function resolveLinkToken() {
  const res = await fetch(`/api/links/${encodeURIComponent(linkToken)}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || data.error || 'Не удалось открыть кабинет.');
  boardId = data.boardId;
  projectFilter = data.projectId;
  return { name: data.name || '', logoUrl: data.logoUrl || '' };
}

// A post's "Название" often starts with a shorthand for which social network
// it's meant for (agency's own convention, e.g. "IG: карусель про..." or
// "tg - анонс..."). Detected case-insensitively from the title's start only
// (\b keeps "Igor..."/"Maxim..." etc. from false-matching) and rendered as a
// colored badge instead of raw shorthand text, since "IG"/"tg" isn't
// meaningful to the client the way a recognizable network name/color is.
// "[AI]" anywhere in the title marks a post as AI-generated (agency's own
// convention, case-insensitive, works in any position relative to a network
// prefix like "IG:"). Stripped from the displayed title and shown instead as
// a glowing card border + a small badge (see .card.ai / .status.ai in
// app.css). Checked BEFORE detectSocial() below so "[AI] IG: ..." and
// "IG: [AI] ..." both work.
const AI_TAG_RE = /\[ai\]/i;
function isAiPost(title) {
  return AI_TAG_RE.test(String(title || ''));
}
function stripAiTag(title) {
  return String(title || '').replace(AI_TAG_RE, '').replace(/\s{2,}/g, ' ').trim();
}

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
  return { ...SOCIAL_MAP[m[1].toLowerCase()], matchedPrefix: m[0] };
}

// "not_started" tasks (see backend's index.js — cards still in the "Не
// начато" internal production stage, fetched separately and merged into
// state.tasks ONLY so the calendar view can show them greyed out) must stay
// invisible everywhere else in the client cabinet: week nav, list, filters,
// the attention banner. Every one of those reads from this filtered view
// instead of state.tasks directly; renderCalendar() is the one place that
// still reads state.tasks itself.
function clientFacingTasks() {
  return state.tasks.filter((t) => t.status !== 'not_started');
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

// Two possible sources: an attachment on the Mattermost card itself (Boards'
// own file storage, keyed by team+board), or a disk.kontentferma.* share
// link found in the post text/URL and proxied through our own disk-embed
// route instead. Shared by mediaHtml() and the media-order modal below.
function mediaFileUrl(m) {
  return m.source === 'disk'
    ? `/api/disk-embed?u=${encodeURIComponent(m.shareUrl)}`
    : `/api/files/${encodeURIComponent(boardId)}/${encodeURIComponent(m.fileId)}`;
}

// Two-sided dialog between the client and the agency team, built from
// taskMapper.js's clientComments: 'feedback' (client's own ПРАВКИ text) and
// 'agency' (team messages sent from the /team cabinet's "Чат с клиентом"
// tab) are real written messages, so they render as chat bubbles — client
// on the right ('mine', since this is the client's own cabinet), agency on
// the left ('theirs'). 'approved'/'correction' are system-style notices
// (card approved / media reordered etc.), not conversation, so they're left
// out here — they're already reflected elsewhere on the card (status badge,
// media order itself).
//
// Collapsed by default to just the latest message with a toggle arrow —
// see expandedDialogIds — so a returning client immediately sees what's
// new without the whole history pushing the card's action buttons down.
function clientDialogHtml(task) {
  const CHAT_SIDE = { feedback: 'mine', agency: 'theirs' };
  const messages = (task.clientComments || []).filter((c) => CHAT_SIDE[c.kind]);
  if (!messages.length) return '';
  const expanded = expandedDialogIds.has(task.id);
  const lastIndex = messages.length - 1;
  const bubbles = messages
    .map((c, i) => {
      const side = CHAT_SIDE[c.kind];
      const label = side === 'theirs' ? '<span class="client-chat-label">Агентство</span>' : '';
      const hidden = !expanded && i !== lastIndex ? ' hidden-msg' : '';
      const img = c.imageUrl
        ? `<img class="client-chat-img" src="${esc(c.imageUrl)}" alt="" loading="lazy" data-action="open-lightbox" data-src="${esc(c.imageUrl)}">`
        : '';
      return `<div class="client-chat-msg ${side}${hidden}">${label}${c.text ? esc(c.text) : ''}${img}</div>`;
    })
    .join('');
  const toggle = messages.length > 1
    ? `<button type="button" class="client-dialog-toggle" data-action="toggle-dialog" data-id="${task.id}" aria-expanded="${expanded ? 'true' : 'false'}">
        <span>${expanded ? 'Свернуть переписку' : 'Вся переписка'}</span>
        <svg viewBox="0 0 24 24" aria-hidden="true" width="14" height="14"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>`
    : '';
  return `<div class="client-dialog${expanded ? ' expanded' : ''}">${bubbles}${toggle}</div>`;
}

function mediaHtml(task, canReorder) {
  if (!task.media.length) {
    return '<div class="media"><div class="carousel"><div class="slide file-link"><div><b>Без вложений</b></div></div></div></div>';
  }
  const slides = task.media
    .map((m) => {
      const fileUrl = mediaFileUrl(m);
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
  // Reordering only makes sense with 2+ items, and only while the post is
  // still editable (same gate as the text-edit pencil — an approved/
  // published post's media is final).
  const reorderBtn = canReorder && task.media.length > 1
    ? `<button type="button" class="media-reorder-btn" data-action="open-media-order" data-id="${task.id}" aria-label="Изменить порядок фото/видео" title="Изменить порядок фото/видео">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 7l0 10M8 7L5 10M8 7l3 3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M16 17l0-10M16 17l3-3M16 17l-3-3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>`
    : '';
  return `<div class="media">${reorderBtn}<div class="carousel" data-count="${task.media.length}">${slides}</div>${counter}</div>`;
}

function cardHtml(task) {
  const st = statusInfo(task.status);
  const busy = busyTaskId === task.id;
  const urgent = isUrgent(task);
  const ai = isAiPost(task.title);
  const editingText = editingTextTaskId === task.id;
  const canEditText = task.status !== 'approved' && task.status !== 'published';
  const swipeable = canEditText;
  let actions;
  if (task.status === 'approved') {
    actions = '<div class="actions"><div class="approved-box">✓ Согласовано</div></div>';
  } else if (task.status === 'published') {
    // Terminal state — nothing left for the client to do here.
    actions = '<div class="actions"><div class="approved-box published-box">🔗 Опубликовано</div></div>';
  } else {
    actions = `<div class="actions">
           <button class="btn approve" ${busy ? 'disabled' : ''} data-action="approve" data-id="${task.id}">Согласовать</button>
           <button class="btn changes" ${busy ? 'disabled' : ''} data-action="open-feedback" data-id="${task.id}">Правки/комментарии</button>
         </div>`;
  }
  const dateBadge = task.publishDate
    ? `<span class="status date" title="Плановая дата публикации">${esc(formatDatePill(task.publishDate))}</span>`
    : '';
  const urlLink = task.url
    ? `<div class="post-link"><a href="${esc(task.url)}" target="_blank" rel="noopener">Открыть опубликованный пост →</a></div>`
    : '';
  const aiAvatar = ai
    ? '<button type="button" class="ai-avatar" data-action="ai-info" title="Этот пост сгенерирован с помощью ИИ"><img src="/ai-avatar.png" alt="" loading="lazy"></button>'
    : '';
  const aiDisclaimer = ai
    ? '<div class="ai-disclaimer">⚠️ Материал подготовлен с помощью ИИ и может содержать неточности. Проверка фактов и ответственность за публикацию — на стороне пользователя.</div>'
    : '';
  const urgentBadge = urgent ? '<span class="status urgent">🔥 ГОРИТ!</span>' : '';
  const aiBadge = ai ? '<span class="status ai">✨ AI</span>' : '';
  const titleClean = ai ? stripAiTag(task.title) : task.title;
  const social = detectSocial(titleClean);
  const displayTitle = social ? titleClean.slice(social.matchedPrefix.length) : titleClean;
  const socialBadge = social
    ? `<span class="social-badge" style="background:${esc(social.color)}" title="${esc(social.label)}">${esc(social.short)}</span>`
    : '';
  const captionText = task.caption || '';
  const captionBlock = (captionText || editingText || canEditText)
    ? editingText
      ? `<div class="caption-wrap editing">
          <div class="caption-head">
            <div class="caption-tip">Исправьте текст для клиента</div>
            <div class="caption-head-actions">
              <button type="button" class="caption-btn cancel" ${busy ? 'disabled' : ''} data-action="cancel-text" data-id="${task.id}">Отмена</button>
              <button type="button" class="caption-btn save" ${busy ? 'disabled' : ''} data-action="save-text" data-id="${task.id}">Сохранить</button>
            </div>
          </div>
          <textarea class="caption-editor" data-caption-editor="${task.id}" spellcheck="true" ${busy ? 'readonly' : ''}>${esc(captionText)}</textarea>
        </div>`
      : `<div class="caption-wrap${captionText ? '' : ' empty'}">
          <div class="caption-head">
            <div class="caption-tip">${captionText ? '' : 'Текст ещё не задан. Можно добавить сразу здесь.'}</div>
            ${canEditText ? `<button type="button" class="caption-edit" ${busy ? 'disabled' : ''} data-action="edit-text" data-id="${task.id}" aria-label="Правка текста" title="Правка текста">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4l10-10a2.8 2.8 0 0 0-4-4L4 16v4z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M13.5 6.5l4 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
            </button>` : ''}
          </div>
          ${captionText ? `<div class="caption open">${formatTelegram(captionText)}</div>` : ''}
        </div>`
    : '';
  // Ключевые слова/мысли — agency-internal planning notes (brief/keywords/
  // рубрика/funnel stage, see backend's taskMapper.js), shown small and
  // read-only under the post text — just enough for the client to see the
  // thinking behind the post, not editable here.
  const keywordsText = (task.keywords || '').trim();
  const keywordsBlock = keywordsText
    ? `<div class="keywords-note"><span class="keywords-note-icon">💡</span><span class="keywords-note-text">${esc(keywordsText)}</span></div>`
    : '';
  const article = `<article class="card${swipeable ? ' swipeable' : ''}${busy ? ' pending-action' : ''}${urgent ? ' urgent' : ''}${ai ? ' ai' : ''}" id="task-${esc(task.id)}" data-task-id="${esc(task.id)}">
    ${aiAvatar}
    <div class="meta">
      <div class="meta-left">
        ${task.format ? `<div class="eyebrow">${esc(task.format)}</div>` : ''}
        <h2>${socialBadge}<span class="h2-text">${esc(displayTitle)}</span></h2>
      </div>
      <div class="badges">
        ${aiBadge}
        ${urgentBadge}
        ${dateBadge}
        <span class="status ${st.cls}">${st.text}</span>
      </div>
    </div>
    ${mediaHtml(task, canEditText)}
    ${captionBlock}
    ${keywordsBlock}
    ${urlLink}
    ${clientDialogHtml(task)}
    ${actions}
    ${aiDisclaimer}
  </article>`;

  // Swipeable cards (anything still awaiting a decision) sit in a wrapper
  // with two behind-the-card zones that light up green (approve) / red
  // (changes) as the card is dragged — see the swipe handlers below.
  if (!swipeable) return article;
  return `<div class="swipe-wrap">
    <div class="swipe-zone right"><span>✓ СОГЛАСОВАТЬ</span></div>
    ${article}
    <div class="swipe-zone left"><span>✎ ЕСТЬ ПРАВКИ</span></div>
  </div>`;
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
const CAL_DOT_CLASS = { waiting: 'waiting', approved: 'approved', changes: 'changes', published: 'published', not_started: 'not-started' };
function calMarkerHtml(task) {
  if (isUrgent(task)) return '<span class="cal-mark fire" aria-hidden="true">🔥</span>';
  const cls = CAL_DOT_CLASS[task.status] || 'waiting';
  return `<span class="cal-mark dot ${cls}" aria-hidden="true"></span>`;
}

function scrollToTask(id) {
  const el = document.getElementById(`task-${id}`);
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// Jumps to a specific post: switches to its week, clears any filter so the
// card is actually rendered, then smooth-scrolls to it. Shared by the
// attention panel links and anything else that needs "take me to this card".
function focusTask(id) {
  const task = state.tasks.find((t) => t.id === id);
  if (!task) return;
  if (task.weekStart) activeWeek = task.weekStart;
  activeFilter = '';
  document.querySelectorAll('.filter').forEach((x) => x.classList.toggle('active', x.dataset.filter === ''));
  render();
  scrollToTask(id);
}

// Top info strip, two rows:
//   Row 1 — approval status: burning posts (accent #ff5f60, click → jump to
//     that card) + total posts awaiting approval (click → jump to the oldest).
//     Burning only shown if any; if there are waiting but no burning → soft green.
//   Row 2 — nearest upcoming publication: date — first ~20 chars of the title
//     (click → jump to that card).
// Computed across ALL the client's tasks (not the active week).
function updateAttention() {
  const el = document.getElementById('attention');
  const all = clientFacingTasks();
  if (!all.length) { el.hidden = true; return; }

  const waiting = all.filter((t) => t.status === 'waiting');
  const urgent = waiting.filter(isUrgent);
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const byDate = (a, b) => (a.publishDate || '9999').localeCompare(b.publishDate || '9999');

  // Row 1.
  const row1 = [];
  let stateClass = 'clear';
  if (urgent.length) {
    stateClass = 'urgent';
    const hottest = urgent.slice().sort(byDate)[0];
    const g = urgent.length;
    row1.push(`<button class="attention-link" data-scroll="${hottest.id}">🔥 ${g} ${plural(g, 'горящий пост', 'горящих поста', 'горящих постов')} — срочно рассмотреть!</button>`);
  }
  if (waiting.length) {
    if (stateClass !== 'urgent') stateClass = 'waiting';
    const oldest = waiting.slice().sort(byDate)[0];
    const w = waiting.length;
    row1.push(`<button class="attention-link" data-scroll="${oldest.id}">${w} ${plural(w, 'пост', 'поста', 'постов')} на согласовании</button>`);
  }

  // Row 2 — nearest upcoming publication.
  const nextPub = all
    .filter((t) => t.publishDate && t.publishDate >= today)
    .sort(byDate)[0];

  let html = '';
  if (row1.length) html += `<div class="attention-row1">${row1.join(' · ')}</div>`;
  if (nextPub) {
    const short = nextPub.title.length > 20 ? `${nextPub.title.slice(0, 20)}…` : nextPub.title;
    html += `<button class="attention-link attention-row2" data-scroll="${nextPub.id}">Ближайшая публикация: ${formatDatePill(nextPub.publishDate)} — ${esc(short)}</button>`;
  }
  if (!html) html = '<div class="attention-row1">Все посты согласованы</div>';

  el.className = `attention ${stateClass}`;
  el.innerHTML = html;
  el.hidden = false;
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
      .map((t) => {
        // Первые 500 символов, не полностью (пользователь сперва попросил
        // ЦЕЛИКОМ, затем поправился — это слишком длинно для карточки дня).
        // white-space:pre-wrap в app.css сохраняет переносы между абзацами
        // исходного поля ("Ключевые слова: ...\n\nИдея поста: ...", см.
        // backend/src/taskMapper.js) в пределах этого отрывка.
        const kwFull = (t.keywords || '').trim();
        const kw = kwFull.length > 500 ? `${kwFull.slice(0, 500)}…` : kwFull;
        const kwHtml = kw ? `<span class="cal-post-keywords">${esc(kw)}</span>` : '';
        const notStarted = t.status === 'not_started';
        const cls = `cal-post${notStarted ? ' cal-post-not-started' : ''}`;
        // Подсказка при наведении — только для "не начато": в ячейке сам
        // текст уже виден (title+первые 500 символов keywords), а вот у
        // этих карточек нет перехода по клику (см. clientFacingTasks/клик-
        // обработчик calendarGrid — просто toast), поэтому вся сводка на
        // hover: проект, дата, статус, тема, ключевые слова целиком.
        const notStartedTip = notStarted
          ? ` title="${esc(
              [t.projectLabel || '', formatDatePill(t.publishDate), 'Не начато', t.title, kwFull].filter(Boolean).join('\n')
            )}"`
          : '';
        return `<button type="button" class="${cls}" data-task-id="${esc(t.id)}"${notStartedTip}>${calMarkerHtml(t)}<span class="cal-post-body"><span class="cal-post-title">${esc(t.title)}</span>${kwHtml}</span></button>`;
      })
      .join('');
    const cls = `cal-day${inMonth ? '' : ' other-month'}${dateStr === todayStr ? ' today' : ''}`;
    cells.push(`<div class="${cls}"><div class="cal-day-num">${d.getUTCDate()}</div>${posts}</div>`);
  }
  document.getElementById('calendarGrid').innerHTML = cells.join('');
}

// Чистое переключение вида, без истории/URL — используется и открытием по
// кнопке (openCalendar ниже), и синхронизацией с адресной строкой при её
// изменении (см. applyCalendarViewFromLocation/popstate ниже), и авто-
// открытием по "?calend"-ссылке при первой загрузке страницы (там URL уже
// правильный, пушить в историю ещё раз не нужно).
function showCalendarView(on) {
  document.getElementById('listHead').hidden = on;
  document.getElementById('listView').hidden = on;
  document.getElementById('calendarView').hidden = !on;
  hideCalPostPopup();
  if (on) renderCalendar();
}

// Попап с полной информацией по "не начато"-карточке в календаре клиента —
// такие карточки не ведут в список (см. clientFacingTasks), а короткий
// hover-title неудобен на телефоне, поэтому по клику показываем компактную
// карточку рядом с постом: проект, дата, статус, тема, ключевые слова
// целиком (не обрезанные 500 символами, в отличие от текста в самой ячейке).
function hideCalPostPopup() {
  const pop = document.getElementById('calPostPopup');
  if (pop) pop.hidden = true;
}

function showCalPostPopup(anchorEl, task) {
  const pop = document.getElementById('calPostPopup');
  const kw = (task.keywords || '').trim();
  const rows = [
    task.projectLabel ? `<div class="cal-popup-row"><span class="cal-popup-label">Проект:</span> ${esc(task.projectLabel)}</div>` : '',
    `<div class="cal-popup-row"><span class="cal-popup-label">Дата:</span> ${esc(formatDatePill(task.publishDate))}</div>`,
    `<div class="cal-popup-row"><span class="cal-popup-label">Статус:</span> Не начато</div>`,
    `<div class="cal-popup-row"><span class="cal-popup-label">Тема:</span> ${esc(task.title)}</div>`,
    kw ? `<div class="cal-popup-row cal-popup-kw"><span class="cal-popup-label">Ключевые слова:</span><br>${esc(kw)}</div>` : '',
  ].filter(Boolean).join('');
  pop.innerHTML = rows;
  pop.hidden = false;

  // Позиционирование — fixed относительно вьюпорта (карточка внутри
  // скроллящейся сетки), клампится в границы экрана; меряем реальные
  // размеры попапа ПОСЛЕ того как контент уже вставлен и он видим.
  const margin = 8;
  const r = anchorEl.getBoundingClientRect();
  const pw = pop.offsetWidth;
  const ph = pop.offsetHeight;
  let left = r.left;
  let top = r.bottom + margin;
  if (left + pw > window.innerWidth - margin) left = window.innerWidth - pw - margin;
  if (left < margin) left = margin;
  if (top + ph > window.innerHeight - margin) top = r.top - ph - margin;
  if (top < margin) top = margin;
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
}

// Клик в любом другом месте страницы — закрыть попап. Клик по ДРУГОЙ
// "не начато"-карточке не должен здесь закрывать попап — её откроет
// обработчик calendarGrid (см. ниже), а этот document-слушатель просто
// не должен успеть его тут же спрятать.
document.addEventListener('click', (e) => {
  const pop = document.getElementById('calPostPopup');
  if (!pop || pop.hidden) return;
  if (pop.contains(e.target)) return;
  if (e.target.closest('.cal-post-not-started')) return;
  hideCalPostPopup();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') hideCalPostPopup();
});
window.addEventListener('resize', hideCalPostPopup);

// Убирает/добавляет флаг календаря в URL, сохраняя остальные query-параметры
// как есть (?project=, ?color= и т.п. — актуально для /p/{boardId}-ссылок).
function withCalendarFlag(on) {
  const url = new URL(location.href);
  [...url.searchParams.keys()]
    .filter((k) => k.toLowerCase().startsWith('calend'))
    .forEach((k) => url.searchParams.delete(k));
  if (on) url.searchParams.set('calendar', '1');
  return url;
}

// Нажатие 🗓️ — переходим на адрес именно с ?calendar=1 (pushState, новая
// запись в истории), чтобы ЭТОТ адрес из адресной строки можно было
// скопировать и отправить клиенту как прямую ссылку на календарь (см.
// запрос пользователя — раньше URL не менялся вообще). Новая запись в
// истории даёт открытию "бесплатную" системную кнопку "назад" — она тоже
// закрывает календарь, см. popstate ниже.
function openCalendar() {
  history.pushState({ kfCalendar: true }, '', withCalendarFlag(true).toString());
  showCalendarView(true);
}

function closeCalendar() {
  // Если календарь был открыт именно нашим pushState (обычный путь — кнопка
  // 🗓️ или клик по карточке в сетке) — используем history.back(), а не
  // ещё один pushState, чтобы не плодить бесполезные записи в истории;
  // popstate ниже сам приведёт вид и URL в соответствие. Если календарь
  // сейчас открыт без нашей записи в истории (например, страница
  // загрузилась сразу с ?calend в адресе — см. loadTasks) — откатывать
  // назад нечего, просто заменяем текущую запись без флага.
  if (history.state && history.state.kfCalendar) {
    history.back();
  } else {
    history.replaceState({}, '', withCalendarFlag(false).toString());
    showCalendarView(false);
  }
}

// Синхронизирует вид с тем, что реально написано в адресной строке —
// вызывается и при popstate (кнопка "назад"/"вперёд" браузера), и не
// требует отдельного вызова при обычной загрузке страницы (см. loadTasks).
function applyCalendarViewFromLocation() {
  const p = new URLSearchParams(location.search);
  const wants = [...p.keys()].some((k) => k.toLowerCase().startsWith('calend'));
  showCalendarView(wants);
}
window.addEventListener('popstate', applyCalendarViewFromLocation);

function render() {
  const tasks = clientFacingTasks();
  const weeks = weeksOf(tasks);
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

  const inWeek = tasks.filter((t) => t.weekStart === activeWeek);
  const approved = inWeek.filter((t) => t.status === 'approved').length;
  document.getElementById('progressFill').style.width = (inWeek.length ? (approved / inWeek.length) * 100 : 0) + '%';
  document.getElementById('progressText').textContent = `${approved} из ${inWeek.length} согласовано`;

  // Nothing left to approve anywhere (no 'waiting' task across the whole
  // board) → celebrate with the mascot and make sure the "Все" filter is
  // active so the approved posts are actually visible below it.
  const nothingToApprove = !tasks.some((t) => t.status === 'waiting');
  if (nothingToApprove && activeFilter) {
    activeFilter = '';
    document.querySelectorAll('.filter').forEach((x) => x.classList.toggle('active', x.dataset.filter === ''));
  }

  const visible = inWeek.filter((t) => !activeFilter || t.status === activeFilter);
  const mascot = nothingToApprove
    ? `<div class="all-done">
        <img class="all-done-mascot" src="/mascot.png" alt="КРАСАВА">
        <div>
          <div class="all-done-title">Всё согласовано!</div>
          <div class="all-done-sub">Ничего не ждёт вашего решения. Ниже — согласованные посты.</div>
        </div>
      </div>`
    : '';
  const cards = visible.map(cardHtml).join('');
  document.getElementById('stack').innerHTML =
    mascot + (cards || (nothingToApprove ? '' : '<div class="empty">Здесь пока ничего нет.</div>'));

  if (deepLinkTaskId) {
    const el = document.getElementById(`task-${deepLinkTaskId}`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  updateAttention();
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
      // Clear the status filter so the linked card actually renders even if
      // it's not "waiting" (same as focusTask does for attention-panel links).
      activeFilter = '';
      document.querySelectorAll('.filter').forEach((x) => x.classList.toggle('active', x.dataset.filter === ''));
    }
    render();
    // Auto-open the calendar for a "?calendar=1"-flagged link — done after
    // the normal render() above (not instead of it) so the list is already
    // built and ready underneath the moment someone taps "Назад". Плоское
    // showCalendarView (не openCalendar) — URL уже правильный при заходе по
    // такой ссылке, лишняя запись в истории тут не нужна.
    if (wantsCalendarView) showCalendarView(true);
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

async function saveTextEdit(taskId) {
  const textarea = document.querySelector(`[data-caption-editor="${taskId}"]`);
  if (!textarea) return;
  const text = textarea.value.replace(/\r\n/g, '\n');
  if (!text.trim()) {
    toast('Текст не может быть пустым');
    return;
  }
  busyTaskId = taskId;
  render();
  try {
    const res = await fetch(`/api/boards/${encodeURIComponent(boardId)}/tasks/${encodeURIComponent(taskId)}/text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || data.error);
    state.tasks = state.tasks.map((t) => (t.id === taskId ? data.task : t));
    editingTextTaskId = '';
    toast('Текст обновлён');
  } catch (err) {
    toast('Не удалось сохранить текст: ' + err.message);
  } finally {
    busyTaskId = null;
    render();
  }
}

// Media-order modal: a plain sheet with an up/down-arrow list, not
// drag-and-drop — the card list already has a Tinder-style horizontal swipe
// gesture and the carousel itself scrolls horizontally, so a drag surface
// here would fight both. Arrows are unambiguous and work identically on
// touch and mouse.
function mediaKindLabel(kind) {
  return kind === 'image' ? 'Фото' : kind === 'video' ? 'Видео' : 'Файл';
}

function openMediaOrder(id) {
  const task = state.tasks.find((t) => t.id === id);
  if (!task) return;
  reorderTaskId = id;
  reorderIds = task.media.map((m) => m.id);
  renderMediaOrderList();
  document.getElementById('mediaOrderModal').classList.add('show');
}

function closeMediaOrder() {
  document.getElementById('mediaOrderModal').classList.remove('show');
  reorderTaskId = '';
  reorderIds = [];
}

function renderMediaOrderList() {
  const task = state.tasks.find((t) => t.id === reorderTaskId);
  const list = document.getElementById('moList');
  if (!task || !list) return;
  const byId = new Map(task.media.map((m) => [m.id, m]));
  list.innerHTML = reorderIds
    .map((id, i) => {
      const m = byId.get(id);
      if (!m) return '';
      const thumb = m.kind === 'image'
        ? `<img class="mo-thumb" src="${mediaFileUrl(m)}" alt="" loading="lazy">`
        : `<div class="mo-thumb mo-thumb-icon">${m.kind === 'video' ? '🎬' : '📄'}</div>`;
      return `<div class="mo-row">
        ${thumb}
        <div class="mo-label">${i + 1}. ${esc(m.name || mediaKindLabel(m.kind))}</div>
        <div class="mo-arrows">
          <button type="button" class="mo-btn" data-action="mo-up" data-id="${id}" ${i === 0 ? 'disabled' : ''} aria-label="Выше">↑</button>
          <button type="button" class="mo-btn" data-action="mo-down" data-id="${id}" ${i === reorderIds.length - 1 ? 'disabled' : ''} aria-label="Ниже">↓</button>
        </div>
      </div>`;
    })
    .join('');
}

function moveMediaOrder(id, dir) {
  const i = reorderIds.indexOf(id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= reorderIds.length) return;
  [reorderIds[i], reorderIds[j]] = [reorderIds[j], reorderIds[i]];
  renderMediaOrderList();
}

async function saveMediaOrder() {
  if (!reorderTaskId) return;
  const taskId = reorderTaskId;
  const order = reorderIds.slice();
  busyTaskId = taskId;
  render();
  try {
    const res = await fetch(`/api/boards/${encodeURIComponent(boardId)}/tasks/${encodeURIComponent(taskId)}/media-order`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || data.error);
    state.tasks = state.tasks.map((t) => (t.id === taskId ? data.task : t));
    closeMediaOrder();
    toast('Порядок обновлён');
  } catch (err) {
    toast('Не удалось сохранить порядок: ' + err.message);
  } finally {
    busyTaskId = null;
    render();
  }
}

document.getElementById('moList').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  if (btn.dataset.action === 'mo-up') moveMediaOrder(btn.dataset.id, -1);
  if (btn.dataset.action === 'mo-down') moveMediaOrder(btn.dataset.id, 1);
});
document.querySelector('[data-action="close-media-order"]').addEventListener('click', closeMediaOrder);
document.querySelector('[data-action="save-media-order"]').addEventListener('click', saveMediaOrder);

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

function openFeedbackFor(id) {
  feedbackTaskId = id;
  const task = state.tasks.find((t) => t.id === id);
  document.getElementById('feedbackTitle').textContent = task ? task.title : '';
  document.getElementById('feedbackText').value = '';
  pendingFeedbackImage = null;
  renderFeedbackImagePreview();
  document.getElementById('feedbackModal').classList.add('show');
}

// Превью прикреплённого к правкам фото — миниатюра + крестик убрать, либо
// пусто, пока ничего не выбрано. Отдельная маленькая функция (не полный
// render()), потому что модалка правок не участвует в общем цикле
// перерисовки карточек.
function renderFeedbackImagePreview() {
  const el = document.getElementById('feedbackImagePreview');
  if (!pendingFeedbackImage) { el.hidden = true; el.innerHTML = ''; return; }
  el.hidden = false;
  el.innerHTML = `<div class="fb-pending-img${pendingFeedbackImage.uploading ? ' uploading' : ''}">
    ${pendingFeedbackImage.shareUrl ? `<img src="${esc(pendingFeedbackImage.shareUrl)}" alt="">` : ''}
    <button type="button" class="fb-pending-remove" data-action="remove-feedback-image" aria-label="Убрать фото">✕</button>
  </div>`;
}

async function uploadFeedbackImage(taskId, file) {
  pendingFeedbackImage = { uploading: true };
  renderFeedbackImagePreview();
  try {
    const form = new FormData();
    form.append('file', file);
    const res = await fetch(`/api/boards/${encodeURIComponent(boardId)}/tasks/${encodeURIComponent(taskId)}/feedback-image`, { method: 'POST', body: form });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      pendingFeedbackImage = null;
      toast(
        data.error === 'disk_upload_not_configured'
          ? 'Загрузка фото ещё не настроена — опишите правки текстом.'
          : 'Не удалось загрузить фото: ' + (data.message || data.error || 'ошибка')
      );
      renderFeedbackImagePreview();
      return;
    }
    pendingFeedbackImage = { uploading: false, shareUrl: data.shareUrl };
    renderFeedbackImagePreview();
  } catch (err) {
    pendingFeedbackImage = null;
    toast('Не удалось загрузить фото: ' + err.message);
    renderFeedbackImagePreview();
  }
}

// Tinder-style swipe approval, list view only (the cards in #stack — the
// calendar view has no cards to swipe). Only non-terminal cards are
// swipeable (same set that gets the Согласовать/Есть правки buttons): drag
// right → green "✓ СОГЛАСОВАТЬ" zone lights up behind the card and, past a
// threshold, approves; drag left → red "✎ ЕСТЬ ПРАВКИ" zone and opens the
// feedback popup. Pointer events so it works for both touch and mouse; the
// buttons stay as the no-gesture fallback.
const SWIPE_THRESHOLD = 96;
const SWIPE_ZONE_MAX = 90; // px of drag needed to fully reveal a zone
let swipe = null;
let suppressClick = false;

function swipeWrapOf(card) {
  const wrap = card.parentElement;
  return wrap && wrap.classList.contains('swipe-wrap') ? wrap : null;
}

function applySwipe(dx) {
  const rot = Math.max(-12, Math.min(12, dx / 12));
  swipe.card.style.transform = `translateX(${dx}px) rotate(${rot}deg)`;
  const progress = Math.min(1, Math.abs(dx) / SWIPE_ZONE_MAX);
  swipe.wrap.querySelector('.swipe-zone.right').style.opacity = dx > 0 ? progress : 0;
  swipe.wrap.querySelector('.swipe-zone.left').style.opacity = dx < 0 ? progress : 0;
  swipe.wrap.classList.toggle('swipe-right', dx > 30);
  swipe.wrap.classList.toggle('swipe-left', dx < -30);
}

function resetSwipe() {
  const { card, wrap } = swipe;
  card.classList.remove('swiping');
  wrap.classList.remove('swiping', 'swipe-right', 'swipe-left');
  card.style.transform = '';
  wrap.querySelectorAll('.swipe-zone').forEach((z) => { z.style.opacity = ''; });
}

function finishSwipe() {
  const { card, dx } = swipe;
  swipe = null;
  const wrap = swipeWrapOf(card);
  if (Math.abs(dx) < SWIPE_THRESHOLD) {
    card.classList.remove('swiping');
    card.style.transform = '';
    wrap.classList.remove('swiping', 'swipe-right', 'swipe-left');
    wrap.querySelectorAll('.swipe-zone').forEach((z) => { z.style.opacity = ''; });
    return;
  }
  const dir = dx > 0 ? 'right' : 'left';
  const id = card.dataset.taskId;
  card.classList.remove('swiping');
  card.classList.add('flying', dir);
  card.style.transform = `translateX(${dir === 'right' ? '130%' : '-130%'}) rotate(${dir === 'right' ? 14 : -14}deg)`;
  wrap.classList.remove('swiping', 'swipe-right', 'swipe-left');
  wrap.querySelectorAll('.swipe-zone').forEach((z) => { z.style.opacity = ''; });
  suppressClick = true;
  setTimeout(() => { suppressClick = false; }, 150);
  setTimeout(() => {
    if (dir === 'right') approve(id);
    else openFeedbackFor(id);
  }, 240);
}

function tryStartSwipe(card, x, y) {
  if (swipe || busyTaskId) return false;
  if (!card || !swipeWrapOf(card)) return false;
  swipe = {
    card, wrap: swipeWrapOf(card),
    startX: x, startY: y,
    dx: 0, dy: 0, locked: false,
    touchId: null, ptPointerId: null,
  };
  return true;
}

// Returns true when the gesture is being handled (caller may preventDefault
// so the browser doesn't steal the drag into a scroll); false when it should
// be left to the browser (tiny move or clear vertical intent).
function moveSwipe(x, y) {
  if (!swipe) return false;
  swipe.dx = x - swipe.startX;
  swipe.dy = y - swipe.startY;
  if (!swipe.locked) {
    if (Math.abs(swipe.dx) < 8 && Math.abs(swipe.dy) < 8) return false;
    if (Math.abs(swipe.dy) > Math.abs(swipe.dx) * 1.6 && Math.abs(swipe.dy) > 14) { swipe = null; return false; }
    swipe.locked = true;
    swipe.card.classList.add('swiping');
    swipe.wrap.classList.add('swiping');
  }
  applySwipe(swipe.dx);
  return true;
}

function endSwipe() {
  if (!swipe) return;
  if (!swipe.locked) { swipe = null; return; }
  finishSwipe(); // clears swipe
}

function cancelSwipe() {
  if (!swipe) return;
  // The browser stole the gesture (vertical scroll, edge-back,
  // pull-to-refresh). If the card was already dragged past the threshold,
  // still commit the swipe instead of silently snapping back — otherwise a
  // good swipe dies at the last moment. Below the threshold → clean reset.
  if (swipe.locked) {
    if (Math.abs(swipe.dx) >= SWIPE_THRESHOLD) finishSwipe();
    else resetSwipe();
  }
  swipe = null;
}

// Touch (iPhone etc.): legacy touch events with preventDefault() in
// touchmove — unlike pointer events, this reliably stops iOS Safari from
// stealing the drag into a scroll once horizontal intent is confirmed.
// touch-action stays pan-y so vertical page scrolling over cards still works.
const stackEl = document.getElementById('stack');
stackEl.addEventListener('touchstart', (e) => {
  if (e.touches.length !== 1) return;
  const t = e.touches[0];
  const card = t.target.closest('.card.swipeable');
  if (!card) return;
  if (t.target.closest('button, a, input, textarea, select')) return;
  // Starting the drag on the photo carousel itself is left entirely to the
  // browser's native horizontal scroll (see .carousel's touch-action in
  // app.css) — otherwise flipping through photos gets hijacked into an
  // approve/changes swipe, which is exactly the complaint this guards
  // against. The approve/changes swipe still works from anywhere else on
  // the card (caption, background, dots).
  if (t.target.closest('.carousel')) return;
  if (!tryStartSwipe(card, t.clientX, t.clientY)) return;
  swipe.touchId = t.identifier;
}, { passive: true });
stackEl.addEventListener('touchmove', (e) => {
  if (!swipe || swipe.touchId == null) return;
  let t = null;
  for (let i = 0; i < e.changedTouches.length; i++) {
    if (e.changedTouches[i].identifier === swipe.touchId) { t = e.changedTouches[i]; break; }
  }
  if (!t) return;
  if (moveSwipe(t.clientX, t.clientY) && e.cancelable) e.preventDefault();
}, { passive: false });
stackEl.addEventListener('touchend', (e) => {
  if (!swipe || swipe.touchId == null) return;
  for (let i = 0; i < e.changedTouches.length; i++) {
    if (e.changedTouches[i].identifier === swipe.touchId) {
      swipe.touchId = null;
      endSwipe();
      return;
    }
  }
}, { passive: true });
stackEl.addEventListener('touchcancel', (e) => {
  if (!swipe || swipe.touchId == null) return;
  swipe.touchId = null;
  cancelSwipe();
}, { passive: true });

// Mouse/trackpad: pointer events. Touch pointer events are ignored here —
// the touch handlers above own the gesture on touch devices.
stackEl.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'touch') return;
  if (e.button !== 0) return;
  const card = e.target.closest('.card.swipeable');
  if (!card) return;
  if (e.target.closest('button, a, input, textarea, select')) return;
  if (e.target.closest('.carousel')) return; // see touchstart above
  if (!tryStartSwipe(card, e.clientX, e.clientY)) return;
  swipe.ptPointerId = e.pointerId;
});
stackEl.addEventListener('pointermove', (e) => {
  if (!swipe || swipe.ptPointerId == null || swipe.ptPointerId !== e.pointerId) return;
  if (moveSwipe(e.clientX, e.clientY)) {
    if (e.cancelable) e.preventDefault();
    try { swipe.card.setPointerCapture(e.pointerId); } catch (_) {}
  }
});
stackEl.addEventListener('pointerup', endSwipe);
stackEl.addEventListener('pointercancel', cancelSwipe);

document.getElementById('stack').addEventListener('click', (e) => {
  if (suppressClick) return;
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const id = btn.dataset.id;
  if (btn.dataset.action === 'approve') approve(id);
  if (btn.dataset.action === 'open-feedback') openFeedbackFor(id);
  if (btn.dataset.action === 'edit-text') {
    editingTextTaskId = id;
    render();
    requestAnimationFrame(() => {
      const ta = document.querySelector(`[data-caption-editor="${id}"]`);
      if (ta) {
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
      }
    });
  }
  if (btn.dataset.action === 'cancel-text') {
    editingTextTaskId = '';
    render();
  }
  if (btn.dataset.action === 'save-text') saveTextEdit(id);
  if (btn.dataset.action === 'open-media-order') openMediaOrder(id);
  if (btn.dataset.action === 'ai-info') toast('✨ Этот пост сгенерирован с помощью ИИ');
  if (btn.dataset.action === 'toggle-dialog') {
    if (expandedDialogIds.has(id)) expandedDialogIds.delete(id);
    else expandedDialogIds.add(id);
    render();
  }
  if (btn.dataset.action === 'open-lightbox') {
    openLightbox(btn.dataset.src);
  }
});

// Полноэкранный просмотр фото из переписки с агентством — миниатюра в
// сообщении "всплывает" до 80% экрана (см. .lightbox img в app.css), фон и
// крестик закрывают. history.pushState при открытии + popstate — так
// аппаратная/жестовая кнопка "назад" на телефоне тоже просто закрывает
// фото, а не уводит с карточки.
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
    lightboxOpenedViaHistory = false;
    closeLightbox();
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && lightboxEl && !lightboxEl.hidden) closeLightbox();
});

document.querySelector('[data-action="close-feedback"]').addEventListener('click', () => {
  document.getElementById('feedbackModal').classList.remove('show');
});

document.querySelector('[data-action="send-feedback"]').addEventListener('click', () => {
  const text = document.getElementById('feedbackText').value.trim();
  const imageUrl = pendingFeedbackImage && pendingFeedbackImage.shareUrl;
  if (!text && !imageUrl) { toast('Напишите комментарий или приложите фото'); return; }
  if (pendingFeedbackImage && pendingFeedbackImage.uploading) { toast('Фото ещё загружается…'); return; }
  document.getElementById('feedbackModal').classList.remove('show');
  // Ссылка на фото уходит последней строкой того же текста — тот же
  // формат, что уже понимает taskMapper.js на бэкенде (см. imageUrl в
  // clientComments), плюс сама СОГЛАСОВАНО/ПРАВКИ-обработка ничего не
  // теряет: карточка Mattermost получает и текст, и ссылку одним комментом.
  const comment = imageUrl ? `${text}${text ? '\n' : ''}${imageUrl}` : text;
  sendFeedback(feedbackTaskId, comment);
});

document.querySelector('[data-action="pick-feedback-image"]').addEventListener('click', () => {
  document.getElementById('feedbackFileInput').click();
});

document.getElementById('feedbackFileInput').addEventListener('change', (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (file && feedbackTaskId) uploadFeedbackImage(feedbackTaskId, file);
});

document.getElementById('feedbackImagePreview').addEventListener('click', (e) => {
  if (e.target.closest('[data-action="remove-feedback-image"]')) {
    pendingFeedbackImage = null;
    renderFeedbackImagePreview();
  }
});

document.getElementById('attention').addEventListener('click', (e) => {
  const btn = e.target.closest('.attention-link');
  if (!btn) return;
  focusTask(btn.dataset.scroll);
});

document.getElementById('calendarToggle').addEventListener('click', openCalendar);
document.getElementById('calBack').addEventListener('click', closeCalendar);
document.getElementById('calPrev').addEventListener('click', () => {
  calMonth--;
  if (calMonth < 0) { calMonth = 11; calYear--; }
  hideCalPostPopup();
  renderCalendar();
});
document.getElementById('calNext').addEventListener('click', () => {
  calMonth++;
  if (calMonth > 11) { calMonth = 0; calYear++; }
  hideCalPostPopup();
  renderCalendar();
});
document.getElementById('calendarGrid').addEventListener('click', (e) => {
  const btn = e.target.closest('.cal-post');
  if (!btn) return;
  const id = btn.dataset.taskId;
  const task = state.tasks.find((t) => t.id === id);
  // "Не начато" карточки не существуют в списке (см. clientFacingTasks) —
  // перехода туда нет, вместо этого по клику показываем попап с полной
  // информацией по посту (см. showCalPostPopup выше).
  if (task && task.status === 'not_started') {
    showCalPostPopup(btn, task);
    return;
  }
  hideCalPostPopup();
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
    let logoUrl = '';
    try {
      ({ name, logoUrl } = await resolveLinkToken());
    } catch (err) {
      document.getElementById('loading').hidden = true;
      document.getElementById('stack').innerHTML = `<div class="error-box">${esc(err.message)}</div>`;
      return;
    }
    applyBranding(name, logoUrl);
    loadTasks();
    return;
  }
  if (!boardId) {
    document.getElementById('loading').hidden = true;
    document.getElementById('stack').innerHTML = `
      <div class="not-found">
        <img class="not-found-img" src="/not-found.png" alt="">
        <div class="not-found-title">Упс, ссылка неполная</div>
        <div class="not-found-sub">Мы не смогли определить проект. Свяжитесь с вашим менеджером — он пришлёт актуальную ссылку.</div>
      </div>`;
    return;
  }
  applyBranding();
  loadTasks();
}

init();
