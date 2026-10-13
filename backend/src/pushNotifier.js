// Web Push (Push API) delivery — "клиент один раз подписался на уведомления,
// дальше напоминания приходят на его телефон сами". Push-инфраструктура
// (браузер клиента → своя подписка → пуш-сервис БРАУЗЕРА) — это не канал
// типа Telegram (у него не бывает "входящих от клиента", которые надо
// кому-то показывать), поэтому, в отличие от бота (см. botStore.js, принцип
// "это приложение само никогда не звонит во внешний send-API"), web-push
// шлём напрямую — за подписки и их состояние отвечаем мы сами, и здесь не
// требуется ни n8n, ни ручной посредник.
//
// VAPID-ключи: берутся из config (env VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY),
// а если не заданы — генерируются один раз при первом старте и сохраняются
// в api_keys (см. apiKeys.js), чтобы передеплой не ломал уже подписавшихся
// клиентов (публичный ключ обязан совпадать с тем, что отдавался кабинету
// в момент подписки). Подписки живут в Postgres (таблица push_subscriptions)
// и привязаны к (board_id, project_id), а НЕ к link-токену — ротация ссылки
// не должна обрубать устройства, которые уже подписались.

const webpush = require('web-push');
const config = require('./config');
const apiKeys = require('./apiKeys');

// Мультиподписочная отправка от одного веб-воркера на много устройств — на
// боевом проекте уже были инциденты с одновременным хайпом на Nextcloud
// (см. MEDIA_UPLOAD_MAX_CONCURRENT в index.js), поэтому рассылка по всем
// устройствам проекта ограничена по параллелизму: каждая следующая подписка
// ждёт завершения предыдущей, а не футболит пуш-сервис браузера пачкой.
let sendQueue = Promise.resolve();
function serial(fn) {
  sendQueue = sendQueue.then(fn, fn);
  return sendQueue;
}

// Долгоживущие VAPID-ключи — кэш внутри процесса, инициализируется один раз
// (см. init()). Обновлять на лету не нужно: ключи меняются только вручную в
// env/вкладке /ceo/api-keys, а любой следующий deploy перезапускает процесс.
let vapid = null; // { publicKey, privateKey, subject } | null

async function ensureVapidKeys() {
  if (vapid) return vapid;
  let pub = config.vapidPublicKey;
  let priv = config.vapidPrivateKey;
  if (!pub || !priv) {
    // Env не задан — попробуем ранее сохранённые в api_keys (генерируются
    // здесь ниже при первом старте).
    pub = apiKeys.getValueSync('VAPID_PUBLIC_KEY') || '';
    priv = apiKeys.getValueSync('VAPID_PRIVATE_KEY') || '';
  }
  if (!pub || !priv) {
    const generated = webpush.generateVAPIDKeys();
    pub = generated.publicKey;
    priv = generated.privateKey;
    try {
      await apiKeys.upsertKey('VAPID_PUBLIC_KEY', { label: 'Web Push — публичный ключ (кабинету не показывается)', value: pub });
      await apiKeys.upsertKey('VAPID_PRIVATE_KEY', { label: 'Web Push — приватный ключ подписи', value: priv });
      console.log('[push] VAPID-ключи сгенерированы и сохранены в api_keys.');
    } catch (err) {
      console.warn(`[push] не удалось сохранить VAPID-ключи в api_keys: ${err.message}`);
    }
  }
  vapid = { publicKey: pub, privateKey: priv, subject: config.vapidSubject };
  return vapid;
}

// Вызывается один раз при старте приложения (после apiKeys.init(), чтобы
// api_keys уже был прочитан в себя). Если БД недоступна (DATABASE_URL не
// задан / Postgres поднимается) — смена статуса карточки продолжит работать,
// просто push-функция будет отключена до следующего перезапуска: уведомления
// в этом режиме не рассылаются, кабинет вернёт публичный ключ пустым.
async function init() {
  try {
    await ensureVapidKeys();
  } catch (err) {
    console.warn(`[push] VAPID-инициализация отложена: ${err.message}`);
  }
  return vapid;
}

