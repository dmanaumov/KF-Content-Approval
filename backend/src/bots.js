// Registry of our Telegram bots ("Кот Василий" today, more later) —
// presentational only: name + @username, nothing secret. The actual bot
// token/credential lives in n8n/Telegram, same as everywhere else in this
// app (see the big comment on config.botApiKey) — this table exists purely
// so staff picking a publish destination in project settings can see and
// copy the right bot's @username, instead of that living only in someone's
// head or in an old Telegram chat.
//
// Deliberately NOT linked yet from bot_chats (no bot_id column there) —
// today there's exactly one bot, so every known chat is unambiguously
// "this bot's". That link is real, planned work for whenever a second bot
// actually shows up (see project notes) — adding it now, before there's a
// second bot to test against, would be speculative and untestable.
//
// Managed from the CEO-only "Управление" tab (frontend/api-keys.html,
// /api/ceo/bots* in index.js) — same page as the API-key registry, same
// owner-only gate.

const db = require('./db');

// First-boot convenience: give the CEO one row to fill in (name pre-filled,
// username left blank for them to paste in) instead of an empty table and
// a mandatory "add your first bot" step. Guarded by "table is empty", not
// by name, since bot names aren't unique — safe to run on every boot.
async function ensureSeeded() {
  const pool = db.requirePool();
  await pool.query(
    `INSERT INTO bots (name, username)
     SELECT 'Кот Василий', ''
     WHERE NOT EXISTS (SELECT 1 FROM bots)`
  );
}

async function listBots({ activeOnly = false } = {}) {
  const pool = db.requirePool();
  const { rows } = await pool.query(
    activeOnly
      ? `SELECT id, name, username, is_active, created_at, updated_at FROM bots WHERE is_active ORDER BY name`
      : `SELECT id, name, username, is_active, created_at, updated_at FROM bots ORDER BY name`
  );
  return rows;
}

function normalizeUsername(value) {
  return String(value || '').trim().replace(/^@+/, '');
}

async function createBot({ name, username }) {
  const cleanName = String(name || '').trim();
  if (!cleanName) throw new Error('Имя бота обязательно.');
  const pool = db.requirePool();
  const { rows } = await pool.query(
    `INSERT INTO bots (name, username) VALUES ($1, $2) RETURNING *`,
    [cleanName, normalizeUsername(username)]
  );
  return rows[0];
}

async function updateBot(id, { name, username, isActive } = {}) {
  const pool = db.requirePool();
  const { rows: existingRows } = await pool.query(`SELECT * FROM bots WHERE id = $1`, [id]);
  const existing = existingRows[0];
  if (!existing) throw new Error('Бот не найден.');

  const nextName = name == null ? existing.name : String(name).trim();
  if (!nextName) throw new Error('Имя бота обязательно.');
  const nextUsername = username == null ? existing.username : normalizeUsername(username);
  const nextActive = isActive == null ? existing.is_active : !!isActive;

  const { rows } = await pool.query(
    `UPDATE bots SET name = $2, username = $3, is_active = $4, updated_at = now() WHERE id = $1 RETURNING *`,
    [id, nextName, nextUsername, nextActive]
  );
  return rows[0];
}

async function deleteBot(id) {
  const pool = db.requirePool();
  await pool.query(`DELETE FROM bots WHERE id = $1`, [id]);
}

module.exports = { ensureSeeded, listBots, createBot, updateBot, deleteBot };
