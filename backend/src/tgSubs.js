// Client Telegram-reminder subscriptions (table client_tg_subs) — клиент один
// раз нажал в кабинете «напоминания в Telegram», получил deep link к боту,
// нажал /start с токеном, бот (n8n) вызвал POST /api/bot/client-subscribe, и
// теперь мы знаем его chat_id. Сами сообщения этим модулем НЕ отправляются —
// у приложения нет токена бота (см. botStore.js; отправку делает n8n через
// очередь исходящих). Здесь только «кто из чатов хочет получать напоминания
// по этому проекту».

const db = require('./db');

async function registerChat({ boardId, projectId, chatId }) {
  const pool = db.requirePool();
  const trimmed = String(chatId || '').trim();
  if (!trimmed) throw new Error('chatId обязателен.');
  const { rows } = await pool.query(
    `INSERT INTO client_tg_subs (chat_id, board_id, project_id, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (chat_id) DO UPDATE
       SET board_id = EXCLUDED.board_id, project_id = EXCLUDED.project_id, updated_at = now()
     RETURNING *`,
    [trimmed, boardId, projectId]
  );
  return rows[0];
}

async function unregisterChat({ chatId }) {
  const pool = db.requirePool();
  const trimmed = String(chatId || '').trim();
  if (!trimmed) return null;
  const { rows } = await pool.query('DELETE FROM client_tg_subs WHERE chat_id = $1 RETURNING *', [trimmed]);
  return rows[0] || null;
}

// Чьи чаты получать напоминания по проекту — используется автоматическим
// триггером (см. reminders.js): на переход карточки в "waiting" шлём всем,
// кто подписался, текст + ссылку на карточку.
async function chatIdsForProject(boardId, projectId) {
  const pool = db.requirePool();
  const { rows } = await pool.query(
    'SELECT chat_id FROM client_tg_subs WHERE board_id = $1 AND project_id = $2',
    [boardId, projectId]
  );
  return rows.map((r) => r.chat_id);
}

module.exports = { registerChat, unregisterChat, chatIdsForProject };