// Internal staff page — lists every client project on the shared board with
// its rotatable client cabinet link (see backend/src/projectSettings.js), a
// link to open the project directly in Mattermost, a "regenerate" button for
// when a link may have leaked, and a "Редактировать" popup for the client's
// logo URL, per-network publishing credentials, and the planning/profile
// fields (report start date, project manager, posts per month, MSK publish
// time, strategy/planning/post/image prompts) — also in projectSettings.js,
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

function render(filterText) {
  // TODO (когда проектов станет >20): разделить ИИ-проекты и обычные через
  // закладки/фильтры — сейчас они вперемешку в одном списке.
  const needle = (filterText || '').trim().toLowerCase();
  const visible = needle ? options.filter((o) => o.label.toLowerCase().includes(needle)) : options;
  document.getElementById('list').innerHTML =
    visible
      .map((o) => {
        const link = clientLinkFor(o.token);
        const busy = busyProjectId === o.id;
        const initial = (o.label || '?').trim().charAt(0).toUpperCase();
        const logo = o.logoUrl
          ? `<img src="${esc(o.logoUrl)}" alt="">`
          : `<span class="proj-logo-fallback">${esc(initial)}</span>`;
        const aiClass = o.aiStatus === 'ai' ? ' ai' : o.aiStatus === 'partial' ? ' attention' : '';
        const avatar = o.aiStatus === 'ai' || o.aiStatus === 'partial'
          ? `<span class="proj-ai-avatar-wrap" data-tip="${o.aiStatus === 'ai' ? 'ИИ-проект — промты заполнены полностью' : 'Заполнены не все промты ИИ — требуется внимание'}"><img class="proj-ai-avatar" src="/ai-avatar.png" alt="ИИ"></span>`
          : '';
        const kpi = o.scheduleStatus;
        const kpiTip = kpi
          ? kpi.tier === 'ontrack'
            ? `В графике — ${kpi.planned}/${kpi.target} постов за месяц, просрочек нет`
            : kpi.tier === 'minor'
            ? `Небольшое отклонение — ${kpi.planned}/${kpi.target} постов за месяц${kpi.late ? `, просрочено: ${kpi.late}` : ''}`
            : `Не укладываемся в KPI — ${kpi.planned}/${kpi.target} постов за месяц${kpi.late ? `, просрочено: ${kpi.late}` : ''}`
          : '';
        const kpiDot = kpi ? `<span class="proj-kpi-dot ${kpi.tier}" data-tip="${esc(kpiTip)}"></span>` : '';
        return `<div class="proj-card${aiClass}" id="proj-${esc(o.id)}">
          <div class="proj-card-top">
            <div class="proj-logo">${logo}${kpiDot}</div>
            <div class="proj-info">
              <div class="proj-name">${esc(o.label)}</div>
              <div class="proj-row proj-link-row">
                <span class="proj-row-label">Клиенту:</span>
                <input class="proj-link" type="text" readonly value="${esc(link)}" onclick="this.select()">
              </div>
            </div>
            <div class="proj-actions-col">
              ${avatar}
              <button class="icon-btn proj-copy" type="button" data-tip="Скопировать — ссылка для клиента с приглашением" data-link="${esc(link)}" data-label="${esc(o.label)}" aria-label="Скопировать ссылку с приглашением">
                <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
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
      .join('') || '<div class="empty">Ничего не найдено.</div>';
}

function renderKpiBanner() {
  const el = document.getElementById('kpiBanner');
  const off = options.filter((o) => o.scheduleStatus && o.scheduleStatus.tier === 'off');
  const minor = options.filter((o) => o.scheduleStatus && o.scheduleStatus.tier === 'minor');
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

document.getElementById('kpiBanner').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-scroll]');
  if (!btn) return;
  const search = document.getElementById('search');
  if (search.value) { search.value = ''; render(''); }
  const el = document.getElementById(`proj-${btn.dataset.scroll}`);
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
});

document.getElementById('list').addEventListener('click', async (e) => {
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

function credTextareas() {
  return NET_KEYS.map((k) => document.querySelector(`[data-net-field="${k}"]`));
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
  credTextareas().forEach((ta) => { ta.value = ''; });
  document.getElementById('editStartDate').value = '';
  document.getElementById('editProjectManager').value = '';
  document.getElementById('editPostsPerMonth').value = '';
  document.getElementById('editPublishTimeMsk').value = '';
  document.getElementById('editStrategyPrompt').value = '';
  document.getElementById('editPlanningPrompt').value = '';
  document.getElementById('editPostPrompt').value = '';
  document.getElementById('editImagePrompt').value = '';
  switchEditTab('settings');
  document.getElementById('editModal').classList.add('show');

  try {
    const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/settings`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || data.error);
    document.getElementById('editLogoUrl').value = data.logoUrl || '';
    updateLogoPreview();
    document.getElementById('editIsAiProject').checked = !!data.isAiProject;
    document.getElementById('editStartDate').value = data.startDate || '';
    document.getElementById('editProjectManager').value = data.projectManager || '';
    document.getElementById('editPostsPerMonth').value = data.postsPerMonth || '';
    document.getElementById('editPublishTimeMsk').value = data.publishTimeMsk || '';
    document.getElementById('editStrategyPrompt').value = data.strategyPrompt || '';
    document.getElementById('editPlanningPrompt').value = data.planningPrompt || '';
    document.getElementById('editPostPrompt').value = data.postPrompt || '';
    document.getElementById('editImagePrompt').value = data.imagePrompt || '';
    const creds = data.socialCredentials || {};
    credTextareas().forEach((ta) => {
      const net = ta.dataset.netField;
      const value = creds[net];
      ta.value = value && Object.keys(value).length ? JSON.stringify(value, null, 2) : '';
    });
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
        startDate: document.getElementById('editStartDate').value,
        projectManager: document.getElementById('editProjectManager').value.trim(),
        postsPerMonth: document.getElementById('editPostsPerMonth').value.trim(),
        publishTimeMsk: document.getElementById('editPublishTimeMsk').value,
        strategyPrompt: document.getElementById('editStrategyPrompt').value,
        planningPrompt: document.getElementById('editPlanningPrompt').value,
        postPrompt: document.getElementById('editPostPrompt').value,
        imagePrompt: document.getElementById('editImagePrompt').value,
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
document.querySelector('[data-action="close-edit"]').addEventListener('click', closeEdit);
document.querySelector('[data-action="save-edit"]').addEventListener('click', saveEdit);
document.querySelectorAll('.edit-tab').forEach((b) => {
  b.addEventListener('click', () => switchEditTab(b.dataset.tab));
});

load();
