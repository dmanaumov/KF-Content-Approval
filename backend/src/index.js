const express = require('express');
const path = require('path');
const multer = require('multer');
const config = require('./config');
const mm = require('./mattermostClient');
const { buildTasks, findPropertyDef, optionIdByLabel, optionLabelById } = require('./taskMapper');
const { parseAndValidateShareUrl, resolveKind, streamDiskFile } = require('./diskEmbeds');
const diskUpload = require('./diskUpload');
const db = require('./db');
const projectSettings = require('./projectSettings');
const mediaOrder = require('./mediaOrder');
const teamComments = require('./teamComments');
const teamAuth = require('./teamAuth');
const mailer = require('./mailer');
const analytics = require('./analytics');

const app = express();
app.use(express.json());

// Memory storage (not disk) — the file only ever needs to live long enough
// to be relayed straight into diskUpload.uploadAndShare(); nothing else
// reads it back, so there's no reason to touch this container's own disk.
// 80MB covers any real social-media photo/video without letting an upload
// tie up server memory for arbitrarily large files.
const teamMediaUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 80 * 1024 * 1024 } });

// ---------------------------------------------------------------------------
// In-memory cache only (no database). Keyed by boardId. Cleared on write.
// ---------------------------------------------------------------------------
const cache = new Map(); // boardId -> { expires, board, cards, blocks }

async function loadBoard(boardId, { fresh = false } = {}) {
  const cached = cache.get(boardId);
  if (!fresh && config.cacheTtlMs > 0 && cached && cached.expires > Date.now()) {
    return cached;
  }
  const [board, cards] = await Promise.all([mm.getBoard(boardId, config.teamId), mm.listCards(boardId)]);
  // Child blocks (captions/media/comments) are best-effort — this endpoint
  // is unconfirmed on this server (see mattermostClient.js). If it fails,
  // cards still show with title/status/dates, just without those extras,
  // rather than taking down the whole cabinet.
  let blocks = [];
  try {
    blocks = await mm.listBlocks(boardId);
  } catch (err) {
    console.warn(`[mattermost] listBlocks(${boardId}) unavailable, continuing without captions/media:`, err.message);
  }
  const entry = { board, cards, blocks, expires: Date.now() + config.cacheTtlMs };
  cache.set(boardId, entry);
  return entry;
}

function invalidate(boardId) {
  cache.delete(boardId);
}

// Every approve/feedback action must leave a dated marker comment on the
// Mattermost card ("СОГЛАСОВАНО" / "ПРАВКИ" + date+time) so staff working
// directly in Mattermost can see when/what the client did without opening
// the cabinet. Formatted in Moscow time regardless of where the server runs.
function formatMoscowTimestamp() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(now);
  const get = (type) => (parts.find((p) => p.type === type) || {}).value || '';
  return `${get('day')}.${get('month')}.${get('year')} ${get('hour')}:${get('minute')}`;
}

// Resolved once and cached inside mattermostClient itself — cheap to call
// repeatedly. Used so taskMapper.js can show only feedback comments posted
// by our own app's account, not unrelated internal comments left directly
// on the card in Mattermost.
async function getFeedbackAuthorId() {
  try {
    return await mm.getUserIdByUsername(config.feedbackAuthorUsername);
  } catch (err) {
    console.warn(`[app] could not resolve feedbackAuthorUsername "${config.feedbackAuthorUsername}":`, err.message);
    return null;
  }
}

// buildTasks() stays synchronous and can't itself know image-vs-video for a
// disk.kontentferma link (that takes a network call to the disk server) —
// it leaves media.kind === null for those entries, and this fills it in
// afterwards, in parallel, using diskEmbeds' in-memory cache so repeat
// requests for the same link are free.
async function resolveDiskMediaKinds(tasks) {
  const thunks = [];
  for (const t of tasks) {
    for (const m of t.media) {
      if (m.source === 'disk' && m.kind === null) {
        thunks.push(async () => {
          const info = await resolveKind(m.shareUrl);
          m.kind = info.kind;
          if (info.name) m.name = info.name;
        });
      }
    }
  }
  // Limit parallel probes: firing dozens of simultaneous requests at the disk
  // server at once is how a slow page load becomes a hang (and how we stall
  // the disk server for everyone else). resolveKind never rejects (timeout →
  // kind 'file'), so each probe is bounded by config.diskProbeTimeoutMs.
  const limit = 4;
  let i = 0;
  const runNext = async () => {
    while (i < thunks.length) await thunks[i++]();
  };
  await Promise.all(Array.from({ length: Math.min(limit, thunks.length) }, runNext));
  return tasks;
}

