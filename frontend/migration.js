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

let pollTimer = null;

function showToast(text) {
  toast.textContent = text;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2400);
}

function esc(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderReport(report) {
  const feedbackRows = Object.entries(report.feedbackByKind || {})
    .map(([kind, count]) => `<li>${esc(kind)}: ${count}</li>`)
    .join('');
  const errorsBlock = report.mediaErrors && report.mediaErrors.length
    ? `<div class="error-box" style="margin-top:8px">Не удалось перенести ${report.mediaErrors.length} медиафайл(ов) — задача всё равно переносится, без этого файла:<ul>${report.mediaErrors
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
      showToast('Перенос завершён');
      runIdle.hidden = false;
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

previewBtn.addEventListener('click', runPreview);
runBtn.addEventListener('click', showRunConfirm);
runCancelBtn.addEventListener('click', hideRunConfirm);
runConfirmBtn.addEventListener('click', startRun);

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
      if (status.state === 'done') runResult.innerHTML = renderReport(status.report);
      else {
        runError.hidden = false;
        runError.textContent = 'Последний перенос завершился ошибкой: ' + status.error;
      }
    }
  } catch (err) {
    // тихо — страница просто покажет исходное состояние "ещё не запускали"
  }
})();
