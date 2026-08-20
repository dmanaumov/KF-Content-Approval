// Session handling for the /team cabinet (see config.teamCabinetPath).
//
// Unlike everything else in this app, a team member logs in with their OWN
// real Mattermost username/password — checked live against Mattermost on
// every login (mattermostClient.loginAs), never stored anywhere by this app.
// What IS stored, in memory only (same philosophy as mattermostClient.js's
// own bot session — no database, a container restart just means everyone
// re-logs in), is a short-lived mapping from an opaque cookie value to that
// person's Mattermost session token + profile.
//
// No express-session/cookie-parser dependency — this is a handful of lines,
// not worth a new npm install (and this app's package.json has stayed
// deliberately small).

const crypto = require('crypto');

const COOKIE_NAME = 'team_session';
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24h — re-login is just typing MM creds again, low friction

const sessions = new Map(); // sessionId -> { mmToken, user, expiresAt }

function newSessionId() {
  return crypto.randomBytes(24).toString('base64url');
}

function createSession(mmToken, user) {
  const id = newSessionId();
  sessions.set(id, { mmToken, user, expiresAt: Date.now() + SESSION_TTL_MS });
  return id;
}

// Lazy expiry — no background sweep timer (matches this app's existing
// "no cron loops" style, see loadBoard()'s own lazy TTL cache). A small
// team's session count is trivial memory either way.
function getSession(id) {
  if (!id) return null;
  const entry = sessions.get(id);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    sessions.delete(id);
    return null;
  }
  return entry;
}

function destroySession(id) {
  if (id) sessions.delete(id);
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

module.exports = {
  createSession,
  getSession,
  destroySession,
  setSessionCookie,
  clearSessionCookie,
  sessionIdFromRequest,
  requireTeamAuth,
};
