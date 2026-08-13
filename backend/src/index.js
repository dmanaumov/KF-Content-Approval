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
const cache = new Map(); // boardId -> { expires, board, blocks }

async function loadBoard(boardId, { fresh = false } = {}) {
  const cached = cache.get(boardId);
  if (!fresh && config.cacheTtlMs > 0 && cached && cached.expires > Date.now()) {
    return cached;
  }
  const [board, blocks] = await Promise.all([mm.getBoard(boardId), mm.listBlocks(boardId)]);
  const entry = { board, blocks, expires: Date.now() + config.cacheTtlMs };
  cache.set(boardId, entry);
  return entry;
}

function invalidate(boardId) {
  cache.delete(boardId);
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

// GET /api/boards/:boardId/tasks — everything the client cabinet needs.
app.get('/api/boards/:boardId/tasks', async (req, res) => {
  try {
    const { board, blocks } = await loadBoard(req.params.boardId);
    const { tasks, meta } = buildTasks(board, blocks);
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
  const { board: freshBoard, blocks } = await loadBoard(boardId, { fresh: true });
  const { tasks } = buildTasks(freshBoard, blocks);
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
