// Одноразовый (но безопасно нажимаемый повторно) перенос задач/медиа/
// переписки с Mattermost Boards в Postgres — app_tasks/app_task_media/
// app_task_feedback (схема — db.js). Решение 2026-10-14: полный уход от
// Mattermost как хранилища задач, см. claude/kf-mattermost-to-postgres-
// migration.md в проекте «Мои IT дела» и claude/mattermost-boards-oom.md /
// claude/mattermost-session-limit.md — чем это вызвано.
//
// Используется из index.js тремя CEO-роутами (requireCeoAuth):
//   GET  /api/ceo/mattermost-migration/preview — ТОЛЬКО считает, что
//        получится перенести (карточки/медиа/переписка по типам), ничего
//        не пишет в Postgres и не трогает файлы Mattermost — безопасно
//        нажимать сколько угодно раз перед реальным запуском.
//   POST /api/ceo/mattermost-migration/run — запускает реальный перенос В
//        ФОНЕ и сразу отвечает 202. Прогресс/результат — через GET
//        .../status (поллинг с кнопки в CEO-интерфейсе).
//   POST /api/ceo/mattermost-migration/retry-media — вручную (пере)запускает
//        докатку того, что осталось в report.mediaErrors — см. ниже.
//
// РЕШЕНИЕ 2026-10-15 (по следам реального прогона: 971 карточка перенеслась
// за ~2-3 часа, потому что перезаливка каждого Mattermost-файла на диск шла
// СИНХРОННО внутри одной транзакции — и 208/371 файлов упали с disk.
// kontentferma (share API: 429) под устойчивой нагрузкой такого долгого
// прогона): перенос карточек и докатка медиа РАЗДЕЛЕНЫ.
//   1) runMigration() теперь БЫСТРЫЙ — TRUNCATE + заливка карточек/
//      переписки/уже-дисковых медиа одной транзакцией, без ожидания
//      Mattermost-файлов (gatherMigrationData вызывается с fastMedia:true —
//      все Mattermost-файлы попадают не в строки app_task_media, а в
//      отдельный список data.pendingMedia).
//   2) Сразу после commit — ФОНОВО стартует докатка ВСЕХ Mattermost-файлов
//      (runBackfill/startBackfillJob) с собственным ретраем (5 попыток,
//      эскалирующий бэкофф 1/5/10/30/60с — см. reuploadMattermostFileWithBackoff),
//      которая доливает строки app_task_media по мере успеха. Тот же
//      движок, что и у ручной кнопки «Докатить медиа» (для того, что
//      осталось в report.mediaErrors после всех попыток).
//   Перенос ИДЕМПОТЕНТЕН как и раньше (TRUNCATE ... CASCADE на каждый
//   запуск) — повторный клик не задваивает данные. Но: пока это всё ещё
//   Mattermost как источник правды (до деплоя фазы 3 переподключения
//   роутов) — см. claude/kf-mattermost-to-postgres-migration.md, там же
//   предупреждение, что ПОСЛЕ деплоя фазы 3 повторный запуск этого
//   переноса станет разрушительным (снесёт данные, появившиеся напрямую в
//   Postgres и которых больше нет в Mattermost).
//
// Данные вытягиваются через buildTasks() (taskMapper.js) с теми же опциями,
// что уже использует существующий одноразовый импорт ролей
// (/api/ceo/project-access/bootstrap в index.js) — {skipProjectFilter:true,
// includeAllStatuses:true} — чтобы получить ВСЕ карточки по ВСЕМ проектам
// в любой внутренней стадии, не только 5 клиентских статусов. buildTasks()
// уже объединяет Mattermost-файлы и уже-дисковые ссылки в один `media`
// массив и уже вычищает дисковые ссылки из текста описания — переиспользуем
// это напрямую, не дублируем.
//
// Переписка переносится НЕ из buildTasks().clientComments (та выборка — это
// только 4 клиентских маркера для сегодняшнего клиентского кабинета) — тут
// разбираются ВСЕ комментарии карточки, включая внутренние служебные
// маркеры (ТЕКСТ ОБНОВЛЁН, СТАТУС ИЗМЕНЁН, ...), т.к. решение пользователя —
// перенести ПОЛНУЮ историю, не только клиентский срез.