// Resolves a project option id (from a client cabinet ?project= query) to its
// human-readable label for the access log — falls back to the raw id when the
// property/option can't be found, so analytics never crash on a rename.
function projectLabelFor(board, projectId) {
  const prop = findPropertyDef(board, config.projectPropertyName);
  const label = prop ? optionLabelById(prop, projectId) : '';
  return label || String(projectId || '');
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

// GET /api/boards/:boardId/tasks?project=... — everything the client cabinet
// needs. `project` is REQUIRED whenever the board has a project property
// (this board is shared across every client — see docs/MATTERMOST_INTEGRATION.md)
// since it's the only thing separating one client's cards from another's.
app.get('/api/boards/:boardId/tasks', async (req, res) => {
  try {
    const { board, cards, blocks } = await loadBoard(req.params.boardId);
    const feedbackAuthorUserId = await getFeedbackAuthorId();
    const { tasks, meta } = buildTasks(board, cards, blocks, { projectFilter: req.query.project, feedbackAuthorUserId });
    if (meta.projectPropertyFound && !meta.projectFilterMatched) {
      return res.status(400).json({
        error: 'project_filter_required',
        message:
          'This board has a project property, and the link is missing a valid ?project= value — ' +
          'refusing to show tasks to avoid leaking other clients\' cards. Pass the project option id or exact label.',
      });
    }
    await resolveDiskMediaKinds(tasks);
    await mediaOrder.applyStoredOrder(req.params.boardId, tasks);
    // Access analytics: the client (or a team member/staffer opening the
    // cabinet via an admin link) loaded their tasks — record who/when/device/
    // which project (see analytics.js; deduped to once per ~session).
    const who = analytics.identify(req);
    analytics.note(who.role, { project: projectLabelFor(board, req.query.project), actor: who.actor, actorName: who.actorName, path: req.path }, req, res);
    res.json({
      board: { id: req.params.boardId, title: board.title || '' },
      tasks,
      meta,
    });
  } catch (err) {
    console.error('[api] GET tasks failed:', err.message);
    res.status(502).json({ error: 'mattermost_unavailable', message: err.message });
  }
});

// Кто перед нами для внутренних страниц — разбор доступа:
//   1) живая /team-сессия, чей Mattermost-email есть в одном из списков
//      (adminEmails / statEmails / ceoEmails) — персональный доступ, это
//      то, как теперь разграничиваются права «кому из команды разрешено»;
//   2) общий HTTP Basic Auth (STAFF_AUTH_USER/PASSWORD) — полный админ,
//      оставлен как fallback для тех, у кого нет аккаунта Mattermost.
function currentAccess(req) {
  const session = teamAuth.getSession(teamAuth.sessionIdFromRequest(req));
  if (session && session.user) {
    const role = teamAuth.roleFor(session.user);
    if (role.admin || role.stat || role.ceo) return { source: 'team', ...role, user: session.user };
  }
  if (config.staffAuthUser && config.staffAuthPassword) {
    const header = req.headers.authorization || '';
    const [scheme, encoded] = header.split(' ');
    if (scheme === 'Basic' && encoded) {
      const decoded = Buffer.from(encoded, 'base64').toString('utf8');
      const sep = decoded.indexOf(':');
      const user = sep >= 0 ? decoded.slice(0, sep) : decoded;
      const pass = sep >= 0 ? decoded.slice(sep + 1) : '';
      if (user === config.staffAuthUser && pass === config.staffAuthPassword) {
        return { source: 'basic', admin: true, stat: true, ceo: true, user: null };
      }
    }
  }
  return null;
}

// Админ-гейт: живая /team-сессия с ролью admin ИЛИ общий Basic Auth.
function staffAuth(req, res, next) {
  const access = currentAccess(req);
  if (access && access.admin) return next();
  res.set('WWW-Authenticate', 'Basic realm="KF staff"');
  // The browser's native Basic Auth prompt covers this body until the user
  // cancels it — at that point this is what they see, so it's worth a link
  // rather than a bare "Authentication required."
  res.status(401).type('html').send(`<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Нужен вход</title></head>
<body style="font-family:system-ui,sans-serif;max-width:420px;margin:15vh auto 0;padding:0 20px;text-align:center;color:#222">
<h3>Нужен доступ</h3>
<p>Войдите в <a href="/team">кабинет команды</a> под своим Mattermost-аккаунтом или введите пароль админки.</p>
</body></html>`);
}

// Стат-гейт: /team-сессия с ролью stat (admin её получает автоматически)
// ИЛИ общий Basic Auth. Без WWW-Authenticate намеренно — для тех, у кого
// только статистика, браузер не должен показывать непонятный Basic-диалог:
// вместо него отдаём понятное сообщение со ссылкой на /team.
function requireStatAuth(req, res, next) {
  const access = currentAccess(req);
  if (access && access.stat) return next();
  if (req.accepts('html')) {
    return res.status(401).type('html').send(`<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Нужен доступ</title></head>
<body style="font-family:system-ui,sans-serif;max-width:420px;margin:15vh auto 0;padding:0 20px;text-align:center;color:#222">
<h3>Нужен доступ к статистике</h3>
<p>Войдите в <a href="/team">кабинет команды</a> под своим Mattermost-аккаунтом — если вам положен доступ, ссылка появится сама.</p>
</body></html>`);
  }
  res.status(401).json({ error: 'not_allowed', message: 'Нужен доступ к статистике.' });
}

// Simple in-memory per-IP rate limit for the forgot-password endpoint below
// (it's deliberately unauthenticated, so it needs its own brake against
// being hammered/used to spam an inbox). Not persisted — resets on
// redeploy/restart, which is fine for this purpose.
const forgotPasswordAttempts = new Map(); // ip -> timestamps[]
function tooManyForgotPasswordAttempts(ip) {
  const now = Date.now();
  const windowMs = 60 * 60 * 1000;
  const limit = 5;
  const recent = (forgotPasswordAttempts.get(ip) || []).filter((t) => now - t < windowMs);
  recent.push(now);
  forgotPasswordAttempts.set(ip, recent);
  return recent.length > limit;
}

// "В графике" / "Небольшое отклонение" / "Не укладываемся" — a project's
// current-month posting KPI (posts_per_month, set in the "Редактировать"
// popup's planning tab), turned into a traffic-light status for the staff
// project list. Only computed when a KPI is actually set (falsy/non-numeric
// target => null, meaning "don't show anything" — see frontend/projects.js).
//
// Method: of this project's client-facing tasks (same set buildTasks()
// already shows the client — internal/archived stages are never counted)
// whose planned publish date falls in the CURRENT CALENDAR MONTH (Moscow
// time, matching formatMoscowTimestamp elsewhere in this file):
//   planned   = how many exist
//   late      = of those, how many are past their date and still not in the
//               "Опубликовано" status. There's no "actually published at"
//               timestamp in this data model (only the planned date and
//               current status), so a task that reached "Опубликовано" at
//               any point counts as resolved — this can't distinguish
//               "published exactly on time" from "published a day late".
//   shortfall = max(0, target − planned) — fewer posts scheduled this month
//               than the KPI calls for.
//   deviation = late + shortfall
// deviation 0 → 'ontrack', 1–2 → 'minor', >2 → 'off'. Matches the three
// tiers the agency described: fully on schedule / a post or two off / not
// meeting KPI or more than 2 posts late.
function computeScheduleStatus(tasks, kpiTargetRaw) {
  const target = parseInt(String(kpiTargetRaw || '').trim(), 10);
  if (!Number.isFinite(target) || target <= 0) return null;

  const moscowToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(new Date()); // YYYY-MM-DD
  const monthPrefix = moscowToday.slice(0, 7); // YYYY-MM

  const thisMonth = tasks.filter((t) => t.publishDate && t.publishDate.startsWith(monthPrefix));
  const late = thisMonth.filter((t) => t.status !== 'published' && t.publishDate < moscowToday).length;
  const planned = thisMonth.length;
  const shortfall = Math.max(0, target - planned);
  const deviation = late + shortfall;
  const tier = deviation === 0 ? 'ontrack' : deviation <= 2 ? 'minor' : 'off';
  return { tier, target, planned, late };
}

function requireStaffBoardId(res) {
  if (!config.mattermostBoardId) {
    res.status(500).json({
      error: 'board_not_configured',
      message: 'MATTERMOST_BOARD_ID is not set — the staff projects page needs it (see .env.example).',
    });
    return null;
  }
  return config.mattermostBoardId;
}

// "Бусинки" on the staff project card — one bead per post planned THIS month
// (same Moscow-current-month set as computeScheduleStatus above, so the KPI
// traffic-light and the beads always tell the same story). Sorted soonest-
// first. The staff page colors each bead by the same status notation the
// client cabinet uses (published/approved/waiting/changes) and shows the
// date + post title on hover — see frontend/projects.js + projects.css.
function postsForMonth(tasks) {
  const moscowToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(new Date());
  const monthPrefix = moscowToday.slice(0, 7);
  return tasks
    .filter((t) => t.publishDate && t.publishDate.startsWith(monthPrefix))
    .map((t) => ({ id: t.id, title: t.title, publishDate: t.publishDate, status: t.status }))
    .sort((a, b) => (a.publishDate || '').localeCompare(b.publishDate || ''));
}

// GET /api/projects — every option of the "Проект" property, for the
// internal staff page that lists all client cabinet links (see
// frontend/projects.html). Deliberately does NOT take boardId from the URL
// (unlike the client-facing /api/boards/:boardId/... routes) — it reads
// config.mattermostBoardId instead, so nothing about which board this is
// ever needs to appear in a URL a person types/bookmarks/screenshots.
// Reads live from the board's property definition (same source of truth as
// everything else in this app) — a new client project shows up here
// automatically as soon as it's added as an option in Mattermost.
app.get('/api/projects', staffAuth, async (req, res) => {
  const boardId = requireStaffBoardId(res);
  if (!boardId) return;
  try {
    const { board } = await loadBoard(boardId);
    const projectProp = findPropertyDef(board, config.projectPropertyName);
    if (!projectProp) {
      return res.status(404).json({ error: 'project_property_not_found', message: `Property "${config.projectPropertyName}" not found on this board.` });
    }
    const { cards, blocks } = await loadBoard(boardId);
    const options = await Promise.all(
      (projectProp.options || []).map(async (o) => {
        // Rotatable short link + logo URL — see projectSettings.js. Row is
        // created lazily on first read, so every project already has a
        // working link (and, once set, a logo) the first time this list
        // loads.
        const { token, logoUrl, aiStatus, postsPerMonth } = await projectSettings.getTokenAndLogo(boardId, o.id);
        // buildTasks() is pure computation over the board/cards/blocks
        // already fetched above — re-filtering per project here costs no
        // extra Mattermost calls, just re-running an in-memory filter once
        // per project (see computeScheduleStatus/postsForMonth below). The
        // KPI uses the client-facing set; the bead strip additionally wants
        // posts still in internal production stages (status null), hence the
        // second includeAllStatuses pass (same option the /team cabinet uses).
        const clientTasks = buildTasks(board, cards, blocks, { projectFilter: o.id }).tasks;
        const scheduleStatus = postsPerMonth ? computeScheduleStatus(clientTasks, postsPerMonth) : null;
        const allTasks = buildTasks(board, cards, blocks, { projectFilter: o.id, includeAllStatuses: true }).tasks;
        const posts = postsForMonth(allTasks);
        return { id: o.id, label: o.value, token, logoUrl, aiStatus, scheduleStatus, posts };
      })
    );
    const who = analytics.identify(req);
    analytics.note(who.role, { project: '', actor: who.actor, actorName: who.actorName, path: req.path }, req, res);
    res.json({ mattermostWebUrl: config.mattermostWebUrl, options });
  } catch (err) {
    console.error('[api] GET projects failed:', err.message);
    res.status(502).json({ error: 'mattermost_unavailable', message: err.message });
  }
});

// GET /api/analytics/summary — aggregated access statistics for the /stat page
// (see frontend/stat.html/js): last 30 days, grouped by role/date/project/
// device/browser/team-member, plus the most recent raw visits. Staff-gated
// like the rest of the internal API. The byDate "day" labels are Moscow time.
app.get('/api/analytics/summary', requireStatAuth, async (req, res) => {
  try {
    const pool = db.requirePool();
    const [totalVisitors, byRole, byDate, byProject, byDevice, byBrowser, byActor, actorsByProject, recent] = await Promise.all([
      pool.query(
        `SELECT count(DISTINCT visitor_id)::int AS visitors
         FROM access_log WHERE ts > now() - interval '30 days' AND visitor_id <> ''`
      ),
      pool.query(
        `SELECT role, count(*)::int AS events, count(DISTINCT visitor_id)::int AS visitors
         FROM access_log WHERE ts > now() - interval '30 days' GROUP BY role`
      ),
      pool.query(
        `SELECT to_char(ts AT TIME ZONE 'Europe/Moscow','YYYY-MM-DD') AS day,
                count(*)::int AS events, count(DISTINCT visitor_id)::int AS visitors
         FROM access_log WHERE ts > now() - interval '30 days' GROUP BY day ORDER BY day`
      ),
      pool.query(
        `SELECT project, count(*)::int AS events, count(DISTINCT visitor_id)::int AS visitors
         FROM access_log WHERE ts > now() - interval '30 days' AND project <> '' GROUP BY project ORDER BY events DESC LIMIT 50`
      ),
      pool.query(
        `SELECT COALESCE(NULLIF(device_label,''), device) AS device_label,
                count(*)::int AS events, count(DISTINCT visitor_id)::int AS visitors
         FROM access_log WHERE ts > now() - interval '30 days' AND device <> ''
         GROUP BY 1 ORDER BY visitors DESC LIMIT 50`
      ),
      pool.query(
        `SELECT COALESCE(NULLIF(browser_label,''), browser) AS browser_label,
                count(*)::int AS events, count(DISTINCT visitor_id)::int AS visitors
         FROM access_log WHERE ts > now() - interval '30 days' AND browser <> ''
         GROUP BY 1 ORDER BY visitors DESC LIMIT 50`
      ),
      pool.query(
        `SELECT actor, count(*)::int AS events
         FROM access_log WHERE ts > now() - interval '30 days' AND actor <> '' GROUP BY actor ORDER BY events DESC LIMIT 50`
      ),
      pool.query(
        `SELECT actor, max(actor_name) AS actor_name, project, count(*)::int AS events
         FROM access_log WHERE ts > now() - interval '30 days' AND actor <> '' AND project <> '' GROUP BY actor, project ORDER BY events DESC LIMIT 200`
      ),
      pool.query(
        `SELECT to_char(ts AT TIME ZONE 'Europe/Moscow','DD.MM HH24:MI') AS ts, role, project, actor, path,
                COALESCE(NULLIF(device_label,''), device) AS device, COALESCE(NULLIF(browser_label,''), browser) AS browser
         FROM access_log ORDER BY ts DESC LIMIT 200`
      ),
    ]);
    res.json({
      days: 30,
      totalVisitors: totalVisitors.rows[0].visitors,
      byRole: byRole.rows,
      byDate: byDate.rows,
      byProject: byProject.rows,
      byDevice: byDevice.rows,
      byBrowser: byBrowser.rows,
      byActor: byActor.rows,
      actorsByProject: actorsByProject.rows,
      recent: recent.rows,
    });
  } catch (err) {
    console.error('[api] analytics summary failed:', err.message);
    res.status(500).json({ error: 'analytics_unavailable', message: err.message });
  }
});

// Окно «московского месяца» для месячных аналитических вью: принимает
// ?month=YYYY-MM (или текущий месяц в МСК), возвращает границы (МСК-день
// начинается в 21:00 UTC предыдущего) и список дней месяца. Передвигаться
// назад можно до сколь угодно — строки давнее RETENTION_DAYS и так
// вычищаются pruneOldLogs.
function monthWindow(raw) {
  const moscowDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(new Date());
  const [curY, curM] = moscowDay.slice(0, 7).split('-').map(Number);
  let y = curY;
  let m = curM;
  const match = String(raw || '').match(/^(\d{4})-(\d{2})$/);
  if (match) {
    const yy = Number(match[1]);
    const mm = Number(match[2]);
    if (mm >= 1 && mm <= 12 && yy >= 2000 && yy <= 2100) {
      y = yy;
      m = mm;
    }
  }
  const nextY = m === 12 ? y + 1 : y;
  const nextM = m === 12 ? 1 : m + 1;
  const monthStart = new Date(Date.UTC(y, m - 1, 0, 21)); // 1-е число 00:00 МСК
  const monthEnd = new Date(Date.UTC(nextY, nextM - 1, 0, 21)); // 1-е следующего 00:00 МСК
  const monthDays = [];
  for (let d = new Date(monthStart.getTime()); d < monthEnd; d.setUTCDate(d.getUTCDate() + 1)) {
    monthDays.push(new Date(d.getTime() + 3 * 3600 * 1000).toISOString().slice(0, 10));
  }
  return { y, m, monthStart, monthEnd, monthDays };
}

// "YYYY-MM" ключ предыдущего месяца (для сравнения месяц-к-месяцу).
function previousMonthKey(y, m) {
  if (m === 1) return `${y - 1}-12`;
  return `${y}-${String(m - 1).padStart(2, '0')}`;
}

// Еженедельная активность по карточкам для /ceo. Неделя = пн–вс по Москве
// (ключ — дата понедельника). Считаем для каждого из последних `weeks`
// недель (по умолчанию 12), включая текущую:
//   created  — карточек создано в эту неделю (createAt карточки);
//   planned  — публикаций запланировано на эту неделю (publishDate);
//   approved — из запланированных те, что уже «Согласовано» или «Опубликовано»;
//   late     — из запланированных те, чья неделя уже прошла, а карточка так и
//              не опубликована (архив не считается опозданием — это закрытие).
function moscowDateStr(ms) {
  return new Date(ms + 3 * 3600 * 1000).toISOString().slice(0, 10);
}
function mondayOf(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr + 'T00:00:00Z');
  const diff = d.getUTCDay() === 0 ? -6 : 1 - d.getUTCDay();
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}
function weeklyActivity(tasks, weeks = 12) {
  const moscowToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(new Date());
  const weekStartToday = mondayOf(moscowToday);
  const cursor = new Date(weekStartToday + 'T00:00:00Z');
  cursor.setUTCDate(cursor.getUTCDate() - (weeks - 1) * 7);
  const keys = [];
  for (let i = 0; i < weeks; i++) {
    keys.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 7);
  }
  const bucket = Object.fromEntries(keys.map((k) => [k, { created: 0, planned: 0, approved: 0, late: 0 }]));
  for (const t of tasks) {
    if (t.createAt) {
      const ck = mondayOf(moscowDateStr(t.createAt));
      if (bucket[ck]) bucket[ck].created++;
    }
    if (!t.publishDate) continue;
    const wk = mondayOf(t.publishDate);
    if (!bucket[wk]) continue;
    bucket[wk].planned++;
    if (t.status === 'approved' || t.status === 'published') bucket[wk].approved++;
    if (t.status !== 'published' && t.status !== 'archived') {
      const weekEnd = new Date(wk + 'T00:00:00Z');
      weekEnd.setUTCDate(weekEnd.getUTCDate() + 7);
      if (moscowToday > weekEnd.toISOString().slice(0, 10)) bucket[wk].late++;
    }
  }
  return keys.map((k) => ({ week: k, ...bucket[k] }));
}

