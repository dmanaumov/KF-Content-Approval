// Статистика по соцсетям — просмотры/реакции по опубликованным постам +
// еженедельное число подписчиков канала/паблика. Добавлено 2026-10-03 по
// запросу: "нам нужна статистика для дальнейшего формирования отчетов!
// можем ли автоматически ходить и контролировать результаты? Сколько
// просмотров, сколько и каких реакций? Можем ли раз в неделю проверять и
// логировать количество подписчиков в канале?".
//
// Первый слой — VK (полностью: просмотры/лайки/репосты/комментарии поста +
// подписчики паблика) и Telegram (только подписчики — Bot API не отдаёт
// просмотры канала вообще, см. claude/kf-social-stats-tracking.md в
// проекте "Мои IT дела" за разбор остальных сетей — ig/li/pin/ok/max
// оставлены на потом по решению Дмитрия 2026-10-03).
//
// Принципиальное архитектурное решение: НЕ заводим отдельных кредов под
// статистику. Переиспользуем те же per-project publishing credentials, что
// уже лежат в project_settings.social_credentials для n8n (см.
// getAutomationProjectCredentials/upsertAutomationProjectCredentials в
// index.js) — accessToken для vk, botToken для tg. Поле `accessToken` —
// подтверждённое из комментариев к тем функциям общее имя для всех сетей;
// на случай, если реальная автоматизация когда-то называла поля иначе,
// pickField() пробует по паре альтернативных имён, а не падает молча на
// первом же несовпадении.
//
// Личность канала/паблика (VK group id, Telegram @username) ТОЖЕ не новое
// поле креда — вытаскивается прямо из уже опубликованной ссылки поста
// (`url` у задачи, см. GET /api/automation/tasks) этого же проекта: для VK
// owner_id из "vk.com/wall-X_Y" и ЕСТЬ id паблика (без минуса), для
// Telegram — @username из "t.me/<username>/<msgId>". Значит для подписки
// нового проекта на статистику ничего отдельно настраивать не нужно сверх
// уже работающих публикационных кредов — если проект публикует, он уже
// готов к опросу.

const fetch = require('node-fetch');

const VK_API_VERSION = '5.199'; // см. kf-social-stats-tracking.md — сверено 2026-10-03 с dev.vk.ru/en/reference/roadmap
const REQUEST_TIMEOUT_MS = 15000;

function fetchWithTimeout(url, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  return fetch(url, { ...opts, signal: controller.signal }).finally(() => clearTimeout(timer));
}

// Достаёт первое непустое поле из списка альтернативных имён — см.
// комментарий в начале файла про freeform-формат socialCredentials.
function pickField(obj, names) {
  for (const name of names) {
    if (obj && obj[name] != null && obj[name] !== '') return obj[name];
  }
  return null;
}

// --- VK -------------------------------------------------------------------

// "https://vk.com/wall-123456_789" или "https://vk.com/club123456?w=wall-123456_789"
// → {ownerId:"-123456", postId:"789"}. ownerId отрицательный для постов от
// имени сообщества — именно это нам и нужно (личные страницы, ownerId>0,
// намеренно не трогаем, см. fetchVkGroupMembers ниже).
function parseVkWallUrl(url) {
  const m = String(url || '').match(/wall(-?\d+)_(\d+)/);
  if (!m) return null;
  return { ownerId: m[1], postId: m[2] };
}

async function vkApi(method, params, accessToken) {
  const qs = new URLSearchParams({ ...params, access_token: accessToken, v: VK_API_VERSION });
  const res = await fetchWithTimeout(`https://api.vk.com/method/${method}?${qs.toString()}`);
  const data = await res.json();
  if (data.error) {
    const err = new Error(`VK API ${method}: ${data.error.error_msg || 'unknown error'} (код ${data.error.error_code})`);
    err.vkError = data.error;
    throw err;
  }
  return data.response;
}

// idsList: [{ownerId, postId}, ...] — до 100 штук за раз (лимит VK на
// wall.getById); кто вызывает — сам режет на чанки по 100, см. index.js.
// Возвращает Map "ownerId_postId" → {views, likes, comments, reposts}.
async function fetchVkPostsStats(accessToken, idsList) {
  if (!idsList.length) return new Map();
  const posts = idsList.map((x) => `${x.ownerId}_${x.postId}`).join(',');
  const response = await vkApi('wall.getById', { posts }, accessToken);
  const map = new Map();
  for (const post of response || []) {
    const key = `${post.owner_id}_${post.id}`;
    map.set(key, {
      views: (post.views && post.views.count) ?? null,
      likes: (post.likes && post.likes.count) ?? null,
      comments: (post.comments && post.comments.count) ?? null,
      reposts: (post.reposts && post.reposts.count) ?? null,
    });
  }
  return map;
}

