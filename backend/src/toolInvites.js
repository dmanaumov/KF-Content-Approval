// toolInvites.js — invite links for self-serve "tool only" project creation
// (tool_invites table, see db.js). An admin issues one from the staff
// projects page (new POST /api/tool-invites, staffAuth-gated, see index.js);
// the TOKEN travels inside the URL (/invite/:token) and is itself the whole
// secret — unguessable (18 random bytes, base64url) — so a separate one-time
// CODE was dropped on 2026-10-13 at the direct request: "достаточно
// уникальной ссылки". Redeeming an invite (token, used once) creates a
// tool_accounts row and a first tool_projects row — see
// POST /api/invite/:token/redeem.
const crypto = require('crypto');
const db = require('./db');

function newToken() {
  return crypto.randomBytes(18).toString('base64url');
}

async function createInvite({ mode, createdBy }) {
  const token = newToken();
  const { rows } = await db.requirePool().query(
    `INSERT INTO tool_invites (token, mode, created_by) VALUES ($1, $2, $3)
     RETURNING id, token, mode, created_at`,
    [token, mode || 'tool', createdBy || '']
  );
  return { ...rows[0] };
}

async function listInvites() {
  const { rows } = await db.requirePool().query(
    // used_by_login/display_name/last_login_at/is_disabled добавлены
    // 2026-10-13 — нужны фронту (вкладка "SaaS" общей админки) для колонок
    // "дата последнего входа" и действий ("Сбросить пароль"/"Удалить") без
    // отдельного запроса на аккаунт.
    `SELECT ti.id, ti.token, ti.mode, ti.created_by, ti.created_at, ti.used_at, ti.used_by_account_id,
            a.login AS used_by_login, a.display_name AS used_by_display_name,
            a.last_login_at AS used_by_last_login_at, a.is_disabled AS used_by_is_disabled
     FROM tool_invites ti LEFT JOIN tool_accounts a ON a.id = ti.used_by_account_id
     ORDER BY ti.created_at DESC`
  );
  return rows;
}

async function getInviteByToken(token) {
  const { rows } = await db.requirePool().query(
    `SELECT id, token, mode, used_at FROM tool_invites WHERE token = $1`,
    [token]
  );
  return rows[0] || null;
}

// Called right after the new account + project are created, in the same
// request — see POST /api/invite/:token/redeem. If the process dies between
// "account created" and this call, the invite simply stays usable once more
// (its token is unguessable) rather than the account getting silently
// orphaned from an invite marked used.
async function markInviteUsed(inviteId, accountId) {
  await db.requirePool().query(
    `UPDATE tool_invites SET used_at = now(), used_by_account_id = $2 WHERE id = $1`,
    [inviteId, accountId]
  );
}

// "Удалить" в SaaS-списке для ещё НЕ погашенного приглашения (прямой запрос
// пользователя 2026-10-13) — просто убирает саму ссылку-приглашение; для
// уже погашенного (есть аккаунт) используется toolAuth.deleteAccount вместо
// этого (она попутно удаляет и связанную запись тут же).
async function deleteInvite(id) {
  const { rowCount } = await db.requirePool().query(
    `DELETE FROM tool_invites WHERE id = $1 AND used_at IS NULL`,
    [id]
  );
  return rowCount > 0;
}

module.exports = { createInvite, deleteInvite, listInvites, getInviteByToken, markInviteUsed };
