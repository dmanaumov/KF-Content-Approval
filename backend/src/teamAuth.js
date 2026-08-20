// Session handling for the /team cabinet (see config.teamCabinetPath).
//
// Unlike everything else in this app, a team member logs in with their OWN
// real Mattermost username/password — checked live against Mattermost on
// every login (mattermostClient.loginAs), never stored anywhere by this app.
// What IS stored is a short-lived mapping from an opaque cookie value to that
// person's Mattermost session token + profile.
//
// Sessions live in the in-memory Map as the runtime source of truth AND are
// mirrored into Postgres (team_sessions table, see db.js) so a container
// restart / redeploy doesn't log everyone out — restoreSessions() rebuilds
// the map from Postgres on boot. Without DATABASE_URL the app falls back to
// memory-only (current behavior). Lazy expiry, no background sweep timer —
// matches this app's "no cron loops" style.

const crypto = require('crypto');
const config = require('./config');
const db = require('./db');

const COOKIE_NAME = 'team_session';
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24h — re-login is just typing MM creds again, low friction

const sessions = new Map(); // sessionId -> { mmToken, user, expiresAt }

function newSessionId() {
  return crypto.randomBytes(24).toString('base64url');
}

async function createSession(mmToken, user) {
  const id = newSessionId();
  const expiresAt = Date.now() + SESSION_TTL_MS;
  sessions.set(id, { mmToken, user, expiresAt });
  if (db.pool) {
    try {
      await db.pool.query(
        `INSERT INTO team_sessions (id, mm_token, user_data, expires_at)
         VALUES ($1, $2, $3, to_timestamp($4 / 1000.0))
         ON CONFLICT (id) DO NOTHING`,
        [id, mmToken, JSON.stringify(user), expiresAt]
      );
    } catch (err) {
      console.error('[teamAuth] failed to persist session:', err.message);
    }
  }
  return id;
}

// Lazy expiry — no background sweep timer (matches this app's existing
// "no cron loops" style, see loadBoard()'s own lazy TTL cache).
function getSession(id) {
  if (!id) return null;
  const entry = sessions.get(id);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    sessions.delete(id);
    if (db.pool) db.pool.query('DELETE FROM team_sessions WHERE id = $1', [id]).catch(() => {});
    return null;
  }
  return entry;
}

function destroySession(id) {
  if (!id) return;
  sessions.delete(id);
  if (db.pool) db.pool.query('DELETE FROM team_sessions WHERE id = $1', [id]).catch(() => {});
}

// Rebuild the in-memory session map from Postgres on boot (called once after
// initSchema). Expired rows are dropped at the same time.
async function restoreSessions() {
  if (!db.pool) return;
  try {
    const { rows } = await db.pool.query(
      'SELECT id, mm_token, user_data, expires_at FROM team_sessions WHERE expires_at > now()'
    );
    rows.forEach((r) => {
      sessions.set(r.id, { mmToken: r.mm_token, user: r.user_data, expiresAt: new Date(r.expires_at).getTime() });
    });
    await db.pool.query('DELETE FROM team_sessions WHERE expires_at <= now()');
    console.log(`[teamAuth] restored ${rows.length} team session(s) from Postgres.`);
  } catch (err) {
    console.error('[teamAuth] failed to restore sessions:', err.message);
  }
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    if (!key) continue;
    out[key] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

// `secure` is intentionally left off — this deployment runs over plain HTTP
// in production right now (see docs project notes: "HTTPS пользователь
// ВРЕМЕННО отключил"). A `Secure` cookie would silently never be sent over
// HTTP, breaking login entirely. Revisit once HTTPS is back on.
function setSessionCookie(res, id) {
  const maxAgeSec = Math.floor(SESSION_TTL_MS / 1000);
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=${encodeURIComponent(id)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}`
  );
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function sessionIdFromRequest(req) {
  return parseCookies(req)[COOKIE_NAME] || null;
}

// Express middleware — attaches req.teamSession on success, otherwise ends
// the request with a 401 the frontend treats as "show the login form".
function requireTeamAuth(req, res, next) {
  const session = getSession(sessionIdFromRequest(req));
  if (!session) {
    return res.status(401).json({ error: 'not_logged_in' });
  }
  req.teamSession = session;
  next();
}

// GET middleware for the /ceo dashboard — same /team session, but the email
// on the session's Mattermost profile must be on config.ceoEmails. Anyone
// else gets a 401 the frontend turns into "access denied / log into /team".
function requireCeoAuth(req, res, next) {
  const session = getSession(sessionIdFromRequest(req));
  const email = session && session.user ? String(session.user.email || '').toLowerCase().trim() : '';
  if (email && config.ceoEmails.includes(email)) {
    req.ceoUser = session.user;
    return next();
  }
  return res.status(401).json({ error: 'not_allowed', message: 'Доступ только владельцу.' });
}

module.exports = {
  createSession,
  getSession,
  destroySession,
  restoreSessions,
  setSessionCookie,
  clearSessionCookie,
  sessionIdFromRequest,
  requireTeamAuth,
  requireCeoAuth,
};