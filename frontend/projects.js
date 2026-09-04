// Internal staff page — lists every client project on the shared board with
// its rotatable client cabinet link (see backend/src/projectSettings.js), a
// link to open the project directly in Mattermost, a "regenerate" button for
// when a link may have leaked, and a "Редактировать" popup for the client's
// logo URL, per-network publishing credentials, and the planning/profile
// fields (report start date, project manager, posts per month, MSK publish
// time, "оплачено до" — the contract/payment end date that hard-stops
// autoposting once passed, see isPaidThroughExpired in backend/src/index.js —
// strategy/planning/post/image prompts) — also in projectSettings.js,
// Postgres-backed, meant to be read directly by the future publishing
// automation. No build step, same approach as app.js.
//
// Deliberately does NOT take a board id from this page's own URL (unlike
// app.js's /p/{boardId} handling) — the backend already knows the one board
// it operates on (config.mattermostBoardId) and this page's path itself is
// configurable (config.staffProjectsPath) specifically so nothing
// identifying has to sit in a URL someone might screenshot/bookmark/share.

// Russian plural: plural(1,'проект','проекта','проектов') → "проект" etc.
function plural(n, one, few, many) {
  const n10 = n % 10;
  const n100 = n % 100;
  if (n10 === 1 && n100 !== 11) return one;
  if (n10 >= 2 && n10 <= 4 && (n100 < 10 || n100 >= 20)) return few;
  return many;
}

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (s) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[s]));
}

function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 2200);
}

function clientLinkFor(token) {
  return `${location.origin}/l/${encodeURIComponent(token)}`;
}

// Robust clipboard write: the Clipboard API needs a secure context (https)
// and can be missing/blocked in some embedded browsers — fall back to the
// old hidden-textarea + execCommand trick so the button still works there
// instead of silently doing nothing (this is what "не работает кнопка
// копировать" turned out to be).
async function copyToClipboard(text) {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch (err) {
      // fall through to the legacy method below
    }
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.top = '0';
  ta.style.left = '-9999px';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch (err) {
    ok = false;
  }
  document.body.removeChild(ta);
  if (!ok) throw new Error('copy command failed');
}

let options = [];
let busyProjectId = null;

// SMM/ИИ tabs above the list (added once AI projects stopped being rare
// exceptions — see the old TODO this replaces). Ground truth for "which tab"
// is the same o.aiStatus the avatar/highlight already use ('none' → SMM,
// 'partial'/'ai' → ИИ) — a project only shows up in "ИИ проекты" once staff
// actually ticks the "Это ИИ-проект" checkbox in the edit popup, same flag
// as everywhere else in this file. Persisted per-browser so switching pages
// or reloading doesn't dump you back on "SMM" every time.
let activeTab = localStorage.getItem('kf-proj-tab') === 'ai' ? 'ai' : 'smm';

function tabOf(o) {
  return o.aiStatus === 'none' ? 'smm' : 'ai';
}

// Beads-on-a-thread strip at the bottom of each project card (see
// postsForMonth in backend/src/index.js): one bead per post planned this
// month, colored by the same status notation the client cabinet uses. A
// hover tooltip shows the date + post title; too many posts collapse into a
// "+N" bead so the strip never overflows.
const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
function formatBeadTip(p) {
  const m = (p.publishDate || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  const date = m ? `${+m[3]} ${MONTHS_SHORT[+m[2] - 1]}` : (p.publishDate || '—');
  return `${date} · ${p.title}`;
}
// Known client-status posts get the cabinet's color; anything still in an
// internal production stage gets the graphite outline + light-gray fill (the
// staff page sees those posts, the client cabinet doesn't).
const BEAD_CLASS = { published: 'published', approved: 'approved', waiting: 'waiting', changes: 'changes' };
function beadClass(p) {
  return BEAD_CLASS[p.status] || 'internal';
}
// Each bead is a link into THIS project's client cabinet, deep-linked to the
// post (?task=<cardId> — the cabinet scrolls to it, see focusTask in app.js).
// Every planned post gets its own bead — the strip is allowed to wrap onto a
// second line rather than collapsing extras into a "+N" placeholder.
function beadsHtml(o) {
  const posts = o.posts || [];
  if (!posts.length) return '';
  const cabinet = clientLinkFor(o.token);
  const beads = posts
    .map((p) => `<a class="proj-bead-wrap" href="${cabinet}?task=${encodeURIComponent(p.id)}" target="_blank" rel="noopener" data-tip="${esc(formatBeadTip(p))}"><i class="proj-bead ${beadClass(p)}"></i></a>`)
    .join('');
  return `<div class="proj-posts">${beads}</div>`;
}

function updateTabCounts(base) {
  const smmCount = base.filter((o) => tabOf(o) === 'smm').length;
  const aiCount = base.filter((o) => tabOf(o) === 'ai').length;
  document.getElementById('tabCountSmm').textContent = String(smmCount);
  document.getElementById('tabCountAi').textContent = String(aiCount);
  document.querySelectorAll('.proj-tab').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === activeTab);
  });
}

