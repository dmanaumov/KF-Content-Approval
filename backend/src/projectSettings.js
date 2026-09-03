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
// whether the project is "AI" (see aiStatusOf() below), which the staff list
// renders as a highlight + avatar (same treatment "кот Василий" already has).
//
// postsPerMonth (added 2026-09-03, fixing a real latent bug): index.js's
// GET /api/projects has destructured `postsPerMonth` from this function's
// result since the KPI-dot feature was built, but this SELECT never
// actually fetched posts_per_month — so scheduleStatus/the KPI traffic-light
// dot was silently always null for every project. Now actually selected.
//
// configuredNetworks (added 2026-09-03) — which of ig/tg/vk/ok/max have
// non-empty social_credentials for this project, so the project list can
// show "куда реально можем постить" as small network chips. Deliberately
// only the KEY names, never the credential values themselves — same
// never-bulk-expose-secrets posture as the automation API.
//
// paidThroughDate (added 2026-09-03) — "оплачено до", so the list can flag
// a project whose paid period is about to run out (see isPaidThroughExpired
// in index.js for the actual publish-blocking gate; this is just the
// read used to warn staff in the list before that gate ever fires).
async function getTokenAndLogo(boardId, projectId) {
  await ensureRow(boardId, projectId);
  const pool = db.requirePool();
  const { rows } = await pool.query(
    `SELECT link_token, logo_url, is_ai_project, is_archived, strategy_prompt, planning_prompt,
            post_prompt, image_prompt, posts_per_month, paid_through_date, social_credentials
     FROM project_settings WHERE board_id = $1 AND project_id = $2`,
    [boardId, projectId]
  );
  const row = rows[0] || {};
  const credentials = row.social_credentials || {};
  return {
    token: row.link_token || '',
    logoUrl: row.logo_url || '',
    aiStatus: aiStatusOf(row),
    isArchived: !!row.is_archived,
    postsPerMonth: row.posts_per_month || '',
    paidThroughDate: row.paid_through_date || '',
    configuredNetworks: KNOWN_NETWORKS.filter((net) => {
      const c = credentials[net];
      return c && typeof c === 'object' && !Array.isArray(c) && Object.keys(c).length > 0;
    }),
  };
}

// How "AI" a project is. Ground truth is the explicit `is_ai_project`
// checkbox (staff-set, next to the logo field in the edit popup) — NOT
// whether the four generation prompts happen to be filled in. A project not
// flagged here never highlights as AI, no matter what's typed into the
// prompt boxes ('none'). A project THAT IS flagged shows 'ai' once all four
// prompts are filled in, or 'partial' (needs attention) otherwise — even at
// zero prompts filled, since being flagged as AI but unconfigured is itself
// something the team should notice. (Earlier version derived this purely
// from prompt completeness, which started misclassifying real projects once
// more AI clients began appearing — see db.js's comment on is_ai_project.)
function aiStatusOf(row) {
  if (!row.is_ai_project) return 'none';
  const filled = ['strategy_prompt', 'planning_prompt', 'post_prompt', 'image_prompt']
    .filter((k) => String(row[k] || '').trim()).length;
  return filled === 4 ? 'ai' : 'partial';
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
    `SELECT logo_url, social_credentials, is_ai_project, is_archived, start_date, posts_per_month,
            publish_time_msk, project_manager, strategy_prompt, planning_prompt,
            post_prompt, image_prompt, image_references, paid_through_date
     FROM project_settings WHERE board_id = $1 AND project_id = $2`,
    [boardId, projectId]
  );
  const row = rows[0] || {};
  return {
    logoUrl: row.logo_url || '',
    socialCredentials: row.social_credentials || {},
    isAiProject: !!row.is_ai_project,
    isArchived: !!row.is_archived,
    startDate: row.start_date || '',
    postsPerMonth: row.posts_per_month || '',
    publishTimeMsk: row.publish_time_msk || '',
    projectManager: row.project_manager || '',
    strategyPrompt: row.strategy_prompt || '',
    planningPrompt: row.planning_prompt || '',
    postPrompt: row.post_prompt || '',
    imagePrompt: row.image_prompt || '',
    imageReferences: Array.isArray(row.image_references) ? row.image_references : [],
    // "Оплачено до" (YYYY-MM-DD) — см. db.js. Пустая строка = не задано, не
    // блокирует автопостинг. Читается staff-попапом для показа/редактирования
    // и index.js's publishAutomationTask для жёсткого гейта после даты.
    paidThroughDate: row.paid_through_date || '',
  };
}

