const express = require('express');
const path = require('path');
const config = require('./config');
const mm = require('./mattermostClient');
const { buildTasks, findPropertyDef, optionIdByLabel, optionLabelById } = require('./taskMapper');
const { parseAndValidateShareUrl, resolveKind, streamDiskFile } = require('./diskEmbeds');
const db = require('./db');
const projectSettings = require('./projectSettings');
const mailer = require('./mailer');

const app = express();
app.use(express.json());

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
  const jobs = [];
  for (const t of tasks) {
    for (const m of t.media) {
      if (m.source === 'disk' && m.kind === null) {
        jobs.push(
          resolveKind(m.shareUrl).then((info) => {
            m.kind = info.kind;
            if (info.name) m.name = info.name;
          })
        );
      }
    }
  }
  if (jobs.length) await Promise.all(jobs);
  return tasks;
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

// Optional HTTP Basic Auth gate for the internal staff page + its
// /api/projects* API (see config.staffAuthUser/staffAuthPassword). A no-op
// middleware when unset, so behavior is unchanged unless you opt in — see
// .env.example for why this is now recommended (real publishing credentials
// live behind this page, not just non-secret share links).
function staffAuth(req, res, next) {
  if (!config.staffAuthUser || !config.staffAuthPassword) return next();
  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme === 'Basic' && encoded) {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const sep = decoded.indexOf(':');
    const user = sep >= 0 ? decoded.slice(0, sep) : decoded;
    const pass = sep >= 0 ? decoded.slice(sep + 1) : '';
    if (user === config.staffAuthUser && pass === config.staffAuthPassword) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="KF staff"');
  // The browser's native Basic Auth prompt covers this body until the user
  // cancels it — at that point this is what they see, so it's worth a link
  // rather than a bare "Authentication required."
  res.status(401).type('html').send(`<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Нужен вход</title></head>
<body style="font-family:system-ui,sans-serif;max-width:420px;margin:15vh auto 0;padding:0 20px;text-align:center;color:#222">
<h3>Нужны логин и пароль</h3>
<p>Если вы их не помните — <a href="/forgot-password">восстановите доступ по почте</a>.</p>
</body></html>`);
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
    const options = await Promise.all(
      (projectProp.options || []).map(async (o) => {
        // Rotatable short link + logo URL — see projectSettings.js. Row is
        // created lazily on first read, so every project already has a
        // working link (and, once set, a logo) the first time this list
        // loads.
        const { token, logoUrl } = await projectSettings.getTokenAndLogo(boardId, o.id);
        return { id: o.id, label: o.value, token, logoUrl };
      })
    );
    res.json({ mattermostWebUrl: config.mattermostWebUrl, options });
  } catch (err) {
    console.error('[api] GET projects failed:', err.message);
    res.status(502).json({ error: 'mattermost_unavailable', message: err.message });
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
// credentials, for the staff "Редактировать" popup (frontend/projects.js).
// Returned as-is (not masked) — this is already the staff-only page (see
// staffAuth above); the popup needs to show existing values to edit them.
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

// PUT /api/projects/:projectId/settings — saves logo URL + social
// credentials from the edit popup. Body: { logoUrl: string, socialCredentials:
// { ig?, tg?, vk?, ok?, max? } } — each network's value is a free-form JSON
// object; this app never reads it, it's stored purely so the n8n publishing
// automation can read it directly from Postgres (see docs/N8N_AUTOMATION.md).
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
  return updated;
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
// pasted into "Текст поста" or "URL"), so the client sees the material
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
    for (const h of ['content-type', 'content-length', 'accept-ranges', 'content-range', 'cache-control']) {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    if (!res.hasHeader('accept-ranges')) res.setHeader('Accept-Ranges', 'bytes');
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
