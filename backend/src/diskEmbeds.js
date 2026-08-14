// Handles "the material is already on disk.kontentferma.*" links pasted
// into a card's "Текст поста" (or, occasionally, the "URL" property) —
// instead of leaving the client a raw link to click through to another
// site, we detect these links, fetch the file server-side, and embed it
// directly in the media carousel like any other attached photo/video.
//
// disk.kontentferma.* is the agency's own file-sharing server. The share
// link shape confirmed by the agency:
//   https://disk.kontentferma.com/s/rPZR3PBWdtt9Fko
// is Nextcloud's standard public-share URL scheme. Also confirmed live:
// opening the link shows an inline preview, appending "/download" downloads
// the raw file directly, and the share is fully public (no login needed).

const fetch = require('node-fetch');

// Several TLDs are in use for this one server (com, ru, tech, ...) — this
// pattern accepts any short alphabetic TLD rather than an exact list, so a
// new one doesn't require a code change. Extend/tighten here if that's ever
// too permissive in practice.
const DISK_LINK_RE = /https:\/\/disk\.kontentferma\.[a-z]{2,10}\/s\/[A-Za-z0-9]+/gi;

// Finds every disk.kontentferma share link mentioned in a block of text.
// Returns the RAW matched substrings (not validated/normalized) — callers
// should still run each one through parseAndValidateShareUrl before trusting
// it, since the regex alone doesn't rule out anything but the domain/path
// shape (e.g. accidental trailing punctuation from prose).
function extractDiskLinks(text) {
  if (!text) return [];
  const matches = String(text).match(DISK_LINK_RE) || [];
  return [...new Set(matches)]; // de-dupe, keep first-seen order
}

// Removes the given exact substrings from text and tidies up the leftover
// whitespace where a link used to sit on its own line.
function stripDiskLinks(text, rawLinks) {
  if (!text || !rawLinks || !rawLinks.length) return text;
  let out = text;
  for (const link of rawLinks) out = out.split(link).join('');
  return out
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ') // collapse the gap left by an inline link
    .replace(/ +([,.!?:;])/g, '$1') // no stray space before punctuation
    .trim();
}

// Only ever fetch from disk.kontentferma.<tld>, and only the exact public
// share path shape (/s/<token>, nothing else) — this backs a server-side
// proxy reachable by anyone holding a client link, so it must never become
// an open fetch-any-URL relay (SSRF). Returns a normalized
// "https://host/s/token" string (query/hash stripped) or null if the input
// isn't a valid disk.kontentferma share link.
function parseAndValidateShareUrl(rawUrl) {
  let u;
  try {
    u = new URL(String(rawUrl));
  } catch (e) {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  if (!/^disk\.kontentferma\.[a-z]{2,10}$/i.test(u.hostname)) return null;
  if (!/^\/s\/[A-Za-z0-9]+$/.test(u.pathname)) return null;
  return `${u.protocol}//${u.hostname}${u.pathname}`;
}

function downloadUrlFor(shareUrl) {
  return `${shareUrl}/download`;
}

// Cached in memory only (no database, matches the rest of the app) — a
// share link's content type doesn't change, so once resolved it's good for
// the life of the process; a fresh container restart just re-resolves
// lazily on first use. Failures are NOT cached, so a transient network blip
// gets retried on the next request instead of getting stuck as "file".
const kindCache = new Map(); // shareUrl -> { kind, name }

async function resolveKind(shareUrl) {
  if (kindCache.has(shareUrl)) return kindCache.get(shareUrl);
  try {
    const res = await fetch(downloadUrlFor(shareUrl), { headers: { Range: 'bytes=0-1' } });
    const contentType = (res.headers.get('content-type') || '').split(';')[0].trim();
    const disposition = res.headers.get('content-disposition') || '';
    const nameMatch = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
    const name = nameMatch ? decodeURIComponent(nameMatch[1]) : '';
    let kind = 'file';
    if (contentType.startsWith('image/')) kind = 'image';
    else if (contentType.startsWith('video/')) kind = 'video';
    const result = { kind, name };
    kindCache.set(shareUrl, result);
    return result;
  } catch (err) {
    return { kind: 'file', name: '' };
  }
}

// Streams the file itself (Range passthrough, for video seeking/iOS).
// Caller (index.js route) is responsible for validating shareUrl via
// parseAndValidateShareUrl BEFORE calling this — this function itself does
// not re-check, so it must never be reachable with an unvalidated URL.
async function streamDiskFile(shareUrl, rangeHeader) {
  const headers = {};
  if (rangeHeader) headers.Range = rangeHeader;
  return fetch(downloadUrlFor(shareUrl), { headers });
}

module.exports = {
  extractDiskLinks,
  stripDiskLinks,
  parseAndValidateShareUrl,
  resolveKind,
  streamDiskFile,
};
