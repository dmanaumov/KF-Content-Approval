// Real drag-and-drop / file-picker upload from the /team cabinet straight to
// disk.kontentferma — the counterpart to diskEmbeds.js, which only ever
// READS an already-existing share link. This module WRITES: puts the file
// on the disk via WebDAV, then creates a public share link for it via
// Nextcloud's OCS Sharing API (the same "https://disk.kontentferma.<tld>/s/<token>"
// shape diskEmbeds.js already knows how to embed) — so the result plugs
// straight into the existing addTeamMediaLink flow in index.js exactly like
// a manually-pasted link would.
//
// Needs config.diskWebdavBaseUrl/diskWebdavUser/diskWebdavPassword set (see
// config.js for the exact shape expected) — uploadAndShare() throws a
// self-diagnosing error (err.code = 'disk_upload_not_configured') if they
// aren't, so the route can tell the user clearly instead of the button just
// silently doing nothing. The manual "paste a link" field stays as the
// fallback either way.

const fetch = require('node-fetch');
const config = require('./config');

// Same bounded-time-to-headers pattern as diskEmbeds.js — node-fetch has no
// default timeout, and a hanging WebDAV/OCS call would otherwise stall the
// whole upload request indefinitely.
function fetchWithTimeout(url, opts, ms) {
  opts = opts || {};
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(url, Object.assign({}, opts, { signal: controller.signal })).finally(() => clearTimeout(timer));
}

function authHeader() {
  return 'Basic ' + Buffer.from(config.diskWebdavUser + ':' + config.diskWebdavPassword).toString('base64');
}

function fetchWithAuth(url, opts) {
  opts = opts || {};
  const headers = Object.assign({}, opts.headers || {}, { Authorization: authHeader() });
  return fetchWithTimeout(url, Object.assign({}, opts, { headers: headers }), config.requestTimeoutMs);
}

// Nextcloud WebDAV paths are percent-encoded per segment (spaces, Cyrillic,
// etc. all need it) — encodeURIComponent per segment, NOT the whole path
// (that would also encode the "/" separators).
function webdavUrl(relPath) {
  const base = config.diskWebdavBaseUrl.replace(/\/+$/, '');
  const parts = relPath.split('/').filter(Boolean).map(encodeURIComponent);
  return base + '/' + parts.join('/');
}

// Strips characters that aren't safe as a single path segment on the disk —
// deliberately permissive otherwise (spaces, Cyrillic, punctuation all pass
// through fine over WebDAV once percent-encoded). Only the handful of
// characters WebDAV/Nextcloud paths can't contain get swapped for "_".
const UNSAFE_SEGMENT_CHARS = ['/', '\\', ':', '*', '?', '"', '<', '>', '|'];
function sanitizeSegment(raw) {
  let s = String(raw || '');
  for (const ch of UNSAFE_SEGMENT_CHARS) s = s.split(ch).join('_');
  s = s.replace(/\s+/g, ' ').trim();
  return s || 'file';
}

// MKCOL each path segment in turn — Nextcloud's WebDAV requires every parent
// directory to already exist before a PUT into it. 201 = created, 405 =
// already exists (both fine); anything else is a real failure worth
// surfacing rather than silently swallowing.
async function ensureRemoteDir(relPath) {
  const segments = relPath.split('/').filter(Boolean);
  let cur = '';
  for (const seg of segments) {
    cur += '/' + seg;
    const res = await fetchWithAuth(webdavUrl(cur), { method: 'MKCOL' });
    if (res.status !== 201 && res.status !== 405) {
      throw new Error('Не удалось создать папку "' + cur + '" на диске (MKCOL, статус ' + res.status + ').');
    }
  }
}

async function putFile(relPath, buffer, mimeType) {
  const headers = mimeType ? { 'Content-Type': mimeType } : {};
  const res = await fetchWithAuth(webdavUrl(relPath), { method: 'PUT', body: buffer, headers: headers });
  if (res.status !== 201 && res.status !== 204) {
    throw new Error('Не удалось загрузить файл на диск (PUT, статус ' + res.status + ').');
  }
}

// OCS Sharing API lives under the site origin, not under the WebDAV files
// root — derived from diskWebdavBaseUrl rather than a second env var, so
// there's only one URL to configure.
async function createPublicShare(relPath) {
  const origin = new URL(config.diskWebdavBaseUrl).origin;
  const body = new URLSearchParams({
    path: '/' + relPath.replace(/^\/+/, ''),
    shareType: '3', // public link
    permissions: '1', // read-only — the team uploads it, nobody needs write access via the share
  });
  const res = await fetchWithAuth(origin + '/ocs/v2.php/apps/files_sharing/api/v1/shares?format=json', {
    method: 'POST',
    headers: { 'OCS-APIRequest': 'true', 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: body.toString(),
  });
  const data = await res.json().catch(() => null);
  const url = data && data.ocs && data.ocs.data && data.ocs.data.url;
  if (!res.ok || !url) {
    const detail = (data && data.ocs && data.ocs.meta && data.ocs.meta.message) || res.status;
    throw new Error('Не удалось создать публичную ссылку на диске (share API: ' + detail + ').');
  }
  return url;
}

// folderName: per-client sub-folder under diskUploadRootPath (e.g. the
// task's projectLabel — "SMM / Кот Василий / ..."). filename: should
// already be a reasonably final, collision-resistant name (the index.js
// route stamps date + a random suffix before calling this).
async function uploadAndShare(opts) {
  const folderName = opts.folderName;
  const filename = opts.filename;
  const buffer = opts.buffer;
  const mimeType = opts.mimeType;
  if (!config.diskWebdavBaseUrl || !config.diskWebdavUser || !config.diskWebdavPassword) {
    const err = new Error(
      'Загрузка на Диск ещё не настроена — нужны DISK_WEBDAV_URL, DISK_WEBDAV_USER, DISK_WEBDAV_PASSWORD в .env (см. комментарий в config.js). Пока можно прикрепить уже готовую ссылку вручную — поле ниже остаётся доступным.'
    );
    err.code = 'disk_upload_not_configured';
    throw err;
  }
  const root = config.diskUploadRootPath || 'SMM';
  const relDir = root + '/' + sanitizeSegment(folderName);
  const relFile = relDir + '/' + sanitizeSegment(filename);
  await ensureRemoteDir(relDir);
  await putFile(relFile, buffer, mimeType);
  return createPublicShare(relFile);
}

module.exports = { uploadAndShare };