// Публичный ключ для кабинета (GET /api/links/:token/push/public-key) —
// кабинет передаёт его в pushManager.subscribe как applicationServerKey.
function getPublicKey() {
  return vapid && vapid.publicKey ? vapid.publicKey : (config.vapidPublicKey || '');
}

// Сохраняет подписку одного устройства. Идемпотентный upsert по endpoint:
// повторный клик "подписаться" с тем же браузером обновляет строку, а не
// плодит дубликаты.
async function subscribe({ endpoint, p256dh, auth, boardId, projectId, userAgent }) {
  const db = require('./db');
  const pool = db.requirePool();
  const trimmedEndpoint = String(endpoint || '').trim();
  if (!trimmedEndpoint || !p256dh || !auth) throw new Error('endpoint/p256dh/auth обязательны.');
  const { rows } = await pool.query(
    `INSERT INTO push_subscriptions (endpoint, board_id, project_id, p256dh, auth, user_agent, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (endpoint) DO UPDATE
       SET board_id = EXCLUDED.board_id,
           project_id = EXCLUDED.project_id,
           p256dh = EXCLUDED.p256dh,
           auth = EXCLUDED.auth,
           user_agent = EXCLUDED.user_agent,
           updated_at = now()
     RETURNING endpoint`,
    [trimmedEndpoint, boardId, projectId, p256dh, auth, String(userAgent || '').slice(0, 512)]
  );
  return rows[0];
}

// Снимает подписку конкретного устройства (кнопка "отписаться", или
// подписка устарела — endpoint пуш-сервиса уже не существует).
async function unsubscribe({ endpoint }) {
  const db = require('./db');
  const pool = db.requirePool();
  const trimmedEndpoint = String(endpoint || '').trim();
  if (!trimmedEndpoint) return null;
  const { rows } = await pool.query('DELETE FROM push_subscriptions WHERE endpoint = $1 RETURNING endpoint', [trimmedEndpoint]);
  return rows[0] || null;
}

async function subscriptionsForProject(boardId, projectId) {
  const db = require('./db');
  const pool = db.requirePool();
  const { rows } = await pool.query(
    `SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE board_id = $1 AND project_id = $2`,
    [boardId, projectId]
  );
  return rows;
}

// Отправка одному устройству с разбором типовых ошибок пуш-сервиса:
//   404/410 — подписка больше не существует (браузер отписался/удалил сайт)
//   → удаляем её из БД, чтобы не долбить мёртвый endpoint на каждом триггере.
//   Остальное (429/5xx/сеть) — не фатально, лог + следующая попытка будет
//   при следующем срабатывании.
async function sendToOne(subscription, payload) {
  try {
    await webpush.sendNotification(
      { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } },
      JSON.stringify(payload)
    );
    return { ok: true };
  } catch (err) {
    const status = err && err.statusCode;
    if (status === 404 || status === 410) {
      await unsubscribe({ endpoint: subscription.endpoint }).catch(() => {});
      return { ok: true, pruned: true, statusCode: status };
    }
    console.warn(`[push] доставка не удалась (${status || err.message}): ${String(err.message).slice(0, 300)}`);
    return { ok: false, statusCode: status };
  }
}

// Рассылает уведомление ВСЕМ устройствам, подписанным на проект. Вызовы
// не блокируют вызывающий код (fire-and-forget с последовательной отправкой),
// чтобы задержка на пуш-сервис не замедляла смену статуса карточки.
function notifyProject({ boardId, projectId, title, body, url }) {
  const publicKey = getPublicKey();
  if (!publicKey) {
    // VAPID не настроен — функция "уведомлений на телефон" просто не включена.
    return Promise.resolve({ ok: false, reason: 'vapid_not_configured' });
  }
  return subscriptionsForProject(boardId, projectId)
    .then((subs) => {
      const payload = { title, body, url };
      subs.forEach((sub) => {
        serial(() => sendToOne(sub, payload));
      });
      return { ok: true, targets: subs.length };
    })
    .catch((err) => {
      console.warn(`[push] рассылка по проекту ${boardId}/${projectId} не удалась: ${err.message}`);
      return { ok: false };
    });
}

module.exports = { init, getPublicKey, subscribe, unsubscribe, subscriptionsForProject, notifyProject };