// Internal staff page — lists every client project on the shared board with
// its rotatable client cabinet link (see backend/src/projectSettings.js), a
// link to open the project directly in Mattermost, a "regenerate" button for
// when a link may have leaked, and a "Редактировать" popup for the client's
// logo URL + per-network publishing credentials (also in projectSettings.js
// — Postgres-backed, meant to be read directly by the future n8n publishing
// automation). No build step, same approach as app.js.
//
// Deliberately does NOT take a board id from this page's own URL (unlike
// app.js's /p/{boardId} handling) — the backend already knows the one board
// it operates on (config.mattermostBoardId) and this page's path itself is
// configurable (config.staffProjectsPath) specifically so nothing
// identifying has to sit in a URL someone might screenshot/bookmark/share.

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
let mattermostWebUrl = '';
let busyProjectId = null;

function render(filterText) {
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
        return `<div class="proj-card">
          <div class="proj-card-top">
            <div class="proj-logo">${logo}</div>
            <div class="proj-info">
              <div class="proj-name">${esc(o.label)}</div>
              <div class="proj-row">
                <span class="proj-row-label">Mattermost:</span>
                <a class="proj-mm-link" href="${esc(mattermostWebUrl)}" target="_blank" rel="noopener">${esc(mattermostWebUrl)}</a>
              </div>
              <div class="proj-row proj-link-row">
                <span class="proj-row-label">Клиенту:</span>
                <input class="proj-link" type="text" readonly value="${esc(link)}" onclick="this.select()">
                <button class="proj-copy" title="Скопировать ссылку с приглашением" aria-label="Скопировать ссылку с приглашением" data-link="${esc(link)}" data-label="${esc(o.label)}">📋</button>
              </div>
            </div>
          </div>
          <div class="proj-row proj-actions-row">
            <button class="btn changes proj-edit" data-project-id="${esc(o.id)}" data-label="${esc(o.label)}">Редактировать</button>
            <button class="btn changes proj-regen" ${busy ? 'disabled' : ''} data-project-id="${esc(o.id)}" data-label="${esc(o.label)}">
              ${busy ? 'Обновляем…' : 'Сгенерировать новую ссылку'}
            </button>
          </div>
        </div>`;
      })
      .join('') || '<div class="empty">Ничего не найдено.</div>';
}

async function load() {
  const loading = document.getElementById('loading');
  loading.hidden = false;
  try {
    const res = await fetch('/api/projects');
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || data.error || 'Ошибка загрузки');
    mattermostWebUrl = data.mattermostWebUrl || '';
    options = data.options.slice().sort((a, b) => a.label.localeCompare(b.label, 'ru'));
    render(document.getElementById('search').value);
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
  document.getElementById('editError').hidden = true;
  document.getElementById('editLogoUrl').value = '';
  document.getElementById('editLogoPreview').hidden = true;
  credTextareas().forEach((ta) => { ta.value = ''; });
  document.getElementById('editModal').classList.add('show');

  try {
    const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/settings`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || data.error);
    document.getElementById('editLogoUrl').value = data.logoUrl || '';
    updateLogoPreview();
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
      body: JSON.stringify({ logoUrl, socialCredentials }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || data.error);
    // Reflect the new logo in the list immediately, without a full reload.
    const opt = options.find((o) => o.id === editingProjectId);
    if (opt) opt.logoUrl = data.logoUrl || '';
    toast('Настройки сохранены');
    closeEdit();
    render(document.getElementById('search').value);
  } catch (err) {
    errBox.textContent = 'Не удалось сохранить: ' + err.message;
    errBox.hidden = false;
  }
}

document.getElementById('editLogoUrl').addEventListener('input', updateLogoPreview);
document.querySelector('[data-action="close-edit"]').addEventListener('click', closeEdit);
document.querySelector('[data-action="save-edit"]').addEventListener('click', saveEdit);

load();
