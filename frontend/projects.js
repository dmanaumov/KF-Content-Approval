// Internal staff page — lists every client project on the shared board with
// its rotatable client cabinet link (see backend/src/linkTokens.js), a link
// to open the project directly in Mattermost, and a "regenerate" button for
// when a link may have leaked. No build step, same approach as app.js.
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
        return `<div class="proj-card">
          <div class="proj-name">${esc(o.label)}</div>
          <div class="proj-row">
            <span class="proj-row-label">Mattermost:</span>
            <a class="proj-mm-link" href="${esc(mattermostWebUrl)}" target="_blank" rel="noopener">${esc(mattermostWebUrl)}</a>
          </div>
          <div class="proj-row proj-link-row">
            <span class="proj-row-label">Клиенту:</span>
            <input class="proj-link" type="text" readonly value="${esc(link)}" onclick="this.select()">
            <button class="btn approve proj-copy" data-link="${esc(link)}">Копировать</button>
          </div>
          <div class="proj-row proj-actions-row">
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
    try {
      await navigator.clipboard.writeText(copyBtn.dataset.link);
      toast('Ссылка скопирована');
    } catch (err) {
      toast('Не удалось скопировать — выделите ссылку вручную');
    }
    return;
  }
  const regenBtn = e.target.closest('.proj-regen');
  if (regenBtn) {
    regenerateLink(regenBtn.dataset.projectId, regenBtn.dataset.label);
  }
});

load();
