// CEO dashboard (/ceo) — owner-only, data from GET /api/ceo/overview
// (project liveness, month-over-month dynamics, team activity).

const root = document.getElementById('ceoRoot');
const loading = document.getElementById('ceoLoading');
const errorBox = document.getElementById('ceoError');

function esc(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function msk(iso) {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
}

function daysAgo(iso) {
  if (!iso) return '—';
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (d <= 0) return 'сегодня';
  if (d === 1) return 'вчера';
  return `${d} дн.`;
}

function momChange(cur, prev) {
  if (!cur && !prev) return '—';
  if (!prev) return '<span class="mom-new">новый</span>';
  const diff = cur - prev;
  if (diff === 0) return '<span class="mom-flat">0%</span>';
  const pct = Math.round((diff / prev) * 100);
  const cls = diff > 0 ? 'mom-up' : 'mom-down';
  const sign = diff > 0 ? '+' : '';
  return `<span class="${cls}">${sign}${pct}%</span>`;
}

function section(title, body) {
  return `<section class="stat-section"><h2>${esc(title)}</h2>${body}</section>`;
}

function table(headers, rows) {
  return `<table class="stat-table"><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}

function cards(data) {
  const t = data.totals || {};
  const activeTeam = data.team.length;
  const liveProjects = data.projects.filter((p) => (p.visitors7 || 0) > 0).length;
  return `<div class="stat-cards">
    <div class="stat-card"><div class="stat-card-num">${t.visitors30 || 0}</div><div class="stat-card-label">посетителей за 30 дней</div></div>
    <div class="stat-card"><div class="stat-card-num">${t.visitors7 || 0}</div><div class="stat-card-label">посетителей за 7 дней</div></div>
    <div class="stat-card"><div class="stat-card-num">${t.clients30 || 0}</div><div class="stat-card-label">клиентов за 30 дней</div></div>
    <div class="stat-card"><div class="stat-card-num">${activeTeam}</div><div class="stat-card-label">активных сотрудников</div></div>
    <div class="stat-card"><div class="stat-card-num">${liveProjects} из ${data.projects.length}</div><div class="stat-card-label">живых проектов (за 7 дней)</div></div>
  </div>`;
}

function projectLiveness(rows) {
  if (!rows.length) return '<div class="muted">Нет данных.</div>';
  return table(
    ['Проект', 'Последний визит', 'Дней назад', 'Визитов за 7д', 'Посетителей 30д'],
    rows.map((r) => [
      `<span class="stat-actor">${esc(r.project)}</span>`,
      msk(r.last_ts),
      daysAgo(r.last_ts),
      r.visits7 || 0,
      r.visitors30 || 0,
    ])
  );
}

function momTable(rows, curMonth, prevMonth) {
  if (!rows.length) return '<div class="muted">Нет данных.</div>';
  return table(
    ['Проект', `Посетители · ${curMonth}`, `Посетители · ${prevMonth}`, 'Δ посетителей', 'Заходы т/п'],
    rows.map((r) => [
      `<span class="stat-actor">${esc(r.project)}</span>`,
      r.cur_visitors || 0,
      r.prev_visitors || 0,
      momChange(r.cur_visitors || 0, r.prev_visitors || 0),
      `${r.cur_visits || 0} / ${r.prev_visits || 0}`,
    ])
  );
}

function teamTable(rows) {
  if (!rows.length) return '<div class="muted">Нет данных за 30 дней.</div>';
  return table(
    ['Сотрудник', 'Активных дней', 'Сессий', 'Последний заход', 'Дней назад'],
    rows.map((r) => [
      `<span class="stat-actor">${esc(r.actor_name || r.actor)}</span>`,
      r.active_days || 0,
      r.sessions || 0,
      msk(r.last_ts),
      daysAgo(r.last_ts),
    ])
  );
}

function weekLabel(weekKey) {
  const mon = new Date(weekKey + 'T00:00:00Z');
  const sun = new Date(mon.getTime() + 6 * 86400000);
  const f = (d) => new Intl.DateTimeFormat('ru-RU', { timeZone: 'UTC', day: '2-digit', month: '2-digit' }).format(d);
  return `${f(mon)}–${f(sun)}`;
}

function activityTable(rows) {
  if (rows == null) return '<div class="muted">Активность борда сейчас недоступна.</div>';
  if (!rows.length) return '<div class="muted">Нет данных.</div>';
  return table(
    ['Неделя', 'Создано карточек', 'Запланировано', 'Согласовано', 'Не опубликовано вовремя'],
    rows.slice().reverse().map((r) => [
      `<span class="stat-nowrap">${weekLabel(r.week)}</span>`,
      r.created || 0,
      r.planned || 0,
      r.approved || 0,
      (r.late || 0) > 0 ? `<span class="mom-down">${r.late}</span>` : (r.late || 0),
    ])
  );
}

function render(data) {
  const html = [
    section('Итоги за 30 дней', cards(data)),
    section('Активность · по неделям', activityTable(data.activity)),
    section('Живость проектов', projectLiveness(data.projects)),
    section(`Динамика месяц-к-месяцу · ${data.curMonth} vs ${data.prevMonth}`, momTable(data.mom, data.curMonth, data.prevMonth)),
    section('Активность команды · 30 дней', teamTable(data.team)),
  ].join('');
  root.innerHTML = html;
}

async function load() {
  try {
    const res = await fetch('/api/ceo/overview');
    if (res.status === 401) {
      errorBox.innerHTML =
        'Доступ только владельцу. Войдите в <a href="/team">кабинет команды</a> под своим Mattermost-аккаунтом и обновите страницу.';
      errorBox.hidden = false;
      loading.hidden = true;
      return;
    }
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || 'Ошибка загрузки');
    loading.hidden = true;
    render(data);
  } catch (err) {
    loading.hidden = true;
    errorBox.textContent = 'Не удалось загрузить данные: ' + err.message;
    errorBox.hidden = false;
  }
}

load();