function render(filterText) {
  const needle = (filterText || '').trim().toLowerCase();
  const showArchived = document.getElementById('showArchived').checked;
  // Архивные проекты (project_settings.is_archived) скрыты по умолчанию —
  // чекбокс "Архивные проекты" (выключен по умолчанию) их показывает вместе
  // с активными, а не вместо них. Поиск при этом продолжает работать по
  // всему видимому набору как обычно.
  const base = showArchived ? options : options.filter((o) => !o.isArchived);
  updateTabCounts(base);
  const inTab = base.filter((o) => tabOf(o) === activeTab);
  const visible = needle ? inTab.filter((o) => o.label.toLowerCase().includes(needle)) : inTab;
  document.getElementById('list').innerHTML =
    visible
      .map((o) => {
        const link = clientLinkFor(o.token);
        // Тот же кабинет, но с флагом ?calendar=1 — app.js при загрузке видит
        // любой query-ключ, начинающийся на "calend" (см. wantsCalendarView),
        // и сразу открывает вид календаря вместо списка. Отдельная ссылка —
        // чтобы отправлять клиенту не обычное приглашение, а сразу "вот твой
        // контент-план на месяц".
        const calLink = `${link}?calendar=1`;
        const busy = busyProjectId === o.id;
        const initial = (o.label || '?').trim().charAt(0).toUpperCase();
        const logo = o.logoUrl
          ? `<img src="${esc(o.logoUrl)}" alt="">`
          : `<span class="proj-logo-fallback">${esc(initial)}</span>`;
        // Архивная подсветка перекрывает ИИ-подсветку — проект на паузе не
        // должен выглядеть "активным ИИ-проектом", даже если флаг ИИ тоже стоит.
        const aiClass = o.aiStatus === 'ai' ? ' ai' : o.aiStatus === 'partial' ? ' attention' : '';
        const archivedClass = o.isArchived ? ' archived' : '';
        const avatar = !o.isArchived && (o.aiStatus === 'ai' || o.aiStatus === 'partial')
          ? `<span class="proj-ai-avatar-wrap" data-tip="${o.aiStatus === 'ai' ? 'ИИ-проект — промты заполнены полностью' : 'Заполнены не все промты ИИ — требуется внимание'}"><img class="proj-ai-avatar" src="/ai-avatar.png" alt="ИИ"></span>`
          : '';
        const archivedBadge = o.isArchived ? '<span class="archived-badge" data-tip="Проект на паузе — снят с активного обслуживания">АРХИВНЫЙ</span>' : '';
        const kpi = o.scheduleStatus;
        const kpiTip = kpi
          ? kpi.tier === 'ontrack'
            ? `В графике — ${kpi.planned}/${kpi.target} постов за месяц, просрочек нет`
            : kpi.tier === 'minor'
            ? `Небольшое отклонение — ${kpi.planned}/${kpi.target} постов за месяц${kpi.late ? `, просрочено: ${kpi.late}` : ''}`
            : `Не укладываемся в KPI — ${kpi.planned}/${kpi.target} постов за месяц${kpi.late ? `, просрочено: ${kpi.late}` : ''}`
          : '';
        const kpiDot = kpi && !o.isArchived ? `<span class="proj-kpi-dot ${kpi.tier}" data-tip="${esc(kpiTip)}"></span>` : '';
        // Красный "!" — оплата заканчивается меньше чем через 5 дней (или уже
        // просрочена). Архивные проекты глушим, как и остальные значки —
        // проект на паузе не публикует, следить за оплатой там незачем.
        const paidStatus = !o.isArchived ? paidThroughStatus(o.paidThroughDate) : { tier: 'none', daysLeft: null };
        const paidTip =
          paidStatus.tier === 'bad'
            ? paidStatus.daysLeft < 0
              ? 'Оплата просрочена — автопостинг остановлен'
              : paidStatus.daysLeft === 0
              ? 'Оплата истекает сегодня'
              : `Оплата истекает через ${paidStatus.daysLeft} ${plural(paidStatus.daysLeft, 'день', 'дня', 'дней')}`
            : '';
        const paidWarnBadge = paidStatus.tier === 'bad' ? `<span class="paid-warn-badge" data-tip="${esc(paidTip)}">!</span>` : '';
        // Мини-значки соцсетей, для которых в проекте сохранены креды (по
        // факту куда можем постить) — цвета и подписи как в самом попапе
        // редактирования (см. .cred-networks в projects.html).
        const netMeta = {
          ig: { color: '#C13584', label: 'Instagram' },
          tg: { color: '#229ED9', label: 'Telegram' },
          vk: { color: '#0077FF', label: 'ВКонтакте' },
          ok: { color: '#EE8208', label: 'Одноклассники' },
          max: { color: '#7C3AED', label: 'MAX' },
        };
        const netChips = (o.configuredNetworks || [])
          .filter((net) => netMeta[net])
          .map((net) => `<span class="proj-net-chip" style="background:${netMeta[net].color}" data-tip="${esc(netMeta[net].label)}"></span>`)
          .join('');
        const netRow = netChips ? `<div class="proj-net-row">${netChips}</div>` : '';
        return `<div class="proj-card${aiClass}${archivedClass}" id="proj-${esc(o.id)}">
          <div class="proj-card-top">
            <div class="proj-logo">${logo}${kpiDot}</div>
            <div class="proj-info">
              <div class="proj-name-row">
                <div class="proj-name">${esc(o.label)}</div>
                ${paidWarnBadge}
                ${archivedBadge}
              </div>
              <div class="proj-row proj-link-row">
                <span class="proj-row-label">Клиенту:</span>
                <input class="proj-link" type="text" readonly value="${esc(link)}" onclick="this.select()">
              </div>
              ${netRow}
            </div>
            <div class="proj-actions-col">
              ${avatar}
              <button class="icon-btn proj-copy" type="button" data-tip="Скопировать — ссылка для клиента с приглашением" data-link="${esc(link)}" data-label="${esc(o.label)}" aria-label="Скопировать ссылку с приглашением">
                <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
              </button>
              <button class="icon-btn proj-copy-cal" type="button" data-tip="Скопировать — ссылка сразу в календарь" data-link="${esc(calLink)}" data-label="${esc(o.label)}" aria-label="Скопировать ссылку на календарь">
                <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect><path d="M3 10h18M8 2v4M16 2v4"></path></svg>
              </button>
              <button class="icon-btn proj-edit" type="button" data-tip="Редактировать — лого и креды соцсетей" data-project-id="${esc(o.id)}" data-label="${esc(o.label)}" aria-label="Редактировать">
                <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg>
              </button>
              <button class="icon-btn proj-regen${busy ? ' busy' : ''}" type="button" data-tip="Новая ссылка — старая сразу перестанет работать" data-project-id="${esc(o.id)}" data-label="${esc(o.label)}" ${busy ? 'disabled' : ''} aria-label="Сгенерировать новую ссылку">
                <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg>
              </button>
            </div>
          </div>
          ${beadsHtml(o)}
        </div>`;
      })
      .join('') ||
    `<div class="empty">${
      needle
        ? 'Ничего не найдено.'
        : activeTab === 'ai'
        ? 'Пока нет ни одного ИИ-проекта — включите «Это ИИ-проект» в настройках нужного проекта.'
        : 'Пока нет ни одного SMM-проекта.'
    }</div>`;
}

