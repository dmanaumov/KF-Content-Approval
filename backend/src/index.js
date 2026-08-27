const express = require('express');
const path = require('path');
const crypto = require('crypto');
const fetch = require('node-fetch');
const multer = require('multer');
const config = require('./config');
const mm = require('./mattermostClient');
const { buildTasks, findPropertyDef, optionIdByLabel, optionLabelById } = require('./taskMapper');
const { parseAndValidateShareUrl, resolveKind, streamDiskFile } = require('./diskEmbeds');
const diskUpload = require('./diskUpload');
const db = require('./db');
const projectSettings = require('./projectSettings');
const mediaOrder = require('./mediaOrder');
const taskCreators = require('./taskCreators');
const teamComments = require('./teamComments');
const teamAuth = require('./teamAuth');
const mailer = require('./mailer');
const analytics = require('./analytics');
const { buildOpenApiSpec } = require('./openapiSpec');

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

// ---------------------------------------------------------------------------
// Automation API (n8n and similar) — gated by a single shared secret
// (config.automationApiKey, header "X-Api-Key") instead of a real staff
// Mattermost login, specifically so a vendor/developer building an
// automation flow never needs an actual team member's password. See the
// route group below (search "/api/automation/") and docs/N8N_AUTOMATION.md.
// ---------------------------------------------------------------------------
const AUTOMATION_ACTOR = 'автоматизация';

function requireAutomationAuth(req, res, next) {
  if (!config.automationApiKey) {
    return res.status(503).json({
      error: 'automation_api_disabled',
      message: 'AUTOMATION_API_KEY не задан — см. комментарий в config.js.',
    });
  }
  const provided = String(req.headers['x-api-key'] || '');
  const expected = config.automationApiKey;
  // Constant-time comparison so a wrong guess can't be narrowed down via
  // response-time differences. Buffers must match in length for
  // timingSafeEqual — a length mismatch is itself decisive, so short-
  // circuiting on it leaks nothing an attacker doesn't already know
  // (that their guess was wrong).
  const ok = provided.length === expected.length && crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
  if (!ok) {
    return res.status(401).json({ error: 'invalid_api_key' });
  }
  next();
}

// Google Docs API — a SECOND, independent integrator (see config.
// googleDocsApiKey / GOOGLE_DOCS_API_KEY). Same shape as requireAutomationAuth
// (constant-time comparison, 503 when unset), but its own header
// "X-Google-Docs-Key" and its own secret, so the Google-Docs flow gets its
// own credential that can be rotated/revoked without touching n8n's.
function requireGoogleDocsAuth(req, res, next) {
  if (!config.googleDocsApiKey) {
    return res.status(503).json({
      error: 'google_docs_api_disabled',
      message: 'GOOGLE_DOCS_API_KEY не задан — см. комментарий в config.js.',
    });
  }
  const provided = String(req.headers['x-google-docs-key'] || '');
  const expected = config.googleDocsApiKey;
  const ok = provided.length === expected.length && crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
  if (!ok) {
    return res.status(401).json({ error: 'invalid_google_docs_api_key' });
  }
  next();
}

// Small helper so automation route handlers can throw a validation error
// with both a machine-readable code and the right HTTP status, instead of
// every caller re-deriving status from err.code the way the rest of this
// file's write endpoints do.
function badRequest(code, message) {
  const err = new Error(message);
  err.code = code;
  err.httpStatus = 400;
  return err;
}

// Concurrency limiter for the two automation routes that push bytes to
// disk.kontentferma (media-upload, media-import) — added after a real
// incident (2026-08-25): n8n fired ~30 media-upload calls for only 7 cards
// within 1.5 seconds (looks like a retry/loop bug on the n8n side, worth
// fixing there too), and each upload is 2-3 sequential WebDAV/OCS round
// trips to Nextcloud — so that burst meant 40-90 simultaneous requests
// hitting disk.kontentferma at once, slow enough that several individual
// calls exceeded the timeout and got aborted (502 media_upload_failed).
// Regardless of what triggers a burst on the caller's side, OUR server
// shouldn't fail requests just because several arrived close together — so
// this queues anything beyond MEDIA_UPLOAD_MAX_CONCURRENT and runs it as
// soon as a slot frees up, instead of letting them all hit Nextcloud at
// once. Callers simply wait a little longer under a burst; nothing about
// the API's shape or response changes.
//
// Lowered from 4 to 2 after a second incident the same day: even at 4
// concurrent uploads (= up to 12 simultaneous WebDAV/OCS calls, since each
// upload is 3 sequential requests), Nextcloud's own bruteforce/rate-limit
// protection started answering createPublicShare() with 429 — and delaying
// that 429 by 20-28 seconds, characteristic of that protection's throttle —
// so most of a burst failed outright. 2 concurrent uploads (≤6 simultaneous
// WebDAV/OCS calls) plus the 429-retry in diskUpload.js (see
// fetchWithAuthRetry429) is the combination meant to stay under whatever
// threshold is triggering Nextcloud's throttle.
const MEDIA_UPLOAD_MAX_CONCURRENT = 2;
function createLimiter(maxConcurrent) {
  let active = 0;
  const queue = [];
  function runNext() {
    if (active >= maxConcurrent || queue.length === 0) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn().then(
      (value) => {
        active--;
        resolve(value);
        runNext();
      },
      (err) => {
        active--;
        reject(err);
        runNext();
      }
    );
  }
  return function withLimit(fn) {
    return new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      runNext();
    });
  };
}
const mediaUploadLimiter = createLimiter(MEDIA_UPLOAD_MAX_CONCURRENT);

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
    // Visibility rule (per the team's request, 2026-08-25):
    //   - лидеры / СЕО и его зам (role.admin — see config.js's own comment
    //     on adminEmails: "CEO + his deputy"; role.ceo folded in too for the
    //     /ceo-dashboard owner in case that email is ever only on ceoEmails)
    //     see EVERY card, same as before — the status-chip filter in the
    //     frontend still applies on top of this, unaffected.
    //   - everyone else sees a card if they're the assignee ("Исполнитель")
    //     OR if they're the one who created it via "Запланировать
    //     публикацию" — even when it's since been assigned to someone else.
    //     Creation is tracked in our own task_creators table, NOT
    //     Mattermost's block.createdBy (see taskCreators.js for why).
    const role = teamAuth.roleFor(req.teamSession.user);
    const seesAll = role.admin || role.ceo;
    let mine;
    if (seesAll) {
      mine = tasks;
    } else {
      const creatorMap = await taskCreators.getCreators(boardId, tasks.map((t) => t.id));
      mine = tasks.filter((t) => t.assigneeId === myId || creatorMap.get(t.id) === myId);
    }
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

// GET /api/team/projects — every "Проект" option (id+label), NOTHING else —
// powers the project dropdown in the "Запланировать публикацию" create-post
// form (frontend/team.js). Deliberately minimal compared to
// GET /api/automation/projects: no projectSettings enrichment (publish time,
// posts/month, manager, start date) and definitely no social_credentials —
// the team cabinet only ever needs to know which projects exist and what to
// call them in a <select>.
app.get('/api/team/projects', teamAuth.requireTeamAuth, async (req, res) => {
  const boardId = requireStaffBoardId(res);
  if (!boardId) return;
  try {
    const { board } = await loadBoard(boardId);
    const projectProp = findPropertyDef(board, config.projectPropertyName);
    if (!projectProp) {
      return res.status(500).json({
        error: 'project_property_not_found',
        message: `Свойство "${config.projectPropertyName}" не найдено на борде.`,
      });
    }
    const projects = (projectProp.options || []).map((o) => ({ id: o.id, label: o.value }));
    res.json({ projects });
  } catch (err) {
    console.error('[api] team projects failed:', err.message);
    res.status(502).json({ error: 'mattermost_unavailable', message: err.message });
  }
});

