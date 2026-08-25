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
  return fetchWithTimeout(url, Object.assign({}, opts, { headers: headers }), config.diskWebdavTimeoutMs);
}

// Nextcloud's own bruteforce/rate-limit protection can answer a WebDAV/OCS
// call with 429 — and, characteristic of that protection, it DELAYS the 429
// itself (tens of seconds) instead of rejecting instantly, as an
// anti-bruteforce throttle. Confirmed live in production (2026-08-25):
// createPublicShare() got "share API: 429" after 22-28 seconds under a burst
// of concurrent uploads, and most of the burst failed the same way. A 429 is
// exactly the case where retrying (ideally after backing off) is the right
// response rather than giving up immediately — so every WebDAV/OCS call goes
// through this wrapper: on 429 it waits (honoring the server's Retry-After
// header when present, otherwise a fixed backoff) and tries once more before
// surfacing the failure. See also MEDIA_UPLOAD_MAX_CONCURRENT in index.js,
// which reduces how often this gets triggered in the first place.
// `label` is just for the [disk:429] debug line below (which WebDAV/OCS step
// this was) — not sent to Nextcloud.
async function fetchWithAuthRetry429(url, opts, attempts, label) {
  attempts = attempts || 2;
  let res;
  for (let i = 0; i < attempts; i++) {
    res = await fetchWithAuth(url, opts);
    if (res.status !== 429) return res;
    // Temporary diagnostic (same DEBUG_MATTERMOST flag as everything else
    // under config.debug) — added 2026-08-25 because our blind retry
    // (fixed ~4-8s backoff) is clearly NOT outlasting whatever is rate-
    // limiting us: real traffic still gets 429 even on the retry attempt.
    // Logs whatever Nextcloud actually says — a real Retry-After value (if
    // it sends one) tells us the true lockout window instead of guessing;
    // the body sometimes names the specific limiter/rule that tripped.
    // res.clone() so this never consumes the body the caller still needs.
    if (config.debug) {
      let bodyPreview = '';
      try {
        bodyPreview = (await res.clone().text()).slice(0, 500);
      } catch (_e) {
        bodyPreview = '(не удалось прочитать тело)';
      }
      console.log(
        `[disk:429] ${label || url} — попытка ${i + 1}/${attempts}; Retry-After: ${res.headers.get('retry-after') || '(отсутствует)'}; тело: ${bodyPreview}`
      );
    }
    if (i < attempts - 1) {
      const retryAfterHeader = res.headers.get('retry-after');
      const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : NaN;
      const delayMs = Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? retryAfterMs : 4000 * (i + 1);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return res;
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
    const res = await fetchWithAuthRetry429(webdavUrl(cur), { method: 'MKCOL' }, undefined, 'MKCOL');
    if (res.status !== 201 && res.status !== 405) {
      throw new Error('Не удалось создать папку "' + cur + '" на диске (MKCOL, статус ' + res.status + ').');
    }
  }
}

async function putFile(relPath, buffer, mimeType) {
  const headers = mimeType ? { 'Content-Type': mimeType } : {};
  const res = await fetchWithAuthRetry429(webdavUrl(relPath), { method: 'PUT', body: buffer, headers: headers }, undefined, 'PUT');
  if (res.status !== 201 && res.status !== 204) {
    throw new Error('Не удалось загрузить файл на диск (PUT, статус ' + res.status + ').');
  }
}

// Best-effort cleanup for the case below (putFile succeeded, createPublicShare
// didn't) — deliberately swallows its own errors so a failed cleanup never
// masks the original, more useful error from createPublicShare.
async function deleteFile(relPath) {
  try {
    await fetchWithAuth(webdavUrl(relPath), { method: 'DELETE' });
  } catch (_err) {
    // best-effort only — nothing to do if even the cleanup fails
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
  const res = await fetchWithAuthRetry429(
    origin + '/ocs/v2.php/apps/files_sharing/api/v1/shares?format=json',
    {
      method: 'POST',
      headers: { 'OCS-APIRequest': 'true', 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: body.toString(),
    },
    undefined,
    'share-create'
  );
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
  try {
    return await createPublicShare(relFile);
  } catch (shareErr) {
    // The file already landed on disk via putFile above — if we can't link
    // it (429 even after retrying, or any other share-API failure), don't
    // leave it there as an orphan. Found live in production (2026-08-25):
    // 31 files had piled up on disk.kontentferma this way, none of them
    // attached to any card, because every failed share step before this fix
    // left its already-uploaded file behind with nothing pointing at it.
    await deleteFile(relFile);
    throw shareErr;
  }
}

module.exports = { uploadAndShare };
