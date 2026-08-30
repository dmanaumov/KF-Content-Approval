// "Управление" tab (/ceo/api-keys) — live Postgres-backed registry of
// machine-to-machine secrets (AUTOMATION_API_KEY / BOT_API_KEY /
// GOOGLE_DOCS_API_KEY and any custom ones staff add), see backend/src/
// apiKeys.js. Rotating/creating/deleting here takes effect on the very next
// automation/bot request — no Dokploy env var edit, no redeploy. Owner-only,
// same requireCeoAuth gate as the rest of /ceo/*.

const loading = document.getElementById('loading');
const errorBox = document.getElementById('errorBox');
const root = document.getElementById('root');
const keysTableEl = document.getElementById('keysTable');
const addForm = document.getElementById('addKeyForm');
const addNameInput = document.getElementById('newKeyName');
const addLabelInput = document.getElementById('newKeyLabel');
const addErrorBox = document.getElementById('addKeyError');
const toast = document.getElementById('toast');

let keys = [];
// Which key names currently show their raw value in the table (name -> true).
// Reset to hidden on every reload, on purpose — a page refresh re-masks
// everything rather than remembering what was open.
const revealed = new Set();

function esc(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function msk(iso) {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
}

function showToast(text) {
  toast.textContent = text;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2400);
}

function maskedValue(value) {
  const v = String(value || '');
  if (v.length <= 8) return '•'.repeat(Math.max(v.length, 6));
  return v.slice(0, 4) + '…' + v.slice(-4);
}

function render() {
  if (!keys.length) {
    keysTableEl.innerHTML = '<div class="muted">Ключей пока нет.</div>';
    return;
  }
  const rows = keys
    .map((k) => {
      const isRevealed = revealed.has(k.name);
      const shown = isRevealed ? esc(k.value) : esc(maskedValue(k.value));
      return `<tr>
        <td><code class="apikey-name">${esc(k.name)}</code>${k.label ? `<div class="muted" style="font-size:11px;margin-top:2px">${esc(k.label)}</div>` : ''}</td>
        <td><span class="apikey-value" data-name="${esc(k.name)}">${shown}</span></td>
        <td class="stat-nowrap">${msk(k.updated_at)}</td>
        <td class="apikey-actions">
          <button type="button" class="apikey-btn" data-action="toggle" data-name="${esc(k.name)}">${isRevealed ? 'Скрыть' : 'Показать'}</button>
          <button type="button" class="apikey-btn" data-action="copy" data-name="${esc(k.name)}">Скопировать</button>
          <button type="button" class="apikey-btn" data-action="rotate" data-name="${esc(k.name)}">Выпустить новый</button>
          <button type="button" class="apikey-btn danger" data-action="delete" data-name="${esc(k.name)}">Удалить</button>
        </td>
      </tr>`;
    })
    .join('');
  keysTableEl.innerHTML = `<table class="stat-table apikey-table"><thead><tr><th>Имя</th><th>Значение</th><th>Обновлён</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
  keysTableEl.querySelectorAll('.apikey-btn').forEach((btn) => {
    btn.addEventListener('click', () => onAction(btn.getAttribute('data-action'), btn.getAttribute('data-name')));
  });
}

function findKey(name) {
  return keys.find((k) => k.name === name);
}

async function onAction(action, name) {
  const key = findKey(name);
  if (!key) return;
  if (action === 'toggle') {
    if (revealed.has(name)) revealed.delete(name);
    else revealed.add(name);
    render();
    return;
  }
  if (action === 'copy') {
    try {
      await navigator.clipboard.writeText(key.value);
      showToast('Значение скопировано');
    } catch (err) {
      showToast('Не удалось скопировать: ' + err.message);
    }
    return;
  }
  if (action === 'rotate') {
    const sure = confirm(`Выпустить новое значение для «${name}»?\n\nСтарое значение перестанет действовать сразу же — все места, где оно вставлено (n8n, Dokploy и т.п.), нужно будет обновить новым.`);
    if (!sure) return;
    try {
      const res = await fetch(`/api/ceo/api-keys/${encodeURIComponent(name)}/rotate`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'Не удалось выпустить новый ключ');
      revealed.add(name);
      showToast('Новое значение выпущено — не забудьте обновить его там, где оно используется');
      await load({ silent: true });
    } catch (err) {
      showToast('Ошибка: ' + err.message);
    }
    return;
  }
  if (action === 'delete') {
    const sure = confirm(`Удалить ключ «${name}»?\n\nВсё, что использует этот ключ (n8n и т.п.), сразу перестанет проходить проверку — если для него не задана резервная переменная окружения.`);
    if (!sure) return;
    try {
      const res = await fetch(`/api/ceo/api-keys/${encodeURIComponent(name)}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'Не удалось удалить ключ');
      showToast('Ключ удалён');
      await load({ silent: true });
    } catch (err) {
      showToast('Ошибка: ' + err.message);
    }
  }
}

async function load({ silent = false } = {}) {
  try {
    const res = await fetch('/api/ceo/api-keys');
    if (res.status === 401) {
      errorBox.innerHTML = 'Доступ только владельцу. Войдите в <a href="/team">кабинет команды</a> под своим Mattermost-аккаунтом и обновите страницу.';
      errorBox.hidden = false;
      loading.hidden = true;
      return;
    }
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || 'Ошибка загрузки');
    keys = data.keys || [];
    if (!silent) {
      loading.hidden = true;
      root.hidden = false;
    }
    render();
  } catch (err) {
    if (!silent) {
      loading.hidden = true;
      errorBox.textContent = 'Не удалось загрузить данные: ' + err.message;
      errorBox.hidden = false;
    } else {
      showToast('Не удалось обновить список: ' + err.message);
    }
  }
}

addForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  addErrorBox.hidden = true;
  const name = addNameInput.value.trim().toUpperCase();
  const label = addLabelInput.value.trim();
  if (!name) return;
  const submitBtn = addForm.querySelector('button[type="submit"]');
  submitBtn.disabled = true;
  try {
    const res = await fetch('/api/ceo/api-keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, label }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || 'Не удалось добавить ключ');
    addNameInput.value = '';
    addLabelInput.value = '';
    revealed.add(name);
    showToast(`Ключ «${name}» создан`);
    await load({ silent: true });
  } catch (err) {
    addErrorBox.textContent = err.message;
    addErrorBox.hidden = false;
  } finally {
    submitBtn.disabled = false;
  }
});

load();
