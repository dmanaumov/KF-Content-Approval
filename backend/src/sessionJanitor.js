// Keeps the number of Mattermost sessions on KF Approval's own account under
// control (2026-10-08).
//
// Why: every POST /users/login creates a NEW session and nothing ever logs the
// old ones out. This account is also used by other clients (n8n logs in with
// the same credentials; a person's browser shows up on it too), so sessions
// piled up to Mattermost's per-user cap — from then on EVERY login made
// Mattermost revoke the oldest session ("Session revoked; user's number of
// sessions were over the maxSessionsLimit", seen live 12:42 UTC), which can
// knock out a session someone else is still using → their 401 → their
// re-login → knocks out ours → ...
//
// What: list own sessions; if there are more than config.sessionMax, revoke
// the stale ones — sessions with nothing behind them (scripts/API) after
// sessionApiIdleMin of inactivity, real browser/app sessions only after
// sessionHumanIdleHours. Our own live session is in constant use, so it is
// never idle long enough to qualify.

const config = require('./config');
const mm = require('./mattermostClient');

const HUMAN_RE = /chrome|firefox|safari|edge|opera|yandex|electron|desktop|mattermost|mobile|android|ios|iphone|ipad/i;

function isHumanSession(s) {
  if (s.device_id) return true; // mobile app with push registration
  const p = s.props || {};
  const hay = [p.browser, p.platform, p.os, p.is_mobile === 'true' ? 'mobile' : ''].join(' ');
  if (/unknown/i.test(p.browser || '') && !s.device_id) return false;
  return HUMAN_RE.test(hay);
}

let running = false;
let lastRunAt = 0;

async function run(reason) {
  if (!config.sessionJanitorEnabled || !mm.usingSessionLogin() || running) return;
  running = true;
  lastRunAt = Date.now();
  try {
    const { userId, sessions } = await mm.listOwnSessions();
    if (sessions.length <= config.sessionMax) {
      if (config.debug) console.log(`[sessions] ${reason}: ${sessions.length} sessions (limit ${config.sessionMax}) — nothing to do`);
      return;
    }
    const now = Date.now();
    const apiIdle = config.sessionApiIdleMin * 60 * 1000;
    const humanIdle = config.sessionHumanIdleHours * 3600 * 1000;
    let human = 0;
    const stale = sessions
      .filter((s) => {
        const h = isHumanSession(s);
        if (h) human++;
        const idle = now - (s.last_activity_at || s.create_at || 0);
        return idle > (h ? humanIdle : apiIdle);
      })
      .sort((a, b) => (a.last_activity_at || 0) - (b.last_activity_at || 0))
      .slice(0, config.sessionRevokeMaxPerRun);

    let revoked = 0;
    let failed = 0;
    for (const s of stale) {
      try {
        await mm.revokeOwnSession(userId, s.id);
        revoked++;
      } catch (err) {
        failed++;
        if (failed >= 5) break; // Mattermost unhappy — try again next run
      }
      await new Promise((r) => setTimeout(r, 50)); // gentle on Mattermost
    }
    console.log(
      `[sessions] ${reason}: ${sessions.length} sessions (${human} browser/app, ${sessions.length - human} API), ` +
        `limit ${config.sessionMax} → revoked ${revoked} stale` + (failed ? `, ${failed} failed` : '')
    );
  } catch (err) {
    console.warn(`[sessions] ${reason}: cleanup skipped — ${err.message}`);
  } finally {
    running = false;
  }
}

function start() {
  if (!config.sessionJanitorEnabled || !mm.usingSessionLogin()) return;
  const every = Math.max(1, config.sessionJanitorIntervalMin) * 60 * 1000;
  setTimeout(() => run('startup'), 60 * 1000).unref();
  setInterval(() => run('scheduled'), every).unref();
  // A fresh login is exactly when the count grows — check soon after, but at
  // most once per 5 minutes so a login burst doesn't turn into a cleanup burst.
  mm.onLogin(() => {
    if (Date.now() - lastRunAt < 5 * 60 * 1000) return;
    setTimeout(() => run('after-login'), 30 * 1000).unref();
  });
}

module.exports = { start, run, isHumanSession };
