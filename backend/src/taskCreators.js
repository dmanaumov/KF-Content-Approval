// Tracks which real team member created a given card via the /team
// cabinet's "Запланировать публикацию" button (POST /api/team/tasks).
//
// Why this exists instead of just reading Mattermost's own createdBy: this
// app authenticates to Mattermost as ONE shared service account (see
// mattermostClient.js — MATTERMOST_LOGIN_ID/PASSWORD or MATTERMOST_TOKEN)
// for every write it makes, including card creation. So block.createdBy on
// any card this app creates is always that shared account's id, never the
// id of the team member who actually clicked the button. This table is the
// only place that knows the real creator — see task_creators in db.js.
//
// Powers: "если ты создатель карточки — показывать её вне зависимости от
// того, назначена ли она на тебя" in GET /api/team/tasks (see index.js).

const db = require('./db');

// Best-effort — called right after a card already exists in Mattermost, so
// a failure here must never surface as a card-creation error. Worst case:
// the creator doesn't get the "I made this" visibility bonus, but they'll
// still see the card normally since POST /api/team/tasks always also makes
// them the assignee.
async function setCreator(boardId, taskId, creatorUserId) {
  if (!db.pool || !creatorUserId) return;
  try {
    await db.pool.query(
      `INSERT INTO task_creators (board_id, task_id, creator_user_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (board_id, task_id) DO NOTHING`,
      [boardId, taskId, String(creatorUserId)]
    );
  } catch (err) {
    console.warn('[taskCreators] setCreator failed (card still created fine):', err.message);
  }
}

// Batch variant — one query for a whole task list (GET /api/team/tasks)
// instead of one per task. Returns a Map(taskId -> creatorUserId).
async function getCreators(boardId, taskIds) {
  if (!db.pool || !taskIds.length) return new Map();
  try {
    const { rows } = await db.pool.query(
      'SELECT task_id, creator_user_id FROM task_creators WHERE board_id = $1 AND task_id = ANY($2::text[])',
      [boardId, taskIds]
    );
    return new Map(rows.map((r) => [r.task_id, r.creator_user_id]));
  } catch (err) {
    console.warn('[taskCreators] getCreators failed, creator-visibility bonus skipped this request:', err.message);
    return new Map();
  }
}

module.exports = { setCreator, getCreators };
