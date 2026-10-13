// Service Worker для Web Push уведомлений кабинета клиента (/l/{token}).
// Регистрируется фронтендом (app.js) после успешной подписки через
// pushManager. Единственные обязанности здесь:
//   1. Получить push-сообщение от сервера (JSON: { title, body, url }),
//      показать системное уведомление. Приложение "живое" или нет — браузер
//      доставит сообщение сюда в любом случае (это и есть суть Web Push).
//   2. По клику на уведомление — открыть карточку в кабинете клиента
//      (data.url), если она ещё не открыта, и сфокусировать вкладку.
// Больше ничего: никакого кэширования страниц (кабинет всегда свежий),
// никакого fetch-перехвата (все запросы как есть).

self.addEventListener('install', (event) => {
  // Не оставлять старое уведомление ждать: новый воркер применяется сразу.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  // Взять контроль над страницами, открытыми ДО установки этого воркера.
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (_) {
    // Не JSON (никто не должен слать не-JSON, но на всякий случай не ронять).
    payload = {};
  }
  const title = payload.title || 'КонтентФерма';
  const options = {
    body: payload.body || '',
    icon: '/favicon-192.png',
    badge: '/favicon-192.png',
    data: { url: payload.url || '/l' },
    tag: payload.tag || 'kf-reminder',
    renotify: true,
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/l';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        // Уже открыто окно с этим адресом — просто сфокусировать и, если
        // кликнули по конкретной карточке, перевести его на неё.
        if (new URL(client.url).pathname.replace(/\/[^/]*$/, '') === new URL(url, location.origin).pathname.replace(/\/[^/]*$/, '')) {
          return client.navigate(url).then(() => client.focus());
        }
      }
      return self.clients.openWindow(url);
    })
  );
});