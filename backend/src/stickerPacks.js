// DB access for the per-project Telegram sticker catalog — see the big
// comment in db.js above project_sticker_packs/telegram_stickers for the
// overall design. A project can have SEVERAL packs linked (different
// clients, and even one client over time, may register more than one
// set), so this is a proper one-to-many, not a single column.

const db = require('./db');

// One row per linked pack: { packName, packTitle, syncedAt, stickers: [...] }
async function listPacks(boardId, projectId) {
  const pool = db.requirePool();
  const { rows: packRows } = await pool.query(
    `SELECT pack_name, pack_title, synced_at FROM project_sticker_packs
      WHERE board_id = $1 AND project_id = $2 ORDER BY position`,
    [boardId, projectId]
  );
  if (!packRows.length) return [];
  const names = packRows.map((r) => r.pack_name);
  const { rows: stickerRows } = await pool.query(
    `SELECT custom_emoji_id, emoji, pack_name FROM telegram_stickers
      WHERE pack_name = ANY($1::text[]) ORDER BY pack_name, position`,
    [names]
  );
  const byPack = new Map(names.map((n) => [n, []]));
  for (const s of stickerRows) {
    (byPack.get(s.pack_name) || []).push({
      customEmojiId: s.custom_emoji_id,
      emoji: s.emoji,
      thumbUrl: `/api/sticker-thumb/${encodeURIComponent(s.custom_emoji_id)}`,
    });
  }
  return packRows.map((r) => ({
    packName: r.pack_name,
    packTitle: r.pack_title || '',
    syncedAt: r.synced_at,
    stickers: byPack.get(r.pack_name) || [],
  }));
}

// Links a NEW pack to the project (or re-syncs one already linked) —
// additive, never removes other packs already linked to this project.
// `fetched` is telegramStickers.fetchStickerSet()'s result — { title,
// stickers: [{ customEmojiId, emoji, fileId, fileUniqueId, thumbFileId }] }.
// Stale rows for this exact pack_name are cleared first so a sticker
// removed from the pack on Telegram's side actually disappears here too.
async function addOrSyncPack(boardId, projectId, packName, fetched) {
  const pool = db.requirePool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM telegram_stickers WHERE pack_name = $1`, [packName]);
    let i = 0;
    for (const s of fetched.stickers) {
      await client.query(
        `INSERT INTO telegram_stickers (custom_emoji_id, pack_name, emoji, file_id, file_unique_id, thumb_file_id, position)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (custom_emoji_id) DO UPDATE SET
           pack_name = EXCLUDED.pack_name, emoji = EXCLUDED.emoji, file_id = EXCLUDED.file_id,
           file_unique_id = EXCLUDED.file_unique_id, thumb_file_id = EXCLUDED.thumb_file_id,
           position = EXCLUDED.position, updated_at = now()`,
        [s.customEmojiId, packName, s.emoji, s.fileId, s.fileUniqueId, s.thumbFileId, i++]
      );
    }
    const { rows: countRows } = await client.query(
      `SELECT COUNT(*) FROM project_sticker_packs WHERE board_id = $1 AND project_id = $2`,
      [boardId, projectId]
    );
    const nextPosition = Number(countRows[0].count);
    await client.query(
      `INSERT INTO project_sticker_packs (board_id, project_id, pack_name, pack_title, position, synced_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (board_id, project_id, pack_name) DO UPDATE SET
         pack_title = EXCLUDED.pack_title, synced_at = now()`,
      [boardId, projectId, packName, fetched.title, nextPosition]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Unlinks one pack from this project. Deliberately does NOT delete its
// rows from telegram_stickers — that table is shared/global (another
// project could reference the same pack_name, and even if not, keeping a
// few KB of harmless cached metadata around costs nothing) — see the
// comment on telegram_stickers in db.js for why it is a global table at
// all.
async function removePack(boardId, projectId, packName) {
  const pool = db.requirePool();
  await pool.query(
    `DELETE FROM project_sticker_packs WHERE board_id = $1 AND project_id = $2 AND pack_name = $3`,
    [boardId, projectId, packName]
  );
}

// Looks up one sticker by id regardless of which project/pack it belongs
// to — backs the unauthenticated thumbnail-serving route, same "obscure id,
// no project scoping" posture as /api/files/:boardId/:fileId.
async function findSticker(customEmojiId) {
  const pool = db.requirePool();
  const { rows } = await pool.query(
    `SELECT custom_emoji_id, emoji, thumb_file_id FROM telegram_stickers WHERE custom_emoji_id = $1`,
    [customEmojiId]
  );
  if (!rows.length) return null;
  return { customEmojiId: rows[0].custom_emoji_id, emoji: rows[0].emoji, thumbFileId: rows[0].thumb_file_id };
}

module.exports = { listPacks, addOrSyncPack, removePack, findSticker };
