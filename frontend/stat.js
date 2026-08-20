// Access statistics page (/stat) — reads GET /api/analytics/summary and
// renders cards, a by-day bar chart, horizontal-bar breakdowns, and tables.

const root = document.getElementById('statRoot');
const loading = document.getElementById('statLoading');
const errorBox = document.getElementById('statError');

const ROLE_LABEL = { client: 'Клиент', team: 'Команда', staff: 'Админка' };
const ROLE_CLASS = { client: 'waiting', team: 'approved', staff: 'internal' };

function esc(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 3200);
}

// Горизонтальные полоски: name + count + трек, пропорциональный максимуму.
function hbars(rows, labelKey, valueKey = 'events') {
  if (!rows || !rows.length) return '<div class="muted">Нет данных.</div>';
  const max = Math.max(...rows.map((r) => r[valueKey] || 0), 1);
  return rows
    .map((r) => {
      const v = r[valueKey] || 0;
      const w = Math.round((v / max) * 100);
      const name = r[labelKey] || '—';
      const sub = r.visitors != null ? ` · ${r.visitors} посетител(ей)` : '';
      return `<div class="hb">
        <div class="hb-row"><span class="hb-name" title="${esc(name)}">${esc(name)}</span><span class="hb-val">${v}${esc(sub)}</span></div>
        <div class="hb-track"><div class="hb-fill" style="width:${w}%"></div></div>
      </div>`;
    })
    .join('');
}

// График по дням — колонки пропорциональны максимуму.
function dateChart(rows) {
  if (!rows || !rows.length) return '<div class="muted">Нет данных за период.</div>';
  const max = Math.max(...rows.map((r) => r.events || 0), 1);
  return `<div class="c-chart">${rows
    .map((r) => {
      const h = Math.max(3, Math.round((r.events / max) * 130));
      return `<div class="c-bar" title="${esc(r.day)}: ${r.events} событ(ий), ${r.visitors} посетител(ей)">
        <div class="c-bar-fill" style="height:${h}px"></div>
        <div class="c-bar-label">${esc(r.day.slice(5))}</div>
      </div>`;
    })
    .join('')}</div>`;
}

function cards(data) {
  const byRole = Object.fromEntries(data.byRole.map((r) => [r.role, r]));
  const total = data.byRole.reduce((s, r) => s + (r.events || 0), 0);
  const clients = byRole.client || { events: 0, visitors: 0 };
  const team = byRole.team || { events: 0, visitors: 0 };
  const staff = byRole.staff || { events: 0, visitors: 0 };
  return `<div class="stat-cards">
    <div class="stat-card"><div class="stat-card-num">${total}</div><div class="stat-card-label">всего событий за 30 дней</div></div>
    <div class="stat-card"><div class="stat-card-num">${clients.visitors || 0}</div><div class="stat-card-label">уникальных клиентов</div></div>
    <div class="stat-card"><div class="stat-card-num">${clients.events || 0}</div><div class="stat-card-label">заходов клиентов</div></div>
    <div class="stat-card"><div class="stat-card-num">${team.events || 0}</div><div class="stat-card-label">действий команды</div></div>
    <div class="stat-card"><div class="stat-card-num">${staff.events || 0}</div><div class="stat-card-label">просмотров админки</div></div>
  </div>`;
}

function actorsByProjectTable(rows) {
  if (!rows || !rows.length) return '<div class="muted">Нет данных.</div>';
  const grouped = new Map();
  rows.forEach((r) => {
    if (!grouped.has(r.actor)) grouped.set(r.actor, []);
    grouped.get(r.actor).push(r);
  });
  return `<table class="stat-table"><thead><tr><th>Работник</th><th>Проекты (заходы)</th></tr></thead><tbody>${[...grouped.entries()]
    .map(([actor, items]) => {
      const projs = items.map((i) => `<span class="stat-proj"><b>${esc(i.project)}</b> ${i.events}</span>`).join('');
      return `<tr><td class="stat-actor">${esc(actor)}</td><td>${projs}</td></tr>`;
    })
    .join('')}</tbody></table>`;
}

function recentTable(rows) {
  if (!rows || !rows.length) return '<div class="muted">Пока нет событий.</div>';
  return `<table class="stat-table"><thead><tr><th>Когда (МСК)</th><th>Кто</th><th>Где</th><th>Устройство</th><th>Браузер</th></tr></thead><tbody>${rows
    .map((r) => {
      const who = r.role === 'team' ? `👤 ${esc(r.actor)}` : ROLE_LABEL[r.role] || esc(r.role);
      const where = r.project ? esc(r.project) : esc(r.path);
      return `<tr>
        <td class="stat-nowrap">${esc(r.ts)}</td>
        <td><span class="status ${ROLE_CLASS[r.role] || 'internal'}">${esc(who)}</span></td>
        <td>${where}</td>
        <td>${esc(r.device)}</td>
        <td>${esc(r.browser)}</td>
      </tr>`;
    })
    .join('')}</tbody></table>`;
}

function section(title, body) {
  return `<section class="stat-section"><h2>${esc(title)}</h2>${body}</section>`;
}

// Активность по проектам: проект + список устройств, заходивших в его
// интерфейс согласования (за текущий месяц, с числом входов на устройство).
function projectDevicesTable(rows) {
  const groups = new Map();
  rows.forEach((r) => {
    if (!groups.has(r.project)) groups.set(r.project, []);
    groups.get(r.project).push(r);
  });
  if (!groups.size) return '<div class="muted">Нет данных за месяц.</div>';
  return `<table class="stat-table">
    <thead><tr><th>Проект</th><th>Устройства</th></tr></thead>
    <tbody>${[...groups.entries()]
      .map(
        ([proj, list]) => `<tr>
        <td class="stat-actor">${esc(proj)}</td>
        <td>${list.map((d) => `<span class="stat-dev">${esc(d.device)} <b>${d.events}</b></span>`).join('')}</td>
      </tr>`
      )
      .join('')}</tbody>
  </table>`;
}

