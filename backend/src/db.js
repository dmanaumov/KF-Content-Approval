// Postgres connection + schema bootstrap.
//
// This is the ONE deliberate exception to this app's original "no
// database" design (see README/project docs for the earlier reasoning).
// It became necessary once the agency asked for: (a) the rotatable client
// link to be readable/writable from outside this app too, (b) real
// per-project social-network publishing credentials, and (c) a client logo
// URL — stored so a separate n8n automation can read (a)+(b) directly via
// its own Postgres connection to actually publish approved posts. See
// docs/N8N_AUTOMATION.md for how that automation is meant to use this.
//
// Deliberately NOT used for anything else in this app — task/board data
// still comes live from Mattermost on every request, exactly as before.

const { Pool } = require('pg');
const config = require('./config');

const pool = config.databaseUrl ? new Pool({ connectionString: config.databaseUrl }) : null;

function requirePool() {
  if (!pool) {
    throw new Error(
      'DATABASE_URL is not set — see .env.example. Project settings (client link/logo/social credentials) require Postgres.'
    );
  }
  return pool;
}

// Idempotent (IF NOT EXISTS everywhere) — safe to run on every boot, no
// separate migration step to remember.
async function initSchema() {
  if (!pool) {
    console.warn(
      '[db] DATABASE_URL not set — the client link store, logo/social-credentials editor, and the n8n publication log will not work until it is configured.'
    );
    return;
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS project_settings (
      board_id text NOT NULL,
      project_id text NOT NULL,
      link_token text NOT NULL,
      link_token_updated_at timestamptz NOT NULL DEFAULT now(),
      logo_url text NOT NULL DEFAULT '',
      social_credentials jsonb NOT NULL DEFAULT '{}'::jsonb,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (board_id, project_id)
    );
  `);
  // Idempotent column additions for tables that may predate a field (no
  // separate migration step to remember — same philosophy as the rest of
  // initSchema).
  await pool.query(`
    ALTER TABLE project_settings
      ADD COLUMN IF NOT EXISTS start_date text NOT NULL DEFAULT '',
      ADD COLUMN IF NOT EXISTS posts_per_month text NOT NULL DEFAULT '',
      ADD COLUMN IF NOT EXISTS publish_time_msk text NOT NULL DEFAULT '',
      ADD COLUMN IF NOT EXISTS project_manager text NOT NULL DEFAULT '',
      ADD COLUMN IF NOT EXISTS strategy_prompt text NOT NULL DEFAULT '',
      ADD COLUMN IF NOT EXISTS planning_prompt text NOT NULL DEFAULT '',
      ADD COLUMN IF NOT EXISTS post_prompt text NOT NULL DEFAULT '',
      ADD COLUMN IF NOT EXISTS image_prompt text NOT NULL DEFAULT '';
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS project_settings_link_token_idx
      ON project_settings (link_token);
  `);
  // Client-chosen display order of a post's media (photos/videos), keyed by
  // the ids buildTasks() assigns each media item (see taskMapper.js). This is
  // the other reason (besides project_settings above) this app keeps its own
  // Postgres table: Mattermost has no concept of a custom media order at all
  // — only upload time — so there's nothing on the Mattermost side to persist
  // this into. Written/read by mediaOrder.js only.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS task_media_order (
      board_id text NOT NULL,
      task_id text NOT NULL,
      media_order jsonb NOT NULL DEFAULT '[]'::jsonb,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (board_id, task_id)
    );
  `);
  // Written to by the n8n automation directly (its own Postgres connection,
  // see docs/N8N_AUTOMATION.md) — this app never writes to it itself, only
  // the table needs to exist up front so n8n has somewhere to insert into
  // from its very first run.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS publication_log (
      id bigserial PRIMARY KEY,
      board_id text NOT NULL,
      project_id text NOT NULL,
      task_id text NOT NULL,
      network text,
      status text NOT NULL,
      message text,
      post_url text,
      published_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  // Access analytics — who/when/from-which-device-browser/into-which-project
  // (see analytics.js). Written by this app only; the stats views that read
  // it are a later phase.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS access_log (
      id bigserial PRIMARY KEY,
      ts timestamptz NOT NULL DEFAULT now(),
      role text NOT NULL DEFAULT '',
      visitor_id text NOT NULL DEFAULT '',
      project text NOT NULL DEFAULT '',
      actor text NOT NULL DEFAULT '',
      path text NOT NULL DEFAULT '',
      device text NOT NULL DEFAULT '',
      browser text NOT NULL DEFAULT '',
      ua text NOT NULL DEFAULT ''
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS access_log_ts_idx ON access_log (ts);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS access_log_role_idx ON access_log (role);`);
  await pool.query(`
    ALTER TABLE access_log
      ADD COLUMN IF NOT EXISTS actor_name text NOT NULL DEFAULT '';
  `);
  await pool.query(`
    ALTER TABLE access_log
      ADD COLUMN IF NOT EXISTS device_label text NOT NULL DEFAULT '',
      ADD COLUMN IF NOT EXISTS browser_label text NOT NULL DEFAULT '';
  `);
  // Team-cabinet sessions, persisted so a container restart (redeploy) doesn't
  // log everyone out — the in-memory map in teamAuth.js is rebuilt from here
  // on boot (see teamAuth.restoreSessions). Stores the Mattermost session
  // token + profile the /team APIs need for the session's lifetime (24h).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS team_sessions (
      id text PRIMARY KEY,
      mm_token text NOT NULL,
      user jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS team_sessions_expires_idx ON team_sessions (expires_at);`);
  await ensureN8nRole();
}

