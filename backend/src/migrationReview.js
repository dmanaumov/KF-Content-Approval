// ВРЕМЕННЫЙ модуль на время проверки переноса задач с Mattermost на
// Postgres (решение 2026-10-15, см. claude/kf-mattermost-to-postgres-
// migration.md) — хранит подтверждение/замечание КАЖДОГО проекта о том,
// что его план публикаций переехал корректно. Один ряд на проект
// (project_migration_review, db.js) — новое подтверждение/замечание просто
// перезаписывает предыдущее, т.к. нажать может любой сотрудник с доступом
// к проекту (не голосование, см. POST /api/team/migration-review в
// index.js). Можно удалить целиком вместе с этой таблицей, роутами
// /api/team/migration-*, подсветкой карточек в team.js/team.css и баннером
// в team.html после закрытия проверки.
const db = require('./db');

async function getAll(boardId) {
  if (!db.pool) return new Map();
  const { rows } = await db.pool.query(
    'SELECT project_id, status, note, reviewed_by_name, updated_at FROM project_migration_review WHERE board_id = $1',
    [boardId]
  );
  return new Map(
    rows.map((r) => [
      r.project_id,
      { status: r.status, note: r.note, reviewedByName: r.reviewed_by_name, updatedAt: r.updated_at },
    ])
  );
}

async function setReview(boardId, projectId, { status, note, reviewedBy, reviewedByName }) {
  const pool = db.requirePool();
  await pool.query(
    `INSERT INTO project_migration_review (board_id, project_id, status, note, reviewed_by, reviewed_by_name, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,now())
     ON CONFLICT (board_id, project_id) DO UPDATE SET
       status = EXCLUDED.status,
       note = EXCLUDED.note,
       reviewed_by = EXCLUDED.reviewed_by,
       reviewed_by_name = EXCLUDED.reviewed_by_name,
       updated_at = now()`,
    [boardId, projectId, status, note || '', reviewedBy || '', reviewedByName || '']
  );
}

module.exports = { getAll, setReview };
