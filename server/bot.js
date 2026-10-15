/* ══════════════════════════════════════════════════════════════════════
   BloggerPay — телеграм-бот, который открывает мини-апп.

   Что он делает: на /start отвечает приветствием и синей кнопкой
   «Открыть BloggerPay». Плюс ставит постоянную кнопку меню рядом с полем
   ввода — она открывает то же приложение в один тап.

   Почему длинный опрос, а не вебхук: вебхуку нужен публичный HTTPS-адрес,
   а опрос работает сразу — и на вашем компьютере, и на сервере, где ещё
   ничего не настроено. Когда появится домен, можно перейти на вебхук, но
   необходимости в этом нет: одному боту опроса хватает с запасом.

   Запуск:   node server/bot.js
   Настройки: server/.env → BOT_TOKEN и APP_URL

   ВАЖНО: одновременно может работать только ОДИН опрос на бота. Если
   запустить второй, Телеграм ответит 409 — бот честно об этом скажет.
   ══════════════════════════════════════════════════════════════════════ */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { reachableOutside, externalBase } = require('./mail');

/* ── Настройки ─────────────────────────────────────────────────────── */

function loadEnv(file) {
  const out = {};
  try {
    const txt = fs.readFileSync(file, 'utf8');
    for (const line of txt.split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (m && !line.trim().startsWith('#')) out[m[1]] = m[2];
    }
  } catch (e) { /* .env не обязателен — можно задать переменными окружения */ }
  return out;
}

const ENV = Object.assign(loadEnv(path.join(__dirname, '.env')), process.env);
const TOKEN = ENV.BOT_TOKEN || '';
/* Выбор адреса. Правило: если сервер виден из интернета — кнопка ведёт
   НА НЕГО, потому что сайт раздаёт он же. APP_URL берётся только когда
   своего внешнего адреса нет.

   Почему не «APP_URL главнее», как принято для явных настроек: этот
   проект переехал с отдельного хостинга на собственный сервер, и в
   панелях у людей остался APP_URL со старым адресом. Он молча уводил
   посетителей на прежний сайт — кнопка работала, вела не туда, и понять
   это можно было только вручную сверив адрес. Забытая настройка не
   должна пересиливать живой адрес. */
function pickAppUrl() {
  const own = externalBase(ENV);                 /* PUBLIC_URL или DOMAIN хостинга */
  if (own) return { url: own, from: 'адреса сервера' };
  const app = String(ENV.APP_URL || '').trim().replace(/\/+$/, '');
  if (app) return { url: app, from: 'APP_URL' };
  const pub = String(ENV.PUBLIC_URL || '').trim().replace(/\/+$/, '');
  return { url: pub, from: 'PUBLIC_URL' };       /* локальная разработка */
}
const PICKED = pickAppUrl();
const APP_URL = PICKED.url;
/* Адрес API Телеграма. Меняется, если с сервера api.telegram.org
   недоступен (в России это обычное дело) — тогда сюда ставится адрес
   вашего прокси, который проксирует запросы к Телеграму один в один.
   Тот же ключ используют тесты, чтобы подставить заглушку. */
const TG_API_BASE = (ENV.TG_API_BASE || 'https://api.telegram.org').replace(/\/+$/, '');

/* Проверки НЕ на загрузке файла, а в boot(): этот файл подключает к себе
   server.js, и падение process.exit(1) здесь убивало бы весь сервер
   вместе с сайтом — из-за отсутствующего токена бота. */
function checkConfig() {
  if (!TOKEN) {
    return 'В настройках нет BOT_TOKEN. Возьмите его у @BotFather.';
  }
  /* Телеграм отвергает адрес без схемы и без точки в домене
     («Wrong HTTP URL»), поэтому проверяем форму. */
  if (!/^https?:\/\/[^\s.]+\.[^\s]/i.test(APP_URL)) {
    return 'Нужен адрес сайта: PUBLIC_URL (или APP_URL), например'
      + ' https://bloggerpay.up.railway.app. Сейчас там: ' + (APP_URL || '(пусто)');
  }
  /* И HTTPS — для всего, что не своя машина. По http пароль и код из
     письма поехали бы открытым текстом через чужие сети. Локальную
     разработку не мучаем: там http нормально. */
  let host = '';
  try { host = new URL(APP_URL).hostname.toLowerCase(); } catch (e) { host = ''; }
  const local = host === 'localhost' || host === '127.0.0.1' || host === '::1'
    || /\.local(host)?$/.test(host)
    || /^10\./.test(host) || /^192\.168\./.test(host)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
  if (!local && !/^https:\/\//i.test(APP_URL)) {
    return 'адрес сайта должен быть по HTTPS — через приложение идут пароли'
      + ' и коды. Сейчас там: ' + APP_URL;
  }
  return '';
}

