// Access statistics page (/stat) — reads GET /api/analytics/summary and
// renders cards, a by-day bar chart, horizontal-bar breakdowns, and tables.

const root = document.getElementById('statRoot');
const loading = document.getElementById('statLoading');
const errorBox = document.getElementById('statError');

const ROLE_LABEL = { client: 'Клиент', team: 'Команда', staff: 'Админка' };
const ROLE_CLASS = { client: 'waiting', team: 'approved', staff: 'internal' };

const MONTH_NAMES = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];

let summary = null; // данные «за 30 дней» — загружаются один раз
let viewMonth = null; // { y, m } — московский месяц, который показываем в месячных вью

// Фильтры «Недавних посещений» (добавлено 2026-09-26, прямой запрос
// пользователя: сортировка по убыванию — она и так уже была, ORDER BY ts
// DESC что на /api/analytics/summary, что на новом /api/analytics/recent —
// плюс минимальные фильтры «где / пользователь / дата»). where — не
// project, а то же самое, что показывает колонка «Где» в recentTable ниже:
// имя проекта, когда есть, иначе путь эндпоинта (уточнение пользователя:
// «точнее не проект, а "где" выпадающий список»).
let recentFilters = { where: '', actor: '', date: '' };
let recentRows = []; // текущие (отфильтрованные) строки «Недавних посещений»

function currentMoscowMonth() {
  const d = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(new Date());
  const [y, m] = d.slice(0, 7).split('-').map(Number);
  return { y, m };
}

function shiftMonth(ym, delta) {
  let m = ym.m + delta;
  if (m < 1) return { y: ym.y - 1, m: 12 };
  if (m > 12) return { y: ym.y + 1, m: 1 };
  return { y: ym.y, m };
}

function monthQuery() {
  return `?month=${String(viewMonth.y).padStart(4, '0')}-${String(viewMonth.m).padStart(2, '0')}`;
}

function monthNav() {
  const cur = currentMoscowMonth();
  const atCurrent = viewMonth.y === cur.y && viewMonth.m === cur.m;
  return `<section class="stat-section month-nav">
    <div class="month-nav-group">
      <button id="monthPrev" class="month-btn" title="Предыдущий месяц" aria-label="Предыдущий месяц">←</button>
      <span class="month-label">${MONTH_NAMES[viewMonth.m - 1]} ${viewMonth.y}</span>
      <button id="monthNext" class="month-btn" title="Следующий месяц" aria-label="Следующий месяц" ${atCurrent ? 'disabled' : ''}>→</button>
    </div>
    <button id="statRefreshBtn" class="month-btn" title="Обновить сейчас" aria-label="Обновить">⟳</button>
  </section>`;
}

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

// Горизонтальные полоски: name + основное число + необязательная вторая
// метрика. По умолчанию основное = события, подпись — число посетителей;
// для устройств/браузеров наоборот: основное = посетители, подпись = заходы.
function hbars(rows, labelKey, opts = {}) {
  const { valueKey = 'events', subKey = 'visitors', subUnit = 'посетител(ей)' } = opts;
  if (!rows || !rows.length) return '<div class="muted">Нет данных.</div>';
  const max = Math.max(...rows.map((r) => r[valueKey] || 0), 1);
  return rows
    .map((r) => {
      const v = r[valueKey] || 0;
      const w = Math.round((v / max) * 100);
      const name = r[labelKey] || '—';
      const sub = r[subKey] != null ? ` · ${r[subKey]} ${subUnit}` : '';
      return `<div class="hb">
        <div class="hb-row"><span class="hb-name" title="${esc(name)}">${esc(name)}</span><span class="hb-val">${v}${esc(sub)}</span></div>
        <div class="hb-track"><div class="hb-fill" style="width:${w}%"></div></div>
      </div>`;
    })
    .join('');
}

