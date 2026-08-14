// All configuration comes from the environment. No database, no secrets in code.
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
  formatPropertyName: process.env.MM_FORMAT_PROPERTY_NAME || '',
  // Name of the text-type card property holding the actual post copy.
  // CONFIRMED via a real card's raw properties — this is a reliable, direct
  // source, unlike the old best-effort approach of pulling caption text from
  // child "text" blocks via the unconfirmed /blocks endpoint (still used as
  // a fallback in taskMapper.js if this property is empty on a given card).
  postTextPropertyName: process.env.MM_POST_TEXT_PROPERTY_NAME || 'Текст поста',

  // Cards whose "Статус" value isn't one of these four labels are excluded
  // from the client cabinet entirely (rather than lumped into "waiting") —
  // internal production stages like "Не начато"/"В процессе"/"ТЗ РАЙТЕРУ"
  // should stay invisible to the client until they reach client review.
  statusOptionLabels: {
    waiting: process.env.MM_STATUS_WAITING_LABEL || 'На согласование',
    approved: process.env.MM_STATUS_APPROVED_LABEL || 'Согласовано НА ПУБЛИКАЦИЮ',
    // Reuses the existing "Корректировка" option — no dedicated "client
    // requested changes" option was added, see README/docs for the caveat.
    changes: process.env.MM_STATUS_CHANGES_LABEL || 'Корректировка',
    archived: process.env.MM_STATUS_ARCHIVED_LABEL || 'АРХИВ',
  },

  // How long a board's card list is cached in memory before re-fetching from
  // Mattermost. Not a database — just avoids hammering the API on every
  // client poll/re-render. Set to 0 to disable caching entirely.
  cacheTtlMs: parseInt(process.env.CACHE_TTL_MS || '10000', 10),

  // Prints raw Mattermost block/property JSON to the server log — turn this
  // on while calibrating taskMapper.js against your real board.
  debug: (process.env.DEBUG_MATTERMOST || 'false').toLowerCase() === 'true',
};
