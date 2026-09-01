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
const APP_URL = (ENV.APP_URL || '').trim();
/* Адрес API Телеграма. Меняется, если с сервера api.telegram.org
   недоступен (в России это обычное дело) — тогда сюда ставится адрес
   вашего прокси, который проксирует запросы к Телеграму один в один.
   Тот же ключ используют тесты, чтобы подставить заглушку. */
const TG_API_BASE = (ENV.TG_API_BASE || 'https://api.telegram.org').replace(/\/+$/, '');

if (!TOKEN) {
  console.error('[бот] В server/.env нет BOT_TOKEN. Возьмите его у @BotFather и впишите.');
  process.exit(1);
}
/* Телеграм открывает мини-приложения только по HTTPS — это его требование,
   не наше. С http-адресом кнопка просто не появится. */
if (!/^https:\/\//i.test(APP_URL)) {
  console.error('[бот] В server/.env нужен APP_URL — адрес приложения по HTTPS.');
  console.error('      Например: APP_URL=https://ваш-сайт.netlify.app');
  console.error('      Сейчас там: ' + (APP_URL || '(пусто)'));
  process.exit(1);
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
  '• Рекламодатель находит блогера и оплачивает размещение;',
  '• деньги замораживаются на счёте сделки и уходят исполнителю',
  '  только после выполнения работы;',
  '• комиссия со сделки — 0%.',
  '',
  'Нажмите кнопку ниже, чтобы открыть приложение.',
].join('\n');

/* Кнопка ведёт на приложение. Если человек пришёл по приглашению
   (/start r_12345), передаём метку в адрес — приложение её прочитает
   из строки запроса, как делает это вне Телеграма. */
function appUrl(payload) {
  if (!payload) return APP_URL;
  return APP_URL + (APP_URL.includes('?') ? '&' : '?') + 'startapp=' + encodeURIComponent(payload);
}
/* Кнопка — ОБЫЧНАЯ ССЫЛКА, а не мини-апп.

   Раньше здесь стоял web_app: {url}. Такая кнопка открывает сайт внутри
   Телеграма, в его собственном окне: со своей шапкой, своим жестом
   закрытия и без адресной строки. Это отдельный режим, и он навязывает
   приложению правила Телеграма.

   Обычная ссылка (url) открывает сайт в браузере телефона — как любую
   ссылку. Человек видит адрес, может добавить в закладки, поделиться,
   поставить на домашний экран. Так сделано в Canvas, так надёжнее и
   так проще: сайту не нужно быть мини-аппом вообще. */
function keyboard(payload) {
  return { inline_keyboard: [[{ text: '🌐 Открыть BloggerPay', url: appUrl(payload) }]] };
}

/* ── Обработка сообщений ───────────────────────────────────────────── */

async function onMessage(msg) {
  const chatId = msg.chat && msg.chat.id;
  if (!chatId) return;
  const text = String(msg.text || '').trim();

  /* «/start метка» — метка это приглашение или ссылка на карточку */
  const start = /^\/start(?:@\w+)?(?:\s+(\S+))?/.exec(text);
  if (start) {
    await tg('sendMessage', {
      chat_id: chatId, text: HELLO, parse_mode: 'HTML',
      reply_markup: keyboard(start[1] || ''),
    });
    return;
  }

  if (/^\/help/.test(text)) {
    await tg('sendMessage', {
      chat_id: chatId,
      text: 'Всё происходит внутри приложения: сделки, чаты, кошелёк.\n\n'
          + 'Если кнопка ниже не открывается — обновите Телеграм.',
      reply_markup: keyboard(''),
    });
    return;
  }

  /* На любое другое сообщение не молчим: человек написал боту, значит
     ждёт ответа. Переписки здесь нет — вся работа в приложении. */
  await tg('sendMessage', {
    chat_id: chatId,
    text: 'Я открываю приложение — переписка ведётся внутри него, в разделе «Чаты».',
    reply_markup: keyboard(''),
  });
}

/* ── Разовая настройка бота при запуске ────────────────────────────── */

async function setup() {
  const me = await tg('getMe');
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
    ],
  });
  await tg('setMyDescription', {
    description: 'Биржа рекламы у блогеров. Деньги под защитой сделки, комиссия 0%.',
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

setup()
  .then(loop)
  .catch((e) => {
    if (e.code === 401) console.error('[бот] Токен не подошёл. Проверьте BOT_TOKEN в server/.env.');
    else console.error('[бот] не удалось запуститься:', e.message);
    process.exit(1);
  });

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    stopping = true;
    console.log('\n[бот] остановлен');
    process.exit(0);
  });
}
