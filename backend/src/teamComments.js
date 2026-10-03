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

// LEFT JOIN cerberus_feedback — большинство строк (человеческие сообщения)
// просто получат rating=null (у них никогда не может быть строки в
// cerberus_feedback, см. setCerberusFeedback: туда пишут только для
// author_id='cerberus'). Нужно, чтобы вкладка «Команда» (frontend/team.js)
// могла показать специалисту, как уже оценено замечание Цербера — и дать
// кнопки «Согласен/Отчасти/Не согласен» прямо под ним (добавлено
// 2026-10-03, см. комментарий у POST .../cerberus-feedback в index.js).
async function listComments(boardId, taskId) {
  if (!db.pool) return [];
  const { rows } = await db.pool.query(
    `SELECT c.id, c.author_id, c.author_name, c.text, c.image_url, c.created_at,
            f.rating, f.note AS feedback_note, f.rated_by_name, f.rated_at
       FROM task_team_comments c
       LEFT JOIN cerberus_feedback f ON f.comment_id = c.id
      WHERE c.board_id = $1 AND c.task_id = $2
      ORDER BY c.created_at ASC`,
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
    // null для обычных сообщений команды — заполнено только у замечаний
    // Цербера (author_id='cerberus'), и только после того, как кто-то
    // нажал «Согласен/Отчасти/Не согласен» (см. выше).
    cerberusRating: r.rating || null,
    cerberusNote: r.feedback_note || '',
    cerberusRatedByName: r.rated_by_name || '',
    cerberusRatedAt: r.rated_at || null,
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

// --- «Где сработал Цербер» badge (frontend/team.js task list + calendar) --
//
// Added 2026-10-02 per direct request: "сейчас ищу посты где работал
// цербер, но не могу их вычленить в общем объеме... добавим пиктограмку-
// значок как в админке [projects.js's .cerberus-badge, "Защищено Цербером"]
// на посты, где была сработка цербера". Two shapes on purpose: the LIST
// (GET /api/team/tasks) needs every task_id with a remark in ONE query, the
// single-task refetch after a write (refetchTeamTask in index.js) only
// needs a yes/no for the one card it already has — no reason to pull the
// whole board's list just to answer that.

// Every distinct task_id with at least one «Цербер» remark on this board.
async function listCerberusTaskIds(boardId) {
  if (!db.pool) return [];
  const { rows } = await db.pool.query(
    `SELECT DISTINCT task_id FROM task_team_comments WHERE board_id = $1 AND author_id = 'cerberus'`,
    [boardId]
  );
  return rows.map((r) => r.task_id);
}

// Yes/no for ONE card — cheap indexed lookup (task_team_comments is indexed
// on (board_id, task_id), see db.js), used where pulling the whole board's
// list would be wasteful.
async function hasCerberusComment(boardId, taskId) {
  if (!db.pool) return false;
  const { rows } = await db.pool.query(
    `SELECT 1 FROM task_team_comments WHERE board_id = $1 AND task_id = $2 AND author_id = 'cerberus' LIMIT 1`,
    [boardId, taskId]
  );
  return rows.length > 0;
}

// --- «Пропускать при дальнейшей обработке» (API-флаг для n8n) -------------
//
// Добавлено 2026-10-03 по запросу: "если [специалист] не согласен [с
// замечанием Цербера], то при дальнейшей обработке цербера мы пропускаем
// этот пост". Пользователь явно попросил ТОЛЬКО отдать признак через API —
// саму логику "что значит пропустить" и когда её проверять решает сценарий
// n8n на его стороне, этот код не знает и не обязан знать, когда и как
// часто Цербер перепроверяет карточки.
//
// Признак = "есть хотя бы одно замечание Цербера на этой карточке с
// rating='bad'" (rating='bad' — это и есть «не согласен», см. кнопки в
// frontend/team.js и ШКАЛА в kf-cerberus-feedback-api.md, без отдельного
// булева поля — проще, и совпадает с уже существующей трёхвариантной
// шкалой good/partial/bad). Та же пара форм, что и у «сработал Цербер»
// выше: list — для GET /api/automation/tasks (одним запросом на весь
// список), has — для GET /api/automation/tasks/:taskId (одна карточка).

// Все task_id на этом борде, где хоть одно замечание Цербера оценено как
// 'bad' — то есть команда с ним не согласна.
async function listCerberusSkipTaskIds(boardId) {
  if (!db.pool) return [];
  const { rows } = await db.pool.query(
    `SELECT DISTINCT c.task_id
       FROM task_team_comments c
       JOIN cerberus_feedback f ON f.comment_id = c.id
      WHERE c.board_id = $1 AND c.author_id = 'cerberus' AND f.rating = 'bad'`,
    [boardId]
  );
  return rows.map((r) => r.task_id);
}

// Да/нет для ОДНОЙ карточки — см. hasCerberusComment выше, тот же принцип.
async function hasCerberusDisagree(boardId, taskId) {
  if (!db.pool) return false;
  const { rows } = await db.pool.query(
    `SELECT 1
       FROM task_team_comments c
       JOIN cerberus_feedback f ON f.comment_id = c.id
      WHERE c.board_id = $1 AND c.task_id = $2 AND c.author_id = 'cerberus' AND f.rating = 'bad'
      LIMIT 1`,
    [boardId, taskId]
  );
  return rows.length > 0;
}

module.exports = {
  listComments,
  addComment,
  listAllCerberusComments,
  setCerberusFeedback,
  listCerberusTaskIds,
  hasCerberusComment,
  listCerberusSkipTaskIds,
  hasCerberusDisagree,
};
