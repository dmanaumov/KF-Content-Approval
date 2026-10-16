# n8n: сжатие больших файлов KF Approval

Один workflow — `kf-large-media-compress.workflow.json`. Сжимает оригиналы >30 МБ, загруженные через согласователь, в превью ≤10 МБ для клиента.

```
согласователь (/team) ── куски по 16 МБ ──► backend ──► disk.kontentferma/<клиент>/оригиналы
                                               │  медиа: pending_compression=true («Сжимаем…»)
                                               └─► POST webhook n8n (сигнал)

n8n: [Webhook] или [каждый час] → GET /api/automation/media/pending-compression
     → по одному: Execute Command (ffmpeg в контейнере n8n) → Read file
     → POST /api/automation/tasks/:taskId/media/:mediaId/preview-upload
       (превью → disk.kontentferma/<клиент>/превью, снимает pending_compression)
     → чистка → в конце: если были ошибки — выполнение падает с отчётом
```

Для автопубликации в соцсеть брать `media[].fullUrl`, когда он не пуст (это оригинал), а не `url` (превью).

## 1а. Быстро, без пересборки образа

Всё кладётся в volume n8n (`/home/node/.n8n`), поэтому переживает редеплой. Нода Execute Command уже должна быть включена.

На Mac:
```
scp ~/Documents/GitHub/KF-Content-Approval/n8n/large-media/kf-compress.mjs root@<сервер n8n>:/root/
```
На сервере n8n:
```
C=$(docker ps --format '{{.Names}}' | grep -i n8n | head -1); echo "$C"
docker inspect "$C" --format '{{range .Mounts}}{{.Destination}} {{end}}'   # должен быть /home/node/.n8n
docker exec "$C" mkdir -p /home/node/.n8n/kf
docker cp /root/kf-compress.mjs "$C":/home/node/.n8n/kf/
docker create --name kf-ffm mwader/static-ffmpeg:7.1 >/dev/null
docker cp kf-ffm:/ffmpeg /root/ffmpeg && docker cp kf-ffm:/ffprobe /root/ffprobe && docker rm kf-ffm
docker cp /root/ffmpeg "$C":/home/node/.n8n/kf/ && docker cp /root/ffprobe "$C":/home/node/.n8n/kf/
docker exec -u root "$C" chown -R node:node /home/node/.n8n/kf
docker exec "$C" /home/node/.n8n/kf/ffmpeg -version | head -1
```
Скрипт сам находит ffmpeg рядом с собой и работает в `~/.n8n-files/kf-compress`: эту папку нода Read/Write Files читает без дополнительных настроек. Workflow сначала ищет скрипт в `/opt/kf`, затем в `/home/node/.n8n/kf`.

## 1б. Правильно: свой образ n8n с ffmpeg (Dokploy)

В Dokploy-сервисе n8n сменить образ `n8nio/n8n` на сборку из `n8n/large-media/Dockerfile` (Build Type → Dockerfile, context — эта папка). Перед сборкой поставить в `ARG N8N_VERSION` текущую версию n8n.

Что меняет образ:
- `/usr/local/bin/ffmpeg`, `/usr/local/bin/ffprobe` — статический ffmpeg 7.1;
- `/opt/kf/kf-compress.mjs` — скрипт сжатия;
- `NODES_EXCLUDE=[]` — в n8n 2.x нода Execute Command по умолчанию выключена;
- `N8N_RESTRICT_FILE_ACCESS_TO` дополнена папкой `/data/kf-compress/out`.

Если эти переменные уже заданы в Environment Dokploy, они перебьют ENV из образа, поэтому значения нужно дописать туда.

Рабочую папку лучше вынести в volume, чтобы недожатое переживало редеплой: `kf-compress:/data/kf-compress`. Пиковое место на диске ≈ размер одного оригинала + 10 МБ. Оригинал удаляется сразу после сжатия, всё, что старше суток, чистится автоматически.

