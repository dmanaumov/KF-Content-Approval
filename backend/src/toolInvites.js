// toolInvites.js — invite links for self-serve "tool only" project creation
// (tool_invites table, see db.js). An admin issues one from the staff
// projects page (new POST /api/tool-invites, staffAuth-gated, see index.js);
// the TOKEN travels inside the URL (/invite/:token), the one-time CODE goes
// to the recipient through the admin's own channel (WhatsApp/etc) — the two
// are deliberately kept apart rather than both embedded in one link, by
// direct request: "нужен отдельный пароль/код для человека по ссылке".
// Redeeming an invite (token + correct code, once) creates a tool_accounts
// row and a first tool_projects row — see POST /api/invite/:token/redeem.
const crypto = require('crypto');
const db = require('./db');
const { hashSecret, verifySecret } = require('./secretHash');

function newToken() {
  return crypto.randomBytes(18).toString('base64url');
}

// 6-digit code — easy to read aloud or type on a phone. Not meant to resist
// a guess on its own; it only has to resist a guess PAIRED WITH the
// unguessable token already in the URL, which is what actually gates this.
function newCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

async function createInvite({ mode, createdBy }) {
  const token = newToken();
  const code = newCode();
  const codeHash = await hashSecret(code);
  const { rows } = await db.requirePool().query(
    `INSERT INTO tool_invites (token, code_hash, mode, created_by) VALUES ($1, $2, $3, $4)
     RETURNING id, token, mode, created_at`,
    [token, codeHash, mode || 'tool', createdBy || '']
  );
  // The plaintext code is returned to the caller EXACTLY ONCE, right here —
  // only its hash is ever persisted. If the admin loses it, the ORIGINAL code
  // is gone for good — but the same still-pending invite link can be given a
  // fresh code via reissueCode() below (2026-10-13 — "направить ссылку
  // повторно" в SaaS-списке общей админки), so a whole new invite isn't
  // required just because the code was lost.
  return { ...rows[0], code };
}

// "Направить повторно" в SaaS-списке (прямой запрос пользователя 2026-10-13):
// для ещё не погашенного приглашения выписывает НОВЫЙ код на тот же token —
// старый код (чей хэш уже не восстановить) перестаёт подходить. Тот же
// принцип "секрет виден только один раз, сразу после создания", что и у
// самого createInvite/resetPassword.
async function reissueCode(inviteId) {
  const code = newCode();
  const codeHash = await hashSecret(code);
  const { rows } = await db.requirePool().query(
    `UPDATE tool_invites SET code_hash = $2 WHERE id = $1 AND used_at IS NULL RETURNING id, token, mode`,
    [inviteId, codeHash]
  );
  if (!rows[0]) return null;
  return { ...rows[0], code };
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
    `SELECT id, token, code_hash, mode, used_at FROM tool_invites WHERE token = $1`,
    [token]
  );
  return rows[0] || null;
}

async function verifyInviteCode(invite, code) {
  return verifySecret(code, invite.code_hash);
}

// Called right after the new account + project are created, in the same
// request — see POST /api/invite/:token/redeem. If the process dies between
// "account created" and this call, the invite simply stays usable once more
// (its token+code are unguessable together) rather than the account getting
// silently orphaned from an invite marked used.
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

module.exports = { createInvite, reissueCode, deleteInvite, listInvites, getInviteByToken, verifyInviteCode, markInviteUsed };
