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
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS project_settings_link_token_idx
      ON project_settings (link_token);
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
}

module.exports = { pool, requirePool, initSchema };
