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
const addValueInput = document.getElementById('newKeyValue');
const addErrorBox = document.getElementById('addKeyError');
const toast = document.getElementById('toast');

const botsTableEl = document.getElementById('botsTable');
const addBotForm = document.getElementById('addBotForm');
const addBotNameInput = document.getElementById('newBotName');
const addBotUsernameInput = document.getElementById('newBotUsername');
const addBotErrorBox = document.getElementById('addBotError');

let keys = [];
// Which key names currently show their raw value in the table (name -> true).
// Reset to hidden on every reload, on purpose — a page refresh re-masks
// everything rather than remembering what was open.
const revealed = new Set();
// Which key's row is currently showing the "Задать своё значение" inline
// edit input (name, or null) — see onAction('edit-value'/...) below.
let editingKeyName = null;

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
      if (editingKeyName === k.name) {
        return `<tr data-name="${esc(k.name)}"><td colspan="4">
          <div class="bot-edit-row">
            <input class="field-input apikey-edit-value" type="text" value="${esc(k.value)}" placeholder="Новое значение">
            <button type="button" class="apikey-btn" data-action="save-value" data-name="${esc(k.name)}">Сохранить</button>
            <button type="button" class="apikey-btn" data-action="cancel-edit-value" data-name="${esc(k.name)}">Отмена</button>
          </div>
        </td></tr>`;
      }
      const isRevealed = revealed.has(k.name);
      const shown = isRevealed ? esc(k.value) : esc(maskedValue(k.value));
      return `<tr>
        <td><code class="apikey-name">${esc(k.name)}</code>${k.label ? `<div class="muted" style="font-size:11px;margin-top:2px">${esc(k.label)}</div>` : ''}</td>
        <td><span class="apikey-value" data-name="${esc(k.name)}">${shown}</span></td>
        <td class="stat-nowrap">${msk(k.updated_at)}</td>
        <td class="apikey-actions">
          <button type="button" class="apikey-btn" data-action="toggle" data-name="${esc(k.name)}">${isRevealed ? 'Скрыть' : 'Показать'}</button>
          <button type="button" class="apikey-btn" data-action="copy" data-name="${esc(k.name)}">Скопировать</button>
          <button type="button" class="apikey-btn" data-action="edit-value" data-name="${esc(k.name)}">Задать своё значение</button>
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
  if (action === 'edit-value') {
    editingKeyName = name;
    render();
    return;
  }
  if (action === 'cancel-edit-value') {
    editingKeyName = null;
    render();
    return;
  }
  if (action === 'save-value') {
    const row = keysTableEl.querySelector(`tr[data-name="${CSS.escape(name)}"]`);
    if (!row) return;
    const value = row.querySelector('.apikey-edit-value').value.trim();
    if (!value) { showToast('Значение не может быть пустым'); return; }
    try {
      const res = await fetch(`/api/ceo/api-keys/${encodeURIComponent(name)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'Не удалось сохранить значение');
      editingKeyName = null;
      revealed.add(name);
      showToast(`Значение «${name}» обновлено`);
      await load({ silent: true });
    } catch (err) {
      showToast('Ошибка: ' + err.message);
    }
    return;
  }
  if (action === 'rotate') {
    const sure = confirm(`Выпустить новое значение для «${name}»?\n\nСтарое значение перестанет действовать сразу же — все места, где оно вставлено (внешние интеграции, переменные окружения и т.п.), нужно будет обновить новым.`);
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
    const sure = confirm(`Удалить ключ «${name}»?\n\nВсё, что использует этот ключ (внешние интеграции и т.п.), сразу перестанет проходить проверку — если для него не задана резервная переменная окружения.`);
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
  const value = addValueInput.value.trim();
  if (!name) return;
  const submitBtn = addForm.querySelector('button[type="submit"]');
  submitBtn.disabled = true;
  try {
    // Value filled in → "Задать своё значение" (PUT, stored exactly as
    // typed — for externally-issued data like Meta App ID/Secret, where a
    // random generated value would be wrong). Value empty → the original
    // "Добавить и выпустить" flow (POST, random value, rejects a name that
    // already exists).
    const res = value
      ? await fetch(`/api/ceo/api-keys/${encodeURIComponent(name)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ label, value }),
        })
      : await fetch('/api/ceo/api-keys', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, label }),
        });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || 'Не удалось добавить ключ');
    addNameInput.value = '';
    addLabelInput.value = '';
    addValueInput.value = '';
    revealed.add(name);
    showToast(`Ключ «${name}» сохранён`);
    await load({ silent: true });
  } catch (err) {
    addErrorBox.textContent = err.message;
    addErrorBox.hidden = false;
  } finally {
    submitBtn.disabled = false;
  }
});

// --- Боты (feeds the "куда публикует бот" picker in project settings) ---

let botsList = [];
let editingBotId = null;

function renderBots() {
  if (!botsList.length) {
    botsTableEl.innerHTML = '<div class="muted">Ботов пока нет.</div>';
    return;
  }
  const rows = botsList
    .map((b) => {
      if (String(editingBotId) === String(b.id)) {
        return `<tr data-id="${esc(b.id)}"><td colspan="3">
          <div class="bot-edit-row">
            <input class="field-input bot-edit-name" type="text" value="${esc(b.name)}" placeholder="Имя">
            <input class="field-input bot-edit-username" type="text" value="${esc(b.username)}" placeholder="username_бота (без @)">
            <button type="button" class="apikey-btn" data-action="save-edit" data-id="${esc(b.id)}">Сохранить</button>
            <button type="button" class="apikey-btn" data-action="cancel-edit" data-id="${esc(b.id)}">Отмена</button>
          </div>
        </td></tr>`;
      }
      const usernameShown = b.username ? '@' + esc(b.username) : '<span class="muted">не указан</span>';
      return `<tr${b.is_active ? '' : ' class="bot-row-inactive"'}>
        <td>${esc(b.name)}</td>
        <td>${usernameShown}${b.is_active ? '' : ' <span class="muted">(неактивен)</span>'}</td>
        <td class="apikey-actions">
          <button type="button" class="apikey-btn" data-action="copy" data-id="${esc(b.id)}">Скопировать @username</button>
          <button type="button" class="apikey-btn" data-action="edit" data-id="${esc(b.id)}">Изменить</button>
          <button type="button" class="apikey-btn" data-action="toggle-active" data-id="${esc(b.id)}">${b.is_active ? 'Деактивировать' : 'Активировать'}</button>
          <button type="button" class="apikey-btn danger" data-action="delete" data-id="${esc(b.id)}">Удалить</button>
        </td>
      </tr>`;
    })
    .join('');
  botsTableEl.innerHTML = `<table class="stat-table apikey-table"><thead><tr><th>Имя</th><th>Юзернейм</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
  botsTableEl.querySelectorAll('.apikey-btn').forEach((btn) => {
    btn.addEventListener('click', () => onBotAction(btn.getAttribute('data-action'), btn.getAttribute('data-id')));
  });
}

function findBot(id) {
  return botsList.find((b) => String(b.id) === String(id));
}

async function patchBot(id, body) {
  const res = await fetch(`/api/ceo/bots/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || 'Не удалось сохранить');
  return data.bot;
}

async function onBotAction(action, id) {
  const bot = findBot(id);
  if (action === 'copy') {
    if (!bot || !bot.username) { showToast('У этого бота не указан юзернейм'); return; }
    try {
      await navigator.clipboard.writeText('@' + bot.username);
      showToast('Юзернейм скопирован');
    } catch (err) {
      showToast('Не удалось скопировать: ' + err.message);
    }
    return;
  }
  if (action === 'edit') {
    editingBotId = id;
    renderBots();
    return;
  }
  if (action === 'cancel-edit') {
    editingBotId = null;
    renderBots();
    return;
  }
  if (action === 'save-edit') {
    const row = botsTableEl.querySelector(`tr[data-id="${CSS.escape(String(id))}"]`);
    if (!row) return;
    const name = row.querySelector('.bot-edit-name').value.trim();
    const username = row.querySelector('.bot-edit-username').value.trim();
    if (!name) { showToast('Имя обязательно'); return; }
    try {
      await patchBot(id, { name, username });
      editingBotId = null;
      showToast('Сохранено');
      await loadBots({ silent: true });
    } catch (err) {
      showToast('Ошибка: ' + err.message);
    }
    return;
  }
  if (action === 'toggle-active') {
    if (!bot) return;
    try {
      await patchBot(id, { isActive: !bot.is_active });
      showToast(bot.is_active ? 'Бот деактивирован' : 'Бот активирован');
      await loadBots({ silent: true });
    } catch (err) {
      showToast('Ошибка: ' + err.message);
    }
    return;
  }
  if (action === 'delete') {
    if (!bot) return;
    const sure = confirm(`Удалить бота «${bot.name}»?\n\nЕсли он уже выбран в настройках каких-то проектов как «куда публикует», выбрать его там заново будет нельзя, пока не добавите снова — уже сохранённые данные проекта при этом не трогаются.`);
    if (!sure) return;
    try {
      const res = await fetch(`/api/ceo/bots/${encodeURIComponent(id)}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'Не удалось удалить бота');
      showToast('Бот удалён');
      await loadBots({ silent: true });
    } catch (err) {
      showToast('Ошибка: ' + err.message);
    }
  }
}

async function loadBots({ silent = false } = {}) {
  if (!silent) botsTableEl.innerHTML = '<div class="muted">Загружаем ботов…</div>';
  try {
    const res = await fetch('/api/ceo/bots');
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || 'Ошибка загрузки');
    botsList = data.bots || [];
    renderBots();
  } catch (err) {
    botsTableEl.innerHTML = `<div class="error-box">Не удалось загрузить ботов: ${esc(err.message)}</div>`;
  }
}

addBotForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  addBotErrorBox.hidden = true;
  const name = addBotNameInput.value.trim();
  const username = addBotUsernameInput.value.trim();
  if (!name) return;
  const submitBtn = addBotForm.querySelector('button[type="submit"]');
  submitBtn.disabled = true;
  try {
    const res = await fetch('/api/ceo/bots', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, username }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || 'Не удалось добавить бота');
    addBotNameInput.value = '';
    addBotUsernameInput.value = '';
    showToast(`Бот «${name}» добавлен`);
    await loadBots({ silent: true });
  } catch (err) {
    addBotErrorBox.textContent = err.message;
    addBotErrorBox.hidden = false;
  } finally {
    submitBtn.disabled = false;
  }
});

load();
loadBots();
