// Чанковая загрузка БОЛЬШИХ файлов (>30 МБ) из командного кабинета —
// 2026-10-15, по задаче «файлы 350+ МБ: оригинал храним на диске, клиенту
// показываем сжатое превью до 10 МБ, сжимает n8n».
//
// Почему кусками, а не одним multipart как обычный media-upload:
//  - *.kontentferma.com за Cloudflare — на Free-плане один запрос не может
//    быть больше 100 МБ (413), а 350 МБ одним телом туда не пролезут;
//  - Traefik v3 по умолчанию рвёт входящий запрос, который читается дольше
//    60 с (respondingTimeouts.readTimeout), — медленный аплоад 350 МБ упрётся
//    в это раньше, чем закончится;
//  - обычный media-upload держит файл в памяти (multer.memoryStorage, 80 МБ).
// Кусок по 16 МБ — короткий запрос, каждый можно повторить при обрыве.
//
// Состояние — только файловая система (config.largeUploadTmpDir, лежит на
// volume /app/cache): <id>.json (метаданные) + <id>.part (склеиваемые байты).
// Переживает рестарт контейнера посреди загрузки; брошенные загрузки чистит
// janitor через config.largeUploadStaleHours.

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');

const ID_RE = /^[a-f0-9]{32}$/;

function dir() {
  return config.largeUploadTmpDir;
}
function metaPath(id) {
  return path.join(dir(), id + '.json');
}
function partPath(id) {
  return path.join(dir(), id + '.part');
}

function httpError(status, code, message) {
  const err = new Error(message);
  err.httpStatus = status;
  err.code = code;
  return err;
}

async function readMeta(id) {
  if (!ID_RE.test(String(id || ''))) throw httpError(404, 'upload_not_found', 'Загрузка не найдена.');
  try {
    return JSON.parse(await fsp.readFile(metaPath(id), 'utf8'));
  } catch (_e) {
    throw httpError(404, 'upload_not_found', 'Загрузка не найдена или устарела — начните заново.');
  }
}

async function writeMeta(meta) {
  meta.updatedAt = Date.now();
  const tmp = metaPath(meta.id) + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(meta));
  await fsp.rename(tmp, metaPath(meta.id));
}

// Сериализация операций над одной загрузкой (повтор куска из браузера может
// прийти, пока предыдущая попытка того же куска ещё пишется).
const chains = new Map();
function serialize(id, fn) {
  const prev = chains.get(id) || Promise.resolve();
  const next = prev.then(fn, fn);
  const tail = next.catch(() => {});
  chains.set(id, tail);
  tail.then(() => {
    if (chains.get(id) === tail) chains.delete(id);
  });
  return next;
}

async function init({ taskId, filename, size, mimeType, actor }) {
  size = Number(size);
  if (!Number.isFinite(size) || size <= 0) throw httpError(400, 'size_required', 'Не указан размер файла.');
  if (size > config.largeUploadMaxBytes) {
    throw httpError(413, 'file_too_large', `Файл слишком большой (максимум ${Math.round(config.largeUploadMaxBytes / 1024 / 1024)} МБ).`);
  }
  const mime = String(mimeType || '');
  if (mime && !/^(video|image)\//.test(mime)) {
    throw httpError(400, 'unsupported_type', 'Большие файлы принимаются только как фото или видео.');
  }
  await fsp.mkdir(dir(), { recursive: true });
  const id = crypto.randomBytes(16).toString('hex');
  const meta = {
    id,
    taskId: String(taskId),
    filename: String(filename || 'file').slice(0, 200),
    size,
    mimeType: mime,
    actor: String(actor || ''),
    chunkSize: config.largeUploadChunkBytes,
    received: 0,
    nextIndex: 0,
    state: 'uploading',
    createdAt: Date.now(),
  };
  await fsp.writeFile(partPath(id), Buffer.alloc(0));
  await writeMeta(meta);
  return { uploadId: id, chunkSize: meta.chunkSize, chunks: Math.ceil(size / meta.chunkSize) };
}

// Идемпотентно: кусок с индексом < nextIndex уже принят (повтор после
// обрыва ответа) — просто подтверждаем; > nextIndex — пропуск, ошибка 409 с
// nextIndex, чтобы браузер знал, откуда продолжать.
function appendChunk(id, taskId, index, buf) {
  return serialize(id, async () => {
    const meta = await readMeta(id);
    if (meta.taskId !== String(taskId)) throw httpError(404, 'upload_not_found', 'Загрузка не найдена.');
    if (meta.state !== 'uploading') throw httpError(409, 'upload_closed', 'Загрузка уже завершена.');
    index = Number(index);
    if (!Number.isInteger(index) || index < 0) throw httpError(400, 'bad_index', 'Некорректный номер куска.');
    if (index < meta.nextIndex) return { received: meta.received, nextIndex: meta.nextIndex };
    if (index > meta.nextIndex) {
      const err = httpError(409, 'chunk_out_of_order', 'Пропущен кусок файла.');
      err.nextIndex = meta.nextIndex;
      throw err;
    }
    const isLast = meta.received + buf.length >= meta.size;
    if (!buf.length || (!isLast && buf.length !== meta.chunkSize) || meta.received + buf.length > meta.size) {
      throw httpError(400, 'bad_chunk_size', 'Размер куска не совпадает с ожидаемым.');
    }
    // Обрезаем .part до уже подтверждённого размера — на случай, если
    // предыдущая попытка записи упала посередине.
    await fsp.truncate(partPath(id), meta.received);
    await fsp.appendFile(partPath(id), buf);
    meta.received += buf.length;
    meta.nextIndex += 1;
    await writeMeta(meta);
    return { received: meta.received, nextIndex: meta.nextIndex };
  });
}

// Переводит загрузку в state=completing (повторный complete → 409) и отдаёт
// метаданные + путь к собранному файлу.
function beginComplete(id, taskId) {
  return serialize(id, async () => {
    const meta = await readMeta(id);
    if (meta.taskId !== String(taskId)) throw httpError(404, 'upload_not_found', 'Загрузка не найдена.');
    if (meta.state !== 'uploading') throw httpError(409, 'upload_closed', 'Загрузка уже завершается.');
    const actual = fs.statSync(partPath(id)).size;
    if (meta.received !== meta.size || actual !== meta.size) {
      throw httpError(409, 'upload_incomplete', `Файл получен не полностью (${meta.received} из ${meta.size} байт).`);
    }
    meta.state = 'completing';
    await writeMeta(meta);
    return Object.assign({}, meta, { filePath: partPath(id) });
  });
}

async function remove(id) {
  if (!ID_RE.test(String(id || ''))) return;
  await fsp.rm(partPath(id), { force: true });
  await fsp.rm(metaPath(id), { force: true });
}

async function sweepStale() {
  let names;
  try {
    names = await fsp.readdir(dir());
  } catch (_e) {
    return;
  }
  const cutoff = Date.now() - config.largeUploadStaleHours * 3600 * 1000;
  for (const name of names) {
    const full = path.join(dir(), name);
    try {
      const st = await fsp.stat(full);
      if (st.mtimeMs < cutoff) await fsp.rm(full, { force: true });
    } catch (_e) {
      // файл уже удалён параллельно — неважно
    }
  }
}

function startJanitor() {
  sweepStale().catch(() => {});
  const t = setInterval(() => sweepStale().catch(() => {}), 30 * 60 * 1000);
  if (t.unref) t.unref();
}

module.exports = { init, appendChunk, beginComplete, remove, startJanitor };
