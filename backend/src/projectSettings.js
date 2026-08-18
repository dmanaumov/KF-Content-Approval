// Postgres-backed per-project settings: the rotatable client cabinet link
// (token), the client's logo URL (shown in the cabinet header — see
// resolveLinkToken()/applyBranding() in app.js — instead of the generic
// letter avatar), per-social-network publishing credentials (a plain JSON
// blob per network, meant to be read directly by the publishing automation
// via its own Postgres connection — this app itself never reads
// social_credentials, only stores/returns it for the staff edit popup), and
// the project's planning/profile metadata for that automation: report start
// date, posts per month, preferred MSK publish time, project manager, and
// the strategy/planning/post/image prompts. Like the credentials, these are
// stored for the automation to read directly; this app only persists/returns
// them for the staff edit popup.
//
// Replaces the earlier flat-JSON-file link store (linkTokens.js) — that was
// fine while a link token was the only thing worth persisting, but real
// API credentials need a real, queryable-by-a-second-system store. See
// importLegacyFileTokens() below for how an already-issued link survives
// the cutover.

const crypto = require('crypto');
const fs = require('fs');
const config = require('./config');
const db = require('./db');

function newToken() {
  return crypto.randomBytes(9).toString('base64url'); // 12 URL-safe chars
}

// Creates a row (with a fresh token) the first time a project is touched;
// a no-op if one already exists. Concurrency-safe via ON CONFLICT DO NOTHING
// + a re-read, so two near-simultaneous first-loads can't create two
// different "first" tokens for the same project.
async function ensureRow(boardId, projectId) {
  const pool = db.requirePool();
  const existing = await pool.query(
    'SELECT link_token FROM project_settings WHERE board_id = $1 AND project_id = $2',
    [boardId, projectId]
  );
  if (existing.rows.length) return existing.rows[0].link_token;
  const token = newToken();
  await pool.query(
    `INSERT INTO project_settings (board_id, project_id, link_token)
     VALUES ($1, $2, $3)
     ON CONFLICT (board_id, project_id) DO NOTHING`,
    [boardId, projectId, token]
  );
  const row = await pool.query(
    'SELECT link_token FROM project_settings WHERE board_id = $1 AND project_id = $2',
    [boardId, projectId]
  );
  return row.rows[0].link_token;
}

async function getToken(boardId, projectId) {
  return ensureRow(boardId, projectId);
}

// Token + logo URL in one go — used by the staff project-list page, which
// needs both per project and would otherwise call ensureRow() twice (once
// via getToken, once via getSettings) for every row. Also returns aiStatus —
// whether the project is "AI" based on the four generation prompts (see
// aiStatusOf() below), which the staff list renders as a highlight + avatar.
async function getTokenAndLogo(boardId, projectId) {
  await ensureRow(boardId, projectId);
  const pool = db.requirePool();
  const { rows } = await pool.query(
    `SELECT link_token, logo_url, strategy_prompt, planning_prompt, post_prompt,
            image_prompt
     FROM project_settings WHERE board_id = $1 AND project_id = $2`,
    [boardId, projectId]
  );
  const row = rows[0] || {};
  return {
    token: row.link_token || '',
    logoUrl: row.logo_url || '',
    aiStatus: aiStatusOf(row),
  };
}

// How "AI" a project is, purely from whether the four generation prompts are
// filled in: all four non-empty = 'ai', at least one but not all = 'partial'
// (needs attention), none = 'none' (a regular project). Kept in sync with
// frontend/projects.js's own re-classification on save.
function aiStatusOf(row) {
  const filled = ['strategy_prompt', 'planning_prompt', 'post_prompt', 'image_prompt']
    .filter((k) => String(row[k] || '').trim()).length;
  return filled === 4 ? 'ai' : filled > 0 ? 'partial' : 'none';
}

// Generates and stores a brand new token, overwriting (invalidating)
// whatever token existed before — the old short link starts 404ing on its
// very next use.
async function regenerateToken(boardId, projectId) {
  const pool = db.requirePool();
  const token = newToken();
  await pool.query(
    `INSERT INTO project_settings (board_id, project_id, link_token, link_token_updated_at, updated_at)
     VALUES ($1, $2, $3, now(), now())
     ON CONFLICT (board_id, project_id)
     DO UPDATE SET link_token = EXCLUDED.link_token, link_token_updated_at = now(), updated_at = now()`,
    [boardId, projectId, token]
  );
  return token;
}

// token -> { boardId, projectId } | null (null = unknown or revoked token)
async function resolveToken(token) {
  if (!token) return null;
  const pool = db.requirePool();
  const { rows } = await pool.query(
    'SELECT board_id, project_id FROM project_settings WHERE link_token = $1',
    [token]
  );
  if (!rows.length) return null;
  return { boardId: rows[0].board_id, projectId: rows[0].project_id };
}

