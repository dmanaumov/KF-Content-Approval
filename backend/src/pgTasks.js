// Postgres-backed замена taskMapper.buildTasks() + мутирующих вызовов
// mattermostClient.js для карточек/медиа/переписки — фаза 3 переноса с
// Mattermost Boards (см. claude/kf-mattermost-to-postgres-migration.md в
// проекте «Мои IT дела», и mattermostMigration.js — фаза 2, одноразовый
// импорт, который и наполнил эти три таблицы).
//
// Схема борда (список проектов/клиентов, список статус-опций) СОЗНАТЕЛЬНО
// остаётся источником на Mattermost — решение пользователя 2026-10-14:
// getBoard() дешёвый (~100-300мс), это НЕ тот тяжёлый listCards/listBlocks,
// который и создавал проблему (OOM, исчерпание сессий). Поэтому каждая
// функция ниже принимает уже загруженный `board` (index.js's
// loadBoardSchema()) и использует taskMapper.findPropertyDef/optionLabelById
// только для разрешения project_id → название и полного списка статусов —
// сами карточки/медиа/переписка читаются и пишутся только здесь.
//
// Выходная форма задачи (`rowToTask`) намеренно совпадает с тем, что раньше
// отдавал taskMapper.buildTasks() — id/title/status/statusLabel/format/
// publishDate/weekStart/weekLabel/caption/keywords/reference/media/feedback/
// clientComments/url/assigneeId/projectId/projectLabel/createAt/updateAt —
// чтобы ни один downstream-потребитель (frontend, другие роуты) не заметил
// разницы.

const crypto = require('crypto');
const db = require('./db');
const config = require('./config');
const {
  findPropertyDef,
  optionLabelById,
  normLabel,
  statusEnumFromLabel,
  mondayOf,
  weekLabel,
  resolveProjectOptionId,
} = require('./taskMapper');

const CLIENT_FEEDBACK_KINDS = new Set(['approved', 'feedback', 'agency', 'correction']);

function rowToTask(row, mediaRows, feedbackRows, projectProp) {
  const statusLabel = row.status || '';
  const status = statusEnumFromLabel(statusLabel);
  const media = mediaRows.map((m) => ({
    id: String(m.id),
    source: 'disk',
    shareUrl: m.url,
    // '' (неизвестно, как у исторических disk-ссылок в тексте) -> null, то
    // же соглашение, что раньше было у taskMapper.js'ного diskMedia — так
    // существующий resolveDiskMediaKinds() в index.js (проба по shareUrl,
    // кэш, лимит параллелизма) продолжает работать без изменений. Известный
    // kind (файлы, перезаливанные с Mattermost при переносе) не трогаем —
    // не нужно перепроверять то, что уже знаем.
    kind: m.kind || null,
    name: '',
  }));
  const clientComments = feedbackRows
    .filter((f) => CLIENT_FEEDBACK_KINDS.has(f.kind))
    .map((f) => ({
      id: String(f.id),
      kind: f.kind,
      text: f.text || '',
      imageUrl: f.image_url || null,
      createdAt: new Date(f.created_at).getTime(),
    }));
  let feedback = null;
  if (status === 'changes') {
    // feedbackRows уже отсортированы по created_at ASC (см. rowsToTasks) —
    // последняя запись kind:'feedback' это самая свежая правка клиента.
    const feedbackOnly = feedbackRows.filter((f) => f.kind === 'feedback');
    const latest = feedbackOnly[feedbackOnly.length - 1];
    feedback = latest ? latest.text : null;
  }
  const projectLabel = projectProp ? optionLabelById(projectProp, row.project_id) || '' : '';
  const weekStartVal = mondayOf(row.publish_date || null);
  return {
    id: row.id,
    title: row.title || '(без названия)',
    status,
    statusLabel,
    format: row.format || null,
    publishDate: row.publish_date || null,
    weekStart: weekStartVal,
    weekLabel: weekLabel(weekStartVal),
    caption: row.caption || '',
    keywords: row.keywords || '',
    reference: row.reference || '',
    media,
    feedback,
    clientComments,
    url: row.published_url || '',
    assigneeId: row.assignee_id || null,
    projectId: row.project_id || null,
    projectLabel,
    createAt: new Date(row.created_at).getTime(),
    updateAt: new Date(row.updated_at).getTime(),
  };
}