// График по дням — колонки с числом визитов и датой (DD.MM), в подсказке —
// полная дата и число посетителей.
function dateChart(rows) {
  if (!rows || !rows.length) return '<div class="muted">Нет данных за период.</div>';
  const max = Math.max(...rows.map((r) => r.events || 0), 1);
  return `<div class="c-chart">${rows
    .map((r) => {
      const h = Math.max(4, Math.round((r.events / max) * 110));
      const label = r.day.slice(5).split('-').reverse().join('.');
      return `<div class="c-bar" title="${esc(r.day)}: ${r.events} визит(ов), ${r.visitors} посетител(ей)">
        <div class="c-bar-val">${r.events}</div>
        <div class="c-bar-fill" style="height:${h}px"></div>
        <div class="c-bar-label">${esc(label)}</div>
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
    <div class="stat-card"><div class="stat-card-num">${data.totalVisitors || 0}</div><div class="stat-card-label">уникальных посетителей</div></div>
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
    if (!grouped.has(r.actor)) grouped.set(r.actor, { label: r.actor_name || r.actor, items: [] });
    grouped.get(r.actor).items.push(r);
  });
  return `<table class="stat-table"><thead><tr><th>Работник</th><th>Проекты (заходы)</th></tr></thead><tbody>${[...grouped.values()]
    .map((g) => {
      const projs = g.items.map((i) => `<span class="stat-proj"><b>${esc(i.project)}</b> ${i.events}</span>`).join('');
      return `<tr><td class="stat-actor">${esc(g.label)}</td><td>${projs}</td></tr>`;
    })
    .join('')}</tbody></table>`;
}

function recentTable(rows) {
  if (!rows || !rows.length) return '<div class="muted">Ничего не найдено — попробуйте сбросить фильтры.</div>';
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

// Строит выпадающие списки «Где»/«Кто» из summary.byWhere/actorsByProject —
// тот же пул значений «за 30 дней», что и остальные срезы на странице,
// плюс те, кто вообще есть в byActor (actorsByProject требует project<>'',
// так что чисто внутренние действия без проекта туда не попадают, а
// человека всё равно нужно найти в списке).
function recentFilterBarHtml() {
  const whereOptions = ((summary && summary.byWhere) || [])
    .map((w) => `<option value="${esc(w.where_label)}"${recentFilters.where === w.where_label ? ' selected' : ''}>${esc(w.where_label)}</option>`)
    .join('');
  const actorNames = new Map();
  ((summary && summary.actorsByProject) || []).forEach((r) => {
    if (!actorNames.has(r.actor)) actorNames.set(r.actor, r.actor_name || r.actor);
  });
  ((summary && summary.byActor) || []).forEach((r) => {
    if (!actorNames.has(r.actor)) actorNames.set(r.actor, r.actor);
  });
  const actorOptions = [...actorNames.entries()]
    .sort((a, b) => a[1].localeCompare(b[1], 'ru'))
    .map(([actor, label]) => `<option value="${esc(actor)}"${recentFilters.actor === actor ? ' selected' : ''}>${esc(label)}</option>`)
    .join('');
  return `<div class="stat-filters">
    <select id="recentFilterWhere" class="stat-filter-select"><option value="">Где — все</option>${whereOptions}</select>
    <select id="recentFilterActor" class="stat-filter-select"><option value="">Кто — все</option>${actorOptions}</select>
    <input type="date" id="recentFilterDate" class="stat-filter-date" value="${esc(recentFilters.date)}">
    <button type="button" id="recentFilterReset" class="stat-filter-reset">Сбросить</button>
  </div>`;
}

function recentSectionHtml() {
  return `${recentFilterBarHtml()}<div id="recentTableWrap">${recentTable(recentRows)}</div>`;
}

function recentQuery() {
  const params = new URLSearchParams();
  if (recentFilters.where) params.set('where', recentFilters.where);
  if (recentFilters.actor) params.set('actor', recentFilters.actor);
  if (recentFilters.date) params.set('date', recentFilters.date);
  const qs = params.toString();
  return qs ? '?' + qs : '';
}

async function fetchRecent() {
  const res = await fetch('/api/analytics/recent' + recentQuery());
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || 'Ошибка загрузки посещений');
  recentRows = data.rows || [];
}