const API = TG_API_BASE + '/bot' + TOKEN + '/';

/* ── Вызов Телеграма ───────────────────────────────────────────────── */

async function tg(method, body, timeoutMs) {
  const res = await fetch(API + method, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(timeoutMs || 15000),
  });
  const j = await res.json().catch(() => ({}));
  if (!j.ok) {
    const e = new Error(j.description || ('Телеграм ответил ' + res.status));
    e.code = j.error_code || res.status;
    throw e;
  }
  return j.result;
}

/* ── Что показываем ────────────────────────────────────────────────── */

const HELLO = [
  '👋 <b>BloggerPay</b> — биржа рекламы у блогеров.',
  '',
  '• рекламодатель размещает задание и замораживает бюджет;',
  '• блогер публикует ролик в TikTok или YouTube и загружает ссылку;',
  '• 30 дней сайт сам считает просмотры и начисляет деньги;',
  '• комиссия сервиса 7% — сверху пополнения, сверху бюджета задания и с выплат за ролики; вывод без комиссии.',
  '',
  'Кнопки ниже: биржа и наш магазин соусов «Санчоус».',
].join('\n');

/* Кнопка ведёт на приложение. Если человек пришёл по приглашению
   (/start r_12345), передаём метку в адрес — приложение её прочитает
   из строки запроса, как делает это вне Телеграма. */
/* Ссылку бот собирает САМ, из адреса, по которому его же сервер отдаёт
   сайт. Отдельный адрес прописывать не нужно и не следует: сайт живёт
   в том же процессе, что и бот, значит его адрес боту уже известен.

   Метка from=tg говорит сайту, что человек пришёл из Телеграма — по
   ней приложение отличает такой заход от прямого. */
