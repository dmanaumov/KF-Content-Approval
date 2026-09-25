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
let keepAliveHttpAgent = new http.Agent({ keepAlive: true, keepAliveMsecs: 10000, maxSockets: 64 });
let keepAliveHttpsAgent = new https.Agent({ keepAlive: true, keepAliveMsecs: 10000, maxSockets: 64 });
function agentFor(url) {
  return url.startsWith('https:') ? keepAliveHttpsAgent : keepAliveHttpAgent;
}

// BUGFIX 2026-09-09 (live incident): the WHOLE /team cabinet stopped loading —
// every request to Mattermost died with "The user aborted a request." (our own
// AbortError from fetchWithTimeout below) at exactly the 15s timeout, INCLUDING
// a fresh login call, while `curl` from the same host answered /system/ping in
// ~0.25s every time. MM was fine; our keep-alive pool was not: idle connections
// that the nginx/LB in front of Mattermost silently closed were being reused as
// if alive, so each request hung until OUR timeout aborted it. A container
// restart (fresh sockets) fixed it instantly — classic symptom, hence this
// self-healing instead of a manual redeploy every time:
//
//   1. Every request that hits OUR abort timeout counts; a single success
//      resets the count.
//   2. After AGENT_ROTATE_AFTER_TIMEOUTS consecutive timeouts (a whole-pool
//      "went stale" burst, not a one-off blip — one-off blips stay just that,
//      the existing backoff in fetchCardsPage() handles them), drop the old
//      agents and build fresh ones from scratch. New connections force a real
//      TCP/TLS handshake instead of reusing whatever got orphaned.
//   3. keepAliveMsecs: 10000 — Node sends a TCP keepalive probe after ~10s of
//      socket idleness, so a peer that died on the proxy side gets detected in
//      seconds instead of the OS default of hours.
function rotateAgentPool(reason) {
  keepAliveHttpAgent = new http.Agent({ keepAlive: true, keepAliveMsecs: 10000, maxSockets: 64 });
  keepAliveHttpsAgent = new https.Agent({ keepAlive: true, keepAliveMsecs: 10000, maxSockets: 64 });
  // Deliberately do NOT destroy() the old agents: any request still in flight
  // on one of their sockets must be allowed to finish normally. Once no
  // request references them anymore, the old agent (and its dead sockets) is
  // unreferenced and GC'd. New requests all land on the fresh pool.
  console.error(`[mattermost] rotated keep-alive agent pool (${reason}) — stale sockets reset, new connections will be established`);
}
let consecutiveTimeouts = 0;
let firstTimeoutAt = null;
let lastRotatedAt = 0;
const AGENT_ROTATE_AFTER_TIMEOUTS = 5;
// Don't let a parallel burst of aborts (e.g. listCards' per-card fallback
// firing on several pages at once) spin the rotation hot: once we've rotated,
// give the fresh pool a moment to actually establish connections before even
// considering rotating again. The threshold check below then needs 5 more
// aborts after the cooldown to re-trigger, which conveniently also caps the
// log spam from a genuinely down Mattermost.
const AGENT_ROTATE_COOLDOWN_MS = 15000;

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
  const startedAt = Date.now();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(url, { agent: agentFor(url), ...opts, signal: controller.signal })
    .then((res) => {
      consecutiveTimeouts = 0;
      firstTimeoutAt = null;
      const ttfh = Date.now() - startedAt;
      // Headers took suspiciously long (but still under the timeout) — log
      // it so a slowly-degrading upstream shows up in the logs as a trend
      // long before it turns into a hard failure.
      if (ttfh > 3000) console.error(`[mattermost] slow response after ${ttfh}ms: ${opts.method || 'GET'} ${url}`);
      return res;
    })
    .catch((err) => {
      // Not every AbortError is a stale-socket problem — but a BURST of them
      // in a row is exactly the signature of the 2026-09-09 incident above.
      // Count on our own timeout only, not on arbitrary errors: a real error
      // from Mattermost is handled up the stack (retry/fallback), it says
      // nothing about the health of OUR connection pool.
      if (err && err.name === 'AbortError') {
        if (!firstTimeoutAt) firstTimeoutAt = Date.now();
        consecutiveTimeouts++;
        const ttfh = Date.now() - startedAt;
        console.error(
          `[mattermost] request aborted after ${ttfh}ms (timeout ${ms}ms): ${opts.method || 'GET'} ${url} — ` +
            `consecutive timeouts: ${consecutiveTimeouts}/${AGENT_ROTATE_AFTER_TIMEOUTS}`
        );
        if (
          consecutiveTimeouts >= AGENT_ROTATE_AFTER_TIMEOUTS &&
          Date.now() - lastRotatedAt >= AGENT_ROTATE_COOLDOWN_MS
        ) {
          lastRotatedAt = Date.now();
          rotateAgentPool(`timeout-storm: ${consecutiveTimeouts} consecutive aborts since ${new Date(firstTimeoutAt).toISOString()}`);
          consecutiveTimeouts = 0;
          firstTimeoutAt = null;
        }
      }
      throw err;
    })
    .finally(() => clearTimeout(timer));
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
    // BUGFIX 2026-09-22 (live incident, follow-up): a single poisoned card
    // (Mattermost itself 500s on it) was forcing this per-card fallback on
    // EVERY cold loadBoard(), including every write action (all write
    // routes reload with {fresh:true}, bypassing the cache entirely). The
    // old walk issued ~perPage (200) per_page=1 requests for the ONE
    // affected page every single time — team reported /team taking 10+s to
    // open and 5+s per edit while Mattermost's own logs just showed the
    // same poisoned card failing over and over. Mattermost 500s ANY /cards
    // window that contains the bad record and serves clean windows
    // normally, so instead of walking every offset we probe the failed page
    // in power-of-two-aligned windows (each page = offset / size is exact by
    // construction) and only descend into windows that still fail. One
    // poisoned card now costs ~2*log2(perPage) requests instead of perPage;
    // PAGE_BAILOUT_SKIPS still caps broad outages, and the SKIP/end-of-board
    // accounting is unchanged from the walk it replaces.
    const PAGE_BAILOUT_SKIPS = 8;
    const state = { reachedEnd: false, endOffset: Infinity, skipped: 0, bailedOut: false };
    // One /cards request for an aligned window [start, start+size). Empty
    // response = ran past the real end of the board. Resolves to the
    // window's cards (offset-tagged) or rejects — a rejection means a
    // poisoned record lives inside this window.
    const probeWindow = async (start, size) => {
      const res = await mmFetch(
        boardsUrl(`/boards/${boardId}/cards?page=${start / size}&per_page=${size}`),
        {},
        `listCards(${boardId},page=${start / size},per_page=${size})`
      );
      const data = await asJsonOrThrow(res, `listCards(${boardId},page=${start / size},per_page=${size})`);
      const cards = Array.isArray(data) ? data : (data && data.cards) || [];
      if (!cards.length) {
        state.reachedEnd = true;
        if (start < state.endOffset) state.endOffset = start;
      }
      return cards.map((card, i) => ({ offset: start + i, card }));
    };
    // Probe a known-failing [start, end) window: try each aligned half, and
    // only dig into the half that still fails. Halves of a power-of-two
    // aligned window are themselves aligned, so page stays integral all the
    // way down; a size-1 window is where the poisoned record actually
    // surfaces (skipped, everything else on the board still loads).
    const scanWindow = async (start, end) => {
      if (state.bailedOut || state.reachedEnd) return [];
      if (end - start === 1) {
        try {
          return await probeWindow(start, 1);
        } catch (err) {
          state.skipped++;
          console.error(`[mattermost] listCards(${boardId}): SKIPPING card at offset ${start} — Mattermost itself keeps failing on it: ${err.message}`);
          // Deliberately swallowed — this one card is missing from the
          // result, everything else on the board still loads. listCards()
          // below decides whether the AGGREGATE skip count across the whole
          // board is small enough to just live with (one genuinely corrupt
          // card) or high enough to treat the whole load as failed instead
          // of quietly serving/caching an incomplete list.
          if (state.skipped >= PAGE_BAILOUT_SKIPS) state.bailedOut = true;
          return [];
        }
      }
      const mid = start + Math.floor((end - start) / 2);
      const out = [];
      for (const [a, b] of [[start, mid], [mid, end]]) {
        try {
          out.push(...(await probeWindow(a, b - a)));
        } catch (err) {
          out.push(...(await scanWindow(a, b)));
        }
      }
      return out;
    };
    // Split the failing page into aligned power-of-two blocks and scan each:
    // a block that comes back clean is done in one request, only failing
    // blocks go through scanWindow. Blocks are walked in offset order so the
    // first empty one (real end of board) stops the loop early.
    const found = []; // { offset, card }
    const pageEnd = (page + 1) * perPage;
    for (let offset = page * perPage; offset < pageEnd && !state.bailedOut && !state.reachedEnd; ) {
      let size = 1 << Math.floor(Math.log2(pageEnd - offset));
      while ((offset & (size - 1)) !== 0) size >>= 1;
      try {
        found.push(...(await probeWindow(offset, size)));
      } catch (err) {
        found.push(...(await scanWindow(offset, offset + size)));
      }
      offset += size;
    }
    // Probe results arrive in order (blocks and halves are traversed in
    // order), but keep the defensive sort + end-of-board trim from before:
    // a higher offset that briefly "succeeded" past the real end discovered
    // by an earlier empty window would just be noise past the board.
    found.sort((a, b) => a.offset - b.offset);
    const batch = found.filter((x) => x.offset < state.endOffset).map((x) => x.card);
    if (state.skipped > 0) {
      console.error(
        `[mattermost] listCards(${boardId},page=${page}): SUMMARY — skipped ${state.skipped}/${perPage} cards on this page` +
          (state.bailedOut ? ` (bailed out early past ${PAGE_BAILOUT_SKIPS} skips — this page looks broadly unavailable, not one bad record)` : '') +
          ' (see SKIPPING lines above for exact offsets)'
      );
    }
    return { batch, reachedEnd: state.reachedEnd, skipped: state.skipped };
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

