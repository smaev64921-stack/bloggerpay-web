/* ══════════════════════════════════════════════════════════════════════
   BloggerPay — service worker

   Зачем он вообще: приложение весит около 4 МБ (1 МБ после сжатия) и
   грузится одним файлом. Без кэша каждый заход по мобильному интернету —
   это заново скачанный мегабайт и несколько секунд заставки.

   Стратегия — «сеть вперёд, кэш на подхвате» (network-first):
     · есть сеть  → всегда берём свежую версию, кладём копию в кэш;
     · нет сети   → отдаём последнюю удачную копию;
     · нет ни того, ни другого → короткая честная страница.

   Почему НЕ «кэш вперёд»: это приложение с деньгами. Застрявшая у
   пользователя старая версия — это старые правила выплат, старые тексты
   оферты и старые ошибки, которые уже исправлены. Лишняя секунда
   загрузки дешевле, чем человек, работающий по прошлогодним правилам.

   Обновление: меняем VERSION — старые кэши удаляются в activate.
   ══════════════════════════════════════════════════════════════════════ */

var VERSION = 'bp-v116';
var CACHE = 'bloggerpay-' + VERSION;

/* Ничего не кладём заранее: имя главного файла меняется от версии к
   версии (bloggerpay-1008-vNN.html), а на хостинге он лежит как
   index.html. Наполняем кэш тем, что реально запросили. */
self.addEventListener('install', function (e) {
  self.skipWaiting();
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys.map(function (k) {
          return k === CACHE ? null : caches.delete(k);
        }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('message', function (e) {
  if (e && e.data === 'bp-skip-waiting') self.skipWaiting();
});

/* Уведомление от сервера.
   Приходит, когда приложение закрыто, — этим web push и отличается от
   всего, что умеет сама страница. Тело зашифровано ключами подписки,
   расшифровывает его сам браузер, нам достаётся готовый JSON
   (см. server/push.js). Показать что-то мы ОБЯЗАНЫ: браузеры не
   разрешают «тихий» push и снимают разрешение у тех, кто молчит. */
self.addEventListener('push', function (e) {
  var d = { title: 'BloggerPay', body: '', url: '/' };
  try {
    if (e.data) {
      var j = e.data.json();
      if (j && typeof j === 'object') {
        d.title = String(j.title || d.title);
        d.body = String(j.body || '');
        d.url = String(j.url || '/');
      }
    }
  } catch (err) { /* пришло не JSON — покажем заголовок по умолчанию */ }

  e.waitUntil(
    self.registration.showNotification(d.title, {
      body: d.body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: 'bp-srv',
      renotify: true,
      data: { url: d.url }
    })
  );
});

/* Нажатие на уведомление.
   Уведомления показывает сама страница через registration.showNotification
   (слой bp-push): они переживают закрытие вкладки, и вернуть человека
   обратно должен воркер. Ищем уже открытое окно приложения и поднимаем
   его; не нашли — открываем новое. Без этого нажатие просто гасит
   уведомление и никуда не ведёт. */
self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  var url = '/';
  try { if (e.notification.data && e.notification.data.url) url = String(e.notification.data.url); } catch (err) {}
  /* Открываем только свой адрес: url приходит из уведомления, а его
     содержимое пришло по сети. Чужая ссылка отсюда открываться не должна. */
  if (url.charAt(0) !== '/') url = '/';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(function (list) {
        for (var i = 0; i < list.length; i++) {
          var c = list[i];
          if (c.url.indexOf(self.location.origin) === 0 && 'focus' in c) return c.focus();
        }
        if (self.clients.openWindow) return self.clients.openWindow(url);
        return null;
      })
      .catch(function () { return null; })
  );
});

function offlinePage() {
  return new Response(
    '<!doctype html><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>BloggerPay</title>' +
    '<style>body{margin:0;min-height:100vh;display:flex;align-items:center;' +
    'justify-content:center;background:#08080b;color:#e4e4e7;' +
    'font:600 15px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;text-align:center;padding:24px}' +
    'p{color:#7d818c;font-weight:500;margin:8px 0 0;font-size:13px}</style>' +
    '<div><div>Нет соединения</div>' +
    '<p>BloggerPay откроется, как только появится сеть.</p></div>',
    { headers: { 'Content-Type': 'text/html; charset=utf-8' }, status: 503 }
  );
}

self.addEventListener('fetch', function (e) {
  var req = e.request;

  /* Трогаем только обычные GET со своего домена. Чужие адреса
     (telegram.org, googleapis.com) отдаём браузеру как есть: их кэширование
     нам не принадлежит, а YouTube-статистика вообще обязана быть свежей. */
  if (req.method !== 'GET') return;
  var url;
  try { url = new URL(req.url); } catch (err) { return; }
  if (url.origin !== self.location.origin) return;
  /* Ответы кассы не кэшируем вовсе. Это и свежесть (статус проверки
     личности, баланс, каталог), и чужие данные: копия ответа /api/me
     осталась бы в кэше устройства после смены аккаунта. */
  if (url.pathname.indexOf('/api/') === 0) return;
  /* Магазин соусов по адресу /sauce/ — отдельное приложение со своим
     служебным работником. Наша область (весь адрес) его накрывает, и без
     этой строки при плохой связи человек, открывший магазин, получал бы
     НАШУ страницу «Нет соединения» с надписью BloggerPay. Пропускаем
     мимо: там разберётся свой работник. */
  if (url.pathname === '/sauce' || url.pathname.indexOf('/sauce/') === 0) return;

  e.respondWith(
    fetch(req)
      .then(function (res) {
        /* Кладём в кэш только удачные полные ответы. Частичные (206) в
           Cache API класть нельзя — это ошибка времени выполнения. */
        if (res && res.ok && res.status === 200 && res.type === 'basic') {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) {
            c.put(req, copy).catch(function () {});
          }).catch(function () {});
        }
        return res;
      })
      .catch(function () {
        return caches.match(req).then(function (hit) {
          if (hit) return hit;
          /* Переход по адресу без сети и без копии — показываем страницу,
             а не браузерную ошибку. */
          if (req.mode === 'navigate') return offlinePage();
          return new Response('', { status: 504, statusText: 'Нет сети' });
        });
      })
  );
});
