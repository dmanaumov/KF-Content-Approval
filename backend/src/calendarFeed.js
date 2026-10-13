// ICS (iCalendar) feed for the client cabinet's "напоминания в календаре"
// feature — lets a client subscribe (webcal://) their own calendar app to a
// per-project feed of their scheduled posts. The client's OWN calendar app
// polls this URL on its own schedule (Google/Apple/Outlook decide that
// cadence, not us) and renders the events + optional native alarms.
//
// WHY this is a plain pull feed and not a push channel: the calendar belongs
// to the CLIENT (Google/Apple/Outlook), so we can't write into it — we only
// answer when their calendar asks. "Реально обновляться по статусу" here
// means: the feed is regenerated from the LIVE board on every fetch, so a
// calendar that re-syncs (typically every few hours to ~24h, hinted by
// X-PUBLISHED-TTL below) picks up the current status. Instant "срочно
// согласовать" nudges are deliberately NOT this feed's job — that's Web Push
// (pushNotifier.js) and the Telegram bot for clients who subscribed, both of
// which we can genuinely push. The calendar is the "план + спокойные
// напоминания" view.
//
// EVERY TASK = EXACTLY ONE VEVENT, no RRULE. Earlier versions used
// RRULE:FREQ=DAILY to "нагонять" the client until they approve — which made
// Google show the SAME task on every day for weeks, exactly the "почему
// показывает всё время одну и ту же задачу" complaint that killed it.
// Instead: each event sits on the post's publish date, the SUMMARY carries
// the REAL current status (🔥 нужно согласовать / ✅ согласовано / и т.д.),
// and UID is stable (kfw-<taskId>) — so when a card changes status, the
// client's calendar REPLACES the event in place on its next sync (same UID,
// new SUMMARY/DTSTART). No unbounded recurrence, no spam.

