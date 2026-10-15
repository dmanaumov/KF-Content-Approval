// Одноразовый (но безопасно нажимаемый повторно) перенос задач/медиа/
// переписки с Mattermost Boards в Postgres — app_tasks/app_task_media/
// app_task_feedback (схема — db.js). Решение 2026-10-14: полный уход от
// Mattermost как хранилища задач, см. claude/kf-mattermost-to-postgres-
// migration.md в проекте «Мои IT дела» и claude/mattermost-boards-oom.md /
// claude/mattermost-session-limit.md — чем это вызвано.
//
// Используется из index.js двумя CEO-роутами (requireCeoAuth):
//   GET  /api/ceo/mattermost-migration/preview — ТОЛЬКО считает, что
//        получится перенести (карточки/медиа/переписка по типам), ничего
//        не пишет в Postgres и не трогает файлы Mattermost — безопасно
//        нажимать сколько угодно раз перед реальным запуском.
//   POST /api/ceo/mattermost-migration/run — запускает реальный перенос В
//        ФОНЕ (не ждёт его в самом HTTP-ответе — при ~1000+ карточках и
//        перезаливке медиа на диск это легко занимает минуты, что дольше
//        любого разумного HTTP/реверс-прокси таймаута) и сразу отвечает
//        202. Прогресс/результат — через GET .../status (поллинг с
//        кнопки в CEO-интерфейсе). Сам перенос ИДЕМПОТЕНТЕН: каждый запуск
//        полностью очищает все три таблицы (TRUNCATE ... CASCADE) и
//        заливает их заново с нуля — повторный клик не задваивает данные,
//        просто пересобирает их заново (это безопасно именно потому, что
//        подтверждено: карточки правятся ТОЛЬКО через наше приложение,
//        никто не трогает нативный интерфейс Mattermost Boards между
//        запусками).
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

// Общий проход по всем карточкам борда — используется preview (download:
// false, считает/классифицирует, ничего не скачивает и не пишет) и run
// (download: true, реально скачивает Mattermost-файлы и перезаливает их).
// onProgress({processed,total}) — для фонового прогресса run() (см.
// startRun ниже); preview может его не передавать.
async function gatherMigrationData(boardId, board, cards, blocks, { download, onProgress } = {}) {
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
        if (download) {
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
    mediaCount: data.counts.media,
    mattermostFilesCount: data.counts.mattermostFiles,
    diskLinksCount: data.counts.diskLinks,
    feedbackByKind: data.counts.feedback,
    mediaErrors: data.mediaErrors,
  };
}

// Только считает — не трогает Postgres, не скачивает ни одного файла.
async function previewMigration(boardId, { board, cards, blocks }) {
  const data = await gatherMigrationData(boardId, board, cards, blocks, { download: false });
  return summarize(data);
}

// Реальный перенос: TRUNCATE трёх таблиц + полная заливка заново, одной
// транзакцией (всё или ничего — чтобы не оставить таблицы в половинчатом
// состоянии, если перенос упадёт на середине). Частичная неудача
// ПЕРЕЗАЛИВКИ ОДНОГО медиафайла — не повод валить всю транзакцию (это
// частый, ожидаемый сбой — сеть/429 от диска/битый fileId на стороне
// Mattermost), она просто копится в mediaErrors отчёта для ручного
// разбора; остальные медиа и сама карточка переносятся как обычно.
async function runMigration(boardId, { board, cards, blocks }, onProgress) {
  const data = await gatherMigrationData(boardId, board, cards, blocks, { download: true, onProgress });
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
  return summarize(data);
}

// Фоновый запуск + статус для поллинга — см. комментарий в начале файла:
// POST .../run не ждёт реальный перенос (легко минуты на ~1000+ карточек),
// он только стартует его и сразу отвечает; кнопка в CEO-интерфейсе
// опрашивает GET .../status, пока state не станет 'done'/'error'.
let runState = { state: 'idle', startedAt: null, finishedAt: null, progress: null, report: null, error: null };

function getRunStatus() {
  return runState;
}

