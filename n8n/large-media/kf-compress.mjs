#!/usr/bin/env node
// KF Approval — сжатие большого медиа (>30 МБ) в превью ≤10 МБ.
// Запускается из n8n нодой Execute Command (внутри контейнера n8n, где лежат
// статические ffmpeg/ffprobe — см. Dockerfile рядом). Один вызов = одно медиа.
//
//   node /opt/kf/kf-compress.mjs --media <mediaId> --url <fullUrl>
//   node /opt/kf/kf-compress.mjs --cleanup --media <mediaId>
//
// В stdout печатается ровно одна строка JSON — её разбирает workflow:
//   { status: "ok",    mediaId, kind, outPath, outName, mime, srcBytes, outBytes, ... }
//   { status: "skip",  mediaId, reason }   — уже сжато/забрано параллельным запуском
//   { status: "busy",  mediaId }           — ffmpeg занят другим запуском, подберём позже
//   { status: "error", mediaId, message, gaveUp }
// Код выхода всегда 0, кроме ошибок самого вызова (нет аргументов).
//
// Рабочая папка KF_COMPRESS_DIR (по умолчанию /data/kf-compress):
//   src/<id>        скачиваемый оригинал; после сжатия переезжает в out/<id>.orig.<ext>
//   out/<id>.orig.* оригинал для заливки в хранилище проекта (удаляет --cleanup)
//   out/<id>.<ext>  готовое превью — его читает нода Read/Write Files
//                   (N8N_RESTRICT_FILE_ACCESS_TO должен включать эту папку)
//   out/<id>.json   метаданные готового превью (повторный вызов отдаст его
//                   без пересжатия, если заливка в согласователь упала)
//   out/<id>.claim  отметка «этот результат уже забрал запуск n8n» (30 мин)
//   fails/<id>      счётчик неудачных попыток; после KF_MAX_FAILS — сдаёмся
//   .lock/          глобальная блокировка: одновременно жмём один файл

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

// Два варианта установки (см. README):
//  1) свой образ n8n (Dockerfile): ffmpeg в PATH, скрипт в /opt/kf, работа в /data/kf-compress;
//  2) без пересборки образа: скрипт + статические ffmpeg/ffprobe лежат рядом в
//     /home/node/.n8n/kf (volume n8n, переживает редеплой), рабочая папка —
//     ~/.n8n-files/kf-compress (её нода Read/Write Files читает без настроек).
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
function pickBin(name, envName) {
  if (process.env[envName]) return process.env[envName];
  const local = path.join(SCRIPT_DIR, name);
  return fs.existsSync(local) ? local : name;
}
const FFMPEG = pickBin('ffmpeg', 'KF_FFMPEG');
const FFPROBE = pickBin('ffprobe', 'KF_FFPROBE');
function pickWorkDir() {
  if (process.env.KF_COMPRESS_DIR) return process.env.KF_COMPRESS_DIR;
  try {
    fs.accessSync('/data/kf-compress', fs.constants.W_OK);
    return '/data/kf-compress';
  } catch {
    return path.join(os.homedir(), '.n8n-files', 'kf-compress');
  }
}
const WORK = pickWorkDir();
const TARGET_MB = Number(process.env.KF_TARGET_MB || '9');        // цель, MiB (запас до 10 МБ на контейнер)
const HARD_LIMIT_MB = Number(process.env.KF_HARD_LIMIT_MB || '10'); // больше этого — пробуем ещё раз
const PRESET = process.env.KF_X264_PRESET || 'veryfast';
const THREADS = process.env.KF_THREADS || '2';
const MAX_FAILS = Number(process.env.KF_MAX_FAILS || '3');
// Длинные видео (2026-10-16): потолок превью = max(KF_HARD_LIMIT_MB, минуты × KF_MB_PER_MIN).
// По умолчанию 2.5: 8.7 мин ≈ 22 МБ (~270 кбит/с вместо 80); ролики до 4 мин — как раньше, 10 МБ.
const MB_PER_MIN = Number(process.env.KF_MB_PER_MIN || '2.5');
const LOCK_STALE_MS = 3 * 3600 * 1000;
const CLAIM_TTL_MS = 30 * 60 * 1000;
const SWEEP_MS = 24 * 3600 * 1000;
const DOWNLOAD_TIMEOUT_MS = Number(process.env.KF_DOWNLOAD_TIMEOUT_MS || String(60 * 60 * 1000));