// RFC5545 §3.3.11 TEXT escaping — backslash, semicolon, comma, and embedded
// newlines all need escaping in any TEXT-valued property (SUMMARY,
// DESCRIPTION, ...).
function escapeIcsText(str) {
  return String(str || '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

// RFC5545 §3.1 line folding — content lines SHOULD be folded at 75 octets,
// continuation lines start with a single space. Cyrillic text is multi-byte
// in UTF-8, so folding at a conservative 70 *characters* (not bytes) keeps
// every real-world line comfortably under the octet limit without having to
// count UTF-8 byte widths here.
function foldLine(line) {
  const CHUNK = 70;
  if (line.length <= CHUNK) return `${line}\r\n`;
  let out = line.slice(0, CHUNK);
  let rest = line.slice(CHUNK);
  while (rest.length) {
    const take = rest.slice(0, CHUNK - 1);
    out += `\r\n ${take}`;
    rest = rest.slice(CHUNK - 1);
  }
  return `${out}\r\n`;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

// Formats a Date as a UTC iCalendar DATE-TIME (YYYYMMDDTHHMMSSZ).
function formatIcsUtc(date) {
  return (
    `${date.getUTCFullYear()}${pad2(date.getUTCMonth() + 1)}${pad2(date.getUTCDate())}` +
    `T${pad2(date.getUTCHours())}${pad2(date.getUTCMinutes())}${pad2(date.getUTCSeconds())}Z`
  );
}

// Moscow has been a fixed UTC+3 with no DST since 2014 — a plain 3h offset
// is safe here (same assumption formatMoscowTimestamp() elsewhere in this
// codebase already makes).
const MSK_OFFSET_MS = 3 * 60 * 60 * 1000;

// The calendar day (in Moscow local time) a task should occupy. Normal case:
// the post's own publish date (publishDate is 'YYYY-MM-DD' or null). For an
// action-needed task WITH a publish date we STILL use the publish date (the
// client sees the plan, and the "нужно сейчас" nudge comes from push/TG).
// Only when a task needs action but has NO publish date do we fall back to
// "today in Moscow" — so it still visibly sits somewhere without constantly
// sliding.
function eventDay(task) {
  if (task.publishDate) return task.publishDate;
  const mskShifted = new Date(Date.now() + MSK_OFFSET_MS);
  return `${mskShifted.getUTCFullYear()}-${pad2(mskShifted.getUTCMonth() + 1)}-${pad2(mskShifted.getUTCDate())}`;
}

// Human status prefix for the calendar SUMMARY — same terminology as the
// cabinet's own calendar legend (🔥 / правки / согласовано / опубликовано).
function statusPrefix(task) {
  switch (task.status) {
    case 'waiting': return '🔥 Нужно согласовать';
    case 'changes': return '✏️ Есть правки';
    case 'approved': return '✅ Согласовано';
    case 'published': return '📅 Будет опубликовано';
    default: return '📝 Пост';
  }
}

// Whether this task currently needs an action from the client — only these
// carry a VALARM (calendar apps surface the native notification for a bare
// event without an explicit alarm unreliably). Approved/published are just
// informational entries: no alarm, no "open me" urgency.
function needsAction(task) {
  return task.status === 'waiting' || task.status === 'changes';
}

// Builds one VEVENT for a single task — on its publish date (or today, see
// eventDay), NO recurrence, status in the SUMMARY. VALARM present only while
// the task is waiting for approval / has revisions to review.
function buildEvent(task, { linkToken, host, proto, dtstamp }) {
  const day = eventDay(task);
  const startUtcMs = Date.parse(`${day}T00:00:00Z`) + 7 * 60 * 60 * 1000; // 10:00 MSK == 07:00 UTC
  const dtstart = formatIcsUtc(new Date(startUtcMs));
  const dtend = formatIcsUtc(new Date(startUtcMs + 15 * 60 * 1000));
  const taskUrl = `${proto}://${host}/l/${encodeURIComponent(linkToken)}?task=${encodeURIComponent(task.id)}`;
  const summary = `${statusPrefix(task)}: ${task.title}`;
  const lines = [
    'BEGIN:VEVENT',
    `UID:kfw-${task.id}@kontentferma.com`,
    `DTSTAMP:${dtstamp}`,
    `DTSTART:${dtstart}`,
    `DTEND:${dtend}`,
    `SUMMARY:${escapeIcsText(summary)}`,
    `DESCRIPTION:${escapeIcsText(`Откройте карточку в кабинете КонтентФермы: ${taskUrl}`)}`,
    `URL:${taskUrl}`,
    'STATUS:CONFIRMED',
    'SEQUENCE:0',
  ];
  if (needsAction(task)) {
    lines.push(
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      `DESCRIPTION:${escapeIcsText(summary)}`,
      'TRIGGER:-PT15M',
      'END:VALARM'
    );
  }
  lines.push('END:VEVENT');
  return lines.map(foldLine).join('');
}

// tasks — the project's CLIENT-VISIBLE tasks. The caller (index.js) already
// built them with buildTasks(... projectFilter), so every task here is on the
// right project and not an internal-production-stage card. We further keep
// only what makes sense in a schedule view: anything with a publish date
// (the plan), plus action-needed cards even if they somehow lack a date.
// Archived and status-less cards are dropped (nothing scheduled about them).
function pickFeedTasks(tasks) {
  const feedStatus = (t) => t.status === 'waiting' || t.status === 'changes' || t.status === 'approved' || t.status === 'published';
  return (tasks || []).filter((t) => t.publishDate ? feedStatus(t) : needsAction(t));
}

function buildIcsFeed(tasks, { projectLabel, linkToken, host, proto }) {
  const dtstamp = formatIcsUtc(new Date());
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//KontentFerma//KF Content Approval//RU',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeIcsText(`КФ — ${projectLabel}: посты`)}`,
    `X-WR-CALDESC:${escapeIcsText('План постов КонтентФермы: даты публикации и статусы согласования (обновляется при каждой синхронизации календаря)')}`,
    'X-WR-TIMEZONE:Europe/Moscow',
    // Both are hints, not guarantees — Google Calendar honors X-PUBLISHED-TTL
    // for its own refresh cadence; other clients may ignore either. Status
    // changes pick up on the next re-sync, not instantly.
    'REFRESH-INTERVAL;VALUE=DURATION:PT6H',
    'X-PUBLISHED-TTL:PT6H',
  ];
  const body = pickFeedTasks(tasks)
    .map((task) => buildEvent(task, { linkToken, host, proto, dtstamp }))
    .join('');
  const footer = 'END:VCALENDAR\r\n';
  return lines.map(foldLine).join('') + body + footer;
}

module.exports = { buildIcsFeed, pickFeedTasks, escapeIcsText, foldLine };