// Referenced images for AI generation — up to 10 URLs (pasted or uploaded to
// disk.kontentferma via POST /api/projects/:id/reference-upload, see
// index.js/diskUpload.js). Deliberately permissive validation (just "is it a
// non-empty string, and at most 10 of them") — these are meant to be quick
// working links for an automation to fetch, not something this app itself
// dereferences, so no need to be stricter about exact URL shape here.
const MAX_IMAGE_REFERENCES = 10;
function normalizeImageReferences(value) {
  const arr = Array.isArray(value) ? value : [];
  const cleaned = arr.map((v) => String(v || '').trim()).filter(Boolean);
  if (cleaned.length > MAX_IMAGE_REFERENCES) {
    throw new Error(`Референсов не может быть больше ${MAX_IMAGE_REFERENCES} (передано ${cleaned.length}).`);
  }
  return cleaned;
}

// Same 5 shorthands the client cabinet already detects in a post title
// (see SOCIAL_MAP in frontend/app.js) — kept in sync manually since one
// lives in the browser and one here; see docs/N8N_AUTOMATION.md which spells
// this rule out for whoever builds the automation.
const KNOWN_NETWORKS = ['ig', 'tg', 'vk', 'ok', 'max'];

function textOrEmpty(value) {
  return value == null ? '' : String(value);
}

// YYYY-MM-DD, same shape the <input type="date"> in the edit popup already
// sends for startDate — reused here (see paidThroughDate below) rather than
// accepting arbitrary date text, since this field directly gates whether
// publishAutomationTask() lets autoposting through (index.js) and a value
// Date.parse() can't reliably compare would silently defeat that gate.
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