// Общая тепловая карта: series = [{ label, cells: { 'YYYY-MM-DD': { v, tip } } }].
// Нет сессии — белый фон, максимум — зелёный.
function heatmapTable(monthDays, series, rowLabel = 'Проект') {
  if (!monthDays.length || !series.length) return '<div class="muted">Нет данных за месяц.</div>';
  const max = Math.max(...series.flatMap((s) => Object.values(s.cells).map((c) => c.v)), 0);
  const weekend = monthDays.map((d) => { const w = new Date(d + 'T00:00:00Z').getUTCDay(); return w === 0 || w === 6; });
  const head = `<thead><tr><th>${esc(rowLabel)}</th>${monthDays.map((d, i) => `<th class="${weekend[i] ? 'hm-weekend' : ''}">${+d.slice(8)}</th>`).join('')}</tr></thead>`;
  const body = series
    .map((s) => {
      const tds = monthDays
        .map((d, i) => {
          const c = s.cells[d];
          if (!c) return `<td class="hm-zero${weekend[i] ? ' hm-weekend' : ''}"></td>`;
          const alpha = max ? c.v / max : 0;
          const strong = alpha > 0.55;
          return `<td class="${strong ? 'hm-strong' : ''}${weekend[i] ? ' hm-weekend' : ''}" style="background:rgba(121,201,74,${alpha})" title="${esc(c.tip || '')}">${c.v}</td>`;
        })
        .join('');
      return `<tr><td class="stat-actor">${esc(s.label)}</td>${tds}</tr>`;
    })
    .join('');
  return `<div class="hm"><table class="stat-table hm-table">${head}<tbody>${body}</tbody></table><div class="hm-legend">нет сессий — белый · максимум — зелёный</div></div>`;
}

// Активность по проекту: строки — проекты, столбцы — даты текущего месяца,
// ячейки — сколько входов было.
function projectHeatmap(monthDays, daily) {
  const cell = new Map();
  const totals = new Map();
  daily.forEach((r) => {
    cell.set(r.project + '|' + r.day, r);
    totals.set(r.project, (totals.get(r.project) || 0) + r.events);
  });
  const series = [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([p]) => {
      const cells = {};
      monthDays.forEach((d) => {
        const c = cell.get(p + '|' + d);
        if (c) cells[d] = { v: c.events, tip: `${d}: ${c.events} вход(ов), ${c.devices} устройств, ${c.visitors} посетител(ей)` };
      });
      return { label: p, cells };
    });
  return heatmapTable(monthDays, series);
}

// Активность команды: строки — работники (имя/фамилия, если известны),
// ячейки — число сессий за день.
function teamHeatmap(monthDays, daily) {
  const cell = new Map();
  const totals = new Map();
  daily.forEach((r) => {
    cell.set(r.actor + '|' + r.day, r);
    totals.set(r.actor, (totals.get(r.actor) || 0) + r.sessions);
  });
  const series = [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([actor]) => {
      const first = daily.find((r) => r.actor === actor);
      const label = (first && first.actor_name) || actor;
      const cells = {};
      monthDays.forEach((d) => {
        const c = cell.get(actor + '|' + d);
        if (c) cells[d] = { v: c.sessions, tip: `${d}: ${c.sessions} сесси(й), ${c.devices} устройств, ${c.visitors} посетител(ей)` };
      });
      return { label, cells };
    });
  return heatmapTable(monthDays, series, 'Работник');
}

function render(data, proj, team) {
  const html = [
    section(`Активность по проектам · ${proj.month}`, projectDevicesTable(proj.projectDevices)),
    section(`Активность по проекту · ${proj.month}`, projectHeatmap(proj.monthDays, proj.projectDaily)),
    section(`Активность команды · ${team.month}`, teamHeatmap(team.monthDays, team.teamDaily)),
    section('За 30 дней', cards(data)),
    section('Визиты по дням', dateChart(data.byDate)),
    section('Заходы по проектам', hbars(data.byProject, 'project')),
    section('Устройства', hbars(data.byDevice, 'device')),
    section('Браузеры', hbars(data.byBrowser, 'browser')),
    section('В какие проекты заходят работники', actorsByProjectTable(data.actorsByProject)),
    section('Недавние посещения', recentTable(data.recent)),
  ].join('');
  root.innerHTML = html;
}

async function load() {
  try {
    const [sumRes, projRes, teamRes] = await Promise.all([
      fetch('/api/analytics/summary'),
      fetch('/api/analytics/projects'),
      fetch('/api/analytics/team'),
    ]);
    if (sumRes.status === 401 || projRes.status === 401 || teamRes.status === 401) {
      errorBox.textContent = 'Нужен доступ администратора (введите пароль от админки). Обновите страницу после входа.';
      errorBox.hidden = false;
      loading.hidden = true;
      return;
    }
    const data = await sumRes.json();
    const proj = await projRes.json();
    const team = await teamRes.json();
    if (!sumRes.ok) throw new Error(data.message || 'Ошибка загрузки статистики');
    if (!projRes.ok) throw new Error(proj.message || 'Ошибка загрузки статистики');
    if (!teamRes.ok) throw new Error(team.message || 'Ошибка загрузки статистики');
    loading.hidden = true;
    render(data, proj, team);
  } catch (err) {
    loading.hidden = true;
    errorBox.textContent = 'Не удалось загрузить статистику: ' + err.message;
    errorBox.hidden = false;
  }
}

load();