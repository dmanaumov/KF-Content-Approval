// Thin wrapper around the Mattermost Boards REST API.
//
// IMPORTANT: the Boards API is not officially documented/stable (confirmed
// on Mattermost's own forums as of 2026 — see docs/MATTERMOST_INTEGRATION.md).
// Endpoints below come from reading the mattermost-plugin-boards server
// source (its route registrations), not from a published spec. A couple of
// request/response shapes are best-effort and flagged VERIFY.
//
// Everything Mattermost-specific is isolated in this one file on purpose:
// if your server's actual payloads differ, this is the only file that needs
// to change. Fastest way to confirm exact shapes: open Boards in a browser,
// do the equivalent action by hand, and read the request in devtools →
// Network. Turn on DEBUG_MATTERMOST=true to log raw responses server-side.
//
// --- Auth ---------------------------------------------------------------
// Two auth modes, tried in this order:
//   1. Session login (MATTERMOST_LOGIN_ID + MATTERMOST_PASSWORD) — logs in
//      via POST /api/v4/users/login and reuses the returned session token
//      as a Bearer token, re-logging in on 401. This is what the agency's
//      own n8n integration uses for EVERY call (including plain reads) —
//      per the agency, a Personal Access Token did not work at all there.
//   2. Personal Access Token (MATTERMOST_TOKEN) — simpler (no password to
//      store, tokens don't expire), and DOES work for this app's own GET
//      calls against the real server (confirmed in production logs). Kept
//      as a fallback/alternative for whichever calls it's sufficient for.
// If both are set, session login wins. See README/.env.example.

const fetch = require('node-fetch');
const config = require('./config');

function usingSessionLogin() {
  return !!(config.mattermostLoginId && config.mattermostPassword);
}

function assertConfigured() {
  if (!config.mattermostUrl) throw new Error('MATTERMOST_URL is not configured');
  if (!usingSessionLogin() && !config.mattermostToken) {
    throw new Error('Neither MATTERMOST_TOKEN nor MATTERMOST_LOGIN_ID/MATTERMOST_PASSWORD are configured');
  }
}

function boardsUrl(path) {
  return `${config.mattermostUrl}${config.boardsApiPrefix}${path}`;
}

// --- Session login --------------------------------------------------------
// Cached in memory only (no database, matches the rest of the app). A fresh
// container restart re-logs in from scratch, which is fine since login is
// cheap and happens lazily on first request.
let session = { token: null };

// Pulls the session token out of a Set-Cookie: MMAUTHTOKEN=<token>; ... header.
// The agency's own working n8n login flow has a node literally named "Extract
// Cookies" right after Login — strong signal that on this server the token
// should be read from the cookie, not (only) trusted from the Token header.
function extractAuthTokenFromCookies(res) {
  // node-fetch v2: headers.raw() exposes multi-value headers like Set-Cookie
  // as an array; headers.get('set-cookie') would only return the first one.
  const rawCookies = (res.headers.raw && res.headers.raw()['set-cookie']) || [];
  for (const cookie of rawCookies) {
    const match = /(?:^|;\s*)MMAUTHTOKEN=([^;]+)/.exec(cookie);
    if (match) return decodeURIComponent(match[1]);
  }
  return null;
}

