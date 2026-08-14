// Turns raw Mattermost Boards data (a board's property definitions + its flat
// block list) into the normalized "task" shape the frontend consumes. This is
// the second place (besides mattermostClient.js) where you'll need to adjust
// things once you see real board data — turn on DEBUG_MATTERMOST=true and
// compare against what you expect.

const config = require('./config');
const { extractDiskLinks, stripDiskLinks, parseAndValidateShareUrl } = require('./diskEmbeds');

const MONTHS_RU = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

// Real board data has shown stray leading/trailing whitespace on option
// labels (confirmed: the real "Согласовано НА ПУБЛИКАЦИЮ" option actually
// has a trailing space in Mattermost) — someone editing the property in the
// Boards UI by hand is an easy way to introduce this, and a strict `===`
// silently drops every matching card. All label comparisons below normalize
// whitespace on both sides so this class of mistake can't reoccur.
function normLabel(s) {
  return (s == null ? '' : String(s)).trim().replace(/\s+/g, ' ');
}

function findPropertyDef(board, name) {
  const props = (board && board.cardProperties) || [];
  const needle = normLabel(name);
  return props.find((p) => normLabel(p.name) === needle) || null;
}

function optionLabelById(propDef, optionId) {
  if (!propDef || !optionId) return null;
  const opt = (propDef.options || []).find((o) => o.id === optionId);
  return opt ? opt.value : null;
}

function optionIdByLabel(propDef, label) {
  if (!propDef) return null;
  const needle = normLabel(label);
  const opt = (propDef.options || []).find((o) => normLabel(o.value) === needle);
  return opt ? opt.id : null;
}

// Returns null (not a default) when the label doesn't match any configured
// state — callers must treat that as "not a client-facing task" and drop
// the card, not silently show it as "waiting". This matters here because
// the approval property is shared with an internal production pipeline
// that has many other stages ("Не начато", "В процессе", "ТЗ РАЙТЕРУ", ...).
function statusEnumFromLabel(label) {
  const needle = normLabel(label);
  const entry = Object.entries(config.statusOptionLabels).find(([, v]) => normLabel(v) === needle);
  return entry ? entry[0] : null;
}

// Matches a `project` link parameter against a select property's options,
// by option id (preferred — stable) or by label text (case/whitespace
// insensitive, for convenience when someone hand-builds a link).
function resolveProjectOptionId(projectProp, filterValue) {
  if (!projectProp || !filterValue) return null;
  const needle = String(filterValue).trim().toLowerCase();
  const opt = (projectProp.options || []).find(
    (o) => o.id === filterValue || String(o.value).trim().toLowerCase() === needle
  );
  return opt ? opt.id : null;
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

const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'heic', 'heif'];
const VIDEO_EXTENSIONS = ['mp4', 'mov', 'webm', 'avi', 'mkv', 'm4v', '3gp'];

// Real card blocks confirmed against a live board never carry fields.mimeType
// at all — the ONLY signal available is the file's extension, which (also
// confirmed live) IS embedded in fields.fileId itself (Boards' own file
// storage names files "<randomId>.<ext>", e.g. "76ttr5js5efdzbrjy7a5qkqrgbw.png"
// — unlike core Mattermost FileInfo ids, which have no extension). Extension
// is checked first and is authoritative when present; mimeType/block.type
// are kept only as a fallback for whatever server behavior we haven't seen yet.
function guessMediaKind(block) {
  const fileId = (block.fields && block.fields.fileId) || '';
  const ext = (fileId.split('.').pop() || '').toLowerCase();
  if (IMAGE_EXTENSIONS.includes(ext)) return 'image';
  if (VIDEO_EXTENSIONS.includes(ext)) return 'video';
  const mime = (block.fields && block.fields.mimeType) || '';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (block.type === 'image') return 'image';
  if (block.type === 'video') return 'video';
  return 'file';
}