const config = require('./config');
const mm = require('./mattermostClient');
const db = require('./db');
const diskUpload = require('./diskUpload');
const taskCreators = require('./taskCreators');
const mediaOrder = require('./mediaOrder');
const pgTasks = require('./pgTasks');
const { buildTasks, findPropertyDef } = require('./taskMapper');
const { extractDiskLinks, stripDiskLinks, parseAndValidateShareUrl } = require('./diskEmbeds');

function normLabel(s) {
  return (s == null ? '' : String(s)).trim().replace(/\s+/g, ' ');
}

// Срезает ведущий "ДД.ММ.ГГГГ ЧЧ:MM " (formatMoscowTimestamp() в index.js
// ставит его перед любым маркером) — дальше классифицируем по тексту,
// момент берём из самого блока (block.createAt), не перепарсиваем строку.
const TS_PREFIX_RE = /^\d{2}\.\d{2}\.\d{4}\s+\d{2}:\d{2}\s+/;

// Полный словарь маркеров сервисного аккаунта — см. index.js (grep по
// addCardComment): formatMoscowTimestamp() + один из этих текстов пишется
// при каждом клиентском действии (СОГЛАСОВАНО/ПРАВКИ/ЗАКАЗЧИК...) или
// команда-видимом изменении (ТЕКСТ ОБНОВЛЁН/СТАТУС ИЗМЕНЁН/...). Порядок
// проверки не важен — после среза TS_PREFIX_RE маркеры не пересекаются.
const MARKERS = [
  { re: /^СОГЛАСОВАНО\s*$/, kind: 'approved', authorKind: 'client' },
  { re: /^ПРАВКИ\n\n([\s\S]*)$/, kind: 'feedback', authorKind: 'client', textGroup: 1, extractAttachment: true },
  { re: /^ЗАКАЗЧИК СКОРРЕКТИРОВАЛ ТЕКСТ\. ОБНОВЛЕНА ВЕРСИЯ\s*$/, kind: 'correction', authorKind: 'client' },
  { re: /^ЗАКАЗЧИК ИЗМЕНИЛ ПОРЯДОК МЕДИА:\n?([\s\S]*)$/, kind: 'correction', authorKind: 'client', textGroup: 1 },
  { re: /^СООБЩЕНИЕ(?:\s+\(([^)]*)\))?\n\n([\s\S]*)$/, kind: 'agency', authorKind: 'staff', nameGroup: 1, textGroup: 2, extractAttachment: true },
  { re: /^ТЕКСТ ОБНОВЛЁН(?:\s+\(([^)]*)\))?\s*$/, kind: 'system', authorKind: 'staff', nameGroup: 1 },
  { re: /^ПОРЯДОК МЕДИА ИЗМЕНЁН(?:\s+\(([^)]*)\))?:\n?([\s\S]*)$/, kind: 'system', authorKind: 'staff', nameGroup: 1, textGroup: 2 },
  { re: /^МАТЕРИАЛ УДАЛЁН(?:\s+\(([^)]*)\))?:\s*([\s\S]*)$/, kind: 'system', authorKind: 'staff', nameGroup: 1, textGroup: 2 },
  { re: /^СТАТУС ИЗМЕНЁН(?:\s+\(([^)]*)\))?:\s*([\s\S]*)$/, kind: 'system', authorKind: 'staff', nameGroup: 1, textGroup: 2 },
  { re: /^СОЦСЕТЬ ИЗМЕНЕНА(?:\s+\(([^)]*)\))?:\s*([\s\S]*)$/, kind: 'system', authorKind: 'staff', nameGroup: 1, textGroup: 2 },
  { re: /^НАЗВАНИЕ ИЗМЕНЕНО(?:\s+\(([^)]*)\))?\s*$/, kind: 'system', authorKind: 'staff', nameGroup: 1 },
  { re: /^ДОБАВЛЕН МАТЕРИАЛ(?:\s+\(([^)]*)\))?:\s*([\s\S]*)$/, kind: 'system', authorKind: 'staff', nameGroup: 1, textGroup: 2 },
  { re: /^ОПУБЛИКОВАНО(?:\s+\(([^)]*)\))?:\s*([\s\S]*)$/, kind: 'system', authorKind: 'staff', nameGroup: 1, textGroup: 2 },
  { re: /^КАРТОЧКА СОЗДАНА(?:\s+\(([^)]*)\))?\s*$/, kind: 'system', authorKind: 'staff', nameGroup: 1 },
];