// POST /api/team/tasks — body: { title, network?, projectId, text?,
// publishDate?, status?, media?: string[] }. This is the "Запланировать
// публикацию" button in the team cabinet — creates a brand-new card from
// scratch (the team member didn't have a post yet, unlike every other
// /api/team/tasks/:taskId/* route above/below, which all edit an EXISTING
// one). Reuses createAutomationTask's Mattermost Blocks-API plumbing
// (confirmed live 2026-08-25, see its own comment for the id-reassignment
// gotcha it already works around) with two team-specific differences:
//   1. assigneeUserId is ALWAYS the creating team member — without this the
//      new card would silently never show up in their own cabinet, since
//      GET /api/team/tasks filters strictly by assigneeId === the logged-in
//      user's id (see that route above). A card created here with no
//      assignee would exist in Mattermost but look, from the team member's
//      own screen, like nothing happened.
//   2. actorLabel is the real team member's name (teamActorName), not
//      AUTOMATION_ACTOR — so the audit comment on the new card reads
//      "КАРТОЧКА СОЗДАНА (Имя Фамилия)", consistent with every other
//      audit comment this cabinet leaves (status/media/text changes, etc.).
app.post('/api/team/tasks', teamAuth.requireTeamAuth, async (req, res) => {
  const boardId = requireStaffBoardId(res);
  if (!boardId) return;
  try {
    const task = await createAutomationTask(boardId, {
      ...(req.body || {}),
      assigneeUserId: req.teamSession.user.id,
      actorLabel: teamActorName(req),
    });
    // Best-effort — see taskCreators.js. Never blocks the response: the
    // card already exists in Mattermost by this point regardless.
    await taskCreators.setCreator(boardId, task.id, req.teamSession.user.id);
    // task.caption comes from createAutomationTask's own fresh re-read after
    // creation — bytesSaved lets the caller confirm the post text actually
    // landed, same reasoning as the /text update routes below.
    res.status(201).json({ task, bytesSaved: Buffer.byteLength(task.caption || '', 'utf8') });
  } catch (err) {
    console.error('[api] team create task failed:', err.message);
    res.status(err.httpStatus || 502).json({ error: err.code || 'create_task_failed', message: err.message });
  }
});

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
    // updated.caption comes from a fresh re-read of the card (refetchTeamTask
    // inside updateTaskTextTeam), NOT an echo of the request body — so
    // bytesSaved genuinely confirms what Mattermost has right now, not just
    // what was sent. Added 2026-08-26: the response had no way to tell "did
    // this actually save" without eyeballing the whole caption.
    res.json({ task: updated, bytesSaved: Buffer.byteLength(updated.caption || '', 'utf8') });
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
  let proseBlockId;
  if (proseBlocks.length) {
    proseBlockId = proseBlocks[0].id;
    await mm.patchBlock(boardId, proseBlockId, { title: text });
    for (const extra of proseBlocks.slice(1)) {
      await mm.deleteBlock(boardId, extra.id);
    }
  } else {
    proseBlockId = `${nowMs.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    await mm.addBlocks(boardId, [
      {
        id: proseBlockId,
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

  // BUGFIX 2026-08-27 (reported live, card
  // https://messager.kontentferma.com/.../crc16ork6i3yo9ku8nayxom4xwy — was
  // created with empty opts.text, so createAutomationTask left
  // fields.contentOrder:[] on it, and the text added afterward via
  // POST .../text never got added to contentOrder either): runs on EVERY
  // save, not just when a brand-new block is created — a card can already
  // have a real, correctly-worded prose block that's simply missing from
  // contentOrder (exactly this bug, from an earlier /text call before this
  // fix existed), and the plain title-patch above does nothing to repair
  // that. This app's OWN caption reader (extractDescriptionText in
  // taskMapper.js) scans children by parentId regardless of contentOrder, so
  // GET .../tasks/:id's `caption` and bytesSaved both looked correct the
  // whole time — but Mattermost's OWN Boards UI renders ONLY blocks listed
  // in contentOrder (same rule already documented for createAutomationTask
  // above), so the post body showed up empty there. Self-healing: if the
  // prose block isn't in contentOrder yet, prepend it (leave already-correct
  // orders untouched — cheap no-op skip, and doesn't fight any manual
  // reordering staff did directly in Mattermost).
  const cardBlock = (blocks || []).find((b) => b.id === taskId && b.type === 'card');
  const existingOrder = cardBlock && cardBlock.fields && Array.isArray(cardBlock.fields.contentOrder) ? cardBlock.fields.contentOrder : [];
  if (!existingOrder.includes(proseBlockId)) {
    await mm.patchBlock(boardId, taskId, { updatedFields: { contentOrder: [proseBlockId, ...existingOrder] } });
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

// ---------------------------------------------------------------------------
// Automation API core (n8n and similar) — read + write helpers behind
// requireAutomationAuth (see its definition near requireStaffBoardId above).
// Deliberately separate from the /team functions above even where the
// underlying write is identical (addTeamMediaLink, updateTaskMediaOrderTeam
// are reused directly) — this whole section exists so an external flow only
// ever needs the automation API key, never a real staff Mattermost login.
// ---------------------------------------------------------------------------

// GET /api/automation/projects — every "Проект" option plus the scheduling
// fields already stored for it in Postgres (see projectSettings.js). NOT the
// same payload as the internal /api/projects (staffAuth) — this deliberately
// leaves out the client cabinet link token and logo, neither of which an
// automation needs, so this key can't be used to enumerate live client
// links. social_credentials is STILL left out of THIS response (bulk list of
// every project) — it's only ever returned one project at a time, and only
// by the dedicated endpoint below, never bundled into a listing call.
// isAiProject (added 2026-08-26) — the staff-set "ИИ-проект" checkbox from
// the edit popup (project_settings.is_ai_project), so an automation flow can
// filter to just the projects it should be generating content for instead of
// hardcoding project ids/names on its own side.
async function getAutomationProjects(boardId) {
  const { board } = await loadBoard(boardId);
  const projectProp = findPropertyDef(board, config.projectPropertyName);
  if (!projectProp) {
    throw badRequest('project_property_not_found', `Свойство "${config.projectPropertyName}" не найдено на борде.`);
  }
  return Promise.all(
    (projectProp.options || []).map(async (o) => {
      const settings = await projectSettings.getSettings(boardId, o.id);
      return {
        id: o.id,
        label: o.value,
        isAiProject: settings.isAiProject,
        publishTimeMsk: settings.publishTimeMsk,
        postsPerMonth: settings.postsPerMonth,
        projectManager: settings.projectManager,
        startDate: settings.startDate,
      };
    })
  );
}

// GET /api/automation/projects/:projectId/credentials — the ONE exception to
// "the automation API never hands out real secrets" above. Added 2026-08-25
// at Дмитрий's explicit request, to close the loop of the publishing flow
// entirely through this API instead of needing a second connection: 1) GET
// /api/automation/tasks — what's ready to publish; 2) THIS — the creds for
// that task's project; 3) POST .../publish — report back. Direct-Postgres
// access via the dedicated `n8n` role (docs/N8N_AUTOMATION.md §1) still
// works exactly as before and stays documented as an alternative — this is
// additive, not a replacement.
//
// Security tradeoff this accepts, spelled out because it's a real one: a
// leaked/compromised AUTOMATION_API_KEY can now read real IG/TG/VK/OK/MAX
// publishing credentials for any project on the board (one project per call,
// see below — never a bulk dump of every client at once). Before this
// endpoint, that key could only read/write task and project *metadata* —
// none of it a live credential. Treat AUTOMATION_API_KEY with the same care
// as any of the credentials it can now unlock (rotate it if the automation
// side is ever suspected compromised).
//
// One project's worth of credentials per call, never every project at once —
// so a single call can't be used to enumerate every client's secrets in one
// shot; the caller still has to already know (or separately look up via
// GET /api/automation/projects) which projectId it wants.
//
// `network` (optional, ?network=ig|tg|vk|ok|max) narrows further to ONE
// network's credential object — added 2026-08-25 at Дмитрий's request so a
// publisher that already knows which network it's about to post to doesn't
// have to pull every OTHER network's secret along with it on every single
// call (smaller payload, and each call now only ever carries the one secret
// actually needed for that publish). Omit it to get the full per-network map
// back, unchanged from before.
//
// NEVER logged: the /api/automation debug-response logger below explicitly
// skips this route (see isCredentialsRoute there) so turning DEBUG_MATTERMOST
// on for unrelated diagnosis never writes real secrets to stdout/logs.
async function getAutomationProjectCredentials(boardId, projectId, network) {
  const { board } = await loadBoard(boardId);
  const projectProp = findPropertyDef(board, config.projectPropertyName);
  if (!projectProp) {
    throw badRequest('project_property_not_found', `Свойство "${config.projectPropertyName}" не найдено на борде.`);
  }
  const id = String(projectId || '').trim();
  if (!id) {
    throw badRequest('project_id_required', 'projectId обязателен — id опции свойства "Проект" (см. GET /api/automation/projects).');
  }
  const projectOption = (projectProp.options || []).find((o) => o.id === id);
  if (!projectOption) {
    const available = (projectProp.options || []).map((o) => `${o.value} (${o.id})`).join(', ') || '(нет опций)';
    throw badRequest('project_not_found', `projectId "${id}" не найден в свойстве "Проект". Доступные: ${available}.`);
  }
  const net = String(network || '').trim().toLowerCase();
  if (net && !SOCIAL_LABELS[net]) {
    throw badRequest('invalid_network', `Неизвестная соцсеть "${network}". Доступные: ${Object.keys(SOCIAL_LABELS).join(', ')}.`);
  }
  const settings = await projectSettings.getSettings(boardId, id);
  // {} (not null/undefined) when nothing's been filled in yet — so the
  // caller can uniformly do `credentials[network]` without a null-check,
  // same convention socialCredentials already uses in projectSettings.js.
  const all = settings.socialCredentials || {};
  if (!net) return all;
  // Single-network shape: the object for that network directly (not nested
  // under its own key again — the caller already told us which network),
  // or null if that specific network just isn't configured for this
  // project yet (a normal, expected state — same "log and skip" case
  // docs/N8N_AUTOMATION.md §4.4c already describes for the bulk shape, NOT
  // an error on its own).
  return net in all ? all[net] : null;
}

// GET /api/automation/projects/:projectId/settings — the planning/profile
// side of a project's settings: isAiProject, projectManager, startDate,
// postsPerMonth, publishTimeMsk, and the four AI generation prompts
// (strategyPrompt/planningPrompt/postPrompt/imagePrompt — set by staff in
// the "ИИ настройки" tab of the /projects edit popup). Deliberately does
// NOT include socialCredentials (its own dedicated, one-project-at-a-time
// endpoint above — never bundled with anything else) or logoUrl/link token
// (staff-internal only, no automation ever needs them). Added 2026-08-26 so
// a content-generation automation can read a project's own prompts directly
// instead of hardcoding them — this is the ONLY place they're exposed
// outside the staff-only GET /api/projects/:projectId/settings.
async function getAutomationProjectSettings(boardId, projectId) {
  const { board } = await loadBoard(boardId);
  const projectProp = findPropertyDef(board, config.projectPropertyName);
  if (!projectProp) {
    throw badRequest('project_property_not_found', `Свойство "${config.projectPropertyName}" не найдено на борде.`);
  }
  const id = String(projectId || '').trim();
  if (!id) {
    throw badRequest('project_id_required', 'projectId обязателен — id опции свойства "Проект" (см. GET /api/automation/projects).');
  }
  const projectOption = (projectProp.options || []).find((o) => o.id === id);
  if (!projectOption) {
    const available = (projectProp.options || []).map((o) => `${o.value} (${o.id})`).join(', ') || '(нет опций)';
    throw badRequest('project_not_found', `projectId "${id}" не найден в свойстве "Проект". Доступные: ${available}.`);
  }
  const settings = await projectSettings.getSettings(boardId, id);
  return {
    isAiProject: settings.isAiProject,
    projectManager: settings.projectManager,
    startDate: settings.startDate,
    postsPerMonth: settings.postsPerMonth,
    publishTimeMsk: settings.publishTimeMsk,
    strategyPrompt: settings.strategyPrompt,
    planningPrompt: settings.planningPrompt,
    postPrompt: settings.postPrompt,
    imagePrompt: settings.imagePrompt,
  };
}

// GET /api/automation/tasks?project=<id>&status=<code|raw>&date=<YYYY-MM-DD|today>
// General-purpose task query — project is optional (omit for "across every
// client"), status is REQUIRED: either one of the 5 friendly codes this app
// already uses everywhere (waiting/changes/approved/published/archived) or
// the EXACT raw Mattermost option text, so an internal-only production stage
// ("В процессе", "ТЗ РАЙТЕРУ", ...) can be queried too, not just the 5
// client-facing ones. `date` is an optional extra narrowing (e.g.
// status=approved&date=today for "what's due to publish today" — the old
// /api/automation/tasks/today is exactly this call now).
//
// Every task comes back FULLY enriched regardless of which status was
// asked for, since different statuses need different fields and there's no
// reason to force a second request to get them:
//   - network (parsed from the title prefix, same rule as frontend/app.js's
//     detectSocial — see updateTaskNetwork above) + recommendedPublishTime
//     (project_settings.publish_time_msk) — for "ready to publish".
//   - clientComments (the full client correspondence timeline — approve/
//     правки/сообщения, see taskMapper.js) + feedback (latest correction
//     text) — already part of every task object, for "на редактировании".
// Media comes back kind-resolved and in the CLIENT-CHOSEN order
// (resolveDiskMediaKinds + mediaOrder.applyStoredOrder), exactly like every
// other read in this app — never read task_media_order directly yourself.
async function getAutomationTasks(boardId, { project, status, date } = {}) {
  if (!status) {
    throw badRequest(
      'status_required',
      `status обязателен — один из кодов (${Object.keys(config.statusOptionLabels).join('/')}) или точный текст статуса в Mattermost.`
    );
  }
  const { board, cards, blocks } = await loadBoard(boardId, { fresh: true });
  const feedbackAuthorUserId = await getFeedbackAuthorId();
  const opts = project
    ? { projectFilter: project, includeAllStatuses: true, feedbackAuthorUserId }
    : { skipProjectFilter: true, includeAllStatuses: true, feedbackAuthorUserId };
  const { tasks, meta } = buildTasks(board, cards, blocks, opts);
  if (project && !meta.projectFilterMatched) {
    throw badRequest('project_not_found', `project "${project}" не найден в свойстве "Проект".`);
  }

  // Friendly code (waiting/changes/approved/published/archived) matches by
  // the already-normalized t.status; anything else is treated as the exact
  // raw Mattermost option label (whitespace/case-insensitive, same
  // tolerance taskMapper.js's normLabel already applies everywhere else),
  // so internal-only stages that statusEnumFromLabel() maps to null are
  // still reachable here.
  const friendlyKey = Object.keys(config.statusOptionLabels).find((k) => k.toLowerCase() === String(status).trim().toLowerCase());
  const normLoose = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
  let matched = friendlyKey
    ? tasks.filter((t) => t.status === friendlyKey)
    : tasks.filter((t) => normLoose(t.statusLabel) === normLoose(status));

  if (date) {
    const resolvedDate =
      date === 'today' ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(new Date()) : date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(resolvedDate)) {
      throw badRequest('invalid_date', `Некорректная дата "${date}" — ожидался формат YYYY-MM-DD или "today".`);
    }
    matched = matched.filter((t) => t.publishDate === resolvedDate);
  }

  await resolveDiskMediaKinds(matched);
  await mediaOrder.applyStoredOrder(boardId, matched);

  const settingsCache = new Map();
  const result = [];
  for (const t of matched) {
    if (!settingsCache.has(t.projectId)) {
      settingsCache.set(t.projectId, await projectSettings.getSettings(boardId, t.projectId));
    }
    const settings = settingsCache.get(t.projectId);
    const networkMatch = String(t.title || '').match(SOCIAL_PREFIX_RE);
    result.push({
      ...t,
      network: networkMatch ? networkMatch[1].toLowerCase() : null,
      recommendedPublishTime: settings.publishTimeMsk || null,
    });
  }
  return result;
}

// GET /api/automation/tasks/:taskId — single-task lookup by id, same shape
// as one entry from getAutomationTasks above (network/recommendedPublishTime
// included) but without needing to already know the card's project/status/
// date to find it in a list. skipProjectFilter+includeAllStatuses so this
// can find a card in ANY internal production stage, not just the 5
// client-facing statuses — same reasoning as refetchTeamTask.
async function getAutomationTaskById(boardId, taskId) {
  const { board, cards, blocks } = await loadBoard(boardId, { fresh: true });
  const feedbackAuthorUserId = await getFeedbackAuthorId();
  const { tasks } = buildTasks(board, cards, blocks, { skipProjectFilter: true, includeAllStatuses: true, feedbackAuthorUserId });
  const task = tasks.find((t) => t.id === taskId);
  if (!task) {
    const err = new Error(`Карточка ${taskId} не найдена на борде.`);
    err.code = 'task_not_found';
    err.httpStatus = 404;
    throw err;
  }
  await resolveDiskMediaKinds([task]);
  await mediaOrder.applyStoredOrder(boardId, [task]);
  const settings = await projectSettings.getSettings(boardId, task.projectId);
  const networkMatch = String(task.title || '').match(SOCIAL_PREFIX_RE);
  return {
    ...task,
    network: networkMatch ? networkMatch[1].toLowerCase() : null,
    recommendedPublishTime: settings.publishTimeMsk || null,
  };
}

// POST /api/automation/tasks/:taskId/publish — flips a card to
// "ОПУБЛИКОВАНО" and records the live post URL, in ONE safe PATCH (merges
// into the card's FULL existing properties — see the big warning on
// patchCardProperty in mattermostClient.js and docs/N8N_AUTOMATION.md §5;
// this endpoint exists specifically so an external automation never has to
// get that merge right itself). Re-reads the card after writing and throws
// if the status didn't actually change, same caution as setStatusByRawLabel.
async function publishAutomationTask(boardId, taskId, url) {
  const trimmedUrl = String(url || '').trim();
  if (!trimmedUrl) throw badRequest('url_required', 'url обязателен — ссылка на реально опубликованный пост.');
  const { board, cards } = await loadBoard(boardId, { fresh: true });
  const approvalProp = findPropertyDef(board, config.approvalPropertyName);
  const urlProp = findPropertyDef(board, config.urlPropertyName);
  if (!approvalProp) throw badRequest('approval_property_not_found', `Свойство "${config.approvalPropertyName}" не найдено на борде.`);
  const publishedLabel = config.statusOptionLabels.published;
  const publishedOptionId = optionIdByLabel(approvalProp, publishedLabel);
  if (!publishedOptionId) {
    throw badRequest('published_option_not_found', `Опция "${publishedLabel}" не найдена в свойстве "${config.approvalPropertyName}".`);
  }
  const card = cards.find((c) => c.id === taskId);
  if (!card) throw badRequest('task_not_found', `Карточка ${taskId} не найдена.`);
  const mergedProperties = { ...(card.properties || {}), [approvalProp.id]: publishedOptionId };
  if (urlProp) mergedProperties[urlProp.id] = trimmedUrl;
  await mm.patchCardProperty(boardId, taskId, mergedProperties);
  await mm.addCardComment(boardId, taskId, `${formatMoscowTimestamp()} ОПУБЛИКОВАНО (${AUTOMATION_ACTOR}): ${trimmedUrl}`);
  invalidate(boardId);
  const updated = await refetchTeamTask(boardId, taskId);
  if (updated.status !== 'published') {
    throw new Error(
      `Mattermost принял запрос, но после повторного чтения карточки ${taskId} статус остался "${updated.statusLabel || '(нет)'}", ` +
        `а не "${publishedLabel}". Проверьте права аккаунта, от имени которого работает приложение.`
    );
  }
  return updated;
}

// Creates a brand-new task card — for content-generation automations that
// produce the post from scratch, as opposed to attaching media to a card
// staff already created (addTeamMediaLink above covers that case). Also the
// engine behind the team cabinet's "Запланировать публикацию" button (see
// POST /api/team/tasks above), which passes assigneeUserId/actorLabel —
// everything else about card creation is identical between the two callers.
// CONFIRMED against the live server 2026-08-25 (see the id-reassignment
// comment further down — Mattermost Boards doesn't honor client-supplied
// block ids, this already works around that).
//
// opts.assigneeUserId (optional, Mattermost user id): if given, sets the
// "Исполнитель" property to this user — the ONLY caller that needs this
// today is POST /api/team/tasks, which always passes the creating team
// member's own id (otherwise the new card wouldn't show up in THEIR OWN
// "my tasks" list — see that route's comment). Automation callers never
// pass this; a card created without it just has no assignee, same as
// before this parameter existed.
// opts.actorLabel (optional, defaults to AUTOMATION_ACTOR): whose name goes
// in the "КАРТОЧКА СОЗДАНА (...)" audit comment — the real team member's
// name for team-created cards, AUTOMATION_ACTOR for everything else.
async function createAutomationTask(boardId, opts) {
  const { board } = await loadBoard(boardId, { fresh: true });
  const approvalProp = findPropertyDef(board, config.approvalPropertyName);
  const projectProp = findPropertyDef(board, config.projectPropertyName);
  const publishDateProp = findPropertyDef(board, config.publishDatePropertyName);
  const assigneeProp = findPropertyDef(board, config.assigneePropertyName);
  const keywordsProp = findPropertyDef(board, config.keywordsPropertyName);

  const title = String(opts.title || '').trim();
  if (!title) throw badRequest('title_required', 'title обязателен.');

  const network = String(opts.network || '').trim().toLowerCase();
  if (network && !SOCIAL_LABELS[network]) {
    throw badRequest('invalid_network', `Неизвестная соцсеть "${opts.network}". Доступные: ${Object.keys(SOCIAL_LABELS).join(', ')}.`);
  }

  if (!projectProp) throw badRequest('project_property_not_found', `Свойство "${config.projectPropertyName}" не найдено на борде.`);
  const projectId = String(opts.projectId || '').trim();
  if (!projectId) throw badRequest('project_id_required', 'projectId обязателен — id опции свойства "Проект" (см. GET /api/automation/projects).');
  const projectOption = (projectProp.options || []).find((o) => o.id === projectId);
  if (!projectOption) {
    const available = (projectProp.options || []).map((o) => `${o.value} (${o.id})`).join(', ') || '(нет опций)';
    throw badRequest('project_not_found', `projectId "${projectId}" не найден в свойстве "Проект". Доступные: ${available}.`);
  }

  let statusOptionId = null;
  if (opts.status) {
    if (!approvalProp) throw badRequest('approval_property_not_found', `Свойство "${config.approvalPropertyName}" не найдено на борде.`);
    statusOptionId = optionIdByLabel(approvalProp, opts.status);
    if (!statusOptionId) {
      const available = (approvalProp.options || []).map((o) => `«${o.value}»`).join(', ') || '(нет опций)';
      throw badRequest('status_not_found', `Статус "${opts.status}" не найден. Доступные: ${available}.`);
    }
  }

  let publishDateValue = null;
  if (opts.publishDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.publishDate)) {
      throw badRequest('invalid_publish_date', `Некорректная дата "${opts.publishDate}" — ожидался формат YYYY-MM-DD.`);
    }
    if (!publishDateProp) throw badRequest('publish_date_property_not_found', `Свойство "${config.publishDatePropertyName}" не найдено на борде.`);
    publishDateValue = JSON.stringify({ from: Date.parse(`${opts.publishDate}T00:00:00.000Z`) });
  }

  const mediaUrls = Array.isArray(opts.media) ? opts.media.map((u) => String(u || '').trim()).filter(Boolean) : [];
  const validatedMedia = [];
  for (const raw of mediaUrls) {
    const validated = parseAndValidateShareUrl(raw);
    if (!validated) throw badRequest('invalid_media_url', `"${raw}" не похоже на ссылку с disk.kontentferma.`);
    validatedMedia.push(validated);
  }

  const nowMs = Date.now();
  const genId = (offset) => `${(nowMs + offset).toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const cardId = genId(0);
  const descId = genId(1);
  const text = String(opts.text || '').trim();

  const properties = {};
  properties[projectProp.id] = projectId;
  if (statusOptionId) properties[approvalProp.id] = statusOptionId;
  if (publishDateValue) properties[publishDateProp.id] = publishDateValue;
  // Best-effort: an automation caller never sends assigneeUserId, and even
  // for a team-cabinet caller a misconfigured/renamed "Исполнитель" property
  // shouldn't block card creation outright — the card just comes back
  // unassigned (team member won't see it in "my tasks" until fixed, but
  // nothing is lost/duplicated, and every other property still gets set).
  if (opts.assigneeUserId && assigneeProp) {
    properties[assigneeProp.id] = String(opts.assigneeUserId);
  }
  // opts.keywords (optional, free text): "Ключевые слова/мысли" — the ONLY
  // place a post's topic/brief/keywords live in Mattermost (see taskMapper.js
  // — this property is NOT the post text/body, see the `text` var below for
  // that). Best-effort, same reasoning as assigneeProp above — a missing/
  // renamed property shouldn't block card creation, just skip setting it.
  if (opts.keywords != null && keywordsProp) {
    properties[keywordsProp.id] = String(opts.keywords);
  }

  const fullTitle = network ? `${network}: ${title}` : title;

  const blocks = [
    {
      id: cardId,
      boardId,
      parentId: boardId,
      type: 'card',
      title: fullTitle,
      schema: 1,
      createAt: nowMs,
      updateAt: nowMs,
      fields: { properties, contentOrder: text ? [descId] : [], icon: '', isTemplate: false },
    },
  ];
  if (text) {
    blocks.push({
      id: descId, boardId, parentId: cardId, type: 'text', title: text,
      schema: 1, createAt: nowMs + 1, updateAt: nowMs + 1, fields: {},
    });
  }
  validatedMedia.forEach((shareUrl, i) => {
    blocks.push({
      id: genId(2 + i), boardId, parentId: cardId, type: 'text', title: shareUrl,
      schema: 1, createAt: nowMs + 2 + i, updateAt: nowMs + 2 + i, fields: {},
    });
  });

  // ROOT CAUSE (confirmed live, 2026-08-25): Mattermost Boards does NOT
  // honor the client-supplied block id on insert — it reassigns its own
  // server-generated id to every block, including the card itself. This
  // app's OWN addCardComment already relies on the server's returned id
  // (it never re-looks-up its own comment by id afterward, so the mismatch
  // was invisible there) — createAutomationTask is the first place that
  // needs to look a just-created block back up, and doing that with the
  // locally-generated `cardId` was the actual bug: it doesn't exist in
  // Mattermost under that id, so the reread always failed. Fix: read the
  // real id back out of addBlocks' own response instead of trusting cardId.
  const createResult = await mm.addBlocks(boardId, blocks, 'createAutomationTask');
  const createdBlocks = Array.isArray(createResult) ? createResult : [];
  const createdCard = createdBlocks.find((b) => b.type === 'card');
  if (!createdCard) {
    // Response didn't come back in the shape we expect — surface exactly
    // what Mattermost sent instead of silently falling back to a
    // definitely-wrong id, so this is diagnosable from the error alone.
    throw new Error(
      `Mattermost принял запрос на создание карточки, но в ответе не нашлось блока с type:"card" — ` +
        `получено: ${JSON.stringify(createResult).slice(0, 1000)}. Обратитесь за диагностикой.`
    );
  }
  const actualCardId = createdCard.id;

  await mm.addCardComment(boardId, actualCardId, `${formatMoscowTimestamp()} КАРТОЧКА СОЗДАНА (${opts.actorLabel || AUTOMATION_ACTOR})`);
  invalidate(boardId);

  // Small retry margin kept as a safety net for genuine read-after-write
  // lag on top of the id fix above — cheap, and harmless if unneeded.
  const REREAD_DELAYS_MS = [400, 800, 1600];
  let created = null;
  for (const delayMs of REREAD_DELAYS_MS) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    invalidate(boardId);
    created = await refetchTeamTask(boardId, actualCardId).catch(() => null);
    if (created) break;
  }
  if (!created) {
    throw new Error(
      `Карточка ${actualCardId} создана в Mattermost (запрос прошёл без ошибки), но не нашлась при повторном чтении ` +
        `борда даже после нескольких попыток — проверьте карточку в Mattermost вручную (она может существовать) и ` +
        `НЕ повторяйте запрос на всякий случай, это создаст дубликат. Сообщите об этой ошибке для диагностики.`
    );
  }
  return created;
}