// Точечно обновляет только таблицу «Недавних посещений» (не всю страницу) —
// используется при смене любого из трёх фильтров и кнопкой «Сбросить».
async function refreshRecentTable() {
  try {
    await fetchRecent();
    const wrap = document.getElementById('recentTableWrap');
    if (wrap) wrap.innerHTML = recentTable(recentRows);
  } catch (err) {
    const wrap = document.getElementById('recentTableWrap');
    if (wrap) wrap.innerHTML = `<div class="muted">Не удалось загрузить: ${esc(err.message)}</div>`;
  }
}

function section(title, body, sub) {
  return `<section class="stat-section"><h2>${esc(title)}</h2>${sub ? `<div class="stat-sub">${esc(sub)}</div>` : ''}${body}</section>`;
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
// Без колонки дат — маленькие квадратики, дата и число всплывают при наведении.
// Нет сессии — белый фон, максимум — зелёный.
function heatmapTable(monthDays, series, rowLabel = 'Проект') {
  if (!monthDays.length || !series.length) return '<div class="muted">Нет данных за месяц.</div>';
  const max = Math.max(...series.flatMap((s) => Object.values(s.cells).map((c) => c.v)), 0);
  const weekend = monthDays.map((d) => { const w = new Date(d + 'T00:00:00Z').getUTCDay(); return w === 0 || w === 6; });
  const body = series
    .map((s) => {
      const tds = monthDays
        .map((d, i) => {
          const c = s.cells[d];
          if (!c) return `<td class="hm-zero${weekend[i] ? ' hm-weekend' : ''}" title="${esc(d)}: 0"></td>`;
          const alpha = max ? c.v / max : 0;
          const strong = alpha > 0.55;
          return `<td class="${strong ? 'hm-strong' : ''}${weekend[i] ? ' hm-weekend' : ''}" style="background:rgba(121,201,74,${alpha})" title="${esc(c.tip || '')}">${c.v}</td>`;
        })
        .join('');
      return `<tr><td class="stat-actor hm-label" title="${esc(s.label)}">${esc(s.label)}</td>${tds}</tr>`;
    })
    .join('');
  return `<div class="hm"><table class="stat-table hm-table"><tbody>${body}</tbody></table><div class="hm-legend">дата и число — при наведении · максимум — зелёный</div></div>`;
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

// Матрица «работник × выполнение задач» — строки исполнители (исполнитель на
// карточке), столбцы: невыполненных карточек и выполненных за последние 14
// дней (статус «Согласовано НА ПУБЛИКАЦИЮ»/«ОПУБЛИКОВАНО» И updateAt карточки
// моложе 14 дней — см. /api/analytics/team-tasks). Такой же вид проматрицы,
// как у остальных таблиц этой страницы. Не зависит от выбранного месяца —
// это скользящее 14-дневное окно, не календарный месяц.
function workerTasksTable(rows) {
  if (!rows || !rows.length) return '<div class="muted">Нет задач с назначенным исполнителем.</div>';
  return `<table class="stat-table">
    <thead><tr><th>Работник</th><th>Невыполнено задач</th><th>Выполнено за 14 дней</th></tr></thead>
    <tbody>${rows
      .map(
        (r) => `<tr>
        <td class="stat-actor">${esc(r.name)}</td>
        <td>${r.notDone}</td>
        <td>${r.done14}</td>
      </tr>`
      )
      .join('')}</tbody>
  </table>`;
}

function render(data, proj, team, tasks) {
  const html = [
    monthNav(),
    section(`Активность по проектам · ${proj.month}`, projectDevicesTable(proj.projectDevices)),
    section(`Активность по проекту · ${proj.month}`, projectHeatmap(proj.monthDays, proj.projectDaily)),
    section(`Активность команды · ${team.month}`, teamHeatmap(team.monthDays, team.teamDaily)),
    section('Выполнение задач · за 14 дней', workerTasksTable(tasks.rows), 'невыполнено — карточки не в статусах «Согласовано НА ПУБЛИКАЦИЮ» / «ОПУБЛИКОВАНО»; выполнено за 14 дней — карточка в одном из этих статусов, обновлённая менее 14 дней назад'),
    section('За 30 дней', cards(data)),
    section('Посещения по дням', dateChart(data.byDate), 'все кабинеты (клиенты, команда, админка) · один заход на посетителя за 20 минут'),
    section('Заходы по проектам', hbars(data.byProject, 'project')),
    section('Устройства посетителей', hbars(data.byDevice, 'device_label', { valueKey: 'visitors', subKey: 'events', subUnit: 'заход(ов)' })),
    section('Браузеры посетителей', hbars(data.byBrowser, 'browser_label', { valueKey: 'visitors', subKey: 'events', subUnit: 'заход(ов)' })),
    section('В какие проекты заходят работники', actorsByProjectTable(data.actorsByProject)),
    section('Недавние посещения', recentSectionHtml()),
  ].join('');
  root.innerHTML = html;
  document.getElementById('monthPrev').addEventListener('click', () => {
    viewMonth = shiftMonth(viewMonth, -1);
    renderAll();
  });
  document.getElementById('monthNext').addEventListener('click', () => {
    viewMonth = shiftMonth(viewMonth, 1);
    renderAll();
  });
  // Обновить сейчас — тянет и summary (см. fetchSummary), и месячные вью,
  // не дожидаясь автообновления (см. startAutoRefresh ниже) или ручного F5.
  document.getElementById('statRefreshBtn').addEventListener('click', async () => {
    try {
      if (!(await fetchSummary())) return;
      await fetchRecent();
      await renderAll();
    } catch (err) {
      errorBox.textContent = 'Не удалось обновить статистику: ' + err.message;
      errorBox.hidden = false;
    }
  });
  // Фильтры «Недавних посещений» — каждый меняет своё поле в recentFilters
  // и точечно перерисовывает только таблицу (без полного renderAll):
  // остальные секции этот выбор не затрагивает.
  document.getElementById('recentFilterWhere').addEventListener('change', (e) => {
    recentFilters.where = e.target.value;
    refreshRecentTable();
  });
  document.getElementById('recentFilterActor').addEventListener('change', (e) => {
    recentFilters.actor = e.target.value;
    refreshRecentTable();
  });
  document.getElementById('recentFilterDate').addEventListener('change', (e) => {
    recentFilters.date = e.target.value;
    refreshRecentTable();
  });
  document.getElementById('recentFilterReset').addEventListener('click', () => {
    recentFilters = { where: '', actor: '', date: '' };
    // Сбрасываем сами инпуты руками (без полного render()) — им не нужно
    // ничего, кроме сброса значения, а сам render() ничего не выиграл бы:
    // options списков «Где»/«Кто» и так не зависят от recentFilters, кроме
    // атрибута selected, который сейчас нам и не важен.
    const wSel = document.getElementById('recentFilterWhere');
    const aSel = document.getElementById('recentFilterActor');
    const dInp = document.getElementById('recentFilterDate');
    if (wSel) wSel.value = '';
    if (aSel) aSel.value = '';
    if (dInp) dInp.value = '';
    refreshRecentTable();
  });
}

// Тянет «за 30 дней» (включая «Недавние посещения») и кладёт в module-level
// summary. Вынесено из load() в отдельную функцию 2026-09-26 — баг:
// «Недавние посещения» показывали конец августа и не обновлялись, хотя
// access_log все это время копился (см. teamHeatmap/projectHeatmap — те
// свежие, потому что renderAll() дёргает их эндпоинты заново при листании
// месяцев). Причина — summary грузился РОВНО ОДИН РАЗ, при открытии
// страницы (см. комментарий у renderAll: «кэшируется и не дёргается при
// листании месяцев» — экономия запросов, о которой никто не думал как о
// «эта вкладка открыта у Дмитрия неделями»). Возвращает false и сама
// показывает ошибку/401, если статистику вообще не удалось получить —
// вызывающий код в этом случае просто останавливается, ничего больше не
// рисуя поверх.
async function fetchSummary() {
  const sumRes = await fetch('/api/analytics/summary');
  if (sumRes.status === 401) {
    errorBox.textContent = 'Нужен доступ администратора (введите пароль от админки). Обновите страницу после входа.';
    errorBox.hidden = false;
    loading.hidden = true;
    return false;
  }
  summary = await sumRes.json();
  if (!sumRes.ok) throw new Error(summary.message || 'Ошибка загрузки статистики');
  return true;
}

// Раз в 5 минут, пока страница открыта, тихо обновляет summary + месячные
// вью — та же причина, что и у fetchSummary() выше: страница может
// оставаться открытой вкладкой неделями, и без этого «недавние посещения»
// не были на самом деле недавними. Фейл — просто в консоль, не поверх
// текущего экрана: разовый сетевой сбой в фоне не должен перекрывать уже
// показанные (пусть и на минуту устаревшие) данные сообщением об ошибке.
const AUTO_REFRESH_MS = 5 * 60 * 1000;
let autoRefreshTimer = null;
function startAutoRefresh() {
  if (autoRefreshTimer) return;
  autoRefreshTimer = setInterval(async () => {
    try {
      if (!(await fetchSummary())) return;
      await fetchRecent();
      await renderAll();
    } catch (err) {
      console.error('[stat] auto-refresh failed:', err.message);
    }
  }, AUTO_REFRESH_MS);
}

async function load() {
  try {
    viewMonth = currentMoscowMonth();
    if (!(await fetchSummary())) return;
    await fetchRecent();
    await renderAll();
    startAutoRefresh();
  } catch (err) {
    loading.hidden = true;
    errorBox.textContent = 'Не удалось загрузить статистику: ' + err.message;
    errorBox.hidden = false;
  }
}

// Перезагружает месячные вью (проекты + команда) для viewMonth и рисует
// страницу. Сводка «за 30 дней» кэшируется в summary и не дёргается при
// листании месяцев.
async function renderAll() {
  try {
    const [projRes, teamRes] = await Promise.all([
      fetch('/api/analytics/projects' + monthQuery()),
      fetch('/api/analytics/team' + monthQuery()),
    ]);
    // Матрица «выполнение задач» не зависит от месяца (скользящее окно 14
    // дней), поэтому тянется один раз — параллельно с месячными вью.
    const tasksRes = await fetch('/api/analytics/team-tasks');
    if (projRes.status === 401 || teamRes.status === 401) {
      errorBox.textContent = 'Нужен доступ администратора (введите пароль от админки). Обновите страницу после входа.';
      errorBox.hidden = false;
      return;
    }
    const proj = await projRes.json();
    const team = await teamRes.json();
    const tasks = await tasksRes.json();
    if (!projRes.ok) throw new Error(proj.message || 'Ошибка загрузки статистики');
    if (!teamRes.ok) throw new Error(team.message || 'Ошибка загрузки статистики');
    if (!tasksRes.ok) throw new Error(tasks.message || 'Ошибка загрузки статистики');
    loading.hidden = true;
    errorBox.hidden = true;
    render(summary, proj, team, tasks);
  } catch (err) {
    loading.hidden = true;
    errorBox.textContent = 'Не удалось загрузить статистику: ' + err.message;
    errorBox.hidden = false;
  }
}

load();