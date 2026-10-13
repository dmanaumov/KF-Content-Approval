// Postgres-backed store for the Telegram bot's own footprint («Кот
// Василий») — separate from project_settings/publication_log (those belong
// to the SMM-approval automation and its own AUTOMATION_API_KEY). Things
// that live here:
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
//   3. bot_channel_posts / bot_channel_subscriber_stats — weekly channel
//      stats (posts/views/reactions/comments/subscribers), added
//      2026-10-13. Same "this app never talks to Telegram directly"
//      principle: n8n scrapes each public channel's free t.me/s/<username>
//      page (posts/views/comments — Bot API exposes none of that
//      retroactively) and polls getChatMemberCount (subscribers), then POSTs
//      what it found to POST /api/bot/channel-posts and
//      POST /api/bot/channel-subscribers. Real-time reaction counts arrive
//      separately via Telegram's message_reaction_count update, relayed by
//      n8n to POST /api/bot/channel-reactions as they happen. See
//      claude/kf-social-stats-tracking.md for why Bot API alone can't do
//      this (no retroactive post history/views, no queryable reaction
//      history) and the "только публичные каналы" decision.
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
//
// username (added 2026-10-13): the channel's public @username, when it has
// one — needed to build a post's t.me/<username>/<id> link and to know
// which channels the weekly stats scrape can even reach (see
// getChannelWeeklyReport below: only chat_type='channel' AND
// status='administrator' are eligible, same gate, username is just the
// display/link detail). Same "only overwrite with a real value" treatment
// as title.
async function upsertChatEvent({ chatId, chatType, title, status, username, actorUserId, actorName, actorUsername }) {
  const pool = db.requirePool();
  const id = textOrEmpty(chatId);
  if (!id) throw new Error('chatId обязателен.');
  if (!textOrEmpty(status)) throw new Error('status обязателен.');
  const { rows } = await pool.query(
    `INSERT INTO bot_chats (chat_id, chat_type, title, status, username, added_by_user_id, added_by_name, added_by_username)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (chat_id) DO UPDATE
       SET chat_type = EXCLUDED.chat_type,
           title = CASE WHEN EXCLUDED.title <> '' THEN EXCLUDED.title ELSE bot_chats.title END,
           username = CASE WHEN EXCLUDED.username <> '' THEN EXCLUDED.username ELSE bot_chats.username END,
           status = EXCLUDED.status,
           status_updated_at = now(),
           updated_at = now()
     RETURNING *`,
    [id, textOrEmpty(chatType), textOrEmpty(title), textOrEmpty(status), textOrEmpty(username), textOrEmpty(actorUserId), textOrEmpty(actorName), textOrEmpty(actorUsername)]
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

// Bulk upsert of one channel's scraped posts (n8n's weekly scrape of
// t.me/s/<username>, one call per channel, посты за проход). Upsert by PK
// (chat_id, telegram_message_id) — views/comments/reactions_total only ever
// move forward in reality, but we still let a fresh scrape overwrite rather
// than GREATEST()-guard them here: the scrape always reads the CURRENT page
// state, so a lower number means Telegram's own count genuinely changed
// (e.g. a comment got deleted), not scraper noise — GREATEST() is reserved
// for upsertReactionCount below, which only ever receives real-time deltas
// that must never regress a figure the scrape already saw.
async function upsertChannelPosts(chatId, posts) {
  const pool = db.requirePool();
  const id = textOrEmpty(chatId);
  if (!id) throw new Error('chatId обязателен.');
  const list = Array.isArray(posts) ? posts : [];
  const saved = [];
  for (const p of list) {
    const messageId = textOrEmpty(p && p.telegramMessageId);
    if (!messageId) continue;
    const { rows } = await pool.query(
      `INSERT INTO bot_channel_posts (chat_id, telegram_message_id, url, text, published_at, views, comments_count, last_scraped_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now())
       ON CONFLICT (chat_id, telegram_message_id) DO UPDATE
         SET url = EXCLUDED.url,
             text = EXCLUDED.text,
             published_at = COALESCE(EXCLUDED.published_at, bot_channel_posts.published_at),
             views = EXCLUDED.views,
             comments_count = EXCLUDED.comments_count,
             last_scraped_at = now()
       RETURNING *`,
      [
        id,
        messageId,
        textOrEmpty(p.url),
        textOrEmpty(p.text),
        p.publishedAt || null,
        Number(p.views) || 0,
        Number(p.commentsCount) || 0,
      ]
    );
    saved.push(rows[0]);
  }
  return saved;
}

// Real-time message_reaction_count update for one post, relayed by n8n as
// Telegram pushes it (no historical backfill — see the AskUserQuestion
// answer "Да, включить с этого момента" 2026-10-13). GREATEST()-guarded:
// unlike upsertChannelPosts above, these arrive as discrete push events that
// can race the weekly scrape, so a stale/out-of-order update must never
// knock reactions_total back down. Inserts a bare row if the post hasn't
// been scraped yet (reaction push can arrive before the next weekly scrape
// first sees the post).
async function upsertReactionCount({ chatId, telegramMessageId, reactionsTotal, breakdown }) {
  const pool = db.requirePool();
  const id = textOrEmpty(chatId);
  const messageId = textOrEmpty(telegramMessageId);
  if (!id || !messageId) throw new Error('chatId и telegramMessageId обязательны.');
  const total = Number(reactionsTotal) || 0;
  const { rows } = await pool.query(
    `INSERT INTO bot_channel_posts (chat_id, telegram_message_id, reactions_total, reactions_breakdown, last_reaction_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (chat_id, telegram_message_id) DO UPDATE
       SET reactions_total = GREATEST(EXCLUDED.reactions_total, bot_channel_posts.reactions_total),
           reactions_breakdown = EXCLUDED.reactions_breakdown,
           last_reaction_at = now()
     RETURNING *`,
    [id, messageId, total, breakdown && typeof breakdown === 'object' ? JSON.stringify(breakdown) : '{}']
  );
  return rows[0];
}

// One weekly subscriber-count snapshot (n8n's getChatMemberCount poll) —
// APPEND-ONLY, see the bot_channel_subscriber_stats comment in db.js: we
// need a trend/delta, not just the latest value.
async function recordSubscriberCount(chatId, subscriberCount) {
  const pool = db.requirePool();
  const id = textOrEmpty(chatId);
  if (!id) throw new Error('chatId обязателен.');
  const { rows } = await pool.query(
    `INSERT INTO bot_channel_subscriber_stats (chat_id, subscriber_count) VALUES ($1, $2) RETURNING *`,
    [id, Number(subscriberCount) || 0]
  );
  return rows[0];
}

// The actual weekly report: for every channel the bot administers (same
// "администратор" gate as the staff-facing listChats filter conventions
// elsewhere in this app — a channel the bot is merely a member of can't be
// scraped reliably since we never confirmed it's actually public/ours to
// report on), aggregate the posts published in [fromDate, toDate), plus a
// subscriber count/delta comparing the latest snapshot before toDate against
// the latest snapshot before fromDate.
async function getChannelWeeklyReport(fromDate, toDate) {
  const pool = db.requirePool();
  const { rows: channels } = await pool.query(
    `SELECT chat_id, title, username FROM bot_chats
     WHERE chat_type = 'channel' AND status = 'administrator'
     ORDER BY title`
  );
  if (!channels.length) return [];
  const chatIds = channels.map((c) => c.chat_id);
  const { rows: posts } = await pool.query(
    `SELECT * FROM bot_channel_posts
     WHERE chat_id = ANY($1) AND published_at >= $2 AND published_at < $3
     ORDER BY published_at DESC`,
    [chatIds, fromDate, toDate]
  );
  const { rows: subsNow } = await pool.query(
    `SELECT DISTINCT ON (chat_id) chat_id, subscriber_count FROM bot_channel_subscriber_stats
     WHERE chat_id = ANY($1) AND recorded_at < $2
     ORDER BY chat_id, recorded_at DESC`,
    [chatIds, toDate]
  );
  const { rows: subsPrev } = await pool.query(
    `SELECT DISTINCT ON (chat_id) chat_id, subscriber_count FROM bot_channel_subscriber_stats
     WHERE chat_id = ANY($1) AND recorded_at < $2
     ORDER BY chat_id, recorded_at DESC`,
    [chatIds, fromDate]
  );
  const postsByChat = new Map();
  posts.forEach((p) => {
    if (!postsByChat.has(p.chat_id)) postsByChat.set(p.chat_id, []);
    postsByChat.get(p.chat_id).push(p);
  });
  const subsNowByChat = new Map(subsNow.map((r) => [r.chat_id, r.subscriber_count]));
  const subsPrevByChat = new Map(subsPrev.map((r) => [r.chat_id, r.subscriber_count]));
  return channels.map((c) => {
    const channelPosts = postsByChat.get(c.chat_id) || [];
    const viewsTotal = channelPosts.reduce((sum, p) => sum + Number(p.views || 0), 0);
    const reactionsTotal = channelPosts.reduce((sum, p) => sum + Number(p.reactions_total || 0), 0);
    const commentsTotal = channelPosts.reduce((sum, p) => sum + Number(p.comments_count || 0), 0);
    const subscriberCount = subsNowByChat.has(c.chat_id) ? subsNowByChat.get(c.chat_id) : null;
    const subscriberCountPrev = subsPrevByChat.has(c.chat_id) ? subsPrevByChat.get(c.chat_id) : null;
    const subscriberDelta = subscriberCount != null && subscriberCountPrev != null ? subscriberCount - subscriberCountPrev : null;
    const engagementRate = viewsTotal > 0 ? (reactionsTotal + commentsTotal) / viewsTotal : null;
    return {
      chatId: c.chat_id,
      title: c.title,
      username: c.username,
      postsCount: channelPosts.length,
      posts: channelPosts.map((p) => ({
        telegramMessageId: p.telegram_message_id,
        url: p.url,
        text: p.text,
        publishedAt: p.published_at,
        views: Number(p.views || 0),
        commentsCount: p.comments_count,
        reactionsTotal: p.reactions_total,
        reactionsBreakdown: p.reactions_breakdown,
      })),
      viewsTotal,
      reactionsTotal,
      commentsTotal,
      subscriberCount,
      subscriberDelta,
      engagementRate,
    };
  });
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
  upsertChannelPosts,
  upsertReactionCount,
  recordSubscriberCount,
  getChannelWeeklyReport,
};