async function getSettings(boardId, projectId) {
  await ensureRow(boardId, projectId); // guarantees a row exists to read
  const pool = db.requirePool();
  const { rows } = await pool.query(
    `SELECT logo_url, social_credentials, start_date, posts_per_month,
            publish_time_msk, project_manager, strategy_prompt, planning_prompt,
            post_prompt, image_prompt
     FROM project_settings WHERE board_id = $1 AND project_id = $2`,
    [boardId, projectId]
  );
  const row = rows[0] || {};
  return {
    logoUrl: row.logo_url || '',
    socialCredentials: row.social_credentials || {},
    startDate: row.start_date || '',
    postsPerMonth: row.posts_per_month || '',
    publishTimeMsk: row.publish_time_msk || '',
    projectManager: row.project_manager || '',
    strategyPrompt: row.strategy_prompt || '',
    planningPrompt: row.planning_prompt || '',
    postPrompt: row.post_prompt || '',
    imagePrompt: row.image_prompt || '',
  };
}

// Same 5 shorthands the client cabinet already detects in a post title
// (see SOCIAL_MAP in frontend/app.js) — kept in sync manually since one
// lives in the browser and one here; see docs/N8N_AUTOMATION.md which spells
// this rule out for whoever builds the automation.
const KNOWN_NETWORKS = ['ig', 'tg', 'vk', 'ok', 'max'];

function textOrEmpty(value) {
  return value == null ? '' : String(value);
}

async function updateSettings(boardId, projectId, {
  logoUrl, socialCredentials,
  startDate, postsPerMonth, publishTimeMsk, projectManager,
  strategyPrompt, planningPrompt, postPrompt, imagePrompt,
}) {
  if (typeof logoUrl !== 'string') {
    throw new Error('logoUrl must be a string (may be empty).');
  }
  if (socialCredentials === undefined || socialCredentials === null || typeof socialCredentials !== 'object' || Array.isArray(socialCredentials)) {
    throw new Error('socialCredentials must be a JSON object keyed by network (ig/tg/vk/ok/max).');
  }
  for (const key of Object.keys(socialCredentials)) {
    if (!KNOWN_NETWORKS.includes(key)) {
      throw new Error(`Unknown network key "${key}" — expected one of: ${KNOWN_NETWORKS.join(', ')}.`);
    }
  }
  await ensureRow(boardId, projectId);
  const pool = db.requirePool();
  await pool.query(
    `UPDATE project_settings
     SET logo_url = $3,
         social_credentials = $4::jsonb,
         start_date = $5,
         posts_per_month = $6,
         publish_time_msk = $7,
         project_manager = $8,
         strategy_prompt = $9,
         planning_prompt = $10,
         post_prompt = $11,
         image_prompt = $12,
         updated_at = now()
     WHERE board_id = $1 AND project_id = $2`,
    [
      boardId, projectId, logoUrl, JSON.stringify(socialCredentials),
      textOrEmpty(startDate), textOrEmpty(postsPerMonth), textOrEmpty(publishTimeMsk),
      textOrEmpty(projectManager),
      textOrEmpty(strategyPrompt), textOrEmpty(planningPrompt),
      textOrEmpty(postPrompt), textOrEmpty(imagePrompt),
    ]
  );
}

// One-time (but idempotent — safe to run on every boot) import of the OLD
// flat-JSON link store into Postgres, so a link already handed to a client
// (already tested live by the agency, see project docs) keeps working after
// this app cuts over to Postgres. Never overwrites an existing DB row —
// only fills in projects Postgres doesn't know about yet.
async function importLegacyFileTokens() {
  const legacyFile = config.projectLinksFile;
  if (!legacyFile) return;
  let raw;
  try {
    raw = fs.readFileSync(legacyFile, 'utf8');
  } catch (err) {
    return; // no legacy file (fresh install, or already migrated+removed) — fine
  }
  let store;
  try {
    store = JSON.parse(raw);
  } catch (err) {
    console.warn(`[projectSettings] legacy link file ${legacyFile} is not valid JSON, skipping migration:`, err.message);
    return;
  }
  const entries = Object.values(store || {}).filter((e) => e && e.boardId && e.projectId && e.token);
  if (!entries.length) return;
  const pool = db.requirePool();
  let migrated = 0;
  for (const e of entries) {
    const result = await pool.query(
      `INSERT INTO project_settings (board_id, project_id, link_token, link_token_updated_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (board_id, project_id) DO NOTHING`,
      [e.boardId, e.projectId, e.token, e.updatedAt || new Date().toISOString()]
    );
    if (result.rowCount) migrated++;
  }
  if (migrated) {
    console.log(`[projectSettings] migrated ${migrated} legacy link token(s) from ${legacyFile} into Postgres.`);
  }
}

module.exports = {
  getToken,
  getTokenAndLogo,
  regenerateToken,
  resolveToken,
  getSettings,
  updateSettings,
  importLegacyFileTokens,
  KNOWN_NETWORKS,
};