// Для mattermostMigration.js: какие disk.kontentferma-URL у задачи УЖЕ
// есть в Postgres прямо сейчас — используется, чтобы сверить "что реально
// уже докатано" с живым списком Mattermost-медиа карточки, НЕ полагаясь на
// report.mediaErrors в памяти процесса (который теряется при рестарте
// бэкенда — см. computeMissingMediaTargets в mattermostMigration.js).
async function getExistingMediaUrlsByTask(taskIds) {
  const map = new Map();
  if (!taskIds.length) return map;
  const pool = db.requirePool();
  const { rows } = await pool.query('SELECT task_id, url FROM app_task_media WHERE task_id = ANY($1::text[])', [taskIds]);
  for (const r of rows) {
    if (!map.has(r.task_id)) map.set(r.task_id, []);
    map.get(r.task_id).push(r.url);
  }
  return map;
}

async function rowsToTasks(rows, projectProp) {
  if (!rows.length) return [];
  const pool = db.requirePool();
  const ids = rows.map((r) => r.id);
  const [mediaRes, feedbackRes] = await Promise.all([
    pool.query('SELECT * FROM app_task_media WHERE task_id = ANY($1::text[]) ORDER BY task_id, position', [ids]),
    pool.query('SELECT * FROM app_task_feedback WHERE task_id = ANY($1::text[]) ORDER BY task_id, created_at', [ids]),
  ]);
  const mediaByTask = new Map();
  for (const m of mediaRes.rows) {
    if (!mediaByTask.has(m.task_id)) mediaByTask.set(m.task_id, []);
    mediaByTask.get(m.task_id).push(m);
  }
  const feedbackByTask = new Map();
  for (const f of feedbackRes.rows) {
    if (!feedbackByTask.has(f.task_id)) feedbackByTask.set(f.task_id, []);
    feedbackByTask.get(f.task_id).push(f);
  }
  return rows.map((row) => rowToTask(row, mediaByTask.get(row.id) || [], feedbackByTask.get(row.id) || [], projectProp));
}