// Temporary-but-safe request/response logging for the whole /api/automation/*
// surface — gated behind the SAME DEBUG_MATTERMOST flag already used for the
// low-level Mattermost-call dump (see asJsonOrThrow in mattermostClient.js),
// so turning debug on shows both "what did n8n send/get" (this) and "what
// did Mattermost itself say" (that) in one place. NEVER logs the API key
// (headers aren't logged at all) or raw file bytes (multipart bodies are
// logged as a placeholder, not their content). Meant to be temporary —
// turn DEBUG_MATTERMOST back off once done diagnosing.
//
// isCredentialsRoute: the ONE route on this surface that returns real
// third-party secrets (see getAutomationProjectCredentials above) — its
// response body is deliberately NEVER logged here, request or response,
// regardless of config.debug, so flipping DEBUG_MATTERMOST on for an
// unrelated media/task issue can't accidentally write live IG/TG/VK/OK/MAX
// credentials to stdout/container logs.
app.use('/api/automation', (req, res, next) => {
  const isCredentialsRoute = /\/projects\/[^/]+\/credentials$/.test(req.path);
  if (!config.debug || isCredentialsRoute) return next();
  const startedAt = Date.now();
  const isMultipart = String(req.headers['content-type'] || '').startsWith('multipart/form-data');
  console.log(
    `[automation:debug] → ${req.method} ${req.originalUrl}` +
      (isMultipart ? ' (multipart body, не логируется)' : ` body=${JSON.stringify(req.body || {}).slice(0, 2000)}`)
  );
  const originalJson = res.json.bind(res);
  res.json = (body) => {
    console.log(
      `[automation:debug] ← ${req.method} ${req.originalUrl} status=${res.statusCode} (${Date.now() - startedAt}мс) body=${JSON.stringify(body).slice(0, 3000)}`
    );
    return originalJson(body);
  };
  next();
});

