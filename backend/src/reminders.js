// Единая точка «уведомить клиента, что карточка ждёт его действия» — при
// переходе карточки в "waiting"/"changes". Рассылает по ВСЕМ каналам, на
// которые клиент подписался:
//
//   • Web Push (pushNotifier.js) — приходит на телефон браузера/устройства,
//     которое подписалось в кабинете /l/{token}.
//   • Telegram (tgSubs.js → botStore.queueOutgoing) — клиент подписался по
//     deep linkу; сообщение физически отправляет n8n через очередь исходящих
//     бота (это приложение не держит токен бота — см. botStore.js).
//
// Вызывается ИЗ АСИНХРОННЫХ ОБРАБОТЧИКОВ ПОСЛЕ того, как статус карточки
// реально изменился (для подтверждения уже был сделан повторный фид-рид
// карточки). Поэтому функция fire-and-forget и не может швыряться ошибками
// в вызывающий код: неудачная рассылка не должна ломать смену статуса.
//
// URL в уведомлении строится из config.publicBaseUrl + токена проекта —
// уведомление рождается не в HTTP-запросе кабинета, поэтому «хост из
// заголовка» здесь недоступен. Без publicBaseUrl шлём текст без ссылки.

const config = require('./config');
const pushNotifier = require('./pushNotifier');
const tgSubs = require('./tgSubs');
const botStore = require('./botStore');
const projectSettings = require('./projectSettings');

// Что показать и куда вести. task — карточка из buildTasks: у неё есть id,
// title, projectId (id опции свойства «Проект»), status. boardId — борд, на
// котором карточка живёт (нужен для выборки подписей проекта и token).
async function notifyTaskNeedsAction(boardId, task) {
  if (!task || !task.projectId) return;
  // Ссылка на карточку в кабинете клиента — только через его link-токен
  // (тот же /l/{token}, что и весь кабинет). Свойство "Проект" карточки —
  // это НЕ токен. Без токена (настройки не заведены) шлём текст без ссылки.
  let linkToken = '';
  try {
    const settings = await projectSettings.getSettings(boardId, task.projectId);
    linkToken = settings.token || '';
  } catch (err) {
    console.warn(`[reminders] не удалось прочитать settings проекта ${boardId}/${task.projectId}: ${err.message}`);
  }
  const taskUrl = config.publicBaseUrl && linkToken
    ? `${config.publicBaseUrl.replace(/\/+$/, '')}/l/${encodeURIComponent(linkToken)}?task=${encodeURIComponent(task.id)}`
    : '';
  const actionText = task.status === 'waiting' ? 'ждёт вашего согласования' : 'обновлён — нужны ваши правки';
  const title = task.title || '(без названия)';
  const pushTitle = 'КонтентФерма';
  const pushBody = `«${title}» — ${actionText}`;

  // Web Push — просто запускаем, результат никого не блокирует.
  pushNotifier.notifyProject({
    boardId,
    projectId: task.projectId,
    title: pushTitle,
    body: pushBody,
    url: taskUrl,
  }).catch(() => {});

  // Telegram — для каждого подписавшегося чата кладём строку в очередь
  // исходящих бота (n8n вычитает и отправит). Ошибки только логируем. markSent
  // проставляет last_sent_at (тот же сигнал активности, что и у push), чтобы
  // в CEO-матрице "клиенты с активностью за 48ч" TG-канал был честным: чат
  // считается активным, если ему реально ушло напоминание, а не только был
  // подписан когда-то.
  tgSubs
    .chatIdsForProject(boardId, task.projectId)
    .then((chatIds) => {
      const text = taskUrl ? `«${title}» — ${actionText}\nОткрыть: ${taskUrl}` : `«${title}» — ${actionText}`;
      return Promise.all(
        chatIds.map((chatId) =>
          botStore.queueOutgoing({ chatId, text, sentBy: 'КФ: напоминание' })
            .then(() => tgSubs.markSent({ chatId }))
            .catch((err) => {
              console.warn(`[reminders] не удалось поставить tg-напоминание в чат ${chatId}: ${err.message}`);
            })
        )
      );
    })
    .catch((err) => {
      console.warn(`[reminders] выборка tg-подписок проекта не удалась: ${err.message}`);
    });
}

module.exports = { notifyTaskNeedsAction };