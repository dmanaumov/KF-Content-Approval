// Per-project, per-team-member access role — 'editor' or 'admin'. A MISSING
// row means "нет" (no access at all): the default for every team member on
// every project until a CEO explicitly grants one from the new "Доступ"
// page (/ceo/access — see GET/PUT /api/ceo/project-access in index.js).
//
// Added 2026-09-20, replacing the old implicit rule ("видишь карточку, если
// назначен исполнителем, ты автор карточки, или указан единственным
// «Менеджером проекта»"): per Дмитрий's decision that day, the PROJECT role
// is now the sole authority over /team visibility — role 'нет' hides a
// project's cards completely, even from someone personally assigned to one
// of them. 'editor' sees + edits every card of the project (status, dates,
// text, media, chat) regardless of assignment. 'admin' additionally unlocks
// that project's settings on the internal /projects staff page (logo,
// social credentials, KPI, AI prompts, the «Цербер» tab) — the same scope
// the old single-person "Менеджер проекта" field used to grant, just
// multi-person and explicitly separate from card-editing rights.
//
// See db.js's project_access table comment for the schema. See
// bootstrapFromCurrentData() below for the one-time, idempotent import of
// pre-existing (assignee/creator/manager) relationships into this table, so
// switching this on doesn't lock anyone out of what they were already doing.

const db = require('./db');

const ROLES = ['editor', 'admin'];
const RANK = { none: 0, editor: 1, admin: 2 };

function normalizeRole(role) {
  const r = String(role || '').trim().toLowerCase();
  return ROLES.includes(r) ? r : 'none';
}

// Single (project, user) lookup — used by write routes that already know
// exactly which project a card belongs to (see requireTeamCardAccess and
// staffCanAccessProject in index.js). Cheap: primary-key lookup.
async function getRole(boardId, projectId, userId) {
  if (!db.pool || !projectId || !userId) return 'none';
  try {
    const { rows } = await db.pool.query(
      'SELECT role FROM project_access WHERE board_id = $1 AND project_id = $2 AND user_id = $3',
      [boardId, projectId, String(userId)]
    );
    return rows.length ? normalizeRole(rows[0].role) : 'none';
  } catch (err) {
    console.error('[projectAccess] getRole failed (defaulting to "нет"):', err.message);
    return 'none';
  }
}

// Every role this ONE user holds across ALL projects on the board, as a
// Map(projectId -> 'editor'|'admin') — powers GET /api/team/tasks' list-wide
// visibility filter (one query instead of one per task) and staffAuth's
// "does this person manage at least one project" checks.
async function getRolesForUser(boardId, userId) {
  if (!db.pool || !userId) return new Map();
  try {
    const { rows } = await db.pool.query(
      'SELECT project_id, role FROM project_access WHERE board_id = $1 AND user_id = $2',
      [boardId, String(userId)]
    );
    return new Map(rows.map((r) => [r.project_id, normalizeRole(r.role)]));
  } catch (err) {
    console.error('[projectAccess] getRolesForUser failed (defaulting to no access anywhere):', err.message);
    return new Map();
  }
}

// projectIds where this user has 'admin' — the staff-page (/projects) scope
// equivalent of the old single-username "Менеджер проекта" check.
async function getAdminProjectIds(boardId, userId) {
  const roles = await getRolesForUser(boardId, userId);
  return new Set([...roles.entries()].filter(([, role]) => role === 'admin').map(([projectId]) => projectId));
}

// projectIds where this user has ANY role — 'editor' OR 'admin'. Added
// 2026-09-25 (staffAuth's door into /projects + the "Секретики" tab used to
// admit admin-only; по прямому запросу пользователя «проавить может каждый
// член команды проекта» ordinary project team members now need in too —
// see staffAuth/staffCanViewProject in index.js).
async function getAccessibleProjectIds(boardId, userId) {
  const roles = await getRolesForUser(boardId, userId);
  return new Set(roles.keys());
}