function renderKpiBanner() {
  const el = document.getElementById('kpiBanner');
  // Архивные (проекты на паузе) не должны сюда попадать — они по умолчанию
  // не видны в списке, и "горящий" баннер про проект, которого не видно,
  // только сбивает с толку.
  const active = options.filter((o) => !o.isArchived);
  const off = active.filter((o) => o.scheduleStatus && o.scheduleStatus.tier === 'off');
  const minor = active.filter((o) => o.scheduleStatus && o.scheduleStatus.tier === 'minor');
  if (!off.length && !minor.length) {
    el.hidden = true;
    return;
  }
  const namesLine = (list) => {
    const shown = list.slice(0, 3).map((o) => o.label);
    const rest = list.length - shown.length;
    return shown.join(', ') + (rest > 0 ? ` и ещё ${rest}` : '');
  };
  const rows = [];
  if (off.length) {
    rows.push(
      `<div class="attention-row1 row-off"><button type="button" class="attention-link" data-scroll="${esc(off[0].id)}">🔥 ${off.length} ${plural(off.length, 'проект не укладывается', 'проекта не укладываются', 'проектов не укладываются')} в KPI — ${esc(namesLine(off))}</button></div>`
    );
  }
  if (minor.length) {
    rows.push(
      `<div class="attention-row1 row-minor"><button type="button" class="attention-link" data-scroll="${esc(minor[0].id)}">⚠️ ${minor.length} ${plural(minor.length, 'проект с небольшим отклонением', 'проекта с небольшим отклонением', 'проектов с небольшим отклонением')} — ${esc(namesLine(minor))}</button></div>`
    );
  }
  el.className = `attention ${off.length ? 'off' : 'minor'}`;
  el.innerHTML = rows.join('');
  el.hidden = false;
}

async function load() {
  const loading = document.getElementById('loading');
  loading.hidden = false;
  try {
    const res = await fetch('/api/projects');
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || data.error || 'Ошибка загрузки');
    const KPI_TIER_RANK = { off: 0, minor: 1, ontrack: 2 };
    const kpiRank = (o) => (o.scheduleStatus ? KPI_TIER_RANK[o.scheduleStatus.tier] : 3);
    options = data.options.slice().sort((a, b) => {
      // Архивные — всегда последними (даже если включён показ архива и у
      // проекта на паузе почему-то есть KPI-тир): пауза важнее графика.
      const ar = (a.isArchived ? 1 : 0) - (b.isArchived ? 1 : 0);
      if (ar !== 0) return ar;
      const r = kpiRank(a) - kpiRank(b);
      return r !== 0 ? r : a.label.localeCompare(b.label, 'ru');
    });
    render(document.getElementById('search').value);
    renderKpiBanner();
  } catch (err) {
    document.getElementById('list').innerHTML = `<div class="error-box">Не удалось загрузить список проектов: ${esc(err.message)}</div>`;
  } finally {
    loading.hidden = true;
  }
}

async function regenerateLink(projectId, label) {
  const sure = confirm(`Сгенерировать новую ссылку для «${label}»?\n\nСтарая ссылка перестанет работать сразу же — если клиент открыл кабинет по старой ссылке и не обновит страницу, дальнейшие действия у него всё равно продолжат работать (кабинет уже загружен), но повторный переход по старой ссылке будет недоступен.`);
  if (!sure) return;
  busyProjectId = projectId;
  render(document.getElementById('search').value);
  try {
    const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/regenerate-link`, {
      method: 'POST',
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || data.error);
    const opt = options.find((o) => o.id === projectId);
    if (opt) opt.token = data.token;
    toast('Новая ссылка готова');
  } catch (err) {
    toast('Не удалось обновить ссылку: ' + err.message);
  } finally {
    busyProjectId = null;
    render(document.getElementById('search').value);
  }
}

document.getElementById('search').addEventListener('input', (e) => render(e.target.value));
document.getElementById('showArchived').addEventListener('change', () => render(document.getElementById('search').value));

document.getElementById('projTabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.proj-tab');
  if (!btn || btn.dataset.tab === activeTab) return;
  activeTab = btn.dataset.tab;
  localStorage.setItem('kf-proj-tab', activeTab);
  render(document.getElementById('search').value);
});

document.getElementById('kpiBanner').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-scroll]');
  if (!btn) return;
  const search = document.getElementById('search');
  if (search.value) { search.value = ''; render(''); }
  // Баннер про "горящие" проекты намеренно считается по ВСЕМ проектам сразу
  // (не только текущей вкладке) — иначе легко пропустить срыв KPI у клиента,
  // просто потому что смотришь сейчас в другую вкладку. При клике — сначала
  // переключаемся на вкладку нужного проекта, потом скроллим.
  const target = options.find((o) => o.id === btn.dataset.scroll);
  if (target && tabOf(target) !== activeTab) {
    activeTab = tabOf(target);
    localStorage.setItem('kf-proj-tab', activeTab);
    render('');
  }
  const el = document.getElementById(`proj-${btn.dataset.scroll}`);
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
});

document.getElementById('list').addEventListener('click', async (e) => {
  const copyCalBtn = e.target.closest('.proj-copy-cal');
  if (copyCalBtn) {
    const text = `Направляю ссылку на контент-план проекта #${copyCalBtn.dataset.label} (сразу открывается календарь):\n${copyCalBtn.dataset.link}`;
    try {
      await copyToClipboard(text);
      toast('Скопировано — можно вставлять');
    } catch (err) {
      toast('Не удалось скопировать — выделите ссылку вручную');
    }
    return;
  }
  const copyBtn = e.target.closest('.proj-copy');
  if (copyBtn) {
    const text = `Направляю актуальную ссылку по управлению публикациями проекта #${copyBtn.dataset.label}:\n${copyBtn.dataset.link}`;
    try {
      await copyToClipboard(text);
      toast('Скопировано — можно вставлять');
    } catch (err) {
      toast('Не удалось скопировать — выделите ссылку вручную');
    }
    return;
  }
  const regenBtn = e.target.closest('.proj-regen');
  if (regenBtn) {
    regenerateLink(regenBtn.dataset.projectId, regenBtn.dataset.label);
    return;
  }
  const editBtn = e.target.closest('.proj-edit');
  if (editBtn) {
    openEdit(editBtn.dataset.projectId, editBtn.dataset.label);
  }
});