// Fetches ONE card block plus its own children (description text, media
// attachments, comments) WITHOUT pulling the rest of the board — added
// 2026-09-22 after a live incident where every team write (status/text/etc.)
// was paying for a full listBlocks() (unpaginated, ALL ~3000+ blocks on the
// board in one response) TWICE per action: once before the patch (to safely
// merge properties — see patchCardProperty's comment on why a stale/partial
// read there is dangerous) and once after (to verify the write took and
// build the response — see refetchTeamTask() in index.js). listBlocks()
// itself costs 3-6s at this board's size regardless of Mattermost's health,
// which made every single edit feel like it was hanging.
//
// Verified live against this server (2026-09-22, via curl) that the same
// /boards/{boardId}/blocks endpoint listBlocks() uses also accepts
// block_id= (returns just that one block) and parent_id= (returns just its
// direct children) query params — both confirmed to actually filter
// server-side, not just get ignored. Fired in parallel since they're
// independent reads.
async function getCardWithChildren(boardId, cardId) {
  const [cardRes, childrenRes] = await Promise.all([
    mmFetch(
      boardsUrl(`/boards/${boardId}/blocks?block_id=${encodeURIComponent(cardId)}`),
      {},
      `getCardWithChildren(${boardId},${cardId}):card`
    ),
    mmFetch(
      boardsUrl(`/boards/${boardId}/blocks?parent_id=${encodeURIComponent(cardId)}`),
      {},
      `getCardWithChildren(${boardId},${cardId}):children`
    ),
  ]);
  const cardData = await asJsonOrThrow(cardRes, `getCardWithChildren(${boardId},${cardId}):card`);
  const childrenData = await asJsonOrThrow(childrenRes, `getCardWithChildren(${boardId},${cardId}):children`);
  const cardArr = Array.isArray(cardData) ? cardData : (cardData && cardData.blocks) || [];
  const childArr = Array.isArray(childrenData) ? childrenData : (childrenData && childrenData.blocks) || [];
  const card = cardArr[0] || null;
  // The generic /blocks endpoint (used here) nests card properties under
  // `fields.properties`, NOT at `card.properties` like the dedicated /cards
  // endpoint (see listCards() comment above). Every downstream consumer
  // (buildTasks(), setStatusByRawLabel()'s property merge, etc.) assumes the
  // flattened `card.properties` shape, so normalize it here — otherwise
  // `card.properties` is undefined and a property-merge-then-PATCH wipes
  // every other property on the card (Mattermost's PATCH replaces
  // `fields.properties` wholesale, it does not deep-merge).
  if (card) {
    card.properties = (card.fields && card.fields.properties) || card.properties || {};
  }
  return { card, children: childArr };
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

// ROOT CAUSE (2026-09-16, reported live: "Удаление проекта" failing with
// HTTP 404 "{block ID=<boardId>} not found") — the ORIGINAL assumption here
// ("a board is just a block whose id equals its own boardId") is simply
// wrong on this Mattermost Boards version: confirmed against the actual
// mattermost-plugin-boards source (server/model/board.go) that `Board` is
// its own model, entirely separate from `Block` — a board is NOT a row in
// the blocks table at all, so PATCHing /blocks/{boardId} 404s because no
// such block ever existed to find. The real, dedicated route for a board's
// own fields (including its card property DEFINITIONS — "Проект"/"Статус"/
// etc. as a whole, not a card's VALUES for them) is `PATCH /boards/{boardId}`
// with a BoardPatch body — and it has genuinely BETTER semantics than the
// old (broken) approach: `updatedCardProperties` merges by the property's
// OWN id (server/model/board.go's BoardPatch.Patch()), so a caller only
// needs to send the ONE property definition that changed (with its full,
// already-merged `options` array) — Mattermost keeps every other property
// (Статус, Дедлайн, Исполнитель, ...) untouched on its own, no need to
// resend the board's entire cardProperties array and risk wiping something
// by omission (the exact class of bug patchCardProperty's own history
// already warns about for CARD-level properties).
async function patchBoardCardProperty(boardId, propertyDef) {
  const res = await mmFetch(
    boardsUrl(`/boards/${boardId}`),
    { method: 'PATCH', body: JSON.stringify({ updatedCardProperties: [propertyDef] }) },
    `patchBoardCardProperty(${boardId},${propertyDef && propertyDef.id})`
  );
  return asJsonOrThrow(res, `patchBoardCardProperty(${boardId},${propertyDef && propertyDef.id})`);
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

// GET /api/v4/users?team_id={teamId} — every worker who has Mattermost TEAM
// membership in config.teamId. Since the app's board is shared at the team
// level (Mattermost grants board access per team), team members == the people
// who have board access. This is what powers the responsible-worker dropdown
// in the staff project-settings popup (see GET /api/projects/team-members in
// index.js), and — via the `email` field — the project-card avatar facepile
// (GET /api/projects, added 2026-09-25) telling apart a CEO's project_access
// row (excluded there, per config.ceoEmails) from an ordinary admin/editor's.
// Stable, documented core API; fetched with the shared bot session like
// getUserIdByUsername above. Paginates per_page=200 — a roster that big is
// unrealistic here, but the loop is cheap and keeps the list complete if the
// team ever grows past a single page. Deactivated accounts (delete_at set)
// are filtered out so the dropdown only offers real, usable people.
async function listTeamUsers() {
  assertConfigured();
  if (!config.teamId) return [];
  const profiles = [];
  let page = 0;
  for (;;) {
    const headers = await authHeaders();
    delete headers['Content-Type'];
    const url = `${config.mattermostUrl}/api/v4/users?team_id=${encodeURIComponent(config.teamId)}&page=${page}&per_page=200`;
    let res = await fetchWithTimeout(url, { headers });
    if (res.status === 401 && usingSessionLogin()) {
      const retryHeaders = await authHeaders(undefined, { forceRelogin: true });
      delete retryHeaders['Content-Type'];
      res = await fetchWithTimeout(url, { headers: retryHeaders });
    }
    if (!res.ok) {
      if (config.debug) console.warn(`[mattermost] listTeamUsers: HTTP ${res.status}`);
      throw new Error(`listTeamUsers: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
    }
    const users = await res.json();
    const batch = Array.isArray(users) ? users : [];
    profiles.push(...batch);
    if (batch.length < 200) break;
    page++;
  }
  return profiles
    .filter((u) => u && u.id && u.username && !u.delete_at)
    .map((u) => ({
      id: u.id,
      username: u.username,
      name: [u.first_name, u.last_name].filter(Boolean).join(' ').trim() || u.username,
      email: u.email || '',
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
}

// --- Core API "as a real team member" ------------------------------------
// Everything above uses the ONE shared bot-account session (module-level
// `session`) to talk to the Boards plugin API. The functions below are a
// separate, deliberately parallel path: they call Mattermost's CORE
// (/api/v4/...) API using a caller-SUPPLIED token — specifically, a /team
// cabinet member's own real Mattermost session token, already stored per
// login by teamAuth.js (req.teamSession.mmToken). This is what powers the
// "открыть чат" team-channel panel: messages are read/sent AS that actual
// person (not a shared bot), and unread state rides on Mattermost's own
// native per-user tracking (ChannelMember.msg_count vs Channel.total_msg_count)
// instead of a second, custom read-tracking system in our own Postgres.
//
// Deliberately NOT routed through mmFetch()/getBearerToken() above — those
// always mean "the bot account", and there is no bot-side relogin story for
// a token that belongs to someone else. If a per-user token has expired/been
// revoked, the caller gets a plain 401 back from Mattermost and the route
// handlers below turn that into { error: 'mm_session_expired' } — the
// frontend's job is then to prompt that person to log back into /team (which
// re-runs loginAs() and stores a fresh mmToken).
async function coreFetchAsUser(token, path, opts = {}, context = 'coreFetchAsUser') {
  if (!config.mattermostUrl) throw new Error('MATTERMOST_URL is not configured');
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(opts.headers || {}) };
  const res = await fetchWithTimeout(`${config.mattermostUrl}/api/v4${path}`, { ...opts, headers });
  if (res.status === 401) {
    const err = new Error(`${context}: сессия Mattermost истекла или недействительна (HTTP 401)`);
    err.mmSessionExpired = true;
    throw err;
  }
  return asJsonOrThrow(res, context);
}

// GET /teams/{teamId}/channels/name/{channelName} — resolve a channel by its
// URL slug (what config.smmTeamChannelName holds) to its id + metadata,
// including total_msg_count (used for unread computation below).
async function getChannelByNameAsUser(token, teamId, channelName) {
  return coreFetchAsUser(
    token,
    `/teams/${teamId}/channels/name/${encodeURIComponent(channelName)}`,
    {},
    `getChannelByNameAsUser(${channelName})`
  );
}

// GET /channels/{channelId}/members/me — this user's own membership record
// for the channel (msg_count = how many of the channel's messages they've
// "read" as of last_viewed_at, per Mattermost's own bookkeeping).
async function getChannelMemberMeAsUser(token, channelId) {
  return coreFetchAsUser(token, `/channels/${channelId}/members/me`, {}, `getChannelMemberMeAsUser(${channelId})`);
}

// Combines a fresh channel fetch (for its current total_msg_count) with this
// user's membership record to compute how many messages they haven't seen
// yet. Fetching the channel fresh (rather than trusting a cached value from
// getChannelByNameAsUser) matters because total_msg_count changes every time
// ANYONE posts — exactly the number this button's accent state depends on.
async function getChannelUnreadAsUser(token, channelId) {
  const [channel, member] = await Promise.all([
    coreFetchAsUser(token, `/channels/${channelId}`, {}, `getChannelUnreadAsUser:channel(${channelId})`),
    getChannelMemberMeAsUser(token, channelId),
  ]);
  const unread = Math.max(0, (channel.total_msg_count || 0) - (member.msg_count || 0));
  return { unread, totalMsgCount: channel.total_msg_count || 0, msgCount: member.msg_count || 0 };
}

// GET /channels/{channelId}/posts?per_page=N — recent posts. Response shape
// is { order: [...ids, newest first], posts: { id: Post } } — callers
// re-order via `order` since Object.values(posts) has no guaranteed order.
async function listChannelPostsAsUser(token, channelId, perPage = 30) {
  return coreFetchAsUser(
    token,
    `/channels/${channelId}/posts?per_page=${encodeURIComponent(perPage)}`,
    {},
    `listChannelPostsAsUser(${channelId})`
  );
}

// POST /posts — creates the post as the token's own user (Mattermost infers
// the author from the auth token, not a field in the body).
async function createChannelPostAsUser(token, channelId, message) {
  return coreFetchAsUser(
    token,
    '/posts',
    { method: 'POST', body: JSON.stringify({ channel_id: channelId, message }) },
    `createChannelPostAsUser(${channelId})`
  );
}

// POST /channels/members/{userId}/view — tells Mattermost itself "I've now
// seen this channel", which is what advances member.msg_count / last_viewed_at
// (i.e. this is how the unread badge gets cleared, and it stays consistent
// even if the person separately opens real Mattermost).
async function markChannelViewedAsUser(token, userId, channelId) {
  return coreFetchAsUser(
    token,
    `/channels/members/${userId}/view`,
    { method: 'POST', body: JSON.stringify({ channel_id: channelId }) },
    `markChannelViewedAsUser(${channelId})`
  );
}

// POST /users/ids — bulk id→profile lookup, used to resolve each post's
// user_id to a display name when rendering the message list.
async function getUsersByIdsAsUser(token, ids) {
  const uniqueIds = Array.from(new Set((ids || []).filter(Boolean)));
  if (!uniqueIds.length) return [];
  return coreFetchAsUser(token, '/users/ids', { method: 'POST', body: JSON.stringify(uniqueIds) }, 'getUsersByIdsAsUser');
}

module.exports = {
  listTeamBoards,
  getBoard,
  listCards,
  listBlocks,
  getCardWithChildren,
  patchCardProperty,
  patchBlock,
  patchBoardCardProperty,
  deleteBlock,
  addCardComment,
  addBlocks,
  fetchFileStream,
  getUserIdByUsername,
  listTeamUsers,
  loginAs,
  getChannelByNameAsUser,
  getChannelUnreadAsUser,
  listChannelPostsAsUser,
  createChannelPostAsUser,
  markChannelViewedAsUser,
  getUsersByIdsAsUser,
};