// board: result of mattermostClient.getBoard(boardId)
// cards: result of mattermostClient.listCards(boardId) — CONFIRMED endpoint,
//   property values sit directly on card.properties.
// childBlocks: result of mattermostClient.listBlocks(boardId) — UNCONFIRMED
//   on this server, best-effort only, may be []. Used solely for
//   caption/media/comment children; a card with no matching children just
//   shows without them, nothing breaks.
// opts.projectFilter: value of the `project` link parameter — REQUIRED
// whenever the board has a project property, since this board is shared
// across all clients (see docs/MATTERMOST_INTEGRATION.md). Without it we'd
// leak every other client's cards.
// Returns { tasks, meta: { approvalPropertyFound, projectPropertyFound, projectFilterMatched } }
function buildTasks(board, cards, childBlocks = [], opts = {}) {
  const approvalProp = findPropertyDef(board, config.approvalPropertyName);
  const publishDateProp = findPropertyDef(board, config.publishDatePropertyName);
  const formatProp = findPropertyDef(board, config.formatPropertyName);
  const projectProp = findPropertyDef(board, config.projectPropertyName);
  const postTextProp = findPropertyDef(board, config.postTextPropertyName);
  const urlProp = findPropertyDef(board, config.urlPropertyName);

  const projectOptionId = projectProp ? resolveProjectOptionId(projectProp, opts.projectFilter) : null;
  const projectFilterMatched = !projectProp || !!projectOptionId;

  let visibleCards = cards.filter((c) => !c.deleteAt);
  if (projectProp && !opts.skipProjectFilter) {
    // Board has a project property → filtering is mandatory for the client
    // list view. If the filter didn't resolve to a real option, show
    // nothing rather than everything. (skipProjectFilter is for internal
    // single-card lookups right after a write, where the caller already
    // knows the exact card id — see index.js setApprovalStatus.)
    visibleCards = projectOptionId
      ? visibleCards.filter((c) => (c.properties || {})[projectProp.id] === projectOptionId)
      : [];
  }

  const tasks = visibleCards.map((card) => {
    const children = childBlocks.filter((b) => b.parentId === card.id && !b.deleteAt);

    const mediaBlocks = children.filter((b) => b.fields && b.fields.fileId);
    const cardMedia = mediaBlocks
      .sort((a, b) => (a.createAt || 0) - (b.createAt || 0))
      .map((b) => ({
        id: b.id,
        source: 'mattermost',
        fileId: b.fields.fileId,
        kind: guessMediaKind(b),
        name: b.title || b.fields.filename || '',
        mimeType: (b.fields && b.fields.mimeType) || '',
      }));

    const properties = card.properties || {};
    const statusOptionId = approvalProp ? properties[approvalProp.id] : null;
    const statusLabel = optionLabelById(approvalProp, statusOptionId);
    // null status = card's current "Статус" isn't one of our configured
    // client-facing values (e.g. still "Не начато"/"В процессе") → excluded
    // below, not shown to the client at all.
    const status = statusEnumFromLabel(statusLabel);

    // Show client feedback only from our own app's account (config.
    // feedbackAuthorUsername, resolved to a user id in index.js) — a shared
    // production board can have unrelated internal comments left directly
    // on the card in Mattermost by staff, which shouldn't surface to the
    // client as if they were "правки". Fallback (if the id wasn't resolved,
    // or nothing matched it): a comment whose text literally names the
    // account, in case authorship can't be determined some other way.
    // Only surfaced while status === 'changes': our own account also posts
    // a dated "СОГЛАСОВАНО" marker comment on approve (see index.js), and
    // without this gate that marker would show up as a stale "правки" note
    // on an already-approved card.
    const allComments = children.filter((b) => b.type === 'comment').sort((a, b) => (b.createAt || 0) - (a.createAt || 0));
    const authorNeedle = normLabel(config.feedbackAuthorUsername).toLowerCase();
    const comments = allComments.filter(
      (b) =>
        (opts.feedbackAuthorUserId && b.createdBy === opts.feedbackAuthorUserId) ||
        (authorNeedle && String(b.title || '').toLowerCase().includes(authorNeedle))
    );
    const feedback = status === 'changes' && comments.length ? comments[0].title : null;

    const rawPublishDate = publishDateProp ? properties[publishDateProp.id] : null;
    const publishDate = parsePropertyDate(rawPublishDate);
    const weekStart = mondayOf(publishDate);

    // Post text: prefer the CONFIRMED direct card property ("Текст поста" —
    // found on a real card's properties), fall back to text-type child
    // blocks (the old best-effort approach via the unconfirmed /blocks
    // endpoint) only if that property is empty/missing on this card.
    const directPostText = postTextProp ? String(properties[postTextProp.id] || '').trim() : '';
    let caption = directPostText;
    if (!caption) {
      const textBlocks = children
        .filter((b) => b.type === 'text')
        .sort((a, b) => (a.createAt || 0) - (b.createAt || 0));
      caption = textBlocks
        .map((b) => b.title || (b.fields && b.fields.text) || '')
        .filter(Boolean)
        .join('\n\n');
    }

    // "Материал уже на диске" links (https://disk.kontentferma.<tld>/s/<token>)
    // pasted into the post text: strip the raw link out of the visible text
    // and embed the actual file in the media carousel instead, so the client
    // sees the material directly rather than clicking through to another
    // site. Each match is re-validated (not just regex-matched) before being
    // trusted — see diskEmbeds.js for why.
    const rawDiskMatches = extractDiskLinks(caption);
    const validatedCaptionDiskLinks = [];
    for (const raw of rawDiskMatches) {
      const normalized = parseAndValidateShareUrl(raw);
      if (normalized) validatedCaptionDiskLinks.push({ raw, normalized });
    }
    if (validatedCaptionDiskLinks.length) {
      caption = stripDiskLinks(caption, validatedCaptionDiskLinks.map((l) => l.raw));
    }

    let format = null;
    if (formatProp) {
      const rawFormat = properties[formatProp.id];
      format = formatProp.type === 'select' ? optionLabelById(formatProp, rawFormat) : rawFormat;
    }

    let url = urlProp ? String(properties[urlProp.id] || '').trim() : '';
    // Occasionally staff paste a disk.kontentferma link into "URL" instead
    // of a real published-post link — treat that the same way (embed as
    // media) rather than rendering it as "Открыть опубликованный пост →".
    let urlAsDiskLink = null;
    if (url) {
      const normalized = parseAndValidateShareUrl(url);
      if (normalized) {
        urlAsDiskLink = normalized;
        url = '';
      }
    }

    const diskShareUrls = [
      ...validatedCaptionDiskLinks.map((l) => l.normalized),
      ...(urlAsDiskLink ? [urlAsDiskLink] : []),
    ];
    // kind/name are resolved later, server-side (index.js), since it takes a
    // network call to the disk server to know image vs video — buildTasks()
    // itself stays synchronous, matching every other caller's expectations.
    const diskMedia = diskShareUrls.map((shareUrl, i) => ({
      id: `disk-${card.id}-${i}`,
      source: 'disk',
      shareUrl,
      kind: null,
      name: '',
    }));
    const media = [...cardMedia, ...diskMedia];

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
      url,
      createAt: card.createAt || 0,
    };
  });

  // Sort strictly by planned publish date, descending (agency's request) —
  // cards with no date at all sort last.
  tasks.sort((a, b) => {
    if (a.publishDate !== b.publishDate) return (b.publishDate || '').localeCompare(a.publishDate || '');
    return b.createAt - a.createAt;
  });

  return {
    // status === null → "Статус" value isn't a client-facing one (internal
    // production stage) → hidden. status === 'archived' → explicitly hidden.
    tasks: tasks.filter((t) => t.status && t.status !== 'archived'),
    meta: {
      approvalPropertyFound: !!approvalProp,
      publishDatePropertyFound: !!publishDateProp,
      postTextPropertyFound: !!postTextProp,
      urlPropertyFound: !!urlProp,
      projectPropertyFound: !!projectProp,
      projectFilterMatched,
    },
  };
}

module.exports = { buildTasks, findPropertyDef, optionIdByLabel, optionLabelById };
