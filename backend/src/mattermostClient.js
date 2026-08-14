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

const fetch = require('node-fetch');
const config = require('./config');

function assertConfigured() {
  if (!config.mattermostUrl) throw new Error('MATTERMOST_URL is not configured');
  if (!config.mattermostToken) throw new Error('MATTERMOST_TOKEN is not configured');
}

function boardsUrl(path) {
  return `${config.mattermostUrl}${config.boardsApiPrefix}${path}`;
}

function authHeaders(extra) {
  return {
    Authorization: `Bearer ${config.mattermostToken}`,
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

// GET /teams/{teamId}/boards — all boards for a team, INCLUDING cardProperties
// (property definitions: id, name, type, options: [{id, value, color}]).
// Confirmed working shape against a real server (unlike the single-board
// GET /boards/{boardId}, which is unverified — see docs/MATTERMOST_INTEGRATION.md).
async function listTeamBoards(teamId) {
  assertConfigured();
  const res = await fetch(boardsUrl(`/teams/${teamId}/boards`), { headers: authHeaders() });
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

// GET /boards/{boardId}/blocks — every block on the board (cards, comments,
// text/image content blocks, all mixed together, flat list).
async function listBlocks(boardId) {
  assertConfigured();
  const res = await fetch(boardsUrl(`/boards/${boardId}/blocks`), { headers: authHeaders() });
  const data = await asJsonOrThrow(res, `listBlocks(${boardId})`);
  return Array.isArray(data) ? data : (data && data.blocks) || [];
}

// PATCH /boards/{boardId}/blocks/{blockId}
// Body mirrors Focalboard's model.BlockPatch: updatedProperties is a
// propertyId -> value map. VERIFY against your server.
async function patchCardProperty(boardId, cardId, propertyId, value) {
  assertConfigured();
  const body = { updatedProperties: { [propertyId]: value } };
  const res = await fetch(boardsUrl(`/boards/${boardId}/blocks/${cardId}`), {
    method: 'PATCH',
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  return asJsonOrThrow(res, `patchCardProperty(${boardId},${cardId},${propertyId})`);
}

// POST /boards/{boardId}/blocks — bulk block creation, used to attach a
// "comment" block to the card. This is how Boards records feedback. VERIFY
// field names against your server (this mirrors Focalboard's Block model).
async function addCardComment(boardId, cardId, text) {
  assertConfigured();
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
  const res = await fetch(boardsUrl(`/boards/${boardId}/blocks`), {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  return asJsonOrThrow(res, `addCardComment(${boardId},${cardId})`);
}

// Files attached to Boards cards live in core Mattermost file storage and
// are served via the stable, documented core file API. This requires the
// same bot token, so it is NOT directly reachable by a client's browser —
// mediaRoutes proxies bytes through our backend instead (with Range support
// for video, since iPhone Safari needs it).
function fileDownloadUrl(fileId) {
  return `${config.mattermostUrl}/api/v4/files/${fileId}`;
}

async function fetchFileStream(fileId, rangeHeader) {
  assertConfigured();
  const headers = authHeaders();
  delete headers['Content-Type'];
  if (rangeHeader) headers.Range = rangeHeader;
  return fetch(fileDownloadUrl(fileId), { headers });
}

module.exports = {
  listTeamBoards,
  getBoard,
  listBlocks,
  patchCardProperty,
  addCardComment,
  fetchFileStream,
};