// --- "Редактировать" popup: logo URL + per-network publishing credentials
// (backend/src/projectSettings.js) --------------------------------------
const NET_KEYS = ['ig', 'tg', 'vk', 'ok', 'max'];
let editingProjectId = null;
// Референсы картинок для ИИ-генерации (до 10 шт., project_settings.image_references) —
// собираются локально в этом массиве (и добавлением ссылки, и загрузкой файла
// на диск через /api/projects/:id/reference-upload), а сохраняются целиком
// вместе с остальными настройками попапа по кнопке «Сохранить» — см. saveEdit().
const MAX_IMAGE_REFERENCES = 10;
let imageReferences = [];

function credTextareas() {
  return NET_KEYS.map((k) => document.querySelector(`[data-net-field="${k}"]`));
}

// --- Telegram "куда публикует бот" picker — sits on top of the tg
// credentials textarea (data-net-field="tg"): the textarea stays the real
// field saveEdit() reads/writes (same JSON contract the automation already
// expects, see backend/src/projectSettings.js), this just writes
// {chatId, chatType, botUsername} into it from two dropdowns instead of
// asking staff to type that JSON — and to find the chatId — by hand.
// "Ввести вручную" stays as an escape hatch for anything the picker can't
// represent (a chat the bot hasn't joined yet, hand-crafted JSON, etc).
const tgPicker = document.getElementById('tgPicker');
const tgBotField = document.getElementById('tgBotField');
const tgBotSelect = document.getElementById('tgBotSelect');
const tgBotHint = document.getElementById('tgBotHint');
const tgChatSelect = document.getElementById('tgChatSelect');
const tgChatHint = document.getElementById('tgChatHint');
const tgManualToggle = document.getElementById('tgManualToggle');
let tgBots = [];
let tgChats = [];
let tgManualMode = false;

function tgTextarea() {
  return document.querySelector('[data-net-field="tg"]');
}

function chatTypeLabel(type) {
  if (type === 'channel') return 'канал';
  if (type === 'supergroup' || type === 'group') return 'группа';
  return type || 'чат';
}

async function loadTgPickerData() {
  tgBotField.hidden = true;
  tgBotHint.hidden = true;
  tgBotSelect.innerHTML = '<option value="">Загружаем…</option>';
  tgChatSelect.innerHTML = '<option value="">Загружаем…</option>';
  tgChatHint.textContent = '';
  try {
    const [botsRes, chatsRes] = await Promise.all([
      fetch('/api/projects/telegram-bots'),
      fetch('/api/projects/telegram-chats'),
    ]);
    const botsData = await botsRes.json();
    const chatsData = await chatsRes.json();
    tgBots = botsRes.ok ? (botsData.bots || []) : [];
    tgChats = chatsRes.ok ? (chatsData.chats || []) : [];
  } catch (err) {
    tgBots = [];
    tgChats = [];
  }
  renderTgBotSelect();
  renderTgChatSelect();
}

// Bot select only shows once there's actually something to choose between —
// with the (today: usual) single active bot, its @username is just shown
// as a hint instead of a one-option dropdown nobody needs to touch.
function renderTgBotSelect() {
  if (tgBots.length > 1) {
    tgBotField.hidden = false;
    tgBotSelect.innerHTML = tgBots.map((b) => `<option value="${esc(b.id)}">${esc(b.name)}</option>`).join('');
  } else {
    tgBotField.hidden = true;
  }
  updateTgBotHint();
}

function currentTgBot() {
  if (tgBots.length > 1) return tgBots.find((b) => String(b.id) === tgBotSelect.value) || null;
  return tgBots[0] || null;
}

function updateTgBotHint() {
  const bot = currentTgBot();
  if (!bot) {
    if (!tgBots.length) {
      tgBotHint.innerHTML = 'Ни одного бота не настроено — добавьте в <a href="/ceo/api-keys" target="_blank" rel="noopener">Управлении</a>.';
      tgBotHint.hidden = false;
    } else {
      tgBotHint.hidden = true;
    }
    return;
  }
  if (!bot.username) {
    tgBotHint.innerHTML = `Публикует бот «${esc(bot.name)}» — юзернейм не указан (добавьте в <a href="/ceo/api-keys" target="_blank" rel="noopener">Управлении</a>, чтобы было что скопировать и отдать клиенту).`;
    tgBotHint.hidden = false;
    return;
  }
  tgBotHint.innerHTML = `Публикует <code>@${esc(bot.username)}</code> — этого бота нужно добавить в канал клиента в Telegram. <button type="button" id="tgBotCopyBtn">Скопировать юзернейм</button>`;
  tgBotHint.hidden = false;
  const copyBtn = document.getElementById('tgBotCopyBtn');
  if (copyBtn) {
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText('@' + bot.username);
        toast('Юзернейм скопирован');
      } catch (err) {
        toast('Не удалось скопировать: ' + err.message);
      }
    });
  }
}

function renderTgChatSelect(preselectChatId) {
  if (!tgChats.length) {
    tgChatSelect.innerHTML = '<option value="">— каналов пока нет —</option>';
    tgChatHint.textContent = 'Бот пока никуда не добавлен. Добавьте его в канал/группу клиента в Telegram, затем откройте этот попап заново — список обновится.';
    return;
  }
  const options = ['<option value="">— выберите —</option>'].concat(
    tgChats.map((c) => `<option value="${esc(c.chatId)}">${esc(c.title || c.chatId)} (${esc(chatTypeLabel(c.chatType))})</option>`)
  );
  tgChatSelect.innerHTML = options.join('');
  tgChatHint.textContent = 'Не видите нужный канал? Добавьте бота в него в Telegram и откройте это окно заново.';
  if (preselectChatId && tgChats.some((c) => c.chatId === preselectChatId)) {
    tgChatSelect.value = preselectChatId;
  }
}

function syncTgTextareaFromPicker() {
  const chatId = tgChatSelect.value;
  if (!chatId) { tgTextarea().value = ''; return; }
  const chat = tgChats.find((c) => c.chatId === chatId);
  const bot = currentTgBot();
  const payload = { chatId };
  if (chat) payload.chatType = chat.chatType;
  if (bot && bot.username) payload.botUsername = bot.username;
  tgTextarea().value = JSON.stringify(payload, null, 2);
}

function setTgManualMode(on) {
  tgManualMode = on;
  tgPicker.hidden = on;
  tgTextarea().hidden = !on;
  tgManualToggle.textContent = on ? 'Вернуться к выбору из списка' : 'Ввести вручную (JSON)';
}

