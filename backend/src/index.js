const express = require('express');
const path = require('path');
const config = require('./config');
const mm = require('./mattermostClient');
const { buildTasks, findPropertyDef, optionIdByLabel } = require('./taskMapper');

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
    const { tasks, meta } = buildTasks(board, cards, blocks, { projectFilter: req.query.project });
    if (meta.projectPropertyFound && !meta.projectFilterMatched) {
      return res.status(400).json({
        error: 'project_filter_required',
        message:
          'This board has a project property, and the link is missing a valid ?project= value — ' +
          'refusing to show tasks to avoid leaking other clients\' cards. Pass the project option id or exact label.',
      });
    }
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

// POST /api/boards/:boardId/tasks/:taskId/approve — idempotent.
app.post('/api/boards/:boardId/tasks/:taskId/approve', async (req, res) => {
  try {
    const updated = await setApprovalStatus(req.params.boardId, req.params.taskId, 'approved');
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
    await mm.addCardComment(boardId, taskId, comment);
    const updated = await setApprovalStatus(boardId, taskId, 'changes');
    res.json({ task: updated });
  } catch (err) {
    console.error('[api] feedback failed:', err.message);
    res.status(502).json({ error: 'feedback_failed', message: err.message });
  }
});

async function setApprovalStatus(boardId, taskId, statusKey) {
  const { board } = await loadBoard(boardId);
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
  await mm.patchCardProperty(boardId, taskId, approvalProp.id, optionId);
  invalidate(boardId);
  const { board: freshBoard, cards, blocks } = await loadBoard(boardId, { fresh: true });
  // skipProjectFilter: we already know the exact card id (client only ever
  // learns it from their own, already-filtered task list) — no need to
  // re-apply the project filter here, and doing so would break this lookup
  // on shared boards since we don't carry the client's `project` through.
  const { tasks } = buildTasks(freshBoard, cards, blocks, { skipProjectFilter: true });
  const updated = tasks.find((t) => t.id === taskId);
  if (!updated) throw new Error(`Card ${taskId} not found on board ${boardId} after update.`);
  return updated;
}

// GET /api/files/:fileId — proxies media bytes from Mattermost with Range
// support (needed for video playback, notably iPhone Safari).
app.get('/api/files/:fileId', async (req, res) => {
  try {
    const mmRes = await mm.fetchFileStream(req.params.fileId, req.headers.range);
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
    const { board, cards } = await loadBoard(req.params.boardId, { fresh: true });
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
      allProperties: (board.cardProperties || []).map((p) => ({ id: p.id, name: p.name, type: p.type })),
      approvalProp: findPropertyDef(board, config.approvalPropertyName),
      projectProp,
      matchCount: matches.length,
      cards: matches.map((c) => ({ id: c.id, title: c.title, properties: c.properties })),
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

app.listen(config.port, () => {
  console.log(`KF Approval listening on :${config.port}`);
  if (!config.mattermostUrl || !config.mattermostToken) {
    console.warn('[startup] MATTERMOST_URL/MATTERMOST_TOKEN not set — API calls will fail until configured.');
  }
});