// Замена buildTasks(board, cards, blocks, opts) — та же опция-совместимость
// (skipProjectFilter/includeAllStatuses/projectFilter), но без cards/blocks:
// карточки читаются прямо из app_tasks. meta — тот же набор полей, что
// раньше (approvalPropertyFound и т.д.), т.к. это всё ещё схема борда.
async function listTasks(boardId, board, opts = {}) {
  const projectProp = findPropertyDef(board, config.projectPropertyName);
  const approvalProp = findPropertyDef(board, config.approvalPropertyName);
  const publishDateProp = findPropertyDef(board, config.publishDatePropertyName);
  const urlProp = findPropertyDef(board, config.urlPropertyName);
  const assigneeProp = findPropertyDef(board, config.assigneePropertyName);
  const keywordsProp = findPropertyDef(board, config.keywordsPropertyName);
  const referenceProp = findPropertyDef(board, config.referencePropertyName);

  let projectOptionId = null;
  let projectFilterMatched = true;
  if (projectProp && !opts.skipProjectFilter) {
    projectOptionId = resolveProjectOptionId(projectProp, opts.projectFilter);
    projectFilterMatched = !!projectOptionId;
  }

  const meta = {
    approvalPropertyFound: !!approvalProp,
    publishDatePropertyFound: !!publishDateProp,
    urlPropertyFound: !!urlProp,
    projectPropertyFound: !!projectProp,
    assigneePropertyFound: !!assigneeProp,
    keywordsPropertyFound: !!keywordsProp,
    referencePropertyFound: !!referenceProp,
    projectFilterMatched,
    statusOptions: approvalProp ? (approvalProp.options || []).map((o) => ({ id: o.id, label: o.value })) : [],
  };

  if (projectProp && !opts.skipProjectFilter && !projectFilterMatched) {
    return { tasks: [], meta };
  }

  const pool = db.requirePool();
  const where = ['board_id = $1'];
  const params = [boardId];
  if (projectOptionId) {
    params.push(projectOptionId);
    where.push(`project_id = $${params.length}`);
  }
  const { rows } = await pool.query(
    `SELECT * FROM app_tasks WHERE ${where.join(' AND ')} ORDER BY publish_date DESC NULLS LAST, created_at DESC`,
    params
  );
  let tasks = await rowsToTasks(rows, projectProp);

  // Видимость по статусу — то же правило, что у buildTasks(): клиентский
  // кабинет (includeAllStatuses не указан) видит только 4 клиенто-видимых
  // состояния (waiting/changes/approved/published — архив исключён всегда,
  // внутренние стадии маппятся в status:null и тоже отпадают сами собой).
  // Команда (includeAllStatuses:true) видит всё, кроме архива — сравнение
  // идёт по НОРМАЛИЗОВАННОМУ сырому label (а не status-enum), т.к.
  // внутренние стадии в status-enum не попадают вовсе.
  if (opts.includeAllStatuses) {
    const archivedLabel = normLabel(config.statusOptionLabels.archived);
    tasks = tasks.filter((t) => normLabel(t.statusLabel) !== archivedLabel);
  } else {
    tasks = tasks.filter((t) => t.status && t.status !== 'archived');
  }

  return { tasks, meta };
}

// Одна карточка по id — замена getCardWithChildren+buildTasks (refetchTeamTask
// и аналоги). Возвращает null, если не найдена (вызывающий сам решает, 404
// это или что-то другое).
async function getTaskById(boardId, board, taskId) {
  const pool = db.requirePool();
  const { rows } = await pool.query('SELECT * FROM app_tasks WHERE board_id = $1 AND id = $2', [boardId, taskId]);
  if (!rows.length) return null;
  const projectProp = findPropertyDef(board, config.projectPropertyName);
  const tasks = await rowsToTasks(rows, projectProp);
  return tasks[0];
}

// Сколько карточек у проекта — замена buildTasks(...).tasks.length для
// DELETE /api/projects/:projectId's "проект ещё не пуст" guard.
async function countTasksForProject(boardId, projectId) {
  const pool = db.requirePool();
  const { rows } = await pool.query(
    'SELECT COUNT(*)::int AS n FROM app_tasks WHERE board_id = $1 AND project_id = $2',
    [boardId, projectId]
  );
  return rows[0].n;
}

