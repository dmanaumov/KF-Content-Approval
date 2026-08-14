// All configuration comes from the environment. No database, no secrets in code.
// See .env.example / README.md for what to set.

module.exports = {
  port: parseInt(process.env.PORT || '3000', 10),

  // Mattermost server, e.g. https://chat.company.com
  mattermostUrl: (process.env.MATTERMOST_URL || '').replace(/\/+$/, ''),

  // Personal Access Token of a dedicated bot/service account that has
  // read + write access to the boards this app will serve.
  mattermostToken: process.env.MATTERMOST_TOKEN || '',

  // Path prefix for the Boards REST API. This differs by how Boards is
  // deployed on your server — see docs/MATTERMOST_INTEGRATION.md.
  //   Mattermost 9+ (Boards bundled, plugin id "boards"):    /plugins/boards/api/v2
  //   Older Mattermost (plugin id "focalboard"):              /plugins/focalboard/api/v2
  //   Standalone Focalboard personal server:                   /api/v2
  boardsApiPrefix: process.env.MATTERMOST_BOARDS_API_PREFIX || '/plugins/boards/api/v2',

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
  // if your board doesn't have a matching property.
  publishDatePropertyName: process.env.MM_PUBLISH_DATE_PROPERTY_NAME || '',
  formatPropertyName: process.env.MM_FORMAT_PROPERTY_NAME || '',

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
