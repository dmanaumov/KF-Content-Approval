// toolProjects.js — self-serve "tool only" projects + their tasks
// (tool_projects/tool_tasks, see db.js). A COMPLETELY separate task store
// from the shared Mattermost board that the rest of this app uses — by
// direct request, so self-serve signups can never touch agency client data
// or run into Mattermost's own API limits.
//
// The task shape (status/caption/media/publishDate/title) deliberately
// mirrors what taskMapper.js produces for Mattermost-backed tasks, so the
// existing card-rendering logic (cardHtml()/progressHtml() in frontend/
// app.js, team.js) can be reused on the new /tool cabinet almost as-is —
// only the data source differs.
const crypto = require('crypto');
const db = require('./db');

function newLinkToken() {
  return crypto.randomBytes(18).toString('base64url');
}

const PROJECT_COLUMNS = 'id, account_id, name, link_token, created_at, is_archived, mode, survey';

function mapProjectRow(r) {
  return {
    id: String(r.id),
    accountId: String(r.account_id),
    name: r.name,
    linkToken: r.link_token,
    createdAt: r.created_at,
    isArchived: r.is_archived,
    mode: r.mode,
    survey: r.survey || {},
  };
}

// mode/survey — выбор "Как будете использовать инструмент?" (PlanChoice) и,
// для режима 'ai', ответы на анкету (Survey) — оба собираются на /invite на
// СТОРОНЕ приглашённого при регистрации, см. POST /api/invite/:token/redeem.
async function createProject(accountId, name, mode, survey) {
  const safeMode = mode === 'ai' ? 'ai' : 'tool';
  const { rows } = await db.requirePool().query(
    `INSERT INTO tool_projects (account_id, name, link_token, mode, survey) VALUES ($1, $2, $3, $4, $5)
     RETURNING ${PROJECT_COLUMNS}`,
    [accountId, String(name || '').trim() || 'Проект', newLinkToken(), safeMode, JSON.stringify(survey || {})]
  );
  return mapProjectRow(rows[0]);
}

async function listProjectsForAccount(accountId) {
  const { rows } = await db.requirePool().query(
    `SELECT ${PROJECT_COLUMNS}
     FROM tool_projects WHERE account_id = $1 ORDER BY created_at ASC`,
    [accountId]
  );
  return rows.map(mapProjectRow);
}

async function getProjectForAccount(accountId, projectId) {
  const { rows } = await db.requirePool().query(
    `SELECT ${PROJECT_COLUMNS}
     FROM tool_projects WHERE account_id = $1 AND id = $2`,
    [accountId, projectId]
  );
  return rows[0] ? mapProjectRow(rows[0]) : null;
}

// Public read — used by the (future) client-approval portal for this
// project's link_token. Not yet wired to any route (that portal is a
// separate, not-yet-built piece — see project notes).
async function getProjectByLinkToken(linkToken) {
  const { rows } = await db.requirePool().query(
    `SELECT ${PROJECT_COLUMNS}
     FROM tool_projects WHERE link_token = $1`,
    [linkToken]
  );
  return rows[0] ? mapProjectRow(rows[0]) : null;
}

function mapTaskRow(r) {
  return {
    id: String(r.id),
    projectId: String(r.project_id),
    title: r.title,
    caption: r.caption,
    media: r.media || [],
    status: r.status,
    publishDate: r.publish_date,
    keywords: r.keywords,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

async function listTasks(projectId) {
  const { rows } = await db.requirePool().query(
    `SELECT * FROM tool_tasks WHERE project_id = $1 ORDER BY created_at DESC`,
    [projectId]
  );
  return rows.map(mapTaskRow);
}

async function createTask(projectId, { title, caption, status, publishDate, keywords, media }) {
  const { rows } = await db.requirePool().query(
    `INSERT INTO tool_tasks (project_id, title, caption, status, publish_date, keywords, media)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      projectId,
      String(title || '').trim(),
      String(caption || ''),
      status && ['waiting', 'changes', 'approved', 'published'].includes(status) ? status : 'waiting',
      String(publishDate || ''),
      String(keywords || ''),
      JSON.stringify(media || []),
    ]
  );
  return mapTaskRow(rows[0]);
}

async function getTask(projectId, taskId) {
  const { rows } = await db.requirePool().query(
    `SELECT * FROM tool_tasks WHERE project_id = $1 AND id = $2`,
    [projectId, taskId]
  );
  return rows[0] ? mapTaskRow(rows[0]) : null;
}

// Partial update — only columns present in `fields` are touched, same
// "merge, don't replace" shape the client-facing task editors elsewhere in
// this app use.
async function updateTask(projectId, taskId, fields) {
  const sets = [];
  const values = [];
  let i = 1;
  const allowed = { title: 'title', caption: 'caption', status: 'status', publishDate: 'publish_date', keywords: 'keywords', media: 'media' };
  for (const [key, column] of Object.entries(allowed)) {
    if (!(key in fields)) continue;
    if (key === 'status' && !['waiting', 'changes', 'approved', 'published'].includes(fields.status)) continue;
    sets.push(`${column} = $${i}`);
    values.push(key === 'media' ? JSON.stringify(fields.media || []) : fields[key]);
    i += 1;
  }
  if (!sets.length) return getTask(projectId, taskId);
  sets.push(`updated_at = now()`);
  values.push(projectId, taskId);
  const { rows } = await db.requirePool().query(
    `UPDATE tool_tasks SET ${sets.join(', ')} WHERE project_id = $${i} AND id = $${i + 1} RETURNING *`,
    values
  );
  return rows[0] ? mapTaskRow(rows[0]) : null;
}

async function deleteTask(projectId, taskId) {
  await db.requirePool().query(`DELETE FROM tool_tasks WHERE project_id = $1 AND id = $2`, [projectId, taskId]);
}

module.exports = {
  createProject,
  listProjectsForAccount,
  getProjectForAccount,
  getProjectByLinkToken,
  listTasks,
  createTask,
  getTask,
  updateTask,
  deleteTask,
};