const ALLOWED_KINDS = new Set(['approved', 'feedback', 'agency', 'correction', 'message', 'system']);
const ALLOWED_AUTHOR_KINDS = new Set(['', 'client', 'staff', 'system']);

// Один комментарий карточки -> {kind, authorKind, authorName, text,
// imageUrl}. usersMap: Map(mattermostUserId -> username), резолвится один
// раз на весь перенос (mm.listTeamUsers()), не по комментарию. Комментарий,
// не подошедший ни под один маркер, — это что-то, оставленное человеком
// прямо в Mattermost UI (до этого приложения, или в обход него): kind
// 'message', authorKind '' (не знаем, клиент это был или сотрудник).
function classifyComment(block, usersMap) {
  const raw = String(block.title || '');
  const body = raw.replace(TS_PREFIX_RE, '');
  for (const m of MARKERS) {
    const match = body.match(m.re);
    if (!match) continue;
    let text = m.textGroup ? (match[m.textGroup] || '').trim() : '';
    const authorName = m.nameGroup ? (match[m.nameGroup] || '').trim() : '';
    let imageUrl = '';
    if (m.extractAttachment && text) {
      const links = extractDiskLinks(text);
      const lastLink = links[links.length - 1];
      if (lastLink && text.trim().endsWith(lastLink)) {
        const validated = parseAndValidateShareUrl(lastLink);
        if (validated) {
          imageUrl = validated;
          text = stripDiskLinks(text, [lastLink]).trim();
        }
      }
    }
    return {
      kind: ALLOWED_KINDS.has(m.kind) ? m.kind : 'message',
      authorKind: ALLOWED_AUTHOR_KINDS.has(m.authorKind) ? m.authorKind : '',
      authorName,
      text,
      imageUrl,
    };
  }
  const authorName = usersMap.get(block.createdBy) || '';
  return { kind: 'message', authorKind: '', authorName, text: raw, imageUrl: '' };
}

// Скачивает файл блока с Mattermost и перезаливает на disk.kontentferma —
// результат встаёт в app_task_media.url вместо исходного fileId (решение
// «консолидировать всё на disk.kontentferma», 2026-10-14). folderName — тот
// же параметр, что и у обычной командной загрузки (см. uploadAndShare в
// index.js) — проектная метка, под отдельной подпапкой, чтобы не путать с
// файлами, залитыми вручную командой.
async function reuploadMattermostFile(boardId, mediaItem, folderName) {
  const mmRes = await mm.fetchFileStream(boardId, mediaItem.fileId);
  if (!mmRes.ok) {
    throw new Error(`Mattermost вернул ${mmRes.status} на файл ${mediaItem.fileId}`);
  }
  const buffer = Buffer.from(await mmRes.arrayBuffer());
  const mimeType = mmRes.headers.get('content-type') || mediaItem.mimeType || 'application/octet-stream';
  const extMatch = String(mediaItem.fileId || '').match(/\.[a-zA-Z0-9]+$/);
  const filename = `mm_${mediaItem.id}${extMatch ? extMatch[0] : ''}`;
  return diskUpload.uploadAndShare({
    folderName,
    subFolder: 'перенос с mattermost',
    filename,
    buffer,
    mimeType,
  });
}

// Пауза перед каждой следующей попыткой reuploadMattermostFile при фоновой
// докатке — решение 2026-10-15 (пользователь, по следам 208/371 файлов,
// упавших в первом прогоне с ошибкой "share API: 429"): встроенный ретрай
// в diskUpload.js (fetchWithAuthRetry429 — 2 попытки, короткий фиксированный
// бэкофф) рассчитан на единичную живую загрузку, а не на то, чтобы
// пересидеть устойчивую нагрузку миграции на сотнях файлов. 5 попыток,
// эскалирующий бэкофф 1/5/10/30/60с между ними (итого до 6 попыток: первая
// сразу + 5 повторов). Каждая попытка — ПОЛНЫЙ повтор reuploadMattermostFile
// (скачать с Mattermost заново + выложить на диск + расшарить): Mattermost
// не узкое место (рейт-лимитит именно диск), так что передогрузка байтов не
// страшна, а так проще, чем пробрасывать номер попытки внутрь diskUpload.js.
// СОЗНАТЕЛЬНО не трогали сам fetchWithAuthRetry429 — он общий с живыми
// роутами /team и /api/automation, и растягивать ретрай живой одиночной
// загрузки до ~1.5 минут в худшем случае ради миграционного сценария не
// нужно (пользователь просил это именно "для фоновой заливки ВСЕХ МЕДИА",
// не для обычной загрузки с кабинета).
const BACKFILL_RETRY_DELAYS_MS = [1000, 5000, 10000, 30000, 60000];