// Called once picker data (tgBots/tgChats) and the tg textarea's real,
// saved value are both loaded — tries to preselect the picker to match
// what's already there; falls back to manual mode for anything the picker
// can't represent (old-format JSON with a botToken, an unrecognized/stale
// chatId, hand-crafted extra keys) rather than silently showing an empty
// picker over real saved data.
function applyTgTextareaToPicker() {
  const raw = tgTextarea().value.trim();
  if (!raw) {
    renderTgChatSelect();
    setTgManualMode(false);
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    setTgManualMode(true);
    return;
  }
  const chatId = parsed && parsed.chatId != null ? String(parsed.chatId) : '';
  const knownKeys = ['chatId', 'chatType', 'botUsername'];
  const hasExtraKeys = !parsed || typeof parsed !== 'object' || Object.keys(parsed).some((k) => !knownKeys.includes(k));
  if (!chatId || hasExtraKeys || !tgChats.some((c) => c.chatId === chatId)) {
    setTgManualMode(true);
    return;
  }
  renderTgChatSelect(chatId);
  if (parsed.botUsername && tgBots.length > 1) {
    const match = tgBots.find((b) => b.username === parsed.botUsername);
    if (match) { tgBotSelect.value = String(match.id); updateTgBotHint(); }
  }
  setTgManualMode(false);
}

tgBotSelect.addEventListener('change', () => { updateTgBotHint(); syncTgTextareaFromPicker(); });
tgChatSelect.addEventListener('change', syncTgTextareaFromPicker);
tgManualToggle.addEventListener('click', () => {
  if (tgManualMode) applyTgTextareaToPicker(); // re-derive picker state from whatever was hand-typed
  else setTgManualMode(true);
});

// --- Instagram "accessToken/igUserId + Проверить" picker — same idea as the
// Telegram picker above, sitting on top of the ig credentials textarea
// (data-net-field="ig"), but structurally simpler: Instagram's Graph API has
// no "list every account this token could publish to" endpoint the way
// Telegram's Bot API does (a token is normally hand-obtained via Meta
// OAuth), so there's nothing to populate a dropdown FROM — instead this is
// two plain fields plus a live "Проверить" button that calls Instagram's own
// API server-side (POST /api/projects/:id/validate-instagram, backend/src/
// index.js) to confirm the pair actually works, BEFORE staff ever clicks
// "Сохранить". Added 2026-09-03 at Дмитрий's request ("сразу надо дать
// возможность ВАЛИДИРОВАТЬ! Что все работает!").
//
// Preserves any OTHER keys already in the textarea (expiresAt/
// lastRefreshedAt — written server-side by the automation's token-refresh
// endpoint, see projectSettings.upsertNetworkCredentials) rather than
// clobbering them — syncIgTextareaFromPicker merges into whatever JSON was
// already there, same shallow-merge spirit the backend itself uses.
const igPicker = document.getElementById('igPicker');
const igValidateBtn = document.getElementById('igValidateBtn');
const igValidateHint = document.getElementById('igValidateHint');
const igMetaHint = document.getElementById('igMetaHint');
const igMetaHintText = document.getElementById('igMetaHintText');
const igRefreshBtn = document.getElementById('igRefreshBtn');
const igRefreshHint = document.getElementById('igRefreshHint');
const igManualToggle = document.getElementById('igManualToggle');
const IG_KNOWN_KEYS = ['accessToken', 'igUserId', 'expiresAt', 'lastRefreshedAt'];
let igManualMode = false;

function igTextarea() {
  return document.querySelector('[data-net-field="ig"]');
}

// Shows the expiry/last-refreshed line PLUS the "Освежить" button next to it
// (see igRefreshBtn below) — visible whenever there's a saved accessToken to
// refresh, not only once it already has an expiresAt: a token that's never
// been through an exchange yet has no known expiry, but "Освежить" is
// exactly how it gets one for the first time (same fb_exchange_token call
// either way, see refreshInstagramAccessToken in backend/src/index.js).
function updateIgMetaHint(parsed) {
  const hasToken = !!(parsed && parsed.accessToken);
  if (!hasToken) {
    igMetaHint.hidden = true;
    igMetaHint.className = 'ig-meta-hint';
    igRefreshHint.textContent = '';
    igRefreshHint.className = 'ig-refresh-hint';
    return;
  }
  const parts = [];
  let danger = false;
  if (parsed.expiresAt) {
    const ms = Date.parse(parsed.expiresAt);
    const expired = !Number.isNaN(ms) && ms < Date.now();
    parts.push(`${expired ? '⛔ истёк' : 'действует до'} ${esc(parsed.expiresAt)}`);
    danger = expired;
  } else {
    parts.push('дата истечения неизвестна');
  }
  if (parsed.lastRefreshedAt) parts.push(`обновлён ${esc(parsed.lastRefreshedAt)}`);
  igMetaHint.className = danger ? 'ig-meta-hint bad' : 'ig-meta-hint';
  igMetaHintText.textContent = parts.join(' · ');
  igMetaHint.hidden = false;
}

function syncIgTextareaFromPicker() {
  const accessToken = document.getElementById('editIgAccessToken').value.trim();
  const igUserId = document.getElementById('editIgUserId').value.trim();
  let existing = {};
  try {
    const parsed = JSON.parse(igTextarea().value.trim() || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) existing = parsed;
  } catch (err) {
    existing = {};
  }
  const payload = { ...existing };
  if (accessToken) payload.accessToken = accessToken; else delete payload.accessToken;
  if (igUserId) payload.igUserId = igUserId; else delete payload.igUserId;
  igTextarea().value = Object.keys(payload).length ? JSON.stringify(payload, null, 2) : '';
}

function setIgManualMode(on) {
  igManualMode = on;
  igPicker.hidden = on;
  igTextarea().hidden = !on;
  igManualToggle.textContent = on ? 'Вернуться к выбору' : 'Ввести вручную (JSON)';
}