// GET /api/automation/projects
app.get('/api/automation/projects', requireAutomationAuth, async (req, res) => {
  const boardId = requireStaffBoardId(res);
  if (!boardId) return;
  try {
    const projects = await getAutomationProjects(boardId);
    res.json({ projects });
  } catch (err) {
    console.error('[api] automation projects failed:', err.message);
    res.status(err.httpStatus || 502).json({ error: err.code || 'automation_projects_failed', message: err.message });
  }
});

// GET /api/automation/projects/:projectId/credentials?network=<ig|tg|vk|ok|max>
// — real publishing credentials for ONE project, see
// getAutomationProjectCredentials above for the security tradeoff this
// accepts (deliberate, per Дмитрий 2026-08-25) and why the debug logger
// above skips this route on purpose.
//
// Without ?network — response unchanged from before:
//   { projectId, credentials: {"ig": {...}, "tg": {...}, "vk": {...}, "ok": {...}, "max": {...}} }
// only whichever networks actually have something filled in via the staff
// "Редактировать" popup; a network with nothing set simply isn't a key (not
// an empty {} under it), so callers can do `if (credentials.ig)`.
//
// WITH ?network — added 2026-08-25 so a caller that already knows which
// network it's about to publish to doesn't have to receive every other
// network's secret on every call:
//   { projectId, network, credentials: {...} | null }
// `credentials` here is that ONE network's object directly (not nested
// under an `ig`/`tg`/... key again), or `null` if that project simply
// doesn't have that network configured yet (a normal, expected state — see
// docs/N8N_AUTOMATION.md §4.4c — not an error on its own).
app.get('/api/automation/projects/:projectId/credentials', requireAutomationAuth, async (req, res) => {
  const boardId = requireStaffBoardId(res);
  if (!boardId) return;
  const network = req.query.network != null ? String(req.query.network).trim() : '';
  try {
    const credentials = await getAutomationProjectCredentials(boardId, req.params.projectId, network);
    const payload = { projectId: req.params.projectId, credentials };
    if (network) payload.network = network.toLowerCase();
    res.json(payload);
  } catch (err) {
    // Deliberately NOT logging err in a way that could ever include
    // credentials — err here only ever carries badRequest()'s validation
    // messages (bad/missing projectId, unknown network), never the
    // credentials themselves, but keep it that way if this catch block is
    // ever touched again.
    console.error('[api] automation project credentials failed:', err.message);
    res.status(err.httpStatus || 502).json({ error: err.code || 'automation_credentials_failed', message: err.message });
  }
});