// GET /api/ceo/overview — CEO dashboard (frontend/ceo.html/js), owner-only:
// project liveness (last visit, visits per 7d, visitors per 30d), month-over-
// month visitors per project, team activity over the last 30 days (all from
// access_log) plus weekly card activity from the board (best-effort — if the
// board is unreachable we return activity: null rather than failing).
app.get('/api/ceo/overview', teamAuth.requireCeoAuth, async (req, res) => {
  try {
    const pool = db.requirePool();
    const cur = monthWindow();
    const prev = monthWindow(previousMonthKey(cur.y, cur.m));
    const [projects, mom, team, totals] = await Promise.all([
      pool.query(
        `SELECT project, max(ts) AS last_ts,
                count(DISTINCT visitor_id) FILTER (WHERE ts > now() - interval '30 days')::int AS visitors30,
                count(DISTINCT visitor_id) FILTER (WHERE ts > now() - interval '7 days')::int AS visitors7,
                count(*) FILTER (WHERE ts > now() - interval '7 days')::int AS visits7
         FROM access_log WHERE project <> ''
         GROUP BY project ORDER BY last_ts DESC`
      ),
      pool.query(
        `SELECT project,
                count(DISTINCT visitor_id) FILTER (WHERE ts >= $1 AND ts < $2)::int AS cur_visitors,
                count(DISTINCT visitor_id) FILTER (WHERE ts >= $3 AND ts < $4)::int AS prev_visitors,
                count(*) FILTER (WHERE ts >= $1 AND ts < $2)::int AS cur_visits,
                count(*) FILTER (WHERE ts >= $3 AND ts < $4)::int AS prev_visits
         FROM access_log
         WHERE project <> '' AND (ts >= $3 AND ts < $2)
         GROUP BY project ORDER BY cur_visitors DESC, project`,
        [cur.monthStart.toISOString(), cur.monthEnd.toISOString(), prev.monthStart.toISOString(), prev.monthEnd.toISOString()]
      ),
      pool.query(
        `SELECT actor, max(actor_name) AS actor_name,
                count(DISTINCT to_char(ts AT TIME ZONE 'Europe/Moscow','YYYY-MM-DD'))::int AS active_days,
                count(*)::int AS sessions,
                count(DISTINCT visitor_id)::int AS visitors,
                max(ts) AS last_ts
         FROM access_log
         WHERE role = 'team' AND actor <> '' AND ts > now() - interval '30 days'
         GROUP BY actor ORDER BY active_days DESC, sessions DESC`
      ),
      pool.query(
        `SELECT count(DISTINCT visitor_id) FILTER (WHERE ts > now() - interval '30 days')::int AS visitors30,
                count(DISTINCT visitor_id) FILTER (WHERE ts > now() - interval '7 days')::int AS visitors7,
                count(DISTINCT visitor_id) FILTER (WHERE ts > now() - interval '30 days' AND role = 'client')::int AS clients30
         FROM access_log WHERE ts > now() - interval '30 days'`
      ),
    ]);
    // Weekly card activity — needs Mattermost (not just access_log), so it's
    // best-effort: if the board is unreachable we still return everything else
    // with activity: null and the CEO page shows a "недоступно" note.
    let activity = null;
    try {
      const { board, cards, blocks } = await loadBoard(config.mattermostBoardId);
      const { tasks } = buildTasks(board, cards, blocks, { includeAllStatuses: true });
      activity = weeklyActivity(tasks, 12);
    } catch (err) {
      console.warn('[api] ceo weekly activity unavailable:', err.message);
    }
    res.json({
      curMonth: `${String(cur.m).padStart(2, '0')}.${cur.y}`,
      prevMonth: `${String(prev.m).padStart(2, '0')}.${prev.y}`,
      projects: projects.rows,
      mom: mom.rows,
      team: team.rows,
      totals: totals.rows[0],
      activity,
    });
  } catch (err) {
    console.error('[api] ceo overview failed:', err.message);
    res.status(500).json({ error: 'ceo_unavailable', message: err.message });
  }
});

// GET /api/analytics/team — session heatmap data for the /stat "команда"
// view: rows are team members (actor username + full name from actor_name),
// columns are the days of the viewed Moscow month, cells = how many sessions
// that person had that day (deduped to ~one per 20 minutes in analytics.js).
app.get('/api/analytics/team', requireStatAuth, async (req, res) => {
  try {
    const pool = db.requirePool();
    const { y, m, monthStart, monthEnd, monthDays } = monthWindow(req.query.month);
    const daily = await pool.query(
      `SELECT actor, max(actor_name) AS actor_name,
              to_char(ts AT TIME ZONE 'Europe/Moscow','YYYY-MM-DD') AS day,
              count(*)::int AS sessions,
              count(DISTINCT device)::int AS devices,
              count(DISTINCT visitor_id)::int AS visitors
       FROM access_log
       WHERE role = 'team' AND actor <> '' AND ts >= $1 AND ts < $2
       GROUP BY actor, day ORDER BY actor, day`,
      [monthStart.toISOString(), monthEnd.toISOString()]
    );
    res.json({ month: `${String(m).padStart(2, '0')}.${y}`, monthDays, teamDaily: daily.rows });
  } catch (err) {
    console.error('[api] analytics team failed:', err.message);
    res.status(500).json({ error: 'analytics_unavailable', message: err.message });
  }
});

// GET /api/analytics/projects — the two project-activity views for /stat:
// (a) per project, the devices that entered its approval cabinet, and
// (b) a project × viewed-Moscow-month-day heatmap of entry counts (no
// entries → white cell, max → green — see frontend/stat.js). Принимает
// ?month=YYYY-MM, по умолчанию — текущий месяц в МСК.
app.get('/api/analytics/projects', requireStatAuth, async (req, res) => {
  try {
    const pool = db.requirePool();
    const { y, m, monthStart, monthEnd, monthDays } = monthWindow(req.query.month);
    const [devices, daily] = await Promise.all([
      pool.query(
        `SELECT project, COALESCE(NULLIF(device_label,''), device) AS device, count(*)::int AS events
         FROM access_log
         WHERE project <> '' AND device <> '' AND ts >= $1 AND ts < $2
         GROUP BY 1, 2 ORDER BY project, events DESC`,
        [monthStart.toISOString(), monthEnd.toISOString()]
      ),
      pool.query(
        `SELECT project, to_char(ts AT TIME ZONE 'Europe/Moscow','YYYY-MM-DD') AS day,
                count(*)::int AS events, count(DISTINCT visitor_id)::int AS visitors,
                count(DISTINCT device)::int AS devices
         FROM access_log
         WHERE project <> '' AND ts >= $1 AND ts < $2
         GROUP BY project, day ORDER BY project, day`,
        [monthStart.toISOString(), monthEnd.toISOString()]
      ),
    ]);
    res.json({ month: `${String(m).padStart(2, '0')}.${y}`, monthDays, projectDevices: devices.rows, projectDaily: daily.rows });
  } catch (err) {
    console.error('[api] analytics projects failed:', err.message);
    res.status(500).json({ error: 'analytics_unavailable', message: err.message });
  }
});

// POST /api/projects/:projectId/regenerate-link — issues a brand new short
// link for this project and immediately invalidates the old one. Internal
// staff action (not reachable from anywhere in the client-facing cabinet) —
// used when a link may have leaked/been misused; see projectSettings.js for
// how revocation is made to actually survive a redeploy.
app.post('/api/projects/:projectId/regenerate-link', staffAuth, async (req, res) => {
  const boardId = requireStaffBoardId(res);
  if (!boardId) return;
  try {
    const token = await projectSettings.regenerateToken(boardId, req.params.projectId);
    res.json({ token });
  } catch (err) {
    console.error('[api] regenerate-link failed:', err.message);
    res.status(500).json({ error: 'regenerate_failed', message: err.message });
  }
});

// GET /api/projects/:projectId/settings — logo URL + per-network publishing
// credentials + planning/profile fields (start date, project manager, posts
// per month, MSK publish time, the strategy/planning/post/image prompts),
// for the staff "Редактировать" popup (frontend/projects.js). Returned
// as-is (not masked) — this is already the staff-only page (see staffAuth
// above); the popup needs to show existing values to edit them.
app.get('/api/projects/:projectId/settings', staffAuth, async (req, res) => {
  const boardId = requireStaffBoardId(res);
  if (!boardId) return;
  try {
    const settings = await projectSettings.getSettings(boardId, req.params.projectId);
    res.json(settings);
  } catch (err) {
    console.error('[api] GET project settings failed:', err.message);
    res.status(500).json({ error: 'settings_failed', message: err.message });
  }
});

// PUT /api/projects/:projectId/settings — saves logo URL, social
// credentials, and the planning/profile fields from the edit popup. Body:
// { logoUrl: string, socialCredentials: { ig?, tg?, vk?, ok?, max? },
//   startDate?, postsPerMonth?, publishTimeMsk?, projectManager?,
//   strategyPrompt?, planningPrompt?, postPrompt?, imagePrompt? } — each network's value is a
// free-form JSON object; this app never reads any of it, it's stored purely
// so the publishing automation can read it directly from Postgres.
app.put('/api/projects/:projectId/settings', staffAuth, async (req, res) => {
  const boardId = requireStaffBoardId(res);
  if (!boardId) return;
  try {
    await projectSettings.updateSettings(boardId, req.params.projectId, req.body || {});
    const settings = await projectSettings.getSettings(boardId, req.params.projectId);
    res.json(settings);
  } catch (err) {
    console.error('[api] PUT project settings failed:', err.message);
    res.status(400).json({ error: 'invalid_settings', message: err.message });
  }
});

// ---------------------------------------------------------------------------
// Team cabinet (config.teamCabinetPath, default /team) — internal staff, one
// account each, real Mattermost login. Separate from staffAuth above (single
// shared Basic Auth login for the /projects list) — see teamAuth.js for why.
// ---------------------------------------------------------------------------

// POST /api/team/login — body: { login, password }. `login` is whatever
// Mattermost itself accepts as login_id (username OR email). Credentials are
// checked live against Mattermost and never stored — only the resulting
// session token (see teamAuth.js) is kept, in memory, keyed by an opaque
// cookie value this endpoint sets.
app.post('/api/team/login', async (req, res) => {
  const login = String((req.body && req.body.login) || '').trim();
  const password = String((req.body && req.body.password) || '');
  if (!login || !password) return res.status(400).json({ error: 'credentials_required' });
  try {
    const { token, user } = await mm.loginAs(login, password);
    const sessionId = await teamAuth.createSession(token, user);
    teamAuth.setSessionCookie(res, sessionId);
    analytics.note('team', { actor: user.username || login, actorName: [user.first_name, user.last_name].filter(Boolean).join(' '), path: req.path }, req, res);
    const role = teamAuth.roleFor(user);
    res.json({
      user: { id: user.id, username: user.username, firstName: user.first_name, lastName: user.last_name },
      // staffProjectsPath only handed to admins — it's meant to stay
      // unguessable (see config.js's comment on STAFF_PROJECTS_PATH), so
      // non-admins never even see it in this response.
      access: { ...role, staffProjectsPath: role.admin ? config.staffProjectsPath : undefined },
    });
  } catch (err) {
    // Wrong password, unknown user, Mattermost unreachable — all land here.
    // 401 either way; the message (from mm.loginAs, Mattermost's own) is
    // safe to show directly in the login form.
    res.status(401).json({ error: 'login_failed', message: err.message });
  }
});

app.post('/api/team/logout', (req, res) => {
  teamAuth.destroySession(teamAuth.sessionIdFromRequest(req));
  teamAuth.clearSessionCookie(res);
  res.json({ ok: true });
});

// GET /api/team/me — lets the frontend check "am I already logged in?" on
// page load without re-submitting credentials (the session cookie is enough).
// Also returns the user's access roles (admin/stat/ceo) so the cabinet can
// show role-appropriate links (e.g. "Статистика" for those who may view it).
app.get('/api/team/me', teamAuth.requireTeamAuth, (req, res) => {
  const { user } = req.teamSession;
  const role = teamAuth.roleFor(user);
  res.json({
    user: { id: user.id, username: user.username, firstName: user.first_name, lastName: user.last_name },
    access: { ...role, staffProjectsPath: role.admin ? config.staffProjectsPath : undefined },
  });
});

