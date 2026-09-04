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
const http = require('http');
const https = require('https');
const config = require('./config');

// A fresh TCP+TLS handshake for every single request to Mattermost adds
// real, avoidable latency — and this file alone can fire off several
// sequential calls just loading one cabinet (listCards pages through the
// 616+-card board page by page, then listBlocks, then per-request auth
// checks...). Reusing one keep-alive connection per host cuts every request
// after the first down to roughly the cost of sending the bytes, instead of
// paying handshake cost again and again. node-fetch does NOT do this by
// default — without an explicit agent it opens (and tears down) a brand new
// connection per call.
// maxSockets bumped 30→64 on 2026-09-03 — see the BUGFIX comment on
// fetchCardsPage() below: the poisoned-card fallback firing on several
// pages at once could briefly want 50+ concurrent sockets to this one host,
// and anything past 30 was queueing (and sometimes timing out) INSIDE this
// agent before ever reaching the wire — Mattermost's own logs showed zero
// trace of those requests, confirming they never actually got sent.
const keepAliveHttpAgent = new http.Agent({ keepAlive: true, maxSockets: 64 });
const keepAliveHttpsAgent = new https.Agent({ keepAlive: true, maxSockets: 64 });
function agentFor(url) {
  return url.startsWith('https:') ? keepAliveHttpsAgent : keepAliveHttpAgent;
}

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