// GET /api/automation/projects/:projectId/settings — see
// getAutomationProjectSettings above for exactly what's in/out of this
// response (prompts + planning fields, no credentials, no logo/link token).
app.get('/api/automation/projects/:projectId/settings', requireAutomationAuth, async (req, res) => {
  const boardId = requireStaffBoardId(res);
  if (!boardId) return;
  try {
    const settings = await getAutomationProjectSettings(boardId, req.params.projectId);
    res.json({ projectId: req.params.projectId, ...settings });
  } catch (err) {
    console.error('[api] automation project settings failed:', err.message);
    res.status(err.httpStatus || 502).json({ error: err.code || 'automation_settings_failed', message: err.message });
  }
});

// GET /api/automation/tasks?project=<id>&status=<code|raw>&date=<YYYY-MM-DD|today>
// status is required — see getAutomationTasks above for the two shapes it
// accepts. project and date are both optional narrowing.
app.get('/api/automation/tasks', requireAutomationAuth, async (req, res) => {
  const boardId = requireStaffBoardId(res);
  if (!boardId) return;
  const project = String(req.query.project || '').trim() || null;
  const status = String(req.query.status || '').trim() || null;
  const date = String(req.query.date || '').trim() || null;
  try {
    const tasks = await getAutomationTasks(boardId, { project, status, date });
    res.json({ tasks });
  } catch (err) {
    console.error('[api] automation tasks query failed:', err.message);
    res.status(err.httpStatus || 502).json({ error: err.code || 'automation_tasks_failed', message: err.message });
  }
});