// ownerId — как из parseVkWallUrl (со знаком минус у сообщества). Для
// личной страницы (ownerId>0) подписчиков через groups.getById не узнать —
// возвращаем null, вызывающий код это должен просто пропустить.
async function fetchVkGroupMembers(accessToken, ownerId) {
  if (!String(ownerId).startsWith('-')) return null;
  const groupId = String(ownerId).slice(1);
  const response = await vkApi('groups.getById', { group_id: groupId, fields: 'members_count' }, accessToken);
  const group = Array.isArray(response) ? response[0] : response && Array.isArray(response.groups) ? response.groups[0] : null;
  return group ? group.members_count ?? null : null;
}

// --- Telegram ---------------------------------------------------------------

// Только публичные каналы — "https://t.me/channelname/123". Приватные
// (t.me/c/<numericId>/<msgId>) не резолвятся ботом в chat_id без
// дополнительной настройки (нужен сам numeric chat_id, которого в ссылке
// нет) — возвращаем null, пропускается как и любая другая несовпавшая
// ссылка.
function parseTelegramPublicUrl(url) {
  const m = String(url || '').match(/t\.me\/([A-Za-z0-9_]{5,})\/(\d+)/);
  if (!m || m[1].toLowerCase() === 'c' || m[1].toLowerCase() === 's') return null;
  return { username: `@${m[1]}`, messageId: m[2] };
}

async function fetchTelegramMemberCount(botToken, chatId) {
  const res = await fetchWithTimeout(`https://api.telegram.org/bot${botToken}/getChatMemberCount?chat_id=${encodeURIComponent(chatId)}`);
  const data = await res.json();
  if (!data.ok) {
    throw new Error(`Telegram getChatMemberCount: ${data.description || 'unknown error'}`);
  }
  return data.result;
}

// --- Хранение (Postgres, best-effort — см. философию teamComments.js) -----

const db = require('./db');

async function recordPostStats(boardId, taskId, network, stats) {
  const pool = db.requirePool();
  await pool.query(
    `INSERT INTO social_post_stats (board_id, task_id, network, views, likes, comments, reposts)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [boardId, taskId, network, stats.views, stats.likes, stats.comments, stats.reposts]
  );
}

async function recordChannelStats(boardId, projectId, network, subscriberCount) {
  const pool = db.requirePool();
  await pool.query(
    `INSERT INTO social_channel_stats (board_id, project_id, network, subscriber_count)
     VALUES ($1, $2, $3, $4)`,
    [boardId, projectId, network, subscriberCount]
  );
}

// История по ОДНОМУ посту — для будущего отчёта "как росли просмотры".
async function listPostStats(boardId, taskId) {
  if (!db.pool) return [];
  const { rows } = await db.pool.query(
    `SELECT network, views, likes, comments, reposts, fetched_at
       FROM social_post_stats WHERE board_id = $1 AND task_id = $2 ORDER BY fetched_at ASC`,
    [boardId, taskId]
  );
  return rows.map((r) => ({
    network: r.network,
    views: r.views,
    likes: r.likes,
    comments: r.comments,
    reposts: r.reposts,
    fetchedAt: r.fetched_at,
  }));
}

// История подписчиков — опционально фильтруется по проекту и/или сети.
async function listChannelStats(boardId, projectId, network) {
  if (!db.pool) return [];
  const params = [boardId];
  let where = 'board_id = $1';
  if (projectId) {
    params.push(projectId);
    where += ` AND project_id = $${params.length}`;
  }
  if (network) {
    params.push(network);
    where += ` AND network = $${params.length}`;
  }
  const { rows } = await db.pool.query(
    `SELECT project_id, network, subscriber_count, fetched_at FROM social_channel_stats WHERE ${where} ORDER BY fetched_at ASC`,
    params
  );
  return rows.map((r) => ({
    projectId: r.project_id,
    network: r.network,
    subscriberCount: r.subscriber_count,
    fetchedAt: r.fetched_at,
  }));
}

module.exports = {
  pickField,
  parseVkWallUrl,
  fetchVkPostsStats,
  fetchVkGroupMembers,
  parseTelegramPublicUrl,
  fetchTelegramMemberCount,
  recordPostStats,
  recordChannelStats,
  listPostStats,
  listChannelStats,
};