async function reuploadMattermostFileWithBackoff(boardId, mediaItem, folderName) {
  let lastErr;
  for (let attempt = 0; attempt <= BACKFILL_RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, BACKFILL_RETRY_DELAYS_MS[attempt - 1]));
    }
    try {
      return await reuploadMattermostFile(boardId, mediaItem, folderName);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

// Общий проход по всем карточкам борда — три режима:
//   (ничего не передано / download:false) — ПРЕДПРОСМОТР: ничего не
//     скачивает, Mattermost-медиа считает как плейсхолдер (чтобы показать
//     реалистичные итоговые цифры), ничего не пишет.
//   fastMedia:true — БЫСТРЫЙ перенос карточек (решение 2026-10-15, см.
//     комментарий в начале файла): Mattermost-медиа НЕ скачивается и НЕ
//     попадает в t.media — вместо этого копится в result.pendingMedia для
//     последующей фоновой докатки (runBackfill ниже).
//   download:true — старый синхронный режим (скачивает прямо здесь,
//     копит неудачи в result.mediaErrors). Больше не используется
//     runMigration() ниже, но оставлен — дешёвый, самодостаточный путь на
//     случай, если синхронный перенос медиа когда-то снова понадобится.
// onProgress({processed,total}) — для фонового прогресса run() (см.
// startRun ниже); preview может его не передавать.
async function gatherMigrationData(boardId, board, cards, blocks, { download, fastMedia, onProgress } = {}) {
  const { tasks } = buildTasks(board, cards, blocks, { skipProjectFilter: true, includeAllStatuses: true });
  const taskIds = tasks.map((t) => t.id);
  const [creators, teamUsers, mediaOrders] = await Promise.all([
    taskCreators.getCreators(boardId, taskIds),
    mm.listTeamUsers(),
    mediaOrder.getMediaOrders(boardId, taskIds),
  ]);
  const usersMap = new Map(teamUsers.map((u) => [u.id, u.username]));
  const archivedLabel = normLabel(config.statusOptionLabels.archived);

  const result = {
    tasks: [],
    mediaErrors: [],
    pendingMedia: [], // см. fastMedia выше — {taskId, position, folderName, mediaItem}
    counts: { tasks: 0, media: 0, mattermostFiles: 0, diskLinks: 0, feedback: {} },
  };

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    const folderName = task.projectLabel || 'Без клиента';
    const orderedMedia = mediaOrder.applyOrder(task.media, mediaOrders.get(task.id));
    const mediaRows = [];
    for (let pos = 0; pos < orderedMedia.length; pos++) {
      const item = orderedMedia[pos];
      if (item.source === 'mattermost') {
        result.counts.mattermostFiles++;
        if (fastMedia) {
          // Строку в app_task_media пока не пишем — url ещё не известен,
          // сам файл докатится фоном сразу после commit (см. runMigration).
          result.pendingMedia.push({ taskId: task.id, position: pos, folderName, mediaItem: item });
        } else if (download) {
          try {
            const url = await reuploadMattermostFile(boardId, item, folderName);
            mediaRows.push({ url, kind: item.kind || '', position: pos });
          } catch (err) {
            console.error(`[mattermostMigration] перезалить медиа ${item.fileId} (задача ${task.id}) не удалось:`, err.message);
            result.mediaErrors.push({ taskId: task.id, fileId: item.fileId, message: err.message });
          }
        } else {
          // Предпросмотр: не скачиваем, но считаем так, будто перенос прошёл
          // (реальные ошибки скачивания видны только при настоящем запуске).
          mediaRows.push({ url: `(mattermost:${item.fileId})`, kind: item.kind || '', position: pos });
        }
      } else {
        result.counts.diskLinks++;
        mediaRows.push({ url: item.shareUrl, kind: item.kind || '', position: pos });
      }
    }
    result.counts.media += mediaRows.length;

    const cardComments = blocks
      .filter((b) => b.parentId === task.id && b.type === 'comment' && !b.deleteAt)
      .sort((a, b) => (a.createAt || 0) - (b.createAt || 0));
    const feedbackRows = cardComments.map((b) => {
      const c = classifyComment(b, usersMap);
      result.counts.feedback[c.kind] = (result.counts.feedback[c.kind] || 0) + 1;
      return { ...c, createdAtMs: b.createAt || 0 };
    });

    result.tasks.push({
      id: task.id,
      projectId: task.projectId || '',
      title: task.title || '',
      status: task.statusLabel || '',
      format: task.format || '',
      publishDate: task.publishDate || '',
      caption: task.caption || '',
      keywords: task.keywords || '',
      reference: task.reference || '',
      publishedUrl: task.url || '',
      assigneeId: task.assigneeId || '',
      createdBy: creators.get(task.id) || '',
      isArchived: normLabel(task.statusLabel) === archivedLabel,
      createdAtMs: task.createAt || 0,
      updatedAtMs: task.updateAt || 0,
      media: mediaRows,
      feedback: feedbackRows,
    });
    result.counts.tasks++;
    if (onProgress) onProgress({ processed: i + 1, total: tasks.length });
  }
  return result;
}