// POST /api/automation/tasks — body: { title, network?, projectId, text?,
// keywords?, publishDate?, status?, media?: string[] }. See
// createAutomationTask above. `title` is the post's TOPIC/headline (with the
// optional `network` prefix — ig/tg/vk/ok/max — added to it automatically);
// `text` is the actual post BODY (goes into card content, see "КРИТИЧЕСКИ
// ВАЖНО" in project notes / GET /api/automation/tasks/:taskId's `caption`
// field below); `keywords` is the free-text brief/keywords property
// ("Ключевые слова/мысли" in Mattermost) — a separate field from both, never
// shown to clients, meant for internal planning notes; `media` is an array
// of already-existing disk.kontentferma share URLs (use media-upload/
// media-import below to attach a NEW file instead).
app.post('/api/automation/tasks', requireAutomationAuth, async (req, res) => {
  const boardId = requireStaffBoardId(res);
  if (!boardId) return;
  try {
    const task = await createAutomationTask(boardId, req.body || {});
    // See POST /api/automation/tasks/:taskId/text below for why this is a
    // fresh-read byte count, not an echo of req.body.text.
    res.status(201).json({ task, bytesSaved: Buffer.byteLength(task.caption || '', 'utf8') });
  } catch (err) {
    console.error('[api] automation create task failed:', err.message);
    res.status(err.httpStatus || 502).json({ error: err.code || 'create_task_failed', message: err.message });
  }
});

// GET /api/automation/tasks/:taskId — one task by id, in its CURRENT full
// composition: title (topic/headline, with any network prefix), caption
// (the actual post BODY — card content, see "КРИТИЧЕСКИ ВАЖНО" in project
// notes), keywords (the separate "Ключевые слова/мысли" brief property),
// media (every attached photo/video/disk-link, in the client's chosen
// order), status/statusLabel, publishDate, projectId/projectLabel, url
// (the live post link once published), plus network/recommendedPublishTime
// like the list endpoint above adds. Added so an automation doesn't have to
// pull the WHOLE list (GET /api/automation/tasks?status=...) just to look up
// one card it already knows the id of — e.g. right after creating it, or
// before deciding whether to update it.
app.get('/api/automation/tasks/:taskId', requireAutomationAuth, async (req, res) => {
  const boardId = requireStaffBoardId(res);
  if (!boardId) return;
  try {
    const task = await getAutomationTaskById(boardId, req.params.taskId);
    res.json({ task });
  } catch (err) {
    console.error('[api] automation get task failed:', err.message);
    res.status(err.httpStatus || (err.code === 'task_not_found' ? 404 : 502)).json({ error: err.code || 'task_lookup_failed', message: err.message });
  }
});

// POST /api/automation/tasks/:taskId/text — body: { text }. Rewrites the
// post BODY (card content — see "КРИТИЧЕСКИ ВАЖНО" in project notes; this is
// what GET .../tasks returns as `caption`) on an EXISTING card. Reuses the
// exact same function the /team cabinet's own text editor uses
// (updateTaskTextTeam) — no "flip to changes"/client-facing marker comment,
// just a plain "ТЕКСТ ОБНОВЛЁН (автоматизация)" audit note, same as team
// edits. This does NOT touch `title` (the topic/headline) or `keywords` (the
// separate brief property) — use POST /api/automation/tasks/:taskId/keywords
// for that, or PATCH the title via Mattermost directly if it ever needs to
// change (no automation route for that today, ask if you need one).
app.post('/api/automation/tasks/:taskId/text', requireAutomationAuth, async (req, res) => {
  const boardId = requireStaffBoardId(res);
  if (!boardId) return;
  const text = String((req.body && req.body.text) || '').replace(/\r\n/g, '\n');
  if (!text.trim()) return res.status(400).json({ error: 'text_required' });
  try {
    const updated = await updateTaskTextTeam(boardId, req.params.taskId, text, AUTOMATION_ACTOR);
    // bytesSaved = UTF-8 byte length of updated.caption, which comes from a
    // FRESH re-read of the card after the write (see updateTaskTextTeam →
    // refetchTeamTask) — not an echo of req.body.text. So this genuinely
    // confirms what Mattermost is holding right now, including catching a
    // silent truncation/mismatch (compare it to Buffer.byteLength(text,
    // 'utf8') on your side — if they differ, the save did NOT go through as
    // sent). Added 2026-08-26 per developer request — the response gave no
    // way to verify a save actually stuck without diffing the whole caption.
    res.json({ task: updated, bytesSaved: Buffer.byteLength(updated.caption || '', 'utf8') });
  } catch (err) {
    console.error('[api] automation text update failed:', err.message);
    res.status(502).json({ error: 'text_update_failed', message: err.message });
  }
});

// POST /api/automation/tasks/:taskId/keywords — body: { text }. Rewrites the
// "Ключевые слова/мысли" property on an EXISTING card — the free-text
// topic/keywords/brief field (see createAutomationTask's opts.keywords doc
// above for how this differs from `text`/post body and `title`/headline).
// Team-only concept, never shown to clients, so no marker comment is left
// (mirrors POST /api/team/tasks/:taskId/keywords exactly, just behind the
// automation API key instead of a team login).
app.post('/api/automation/tasks/:taskId/keywords', requireAutomationAuth, async (req, res) => {
  const boardId = requireStaffBoardId(res);
  if (!boardId) return;
  const text = String((req.body && req.body.text) || '');
  try {
    const updated = await updateTaskKeywords(boardId, req.params.taskId, text);
    res.json({ task: updated });
  } catch (err) {
    console.error('[api] automation keywords update failed:', err.message);
    res.status(502).json({ error: 'keywords_update_failed', message: err.message });
  }
});

// POST /api/automation/tasks/:taskId/status — body: { status: <raw label> }.
// Moves an EXISTING card to ANY option of the "Статус" property — NOT just
// the 5 client-facing ones (statusOptionLabels), same as the team cabinet's
// own status control. Added 2026-08-26 for the exact gap the automation
// developer asked about: a card generated in one internal stage (e.g.
// "В процессе") needs to be moved to "На согласование" (or any other stage)
// once generation/review is done — this is a DIFFERENT thing from
// POST .../text (post body) and POST .../publish (the one-way "ОПУБЛИКОВАНО"
// + URL flip below) — use THIS route for any other status transition.
// Reuses setStatusByRawLabel — same function POST /api/team/tasks/:taskId/status
// calls — which leaves a "СТАТУС ИЗМЕНЁН (...)" audit comment and re-reads
// the card afterward to confirm the write actually stuck.
app.post('/api/automation/tasks/:taskId/status', requireAutomationAuth, async (req, res) => {
  const boardId = requireStaffBoardId(res);
  if (!boardId) return;
  const status = String((req.body && req.body.status) || '').trim();
  if (!status) return res.status(400).json({ error: 'status_required', message: 'status обязателен — точный текст опции свойства "Статус" в Mattermost.' });
  try {
    const updated = await setStatusByRawLabel(boardId, req.params.taskId, status, AUTOMATION_ACTOR);
    res.json({ task: updated });
  } catch (err) {
    console.error('[api] automation status update failed:', err.message);
    res.status(502).json({ error: 'status_update_failed', message: err.message });
  }
});

// POST /api/automation/tasks/:taskId/media-link — body: { url }. Same as the
// /team route of the same shape, just behind the automation API key.
app.post('/api/automation/tasks/:taskId/media-link', requireAutomationAuth, async (req, res) => {
  const boardId = requireStaffBoardId(res);
  if (!boardId) return;
  const shareUrl = parseAndValidateShareUrl(String((req.body && req.body.url) || '').trim());
  if (!shareUrl) {
    return res.status(400).json({ error: 'invalid_disk_url', message: 'Это не похоже на ссылку с disk.kontentferma.' });
  }
  try {
    const task = await addTeamMediaLink(boardId, req.params.taskId, shareUrl, AUTOMATION_ACTOR);
    res.json({ task });
  } catch (err) {
    console.error('[api] automation media link add failed:', err.message);
    res.status(502).json({ error: 'media_link_failed', message: err.message });
  }
});