// SQL string literal escaping for values that can't be passed as query
// parameters (Postgres doesn't support parameter placeholders inside DDL
// like CREATE ROLE/ALTER ROLE) — doubles embedded single quotes, the
// standard SQL escape.
function pgLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

// Creates (or, on every later boot, just re-syncs the password of) a
// dedicated, least-privilege Postgres role for the n8n publishing
// automation (see docs/N8N_AUTOMATION.md) — SELECT-only on project_settings
// (it needs to read social_credentials to publish), read+write on
// publication_log (it needs to record what it did). Deliberately NOT the
// app's own POSTGRES_USER — that user is the Postgres instance's bootstrap
// superuser (that's how the official postgres:16-alpine image sets up
// POSTGRES_USER), so handing it to a second system would give n8n far more
// access than it needs. Only runs if N8N_DB_PASSWORD is set — leave it
// blank to skip provisioning this role entirely.
async function ensureN8nRole() {
  if (!pool || !config.n8nDbPassword) return;
  const role = config.n8nDbUser;
  // Role names can't be parameterized either — validate against a strict
  // allowlist instead of trusting env content directly before interpolating
  // it into SQL.
  if (!/^[a-z_][a-z0-9_]*$/.test(role)) {
    console.warn(`[db] N8N_DB_USER "${role}" is not a valid Postgres role name (lowercase letters/digits/underscore, starting with a letter or underscore) — skipping n8n role setup.`);
    return;
  }
  const passwordLiteral = pgLiteral(config.n8nDbPassword);
  await pool.query(`
    DO $do$
    BEGIN
      IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = '${role}') THEN
        CREATE ROLE ${role} LOGIN PASSWORD ${passwordLiteral};
      ELSE
        ALTER ROLE ${role} WITH LOGIN PASSWORD ${passwordLiteral};
      END IF;
    END
    $do$;
  `);
  await pool.query(`GRANT SELECT ON project_settings TO ${role};`);
  await pool.query(`GRANT SELECT, INSERT, UPDATE ON publication_log TO ${role};`);
  await pool.query(`GRANT USAGE, SELECT ON SEQUENCE publication_log_id_seq TO ${role};`);
  console.log(`[db] Postgres role "${role}" for n8n is ready (password kept in sync with N8N_DB_PASSWORD on every boot).`);
}

module.exports = { pool, requirePool, initSchema };