// Called once the ig textarea's real, saved value is loaded — tries to
// preselect the picker's two fields from it; falls back to manual mode for
// anything the picker can't represent (unparsable JSON, or keys outside the
// known accessToken/igUserId/expiresAt/lastRefreshedAt set) rather than
// silently hiding real saved data.
function applyIgTextareaToPicker() {
  const raw = igTextarea().value.trim();
  clearTimeout(igValidateHintTimer);
  igValidateHint.textContent = '';
  igValidateHint.className = 'ig-validate-hint';
  if (!raw) {
    document.getElementById('editIgAccessToken').value = '';
    document.getElementById('editIgUserId').value = '';
    updateIgMetaHint(null);
    setIgManualMode(false);
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    setIgManualMode(true);
    return;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).some((k) => !IG_KNOWN_KEYS.includes(k))) {
    setIgManualMode(true);
    return;
  }
  document.getElementById('editIgAccessToken').value = parsed.accessToken || '';
  document.getElementById('editIgUserId').value = parsed.igUserId || '';
  updateIgMetaHint(parsed);
  setIgManualMode(false);
}

document.getElementById('editIgAccessToken').addEventListener('input', syncIgTextareaFromPicker);
document.getElementById('editIgUserId').addEventListener('input', syncIgTextareaFromPicker);
igManualToggle.addEventListener('click', () => {
  if (igManualMode) applyIgTextareaToPicker(); // re-derive picker state from whatever was hand-typed
  else setIgManualMode(true);
});
// Reads {accessToken, igUserId} from whichever editor is currently active —
// the guided two fields, or (when igManualMode is on) the raw JSON textarea
// — so "Проверить" works no matter which mode staff is looking at (see the
// button's new placement in the always-visible header row, projects.html).
function currentIgCredentials() {
  if (!igManualMode) {
    return {
      accessToken: document.getElementById('editIgAccessToken').value.trim(),
      igUserId: document.getElementById('editIgUserId').value.trim(),
    };
  }
  try {
    const parsed = JSON.parse(igTextarea().value.trim() || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return {
        accessToken: String(parsed.accessToken || '').trim(),
        igUserId: String(parsed.igUserId || '').trim(),
      };
    }
  } catch (err) {
    // fall through — treated the same as "both empty" below, gives a clear
    // "заполните оба поля" message rather than a raw JSON.parse error.
  }
  return { accessToken: '', igUserId: '' };
}

// Auto-clears the ✅/❌ result ~30s after it's shown (Дмитрий's request,
// 2026-09-03) — a stale check result shouldn't linger once staff has moved
// on to something else in the popup. Timer is reset on every click so
// rapid re-checks don't clear each other's result early.
let igValidateHintTimer = null;
function setIgValidateHint(text, cls) {
  clearTimeout(igValidateHintTimer);
  igValidateHint.textContent = text;
  igValidateHint.className = cls ? `ig-validate-hint ${cls}` : 'ig-validate-hint';
  if (text) {
    igValidateHintTimer = setTimeout(() => {
      igValidateHint.textContent = '';
      igValidateHint.className = 'ig-validate-hint';
    }, 30000);
  }
}

igValidateBtn.addEventListener('click', async () => {
  const { accessToken, igUserId } = currentIgCredentials();
  if (!accessToken || !igUserId) {
    setIgValidateHint(
      igManualMode ? 'В JSON нужны оба поля: accessToken и igUserId.' : 'Укажите Access Token и IG User ID.',
      'bad'
    );
    return;
  }
  setIgValidateHint('Проверяем…');
  igValidateBtn.disabled = true;
  try {
    const res = await fetch(`/api/projects/${encodeURIComponent(editingProjectId)}/validate-instagram`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accessToken, igUserId }),
    });
    const data = await res.json();
    if (data.ok) {
      setIgValidateHint(`✅ Токен рабочий — @${data.username || '?'}${data.accountType ? ' (' + data.accountType + ')' : ''}`, 'good');
    } else {
      setIgValidateHint(`❌ ${data.message || 'не удалось проверить'}`, 'bad');
    }
  } catch (err) {
    setIgValidateHint(`❌ Не удалось проверить: ${err.message}`, 'bad');
  } finally {
    igValidateBtn.disabled = false;
  }
});

// "Освежить" — trades the ALREADY-SAVED IG access token for a fresh one via
// the backend's fb_exchange_token call (POST /api/projects/:id/refresh-
// instagram-token), added 2026-09-03 at Дмитрий's request. Operates on
// what's saved in Postgres, not on unsaved edits in the two fields above —
// same reasoning the backend route documents. The backend persists the new
// token immediately (no separate "Сохранить" needed), so this just updates
// the popup's own fields/hint from the response to match.
igRefreshBtn.addEventListener('click', async () => {
  igRefreshHint.className = 'ig-refresh-hint';
  igRefreshHint.textContent = 'Обновляем токен…';
  igRefreshBtn.disabled = true;
  try {
    const res = await fetch(`/api/projects/${encodeURIComponent(editingProjectId)}/refresh-instagram-token`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || 'Не удалось обновить токен');
    const creds = data.credentials || {};
    document.getElementById('editIgAccessToken').value = creds.accessToken || '';
    if (creds.igUserId) document.getElementById('editIgUserId').value = creds.igUserId;
    igTextarea().value = Object.keys(creds).length ? JSON.stringify(creds, null, 2) : '';
    setIgManualMode(false);
    updateIgMetaHint(creds);
    igRefreshHint.className = 'ig-refresh-hint good';
    igRefreshHint.textContent = '✅ Токен обновлён и сохранён.';
    toast('IG-токен обновлён');
  } catch (err) {
    igRefreshHint.className = 'ig-refresh-hint bad';
    igRefreshHint.textContent = `❌ ${err.message}`;
  } finally {
    igRefreshBtn.disabled = false;
  }
});

// --- "Оплачено до" — staff-set contract/payment end date (project_settings.
// paid_through_date). After this date POST /api/automation/tasks/{taskId}/
// publish starts refusing to publish for this project's cards (see
// backend/src/index.js's isPaidThroughExpired/publishAutomationTask) — this
// hint is the "предупреждение в интерфейсе" half of that, so staff sees it
// coming before an automation run actually gets rejected. Added 2026-09-03.
//
// paidThroughStatus() is shared between this popup hint and the project-list
// red-badge (see render()) so the two thresholds can never drift apart.
// Tiers: 'bad' = less than PAID_THROUGH_DANGER_DAYS left (this INCLUDES
// already-expired — user asked for "меньше 5 дней" as one merged red state,
// not a separate super-red state for expired), 'warn' = a softer heads-up
// band between DANGER and HEADSUP days (my own addition, not explicitly
// requested, consistent with the pre-existing amber-tier pattern elsewhere),
// 'good' = plenty of runway, 'none' = no date set, 'invalid' = unparsable.
const PAID_THROUGH_DANGER_DAYS = 5;
const PAID_THROUGH_HEADSUP_DAYS = 14;
function paidThroughStatus(dateStr) {
  if (!dateStr) return { tier: 'none', daysLeft: null };
  const dueMs = Date.parse(`${dateStr}T23:59:59+03:00`);
  if (Number.isNaN(dueMs)) return { tier: 'invalid', daysLeft: null };
  const daysLeft = Math.ceil((dueMs - Date.now()) / (24 * 60 * 60 * 1000));
  let tier;
  if (daysLeft < PAID_THROUGH_DANGER_DAYS) tier = 'bad';
  else if (daysLeft <= PAID_THROUGH_HEADSUP_DAYS) tier = 'warn';
  else tier = 'good';
  return { tier, daysLeft };
}