// POST /api/automation/tasks/:taskId/media-upload — multipart, field "file".
// Same WebDAV-upload-then-attach flow as the /team route; needs
// DISK_WEBDAV_* configured (see config.js) exactly like that one does.
app.post('/api/automation/tasks/:taskId/media-upload', requireAutomationAuth, (req, res) => {
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
      // Queued behind mediaUploadLimiter — see its definition above for why
      // (n8n bursts, Nextcloud under concurrent load).
      await mediaUploadLimiter(async () => {
        const { board, cards, blocks } = await loadBoard(boardId, { fresh: true });
        const feedbackAuthorUserId = await getFeedbackAuthorId();
        const { tasks } = buildTasks(board, cards, blocks, { skipProjectFilter: true, includeAllStatuses: true, feedbackAuthorUserId });
        const task = tasks.find((t) => t.id === req.params.taskId);
        if (!task) {
          res.status(404).json({ error: 'task_not_found' });
          return;
        }
        const dateStr = task.publishDate || new Date().toISOString().slice(0, 10);
        const extMatch = String(req.file.originalname || '').match(/\.[a-zA-Z0-9]+$/);
        const filename = `${dateStr}_${Date.now().toString(36)}${extMatch ? extMatch[0] : ''}`;
        const shareUrl = await diskUpload.uploadAndShare({
          folderName: task.projectLabel || 'Без клиента',
          filename,
          buffer: req.file.buffer,
          mimeType: req.file.mimetype,
        });
        const updated = await addTeamMediaLink(boardId, req.params.taskId, shareUrl, AUTOMATION_ACTOR);
        res.json({ task: updated });
      });
    } catch (err) {
      console.error('[api] automation media upload failed:', err.message);
      const status = err.code === 'disk_upload_not_configured' ? 501 : 502;
      res.status(status).json({ error: err.code || 'media_upload_failed', message: err.message });
    }
  });
});

// Server-side fetch backing POST /api/automation/tasks/:taskId/media-import
// (below). Downloads an arbitrary external URL (e.g. a CDN link an n8n flow
// received from the social network) and returns its bytes so the route can
// push them into disk.kontentferma exactly like a manual media-upload would.
// This exists so n8n never has to construct multipart/form-data itself — it
// sends { url } as plain JSON and the SERVER does the downloading instead.
//
// IMPORTANT LIMITATION — this is a plain, unauthenticated HTTP(S) GET. It
// works for genuinely public URLs (e.g. a signed/expiring CDN link) but
// CANNOT fetch anything that requires a logged-in session, cookies, or a
// bearer token that only n8n/the client holds — there is no way for this
// server to present those credentials on the source's behalf. If the
// upstream needs auth it will answer 401/403 (or sometimes redirect to a
// login page), and this function fails loudly with `media_fetch_failed` /
// `upstreamStatus` set — it NEVER silently succeeds with a wrong/empty file.
// The caller (n8n) sees that in the API response and should fall back to
// media-upload (download the bytes itself, where it may already hold the
// right session/cookies, and push them here as multipart) for that link.
const MEDIA_IMPORT_MAX_BYTES = 80 * 1024 * 1024; // same ceiling as media-upload
const MEDIA_IMPORT_TIMEOUT_MS = 20000;

function isBlockedImportHost(hostname) {
  // Best-effort SSRF guard for literal private/loopback/link-local hosts —
  // not a full DNS-resolution check (a public hostname that RESOLVES to a
  // private IP slips through, same tradeoff most simple "fetch this URL"
  // endpoints make). Good enough given this endpoint is gated by the
  // automation API key, not open to the public internet.
  const h = String(hostname || '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h === '::1' || h === '0.0.0.0') return true;
  if (/^127\./.test(h)) return true;
  if (/^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (/^169\.254\./.test(h)) return true;
  return false;
}

async function fetchExternalMediaBuffer(rawUrl) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl || ''));
  } catch {
    const err = new Error('Некорректный URL.');
    err.code = 'invalid_url';
    err.httpStatus = 400;
    throw err;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    const err = new Error('Поддерживаются только http/https ссылки.');
    err.code = 'invalid_url';
    err.httpStatus = 400;
    throw err;
  }
  if (isBlockedImportHost(parsed.hostname)) {
    const err = new Error('Этот хост недоступен для импорта.');
    err.code = 'invalid_url';
    err.httpStatus = 400;
    throw err;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MEDIA_IMPORT_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(parsed.toString(), {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'KF-Content-Approval-media-import/1.0' },
    });
  } catch (fetchErr) {
    clearTimeout(timer);
    if (fetchErr.name === 'AbortError') {
      const err = new Error(`Файл не скачался за ${MEDIA_IMPORT_TIMEOUT_MS / 1000} сек — источник не ответил вовремя.`);
      err.code = 'media_fetch_timeout';
      err.httpStatus = 504;
      throw err;
    }
    const err = new Error(`Не удалось подключиться к источнику файла: ${fetchErr.message}`);
    err.code = 'media_fetch_failed';
    err.httpStatus = 502;
    throw err;
  }
  clearTimeout(timer);

  if (!response.ok) {
    const authIssue = response.status === 401 || response.status === 403;
    const err = new Error(
      authIssue
        ? `Источник вернул ${response.status} — похоже, файл доступен только авторизованной сессии, и сервер скачать его так не может. Используйте media-upload вместо media-import для этой ссылки.`
        : `Источник вернул ${response.status} при скачивании файла.`
    );
    err.code = 'media_fetch_failed';
    err.httpStatus = 502;
    err.upstreamStatus = response.status;
    throw err;
  }

  const contentLengthHeader = response.headers.get('content-length');
  if (contentLengthHeader && Number(contentLengthHeader) > MEDIA_IMPORT_MAX_BYTES) {
    const err = new Error(`Файл слишком большой (${contentLengthHeader} байт, максимум ${MEDIA_IMPORT_MAX_BYTES}).`);
    err.code = 'media_too_large';
    err.httpStatus = 413;
    throw err;
  }

  const buffer = await response.buffer();
  if (buffer.length > MEDIA_IMPORT_MAX_BYTES) {
    const err = new Error(`Файл слишком большой (${buffer.length} байт, максимум ${MEDIA_IMPORT_MAX_BYTES}).`);
    err.code = 'media_too_large';
    err.httpStatus = 413;
    throw err;
  }
  if (!buffer.length) {
    const err = new Error('Источник вернул пустой файл.');
    err.code = 'media_fetch_failed';
    err.httpStatus = 502;
    throw err;
  }

  const mimeType = (response.headers.get('content-type') || '').split(';')[0].trim() || 'application/octet-stream';
  return { buffer, mimeType };
}

// POST /api/automation/tasks/:taskId/media-import — body: { url }. Server
// downloads `url` itself (see fetchExternalMediaBuffer above) and pushes the
// bytes to disk.kontentferma exactly like media-upload does — n8n sends
// plain JSON, no multipart/form-data required. Use this instead of
// media-upload when file transport through n8n (formData/multipart) is the
// problem, not the file's availability.
//
// FAILURE BEHAVIOR: fetchExternalMediaBuffer throws BEFORE anything is
// written to disk.kontentferma or attached to the card, so any error here —
// timeout, non-2xx from the source (401/403 = auth-gated, 404 = gone, etc.),
// or oversize — leaves the task exactly as it was. Nothing partial is ever
// attached. The JSON error response always includes `error` (a stable code
// to branch on in n8n) and, for upstream HTTP failures, `upstreamStatus`
// (the source's own status code) so the caller can tell "source needs a
// login" (401/403) apart from "source URL is just wrong/expired" (404) apart
// from "our server timed out talking to the source" (504/media_fetch_timeout)
// — and decide whether to retry, fall back to media-upload, or alert a human.
app.post('/api/automation/tasks/:taskId/media-import', requireAutomationAuth, async (req, res) => {
  const boardId = requireStaffBoardId(res);
  if (!boardId) return;
  const sourceUrl = String((req.body && req.body.url) || '').trim();
  if (!sourceUrl) return res.status(400).json({ error: 'url_required' });
  try {
    // Queued behind mediaUploadLimiter — same reasoning as media-upload above
    // (n8n bursts, Nextcloud under concurrent load); media-import ends in the
    // exact same uploadAndShare() call against disk.kontentferma.
    await mediaUploadLimiter(async () => {
      const { board, cards, blocks } = await loadBoard(boardId, { fresh: true });
      const feedbackAuthorUserId = await getFeedbackAuthorId();
      const { tasks } = buildTasks(board, cards, blocks, { skipProjectFilter: true, includeAllStatuses: true, feedbackAuthorUserId });
      const task = tasks.find((t) => t.id === req.params.taskId);
      if (!task) {
        res.status(404).json({ error: 'task_not_found' });
        return;
      }

      const { buffer, mimeType } = await fetchExternalMediaBuffer(sourceUrl);

      const dateStr = task.publishDate || new Date().toISOString().slice(0, 10);
      const extFromUrl = (() => {
        try {
          const m = new URL(sourceUrl).pathname.match(/\.[a-zA-Z0-9]{2,5}$/);
          return m ? m[0] : '';
        } catch {
          return '';
        }
      })();
      const filename = `${dateStr}_${Date.now().toString(36)}${extFromUrl}`;

      const shareUrl = await diskUpload.uploadAndShare({
        folderName: task.projectLabel || 'Без клиента',
        filename,
        buffer,
        mimeType,
      });
      const updated = await addTeamMediaLink(boardId, req.params.taskId, shareUrl, AUTOMATION_ACTOR);
      res.json({ task: updated });
    });
  } catch (err) {
    console.error('[api] automation media import failed:', err.message);
    const status = err.httpStatus || (err.code === 'disk_upload_not_configured' ? 501 : 502);
    const payload = { error: err.code || 'media_import_failed', message: err.message };
    if (err.upstreamStatus) payload.upstreamStatus = err.upstreamStatus;
    res.status(status).json(payload);
  }
});

