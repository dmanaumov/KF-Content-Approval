// «Миграция» (/ceo/migration) — разовый перенос задач/медиа/переписки с
// Mattermost Boards в Postgres (app_tasks/app_task_media/app_task_feedback),
// см. backend/src/mattermostMigration.js и claude/kf-mattermost-to-postgres-
// migration.md в проекте «Мои IT дела». Два отдельных действия по дизайну:
// предпросмотр (GET .../preview, ничего не пишет) и реальный запуск (POST
// .../run, подтверждение в самой кнопке) — так безопаснее перед
// необратимым (для текущего содержимого этих трёх таблиц) шагом.

const toast = document.getElementById('toast');

const previewBtn = document.getElementById('previewBtn');
const previewLoading = document.getElementById('previewLoading');
const previewError = document.getElementById('previewError');
const previewResult = document.getElementById('previewResult');

const runIdle = document.getElementById('runIdle');
const runBtn = document.getElementById('runBtn');
const runConfirm = document.getElementById('runConfirm');
const runConfirmBtn = document.getElementById('runConfirmBtn');
const runCancelBtn = document.getElementById('runCancelBtn');
const runProgress = document.getElementById('runProgress');
const runProgressText = document.getElementById('runProgressText');
const runError = document.getElementById('runError');
const runResult = document.getElementById('runResult');

const retryIntro = document.getElementById('retryIntro');
const retryMediaBtn = document.getElementById('retryMediaBtn');
const retryProgress = document.getElementById('retryProgress');
const retryProgressFill = document.getElementById('retryProgressFill');
const retryProgressText = document.getElementById('retryProgressText');
const retryError = document.getElementById('retryError');
const retryResult = document.getElementById('retryResult');
const retryLog = document.getElementById('retryLog');

let pollTimer = null;
let retryPollTimer = null;

function showToast(text) {
  toast.textContent = text;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2400);
}