function startRun(boardId, { board, cards, blocks }) {
  if (runState.state === 'running') {
    throw new Error('Перенос уже выполняется — подождите его завершения.');
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
    .then((report) => {
      runState.state = 'done';
      runState.finishedAt = Date.now();
      runState.report = report;
    })
    .catch((err) => {
      console.error('[mattermostMigration] перенос упал:', err.message);
      runState.state = 'error';
      runState.finishedAt = Date.now();
      runState.error = err.message;
    });
  return runState;
}

// Фоновая докатка медиафайлов, не перенесённых при последнем запуске
// основного переноса (runState.report.mediaErrors) — кнопка «Докатить
// медиа» на /ceo/migration, решение 2026-10-15 (часть Mattermost-файлов
// не перезаливается из-за рейт-лимита disk.kontentferma — share API 429,
// см. комментарий в diskUpload.js). Не трогает app_tasks/app_task_feedback,
// только доливает недостающие строки app_task_media для уже перенесённых
// задач. Повторный клик безопасен: каждый успешно докатанный файл сразу
// убирается из runState.report.mediaErrors, так что следующий запуск
// повторяет только то, что всё ещё не получилось.
let retryState = { state: 'idle', startedAt: null, finishedAt: null, progress: null, log: [], error: null };

function getMediaRetryStatus() {
  return retryState;
}

// targets — снимок runState.report.mediaErrors на момент запуска (список
// {taskId, fileId, message} из последнего ПЕРЕНОСА, не предпросмотра —
// предпросмотр ничего не скачивает, поэтому его report.mediaErrors всегда
// пуст). Карточки/медиа читаем заново из Mattermost — сам Mattermost-файл
// (и его позиция в списке медиа карточки) за это время не меняется, пока
// карточками правят только через наше приложение (то же допущение, что и
// у основного переноса — см. комментарий в начале файла).
async function runMediaRetry(boardId) {
  const targets = (runState.report && runState.report.mediaErrors || []).slice();
  if (!targets.length) {
    throw new Error('Нет медиафайлов для докатки — список ошибок последнего переноса пуст.');
  }
  const [board, cards, blocks] = await Promise.all([
    mm.getBoard(boardId, config.teamId),
    mm.listCards(boardId),
    mm.listBlocks(boardId),
  ]);
  const { tasks } = buildTasks(board, cards, blocks, { skipProjectFilter: true, includeAllStatuses: true });
  const tasksById = new Map(tasks.map((t) => [t.id, t]));
  const mediaOrders = await mediaOrder.getMediaOrders(boardId, [...new Set(targets.map((e) => e.taskId))]);

  for (let i = 0; i < targets.length; i++) {
    const target = targets[i];
    const entry = { taskId: target.taskId, fileId: target.fileId, ok: false, message: '' };
    const task = tasksById.get(target.taskId);
    const orderedMedia = task ? mediaOrder.applyOrder(task.media, mediaOrders.get(task.id)) : [];
    const pos = task ? orderedMedia.findIndex((m) => m.source === 'mattermost' && m.fileId === target.fileId) : -1;
    const item = pos === -1 ? null : orderedMedia[pos];
    if (!task) {
      entry.message = 'Задача не найдена (удалена с момента последнего переноса).';
    } else if (!item) {
      entry.message = 'Файл не найден среди медиа карточки (состав медиа изменился с момента переноса).';
    } else {
      try {
        const url = await reuploadMattermostFile(boardId, item, task.projectLabel || 'Без клиента');
        await pgTasks.insertMedia(task.id, { url, kind: item.kind || '', position: pos });
        entry.ok = true;
        // Убираем из отчёта последнего переноса — повторный клик докатки
        // не будет повторно трогать уже исправленный файл.
        if (runState.report) {
          runState.report.mediaErrors = runState.report.mediaErrors.filter(
            (e) => !(e.taskId === target.taskId && e.fileId === target.fileId)
          );
        }
      } catch (err) {
        entry.message = err.message;
      }
    }
    retryState.log.push(entry);
    retryState.progress = { processed: i + 1, total: targets.length };
  }
  return { total: targets.length, succeeded: retryState.log.filter((e) => e.ok).length };
}

function startMediaRetry(boardId) {
  if (retryState.state === 'running') {
    throw new Error('Докатка медиа уже выполняется — подождите её завершения.');
  }
  if (runState.state === 'running') {
    throw new Error('Основной перенос ещё выполняется — подождите его завершения.');
  }
  retryState.state = 'running';
  retryState.startedAt = Date.now();
  retryState.finishedAt = null;
  retryState.progress = { processed: 0, total: 0 };
  retryState.log = [];
  retryState.error = null;
  runMediaRetry(boardId)
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

module.exports = { previewMigration, startRun, getRunStatus, startMediaRetry, getMediaRetryStatus };
