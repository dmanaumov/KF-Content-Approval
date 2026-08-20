// Access analytics — "кто, когда, с какого устройства и в какой проект заходил".
//
// Records one row per (visitor, role, project/actor) per ~20-minute window into
// the access_log table (see initSchema in db.js), so a single cabinet visit is
// counted once rather than on every re-render/swipe. Anonymous cabinet visitors
// get a `kf_vid` cookie (1 year) so their return visits across days are the same
// "visitor". "Наши" (team members logged into /team, or the staff basic-auth
// user) are attributed as role=team/staff with their username; everyone else is
// role=client. Device/browser are classified from the User-Agent header.
//
// The stats *views* (how often a client logs in, which projects a worker opens,
// which devices/browsers, which dates) are a later phase — this module only
// records; the data is queryable straight from the access_log table.

const crypto = require('crypto');
const config = require('./config');
const db = require('./db');
const teamAuth = require('./teamAuth');

const VISITOR_COOKIE = 'kf_vid';
const VISITOR_COOKIE_MAX_AGE = 365 * 24 * 3600; // 1 year, so return visits stay the same visitor
const DEDUPE_WINDOW_MS = 20 * 60 * 1000; // ~ one "session" per visitor/role/project

const recent = new Map();
let warned = false;

// Распознаём из User-Agent всё, что в нём есть: тип устройства, браузер
// (+версию), ОС и модель. Модель/«производитель» в UA встречаются в основном
// у мобильных (iPhone/iPad и андроид-модели вида "SM-G991B"), для десктопа
// остаётся ОС. Итог склеивается в читаемую строку deviceLabel (и аналогично
// browserLabel) и кладётся в access_log — на /stat видно, сколько РАЗНЫХ
// посетителей заходило с какого устройства/браузера.
function uaInfo(ua) {
  const s = String(ua || '');
  let device = 'desktop';
  if (/iPad|Tablet/i.test(s)) device = 'tablet';
  else if (/Mobi|Android|iPhone/i.test(s)) device = 'mobile';

  let browser = 'другое';
  if (/Edg\//.test(s)) browser = 'Edge';
  else if (/OPR\/|Opera/i.test(s)) browser = 'Opera';
  else if (/Firefox\//.test(s)) browser = 'Firefox';
  else if (/Chrome\/|CriOS\//.test(s)) browser = 'Chrome';
  else if (/Safari\//.test(s)) browser = 'Safari';

  let os = '';
  if (/Windows NT 10\.0/.test(s)) os = 'Windows 10/11';
  else if (/Windows NT 6\.3/.test(s)) os = 'Windows 8.1';
  else if (/Windows NT/.test(s)) os = 'Windows';
  else if (/CrOS/.test(s)) os = 'ChromeOS';
  else if (/Mac OS X (\d+)[._](\d+)/.test(s)) os = 'macOS ' + s.match(/Mac OS X (\d+)[._](\d+)/).slice(1).join('.');
  else if (/CPU (?:iPhone )?OS (\d+)[._](\d+)/.test(s)) os = 'iOS ' + s.match(/CPU (?:iPhone )?OS (\d+)[._](\d+)/).slice(1).join('.');
  else if (/Android (\d+)/.test(s)) os = 'Android ' + s.match(/Android (\d+)/)[1];
  else if (/Linux/.test(s)) os = 'Linux';

  let model = '';
  if (/iPhone/.test(s)) model = 'iPhone';
  else if (/iPad/.test(s)) model = 'iPad';
  else if (/Macintosh|Mac OS X/.test(s)) model = 'Mac';
  else if (/Windows/.test(s)) model = 'PC';
  else {
    const m = s.match(/Android [\d.]+; ([^;)]+)/);
    if (m) model = m[1].replace(/\sBuild\/.*$/, '').trim();
  }

  // Для десктопа "PC/Mac" не пишем — там модель не несёт смысла, хватает ОС.
  const parts = [];
  if (model && model !== 'Mac' && model !== 'PC') parts.push(model);
  if (os) parts.push(os);
  const deviceLabel = parts.join(' · ') || device;

  let bver = '';
  if (browser === 'Safari') {
    const v = s.match(/Version\/([\d.]+)/);
    if (v) bver = v[1];
  } else {
    const re = { Edge: /Edg\/([\d.]+)/, Opera: /OPR\/([\d.]+)/, Firefox: /Firefox\/([\d.]+)/, Chrome: /Chrome\/([\d.]+)/ }[browser];
    if (re) {
      const v = s.match(re);
      if (v) bver = v[1];
    }
  }
  const browserLabel = bver ? `${browser} ${bver}` : browser;

  return { device, browser, deviceLabel, browserLabel };
}

function visitorId(req, res) {
  const m = String(req.headers.cookie || '').match(new RegExp('(?:^|;)\\s*' + VISITOR_COOKIE + '=([^;]+)'));
  if (m) return decodeURIComponent(m[1]);
  const id = crypto.randomUUID();
  const val = encodeURIComponent(id);
  // append, not setHeader — the same response may already carry another
  // cookie (e.g. the team session cookie on /api/team/login).
  res.append('Set-Cookie', `${VISITOR_COOKIE}=${val}; Path=/; Max-Age=${VISITOR_COOKIE_MAX_AGE}; HttpOnly; SameSite=Lax`);
  return id;
}

// Кто сейчас перед нами: залогиненный в /team — team; валидный basic-auth
// админки — staff; иначе анонимный client. Проверяется в первую очередь для
// кабинетных запросов, где "наш" сотрудник может открывать клиентские ссылки.
function identify(req) {
  try {
    const session = teamAuth.getSession(teamAuth.sessionIdFromRequest(req));
    if (session && session.user && session.user.username) {
      return {
        role: 'team',
        actor: session.user.username,
        actorName: [session.user.first_name, session.user.last_name].filter(Boolean).join(' '),
      };
    }
  } catch (e) {
    // no-op — fall through to staff/client
  }
  if (config.staffAuthUser && config.staffAuthPassword) {
    const header = req.headers.authorization || '';
    const [scheme, encoded] = header.split(' ');
    if (scheme === 'Basic' && encoded) {
      const decoded = Buffer.from(encoded, 'base64').toString('utf8');
      const sep = decoded.indexOf(':');
      if (sep >= 0 && decoded.slice(0, sep) === config.staffAuthUser && decoded.slice(sep + 1) === config.staffAuthPassword) {
        return { role: 'staff', actor: config.staffAuthUser, actorName: config.staffAuthUser };
      }
    }
  }
  return { role: 'client', actor: '', actorName: '' };
}

// Fire-and-forget: never blocks the response, never throws into the caller.
function note(role, { project = '', actor = '', actorName = '', path = '' }, req, res) {
  if (!config.databaseUrl) {
    if (!warned) {
      warned = true;
      console.warn('[analytics] DATABASE_URL not set — access analytics are not recorded.');
    }
    return;
  }
  const ua = String(req.headers['user-agent'] || '');
  const { device, browser, deviceLabel, browserLabel } = uaInfo(ua);
  const vid = visitorId(req, res);
  const key = `${vid}|${role}|${project || '-'}|${actor || '-'}|${path}`;
  const now = Date.now();
  const last = recent.get(key);
  if (last && now - last < DEDUPE_WINDOW_MS) return;
  recent.set(key, now);
  if (recent.size > 5000) recent.clear(); // keep the in-memory dedupe map bounded
  db.requirePool()
    .query(
      'INSERT INTO access_log (role, visitor_id, project, actor, actor_name, path, device, browser, device_label, browser_label, ua) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
      [role, vid, project, actor, actorName, path, device, browser, deviceLabel, browserLabel, ua]
    )
    .catch((err) => console.error('[analytics] failed to record:', err.message));
}

module.exports = { note, identify };