function summarize(data) {
  return {
    tasksCount: data.counts.tasks,
    // mattermostFiles+diskLinks — верно во всех режимах (оба счётчика
    // инкрементируются безусловно, до ветвления по fastMedia/download) —
    // не полагаемся на counts.media, которое в fastMedia-режиме учитывает
    // только уже-дисковые строки.
    mediaCount: data.counts.mattermostFiles + data.counts.diskLinks,
    mattermostFilesCount: data.counts.mattermostFiles,
    diskLinksCount: data.counts.diskLinks,
    feedbackByKind: data.counts.feedback,
    mediaErrors: data.mediaErrors,
    // Сколько Mattermost-файлов ещё ждут фоновой докатки (fastMedia-режим) —
    // 0 в preview/download-режимах, т.к. там pendingMedia не используется.
    pendingMediaCount: (data.pendingMedia || []).length,
  };
}

// Только считает — не трогает Postgres, не скачивает ни одного файла.
async function previewMigration(boardId, { board, cards, blocks }) {
  const data = await gatherMigrationData(boardId, board, cards, blocks, { download: false });
  return summarize(data);
}

// Реальный перенос карточек — БЫСТРЫЙ (решение 2026-10-15, см. комментарий
// в начале файла): TRUNCATE трёх таблиц + заливка карточек/переписки/уже-
// дисковых медиа одной транзакцией, без ожидания Mattermost-файлов — те
// копятся в data.pendingMedia и докатываются фоном ПОСЛЕ commit (см.
// startRun ниже). Возвращает {report, pendingMedia} — report идёт в
// runState.report как раньше, pendingMedia сразу передаётся в фоновую
// докатку вызывающим кодом.
async function runMigration(boardId, { board, cards, blocks }, onProgress) {
  const data = await gatherMigrationData(boardId, board, cards, blocks, { fastMedia: true, onProgress });
  const pool = db.requirePool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('TRUNCATE app_task_feedback, app_task_media, app_tasks RESTART IDENTITY CASCADE');
    for (const t of data.tasks) {
      await client.query(
        `INSERT INTO app_tasks
           (id, project_id, board_id, title, status, format, publish_date, caption, keywords, reference,
            published_url, assignee_id, created_by, is_archived, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [
          t.id, t.projectId, boardId, t.title, t.status, t.format, t.publishDate, t.caption, t.keywords, t.reference,
          t.publishedUrl, t.assigneeId, t.createdBy, t.isArchived,
          t.createdAtMs ? new Date(t.createdAtMs) : new Date(),
          t.updatedAtMs ? new Date(t.updatedAtMs) : new Date(),
        ]
      );
      for (const m of t.media) {
        await client.query(
          `INSERT INTO app_task_media (task_id, url, kind, position, uploaded_at) VALUES ($1,$2,$3,$4,now())`,
          [t.id, m.url, m.kind, m.position]
        );
      }
      for (const f of t.feedback) {
        await client.query(
          `INSERT INTO app_task_feedback (task_id, kind, author_kind, author_name, text, image_url, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [t.id, f.kind, f.authorKind, f.authorName, f.text, f.imageUrl, f.createdAtMs ? new Date(f.createdAtMs) : new Date()]
        );
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return { report: summarize(data), pendingMedia: data.pendingMedia };
}

// ========================= Фоновая докатка медиа =========================
// Общий движок для двух сценариев:
//  1) АВТОМАТИЧЕСКИ сразу после быстрого переноса карточек (startRun ниже)
//     — targets уже полностью разрешены (из того же прохода
//     gatherMigrationData — data.pendingMedia), повторного чтения
//     Mattermost не требуется.
//  2) Вручную кнопкой «Докатить медиа» на /ceo/migration — targets теперь
//     ВСЕГДА пересчитываются заново сверкой живого Mattermost с текущим
//     Postgres (computeMissingMediaTargets ниже), а не из report.mediaErrors
//     в памяти процесса — та память пуста после любого рестарта бэкенда
//     (см. claude/kf-mattermost-to-postgres-migration.md), а эта сверка от
//     рестартов не зависит вообще.
// Каждый файл — reuploadMattermostFileWithBackoff (см. выше). retryState —
// общий прогресс/лог для поллинга (GET .../retry-media/status), один на
// оба сценария: кнопка в CEO-интерфейсе показывает и автоматическую, и
// ручную докатку одинаково.
let retryState = { state: 'idle', startedAt: null, finishedAt: null, progress: null, log: [], error: null };

function getMediaRetryStatus() {
  return retryState;
}

// taskId -> сколько медиафайлов этой задачи ещё не разрешено (ни успехом,
// ни окончательным провалом после всех попыток) в ТЕКУЩЕЙ докатке. Нужно
// отдельно от retryState.log/progress (те считают файлы, а не задачи, и не
// рассчитаны на поиск "эта задача ещё ждёт медиа?" annotateMigrationStatus
// в index.js — см. использование в getPendingMediaTaskIds ниже). Один
// файл с ошибкой также остаётся в runState.report.mediaErrors навсегда
// (до следующего прогона/докатки), но этот счётчик — только на время
// активной докатки, чтобы подсветка карточек не "зеленела" раньше времени.
let pendingMediaTaskCounts = new Map();

function markPendingTasks(targets) {
  pendingMediaTaskCounts = new Map();
  for (const t of targets) {
    pendingMediaTaskCounts.set(t.taskId, (pendingMediaTaskCounts.get(t.taskId) || 0) + 1);
  }
}

function resolvePendingTask(taskId) {
  const left = (pendingMediaTaskCounts.get(taskId) || 1) - 1;
  if (left <= 0) pendingMediaTaskCounts.delete(taskId);
  else pendingMediaTaskCounts.set(taskId, left);
}

// Используется annotateMigrationStatus() в index.js, чтобы подсвечивать
// карточку media_pending (жёлтым) пока её медиа ещё в активной докатке —
// до этого фикса там смотрели только на report.mediaErrors, который сразу
// после нового быстрого переноса пуст (ошибки пишутся туда только после
// всех 6 попыток, то есть минуты спустя), и карточки ложно зеленели.
function getPendingMediaTaskIds() {
  return Array.from(pendingMediaTaskCounts.keys());
}

// targets — уже разрешённые {taskId, position, folderName, mediaItem} (или
// {..., mediaItem: null, message} для таргетов, которые не удалось
// разрешить — см. computeMissingMediaTargets).
async function runBackfill(boardId, targets) {
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    const fileId = t.mediaItem ? t.mediaItem.fileId : t.fileId;
    const entry = { taskId: t.taskId, fileId, ok: false, message: '' };
    if (!t.mediaItem) {
      entry.message = t.message || 'Файл не найден.';
    } else {
      try {
        const url = await reuploadMattermostFileWithBackoff(boardId, t.mediaItem, t.folderName);
        await pgTasks.insertMedia(t.taskId, { url, kind: t.mediaItem.kind || '', position: t.position });
        entry.ok = true;
        // Если этот файл также числился в отчёте последнего переноса как
        // ошибка (сценарий 2 выше, или повторная докатка после частичного
        // сбоя) — убираем, чтобы следующий запуск не трогал его снова.
        if (runState.report) {
          runState.report.mediaErrors = (runState.report.mediaErrors || []).filter(
            (e) => !(e.taskId === entry.taskId && e.fileId === entry.fileId)
          );
        }
      } catch (err) {
        entry.message = err.message;
        // Фиксируем неудачу в report.mediaErrors — это единственное, что
        // переживает ДО следующего перезапуска сервера (см. предупреждение
        // выше) и то, чем пользуется ручная кнопка «Докатить медиа».
        if (runState.report) {
          if (!runState.report.mediaErrors) runState.report.mediaErrors = [];
          const exists = runState.report.mediaErrors.some((e) => e.taskId === entry.taskId && e.fileId === entry.fileId);
          if (!exists) runState.report.mediaErrors.push({ taskId: entry.taskId, fileId: entry.fileId, message: err.message });
        }
      }
    }
    retryState.log.push(entry);
    retryState.progress = { processed: i + 1, total: targets.length };
    resolvePendingTask(t.taskId);
  }
  return { total: targets.length, succeeded: retryState.log.filter((e) => e.ok).length };
}

// targets уже полностью разрешены (синхронный, немедленный старт — тот же
// паттерн, что у startRun: выставляем 'running' и возвращаем retryState
// сразу, сама работа идёт в фоне).
function startBackfillJob(boardId, targets) {
  if (retryState.state === 'running') {
    throw new Error('Докатка медиа уже выполняется — подождите её завершения.');
  }
  if (!targets.length) {
    throw new Error('Нет медиафайлов для докатки.');
  }
  retryState.state = 'running';
  retryState.startedAt = Date.now();
  retryState.finishedAt = null;
  retryState.progress = { processed: 0, total: targets.length };
  retryState.log = [];
  retryState.error = null;
  markPendingTasks(targets);
  runBackfill(boardId, targets)
    .then(() => {
      retryState.state = 'done';
      retryState.finishedAt = Date.now();
    })
    .catch((err) => {
      console.error('[mattermostMigration] докатка медиа упала:', err.message);
      retryState.state = 'error';
      retryState.finishedAt = Date.now();
      retryState.error = err.message;
    });
  return retryState;
}

// ВМЕСТО старого resolveMediaErrorTargets (разрешал только то, что было в
// report.mediaErrors в памяти процесса — ломалось при любом рестарте
// бэкенда, см. 2026-10-15 в project doc): сверяет ЖИВОЙ список
// Mattermost-медиа каждой карточки с тем, что уже РЕАЛЬНО лежит в Postgres
// (app_task_media.url) — источники правды напрямую, без зависимости от
// памяти процесса. Файл считается уже докатанным, если среди текущих URL
// задачи есть такой, что содержит `mm_<mediaItem.id>` — reuploadMattermostFile
// называет файл на диске именно так (`mm_${mediaItem.id}${ext}`), и это имя
// переживает любое число докаток/рестартов. Так же находит и файлы,
// которые ещё ни разу не пытались докатить, и те, что упали раньше —
// разницы для этой сверки нет, важно только "есть ли уже URL на диске".
async function computeMissingMediaTargets(boardId) {
  const [board, cards, blocks] = await Promise.all([
    mm.getBoard(boardId, config.teamId),
    mm.listCards(boardId),
    mm.listBlocks(boardId),
  ]);
  const { tasks } = buildTasks(board, cards, blocks, { skipProjectFilter: true, includeAllStatuses: true });
  const taskIds = tasks.map((t) => t.id);
  const [mediaOrders, existingUrlsByTask] = await Promise.all([
    mediaOrder.getMediaOrders(boardId, taskIds),
    pgTasks.getExistingMediaUrlsByTask(taskIds),
  ]);
  const targets = [];
  for (const task of tasks) {
    const orderedMedia = mediaOrder.applyOrder(task.media, mediaOrders.get(task.id));
    const existingUrls = existingUrlsByTask.get(task.id) || [];
    orderedMedia.forEach((item, pos) => {
      if (item.source !== 'mattermost') return;
      const marker = `mm_${item.id}`;
      if (existingUrls.some((u) => u.includes(marker))) return; // уже на диске
      targets.push({ taskId: task.id, fileId: item.fileId, position: pos, folderName: task.projectLabel || 'Без клиента', mediaItem: item });
    });
  }
  return targets;
}

// Ручная кнопка «Докатить медиа» — теперь ПОЛНОСТЬЮ асинхронная (раньше
// синхронно проверяла report.mediaErrors и сразу бросала при пустом
// списке — больше не можем решить это без похода в Mattermost+Postgres,
// см. computeMissingMediaTargets выше). index.js awaits на вызове.
async function startMediaRetry(boardId) {
  if (retryState.state === 'running') {
    throw new Error('Докатка медиа уже выполняется — подождите её завершения.');
  }
  if (runState.state === 'running') {
    throw new Error('Основной перенос ещё выполняется — подождите его завершения.');
  }
  const targets = await computeMissingMediaTargets(boardId);
  if (!targets.length) {
    throw new Error('Нечего докатывать — все Mattermost-медиа уже на диске.');
  }
  retryState.state = 'running';
  retryState.startedAt = Date.now();
  retryState.finishedAt = null;
  retryState.progress = { processed: 0, total: targets.length };
  retryState.log = [];
  retryState.error = null;
  markPendingTasks(targets);
  runBackfill(boardId, targets)
    .then(() => {
      retryState.state = 'done';
      retryState.finishedAt = Date.now();
    })
    .catch((err) => {
      console.error('[mattermostMigration] докатка медиа упала:', err.message);
      retryState.state = 'error';
      retryState.finishedAt = Date.now();
      retryState.error = err.message;
    });
  return retryState;
}
// ======================= /Фоновая докатка медиа ===========================

// Фоновый запуск + статус для поллинга — см. комментарий в начале файла:
// POST .../run не ждёт реальный перенос, он только стартует его и сразу
// отвечает; кнопка в CEO-интерфейсе опрашивает GET .../status, пока state
// не станет 'done'/'error'. С 2026-10-15 сама транзакция быстрая (карточки
// без медиа-файлов) — после её commit сразу стартует фоновая докатка
// media (см. startBackfillJob выше), поэтому runState и retryState почти
// всегда переходят в 'running' практически одновременно.
let runState = { state: 'idle', startedAt: null, finishedAt: null, progress: null, report: null, error: null };

function getRunStatus() {
  return runState;
}

function startRun(boardId, { board, cards, blocks }) {
  if (runState.state === 'running') {
    throw new Error('Перенос уже выполняется — подождите его завершения.');
  }
  if (retryState.state === 'running') {
    throw new Error('Докатка медиа ещё идёт в фоне — дождитесь её завершения, прежде чем запускать перенос заново (иначе она попытается дописать медиа для задач, которые вот-вот пересоздадутся TRUNCATE).');
  }
  runState.state = 'running';
  runState.startedAt = Date.now();
  runState.finishedAt = null;
  runState.progress = { processed: 0, total: 0 };
  runState.report = null;
  runState.error = null;
  runMigration(boardId, { board, cards, blocks }, (p) => {
    runState.progress = p;
  })
    .then(({ report, pendingMedia }) => {
      runState.state = 'done';
      runState.finishedAt = Date.now();
      runState.report = report;
      // Карточки уже в базе — сразу фоном поднимаем докатку ВСЕХ
      // Mattermost-медиа этого прогона (решение 2026-10-15). targets уже
      // полностью разрешены (тот же проход gatherMigrationData), повторного
      // чтения Mattermost не требуется.
      if (pendingMedia && pendingMedia.length) {
        try {
          startBackfillJob(boardId, pendingMedia);
        } catch (err) {
          console.error('[mattermostMigration] не удалось автоматически запустить докатку медиа после переноса:', err.message);
        }
      }
    })
    .catch((err) => {
      console.error('[mattermostMigration] перенос упал:', err.message);
      runState.state = 'error';
      runState.finishedAt = Date.now();
      runState.error = err.message;
    });
  return runState;
}

module.exports = { previewMigration, startRun, getRunStatus, startMediaRetry, getMediaRetryStatus, getPendingMediaTaskIds };