async function updateSettings(boardId, projectId, {
  logoUrl, socialCredentials, isAiProject, isArchived,
  startDate, postsPerMonth, publishTimeMsk, projectManager,
  strategyPrompt, planningPrompt, postPrompt, imagePrompt,
  imageReferences, paidThroughDate,
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
  if (paidThroughDate !== undefined && paidThroughDate !== null && paidThroughDate !== '' && !DATE_ONLY_RE.test(String(paidThroughDate))) {
    throw new Error('paidThroughDate must be YYYY-MM-DD (or empty to clear it).');
  }
  const references = normalizeImageReferences(imageReferences);
  await ensureRow(boardId, projectId);
  const pool = db.requirePool();
  await pool.query(
    `UPDATE project_settings
     SET logo_url = $3,
         social_credentials = $4::jsonb,
         is_ai_project = $5,
         start_date = $6,
         posts_per_month = $7,
         publish_time_msk = $8,
         project_manager = $9,
         strategy_prompt = $10,
         planning_prompt = $11,
         post_prompt = $12,
         image_prompt = $13,
         is_archived = $14,
         image_references = $15::jsonb,
         paid_through_date = $16,
         updated_at = now()
     WHERE board_id = $1 AND project_id = $2`,
    [
      boardId, projectId, logoUrl, JSON.stringify(socialCredentials), !!isAiProject,
      textOrEmpty(startDate), textOrEmpty(postsPerMonth), textOrEmpty(publishTimeMsk),
      textOrEmpty(projectManager),
      textOrEmpty(strategyPrompt), textOrEmpty(planningPrompt),
      textOrEmpty(postPrompt), textOrEmpty(imagePrompt),
      !!isArchived,
      JSON.stringify(references),
      textOrEmpty(paidThroughDate),
    ]
  );
}

// Merge-upsert ONE network's credentials for a project, without touching any
// other field on the row (other networks, isAiProject, prompts, ...) and
// without a read-modify-write race — a single atomic UPDATE via Postgres
// jsonb functions. Added 2026-09-03 for the automation credentials-WRITE
// API (see index.js) — updateSettings() above stays the whole-row replace
// the staff "Редактировать" popup uses; this is the narrower write an
// automated token-refresh flow actually needs: "update just this one
// network, leave literally everything else exactly as it was".
//
// `fields` is SHALLOW-MERGED into whatever's already stored for that
// network — a refresh call can resend just {accessToken, expiresAt} without
// also having to know/resend igUserId, and any older field this call
// doesn't mention survives untouched. `network` must already be validated
// by the caller (index.js) — this function trusts it. `lastRefreshedAt` is
// ALWAYS stamped here server-side (now(), ISO) regardless of what's in
// `fields` — it's meant to be this app's own record of when the credential
// was last written, not something a caller can backdate.
async function upsertNetworkCredentials(boardId, projectId, network, fields) {
  await ensureRow(boardId, projectId);
  const pool = db.requirePool();
  const merged = { ...fields, lastRefreshedAt: new Date().toISOString() };
  const { rows } = await pool.query(
    `UPDATE project_settings
     SET social_credentials = jsonb_set(
           COALESCE(social_credentials, '{}'::jsonb),
           ARRAY[$3::text],
           COALESCE(social_credentials -> $3, '{}'::jsonb) || $4::jsonb,
           true
         ),
         updated_at = now()
     WHERE board_id = $1 AND project_id = $2
     RETURNING social_credentials -> $3 AS updated`,
    [boardId, projectId, network, JSON.stringify(merged)]
  );
  return (rows[0] && rows[0].updated) || merged;
}

// Cross-project "which credentials are expiring soon" lookup — added
// alongside upsertNetworkCredentials above for the same IG-token-refresh
// flow (Business tokens expire every ~60 days; with 10+ accounts, looping
// GET .../credentials once per project just to find out who needs a
// refresh doesn't scale). Reads straight out of the same social_credentials
// jsonb column every project already has — no schema change — and filters
// in JS after a single query rather than a per-network jsonb SQL predicate,
// since the actual row count (a few dozen projects at most) makes that
// simplicity free. NOTE: this still reads the full credentials object
// (including the real secret) out of Postgres into this process, same as
// getSettings() always has — it's index.js's HTTP response that then
// deliberately narrows what actually leaves the server (see the route for
// why); this function itself is just a normal internal read.
//
// `network` null = every known network. `expiringWithinDays`: rows where
// expiresAt <= now() + N days — this ALSO catches anything already expired
// (a past expiresAt is <= any future cutoff too), which is intentional: an
// already-expired credential needs attention at least as urgently as one
// about to expire, so it stays in the same list rather than needing a
// separate call.
async function listExpiringCredentials(boardId, network, expiringWithinDays) {
  const pool = db.requirePool();
  const networks = network ? [network] : KNOWN_NETWORKS;
  const { rows } = await pool.query(
    `SELECT project_id, social_credentials FROM project_settings
     WHERE board_id = $1 AND social_credentials IS NOT NULL AND social_credentials != '{}'::jsonb`,
    [boardId]
  );
  const cutoffMs = Date.now() + expiringWithinDays * 24 * 60 * 60 * 1000;
  const out = [];
  for (const row of rows) {
    const creds = row.social_credentials || {};
    for (const net of networks) {
      const c = creds[net];
      if (!c || !c.expiresAt) continue; // no expiry set for this network = nothing to flag
      const expiresAtMs = Date.parse(c.expiresAt);
      if (Number.isNaN(expiresAtMs) || expiresAtMs > cutoffMs) continue;
      out.push({
        projectId: row.project_id,
        network: net,
        expiresAt: c.expiresAt,
        lastRefreshedAt: c.lastRefreshedAt || null,
      });
    }
  }
  return out;
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
  upsertNetworkCredentials,
  listExpiringCredentials,
  importLegacyFileTokens,
  KNOWN_NETWORKS,
};
