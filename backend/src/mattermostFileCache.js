// Local on-disk cache for Mattermost board attachments, served via
// /api/files/:boardId/:fileId (2026-10-01).
//
// Why: that route used to proxy EVERY view and EVERY seek of EVERY
// photo/video straight through to Mattermost's Boards file storage on
// TeastyMenu-prod — a 2 CPU / 4GB RAM box already documented as running
// Mattermost+Postgres, Nextcloud, Dokploy itself, mail, two VPNs and a PBX
// all at once, and already OOM-killed at least once (see
// claude/mattermost-boards-oom.md). The same host's disk.kontentferma side
// was separately measured at ~1-1.4 MB/s effective throughput
// (claude/disk-kontentferma-slow-media.md) — at that speed a 15-20MB video
// takes exactly the 10-20s viewers were seeing, and it took that long on
// EVERY open, not just the first.
//
// Fix: this is an exact port of diskCache.js's pattern — a file's bytes
// never change once attached to a card, so each one is downloaded from
// Mattermost ONCE (freeing the slow path quickly) and served from local
// disk — including Range/seek — for every request after that.
//
// Files are named `<boardId>_<fileId>` — both are validated by Mattermost's
// own ID shape upstream (route params, alphanumeric) and never touch the
// filesystem unescaped beyond that join, same as diskCache.js's token.

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { pipeline } = require('stream/promises');
const config = require('./config');
const mm = require('./mattermostClient');

const dir = config.mmFileCacheDir;
let dirReady = null;
function ensureDir() {
  if (!dirReady) dirReady = fsp.mkdir(dir, { recursive: true }).catch((err) => {
    dirReady = null;
    throw err;
  });
  return dirReady;
}

function keyOf(boardId, fileId) {
  return `${boardId}_${fileId}`;
}

function paths(boardId, fileId) {
  const k = keyOf(boardId, fileId);
  return { data: path.join(dir, `${k}.bin`), meta: path.join(dir, `${k}.json`) };
}

// Returns { file, contentType, size, etag, lastModified } or null.
async function lookup(boardId, fileId) {
  if (!config.mmFileCacheEnabled) return null;
  const p = paths(boardId, fileId);
  try {
    const meta = JSON.parse(await fsp.readFile(p.meta, 'utf8'));
    const st = await fsp.stat(p.data);
    if (meta.size != null && st.size !== meta.size) return null; // corrupt/partial
    const now = new Date();
    fsp.utimes(p.data, now, now).catch(() => {}); // LRU touch
    return { ...meta, file: p.data };
  } catch (e) {
    return null;
  }
}

// --- download (deduplicated per key, bounded concurrency) ----------------

const inFlight = new Map(); // key -> Promise<entry|null>
// Keys known to exceed MM_FILE_CACHE_MAX_FILE_MB — skip re-probing them on
// every request (in-memory only; a restart re-learns it on first view).
const tooBig = new Set();
let active = 0;
const waiters = [];
async function withSlot(fn) {
  if (active >= config.mmFileCacheMaxConcurrent) await new Promise((r) => waiters.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    const next = waiters.shift();
    if (next) next();
  }
}

async function download(boardId, fileId) {
  await ensureDir();
  const p = paths(boardId, fileId);
  const tmp = `${p.data}.${process.pid}.${Date.now()}.part`;
  try {
    // No Range header here — always pull the full file once so every later
    // request (including the first Range request) can be served from disk.
    const res = await mm.fetchFileStream(boardId, fileId);
    if (res.status !== 200) {
      res.body && res.body.resume && res.body.resume();
      throw new Error(`upstream HTTP ${res.status}`);
    }
    const len = parseInt(res.headers.get('content-length') || '', 10);
    const maxBytes = config.mmFileCacheMaxFileMb * 1024 * 1024;
    if (Number.isFinite(len) && len > maxBytes) {
      tooBig.add(keyOf(boardId, fileId));
      return null; // too big to cache — caller keeps streaming passthrough
    }
    await pipeline(res.body, fs.createWriteStream(tmp));
    const st = await fsp.stat(tmp);
    if (Number.isFinite(len) && st.size !== len) throw new Error(`short read ${st.size}/${len}`);
    const meta = {
      contentType: (res.headers.get('content-type') || 'application/octet-stream').split(';')[0].trim(),
      size: st.size,
      etag: res.headers.get('etag') || '',
      lastModified: res.headers.get('last-modified') || '',
      cachedAt: new Date().toISOString(),
    };
    await fsp.rename(tmp, p.data);
    await fsp.writeFile(p.meta, JSON.stringify(meta));
    evictSoon();
    return { ...meta, file: p.data };
  } finally {
    fsp.unlink(tmp).catch(() => {});
  }
}

// Starts (or joins) the one download for this file. Never rejects —
// resolves null on any failure so callers just fall back to passthrough;
// failures are not remembered, the next request tries again.
function ensureCached(boardId, fileId) {
  if (!config.mmFileCacheEnabled) return Promise.resolve(null);
  const k = keyOf(boardId, fileId);
  if (tooBig.has(k)) return Promise.resolve(null);
  if (inFlight.has(k)) return inFlight.get(k);
  const p = (async () => {
    const hit = await lookup(boardId, fileId);
    if (hit) return hit;
    return withSlot(() => download(boardId, fileId));
  })()
    .catch((err) => {
      console.warn(`[mm-file-cache] ${k} not cached: ${err.message}`);
      return null;
    })
    .finally(() => inFlight.delete(k));
  inFlight.set(k, p);
  return p;
}

// --- eviction -------------------------------------------------------------

let evictTimer = null;
function evictSoon() {
  if (evictTimer) return;
  evictTimer = setTimeout(() => {
    evictTimer = null;
    evict().catch((err) => console.warn('[mm-file-cache] evict failed:', err.message));
  }, 5000);
}

async function evict() {
  const limit = config.mmFileCacheMaxMb * 1024 * 1024;
  const names = (await fsp.readdir(dir)).filter((n) => n.endsWith('.bin'));
  const files = [];
  let total = 0;
  for (const n of names) {
    try {
      const st = await fsp.stat(path.join(dir, n));
      files.push({ n, size: st.size, mtime: st.mtimeMs });
      total += st.size;
    } catch (e) {}
  }
  if (total <= limit) return;
  files.sort((a, b) => a.mtime - b.mtime);
  for (const f of files) {
    if (total <= limit * 0.9) break;
    const base = f.n.slice(0, -4);
    await fsp.unlink(path.join(dir, f.n)).catch(() => {});
    await fsp.unlink(path.join(dir, `${base}.json`)).catch(() => {});
    total -= f.size;
  }
}

// Clean stale .part files from a previous crash at startup.
async function init() {
  if (!config.mmFileCacheEnabled) return;
  try {
    await ensureDir();
    for (const n of await fsp.readdir(dir)) {
      if (n.endsWith('.part')) await fsp.unlink(path.join(dir, n)).catch(() => {});
    }
    evictSoon();
  } catch (err) {
    console.warn('[mm-file-cache] init failed, caching disabled for now:', err.message);
  }
}

module.exports = { lookup, ensureCached, init };
