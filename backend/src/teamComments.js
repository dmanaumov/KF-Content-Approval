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
    `SELECT id, author_id, author_name, text, image_url, created_at
     FROM task_team_comments
     WHERE board_id = $1 AND task_id = $2
     ORDER BY created_at ASC`,
    [boardId, taskId]
  );
  return rows.map(rowToComment);
}

// imageUrl: optional disk.kontentferma share link for a photo attached to
// this message (uploaded via diskUpload.js, see index.js's chat-upload
// route) — a message can be text-only, image-only, or both.
async function addComment(boardId, taskId, author, text, imageUrl) {
  const pool = db.requirePool();
  const { rows } = await pool.query(
    `INSERT INTO task_team_comments (board_id, task_id, author_id, author_name, text, image_url)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, author_id, author_name, text, image_url, created_at`,
    [boardId, taskId, (author && author.id) || '', (author && author.name) || '', text || '', imageUrl || '']
  );
  return rowToComment(rows[0]);
}

function rowToComment(r) {
  return {
    id: String(r.id),
    authorId: r.author_id,
    authorName: r.author_name,
    text: r.text,
    imageUrl: r.image_url || '',
    createdAt: r.created_at,
  };
}

// --- «Цербер» feedback (cerberus_feedback, see its comment in db.js) -------
//
// Added 2026-10-02 for the automation API (GET/POST /api/automation/
// cerberus-feedback in index.js) — the user is building the actual rating
// UI in a separate portal (my.kontentferma.com), not in this app, so these
// two functions are the whole surface it needs: one to list every «Цербер»
// remark this board has ever recorded (rated or not — the caller wants the
// FULL list, to go rate the ones that aren't yet), one to add/update a
// rating on one of them.

// Every task_team_comments row written "от лица" Цербер, across the WHOLE
// board — deliberately not scoped to one task/project here; the caller
// (index.js route) cross-references each row's taskId against a fresh
// buildTasks() to attach project/post context, since task_team_comments
// itself has no notion of "project" (see db.js comment on cerberus_feedback
// for why that's resolved live rather than stored).
async function listAllCerberusComments(boardId) {
  if (!db.pool) return [];
  const { rows } = await db.pool.query(
    `SELECT c.id, c.task_id, c.text, c.created_at,
            f.rating, f.note, f.rated_by_user_id, f.rated_by_name, f.rated_at
       FROM task_team_comments c
       LEFT JOIN cerberus_feedback f ON f.comment_id = c.id
      WHERE c.board_id = $1 AND c.author_id = 'cerberus'
      ORDER BY c.created_at ASC`,
    [boardId]
  );
  return rows.map((r) => ({
    commentId: String(r.id),
    taskId: r.task_id,
    text: r.text,
    createdAt: r.created_at,
    rating: r.rating || null,
    note: r.note || '',
    ratedByUserId: r.rated_by_user_id || '',
    ratedByName: r.rated_by_name || '',
    ratedAt: r.rated_at || null,
  }));
}

// Adds or replaces the rating on ONE «Цербер» remark. Rejects a commentId
// that doesn't exist, isn't on this board, or (critically) wasn't actually
// authored by «Цербер» — a human team-chat message can't be "rated" this
// way, that would corrupt the fine-tuning dataset with unrelated rows.
// `ratedBy` is whatever identity the CALLER wants recorded (my-portal has
// its own user accounts, not this app's) — both fields are free text, not
// validated against anything here.
async function setCerberusFeedback(boardId, commentId, rating, note, ratedBy) {
  const pool = db.requirePool();
  const { rows: commentRows } = await pool.query(
    `SELECT id, task_id FROM task_team_comments WHERE id = $1 AND board_id = $2 AND author_id = 'cerberus'`,
    [commentId, boardId]
  );
  if (!commentRows.length) {
    throw new Error(`Замечание Цербера с id=${commentId} не найдено на этом борде.`);
  }
  const { rows } = await pool.query(
    `INSERT INTO cerberus_feedback (comment_id, board_id, rating, note, rated_by_user_id, rated_by_name, rated_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (comment_id) DO UPDATE SET
       rating = EXCLUDED.rating, note = EXCLUDED.note,
       rated_by_user_id = EXCLUDED.rated_by_user_id, rated_by_name = EXCLUDED.rated_by_name,
       rated_at = now()
     RETURNING comment_id, rating, note, rated_by_user_id, rated_by_name, rated_at`,
    [commentId, boardId, rating, note || '', (ratedBy && ratedBy.id) || '', (ratedBy && ratedBy.name) || '']
  );
  const row = rows[0];
  return {
    commentId: String(row.comment_id),
    taskId: commentRows[0].task_id,
    rating: row.rating,
    note: row.note || '',
    ratedByUserId: row.rated_by_user_id || '',
    ratedByName: row.rated_by_name || '',
    ratedAt: row.rated_at,
  };
}

module.exports = { listComments, addComment, listAllCerberusComments, setCerberusFeedback };
