// Postgres-backed store for the Telegram bot's own footprint («Кот
// Василий») — separate from project_settings/publication_log (those belong
// to the SMM-approval automation and its own AUTOMATION_API_KEY). Two
// things live here:
//
//   1. bot_chats  — every group/channel/private chat the bot has ever been
//      added to (or messaged from), fed by n8n's my_chat_member handler via
//      POST /api/bot/channels (see index.js).
//   2. bot_messages — the bot's private-chat correspondence (potential
//      leads) plus the outgoing-send queue: this app never talks to
//      Telegram directly (no bot token here — see the big comment on
//      config.botApiKey), it only stores what n8n reports in and what staff
//      want sent out; n8n does the actual sending and reports back via
//      POST /api/bot/messages/:id/ack.
//
// See docs/N8N_AUTOMATION.md for the full wiring instructions this was
// built against.

const db = require('./db');

function textOrEmpty(value) {
  return value == null ? '' : String(value);
}

// Records one my_chat_member-style event: the bot's own membership status
// changed in a chat (added/removed/promoted). Upserted by chat_id — title
// and status always move to the latest report, but added_by_* is only ever
// set on the FIRST insert (see the DO UPDATE clause below, which
// deliberately omits those columns) so a later remove/re-add doesn't
// overwrite the record of who originally added the bot. If that's ever
// wrong for a specific case (bot removed and re-added by someone else
// months later), it's a manual DB fix, not something worth adding UI for.
async function upsertChatEvent({ chatId, chatType, title, status, actorUserId, actorName, actorUsername }) {
  const pool = db.requirePool();
  const id = textOrEmpty(chatId);
  if (!id) throw new Error('chatId обязателен.');
  if (!textOrEmpty(status)) throw new Error('status обязателен.');
  const { rows } = await pool.query(
    `INSERT INTO bot_chats (chat_id, chat_type, title, status, added_by_user_id, added_by_name, added_by_username)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (chat_id) DO UPDATE
       SET chat_type = EXCLUDED.chat_type,
           title = CASE WHEN EXCLUDED.title <> '' THEN EXCLUDED.title ELSE bot_chats.title END,
           status = EXCLUDED.status,
           status_updated_at = now(),
           updated_at = now()
     RETURNING *`,
    [id, textOrEmpty(chatType), textOrEmpty(title), textOrEmpty(status), textOrEmpty(actorUserId), textOrEmpty(actorName), textOrEmpty(actorUsername)]
  );
  return rows[0];
}

// Ensures a bot_chats row exists for a chat we only know about because a
// message arrived (private chats never fire my_chat_member on first
// contact — only on block/unblock) — called from insertMessage() below for
// every incoming message, cheap no-op if the chat is already known.
async function ensureChatSeen({ chatId, chatType, title }) {
  const pool = db.requirePool();
  const id = textOrEmpty(chatId);
  if (!id) return;
  await pool.query(
    `INSERT INTO bot_chats (chat_id, chat_type, title, status, status_updated_at)
     VALUES ($1, $2, $3, 'member', now())
     ON CONFLICT (chat_id) DO UPDATE
       SET title = CASE WHEN bot_chats.title = '' AND EXCLUDED.title <> '' THEN EXCLUDED.title ELSE bot_chats.title END,
           updated_at = now()`,
    [id, textOrEmpty(chatType), textOrEmpty(title)]
  );
}

// Incoming message from a user (direction='in', status='received' always).
async function insertMessage({ chatId, chatType, chatTitle, telegramMessageId, fromUserId, fromName, fromUsername, text }) {
  const id = textOrEmpty(chatId);
  if (!id) throw new Error('chatId обязателен.');
  await ensureChatSeen({ chatId: id, chatType, title: chatTitle || [fromName, fromUsername && `@${fromUsername}`].filter(Boolean).join(' ') });
  const pool = db.requirePool();
  const { rows } = await pool.query(
    `INSERT INTO bot_messages (chat_id, direction, status, telegram_message_id, from_user_id, from_name, from_username, text)
     VALUES ($1, 'in', 'received', $2, $3, $4, $5, $6)
     RETURNING *`,
    [id, textOrEmpty(telegramMessageId), textOrEmpty(fromUserId), textOrEmpty(fromName), textOrEmpty(fromUsername), textOrEmpty(text)]
  );
  return rows[0];
}