async function login() {
  const res = await fetch(`${config.mattermostUrl}/api/v4/users/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login_id: config.mattermostLoginId, password: config.mattermostPassword }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`[mattermost] login() failed: HTTP ${res.status} ${text.slice(0, 300)}`);
  }
  // Mattermost returns the session token two ways: a "Token" response header,
  // and a Set-Cookie: MMAUTHTOKEN=... cookie. Try the header first (simpler),
  // fall back to the cookie (this is what the agency's own n8n flow relies
  // on — see comment on extractAuthTokenFromCookies above) since on this
  // server the header alone might not be present/reliable.
  const token = res.headers.get('token') || extractAuthTokenFromCookies(res);
  if (!token) {
    throw new Error(
      '[mattermost] login() succeeded (200) but no session token found in either the Token header or the ' +
        'MMAUTHTOKEN cookie — unexpected server behavior, see docs/MATTERMOST_INTEGRATION.md'
    );
  }
  session = { token };
  if (config.debug) {
    console.log(
      `[mattermost:debug] login() → session token acquired (source: ${res.headers.get('token') ? 'Token header' : 'MMAUTHTOKEN cookie'})`
    );
  }
  return token;
}

async function getBearerToken({ forceRelogin = false } = {}) {
  if (!usingSessionLogin()) return config.mattermostToken;
  if (forceRelogin || !session.token) await login();
  return session.token;
}

async function authHeaders(extra, opts) {
  const token = await getBearerToken(opts);
  return {
    Authorization: `Bearer ${token}`,
    // The boards plugin's v2 router enforces this header on every request
    // (server/api/api.go requireCSRFToken) regardless of auth method —
    // harmless to send even if your build doesn't require it.
    'X-Requested-With': 'XMLHttpRequest',
    'Content-Type': 'application/json',
    ...extra,
  };
}

async function asJsonOrThrow(res, context) {
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`[mattermost] ${context} failed: HTTP ${res.status} ${text.slice(0, 500)}`);
  }
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (config.debug) console.log(`[mattermost:debug] ${context} →`, JSON.stringify(parsed).slice(0, 2000));
    return parsed;
  } catch (e) {
    throw new Error(`[mattermost] ${context}: non-JSON response: ${text.slice(0, 200)}`);
  }
}

// Wraps fetch with: lazy session login (if configured), one retry-with-
// relogin on a 401 (session tokens can expire/get invalidated server-side,
// unlike PATs), and the debug-logged JSON parsing above. Every call in this
// file that hits the Boards or core API goes through this.
async function mmFetch(url, { headers: extraHeaders, ...opts } = {}, context) {
  assertConfigured();
  let headers = await authHeaders(extraHeaders);
  let res = await fetch(url, { ...opts, headers });
  if (res.status === 401 && usingSessionLogin()) {
    if (config.debug) console.log(`[mattermost:debug] ${context}: got 401, re-logging in and retrying once`);
    headers = await authHeaders(extraHeaders, { forceRelogin: true });
    res = await fetch(url, { ...opts, headers });
  }
  return res;
}

// GET /teams/{teamId}/boards — all boards for a team, INCLUDING cardProperties
// (property definitions: id, name, type, options: [{id, value, color}]).
// Confirmed working shape against a real server (unlike the single-board
// GET /boards/{boardId}, which is unverified — see docs/MATTERMOST_INTEGRATION.md).
async function listTeamBoards(teamId) {
  const res = await mmFetch(boardsUrl(`/teams/${teamId}/boards`), {}, `listTeamBoards(${teamId})`);
  const data = await asJsonOrThrow(res, `listTeamBoards(${teamId})`);
  return Array.isArray(data) ? data : (data && data.boards) || [];
}

// Board metadata for one board, resolved by listing the team's boards and
// picking the matching one (see listTeamBoards above for why).
async function getBoard(boardId, teamId) {
  if (!teamId) throw new Error('MATTERMOST_TEAM_ID is not configured');
  const boards = await listTeamBoards(teamId);
  const board = boards.find((b) => b.id === boardId);
  if (!board) throw new Error(`Board ${boardId} not found in team ${teamId} (checked ${boards.length} boards)`);
  return board;
}

// GET /boards/{boardId}/cards?page=N&per_page=200 — the dedicated cards API.
// CONFIRMED against a real server (via a working n8n integration the agency
// already had). Property values sit directly on `card.properties`, NOT
// nested under `card.fields.properties` like the generic /blocks endpoint —
// this is a different, card-specific representation.
//
// PAGINATES through every page: this board is shared across every client
// (see docs/MATTERMOST_INTEGRATION.md §7), so it can easily hold well over
// 200 cards — a single page=0 request silently missed real cards in testing
// (a newly-created card wasn't showing up at all). Stops at the first
// short/empty page; capped at 50 pages (10k cards) as a runaway-loop
// backstop, not an expected real limit.
async function listCards(boardId) {
  const perPage = 200;
  const maxPages = 50;
  let all = [];
  for (let page = 0; page < maxPages; page++) {
    const res = await mmFetch(
      boardsUrl(`/boards/${boardId}/cards?page=${page}&per_page=${perPage}`),
      {},
      `listCards(${boardId},page=${page})`
    );
    const data = await asJsonOrThrow(res, `listCards(${boardId},page=${page})`);
    const batch = Array.isArray(data) ? data : (data && data.cards) || [];
    all = all.concat(batch);
    if (batch.length < perPage) break; // last page reached
    if (page === maxPages - 1 && config.debug) {
      console.warn(`[mattermost] listCards(${boardId}): hit the ${maxPages}-page safety cap, some cards may be missing`);
    }
  }
  return all;
}

// GET /boards/{boardId}/blocks — every block on the board (cards, comments,
// text/image content blocks). UNCONFIRMED on this server (the /cards
// endpoint above is what's proven to work) — used only to enrich cards with
// caption/media/comment children. Callers must tolerate this failing/being
// empty and still show cards using listCards() alone.
async function listBlocks(boardId) {
  const res = await mmFetch(boardsUrl(`/boards/${boardId}/blocks`), {}, `listBlocks(${boardId})`);
  const data = await asJsonOrThrow(res, `listBlocks(${boardId})`);
  return Array.isArray(data) ? data : (data && data.blocks) || [];
}

// PATCH /boards/{boardId}/blocks/{blockId}
// Body mirrors Focalboard's model.BlockPatch: updatedProperties is a
// propertyId -> value map. VERIFY against your server.
async function patchCardProperty(boardId, cardId, propertyId, value) {
  const body = { updatedProperties: { [propertyId]: value } };
  const res = await mmFetch(
    boardsUrl(`/boards/${boardId}/blocks/${cardId}`),
    { method: 'PATCH', body: JSON.stringify(body) },
    `patchCardProperty(${boardId},${cardId},${propertyId})`
  );
  return asJsonOrThrow(res, `patchCardProperty(${boardId},${cardId},${propertyId})`);
}

// POST /boards/{boardId}/blocks — bulk block creation, used to attach a
// "comment" block to the card. This is how Boards records feedback. VERIFY
// field names against your server (this mirrors Focalboard's Block model).
async function addCardComment(boardId, cardId, text) {
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const nowMs = Date.now();
  const body = [
    {
      id,
      boardId,
      parentId: cardId,
      type: 'comment',
      title: text,
      schema: 1,
      createAt: nowMs,
      updateAt: nowMs,
      fields: {},
    },
  ];
  const res = await mmFetch(
    boardsUrl(`/boards/${boardId}/blocks`),
    { method: 'POST', body: JSON.stringify(body) },
    `addCardComment(${boardId},${cardId})`
  );
  return asJsonOrThrow(res, `addCardComment(${boardId},${cardId})`);
}

// Files attached to Boards cards live in core Mattermost file storage and
// are served via the stable, documented core file API. This requires the
// same auth, so it is NOT directly reachable by a client's browser —
// mediaRoutes proxies bytes through our backend instead (with Range support
// for video, since iPhone Safari needs it).
function fileDownloadUrl(fileId) {
  return `${config.mattermostUrl}/api/v4/files/${fileId}`;
}

async function fetchFileStream(fileId, rangeHeader) {
  assertConfigured();
  const headers = await authHeaders();
  delete headers['Content-Type'];
  if (rangeHeader) headers.Range = rangeHeader;
  let res = await fetch(fileDownloadUrl(fileId), { headers });
  if (res.status === 401 && usingSessionLogin()) {
    const retryHeaders = await authHeaders(undefined, { forceRelogin: true });
    delete retryHeaders['Content-Type'];
    if (rangeHeader) retryHeaders.Range = rangeHeader;
    res = await fetch(fileDownloadUrl(fileId), { headers: retryHeaders });
  }
  return res;
}

module.exports = {
  listTeamBoards,
  getBoard,
  listCards,
  listBlocks,
  patchCardProperty,
  addCardComment,
  fetchFileStream,
};
