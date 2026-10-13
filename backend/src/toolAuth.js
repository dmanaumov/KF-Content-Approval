// toolAuth.js — self-serve "tool only" SaaS accounts: login by email/phone +
// password, kept ENTIRELY in our own Postgres (tool_accounts/tool_sessions,
// see db.js) — NEVER a Mattermost account. Deliberately separate from
// teamAuth.js (real Mattermost staff login): by direct request, "создаем
// учетку и ведем ее в базе данных! В маттермост его не впускаем!" — these
// people must never be able to reach anything gated by staffAuth/teamAuth.
//
// Session pattern mirrors teamAuth.js (opaque cookie -> Postgres-backed
// session, in-memory map as the runtime source of truth, rebuilt on boot)
// but with its own cookie name and table so the two systems never cross.

const crypto = require('crypto');
const db = require('./db');
const { hashSecret, verifySecret } = require('./secretHash');

const COOKIE_NAME = 'tool_session';
// Self-serve users have no reason to re-type a password every day the way
// /team's 24h TTL assumes (that TTL exists because re-login there is just
// typing Mattermost creds again, already memorized) — 30 days instead.
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const sessions = new Map(); // sessionId -> { accountId, account, expiresAt }

function newId() {
  return crypto.randomBytes(24).toString('base64url');
}

function normalizeLogin(login) {
  return String(login || '').trim();
}

async function createAccount({ login, password, displayName }) {
  const passwordHash = await hashSecret(password);
  const { rows } = await db.requirePool().query(
    `INSERT INTO tool_accounts (login, password_hash, display_name) VALUES ($1, $2, $3)
     RETURNING id, login, display_name`,
    [normalizeLogin(login), passwordHash, displayName || '']
  );
  return rows[0];
}

async function findByLogin(login) {
  const { rows } = await db.requirePool().query(
    `SELECT id, login, password_hash, display_name, is_disabled FROM tool_accounts WHERE lower(login) = lower($1)`,
    [normalizeLogin(login)]
  );
  return rows[0] || null;
}

async function verifyLogin(login, password) {
  const account = await findByLogin(login);
  if (!account || account.is_disabled) return null;
  const ok = await verifySecret(password, account.password_hash);
  if (!ok) return null;
  return { id: account.id, login: account.login, displayName: account.display_name };
}

// Кнопка "Сбросить пароль" в /admin/invites (по прямому запросу пользователя
// 2026-10-13) — для случая, когда self-serve пользователь забыл пароль и
// написал напрямую агентству, а не через какое-то (пока не существующее)
// "забыли пароль" на самом /tool. Генерирует новый пароль, хэширует,
// перезаписывает и возвращает ОТКРЫТЫМ ТЕКСТОМ ОДИН РАЗ — его показывает
// админ в интерфейсе и дальше передаёт пользователю сам, тем же принципом
// "отдельным каналом", что и код приглашения (см. toolInvites.js). Заодно
// гасит все текущие сессии этого аккаунта — старый пароль мог быть
// скомпрометирован, раз его вообще понадобилось сбрасывать.
function randomPassword() {
  // 9 байт base64url ~ 12 символов [A-Za-z0-9_-] — легко продиктовать/
  // скопировать, без неоднозначных спецсимволов.
  return crypto.randomBytes(9).toString('base64url');
}

async function resetPassword(accountId) {
  const password = randomPassword();
  const passwordHash = await hashSecret(password);
  const { rows } = await db.requirePool().query(
    `UPDATE tool_accounts SET password_hash = $2 WHERE id = $1 RETURNING id, login, display_name`,
    [accountId, passwordHash]
  );
  if (!rows[0]) return null;
  for (const [sessionId, entry] of sessions) {
    if (String(entry.accountId) === String(accountId)) sessions.delete(sessionId);
  }
  try {
    await db.requirePool().query(`DELETE FROM tool_sessions WHERE account_id = $1`, [accountId]);
  } catch (err) {
    console.error('[toolAuth] failed to clear sessions on password reset:', err.message);
  }
  return { account: rows[0], password };
}

