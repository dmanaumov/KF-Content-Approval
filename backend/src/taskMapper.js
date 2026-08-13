// Turns raw Mattermost Boards data (a board's property definitions + its flat
// block list) into the normalized "task" shape the frontend consumes. This is
// the second place (besides mattermostClient.js) where you'll need to adjust
// things once you see real board data — turn on DEBUG_MATTERMOST=true and
// compare against what you expect.

const config = require('./config');

const MONTHS_RU = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

function findPropertyDef(board, name) {
  const props = (board && board.cardProperties) || [];
  return props.find((p) => p.name === name) || null;
}

function optionLabelById(propDef, optionId) {
  if (!propDef || !optionId) return null;
  const opt = (propDef.options || []).find((o) => o.id === optionId);
  return opt ? opt.value : null;
}

function optionIdByLabel(propDef, label) {
  if (!propDef) return null;
  const opt = (propDef.options || []).find((o) => o.value === label);
  return opt ? opt.id : null;
}

function statusEnumFromLabel(label) {
  const entry = Object.entries(config.statusOptionLabels).find(([, v]) => v === label);
  return entry ? entry[0] : 'waiting';
}

// Focalboard date-property values have shown up in the wild as a JSON string
// like {"from":1692400000000}, a bare epoch-ms number-as-string, or a plain
// "YYYY-MM-DD". We try all three and fall back to null rather than guessing.
function parsePropertyDate(raw) {
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw);
    if (obj && obj.from) return new Date(obj.from).toISOString().slice(0, 10);
  } catch (e) {
    // not JSON, fall through
  }
  if (/^\d{12,13}$/.test(raw)) return new Date(parseInt(raw, 10)).toISOString().slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  return null;
}

function mondayOf(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr + 'T00:00:00Z');
  const day = d.getUTCDay() || 7; // Sunday -> 7
  if (day !== 1) d.setUTCDate(d.getUTCDate() - (day - 1));
  return d.toISOString().slice(0, 10);
}

function weekLabel(weekStart) {
  if (!weekStart) return '';
  const start = new Date(weekStart + 'T00:00:00Z');
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 6);
  return `${start.getUTCDate()} ${MONTHS_RU[start.getUTCMonth()]} — ${end.getUTCDate()} ${MONTHS_RU[end.getUTCMonth()]}`;
}

function guessMediaKind(block) {
  const mime = (block.fields && block.fields.mimeType) || '';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (block.type === 'image') return 'image';
  return 'file';
}

// board: result of mattermostClient.getBoard(boardId)
// blocks: result of mattermostClient.listBlocks(boardId)
// Returns { tasks: [...] , meta: { approvalPropertyFound, publishDatePropertyFound } }
function buildTasks(board, blocks) {
  const approvalProp = findPropertyDef(board, config.approvalPropertyName);
  const publishDateProp = findPropertyDef(board, config.publishDatePropertyName);
  const formatProp = findPropertyDef(board, config.formatPropertyName);

  const cards = blocks.filter((b) => b.type === 'card' && !b.deleteAt);

  const tasks = cards.map((card) => {
    const children = blocks.filter((b) => b.parentId === card.id && !b.deleteAt);
    const textBlocks = children
      .filter((b) => b.type === 'text')
      .sort((a, b) => (a.createAt || 0) - (b.createAt || 0));
    const caption = textBlocks
      .map((b) => b.title || (b.fields && b.fields.text) || '')
      .filter(Boolean)
      .join('\n\n');

    const mediaBlocks = children.filter((b) => b.fields && b.fields.fileId);
    const media = mediaBlocks
      .sort((a, b) => (a.createAt || 0) - (b.createAt || 0))
      .map((b) => ({
        id: b.id,
        fileId: b.fields.fileId,
        kind: guessMediaKind(b),
        name: b.title || b.fields.filename || '',
        mimeType: (b.fields && b.fields.mimeType) || '',
      }));

    const comments = children
      .filter((b) => b.type === 'comment')
      .sort((a, b) => (b.createAt || 0) - (a.createAt || 0));
    const feedback = comments.length ? comments[0].title : null;

    const properties = (card.fields && card.fields.properties) || {};
    const statusOptionId = approvalProp ? properties[approvalProp.id] : null;
    const statusLabel = optionLabelById(approvalProp, statusOptionId) || config.statusOptionLabels.waiting;
    const status = statusEnumFromLabel(statusLabel);

    const rawPublishDate = publishDateProp ? properties[publishDateProp.id] : null;
    const publishDate = parsePropertyDate(rawPublishDate);
    const weekStart = mondayOf(publishDate);

    let format = null;
    if (formatProp) {
      const rawFormat = properties[formatProp.id];
      format = formatProp.type === 'select' ? optionLabelById(formatProp, rawFormat) : rawFormat;
    }

    return {
      id: card.id,
      title: card.title || '(без названия)',
      status,
      statusLabel,
      format,
      publishDate,
      weekStart,
      weekLabel: weekLabel(weekStart),
      caption,
      media,
      feedback,
      createAt: card.createAt || 0,
    };
  });

  tasks.sort((a, b) => {
    if (a.weekStart !== b.weekStart) return (b.weekStart || '').localeCompare(a.weekStart || ''); // newest week first
    if (a.publishDate !== b.publishDate) return (a.publishDate || '').localeCompare(b.publishDate || '');
    return a.createAt - b.createAt;
  });

  return {
    tasks: tasks.filter((t) => t.status !== 'archived'),
    meta: {
      approvalPropertyFound: !!approvalProp,
      publishDatePropertyFound: !!publishDateProp,
    },
  };
}

module.exports = { buildTasks, findPropertyDef, optionIdByLabel };
