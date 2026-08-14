// Rotatable, revocable client links — "/l/{token}" redirects to the current
// /p/{boardId}?project={projectId}&name={label} URL for a project. Exists
// because the OLD link shape used a project's raw Mattermost option id
// directly, which can never be invalidated: a "Проект" option can't be
// renamed away from a leaked id without breaking every other link to that
// same project too. This gives staff a "regenerate" button on the internal
// projects page — the OLD short link immediately stops resolving, a NEW one
// starts working, without ever touching Mattermost itself.
//
// Persisted to a plain JSON file on disk (agency's explicit choice — see
// config.projectLinksFile) rather than in-memory, so a revoked link STAYS
// revoked across a Dokploy redeploy/restart. This REQUIRES a persistent
// volume mounted at this file's directory (docker-compose.yml mounts one at
// /app/data by default) — without it, Dokploy recreating the container on
// every deploy resets this file too, and "revoking" a link would only last
// until the next deploy.
//
// No database, still — just a small on-disk map, read/written on each call.
// Traffic here is a handful of staff clicks, not client polling, so the
// synchronous file I/O and lack of locking against concurrent regenerate
// calls are an acceptable tradeoff for how small and low-traffic this is.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');

const FILE = config.projectLinksFile;

function readStoreSync() {
  try {
    const raw = fs.readFileSync(FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`[linkTokens] failed to read ${FILE}, starting from an empty store:`, err.message);
    }
    return {};
  }
}

function writeStoreSync(store) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  // Write-then-rename so a crash mid-write can't leave a half-written file
  // for the next request to trip over.
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, FILE);
}

function keyFor(boardId, projectId) {
  return `${boardId}:${projectId}`;
}

function newToken() {
  return crypto.randomBytes(9).toString('base64url'); // 12 URL-safe chars
}

// Returns the current token for a project, creating (and persisting) one on
// first use — so every project has a working link the first time the
// internal projects page loads, with no separate "provision" step.
function getToken(boardId, projectId) {
  const store = readStoreSync();
  const key = keyFor(boardId, projectId);
  if (store[key] && store[key].token) return store[key].token;
  const token = newToken();
  store[key] = { boardId, projectId, token, updatedAt: new Date().toISOString() };
  writeStoreSync(store);
  return token;
}

// Generates and stores a brand new token for a project, overwriting
// (invalidating) whatever token existed before — the old short link starts
// 404ing on its next use, immediately.
function regenerateToken(boardId, projectId) {
  const store = readStoreSync();
  const key = keyFor(boardId, projectId);
  const token = newToken();
  store[key] = { boardId, projectId, token, updatedAt: new Date().toISOString() };
  writeStoreSync(store);
  return token;
}

// token -> { boardId, projectId } | null (null = unknown or revoked token)
function resolveToken(token) {
  if (!token) return null;
  const store = readStoreSync();
  for (const entry of Object.values(store)) {
    if (entry && entry.token === token) return { boardId: entry.boardId, projectId: entry.projectId };
  }
  return null;
}

module.exports = { getToken, regenerateToken, resolveToken };
