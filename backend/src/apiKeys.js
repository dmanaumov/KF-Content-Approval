// Live (not env-var) registry of machine-to-machine API secrets — the
// actual runtime source of truth for AUTOMATION_API_KEY / BOT_API_KEY /
// GOOGLE_DOCS_API_KEY (and any new one staff define later), backed by
// Postgres and managed from the CEO-only "Управление" tab
// (frontend/api-keys.html, /api/ceo/api-keys* in index.js).
//
// Why this exists: requireAutomationAuth/requireBotAuth used to read
// config.automationApiKey/config.botApiKey directly (static, set once from
// process.env at boot) — rotating a key meant editing the env var in
// Dokploy AND redeploying. Now the CEO can generate/rotate/delete a key
// from the UI and it takes effect on the very next request, no redeploy.
//
// Zero-downtime migration: on first boot after this shipped, ensureSeeded()
// copies whatever was already in config.js's env-var-backed values into
// Postgres (only for keys that HAD a value — nothing to migrate otherwise),
// so an already-working n8n credential keeps working unchanged. From then
// on Postgres is authoritative; the env vars still work as a fallback if
// Postgres is ever unreachable (see getValueSync below), same "never
// hard-fail on a DB hiccup" posture as the rest of this app.
//
// Caching: requireAutomationAuth/requireBotAuth run on EVERY automation
// request, so this keeps an in-memory Map instead of hitting Postgres each
// time. This module is the ONLY writer of api_keys, so the cache is kept in
// lockstep on every write here (upsert/rotate/delete all refresh it
// immediately) — no polling, no staleness window, no invalidation needed
// from anywhere else.

const crypto = require('crypto');
const db = require('./db');
const config = require('./config');

let cache = null; // Map<name, {name,label,value,created_at,updated_at}> | null until first load

const BUILTIN_SEEDS = [
  { name: 'AUTOMATION_API_KEY', label: 'SMM-автоматизация (n8n, публикация постов)', value: () => config.automationApiKey },
  { name: 'BOT_API_KEY', label: 'Telegram-бот «Кот Василий»', value: () => config.botApiKey },
  { name: 'GOOGLE_DOCS_API_KEY', label: 'Google Docs интеграция', value: () => config.googleDocsApiKey },
];

async function ensureSeeded() {
  const pool = db.requirePool();
  for (const seed of BUILTIN_SEEDS) {
    const value = seed.value();
    if (!value) continue; // nothing set in env — nothing to migrate, leave absent
    await pool.query(
      `INSERT INTO api_keys (name, label, value) VALUES ($1, $2, $3) ON CONFLICT (name) DO NOTHING`,
      [seed.name, seed.label, value]
    );
  }
}

async function loadCache() {
  const pool = db.requirePool();
  const { rows } = await pool.query('SELECT name, label, value, created_at, updated_at FROM api_keys ORDER BY name');
  cache = new Map(rows.map((r) => [r.name, r]));
}

async function init() {
  if (!db.pool) return; // DATABASE_URL not set — same "warn and continue" posture as db.initSchema()
  await ensureSeeded();
  await loadCache();
}

// Synchronous on purpose — called from requireAutomationAuth/requireBotAuth
// on every request, can't await a DB round-trip there. Falls back to the
// static env value (config.js) if the cache has nothing for this name yet
// (DB unreachable at boot, or init() hasn't run) — a key someone deleted
// from the UI on purpose stays deleted (cache.has() is true with an absent
// row only through an explicit delete, which also removes it from the
// fallback-eligible set by design: once it exists in Postgres at all, the
// DB value — not the env var — wins).
function getValueSync(name) {
  if (cache && cache.has(name)) return cache.get(name).value;
  if (!cache) {
    const seed = BUILTIN_SEEDS.find((s) => s.name === name);
    if (seed) return seed.value();
  }
  return '';
}

async function listKeys() {
  if (!cache) await loadCache();
  return Array.from(cache.values());
}

const NAME_PATTERN = /^[A-Z][A-Z0-9_]{2,63}$/;

async function upsertKey(name, { label, value }) {
  const trimmedName = String(name || '').trim();
  if (!NAME_PATTERN.test(trimmedName)) {
    throw new Error('Имя ключа — заглавные латинские буквы/цифры/подчёркивание, начиная с буквы, 3-64 символа (как переменная окружения), например MY_INTEGRATION_KEY.');
  }
  const trimmedValue = String(value || '').trim();
  if (!trimmedValue) throw new Error('Значение ключа не может быть пустым.');
  const pool = db.requirePool();
  await pool.query(
    `INSERT INTO api_keys (name, label, value) VALUES ($1, $2, $3)
     ON CONFLICT (name) DO UPDATE SET label = EXCLUDED.label, value = EXCLUDED.value, updated_at = now()`,
    [trimmedName, String(label || ''), trimmedValue]
  );
  await loadCache();
  return cache.get(trimmedName);
}

// "Выпустить новый ключ (обновить — имя прежнее, но новое значение)" — for
// an EXISTING name only; keeps its current label.
async function rotateKey(name) {
  if (!cache) await loadCache();
  const existing = cache.get(name);
  if (!existing) throw new Error(`Ключ "${name}" не найден.`);
  const value = crypto.randomBytes(32).toString('hex');
  return upsertKey(name, { label: existing.label, value });
}

// "Добавить новый параметр" — a brand new named key with an auto-generated
// value; rejects if the name is already taken (use rotateKey to replace an
// existing one's value instead).
async function createKey(name, label) {
  if (!cache) await loadCache();
  const trimmedName = String(name || '').trim();
  if (cache.has(trimmedName)) throw new Error(`Ключ с именем "${trimmedName}" уже существует — используйте «выпустить новый» на нём, чтобы сменить значение.`);
  const value = crypto.randomBytes(32).toString('hex');
  return upsertKey(trimmedName, { label, value });
}

async function deleteKey(name) {
  const pool = db.requirePool();
  await pool.query('DELETE FROM api_keys WHERE name = $1', [name]);
  if (cache) cache.delete(name);
}

module.exports = { init, getValueSync, listKeys, upsertKey, rotateKey, createKey, deleteKey };