// Every grant on the board, for the "Доступ" page's matrix — one query, the
// page itself groups by project. Returns
// [{projectId, userId, role, grantedBy, grantedAt, updatedAt}, ...].
async function listForBoard(boardId) {
  if (!db.pool) return [];
  try {
    const { rows } = await db.pool.query(
      `SELECT project_id, user_id, role, granted_by, granted_at, updated_at
       FROM project_access WHERE board_id = $1`,
      [boardId]
    );
    return rows.map((r) => ({
      projectId: r.project_id,
      userId: r.user_id,
      role: normalizeRole(r.role),
      grantedBy: r.granted_by || '',
      grantedAt: r.granted_at,
      updatedAt: r.updated_at,
    }));
  } catch (err) {
    console.error('[projectAccess] listForBoard failed:', err.message);
    return [];
  }
}

// Sets (or clears, when role is falsy/'none') exactly one (project, user)
// grant — the single write behind PUT /api/ceo/project-access/:projectId/:userId.
// grantedByUsername is cosmetic (shown on the matrix as "выдал ...") — never
// itself part of the access decision.
async function setRole(boardId, projectId, userId, role, grantedByUsername) {
  const pool = db.requirePool();
  const normalized = String(role || '').trim().toLowerCase();
  if (!normalized || normalized === 'none') {
    await pool.query(
      'DELETE FROM project_access WHERE board_id = $1 AND project_id = $2 AND user_id = $3',
      [boardId, projectId, String(userId)]
    );
    return 'none';
  }
  if (!ROLES.includes(normalized)) {
    throw new Error(`Неизвестная роль "${role}" — допустимы: none, ${ROLES.join(', ')}.`);
  }
  await pool.query(
    `INSERT INTO project_access (board_id, project_id, user_id, role, granted_by)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (board_id, project_id, user_id)
     DO UPDATE SET role = EXCLUDED.role, granted_by = EXCLUDED.granted_by, updated_at = now()`,
    [boardId, projectId, String(userId), normalized, String(grantedByUsername || '')]
  );
  return normalized;
}

// One-time (but always safe to re-run) import of pre-existing access from
// BEFORE this table existed, so turning this feature on doesn't strand
// anyone who was already working normally. `pairs` is
// [{projectId, userId, role}, ...] — the caller (index.js's
// POST /api/ceo/project-access/bootstrap) works out the candidate role per
// pair (assignee/card-creator -> 'editor', the old single "Менеджер
// проекта" -> 'admin', an 'admin' entry winning over 'editor' for the same
// pair). This function ONLY fills gaps: a pair that already has ANY row
// (from a previous bootstrap run, or from a CEO's own click on the page) is
// left completely untouched — never upgraded, downgraded, or overwritten.
// Returns how many NEW rows were actually inserted, so the page can show
// "добавлено N прав доступа" instead of a silent no-op.
async function bootstrapFromCurrentData(boardId, pairs) {
  const pool = db.requirePool();
  // Collapse duplicates for the same (projectId, userId) — 'admin' wins.
  const byKey = new Map();
  for (const p of pairs) {
    if (!p || !p.projectId || !p.userId) continue;
    const key = `${p.projectId}\u0000${p.userId}`;
    const role = normalizeRole(p.role);
    if (role === 'none') continue;
    const existing = byKey.get(key);
    if (!existing || RANK[role] > RANK[existing.role]) {
      byKey.set(key, { projectId: p.projectId, userId: String(p.userId), role });
    }
  }
  let inserted = 0;
  for (const { projectId, userId, role } of byKey.values()) {
    const { rowCount } = await pool.query(
      `INSERT INTO project_access (board_id, project_id, user_id, role, granted_by)
       VALUES ($1, $2, $3, $4, 'bootstrap')
       ON CONFLICT (board_id, project_id, user_id) DO NOTHING`,
      [boardId, projectId, userId, role]
    );
    inserted += rowCount;
  }
  return inserted;
}

module.exports = {
  getRole,
  getRolesForUser,
  getAdminProjectIds,
  getAccessibleProjectIds,
  listForBoard,
  setRole,
  bootstrapFromCurrentData,
};
