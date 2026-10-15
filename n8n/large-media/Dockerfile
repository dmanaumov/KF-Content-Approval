# n8n + статический ffmpeg/ffprobe + скрипт сжатия больших файлов KF Approval.
# Собирается в Dokploy вместо голого образа n8nio/n8n (см. README.md рядом).
#
# N8N_VERSION — ровно та версия, что крутится сейчас (Settings → About в n8n),
# чтобы смена образа не обновила n8n заодно.
ARG N8N_VERSION=2.43.6

# Полностью статические сборки (musl), работают в alpine-образе n8n без apk.
FROM mwader/static-ffmpeg:7.1 AS ffmpeg

FROM n8nio/n8n:${N8N_VERSION}
USER root
COPY --from=ffmpeg /ffmpeg /ffprobe /usr/local/bin/
COPY --chown=node:node kf-compress.mjs /opt/kf/kf-compress.mjs
RUN mkdir -p /data/kf-compress && chown -R node:node /data/kf-compress
USER node

# n8n 2.x по умолчанию выключает ноду Execute Command — включаем все ноды.
# Если у вас уже задан NODES_EXCLUDE в Dokploy, уберите из него
# n8n-nodes-base.executeCommand вместо этой строки.
ENV NODES_EXCLUDE="[]"
# Нода Read/Write Files читает только из разрешённых папок. Если переменная
# уже задана в Dokploy — допишите туда ";/data/kf-compress/out".
ENV N8N_RESTRICT_FILE_ACCESS_TO="/home/node/.n8n-files;/data/kf-compress/out"
ENV KF_COMPRESS_DIR=/data/kf-compress
