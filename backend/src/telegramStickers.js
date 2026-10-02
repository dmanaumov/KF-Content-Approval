// Telegram Bot API client for the sticker-catalog feature (2026-10-01) —
// see the big comment in db.js above the telegram_stickers table for why
// this exists. Two calls only, both read-only and public (neither requires
// the querying bot to own or administer the pack):
//
//   getStickerSet(name) — resolves a sticker pack's short name (the part
//   after https://t.me/addemoji/ or https://t.me/addstickers/) to its full
//   contents: each sticker's custom_emoji_id, fallback emoji, file_id, and
//   (for a static/animated custom-emoji pack) a thumbnail file_id.
//
//   getFile(fileId) — resolves a file_id to a downloadable file_path, used
//   here only for thumbnails (actual sticker FILES are never needed —
//   staff just need to see which sticker is which to pick one; what gets
//   sent to Telegram at publish time is the custom_emoji_id, by n8n).
//
// The token is a SEPARATE credential from BOT_API_KEY — see the comment on
// it in apiKeys.js (BUILTIN_SEEDS) if this gets confused again (it has
// been). Read the same way AUTOMATION_API_KEY/BOT_API_KEY are in index.js's
// requireAutomationAuth/requireBotAuth: live value from the Postgres-backed
// registry (apiKeys.js — editable from the CEO-only "Управление" tab,
// /ceo/api-keys, no redeploy needed), falling back to the env var
// (config.telegramBotToken) only if nothing is set there yet.

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { pipeline } = require('stream/promises');
const fetch = require('node-fetch');
const config = require('./config');
const apiKeys = require('./apiKeys');

const API_TIMEOUT_MS = 15000;

function fetchWithTimeout(url, opts = {}, ms = API_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(url, { ...opts, signal: controller.signal }).finally(() => clearTimeout(timer));
}

function requireToken() {
  const token = apiKeys.getValueSync('TELEGRAM_BOT_TOKEN') || config.telegramBotToken;
  if (!token) {
    throw new Error('TELEGRAM_BOT_TOKEN не задан — задайте токен любого Telegram-бота в «Управление ключами» (/ceo/api-keys) или в настройках сервера.');
  }
  return token;
}

function apiUrl(method) {
  return `https://api.telegram.org/bot${requireToken()}/${method}`;
}

async function callApi(method, params) {
  const url = `${apiUrl(method)}?${new URLSearchParams(params).toString()}`;
  const res = await fetchWithTimeout(url);
  const body = await res.json().catch(() => null);
  if (!res.ok || !body || body.ok !== true) {
    const desc = (body && body.description) || `HTTP ${res.status}`;
    throw new Error(`Telegram ${method} failed: ${desc}`);
  }
  return body.result;
}

// Accepts either a bare short name OR the full StickersBot link (with or
// without https://, addstickers OR addemoji, trailing slash/query string —
// whatever a copy-paste off the "Получить ссылку" button in Telegram
// happens to include). Added 2026-10-02 after a live bug report: pasting
// the full link "https://t.me/addemoji/<name>" into the «короткое имя»
// field sent the ENTIRE URL to Telegram's getStickerSet as `name`, which
// always answers "Bad Request: STICKERSET_INVALID" for that — the Bot API
// only ever accepts the bare short name, never the link around it.
function normalizePackName(input) {
  const raw = String(input || '').trim();
  const linkMatch = raw.match(/t\.me\/(?:addstickers|addemoji)\/([A-Za-z0-9_]+)/i);
  if (linkMatch) return linkMatch[1];
  return raw.replace(/^@/, '').split(/[?#]/)[0].replace(/\/+$/, '');
}

// Returns { title, stickers: [{ customEmojiId, emoji, fileId, fileUniqueId, thumbFileId }] }.
// Only custom-emoji stickers carry custom_emoji_id — a short name that turns
// out to be a REGULAR sticker pack (not a custom-emoji pack, e.g. added via
// addstickers instead of addemoji) is filtered down to an empty list rather
// than erroring, since there is nothing usable in a post's text either way.
async function fetchStickerSet(shortName) {
  const name = normalizePackName(shortName);
  if (!name) throw new Error('Не указано имя стикерпака.');
  const result = await callApi('getStickerSet', { name });
  const stickers = (result.stickers || [])
    .filter((s) => s.custom_emoji_id)
    .map((s) => ({
      customEmojiId: s.custom_emoji_id,
      emoji: s.emoji || '🙂',
      fileId: s.file_id,
      fileUniqueId: s.file_unique_id,
      thumbFileId: (s.thumbnail && s.thumbnail.file_id) || (s.thumb && s.thumb.file_id) || s.file_id,
    }));
  return { title: result.title || name, stickers };
}

// Resolves a file_id to a direct-download URL (file_path is short-lived in
// theory but Telegram does not actually expire these in practice for a bot
// token that stays valid — same assumption diskCache.js makes about share
// links never changing bytes once issued).
async function resolveFileUrl(fileId) {
  const file = await callApi('getFile', { file_id: fileId });
  if (!file.file_path) throw new Error('Telegram getFile: пустой file_path.');
  return `https://api.telegram.org/file/bot${requireToken()}/${file.file_path}`;
}

// --- thumbnail disk cache (tiny files, no eviction needed) ---------------

const dir = config.telegramStickerCacheDir;
let dirReady = null;
function ensureDir() {
  if (!dirReady) dirReady = fsp.mkdir(dir, { recursive: true }).catch((err) => {
    dirReady = null;
    throw err;
  });
  return dirReady;
}

function pathsFor(customEmojiId) {
  return {
    data: path.join(dir, `${customEmojiId}.bin`),
    meta: path.join(dir, `${customEmojiId}.json`),
  };
}

async function lookupThumb(customEmojiId) {
  const p = pathsFor(customEmojiId);
  try {
    const meta = JSON.parse(await fsp.readFile(p.meta, 'utf8'));
    await fsp.stat(p.data);
    return { ...meta, file: p.data };
  } catch (e) {
    return null;
  }
}

const inFlight = new Map(); // customEmojiId -> Promise<entry|null>

// Downloads (or joins an in-progress download of) one sticker's thumbnail,
// deduplicated per customEmojiId. Never rejects — resolves null on failure
// so callers can fall back to just showing the fallback emoji character.
function ensureThumbCached(customEmojiId, thumbFileId) {
  if (inFlight.has(customEmojiId)) return inFlight.get(customEmojiId);
  const p = (async () => {
    const hit = await lookupThumb(customEmojiId);
    if (hit) return hit;
    await ensureDir();
    const paths = pathsFor(customEmojiId);
    const tmp = `${paths.data}.${process.pid}.${Date.now()}.part`;
    const url = await resolveFileUrl(thumbFileId);
    const res = await fetchWithTimeout(url, {}, 20000);
    if (!res.ok) throw new Error(`thumbnail download HTTP ${res.status}`);
    await pipeline(res.body, fs.createWriteStream(tmp));
    const meta = {
      contentType: res.headers.get('content-type') || 'image/webp',
    };
    await fsp.rename(tmp, paths.data);
    await fsp.writeFile(paths.meta, JSON.stringify(meta));
    return { ...meta, file: paths.data };
  })()
    .catch((err) => {
      console.warn(`[telegram-stickers] thumb ${customEmojiId} not cached: ${err.message}`);
      return null;
    })
    .finally(() => inFlight.delete(customEmojiId));
  inFlight.set(customEmojiId, p);
  return p;
}

module.exports = { fetchStickerSet, resolveFileUrl, lookupThumb, ensureThumbCached, normalizePackName };
