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

  // Name of the select-type card property that carries the four-state
  // approval status. Its option labels must match statusOptionMap below —
  // set this up once on each board (or on a board template).
  approvalPropertyName: process.env.MM_APPROVAL_PROPERTY_NAME || 'Согласование',
  publishDatePropertyName: process.env.MM_PUBLISH_DATE_PROPERTY_NAME || 'Дата публикации',
  formatPropertyName: process.env.MM_FORMAT_PROPERTY_NAME || 'Формат',

  statusOptionLabels: {
    waiting: process.env.MM_STATUS_WAITING_LABEL || 'На согласовании',
    approved: process.env.MM_STATUS_APPROVED_LABEL || 'Согласовано',
    changes: process.env.MM_STATUS_CHANGES_LABEL || 'Правки',
    archived: process.env.MM_STATUS_ARCHIVED_LABEL || 'Архив',
  },

  // How long a board's card list is cached in memory before re-fetching from
  // Mattermost. Not a database — just avoids hammering the API on every
  // client poll/re-render. Set to 0 to disable caching entirely.
  cacheTtlMs: parseInt(process.env.CACHE_TTL_MS || '10000', 10),

  // Prints raw Mattermost block/property JSON to the server log — turn this
  // on while calibrating taskMapper.js against your real board.
  debug: (process.env.DEBUG_MATTERMOST || 'false').toLowerCase() === 'true',
};