function appUrl(payload) {
  const q = ['from=tg'];
  if (payload) q.push('startapp=' + encodeURIComponent(payload));
  /* Косая черта перед вопросом: без неё получается «домен?from=tg» —
     работает, но выглядит опечаткой. Добавляем, только если пути нет. */
  let base = APP_URL;
  if (!/^https?:\/\/[^/]+\//i.test(base)) base += '/';
  return base + (base.includes('?') ? '&' : '?') + q.join('&');
}
/* Кнопка — МИНИ-ПРИЛОЖЕНИЕ (web_app), если адрес https (15.10.2026).

   Было: обычная ссылка (url). Телеграм открывает её во встроенном
   браузере — с полосой «✕ · название · адрес · ⋮» сверху. Владелец:
   «сразу показывается блок, где закрыть и три точки, — мне так не надо».
   Мини-приложение приложение само разворачивает на весь экран
   (requestFullscreen, слой bp-tg-fs): полосы с адресом нет, от Телеграма
   остаются только его маленькие кнопки «Закрыть» и «⋯» поверх — их не
   убирает ни одно приложение. Скрипт Телеграма сайт грузит только внутри
   мини-приложения (bp-tg-boot), в браузере он не нужен.
   На http (своя машина) мини-приложение Телеграм не откроет — тогда
   по-прежнему обычная ссылка. */
function openButton(payload) {
  const url = appUrl(payload);
  return /^https:\/\//i.test(url) ? { text: '🌐 Открыть BloggerPay', web_app: { url } } : { text: '🌐 Открыть BloggerPay', url };
}
/* Магазин соусов «Санчоус» раздаётся этим же сервером по адресу /sauce/
   (у его собственного бота не отвечает узел хостинга). Кнопка — тоже
   обычная ссылка, а не мини-апп: тот же довод, что и выше. */
function sauceUrl() {
  let base = APP_URL;
  if (!/^https?:\/\/[^/]+\//i.test(base)) base += '/';
  return base.replace(/\/+$/, '') + '/sauce/';
}
function keyboard(payload) {
  return {
    inline_keyboard: [
      [openButton(payload)],
      [{ text: '🌶 Санчоус — магазин соусов', url: sauceUrl() }],
    ],
  };
}
/* ── Админ-панель для владельца (15.10.2026) ──────────────────────
   Только в чате владельца (ADMIN_CHAT_ID): кнопка «Админ панель» открывает
   /admin МИНИ-ПРИЛОЖЕНИЕМ Телеграма — так страница получает подписанные
   данные Телеграма и входит сама, без ключа (сервер: /api/admin/tg-session).
   Мини-приложение Телеграм открывает только по https; на локальной машине
   (http) — обычная ссылка, там вход ключом. */
function adminChat() { return String(ENV.ADMIN_CHAT_ID || '').trim(); }
function isAdminChat(chatId) { const a = adminChat(); return !!a && String(chatId) === a; }
function adminUrl() {
  /* админка живёт в корне сайта (/admin), даже если у приложения есть путь */
  try { return new URL('/admin', APP_URL).href; } catch (e) { return String(APP_URL).replace(/\/+$/, '') + '/admin'; }
}
function adminButton() {
  const url = adminUrl();
  return /^https:\/\//i.test(url) ? { text: '🛠 Админ панель', web_app: { url } } : { text: '🛠 Админ панель', url };
}
function keyboardFor(chatId, payload) {
  const kb = keyboard(payload);
  if (isAdminChat(chatId)) kb.inline_keyboard.push([adminButton()]);
  return kb;
}

/* ── Крючки для сервера (14.10.2026) ───────────────────────────────
   Пополнение по счёту ведётся здесь, в чате: сервер ставит крючки
   (setHooks), бот отдаёт им /start с меткой, ответы владельца на
   пересланные сообщения и сообщения клиентов. Крючок вернул true —
   сообщение обработано, обычный ответ бота не нужен. */
let HOOKS = {};
let ME_NAME = '';
function setHooks(h) { HOOKS = Object.assign({}, HOOKS, h || {}); }
function botName() { return ME_NAME || String(ENV.BOT_USERNAME || '').replace(/^@/, ''); }
async function say(chatId, text, extra) {
  if (!TOKEN || !chatId) return null;
  try {
    return await tg('sendMessage', Object.assign({
      chat_id: chatId, text: String(text).slice(0, 3900), disable_web_page_preview: true,
    }, extra || {}));
  } catch (e) { console.error('[бот] не отправил сообщение: ' + e.message); return null; }
}
async function copy(toChat, fromChat, messageId) {
  if (!TOKEN || !toChat || !fromChat || !messageId) return null;
  try { return await tg('copyMessage', { chat_id: toChat, from_chat_id: fromChat, message_id: messageId }); }
  catch (e) { console.error('[бот] не переслал сообщение: ' + e.message); return null; }
}
async function hook(name, ...args) {
  if (typeof HOOKS[name] !== 'function') return false;
  try { return !!(await HOOKS[name](...args)); }
  catch (e) { console.error('[бот] ' + name + ': ' + ((e && e.message) || e)); return false; }
}

/* ── Обработка сообщений ───────────────────────────────────────────── */

async function onMessage(msg) {
  const chatId = msg.chat && msg.chat.id;
  if (!chatId) return;
  const text = String(msg.text || '').trim();
  const admin = String(ENV.ADMIN_CHAT_ID || '').trim();

  /* владелец ответил на пересланное сообщение — ответ уходит клиенту */
  if (admin && String(chatId) === admin && msg.reply_to_message && await hook('adminReply', msg)) return;

  /* «/start метка» — метка это приглашение или ссылка на карточку */
  const start = /^\/start(?:@\w+)?(?:\s+(\S+))?/.exec(text);
  if (start && start[1] && await hook('start', start[1], msg)) return;
  if (start) {
    await tg('sendMessage', {
      chat_id: chatId, text: HELLO, parse_mode: 'HTML',
      reply_markup: keyboardFor(chatId, start[1] || ''),
    });
    return;
  }

  /* /admin — владельцу кнопка админ-панели; остальным команда не нужна */
  if (/^\/admin(?:@\w+)?\b/.test(text) && isAdminChat(chatId)) {
    await tg('sendMessage', {
      chat_id: chatId,
      text: 'Админ-панель BloggerPay: выплаты, проверка личности, видео заданий, пользователи.',
      reply_markup: { inline_keyboard: [[adminButton()]] },
    });
    return;
  }

  /* /support — разговор с поддержкой: сервер передаёт его владельцу */
  if (/^\/support(?:@\w+)?\b/.test(text) && await hook('start', 'support', msg)) return;

  if (/^\/help/.test(text)) {
    await tg('sendMessage', {
      chat_id: chatId,
      text: 'Всё происходит внутри приложения: задания, чаты, кошелёк.\n\n'
          + 'Если кнопка ниже не открывается — обновите Телеграм.',
      reply_markup: keyboard(''),
    });
    return;
  }

  /* открыта заявка на счёт — сообщение уходит владельцу */
  if (await hook('message', msg)) return;

  /* На любое другое сообщение не молчим: человек написал боту, значит
     ждёт ответа. Переписки здесь нет — вся работа в приложении. */
  await tg('sendMessage', {
    chat_id: chatId,
    text: 'Я открываю приложение — переписка ведётся внутри него, в разделе «Чаты».\n\nВопрос к нам — команда /support.',
    reply_markup: keyboard(''),
  });
}

/* ── Разовая настройка бота при запуске ────────────────────────────── */

async function setup() {
  const me = await tg('getMe');
  ME_NAME = String((me && me.username) || '');
  console.log('[бот] подключился: @' + me.username + ' (' + (me.first_name || '') + ')');

  /* Кнопка рядом с полем ввода показывает список команд, а не приложение.

     Телеграм разрешает у этой кнопки только три вида: web_app, commands
     и default — обычной ссылки среди них нет. Раз сайт открывается в
     браузере, а не внутри Телеграма, мини-апп здесь оставлять нельзя:
     это был бы второй, другой способ открыть то же самое, и человек
     видел бы сайт то в окне Телеграма, то в браузере. Оставляем
     команды — /start вернёт сообщение со ссылкой. */
  await tg('setChatMenuButton', {
    menu_button: { type: 'commands' },
  });
  await tg('setMyCommands', {
    commands: [
      { command: 'start', description: 'Открыть BloggerPay' },
      { command: 'help', description: 'Как это работает' },
      { command: 'support', description: 'Написать в поддержку' },
    ],
  });
  /* Владельцу — постоянная кнопка «Админка» у поля ввода и команда /admin
     (только в его чате; у остальных кнопка меню — команды, как выше) */
  const admin0 = adminChat();
  if (admin0) {
    const url = adminUrl();
    if (/^https:\/\//i.test(url)) {
      await tg('setChatMenuButton', { chat_id: admin0, menu_button: { type: 'web_app', text: 'Админка', web_app: { url } } })
        .catch((e) => console.error('[бот] кнопка админки не поставилась: ' + ((e && e.message) || e)));
    }
    await tg('setMyCommands', {
      commands: [
        { command: 'start', description: 'Открыть BloggerPay' },
        { command: 'admin', description: 'Админ-панель' },
        { command: 'help', description: 'Как это работает' },
      ],
      scope: { type: 'chat', chat_id: Number(admin0) || admin0 },
    }).catch(() => {});
  }
  await tg('setMyDescription', {
    description: 'Рекламные задания для блогеров: публикуйте ролики и получайте деньги за просмотры.',
  }).catch(() => {});          /* не критично, если Телеграм откажет */

  console.log('[бот] кнопка меню и команды настроены');
  console.log('[бот] приложение: ' + APP_URL);
  return me;
}

/* ── Длинный опрос ─────────────────────────────────────────────────── */

let offset = 0;
let stopping = false;

async function loop() {
  while (!stopping) {
    try {
      const updates = await tg('getUpdates', {
        offset, timeout: 30, allowed_updates: ['message'],
      }, 40000);
      for (const u of updates) {
        offset = u.update_id + 1;
        if (u.message) {
          try { await onMessage(u.message); }
          catch (e) { console.error('[бот] не смог ответить:', e.message); }
        }
      }
    } catch (e) {
      if (stopping) break;
      if (e.code === 409) {
        console.error('[бот] Телеграм говорит: этого бота уже кто-то опрашивает.');
        console.error('      Остановите второй запущенный экземпляр — работать может только один.');
        await sleep(5000);
        continue;
      }
      if (e.code === 401) {
        console.error('[бот] Токен не подошёл. Проверьте BOT_TOKEN в server/.env.');
        process.exit(1);
      }
      /* Обрыв связи или тайм-аут опроса — это норма, просто ждём и снова. */
      const why = e.name === 'TimeoutError' ? 'нет ответа' : e.message;
      console.error('[бот] связь потеряна (' + why + '), пробую снова через 3 с');
      if (/fetch failed|ENOTFOUND|ETIMEDOUT|ECONNREFUSED/i.test(why)) {
        console.error('      Похоже, с этой машины не открывается ' + TG_API_BASE + '.');
        console.error('      В России Телеграм часто закрыт — поднимите прокси и укажите');
        console.error('      его адрес в server/.env → TG_API_BASE.');
      }
      await sleep(3000);
    }
  }
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/* ── Старт ─────────────────────────────────────────────────────────── */

/* boot() зовёт и server.js (бот живёт в одном процессе с сайтом), и
   запуск напрямую. Разница в том, что делать при беде: отдельному
   процессу правильно упасть, а внутри сервера — нет, иначе сайт ляжет
   из-за незаполненного токена. Поэтому boot() ничего не роняет, а
   возвращает false; решает вызывающий. */
async function boot() {
  const why = checkConfig();
  if (why) { console.error('[бот] не запущен: ' + why); return false; }
  try {
    await setup();
  } catch (e) {
    if (e.code === 401) console.error('[бот] Токен не подошёл. Проверьте BOT_TOKEN.');
    else console.error('[бот] не удалось запуститься: ' + e.message);
    return false;
  }
  /* Опрос крутится вечно — его не ждём, иначе не вернём управление. */
  loop().catch((e) => console.error('[бот] опрос прервался: ' + ((e && e.message) || e)));

  /* Владельцу — одна строка о том, что бот поднялся. Нужна после
     обновления из гита: хостинг перезапускает процесс молча, и понять,
     доехала правка или упала на старте, было неоткуда.

     Намеренно без подробностей: это сигнал «живой», а не отчёт. Отправку
     не ждём и её отказ не считаем бедой — бот уже работает. */
  /* Прямо говорим, куда поведёт кнопка и откуда взят адрес: молчаливая
     подмена адреса — ровно та беда, из-за которой люди уходили на старый
     сайт и никто этого не замечал. */
  console.log('[бот] кнопка ведёт на ' + appUrl('') + '  (адрес из ' + PICKED.from + ')');
  const other = String(ENV.APP_URL || '').trim().replace(/\/+$/, '');
  if (PICKED.from === 'PUBLIC_URL' && other && other !== APP_URL) {
    console.warn('[бот] ВНИМАНИЕ: в настройках остался APP_URL=' + other
      + ' — он не используется. Удалите его, чтобы не путал.');
  }

  const admin = String(ENV.ADMIN_CHAT_ID || '').trim();
  if (admin) {
    tg('sendMessage', { chat_id: admin, text: 'Бот обновлён' })
      .catch((e) => console.error('[бот] не удалось сообщить владельцу: ' + ((e && e.message) || e)));
  }
  return true;
}

module.exports = { boot, appUrl, keyboard, keyboardFor, adminUrl, setHooks, say, copy, botName };

/* Запущен напрямую (node server/bot.js) — работаем как отдельный процесс. */
if (require.main === module) {
  boot().then((ok) => { if (!ok) process.exit(1); });

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      stopping = true;
      console.log('\n[бот] остановлен');
      process.exit(0);
    });
  }
}