Если n8n работает в queue mode, образ нужен **воркерам**: Execute Command выполняется там.

Проверка после деплоя:
```
docker exec -it <n8n> ffmpeg -version
docker exec -it <n8n> node /opt/kf/kf-compress.mjs --media test --url https://disk.kontentferma.com/s/<токен любого видео>
```

## 2. Credentials в n8n

- **KF Approval API (X-API-Key)** — Header Auth, `X-API-Key: <AUTOMATION_API_KEY>`. Скорее всего уже есть (им пользуются остальные сценарии публикации), тогда выбрать существующий.
- **KF Signal (X-KF-Signal)** — Header Auth, `X-KF-Signal: <длинная случайная строка>`. Этим защищён webhook.

## 3. Импорт и активация

Import from file → `kf-large-media-compress.workflow.json`, в трёх HTTP/Webhook-нодах выбрать credentials, Activate. Production URL webhook-ноды: `https://n8n.teastymenu.ru/webhook/kf-large-media`.

## 4. Переменные согласователя (.env / Dokploy)

```
LARGE_MEDIA_WEBHOOK_URL=https://n8n.teastymenu.ru/webhook/kf-large-media
LARGE_MEDIA_WEBHOOK_SECRET=<та же строка, что в KF Signal>
# необязательно (значения по умолчанию):
# LARGE_UPLOAD_THRESHOLD_MB=30  LARGE_UPLOAD_MAX_MB=2048  LARGE_UPLOAD_CHUNK_MB=16
# LARGE_UPLOAD_ORIGINALS_FOLDER=оригиналы  LARGE_UPLOAD_PREVIEWS_FOLDER=превью
```
Без webhook всё тоже работает: файл подхватит ежечасный запуск.

## Параметры сжатия

| | |
|---|---|
| Видео | H.264 в 2 прохода + AAC. Потолок превью = max(10 МБ, 2.5 МБ × минуты): ролики до 4 мин укладываются в 10 МБ, 10-минутный — в 25 МБ. Битрейт = 90% потолка / длительность (максимум 2.5 Мбит/с). Длинная сторона 1280 при ≥1 Мбит/с, 854 при ≥500 кбит/с, иначе 640. Не больше 30 к/с. Перебрал 10 МБ — второй заход с пересчитанным битрейтом. |
| Фото | JPEG, длинная сторона 2560 (q3), при перевесе 2048 (q5), затем 1600 (q7). |
| Скорость | Тест на 2 vCPU: 90 с 1080p60 (69 МБ) → 9.1 МБ за 89 с, то есть примерно реальное время. Процесс ffmpeg запускается с пониженным приоритетом, одновременно жмётся только один файл. |
| Ошибки | 3 неудачи подряд по одному медиа — скрипт сдаётся (`/data/kf-compress/fails/<mediaId>`; удалить файл, чтобы попробовать снова). |

Переменные скрипта (необязательные): `KF_MB_PER_MIN` (2.5), `KF_TARGET_MB` (9), `KF_HARD_LIMIT_MB` (10), `KF_X264_PRESET` (veryfast), `KF_THREADS` (2), `KF_MAX_FAILS` (3).

## Инфраструктура: проверить до первого 350-мегабайтного файла

- **Cloudflare** (`smm.kontentferma.com`). Загрузка идёт кусками по 16 МБ, поэтому лимит 100 МБ на запрос не мешает при любом режиме прокси.
- **Nextcloud** (`disk.kontentferma.com`). Оригинал льётся одним WebDAV PUT. Если перед Nextcloud стоит nginx, нужен `client_max_body_size` ≥ 2G (или 0) и `proxy_request_buffering off`. В PHP при PUT через WebDAV `upload_max_filesize` обычно не участвует, но лимиты `max_execution_time` и таймауты прокси — участвуют.
- **Место на сервере согласователя.** Куски собираются в `/app/cache/large-uploads` (volume `disk-cache`) и удаляются после заливки на диск. Брошенные загрузки чистятся через 6 ч.