const MiB = 1024 * 1024;

function out(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--cleanup') a.cleanup = true;
    else if (k.startsWith('--')) a[k.slice(2)] = argv[++i];
  }
  return a;
}

const dirs = {
  src: path.join(WORK, 'src'),
  out: path.join(WORK, 'out'),
  fails: path.join(WORK, 'fails'),
  tmp: path.join(WORK, 'tmp'),
  lock: path.join(WORK, '.lock'),
};

async function ensureDirs() {
  for (const d of [dirs.src, dirs.out, dirs.fails, dirs.tmp]) await fsp.mkdir(d, { recursive: true });
}

async function exists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

async function ageMs(p) {
  try {
    return Date.now() - (await fsp.stat(p)).mtimeMs;
  } catch {
    return Infinity;
  }
}

// Чистим всё, что старше суток (брошенные результаты, обломки упавших запусков).
async function sweep() {
  for (const d of [dirs.src, dirs.out, dirs.tmp]) {
    let names = [];
    try {
      names = await fsp.readdir(d);
    } catch {
      continue;
    }
    for (const n of names) {
      const p = path.join(d, n);
      if ((await ageMs(p)) > SWEEP_MS) await fsp.rm(p, { recursive: true, force: true });
    }
  }
}

async function acquireLock() {
  try {
    await fsp.mkdir(dirs.lock);
    return true;
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    if ((await ageMs(dirs.lock)) > LOCK_STALE_MS) {
      await fsp.rm(dirs.lock, { recursive: true, force: true });
      try {
        await fsp.mkdir(dirs.lock);
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }
}

async function releaseLock() {
  await fsp.rm(dirs.lock, { recursive: true, force: true });
}

// Публичная ссылка Nextcloud/ownCloud "https://disk.../s/<token>" отдаёт HTML-
// страницу; сам файл — по "/s/<token>/download".
function directDownloadUrl(u) {
  const url = new URL(u);
  if (/\/s\/[A-Za-z0-9]+\/?$/.test(url.pathname)) url.pathname = url.pathname.replace(/\/?$/, '/download');
  return url.toString();
}

async function download(url, dest) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const res = await fetch(directDownloadUrl(url), { signal: controller.signal, redirect: 'follow' });
    if (!res.ok) throw new Error(`скачивание оригинала: HTTP ${res.status}`);
    const ct = res.headers.get('content-type') || '';
    if (ct.startsWith('text/html')) throw new Error('по ссылке пришла HTML-страница, а не файл (ссылка не публичная или удалена?)');
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(dest));
    // Имя и тип оригинала — для заливки в хранилище проекта (Google Диск).
    const cd = res.headers.get('content-disposition') || '';
    let name = '';
    const star = cd.match(/filename\*=(?:UTF-8'')?([^;]+)/i);
    const plain = cd.match(/filename="?([^";]+)"?/i);
    try {
      name = star ? decodeURIComponent(star[1].trim().replace(/^"|"$/g, '')) : plain ? plain[1].trim() : '';
    } catch {
      name = plain ? plain[1].trim() : '';
    }
    return { size: (await fsp.stat(dest)).size, name: name.replace(/[\/\\]/g, '_'), mime: ct.split(';')[0].trim() };
  } finally {
    clearTimeout(timer);
  }
}

