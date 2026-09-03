// All configuration comes from the environment. No secrets in code.
// See .env.example / README.md for what to set.

module.exports = {
  port: parseInt(process.env.PORT || '3000', 10),

  // Mattermost server, e.g. https://chat.company.com
  mattermostUrl: (process.env.MATTERMOST_URL || '').replace(/\/+$/, ''),

  // Two auth options — see mattermostClient.js for details. If both
  // MATTERMOST_LOGIN_ID and MATTERMOST_PASSWORD are set, session-login auth
  // is used for every call (this is what the agency's own n8n integration
  // relies on — per the agency, a plain PAT did not work there at all).
  // Otherwise falls back to MATTERMOST_TOKEN (Personal Access Token).
  mattermostLoginId: process.env.MATTERMOST_LOGIN_ID || '',
  mattermostPassword: process.env.MATTERMOST_PASSWORD || '',
  // Personal Access Token of a dedicated bot/service account that has
  // read + write access to the boards this app will serve. Used only if
  // MATTERMOST_LOGIN_ID/MATTERMOST_PASSWORD are not set.
  mattermostToken: process.env.MATTERMOST_TOKEN || '',

  // Path prefix for the Boards REST API. CONFIRMED against the agency's real
  // server (via an existing working n8n integration) to be the focalboard
  // plugin id, not "boards" — see docs/MATTERMOST_INTEGRATION.md if this
  // ever needs to change for a different server.
  boardsApiPrefix: process.env.MATTERMOST_BOARDS_API_PREFIX || '/plugins/focalboard/api/v2',

  // Required: the Mattermost team that owns the board(s) this app serves.
  // Board metadata is fetched via GET /teams/{teamId}/boards (see
  // mattermostClient.js) — there is no reliable way to resolve a board
  // without knowing its team first.
  teamId: process.env.MATTERMOST_TEAM_ID || '',

  // Name of the select-type card property that carries approval status.
  // Defaults match the real "Задачи SMM-Team" board's existing "Статус"
  // property — this project intentionally reuses it rather than adding a
  // second status property (agency's choice), so approving/requesting
  // changes from the client cabinet DOES overwrite whatever internal
  // production stage a card was in.
  approvalPropertyName: process.env.MM_APPROVAL_PROPERTY_NAME || 'Статус',
  // Name of the select property that identifies which client/project a card
  // belongs to, since this is one shared board for all clients. REQUIRED —
  // without it every client link would see every other client's cards.
  projectPropertyName: process.env.MM_PROJECT_PROPERTY_NAME || 'Проект',
  // Optional — leave blank ('') to omit publish date / format from the UI
  // if your board doesn't have a matching property. Default matches the
  // real "Задачи SMM-Team" board's date property (confirmed via debug dump).
  publishDatePropertyName: process.env.MM_PUBLISH_DATE_PROPERTY_NAME || 'Дедлайн (публикация)',
  // Separate date property for the deadline when the work itself should be
  // done (field "Окончание работ" — distinct from the publication date above;
  // Google-Docs API sets it via workEndDate). Leave blank ('') to omit.
  workEndPropertyName: process.env.MM_WORK_END_PROPERTY_NAME || 'Окончание работ',
  formatPropertyName: process.env.MM_FORMAT_PROPERTY_NAME || '',
  // URL of the live published post, shown as a link under the post text.
  // Only meaningful once a card reaches the "published" status below, but
  // rendered whenever it's non-empty regardless of status.
  urlPropertyName: process.env.MM_URL_PROPERTY_NAME || 'URL',
  // Name of the person-type property that assigns a card to a team member —
  // powers the /team cabinet's "my tasks" list (see teamAuth.js/taskMapper.js).
  // CONFIRMED live against the real board (2026-08-20): the person-type
  // property is actually named "Исполнитель", NOT "Ответственный" — an
  // earlier project note (see docs/) called it "Ответственный" but that
  // turned out to be wrong/stale, caught via /team returning
  // assignee_property_not_found with the board's real property list.
  assigneePropertyName: process.env.MM_ASSIGNEE_PROPERTY_NAME || 'Исполнитель',

  // Name of the free-text property that carries the copywriter's brief for
  // a post ("Ключевые слова/мысли" on the real board) — shown/editable in
  // the /team cabinet's "Текст" tab, and meant as the input material for the
  // AI text/image generator there once it's wired to a real provider.
  keywordsPropertyName: process.env.MM_KEYWORDS_PROPERTY_NAME || 'Ключевые слова/мысли',

  // Only comments authored by this Mattermost username are shown to the
  // client as "правки"/feedback (resolved to a user id once via the core
  // API and cached — see mattermostClient.getUserIdByUsername). This is the
  // account our own app posts client feedback comments as (MATTERMOST_LOGIN_ID),
  // so restricting to it filters out unrelated internal team comments left
  // directly on the card in Mattermost. Fallback if resolution fails or
  // matches nothing: any comment whose text literally contains this name.
  feedbackAuthorUsername: process.env.MM_FEEDBACK_AUTHOR_USERNAME || 'webuser',

  // Cards whose "Статус" value isn't one of these labels are excluded from
  // the client cabinet entirely (rather than lumped into "waiting") —
  // internal production stages like "Не начато"/"В процессе"/"ТЗ РАЙТЕРУ"
  // should stay invisible to the client until they reach client review.
  statusOptionLabels: {
    waiting: process.env.MM_STATUS_WAITING_LABEL || 'На согласование',
    approved: process.env.MM_STATUS_APPROVED_LABEL || 'Согласовано НА ПУБЛИКАЦИЮ',
    // Reuses the existing "Корректировка" option — no dedicated "client
    // requested changes" option was added, see README/docs for the caveat.
    changes: process.env.MM_STATUS_CHANGES_LABEL || 'Корректировка',
    // A 5th client-facing state (added on request): once a post actually
    // goes live, show it under its own "Опубликовано" tab with a link to
    // the live post (see urlPropertyName above) instead of hiding it.
    published: process.env.MM_STATUS_PUBLISHED_LABEL || 'ОПУБЛИКОВАНО',
    archived: process.env.MM_STATUS_ARCHIVED_LABEL || 'АРХИВ',
  },

  // How long a board's card list is cached in memory before re-fetching from
  // Mattermost. Not a database — just avoids hammering the API on every
  // client poll/re-render. Set to 0 to disable caching entirely.
  cacheTtlMs: parseInt(process.env.CACHE_TTL_MS || '10000', 10),

  // Max ms to wait for headers of any single upstream request (Mattermost or
  // the disk server) before aborting it. node-fetch has no default timeout,
  // so without this a slow/hanging upstream leaves the cabinet spinner
  // running for minutes instead of failing fast with a readable error.
  // Streaming (media) only waits this long for HEADERS, not for the whole
  // body, so video playback is unaffected.
  requestTimeoutMs: parseInt(process.env.MM_REQUEST_TIMEOUT_MS || '15000', 10),

  // Shorter timeout for the tiny content-type probe the disk embed does
  // (resolveKind, one Range bytes=0-1 request per disk link) — that one is
  // per-link and awaited in parallel before the task list is returned, so it
  // must fail fast or the whole cabinet waits on it.
  diskProbeTimeoutMs: parseInt(process.env.MM_DISK_PROBE_TIMEOUT_MS || '5000', 10),

  // Real drag-and-drop / file-picker upload from the /team cabinet straight
  // to disk.kontentferma (see backend/src/diskUpload.js) — as opposed to the
  // existing "paste an already-created share link" fallback, which stays
  // available regardless. All three must be set for uploads to work; until
  // they are, diskUpload.js throws a self-diagnosing error instead of
  // silently doing nothing. DISK_WEBDAV_URL is the Nextcloud WebDAV root for
  // the uploading account, e.g. "https://disk.kontentferma.com/remote.php/dav/files/smm-bot/"
  // (note the trailing slash and that this is the *files* root, not a share
  // link) — DISK_WEBDAV_USER/PASSWORD should be a Nextcloud "app password"
  // for that account, not its real login password.
  diskWebdavBaseUrl: (process.env.DISK_WEBDAV_URL || '').trim(),
  diskWebdavUser: process.env.DISK_WEBDAV_USER || '',
  diskWebdavPassword: process.env.DISK_WEBDAV_PASSWORD || '',
  // Root folder under that account's files, per the "SMM / <клиент> / файл"
  // convention the team asked for — sub-folder per client is created lazily
  // (MKCOL) on first upload for that project, not pre-provisioned.
  diskUploadRootPath: (process.env.DISK_UPLOAD_ROOT_PATH || 'SMM').replace(/^\/+|\/+$/g, ''),
  // Separate, longer timeout for WebDAV/OCS calls to disk.kontentferma
  // (diskUpload.js) — kept apart from requestTimeoutMs (Mattermost API calls)
  // because an upload is a genuinely heavier operation (MKCOL + PUT + share,
  // three sequential round trips) and, under a burst of several concurrent
  // uploads from n8n, Nextcloud can legitimately take longer to answer than
  // a lightweight Mattermost call would. Found via a real incident
  // (2026-08-25): n8n fired ~30 media-upload calls for 7 cards within 1.5s,
  // and several individual WebDAV calls exceeded the shared 15s timeout and
  // got aborted (node-fetch's "The user aborted a request." error) — see
  // also the media-upload concurrency limiter in index.js, which addresses
  // the same incident from the other side (don't let that many uploads hit
  // Nextcloud at once in the first place).
  diskWebdavTimeoutMs: parseInt(process.env.DISK_WEBDAV_TIMEOUT_MS || '30000', 10),

  // API version pinned in the "Проверить" (validate) call the /projects edit
  // popup makes against Instagram's own Graph API (POST /api/projects/
  // :projectId/validate-instagram in index.js) — confirms a just-typed
  // accessToken/igUserId pair is actually live before staff saves it.
  // Overridable so a Graph API deprecation doesn't require a code change,
  // just an env var bump.
  instagramGraphApiVersion: process.env.INSTAGRAM_GRAPH_API_VERSION || 'v21.0',

  // Prints raw Mattermost block/property JSON to the server log — turn this
  // on while calibrating taskMapper.js against your real board.
  debug: (process.env.DEBUG_MATTERMOST || 'false').toLowerCase() === 'true',

  // Postgres connection string. Required for: the rotatable client link
  // store, the internal staff page's per-project logo/social-credentials
  // editor, and the n8n publishing automation (reads project_settings
  // directly via its own Postgres connection — see docs/N8N_AUTOMATION.md).
  // docker-compose.yml builds this automatically from POSTGRES_DB/USER/
  // PASSWORD — normally you only set those three, not this directly (see
  // .env.example).
  databaseUrl: process.env.DATABASE_URL || '',

  // LEGACY — the old on-disk JSON link-token store, from before Postgres.
  // Nothing writes to it anymore; kept only so
  // projectSettings.importLegacyFileTokens() can migrate an already-issued,
  // already-tested client link into Postgres once on first boot after
  // upgrading. Safe to leave as-is indefinitely.
  projectLinksFile: process.env.PROJECT_LINKS_FILE || '/app/data/project-links.json',

  // Optional HTTP Basic Auth in front of the internal staff page and its
  // /api/projects* API. Both blank (default) = exactly as open as before
  // (unguessable path only — see README). Now that this page also stores
  // real social-network publishing credentials rather than just non-secret
  // share links, setting these is STRONGLY recommended.
  staffAuthUser: process.env.STAFF_AUTH_USER || '',
  staffAuthPassword: process.env.STAFF_AUTH_PASSWORD || '',

  // Static link to the Mattermost web app itself, shown on the internal
  // staff page next to each project (same URL for every project — Boards
  // doesn't have a per-project deep-link, it's one shared board with a
  // client-side filter).
  mattermostWebUrl: process.env.MATTERMOST_WEB_URL || 'https://messager.kontentferma.com/',

  // The one Mattermost board this whole app operates on. Previously every
  // route took boardId as a URL path segment (in principle multi-board
  // capable); the internal staff page specifically must NOT show it (or
  // anything else identifying) in a URL a person can see/copy, so that page
  // and its API now read the board id from here instead of the address bar.
  mattermostBoardId: process.env.MATTERMOST_BOARD_ID || '',

  // URL PATH of the internal staff page (list of clients + their rotatable
  // links). Deliberately configurable rather than a fixed "/projects" — the
  // agency didn't want a guessable, identity-revealing path here. This is
  // still only obscurity (same security model as the rest of this app — see
  // README), not real access control; pick something not easily guessed.
  staffProjectsPath: process.env.STAFF_PROJECTS_PATH || '/projects',

  // URL path of the team cabinet (see teamAuth.js) — team members log in
  // with their own real Mattermost username/password (checked live against
  // Mattermost itself, never stored) and see only cards where they're the
  // "Исполнитель" (assignee). Configurable for the same obscurity reason
  // as staffProjectsPath above.
  teamCabinetPath: process.env.TEAM_CABINET_PATH || '/team',

  // Dedicated, least-privilege Postgres role created (and kept up to date)
  // for the n8n publishing automation — see db.js's ensureN8nRole(). n8n
  // should connect as THIS role, not as the app's own POSTGRES_USER (which
  // is effectively a superuser on this database). Only created if
  // N8N_DB_PASSWORD is set; leave blank to skip provisioning it entirely.
  n8nDbUser: process.env.N8N_DB_USER || 'n8n',
  n8nDbPassword: process.env.N8N_DB_PASSWORD || '',

  // Comma-separated allowlist of email addresses allowed to request a
  // reminder of the STAFF_AUTH_USER/PASSWORD above (see POST
  // /api/staff/forgot-password in index.js and frontend/forgot-password.html).
  // Only an address already on this list ever receives anything — the
  // endpoint gives the same generic response either way, so it can't be
  // used to find out which addresses are trusted.
  staffRecoveryEmails: (process.env.STAFF_RECOVERY_EMAILS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),

  // Comma-separated allowlist of Mattermost EMAILS allowed to open the /ceo
  // dashboard (see teamAuth.requireCeoAuth) — the person authenticates via
  // the /team cabinet with their own real Mattermost credentials, and this
  // checks the email on that session's profile. Default: the owner's account.
  ceoEmails: (process.env.CEO_EMAILS || 'dmitry.naumov@mail.ru')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),

  // Comma-separated allowlist of Mattermost EMAILS with FULL internal access:
  // the staff page (/projects + its API + the social-credentials editor) and
  // /stat. These people still log in through /team (own Mattermost
  // credentials, never shared) — the email on the session decides the role.
  // CEO + his deputy. Default: the owner.
  adminEmails: (process.env.ADMIN_EMAILS || 'dmitry.naumov@mail.ru')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),

  // Emails allowed to view /stat (access analytics) but NOT the staff page.
  // Admins from adminEmails get /stat automatically; list here everyone who
  // only gets the stats (e.g. the analyst). Default: empty.
  statEmails: (process.env.STAT_EMAILS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),

  // Plain SMTP for sending the forgot-password reminder above. Any provider
  // that supports SMTP + a password/app-password works (Yandex, Mail.ru,
  // Gmail, agency's own mail server, ...) — see .env.example for per-provider
  // notes. If any of these three are blank, the reminder email silently
  // can't be sent (the API still responds, it just won't deliver anything —
  // see mailer.js).
  smtpHost: process.env.SMTP_HOST || '',
  smtpPort: parseInt(process.env.SMTP_PORT || '587', 10),
  smtpSecure: (process.env.SMTP_SECURE || 'false').toLowerCase() === 'true',
  smtpUser: process.env.SMTP_USER || '',
  smtpPassword: process.env.SMTP_PASSWORD || '',
  smtpFrom: process.env.SMTP_FROM || '',

  // Shared secret for the machine-to-machine automation API (see the
  // /api/automation/* routes in index.js — n8n publishing/content flows use
  // these, NOT a real staff Mattermost login, so a vendor/developer never
  // needs an actual team member's password). Blank (default) = every
  // /api/automation/* route responds 503 rather than silently accepting
  // requests with no check at all — you must explicitly set this to turn the
  // automation API on. Generate one long random value, e.g.:
  //   openssl rand -hex 32
  // and set it as AUTOMATION_API_KEY in Dokploy; give n8n that value only
  // (as an HTTP Header Auth credential — header name "X-Api-Key"), never
  // your own Mattermost password. Rotate by changing this value and updating
  // n8n's credential to match.
  automationApiKey: process.env.AUTOMATION_API_KEY || '',

  // Second, independent shared secret for a DIFFERENT integrator/flow —
  // set as GOOGLE_DOCS_API_KEY in Dokploy (by analogy with AUTOMATION_API_KEY
  // above; generate a long random value, e.g. `openssl rand -hex 32`). The
  // route(s) gated by requireGoogleDocsAuth in index.js (header
  // "X-Google-Docs-Key") accept ONLY this key — keep it separate from
  // AUTOMATION_API_KEY so each vendor/flow gets its own credential that can
  // be rotated/revoked on its own. Blank (default) = those routes respond
  // 503 rather than silently accepting requests.
  googleDocsApiKey: process.env.GOOGLE_DOCS_API_KEY || '',

  // Third shared secret, for the Telegram bot integration («Кот Василий» —
  // see /api/bot/* in index.js, header "X-Bot-Key") — set as BOT_API_KEY in
  // Dokploy. Deliberately separate from AUTOMATION_API_KEY so this
  // integration's credential can be rotated/revoked on its own. n8n's
  // Telegram Trigger workflow uses it to: report the bot's own my_chat_member
  // changes (POST /api/bot/channels — powers /ceo/bot-chats, "куда
  // добавлен"), report incoming private messages (POST /api/bot/messages —
  // powers /ceo/bot-leads, "переписка"/leads), and poll+ack the outgoing-send
  // queue (GET /api/bot/messages/outgoing, POST /api/bot/messages/:id/ack —
  // this app holds no Telegram bot token, it only queues what staff type in
  // /ceo/bot-leads; n8n does the actual send). See botStore.js and
  // docs/N8N_AUTOMATION.md for the full wiring. Blank (default) = those
  // routes respond 503 rather than silently accepting requests.
  botApiKey: process.env.BOT_API_KEY || '',
};