async function createSession(account) {
  const id = newId();
  const expiresAt = Date.now() + SESSION_TTL_MS;
  sessions.set(id, { accountId: account.id, account, expiresAt });
  try {
    await db.requirePool().query(
      `INSERT INTO tool_sessions (id, account_id, expires_at) VALUES ($1, $2, to_timestamp($3 / 1000.0))`,
      [id, account.id, expiresAt]
    );
    // "Дата последнего входа" в SaaS-списке общей админки (прямой запрос
    // пользователя 2026-10-13) — createSession вызывается на каждом реальном
    // входе: и на POST /api/tool/login, и на авто-логине сразу после
    // регистрации по приглашению (считаем это первым "входом").
    await db.requirePool().query(`UPDATE tool_accounts SET last_login_at = now() WHERE id = $1`, [account.id]);
  } catch (err) {
    console.error('[toolAuth] failed to persist session:', err.message);
  }
  return id;
}

// Кнопка "Удалить" в SaaS-списке общей админки (прямой запрос пользователя
// 2026-10-13) — полная, безвозвратная зачистка аккаунта и всего, что он
// успел создать: задачи → проекты → приглашение, которым он был выпущен →
// сами сессии → сама учётка. Нет ON DELETE CASCADE на этих FK (см. db.js),
// поэтому порядок важен — от самых "глубоких" дочерних записей к самой
// учётке.
async function deleteAccount(accountId) {
  const pool = db.requirePool();
  const { rows } = await pool.query(`SELECT id, login, display_name FROM tool_accounts WHERE id = $1`, [accountId]);
  if (!rows[0]) return null;
  await pool.query(`DELETE FROM tool_tasks WHERE project_id IN (SELECT id FROM tool_projects WHERE account_id = $1)`, [accountId]);
  await pool.query(`DELETE FROM tool_projects WHERE account_id = $1`, [accountId]);
  await pool.query(`DELETE FROM tool_invites WHERE used_by_account_id = $1`, [accountId]);
  await pool.query(`DELETE FROM tool_sessions WHERE account_id = $1`, [accountId]);
  await pool.query(`DELETE FROM tool_accounts WHERE id = $1`, [accountId]);
  for (const [sessionId, entry] of sessions) {
    if (String(entry.accountId) === String(accountId)) sessions.delete(sessionId);
  }
  return rows[0];
}

// Lazy expiry — no background sweep timer, same posture as teamAuth.js.
function getSession(id) {
  if (!id) return null;
  const entry = sessions.get(id);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    sessions.delete(id);
    if (db.pool) db.pool.query('DELETE FROM tool_sessions WHERE id = $1', [id]).catch(() => {});
    return null;
  }
  return entry;
}

function destroySession(id) {
  if (!id) return;
  sessions.delete(id);
  if (db.pool) db.pool.query('DELETE FROM tool_sessions WHERE id = $1', [id]).catch(() => {});
}

async function restoreSessions() {
  if (!db.pool) return;
  try {
    const { rows } = await db.pool.query(
      `SELECT ts.id, ts.account_id, ts.expires_at, a.login, a.display_name
       FROM tool_sessions ts JOIN tool_accounts a ON a.id = ts.account_id
       WHERE ts.expires_at > now()`
    );
    rows.forEach((r) => {
      sessions.set(r.id, {
        accountId: r.account_id,
        account: { id: r.account_id, login: r.login, displayName: r.display_name },
        expiresAt: new Date(r.expires_at).getTime(),
      });
    });
    await db.pool.query('DELETE FROM tool_sessions WHERE expires_at <= now()');
    console.log(`[toolAuth] restored ${rows.length} tool session(s) from Postgres.`);
  } catch (err) {
    console.error('[toolAuth] failed to restore sessions:', err.message);
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

// `secure` left off, matching teamAuth.js's cookie — see its comment (this
// deployment runs over plain HTTP in production right now).
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

// Express middleware — attaches req.toolSession on success, otherwise 401.
// Deliberately NOT staffAuth/teamAuth — a tool_session can never satisfy
// those (different cookie, different table, no Mattermost user behind it).
function requireToolAuth(req, res, next) {
  const session = getSession(sessionIdFromRequest(req));
  if (!session) return res.status(401).json({ error: 'not_logged_in' });
  req.toolSession = session;
  next();
}

module.exports = {
  createAccount,
  findByLogin,
  verifyLogin,
  resetPassword,
  deleteAccount,
  createSession,
  getSession,
  destroySession,
  restoreSessions,
  setSessionCookie,
  clearSessionCookie,
  sessionIdFromRequest,
  requireToolAuth,
};