function esc(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// mediaErrors, оставшиеся в отчёте ПОСЛЕДНЕГО переноса, — это именно то,
// что докатает кнопка «Докатить медиа» (успешно докатанные файлы сервер
// сам убирает из report.mediaErrors, см. mattermostMigration.js). С
// 2026-10-15 докатка ВСЕХ Mattermost-медиа стартует автоматически сразу
// после быстрого переноса карточек (см. pollStatus ниже) — эта кнопка
// теперь нужна для РУЧНОГО повтора того, что осталось в mediaErrors
// (например, после перезапуска сервера, см. claude/kf-mattermost-to-
// postgres-migration.md).
function updateRetryAvailability(report) {
  const left = (report && report.mediaErrors && report.mediaErrors.length) || 0;
  retryMediaBtn.disabled = left === 0;
  retryIntro.textContent = left
    ? `Не докатано ${left} медиафайл(ов) — можно докатить их отдельно.`
    : 'Докатка (если нужна) запускается автоматически после переноса. Эта кнопка — для повторной попытки, если что-то осталось недокатанным.';
}

function renderReport(report) {
  const feedbackRows = Object.entries(report.feedbackByKind || {})
    .map(([kind, count]) => `<li>${esc(kind)}: ${count}</li>`)
    .join('');
  const pendingBlock = report.pendingMediaCount
    ? `<div class="loading" style="margin-top:8px">Докатка ${report.pendingMediaCount} Mattermost-медиафайлов идёт в фоне — см. «Докатка медиа» ниже.</div>`
    : '';
  const errorsBlock = report.mediaErrors && report.mediaErrors.length
    ? `<div class="error-box" style="margin-top:8px">Не удалось докатить ${report.mediaErrors.length} медиафайл(ов) даже после всех попыток:<ul>${report.mediaErrors
        .slice(0, 20)
        .map((e) => `<li>задача ${esc(e.taskId)}, файл ${esc(e.fileId)}: ${esc(e.message)}</li>`)
        .join('')}</ul>${report.mediaErrors.length > 20 ? `…и ещё ${report.mediaErrors.length - 20}.` : ''}</div>`
    : '';
  return `
    <ul>
      <li>Задач: ${report.tasksCount}</li>
      <li>Медиафайлов всего: ${report.mediaCount} (с Mattermost: ${report.mattermostFilesCount}, уже на диске: ${report.diskLinksCount})</li>
    </ul>
    <div>Переписка по типам:</div>
    <ul>${feedbackRows || '<li>нет записей</li>'}</ul>
    ${pendingBlock}
    ${errorsBlock}
  `;
}

async function runPreview() {
  previewBtn.disabled = true;
  previewLoading.hidden = false;
  previewError.hidden = true;
  previewResult.innerHTML = '';
  try {
    const res = await fetch('/api/ceo/mattermost-migration/preview');
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
    previewResult.innerHTML = renderReport(data);
    runBtn.disabled = false;
  } catch (err) {
    previewError.hidden = false;
    previewError.textContent = 'Не удалось получить предпросмотр: ' + err.message;
  } finally {
    previewBtn.disabled = false;
    previewLoading.hidden = true;
  }
}

function showRunConfirm() {
  runIdle.hidden = true;
  runConfirm.hidden = false;
}

function hideRunConfirm() {
  runIdle.hidden = false;
  runConfirm.hidden = true;
}

async function startRun() {
  runConfirm.hidden = true;
  runError.hidden = true;
  runResult.innerHTML = '';
  runProgress.hidden = false;
  runProgressText.textContent = '';
  try {
    const res = await fetch('/api/ceo/mattermost-migration/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok && res.status !== 202) throw new Error(data.message || `HTTP ${res.status}`);
    pollStatus();
  } catch (err) {
    runProgress.hidden = true;
    runIdle.hidden = false;
    runError.hidden = false;
    runError.textContent = 'Не удалось запустить перенос: ' + err.message;
  }
}

async function pollStatus() {
  clearTimeout(pollTimer);
  try {
    const res = await fetch('/api/ceo/mattermost-migration/status');
    const status = await res.json();
    if (status.state === 'running') {
      const p = status.progress;
      runProgressText.textContent = p && p.total ? `${p.processed} / ${p.total} задач` : '';
      pollTimer = setTimeout(pollStatus, 3000);
      return;
    }
    runProgress.hidden = true;
    if (status.state === 'done') {
      runResult.innerHTML = renderReport(status.report);
      updateRetryAvailability(status.report);
      showToast('Перенос завершён');
      runIdle.hidden = false;
      // С 2026-10-15 докатка медиа стартует на сервере автоматически сразу
      // после переноса карточек — покажем её прогресс сразу, не дожидаясь
      // ручного клика по «Докатить медиа».
      if (status.report && status.report.pendingMediaCount) {
        retryLog.hidden = false;
        retryProgress.hidden = false;
        pollRetryStatus(0);
      }
    } else if (status.state === 'error') {
      runError.hidden = false;
      runError.textContent = 'Перенос завершился ошибкой: ' + status.error;
      runIdle.hidden = false;
    } else {
      runIdle.hidden = false;
    }
  } catch (err) {
    pollTimer = setTimeout(pollStatus, 5000);
  }
}

function appendLogEntries(entries) {
  const frag = entries
    .map((e) => {
      const color = e.ok ? '#1a7f37' : '#c0392b';
      const status = e.ok ? 'OK' : 'ОШИБКА: ' + esc(e.message);
      return `<div style="color:${color}">задача ${esc(e.taskId)}, файл ${esc(e.fileId)} — ${status}</div>`;
    })
    .join('');
  retryLog.insertAdjacentHTML('beforeend', frag);
  retryLog.scrollTop = retryLog.scrollHeight;
}

function renderRetrySummary(log) {
  const ok = log.filter((e) => e.ok).length;
  return `Докатано: ${ok} из ${log.length}${ok < log.length ? ` (не удалось: ${log.length - ok})` : ''}.`;
}

async function startMediaRetry() {
  retryMediaBtn.disabled = true;
  retryError.hidden = true;
  retryResult.hidden = true;
  retryLog.hidden = false;
  retryLog.innerHTML = '';
  retryProgress.hidden = false;
  retryProgressFill.style.width = '0%';
  retryProgressText.textContent = '0 / 0';
  try {
    const res = await fetch('/api/ceo/mattermost-migration/retry-media', { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok && res.status !== 202) throw new Error(data.message || `HTTP ${res.status}`);
    pollRetryStatus(0);
  } catch (err) {
    retryProgress.hidden = true;
    retryMediaBtn.disabled = false;
    retryError.hidden = false;
    retryError.textContent = 'Не удалось запустить докатку: ' + err.message;
  }
}

// knownLogLength — сколько записей лога мы уже отрисовали, чтобы при
// каждом опросе дорисовывать только новые файлы, а не всю историю заново.
async function pollRetryStatus(knownLogLength) {
  clearTimeout(retryPollTimer);
  try {
    const res = await fetch('/api/ceo/mattermost-migration/retry-media/status');
    const status = await res.json();
    const log = status.log || [];
    if (log.length > knownLogLength) appendLogEntries(log.slice(knownLogLength));
    const p = status.progress;
    if (p && p.total) {
      retryProgressFill.style.width = Math.round((p.processed / p.total) * 100) + '%';
      retryProgressText.textContent = `${p.processed} / ${p.total}`;
    }
    if (status.state === 'running') {
      retryPollTimer = setTimeout(() => pollRetryStatus(log.length), 2000);
      return;
    }
    retryProgress.hidden = true;
    if (status.state === 'done') {
      retryResult.hidden = false;
      retryResult.textContent = renderRetrySummary(log);
      showToast('Докатка медиа завершена');
    } else if (status.state === 'error') {
      retryError.hidden = false;
      retryError.textContent = 'Докатка медиа завершилась ошибкой: ' + status.error;
    }
    // Разрешаем повторный клик и после ошибок — пользователь может попробовать
    // ещё раз (например, если диск снова начал отдавать 429 под нагрузкой).
    retryMediaBtn.disabled = false;
  } catch (err) {
    retryPollTimer = setTimeout(() => pollRetryStatus(knownLogLength), 4000);
  }
}

previewBtn.addEventListener('click', runPreview);
runBtn.addEventListener('click', showRunConfirm);
runCancelBtn.addEventListener('click', hideRunConfirm);
runConfirmBtn.addEventListener('click', startRun);
retryMediaBtn.addEventListener('click', startMediaRetry);

// Та же логика восстановления состояния после перезагрузки страницы, что и
// у основного переноса выше, — на случай, если докатку запустили и ушли
// со страницы, пока она работала в фоне.
(async function initialRetryStatusCheck() {
  try {
    const res = await fetch('/api/ceo/mattermost-migration/retry-media/status');
    const status = await res.json();
    const log = status.log || [];
    if (status.state === 'running') {
      retryMediaBtn.disabled = true;
      retryProgress.hidden = false;
      retryLog.hidden = false;
      appendLogEntries(log);
      pollRetryStatus(log.length);
    } else if (log.length) {
      retryLog.hidden = false;
      appendLogEntries(log);
      if (status.state === 'done') {
        retryResult.hidden = false;
        retryResult.textContent = renderRetrySummary(log);
      } else if (status.state === 'error') {
        retryError.hidden = false;
        retryError.textContent = 'Последняя докатка завершилась ошибкой: ' + status.error;
      }
    }
  } catch (err) {
    // тихо — наличие кнопки докатки и так зависит от статуса основного переноса
  }
})();

// На случай, если перенос уже идёт/закончился после перезагрузки страницы
// (запустили, ушли с /ceo/migration, вернулись) — сразу спросим статус.
(async function initialStatusCheck() {
  try {
    const res = await fetch('/api/ceo/mattermost-migration/status');
    const status = await res.json();
    if (status.state === 'running') {
      runProgress.hidden = false;
      runIdle.hidden = true;
      pollStatus();
    } else if (status.state === 'done' || status.state === 'error') {
      runBtn.disabled = false;
      if (status.state === 'done') {
        runResult.innerHTML = renderReport(status.report);
        updateRetryAvailability(status.report);
      } else {
        runError.hidden = false;
        runError.textContent = 'Последний перенос завершился ошибкой: ' + status.error;
      }
    }
  } catch (err) {
    // тихо — страница просто покажет исходное состояние "ещё не запускали"
  }
})();
