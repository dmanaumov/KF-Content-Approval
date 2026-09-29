// Local on-disk cache for disk.kontentferma share files (2026-09-30).
//
// Why: /api/disk-embed used to proxy EVERY request (every video seek, every
// repeat view, every viewer) straight through to Nextcloud on TeastyMenu-prod
// (Russia) from this server (Germany), each one as two PHP requests
// (/s/<t>/download → 303 → /public.php/dav/files/<t>). A paused video kept
// its upstream request open for minutes, holding one of only 20 Apache/PHP
// workers on the Nextcloud side — a handful of open videos exhausted the
// pool and every other disk.kontentferma user (web UI, PDF downloads) queued
// behind them. Confirmed from the Nextcloud access log 2026-09-29: 5-minute
// requests from this server, 20+ second waits on trivial redirects.
//
// Fix: a share token's bytes never change once uploaded, so each file is
// downloaded from Nextcloud ONCE, at full speed (the PHP worker is freed in
// seconds, not held for as long as a viewer keeps the tab open), stored
// here, and every request after that — including Range/seek — is served
// from local disk via res.sendFile without touching Nextcloud at all.
//
// Files are named by share token (validated [A-Za-z0-9]+ upstream, so safe
// as a filename). Eviction: least-recently-used by mtime (touched on every
// hit) once the total exceeds DISK_CACHE_MAX_MB.

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { pipeline } = require('stream/promises');
const fetch = require('node-fetch');
const config = require('./config');

const dir = config.diskCacheDir;
let dirReady = null;
function ensureDir() {
  if (!dirReady) dirReady = fsp.mkdir(dir, { recursive: true }).catch((err) => {
    dirReady = null;
    throw err;
  });
  return dirReady;
}

function tokenOf(shareUrl) {
  return shareUrl.split('/s/')[1];
}

// Direct WebDAV URL of a public share — the same place Nextcloud's
// /s/<token>/download 303-redirects to, minus one PHP round trip.
function davUrlFor(shareUrl) {
  const u = new URL(shareUrl);
  return `${u.protocol}//${u.host}/public.php/dav/files/${tokenOf(shareUrl)}`;
}

function paths(shareUrl) {
  const t = tokenOf(shareUrl);
  return { data: path.join(dir, `${t}.bin`), meta: path.join(dir, `${t}.json`) };
}

// Returns { file, contentType, size, name, etag, lastModified } or null.
async function lookup(shareUrl) {
  if (!config.diskCacheEnabled) return null;
  const p = paths(shareUrl);
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

// --- download (deduplicated per token, bounded concurrency) --------------

const inFlight = new Map(); // token -> Promise<entry|null>
// Tokens known to exceed DISK_CACHE_MAX_FILE_MB — skip re-probing them on
// every request (in-memory only; a restart re-learns it on first view).
const tooBig = new Set();
let active = 0;
const waiters = [];
async function withSlot(fn) {
  if (active >= config.diskCacheMaxConcurrent) await new Promise((r) => waiters.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    const next = waiters.shift();
    if (next) next();
  }
}

async function download(shareUrl) {
  await ensureDir();
  const p = paths(shareUrl);
  const tmp = `${p.data}.${process.pid}.${Date.now()}.part`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.diskCacheDownloadTimeoutMs);
  try {
    const res = await fetch(davUrlFor(shareUrl), { signal: controller.signal });
    if (res.status !== 200) {
      res.body.resume();
      throw new Error(`upstream HTTP ${res.status}`);
    }
    const len = parseInt(res.headers.get('content-length') || '', 10);
    const maxBytes = config.diskCacheMaxFileMb * 1024 * 1024;
    if (Number.isFinite(len) && len > maxBytes) {
      tooBig.add(tokenOf(shareUrl));
      controller.abort();
      return null; // too big to cache — caller keeps streaming passthrough
    }
    await pipeline(res.body, fs.createWriteStream(tmp));
    const st = await fsp.stat(tmp);
    if (Number.isFinite(len) && st.size !== len) throw new Error(`short read ${st.size}/${len}`);
    const disposition = res.headers.get('content-disposition') || '';
    const nameMatch = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
    const meta = {
      contentType: (res.headers.get('content-type') || 'application/octet-stream').split(';')[0].trim(),
      size: st.size,
      name: nameMatch ? safeDecode(nameMatch[1]) : '',
      etag: res.headers.get('etag') || '',
      lastModified: res.headers.get('last-modified') || '',
      cachedAt: new Date().toISOString(),
    };
    await fsp.rename(tmp, p.data);
    await fsp.writeFile(p.meta, JSON.stringify(meta));
    evictSoon();
    return { ...meta, file: p.data };
  } finally {
    clearTimeout(timer);
    fsp.unlink(tmp).catch(() => {});
  }
}

function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch (e) {
    return s;
  }
}

// Starts (or joins) the one download for this share. Never rejects —
// resolves null on any failure so callers just fall back to passthrough;
// failures are not remembered, the next request tries again.
function ensureCached(shareUrl) {
  if (!config.diskCacheEnabled) return Promise.resolve(null);
  const t = tokenOf(shareUrl);
  if (tooBig.has(t)) return Promise.resolve(null);
  if (inFlight.has(t)) return inFlight.get(t);
  const p = (async () => {
    const hit = await lookup(shareUrl);
    if (hit) return hit;
    return withSlot(() => download(shareUrl));
  })()
    .catch((err) => {
      console.warn(`[disk-cache] ${t} not cached: ${err.message}`);
      return null;
    })
    .finally(() => inFlight.delete(t));
  inFlight.set(t, p);
  return p;
}

// --- eviction -------------------------------------------------------------

let evictTimer = null;
function evictSoon() {
  if (evictTimer) return;
  evictTimer = setTimeout(() => {
    evictTimer = null;
    evict().catch((err) => console.warn('[disk-cache] evict failed:', err.message));
  }, 5000);
}

async function evict() {
  const limit = config.diskCacheMaxMb * 1024 * 1024;
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
  if (!config.diskCacheEnabled) return;
  try {
    await ensureDir();
    for (const n of await fsp.readdir(dir)) {
      if (n.endsWith('.part')) await fsp.unlink(path.join(dir, n)).catch(() => {});
    }
    evictSoon();
  } catch (err) {
    console.warn('[disk-cache] init failed, caching disabled for now:', err.message);
  }
}

module.exports = { lookup, ensureCached, davUrlFor, init };
