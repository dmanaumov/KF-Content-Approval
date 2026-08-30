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
  // Explicit "is this an AI project" toggle — a staff-set checkbox (see the
  // "Настройки" tab's edit popup, next to the logo field), NOT derived from
  // whether the 4 AI prompts below happen to be filled in. Added because the
  // old prompts-filled-ness heuristic (see aiStatusOf() in projectSettings.js)
  // misclassifies real projects as new AI clients start appearing — a
  // project shouldn't light up as "AI" just because someone pasted text into
  // a prompt box, and a real AI project should show as "needs attention"
  // (not "regular project") even before any prompt is filled in yet. This
  // column is now the ground truth; aiStatusOf() only distinguishes
  // fully-configured vs needs-attention AMONG projects already flagged here.
  await pool.query(`
    ALTER TABLE project_settings
      ADD COLUMN IF NOT EXISTS is_ai_project boolean NOT NULL DEFAULT false;
  `);
  // "Проект в архиве" toggle (staff-set, same "Настройки" tab of the edit
  // popup as is_ai_project above) — projects on pause that the team still
  // wants on record but doesn't want cluttering the default staff list. Ground
  // truth for the /projects "Архивные проекты" checkbox filter and the grey
  // "АРХИВНЫЙ" badge (see frontend/projects.js). Deliberately independent of
  // is_ai_project — a project can be archived and AI-flagged at once.
  await pool.query(`
    ALTER TABLE project_settings
      ADD COLUMN IF NOT EXISTS is_archived boolean NOT NULL DEFAULT false;
  `);
  // Референсы для генерации картинок (до 10 ссылок на изображения — либо
  // вставлены вручную, либо загружены через POST /api/projects/:id/
  // reference-upload на disk.kontentferma в подпапку "референсы", см.
  // diskUpload.js). Читается автоматизацией через GET /api/automation/
  // projects/:projectId/settings (getAutomationProjectSettings в index.js)
  // как материал для генерации картинок в чат клиента.
  await pool.query(`
    ALTER TABLE project_settings
      ADD COLUMN IF NOT EXISTS image_references jsonb NOT NULL DEFAULT '[]'::jsonb;
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
  // NB: the profile column is user_data, NOT "user" — in Postgres bare `user`
  // is a keyword alias for current_user(), so `SELECT user` silently returns
  // the DB role name instead of the column. This burned us once: sessions were
  // restored with a garbage "user", which looked like everyone was logged out.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS team_sessions (
      id text PRIMARY KEY,
      mm_token text NOT NULL,
      user_data jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL
    );
  `);
  await pool.query(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'team_sessions' AND column_name = 'user') THEN
        ALTER TABLE team_sessions RENAME COLUMN "user" TO user_data;
      END IF;
    END $$;
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS team_sessions_expires_idx ON team_sessions (expires_at);`);
  // Internal team discussion on a post — deliberately NOT stored as
  // Mattermost card comments: those are reserved for the client-feedback
  // convention taskMapper.js already relies on (feedbackAuthorUsername +
  // status==='changes' gating, see index.js buildTasks callers). Mixing
  // team chatter into the same comment stream would both leak into that
  // client-facing surface and make "which comment is client feedback"
  // ambiguous. Team-only, own table, own read/write path (teamComments.js).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS task_team_comments (
      id bigserial PRIMARY KEY,
      board_id text NOT NULL,
      task_id text NOT NULL,
      author_id text NOT NULL DEFAULT '',
      author_name text NOT NULL DEFAULT '',
      text text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS task_team_comments_task_idx ON task_team_comments (board_id, task_id);`);
  // A team chat message can carry one attached photo (uploaded straight to
  // disk.kontentferma via diskUpload.js, same as the Медиа-tab dropzone) —
  // see teamComments.js/frontend team.js "ЧАТ КОМАНДЫ". Idempotent add, same
  // philosophy as the rest of initSchema.
  await pool.query(`
    ALTER TABLE task_team_comments
      ADD COLUMN IF NOT EXISTS image_url text NOT NULL DEFAULT '';
  `);
  // Who actually clicked "Запланировать публикацию" in the /team cabinet.
  // Mattermost's own block.createdBy is USELESS for this: this app talks to
  // Mattermost as ONE shared service account (MATTERMOST_LOGIN_ID or
  // MATTERMOST_TOKEN, see mattermostClient.js) for every write it makes, so
  // createdBy on every card this app creates is always that same shared
  // account — never the real team member. This table is the only place that
  // actually knows who created a given card. Written once, best-effort, by
  // POST /api/team/tasks right after a card is created (see taskCreators.js);
  // read by GET /api/team/tasks so a card's creator sees it in their list
  // even when they're not the assignee (per the team's request). If this
  // write ever fails, the card still exists — the creator just won't get
  // the "I made this" visibility bonus, they'll still see it if/when
  // they're also the assignee (which POST /api/team/tasks always sets).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS task_creators (
      board_id text NOT NULL,
      task_id text NOT NULL,
      creator_user_id text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (board_id, task_id)
    );
  `);
  // Бот «Кот Василий» (Telegram) — куда он добавлен + переписка с ним.
  // Отдельная подсистема от project_settings/publication_log выше: тот же
  // Postgres, но пишет и читает через свой собственный ключ (BOT_API_KEY /
  // X-Bot-Key, см. requireBotAuth в index.js), НЕ через AUTOMATION_API_KEY
  // n8n-потока публикаций — чтобы у Telegram-бота был свой независимый
  // канал доступа, который можно ротировать/отозвать отдельно.
  //
  // chat_id хранится как text (не bigint/numeric) — Telegram присылает его и
  // числом, и строкой в зависимости от узла n8n, а сравнивать/JOIN-ить проще
  // и безопаснее строкой, не тратя силы на нормализацию типов на каждом
  // запросе.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bot_chats (
      chat_id text PRIMARY KEY,
      chat_type text NOT NULL DEFAULT '',
      title text NOT NULL DEFAULT '',
      status text NOT NULL DEFAULT '',
      added_by_user_id text NOT NULL DEFAULT '',
      added_by_name text NOT NULL DEFAULT '',
      added_by_username text NOT NULL DEFAULT '',
      first_seen_at timestamptz NOT NULL DEFAULT now(),
      status_updated_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  // Переписка (личные чаты — потенциальные лиды) + очередь исходящих.
  // direction: 'in' (пришло от пользователя) | 'out' (написали от имени
  // бота). Для 'out' status идёт pending → sent/failed — исходящее НЕ
  // отправляется этим приложением напрямую (у него нет токена бота), только
  // складывается в очередь; n8n вычитывает через GET /api/bot/messages/
  // outgoing, реально шлёт через Telegram Bot API своим credential'ом и
  // отчитывается через POST /api/bot/messages/:id/ack. Для 'in' status всегда
  // 'received' — эти строки только читаются.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bot_messages (
      id bigserial PRIMARY KEY,
      chat_id text NOT NULL,
      direction text NOT NULL,
      status text NOT NULL DEFAULT 'received',
      telegram_message_id text NOT NULL DEFAULT '',
      from_user_id text NOT NULL DEFAULT '',
      from_name text NOT NULL DEFAULT '',
      from_username text NOT NULL DEFAULT '',
      text text NOT NULL DEFAULT '',
      sent_by text NOT NULL DEFAULT '',
      error text NOT NULL DEFAULT '',
      created_at timestamptz NOT NULL DEFAULT now(),
      sent_at timestamptz
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS bot_messages_chat_idx ON bot_messages (chat_id, created_at);`);
  // Частичный индекс — быстрая выборка «что ещё не отправлено» для n8n-поллинга,
  // не сканируя всю историю переписки на каждый тик.
  await pool.query(`
    CREATE INDEX IF NOT EXISTS bot_messages_pending_out_idx
      ON bot_messages (created_at)
      WHERE direction = 'out' AND status = 'pending';
  `);
  // Живой (не env-var) реестр секретов для машинных интеграций — заменяет
  // AUTOMATION_API_KEY/BOT_API_KEY/GOOGLE_DOCS_API_KEY как источник правды
  // на лету, без редеплоя: см. apiKeys.js. При старте seed'ится из тех же
  // env-переменных (см. apiKeys.ensureSeeded), так что уже настроенные
  // интеграции продолжают работать без ручной миграции. Управляется через
  // CEO-only вкладку "Управление" (/ceo/api-keys).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS api_keys (
      name text PRIMARY KEY,
      label text NOT NULL DEFAULT '',
      value text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);
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