// Точечное обновление произвольных колонок app_tasks (всегда одной командой,
// без read-merge-write — в отличие от Mattermost patchCardProperty, тут
// нет "пришлите весь properties-блоб целиком" гонки). fields — плоский
// объект {колонка: значение}; updated_at обновляется всегда.
async function updateFields(taskId, fields) {
  const pool = db.requirePool();
  const keys = Object.keys(fields);
  if (!keys.length) return;
  const sets = keys.map((k, i) => `${k} = $${i + 2}`);
  const values = keys.map((k) => fields[k]);
  await pool.query(`UPDATE app_tasks SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, [taskId, ...values]);
}

// Статус + is_archived пересчитываются вместе всегда (одна и та же пара
// колонок на любое изменение статуса) — отдельная функция вместо голого
// updateFields, чтобы это правило жило в одном месте.
async function setStatusLabel(taskId, rawLabel) {
  const archived = normLabel(rawLabel) === normLabel(config.statusOptionLabels.archived);
  await updateFields(taskId, { status: rawLabel, is_archived: archived });
}

async function deleteTaskRow(taskId) {
  const pool = db.requirePool();
  await pool.query('DELETE FROM app_tasks WHERE id = $1', [taskId]);
}

// Генерирует id в духе того, как раньше выглядели Mattermost block id (не
// обязано совпадать по формату — это просто непрозрачная строка, которую
// клиентские диплинки вида #tasks?task=<id> используют как есть).
function generateTaskId() {
  return `t${Date.now().toString(36)}${crypto.randomBytes(6).toString('hex')}`;
}

async function createTaskRow(fields) {
  const pool = db.requirePool();
  const id = generateTaskId();
  const cols = ['id', ...Object.keys(fields)];
  const values = [id, ...Object.values(fields)];
  const placeholders = cols.map((_, i) => `$${i + 1}`);
  await pool.query(`INSERT INTO app_tasks (${cols.join(', ')}) VALUES (${placeholders.join(', ')})`, values);
  return id;
}

// --- Медиа -------------------------------------------------------------

async function getMedia(taskId, mediaId) {
  const pool = db.requirePool();
  const { rows } = await pool.query('SELECT * FROM app_task_media WHERE id = $1 AND task_id = $2', [mediaId, taskId]);
  return rows[0] || null;
}

// position не передан -> в конец списка. kind '' (неизвестно) для любой
// только что добавленной disk-ссылки — ровно как раньше у diskMedia,
// resolveDiskMediaKinds() на чтении сам разберётся.
async function insertMedia(taskId, { url, kind = '', position = null }) {
  const pool = db.requirePool();
  let pos = position;
  if (pos == null) {
    const { rows } = await pool.query(
      'SELECT COALESCE(MAX(position), -1) + 1 AS next FROM app_task_media WHERE task_id = $1',
      [taskId]
    );
    pos = rows[0].next;
  }
  const { rows } = await pool.query(
    'INSERT INTO app_task_media (task_id, url, kind, position) VALUES ($1,$2,$3,$4) RETURNING id',
    [taskId, url, kind, pos]
  );
  return String(rows[0].id);
}

async function deleteMedia(taskId, mediaId) {
  const pool = db.requirePool();
  const { rowCount } = await pool.query('DELETE FROM app_task_media WHERE id = $1 AND task_id = $2', [mediaId, taskId]);
  return rowCount > 0;
}

// orderedIds — полный список media.id (строки) в новом порядке; position
// проставляется по индексу в массиве. Одной транзакцией — реордер должен
// быть всё-или-ничего, как и было с mediaOrder.setMediaOrder раньше.
async function reorderMedia(taskId, orderedIds) {
  const pool = db.requirePool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (let i = 0; i < orderedIds.length; i++) {
      await client.query('UPDATE app_task_media SET position = $1 WHERE id = $2 AND task_id = $3', [i, orderedIds[i], taskId]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// --- Переписка (app_task_feedback) --------------------------------------

// kind: 'approved'|'feedback'|'agency'|'correction'|'message'|'system' (см.
// CHECK в db.js) — то же самое множество значений, в которые mattermostMigration.js
// раскладывал исторические маркеры. Каждый вызов mm.addCardComment(...) в
// старом коде становится одним вызовом этой функции.
async function addFeedback(taskId, { kind, authorKind = '', authorName = '', text = '', imageUrl = '' }) {
  const pool = db.requirePool();
  await pool.query(
    `INSERT INTO app_task_feedback (task_id, kind, author_kind, author_name, text, image_url)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [taskId, kind, authorKind, authorName, text, imageUrl]
  );
}

module.exports = {
  listTasks,
  getTaskById,
  countTasksForProject,
  updateFields,
  setStatusLabel,
  deleteTaskRow,
  createTaskRow,
  generateTaskId,
  getMedia,
  insertMedia,
  deleteMedia,
  reorderMedia,
  addFeedback,
  getExistingMediaUrlsByTask,
};
