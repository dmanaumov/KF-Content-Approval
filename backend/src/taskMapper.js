// Turns raw Mattermost Boards data (a board's property definitions + its flat
// block list) into the normalized "task" shape the frontend consumes. This is
// the second place (besides mattermostClient.js) where you'll need to adjust
// things once you see real board data — turn on DEBUG_MATTERMOST=true and
// compare against what you expect.

const crypto = require('crypto');
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

function extractDescriptionText(textBlocks) {
  const joined = (textBlocks || [])
    .map((b) => String(b.title || (b.fields && b.fields.text) || '').trim())
    .filter(Boolean)
    .join('\n\n')
    .trim();
  if (!joined) return '';

  // Preferred convention: put the public-facing copy under a heading like
  // "## Для клиента" (or "Клиенту" / "Клиентский пост"). If such a section
  // exists, we take only that slice and ignore internal notes elsewhere in the
  // description. Old cards without headings still work because we fall back to
  // the whole description text.
  const clientHeadingRe = /^\s*#{1,6}\s*(?:для клиента|клиенту|клиентский пост)\s*[:\-–—]*\s*$/i;
  const headingRe = /^\s*#{1,6}\s+\S/;
  const lines = joined.split(/\r?\n/);
  const clientLines = [];
  let collecting = false;
  let foundClientSection = false;

  for (const line of lines) {
    if (clientHeadingRe.test(line)) {
      collecting = true;
      foundClientSection = true;
      continue;
    }
    if (collecting && headingRe.test(line)) break;
    if (collecting) clientLines.push(line);
  }

  const clientText = clientLines.join('\n').trim();
  return foundClientSection && clientText ? clientText : joined;
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
  const urlProp = findPropertyDef(board, config.urlPropertyName);
  const assigneeProp = findPropertyDef(board, config.assigneePropertyName);
  const keywordsProp = findPropertyDef(board, config.keywordsPropertyName);

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

    // Full client-correspondence timeline for the /team cabinet's "Чат с
    // клиентом" tab (see index.js's refetchTeamTask/GET /api/team/tasks).
    // `comments` above is every comment posted under our own app's shared
    // account — but that account ALSO posts TEAM-cabinet system markers
    // ("ТЕКСТ ОБНОВЛЁН (Имя)", "СТАТУС ИЗМЕНЁН (Имя): ...", etc., see
    // index.js's updateTaskTextTeam/setStatusByRawLabel/updateTaskNetwork/
    // addTeamMediaLink/updateTaskMediaOrderTeam) under that SAME account, so
    // naive "any comment from this account" would show internal team
    // activity to this client-facing timeline as if the client said it.
    // These marker words are written either by an actual CLIENT action
    // (approve / submit feedback / edit text or media order from the client
    // cabinet — see setApprovalStatus, POST .../feedback, updateTaskText,
    // updateTaskMediaOrder — none of them tag an actor name) or by the
    // team explicitly writing TO the client (СООБЩЕНИЕ, see
    // sendClientMessage in index.js — this one DOES carry "(actorName)",
    // same as the internal system markers, but it's deliberately included
    // here since — unlike those — it's meant to reach the client). Every
    // other team-cabinet marker (ТЕКСТ ОБНОВЛЁН, СТАТУС ИЗМЕНЁН, ...) is
    // internal-only and must never appear in this client-facing timeline.
    // `kind` lets both cabinets render this as a chat bubble (actual
    // written text — 'feedback' from the client, 'agency' from the team) vs.
    // a plain system line ('approved'/'correction' — no free text of their
    // own, just the marker).
    const CLIENT_MARKER_RE = /^\d{2}\.\d{2}\.\d{4}\s+\d{2}:\d{2}\s+(СОГЛАСОВАНО|ПРАВКИ|ЗАКАЗЧИК|СООБЩЕНИЕ)/;
    const clientComments = comments
      .filter((b) => CLIENT_MARKER_RE.test(String(b.title || '')))
      .map((b) => {
        const title = String(b.title || '');
        const marker = title.match(CLIENT_MARKER_RE)[1];
        const kind =
          marker === 'СОГЛАСОВАНО' ? 'approved' : marker === 'ПРАВКИ' ? 'feedback' : marker === 'СООБЩЕНИЕ' ? 'agency' : 'correction';
        let text =
          kind === 'feedback'
            ? title.replace(/^\d{2}\.\d{2}\.\d{4}\s+\d{2}:\d{2}\s+ПРАВКИ\n\n/, '')
            : kind === 'agency'
            ? title.replace(/^\d{2}\.\d{2}\.\d{4}\s+\d{2}:\d{2}\s+СООБЩЕНИЕ(?:\s+\([^)]*\))?\n\n/, '')
            : title;
        // A written message ('feedback'/'agency') can carry one attached
        // photo — sent as a plain disk.kontentferma share link on its own
        // trailing line (see sendClientMessage in index.js), same
        // convention diskEmbeds.js uses for card-description attachments.
        // Only treated as an attachment when the link is the LAST thing in
        // the text, so a link mentioned mid-sentence stays plain text.
        let imageUrl = null;
        if (kind === 'feedback' || kind === 'agency') {
          const links = extractDiskLinks(text);
          const lastLink = links[links.length - 1];
          if (lastLink && text.trim().endsWith(lastLink)) {
            const validated = parseAndValidateShareUrl(lastLink);
            if (validated) {
              imageUrl = validated;
              text = stripDiskLinks(text, [lastLink]);
            }
          }
        }
        return { id: b.id, kind, text, imageUrl, createdAt: b.createAt || 0 };
      })
      .sort((a, b) => a.createdAt - b.createdAt);

    const rawPublishDate = publishDateProp ? properties[publishDateProp.id] : null;
    const publishDate = parsePropertyDate(rawPublishDate);
    const weekStart = mondayOf(publishDate);

    // Post text comes from the card description (text-type child blocks).
    // If the team uses section headings, we only keep the public-facing part
    // under "Для клиента" and ignore internal notes elsewhere in the same
    // description. That keeps one board card usable for both team notes and
    // client-facing copy, while preserving line breaks.
    const textBlocks = children
      .filter((b) => b.type === 'text')
      .sort((a, b) => (a.createAt || 0) - (b.createAt || 0));
    let caption = extractDescriptionText(textBlocks);

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

    // Which client this card belongs to — not needed by the client cabinet
    // (a client's own link is already filtered to one project, see
    // projectOptionId above) but IS needed by the /team cabinet, which spans
    // every project a person works across and has to label each card.
    const projectId = projectProp ? properties[projectProp.id] || null : null;
    const projectLabel = projectProp ? optionLabelById(projectProp, projectId) : null;

    let format = null;
    if (formatProp) {
      const rawFormat = properties[formatProp.id];
      format = formatProp.type === 'select' ? optionLabelById(formatProp, rawFormat) : rawFormat;
    }

    // "Исполнитель" (person-type property) — powers the /team cabinet's
    // "my tasks" filter (see index.js's assignee-filtered task list). Not
    // used by the client cabinet at all. Focalboard "person" properties have
    // been observed elsewhere in this project (n8n automation, see
    // docs/N8N_AUTOMATION.md) storing a single Mattermost user id as a plain
    // string — handled defensively here in case a given card instead has a
    // JSON array (multi-assign) or is simply unset, rather than assuming the
    // single-string shape is the only one that can occur.
    let assigneeId = null;
    if (assigneeProp) {
      const raw = properties[assigneeProp.id];
      if (Array.isArray(raw)) assigneeId = raw[0] || null;
      else if (typeof raw === 'string' && raw.trim()) {
        try {
          const parsed = JSON.parse(raw);
          assigneeId = Array.isArray(parsed) ? parsed[0] || null : raw;
        } catch (e) {
          assigneeId = raw; // plain string, not JSON — the common case
        }
      }
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
    //
    // id is derived from the URL itself (short hash), NOT from position in
    // the list — the client can now save a custom media order (mediaOrder.js),
    // keyed by these ids, and a later caption edit can reorder/add/remove the
    // disk links found in the text. A position-based id ("disk-<card>-0")
    // would silently point at different content after that happens; a
    // content-based id stays correct (worst case, the same link pasted twice
    // in one caption collides — accepted, rare, and the reorder degrades to
    // "treat both as one" rather than doing anything destructive).
    const diskMedia = diskShareUrls.map((shareUrl) => ({
      id: `disk-${card.id}-${crypto.createHash('md5').update(shareUrl).digest('hex').slice(0, 10)}`,
      source: 'disk',
      shareUrl,
      kind: null,
      name: '',
    }));
    const media = [...cardMedia, ...diskMedia];

    // "Ключевые слова/мысли" — free-text brief for the copywriter, only
    // shown/edited in the /team cabinet (see index.js's keywords route).
    // Text-type property, so the raw value is already the plain string —
    // no option-id lookup like the select properties above.
    const keywords = keywordsProp ? String(properties[keywordsProp.id] || '') : '';

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
      keywords,
      media,
      feedback,
      clientComments,
      url,
      assigneeId,
      projectId,
      projectLabel,
      createAt: card.createAt || 0,
    };
  });

  // Sort strictly by planned publish date, descending (agency's request) —
  // cards with no date at all sort last.
  tasks.sort((a, b) => {
    if (a.publishDate !== b.publishDate) return (b.publishDate || '').localeCompare(a.publishDate || '');
    return b.createAt - a.createAt;
  });

  // opts.includeAllStatuses (used by the /team cabinet's "my tasks" list —
  // see index.js) — a team member's own work includes plenty of cards still
  // in an internal-only production stage ("В процессе", "ТЗ РАЙТЕРУ", ...)
  // that statusEnumFromLabel() deliberately maps to null (not one of the 5
  // client-facing states) because the CLIENT cabinet must never show those.
  // The team cabinet has the opposite need — show everything that's theirs,
  // whatever stage it's in — so this bypasses that exclusion and keeps the
  // raw statusLabel instead. "АРХИВ" is still excluded either way (dropped,
  // not "my active work" in either cabinet).
  const archivedLabel = normLabel(config.statusOptionLabels.archived);
  const visibleTasks = opts.includeAllStatuses
    ? tasks.filter((t) => normLabel(t.statusLabel) !== archivedLabel)
    : tasks.filter((t) => t.status && t.status !== 'archived');

  return {
    tasks: visibleTasks,
    meta: {
      approvalPropertyFound: !!approvalProp,
      publishDatePropertyFound: !!publishDateProp,
      urlPropertyFound: !!urlProp,
      projectPropertyFound: !!projectProp,
      assigneePropertyFound: !!assigneeProp,
      keywordsPropertyFound: !!keywordsProp,
      projectFilterMatched,
      // Every raw option on the "Статус" property, for the /team cabinet's
      // status picker — team members can move a card into ANY production
      // stage, not just the 5 client-facing ones statusOptionLabels covers
      // (see index.js's /api/team/tasks/:id/status).
      statusOptions: approvalProp ? (approvalProp.options || []).map((o) => ({ id: o.id, label: o.value })) : [],
    },
  };
}

module.exports = { buildTasks, findPropertyDef, optionIdByLabel, optionLabelById };