// GET /api/staff/me — what access the CURRENT viewer has on the internal
// pages (team session with an allowlisted email, or the shared Basic Auth).
// Used by the staff page to show role-appropriate links (stat/ceo buttons).
// Open endpoint by design — it only tells a person their own role, which the
// protected APIs enforce regardless.
app.get('/api/staff/me', (req, res) => {
  const access = currentAccess(req);
  if (!access) return res.status(401).json({ error: 'not_allowed' });
  const user = access.user
    ? { id: access.user.id, username: access.user.username, firstName: access.user.first_name, lastName: access.user.last_name, email: access.user.email }
    : null;
  res.json({ access: { admin: access.admin, stat: access.stat, ceo: access.ceo }, user });
});

// GET /api/team/tasks — every card where "Исполнитель" == the logged-in
// person, across ALL projects (unlike the client cabinet, deliberately NOT
// project-filtered — a team member's work usually spans several clients) and
// in ANY status (unlike the client cabinet, which only shows the 5
// client-facing states — see buildTasks' opts.includeAllStatuses).
app.get('/api/team/tasks', teamAuth.requireTeamAuth, async (req, res) => {
  const boardId = requireStaffBoardId(res);
  if (!boardId) return;
  try {
    const { board, cards, blocks } = await loadBoard(boardId);
    const feedbackAuthorUserId = await getFeedbackAuthorId();
    const { tasks, meta } = buildTasks(board, cards, blocks, {
      skipProjectFilter: true,
      includeAllStatuses: true,
      feedbackAuthorUserId,
    });
    if (!meta.assigneePropertyFound) {
      // Self-diagnosing on purpose — list what's actually on the board right
      // in the error, instead of sending whoever hits this to dig through
      // DEBUG_MATTERMOST=true + /api/debug/... just to find the real name.
      const available = (board.cardProperties || []).map((p) => `«${p.name}»`).join(', ') || '(не удалось получить список свойств)';
      return res.status(500).json({
        error: 'assignee_property_not_found',
        message: `Свойство "${config.assigneePropertyName}" не найдено на борде. Реальные свойства борда: ${available}. Задайте точное имя через MM_ASSIGNEE_PROPERTY_NAME в .env.`,
      });
    }
    const myId = req.teamSession.user.id;
    const mine = tasks.filter((t) => t.assigneeId === myId);
    await resolveDiskMediaKinds(mine);
    await mediaOrder.applyStoredOrder(boardId, mine);
    analytics.note('team', { actor: req.teamSession.user.username || '', actorName: [req.teamSession.user.first_name, req.teamSession.user.last_name].filter(Boolean).join(' '), path: req.path }, req, res);
    // statusOptions: every raw option on "Статус" — powers the card's status
    // picker (frontend/team.js), which lets team members move a card into
    // ANY production stage, not just the 5 client-facing ones. keywordsFound
    // lets the frontend hide the "Ключевые слова/мысли" field cleanly instead
    // of showing an always-empty box if that property isn't on this board.
    // boardId: the /team cabinet's OWN routes deliberately never take it as
    // a URL param (see teamAuth/requireStaffBoardId's comment — resolved
    // server-side, kept out of this cabinet's bookmarkable URLs). But media
    // thumbnails still have to load through the pre-existing, unauthenticated
    // /api/files/:boardId/:fileId proxy the CLIENT cabinet already relies on
    // (same "obscure, not secret" model there), so the frontend needs the
    // value once to build those <img>/<video> src attributes — sent here,
    // not as a route param anywhere under /api/team/.
    res.json({ tasks: mine, statusOptions: meta.statusOptions, keywordsPropertyFound: meta.keywordsPropertyFound, boardId });
  } catch (err) {
    console.error('[api] team tasks failed:', err.message);
    res.status(502).json({ error: 'mattermost_unavailable', message: err.message });
  }
});

// Loose whitespace-normalizing label compare — mirrors taskMapper.js's
// internal normLabel (not exported), used here only to verify a status
// write actually took (see setStatusByRawLabel below).
function normLabelLoose(s) {
  return (s == null ? '' : String(s)).trim().replace(/\s+/g, ' ');
}

// Re-reads one task the way the /team cabinet needs it (every status, not
// just the 5 client-facing ones) — shared by every /api/team/tasks/:id/*
// write route below, right after it changes something.
async function refetchTeamTask(boardId, taskId) {
  const { board, cards, blocks } = await loadBoard(boardId, { fresh: true });
  const feedbackAuthorUserId = await getFeedbackAuthorId();
  const { tasks } = buildTasks(board, cards, blocks, { skipProjectFilter: true, includeAllStatuses: true, feedbackAuthorUserId });
  const updated = tasks.find((t) => t.id === taskId);
  if (!updated) throw new Error(`Card ${taskId} not found on board ${boardId} after update.`);
  await resolveDiskMediaKinds([updated]);
  await mediaOrder.applyStoredOrder(boardId, [updated]);
  return updated;
}

