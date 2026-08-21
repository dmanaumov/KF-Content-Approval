// Internal team discussion on a post (kabinet komandy — see frontend/team.js
// "Команда" tab). Stored in our own Postgres table (task_team_comments, see
// db.js), NOT as Mattermost card comments — those are reserved for the
// client-feedback convention taskMapper.js/index.js already rely on
// (feedbackAuthorUsername + status==='changes'), so mixing team chatter in
// would both leak into that client-facing surface and make "which comment
// is client feedback" ambiguous.
//
// Best-effort like mediaOrder.js: if Postgres isn't configured, listComments
// returns [] and addComment throws (surfaced to the UI as "недоступно"),
// rather than the whole team cabinet failing to load.

const db = require('./db');

async function listComments(boardId, taskId) {
  if (!db.pool) return [];
  const { rows } = await db.pool.query(
    `SELECT id, author_id, author_name, text, created_at
     FROM task_team_comments
     WHERE board_id = $1 AND task_id = $2
     ORDER BY created_at ASC`,
    [boardId, taskId]
  );
  return rows.map(rowToComment);
}

async function addComment(boardId, taskId, author, text) {
  const pool = db.requirePool();
  const { rows } = await pool.query(
    `INSERT INTO task_team_comments (board_id, task_id, author_id, author_name, text)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, author_id, author_name, text, created_at`,
    [boardId, taskId, (author && author.id) || '', (author && author.name) || '', text]
  );
  return rowToComment(rows[0]);
}

function rowToComment(r) {
  return {
    id: String(r.id),
    authorId: r.author_id,
    authorName: r.author_name,
    text: r.text,
    createdAt: r.created_at,
  };
}

module.exports = { listComments, addComment };