function updatePaidThroughHint() {
  const hint = document.getElementById('paidThroughHint');
  const input = document.getElementById('editPaidThroughDate');
  const value = input.value;
  if (!value) {
    hint.hidden = true;
    input.classList.remove('field-input-danger');
    return;
  }
  const status = paidThroughStatus(value);
  hint.hidden = false;
  input.classList.toggle('field-input-danger', status.tier === 'bad');
  if (status.tier === 'invalid') {
    hint.className = 'paid-through-hint';
    hint.textContent = 'Некорректная дата.';
  } else if (status.tier === 'bad') {
    hint.className = 'paid-through-hint bad';
    hint.textContent =
      status.daysLeft < 0
        ? 'Просрочено — автопостинг остановлен.'
        : status.daysLeft === 0
        ? 'Истекает сегодня.'
        : `Истекает через ${status.daysLeft} ${plural(status.daysLeft, 'день', 'дня', 'дней')}.`;
  } else if (status.tier === 'warn') {
    hint.className = 'paid-through-hint warn';
    hint.textContent = `Истекает через ${status.daysLeft} ${plural(status.daysLeft, 'день', 'дня', 'дней')}.`;
  } else {
    hint.className = 'paid-through-hint good';
    hint.textContent = 'Оплачено, автопостинг активен.';
  }
}
document.getElementById('editPaidThroughDate').addEventListener('input', updatePaidThroughHint);

function renderRefGallery() {
  const gallery = document.getElementById('refGallery');
  const addRow = document.querySelector('.ref-add-row');
  if (!imageReferences.length) {
    gallery.hidden = true;
    gallery.innerHTML = '';
  } else {
    gallery.hidden = false;
    gallery.innerHTML = imageReferences
      .map((url, i) => `<div class="ref-thumb">
        <img src="${esc(url)}" alt="" loading="lazy">
        <button type="button" class="ref-thumb-remove" data-idx="${i}" title="Убрать" aria-label="Убрать">×</button>
      </div>`)
      .join('');
    gallery.querySelectorAll('.ref-thumb-remove').forEach((btn) => {
      btn.addEventListener('click', () => {
        imageReferences.splice(Number(btn.dataset.idx), 1);
        renderRefGallery();
      });
    });
  }
  const atLimit = imageReferences.length >= MAX_IMAGE_REFERENCES;
  addRow.hidden = atLimit;
}

function addImageReference(url) {
  const clean = String(url || '').trim();
  if (!clean) return false;
  if (imageReferences.length >= MAX_IMAGE_REFERENCES) {
    toast(`Референсов не может быть больше ${MAX_IMAGE_REFERENCES}`);
    return false;
  }
  imageReferences.push(clean);
  renderRefGallery();
  return true;
}

function updateLogoPreview() {
  const url = document.getElementById('editLogoUrl').value.trim();
  const wrap = document.getElementById('editLogoPreview');
  const img = document.getElementById('editLogoPreviewImg');
  if (!url) {
    wrap.hidden = true;
    return;
  }
  img.src = url;
  wrap.hidden = false;
}

async function openEdit(projectId, label) {
  editingProjectId = projectId;
  document.getElementById('editProjectName').textContent = label;
  document.getElementById('editMmid').dataset.mmid = projectId;
  document.getElementById('editMmidValue').textContent = projectId;
  document.getElementById('editError').hidden = true;
  document.getElementById('editLogoUrl').value = '';
  document.getElementById('editLogoPreview').hidden = true;
  document.getElementById('editIsAiProject').checked = false;
  document.getElementById('editIsArchived').checked = false;
  credTextareas().forEach((ta) => { ta.value = ''; });
  setTgManualMode(false);
  document.getElementById('editIgAccessToken').value = '';
  document.getElementById('editIgUserId').value = '';
  updateIgMetaHint(null);
  clearTimeout(igValidateHintTimer);
  igValidateHint.textContent = '';
  igValidateHint.className = 'ig-validate-hint';
  setIgManualMode(false);
  document.getElementById('editStartDate').value = '';
  document.getElementById('editProjectManager').value = '';
  document.getElementById('editPostsPerMonth').value = '';
  document.getElementById('editPublishTimeMsk').value = '';
  document.getElementById('editPaidThroughDate').value = '';
  document.getElementById('paidThroughHint').hidden = true;
  document.getElementById('editStrategyPrompt').value = '';
  document.getElementById('editPlanningPrompt').value = '';
  document.getElementById('editPostPrompt').value = '';
  document.getElementById('editImagePrompt').value = '';
  imageReferences = [];
  document.getElementById('refUrlInput').value = '';
  document.getElementById('refError').hidden = true;
  renderRefGallery();
  switchEditTab('settings');
  document.getElementById('editModal').classList.add('show');

  try {
    const [res] = await Promise.all([
      fetch(`/api/projects/${encodeURIComponent(projectId)}/settings`),
      loadTgPickerData(),
    ]);
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || data.error);
    document.getElementById('editLogoUrl').value = data.logoUrl || '';
    updateLogoPreview();
    document.getElementById('editIsAiProject').checked = !!data.isAiProject;
    document.getElementById('editIsArchived').checked = !!data.isArchived;
    document.getElementById('editStartDate').value = data.startDate || '';
    document.getElementById('editProjectManager').value = data.projectManager || '';
    document.getElementById('editPostsPerMonth').value = data.postsPerMonth || '';
    document.getElementById('editPublishTimeMsk').value = data.publishTimeMsk || '';
    document.getElementById('editPaidThroughDate').value = data.paidThroughDate || '';
    updatePaidThroughHint();
    document.getElementById('editStrategyPrompt').value = data.strategyPrompt || '';
    document.getElementById('editPlanningPrompt').value = data.planningPrompt || '';
    document.getElementById('editPostPrompt').value = data.postPrompt || '';
    document.getElementById('editImagePrompt').value = data.imagePrompt || '';
    imageReferences = Array.isArray(data.imageReferences) ? data.imageReferences.slice(0, MAX_IMAGE_REFERENCES) : [];
    renderRefGallery();
    const creds = data.socialCredentials || {};
    credTextareas().forEach((ta) => {
      const net = ta.dataset.netField;
      const value = creds[net];
      ta.value = value && Object.keys(value).length ? JSON.stringify(value, null, 2) : '';
    });
    applyTgTextareaToPicker();
    applyIgTextareaToPicker();
  } catch (err) {
    toast('Не удалось загрузить настройки: ' + err.message);
  }
}

