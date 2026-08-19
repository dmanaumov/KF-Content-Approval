// Persists the client's chosen display order of a post's media
// (photos/videos) in the approval card. Mattermost itself has no concept of
// a custom media order independent of upload time (see taskMapper.js's
// cardMedia, sorted by createAt) — this is the other place (besides
// projectSettings.js) this app keeps its own Postgres row for something that
// simply doesn't exist on the Mattermost side to write back into.
//
// Storage is a plain ordered array of media ids (see task_media_order in
// db.js) per (board, task). Ids not present in a stored order (media added
// after the client last reordered) are appended at the end, in their
// original order, rather than disappearing.

const db = require('./db');

async function getMediaOrder(boardId, taskId) {
  if (!db.pool) return null;
  const { rows } = await db.pool.query(
    'SELECT media_order FROM task_media_order WHERE board_id = $1 AND task_id = $2',
    [boardId, taskId]
  );
  return rows.length ? rows[0].media_order : null;
}

// Batch variant — one query for a whole task list (GET /api/boards/:boardId/tasks)
// instead of one per task.
async function getMediaOrders(boardId, taskIds) {
  if (!db.pool || !taskIds.length) return new Map();
  const { rows } = await db.pool.query(
    'SELECT task_id, media_order FROM task_media_order WHERE board_id = $1 AND task_id = ANY($2::text[])',
    [boardId, taskIds]
  );
  return new Map(rows.map((r) => [r.task_id, r.media_order]));
}

async function setMediaOrder(boardId, taskId, order) {
  const pool = db.requirePool();
  await pool.query(
    `INSERT INTO task_media_order (board_id, task_id, media_order, updated_at)
     VALUES ($1, $2, $3::jsonb, now())
     ON CONFLICT (board_id, task_id)
     DO UPDATE SET media_order = EXCLUDED.media_order, updated_at = now()`,
    [boardId, taskId, JSON.stringify(order)]
  );
}

// Reorders `media` (already in buildTasks()'s default order) per a
// previously stored id list.
function applyOrder(media, storedIds) {
  if (!storedIds || !storedIds.length) return media;
  const byId = new Map(media.map((m) => [m.id, m]));
  const ordered = [];
  for (const id of storedIds) {
    const m = byId.get(id);
    if (m) {
      ordered.push(m);
      byId.delete(id);
    }
  }
  for (const m of media) if (byId.has(m.id)) ordered.push(m);
  return ordered;
}

// Applies stored order to every task in `tasks` (mutates task.media in
// place) — call this on every path that returns tasks to the client.
// Best-effort: if Postgres isn't configured, tasks come back in default
// order, same as before this feature existed (matches loadBoard()'s
// listBlocks fallback in index.js — an optional extra degrading gracefully
// rather than breaking the whole list).
async function applyStoredOrder(boardId, tasks) {
  if (!db.pool || !tasks.length) return tasks;
  try {
    const orders = await getMediaOrders(boardId, tasks.map((t) => t.id));
    for (const t of tasks) {
      const stored = orders.get(t.id);
      if (stored) t.media = applyOrder(t.media, stored);
    }
  } catch (err) {
    console.warn('[mediaOrder] applyStoredOrder failed, showing default order:', err.message);
  }
  return tasks;
}

module.exports = { getMediaOrder, getMediaOrders, setMediaOrder, applyOrder, applyStoredOrder };