function teamActorName(req) {
  const u = req.teamSession.user;
  return [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || 'команда';
}

// POST /api/team/tasks/:taskId/status — body: { status: <raw label> }.
// Unlike setApprovalStatus (client-facing, only the 5 statusOptionLabels
// keys), this accepts ANY option on the "Статус" property — a team member
// moves a card through internal production stages too ("В процессе",
// "Сдали", ...), not just the client-visible ones.
app.post('/api/team/tasks/:taskId/status', teamAuth.requireTeamAuth, async (req, res) => {
  const boardId = requireStaffBoardId(res);
  if (!boardId) return;
  const status = String((req.body && req.body.status) || '').trim();
  if (!status) return res.status(400).json({ error: 'status_required' });
  try {
    const updated = await setStatusByRawLabel(boardId, req.params.taskId, status, teamActorName(req));
    res.json({ task: updated });
  } catch (err) {
    console.error('[api] team status update failed:', err.message);
    res.status(502).json({ error: 'status_update_failed', message: err.message });
  }
});

// POST /api/team/tasks/:taskId/text — body: { text }. Same card description
// updateTaskText (client route) edits, but doesn't flip status to "changes"
// or leave a "ЗАКАЗЧИК СКОРРЕКТИРОВАЛ..." marker — this is the team editing
// their own draft, not a client-submitted correction.
app.post('/api/team/tasks/:taskId/text', teamAuth.requireTeamAuth, async (req, res) => {
  const boardId = requireStaffBoardId(res);
  if (!boardId) return;
  const text = String((req.body && req.body.text) || '').replace(/\r\n/g, '\n');
  if (!text.trim()) return res.status(400).json({ error: 'text_required' });
  try {
    const updated = await updateTaskTextTeam(boardId, req.params.taskId, text, teamActorName(req));
    res.json({ task: updated });
  } catch (err) {
    console.error('[api] team text update failed:', err.message);
    res.status(502).json({ error: 'text_update_failed', message: err.message });
  }
});

// POST /api/team/tasks/:taskId/keywords — body: { text }. The
// "Ключевые слова/мысли" brief property — team-only, never shown to clients.
app.post('/api/team/tasks/:taskId/keywords', teamAuth.requireTeamAuth, async (req, res) => {
  const boardId = requireStaffBoardId(res);
  if (!boardId) return;
  const text = String((req.body && req.body.text) || '');
  try {
    const updated = await updateTaskKeywords(boardId, req.params.taskId, text);
    res.json({ task: updated });
  } catch (err) {
    console.error('[api] team keywords update failed:', err.message);
    res.status(502).json({ error: 'keywords_update_failed', message: err.message });
  }
});

// POST /api/team/tasks/:taskId/media-order — same permutation contract as
// the client-facing route below, but doesn't flip status to "changes" (see
// updateTaskMediaOrderTeam) and logs a distinct marker comment.
app.post('/api/team/tasks/:taskId/media-order', teamAuth.requireTeamAuth, async (req, res) => {
  const boardId = requireStaffBoardId(res);
  if (!boardId) return;
  const order = Array.isArray(req.body && req.body.order) ? req.body.order.map(String) : null;
  if (!order || !order.length) return res.status(400).json({ error: 'order_required' });
  try {
    const updated = await updateTaskMediaOrderTeam(boardId, req.params.taskId, order, teamActorName(req));
    res.json({ task: updated });
  } catch (err) {
    console.error('[api] team media order update failed:', err.message);
    const status = err.code === 'stale_media_order' ? 409 : 502;
    res.status(status).json({ error: err.code || 'media_order_failed', message: err.message });
  }
});

// POST /api/team/tasks/:taskId/media-link — body: { url }. Attaches an
// EXISTING disk.kontentferma share link to the card (validated the same way
// /api/disk-embed validates one before proxying it — see diskEmbeds.js).
// This is deliberately NOT a file upload: real drag-and-drop upload needs
// WebDAV/API credentials for disk.kontentferma this app doesn't have yet
// (see frontend/team.js) — until then, staff create the share link on the
// Disk itself (as already done for existing cards) and attach it here
// instead of hand-editing the Mattermost card. The link is stored as its
// own text child block (see addTeamMediaLink) — never mixed into the same
// block as the caption — so a later caption edit can never delete it.
app.post('/api/team/tasks/:taskId/media-link', teamAuth.requireTeamAuth, async (req, res) => {
  const boardId = requireStaffBoardId(res);
  if (!boardId) return;
  const shareUrl = parseAndValidateShareUrl(String((req.body && req.body.url) || '').trim());
  if (!shareUrl) {
    return res.status(400).json({ error: 'invalid_disk_url', message: 'Это не похоже на ссылку с disk.kontentferma — проверьте адрес.' });
  }
  try {
    const updated = await addTeamMediaLink(boardId, req.params.taskId, shareUrl, teamActorName(req));
    res.json({ task: updated });
  } catch (err) {
    console.error('[api] team media link add failed:', err.message);
    res.status(502).json({ error: 'media_link_failed', message: err.message });
  }
});

// POST /api/team/tasks/:taskId/media-upload — multipart, field name "file".
// The real drag-and-drop/file-picker path: uploads straight to
// disk.kontentferma via WebDAV (diskUpload.js), creates a public share
// link, then attaches it the exact same way POST .../media-link does for a
// manually-pasted one (addTeamMediaLink). Needs DISK_WEBDAV_* configured —
// until then diskUpload throws a self-diagnosing error (501, not a generic
// 502) so the UI can say clearly "not set up yet" instead of "failed", and
// the manual-link field stays usable as the fallback either way.
app.post('/api/team/tasks/:taskId/media-upload', teamAuth.requireTeamAuth, (req, res) => {
  teamMediaUpload.single('file')(req, res, async (uploadErr) => {
    if (uploadErr) {
      const tooLarge = uploadErr.code === 'LIMIT_FILE_SIZE';
      return res.status(tooLarge ? 413 : 400).json({
        error: tooLarge ? 'file_too_large' : 'upload_error',
        message: tooLarge ? 'Файл слишком большой (максимум 80 МБ).' : uploadErr.message,
      });
    }
    const boardId = requireStaffBoardId(res);
    if (!boardId) return;
    if (!req.file) return res.status(400).json({ error: 'file_required' });
    try {
      const { board, cards, blocks } = await loadBoard(boardId, { fresh: true });
      const feedbackAuthorUserId = await getFeedbackAuthorId();
      const { tasks } = buildTasks(board, cards, blocks, { skipProjectFilter: true, includeAllStatuses: true, feedbackAuthorUserId });
      const task = tasks.find((t) => t.id === req.params.taskId);
      if (!task) return res.status(404).json({ error: 'task_not_found' });
      const dateStr = task.publishDate || new Date().toISOString().slice(0, 10);
      const extMatch = String(req.file.originalname || '').match(/\.[a-zA-Z0-9]+$/);
      const filename = `${dateStr}_${Date.now().toString(36)}${extMatch ? extMatch[0] : ''}`;
      const shareUrl = await diskUpload.uploadAndShare({
        folderName: task.projectLabel || 'Без клиента',
        filename,
        buffer: req.file.buffer,
        mimeType: req.file.mimetype,
      });
      const updated = await addTeamMediaLink(boardId, req.params.taskId, shareUrl, teamActorName(req));
      res.json({ task: updated });
    } catch (err) {
      console.error('[api] team media upload failed:', err.message);
      const status = err.code === 'disk_upload_not_configured' ? 501 : 502;
      res.status(status).json({ error: err.code || 'media_upload_failed', message: err.message });
    }
  });
});

// POST /api/team/tasks/:taskId/chat-upload — multipart, field name "file".
// A photo attached to a CHAT message (either "ЧАТ КОМАНДЫ" or "Чат с
// клиентом" — not the post's own media). Uploads to disk.kontentferma the
// same way media-upload above does, but does NOT call addTeamMediaLink —
// it just hands back the share link for the caller to attach to whichever
// message it's about to send (POST .../comments or .../client-message).
app.post('/api/team/tasks/:taskId/chat-upload', teamAuth.requireTeamAuth, (req, res) => {
  teamMediaUpload.single('file')(req, res, async (uploadErr) => {
    if (uploadErr) {
      const tooLarge = uploadErr.code === 'LIMIT_FILE_SIZE';
      return res.status(tooLarge ? 413 : 400).json({
        error: tooLarge ? 'file_too_large' : 'upload_error',
        message: tooLarge ? 'Файл слишком большой (максимум 80 МБ).' : uploadErr.message,
      });
    }
    const boardId = requireStaffBoardId(res);
    if (!boardId) return;
    if (!req.file) return res.status(400).json({ error: 'file_required' });
    try {
      const { board, cards, blocks } = await loadBoard(boardId, { fresh: true });
      const feedbackAuthorUserId = await getFeedbackAuthorId();
      const { tasks } = buildTasks(board, cards, blocks, { skipProjectFilter: true, includeAllStatuses: true, feedbackAuthorUserId });
      const task = tasks.find((t) => t.id === req.params.taskId);
      if (!task) return res.status(404).json({ error: 'task_not_found' });
      const extMatch = String(req.file.originalname || '').match(/\.[a-zA-Z0-9]+$/);
      const filename = `chat_${Date.now().toString(36)}${extMatch ? extMatch[0] : ''}`;
      const shareUrl = await diskUpload.uploadAndShare({
        folderName: task.projectLabel || 'Без клиента',
        filename,
        buffer: req.file.buffer,
        mimeType: req.file.mimetype,
      });
      res.json({ shareUrl });
    } catch (err) {
      console.error('[api] chat image upload failed:', err.message);
      const status = err.code === 'disk_upload_not_configured' ? 501 : 502;
      res.status(status).json({ error: err.code || 'chat_upload_failed', message: err.message });
    }
  });
});

// POST /api/team/tasks/:taskId/title — body: { title }. The human-readable
// part only — see updateTaskTitle for how the ig:/tg:/... prefix survives.
app.post('/api/team/tasks/:taskId/title', teamAuth.requireTeamAuth, async (req, res) => {
  const boardId = requireStaffBoardId(res);
  if (!boardId) return;
  const title = String((req.body && req.body.title) || '').trim();
  if (!title) return res.status(400).json({ error: 'title_required' });
  try {
    const updated = await updateTaskTitle(boardId, req.params.taskId, title, teamActorName(req));
    res.json({ task: updated });
  } catch (err) {
    console.error('[api] team title update failed:', err.message);
    res.status(502).json({ error: 'title_update_failed', message: err.message });
  }
});

// POST /api/team/tasks/:taskId/network — body: { network: 'ig'|'tg'|'vk'|'ok'|'max'|'' }.
// Which platform this post is going out to — was missing a UI for it
// entirely before this; see updateTaskNetwork for why this is a title
// prefix, not a card property. Empty string clears the prefix.
app.post('/api/team/tasks/:taskId/network', teamAuth.requireTeamAuth, async (req, res) => {
  const boardId = requireStaffBoardId(res);
  if (!boardId) return;
  const network = String((req.body && req.body.network) || '').trim();
  try {
    const updated = await updateTaskNetwork(boardId, req.params.taskId, network, teamActorName(req));
    res.json({ task: updated });
  } catch (err) {
    console.error('[api] team network update failed:', err.message);
    res.status(502).json({ error: 'network_update_failed', message: err.message });
  }
});

// POST /api/team/tasks/:taskId/date — body: { date: 'YYYY-MM-DD' }. Moves
// the publish date — the month-calendar picker in the /team cabinet's card
// header (see also GET /api/team/schedule below, which feeds that picker's
// "this day is already busy" markers).
app.post('/api/team/tasks/:taskId/date', teamAuth.requireTeamAuth, async (req, res) => {
  const boardId = requireStaffBoardId(res);
  if (!boardId) return;
  const dateStr = String((req.body && req.body.date) || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return res.status(400).json({ error: 'invalid_date', message: 'Ожидался формат YYYY-MM-DD.' });
  }
  try {
    const updated = await updateTaskDate(boardId, req.params.taskId, dateStr);
    res.json({ task: updated });
  } catch (err) {
    console.error('[api] team date update failed:', err.message);
    res.status(502).json({ error: 'date_update_failed', message: err.message });
  }
});

// GET /api/team/schedule?month=YYYY-MM — board-wide (not just "my tasks")
// count of posts scheduled per day, for the month-calendar date picker to
// mark days that already have other activity on them ("чтобы не получилось
// что все посты в один день"). Deliberately just counts + a short label
// list, not full task objects — this is a lightweight adjacency signal, not
// a second copy of GET /api/team/tasks.
app.get('/api/team/schedule', teamAuth.requireTeamAuth, async (req, res) => {
  const boardId = requireStaffBoardId(res);
  if (!boardId) return;
  const month = String(req.query.month || '').trim();
  if (!/^\d{4}-\d{2}$/.test(month)) {
    return res.status(400).json({ error: 'invalid_month', message: 'Ожидался формат YYYY-MM.' });
  }
  try {
    const { board, cards, blocks } = await loadBoard(boardId, { fresh: true });
    const { tasks } = buildTasks(board, cards, blocks, { skipProjectFilter: true, includeAllStatuses: true });
    const byDay = {};
    for (const t of tasks) {
      // publishDate is already a plain 'YYYY-MM-DD' string (see
      // parsePropertyDate in taskMapper.js) — no Date() round-trip needed,
      // and none of the timezone-shift risk that would come with one.
      if (!t.publishDate || !t.publishDate.startsWith(month)) continue;
      const key = t.publishDate;
      if (!byDay[key]) byDay[key] = { count: 0, titles: [] };
      byDay[key].count += 1;
      if (byDay[key].titles.length < 5) byDay[key].titles.push(t.title);
    }
    res.json({ month, days: byDay });
  } catch (err) {
    console.error('[api] team schedule failed:', err.message);
    res.status(502).json({ error: 'schedule_unavailable', message: err.message });
  }
});

// GET/POST /api/team/tasks/:taskId/comments — internal team discussion, see
// teamComments.js. Deliberately separate from the client-facing "правки"
// comments (which live on the Mattermost card itself).
app.get('/api/team/tasks/:taskId/comments', teamAuth.requireTeamAuth, async (req, res) => {
  const boardId = requireStaffBoardId(res);
  if (!boardId) return;
  try {
    const comments = await teamComments.listComments(boardId, req.params.taskId);
    res.json({ comments });
  } catch (err) {
    console.error('[api] team comments list failed:', err.message);
    res.status(500).json({ error: 'comments_unavailable', message: err.message });
  }
});

app.post('/api/team/tasks/:taskId/comments', teamAuth.requireTeamAuth, async (req, res) => {
  const boardId = requireStaffBoardId(res);
  if (!boardId) return;
  const text = String((req.body && req.body.text) || '').trim();
  const imageUrl = String((req.body && req.body.imageUrl) || '').trim();
  // A message can be image-only (no caption) — only reject if BOTH are empty.
  if (!text && !imageUrl) return res.status(400).json({ error: 'text_required' });
  try {
    const user = req.teamSession.user;
    const comment = await teamComments.addComment(boardId, req.params.taskId, { id: user.id, name: teamActorName(req) }, text, imageUrl);
    res.json({ comment });
  } catch (err) {
    console.error('[api] team comment add failed:', err.message);
    res.status(500).json({ error: 'comment_failed', message: err.message });
  }
});

// POST /api/team/tasks/:taskId/client-message — body: { text }. Sends a
// message to the CLIENT (see sendClientMessage) — separate from
// /comments above, which is the internal team-only chat. Available any
// time, not gated on the client having said anything first.
app.post('/api/team/tasks/:taskId/client-message', teamAuth.requireTeamAuth, async (req, res) => {
  const boardId = requireStaffBoardId(res);
  if (!boardId) return;
  const text = String((req.body && req.body.text) || '').trim();
  const imageUrl = String((req.body && req.body.imageUrl) || '').trim();
  // A message can be image-only (no caption) — only reject if BOTH are empty.
  if (!text && !imageUrl) return res.status(400).json({ error: 'text_required' });
  try {
    const updated = await sendClientMessage(boardId, req.params.taskId, text, teamActorName(req), imageUrl);
    res.json({ task: updated });
  } catch (err) {
    console.error('[api] team client-message failed:', err.message);
    res.status(502).json({ error: 'client_message_failed', message: err.message });
  }
});

// POST /api/boards/:boardId/tasks/:taskId/approve — idempotent.
app.post('/api/boards/:boardId/tasks/:taskId/approve', async (req, res) => {
  try {
    const { boardId, taskId } = req.params;
    await mm.addCardComment(boardId, taskId, `${formatMoscowTimestamp()} СОГЛАСОВАНО`);
    const updated = await setApprovalStatus(boardId, taskId, 'approved');
    res.json({ task: updated });
  } catch (err) {
    console.error('[api] approve failed:', err.message);
    res.status(502).json({ error: 'approve_failed', message: err.message });
  }
});

// POST /api/boards/:boardId/tasks/:taskId/feedback — body: { comment }
app.post('/api/boards/:boardId/tasks/:taskId/feedback', async (req, res) => {
  const comment = (req.body && req.body.comment || '').trim();
  if (!comment) return res.status(400).json({ error: 'comment_required' });
  try {
    const { boardId, taskId } = req.params;
    // Marker line + the client's actual text in one comment, so it still
    // shows correctly as "правки" in the cabinet (taskMapper picks the most
    // recent comment from our own account as task.feedback) while also
    // giving Mattermost staff the date/time + "ПРАВКИ" marker they asked for.
    const commentWithMarker = `${formatMoscowTimestamp()} ПРАВКИ\n\n${comment}`;
    await mm.addCardComment(boardId, taskId, commentWithMarker);
    const updated = await setApprovalStatus(boardId, taskId, 'changes');
    res.json({ task: updated });
  } catch (err) {
    console.error('[api] feedback failed:', err.message);
    res.status(502).json({ error: 'feedback_failed', message: err.message });
  }
});

// POST /api/boards/:boardId/tasks/:taskId/feedback-image — multipart, field
// "file". Lets the CLIENT attach a photo to their правки (see the
// feedbackModal attach button in app.js) — uploads to disk.kontentferma via
// diskUpload.js (same pipeline as the team cabinet's chat-upload) and hands
// back the share link only; the frontend appends it as a trailing line to
// the comment text before POSTing .../feedback below. taskMapper.js's
// clientComments extraction (kind:'feedback') already knows how to pull a
// trailing disk link back out as imageUrl — no changes needed there. Public
// like /feedback itself (same obscured-boardId security model), not gated
// by teamAuth.
app.post('/api/boards/:boardId/tasks/:taskId/feedback-image', (req, res) => {
  teamMediaUpload.single('file')(req, res, async (uploadErr) => {
    if (uploadErr) {
      const tooLarge = uploadErr.code === 'LIMIT_FILE_SIZE';
      return res.status(tooLarge ? 413 : 400).json({
        error: tooLarge ? 'file_too_large' : 'upload_error',
        message: tooLarge ? 'Файл слишком большой (максимум 80 МБ).' : uploadErr.message,
      });
    }
    if (!req.file) return res.status(400).json({ error: 'file_required' });
    try {
      const { boardId, taskId } = req.params;
      const { board, cards, blocks } = await loadBoard(boardId, { fresh: true });
      const feedbackAuthorUserId = await getFeedbackAuthorId();
      const { tasks } = buildTasks(board, cards, blocks, { skipProjectFilter: true, feedbackAuthorUserId });
      const task = tasks.find((t) => t.id === taskId);
      if (!task) return res.status(404).json({ error: 'task_not_found' });
      const extMatch = String(req.file.originalname || '').match(/\.[a-zA-Z0-9]+$/);
      const filename = `feedback_${Date.now().toString(36)}${extMatch ? extMatch[0] : ''}`;
      const shareUrl = await diskUpload.uploadAndShare({
        folderName: task.projectLabel || 'Без клиента',
        filename,
        buffer: req.file.buffer,
        mimeType: req.file.mimetype,
      });
      res.json({ shareUrl });
    } catch (err) {
      console.error('[api] client feedback image upload failed:', err.message);
      const status = err.code === 'disk_upload_not_configured' ? 501 : 502;
      res.status(status).json({ error: err.code || 'feedback_image_failed', message: err.message });
    }
  });
});

// POST /api/boards/:boardId/tasks/:taskId/text — body: { text }
// Rewrites the client-facing description text stored as text-type child blocks
// on the card, then leaves a log comment that the client corrected the copy.
app.post('/api/boards/:boardId/tasks/:taskId/text', async (req, res) => {
  const text = String((req.body && req.body.text) || '').replace(/\r\n/g, '\n');
  if (!text.trim()) return res.status(400).json({ error: 'text_required' });
  try {
    const { boardId, taskId } = req.params;
    const updated = await updateTaskText(boardId, taskId, text);
    res.json({ task: updated });
  } catch (err) {
    console.error('[api] text update failed:', err.message);
    res.status(502).json({ error: 'text_update_failed', message: err.message });
  }
});

// POST /api/boards/:boardId/tasks/:taskId/media-order — body: { order: [mediaId, ...] }
// `order` must be a full permutation of the task's current media ids (see
// updateTaskMediaOrder) — the client always sends the whole list it's
// currently showing, reordered.
app.post('/api/boards/:boardId/tasks/:taskId/media-order', async (req, res) => {
  const order = Array.isArray(req.body && req.body.order) ? req.body.order.map(String) : null;
  if (!order || !order.length) return res.status(400).json({ error: 'order_required' });
  try {
    const { boardId, taskId } = req.params;
    const updated = await updateTaskMediaOrder(boardId, taskId, order);
    res.json({ task: updated });
  } catch (err) {
    console.error('[api] media order update failed:', err.message);
    const status = err.code === 'stale_media_order' ? 409 : 502;
    res.status(status).json({ error: err.code || 'media_order_failed', message: err.message });
  }
});

async function setApprovalStatus(boardId, taskId, statusKey) {
  const { board, cards } = await loadBoard(boardId);
  const approvalProp = findPropertyDef(board, config.approvalPropertyName);
  if (!approvalProp) {
    throw new Error(
      `Card property "${config.approvalPropertyName}" not found on board ${boardId}. ` +
        `Add a select property with this exact name and options matching statusOptionLabels in config.js.`
    );
  }
  const targetLabel = config.statusOptionLabels[statusKey];
  const optionId = optionIdByLabel(approvalProp, targetLabel);
  if (!optionId) {
    throw new Error(
      `Option "${targetLabel}" not found on property "${config.approvalPropertyName}" (board ${boardId}).`
    );
  }
  const card = cards.find((c) => c.id === taskId);
  if (!card) throw new Error(`Card ${taskId} not found on board ${boardId} before update.`);
  // Merge the one changed property into the card's FULL current properties —
  // see the big comment on mattermostClient.patchCardProperty for why: the
  // real PATCH body (`updatedFields.properties`) replaces the whole
  // properties object, so sending just the changed property would silently
  // wipe out project/date/post-text/etc. on the card.
  const mergedProperties = { ...(card.properties || {}), [approvalProp.id]: optionId };
  const patchResult = await mm.patchCardProperty(boardId, taskId, mergedProperties);
  if (config.debug) {
    console.log(`[mattermost:debug] patchCardProperty(${boardId},${taskId}) response →`, JSON.stringify(patchResult).slice(0, 1000));
  }
  invalidate(boardId);
  const { board: freshBoard, cards: freshCards, blocks } = await loadBoard(boardId, { fresh: true });
  // skipProjectFilter: we already know the exact card id (client only ever
  // learns it from their own, already-filtered task list) — no need to
  // re-apply the project filter here, and doing so would break this lookup
  // on shared boards since we don't carry the client's `project` through.
  const feedbackAuthorUserId = await getFeedbackAuthorId();
  const { tasks } = buildTasks(freshBoard, freshCards, blocks, { skipProjectFilter: true, feedbackAuthorUserId });
  const updated = tasks.find((t) => t.id === taskId);
  if (!updated) throw new Error(`Card ${taskId} not found on board ${boardId} after update.`);
  // IMPORTANT: a 200 from PATCH does not prove Mattermost actually changed
  // anything — this was silently failing in production (UI said "Согласовано",
  // Boards itself stayed unchanged). Verify by re-reading the card and
  // comparing its actual status, and fail loudly if it didn't take, instead
  // of reporting false success back to the client.
  if (updated.status !== statusKey) {
    throw new Error(
      `Mattermost принял запрос на изменение статуса (PATCH вернул успех), но после повторного чтения ` +
        `карточки ${taskId} статус остался "${updated.statusLabel || '(нет)'}", а не "${targetLabel}". ` +
        `Похоже, PATCH на этом сервере не применяется по факту — либо аккаунт, от имени которого идёт ` +
        `запрос (см. MATTERMOST_LOGIN_ID/MATTERMOST_TOKEN), не имеет прав редактировать эту карточку/борд, ` +
        `либо формат запроса отличается от ожидаемого (см. docs/MATTERMOST_INTEGRATION.md §4).`
    );
  }
  await resolveDiskMediaKinds([updated]);
  await mediaOrder.applyStoredOrder(boardId, [updated]);
  return updated;
}

// Text-type child blocks that consist ONLY of a disk.kontentferma share link
// (see diskEmbeds.js) are MEDIA, not prose — added by the /team media-link
// route (see addTeamMediaLink) or hand-pasted by staff directly in
// Mattermost. saveDescriptionText below must never touch/delete these, or
// saving the caption would silently drop whatever media was attached.
function isPureDiskLinkBlock(block) {
  const title = String(block.title || (block.fields && block.fields.text) || '').trim();
  return !!(title && parseAndValidateShareUrl(title));
}

// Shared by updateTaskText (client) and updateTaskTextTeam (team): rewrites
// the card's PROSE description, leaving any pure-disk-link blocks (media)
// completely alone. `blocks` must already be fresh (caller loads it).
async function saveDescriptionText(boardId, taskId, blocks, text) {
  const allTextBlocks = (blocks || [])
    .filter((b) => b.parentId === taskId && !b.deleteAt && b.type === 'text')
    .sort((a, b) => (a.createAt || 0) - (b.createAt || 0));
  const proseBlocks = allTextBlocks.filter((b) => !isPureDiskLinkBlock(b));

  const nowMs = Date.now();
  if (proseBlocks.length) {
    await mm.patchBlock(boardId, proseBlocks[0].id, { title: text });
    for (const extra of proseBlocks.slice(1)) {
      await mm.deleteBlock(boardId, extra.id);
    }
  } else {
    await mm.addBlocks(boardId, [
      {
        id: `${nowMs.toString(36)}${Math.random().toString(36).slice(2, 8)}`,
        boardId,
        parentId: taskId,
        type: 'text',
        title: text,
        schema: 1,
        createAt: nowMs,
        updateAt: nowMs,
        fields: {},
      },
    ], 'addDescriptionBlock');
  }
}

async function updateTaskText(boardId, taskId, text) {
  const { board, cards, blocks } = await loadBoard(boardId, { fresh: true });
  const card = cards.find((c) => c.id === taskId);
  if (!card) throw new Error(`Card ${taskId} not found on board ${boardId} before text update.`);

  await saveDescriptionText(boardId, taskId, blocks, text);
  await mm.addCardComment(boardId, taskId, `${formatMoscowTimestamp()} ЗАКАЗЧИК СКОРРЕКТИРОВАЛ ТЕКСТ. ОБНОВЛЕНА ВЕРСИЯ`);
  await setApprovalStatus(boardId, taskId, 'changes');

  invalidate(boardId);
  const { board: freshBoard, cards: freshCards, blocks: freshBlocks } = await loadBoard(boardId, { fresh: true });
  const feedbackAuthorUserId = await getFeedbackAuthorId();
  const { tasks } = buildTasks(freshBoard, freshCards, freshBlocks, { skipProjectFilter: true, feedbackAuthorUserId });
  const updated = tasks.find((t) => t.id === taskId);
  if (!updated) throw new Error(`Card ${taskId} not found on board ${boardId} after text update.`);
  await resolveDiskMediaKinds([updated]);
  await mediaOrder.applyStoredOrder(boardId, [updated]);
  return updated;
}

// Team's own version of updateTaskText: same description rewrite, but no
// "flip to changes"/client-facing marker comment — a team member editing
// their own draft isn't a client correction.
async function updateTaskTextTeam(boardId, taskId, text, actorName) {
  const { board, cards, blocks } = await loadBoard(boardId, { fresh: true });
  const card = cards.find((c) => c.id === taskId);
  if (!card) throw new Error(`Card ${taskId} not found on board ${boardId} before text update.`);

  await saveDescriptionText(boardId, taskId, blocks, text);
  await mm.addCardComment(boardId, taskId, `${formatMoscowTimestamp()} ТЕКСТ ОБНОВЛЁН (${actorName || 'команда'})`);
  invalidate(boardId);
  return refetchTeamTask(boardId, taskId);
}

// Shared reorder core for updateTaskMediaOrder (client) and
// updateTaskMediaOrderTeam below — computes the new order, validates it's a
// permutation of the task's CURRENT media, persists it, and returns which
// items moved (for the marker comment each caller writes differently).
// includeAllStatuses:true so a team member can reorder media on a card
// that's still in an internal-only production stage, not just the 5
// client-facing ones.
async function reorderTaskMedia(boardId, taskId, newOrderIds) {
  const { board, cards, blocks } = await loadBoard(boardId, { fresh: true });
  const feedbackAuthorUserId = await getFeedbackAuthorId();
  const { tasks } = buildTasks(board, cards, blocks, { skipProjectFilter: true, includeAllStatuses: true, feedbackAuthorUserId });
  const task = tasks.find((t) => t.id === taskId);
  if (!task) throw new Error(`Card ${taskId} not found on board ${boardId} before media reorder.`);
  await resolveDiskMediaKinds([task]);
  await mediaOrder.applyStoredOrder(boardId, [task]); // current effective ("before") order

  const beforeIds = task.media.map((m) => m.id);
  const beforeSet = new Set(beforeIds);
  const afterSet = new Set(newOrderIds);
  const isSamePermutation =
    newOrderIds.length === beforeIds.length &&
    beforeIds.every((id) => afterSet.has(id)) &&
    newOrderIds.every((id) => beforeSet.has(id));
  if (!isSamePermutation) {
    const err = new Error('Список материалов устарел — обновите страницу и попробуйте снова.');
    err.code = 'stale_media_order';
    throw err;
  }

  const beforePos = new Map(beforeIds.map((id, i) => [id, i + 1]));
  const afterPos = new Map(newOrderIds.map((id, i) => [id, i + 1]));
  const byId = new Map(task.media.map((m) => [m.id, m]));
  const kindLabel = (k) => (k === 'image' ? 'Фото' : k === 'video' ? 'Видео' : 'Файл');
  const moved = beforeIds
    .filter((id) => beforePos.get(id) !== afterPos.get(id))
    .map((id) => {
      const m = byId.get(id);
      const label = (m && m.name) ? m.name : `${kindLabel(m && m.kind)} #${beforePos.get(id)}`;
      return `${label}: было на месте ${beforePos.get(id)} → стало на месте ${afterPos.get(id)}`;
    });

  await mediaOrder.setMediaOrder(boardId, taskId, newOrderIds);
  return { moved };
}

// Reorders a task's media (photos/videos) per a client-submitted list of
// media ids, then flips status to 'changes' — the client corrected
// something about how the post reads, staff should re-review before
// publishing. Leaves a comment naming which items moved and where, not just
// a generic "changed" marker, so staff can tell at a glance whether it's
// worth reopening the card in Mattermost.
async function updateTaskMediaOrder(boardId, taskId, newOrderIds) {
  const { moved } = await reorderTaskMedia(boardId, taskId, newOrderIds);
  if (moved.length) {
    await mm.addCardComment(
      boardId,
      taskId,
      `${formatMoscowTimestamp()} ЗАКАЗЧИК ИЗМЕНИЛ ПОРЯДОК МЕДИА:\n${moved.map((l) => `• ${l}`).join('\n')}`
    );
  }
  return setApprovalStatus(boardId, taskId, 'changes');
}

// Team's own version — same reorder, but no "flip to changes" (the team
// isn't correcting a client-approved post, just organizing a draft) and a
// distinct marker comment.
async function updateTaskMediaOrderTeam(boardId, taskId, newOrderIds, actorName) {
  const { moved } = await reorderTaskMedia(boardId, taskId, newOrderIds);
  if (moved.length) {
    await mm.addCardComment(
      boardId,
      taskId,
      `${formatMoscowTimestamp()} ПОРЯДОК МЕДИА ИЗМЕНЁН (${actorName || 'команда'}):\n${moved.map((l) => `• ${l}`).join('\n')}`
    );
  }
  invalidate(boardId);
  return refetchTeamTask(boardId, taskId);
}

// Sets the "Статус" property to ANY raw option label — unlike
// setApprovalStatus (client-facing, restricted to the 5 statusOptionLabels
// keys), used by the team status picker which can move a card through
// internal production stages too. Verifies the write actually took by
// re-reading the card (same "PATCH can 200 without changing anything"
// caution as setApprovalStatus).
async function setStatusByRawLabel(boardId, taskId, rawLabel, actorName) {
  const { board, cards } = await loadBoard(boardId, { fresh: true });
  const approvalProp = findPropertyDef(board, config.approvalPropertyName);
  if (!approvalProp) {
    throw new Error(`Card property "${config.approvalPropertyName}" not found on board ${boardId}.`);
  }
  const optionId = optionIdByLabel(approvalProp, rawLabel);
  if (!optionId) {
    const available = (approvalProp.options || []).map((o) => `«${o.value}»`).join(', ') || '(нет опций)';
    throw new Error(`Опция "${rawLabel}" не найдена в свойстве "${config.approvalPropertyName}". Доступные опции: ${available}.`);
  }
  const card = cards.find((c) => c.id === taskId);
  if (!card) throw new Error(`Card ${taskId} not found on board ${boardId} before status update.`);
  const mergedProperties = { ...(card.properties || {}), [approvalProp.id]: optionId };
  await mm.patchCardProperty(boardId, taskId, mergedProperties);
  await mm.addCardComment(boardId, taskId, `${formatMoscowTimestamp()} СТАТУС ИЗМЕНЁН (${actorName || 'команда'}): ${rawLabel}`);
  invalidate(boardId);
  const updated = await refetchTeamTask(boardId, taskId);
  if (normLabelLoose(updated.statusLabel) !== normLabelLoose(rawLabel)) {
    throw new Error(
      `Mattermost принял запрос на изменение статуса, но после повторного чтения карточки ${taskId} статус ` +
        `остался "${updated.statusLabel || '(нет)'}", а не "${rawLabel}". Проверьте права аккаунта, от имени которого работает приложение.`
    );
  }
  return updated;
}

// Sets an arbitrary free-text property (currently just "Ключевые
// слова/мысли") — team-only, never shown to clients, so no marker comment.
async function updateTaskKeywords(boardId, taskId, text) {
  const { board, cards } = await loadBoard(boardId, { fresh: true });
  const keywordsProp = findPropertyDef(board, config.keywordsPropertyName);
  if (!keywordsProp) {
    const available = (board.cardProperties || []).map((p) => `«${p.name}»`).join(', ') || '(не удалось получить список свойств)';
    throw new Error(`Свойство "${config.keywordsPropertyName}" не найдено на борде. Реальные свойства борда: ${available}.`);
  }
  const card = cards.find((c) => c.id === taskId);
  if (!card) throw new Error(`Card ${taskId} not found on board ${boardId} before keywords update.`);
  const mergedProperties = { ...(card.properties || {}), [keywordsProp.id]: text };
  await mm.patchCardProperty(boardId, taskId, mergedProperties);
  invalidate(boardId);
  return refetchTeamTask(boardId, taskId);
}

// Which social network a post is for is NOT a Mattermost property at all —
// it's a title-prefix convention frontend/app.js already reads for real
// (SOCIAL_MAP/SOCIAL_PREFIX_RE/detectSocial there) to render the colored
// IG/TG/VK/OK/MAX badge on client-facing cards. config.formatPropertyName
// is a different, separate (and in practice unconfigured — empty by
// default) free-text "format" field — writing the network there would
// change nothing the client actually sees. So this writes the SAME prefix
// convention the client cabinet already reads, via the card's own title
// (a block field, patched the same way saveDescriptionText patches a text
// child block's title — see mm.patchBlock). Keep this regex/map in sync
// with SOCIAL_MAP/SOCIAL_PREFIX_RE in frontend/app.js and frontend/team.js.
const SOCIAL_LABELS = { ig: 'Instagram', tg: 'Telegram', vk: 'ВКонтакте', ok: 'Одноклассники', max: 'MAX' };
const SOCIAL_PREFIX_RE = /^(ig|tg|vk|ok|max)\b[\s:\-–—]*/i;

async function updateTaskNetwork(boardId, taskId, networkKey, actorName) {
  const key = String(networkKey || '').trim().toLowerCase();
  if (key && !SOCIAL_LABELS[key]) {
    throw new Error(`Неизвестная соцсеть "${networkKey}". Доступные: ${Object.keys(SOCIAL_LABELS).join(', ')}.`);
  }
  const { cards } = await loadBoard(boardId, { fresh: true });
  const card = cards.find((c) => c.id === taskId);
  if (!card) throw new Error(`Card ${taskId} not found on board ${boardId} before network update.`);
  // AI_TAG_RE ('[ai]', see app.js) is never anchored at the very start of a
  // real title the way the social prefix is, so it's untouched here — no
  // need to strip/reinsert it the way stripAiTag does for display.
  const bareTitle = String(card.title || '').replace(SOCIAL_PREFIX_RE, '');
  const newTitle = key ? `${key}: ${bareTitle}` : bareTitle;
  await mm.patchBlock(boardId, taskId, { title: newTitle });
  await mm.addCardComment(
    boardId,
    taskId,
    `${formatMoscowTimestamp()} СОЦСЕТЬ ИЗМЕНЕНА (${actorName || 'команда'}): ${key ? SOCIAL_LABELS[key] : '—'}`
  );
  invalidate(boardId);
  return refetchTeamTask(boardId, taskId);
}

// Renames a card, preserving whatever social prefix updateTaskNetwork put on
// it — the /team cabinet's title field only ever edits the human-readable
// part, never the ig:/tg:/... tag, so this strips the existing prefix, keeps
// it aside, and re-applies it to the new text instead of asking the caller
// to know about the convention at all.
async function updateTaskTitle(boardId, taskId, newBareTitle, actorName) {
  const trimmed = String(newBareTitle || '').trim();
  if (!trimmed) throw new Error('Название не может быть пустым.');
  const { cards } = await loadBoard(boardId, { fresh: true });
  const card = cards.find((c) => c.id === taskId);
  if (!card) throw new Error(`Card ${taskId} not found on board ${boardId} before title update.`);
  const existingPrefix = String(card.title || '').match(SOCIAL_PREFIX_RE);
  const newTitle = existingPrefix ? `${existingPrefix[0]}${trimmed}` : trimmed;
  await mm.patchBlock(boardId, taskId, { title: newTitle });
  await mm.addCardComment(boardId, taskId, `${formatMoscowTimestamp()} НАЗВАНИЕ ИЗМЕНЕНО (${actorName || 'команда'})`);
  invalidate(boardId);
  return refetchTeamTask(boardId, taskId);
}

// Sets the publish-date property. Written as {"from": epochMs} — the first
// (and, per parsePropertyDate in taskMapper.js, preferred) of the three
// shapes real Focalboard date values have shown up in; the other two
// (bare epoch-ms string, plain "YYYY-MM-DD") are read-compatibility only,
// never something this app itself needs to write.
async function updateTaskDate(boardId, taskId, dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    throw new Error(`Некорректная дата "${dateStr}" — ожидался формат YYYY-MM-DD.`);
  }
  const { board, cards } = await loadBoard(boardId, { fresh: true });
  const dateProp = findPropertyDef(board, config.publishDatePropertyName);
  if (!dateProp) {
    throw new Error(`Свойство "${config.publishDatePropertyName}" не найдено на борде ${boardId}.`);
  }
  const card = cards.find((c) => c.id === taskId);
  if (!card) throw new Error(`Card ${taskId} not found on board ${boardId} before date update.`);
  const epochMs = Date.parse(`${dateStr}T00:00:00.000Z`);
  const mergedProperties = { ...(card.properties || {}), [dateProp.id]: JSON.stringify({ from: epochMs }) };
  await mm.patchCardProperty(boardId, taskId, mergedProperties);
  invalidate(boardId);
  return refetchTeamTask(boardId, taskId);
}