// POST /api/automation/tasks/:taskId/media-order — body: { order: string[] }.
app.post('/api/automation/tasks/:taskId/media-order', requireAutomationAuth, async (req, res) => {
  const boardId = requireStaffBoardId(res);
  if (!boardId) return;
  const order = Array.isArray(req.body && req.body.order) ? req.body.order.map(String) : null;
  if (!order || !order.length) return res.status(400).json({ error: 'order_required' });
  try {
    const updated = await updateTaskMediaOrderTeam(boardId, req.params.taskId, order, AUTOMATION_ACTOR);
    res.json({ task: updated });
  } catch (err) {
    console.error('[api] automation media order update failed:', err.message);
    const status = err.code === 'stale_media_order' ? 409 : 502;
    res.status(status).json({ error: err.code || 'media_order_failed', message: err.message });
  }
});

// POST /api/automation/tasks/:taskId/publish — body: { url }.
app.post('/api/automation/tasks/:taskId/publish', requireAutomationAuth, async (req, res) => {
  const boardId = requireStaffBoardId(res);
  if (!boardId) return;
  try {
    const task = await publishAutomationTask(boardId, req.params.taskId, req.body && req.body.url);
    res.json({ task });
  } catch (err) {
    console.error('[api] automation publish failed:', err.message);
    res.status(err.httpStatus || 502).json({ error: err.code || 'publish_failed', message: err.message });
  }
});

// POST /api/google-docs/tasks/:taskId/client-message — добавить комментарий
// в «Чат с клиентом» по карточке, под ОТДЕЛЬНЫМ ключом GOOGLE_DOCS_API_KEY
// (header "X-Google-Docs-Key", см. requireGoogleDocsAuth) — свой секрет для
// Google-Docs-интеграции, отдельно от n8n/AUTOMATION_API_KEY.
// Переиспользуем sendClientMessage (маркер «СООБЩЕНИЕ», kind 'agency') — то
// есть текст появляется в чате как сообщение Агентства, статус не трогаем,
// в Mattermost идёт только комментарий.
// body: { text } — обязателен; необязательный imageUrl — готовая ссылка
// disk.kontentferma (картинка прикрепится к сообщению и отобразится как
// превью).
app.post('/api/google-docs/tasks/:taskId/client-message', requireGoogleDocsAuth, async (req, res) => {
  const boardId = requireStaffBoardId(res);
  if (!boardId) return;
  const body = req.body || {};
  const text = String(body.text || '').trim();
  const imageUrl = String(body.imageUrl || '').trim();
  if (!text && !imageUrl) {
    return res.status(400).json({ error: 'message_required', message: 'Укажите text (или imageUrl).' });
  }
  try {
    const task = await sendClientMessage(boardId, req.params.taskId, text, 'Google Docs', imageUrl);
    res.json({ task });
  } catch (err) {
    console.error('[api] google-docs client-message failed:', err.message);
    res.status(502).json({ error: 'client_message_failed', message: err.message });
  }
});

// POST /api/google-docs/tasks/:taskId/title — править человеко-читаемый
// заголовок карточки (под ключом Google Docs). Переиспользуем updateTaskTitle:
// префикс соцсети (ig:/tg:/...) сохраняется отдельно.
// body: { title } — новый заголовок без префикса соцсети, обязателен.
app.post('/api/google-docs/tasks/:taskId/title', requireGoogleDocsAuth, async (req, res) => {
  const boardId = requireStaffBoardId(res);
  if (!boardId) return;
  const title = String((req.body && req.body.title) || '').trim();
  if (!title) {
    return res.status(400).json({ error: 'title_required', message: 'Укажите title.' });
  }
  try {
    const task = await updateTaskTitle(boardId, req.params.taskId, title, 'Google Docs');
    res.json({ task });
  } catch (err) {
    console.error('[api] google-docs title failed:', err.message);
    res.status(502).json({ error: 'title_failed', message: err.message });
  }
});

// POST /api/google-docs/tasks/:taskId/date — поставить «Дедлайн (публикация)»
// (= поле «Окончание работ») карточки (под ключом Google Docs). Переиспользуем
// updateTaskDate: пишет {"from": epochMs} в config.publishDatePropertyName.
// body: { date: 'YYYY-MM-DD' } — обязателен.
app.post('/api/google-docs/tasks/:taskId/date', requireGoogleDocsAuth, async (req, res) => {
  const boardId = requireStaffBoardId(res);
  if (!boardId) return;
  const dateStr = String((req.body && req.body.date) || '').trim();
  if (!dateStr) {
    return res.status(400).json({ error: 'date_required', message: 'Укажите date (YYYY-MM-DD).' });
  }
  try {
    const task = await updateTaskDate(boardId, req.params.taskId, dateStr);
    res.json({ task });
  } catch (err) {
    console.error('[api] google-docs date failed:', err.message);
    res.status(502).json({ error: 'date_failed', message: err.message });
  }
});

// POST /api/google-docs/tasks — СОЗДАТЬ карточку через Google-Docs API и сразу
// поставить «Дедлайн (публикация)» (= поле «Окончание работ»). Это отдельный
// вход для Google-Docs-интеграции (свой ключ GOOGLE_DOCS_API_KEY, header
// X-Google-Docs-Key); переиспользуем createAutomationTask, поэтому принимаем
// те же поля: { title, network?, projectId, date?, text?, status?, ... }.
// "date" (YYYY-MM-DD) — это дедлайн/окончание работ; кладётся в publishDate
// при создании одним запросом (не нужен отдельный вызов /date).
app.post('/api/google-docs/tasks', requireGoogleDocsAuth, async (req, res) => {
  const boardId = requireStaffBoardId(res);
  if (!boardId) return;
  const body = req.body ? { ...(req.body || {}) } : {};
  if (body.date && !body.publishDate) body.publishDate = body.date;
  try {
    const task = await createAutomationTask(boardId, { ...body, actorLabel: 'Google Docs' });
    res.status(201).json({ task });
  } catch (err) {
    console.error('[api] google-docs create task failed:', err.message);
    res.status(err.httpStatus || 502).json({ error: err.code || 'create_task_failed', message: err.message });
  }
});

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

// GET /api/ceo/openapi.json + GET /ceo/api-docs — Swagger/OpenAPI
// description of the automation API (see backend/src/openapiSpec.js),
// gated the same way as /ceo above — real /team login + email on
// config.ceoEmails. This describes ENDPOINTS AND SHAPES, not secrets (the
// automation API key itself is never in this document, only the header
// name it's expected under) — CEO-only anyway because it's a map of every
// write this app's automation surface can make, not something to leave
// world-readable.
app.get('/api/ceo/openapi.json', teamAuth.requireCeoAuth, (req, res) => {
  res.json(buildOpenApiSpec());
});

function sendSwaggerUiPage(req, res) {
  res.type('html').send(`<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>КФ — API для автоматизации</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css">
<style>body{margin:0}</style>
</head>
<body>
<div id="swagger-ui"></div>
<script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
<script>
  window.ui = SwaggerUIBundle({
    url: '/api/ceo/openapi.json',
    dom_id: '#swagger-ui',
    presets: [SwaggerUIBundle.presets.apis],
    layout: 'BaseLayout',
  });
</script>
</body>
</html>`);
}

app.get('/ceo/api-docs', teamAuth.requireCeoAuth, sendSwaggerUiPage);

// GET /swagger — shorter alias for /ceo/api-docs (added 2026-08-27, by
// request — easier to remember/share than the /ceo-prefixed path). Same
// handler, same gate (real /team login + email on config.ceoEmails) — this
// is still a map of every write the automation API can make, not something
// to leave world-readable just because the URL got friendlier.
app.get('/swagger', teamAuth.requireCeoAuth, sendSwaggerUiPage);

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