// node-fetch has no default timeout — a slow or unreachable upstream would
// leave the request hanging forever and the cabinet spinner running for
// minutes instead of failing fast. Every fetch in this file goes through
// this: it aborts once config.requestTimeoutMs has passed without headers
// (the timeout is cleared as soon as the response resolves, so streaming a
// long video body is unaffected — only time-to-headers is bounded).
function fetchWithTimeout(url, opts = {}, ms = config.requestTimeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(url, { agent: agentFor(url), ...opts, signal: controller.signal }).finally(() => clearTimeout(timer));
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
  const res = await fetchWithTimeout(`${config.mattermostUrl}/api/v4/users/login`, {
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

// Logs in with ARBITRARY credentials — separate from the module-level
// `session` above, which is only ever the fixed bot account from config.
// Used by teamAuth.js for the /team cabinet, where each team member
// authenticates with their own real Mattermost username/password (checked
// live against Mattermost on every login, never stored by this app).
// Returns the session token AND the logged-in user's own profile —
// Mattermost's login response body IS the User object itself, so no extra
// request is needed to find out who just logged in.
async function loginAs(loginId, password) {
  const res = await fetchWithTimeout(`${config.mattermostUrl}/api/v4/users/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login_id: loginId, password }),
  });
  const text = await res.text();
  if (!res.ok) {
    // Mattermost returns 401 with a JSON body ({message: "..."}) on bad
    // credentials — surface THAT message (it's meant to be user-facing),
    // not a raw HTTP status, since this one goes straight into a login form.
    let message = `HTTP ${res.status}`;
    try {
      message = JSON.parse(text).message || message;
    } catch (e) {
      // not JSON, keep the HTTP-status fallback
    }
    throw new Error(message);
  }
  const token = res.headers.get('token') || extractAuthTokenFromCookies(res);
  if (!token) {
    throw new Error(
      'Mattermost вернул успешный логин, но не выдал сессионный токен — см. docs/MATTERMOST_INTEGRATION.md.'
    );
  }
  let user = null;
  try {
    user = JSON.parse(text);
  } catch (e) {
    // fall through, user stays null → handled below
  }
  if (!user || !user.id) {
    throw new Error('Mattermost вернул успешный логин, но тело ответа не похоже на профиль пользователя.');
  }
  return { token, user };
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
  let res = await fetchWithTimeout(url, { ...opts, headers });
  if (res.status === 401 && usingSessionLogin()) {
    if (config.debug) console.log(`[mattermost:debug] ${context}: got 401, re-logging in and retrying once`);
    headers = await authHeaders(extraHeaders, { forceRelogin: true });
    res = await fetchWithTimeout(url, { ...opts, headers });
  }
  // Retry a couple of times on a transient 5xx from Mattermost's OWN server
  // — GET-only (idempotent; a POST/PATCH/DELETE that came back 500 may have
  // partially applied server-side already, so retrying those risks doubling
  // an action — same reasoning as the 429-retry in diskUpload.js, applied
  // here to Mattermost's side instead of Nextcloud's). Added 2026-08-28:
  // reported live — listCards page=3 failed with a bare "internal server
  // error" from Mattermost itself (nothing wrong with our request), and
  // that single page's blip took down the WHOLE /projects list instead of
  // a quick retry just recovering it.
  const isGet = !opts.method || opts.method.toUpperCase() === 'GET';
  const RETRY_DELAYS_MS = [400, 1200];
  for (let i = 0; isGet && res.status >= 500 && i < RETRY_DELAYS_MS.length; i++) {
    if (config.debug) {
      console.log(`[mattermost:debug] ${context}: got ${res.status}, retrying in ${RETRY_DELAYS_MS[i]}ms (attempt ${i + 2}/${RETRY_DELAYS_MS.length + 1})`);
    }
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[i]));
    res = await fetchWithTimeout(url, { ...opts, headers });
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
// Fetches ONE page of cards, with the same poisoned-card fallback as before.
// Split out of listCards() so the pages themselves can be fetched in
// parallel batches (see listCards() below) instead of one-after-another.
async function fetchCardsPage(boardId, page, perPage) {
  const fetchWholePage = async () => {
    const res = await mmFetch(
      boardsUrl(`/boards/${boardId}/cards?page=${page}&per_page=${perPage}`),
      {},
      `listCards(${boardId},page=${page})`
    );
    const data = await asJsonOrThrow(res, `listCards(${boardId},page=${page})`);
    const batch = Array.isArray(data) ? data : (data && data.cards) || [];
    return { batch, reachedEnd: batch.length < perPage, skipped: 0 }; // short/empty page = last page reached
  };
  try {
    return await fetchWholePage();
  } catch (err) {
    // BUGFIX 2026-09-03 (reported live: an incident that skipped ~99 cards
    // across all 5 pages of the board within a 2-second window — Mattermost's
    // OWN app + Postgres logs for that exact window were completely clean,
    // no errors, no slow queries, pings succeeding throughout. So this was
    // NOT Mattermost being down/overloaded. Root cause: this file's shared
    // keep-alive HTTP agent caps concurrent sockets to one host — when
    // listCards() fires 5 pages at once (BATCH_SIZE below) AND the old
    // per-card fallback fired up to 10 more concurrent requests PER PAGE on
    // top of that, a brief spike easily wanted 50+ simultaneous sockets.
    // Requests that lost the race for a socket just sat QUEUED inside
    // node-fetch/the agent — their own abort timer was already running from
    // the moment they were CALLED, not from when they actually got sent — so
    // several timed out ("The user aborted a request.") without Mattermost
    // ever seeing them at all. The fallback below, built for one corrupt
    // card, was making a real overload WORSE by piling on more concurrent
    // requests instead of backing off. Fix, in order:
    //   1. If the page-level failure was OUR OWN timeout (AbortError) rather
    //      than a real error response from Mattermost, that's a strong sign
    //      of exactly this kind of transient socket/network pressure — retry
    //      the WHOLE page (one request, not per_page=1×200) a couple more
    //      times with backoff first. This alone resolves a passing blip
    //      without ever touching the expensive fallback.
    //   2. Only fall through to the one-card-at-a-time fallback (still useful
    //      for a genuinely corrupt single record, which fails with a real
    //      error response, not a timeout) if that also doesn't recover.
    //   3. Fallback concurrency lowered 10→4 so even several pages falling
    //      back at once stay well under the (now-larger) socket cap instead
    //      of amplifying the very pressure that caused the trouble.
    if (err.name === 'AbortError') {
      for (const delayMs of [800, 2000]) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        try {
          return await fetchWholePage();
        } catch (err2) {
          err = err2; // still failing — try the next backoff step, or fall through below
        }
      }
    }
    console.error(
      `[mattermost] listCards(${boardId},page=${page}) failed even after retry (${err.message}) — ` +
        `falling back to fetching this page one card at a time to isolate the bad record`
    );
    const offsets = [];
    for (let offset = page * perPage; offset < (page + 1) * perPage; offset++) offsets.push(offset);
    const CONCURRENCY = 4;
    // BUGFIX 2026-09-03: during a genuine widespread outage (see the big
    // comment above), EVERY offset on the page would fail — without a cap,
    // this loop would plow through all `perPage` (200) of them one by one
    // at up to config.requestTimeoutMs each, i.e. potentially many MINUTES
    // per page before finally giving up. listCards() below already throws
    // once the aggregate skip count crosses SKIP_THRESHOLD, so once a
    // single page alone has clearly blown past that, there's nothing to
    // gain from grinding through the rest of it — bail out of THIS page
    // early and let listCards() fail fast instead.
    const PAGE_BAILOUT_SKIPS = 8;
    const found = []; // { offset, card }
    let reachedEnd = false;
    let bailedOut = false;
    let endOffset = Infinity; // lowest offset any worker found empty (real end of board)
    let skipped = 0;
    let i = 0;
    const runNext = async () => {
      while (i < offsets.length) {
        if (reachedEnd || bailedOut) return; // another worker already found the real end — or this page is clearly a lost cause
        const offset = offsets[i++];
        try {
          const res1 = await mmFetch(
            boardsUrl(`/boards/${boardId}/cards?page=${offset}&per_page=1`),
            {},
            `listCards(${boardId},page=${offset},per_page=1)`
          );
          const data1 = await asJsonOrThrow(res1, `listCards(${boardId},page=${offset},per_page=1)`);
          const one = Array.isArray(data1) ? data1 : (data1 && data1.cards) || [];
          if (!one.length) {
            reachedEnd = true; // ran past the real end of the board
            if (offset < endOffset) endOffset = offset;
          } else {
            found.push({ offset, card: one[0] });
          }
        } catch (err1) {
          skipped++;
          console.error(`[mattermost] listCards(${boardId}): SKIPPING card at offset ${offset} — Mattermost itself keeps failing on it: ${err1.message}`);
          // Deliberately swallowed — this one card is missing from the
          // result, everything else on the board still loads. listCards()
          // below decides whether the AGGREGATE skip count across the whole
          // board is small enough to just live with (one genuinely corrupt
          // card) or high enough to treat the whole load as failed instead
          // of quietly serving/caching an incomplete list.
          if (skipped >= PAGE_BAILOUT_SKIPS) bailedOut = true;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, offsets.length) }, runNext));
    // Workers finish out of offset order — restore it, and drop anything at
    // or past whichever offset a worker found empty (defensive: a higher
    // offset that happened to briefly "succeed" before the real end was
    // discovered by another worker would just be noise past the board).
    found.sort((a, b) => a.offset - b.offset);
    const batch = found.filter((x) => x.offset < endOffset).map((x) => x.card);
    if (skipped > 0) {
      console.error(
        `[mattermost] listCards(${boardId},page=${page}): SUMMARY — skipped ${skipped}/${offsets.length} cards on this page` +
          (bailedOut ? ` (bailed out early past ${PAGE_BAILOUT_SKIPS} skips — this page looks broadly unavailable, not one bad record)` : '') +
          ' (see SKIPPING lines above for exact offsets)'
      );
    }
    return { batch, reachedEnd, skipped };
  }
}

async function listCards(boardId) {
  const perPage = 200;
  const maxPages = 50;
  // PAGES ARE FETCHED IN PARALLEL BATCHES, not one after another: this
  // board is big enough (616+ cards / per_page=200 → 4-5 pages) that
  // awaiting each page before starting the next used to add up to real,
  // user-visible wait ("Загружаем данные..." hanging 30+ seconds) even
  // though nothing on our own server was actually busy — it was pure
  // sequential round-trip latency to Mattermost. A batch of BATCH_SIZE
  // pages is fired off together; once a batch contains a short/empty page
  // (the real end of the board), any later pages in that SAME batch are
  // safe to discard even if they came back non-empty (over-fetching past
  // the end is harmless, Mattermost just returns whatever's there).
  const BATCH_SIZE = 5;
  // BUGFIX 2026-09-03 (see fetchCardsPage() above for the full incident this
  // is responding to): a handful of skipped cards is the ORIGINAL, still-
  // legitimate "one poisoned/corrupt record" case this whole fallback exists
  // for — fine to just quietly omit those and move on, same as before. But
  // when skips run much higher than that, it's a strong sign of a broader
  // hiccup (network/socket pressure, a Mattermost blip), and silently
  // returning — and CACHING, see loadBoard() in index.js — a list that's
  // missing dozens of real cards is worse than failing loudly: staff and
  // clients would see posts "vanish" with no error on screen at all. Past
  // this threshold, throw instead — loadBoard()'s callers already have a
  // proper error path (/api/projects' error-box, /api/boards/:id/tasks'
  // 502 mattermost_unavailable) that tells people to retry, rather than
  // quietly showing wrong data. Checked INSIDE the loop too (not just at the
  // end) so a genuine board-wide outage stops after the first bad batch
  // instead of grinding through all `maxPages` batches one by one first.
  const SKIP_THRESHOLD = 5;
  let all = [];
  let reachedEnd = false;
  let totalSkipped = 0;
  for (let batchStart = 0; batchStart < maxPages && !reachedEnd && totalSkipped <= SKIP_THRESHOLD; batchStart += BATCH_SIZE) {
    const pages = [];
    for (let p = batchStart; p < Math.min(batchStart + BATCH_SIZE, maxPages); p++) pages.push(p);
    const results = await Promise.all(pages.map((p) => fetchCardsPage(boardId, p, perPage)));
    for (const r of results) {
      all = all.concat(r.batch);
      totalSkipped += r.skipped || 0;
      if (r.reachedEnd) {
        reachedEnd = true;
        break; // ignore any later pages already fetched in this same batch
      }
    }
    if (!reachedEnd && batchStart + BATCH_SIZE >= maxPages && config.debug) {
      console.warn(`[mattermost] listCards(${boardId}): hit the ${maxPages}-page safety cap, some cards may be missing`);
    }
  }
  if (totalSkipped > SKIP_THRESHOLD) {
    throw new Error(
      `listCards(${boardId}): не удалось загрузить ${totalSkipped} карточек из ${all.length + totalSkipped} — ` +
        `похоже на временный сбой соединения с Mattermost, а не отдельные битые записи. Список отклонён целиком, чтобы не показывать неполные данные — попробуйте через минуту.`
    );
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
//
// ROOT CAUSE of "PATCH returns 200 but nothing changes in Mattermost" (real
// bug hit in production): the body shape was wrong. `model.BlockPatch` (the
// actual Go struct behind this endpoint, confirmed via the mattermost-plugin-
// boards source) has NO `updatedProperties` field at all — that key was a
// mistaken guess and the server just silently ignored it. The real field is
// `updatedFields`, a generic map merged into the block's top-level `fields`
// object — and `properties` is itself one key of `fields`, replaced WHOLESALE
// (not deep-merged) by whatever you put there. So this function takes the
// card's FULL, already-merged properties object (not a single propertyId/
// value pair) — the caller is responsible for merging the one changed
// property into the card's existing properties first (see setApprovalStatus
// in index.js), or every other property (project, date, post text, ...)
// would be silently wiped from the card.
async function patchCardProperty(boardId, cardId, mergedProperties) {
  const body = { updatedFields: { properties: mergedProperties } };
  const res = await mmFetch(
    boardsUrl(`/boards/${boardId}/blocks/${cardId}`),
    { method: 'PATCH', body: JSON.stringify(body) },
    `patchCardProperty(${boardId},${cardId})`
  );
  return asJsonOrThrow(res, `patchCardProperty(${boardId},${cardId})`);
}

async function patchBlock(boardId, blockId, body) {
  const res = await mmFetch(
    boardsUrl(`/boards/${boardId}/blocks/${blockId}?disable_notify=true`),
    { method: 'PATCH', body: JSON.stringify(body) },
    `patchBlock(${boardId},${blockId})`
  );
  return asJsonOrThrow(res, `patchBlock(${boardId},${blockId})`);
}

async function deleteBlock(boardId, blockId) {
  const res = await mmFetch(
    boardsUrl(`/boards/${boardId}/blocks/${blockId}?disable_notify=true`),
    { method: 'DELETE' },
    `deleteBlock(${boardId},${blockId})`
  );
  return asJsonOrThrow(res, `deleteBlock(${boardId},${blockId})`);
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

async function addBlocks(boardId, blocks, context = 'addBlocks') {
  const res = await mmFetch(
    boardsUrl(`/boards/${boardId}/blocks?disable_notify=true`),
    { method: 'POST', body: JSON.stringify(blocks) },
    `${context}(${boardId})`
  );
  return asJsonOrThrow(res, `${context}(${boardId})`);
}

// Files attached DIRECTLY TO A CARD (drag-and-drop / attach in Boards) do
// NOT live in core Mattermost file storage — they live in the Boards
// plugin's own file storage, keyed by team+board, and the fileId itself is
// literally the stored filename (confirmed against a real card's raw
// blocks: fields.fileId was "76ttr5js5efdzbrjy7a5qkqrgbw.png", an id+
// extension, not a core Mattermost FileInfo id). The CONFIRMED route
// (mattermost-plugin-boards source, server/api/files.go,
// registerFilesRoutes: GET "/files/teams/{teamID}/{boardID}/{filename}")
// lives under the same apiv2 router as every other Boards call in this
// file — NOT under /api/v4/files/{fileId} (that's for chat-post
// attachments, a different storage entirely, and was the actual reason
// images/video weren't loading before this fix). Requires teamId + the
// owning boardId, both already known by every caller in this app.
// This is NOT directly reachable by a client's browser (needs Boards
// auth) — mediaRoutes proxies bytes through our backend instead (with
// Range support for video, since iPhone Safari needs it).
function fileDownloadUrl(boardId, fileId) {
  return boardsUrl(`/files/teams/${config.teamId}/${boardId}/${fileId}`);
}

async function fetchFileStream(boardId, fileId, rangeHeader) {
  assertConfigured();
  const headers = await authHeaders();
  delete headers['Content-Type'];
  if (rangeHeader) headers.Range = rangeHeader;
  let res = await fetchWithTimeout(fileDownloadUrl(boardId, fileId), { headers });
  if (res.status === 401 && usingSessionLogin()) {
    const retryHeaders = await authHeaders(undefined, { forceRelogin: true });
    delete retryHeaders['Content-Type'];
    if (rangeHeader) retryHeaders.Range = rangeHeader;
    res = await fetchWithTimeout(fileDownloadUrl(boardId, fileId), { headers: retryHeaders });
  }
  return res;
}

// GET /api/v4/users/username/{username} — core (stable, documented) user
// lookup, used to resolve config.feedbackAuthorUsername to a user id so
// taskMapper.js can tell "feedback comment our app posted" apart from
// unrelated internal comments left directly on the card in Mattermost.
// Cached in memory (module-level, like the session token) — the mapping
// doesn't change during the process's lifetime. Returns null (not a throw)
// on any failure, so a lookup problem degrades to the text-match fallback
// in taskMapper.js instead of taking down the whole board request.
let userIdCache = new Map();
async function getUserIdByUsername(username) {
  if (!username) return null;
  if (userIdCache.has(username)) return userIdCache.get(username);
  try {
    const headers = await authHeaders();
    delete headers['Content-Type'];
    let res = await fetchWithTimeout(`${config.mattermostUrl}/api/v4/users/username/${encodeURIComponent(username)}`, { headers });
    if (res.status === 401 && usingSessionLogin()) {
      const retryHeaders = await authHeaders(undefined, { forceRelogin: true });
      delete retryHeaders['Content-Type'];
      res = await fetchWithTimeout(`${config.mattermostUrl}/api/v4/users/username/${encodeURIComponent(username)}`, { headers: retryHeaders });
    }
    if (!res.ok) {
      if (config.debug) console.warn(`[mattermost] getUserIdByUsername(${username}): HTTP ${res.status}`);
      userIdCache.set(username, null);
      return null;
    }
    const user = await res.json();
    userIdCache.set(username, user.id || null);
    return user.id || null;
  } catch (err) {
    if (config.debug) console.warn(`[mattermost] getUserIdByUsername(${username}) failed:`, err.message);
    return null;
  }
}

module.exports = {
  listTeamBoards,
  getBoard,
  listCards,
  listBlocks,
  patchCardProperty,
  patchBlock,
  deleteBlock,
  addCardComment,
  addBlocks,
  fetchFileStream,
  getUserIdByUsername,
  loginAs,
};