// Adds an already-existing disk.kontentferma share link to a card as its own
// dedicated text block (see isPureDiskLinkBlock) — never mixed into the
// prose caption block, so a later caption edit can never delete it.
async function addTeamMediaLink(boardId, taskId, shareUrl, actorName) {
  const nowMs = Date.now();
  await mm.addBlocks(boardId, [
    {
      id: `${nowMs.toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      boardId,
      parentId: taskId,
      type: 'text',
      title: shareUrl,
      schema: 1,
      createAt: nowMs,
      updateAt: nowMs,
      fields: {},
    },
  ], 'addTeamMediaLink');
  await mm.addCardComment(boardId, taskId, `${formatMoscowTimestamp()} ДОБАВЛЕН МАТЕРИАЛ (${actorName || 'команда'}): ${shareUrl}`);
  invalidate(boardId);
  return refetchTeamTask(boardId, taskId);
}

// Posts a message TO the client — unlike every other team-cabinet marker,
// this one is deliberately included in taskMapper.js's clientComments
// (kind: 'agency'), because the whole point is for the client to see it,
// not just staff working directly in Mattermost. Doesn't flip status (a
// message isn't a correction) and, unlike updateTaskTextTeam etc., can be
// sent at any time regardless of whether the client has said anything —
// see the /team cabinet's "Чат с клиентом" tab, which the team asked to be
// writable rather than read-only.
// imageUrl: optional disk.kontentferma share link for a photo attached to
// this message — appended as its own trailing line so taskMapper.js's
// clientComments extraction (kind:'agency') can pull it back out (same
// convention diskEmbeds.js uses for card-description attachments; see the
// comment there and in taskMapper.js).
async function sendClientMessage(boardId, taskId, text, actorName, imageUrl) {
  const trimmed = String(text || '').trim();
  const image = String(imageUrl || '').trim();
  if (!trimmed && !image) throw new Error('Сообщение не может быть пустым.');
  const body = image ? `${trimmed}${trimmed ? '\n' : ''}${image}` : trimmed;
  await mm.addCardComment(boardId, taskId, `${formatMoscowTimestamp()} СООБЩЕНИЕ (${actorName || 'команда'})\n\n${body}`);
  invalidate(boardId);
  return refetchTeamTask(boardId, taskId);
}

// GET /api/files/:boardId/:fileId — proxies media bytes from Mattermost with
// Range support (needed for video playback, notably iPhone Safari). Board
// attachments live in the Boards plugin's own file storage (keyed by
// team+board), not core Mattermost file storage — see fetchFileStream in
// mattermostClient.js — so boardId is required to build the right URL.
app.get('/api/files/:boardId/:fileId', async (req, res) => {
  try {
    const mmRes = await mm.fetchFileStream(req.params.boardId, req.params.fileId, req.headers.range);
    res.status(mmRes.status);
    for (const h of ['content-type', 'content-length', 'accept-ranges', 'content-range', 'cache-control']) {
      const v = mmRes.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    if (!res.hasHeader('accept-ranges')) res.setHeader('Accept-Ranges', 'bytes');
    mmRes.body.pipe(res);
  } catch (err) {
    console.error('[api] file proxy failed:', err.message);
    res.status(502).json({ error: 'file_unavailable', message: err.message });
  }
});

// GET /api/disk-embed?u=<share url> — proxies a file from the agency's own
// disk.kontentferma.* file server (Nextcloud-style public share links
// pasted into the card description text (or "URL"), so the client sees the material
// inline instead of clicking through to another site. STRICTLY validates
// the URL against the disk.kontentferma.* share-link shape before fetching
// anything — this route is reachable by anyone holding a client link, so it
// must never become an open fetch-any-URL relay. See diskEmbeds.js.
app.get('/api/disk-embed', async (req, res) => {
  const shareUrl = parseAndValidateShareUrl(req.query.u || '');
  if (!shareUrl) return res.status(400).json({ error: 'invalid_disk_url' });
  try {
    const upstream = await streamDiskFile(shareUrl, req.headers.range);
    res.status(upstream.status);
    for (const h of ['content-type', 'content-length', 'accept-ranges', 'content-range', 'etag', 'last-modified']) {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    if (!res.hasHeader('accept-ranges')) res.setHeader('Accept-Ranges', 'bytes');
    // Every request for this file goes agency-server → our Node process →
    // disk.kontentferma → back — two hops, and disk.kontentferma isn't fast.
    // A share link's bytes never change once uploaded (see comment on
    // kindCache above), so it's safe to tell the browser to just keep its
    // own copy for a week instead of re-walking that whole path on every
    // repeat visit/reopen — this is what was making media feel "very slow"
    // even for material already seen. Overrides whatever (if anything)
    // disk.kontentferma itself sent, since a self-hosted Nextcloud share
    // often sends weak/no caching by default.
    if (upstream.status === 200 || upstream.status === 206) {
      res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
    }
    upstream.body.pipe(res);
  } catch (err) {
    console.error('[api] disk-embed proxy failed:', err.message);
    res.status(502).json({ error: 'disk_unavailable', message: err.message });
  }
});

app.get('/healthz', (req, res) => res.json({ ok: true }));

// TEMPORARY diagnostic endpoint — only active when DEBUG_MATTERMOST=true.
// Returns the target board's "Статус"/"Проект" property DEFINITIONS
// (with every option id + label) side by side with the raw `properties`
// of cards whose title matches ?title=..., with no truncation (unlike the
// console debug logs, which cut off at 2000 chars and are useless for a
// board with many cards). Delete this route once the real property/value
// format is confirmed and taskMapper.js is fixed accordingly.
app.get('/api/debug/boards/:boardId/find', async (req, res) => {
  if (!config.debug) return res.status(404).json({ error: 'set DEBUG_MATTERMOST=true to enable' });
  try {
    const { board, cards, blocks } = await loadBoard(req.params.boardId, { fresh: true });
    const q = (req.query.title || '').trim().toLowerCase();
    // ?project=<optionId> — filter by the "Проект" property's raw value
    // instead of/in addition to title, so you can dump every card for one
    // client at once (e.g. all your test cards) rather than guessing titles.
    const projectFilter = (req.query.project || '').trim();
    const projectProp = findPropertyDef(board, config.projectPropertyName);

    let filtered = cards;
    if (q) filtered = filtered.filter((c) => (c.title || '').toLowerCase().includes(q));
    if (projectFilter && projectProp) {
      filtered = filtered.filter((c) => (c.properties || {})[projectProp.id] === projectFilter);
    }
    const matches = q || projectFilter ? filtered : cards.slice(0, 5);

    res.json({
      totalCardsFetched: cards.length, // if this is a round 200/400/600..., listCards() pagination likely hit the cap
      totalBlocksFetched: blocks.length, // 0 = the /blocks endpoint isn't returning anything on this server
      allProperties: (board.cardProperties || []).map((p) => ({ id: p.id, name: p.name, type: p.type })),
      approvalProp: findPropertyDef(board, config.approvalPropertyName),
      projectProp,
      matchCount: matches.length,
      // childBlocks: raw children of each matched card — this is what would
      // carry photo/video attachments (fields.fileId) if you attach one to
      // the card directly in Mattermost Boards. Use this to confirm the
      // real shape (type, fields.fileId, fields.mimeType) before trusting
      // that media actually shows up for the client.
      cards: matches.map((c) => ({
        id: c.id,
        title: c.title,
        properties: c.properties,
        childBlocks: blocks.filter((b) => b.parentId === c.id),
      })),
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Static frontend. Client link shape: /p/{boardId}?task={taskId}
// (boardId is the Mattermost Board/Project id — the whole "auth" for now is
// that this id is unguessable-enough and shared privately; see README for
// how to harden this if needed.)
// ---------------------------------------------------------------------------
const frontendDir = path.join(__dirname, '..', '..', 'frontend');
app.use(express.static(frontendDir));
app.get('/p/:boardId', (req, res) => res.sendFile(path.join(frontendDir, 'index.html')));

// GET /l/:token — the short, rotatable link actually handed out to clients
// now (see projectSettings.js). Serves the SAME cabinet page as /p/{boardId} —
// but crucially does NOT redirect. The page resolves the token into
// {boardId, projectId, name} itself via GET /api/links/:token right after
// load (see resolveLinkToken() in app.js) and keeps using it entirely in
// memory from then on. The address bar always stays on /l/{token}, nothing
// else is ever shown/copyable — this is what makes "Сгенерировать новую
// ссылку" an actual revoke. (An earlier version of this route did a 302
// redirect to /p/{boardId}?project=...&name=..., which the browser then
// displayed permanently — a redirect only hides the destination up to the
// first click, not after; switched away from that on purpose.)
app.get('/l/:token', (req, res) => res.sendFile(path.join(frontendDir, 'index.html')));

// GET /stat — access statistics page (tables + charts over the access_log
// data, see frontend/stat.html/js). Staff-gated like the rest of the internal
// pages; the data API behind it (/api/analytics/summary) is gated regardless.
app.get('/stat', requireStatAuth, (req, res) => res.sendFile(path.join(frontendDir, 'stat.html')));

// GET /ceo — owner-only dashboard (see teamAuth.requireCeoAuth). The HTML
// shell is sent only to an authenticated /team session whose Mattermost email
// is on config.ceoEmails; the data API (/api/ceo/overview) is gated the same
// way regardless, so even the shell holds no data.
app.get('/ceo', teamAuth.requireCeoAuth, (req, res) => res.sendFile(path.join(frontendDir, 'ceo.html')));

// GET /api/links/:token — resolves a rotatable client link (see above) into
// the {boardId, projectId, name, logoUrl} it currently points to. Returns
// 404 (JSON, not a redirect) when the token is unknown/revoked, so the
// frontend can show a clean "ссылка недействительна" message.
app.get('/api/links/:token', async (req, res) => {
  const resolved = await projectSettings.resolveToken(req.params.token);
  if (!resolved) {
    return res.status(404).json({
      error: 'link_not_found',
      message: 'Ссылка недействительна или была отозвана. Обратитесь к вашему менеджеру за новой ссылкой.',
    });
  }
  try {
    const [{ board }, settings] = await Promise.all([
      loadBoard(resolved.boardId),
      projectSettings.getSettings(resolved.boardId, resolved.projectId).catch(() => ({ logoUrl: '' })),
    ]);
    const projectProp = findPropertyDef(board, config.projectPropertyName);
    const name = optionLabelById(projectProp, resolved.projectId) || '';
    res.json({ boardId: resolved.boardId, projectId: resolved.projectId, name, logoUrl: settings.logoUrl || '' });
  } catch (err) {
    console.error('[api] /api/links/:token failed:', err.message);
    res.status(502).json({ error: 'mattermost_unavailable', message: err.message });
  }
});

// Internal staff page listing every client's cabinet link, in the same
// visual style as the client cabinet — see frontend/projects.html. Path is
// configurable (config.staffProjectsPath, default "/projects") specifically
// so it doesn't have to reveal anything (like a board id) in a fixed,
// guessable URL. NOT for clients: no board/task data, just the list of
// ready-made links (same info a staffer would otherwise hand-assemble from
// the "Проект" property options).
app.get(config.staffProjectsPath, staffAuth, (req, res) => res.sendFile(path.join(frontendDir, 'projects.html')));

// Team cabinet page (config.teamCabinetPath, default /team) — the page itself
// is static; team.js does its own login check against GET /api/team/me on
// load and shows either the login form or the task list. No staffAuth here —
// real per-person Mattermost login (see teamAuth.js) is the actual gate.
app.get(config.teamCabinetPath, (req, res) => res.sendFile(path.join(frontendDir, 'team.html')));

// "Забыли пароль" recovery for the staff Basic Auth above. Deliberately
// public (no staffAuth — that would be circular) but gated by a
// pre-approved email allowlist (STAFF_RECOVERY_EMAILS): only an address
// already on that list ever gets an email, and the response is IDENTICAL
// either way (generic "if this address is trusted, we sent it"), so the
// endpoint can't be used to probe which addresses are trusted. This app
// only has one shared staff password (not per-person accounts), so
// "recovery" here means emailing a reminder of the current password, not a
// reset flow — see mailer.js and frontend/forgot-password.html.
app.get('/forgot-password', (req, res) => res.sendFile(path.join(frontendDir, 'forgot-password.html')));

app.post('/api/staff/forgot-password', async (req, res) => {
  const genericOk = () =>
    res.json({ ok: true, message: 'Если этот адрес есть в списке доверенных — письмо с логином и паролем отправлено.' });

  if (!config.staffAuthUser || !config.staffAuthPassword) {
    return res.status(400).json({
      error: 'not_configured',
      message: 'HTTP Basic Auth для внутренней страницы сейчас не включён (STAFF_AUTH_USER/PASSWORD) — восстанавливать нечего.',
    });
  }
  if (tooManyForgotPasswordAttempts(req.ip)) {
    return res.status(429).json({ error: 'too_many_requests', message: 'Слишком много попыток, попробуйте позже.' });
  }
  const email = String((req.body && req.body.email) || '').trim().toLowerCase();
  if (!email || !config.staffRecoveryEmails.includes(email)) {
    return genericOk(); // no such address on the list — same response as success, on purpose
  }
  try {
    await mailer.sendMail({
      to: email,
      subject: 'Напоминание пароля — внутренняя страница проектов (КФ)',
      text: `Логин: ${config.staffAuthUser}\nПароль: ${config.staffAuthPassword}\n\nЭто письмо отправлено автоматически по запросу восстановления пароля.`,
    });
  } catch (err) {
    // Still return the generic success message to the caller — the failure
    // (e.g. SMTP not configured) is visible in the server log for staff to
    // fix, but shouldn't leak details to whoever submitted the form.
    console.error('[api] forgot-password mail send failed:', err.message);
  }
  return genericOk();
});

// On a brand-new deploy, the "db" container and this "app" container start
// at roughly the same time — docker-compose's plain `depends_on: [db]`
// (see docker-compose.yml) only orders CONTAINER START, not "Postgres is
// actually accepting connections yet" (that's what the healthcheck +
// `condition: service_healthy` there is for, but not every Compose runner
// necessarily honors it the same way). Without a retry here, a single
// unlucky first query during Postgres's own startup/initdb window would
// throw, initSchema() would never run again for the lifetime of this
// container, and every /api/projects* call would fail with "relation ...
// does not exist" until the next restart — this is exactly what happened
// once already. Retrying a few times with a short delay makes this
// self-healing instead of needing a manual restart every time.
async function waitForDb(maxAttempts = 15, delayMs = 2000) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await db.initSchema();
      return;
    } catch (err) {
      if (attempt === maxAttempts) throw err;
      console.warn(`[startup] database not ready yet (attempt ${attempt}/${maxAttempts}): ${err.message} — retrying in ${delayMs}ms`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

(async () => {
  try {
    await waitForDb();
    await teamAuth.restoreSessions();
    await analytics.pruneOldLogs();
    await projectSettings.importLegacyFileTokens();
  } catch (err) {
    console.error('[startup] database init failed — client links/logo/social-credentials editor will not work:', err.message);
  }
  app.listen(config.port, () => {
    console.log(`KF Approval listening on :${config.port}`);
    if (!config.mattermostUrl || !config.mattermostToken) {
      console.warn('[startup] MATTERMOST_URL/MATTERMOST_TOKEN not set — API calls will fail until configured.');
    }
    if (!config.databaseUrl) {
      console.warn('[startup] DATABASE_URL not set — client links/logo/social-credentials will not work until Postgres is configured.');
    }
  });
})();