function run(cmd, args, { lowPriority = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    if (lowPriority) {
      try {
        os.setPriority(child.pid, 15); // не душим остальной n8n
      } catch {
        /* нет прав — не критично */
      }
    }
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => {
      stderr += d;
      if (stderr.length > 20000) stderr = stderr.slice(-10000);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${path.basename(cmd)} завершился с кодом ${code}: ${stderr.trim().split('\n').slice(-3).join(' | ')}`));
    });
  });
}

async function probe(file) {
  const { stdout } = await run(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
  const info = JSON.parse(stdout);
  const v = (info.streams || []).find((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
  const a = (info.streams || []).find((s) => s.codec_type === 'audio');
  const fmt = (info.format && info.format.format_name) || '';
  const duration = Number((info.format && info.format.duration) || (v && v.duration) || 0);
  const isImage = !!v && (/(^|,)image2(,|$)|_pipe(,|$)|^(png|webp|bmp|tiff)/.test(fmt) || !(duration > 0.5));
  return { video: v, audio: a, duration, isImage, format: fmt };
}

// scale: длинная сторона не больше L, чётные размеры (нужно libx264), без апскейла
function scaleFilter(L) {
  return `scale=w='if(gte(iw,ih),trunc(min(iw,${L})/2)*2,-2)':h='if(gte(iw,ih),-2,trunc(min(ih,${L})/2)*2)'`;
}

async function encodeVideo(src, outFile, p, id) {
  const d = p.duration;
  if (!(d > 0)) throw new Error('не удалось определить длительность видео');
  const audioK = p.audio ? (d > 300 ? 64 : 96) : 0;
  const limitMb = Math.max(HARD_LIMIT_MB, (d / 60) * MB_PER_MIN);
  const targetMb = limitMb * (TARGET_MB / HARD_LIMIT_MB); // тот же запас, что 9 из 10
  let factor = 1;
  for (let attempt = 0; attempt < 2; attempt++) {
    const totalK = Math.floor((targetMb * MiB * 8 * factor) / d / 1000);
    let videoK = Math.min(2500, totalK - audioK);
    let lowBitrate = false;
    if (videoK < 80) {
      videoK = 80;
      lowBitrate = true;
    }
    const L = videoK >= 1000 ? 1280 : videoK >= 500 ? 854 : 640;
    const passlog = path.join(dirs.tmp, `${id}-pass`);
    const common = ['-y', '-hide_banner', '-i', src, '-map', '0:v:0', '-vf', scaleFilter(L), '-fpsmax', '30',
      '-c:v', 'libx264', '-preset', PRESET, '-b:v', `${videoK}k`, '-maxrate', `${Math.round(videoK * 1.5)}k`,
      '-bufsize', `${videoK * 2}k`, '-pix_fmt', 'yuv420p', '-threads', THREADS, '-passlogfile', passlog];
    await run(FFMPEG, [...common, '-pass', '1', '-an', '-f', 'null', '-'], { lowPriority: true });
    const audioArgs = p.audio ? ['-map', '0:a:0', '-c:a', 'aac', '-b:a', `${audioK}k`, '-ac', '2'] : ['-an'];
    await run(FFMPEG, [...common, '-pass', '2', ...audioArgs, '-movflags', '+faststart', outFile], { lowPriority: true });
    for (const f of await fsp.readdir(dirs.tmp)) if (f.startsWith(`${id}-pass`)) await fsp.rm(path.join(dirs.tmp, f), { force: true });
    const size = (await fsp.stat(outFile)).size;
    if (size <= limitMb * MiB || lowBitrate) {
      return { videoKbps: videoK, audioKbps: audioK, longSide: L, lowBitrate, limitMb: Math.round(limitMb * 10) / 10 };
    }
    factor *= ((targetMb * MiB) / size) * 0.95; // промахнулись — ужимаем пропорционально и пробуем ещё раз
  }
  throw new Error(`не удалось уложить видео в ${Math.round(limitMb)} МБ`);
}

async function encodeImage(src, outFile) {
  const steps = [
    [2560, 3],
    [2048, 5],
    [1600, 7],
  ];
  for (const [L, q] of steps) {
    await run(FFMPEG, ['-y', '-hide_banner', '-i', src, '-frames:v', '1', '-vf', scaleFilter(L), '-q:v', String(q), outFile], { lowPriority: true });
    if ((await fsp.stat(outFile)).size <= HARD_LIMIT_MB * MiB) return { longSide: L, quality: q };
  }
  throw new Error(`не удалось уложить изображение в ${HARD_LIMIT_MB} МБ`);
}

async function bumpFails(id) {
  const p = path.join(dirs.fails, id);
  let n = 0;
  try {
    n = Number(await fsp.readFile(p, 'utf8')) || 0;
  } catch {
    /* первый раз */
  }
  n += 1;
  await fsp.writeFile(p, String(n));
  return n;
}

async function cleanup(id) {
  for (const f of await fsp.readdir(dirs.out).catch(() => [])) {
    if (f.startsWith(id + '.')) await fsp.rm(path.join(dirs.out, f), { force: true });
  }
  await fsp.rm(path.join(dirs.src, id), { force: true });
  await fsp.rm(path.join(dirs.fails, id), { force: true });
  out({ status: 'cleaned', mediaId: id });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const id = String(args.media || '');
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
    out({ status: 'error', mediaId: id, message: 'некорректный --media' });
    process.exit(2);
  }
  await ensureDirs();
  if (args.cleanup) return cleanup(id);

  const url = String(args.url || '');
  if (!/^https?:\/\//.test(url)) return out({ status: 'error', mediaId: id, message: 'некорректный --url' });

  const failsFile = path.join(dirs.fails, id);
  const fails = Number(await fsp.readFile(failsFile, 'utf8').catch(() => '0')) || 0;
  if (fails >= MAX_FAILS) return out({ status: 'skip', mediaId: id, reason: 'gave_up' });

  const metaFile = path.join(dirs.out, `${id}.json`);
  const claimFile = path.join(dirs.out, `${id}.claim`);

  if (!(await acquireLock())) return out({ status: 'busy', mediaId: id });
  try {
    await sweep();
    // Уже есть готовый результат (прошлая заливка в согласователь упала или
    // параллельный запуск n8n сжал его минуту назад).
    if (await exists(metaFile)) {
      if ((await ageMs(claimFile)) < CLAIM_TTL_MS) return out({ status: 'skip', mediaId: id, reason: 'claimed' });
      const meta = JSON.parse(await fsp.readFile(metaFile, 'utf8'));
      if (await exists(meta.outPath)) {
        await fsp.writeFile(claimFile, String(Date.now()));
        if (meta.origPath && !(await exists(meta.origPath))) meta.origPath = '';
        return out(Object.assign({}, meta, { cached: true }));
      }
    }

    const src = path.join(dirs.src, id);
    const started = Date.now();
    try {
      const dl = await download(url, src);
      const srcBytes = dl.size;
      const p = await probe(src);
      if (!p.video) throw new Error(`в файле нет видео/изображения (формат: ${p.format || 'неизвестен'})`);
      let meta;
      if (p.isImage) {
        const outPath = path.join(dirs.out, `${id}.jpg`);
        const r = await encodeImage(src, outPath);
        meta = { kind: 'image', outPath, outName: `${id}.jpg`, mime: 'image/jpeg', ...r };
      } else {
        const outPath = path.join(dirs.out, `${id}.mp4`);
        const r = await encodeVideo(src, outPath, p, id);
        meta = { kind: 'video', outPath, outName: `${id}.mp4`, mime: 'video/mp4', durationSec: Math.round(p.duration), ...r };
      }
      // Оригинал НЕ удаляем: n8n дальше заливает его в хранилище проекта.
      // Кладём в out/ — эту папку нода Read/Write Files читает; --cleanup
      // удалит его вместе с превью.
      const ext = (path.extname(dl.name) || (meta.kind === 'video' ? '.mp4' : '.jpg')).toLowerCase();
      const origPath = path.join(dirs.out, `${id}.orig${ext}`);
      await fsp.rename(src, origPath);
      meta.origPath = origPath;
      meta.origName = dl.name || `${id}${ext}`;
      meta.origMime = dl.mime && dl.mime !== 'application/octet-stream' ? dl.mime : meta.kind === 'video' ? 'video/mp4' : 'image/jpeg';
      meta = Object.assign({ status: 'ok', mediaId: id, srcBytes, outBytes: (await fsp.stat(meta.outPath)).size, tookSec: Math.round((Date.now() - started) / 1000) }, meta);
      await fsp.writeFile(metaFile, JSON.stringify(meta));
      await fsp.writeFile(claimFile, String(Date.now()));
      await fsp.rm(failsFile, { force: true });
      return out(meta);
    } catch (err) {
      const n = await bumpFails(id);
      return out({ status: 'error', mediaId: id, message: err.message, attempt: n, gaveUp: n >= MAX_FAILS });
    } finally {
      await fsp.rm(src, { force: true });
    }
  } finally {
    await releaseLock();
  }
}

main().catch((err) => {
  out({ status: 'error', message: err.message });
  process.exit(0);
});
