// ICS (iCalendar) feed for the client cabinet's "напоминания в календаре"
// feature — lets a client subscribe (webcal://) their own calendar app to a
// per-project feed of cards currently in "На согласование". Deliberately
// NOT another outbound channel this app has to send through itself (see the
// "Кот Василий" bot's principle: this app never calls an external send API
// directly) — the client's OWN calendar app polls this URL on its own
// schedule and generates the native OS/app notification. One VEVENT per
// waiting card, RRULE:FREQ=DAILY with no UNTIL — "нагоняющее" is achieved
// simply by the event recurring every day for as long as the card keeps
// showing up in this feed; once a card leaves "На согласование" it's absent
// from the next-generated feed, and the client's calendar removes the
// recurrence on its next sync (calendar apps typically re-fetch a
// subscribed URL every few hours to ~24h — that cadence belongs to
// Google/Apple/Outlook, not something this app controls).

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

// The calendar day (in Moscow local time) a reminder should start recurring
// from — best-effort "since when has this card been waiting" signal, since
// there's no dedicated "entered На согласование" timestamp on the card,
// only its overall last-updated time. Clamped to not be in the future (a
// clock-skew safety net, not an expected real case) so a freshly-touched
// card doesn't get a DTSTART calendar apps would treat as "starts tomorrow".
function reminderAnchorDate(task) {
  const raw = Math.min(task.updateAt || Date.now(), Date.now());
  const mskShifted = new Date(raw + MSK_OFFSET_MS);
  return new Date(Date.UTC(mskShifted.getUTCFullYear(), mskShifted.getUTCMonth(), mskShifted.getUTCDate()));
}

// Builds one VEVENT for a single "На согласование" task — daily-recurring,
// 10:00 Moscow time, with a 15-minute-before display alarm (some calendar
// clients only surface a native notification when an explicit VALARM is
// present, not just from the bare event).
function buildEvent(task, { linkToken, host, proto, dtstamp }) {
  const anchor = reminderAnchorDate(task);
  const startUtcMs = anchor.getTime() + 7 * 60 * 60 * 1000; // 10:00 MSK == 07:00 UTC
  const dtstart = formatIcsUtc(new Date(startUtcMs));
  const dtend = formatIcsUtc(new Date(startUtcMs + 15 * 60 * 1000));
  const taskUrl = `${proto}://${host}/l/${encodeURIComponent(linkToken)}?task=${encodeURIComponent(task.id)}`;
  const lines = [
    'BEGIN:VEVENT',
    `UID:kfw-${task.id}@kontentferma.com`,
    `DTSTAMP:${dtstamp}`,
    `DTSTART:${dtstart}`,
    `DTEND:${dtend}`,
    'RRULE:FREQ=DAILY',
    `SUMMARY:${escapeIcsText(`Контент на проверку: ${task.title}`)}`,
    `DESCRIPTION:${escapeIcsText(`Откройте карточку в кабинете КонтентФермы: ${taskUrl}`)}`,
    `URL:${taskUrl}`,
    'STATUS:CONFIRMED',
    'SEQUENCE:0',
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    'DESCRIPTION:Контент ждёт вашей проверки',
    'TRIGGER:-PT15M',
    'END:VALARM',
    'END:VEVENT',
  ];
  return lines.map(foldLine).join('');
}

// tasks — already filtered to status === 'waiting' by the caller (this
// module doesn't know about the app's status taxonomy on purpose, keeps it
// reusable/testable on a plain task array).
function buildIcsFeed(tasks, { projectLabel, linkToken, host, proto }) {
  const dtstamp = formatIcsUtc(new Date());
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//KontentFerma//KF Content Approval//RU',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeIcsText(`КФ — ${projectLabel}: контент на проверку`)}`,
    `X-WR-CALDESC:${escapeIcsText('Автоматическое напоминание о постах, ожидающих вашей проверки в КонтентФерме')}`,
    'X-WR-TIMEZONE:Europe/Moscow',
    // Both are hints, not guarantees — Google Calendar honors X-PUBLISHED-TTL
    // for its own refresh cadence; other clients may ignore either.
    'REFRESH-INTERVAL;VALUE=DURATION:PT12H',
    'X-PUBLISHED-TTL:PT12H',
  ];
  const body = tasks.map((task) => buildEvent(task, { linkToken, host, proto, dtstamp })).join('');
  const footer = 'END:VCALENDAR\r\n';
  return lines.map(foldLine).join('') + body + footer;
}

module.exports = { buildIcsFeed, escapeIcsText, foldLine };