// Queues an outgoing message from the staff "Переписка" UI — status starts
// 'pending', n8n picks it up via listOutgoing() and acks it via
// markOutgoingAck() once it actually hits Telegram.
async function queueOutgoing({ chatId, text, sentBy }) {
  const id = textOrEmpty(chatId);
  if (!id) throw new Error('chatId обязателен.');
  const trimmed = textOrEmpty(text).trim();
  if (!trimmed) throw new Error('text обязателен.');
  const pool = db.requirePool();
  const { rows } = await pool.query(
    `INSERT INTO bot_messages (chat_id, direction, status, text, sent_by)
     VALUES ($1, 'out', 'pending', $2, $3)
     RETURNING *`,
    [id, trimmed, textOrEmpty(sentBy)]
  );
  return rows[0];
}

// n8n polling target — oldest-first, capped, only ever the still-pending
// ones (see the partial index in db.js).
async function listOutgoing(limit = 50) {
  const pool = db.requirePool();
  const { rows } = await pool.query(
    `SELECT id, chat_id, text, created_at FROM bot_messages
     WHERE direction = 'out' AND status = 'pending'
     ORDER BY created_at ASC
     LIMIT $1`,
    [Math.max(1, Math.min(200, limit || 50))]
  );
  return rows;
}

// n8n reports back what actually happened after it called Telegram's own
// sendMessage. status must be 'sent' or 'failed' — anything else is
// rejected by the route handler in index.js before this is called.
async function markOutgoingAck(id, { status, telegramMessageId, error }) {
  const pool = db.requirePool();
  const { rows } = await pool.query(
    `UPDATE bot_messages
     SET status = $2,
         telegram_message_id = COALESCE(NULLIF($3, ''), telegram_message_id),
         error = $4,
         sent_at = now()
     WHERE id = $1 AND direction = 'out'
     RETURNING *`,
    [id, status, textOrEmpty(telegramMessageId), textOrEmpty(error)]
  );
  return rows[0] || null;
}

// Tab 2 — "куда добавлен": groups/channels/supergroups the bot is a member
// of, most-recently-changed first. Private chats are deliberately excluded
// here (that's tab 3's job — see listLeads below); a chat that started as a
// private DM and nothing else never had a real my_chat_member "add" event.
async function listChats() {
  const pool = db.requirePool();
  const { rows } = await pool.query(
    `SELECT * FROM bot_chats WHERE chat_type <> 'private' ORDER BY status_updated_at DESC`
  );
  return rows;
}

// Tab 3 — "переписка": every private chat, each with its latest message
// (for the list preview + the "unread" highlight — unread means the last
// message is 'in', i.e. the client wrote and nobody from staff replied
// yet). LATERAL keeps this to one query instead of N+1.
async function listLeads() {
  const pool = db.requirePool();
  const { rows } = await pool.query(
    `SELECT c.*, m.text AS last_text, m.direction AS last_direction, m.created_at AS last_at, m.status AS last_status
     FROM bot_chats c
     LEFT JOIN LATERAL (
       SELECT text, direction, created_at, status
       FROM bot_messages
       WHERE bot_messages.chat_id = c.chat_id
       ORDER BY created_at DESC
       LIMIT 1
     ) m ON true
     WHERE c.chat_type = 'private'
     ORDER BY COALESCE(m.created_at, c.first_seen_at) DESC`
  );
  return rows;
}

async function getThread(chatId, limit = 500) {
  const pool = db.requirePool();
  const { rows } = await pool.query(
    `SELECT * FROM bot_messages WHERE chat_id = $1 ORDER BY created_at ASC LIMIT $2`,
    [textOrEmpty(chatId), Math.max(1, Math.min(2000, limit || 500))]
  );
  return rows;
}

module.exports = {
  upsertChatEvent,
  insertMessage,
  queueOutgoing,
  listOutgoing,
  markOutgoingAck,
  listChats,
  listLeads,
  getThread,
};