function switchEditTab(name) {
  document.querySelectorAll('.edit-tab').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === name);
  });
  document.getElementById('editTabSettings').hidden = name !== 'settings';
  document.getElementById('editTabAi').hidden = name !== 'ai';
}

function closeEdit() {
  document.getElementById('editModal').classList.remove('show');
  editingProjectId = null;
}

async function saveEdit() {
  const errBox = document.getElementById('editError');
  errBox.hidden = true;

  // Parse every credentials textarea client-side first — an empty box means
  // "no creds set for this network yet" (omitted entirely, not stored as
  // {}); anything non-empty must be valid JSON or we stop before saving
  // anything, with a clear pointer to which network's box is broken.
  const socialCredentials = {};
  for (const ta of credTextareas()) {
    const net = ta.dataset.netField;
    const raw = ta.value.trim();
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('должен быть JSON-объектом, например {"key": "value"}');
      socialCredentials[net] = parsed;
    } catch (err) {
      errBox.textContent = `Поле "${net.toUpperCase()}": ${err.message}`;
      errBox.hidden = false;
      return;
    }
  }

  const logoUrl = document.getElementById('editLogoUrl').value.trim();
  try {
    const res = await fetch(`/api/projects/${encodeURIComponent(editingProjectId)}/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        logoUrl,
        socialCredentials,
        isAiProject: document.getElementById('editIsAiProject').checked,
        isArchived: document.getElementById('editIsArchived').checked,
        startDate: document.getElementById('editStartDate').value,
        projectManager: document.getElementById('editProjectManager').value.trim(),
        postsPerMonth: document.getElementById('editPostsPerMonth').value.trim(),
        publishTimeMsk: document.getElementById('editPublishTimeMsk').value,
        paidThroughDate: document.getElementById('editPaidThroughDate').value,
        strategyPrompt: document.getElementById('editStrategyPrompt').value,
        planningPrompt: document.getElementById('editPlanningPrompt').value,
        postPrompt: document.getElementById('editPostPrompt').value,
        imagePrompt: document.getElementById('editImagePrompt').value,
        imageReferences,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || data.error);
    toast('Настройки сохранены');
    closeEdit();
    // Full reload rather than a local patch: postsPerMonth just changed,
    // and its KPI traffic-light (scheduleStatus) is computed server-side
    // from live Mattermost task data — a local patch can't recompute that,
    // and it also drives sort order, so re-fetching keeps both correct.
    load();
  } catch (err) {
    errBox.textContent = 'Не удалось сохранить: ' + err.message;
    errBox.hidden = false;
  }
}

document.getElementById('editMmid').addEventListener('click', async () => {
  try {
    await copyToClipboard(editingProjectId);
    toast('MM ID скопирован');
  } catch (err) {
    toast('Не удалось скопировать — выделите ID вручную');
  }
});
document.getElementById('editLogoUrl').addEventListener('input', updateLogoPreview);

document.getElementById('refUrlAddBtn').addEventListener('click', () => {
  const input = document.getElementById('refUrlInput');
  if (addImageReference(input.value)) input.value = '';
});
document.getElementById('refUrlInput').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  document.getElementById('refUrlAddBtn').click();
});
document.getElementById('refFileInput').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = ''; // так же файл можно будет выбрать повторно
  if (!file) return;
  const refError = document.getElementById('refError');
  refError.hidden = true;
  if (imageReferences.length >= MAX_IMAGE_REFERENCES) {
    toast(`Референсов не может быть больше ${MAX_IMAGE_REFERENCES}`);
    return;
  }
  const uploadBtn = document.getElementById('refUploadBtn');
  uploadBtn.classList.add('uploading');
  try {
    const formData = new FormData();
    formData.append('file', file);
    const res = await fetch(`/api/projects/${encodeURIComponent(editingProjectId)}/reference-upload`, {
      method: 'POST',
      body: formData,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || data.error);
    addImageReference(data.shareUrl);
  } catch (err) {
    refError.textContent = 'Не удалось загрузить файл: ' + err.message;
    refError.hidden = false;
  } finally {
    uploadBtn.classList.remove('uploading');
  }
});
document.querySelector('[data-action="close-edit"]').addEventListener('click', closeEdit);
document.querySelector('[data-action="save-edit"]').addEventListener('click', saveEdit);
document.querySelectorAll('.edit-tab').forEach((b) => {
  b.addEventListener('click', () => switchEditTab(b.dataset.tab));
});

// Показывает CEO-иконки в шапке (ceoLink/botLink) только когда браузер уже
// залогинен в /team ПОД CEO-аккаунтом (config.ceoEmails) — не любым
// staffAuth-доступом к этой же странице (тот проверяется отдельным общим
// паролем и не завязан на личность, см. currentAccess() в index.js). Тихо
// молчит и оставляет иконки скрытыми, если такой сессии в этом браузере нет
// (обычная ситуация — /projects открывают по общему паролю, без /team).
async function revealCeoLinksIfOwner() {
  try {
    const res = await fetch('/api/team/me');
    if (!res.ok) return;
    const data = await res.json();
    if (data && data.access && data.access.ceo) {
      document.getElementById('ceoLink').hidden = false;
      document.getElementById('botLink').hidden = false;
    }
  } catch (err) {
    // молча — эта проверка сугубо косметическая
  }
}
revealCeoLinksIfOwner();

load();
