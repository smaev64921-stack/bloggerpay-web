/* ══════════════════════════════════════════════════════════════════════
   BloggerPay — сервер-касса. Этап 3 плана запуска.

   Зачем он есть: до сих пор правила денег исполнялись в браузере
   пользователя — баланс переписывался из консоли за три строки, а
   журнал операций обрезался. Здесь деньги живут там, где пользователь
   их не может тронуть.

   Три правила, на которых всё держится:

   1. БАЛАНС НЕ ХРАНИТСЯ. Он считается как сумма журнала операций
      (таблица ledger). Расхождение невозможно по построению: нет
      второго числа, которое могло бы разойтись с первым.

   2. ЖУРНАЛ ТОЛЬКО РАСТЁТ. Ни одна строка не правится и не удаляется.
      Отмена — это новая, встречная запись.

   3. ОДНА ОПЕРАЦИЯ ПРОВОДИТСЯ ОДИН РАЗ. Каждый денежный запрос несёт
      opKey — ключ идемпотентности. Повтор с тем же ключом (двойное
      нажатие, обрыв сети, повторная вкладка) возвращает старый
      результат и не трогает деньги.

   Запуск:   node server/server.js        (настройки — server/.env)
   Зависимостей нет: node:http, node:sqlite, node:crypto (Node 22.5+).

   Чего здесь НЕТ и что появится при подключении настоящих платежей:
   пополнение сейчас тестовое (эндпоинт /api/topup помечен), выплаты
   оператор проводит руками и отмечает в админ-реестре.
   ══════════════════════════════════════════════════════════════════════ */

'use strict';

/* Второй сервер — ретранслятор (15.10.2026, переезд в Россию). Сайт,
   касса и база живут на российском сервере, а этот же код на прежнем,
   нидерландском, запущен с BP_MODE=relay: без базы и без бота, только
   пересылает запросы к площадкам, закрытым из России, и переадресует
   старый адрес на новый. Устройство — в relay.js. */
if (String(process.env.BP_MODE || '').trim().toLowerCase() === 'relay') {
  require('./relay.js').runRelay();
  return;
}

const http = require('node:http');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
/* База встроена в сам Node и появилась только в 22.5. На версии постарше
   require падает с «No such built-in module: node:sqlite» — стеком, по
   которому непонятно, что делать. Ловим и объясняем: беда не в коде, а в
   версии Node на хостинге. */
let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (e) {
  console.error('');
  console.error('  ✖ BloggerPay не запустится на этой версии Node.');
  console.error('');
  console.error('    Нужен Node 22.5 или новее, сейчас ' + process.version + '.');
  console.error('    Причина: база данных встроена в сам Node (node:sqlite)');
  console.error('    и появилась только в 22.5 — на ' + process.version + ' её просто нет.');
  console.error('');
  console.error('    Что сделать на хостинге:');
  console.error('      · если он умеет собирать по Dockerfile — он лежит в корне');
  console.error('        проекта и уже указывает Node 22, включите сборку из него;');
  console.error('      · если версия задаётся в панели — поставьте 22 или новее.');
  console.error('');
  process.exit(1);
}
const { sendCodeEmail, reachableOutside, externalBase, mailConfigured } = require('./mail');

/* ── Настройки из .env ─────────────────────────────────────────────── */

function loadEnv(file) {
  const out = {};
  try {
    const txt = fs.readFileSync(file, 'utf8');
    for (const line of txt.split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (m && !line.trim().startsWith('#')) out[m[1]] = m[2];
    }
  } catch (e) { /* .env не обязателен — работают значения по умолчанию */ }
  return out;
}

const ENV = Object.assign(loadEnv(path.join(__dirname, '.env')), process.env);
/* Площадки, закрытые из России (Телеграм, TikTok, Instagram, YouTube,
   почта), — через ретранслятор в Нидерландах, если задан RELAY_URL. */
require('./relay.js').installFetchRelay(ENV);
const PORT = Number(ENV.PORT) || 8090;
const DB_PATH = ENV.DB_PATH || path.join(__dirname, 'data', 'bloggerpay.db');
const ADMIN_KEY = ENV.ADMIN_KEY || '';
const ORIGIN = ENV.ORIGIN || '*';
/* Токен бота из BotFather. Пока его нет, вход по Телеграму отключён —
   приложение работает по email и паролю, как раньше. */
const BOT_TOKEN = ENV.BOT_TOKEN || '';

/* ── Почта (восстановление пароля) ──────────────────────────────────
   Ключ Resend и адрес отправителя лежат в .env. Модуль mail.js читает
   их из process.env, поэтому переливаем сюда. MAIL_DEBUG=1 — режим
   отладки: код возвращается прямо в ответе /api/password/forgot, чтобы
   проверять поток без настоящей почты. На бою ДОЛЖЕН быть выключен. */
for (const k of ['RESEND_API_KEY', 'MAIL_FROM', 'MAIL_REPLY_TO', 'MAIL_LOGO_URL', 'APP_URL', 'PUBLIC_URL']) {
  if (ENV[k] != null) process.env[k] = ENV[k];
}
let MAIL_DEBUG = String(ENV.MAIL_DEBUG || '') === '1';   /* ниже гасится, если сервер виден снаружи */

/* Письмо без кода: вместо цифр — кнопка «Открыть», код показывается на
   странице /r/<метка> по нажатию. Выключается MAIL_LINK=0, если почему-то
   захочется вернуть код прямо в письмо. Ниже, после PUBLIC_URL, режим
   гасится сам, когда сервер не виден снаружи. */
let PW_LINK_ON = String(ENV.MAIL_LINK == null ? '1' : ENV.MAIL_LINK) !== '0';

/* ── НАСТОЯЩИЙ ПРИЁМ ДЕНЕГ: ЮKassa ─────────────────────────────────
   Ключи выдаёт кабинет yookassa.ru (нужен договор с юр. лицом или ИП):
   shopId и секретный ключ. Пока их нет — касса честно отвечает, что не
   настроена, а пополнение работает в тестовом режиме.

   КАК ТОЛЬКО КЛЮЧИ ПОЯВЛЯЮТСЯ, тестовое пополнение выключается само:
   на боевом сервере не должно быть кнопки, которая рисует деньги. Без
   ключей его можно выключить руками — TEST_TOPUP=0 в .env. */
const YK_SHOP_ID = ENV.YOOKASSA_SHOP_ID || '';
const YK_SECRET = ENV.YOOKASSA_SECRET_KEY || '';
const YK_ON = !!(YK_SHOP_ID && YK_SECRET);
/* Заполнен только один ключ из двух — это ошибка настройки, а не «кассы
   нет»: тестовое пополнение в этом случае НЕ включаем (иначе опечатка в
   .env открыла бы печать денег на бою), пополнение выключено совсем. */
const YK_PARTIAL = !YK_ON && !!(YK_SHOP_ID || YK_SECRET);
const TEST_TOPUP = !YK_ON && !YK_PARTIAL && String(ENV.TEST_TOPUP == null ? '1' : ENV.TEST_TOPUP) !== '0';
if (YK_PARTIAL) {
  console.error('[BloggerPay] В .env заполнен только один ключ ЮKassa из двух'
    + ' (YOOKASSA_SHOP_ID и YOOKASSA_SECRET_KEY) — касса не работает, пополнение выключено.');
}
/* Куда вернуть человека после оплаты (адрес мини-аппа или t.me-ссылка) */
const PAY_RETURN_URL = ENV.PAY_RETURN_URL || 'https://t.me';

/* Подтверждение владения каналом. Человек входит в свой аккаунт на
   площадке, площадка сообщает нам, чей это канал — подделать это,
   в отличие от вставленной ссылки, нельзя.

   Ключи берутся в кабинетах разработчика:
     YouTube — console.cloud.google.com, OAuth-клиент, доступ
               youtube.readonly (только чтение: имя канала и счётчики);
     TikTok  — developers.tiktok.com, Login Kit, доступ user.info.basic.
   Пока ключей нет, кнопка «Подтвердить» честно говорит, что проверка
   ещё не настроена. */
/* Свой внешний адрес. Хостинг может подставить его сам (Bothost кладёт
   домен в DOMAIN), и тогда настраивать ничего не надо. Если внешнего
   адреса нет — работаем как локальный сервер. */
const PUBLIC_URL = externalBase(ENV)
  || (ENV.PUBLIC_URL || ('http://127.0.0.1:' + (Number(ENV.PORT) || 8090))).replace(/\/+$/, '');
/* Куда площадки возвращают человека после входа: redirect_uri у TikTok,
   YouTube, Instagram и Google, origin входа через Телеграм. Обычно это
   сам сервер. После переезда в Россию (15.10.2026) здесь СТАРЫЙ адрес:
   он прописан в кабинетах TikTok и Google, проверка приложения TikTok
   идёт по нему же, а ретранслятор на нём переадресует человека сюда.
   Менять — только вместе с адресами возврата в кабинетах площадок. */
const OAUTH_BASE = (() => {
  const v = String(ENV.OAUTH_BASE || '').trim().replace(/\/+$/, '');
  return /^https:\/\/[^\s/]+\.[^\s/]+$/i.test(v) ? v : PUBLIC_URL;
})();
/* Письмо-ссылка имеет смысл ТОЛЬКО если сервер виден снаружи. Проверять
   одну схему мало: значение по умолчанию — http://127.0.0.1:<порт> —
   схему имеет, и режим включался бы сам собой. Тогда человек получал бы
   письмо без кода и с кнопкой на СВОЙ localhost: восстановить пароль
   нечем, и ломается это молча — Resend отвечает «отправлено».

   Поэтому отбрасываем всё, что заведомо не адрес в интернете: петля,
   .local и частные подсети. В этих случаях письмо честно печатает код
   внутри себя, как раньше. */
if (!/^https?:\/\//i.test(PUBLIC_URL) || !reachableOutside(PUBLIC_URL)) PW_LINK_ON = false;
/* Отладка почты живёт только на своей машине: публичный адрес значит,
   что сервер виден снаружи, и код прямо в ответе отдаёт чужие аккаунты
   любому, кто знает чей-то email. Гасим сами, молча не оставляем. */
if (MAIL_DEBUG && /^https?:\/\//i.test(PUBLIC_URL) && reachableOutside(PUBLIC_URL)) {
  MAIL_DEBUG = false;
  console.error('[BloggerPay] MAIL_DEBUG=1 отключён принудительно: сервер виден'
    + ' снаружи (' + PUBLIC_URL + '). В этом режиме код восстановления и код'
    + ' вывода возвращаются прямо в ответе. Для тестов запускайте локально.');
}
/* Сервер виден из интернета — значит его открывает кто угодно. */
const SERVER_IS_PUBLIC = /^https?:/i.test(PUBLIC_URL) && reachableOutside(PUBLIC_URL);
/* Кому доступно тестовое пополнение. На своей машине — всем, кто вошёл;
   на публичном сервере — только владельцу, если не сказано иначе. */
const TEST_TOPUP_OPEN_SET = String(ENV.TEST_TOPUP_OPEN || '') === '1';
const TEST_TOPUP_OPEN = TEST_TOPUP_OPEN_SET || !SERVER_IS_PUBLIC;
if (TEST_TOPUP && !TEST_TOPUP_OPEN) {
  console.error('[BloggerPay] Тестовое пополнение оставлено только владельцу:'
    + ' сервер виден снаружи (' + PUBLIC_URL + '). Остальным пополнение отвечает,'
    + ' что оплата идёт через кассу. Открыть всем — TEST_TOPUP_OPEN=1.');
}
/* Тестовые деньги на боевом адресе (аудит 16.10.2026). Пока сервер виден
   снаружи и тестовое пополнение открыто всем, любой вошедший «пополняет»
   баланс без оплаты — балансы ненастоящие. Тогда вывод закрыт (иначе
   напечатанное уходило бы наружу настоящими рублями), /admin показывает
   красную плашку, владельцу при запуске — тревога. Перед запуском:
   TEST_TOPUP=0 и пустой TEST_TOPUP_OPEN (ЗАПУСК.md). */
const TEST_MONEY_PUBLIC = TEST_TOPUP && TEST_TOPUP_OPEN_SET && SERVER_IS_PUBLIC;
const TEST_MONEY_MSG = 'Тестовое пополнение открыто всем — перед запуском убрать TEST_TOPUP_OPEN, TEST_TOPUP=0';
/* Метка тестовых зачислений в журнале: kind остаётся 'topup' (сверка
   «внесено − выплачено = в системе» обязана сходиться и с ними), а по ref
   их видно и считают отдельно — /admin показывает «из них тестовых». */
const TEST_TOPUP_REF = 'тестовое пополнение';
const TEST_TOPUP_FEE_REF = 'комиссия тестового пополнения';
if (TEST_MONEY_PUBLIC) {
  console.error('[BloggerPay] ВНИМАНИЕ: ' + TEST_MONEY_MSG + '. Сервер виден снаружи ('
    + PUBLIC_URL + '): любой вошедший пополняет баланс без оплаты, поэтому вывод закрыт.');
}

/* Кавычки и пробелы вокруг значения — самая частая причина «неизвестный
   client_key»: площадка получает ключ вместе с ними и не узнаёт его. */
const cleanKey = (v) => String(v == null ? '' : v).trim().replace(/^["']+|["']+$/g, '').trim();
/* Свои адреса площадки: сюда вписывают прокси, если напрямую не пускают. */
const quality = require('./quality.js');
const TT_AUTH_BASE = (cleanKey(ENV.TT_AUTH_BASE) || 'https://www.tiktok.com').replace(/\/+$/, '');
const TT_API_BASE = (cleanKey(ENV.TT_API_BASE) || 'https://open.tiktokapis.com').replace(/\/+$/, '');
/* Сайт площадки (06.10.2026, «Привязать видео»): по нему раскрываем
   короткие ссылки vm./vt.tiktok.com и спрашиваем oEmbed. Отдельно от
   TT_API_BASE: это разные хосты, и в проверках их подменяют по-разному. */
const TT_WEB_BASE = (cleanKey(ENV.TT_WEB_BASE) || 'https://www.tiktok.com').replace(/\/+$/, '');
/* YouTube для «Загрузить видео» (06.10.2026, механика v2). YT_API_BASE —
   куда сервер ходит за данными роликов и канала (videos.list,
   channels.list), YT_OAUTH_BASE — где меняет код и refresh на доступ
   (подтверждение канала и обновление доступа). В проверках обе
   подменяются поддельной площадкой. Вход через Google живёт отдельно и
   этих адресов не касается.
   YT_API_KEY — ключ API из Google Cloud (YouTube Data API v3): с ним
   публичные цифры ролика берутся без доступа к каналу блогера, а
   владение сверяется по channelId. Без ключа — доступом выбранного
   канала (его даёт подтверждение с access_type=offline). */
const YT_API_BASE = (cleanKey(ENV.YT_API_BASE) || 'https://www.googleapis.com').replace(/\/+$/, '');
const YT_OAUTH_BASE = (cleanKey(ENV.YT_OAUTH_BASE) || 'https://oauth2.googleapis.com').replace(/\/+$/, '');
const YT_TOKEN_URL = YT_OAUTH_BASE + '/token';
const YT_API_KEY = cleanKey(ENV.YT_API_KEY);
/* Instagram (15.10.2026, владелец: «добавь полностью соцсеть инсту и
   шортс»): «Instagram API with Instagram Login» от Meta — вход
   ПРОФЕССИОНАЛЬНЫМ аккаунтом (Автор или Бизнес; личный Instagram площадка
   не пускает). Права: instagram_business_basic — профиль и список
   публикаций, instagram_business_manage_insights — просмотры ролика.
   Ключи — IG_CLIENT_ID / IG_CLIENT_SECRET (кабинет Meta → Instagram → API
   setup with Instagram login). IG_AUTH_BASE — куда отправляем человека,
   IG_API_BASE — обмен кода на доступ, IG_GRAPH_BASE — данные; в проверках
   все три подменяет поддельная площадка. IG_GRAPH_VER — версия Graph API
   (пусто — та, что выбрана в приложении Meta). */
const IG_AUTH_BASE = (cleanKey(ENV.IG_AUTH_BASE) || 'https://www.instagram.com').replace(/\/+$/, '');
const IG_API_BASE = (cleanKey(ENV.IG_API_BASE) || 'https://api.instagram.com').replace(/\/+$/, '');
const IG_GRAPH_BASE = (cleanKey(ENV.IG_GRAPH_BASE) || 'https://graph.instagram.com').replace(/\/+$/, '');
const IG_GRAPH_VER = cleanKey(ENV.IG_GRAPH_VER).replace(/^\/+|\/+$/g, '');
/* YouTube Shorts (15.10.2026): задание может принимать ТОЛЬКО Shorts. Shorts
   ли ролик, спрашиваем у самого сайта: youtube.com/shorts/<id> у обычного
   видео уводит на /watch, у Shorts отвечает страницей. YT_WEB_BASE — чтобы
   проверки подставили свою площадку. */
const YT_WEB_BASE = (cleanKey(ENV.YT_WEB_BASE) || 'https://www.youtube.com').replace(/\/+$/, '');
/* Механика v3 (07.10.2026, VIDEO-SPEC.md, раздел 11): засчитанный ролик
   считается VID_TRACK_DAYS суток ОТ ЗАЧЁТА — раз в сутки сервер сам
   снимает просмотры и доначисляет прибавку на баланс блогера, пока не
   упрётся в максимум за ролик или не выйдет срок. Пустое или мусор — 30. */
const VID_TRACK_DAYS = (() => {
  const raw = String(ENV.VID_TRACK_DAYS == null ? '' : ENV.VID_TRACK_DAYS).trim();
  const n = Number(raw);
  return raw !== '' && Number.isFinite(n) && n >= 0 ? n : 30;
})();
const VID_TRACK_MS = Math.round(VID_TRACK_DAYS * 864e5);
/* Срок подсчёта вышел, а финальный замер не удаётся (сбой площадки):
   после VID_PAY_TRIES неудач подряд подсчёт закрывается по последнему
   удачному замеру — нового ничего не начисляется, владельцу пометка. */
const VID_PAY_TRIES = 3;
/* Сколько часов ролик может ждать проверки рекламодателя. Молчит дольше —
   ролик засчитывается сам (decision = 'auto'): иначе молчанием можно было
   бы держать блогера без денег бесконечно. Пустое или мусор — 72 часа. */
const VID_AUTO_ACCEPT_MS = (() => {
  const raw = String(ENV.VID_AUTO_ACCEPT_H == null ? '' : ENV.VID_AUTO_ACCEPT_H).trim();
  const n = Number(raw);
  return Math.round((raw !== '' && Number.isFinite(n) && n > 0 ? n : 72) * 3600e3);
})();
/* Куда возвращать человека после площадки: обычно это сам сайт, который
   раздаёт этот же сервер. APP_URL нужен, только если сайт живёт отдельно.

   Пока сервер виден из интернета — он И ЕСТЬ сайт, и APP_URL не должен
   его пересиливать (05.09.2026). Забытая в панели переменная со старым
   адресом уводила людей на прошлую выкладку: туда уезжали и сообщение
   бота об обновлении, и метка входа через Google, и пропуск канала.
   Ровно такой порядок уже действует в bot.js (pickAppUrl). */
const APP_BASE = (SERVER_IS_PUBLIC
  ? PUBLIC_URL
  : (String(ENV.APP_URL || '').trim().replace(/\/+$/, '') || PUBLIC_URL)) + '/';


/* ── Вход через Telegram в обычном браузере ────────────────────────
   BotFather у этого бота даёт ровно одну настройку — домен («Set domain»),
   то есть классический Login Widget. Ключей приложения он не выдаёт, и
   они здесь не нужны: подпись ответа проверяется ключом SHA256 от токена
   бота, который у сервера уже есть.

   Порядок: человек уходит на oauth.telegram.org, подтверждает вход, и
   Телеграм возвращает его на наш адрес с полями id, first_name,
   last_name, username, photo_url, auth_date и hash. Проверка подписи
   дословно по документации: строка сверки — все поля кроме hash,
   отсортированные по алфавиту, «ключ=значение» через перевод строки;
   secret_key = SHA256(токен бота); сверяем HMAC-SHA256.

   Прежняя проверка initData (checkInitData) осталась для мини-аппа — там
   другой формат подписи и другой ключ. */
const TG_WIDGET_AUTH = 'https://oauth.telegram.org/auth';
const TG_BOT_ID = String(BOT_TOKEN).split(':')[0] || '';
/* Срок годности подписанного ответа виджета. Было сутки: ответ лежит в
   адресе возврата (история браузера, журналы прокси), и кто его увидел,
   сутки заводил сессии чужого аккаунта на СВОЕЙ метке. Теперь
   (аудит 16.10): десять минут, ответ не старше начала ЭТОГО входа
   (since) и каждый ответ срабатывает ОДИН раз — использованные hash
   помним до конца их срока. */
const TG_AUTH_MAX_AGE = 10 * 60;
const tgUsedHash = new Map();     /* hash → когда можно забыть (мс) */
function tgUsedSweep() {
  const now = Date.now();
  for (const [k, v] of tgUsedHash) if (v <= now) tgUsedHash.delete(k);
}

function tgWidgetCheck(fields, since) {
  if (!BOT_TOKEN) return { ok: false, why: 'Вход через Телеграм не настроен: нет токена бота' };
  const got = {};
  for (const k of Object.keys(fields || {})) {
    if (k === 'hash') continue;
    const v = fields[k];
    if (v == null || v === '') continue;
    got[k] = String(v);
  }
  if (!got.id || !got.auth_date) return { ok: false, why: 'Телеграм прислал неполный ответ' };

  const line = Object.keys(got).sort().map((k) => k + '=' + got[k]).join('\n');
  const secret = crypto.createHash('sha256').update(BOT_TOKEN).digest();
  const want = crypto.createHmac('sha256', secret).update(line).digest('hex');
  const given = String((fields && fields.hash) || '').toLowerCase();
  const a = Buffer.from(want, 'utf8');
  const b = Buffer.from(given, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, why: 'Подпись Телеграма не сошлась' };
  }
  const age = Math.floor(Date.now() / 1000) - Number(got.auth_date);
  if (!(age >= -60 && age <= TG_AUTH_MAX_AGE)) {
    return { ok: false, why: 'Ответ Телеграма просрочен — начните вход заново' };
  }
  /* Ответ выдан раньше, чем начался этот вход, — значит, он чужой или
     старый (две минуты — на расхождение часов с Телеграмом). */
  if (since && Number(got.auth_date) < Math.floor(Number(since) / 1000) - 120) {
    return { ok: false, why: 'Ответ Телеграма просрочен — начните вход заново' };
  }
  tgUsedSweep();
  if (tgUsedHash.has(given)) {
    return { ok: false, why: 'Этот ответ Телеграма уже использован — начните вход заново' };
  }
  tgUsedHash.set(given, Date.now() + (TG_AUTH_MAX_AGE + 180) * 1000);
  return {
    ok: true,
    tg: {
      id: got.id,
      name: [got.first_name, got.last_name].filter(Boolean).join(' ').trim() || got.username || '',
      username: got.username || '',
      photo: got.photo_url || '',
    },
  };
}

/* Служебная почта — не ящик: её ставят аккаунтам, заведённым входом через
   Телеграм (tg<id>@telegram.local) или через Google без почты
   (g<sub>@google.local). Писем на неё не доставить, войти по ней нельзя
   (аудит 16.10.2026: код вывода уходил на tg…@telegram.local). */
function isServiceEmail(e) { return /@(telegram|google)\.local$/i.test(String(e || '')); }
/* Предел длины почты — 254 знака (RFC 5321). Без него регистрация
   принимала адрес на 60 000 знаков: мусор в users, в /admin, в тревогах и
   письмах (аудит 16.10.2026). Имя режется до 120, пароль — до 200. */
const EMAIL_MAX = 254;
const PASS_MAX = 200;

/* Аккаунт без своего пароля (16.10.2026): заведён входом через Телеграм
   или Google, в поле хеша — случайный мусор. Такой соли даём метку
   «nopw:» — по ней «Настройки» позволяют ЗАДАТЬ пароль без «текущего»
   (раньше аккаунт Google с настоящей почтой просили ввести текущий
   пароль, которого нет, и после пяти попыток запирали). Свой пароль
   (регистрация, сброс по коду, «Почта и пароль», смена) пишется с
   обычной солью — метка уходит сама. Аккаунты, заведённые до метки,
   считаются «с паролем»: для них есть «Забыли пароль?». */
const NOPW_SALT = 'nopw:';
function deadSalt() { return NOPW_SALT + crypto.randomBytes(16).toString('hex'); }
function hasOwnPass(u) {
  return !!u && !isServiceEmail(u.email) && String(u.pass_salt || '').indexOf(NOPW_SALT) !== 0;
}

function tgAccount(tgId, name, role) {
  let u = q.userByTg.get(String(tgId));
  if (u) return u;
  /* Пароля у такого аккаунта нет: вход только через Телеграм, поэтому в
     поля хеша кладём случайный мусор, которым войти нельзя. */
  let email = 'tg' + tgId + '@telegram.local';
  if (q.userByEmail.get(email)) email = 'tg' + tgId + '.' + crypto.randomBytes(3).toString('hex') + '@telegram.local';
  const salt = deadSalt();   /* метка «своего пароля нет» — см. hasOwnPass */
  const dead = crypto.randomBytes(32).toString('hex');
  try {
    q.insTgUser.run(email, String(name || '').trim().slice(0, 120) || ('Пользователь ' + tgId),
      role === 'advertiser' ? 'advertiser' : 'blogger', salt, dead, String(tgId));
  } catch (e) { return null; }
  return q.userByTg.get(String(tgId));
}

const OAUTH = {
  youtube: {
    id: cleanKey(ENV.YT_CLIENT_ID), secret: cleanKey(ENV.YT_CLIENT_SECRET),
    auth: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    scope: 'https://www.googleapis.com/auth/youtube.readonly',
    label: 'YouTube',
  },
  tiktok: {
    id: cleanKey(ENV.TT_CLIENT_KEY), secret: cleanKey(ENV.TT_CLIENT_SECRET),
    /* TT_AUTH_BASE — куда отправляем человека (по умолчанию сам TikTok);
       TT_API_BASE — куда сервер ходит за токеном и данными аккаунта.
       Второе важнее: браузер человека может быть за VPN, а сервер нет. */
    auth: TT_AUTH_BASE + '/v2/auth/authorize/',
    token: TT_API_BASE + '/v2/oauth/token/',
    userInfo: TT_API_BASE + '/v2/user/info/',
    /* Список прав задаётся настройкой: пока приложение не прошло проверку,
       TikTok выдаёт только user.info.basic, а запрос лишнего права —
       ещё одна стена после ключа. */
    /* video.list — то самое право, без которого не видно ни просмотров,
       ни лайков, ни комментариев по роликам, а значит нечем отличить
       живой канал от накрученного. */
    scope: cleanKey(ENV.TT_SCOPE) || 'user.info.basic,user.info.profile,user.info.stats,video.list',
    videos: TT_API_BASE + '/v2/video/list/',
    label: 'TikTok',
  },
  instagram: {
    id: cleanKey(ENV.IG_CLIENT_ID), secret: cleanKey(ENV.IG_CLIENT_SECRET),
    auth: IG_AUTH_BASE + '/oauth/authorize',
    token: IG_API_BASE + '/oauth/access_token',
    /* права — через запятую: так их ждёт Instagram */
    scope: cleanKey(ENV.IG_SCOPE) || 'instagram_business_basic,instagram_business_manage_insights',
    label: 'Instagram',
  },
};
/* Виды конвертов, которые приложение применяет к данным ТОГО, КТО ИХ
   ПОЛУЧИЛ, не спрашивая отправителя: профиль (prof), личные настройки
   и избранное (mine), свободные дни (slot). Такой конверт человек
   пишет только сам себе — проверка в POST /api/sync/put. */
const SELF_KINDS = new Set(['prof', 'mine', 'slot']);
/* ── Пределы обмена /api/sync (аудит 16.10.2026) ──
   Было: ограничены только размер одной записи (400 КБ) и частота
   (240/мин). Любой вошедший клал общие конверты-задания без счёта —
   каждый из них уезжал в ленту КАЖДОГО вошедшего и в его хранилище, а
   база росла без границы (проверено: 80 «заданий» блогера подряд — все
   приняты и все у постороннего в первой синхронизации).
   Стало:
     · заданий «в работе» (active/paused) у автора — не больше 50,
       всего заданий у автора — не больше 500 (409 camp_limit);
     · записей человека (последний писавший, from_id) — не больше 100 000,
       их объём — не больше 100 МБ (409 / 413 sync_limit); переписать своё
       меньшим можно всегда;
     · новых «холодных» личных диалогов (нет ни прежней переписки, ни
       общего задания, ни иной записи на двоих) — не больше 30 в сутки
       (429 dm_new_limit): адресный спам по номерам людей.
   Числа можно поднять переменными окружения. */
const SYNC_CAMP_LIVE = Math.max(1, Math.floor(Number(ENV.SYNC_CAMP_LIVE) || 50));
const SYNC_CAMP_ALL = Math.max(SYNC_CAMP_LIVE, Math.floor(Number(ENV.SYNC_CAMP_ALL) || 500));
const SYNC_USER_ROWS = Math.max(10, Math.floor(Number(ENV.SYNC_USER_ROWS) || 100000));
const SYNC_USER_BYTES = Math.max(1, Number(ENV.SYNC_USER_MB) || 100) * 1024 * 1024;
const DM_NEW_PER_DAY = Math.max(1, Math.floor(Number(ENV.DM_NEW_PER_DAY) || 30));
const CAMP_LIVE_ST = new Set(['active', 'paused']);
/* Занятое человеком: счёт из базы раз в 10 минут, между ними — по каждой
   записи (+ новое, − то, что переписано). Удаления в обход put (стирание
   данных по обращению) сойдутся при следующем пересчёте. */
const syncUseCache = new Map();
function syncUseOf(uid) {
  const now = Date.now();
  let e = syncUseCache.get(uid);
  if (!e || now - e.at > 10 * 60000) {
    if (syncUseCache.size > 20000) syncUseCache.clear();
    const r = q.syncUse.get(uid) || {};
    e = { n: Number(r.n) || 0, b: Number(r.b) || 0, at: now };
    syncUseCache.set(uid, e);
  }
  return e;
}
function syncUseAdd(uid, dn, dbytes) {
  const e = syncUseCache.get(uid);
  if (e) { e.n = Math.max(0, e.n + dn); e.b = Math.max(0, e.b + dbytes); }
}
function campLiveStatus(s) { return CAMP_LIVE_ST.has(String(s == null ? '' : s)); }
function campLiveCount(uid, exceptRid) {
  try { return Number((q.campCountLive.get(uid, String(exceptRid || '')) || {}).n) || 0; }
  catch (e) { return 0; }
}
const campLimitBody = { error: 'Одновременно можно вести не больше ' + SYNC_CAMP_LIVE
  + ' заданий — завершите одно из запущенных', code: 'camp_limit' };
/* Новые «холодные» личные диалоги: связь двух людей запоминаем (она не
   исчезает), счёт новых — по своим часам за последние сутки. */
const dmTieKnown = new Set();
const dmNewLog = new Map();
function dmTied(x, y) {
  const k = Math.min(x, y) + ':' + Math.max(x, y);
  if (dmTieKnown.has(k)) return true;
  if (!q.syncTie.get(x, y, y, x, x, y, y, x, y, x, x, y)) return false;
  if (dmTieKnown.size > 100000) dmTieKnown.clear();
  dmTieKnown.add(k);
  return true;
}
function dmNewAllowed(uid) {
  const now = Date.now();
  const arr = (dmNewLog.get(uid) || []).filter((t) => now - t < 864e5);
  if (arr.length >= DM_NEW_PER_DAY) { dmNewLog.set(uid, arr); return false; }
  arr.push(now);
  if (dmNewLog.size > 20000) dmNewLog.clear();
  dmNewLog.set(uid, arr);
  return true;
}
/* Конверт переписывается тем же содержимым с новым ver: лента отдаст его
   ещё раз (нужно, когда бюджет задания заморозили после записи). */
function syncBump(kind, rid) {
  try {
    const ex = q.syncGet.get(kind, rid);
    if (!ex) return;
    db.exec('BEGIN IMMEDIATE');
    try {
      q.syncDel.run(kind, rid);
      q.syncIns.run(kind, rid, ex.a_id, ex.b_id, ex.from_id, ex.data, ex.created_at);
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch (_) {}
      throw e;
    }
  } catch (e) { console.error('[sync] не удалось обновить конверт', kind, rid, e && e.message); }
}
/* Бюджет задания вернули целиком (завершили, удалили, вернули всё): если
   конверт ещё «active»/«paused» — переписываем его со статусом «done» и
   новым ver (аудит 16.10.2026). Удаление в приложении конверта не
   отправляло вовсе, и удалённое задание у всех блогеров так и стояло
   «активным». Автор, адресат и время создания — прежние. */
function syncCampClose(rid) {
  try {
    const ex = q.syncGet.get('camp', String(rid));
    if (!ex) return false;
    let d = null;
    try { d = JSON.parse(ex.data); } catch (e) { return false; }
    if (!d || typeof d !== 'object' || (d.status !== 'active' && d.status !== 'paused')) return false;
    d.status = 'done';
    db.exec('BEGIN IMMEDIATE');
    try {
      q.syncDel.run('camp', ex.rid);
      q.syncIns.run('camp', ex.rid, ex.a_id, ex.b_id, ex.from_id, JSON.stringify(d), ex.created_at);
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch (_) {}
      throw e;
    }
    tsumCache.at = 0;
    return true;
  } catch (e) { console.error('[sync] не удалось закрыть задание', rid, e && e.message); return false; }
}
/* Комиссии сервиса (14.10.2026, решение владельца):
   · пополнение — 7% СВЕРХУ суммы: просит 10 000 ₽ на баланс — платит 10 700 ₽;
   · задание — 7% сверху бюджета с рекламодателя (бюджет 10 000 ₽ — со счёта
     10 700 ₽, все 10 000 ₽ идут на выплаты) и 7% с каждой выплаты блогеру
     (начислено 100 ₽ — на баланс 93 ₽). Ставки пишутся в строку заморозки
     задания при запуске: у заданий, запущенных раньше, комиссии нет;
   · вывод — без комиссии (было 4%). Заявки, поданные раньше, выплачиваются
     как были поданы (fee/net записаны в заявке). */
/* Ставки можно переопределить переменными окружения (целые проценты 0–30):
   так наборы проверок механики начислений гоняются без комиссий, а комиссии
   проверяет свой набор (test-fees.mjs). На бою — значения по умолчанию. */
function feeEnv(k, d) {
  const raw = ENV[k];
  const v = Math.round(Number(raw));
  return raw != null && String(raw).trim() !== '' && Number.isFinite(v) && v >= 0 && v <= 30 ? v : d;
}
const FEE_PCT = feeEnv('WITHDRAW_FEE_PCT', 0);       /* комиссия при выводе — убрана 14.10.2026 */
const TOPUP_FEE_PCT = feeEnv('TOPUP_FEE_PCT', 7);    /* пополнение: сверху суммы */
const TASK_FEE_PCT = feeEnv('TASK_FEE_PCT', 7);      /* рекламодатель: сверху бюджета задания */
const PAYOUT_FEE_PCT = feeEnv('PAYOUT_FEE_PCT', 7);  /* блогер: с каждой выплаты за задание */
/* процент от суммы в рублях (целые рубли, округление до ближайшего) */
function pctOf(sum, pct) { return Math.round((Number(sum) || 0) * (Number(pct) || 0) / 100); }
/* Комиссия задания с рекламодателя — по каждой операции отдельно, поэтому
   округление не должно давать обхода (разбор 15.10.2026): бюджет, пополненный
   по 7 ₽, шёл без комиссии (0,49 → 0), а возврат по 8 ₽ отдавал лишнюю (0,56 → 1).
   Взять — вверх, вернуть часть — вниз; закрытие задания возвращает всю
   невыбранную комиссию (dealFeeBackAll). За потраченное держим % тоже с
   округлением вверх, и комиссия с выплат блогеру — так же, по накопленному:
   иначе задание на 7 ₽, потраченное целиком, проходило бы совсем без комиссий. */
function pctUp(sum, pct) { return Math.ceil(Math.max(0, Number(sum) || 0) * (Number(pct) || 0) / 100); }
function pctDown(sum, pct) { return Math.floor(Math.max(0, Number(sum) || 0) * (Number(pct) || 0) / 100); }
const MAX_AMOUNT = 100_000_000;          /* больше — опечатка, не бюджет */
const SESSION_DAYS = 30;

if (!ADMIN_KEY) {
  console.error('[BloggerPay] В server/.env не задан ADMIN_KEY — без него не работают'
    + ' реестр выплат и админ-сводка. Пример: server/.env.example');
}

/* ── База ──────────────────────────────────────────────────────────── */

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  email      TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  role       TEXT NOT NULL CHECK(role IN ('blogger','advertiser')),
  pass_salt  TEXT NOT NULL,
  pass_hash  TEXT NOT NULL,
  is_admin   INTEGER NOT NULL DEFAULT 0,
  is_blocked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

/* Идемпотентность: одна строка = одна ПРОВЕДЁННАЯ операция.
   Повтор запроса с тем же op_key находит эту строку и получает
   сохранённый ответ, не трогая журнал. */
CREATE TABLE IF NOT EXISTS ops (
  op_key     TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL,
  kind       TEXT NOT NULL,
  result     TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

/* Журнал денег. Только INSERT. bucket:
     available — деньги, которыми можно распоряжаться;
     hold      — заморожено под сделку или заявку на вывод.
   Сумма по (user, bucket) и есть баланс. */
CREATE TABLE IF NOT EXISTS ledger (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  op_key     TEXT NOT NULL REFERENCES ops(op_key),
  user_id    INTEGER NOT NULL,
  bucket     TEXT NOT NULL CHECK(bucket IN ('available','hold')),
  amount     INTEGER NOT NULL,
  kind       TEXT NOT NULL,
  ref        TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ledger_user ON ledger(user_id, bucket);

CREATE TABLE IF NOT EXISTS deals (
  id          TEXT PRIMARY KEY,
  payer_id    INTEGER NOT NULL REFERENCES users(id),
  /* Кого предполагается платить. Заполняется при заморозке: без этого
     вторая сторона не может отказаться от сделки — а отказ блогера это
     обычный, а не исключительный случай. */
  payee_id    INTEGER,
  amount      INTEGER NOT NULL,
  /* Из одной заморозки можно платить частями: бюджет кампании делится
     между несколькими блогерами. paid — сколько уже ушло. */
  paid        INTEGER NOT NULL DEFAULT 0,
  status      TEXT NOT NULL CHECK(status IN ('held','released','refunded')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

/* Подтверждённые каналы. Здесь лежит только то, что площадка сама о
   человеке сообщила: её внутренний id, имя канала и число подписчиков
   на момент проверки. Токенов доступа НЕ храним — они нужны один раз,
   при самой проверке, и дальше только увеличивают ущерб от утечки. */
CREATE TABLE IF NOT EXISTS channels (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  platform    TEXT NOT NULL,
  external_id TEXT NOT NULL,
  title       TEXT,
  url         TEXT,
  subs        INTEGER,
  checked_at  TEXT NOT NULL DEFAULT (datetime('now')),
  /* Ключ — «аккаунт + канал», а не один канал на всю площадку: у одного
     человека бывает два аккаунта (личный и рабочий), и свой же канал он
     должен уметь подтвердить в обоих. Дважды в одном аккаунте нельзя. */
  UNIQUE(user_id, platform, external_id)
);
CREATE INDEX IF NOT EXISTS channels_user ON channels(user_id);

/* Карточки блогеров — общий каталог.
   Каталог жил только в браузере: карточка, опубликованная на одном
   телефоне, не появлялась ни на втором телефоне того же человека, ни у
   рекламодателя. Теперь она едет сюда, и каталог у всех один.
   В data лежит ТОЛЬКО то, что и так видно в каталоге (белый список
   полей — cleanCard ниже): почта, местный id, баланс и остальное не
   сохраняем, даже если клиент их пришлёт. hidden — рубильник владельца:
   публичную витрину нужно уметь закрыть, не удаляя работу человека. */
CREATE TABLE IF NOT EXISTS cards (
  id         TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  data       TEXT NOT NULL,
  hidden     INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS cards_user ON cards(user_id);

/* Конверты — почта между устройствами.
   Заявки, сделки и переписка жили в браузере: рекламодатель на одном
   телефоне отправлял заявку, а блогер на другом её не видел. Теперь
   каждая такая запись кладётся сюда «в конверт» с двумя участниками
   (a_id, b_id — серверные id), и каждый забирает свои конверты по
   номеру (ver): что появилось после последнего визита.
   Сервер НЕ разбирает содержимое (data — как прислали): он только
   следит, кто участник и кто может читать и переписывать. b_id пуст —
   конверт общий, его видят все вошедшие (объявления кампаний).
   Повторная запись того же (kind, rid) получает НОВЫЙ ver — так
   «забрать всё новее N» отдаёт и правки, а не только новые записи. */
CREATE TABLE IF NOT EXISTS sync (
  ver        INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL,
  rid        TEXT NOT NULL,
  a_id       INTEGER NOT NULL REFERENCES users(id),
  b_id       INTEGER REFERENCES users(id),
  from_id    INTEGER NOT NULL,
  data       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(kind, rid)
);
CREATE INDEX IF NOT EXISTS sync_a ON sync(a_id, ver);
CREATE INDEX IF NOT EXISTS sync_b ON sync(b_id, ver);
/* Пределы обмена (аудит 16.10.2026): «есть ли уже связь двух людей» и
   «сколько места занял человек» — без обхода всей таблицы. */
CREATE INDEX IF NOT EXISTS sync_ab ON sync(a_id, b_id);
CREATE INDEX IF NOT EXISTS sync_from ON sync(from_id);

/* Подписки на уведомления. Одна строка — один браузер одного человека:
   у него может быть телефон и ноутбук, и уведомление должно прийти на
   оба. endpoint — адрес службы доставки браузера, он же ключ: повторная
   подписка того же браузера должна обновлять строку, а не плодить.
   p256dh и auth — ключи, которыми шифруется текст; без них сообщение
   не собрать. Личных данных здесь нет. */
CREATE TABLE IF NOT EXISTS push_subs (
  endpoint   TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  ua         TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  seen_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS push_user ON push_subs(user_id);

/* Ошибки у пользователей. Раньше они жили в памяти вкладки и стирались
   при перезагрузке: у человека белый экран, а владелец об этом никогда
   не узнавал. Теперь видно, что и у скольких людей ломается.
   Личных данных здесь нет — только текст ошибки, место и версия. */
CREATE TABLE IF NOT EXISTS errors (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER,
  message    TEXT NOT NULL,
  where_at   TEXT,
  version    TEXT,
  ua         TEXT,
  at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS errors_at ON errors(at);

/* Реестр выплат — то, чего не было вовсе: оператор видит, кому и
   сколько должен, и отмечает, что сделал. */
CREATE TABLE IF NOT EXISTS withdrawals (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  amount      INTEGER NOT NULL,
  fee         INTEGER NOT NULL,
  net         INTEGER NOT NULL,
  requisites  TEXT NOT NULL,
  status      TEXT NOT NULL CHECK(status IN ('queued','processing','paid','rejected','cancelled')),
  note        TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

/* Платежи ЮKassa: одна строка на платёж. Зачисление на баланс идёт
   через журнал (op_key = 'yk:<id платежа>'), поэтому повторный вебхук
   или повторная проверка статуса денег не удвоят. */
CREATE TABLE IF NOT EXISTS payments (
  id         TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  amount     INTEGER NOT NULL,
  status     TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS payments_user ON payments(user_id);

/* Проверка личности перед выводом: анкета и фото разворота паспорта.
   Решение принимает оператор в консоли — сервер только хранит заявку
   и её статус. Фото лежит строкой data:image (сжатый jpeg ≤ 700 КБ). */
CREATE TABLE IF NOT EXISTS kyc_requests (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  name        TEXT NOT NULL,
  birth       TEXT NOT NULL,
  photo       TEXT NOT NULL,
  selfie      TEXT,
  status      TEXT NOT NULL CHECK(status IN ('queued','approved','rejected')),
  note        TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
/* Споры по сделкам. payee_id пуст — спор по всей заморозке (обычная
   сделка); указан — по выплате одному исполнителю из бюджета кампании. */
CREATE TABLE IF NOT EXISTS disputes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  deal_id    TEXT NOT NULL,
  payee_id   INTEGER,
  opened_by  INTEGER NOT NULL,
  status     TEXT NOT NULL CHECK(status IN ('open','closed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at  TEXT
);
CREATE INDEX IF NOT EXISTS disputes_deal ON disputes(deal_id, status);
CREATE INDEX IF NOT EXISTS ops_user_kind ON ops(user_id, kind);
CREATE INDEX IF NOT EXISTS deals_status ON deals(status);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS ledger_kind ON ledger(kind);
CREATE INDEX IF NOT EXISTS ledger_ref ON ledger(ref, user_id);
CREATE INDEX IF NOT EXISTS kyc_user ON kyc_requests(user_id);
CREATE INDEX IF NOT EXISTS kyc_status ON kyc_requests(status);
CREATE INDEX IF NOT EXISTS sessions_exp ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS withdrawals_status ON withdrawals(status);
`);

/* База могла быть создана до появления частичных выплат: CREATE TABLE
   IF NOT EXISTS её не изменит, поэтому колонку добавляем отдельно. */
try { db.exec('ALTER TABLE deals ADD COLUMN paid INTEGER NOT NULL DEFAULT 0'); }
catch (e) { /* уже есть — это нормально */ }
/* Комиссии задания (14.10.2026): fee_pct — с рекламодателя сверху бюджета,
   pay_fee_pct — с выплат блогеру; fee_in — сколько комиссии взято, fee_back —
   сколько вернули вместе с неистраченным бюджетом. У строк до этого дня — 0. */
for (const col of ['fee_pct INTEGER NOT NULL DEFAULT 0', 'pay_fee_pct INTEGER NOT NULL DEFAULT 0',
  'fee_in INTEGER NOT NULL DEFAULT 0', 'fee_back INTEGER NOT NULL DEFAULT 0']) {
  try { db.exec('ALTER TABLE deals ADD COLUMN ' + col); } catch (e) { /* уже есть */ }
}
/* Комиссия платежа ЮKassa: amount — сколько зачислить, fee — сверху (14.10.2026). */
try { db.exec('ALTER TABLE payments ADD COLUMN fee INTEGER NOT NULL DEFAULT 0'); } catch (e) { /* уже есть */ }

/* Телеграм-id: по нему узнаём человека, вошедшего из мини-аппа. */
/* Селфи с паспортом (02.09.2026): второй снимок в заявке на проверку
   личности. Базы, созданные раньше, получают колонку здесь. */
try { db.exec('ALTER TABLE kyc_requests ADD COLUMN selfie TEXT'); } catch (e) { /* уже есть */ }
try { db.exec('ALTER TABLE users ADD COLUMN tg_id TEXT'); }
catch (e) { /* уже есть */ }
try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_tg ON users(tg_id) WHERE tg_id IS NOT NULL'); }
catch (e) { /* индекс мог не создаться на старом движке — не критично */ }

/* Картинка канала (04.09.2026): её отдаёт сама площадка вместе с именем,
   и по ней человек узнаёт свой канал в списке с одного взгляда. Базы,
   созданные раньше, получают колонку здесь. */
try { db.exec('ALTER TABLE channels ADD COLUMN avatar TEXT'); }
catch (e) { /* уже есть */ }

/* Снимаем старый запрет «один канал — один аккаунт» (05.09.2026).
   SQLite не умеет убирать ограничение у существующей таблицы, поэтому
   таблицу пересобираем: новая с ключом (user_id, platform, external_id),
   данные переливаем, старую сносим. Делается один раз — на второй запуск
   в схеме уже новый ключ, и условие не совпадает. */
try {
  const t = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='channels'").get();
  if (t && /UNIQUE\s*\(\s*platform\s*,\s*external_id\s*\)/i.test(t.sql)) {
    /* Внешние ключи на время пересборки выключаем: так советует сама
       SQLite для «сделать новую таблицу и переименовать». Переключать
       PRAGMA внутри транзакции нельзя, поэтому до и после. */
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(`CREATE TABLE channels_new (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id     INTEGER NOT NULL REFERENCES users(id),
        platform    TEXT NOT NULL,
        external_id TEXT NOT NULL,
        title       TEXT,
        url         TEXT,
        subs        INTEGER,
        avatar      TEXT,
        checked_at  TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(user_id, platform, external_id)
      )`);
      db.exec(`INSERT INTO channels_new
          (id, user_id, platform, external_id, title, url, subs, avatar, checked_at)
        SELECT id, user_id, platform, external_id, title, url, subs, avatar, checked_at
        FROM channels`);
      db.exec('DROP TABLE channels');
      db.exec('ALTER TABLE channels_new RENAME TO channels');
      db.exec('CREATE INDEX IF NOT EXISTS channels_user ON channels(user_id)');
      db.exec('COMMIT');
      console.log('каналы: ключ уникальности переведён на «аккаунт + канал»');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch (_) { /* нечего откатывать */ }
      throw e;
    } finally {
      db.exec('PRAGMA foreign_keys = ON');
    }
  }
} catch (e) {
  console.error('каналы: пересборка таблицы не удалась —', e && e.message);
}

/* Порядок важен: сначала пересборка таблицы каналов (она переливает
   только известные ей колонки), и лишь потом новые колонки — иначе
   пересборка их же и снесла бы, а подготовленные запросы упали бы. */
/* Данные канала, которые площадка отдаёт вместе с именем (05.09.2026).
   Раньше мы брали только имя, ссылку и число подписчиков — по трём числам
   нельзя понять, живой канал или накрученный. Колонки добавляем по одной:
   базы, созданные раньше, получают их здесь. */
for (const col of ['username TEXT', 'verified INTEGER DEFAULT 0',
  'following INTEGER', 'likes_total INTEGER', 'videos_total INTEGER',
  'stats_at TEXT', 'risk INTEGER', 'risk_level TEXT', 'risk_at TEXT', 'risk_why TEXT']) {
  try { db.exec('ALTER TABLE channels ADD COLUMN ' + col); }
  catch (e) { /* уже есть */ }
}

/* Доступ к площадке храним ОТДЕЛЬНО от самого канала и никогда не отдаём
   наружу: ни в одном ответе приложения этой таблицы нет. Без него нельзя
   обновлять статистику — человек подтвердил канал один раз, а цифры нужны
   свежие. Токен живёт у площадки недолго, поэтому рядом лежит refresh. */
db.exec(`CREATE TABLE IF NOT EXISTS channel_tokens (
  user_id     INTEGER NOT NULL REFERENCES users(id),
  platform    TEXT NOT NULL,
  external_id TEXT NOT NULL,
  access      TEXT NOT NULL,
  refresh     TEXT,
  expires_at  TEXT,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, platform, external_id)
)`);

/* Снимки статистики: по ним видно динамику, а не одну точку. */
db.exec(`CREATE TABLE IF NOT EXISTS channel_stats (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL,
  platform    TEXT NOT NULL,
  external_id TEXT NOT NULL,
  at          TEXT NOT NULL DEFAULT (datetime('now')),
  followers   INTEGER,
  videos      INTEGER,
  med_views   INTEGER,
  avg_views   INTEGER,
  er_likes    REAL,
  er_comments REAL,
  er_shares   REAL,
  risk        INTEGER,
  risk_level  TEXT,
  data        TEXT
)`);
db.exec('CREATE INDEX IF NOT EXISTS channel_stats_ch ON channel_stats(user_id, platform, external_id, at DESC)');

/* «Привязать видео» (06.10.2026, контракт — server/VIDEO-SPEC.md).
   Блогер больше не «сдаёт работу» словами: он привязывает ролик со своего
   подтверждённого TikTok, а цифры сервер берёт у площадки сам. Просмотры
   от клиента не принимаются никогда — иначе их нарисовали бы из консоли.
   video_id — СТРОКА: у TikTok это 19 цифр, больше 2^53, и числом он
   молча округлился бы до соседнего ролика. Один ролик — одно задание:
   UNIQUE(platform, video_id), иначе тот же ролик продали бы дважды.
   Время — в миллисекундах: окно подсчёта считается арифметикой. */
db.exec(`CREATE TABLE IF NOT EXISTS task_videos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  camp_id TEXT NOT NULL, owner_id INTEGER NOT NULL, blogger_id INTEGER NOT NULL,
  platform TEXT NOT NULL DEFAULT 'tiktok', external_id TEXT NOT NULL,
  video_id TEXT NOT NULL,
  url TEXT, handle TEXT, title TEXT, duration INTEGER, posted_at INTEGER,
  views INTEGER DEFAULT 0, likes INTEGER DEFAULT 0, comments INTEGER DEFAULT 0, shares INTEGER DEFAULT 0,
  stats_at INTEGER, miss INTEGER DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'review',
  review_note TEXT, reviewed_at INTEGER, approved_at INTEGER,
  decision TEXT, decision_note TEXT, decided_at INTEGER,
  risk INTEGER, risk_level TEXT, risk_why TEXT, risk_at INTEGER, risk_hold INTEGER DEFAULT 0,
  earned INTEGER DEFAULT 0, paid INTEGER DEFAULT 0, paid_at INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE(platform, video_id)
)`);
db.exec('CREATE INDEX IF NOT EXISTS task_videos_camp ON task_videos(camp_id)');
db.exec('CREATE INDEX IF NOT EXISTS task_videos_blogger ON task_videos(blogger_id)');
db.exec('CREATE INDEX IF NOT EXISTS task_videos_status ON task_videos(status)');
/* Разбор после аудита (06.10.2026), новые поля строки ролика:
   terms — снимок условий оффера в момент привязки (JSON {payMode, rate,
     fixedPrice, cap, minViews}). Конверт оффера рекламодатель правит сам,
     и без снимка он мог бы после зачёта переписать ставку в ноль.
   pay_hold / pay_why — выплата ждёт владельца не из-за накрутки: в
     заморозке не хватило денег или не удался финальный замер.
   decided_views — просмотры в момент решения владельца «засчитать»:
     решение снимает подозрение только с тех цифр, которые он видел.
   last_try_at — когда последний раз пробовали освежить (удачно или нет):
     по нему очередь круга, чтобы одни и те же ролики не забивали её.
   last_miss_at — когда ролик последний раз не вернулся: промах считаем
     не чаще раза в 20 часов, иначе два круга подряд «удаляли» бы ролик.
   frozen — цифры заморожены (ролик засчитан владельцем после отзыва
     канала): не опрашиваем, платим по тому, что есть. */
for (const col of ['terms TEXT', 'pay_hold INTEGER DEFAULT 0', 'pay_why TEXT', 'decided_views INTEGER',
  'last_try_at INTEGER', 'last_miss_at INTEGER', 'frozen INTEGER DEFAULT 0']) {
  try { db.exec('ALTER TABLE task_videos ADD COLUMN ' + col); } catch (e) { /* уже есть */ }
}
/* Механика v2 (06.10.2026, VIDEO-SPEC.md, раздел 10):
   submit_views — просмотры в момент загрузки: выплата идёт по большему из
     них и свежего замера, ролик не теряет в деньгах, если площадка потом
     срезала часть просмотров.
   reserved — оценка суммы при загрузке: столько бюджета держится под ролик,
     пока по нему не решено.
   paid_views — просмотры, по которым ролик оплачен (база выплаты; ставится
     один раз). Просмотры после выплаты в зачёт не идут.
   hold_kind — чья пауза: 'money' (не хватило денег, ждёт владельца) или
     'measure' (нет свежего замера, круг повторит сам).
   pay_tries — сколько раз подряд не удался свежий замер перед выплатой.
   pay_note — пометка для владельца (например, «оплачено по последнему замеру»). */
for (const col of ['submit_views INTEGER', 'reserved INTEGER DEFAULT 0', 'paid_views INTEGER',
  'hold_kind TEXT', 'pay_tries INTEGER DEFAULT 0', 'pay_note TEXT']) {
  try { db.exec('ALTER TABLE task_videos ADD COLUMN ' + col); } catch (e) { /* уже есть */ }
}
/* Механика v3 (07.10.2026, VIDEO-SPEC.md, раздел 11): загрузка с любым
   числом просмотров, после зачёта — начисления по мере роста 30 дней.
   track_ends_at — до какого момента ролик считается (зачёт + VID_TRACK_DAYS);
   top_views — наибольшие просмотры по замерам: начисление идёт по ним,
     и просевшие на площадке просмотры не уменьшают начисленное;
   notif_at / notif_paid — когда и на какой выплаченной сумме блогеру
     последний раз писали о начислениях (сводка — не чаще раза в сутки).
   В v3 значения колонок прежние: paid — выплачено всего, earned —
   начислено по наибольшим просмотрам, paid_views — просмотры, за которые
   уже заплачено; hold_kind 'measure' больше не ставится. */
/* vkind (15.10.2026): 'shorts' — YouTube Shorts, 'reels' — Instagram Reels. */
try { db.exec('ALTER TABLE task_videos ADD COLUMN vkind TEXT'); } catch (e) { /* уже есть */ }
const vidKindSet = db.prepare('UPDATE task_videos SET vkind = ? WHERE id = ?');
for (const col of ['track_ends_at INTEGER', 'top_views INTEGER', 'notif_at INTEGER', 'notif_paid INTEGER DEFAULT 0']) {
  try { db.exec('ALTER TABLE task_videos ADD COLUMN ' + col); } catch (e) { /* уже есть */ }
}
/* Перенос строк v2 (повторный запуск ничего не меняет):
   - наибольшие просмотры — из того, что уже известно;
   - засчитанные (active) получают срок подсчёта от зачёта, а если его
     нет — от сейчас; ролики на проверке получат срок в момент зачёта;
   - пауза «нет свежего замера» (hold_kind = 'measure') снимается: в v3
     сбой площадки ничего не держит, прибавка просто ждёт следующего круга;
   - кому уже платили, сводка о начислениях считается отправленной —
     иначе первый круг v3 написал бы «Видео засчитано» второй раз.
   Оплаченные (paid) остаются оплаченными. */
try {
  const now0 = Date.now();
  db.prepare(`UPDATE task_videos SET top_views = MAX(COALESCE(views, 0), COALESCE(submit_views, 0), COALESCE(paid_views, 0))
    WHERE top_views IS NULL`).run();
  db.prepare(`UPDATE task_videos SET track_ends_at = COALESCE(approved_at, ?) + ?
    WHERE status = 'active' AND track_ends_at IS NULL`).run(now0, VID_TRACK_MS);
  db.prepare(`UPDATE task_videos SET pay_hold = 0, hold_kind = NULL, pay_why = NULL, pay_tries = 0
    WHERE hold_kind = 'measure'`).run();
  db.prepare(`UPDATE task_videos SET notif_at = COALESCE(paid_at, updated_at), notif_paid = paid
    WHERE notif_at IS NULL AND COALESCE(paid, 0) > 0`).run();
} catch (e) { console.error('видео v3: перенос строк не удался —', e && e.message); }
/* Участники задания. Вступление жило только в приложении, и сервер не
   мог показать ни список участников, ни лидерборд. left_at — вышел из
   задания (строка остаётся: вернуться можно тем же /join). */
db.exec(`CREATE TABLE IF NOT EXISTS task_members (
  camp_id TEXT NOT NULL, user_id INTEGER NOT NULL,
  joined_at INTEGER NOT NULL, left_at INTEGER,
  UNIQUE(camp_id, user_id)
)`);
db.exec('CREATE INDEX IF NOT EXISTS task_members_camp ON task_members(camp_id, left_at, joined_at)');
/* Старые загрузки (до /join): кто уже загружал видео — тот участник. */
try {
  db.exec(`INSERT OR IGNORE INTO task_members (camp_id, user_id, joined_at)
    SELECT camp_id, blogger_id, MIN(created_at) FROM task_videos GROUP BY camp_id, blogger_id`);
} catch (e) { console.error('участники заданий: перенос не удался —', e && e.message); }
/* Снимок дня: одна строка на ролик в сутки (UTC). По ним видно, как ролик
   набирал просмотры, и по ним же ловится резкий скачок без лайков. */
db.exec(`CREATE TABLE IF NOT EXISTS task_video_stats (
  video_row INTEGER NOT NULL, day TEXT NOT NULL,
  views INTEGER, likes INTEGER, comments INTEGER, shares INTEGER, at INTEGER,
  PRIMARY KEY(video_row, day)
)`);


/* Вход через Google (04.09.2026). Связь ведём по google_sub — это
   постоянный номер аккаунта у Google. По почте связывать нельзя: почту
   можно сменить или занять чужой обычной регистрацией, и человек
   получил бы чужой аккаунт вместе с балансом (та же причина, по которой
   телеграм-вход связывается по tg_id). */
try { db.exec('ALTER TABLE users ADD COLUMN presence_off INTEGER NOT NULL DEFAULT 0'); } catch (e) { /* уже есть */ }
/* Номер телефона из «Верификации» (аудит 16.10.2026, C62): раньше жил только
   в браузере — на новом устройстве шаг «Телефон» снова был пустым и
   принимал любой другой номер. Пишется один раз и больше не меняется
   (решение владельца 14.10: «номер телефона менять нельзя»). */
try { db.exec('ALTER TABLE users ADD COLUMN kyc_phone TEXT'); } catch (e) { /* уже есть */ }
try { db.exec('ALTER TABLE users ADD COLUMN kyc_phone_at INTEGER'); } catch (e) { /* уже есть */ }
const qPhone = {
  get: db.prepare('SELECT kyc_phone, kyc_phone_at FROM users WHERE id = ?'),
  set: db.prepare('UPDATE users SET kyc_phone = ?, kyc_phone_at = ? WHERE id = ? AND kyc_phone IS NULL'),
};
/* Отпечаток ключа владельца, которым аккаунт взял права через
   /api/admin/claim (аудит 16.10.2026): смена ADMIN_KEY снимает такие
   права при старте (см. ADMIN_FP ниже). Колонка новая — у тех, кто уже
   админ, ставим отпечаток текущего ключа, чтобы выкладка никого не сняла. */
let ADMIN_FP_NEW = false;
try { db.exec('ALTER TABLE users ADD COLUMN admin_fp TEXT'); ADMIN_FP_NEW = true; } catch (e) { /* уже есть */ }
try { db.exec('ALTER TABLE users ADD COLUMN google_sub TEXT'); }
catch (e) { /* уже есть */ }
try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_gsub ON users(google_sub) WHERE google_sub IS NOT NULL'); }
catch (e) { /* индекс мог не создаться на старом движке — не критично */ }

/* Журнал действий владельца. Решения по выплатам, личности, спорам и
   блокировкам раньше оставляли только новый статус: при нескольких
   админах (почты из ADMIN_EMAIL, принятые права, ключ) нельзя было
   понять, кто выплатил или кого заблокировал. «Кто» — почта аккаунта
   владельца, если он вошёл почтой; иначе «сессия пульта» или «ключ». */
db.exec(`CREATE TABLE IF NOT EXISTS admin_log (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at      TEXT NOT NULL DEFAULT (datetime('now')),
  who     TEXT,
  action  TEXT NOT NULL,
  target  TEXT,
  detail  TEXT
)`);

/* Витрина карт блогеров (10.10.2026): владелец снимает все карты разом
   (POST /api/admin/cards/unpublish-all) — с переходом на задания «как у
   More Views» карта блогера больше не услуга. Это снятие, а не удаление:
   работа людей остаётся, «Вернуть все» возвращает.
   cards.hidden: 0 — на витрине; 1 — скрыта владельцем по одной (решение
   по конкретной карте, «Вернуть все» её НЕ трогает); 2 — снята общей
   кнопкой. Пока витрина закрыта (флаг cards_closed), новая карта тоже
   ложится снятой: иначе приложение (старая версия, второй телефон)
   вернуло бы её на витрину при следующей синхронизации.
   card_tombs — снятая карта, которую автор удалил: если тот же номер
   приедет снова (второй телефон хранит её у себя и шлёт заново), она
   ляжет снятой, а не на витрину. В строке только номер, владелец и
   отметка — ни имени, ни данных карты. */
db.exec(`CREATE TABLE IF NOT EXISTS server_flags (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  at    TEXT NOT NULL DEFAULT (datetime('now'))
)`);
db.exec(`CREATE TABLE IF NOT EXISTS card_tombs (
  id      TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  hidden  INTEGER NOT NULL,
  at      TEXT NOT NULL DEFAULT (datetime('now'))
)`);

/* Картинки заданий (05.10.2026): баннеры, фото товара, обложки. Раньше
   они ехали внутри задания строкой base64, и запись задания упиралась в
   предел 400 КБ (POST /api/sync/put): задание с крупной обложкой молча
   не доходило до блогеров. Теперь картинка лежит здесь отдельно, а в
   задании — только её адрес /media/<id>. */
db.exec(`CREATE TABLE IF NOT EXISTS media (
  id         TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL,
  mime       TEXT NOT NULL,
  data       BLOB NOT NULL,
  size       INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);
db.exec('CREATE INDEX IF NOT EXISTS media_user ON media(user_id)');
const qm = {
  ins: db.prepare('INSERT INTO media (id, user_id, mime, data, size) VALUES (?,?,?,?,?)'),
  get: db.prepare('SELECT mime, data FROM media WHERE id = ?'),
  stat: db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM media WHERE user_id = ?'),
  /* уборка (аудит 16.10.2026): старые файлы человека и где на них ссылки */
  old: db.prepare(`SELECT id FROM media WHERE user_id = ? AND created_at < datetime('now', ?)`),
  del: db.prepare('DELETE FROM media WHERE id = ? AND user_id = ?'),
  refSync: db.prepare('SELECT data FROM sync WHERE a_id = ? OR from_id = ?'),
  refCards: db.prepare('SELECT data FROM cards WHERE user_id = ?'),
};
/* Место человека кончилось — убираем ЕГО файлы старше 30 дней, на которые
   не ссылается ни одна его запись (задания, профиль, личное) и ни одна его
   карточка: заменённые обложки, картинки брошенных черновиков. Раньше
   предел 300 файлов / 150 МБ был навсегда: активный рекламодатель упирался
   в него и больше не мог загрузить ни одной картинки, а совет «удалите
   старые задания» места не освобождал. Свежие (до 30 дней) не трогаем —
   черновик живёт только в браузере, и ссылки на его картинки сервер не видит. */
function mediaGc(uid) {
  let freed = 0;
  try {
    const old = qm.old.all(uid, '-30 days');
    if (!old.length) return 0;
    const refs = new Set();
    const re = /\/media\/([a-f0-9]{32})/g;
    const scan = (s) => { let m; re.lastIndex = 0; while ((m = re.exec(String(s || '')))) refs.add(m[1]); };
    for (const r of qm.refSync.iterate(uid, uid)) scan(r.data);
    for (const r of qm.refCards.iterate(uid)) scan(r.data);
    for (const r of old) if (!refs.has(r.id)) freed += Number(qm.del.run(r.id, uid).changes) || 0;
  } catch (e) { console.error('[media] уборка не удалась', e && e.message); }
  return freed;
}
/* Пополнение по счёту (14.10.2026). Рекламодатель оставляет заявку в
   приложении (компания, ИНН, сумма) и продолжает в Телеграме: бот по
   ссылке t.me/<бот>?start=inv_<code> связывает чат с заявкой, сообщает
   владельцу и передаёт переписку в обе стороны (tg_relay: сообщение в
   чате владельца → чат клиента). Деньги после оплаты зачисляет владелец
   в /admin → «Счета» — через журнал, ключ операции sys:invoice:<id> (до
   16.10 — invoice:<id>, такие узнаются при повторе), повтор не зачислит
   второй раз. */
db.exec(`CREATE TABLE IF NOT EXISTS invoice_requests (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  code       TEXT NOT NULL UNIQUE,
  amount     INTEGER NOT NULL,
  company    TEXT NOT NULL,
  inn        TEXT NOT NULL,
  email      TEXT,
  comment    TEXT,
  status     TEXT NOT NULL DEFAULT 'new',
  tg_chat    TEXT,
  tg_user    TEXT,
  tg_name    TEXT,
  paid       INTEGER,
  note       TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);
db.exec('CREATE INDEX IF NOT EXISTS inv_user ON invoice_requests(user_id)');
db.exec(`CREATE TABLE IF NOT EXISTS tg_relay (
  admin_msg INTEGER PRIMARY KEY,
  user_chat TEXT NOT NULL,
  inv_id    INTEGER,
  at        TEXT NOT NULL DEFAULT (datetime('now'))
)`);
const qi = {
  ins: db.prepare('INSERT INTO invoice_requests (user_id, code, amount, company, inn, email, comment) VALUES (?,?,?,?,?,?,?)'),
  byId: db.prepare('SELECT * FROM invoice_requests WHERE id = ?'),
  byCode: db.prepare('SELECT * FROM invoice_requests WHERE code = ?'),
  mine: db.prepare(`SELECT id, code, amount, company, inn, status, paid, note, created_at, updated_at,
      CASE WHEN tg_chat IS NOT NULL THEN 1 ELSE 0 END AS tg
    FROM invoice_requests WHERE user_id = ? ORDER BY id DESC LIMIT 20`),
  openByChat: db.prepare(`SELECT * FROM invoice_requests WHERE tg_chat = ? AND status IN ('new','linked')
    ORDER BY id DESC LIMIT 1`),
  link: db.prepare(`UPDATE invoice_requests SET tg_chat = ?, tg_user = ?, tg_name = ?,
      status = CASE WHEN status = 'new' THEN 'linked' ELSE status END, updated_at = datetime('now') WHERE id = ?`),
  setSt: db.prepare(`UPDATE invoice_requests SET status = ?, paid = ?, note = ?, updated_at = datetime('now') WHERE id = ?`),
  list: db.prepare(`SELECT i.id, i.user_id, i.amount, i.company, i.inn, i.email, i.comment, i.status, i.tg_user, i.tg_name,
      CASE WHEN i.tg_chat IS NOT NULL THEN 1 ELSE 0 END AS tg, i.paid, i.note, i.created_at, i.updated_at,
      u.email AS user_email, u.name AS user_name
    FROM invoice_requests i JOIN users u ON u.id = i.user_id
    WHERE (? = '' OR i.status = ? OR (? = 'open' AND i.status IN ('new','linked')))
    ORDER BY i.id DESC LIMIT 200`),
  openCount: db.prepare(`SELECT COUNT(*) AS n FROM invoice_requests WHERE status IN ('new','linked')`),
  openByUser: db.prepare(`SELECT COUNT(*) AS n FROM invoice_requests WHERE user_id = ? AND status IN ('new','linked')`),
  relayPut: db.prepare('INSERT OR REPLACE INTO tg_relay (admin_msg, user_chat, inv_id) VALUES (?,?,?)'),
  relayGet: db.prepare('SELECT * FROM tg_relay WHERE admin_msg = ?'),
};
/* Поддержка в боте (15.10.2026): «Настройки → Написать в поддержку».
   Приложение берёт метку (POST /api/support/start, живёт сутки) и
   открывает t.me/<бот>?start=sup_<метка>: бот связывает чат с аккаунтом
   и передаёт переписку владельцу так же, как по счетам (tg_relay с
   inv_id NULL — ответ владельца через «Ответить»). Командой /support в
   боте — тот же разговор, только без аккаунта. Разговор открыт 14 дней
   после последнего сообщения, дальше бот снова отвечает как обычно. */
db.exec(`CREATE TABLE IF NOT EXISTS support_codes (
  code    TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  at      INTEGER NOT NULL
)`);
db.exec(`CREATE TABLE IF NOT EXISTS support_chats (
  chat    TEXT PRIMARY KEY,
  user_id INTEGER,
  tg_user TEXT,
  tg_name TEXT,
  acked   INTEGER NOT NULL DEFAULT 0,
  last_at INTEGER NOT NULL
)`);
const qsup = {
  codePut: db.prepare('INSERT INTO support_codes (code, user_id, at) VALUES (?,?,?)'),
  codeGet: db.prepare('SELECT * FROM support_codes WHERE code = ?'),
  codeGc: db.prepare('DELETE FROM support_codes WHERE at < ?'),
  codeDel: db.prepare('DELETE FROM support_codes WHERE code = ?'),
  chatPut: db.prepare(`INSERT INTO support_chats (chat, user_id, tg_user, tg_name, acked, last_at) VALUES (?,?,?,?,0,?)
    ON CONFLICT(chat) DO UPDATE SET user_id = COALESCE(excluded.user_id, support_chats.user_id),
      tg_user = excluded.tg_user, tg_name = excluded.tg_name, acked = 0, last_at = excluded.last_at`),
  chatGet: db.prepare('SELECT * FROM support_chats WHERE chat = ?'),
  chatTouch: db.prepare('UPDATE support_chats SET last_at = ? WHERE chat = ?'),
  chatAck: db.prepare('UPDATE support_chats SET acked = 1, last_at = ? WHERE chat = ?'),
};
/* Метка одноразовая и живёт полчаса: пересланная ссылка не даст чужому
   выдать себя владельцу за хозяина аккаунта. */
const SUP_CODE_MS = 30 * 60000, SUP_OPEN_MS = 14 * 24 * 3600000;
/* Кто пишет — владельцу одной строкой: имя, почта (служебную почту
   входа через Телеграм не показываем), номер и баланс. */
function supWho(uid) {
  const u = uid ? q.userById.get(Number(uid)) : null;
  if (!u) return 'Аккаунт не указан — открыли бота без приложения';
  const mail = /@telegram\.local$/i.test(String(u.email || '')) ? 'вход через Телеграм' : String(u.email || '');
  let bal = '';
  try { const b = q.balance.get(u.id) || {}; bal = 'баланс ' + rubTxt(Number(b.available) || 0) + (Number(b.hold) ? ', в заморозке ' + rubTxt(Number(b.hold)) : ''); } catch (e) { /* без баланса */ }
  return [String(u.name || '').trim(), mail, '#' + u.id, bal].filter(Boolean).join(' · ');
}
/* Сверка Телеграма: пишет ли тот, кто привязан к аккаунту. Метка из
   приложения доказывает только то, что ссылку открыли, — не кто открыл. */
function supTgCheck(uid, fromId) {
  const u = uid ? q.userById.get(Number(uid)) : null;
  if (!u) return '';
  const tg = String(u.tg_id || '').trim();
  if (!tg) return '\nℹ️ Телеграм к аккаунту не привязан — перед изменениями в аккаунте сверьте, что это владелец';
  return tg === String(fromId || '')
    ? '\n✓ Пишет Телеграм, привязанный к аккаунту'
    : '\n⚠️ Пишет НЕ привязанный к аккаунту Телеграм — сверьте, что это владелец';
}
async function supStart(bot, admin, msg, code) {
  const chat = String(msg.chat && msg.chat.id);
  if (admin && chat === admin) {
    await bot.say(chat, 'Это чат владельца: обращения в поддержку приходят сюда, отвечайте на них кнопкой «Ответить».');
    return true;
  }
  let uid = null;
  if (code) {
    const c = qsup.codeGet.get(code);
    try { qsup.codeDel.run(code); } catch (e) { /* уже погашена */ }
    if (c && Date.now() - Number(c.at) < SUP_CODE_MS) uid = Number(c.user_id);
  }
  const f = msg.from || {};
  const tgUser = f.username ? '@' + String(f.username).slice(0, 40) : null;
  const tgName = [f.first_name, f.last_name].filter(Boolean).join(' ').slice(0, 80) || null;
  qsup.chatPut.run(chat, uid, tgUser, tgName, Date.now());
  const row = qsup.chatGet.get(chat);
  await bot.say(chat, '🛟 Поддержка BloggerPay\n\n'
    + 'Напишите вопрос сюда — можно несколькими сообщениями, со скриншотом или видео. Оператор ответит в этом чате.');
  if (admin) {
    const a = await bot.say(admin, '🛟 Обращение в поддержку' + (tgUser || tgName ? ' — ' + (tgUser || tgName) : '') + '\n'
      + supWho(row && row.user_id) + supTgCheck(row && row.user_id, f.id) + '\n\n'
      + 'Сообщения человека придут сюда. Ответьте на любое из них (Ответить) — бот передаст ответ.');
    if (a && a.message_id) qi.relayPut.run(Number(a.message_id), chat, null);
  }
  return true;
}
async function supMessage(bot, admin, msg) {
  const chat = String(msg.chat && msg.chat.id);
  const s = qsup.chatGet.get(chat);
  if (!s || Date.now() - Number(s.last_at) > SUP_OPEN_MS) return false;
  const f = msg.from || {};
  const who = f.username ? '@' + f.username : (s.tg_name || s.tg_user || 'человек');
  const h = await bot.say(admin, '🛟 Поддержка · ' + who + (s.user_id ? ' · #' + s.user_id : '') + ' пишет:');
  const c = await bot.copy(admin, chat, msg.message_id);
  if (h && h.message_id) qi.relayPut.run(Number(h.message_id), chat, null);
  if (c && c.message_id) qi.relayPut.run(Number(c.message_id), chat, null);
  if (!c) { await bot.say(chat, 'Не получилось передать сообщение оператору — попробуйте ещё раз.'); return true; }
  if (!s.acked) {
    qsup.chatAck.run(Date.now(), chat);
    await bot.say(chat, 'Передали оператору — ответ придёт сюда, в этот чат.');
  } else qsup.chatTouch.run(Date.now(), chat);
  return true;
}
const INV_MIN = Math.max(1000, Number(process.env.INVOICE_MIN || 10000) || 10000);
let BOT = null;                     /* модуль бота: заявкам на счёт нужен его ответ (message_id) */
/* ИНН: 10 цифр у организации, 12 у ИП, с контрольными цифрами */
function innOk(s) {
  const d = String(s || '');
  if (!/^\d{10}$|^\d{12}$/.test(d)) return false;
  const k = (w) => w.reduce((sum, c, i) => sum + c * Number(d[i]), 0) % 11 % 10;
  if (d.length === 10) return k([2, 4, 10, 3, 5, 9, 4, 6, 8]) === Number(d[9]);
  return k([7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) === Number(d[10]) && k([3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) === Number(d[11]);
}
function rubTxt(n) { return Number(n || 0).toLocaleString('ru-RU').replace(/\u00a0|\u202f/g, ' ') + ' ₽'; }
function invSay(chat, text) {
  if (!chat || !BOT || typeof BOT.say !== 'function') return Promise.resolve(null);
  return BOT.say(String(chat), text).catch(() => null);
}
/* Разговор по счёту в боте. Возвращают true — сообщение обработано. */
function invoiceHooks(bot) {
  const admin = String(ENV.ADMIN_CHAT_ID || '').trim();
  return {
    start: async (payload, msg) => {
      const sup = /^(?:support|sup_([0-9a-f]{12}))$/.exec(String(payload || ''));
      if (sup) return supStart(bot, admin, msg, sup[1] || '');
      const m = /^inv_([0-9a-f]{12})$/.exec(String(payload || ''));
      if (!m) return false;
      const chat = String(msg.chat && msg.chat.id);
      const r = qi.byCode.get(m[1]);
      if (!r) {
        await bot.say(chat, 'Заявка не найдена. Создайте её заново в приложении: Кошелёк → Пополнить → По счёту.');
        return true;
      }
      if (r.status === 'paid' || r.status === 'rejected') {
        await bot.say(chat, r.status === 'paid'
          ? 'Счёт №' + r.id + ' уже оплачен — ' + rubTxt(r.paid || r.amount) + ' на балансе BloggerPay.'
          : 'Заявка №' + r.id + ' закрыта' + (r.note ? ': ' + r.note : '') + '. Создайте новую в приложении.');
        return true;
      }
      const f = msg.from || {};
      const tgUser = f.username ? '@' + String(f.username).slice(0, 40) : null;
      const tgName = [f.first_name, f.last_name].filter(Boolean).join(' ').slice(0, 80) || null;
      qi.link.run(chat, tgUser, tgName, r.id);
      await bot.say(chat, '🧾 Заявка на пополнение по счёту №' + r.id + '\n\n'
        + 'На баланс: ' + rubTxt(r.amount) + '\nСумма счёта: ' + rubTxt(r.amount + pctOf(r.amount, TOPUP_FEE_PCT))
        + ' (включая комиссию сервиса ' + TOPUP_FEE_PCT + '%)\nПлательщик: ' + r.company + '\nИНН: ' + r.inn + '\n\n'
        + 'Менеджер выставит счёт и пришлёт его сюда, в этот чат, в течение рабочего дня. '
        + 'После оплаты деньги поступят на баланс BloggerPay — мы напишем.\n\n'
        + 'Нужны другие реквизиты или договор? Напишите сюда — менеджер ответит.');
      if (admin && chat !== admin) {
        const a = await bot.say(admin, '🧾 Клиент по счёту №' + r.id + ' на связи в боте' + (tgUser ? ' — ' + tgUser : '') + '\n'
          + rubTxt(r.amount) + ' на баланс · счёт на ' + rubTxt(r.amount + pctOf(r.amount, TOPUP_FEE_PCT)) + ' · ' + r.company + ' · ИНН ' + r.inn + '\n\n'
          + 'Ответьте на это сообщение (Ответить) — бот передаст ответ клиенту. Счёт можно прислать файлом.');
        if (a && a.message_id) qi.relayPut.run(Number(a.message_id), chat, r.id);
      }
      return true;
    },
    message: async (msg) => {
      const chat = String(msg.chat && msg.chat.id);
      if (!admin || chat === admin) return false;
      const r = qi.openByChat.get(chat);
      if (!r) return supMessage(bot, admin, msg);
      const f = msg.from || {};
      const who = f.username ? '@' + f.username : (r.tg_name || 'клиент');
      const h = await bot.say(admin, '💬 Счёт №' + r.id + ' · ' + who + ' пишет:');
      const c = await bot.copy(admin, chat, msg.message_id);
      if (h && h.message_id) qi.relayPut.run(Number(h.message_id), chat, r.id);
      if (c && c.message_id) qi.relayPut.run(Number(c.message_id), chat, r.id);
      if (!c) await bot.say(chat, 'Не получилось передать сообщение менеджеру — попробуйте ещё раз.');
      return true;
    },
    adminReply: async (msg) => {
      const ref = msg.reply_to_message && msg.reply_to_message.message_id;
      const row = ref ? qi.relayGet.get(Number(ref)) : null;
      if (!row) return false;
      const c = await bot.copy(row.user_chat, String(msg.chat.id), msg.message_id);
      if (!row.inv_id) {
        /* поддержка: ответ владельца держит разговор открытым */
        if (c) { try { qsup.chatTouch.run(Date.now(), String(row.user_chat)); } catch (e) { /* не главное */ } }
        await bot.say(String(msg.chat.id), c ? '✓ Ответ передан в чат поддержки' : '✗ Не дошло: человек мог остановить бота.');
        return true;
      }
      await bot.say(String(msg.chat.id), c
        ? '✓ Передано клиенту по счёту №' + row.inv_id
        : '✗ Не дошло: клиент мог остановить бота. Свяжитесь с ним по почте из заявки.');
      return true;
    },
  };
}
const MEDIA_MAX = 1024 * 1024;              /* JPEG — до 1 МБ: приложение само его ужимает */
/* Анимированный баннер (GIF, анимированные PNG и WebP) и видео-баннер
   пережимать нельзя — анимация пропадёт. Им до 6 МБ (05.10.2026). */
const MEDIA_MAX_RICH = 6 * 1024 * 1024;
const MEDIA_USER_FILES = Math.max(1, Math.floor(Number(ENV.MEDIA_USER_FILES) || 300));
const MEDIA_USER_BYTES = Math.max(1, Number(ENV.MEDIA_USER_MB) || 150) * 1024 * 1024;
/* Тип проверяем по первым байтам, а не по подписи в data:-адресе:
   иначе под видом картинки можно было бы положить что угодно. */
function mediaKind(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length > 12 && buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (buf.length > 6 && /^GIF8[79]a$/.test(buf.slice(0, 6).toString('latin1'))) return 'image/gif';
  /* «ftyp» есть и у фото HEIC/AVIF с iPhone, и у аудио M4A — видео
     только по марке видеоконтейнера */
  if (buf.length > 12 && buf.slice(4, 8).toString('latin1') === 'ftyp'
      && /^(isom|iso[2-9]|mp41|mp42|avc1|dash|m4v |qt  |3gp\d|3g2\w|mmp4|f4v )$/i.test(buf.slice(8, 12).toString('latin1'))) return 'video/mp4';
  if (buf.length > 4 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return 'video/webm';
  return '';
}

/* ── Мелкая утварь ─────────────────────────────────────────────────── */

const q = {
  userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
  userById: db.prepare('SELECT * FROM users WHERE id = ?'),
  userByTg: db.prepare('SELECT * FROM users WHERE tg_id = ?'),
  insTgUser: db.prepare(`INSERT INTO users (email, name, role, pass_salt, pass_hash, tg_id)
    VALUES (?,?,?,?,?,?)`),
  linkTg: db.prepare('UPDATE users SET tg_id = ? WHERE id = ?'),
  userByGoogle: db.prepare('SELECT * FROM users WHERE google_sub = ?'),
  insGoogleUser: db.prepare(`INSERT INTO users (email, name, role, pass_salt, pass_hash, google_sub)
    VALUES (?,?,?,?,?,?)`),
  linkGoogle: db.prepare('UPDATE users SET google_sub = ? WHERE id = ?'),
  insUser: db.prepare('INSERT INTO users (email, name, role, pass_salt, pass_hash) VALUES (?,?,?,?,?)'),
  insSession: db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?,?)'),
  session: db.prepare(`SELECT s.token, s.expires_at, u.* FROM sessions s
                       JOIN users u ON u.id = s.user_id WHERE s.token = ?`),
  delSession: db.prepare('DELETE FROM sessions WHERE token = ?'),
  delUserSessions: db.prepare('DELETE FROM sessions WHERE user_id = ?'),
  updPass: db.prepare('UPDATE users SET pass_salt = ?, pass_hash = ? WHERE id = ?'),
  /* все сессии человека, кроме этой (смена пароля, «выйти на всех устройствах») */
  delOtherSessions: db.prepare('DELETE FROM sessions WHERE user_id = ? AND token <> ?'),
  /* писал ли человек (автор конверта dm — a_id) этому собеседнику: конверт с
     чужим автором завести нельзя, так что «написал сам незнакомцу» не в счёт */
  dmFrom: db.prepare(`SELECT 1 AS x FROM sync WHERE kind = 'dm' AND a_id = ? AND b_id = ? LIMIT 1`),
  presenceSet: db.prepare('UPDATE users SET presence_off = ? WHERE id = ?'),
  /* Смена почты нужна ровно в одном случае: у аккаунта, заведённого
     входом через Телеграм, почта служебная (tg<id>@telegram.local), и
     войти с компьютера человек не может. Он задаёт настоящую почту и
     пароль — и это становится вторым способом входа в ТОТ ЖЕ аккаунт,
     а не вторым кошельком. */
  updEmail: db.prepare('UPDATE users SET email = ? WHERE id = ?'),
  /* Имён у человека было фактически два: users.name с регистрации,
     который менять было нечем, и имя из профиля, которое ездит конвертом
     между устройствами. Рейтинг, тревоги владельцу и пульт оператора
     показывали первое — то есть старое. Теперь профиль правит и его. */
  updName: db.prepare('UPDATE users SET name = ? WHERE id = ?'),
  setAdmin: db.prepare('UPDATE users SET is_admin = ? WHERE id = ?'),
  opByKey: db.prepare('SELECT * FROM ops WHERE op_key = ?'),
  insOp: db.prepare('INSERT INTO ops (op_key, user_id, kind, result) VALUES (?,?,?,?)'),
  updOpResult: db.prepare('UPDATE ops SET result = ? WHERE op_key = ?'),
  insLedger: db.prepare('INSERT INTO ledger (op_key, user_id, bucket, amount, kind, ref) VALUES (?,?,?,?,?,?)'),
  balance: db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN bucket='available' THEN amount END), 0) AS available,
      COALESCE(SUM(CASE WHEN bucket='hold' THEN amount END), 0) AS hold
    FROM ledger WHERE user_id = ?`),
  /* История кошелька (аудит 16.10.2026): постранично (before = id) и с
     фильтром по корзине — раньше отдавались последние 100 строк всех
     корзин, и у рекламодателя их целиком съедали строки заморозки
     (выплаты блогерам), пополнений в истории не оставалось вовсе.
     camp — название задания из его конверта (у удалённого задания конверт
     остаётся со статусом «done»): в браузере удалённого задания уже нет.
     Только конверт того, кто платит по этому заданию (не чужая подделка
     с тем же номером), общий или адресованный этому человеку. */
  myLedger: db.prepare(`SELECT l.id, l.bucket, l.amount, l.kind, l.ref, l.created_at,
      CASE WHEN l.ref LIKE 'camp:%' THEN (SELECT CASE WHEN json_valid(s.data)
          THEN CAST(COALESCE(json_extract(s.data, '$.name'), json_extract(s.data, '$.title')) AS TEXT) END
        FROM sync s WHERE s.kind = 'camp' AND s.rid = substr(l.ref, 6)
          AND (s.a_id = l.user_id OR s.b_id IS NULL OR s.b_id = l.user_id)
          AND EXISTS (SELECT 1 FROM deals d WHERE d.id = l.ref AND d.payer_id = s.a_id) LIMIT 1) END AS camp
    FROM ledger l WHERE l.user_id = ? AND (? = '' OR l.bucket = ?) AND (? = 0 OR l.id < ?)
    ORDER BY l.id DESC LIMIT ?`),
  /* Итоги для плиток кошелька — по всему журналу, не по странице. */
  myLedgerTotals: db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN kind = 'topup' THEN amount END), 0) AS topup,
      COALESCE(SUM(CASE WHEN kind IN ('payout','settle-payout') THEN amount END), 0) AS earned
    FROM ledger WHERE user_id = ? AND bucket = 'available'`),
  /* Рейтинг блогеров: одна выплата в журнале = одна закрытая сделка или
     принятое задание. Денег в рейтинге нет — только счётчик.
     Виды выплат два: обычная 'payout' и 'settle-payout' — деньги, которые
     арбитр присудил блогеру. Спор — это тоже выполненная работа, и не
     считать её значило бы наказывать за обращение к арбитру. */
  /* Считаем СДЕЛКИ, а не строки журнала: COUNT(DISTINCT ref). Бюджет
     кампании уходит частями — несколько раундов публикаций одному
     человеку под тем же ref, и это одна работа, а не три. */
  lbTop: db.prepare(`SELECT u.id, u.name,
      COUNT(DISTINCT COALESCE(l.ref, 'id:' || l.id)) AS deals, MAX(l.created_at) AS last_at
    FROM ledger l JOIN users u ON u.id = l.user_id
    WHERE l.kind IN ('payout','settle-payout') AND l.bucket = 'available' AND l.amount > 0 AND u.is_blocked = 0
    GROUP BY u.id ORDER BY deals DESC, last_at ASC, u.id ASC LIMIT ?`),
  lbTotal: db.prepare(`SELECT COUNT(DISTINCT l.user_id) AS n
    FROM ledger l JOIN users u ON u.id = l.user_id
    WHERE l.kind IN ('payout','settle-payout') AND l.bucket = 'available' AND l.amount > 0 AND u.is_blocked = 0`),
  lbMine: db.prepare(`SELECT COUNT(DISTINCT COALESCE(ref, 'id:' || id)) AS deals,
      MAX(created_at) AS last_at FROM ledger
    WHERE user_id = ? AND kind IN ('payout','settle-payout') AND bucket = 'available' AND amount > 0`),
  /* Место считаем ПО ТОМУ ЖЕ порядку, что и список (deals DESC, last_at ASC,
     id ASC). Со строгим «больше сделок» все с равным числом получали одно
     место: человек не попадал в десятку, а приложение писало ему «вы 2-й»
     и «вы в десятке», показывая первыми совсем других людей. Третий ключ —
     id: время в журнале с точностью до секунды, и у выплат одной секунды
     порядок иначе был бы случайным. */
  lbPlace: db.prepare(`SELECT COUNT(*) AS ahead FROM (
      SELECT l.user_id, COUNT(DISTINCT COALESCE(l.ref, 'id:' || l.id)) AS deals,
        MAX(l.created_at) AS last_at
      FROM ledger l JOIN users u ON u.id = l.user_id
      WHERE l.kind IN ('payout','settle-payout') AND l.bucket = 'available' AND l.amount > 0 AND u.is_blocked = 0
      GROUP BY l.user_id HAVING deals > ?
        OR (deals = ? AND (last_at < ? OR (last_at = ? AND l.user_id < ?))))`),
  syncGet: db.prepare('SELECT * FROM sync WHERE kind = ? AND rid = ?'),
  syncDel: db.prepare('DELETE FROM sync WHERE kind = ? AND rid = ?'),
  syncIns: db.prepare(`INSERT INTO sync (kind, rid, a_id, b_id, from_id, data, created_at)
    VALUES (?,?,?,?,?,?,?)`),
  /* Свои конверты + общие, новее ver; порядок по ver — это и есть лента.

     Общим (без адресата) может быть ТОЛЬКО кампания: её и правда видят
     все. Раньше без адресата раздавалось что угодно, и любой вошедший
     мог положить конверт вида «сообщение в чужой сделке» — оно доезжало
     до всех приложений и вклеивалось в переписку от чужого имени. */
  /* Чужое задание (аудит 16.10.2026) уезжает в ленту, только если автор
     хоть раз замораживал под него бюджет (сделка camp:<номер> с ним же
     плательщиком; любой её статус — чтобы «завершено» и пауза тоже
     доезжали до тех, кто задание уже видел). Без денег «задание» мог
     опубликовать кто угодно, в том числе блогер: текст с чужой ссылкой
     видели все. Своё автор получает всегда (второе устройство, черновой
     запуск). Когда бюджет заморозят ПОСЛЕ записи конверта, заморозка
     переписывает конверт новым ver (syncBump) — лента его отдаст. */
  syncPull: db.prepare(`SELECT ver, kind, rid, a_id, b_id, from_id, data, created_at, updated_at
    FROM sync WHERE ver > ? AND (a_id = ? OR b_id = ?
      OR (b_id IS NULL AND kind = 'camp' AND a_id NOT IN (SELECT id FROM users WHERE is_blocked = 1)
        AND EXISTS (SELECT 1 FROM deals d WHERE d.id = 'camp:' || sync.rid AND d.payer_id = sync.a_id)))
    ORDER BY ver ASC LIMIT ?`),
  syncMax: db.prepare('SELECT COALESCE(MAX(ver), 0) AS v FROM sync'),
  /* Задания — единственные конверты без адресата: их и так видит каждый
     вошедший. Для витрины гостя берём те же строки. */
  /* Задания заблокированного автора в общую ленту не попадают.
     Витрина гостя (аудит 16.10.2026) — только задания с бюджетом,
     замороженным сейчас (held): без денег объявление — просто текст. */
  /* Статус «active» — в самом запросе, ДО ограничения: иначе 60 свежих
     неактивных конвертов (завершённые, на паузе) вытесняли с витрины все
     активные. Бюджет витрины — из заморозки (held), не из текста конверта. */
  publicCamps: db.prepare(`SELECT s.rid, s.data, s.created_at, s.updated_at, d.amount AS held_amount
    FROM sync s JOIN deals d ON d.id = 'camp:' || s.rid AND d.payer_id = s.a_id AND d.status = 'held'
    WHERE s.kind = 'camp' AND s.b_id IS NULL AND s.a_id NOT IN (SELECT id FROM users WHERE is_blocked = 1)
      AND (CASE WHEN json_valid(s.data) THEN json_extract(s.data, '$.status') END) = 'active'
    ORDER BY s.ver DESC LIMIT ?`),
  /* пределы обмена (см. SYNC_CAMP_LIVE): занятое человеком — по последнему
     писавшему, задания — по автору; связь двух людей — для лимита новых
     личных диалогов */
  syncUse: db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(length(CAST(data AS BLOB))), 0) AS b
    FROM sync WHERE from_id = ?`),
  campCountAll: db.prepare(`SELECT COUNT(*) AS n FROM sync WHERE a_id = ? AND b_id IS NULL AND kind = 'camp'`),
  campCountLive: db.prepare(`SELECT COUNT(*) AS n FROM sync WHERE a_id = ? AND b_id IS NULL AND kind = 'camp' AND rid <> ?
    AND (CASE WHEN json_valid(data) THEN json_extract(data, '$.status') END) IN ('active', 'paused')`),
  syncTie: db.prepare(`SELECT 1 AS x FROM sync WHERE a_id = ? AND b_id = ?
    UNION ALL SELECT 1 FROM sync WHERE a_id = ? AND b_id = ?
    UNION ALL SELECT 1 FROM task_videos WHERE owner_id = ? AND blogger_id = ?
    UNION ALL SELECT 1 FROM task_videos WHERE owner_id = ? AND blogger_id = ?
    UNION ALL SELECT 1 FROM sync s JOIN task_members m ON m.camp_id = s.rid AND m.user_id = ?
      WHERE s.a_id = ? AND s.b_id IS NULL AND s.kind = 'camp'
    UNION ALL SELECT 1 FROM sync s JOIN task_members m ON m.camp_id = s.rid AND m.user_id = ?
      WHERE s.a_id = ? AND s.b_id IS NULL AND s.kind = 'camp'
    LIMIT 1`),
  /* ведёт задания = хоть одно своё задание с замороженным когда-либо бюджетом
     (конверт без денег положить может кто угодно) */
  syncHasCamp: db.prepare(`SELECT 1 AS x FROM sync s WHERE s.a_id = ? AND s.b_id IS NULL AND s.kind = 'camp'
    AND EXISTS (SELECT 1 FROM deals d WHERE d.id = 'camp:' || s.rid AND d.payer_id = s.a_id) LIMIT 1`),
  cardGet: db.prepare('SELECT * FROM cards WHERE id = ?'),
  cardsMine: db.prepare('SELECT id FROM cards WHERE user_id = ?'),
  cardIns: db.prepare('INSERT INTO cards (id, user_id, data, hidden) VALUES (?,?,?,?)'),
  cardUpd: db.prepare("UPDATE cards SET data = ?, updated_at = datetime('now') WHERE id = ?"),
  cardDel: db.prepare('DELETE FROM cards WHERE id = ? AND user_id = ?'),
  cardHide: db.prepare("UPDATE cards SET hidden = ?, updated_at = datetime('now') WHERE id = ?"),
  /* Общая кнопка витрины: updated_at не трогаем — порядок в пульте и
     «обновлена …» остаются про работу автора, а не про нажатие владельца. */
  cardsUnpublishAll: db.prepare('UPDATE cards SET hidden = 2 WHERE hidden = 0'),
  cardsRestoreAll: db.prepare('UPDATE cards SET hidden = 0 WHERE hidden = 2'),
  cardsStats: db.prepare(`SELECT COUNT(*) AS total,
      COALESCE(SUM(CASE WHEN c.hidden = 0 THEN 1 ELSE 0 END), 0) AS visible,
      COALESCE(SUM(CASE WHEN c.hidden = 0 AND u.is_blocked = 0 THEN 1 ELSE 0 END), 0) AS listed,
      COALESCE(SUM(CASE WHEN c.hidden = 1 THEN 1 ELSE 0 END), 0) AS hidden,
      COALESCE(SUM(CASE WHEN c.hidden = 2 THEN 1 ELSE 0 END), 0) AS unpublished
    FROM cards c JOIN users u ON u.id = c.user_id`),
  cardTombGet: db.prepare('SELECT hidden FROM card_tombs WHERE id = ?'),
  cardTombPut: db.prepare(`INSERT INTO card_tombs (id, user_id, hidden) VALUES (?,?,?)
    ON CONFLICT(id) DO UPDATE SET user_id = excluded.user_id, hidden = excluded.hidden, at = datetime('now')`),
  cardTombDel: db.prepare('DELETE FROM card_tombs WHERE id = ?'),
  cardTombsRestoreAll: db.prepare('DELETE FROM card_tombs WHERE hidden = 2'),
  /* Скрытие по одной — решение владельца об авторе, а не о номере карты:
     у автора есть карта или след удалённой со скрытием по одной — новая
     его карта ложится скрытой (hidden = 1) при любой витрине, и «Вернуть
     все» её не публикует. Снимает отметку «Вернуть» у его карты в пульте. */
  cardAuthorHid: db.prepare(`SELECT 1 AS x FROM cards WHERE user_id = ? AND hidden = 1
    UNION ALL SELECT 1 FROM card_tombs WHERE user_id = ? AND hidden = 1 LIMIT 1`),
  cardTombsAuthorClear: db.prepare('DELETE FROM card_tombs WHERE user_id = ? AND hidden = 1'),
  flagGet: db.prepare('SELECT value, at FROM server_flags WHERE key = ?'),
  flagSet: db.prepare(`INSERT INTO server_flags (key, value) VALUES (?,?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, at = datetime('now')`),
  flagDel: db.prepare('DELETE FROM server_flags WHERE key = ?'),
  cardsPublic: db.prepare(`SELECT c.id, c.user_id, c.data, c.updated_at
    FROM cards c JOIN users u ON u.id = c.user_id
    WHERE c.hidden = 0 AND u.is_blocked = 0
    ORDER BY c.updated_at DESC LIMIT ?`),
  /* Фото карточки весит до 300 КБ: сортируем узкий подзапрос, а из данных
     фото вырезаем ещё в базе — в пульте оно не показывается. */
  cardsAll: db.prepare(`SELECT c.id, c.user_id, c.hidden, c.updated_at,
      json_remove(c.data, '$.avatar') AS data, (json_extract(c.data, '$.avatar') IS NOT NULL) AS has_avatar,
      u.name AS owner, u.email AS owner_email, u.is_blocked AS owner_blocked
    FROM (SELECT id FROM cards ORDER BY updated_at DESC LIMIT 300) s
    JOIN cards c ON c.id = s.id JOIN users u ON u.id = c.user_id
    ORDER BY c.updated_at DESC`),
  insDeal: db.prepare('INSERT INTO deals (id, payer_id, payee_id, amount, status) VALUES (?,?,?,?,?)'),
  deal: db.prepare('SELECT * FROM deals WHERE id = ?'),
  updDeal: db.prepare(`UPDATE deals SET status = ?, payee_id = ?, updated_at = datetime('now') WHERE id = ?`),
  payDeal: db.prepare(`UPDATE deals SET paid = paid + ?, status = ?, updated_at = datetime('now') WHERE id = ?`),
  /* бюджет задания: пополнение и частичный возврат (11.10.2026) */
  growDeal: db.prepare(`UPDATE deals SET amount = amount + ?, updated_at = datetime('now') WHERE id = ? AND status = 'held'`),
  cutDeal: db.prepare(`UPDATE deals SET amount = amount - ?, updated_at = datetime('now') WHERE id = ? AND status = 'held'`),
  /* Бюджет задания, закрытый исчерпанием до 16.10.2026 (released, выплачено
     всё): пополнение открывает его снова. Денег в нём 0 — открывать безопасно;
     получателя у бюджета задания нет (его ставило старое закрытие). */
  reopenCampDeal: db.prepare(`UPDATE deals SET status = 'held', payee_id = NULL, updated_at = datetime('now')
    WHERE id = ? AND id LIKE 'camp:%' AND status = 'released' AND paid >= amount`),
  /* комиссии задания (14.10.2026) */
  setDealFees: db.prepare('UPDATE deals SET fee_pct = ?, pay_fee_pct = ?, fee_in = ? WHERE id = ?'),
  addFeeIn: db.prepare('UPDATE deals SET fee_in = fee_in + ? WHERE id = ?'),
  addFeeBack: db.prepare('UPDATE deals SET fee_back = fee_back + ? WHERE id = ?'),
  insWd: db.prepare('INSERT INTO withdrawals (user_id, amount, fee, net, requisites, status) VALUES (?,?,?,?,?,?)'),
  wd: db.prepare('SELECT * FROM withdrawals WHERE id = ?'),
  updWd: db.prepare(`UPDATE withdrawals SET status = ?, note = ?, updated_at = datetime('now') WHERE id = ?`),
  myWds: db.prepare('SELECT * FROM withdrawals WHERE user_id = ? ORDER BY id DESC LIMIT 50'),
  allWds: db.prepare(`SELECT w.*, u.email, u.name FROM withdrawals w
    JOIN users u ON u.id = w.user_id
    WHERE (? = '' OR w.status = ?) ORDER BY w.id DESC LIMIT 200`),
  totals: db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN bucket='available' THEN amount END), 0) AS available,
      COALESCE(SUM(CASE WHEN bucket='hold' THEN amount END), 0) AS hold
    FROM ledger`),
  /* доход сервиса — все комиссии на счёте 0: вывод (fee, до 14.10), пополнение,
     задание (за вычетом возвращённой с остатком бюджета), выплаты блогерам */
  platformIncome: db.prepare(`SELECT COALESCE(SUM(amount),0) AS fees
    FROM ledger WHERE user_id = 0 AND kind IN ('fee','topup-fee','task-fee','task-fee-back','payout-fee')`),
  paidOut: db.prepare(`SELECT COALESCE(SUM(net),0) AS s FROM withdrawals WHERE status = 'paid'`),
  /* внесено снаружи: зачисления на баланс И комиссия пополнения сверху —
     её человек тоже заплатил, она лежит на счёте сервиса (сверка) */
  toppedUp: db.prepare(`SELECT COALESCE(SUM(amount),0) AS s FROM ledger WHERE kind IN ('topup','topup-fee')`),
  /* из них ТЕСТОВЫЕ (аудит 16.10.2026): деньги «из воздуха» по кнопке
     тестового пополнения. В сверке они остаются (иначе она разойдётся
     ровно на них), но /admin показывает их отдельно — не как доход. */
  testTopped: db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN kind = 'topup' THEN amount END), 0) AS amount,
      COALESCE(SUM(CASE WHEN kind = 'topup-fee' THEN amount END), 0) AS fee,
      COUNT(DISTINCT CASE WHEN kind = 'topup' THEN user_id END) AS people
    FROM ledger WHERE (kind = 'topup' AND (ref = ? OR ref LIKE ? || ' · %'))
      OR (kind = 'topup-fee' AND ref = ?)`),
  testToppedBy: db.prepare(`SELECT COALESCE(SUM(amount),0) AS s FROM ledger
    WHERE user_id = ? AND kind = 'topup' AND (ref = ? OR ref LIKE ? || ' · %')`),
  openDeals: db.prepare(`SELECT d.id, d.amount, d.paid, d.payer_id, d.payee_id, d.created_at,
      u.name AS payer_name
    FROM deals d JOIN users u ON u.id = d.payer_id
    WHERE d.status = 'held' AND d.amount > d.paid ORDER BY d.created_at DESC LIMIT 100`),
  userLedger: db.prepare(`SELECT id, bucket, amount, kind, ref, created_at
    FROM ledger WHERE user_id = ? ORDER BY id DESC LIMIT 60`),
  /* Пульт · «Пользователи». Поиск делаем в JS: LIKE в SQLite не знает
     регистра кириллицы, «мария» не нашла бы «Марию». Людей пока немного,
     потолок 5000 строк держит запрос лёгким. */
  adminUsers: db.prepare(`SELECT u.id, u.name, u.email, u.role, u.created_at, u.is_admin, u.is_blocked, u.tg_id,
      (u.google_sub IS NOT NULL) AS google,
      COALESCE(b.av, 0) AS available, COALESCE(b.hd, 0) AS hold,
      (SELECT k.status FROM kyc_requests k WHERE k.user_id = u.id ORDER BY k.id DESC LIMIT 1) AS kyc,
      (SELECT COUNT(*) FROM channels c WHERE c.user_id = u.id) AS channels,
      (SELECT COUNT(*) FROM cards c WHERE c.user_id = u.id) AS cards
    FROM users u
    LEFT JOIN (SELECT user_id,
        SUM(CASE WHEN bucket = 'available' THEN amount END) AS av,
        SUM(CASE WHEN bucket = 'hold' THEN amount END) AS hd
      FROM ledger GROUP BY user_id) b ON b.user_id = u.id
    ORDER BY u.id DESC LIMIT 100000`),
  setBlocked: db.prepare('UPDATE users SET is_blocked = ? WHERE id = ?'),
  userKycLast: db.prepare(`SELECT id, name, birth, status, note, created_at, updated_at,
      (photo IS NOT NULL AND photo != '') AS has_photo, (selfie IS NOT NULL AND selfie != '') AS has_selfie
    FROM kyc_requests WHERE user_id = ? ORDER BY id DESC LIMIT 1`),
  userCards: db.prepare('SELECT id, hidden, updated_at, data FROM cards WHERE user_id = ? ORDER BY updated_at DESC'),
  userWds: db.prepare(`SELECT id, amount, fee, net, status, note, created_at, updated_at
    FROM withdrawals WHERE user_id = ? ORDER BY id DESC LIMIT 20`),
  insAdminLog: db.prepare('INSERT INTO admin_log (who, action, target, detail) VALUES (?,?,?,?)'),
  adminLogList: db.prepare('SELECT id, at, who, action, target, detail FROM admin_log ORDER BY id DESC LIMIT ?'),
  trimAdminLog: db.prepare(`DELETE FROM admin_log WHERE id NOT IN
    (SELECT id FROM admin_log ORDER BY id DESC LIMIT 20000)`),
  insError: db.prepare('INSERT INTO errors (user_id, message, where_at, version, ua) VALUES (?,?,?,?,?)'),
  /* Порядок однозначный: у checked_at разрешение в секунду, и две
     привязки подряд давали ничью — клиент брал строку наугад и мог
     показать канал прошлой привязки. */
  myChannels: db.prepare(`SELECT id, platform, external_id, title, url, subs, avatar, checked_at,
      username, verified, following, likes_total, videos_total, stats_at,
      risk, risk_level, risk_at, risk_why
    FROM channels WHERE user_id = ? ORDER BY checked_at DESC, id DESC`),
  /* Кого пора освежить: канал, у которого статистика старше суток. */
  staleChannels: db.prepare(`SELECT user_id, platform, external_id FROM channels
    WHERE platform = 'tiktok' AND (stats_at IS NULL OR stats_at < datetime('now', '-12 hours'))
    ORDER BY (stats_at IS NULL) DESC, stats_at ASC LIMIT ?`),
  /* Канал ищем ВНУТРИ аккаунта: один и тот же канал может быть подтверждён
     у нескольких людей, и «найти канал вообще» больше не имеет смысла —
     непонятно, чью строку вернули бы. */
  channelOf: db.prepare('SELECT * FROM channels WHERE user_id = ? AND platform = ? AND external_id = ?'),
  putToken: db.prepare(`INSERT INTO channel_tokens (user_id, platform, external_id, access, refresh, expires_at)
    VALUES (?,?,?,?,?,?)
    ON CONFLICT(user_id, platform, external_id) DO UPDATE SET
      access = excluded.access, refresh = excluded.refresh,
      expires_at = excluded.expires_at, updated_at = datetime('now')`),
  getToken: db.prepare('SELECT * FROM channel_tokens WHERE user_id = ? AND platform = ? AND external_id = ?'),
  delToken: db.prepare('DELETE FROM channel_tokens WHERE user_id = ? AND platform = ? AND external_id = ?'),
  /* Снимки статистики канала — тоже данные площадки: отвязали канал —
     удаляем вместе с доступом (политика конфиденциальности, раздел 6). */
  delStats: db.prepare('DELETE FROM channel_stats WHERE user_id = ? AND platform = ? AND external_id = ?'),
  chanNums: db.prepare(`UPDATE channels SET username = ?, verified = ?, following = ?,
      likes_total = ?, videos_total = ?, stats_at = datetime('now')
    WHERE user_id = ? AND platform = ? AND external_id = ?`),
  chanRisk: db.prepare(`UPDATE channels SET risk = ?, risk_level = ?, risk_why = ?, risk_at = datetime('now')
    WHERE user_id = ? AND platform = ? AND external_id = ?`),
  insStats: db.prepare(`INSERT INTO channel_stats
      (user_id, platform, external_id, followers, videos, med_views, avg_views,
       er_likes, er_comments, er_shares, risk, risk_level, data)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`),
  statsOf: db.prepare(`SELECT * FROM channel_stats
    WHERE user_id = ? AND platform = ? AND external_id = ? ORDER BY at DESC LIMIT ?`),
  channelsByExt: db.prepare('SELECT * FROM channels WHERE platform = ? AND external_id = ?'),
  delChannel: db.prepare('DELETE FROM channels WHERE user_id = ? AND platform = ? AND external_id = ?'),
  delChannelEverywhere: db.prepare('DELETE FROM channels WHERE platform = ? AND external_id = ?'),
  upsertChannel: db.prepare(`INSERT INTO channels (user_id, platform, external_id, title, url, subs, avatar)
    VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(user_id, platform, external_id) DO UPDATE SET
      title = excluded.title, url = excluded.url,
      subs = excluded.subs, avatar = excluded.avatar, checked_at = datetime('now')`),
  /* Группируем по тексту: сто раз одна ошибка — это одна поломка,
     а не сто. Владельцу важно, ЧТО ломается и у скольких людей. */
  errorGroups: db.prepare(`SELECT message, where_at,
      COUNT(*) AS n, COUNT(DISTINCT COALESCE(user_id, -1)) AS people,
      MAX(at) AS last_at, MIN(at) AS first_at
    FROM errors WHERE at > datetime('now', ?)
    GROUP BY message, where_at ORDER BY n DESC LIMIT 60`),
  errorCount: db.prepare(`SELECT COUNT(*) AS n,
      COUNT(DISTINCT COALESCE(user_id, -1)) AS people
    FROM errors WHERE at > datetime('now', '-1 day')`),
  trimErrors: db.prepare(`DELETE FROM errors WHERE id NOT IN
    (SELECT id FROM errors ORDER BY id DESC LIMIT 20000)`),
  insPay: db.prepare('INSERT INTO payments (id, user_id, amount, status) VALUES (?,?,?,?)'),
  payFee: db.prepare('UPDATE payments SET fee = ? WHERE id = ?'),
  payById: db.prepare('SELECT * FROM payments WHERE id = ?'),
  updPay: db.prepare(`UPDATE payments SET status = ?, updated_at = datetime('now') WHERE id = ?`),
  insKyc: db.prepare('INSERT INTO kyc_requests (user_id, name, birth, photo, selfie, status) VALUES (?,?,?,?,?,?)'),
  kycById: db.prepare('SELECT * FROM kyc_requests WHERE id = ?'),
  myLastKyc: db.prepare('SELECT * FROM kyc_requests WHERE user_id = ? ORDER BY id DESC LIMIT 1'),
  updKycData: db.prepare(`UPDATE kyc_requests SET name = ?, birth = ?, photo = ?, selfie = ?, note = NULL,
    updated_at = datetime('now') WHERE id = ?`),
  updKyc: db.prepare(`UPDATE kyc_requests SET status = ?, note = ?, updated_at = datetime('now') WHERE id = ?`),
  /* Список БЕЗ фото: 60 паспортов base64 — это десятки мегабайт на каждый
     автообмен консоли. Фото оператор берёт по одному, kycPhoto. */
  kycList: db.prepare(`SELECT k.id, k.user_id, k.name, k.birth, k.status, k.note,
      k.created_at, k.updated_at, u.email, u.name AS user_name,
      CASE WHEN length(k.photo) > 0 THEN 1 ELSE 0 END AS has_photo,
      CASE WHEN length(k.selfie) > 0 THEN 1 ELSE 0 END AS has_selfie
    FROM kyc_requests k JOIN users u ON u.id = k.user_id
    WHERE (? = '' OR k.status = ?)
    ORDER BY CASE k.status WHEN 'queued' THEN 0 ELSE 1 END, k.id DESC LIMIT 60`),
  kycPhoto: db.prepare('SELECT id, photo, selfie, updated_at FROM kyc_requests WHERE id = ?'),
  kycQueuedCount: db.prepare(`SELECT COUNT(*) AS n FROM kyc_requests WHERE status = 'queued'`),
  /* споры */
  paidTo: db.prepare(`SELECT 1 AS x FROM ledger
    WHERE ref = ? AND user_id = ? AND kind IN ('payout','settle-payout') LIMIT 1`),
  /* Споры, которые держат возврат: спор плательщика (payee_id пуст),
     спор назначенного исполнителя и спор того, кому по сделке уже
     платили. Спор постороннего «по себе» возврату не помеха.
     Бюджет задания (camp:<id>, аудит 16.10.2026): спор ОДНОГО блогера
     держит только его начисления (vidSettle, ручную выплату ему), а не
     возврат автору — иначе блогер одним запросом запирал весь бюджет.
     Его будущие выплаты и так не вернуть: живые ролики держат свою часть
     (vidReturnable/vidOwed), полный возврат ждёт конца их подсчёта. */
  refundBlocked: db.prepare(`SELECT 1 AS x FROM disputes d
    WHERE d.deal_id = ? AND d.status = 'open' AND (
      d.payee_id IS NULL
      OR (d.deal_id NOT LIKE 'camp:%' AND (
        d.payee_id = ?
        OR EXISTS (SELECT 1 FROM ledger l WHERE l.ref = ? AND l.user_id = d.payee_id
                   AND l.kind IN ('payout','settle-payout'))))
    ) LIMIT 1`),
  /* /admin · «Спорные деньги»: открытые споры со сторонами (аудит 16.10.2026). */
  openDisputesAdmin: db.prepare(`SELECT ds.id, ds.deal_id, ds.payee_id, ds.opened_by, ds.created_at,
      d.status AS deal_status, d.amount, d.paid, d.payer_id, d.payee_id AS deal_payee_id,
      pu.name AS payer_name, pu.email AS payer_email,
      ou.name AS opener_name, ou.email AS opener_email,
      eu.name AS payee_name, eu.email AS payee_email
    FROM disputes ds
    LEFT JOIN deals d ON d.id = ds.deal_id
    LEFT JOIN users pu ON pu.id = d.payer_id
    LEFT JOIN users ou ON ou.id = ds.opened_by
    LEFT JOIN users eu ON eu.id = ds.payee_id
    WHERE ds.status = 'open' ORDER BY ds.id DESC LIMIT 200`),
  paidToSum: db.prepare(`SELECT COALESCE(SUM(amount), 0) AS s FROM ledger
    WHERE ref = ? AND user_id = ? AND kind IN ('payout','settle-payout')`),
  vidLiveOf: db.prepare(`SELECT COUNT(*) AS n FROM task_videos
    WHERE camp_id = ? AND blogger_id = ? AND status IN ('review','active','rejected')`),
  openDisputeFor: db.prepare(`SELECT id, opened_by FROM disputes
    WHERE deal_id = ? AND status = 'open' AND (payee_id IS NULL OR payee_id = ?) LIMIT 1`),
  openDisputeAny: db.prepare(`SELECT id, opened_by FROM disputes WHERE deal_id = ? AND status = 'open' LIMIT 1`),
  openDisputeExact: db.prepare(`SELECT id, opened_by FROM disputes
    WHERE deal_id = ? AND status = 'open' AND ((payee_id IS NULL AND ? IS NULL) OR payee_id = ?) LIMIT 1`),
  insDispute: db.prepare(`INSERT INTO disputes (deal_id, payee_id, opened_by, status) VALUES (?,?,?,'open')`),
  closeDisputesAll: db.prepare(`UPDATE disputes SET status = 'closed', closed_at = datetime('now')
    WHERE deal_id = ? AND status = 'open'`),
  closeDisputesFor: db.prepare(`UPDATE disputes SET status = 'closed', closed_at = datetime('now')
    WHERE deal_id = ? AND status = 'open' AND payee_id = ?`),
  /* /admin · «Снять спор» по строке (аудит 16.10.2026): ровно этот спор —
     снятие спора плательщика «по всей сделке» не трогает споры блогеров. */
  closeDisputeById: db.prepare(`UPDATE disputes SET status = 'closed', closed_at = datetime('now')
    WHERE id = ? AND deal_id = ? AND status = 'open'`),
  /* Снятие спора ТЕМ, КТО ЕГО ОТКРЫЛ. Отдельные запросы, а не общий
     UPDATE: тогда чужую строку нельзя закрыть даже по недосмотру. */
  closeDisputesByOpener: db.prepare(`UPDATE disputes SET status = 'closed', closed_at = datetime('now')
    WHERE deal_id = ? AND status = 'open' AND opened_by = ?`),
  closeDisputesForByOpener: db.prepare(`UPDATE disputes SET status = 'closed', closed_at = datetime('now')
    WHERE deal_id = ? AND status = 'open' AND payee_id = ? AND opened_by = ?`),
  /* уведомления на телефон */
  pushIns: db.prepare(`INSERT INTO push_subs (endpoint, user_id, p256dh, auth, ua) VALUES (?,?,?,?,?)
    ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh,
      auth = excluded.auth, ua = excluded.ua, seen_at = datetime('now')`),
  pushOf: db.prepare('SELECT endpoint, p256dh, auth FROM push_subs WHERE user_id = ?'),
  pushDel: db.prepare('DELETE FROM push_subs WHERE endpoint = ?'),
  pushDelMine: db.prepare('DELETE FROM push_subs WHERE endpoint = ? AND user_id = ?'),
  pushCount: db.prepare('SELECT COUNT(*) AS n FROM push_subs'),
  /* выплаты по кампаниям, чтобы рекламодатель видел расход на любом устройстве */
  /* Прибавки за видео (v3 — до ~30 на ролик) идут отдельным списком со
     своим пределом: иначе они вытесняли бы из 500 строк выплаты по старому
     пути. Итог по ролику (выплачено всего) — myVidPaid, одной строкой. */
  myReleases: db.prepare(`SELECT op_key, result, created_at FROM ops
    WHERE user_id = ? AND kind = 'release' AND op_key NOT LIKE 'sys:vidpay:%' ORDER BY created_at DESC LIMIT 500`),
  myVidReleases: db.prepare(`SELECT op_key, result, created_at FROM ops
    WHERE user_id = ? AND kind = 'release' AND op_key LIKE 'sys:vidpay:%' ORDER BY created_at DESC LIMIT 500`),
  myVidPaid: db.prepare(`SELECT id, camp_id, blogger_id, paid, paid_at FROM task_videos
    WHERE owner_id = ? AND paid > 0 ORDER BY id DESC LIMIT 5000`),
  /* ── «Загрузить видео» (механика v3, VIDEO-SPEC.md, раздел 11) ── */
  vidIns: db.prepare(`INSERT INTO task_videos (camp_id, owner_id, blogger_id, platform, external_id,
      video_id, url, handle, title, duration, posted_at, views, likes, comments, shares, stats_at,
      status, terms, submit_views, reserved, top_views, last_try_at, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'review',?,?,?,?,?,?,?)`),
  vidById: db.prepare('SELECT * FROM task_videos WHERE id = ?'),
  vidByVideo: db.prepare('SELECT id, blogger_id FROM task_videos WHERE platform = ? AND video_id = ?'),
  vidByCamp: db.prepare('SELECT * FROM task_videos WHERE camp_id = ? ORDER BY id DESC LIMIT 500'),
  vidMineCamp: db.prepare('SELECT * FROM task_videos WHERE camp_id = ? AND blogger_id = ? ORDER BY id DESC LIMIT 500'),
  vidMineAll: db.prepare(`SELECT * FROM task_videos WHERE blogger_id = ? OR owner_id = ?
    ORDER BY id DESC LIMIT 500`),
  vidDel: db.prepare("DELETE FROM task_videos WHERE id = ? AND status = 'review'"),
  vidDelHist: db.prepare('DELETE FROM task_video_stats WHERE video_row = ?'),
  vidHist: db.prepare(`SELECT day, views, likes, comments, shares FROM task_video_stats
    WHERE video_row = ? ORDER BY day ASC LIMIT 400`),
  vidSnap: db.prepare(`INSERT INTO task_video_stats (video_row, day, views, likes, comments, shares, at)
    VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(video_row, day) DO UPDATE SET views = excluded.views, likes = excluded.likes,
      comments = excluded.comments, shares = excluded.shares, at = excluded.at`),
  /* Цифры и промахи пишем только строке, которая ещё в работе: между
     чтением строки и ответом площадки её мог закрыть владелец или
     выплата, и старый снимок не должен её «оживить». Оплаченной строке
     цифры обновляются только для показа (до конца срока подсчёта): сумма
     (earned, paid) здесь не трогается никогда. top_views только растёт —
     начисление идёт по наибольшим просмотрам. */
  vidNums: db.prepare(`UPDATE task_videos SET views = ?, top_views = MAX(COALESCE(top_views, 0), ?),
      likes = ?, comments = ?, shares = ?,
      title = COALESCE(?, title), duration = COALESCE(?, duration), stats_at = ?, miss = 0, last_miss_at = NULL,
      updated_at = ? WHERE id = ? AND status IN ('review','active','paid')`),
  vidMiss: db.prepare(`UPDATE task_videos SET miss = miss + 1, last_miss_at = ?, updated_at = ?
    WHERE id = ? AND status IN ('review','active')`),
  vidRemove: db.prepare(`UPDATE task_videos SET status = 'removed', updated_at = ?
    WHERE id = ? AND status IN ('review','active')`),
  vidTry: db.prepare('UPDATE task_videos SET last_try_at = ? WHERE id = ?'),
  vidTerms: db.prepare('UPDATE task_videos SET terms = ? WHERE id = ? AND terms IS NULL'),
  vidRisk: db.prepare(`UPDATE task_videos SET risk = ?, risk_level = ?, risk_why = ?, risk_at = ?,
      risk_hold = ?, updated_at = ? WHERE id = ?`),
  /* Зачёт рекламодателем: ролик переходит в «засчитано — считаем
     просмотры» на VID_TRACK_DAYS суток; первый замер и первое начисление
     идут сразу следом (vidAccrue). */
  vidAccept: db.prepare(`UPDATE task_videos SET status = 'active', reviewed_at = ?, approved_at = ?,
      track_ends_at = ?, updated_at = ? WHERE id = ? AND status = 'review'`),
  vidReviewBad: db.prepare(`UPDATE task_videos SET status = 'rejected', review_note = ?, reviewed_at = ?,
      updated_at = ? WHERE id = ? AND status = 'review'`),
  /* Рекламодатель молчит — ролик засчитан сам (decision = 'auto'). */
  vidAutoOk: db.prepare(`UPDATE task_videos SET status = 'active', reviewed_at = ?, approved_at = ?,
      track_ends_at = ?, decision = 'auto', decided_at = ?, updated_at = ? WHERE id = ? AND status = 'review'`),
  vidReviewStale: db.prepare(`SELECT * FROM task_videos WHERE status = 'review' AND created_at <= ?
    ORDER BY created_at ASC LIMIT 200`),
  vidDecide: db.prepare(`UPDATE task_videos SET status = ?, decision = ?, decision_note = ?, decided_at = ?,
      approved_at = ?, risk_hold = ?, pay_hold = 0, hold_kind = NULL, pay_why = NULL, pay_tries = 0,
      decided_views = ?, frozen = ?, track_ends_at = COALESCE(?, track_ends_at), updated_at = ?
    WHERE id = ? AND status = ?`),
  /* Владелец засчитал ролик, стоявший на паузе за накрутку: наибольшие
     просмотры и начисленное — заново, по цифрам на момент решения (пик,
     отмеченный как накрутка, больше не считается; выплаченное не трогаем). */
  vidRebase: db.prepare('UPDATE task_videos SET top_views = ?, earned = ?, updated_at = ? WHERE id = ?'),
  /* Начислено по наибольшим просмотрам — только растёт. */
  vidEarned: db.prepare(`UPDATE task_videos SET earned = ?, updated_at = ?
    WHERE id = ? AND status = 'active' AND COALESCE(earned, 0) < ?`),
  /* Прибавка выплачена (внутри moneyOp): выплачено всего и просмотры, за
     которые заплачено (null — заплачена только часть, просмотры прежние). */
  vidAccrued: db.prepare(`UPDATE task_videos SET paid = ?, paid_at = ?, paid_views = COALESCE(?, paid_views), updated_at = ?
    WHERE id = ? AND status = 'active'`),
  /* Заплатили часть прибавки (заморозки не хватило) — строка остаётся
     засчитанной, остаток ждёт владельца. */
  vidShort: db.prepare(`UPDATE task_videos SET pay_hold = 1, hold_kind = 'money', pay_why = ?, updated_at = ?
    WHERE id = ? AND status = 'active'`),
  /* Подсчёт закончен: максимум за ролик взят, срок вышел или считать
     больше нечем (цифры заморожены). Статус paid — деньги больше не идут. */
  vidEnd: db.prepare(`UPDATE task_videos SET status = 'paid', pay_hold = 0, hold_kind = NULL, pay_why = NULL,
      pay_tries = 0, pay_note = COALESCE(?, pay_note), updated_at = ? WHERE id = ? AND status = 'active'`),
  /* Сколько раз подряд не удался замер (сбой площадки). */
  vidTries: db.prepare(`UPDATE task_videos SET pay_tries = ?, updated_at = ? WHERE id = ? AND status = 'active'`),
  /* Финальный замер снят (или считать больше нечем): цифры больше не
     опрашиваются, начисление — по тому, что есть. */
  vidFreeze: db.prepare(`UPDATE task_videos SET frozen = 1, pay_tries = 0, updated_at = ? WHERE id = ? AND status = 'active'`),
  vidTrackSet: db.prepare('UPDATE task_videos SET track_ends_at = ? WHERE id = ? AND track_ends_at IS NULL'),
  vidNotified: db.prepare('UPDATE task_videos SET notif_at = ?, notif_paid = ? WHERE id = ?'),
  vidPayHold: db.prepare(`UPDATE task_videos SET pay_hold = 1, hold_kind = ?, pay_why = ?, updated_at = ?
    WHERE id = ? AND status = 'active' AND COALESCE(pay_hold, 0) = 0`),
  vidUnhold: db.prepare(`UPDATE task_videos SET pay_hold = 0, hold_kind = NULL, pay_why = NULL, pay_tries = 0,
      updated_at = ? WHERE id = ? AND status = 'active' AND hold_kind IN ('measure','access')`),
  /* Пауза «в бюджете не хватило денег» снимается, когда в заморозке задания
     снова есть деньги (пополнение — vidBudgetResume, или круг — vidSettle). */
  vidUnholdMoney: db.prepare(`UPDATE task_videos SET pay_hold = 0, hold_kind = NULL, pay_why = NULL,
      updated_at = ? WHERE id = ? AND status = 'active' AND pay_hold = 1 AND hold_kind = 'money'`),
  vidMoneyHeld: db.prepare(`SELECT id FROM task_videos WHERE camp_id = ? AND status = 'active'
      AND pay_hold = 1 AND hold_kind = 'money' AND COALESCE(risk_hold, 0) = 0
    ORDER BY COALESCE(approved_at, created_at) ASC, id ASC LIMIT 200`),
  /* Замер не удался по вине доступа (блогер отвязал канал или отозвал
     доступ, канал отключил владелец): ролик, может быть, уже удалён, и
     начислять по старым цифрам нельзя. Пауза 'access' — в очереди
     владельца; круг пробует снова раз в 3 часа и сам продолжает подсчёт,
     когда блогер переподключит канал. */
  vidAccessHold: db.prepare(`UPDATE task_videos SET pay_hold = 1, hold_kind = 'access', pay_why = ?, pay_tries = 0,
      updated_at = ? WHERE id = ? AND status = 'active' AND COALESCE(risk_hold, 0) = 0
      AND (COALESCE(pay_hold, 0) = 0 OR hold_kind IN ('measure','access'))`),
  /* Отвязал канал — снимаем только то, что ещё ждёт проверки рекламодателя.
     Засчитанные (active) остаются: их подсчёт продолжит круг, когда блогер
     переподключит канал, или решит владелец (пауза 'access'). */
  vidRevokable: db.prepare(`SELECT * FROM task_videos
    WHERE blogger_id = ? AND platform = ? AND external_id = ? AND status = 'review'`),
  vidRevokeOne: db.prepare(`UPDATE task_videos SET status = 'revoked', updated_at = ?
    WHERE id = ? AND status = 'review'`),
  /* Кого пора освежить ТОЛЬКО цифрами (раз в сутки, порог 20 ч): ролики
     на проверке и уже закрытые подсчётом (paid) — эти только для показа,
     пока не вышел срок подсчёта (у строк v2 — 30 суток с публикации).
     Засчитанные (active) замеряет и оплачивает vidAccrue (vidAccrueDue).
     Замороженный не опрашиваем. Очередь — по последней попытке: ролики,
     которые площадка не отдаёт, не стоят вечно впереди остальных.
     Оплаченный ролик после неудачной попытки ждёт сутки от попытки, а не
     от замера: иначе мёртвый доступ дёргал бы площадку каждые полчаса.
     Ролик на проверке, который площадка один раз не вернула, ждёт
     следующего замера VID_MISS_GAP_MS от промаха ($miss): раньше второй
     промах всё равно не считается, а запрос каждые полчаса тратил квоту
     YouTube (аудит 16.10.2026, #32). */
  vidDue: db.prepare(`SELECT * FROM task_videos WHERE COALESCE(frozen, 0) = 0
    AND (status = 'review'
      OR (status = 'paid' AND COALESCE(track_ends_at, COALESCE(posted_at, created_at) + $track) > $now
        AND ($force = 1 OR COALESCE(last_try_at, 0) < $stale)))
    AND ($force = 1 OR stats_at IS NULL OR stats_at < $stale)
    AND ($force = 1 OR last_miss_at IS NULL OR last_miss_at < $miss)
    ORDER BY COALESCE(last_try_at, 0) ASC, id ASC LIMIT $lim`),
  /* Каким засчитанным пора к vidAccrue (замер + прибавка):
     - замороженные (финальный замер уже снят или считать нечем) — каждый
       круг, пока их не держит владелец (накрутка, деньги): ждут только
       снятия спора и закрываются без запроса к площадке;
     - пауза «нет доступа» — не чаще раза в 3 часа;
     - остальные — раз в сутки (порог 20 ч), а с вышедшим сроком — сразу
       (финальный замер), повтор после сбоя — не чаще раза в 20 минут;
       после промаха (площадка не вернула ролик) — не раньше VID_MISS_GAP_MS
       от него ($miss: раньше второй промах не считается), а с вышедшим
       сроком — не чаще раза в 3 часа ($access): финальный замер ещё
       успеет, если ролик вернётся (аудит 16.10.2026, #32).
     force — все засчитанные (кнопка владельца и проверки). */
  vidAccrueDue: db.prepare(`SELECT id FROM task_videos WHERE status = 'active' AND (
      $force = 1
      OR (COALESCE(frozen, 0) = 1 AND COALESCE(risk_hold, 0) = 0
        AND NOT (COALESCE(pay_hold, 0) = 1 AND COALESCE(hold_kind, '') = 'money'))
      OR (COALESCE(frozen, 0) = 0 AND COALESCE(pay_hold, 0) = 1 AND COALESCE(hold_kind, '') = 'access'
        AND COALESCE(last_try_at, 0) < $access)
      OR (COALESCE(frozen, 0) = 0 AND NOT (COALESCE(pay_hold, 0) = 1 AND COALESCE(hold_kind, '') = 'access')
        AND COALESCE(last_try_at, 0) < $retry
        AND (stats_at IS NULL OR stats_at < $stale OR COALESCE(track_ends_at, 0) <= $now)
        AND (last_miss_at IS NULL
          OR last_miss_at < (CASE WHEN COALESCE(track_ends_at, 0) <= $now THEN $access ELSE $miss END))))
    ORDER BY COALESCE(last_try_at, 0) ASC, id ASC LIMIT 200`),
  /* Ролики оффера, по которым деньги ещё могут уйти блогеру. */
  vidLive: db.prepare(`SELECT * FROM task_videos WHERE camp_id = ? AND status IN ('review','active','rejected')`),
  /* Очередь владельца: вернул рекламодатель; пауза по накрутке или по
     деньгам (пауза «нет замера» решается кругом сама); выплату держит
     открытый спор. */
  vidQueueCount: db.prepare(`SELECT COUNT(*) AS n FROM task_videos v
    WHERE v.status = 'rejected'
      OR (v.status IN ('review','active') AND (v.risk_hold = 1
        OR (v.pay_hold = 1 AND COALESCE(v.hold_kind, '') <> 'measure')))
      OR (v.status = 'active' AND EXISTS (SELECT 1 FROM disputes d WHERE d.deal_id = 'camp:' || v.camp_id
        AND d.status = 'open' AND (d.payee_id IS NULL OR d.payee_id = v.blogger_id)))
      OR (v.status = 'active' AND EXISTS (SELECT 1 FROM users bu WHERE bu.id = v.blogger_id AND bu.is_blocked = 1))`),
  /* Пульт: ролик вместе с тем, что владельцу нужно для решения, — чей
     оффер, кто блогер, что за канал и как его оценили. Заблокированный
     блогер (аудит 16.10.2026): засчитанные ролики — в очереди, деньги по
     ним стоят (vidSettle), решение — «Не засчитывать» или разблокировать. */
  vidAdmin: db.prepare(`SELECT v.*,
      COALESCE(json_extract(s.data, '$.name'), json_extract(s.data, '$.title')) AS camp_name,
      o.email AS owner_email, o.name AS owner_name, b.email AS blogger_email, b.name AS blogger_name,
      b.is_blocked AS blogger_blocked,
      c.title AS channel_title, c.risk_level AS channel_risk_level
    FROM task_videos v
    LEFT JOIN sync s ON s.kind = 'camp' AND s.rid = v.camp_id
    LEFT JOIN users o ON o.id = v.owner_id
    LEFT JOIN users b ON b.id = v.blogger_id
    LEFT JOIN channels c ON c.user_id = v.blogger_id AND c.platform = v.platform AND c.external_id = v.external_id
    WHERE ($st = 'all')
      OR ($st = 'queue' AND (v.status = 'rejected'
        OR (v.status IN ('review','active') AND (v.risk_hold = 1
          OR (v.pay_hold = 1 AND COALESCE(v.hold_kind, '') <> 'measure')))
        OR (v.status = 'active' AND EXISTS (SELECT 1 FROM disputes d WHERE d.deal_id = 'camp:' || v.camp_id
          AND d.status = 'open' AND (d.payee_id IS NULL OR d.payee_id = v.blogger_id)))
        OR (v.status = 'active' AND b.is_blocked = 1)))
      OR ($st = 'rejected' AND v.status = 'rejected')
      OR ($st = 'review' AND v.status = 'review')
      OR ($st = 'active' AND v.status = 'active')
      OR ($st = 'paid' AND v.status = 'paid')
      OR ($st = 'risk' AND (v.risk_hold = 1 OR v.risk_level IN ('risk','bad')))
    ORDER BY v.id DESC LIMIT 300`),
  /* Подтверждённые каналы блогера на площадке вместе с наличием доступа. */
  vidChannels: db.prepare(`SELECT c.platform, c.external_id, c.username, c.title, c.avatar, c.risk_level,
      (t.access IS NOT NULL) AS has_token
    FROM channels c LEFT JOIN channel_tokens t
      ON t.user_id = c.user_id AND t.platform = c.platform AND t.external_id = c.external_id
    WHERE c.user_id = ? AND c.platform = ? ORDER BY c.id ASC`),
  /* Окно «Загрузка видео»: свои каналы TikTok и YouTube и есть ли чем
     спросить площадку. Токены наружу не уходят — только признак. */
  vidAccounts: db.prepare(`SELECT c.platform, c.external_id, c.username, c.title, c.avatar,
      (t.access IS NOT NULL) AS has_token, (t.refresh IS NOT NULL AND t.refresh <> '') AS has_refresh,
      t.expires_at
    FROM channels c LEFT JOIN channel_tokens t
      ON t.user_id = c.user_id AND t.platform = c.platform AND t.external_id = c.external_id
    WHERE c.user_id = ? AND c.platform IN ('tiktok','youtube','instagram') ORDER BY c.id ASC`),
  /* ── Участники задания и лидерборд ── */
  tmJoin: db.prepare(`INSERT INTO task_members (camp_id, user_id, joined_at) VALUES (?,?,?)
    ON CONFLICT(camp_id, user_id) DO UPDATE SET
      joined_at = CASE WHEN task_members.left_at IS NULL THEN task_members.joined_at ELSE excluded.joined_at END,
      left_at = NULL`),
  tmGet: db.prepare('SELECT * FROM task_members WHERE camp_id = ? AND user_id = ?'),
  tmLeave: db.prepare('UPDATE task_members SET left_at = ? WHERE camp_id = ? AND user_id = ? AND left_at IS NULL'),
  tmCount: db.prepare(`SELECT COUNT(*) AS n FROM task_members m JOIN users u ON u.id = m.user_id
    WHERE m.camp_id = ? AND m.left_at IS NULL AND u.is_blocked = 0`),
  /* Участники — как у More Views: у кого больше роликов в задании — выше,
     при равенстве — кто вступил раньше (решение владельца 06.10). */
  tmList: db.prepare(`SELECT m.user_id, m.joined_at, u.name,
      (SELECT COUNT(*) FROM task_videos v WHERE v.camp_id = m.camp_id AND v.blogger_id = m.user_id
        AND v.status IN ('review','rejected','active','paid')) AS vids
    FROM task_members m JOIN users u ON u.id = m.user_id
    WHERE m.camp_id = ? AND m.left_at IS NULL AND u.is_blocked = 0
    ORDER BY vids DESC, m.joined_at ASC, m.user_id ASC LIMIT ? OFFSET ?`),
  /* Открытая карточка в каталоге (та же, что отдаёт всем /api/cards):
     по ней приложение открывает профиль участника и чат с ним. */
  cardPubOf: db.prepare(`SELECT c.id FROM cards c JOIN users u ON u.id = c.user_id
    WHERE c.user_id = ? AND c.hidden = 0 AND u.is_blocked = 0 ORDER BY c.updated_at DESC LIMIT 1`),
  /* Лидерборд: по блогеру — засчитанные и ожидающие ролики, их просмотры
     и ВЫПЛАЧЕНО ВСЕГО в этом задании (v3: деньги приходят прибавками, и
     выплаченное за ролик, который потом удалили или не засчитали,
     остаётся у блогера — оно тоже в сумме). Порядок — по просмотрам;
     «по сумме выплаты» пересортировывает vidBoardSorted. */
  boardRows: db.prepare(`SELECT v.blogger_id AS uid, u.name,
      SUM(CASE WHEN v.status IN ('review','rejected','active','paid') THEN 1 ELSE 0 END) AS videos,
      COALESCE(SUM(CASE WHEN v.status IN ('review','rejected','active','paid') THEN v.views ELSE 0 END), 0) AS views,
      COALESCE(SUM(v.paid), 0) AS earned, MIN(v.created_at) AS first_at
    FROM task_videos v JOIN users u ON u.id = v.blogger_id
    WHERE v.camp_id = ? AND (v.status IN ('review','rejected','active','paid') OR COALESCE(v.paid, 0) > 0)
      AND u.is_blocked = 0
    GROUP BY v.blogger_id
    ORDER BY views DESC, earned DESC, first_at ASC, v.blogger_id ASC LIMIT 5000`),
  /* Выплаты по роликам задания — для сумм «на баланс» (комиссия с каждого). */
  boardPaid: db.prepare(`SELECT blogger_id AS uid, paid FROM task_videos
    WHERE camp_id = ? AND COALESCE(paid, 0) > 0`),
  /* Канал, с которого у блогера самый смотримый ролик в этом задании. */
  boardChan: db.prepare(`SELECT platform, external_id, handle FROM task_videos
    WHERE camp_id = ? AND blogger_id = ? AND status IN ('review','rejected','active','paid')
    ORDER BY views DESC, id ASC LIMIT 1`),
  /* Основной подтверждённый канал — для участника без роликов. */
  mainChan: db.prepare(`SELECT platform, external_id, username, title, avatar FROM channels
    WHERE user_id = ? AND platform IN ('tiktok','youtube','instagram') ORDER BY id ASC LIMIT 1`),
  lastStats: db.prepare(`SELECT med_views, followers, er_likes FROM channel_stats
    WHERE user_id = ? AND platform = ? AND external_id = ? ORDER BY at DESC, id DESC LIMIT 1`),
  /* Публичная сводка заданий для карточек «Главной» (режим как у More
     Views): по каждому активному общему заданию — роликов, просмотров,
     выплачено и заморожено. Ролики и просмотры — ровно как в лидерборде
     (boardRows): те же статусы, то же поле v.views, блогер не заблокирован.
     Иначе карточка на «Главной» и шторка задания показали бы разные цифры.
     Задания заблокированного автора не попадают, как и в общую ленту.
     json_valid под CASE: один конверт с битым JSON иначе уронил бы весь
     запрос (json_extract на нём бросает). */
  tasksSummary: db.prepare(`SELECT s.rid AS id,
      COALESCE(d.amount, 0) AS budget, COALESCE(d.paid, 0) AS paid,
      (SELECT COUNT(*) FROM task_videos v JOIN users u ON u.id = v.blogger_id
        WHERE v.camp_id = s.rid AND v.status IN ('review','rejected','active','paid') AND u.is_blocked = 0) AS videos,
      (SELECT COALESCE(SUM(v.views), 0) FROM task_videos v JOIN users u ON u.id = v.blogger_id
        WHERE v.camp_id = s.rid AND v.status IN ('review','rejected','active','paid') AND u.is_blocked = 0) AS views
    FROM sync s LEFT JOIN deals d ON d.id = 'camp:' || s.rid
    WHERE s.kind = 'camp' AND s.b_id IS NULL
      AND s.a_id NOT IN (SELECT id FROM users WHERE is_blocked = 1)
      AND (CASE WHEN json_valid(s.data) THEN json_extract(s.data, '$.status') END) = 'active'
    ORDER BY s.ver DESC LIMIT ?`),
};

/* ── ВХОД ПО ТЕЛЕГРАМУ ────────────────────────────────────────────────
   Телеграм передаёт мини-аппу строку initData с подписью. Проверять её
   ОБЯЗАТЕЛЬНО на сервере: без проверки любой может подставить чужой
   telegram-id и войти под чужим именем — строка приходит из браузера,
   где её ничто не защищает.

   Схема из документации Телеграма:
     секрет = HMAC-SHA256(ключ: "WebAppData", данные: токен бота)
     подпись = HMAC-SHA256(ключ: секрет, данные: пары ключ=значение,
               отсортированные по алфавиту, через перевод строки,
               без самого поля hash)
   Совпало — данные подлинные.                                        */
function checkInitData(initData, maxAgeSec) {
  if (!BOT_TOKEN) return { ok: false, why: 'Вход по Телеграму не настроен: в .env нет BOT_TOKEN' };
  if (typeof initData !== 'string' || !initData) return { ok: false, why: 'Пустые данные Телеграма' };

  let params;
  try { params = new URLSearchParams(initData); }
  catch (e) { return { ok: false, why: 'Данные Телеграма не разобрались' }; }

  const hash = params.get('hash');
  if (!hash) return { ok: false, why: 'В данных нет подписи' };

  const pairs = [];
  for (const [k, v] of params.entries()) {
    if (k !== 'hash') pairs.push(k + '=' + v);
  }
  pairs.sort();

  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const mine = crypto.createHmac('sha256', secret).update(pairs.join('\n')).digest('hex');

  /* Сравнение постоянного времени: обычное === подсказывает по скорости,
     сколько первых знаков угадано. */
  const a = Buffer.from(mine, 'utf8');
  const b = Buffer.from(String(hash), 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, why: 'Подпись не сходится — данные подделаны или токен бота не тот' };
  }

  /* Свежесть: старую подпись могли подсмотреть и переиспользовать. */
  const authDate = Number(params.get('auth_date') || 0);
  const age = Math.floor(Date.now() / 1000) - authDate;
  if (!authDate || age > (maxAgeSec || 86400)) {
    return { ok: false, why: 'Данные Телеграма устарели — переоткройте приложение' };
  }

  let user = null;
  try { user = JSON.parse(params.get('user') || 'null'); }
  catch (e) { /* ниже */ }
  if (!user || !user.id) return { ok: false, why: 'В данных нет пользователя' };

  return { ok: true, tg: user, authDate };
}

/* ── ЮKassa: два вызова их API ─────────────────────────────────────
   Создать платёж и прочитать платёж. Вебхуку на слово не верим:
   что бы ни пришло, статус перечитывается напрямую из кассы. */
async function ykApi(method, path, body, idemKey) {
  const headers = {
    'Authorization': 'Basic ' + Buffer.from(YK_SHOP_ID + ':' + YK_SECRET).toString('base64'),
    'Content-Type': 'application/json',
  };
  if (idemKey) headers['Idempotence-Key'] = idemKey;
  const res = await fetch('https://api.yookassa.ru/v3' + path, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),   /* зависшая касса не должна вешать сервер */
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(j.description || ('ЮKassa: HTTP ' + res.status));
    e.httpStatus = 502;
    /* Свой ответ кассы сохраняем отдельно: по нему вебхук отличает
       внятный отказ («нет такого платежа») от сбоя связи, после
       которого уведомление надо попросить повторить. */
    e.ykStatus = res.status;
    throw e;
  }
  return j;
}

/* Зачисление оплаченного платежа. Идемпотентно: ключ операции — id
   платежа, второй раз журнал его не пропустит. Сумму и получателя
   берём из ответа кассы, а не из запроса. */
function creditYkPayment(p) {
  if (!p || p.status !== 'succeeded') return { ok: false, status: (p && p.status) || 'unknown' };
  const uid = Number(p.metadata && p.metadata.userId) || 0;
  const paidSum = Math.round(Number(p.amount && p.amount.value) || 0);
  if (!uid || !q.userById.get(uid) || paidSum <= 0) return { ok: false, status: 'bad-payment' };
  /* Комиссия пополнения сверху (14.10.2026): заплачено 10 700 ₽ — на баланс
     10 000 ₽, 700 ₽ — сервису. Делим по своей строке платежа (её сумма и
     комиссия), если она сходится с оплаченным; иначе — по ставке от оплаты. */
  const row = q.payById.get(p.id);
  let amount, fee;
  if (row && row.user_id === uid && row.amount > 0 && row.amount + (row.fee || 0) === paidSum) {
    amount = row.amount; fee = row.fee || 0;
  } else {
    amount = Math.round(paidSum * 100 / (100 + TOPUP_FEE_PCT));
    fee = paidSum - amount;
  }
  const r = moneyOp('yk:' + p.id, uid, 'topup', (add) => {
    add(uid, 'available', amount, 'topup', 'пополнение ЮKassa ' + p.id + (fee > 0 ? ' · оплачено ' + paidSum + ', комиссия ' + fee : ''));
    if (fee > 0) add(0, 'available', fee, 'topup-fee', 'комиссия пополнения ЮKassa ' + p.id);
    return { ok: true, credited: amount, fee, paid: paidSum };
  });
  if (r.status === 200) {
    try { q.updPay.run('succeeded', p.id); } catch (e) { /* строки могло не быть */ }
    wakeUser(uid, 'money');
    return { ok: true, status: 'succeeded' };
  }
  /* Зачисление не прошло (сбой транзакции) — строку платежа НЕ помечаем:
     следующий вебхук или опрос статуса повторит зачисление. Пометить
     «succeeded» без денег в журнале — значит потерять платёж навсегда. */
  console.error('[pay] платёж', p.id, 'оплачен, но зачисление не прошло:', r.status, r.body && r.body.error);
  return { ok: false, status: 'credit-failed' };
}

function scrypt(password, salt) {
  return crypto.scryptSync(String(password), salt, 32, { N: 16384, r: 8, p: 1 }).toString('hex');
}
function newToken() { return crypto.randomBytes(32).toString('hex'); }

function amountOk(x) {
  return Number.isInteger(x) && x > 0 && x <= MAX_AMOUNT;
}

/* Пространство ключей операций, куда пользователю ходу нет: его занимает
   пульт оператора. Раньше пульт брал ключи вида bp-op-paid-<id>, и их
   можно было занять заранее — тогда настоящая выплата не проводилась.
   Ключи пульта теперь строит сервер (sysKey), а эти приставки в теле
   запроса отклоняются. */
/* Приставка yk: — ключ зачисления платежа ЮKassa (moneyOp('yk:' + id)).
   Без неё в этом списке человек мог заранее занять ключ своего будущего
   платежа: касса потом отвечала «эта операция уже проведена», и деньги
   не зачислялись вовсе. */
/* Приставка invoice: (16.10.2026) — так до этого дня назывался ключ
   зачисления счёта из /admin ('invoice:' + номер). Номера идут подряд, и
   кто угодно мог заранее занять сотни будущих ключей обычной заморозкой
   на 1 ₽: оплаченный компанией счёт потом не зачислялся (409). Сейчас
   счёт зачисляется ключом sysKey('invoice', id); старую приставку тоже
   держим закрытой — по ней узнаются прежние зачисления. Других ключей,
   которые сервер строит сам, без sys: нет (yk: — выше; комиссии
   task-fee/payout-fee/topup-fee — строки журнала внутри той же операции,
   а не отдельные ключи). */
const RESERVED_OP = /^\s*(sys:|bp-op-|yk:|invoice:)/i;
function userKey(raw) {
  const k = String(raw || '');
  return RESERVED_OP.test(k) ? '' : k;
}
const badKey = { status: 400, body: { error: 'Такой ключ операции занят служебным пространством' } };
function sysKey(kind, id) { return 'sys:' + kind + ':' + id; }

/* Денежная операция целиком в одной транзакции.
   build(add) — тело: зовёт add(userId, bucket, amount, kind, ref) и
   возвращает объект-результат. Если внутри что-то бросило —
   откатывается всё, включая строку идемпотентности. */
function moneyOp(opKey, userId, kind, build) {
  if (!opKey || typeof opKey !== 'string' || opKey.length < 8 || opKey.length > 80) {
    return { status: 400, body: { error: 'Нужен opKey — ключ операции (8–80 символов)' } };
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    const seen = q.opByKey.get(opKey);
    if (seen) {
      db.exec('ROLLBACK');
      /* Тот же ключ, другой пользователь или другой смысл — это не повтор,
         а коллизия ключей: честная ошибка вместо чужого результата. */
      if (seen.user_id !== userId || seen.kind !== kind) {
        return { status: 409, body: { error: 'opKey уже занят другой операцией' } };
      }
      return { status: 200, body: Object.assign(JSON.parse(seen.result), { repeated: true }) };
    }
    q.insOp.run(opKey, userId, kind, '{}');

    const touched = new Set();
    const add = (uid, bucket, amount, k, ref) => {
      q.insLedger.run(opKey, uid, bucket, amount, k, ref || null);
      touched.add(uid);
      /* новая выплата меняет рейтинг блогеров — кэш списка сбрасываем сразу */
      if (k === 'payout' || k === 'settle-payout') lbCache.at = 0;
      /* и сводку заданий: выплата или заморозка по заданию меняет «выплачено N ₽ из M ₽» */
      if (k === 'payout' || k === 'settle-payout' || String(ref || '').startsWith('camp:')) tsumCache.at = 0;
    };

    const result = build(add);

    /* Главный инвариант: ни у кого из затронутых не ушло в минус. */
    for (const uid of touched) {
      if (uid === 0) continue;               /* счёт платформы копит комиссию */
      const b = q.balance.get(uid);
      if (b.available < 0 || b.hold < 0) {
        throw httpError(409, 'Недостаточно средств');
      }
    }

    q.updOpResult.run(JSON.stringify(result), opKey);
    db.exec('COMMIT');
    return { status: 200, body: result };
  } catch (e) {
    db.exec('ROLLBACK');
    if (e && e.httpStatus) return { status: e.httpStatus, body: { error: e.message } };
    console.error('[money]', e);
    return { status: 500, body: { error: 'Операция не проведена' } };
  }
}

/* Сколько комиссии задания вернуть вместе с возвратом части бюджета
   (14.10.2026): комиссия — за ПОТРАЧЕННОЕ. Возвращаем % от возвращаемой
   суммы (с округлением вниз — см. pctDown), но не больше, чем взято минус
   уже возвращённое минус % от уже выплаченного блогерам. Ставит возврат в
   той же операции. */
function dealFeeBack(add, d, sum) {
  const p = Number(d && d.fee_pct) || 0;
  if (p <= 0 || sum <= 0) return 0;
  const room = (Number(d.fee_in) || 0) - (Number(d.fee_back) || 0) - pctUp(d.paid, p);
  const back = Math.max(0, Math.min(room, pctDown(sum, p)));
  if (back > 0) {
    add(0, 'available', -back, 'task-fee-back', d.id);
    add(d.payer_id, 'available', back, 'task-fee-back', d.id);
    q.addFeeBack.run(back, d.id);
  }
  return back;
}
/* Полный возврат: вся невыбранная комиссия (взято − возвращено − % от выплаченного). */
function dealFeeBackAll(add, d) {
  const p = Number(d && d.fee_pct) || 0;
  if (p <= 0) return 0;
  const back = Math.max(0, (Number(d.fee_in) || 0) - (Number(d.fee_back) || 0) - pctUp(d.paid, p));
  if (back > 0) {
    add(0, 'available', -back, 'task-fee-back', d.id);
    add(d.payer_id, 'available', back, 'task-fee-back', d.id);
    q.addFeeBack.run(back, d.id);
  }
  return back;
}

/* Выплата из заморозки: hold плательщика → available получателя.
   Одно движение на оба пути — кнопку рекламодателя (/api/deals/release)
   и прибавки за видео по мере роста просмотров (vidPayStep), — чтобы журнал у них был
   одинаковым до строки: рейтинг, расход кампании и сверка читают именно
   его. Зовётся ТОЛЬКО внутри moneyOp. true — заморозка исчерпана. */
/* Комиссия с выплаты блогеру (14.10.2026): у заморозки задания с
   pay_fee_pct > 0 из суммы выплаты получателю уходит сумма минус процент,
   процент — сервису (payout-fee). Округление — по НАКОПЛЕННОМУ: комиссия
   этой части = % от выплаченного после минус % от выплаченного до, тогда
   сумма частей ровно равна % от всего (у ролика — по его выплатам, см.
   vidPayStep; у ручной выплаты — по заморозке). fee можно передать готовой. */
function dealPayFee(d, sum, before) {
  const p = Number(d && d.pay_fee_pct) || 0;
  if (p <= 0 || sum <= 0) return 0;
  const b = Math.max(0, Number(before == null ? d.paid : before) || 0);
  return Math.max(0, Math.min(sum, pctUp(b + sum, p) - pctUp(b, p)));
}
function dealPayMoves(add, d, payeeId, sum, fee) {
  const cut = fee == null ? dealPayFee(d, sum) : Math.max(0, Math.min(sum, fee));
  add(d.payer_id, 'hold', -sum, 'release', d.id);
  if (sum - cut > 0) add(payeeId, 'available', sum - cut, 'payout', d.id);   /* 1 ₽ при комиссии 1 ₽ — строки «+0» нет */
  if (cut > 0) add(0, 'available', cut, 'payout-fee', d.id);
  const done = (d.paid + sum) >= d.amount;
  /* Бюджет задания (camp:<id>) при исчерпании НЕ закрываем (аудит 16.10.2026):
     остаток 0, но заморозка открыта — рекламодатель её пополнит
     (/api/deals/topup), и недоплата роликам уйдёт сама (vidBudgetResume).
     Раньше она становилась released навсегда: пополнить было нельзя, а
     недоплата блогерам висела без выхода. Закрывают её только возврат
     (refund) и решение арбитра (settle). Обычная сделка — как прежде. */
  const keep = /^camp:/.test(String(d.id));
  q.payDeal.run(sum, done && !keep ? 'released' : 'held', d.id);
  if (done && !keep) q.updDeal.run('released', d.payee_id != null ? d.payee_id : payeeId, d.id);
  /* бюджет задания потрачен весь — сверх % от потраченного комиссии не держим
     (рубль-другой от округления вверх при запуске и пополнениях — назад) */
  if (done && Number(d.fee_pct) > 0) dealFeeBackAll(add, Object.assign({}, d, { paid: d.paid + sum }));
  return done;
}

function httpError(status, message) {
  const e = new Error(message);
  e.httpStatus = status;
  return e;
}

/* журнал обращений к вебхуку кассы — для простого ограничения частоты */
let whLog = [];

/* ── HTTP-обвязка ──────────────────────────────────────────────────── */

function send(res, status, body, extra) {
  const txt = JSON.stringify(body);
  res.writeHead(status, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': ORIGIN,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Admin-Key, X-Admin-Session',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Cache-Control': 'no-store',
  }, extra || {}));
  res.end(txt);
}

/* Тело как есть (для запросов площадок формой). */
function readRaw(req, limit) {
  const max = limit || 16 * 1024;
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > max) { reject(httpError(413, 'Слишком большой запрос')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
/* Подписанный запрос Meta: «подпись.данные» в base64url, подпись —
   HMAC-SHA256 данных секретом приложения Instagram. */
function igSigned(sr) {
  const secret = OAUTH.instagram && OAUTH.instagram.secret;
  if (!secret) return null;
  const parts = String(sr || '').split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const b64 = (x) => Buffer.from(x.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  let data;
  try { data = JSON.parse(b64(parts[1]).toString('utf8')); } catch (e) { return null; }
  if (!data || String(data.algorithm || '').toUpperCase() !== 'HMAC-SHA256') return null;
  const want = crypto.createHmac('sha256', secret).update(parts[1]).digest();
  const got = b64(parts[0]);
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
  return data;
}
/* Отключили приложение / просят удалить данные: этот Instagram отвязываем
   у всех, кто его подключал, — доступ, снимки статистики, ролики на проверке
   (как при отвязке владельцем). На удаление Meta ждёт адрес и код. */
async function handleIgSigned(req, res, url) {
  if (!rateLimit(req, 'igsigned', 60, 60000)) return send(res, tooOften.status, tooOften.body);
  let raw = '';
  try { raw = await readRaw(req, 16 * 1024); } catch (e) { return send(res, 413, { error: 'Слишком большой запрос' }); }
  const data = igSigned(new URLSearchParams(raw).get('signed_request'));
  if (!data || data.user_id == null || !/^\d{1,30}$/.test(String(data.user_id))) return send(res, 400, { error: 'Подпись не сошлась' });
  const ext = String(data.user_id);
  const rows = q.channelsByExt.all('instagram', ext);
  try { q.delChannelEverywhere.run('instagram', ext); } catch (e) { /* уже нет */ }
  for (const r of rows) {
    try { q.delToken.run(r.user_id, 'instagram', ext); } catch (e) { /* мог не сохраниться */ }
    try { q.delStats.run(r.user_id, 'instagram', ext); } catch (e) { /* снимков могло не быть */ }
    try { vidRevoke(r.user_id, 'instagram', ext, 'gone'); } catch (e) { /* не главное */ }
  }
  if (url.pathname.endsWith('/delete')) {
    const code = crypto.randomBytes(8).toString('hex');
    return send(res, 200, { url: PUBLIC_URL + '/privacy.html#delete', confirmation_code: code });
  }
  return send(res, 200, { ok: true });
}

/* Обход тела без рекурсии: '' — всё хорошо, иначе текст отказа. */
function bodyTrap(root) {
  if (root === null || typeof root !== 'object') return '';
  const stack = [[root, 1]];
  const own = Object.prototype.hasOwnProperty;
  while (stack.length) {
    const [o, d] = stack.pop();
    if (d > 100) return 'Слишком глубокая вложенность в теле запроса';
    if (!Array.isArray(o) && (own.call(o, 'toString') || own.call(o, 'valueOf'))) {
      return 'Недопустимое поле в теле запроса';
    }
    for (const k in o) {
      const v = o[k];
      if (v !== null && typeof v === 'object') stack.push([v, d + 1]);
    }
  }
  return '';
}
function readBody(req, limit) {
  const max = limit || 64 * 1024;
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > max) { reject(httpError(413, 'Слишком большой запрос')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        /* Поля-ловушки (аудит 16.10.2026): {"toString":1} или {"valueOf":1}
           роняют String(поле) TypeError'ом — 500 на ~45 маршрутах и тревоги
           владельцу, которые глушили настоящие. Вложенность в тысячи уровней
           роняла JSON.stringify (RangeError). Отвергаем и то и другое. */
        const bad = bodyTrap(parsed);
        if (bad) return reject(httpError(400, bad));
        /* «null» и «строка» — валидный JSON, но маршруты ждут объект:
           без этого body.что-нибудь бросает TypeError и плодит ложные 500. */
        resolve(parsed !== null && typeof parsed === 'object' ? parsed : {});
      }
      catch (e) { reject(httpError(400, 'Тело запроса — не JSON')); }
    });
    req.on('error', reject);
  });
}

/* Токен сессии из заголовка (для «кроме этой сессии»). */
function bearerOf(req) {
  const m = /^Bearer\s+([a-f0-9]{64})$/i.exec(String(req.headers.authorization || ''));
  return m ? m[1] : '';
}
/* Промахи старого пароля при смене: id → { n, at } */
const pwChgMiss = new Map();
/* «В сети» в чатах (15.10.2026): когда человек последний раз ходил на
   сервер со своим входом. Открытое приложение опрашивает ленту раз в
   15 с (в открытом чате — чаще), так что «в сети» = приложение открыто
   последние PRESENCE_MS. Только в памяти: после перезапуска — «не в сети». */
const seenAt = new Map();
const PRESENCE_MS = 75 * 1000;

function auth(req) {
  const h = String(req.headers.authorization || '');
  const m = /^Bearer\s+([a-f0-9]{64})$/i.exec(h);
  if (!m) return null;
  const row = q.session.get(m[1]);
  if (!row) return null;
  if (row.expires_at < new Date().toISOString()) { q.delSession.run(row.token); return null; }
  if (row.is_blocked) return null;
  seenAt.set(row.id, Date.now());   /* строка сессии — это u.* (id человека), без user_id */
  return row;
}

/* Неудачные попытки по адресу: подбор ключа владельца должен упираться в
   стену, а не идти со скоростью сети. Считаем только ПРОМАХИ — у своих
   оператор работает без ограничений. */
const adminMiss = new Map();
const ADMIN_MISS_MAX = 8;
const ADMIN_MISS_WINDOW = 10 * 60 * 1000;
function adminBlocked(req) {
  const ip = clientIp(req);
  const rec = adminMiss.get(ip);
  if (!rec) return false;
  if (Date.now() - rec.at > ADMIN_MISS_WINDOW) { adminMiss.delete(ip); return false; }
  return rec.n >= ADMIN_MISS_MAX;
}
function adminMissed(req) {
  const ip = clientIp(req);
  const now = Date.now();
  const rec = adminMiss.get(ip);
  if (!rec || now - rec.at > ADMIN_MISS_WINDOW) {
    adminMiss.set(ip, { n: 1, at: now });
    return;
  }
  rec.n += 1;
  rec.at = now;
  if (rec.n === ADMIN_MISS_MAX) {
    tgAlert('admin:brute:' + ip, '🚨 Подбор ключа владельца\n\nАдрес ' + ip
      + ' ошибся ключом ' + ADMIN_MISS_MAX + ' раз. Дальнейшие попытки с него отклоняются'
      + ' десять минут. Если это не вы — смените ADMIN_KEY.', 'server');
  }
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of adminMiss) if (now - rec.at > ADMIN_MISS_WINDOW) adminMiss.delete(ip);
}, 5 * 60 * 1000).unref();

/* ── Сессия владельца ──
   Раньше ключ спрашивали дважды: отдельно приложение, отдельно пульт
   выплат на своей странице. Теперь ключ вводится ОДИН раз (а тому, кто
   вошёл своей почтой из ADMIN_EMAIL, — вообще не нужен): сервер ставит
   куку, и обе страницы работают по ней.
   Кука подписана ключом владельца, поэтому её не подделать и хранить
   её негде — состояние в самой куке. HttpOnly: скрипту страницы она
   не видна. SameSite=Strict: чужой сайт её не приложит.
   Отдельная страховка от подделки запроса с чужого сайта — заголовок
   X-Admin-Session на всём, что меняет данные: поставить его из чужой
   формы нельзя, а наши страницы ставят его всегда. */
const ADMIN_SESSION_MS = 12 * 60 * 60 * 1000;
function adminSign(exp, label) {
  /* label — кто вошёл (почта владельца или «ключ владельца»), base64url.
     Подписывается вместе со сроком: подменить имя в куке нельзя. Старые
     куки без метки (формат «срок.подпись») по-прежнему действуют. */
  const what = label ? ('adm:' + exp + ':' + label) : ('adm:' + exp);
  return crypto.createHmac('sha256', ADMIN_KEY || 'нет-ключа').update(what).digest('hex').slice(0, 32);
}
function adminLabel(who) { return Buffer.from(String(who || '').slice(0, 120), 'utf8').toString('base64url'); }
function cookieOf(req, name) {
  const raw = String(req.headers.cookie || '');
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return '';
}
function adminCookie(req, exp, who) {
  /* Смотрим на ВЫЧИСЛЕННЫЙ адрес (PUBLIC_URL выше = externalBase(ENV) ||
     …), а не на сырую настройку: у хостинга внешний адрес приходит в
     DOMAIN, а ENV.PUBLIC_URL так и остаётся http://127.0.0.1:8090 —
     и кука с доступом к пульту выплат уезжала без Secure по живому https. */
  const https = /^https:/i.test(PUBLIC_URL)
    || /^https:/i.test(String(ENV.PUBLIC_URL || ''))
    || String(req.headers['x-forwarded-proto'] || '') === 'https';
  const label = who ? adminLabel(who) : '';
  return 'bp_admin=' + encodeURIComponent(label ? (exp + '.' + label + '.' + adminSign(exp, label)) : (exp + '.' + adminSign(exp)))
    + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=' + Math.floor(ADMIN_SESSION_MS / 1000)
    + (https ? '; Secure' : '');
}
/* Билет на один переход. Пульт выплат Телеграм открывает во ВНЕШНЕМ
   браузере — куки приложения там нет, и ключ спросили бы снова. Поэтому
   приложение берёт у сервера короткий подписанный билет и открывает
   пульт по ссылке с ним; пульт сразу меняет билет на сессию и стирает
   его из адреса. Билет живёт две минуты и срабатывает один раз. */
const TICKET_MS = 2 * 60 * 1000;
const ticketsUsed = new Map();
function ticketSign(exp, nonce) {
  return crypto.createHmac('sha256', ADMIN_KEY || 'нет-ключа')
    .update('tkt:' + exp + ':' + nonce).digest('hex').slice(0, 32);
}
function ticketMake() {
  const exp = Date.now() + TICKET_MS;
  const nonce = crypto.randomBytes(9).toString('hex');
  return exp + '.' + nonce + '.' + ticketSign(exp, nonce);
}
function ticketOk(raw) {
  if (!ADMIN_KEY) return false;
  const parts = String(raw || '').split('.');
  if (parts.length !== 3) return false;
  const exp = Number(parts[0]);
  if (!Number.isFinite(exp) || exp <= Date.now()) return false;
  const a = Buffer.from(parts[2], 'utf8'), b = Buffer.from(ticketSign(exp, parts[1]), 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  /* второй раз тот же билет не пройдёт */
  const now = Date.now();
  for (const [k, t] of ticketsUsed) if (t < now) ticketsUsed.delete(k);
  if (ticketsUsed.has(parts[1])) return false;
  ticketsUsed.set(parts[1], exp);
  return true;
}
/* Разбор куки владельца: null — нет или не подходит, иначе {exp, who}. */
function adminCookieParse(req) {
  if (!ADMIN_KEY) return null;
  const parts = cookieOf(req, 'bp_admin').split('.');
  if (parts.length !== 2 && parts.length !== 3) return null;
  const exp = Number(parts[0]);
  if (!Number.isFinite(exp) || exp <= Date.now()) return null;
  const label = parts.length === 3 ? parts[1] : '';
  if (label && !/^[A-Za-z0-9_-]{1,200}$/.test(label)) return null;
  const a = Buffer.from(parts[parts.length - 1], 'utf8'), b = Buffer.from(adminSign(exp, label), 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let who = '';
  try { who = label ? Buffer.from(label, 'base64url').toString('utf8') : ''; } catch (e) { who = ''; }
  return { exp, who };
}
function adminCookieOk(req) { return !!adminCookieParse(req); }
/* Телеграм-id владельца для входа в админку из бота: ADMIN_CHAT_ID (личный
   чат = номер человека) и необязательный список ADMIN_TG_IDS. Только
   положительные номера: у групп id отрицательный — группа не человек. */
function adminTgIds() {
  return [String(ENV.ADMIN_CHAT_ID || '')].concat(String(ENV.ADMIN_TG_IDS || '').split(/[\s,;]+/))
    .map((x) => x.trim()).filter((x) => /^\d{3,20}$/.test(x));
}
function adminCookieWho(req) { const c = adminCookieParse(req); return c ? c.who : ''; }
/* Кто нажал кнопку в пульте — для журнала действий. */
function adminWho(req) {
  try { const u = auth(req); if (u && u.is_admin) return String(u.email || ('id ' + u.id)); } catch (e) { /* ниже */ }
  try { const c = adminCookieParse(req); if (c) return c.who || 'сессия пульта'; } catch (e) { /* ниже */ }
  return 'ключ';
}
function adminLog(req, action, target, detail) {
  try {
    q.insAdminLog.run(adminWho(req), String(action).slice(0, 40),
      target == null ? null : String(target).slice(0, 80),
      detail == null ? null : String(detail).slice(0, 300));
  } catch (e) { console.error('[admin_log]', e && e.message); }
}
/* Карточка каталога для пульта — сводка без фото: фото весит до 300 КБ,
   а в списке их до трёхсот. */
function cardBrief(raw) {
  let d = {};
  try { d = JSON.parse(raw || '{}') || {}; } catch (e) { d = {}; }
  const pd = (d.platData && typeof d.platData === 'object') ? d.platData : {};
  const plats = (Array.isArray(d.platforms) && d.platforms.length ? d.platforms : Object.keys(pd))
    .filter((p) => CARD_PLATS.includes(p));
  let from = 0;
  const ig = (d.integrations && typeof d.integrations === 'object') ? d.integrations : {};
  for (const p of Object.keys(ig)) {
    if (!Array.isArray(ig[p])) continue;
    for (const x of ig[p]) { const v = Number(x && x.price) || 0; if (v > 0 && (!from || v < from)) from = v; }
  }
  return {
    name: String(d.name || '').slice(0, 60),
    initials: String(d.initials || '').slice(0, 4),
    col: String(d.col || '').slice(0, 64),
    platforms: plats.map((p) => ({
      id: p, url: String((pd[p] && pd[p].url) || '').slice(0, 300),
      subs: Math.max(0, Math.round(Number(pd[p] && pd[p].subs) || 0)),
      verified: !!(pd[p] && pd[p].verified),
    })),
    topics: (Array.isArray(d.topics) ? d.topics : []).slice(0, 5).map((t) => String(t).slice(0, 40)),
    priceFrom: from,
    msg: String(d.msg || '').slice(0, 160),
    hasAvatar: !!d.avatar,
  };
}

function isAdmin(req) {
  /* Сначала вошедший владелец: ему перебирать нечего. */
  const u = auth(req);
  if (u && u.is_admin) return true;
  /* Сессия, выданная после единственного ввода ключа. */
  if (adminCookieOk(req)
      && (req.method === 'GET' || String(req.headers['x-admin-session'] || '') === '1')) return true;
  const given = String(req.headers['x-admin-key'] || '');
  if (!given) return false;
  if (adminBlocked(req)) return false;
  const a = Buffer.from(given, 'utf8'), b = Buffer.from(ADMIN_KEY, 'utf8');
  if (b.length && a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
  adminMissed(req);
  return false;
}

/* Почты владельцев из настроек: такие аккаунты получают права админа сами
   при входе — вводить ключ не нужно.
   ADMIN_EMAIL=почта или почта1,почта2

   ОСТОРОЖНО, ЗДЕСЬ БЫЛА ДЫРА. Права давались всякому, у кого в аккаунте
   стоит этот адрес, а почту при регистрации никто не подтверждает. Пока
   аккаунта с адресом владельца в базе не было — свежая выкладка,
   сброшенный том хостинга, вторая почта в списке — завести его мог кто
   угодно и получить всю площадку: чужие балансы, фотографии паспортов,
   реестр выплат, вход в любой аккаунт. Адрес владельца не секрет: он
   стоит в политике конфиденциальности и в письмах.

   Закрыто в POST /api/register: зарегистрироваться НА адрес владельца
   можно только предъявив ключ (X-Admin-Key). Сам вход по почте остался
   как был — владельцу по-прежнему ничего вводить не нужно. */
const ADMIN_EMAILS = String(ENV.ADMIN_EMAIL || '')
  .split(/[,;\s]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);
function syncAdminFlag(user) {
  try {
    if (!user || !user.email) return user;
    const should = ADMIN_EMAILS.includes(String(user.email).toLowerCase()) ? 1 : Number(user.is_admin || 0);
    if (should !== Number(user.is_admin || 0)) {
      q.setAdmin.run(should, user.id);
      user.is_admin = should;
    }
    return user;
  } catch (e) { return user; }
}
/* Права, взятые ключом (/api/admin/claim), живут, пока жив этот ключ
   (аудит 16.10.2026): ключ утёк → владелец меняет ADMIN_KEY и
   перезапускает сервер → у всех, кто не в ADMIN_EMAIL и брал права
   другим ключом, is_admin снимается. Раньше флаг оставался навсегда, а
   заблокировать «владельца» нельзя. */
const ADMIN_FP = ADMIN_KEY
  ? crypto.createHmac('sha256', ADMIN_KEY).update('admin-claim').digest('hex').slice(0, 32) : '';
try {
  if (ADMIN_FP_NEW && ADMIN_FP) db.prepare('UPDATE users SET admin_fp = ? WHERE is_admin = 1').run(ADMIN_FP);
  for (const r of db.prepare('SELECT id, email, admin_fp FROM users WHERE is_admin = 1').all()) {
    if (ADMIN_EMAILS.includes(String(r.email || '').toLowerCase())) continue;
    if (ADMIN_FP && r.admin_fp === ADMIN_FP) continue;
    q.setAdmin.run(0, r.id);
    console.warn('[BloggerPay] права владельца сняты с аккаунта id ' + r.id + ': ключ владельца сменён');
  }
} catch (e) { console.error('[admin_fp]', (e && e.message) || e); }

/* ── Ограничение частоты ───────────────────────────────────────────
   Скользящее окно по IP в памяти. Защищает дорогие и абузные ручки
   (регистрация, вход, паспорт, платежи) от перебора и заливки.
   За прокси (Caddy/nginx) поставьте TRUST_PROXY=1 — адрес возьмётся
   из X-Forwarded-For, который прокси перезаписывает сам. */
const TRUST_PROXY = String(ENV.TRUST_PROXY || '') === '1';
/* Снять лимиты совсем — только явным флагом и только для тестов. Раньше
   их снимал адрес 127.0.0.1, и это было опасно: за обратным прокси ВСЕ
   запросы приходят с петли, так что лимиты молча выключались целиком. */
const RL_OFF = String(ENV.RL_DISABLE || '') === '1';
const rlMap = new Map();
function clientIp(req) {
  if (TRUST_PROXY) {
    /* Берём ПОСЛЕДНЮЮ запись X-Forwarded-For, а не первую. Caddy и nginx
       не переписывают заголовок, а дописывают адрес в конец — значит
       первую запись сочиняет кто угодно. Взяв первую, мы бы позволили
       одной строчкой в заголовке притвориться другим адресом и обойти
       защиту от перебора паролей. Последняя запись — та, что дописал
       наш собственный прокси. */
    const parts = String(req.headers['x-forwarded-for'] || '')
      .split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
    /* Прокси, который X-Forwarded-For не пишет, обычно ставит X-Real-IP
       (nginx: proxy_set_header X-Real-IP $remote_addr) — он его
       перезаписывает, а не дописывает. */
    const real = String(req.headers['x-real-ip'] || '').trim();
    if (/^[0-9a-f:.]{2,45}$/i.test(real)) return real;
  }
  return String((req.socket && req.socket.remoteAddress) || '');
}
/* Ставить ли TRUST_PROXY (аудит 16.10.2026). Bothost сам снимает TLS и
   проксирует на контейнер — тогда адрес сокета у всех людей один (адрес
   прокси), и лимиты частоты, и замок владельца после 8 промахов ключом
   срабатывают на весь сайт сразу. Значения панели читать нельзя (там
   секреты), поэтому сервер сам один раз пишет в журнал, что видит: адрес
   сокета и есть ли X-Forwarded-For / X-Real-IP. Две строки на запуск
   максимум — первый запрос без заголовков прокси (проверка живости
   хостинга) и первый с ними. То же — в /admin (overview.прокси). */
const proxySeen = { plain: null, fwd: null };
function proxyProbe(req) {
  if (proxySeen.plain && proxySeen.fwd) return;
  try {
    const h = req.headers || {};
    const xff = String(h['x-forwarded-for'] || '').trim().slice(0, 200);
    const xri = String(h['x-real-ip'] || '').trim().slice(0, 64);
    const fwd = !!(xff || xri);
    const slot = fwd ? 'fwd' : 'plain';
    if (proxySeen[slot]) return;
    const sock = String((req.socket && req.socket.remoteAddress) || '');
    proxySeen[slot] = { at: new Date().toISOString(), socket: sock, xff: !!xff, xri: !!xri, ip: clientIp(req) };
    let verdict;
    if (fwd && !TRUST_PROXY) verdict = 'прокси передаёт адрес человека, а TRUST_PROXY не включён: для лимитов частоты все люди — один адрес '
      + sock + '. Поставьте TRUST_PROXY=1 в переменные хостинга.';
    else if (fwd) verdict = 'TRUST_PROXY=1: адрес человека — ' + proxySeen[slot].ip
      + (xff ? ' (последняя запись X-Forwarded-For)' : ' (X-Real-IP)') + '.';
    else if (TRUST_PROXY) verdict = 'TRUST_PROXY=1, а заголовков прокси нет. Если так у ВСЕХ запросов — прокси адрес не передаёт:'
      + ' снимите TRUST_PROXY, иначе адрес можно подделать своим X-Forwarded-For.';
    else verdict = isLoopback(sock) ? 'запрос с этой же машины.' : 'заголовков прокси нет — адрес сокета и есть адрес человека.';
    console.log('[BloggerPay] адрес клиента: сокет ' + (sock || '?')
      + ', X-Forwarded-For: ' + (xff || 'нет') + ', X-Real-IP: ' + (xri || 'нет') + ' — ' + verdict);
  } catch (e) { /* диагностика не обязана удаться */ }
}
/* Для ОТКРЫТЫХ ручек чтения («Главная» гостя: /api/tasks/public, /summary).
   Без TRUST_PROXY за прокси хостинга все люди — один адрес, и лимит 60/мин
   отвечал бы 429 всему сайту. Здесь подмешиваем последнюю запись
   X-Forwarded-For: подделать её — значит лишь прочитать витрину чаще, а
   для входа, денег и ключа владельца по-прежнему действует clientIp. */
function softKey(req) {
  if (TRUST_PROXY) return '';
  const parts = String((req.headers && req.headers['x-forwarded-for']) || '').split(',').map((s) => s.trim()).filter(Boolean);
  return parts.length ? '~' + parts[parts.length - 1].slice(0, 45) : '';
}
/* Совет для /admin: показываем только вывод, без адресов людей. */
function proxyAdvice() {
  const f = proxySeen.fwd, p = proxySeen.plain;
  let совет = '';
  if (f && !TRUST_PROXY) совет = 'Прокси хостинга передаёт адрес человека (X-Forwarded-For), а TRUST_PROXY не включён — лимиты частоты и замок ключа владельца общие на всех. Поставьте TRUST_PROXY=1.';
  else if (!f && p && TRUST_PROXY && !isLoopback(p.socket)) совет = 'TRUST_PROXY=1, а прокси адрес человека не передаёт — адрес можно подделать заголовком. Снимите TRUST_PROXY.';
  return { trust: TRUST_PROXY, заголовки_прокси: f ? true : (p ? false : null), совет };
}
/* Запрос пришёл с этой же машины. Нужно там, где внешний адрес сервера
   определить не удалось и приходится решать по адресу собеседника. */
function isLoopback(ip) {
  const s = String(ip || '');
  return s === '127.0.0.1' || s === '::1' || s === '::ffff:127.0.0.1' || /^127\./.test(s);
}

/* Кому сейчас доступно тестовое пополнение — то есть кнопка «нарисовать
   себе денег». Владельцу — всегда, пока режим включён. Остальным —
   только если это разрешили ЯВНО (TEST_TOPUP_OPEN=1) или если сервер
   точно домашний.

   Раньше правило было «не публичный — значит домашний», а публичным
   сервер считался, только когда внешний адрес удалось вычислить из
   PUBLIC_URL или DOMAIN. Не задал хостинг ни того, ни другого — и
   боевой сервер раздавал печать денег каждому вошедшему. Предохранитель
   отказывал в открытую. Теперь при неопределённом адресе верим только
   запросам со своей машины: разработка и тесты работают как раньше,
   а недонастроенный сервер снаружи денег не печатает. */
function testTopupAllowed(req, u) {
  if (!TEST_TOPUP) return false;
  if (u && u.is_admin) return true;
  if (TEST_TOPUP_OPEN_SET) return true;
  if (SERVER_IS_PUBLIC) return false;
  return isLoopback(clientIp(req));
}

function rateLimit(req, key, limit, windowMs) {
  if (RL_OFF) return true;
  const ip = clientIp(req);
  /* Петля не ограничивается только без прокси — это разработка и тесты,
     где 127.0.0.1 действительно свой. За прокси (TRUST_PROXY=1) петля
     означает сам прокси, и поблажка выключила бы защиту для всех. */
  if (!TRUST_PROXY && (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1')) return true;
  const k = key + '|' + ipBucket(ip);
  const now = Date.now();
  let arr = rlMap.get(k);
  if (!arr) { arr = []; rlMap.set(k, arr); }
  /* Окно запоминаем на самой записи: уборка раз в 5 минут резала всё
     старше 5 минут, и часовые лимиты (удаление аккаунта, поддержка,
     отвязка ролика) сбрасывались через ≤10 минут (аудит 16.10.2026). */
  if (!(arr.w >= windowMs)) arr.w = windowMs;
  while (arr.length && now - arr[0] > windowMs) arr.shift();
  if (arr.length >= limit) return false;
  arr.push(now);
  return true;
}
const tooOften = { status: 429, body: { error: 'Слишком часто — подождите минуту и попробуйте снова' } };
/* Ключ лимита для IPv6 — сеть /64, а не адрес (аудит 16.10.2026): одному
   абоненту провайдер выдаёт целую /64, это миллиарды адресов, и лимит «на
   адрес» перебор не держал. IPv4 и ::ffff:a.b.c.d — как есть. */
function ipBucket(ip) {
  ip = String(ip || '');
  const v4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (v4) return v4[1];
  if (ip.indexOf(':') < 0) return ip;
  const bare = ip.split('%')[0].toLowerCase();
  const parts = bare.split('::');
  const head = parts[0] ? parts[0].split(':') : [];
  let all = head;
  if (parts.length > 1) {
    const tail = parts[1] ? parts[1].split(':') : [];
    all = head.concat(new Array(Math.max(0, 8 - head.length - tail.length)).fill('0'), tail);
  }
  return all.slice(0, 4).map((x) => (parseInt(x, 16) || 0).toString(16)).join(':') + '::/64';
}

/* ── Перебор пароля к ОДНОЙ почте (аудит 16.10.2026) ──
   Лимит /api/login считается по адресу, и с тысяч адресов (ботнет, IPv6)
   одну почту можно было перебирать без конца. Теперь промахи считаются и
   по почте: LOGIN_MISS_MAX за четверть часа — вход паролем для неё на
   паузе LOGIN_PAUSE_MS и одна тревога владельцу. Пауза короткая и
   проходит сама — навсегда никого не запереть; «Забыли пароль?»
   (успешный сброс снимает паузу), вход Телеграмом и Google работают и во
   время неё. Почты без аккаунта считаются так же: по ответу не понять,
   есть ли аккаунт. */
/* Пересмотр (аудит 16.10.2026, R2): пауза на ВСЮ почту запирала хозяина
   посторонним — 10 неверных паролей раз в 15 минут с любого адреса, и
   верный пароль с телефона владельца получал 429. Теперь пауза — на ПАРУ
   (почта, адрес/сеть ipBucket): LOGIN_MISS_MAX промахов за окно — вход
   паролем к этой почте с этого адреса на паузе, с других адресов верный
   пароль проходит. Общий счёт по почте (со всех адресов) — только
   замедление ответа (от LOGIN_SLOW_AT) и одна тревога владельцу за окно
   (LOGIN_ALERT_AT: с одного адреса столько не набрать — пара встаёт на
   паузу раньше, значит перебор идёт с нескольких). Тревоги — в свой
   кошелёк 'auth' (TG_CAP.auth в час) и потолок серверных не выжигают.
   Повтор той же пары быстрее LOGIN_TWIN_MS — полпромаха: приложение на
   одну опечатку шлёт два пароля (производную и сам пароль). */
const LOGIN_MISS_MAX = 10;
const LOGIN_MISS_WIN_MS = 15 * 60 * 1000;
const LOGIN_PAUSE_MS = 15 * 60 * 1000;
const LOGIN_TWIN_MS = 3000;
const LOGIN_SLOW_AT = 20;
const LOGIN_ALERT_AT = 30;
const LOGIN_PAIRS_MAX = 300;
/* почта → { n, at, alerted, pairs: Map(ipBucket → { n, at, last, until }) } */
const loginMiss = new Map();
function loginIpKey(req) { return ipBucket(clientIp(req)); }
function loginPausedFor(email, ipk) {
  if (RL_OFF) return 0;
  const m = loginMiss.get(email);
  const p = m && m.pairs.get(ipk);
  if (!p || !p.until) return 0;
  const left = p.until - Date.now();
  if (left > 0) return left;
  m.pairs.delete(ipk);
  return 0;
}
/* замедление ответа, пока по почте идёт перебор со многих адресов */
function loginSlowMs(email) {
  if (RL_OFF) return 0;
  const m = loginMiss.get(email);
  if (!m || Date.now() - m.at > LOGIN_MISS_WIN_MS || m.n < LOGIN_SLOW_AT) return 0;
  return Math.min(2000, 500 + (m.n - LOGIN_SLOW_AT) * 50);
}
function loginMissed(email, ipk, u) {
  if (RL_OFF || !email) return;
  const now = Date.now();
  let m = loginMiss.get(email);
  if (!m) m = { n: 0, at: now, alerted: false, pairs: new Map() };
  if (now - m.at > LOGIN_MISS_WIN_MS) { m.n = 0; m.at = now; m.alerted = false; }
  let p = m.pairs.get(ipk);
  if (!p || (!p.until && now - p.at > LOGIN_MISS_WIN_MS)) p = { n: 0, at: now, last: 0, until: 0 };
  p.n += (p.last && now - p.last < LOGIN_TWIN_MS) ? 0.5 : 1;
  p.last = now;
  m.n += 1;
  if (p.n >= LOGIN_MISS_MAX) { p.until = now + LOGIN_PAUSE_MS; p.n = 0; p.at = now; }
  m.pairs.delete(ipk); m.pairs.set(ipk, p);                 /* свежие — в конец */
  if (m.pairs.size > LOGIN_PAIRS_MAX) m.pairs.delete(m.pairs.keys().next().value);
  if (u && !m.alerted && m.n >= LOGIN_ALERT_AT) {
    m.alerted = true;
    let addrs = 0;
    for (const x of m.pairs.values()) if (now - x.last < LOGIN_MISS_WIN_MS) addrs++;
    tgAlert('loginbrute:' + u.id,
      '🔐 Похоже на подбор пароля\n\nАккаунт: ' + String(email).slice(0, 120) + ' (#' + u.id + ')'
      + '\nНеверных паролей: ' + m.n + ' за 15 минут, адресов: ' + addrs + '.'
      + '\nС каждого адреса после ' + LOGIN_MISS_MAX + ' промахов вход паролем на паузе 15 минут, ответы замедлены;'
      + ' хозяин со своего адреса входит как обычно.', 'auth');
  }
  loginMiss.delete(email); loginMiss.set(email, m);         /* свежие — в конец */
  if (loginMiss.size > 20000) loginMiss.delete(loginMiss.keys().next().value);
}
function loginPairClear(email, ipk) {
  const m = loginMiss.get(email);
  if (m) m.pairs.delete(ipk);
}
function loginPausedReply(ms) {
  const min = Math.max(1, Math.ceil(ms / 60000));
  return { status: 429, body: {
    error: 'Слишком много неверных паролей для этой почты с вашего адреса. Вход паролем — на паузе ' + min + ' мин. '
      + 'Не помните пароль — нажмите «Забыли пароль?»: код придёт на почту.',
    code: 'login_paused', wait: Math.ceil(ms / 1000),
  } };
}
/* ── Что из карточки блогера попадает в общий каталог ──
   Белый список, а не чёрный: клиент кладёт в карточку и служебное
   (почту владельца, местный id, отметку админа), и всё это уехало бы
   всем в витрину. Что не перечислено здесь — не сохраняется.
   socsHtml (готовая разметка значков) не принимаем сознательно: чужую
   разметку в каталог пускать нельзя, значки клиент рисует сам по
   списку площадок. */
const CARD_STR = { name: 60, initials: 4, col: 64, catsText: 200, sinceText: 60,
  subsVal: 20, reachVal: 20, erVal: 20, cpvVal: 20, publishedAt: 40, msg: 500 };
const CARD_PLATS = ['youtube', 'telegram', 'tiktok', 'instagram', 'vk'];
/* Строка из чужих данных — без исключений (аудит 16.10.2026): объект
   {"toString":1} из JSON ломает String() (TypeError), и один такой
   конверт ронял всю витрину гостя (500 всем). */
function safeStr(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try { return String(v); } catch (e) { return ''; }
}
function cardStr(v, max) { return safeStr(v).slice(0, max); }
/* витрина заданий: число из объявления (ставка, потолок) — только
   конечное неотрицательное; площадки — короткие коды через запятую */
function pubNum(v) {
  const n = typeof v === 'number' ? v : (typeof v === 'string' ? Number(v) : NaN);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 1e9) : 0;
}
function pubPlats(v) {
  const a = Array.isArray(v) ? v : safeStr(v).split(/[,;\s]+/);
  return a.map((x) => safeStr(x || '').toLowerCase().replace(/[^a-z]/g, '').slice(0, 12)).filter(Boolean).slice(0, 8).join(',');
}
function cleanCard(raw) {
  const src = (raw && typeof raw === 'object') ? raw : {};
  const out = {};
  for (const k of Object.keys(CARD_STR)) if (src[k] != null) out[k] = cardStr(src[k], CARD_STR[k]);
  for (const k of ['genderF', 'genderM', 'kids']) {
    const n = Number(src[k]);
    if (Number.isFinite(n)) out[k] = Math.max(0, Math.min(100, Math.round(n)));
  }
  for (const k of ['showGender', 'showKids']) if (src[k] != null) out[k] = !!src[k];
  /* Фото — только вшитая картинка. Ссылка на посторонний адрес означала бы,
     что открытие каталога стучится на чужой сервер за каждым лицом. */
  const av = cardStr(src.avatar, 400000);
  if (/^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(av) && av.length <= 300000) out.avatar = av;
  out.platforms = Array.isArray(src.platforms)
    ? src.platforms.filter((x) => CARD_PLATS.includes(x)).slice(0, 8) : [];
  out.topics = Array.isArray(src.topics)
    ? src.topics.map((t) => cardStr(t, 40)).filter(Boolean).slice(0, 10) : [];
  out.platData = {};
  const pd = (src.platData && typeof src.platData === 'object') ? src.platData : {};
  for (const pid of CARD_PLATS) {
    const pl = pd[pid];
    if (!pl || typeof pl !== 'object') continue;
    const url = cardStr(pl.url, 300);
    if (url && !/^https?:\/\//i.test(url)) continue;   /* javascript: в каталог не пускаем */
    out.platData[pid] = {
      url,
      subs: Math.max(0, Math.round(Number(pl.subs) || 0)),
      er: Math.max(0, Number(pl.er) || 0),
      reach: Math.max(0, Math.round(Number(pl.reach) || 0)),
      verified: !!pl.verified,
      enabled: pl.enabled !== false,
    };
    /* Тематики и аудитория канала — у каждого свои (мастер карты,
       15.09.2026). Строки режем по длине и срезаем угловые скобки: их
       показывают в чужом каталоге. */
    if (Array.isArray(pl.topics)) {
      /* сначала режем длину массива: иначе огромный список проходит целиком */
      const tp = pl.topics.slice(0, 20).map((t) => cardStr(t, 40).replace(/[<>]/g, '').trim()).filter(Boolean).slice(0, 5);
      if (tp.length) out.platData[pid].topics = tp;
    }
    if (pl.genderF != null && Number.isFinite(Number(pl.genderF))) {
      out.platData[pid].genderF = Math.max(0, Math.min(100, Math.round(Number(pl.genderF))));
    }
    if (pl.showGender != null) out.platData[pid].showGender = !!pl.showGender;
    if (pl.kids != null) out.platData[pid].kids = !!pl.kids;
  }
  out.integrations = {};
  const ig = (src.integrations && typeof src.integrations === 'object') ? src.integrations : {};
  for (const pid of CARD_PLATS) {
    if (!Array.isArray(ig[pid])) continue;
    out.integrations[pid] = ig[pid].slice(0, 20)
      .filter((x) => x && typeof x === 'object')
      .map((x) => ({ fmtId: cardStr(x.fmtId, 30), price: Math.max(0, Math.round(Number(x.price) || 0)) }));
  }
  return out;
}
/* Каталог отдаём из памяти: страница главной открывается часто, а список
   меняется редко. Любая правка карточки сбрасывает срок. */
const cardsCache = { at: 0, rows: null };
/* Витрина карт закрыта общей кнопкой «Снять все» (флаг cards_closed). */
function cardsClosed() {
  try { const f = q.flagGet.get('cards_closed'); return f && f.value === '1' ? f : null; }
  catch (e) { return null; }
}
/* Счётчики витрины для пульта — по всей таблице. visible — с отметкой
   «на витрине» (их и снимет «Снять все»), listed — из них реально видны
   в каталоге (владелец не заблокирован), hidden — скрыты по одной,
   unpublished — сняты общей кнопкой. */
function cardsStatsBody() {
  const s = q.cardsStats.get() || {};
  const f = cardsClosed();
  return {
    total: Number(s.total) || 0, visible: Number(s.visible) || 0, listed: Number(s.listed) || 0,
    hidden: Number(s.hidden) || 0, unpublished: Number(s.unpublished) || 0,
    closed: !!f, closedAt: f ? f.at : null,
  };
}
/* Разовый перенос (10.10.2026, решение владельца «Снять»): карты блогеров,
   опубликованные до перехода на задания, при первом запуске этой версии
   снимаются с витрины сами — так же, как кнопкой «Снять все» в пульте
   (hidden 0 → 2, витрина закрыта, запись в журнале). Политика
   конфиденциальности говорит «сняты» как о факте, и это не должно зависеть
   от того, нажмёт ли кто-то кнопку после выкладки. Делается один раз
   (отметка cards_unpub_1010): «Вернуть все» в пульте потом не отменяется
   перезапуском. На пустой базе (новая установка, тесты) снимать нечего —
   витрина остаётся открытой. */
try {
  if (!q.flagGet.get('cards_unpub_1010')) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const vis = Number((q.cardsStats.get() || {}).visible) || 0;
      let n = 0;
      if (vis > 0) {
        n = Number(q.cardsUnpublishAll.run().changes) || 0;
        q.flagSet.run('cards_closed', '1');
        q.insAdminLog.run('сервер', 'cards-unpublish-all', 'витрина карт',
          'разовый перенос 10.10.2026: снято ' + n + ' · витрина закрыта, новые карты ложатся снятыми');
      }
      q.flagSet.run('cards_unpub_1010', vis > 0 ? 'снято ' + n : 'нечего снимать');
      db.exec('COMMIT');
      if (n) console.log('[cards] разовый перенос: снято с витрины ' + n + ' карт');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch (_) {}
      throw e;
    }
  }
} catch (e) { console.error('[cards] разовый перенос не удался —', e && e.message); }
/* Доступ к площадке и снимки статистики канала, у которого больше нет
   строки в channels (отвязан оператором до этой версии — тогда доступ
   оставался), удаляем при старте: «доступ хранится, пока аккаунт
   подключён». */
try {
  const orphan = (tb) => `DELETE FROM ${tb} WHERE NOT EXISTS (SELECT 1 FROM channels c
    WHERE c.user_id = ${tb}.user_id AND c.platform = ${tb}.platform AND c.external_id = ${tb}.external_id)`;
  const t = db.prepare(orphan('channel_tokens')).run();
  const s = db.prepare(orphan('channel_stats')).run();
  if (t.changes || s.changes) console.log('[channels] убраны доступы и снимки отвязанных каналов: ' + t.changes + ' / ' + s.changes);
} catch (e) { console.error('[channels] уборка отвязанных не удалась —', e && e.message); }

/* Рейтинг пересчитывается не чаще раза в минуту: запрос групповой, а ручка открытая. */
const lbCache = { at: 0, rows: null, total: 0 };
/* Сводка заданий (GET /api/tasks/summary) — так же, раз в минуту на всех.
   Сбрасывается там же, где лидерборд задания (vidBoardDrop), рейтинг
   (выплата, блокировка), и при правке конверта задания. */
const tsumCache = { at: 0, body: null };

/* ── УВЕДОМЛЕНИЯ НА ТЕЛЕФОН ──────────────────────────────────────────
   Приложение показывает события, только пока оно открыто. Чтобы
   уведомление дошло до ЗАКРЫТОГО приложения, отправить его должен
   сервер — этим и занимается server/push.js.

   Здесь только адресация: у человека может быть несколько браузеров,
   шлём во все. Служба доставки отвечает 404 или 410, когда подписки
   больше нет (приложение удалили, разрешение отозвали) — такую строку
   убираем сразу, иначе она будет висеть вечно и жечь запросы.

   Ничего не ждём и не роняем: уведомление не должно мешать действию,
   ради которого посылается. */
const pushLib = require('./push.js');
const PUSH_SUBJECT = 'mailto:' + (ADMIN_EMAILS[0] || 'admin@bloggerpay.ru');
/* Щель для проверок: расширяет список разрешённых служб доставки. На бою
   её быть не должно — с ней сервер соглашается стучаться туда, куда
   укажет строка в теле запроса. Молчать про такое нельзя. */
if (String(ENV.PUSH_HOSTS_EXTRA || '').trim()) {
  console.error('[BloggerPay] ВНИМАНИЕ: задан PUSH_HOSTS_EXTRA='
    + String(ENV.PUSH_HOSTS_EXTRA).slice(0, 120)
    + ' — сервер будет слать уведомления и на эти адреса. Это настройка для'
    + ' проверок; на боевом сервере уберите её из .env.');
}

/* ── «Сразу»: ждущий запрос (15.10.2026) ─────────────────────────────────
   Владелец: «уведомления приходят не сразу». Открытое приложение спрашивало
   сервер раз в 15 с (сообщения), ролики, баланс и проверку — ещё реже.
   Теперь оно держит запрос GET /api/wake (до WAKE_MS); как только у человека
   событие — то же, о чём ему шлём push (ролики, выплаты, проверка, счёт),
   новый конверт от собеседника, зачисление оплаты, — сервер отвечает сразу
   { kinds:[…] }, и приложение тут же забирает новое прежними ручками.
   Событие без ждущего запроса (между запросами) живёт WAKE_KEEP_MS и уходит
   со следующим. Ни данных, ни текста здесь нет — только «что проверить». */
const WAKE_MS = Math.max(2000, Math.min(55000, Number(ENV.WAKE_MS) || 25000));
const WAKE_KEEP_MS = 30000;
const wakeWait = new Map();    /* id человека → Set ждущих { done } */
const wakeLate = new Map();    /* id человека → { kinds:Set, at } — пришло, пока никто не ждал */
function wakeUser(userId, kind) {
  try {
    const uid = Number(userId);
    if (!uid) return;
    const k = String(kind || 'note').slice(0, 16);
    const set = wakeWait.get(uid);
    if (set && set.size) {
      for (const w of Array.from(set)) w.done([k]);
      return;
    }
    const late = wakeLate.get(uid) || { kinds: new Set(), at: 0 };
    late.kinds.add(k); late.at = Date.now();
    wakeLate.set(uid, late);
    if (wakeLate.size > 5000) wakeLate.delete(wakeLate.keys().next().value);
  } catch (e) { /* будильник не должен ронять действие */ }
}

function pushTo(userId, title, body, url) {
  wakeUser(userId, 'note');
  try {
    const uid = Number(userId);
    if (!uid) return;
    const rows = q.pushOf.all(uid);
    if (!rows || !rows.length) return;
    const payload = JSON.stringify({
      title: String(title || 'BloggerPay').slice(0, 80),
      body: String(body || '').slice(0, 180),
      url: String(url || '/').slice(0, 200),
    });
    for (const r of rows) {
      pushLib.sendOne(r, payload, { dbPath: DB_PATH, subject: PUSH_SUBJECT, env: ENV })
        .then((res) => {
          if (res && res.gone) { try { q.pushDel.run(r.endpoint); } catch (e) {} }
        })
        .catch(() => {});
    }
  } catch (e) { console.error('[push]', (e && e.message) || e); }
}

/* ── Тревога в Телеграм ──────────────────────────────────────────────
   Скрытая ошибка не должна ждать, пока владелец откроет пульт: каждая
   новая летит сообщением админу через того же бота, что и кнопка
   «Открыть». ADMIN_CHAT_ID — числовой id чата владельца с ботом
   (чтобы бот мог писать первым, владелец один раз жмёт Start).

   Против потопа несколько предохранителей. Одна и та же ошибка — не
   чаще раза в 10 минут. Лимиты в час РАЗДЕЛЬНЫЕ: у ошибок с сайта свой
   (их текст присылает кто угодно, хоть злонамеренно), у серверных —
   свой, чтобы поток мусора с сайта не заглушил настоящую беду; тревога
   о расхождении денег проходит всегда. И тревога никогда не
   задерживает и не роняет сам запрос. */
const ADMIN_CHAT_ID = String(ENV.ADMIN_CHAT_ID || '').trim();
const TG_API_BASE = (ENV.TG_API_BASE || 'https://api.telegram.org').replace(/\/+$/, '');
const ALERTS_ON = Boolean(BOT_TOKEN && ADMIN_CHAT_ID);

const tgSeen = new Map();          /* подпись → { n, lastSent }, свежие в конце */
const TG_CAP = { client: 15, guest: 15, server: 10, auth: 5 };   /* тревог в час на каждый кошелёк */
const TG_REPEAT_MS = 10 * 60 * 1000;
const tgLane = {
  client: { sent: 0, muted: false },
  /* ошибки невошедших — свой кошелёк (аудит 16.10.2026): /api/errors без
     входа, и поток выдуманных «ошибок» от гостей глушил тревоги о
     настоящих ошибках у вошедших людей */
  guest: { sent: 0, muted: false },
  server: { sent: 0, muted: false },
  /* подбор паролей — свой кошелёк (аудит 16.10.2026, R2): тревоги о нём
     вызывает кто угодно без входа, и они глушили споры, KYC и накрутку */
  auth: { sent: 0, muted: false },
};
let tgHourAt = 0;

function tgSendRaw(text) {
  return tgSendTo(ADMIN_CHAT_ID, text, 'тревога');
}
/* Один вызов на все сообщения бота: тревоги владельцу и личные письма
   людям (tgDM) уходят одним и тем же путём, через тот же TG_API_BASE. */
function tgSendTo(chatId, text, tag) {
  return fetch(TG_API_BASE + '/bot' + BOT_TOKEN + '/sendMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: String(text).slice(0, 3800),
      disable_web_page_preview: true,
    }),
    signal: AbortSignal.timeout(8000),
  }).then(async (r) => {
    if (!r.ok) console.error('[' + tag + '] Телеграм ответил ' + r.status + ': ' + (await r.text()).slice(0, 200));
  }).catch((e) => console.error('[' + tag + '] не отправилось: ' + ((e && e.message) || e)));
}
/* Личное сообщение человеку от бота (06.10.2026). Уведомление на телефон
   доходит не до всех: разрешение не дали, приложение не установлено. А
   почти все пришли из Телеграма, и бот им написать может — если человек
   хоть раз нажал у бота Start (иначе Телеграм ответит 403, и это не беда).
   Нет tg_id или нет токена бота — молча ничего. Ответа не ждём. */
function tgDM(userId, text) {
  try {
    if (!BOT_TOKEN) return;
    const u = q.userById.get(Number(userId));
    const chat = u && u.tg_id ? String(u.tg_id).trim() : '';
    if (!/^-?\d{1,20}$/.test(chat)) return;
    tgSendTo(chat, text, 'бот → ' + u.id);
  } catch (e) { console.error('[бот → человек]', (e && e.message) || e); }
}

function tgAlert(sig, text, lane, critical) {
  if (!ALERTS_ON) return;
  const now = Date.now();
  if (now - tgHourAt > 3600000) {
    tgHourAt = now;
    for (const k of Object.keys(tgLane)) { tgLane[k].sent = 0; tgLane[k].muted = false; }
  }
  const key = (lane === 'client' || lane === 'guest' || lane === 'auth') ? lane : 'server';
  const L = tgLane[key];

  const rec = tgSeen.get(sig);
  if (rec) {
    rec.n += 1;
    /* Прикосновение LRU: живая ошибка уезжает в конец очереди на
       вытеснение, чтобы при переполнении первыми уходили давно
       замолчавшие, а не самые активные. */
    tgSeen.delete(sig); tgSeen.set(sig, rec);
    if (now - rec.lastSent < TG_REPEAT_MS) return;
  }

  /* Потолок проверяем ДО пометки «отправлено»: иначе ошибка, впервые
     случившаяся в час молчания, считалась бы отправленной и была бы
     потеряна для чата навсегда. */
  if (!critical && L.sent >= TG_CAP[key]) {
    if (!L.muted) {
      L.muted = true;
      tgSendRaw('⚠️ Тревог ' + (key === 'client' ? 'с сайта' : key === 'guest' ? 'с сайта от гостей' : key === 'auth' ? 'о подборе паролей' : 'серверных')
        + ' больше ' + TG_CAP[key] + ' за час — молчу про них до конца часа, чтобы не завалить чат.'
        + ' Полный список: пульт оператора, раздел «Поломки».');
    }
    return;
  }

  if (rec) {
    rec.lastSent = now;
    text += '\n\n(эта ошибка повторилась, всего ' + rec.n + ' раз)';
  } else {
    tgSeen.set(sig, { n: 1, lastSent: now });
    if (tgSeen.size > 500) tgSeen.delete(tgSeen.keys().next().value);
  }
  L.sent += 1;
  tgSendRaw(text);
}
/* уборка карты, чтобы память не росла бесконечно */
setInterval(() => {
  const now = Date.now();
  for (const [k, arr] of rlMap) {
    const w = arr.w > 300000 ? arr.w : 300000;
    while (arr.length && now - arr[0] > w) arr.shift();
    if (!arr.length) rlMap.delete(k);
  }
}, 300000).unref();

/* ── Заявки на подтверждение канала ────────────────────────────────
   Живут в памяти 15 минут. Здесь важна не столько экономия, сколько
   безопасность: раньше в OAuth-метке state ехал просто подписанный
   id пользователя, и этого достаточно для классической подмены —
   злоумышленник брал СВОЮ ссылку авторизации, присылал её блогеру
   («подтвердите канал, чтобы взять заказ»), тот входил в свой аккаунт,
   и канал записывался на злоумышленника, а настоящий владелец получал
   «канал уже привязан» навсегда.

   Теперь страница возврата НИЧЕГО не привязывает. Она показывает
   шестизначный код тому, кто только что вошёл на площадке, а канал
   привязывается к тому, кто ввёл этот код В ПРИЛОЖЕНИИ, где он уже
   авторизован. Ссылка, отданная чужому человеку, бесполезна: код
   видит только он сам, и подтвердит он свой канал себе же. */
/* Вход через Google. Человек уходит на страницу Google и возвращается
   на наш адрес возврата — а приложение всё это время ждёт в другом окне
   (в мини-аппе — вообще в другом браузере). Поэтому результат входа
   кладём сюда под одноразовой меткой, а приложение забирает его по
   метке или по короткому коду, который человек видит на странице
   возврата. Живёт 15 минут, забирается один раз. */
const glog = new Map();           /* nonce → {at, code, token, user, done, tries} */
/* То же самое для входа через Телеграм: результат ждёт под меткой, пока
   приложение его не заберёт. Плюс хранится проверочная строка PKCE. */
const tglog = new Map();          /* nonce → {at, code, token, user, done, tries, role, verifier} */
const GLOG_TTL = 15 * 60 * 1000;
/* Сколько метка живёт ПОСЛЕ того, как её первый раз забрали.
   Раньше запись удалялась в тот же миг, и вход превращался в гонку: кто
   первым спросил — тот и вошёл, а проигравшему приложение две минуты
   крутило «Заканчиваем вход». Проигрывала обычно та самая вкладка, где
   человек ждал, потому что окно возврата спрашивало раньше.
   Минуты хватает, чтобы вход забрал тот, кому он предназначался, даже
   если браузер придушил его таймеры или человек успел обновить
   страницу. Дальше метка гаснет. Так же устроена касса: /api/pay/status
   перечитываемый, и поэтому у пополнения этой болезни нет. */
const AUTH_GRACE = 60 * 1000;
function glogSweep() {
  const now = Date.now();
  for (const [k, v] of glog) if (now - v.at > GLOG_TTL) glog.delete(k);
  for (const [k, v] of tglog) if (now - v.at > GLOG_TTL) tglog.delete(k);
  tgUsedSweep();
}
setInterval(glogSweep, 60000).unref();

/* ── ВХОД ПРИВЯЗАН К БРАУЗЕРУ, КОТОРЫЙ ЕГО НАЧАЛ (аудит 16.10) ──
   Было: метка (nonce) уходит наружу — это state у Google и return_to у
   Телеграма, — а pending отдавал готовую сессию любому, кто её знает.
   Злоумышленник брал start, присылал жертве НАСТОЯЩУЮ ссылку Google или
   Телеграма, жертва входила — и её сессию забирал он. С ?link=1 так же
   чужой Телеграм прирастал к его аккаунту. Теперь:
   1) start выдаёт ещё и секрет pk. В ссылку он не попадает, сервер помнит
      только sha256(pk); pending, claim и link-confirm без него отвечают
      «не найдено» — утёкшая метка сама по себе бесполезна.
   2) Тот же pk start кладёт в куку bpal_<метка> (HttpOnly, SameSite=Lax,
      путь /api/auth/). Возврат от площадки с этой кукой — тот же браузер
      (bound): приложение забирает вход само, как раньше. Без куки (вход
      закончили в другом браузере — или это ссылка злоумышленника) вход
      выдаётся только по 6-значному коду, который показан ОДИН раз — на
      странице этого возврата: его видит лишь тот, кто сам входил.
   3) Сессия заводится в момент выдачи, а не на возврате: брошенный или
      чужой вход не оставляет в базе живой сессии. */
function loginKeyHash(pk) { return crypto.createHash('sha256').update(String(pk || '')).digest('hex'); }
function loginKeyOk(rec, pk) {
  const s = String(pk || '');
  if (!rec || !rec.pkh || !/^[0-9a-f]{32,64}$/.test(s)) return false;
  const a = Buffer.from(loginKeyHash(s), 'utf8');
  const b = Buffer.from(String(rec.pkh), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function loginCookieName(nonce) { return 'bpal_' + String(nonce || '').slice(0, 16); }
function loginCookie(req, nonce, pk) {
  const https = /^https:/i.test(PUBLIC_URL)
    || /^https:/i.test(String(ENV.PUBLIC_URL || ''))
    || String(req.headers['x-forwarded-proto'] || '') === 'https';
  return loginCookieName(nonce) + '=' + (pk || '') + '; Path=/api/auth/; HttpOnly; SameSite=Lax; Max-Age='
    + (pk ? Math.floor(GLOG_TTL / 1000) : 0) + (https ? '; Secure' : '');
}
function loginNew(map, extra) {
  const nonce = crypto.randomBytes(24).toString('hex');
  const pk = crypto.randomBytes(24).toString('hex');
  map.set(nonce, Object.assign({
    at: Date.now(), code: '', token: '', user: null, uid: 0, done: false, bound: false,
    tries: 0, pkh: loginKeyHash(pk),
  }, extra || {}));
  return { nonce, pk };
}
function loginSameBrowser(req, rec, nonce) {
  let c = '';
  try { c = cookieOf(req, loginCookieName(nonce)); } catch (e) { c = ''; }
  return loginKeyOk(rec, c);
}
/* Возврат от площадки: человек найден/заведён. Тот же браузер — будим
   ждущую вкладку, как раньше; другой — показываем код (один раз). */
function loginDone(req, res, kind, map, state, rec, u) {
  /* Два возврата с одной меткой (обмен кода у Google асинхронный) —
     второй не перезаписывает первый. */
  if (rec.done) {
    return verifyPage(res, 'Вход уже подтверждён',
      'Вернитесь в приложение. Если оно вас не впустило, начните вход заново.', false);
  }
  rec.done = true;
  rec.uid = u ? u.id : 0;
  rec.user = u ? { id: u.id, email: u.email, name: u.name, role: u.role } : null;
  rec.code = String(crypto.randomInt(100000, 1000000));
  rec.bound = loginSameBrowser(req, rec, state);
  map.set(state, rec);
  if (rec.bound) {
    return authRelayPage(res, kind, state,
      APP_BASE + '?' + (kind === 'g' ? 'glogin' : 'tglogin') + '=' + encodeURIComponent(state));
  }
  return verifyPage(res, rec.linkUser ? 'Телеграм подтверждён' : 'Вход подтверждён',
    (rec.linkUser
      ? 'Привязку начинали в другом браузере. Вернитесь в BloggerPay, где нажимали «Привязать», и введите там этот код.'
      : 'Вход начинали в другом браузере или приложении. Вернитесь туда и введите этот код.')
    + ' Никому его не сообщайте — даже поддержке BloggerPay.', true, rec.code);
}
function loginIssue(rec) {
  if (rec.token) return rec.token;
  const u = rec.uid ? q.userById.get(rec.uid) : null;
  if (!u || u.is_blocked) return '';
  const token = newToken();
  q.insSession.run(token, u.id, new Date(Date.now() + SESSION_DAYS * 864e5).toISOString());
  rec.token = token;
  return token;
}
const LOGIN_LOST = { status: 404, body: { error: 'Вход не найден или просрочен' } };
function loginPending(map, nonce, pk) {
  nonce = String(nonce || '').slice(0, 64);
  const rec = map.get(nonce);
  if (!rec || !loginKeyOk(rec, pk)) return LOGIN_LOST;
  if (Date.now() - rec.at > GLOG_TTL) { map.delete(nonce); return LOGIN_LOST; }
  if (!rec.done) return { status: 200, body: { state: 'waiting' } };
  /* Возврат пришёл без куки этого браузера: только код со страницы возврата. */
  if (!rec.bound) return { status: 200, body: { state: 'code' } };
  /* Привязку делает link-confirm от того же аккаунта, не опрос. */
  if (rec.linkUser) return { status: 200, body: { state: 'ok', link: true } };
  /* Отдаём и помечаем выданной, но не стираем сразу — см. AUTH_GRACE. */
  if (!rec.taken) rec.taken = Date.now();
  else if (Date.now() - rec.taken > AUTH_GRACE) { map.delete(nonce); return LOGIN_LOST; }
  const token = loginIssue(rec);
  if (!token) { map.delete(nonce); return { status: 403, body: { error: 'Аккаунт заблокирован — напишите в поддержку' } }; }
  return { status: 200, body: { state: 'ok', token, user: rec.user } };
}
/* Код со страницы возврата. Сверяем ТОЛЬКО со своей меткой и только с
   секретом начавшего: подобрать шесть цифр вслепую нельзя, пять ошибок
   сжигают метку. */
function loginCodeCheck(map, nonce, rec, code) {
  if (Date.now() - rec.at > GLOG_TTL) {
    map.delete(nonce);
    return { status: 410, body: { error: 'Ссылка входа живёт 15 минут — начните заново' } };
  }
  if (rec.tries >= 5) {
    map.delete(nonce);
    return { status: 429, body: { error: 'Слишком много попыток — начните вход заново' } };
  }
  if (code.length !== 6) return { status: 400, body: { error: 'Код — шесть цифр' } };
  if (!rec.done || code !== rec.code) {
    rec.tries++;
    return { status: 400, body: { error: 'Код не подошёл', left: Math.max(0, 5 - rec.tries) } };
  }
  return null;
}
function loginClaim(map, body) {
  const nonce = String(body.nonce || '').slice(0, 64);
  const code = String(body.code || '').replace(/\D/g, '');
  const rec = map.get(nonce);
  if (!rec || rec.linkUser || !loginKeyOk(rec, body.pk)) {
    return { status: 404, body: { error: 'Вход не найден — начните заново' } };
  }
  const bad = loginCodeCheck(map, nonce, rec, code);
  if (bad) return bad;
  map.delete(nonce);
  const token = loginIssue(rec);
  if (!token) return { status: 403, body: { error: 'Аккаунт заблокирован — напишите в поддержку' } };
  return { status: 200, body: { token, user: rec.user } };
}

const vfy = new Map();            /* nonce → {userId, platform, at, channel, code, tries} */
const VFY_TTL = 15 * 60 * 1000;
function vfySweep() {
  const now = Date.now();
  for (const [k, v] of vfy) if (now - v.at > VFY_TTL) vfy.delete(k);
}
setInterval(vfySweep, 60000).unref();

/* Протухшие сессии чистим на старте и раз в час: за месяцы работы
   таблица иначе растёт без ограничений. */
function sweepSessions() {
  try { db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(new Date().toISOString()); }
  catch (e) { console.error('[sessions]', e.message || e); }
}
sweepSessions();
setInterval(sweepSessions, 3600000).unref();

/* ── Маршруты ──────────────────────────────────────────────────────── */

/* ── Восстановление пароля: коды в памяти ──────────────────────────
   Шестизначный код живёт 10 минут. Храним не сам код, а его отпечаток
   (HMAC на случайном секрете процесса), чтобы дамп памяти не выдал коды.
   Коды живут в памяти, как и заявки на подтверждение канала: перезапуск
   сервера обнулит их, человек запросит заново.

   Сколько попыток даём — размен между двумя бедами, и обе настоящие.
   Считать попытки НАВСЕГДА нельзя: кто угодно, зная чужой адрес, пятью
   запросами погасил бы человеку восстановление насовсем. Обнулять их с
   каждым новым кодом — тоже нельзя: перебор становится бесконечным.
   Поэтому здесь три обруча сразу:

     · пять попыток на КОД (новый код их обнуляет — значит запереть
       человека нельзя);
     · пять кодов в час на адрес (потолок перебора — 25 догадок в час
       против миллиона вариантов);
     · пятьдесят неверных попыток в сутки на адрес — дальше новые коды
       не выдаются до конца суточного окна, и тревога владельцу. Это тот
       самый случай, когда счётчик суточный: он ловит долгий тихий
       перебор, который часовые потолки пропускают. (Аудит 16.10.2026:
       раньше после 50-й ошибки ставился лишь час паузы, а дальше счёт
       шёл 51, 52… без новой паузы — около 575 догадок в сутки вместо 50.
       Вход паролем, Телеграмом и Google при этом работает как прежде.)

   Ни один обруч не запирает человека навсегда: худшее, что может сделать
   чужой, — оставить его без кода восстановления до конца суток (вход
   паролем, Телеграмом и Google это не трогает). */
const PW_SECRET = crypto.randomBytes(32);
const PW_TTL_MS = 10 * 60 * 1000;
const PW_RESEND_MS = 60 * 1000;
const PW_MAX_PER_HOUR = 5;
const PW_MAX_ATTEMPTS = 5;
const PW_MAX_FAILS_DAY = 50;
const PW_ABUSE_PAUSE_MS = 60 * 60 * 1000;
/* email → { hash, expires, attempts, sentAt, hourAt, hourN, dayAt, dayFails, pauseUntil } */
const pwCodes = new Map();

/* ── Ссылка из письма ───────────────────────────────────────────────
   В письме кода нет — только кнопка «Открыть». Она ведёт на страницу
   /r/<метка>, где человек сам нажимает «Показать код». Зачем так:

     · код не светится в уведомлении на заблокированном экране и в
       списке писем — там виден только заголовок;
     · почтовые сканеры (их держат многие компании) открывают ссылки в
       письмах автоматически. Показ кода спрятан за НАЖАТИЕМ и отдельным
       POST-запросом, поэтому сканер его не заберёт.

   Как хранится. Прямо код держать в памяти не хочется: сейчас от него
   лежит только HMAC, и дамп памяти кодов не выдаёт. Сохраняем это
   свойство: ключ карты — хеш метки, а сам код лежит ЗАШИФРОВАННЫМ на
   ключе, выведенном из САМОЙ метки. Метка живёт только в письме. Значит
   в памяти сервера лежит «хеш метки + шифротекст» — расшифровать это,
   не имея письма, нельзя.                                              */
const pwLinks = new Map();   /* sha256(метка) → { email, enc, iv, tag, expires } */

function pwHash(email, code) {
  return crypto.createHmac('sha256', PW_SECRET).update(email + '|' + code).digest('hex');
}
function linkKey(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}
/* Ключ шифрования выводим из метки, а не из секрета процесса: иначе он
   лежал бы в той же памяти, что и шифротекст, и защита была бы мнимой. */
function linkCipherKey(token) {
  return crypto.createHash('sha256').update('bp-link|' + String(token)).digest();
}
function linkSeal(token, code) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', linkCipherKey(token), iv);
  const enc = Buffer.concat([c.update(String(code), 'utf8'), c.final()]);
  return { enc: enc.toString('hex'), iv: iv.toString('hex'), tag: c.getAuthTag().toString('hex') };
}
function linkOpen(token, rec) {
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', linkCipherKey(token), Buffer.from(rec.iv, 'hex'));
    d.setAuthTag(Buffer.from(rec.tag, 'hex'));
    return Buffer.concat([d.update(Buffer.from(rec.enc, 'hex')), d.final()]).toString('utf8');
  } catch (e) { return null; }   /* метка не та — расшифровка не сойдётся */
}
/* Запись счётчиков живёт дольше кода: сам код удаляется после смены
   пароля, а лимиты обязаны пережить это удаление — иначе успешный сброс
   обнулял бы часовой потолок и делал его бесполезным. */
function pwRec(email) {
  const now = Date.now();
  let rec = pwCodes.get(email);
  if (!rec) { rec = { hourAt: now, hourN: 0, dayAt: now, dayFails: 0 }; pwCodes.set(email, rec); }
  if (now - (rec.hourAt || 0) > 3600000) { rec.hourAt = now; rec.hourN = 0; }
  if (now - (rec.dayAt || 0) > 86400000) { rec.dayAt = now; rec.dayFails = 0; }
  return rec;
}
/* Код НЕ записывается сразу: сначала его надо успеть отправить письмом.
   Иначе неудачная отправка стирала бы прежний, ещё живой код и сжигала
   часовой лимит — человек оставался бы вообще без рабочего кода.
   Поэтому pwIssue только проверяет лимиты и готовит код, а закрепляет
   его pwCommit — уже после того, как письмо ушло. */
function pwIssue(email) {
  const now = Date.now();
  const rec = pwRec(email);
  if (rec.pauseUntil && now < rec.pauseUntil) return { error: 'paused' };
  /* суточный потолок: pwRec уже прокрутил окно, если сутки прошли */
  if ((rec.dayFails || 0) >= PW_MAX_FAILS_DAY) return { error: 'paused' };
  if (rec.hourN >= PW_MAX_PER_HOUR) return { error: 'too_many' };
  if (rec.sentAt && now - rec.sentAt < PW_RESEND_MS) {
    return { error: 'cooldown', wait: Math.ceil((PW_RESEND_MS - (now - rec.sentAt)) / 1000) };
  }
  return {
    code: String(crypto.randomInt(0, 1000000)).padStart(6, '0'),
    /* Метка для ссылки в письме. Как и код, закрепится только после
       успешной отправки — см. pwCommit. */
    token: crypto.randomBytes(16).toString('hex'),
  };
}
function pwCommit(email, code, token) {
  const now = Date.now();
  const rec = pwRec(email);
  rec.hash = pwHash(email, code);
  rec.expires = now + PW_TTL_MS;
  rec.attempts = 0;
  rec.sentAt = now;
  rec.hourN = (rec.hourN || 0) + 1;
  if (token) {
    /* Прежняя метка этого человека гаснет: иначе старое письмо
       продолжало бы показывать уже недействительный код. */
    if (rec.linkKey) pwLinks.delete(rec.linkKey);
    const k = linkKey(token);
    const sealed = linkSeal(token, code);
    pwLinks.set(k, {
      email, expires: now + PW_TTL_MS, shown: 0,
      enc: sealed.enc, iv: sealed.iv, tag: sealed.tag,
    });
    rec.linkKey = k;
  }
}
function pwVerify(email, code, consume) {
  const rec = pwCodes.get(email);
  const now = Date.now();
  /* суточный потолок перебора исчерпан — до конца окна ни одна проверка */
  if (rec) { pwRec(email); if ((rec.dayFails || 0) >= PW_MAX_FAILS_DAY) return { ok: false, reason: 'locked' }; }
  if (!rec || !rec.hash || now > rec.expires) return { ok: false, reason: 'expired' };
  if (rec.attempts >= PW_MAX_ATTEMPTS) return { ok: false, reason: 'locked' };
  const good = crypto.timingSafeEqual(
    Buffer.from(rec.hash, 'hex'), Buffer.from(pwHash(email, code), 'hex'));
  if (!good) {
    rec.attempts += 1;
    pwRec(email);                      /* прокрутит суточное окно, если пора */
    rec.dayFails = (rec.dayFails || 0) + 1;
    if (rec.dayFails >= PW_MAX_FAILS_DAY) {
      /* дальше — ни новых кодов (pwIssue), ни проверок (выше) до конца
         суточного окна; час паузы — на случай, если окно вот-вот кончится */
      rec.pauseUntil = Math.max(rec.pauseUntil || 0, now + PW_ABUSE_PAUSE_MS);
      if (rec.dayFails === PW_MAX_FAILS_DAY) {
        tgAlert('pwbrute:' + email,
          '🔐 Похоже на перебор кода восстановления\n\nАдрес: ' + email
          + '\nНеверных попыток за сутки: ' + rec.dayFails
          + '\nНовые коды на этот адрес — не раньше чем через сутки от первой попытки.'
          + '\nВойти паролем, Телеграмом или Google человек по-прежнему может.', 'server');
      }
    }
    return { ok: false, reason: 'wrong', left: Math.max(0, PW_MAX_ATTEMPTS - rec.attempts) };
  }
  /* Гасим только код. Счётчики остаются: успешный сброс не должен
     открывать заново часовой лимит. */
  if (consume) { rec.hash = null; rec.expires = 0; rec.attempts = 0; }
  return { ok: true };
}
/* ── Второй фактор на выводе ────────────────────────────────────────
   Вывод — единственное место, где деньги уходят наружу, и до сих пор
   его защищал только сессионный токен: кто им завладел, тот выводил на
   свои реквизиты без единой преграды. Гейт KYC тут не помогает — он
   проверяет ЛИЧНОСТЬ ХОЗЯИНА, а не того, кто сейчас за клавиатурой.

   Теперь заявка проходит в два шага: первый запрос ничего не двигает,
   а высылает код на почту; деньги трогает только второй, с кодом.

   Код привязан к СУММЕ И РЕКВИЗИТАМ: иначе можно было бы запросить код
   на сто рублей себе, а подтвердить им сто тысяч на чужую карту. */
const WD_TTL_MS = 10 * 60 * 1000;
const WD_MAX_ATTEMPTS = 5;
const wdCodes = new Map();   /* userId → { hash, expires, attempts, sig } */

/* Отпечаток заявки: по нему сверяем, что подтверждают именно то, на что
   просили код. Сумма и реквизиты — всё, что определяет, куда уйдут деньги. */
/* Показываем, КУДА ушёл код, но не весь адрес: если заявку создал не
   хозяин, полный адрес в ответе подсказал бы вору, куда ломиться. */
function maskEmail(e) {
  const s = String(e || '');
  const at = s.indexOf('@');
  if (at < 1) return '';
  const name = s.slice(0, at), dom = s.slice(at);
  if (name.length <= 2) return name[0] + '***' + dom;
  return name.slice(0, 2) + '***' + dom;
}
function wdSig(amount, requisites) {
  return crypto.createHmac('sha256', PW_SECRET)
    .update(String(amount) + '|' + String(requisites)).digest('hex');
}
/* Сколько раз человек просил код за последний час: перевыпуск не должен
   стирать память о попытках, иначе перебор бесконечен. */
const wdIssues = new Map();          /* userId → [время, …] */
const WD_ISSUE_MAX = 5;
function wdIssueAllowed(userId) {
  const now = Date.now();
  const arr = (wdIssues.get(userId) || []).filter((t) => now - t < 3600000);
  wdIssues.set(userId, arr);
  return arr.length < WD_ISSUE_MAX;
}
function wdIssue(userId, amount, requisites) {
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const now = Date.now();
  const arr = (wdIssues.get(userId) || []).filter((t) => now - t < 3600000);
  arr.push(now); wdIssues.set(userId, arr);
  const was = wdCodes.get(userId);
  wdCodes.set(userId, {
    hash: crypto.createHmac('sha256', PW_SECRET).update(userId + '|' + code).digest('hex'),
    expires: now + WD_TTL_MS,
    /* Счётчик попыток переезжает на новый код: иначе перевыпуск обнулял
       защиту и код подбирался пятёрками сколько угодно раз. */
    attempts: (was && Date.now() - (was.at || 0) < 3600000) ? (Number(was.attempts) || 0) : 0,
    at: now,
    sig: wdSig(amount, requisites),
  });
  return code;
}
setInterval(() => {
  const now = Date.now();
  for (const [id, arr] of wdIssues) {
    const live = arr.filter((t) => now - t < 3600000);
    if (live.length) wdIssues.set(id, live); else wdIssues.delete(id);
  }
}, 10 * 60 * 1000).unref();
/* ПРОВЕРЯЕТ, НО НЕ ГАСИТ. Гасить код здесь нельзя: после проверки заявка
   может не пройти дальше (например, кривой ключ операции), деньги не
   сдвинутся — а код уже сгорит, и человеку придётся запрашивать новый
   без всякой вины. Гасим отдельно, wdBurn, и только после успеха. */
function wdCheck(userId, code, amount, requisites) {
  const rec = wdCodes.get(userId);
  /* dead: код уже не оживить — приложению нужно выслать новый, а не просить
     ввести ещё раз. Раньше это приходилось угадывать по тексту ошибки. */
  if (!rec || Date.now() > rec.expires) return { ok: false, dead: true, why: 'Код истёк — запросите новый' };
  if (rec.attempts >= WD_MAX_ATTEMPTS) {
    wdCodes.delete(userId);
    return { ok: false, dead: true, why: 'Слишком много попыток — запросите новый код' };
  }
  /* Сумму и реквизиты сверяем ДО кода: если подменили заявку, дело не в
     коде, и подсказывать «неверный код» было бы ложью. */
  if (rec.sig !== wdSig(amount, requisites)) {
    return { ok: false, dead: true, why: 'Сумма или реквизиты изменились — нужен новый код' };
  }
  const mine = crypto.createHmac('sha256', PW_SECRET)
    .update(userId + '|' + String(code)).digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(rec.hash, 'hex'), Buffer.from(mine, 'hex'))) {
    rec.attempts += 1;
    return { ok: false, dead: false, why: 'Неверный код. Осталось попыток: ' + Math.max(0, WD_MAX_ATTEMPTS - rec.attempts) };
  }
  return { ok: true };
}
function wdBurn(userId) { wdCodes.delete(userId); }
setInterval(() => {
  const now = Date.now();
  for (const [k, r] of wdCodes) if (now > r.expires) wdCodes.delete(k);
}, 5 * 60 * 1000).unref();

function pwReason(reason, left) {
  if (reason === 'expired') return 'Код истёк — запросите новый';
  if (reason === 'locked') return 'Слишком много попыток — запросите новый код';
  if (reason === 'wrong') return left ? ('Неверный код. Осталось попыток: ' + left) : 'Неверный код';
  return 'Код недействителен';
}
/* Уборка, чтобы память не росла: запись уходит, когда истёк и код, и оба
   окна счётчиков, и пауза. */
setInterval(() => {
  const now = Date.now();
  for (const [email, rec] of pwCodes) {
    const codeDead = now > (rec.expires || 0);
    const hourDead = now - (rec.hourAt || 0) > 3600000;
    const dayDead = now - (rec.dayAt || 0) > 86400000;
    const pauseDead = !rec.pauseUntil || now > rec.pauseUntil;
    if (codeDead && hourDead && dayDead && pauseDead) pwCodes.delete(email);
  }
  for (const [k, rec] of pwLinks) {
    if (now > (rec.expires || 0)) pwLinks.delete(k);
  }
}, 5 * 60 * 1000).unref();

/* Проверка площадки: заданы ли ключи, дотягивается ли сервер до её
   адресов и не ругается ли она на ключ. Одним кодом пользуются и пульт
   оператора (кнопка «Проверить»), и журнал при запуске — иначе они
   расходятся во мнениях. Запросы делаются те же, что и в работе: HEAD
   проходит там, где настоящий запрос уже висит. */
async function platformProbe(p) {
  const cfg = OAUTH[p];
  if (!cfg) return null;
    const out = {
      platform: p, label: cfg.label,
      keys: !!(cfg.id && cfg.secret),
      redirect: OAUTH_BASE + '/api/verify/callback/' + p,
      scope: cfg.scope,
      authHost: (() => { try { return new URL(cfg.auth).host; } catch (e) { return ''; } })(),
      apiHost: (() => { try { return new URL(cfg.token).host; } catch (e) { return ''; } })(),
    };
    if (!out.keys) {
      out.verdict = 'Ключи площадки не заданы: заполните ключ и секрет в настройках сервера.';
      return out;
    }

    /* Ходить будем с ограничением по времени: заблокированный адрес
       иначе держит запрос до самого таймаута системы. */
    const once = async (address, opts) => {
      const stop = AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined;
      try {
        const r = await fetch(address, Object.assign({ redirect: 'follow', signal: stop }, opts || {}));
        const text = await r.text().catch(() => '');
        return { ok: true, status: r.status, url: r.url, text: text.slice(0, 4000) };
      } catch (e) {
        return { ok: false, why: String((e && e.message) || e) };
      }
    };
    const grab = async (address, opts) => {
      const a = await once(address, opts);
      if (a.ok) return a;
      return once(address, opts);              /* вторая попытка: обрыв ещё не блокировка */
    };

    /* 1. Виден ли сервер площадки вообще. Обмен кода на данные делает
          именно сервер: если отсюда не открывается — вход не заработает,
          сколько ни правь ключи. */
    const api = await grab(cfg.token, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=authorization_code' });
    /* Данные аккаунта запрашиваются отдельным адресом — его тоже
       проверяем: бывает, что обмен токена проходит, а этот висит. */
    const info = cfg.userInfo ? await grab(cfg.userInfo + '?fields=open_id', { headers: { Authorization: 'Bearer probe' } }) : { ok: true };
    out.tokenReachable = api.ok;
    out.infoReachable = info.ok;
    out.apiReachable = api.ok && info.ok;
    if (!api.ok) out.apiWhy = api.why;
    else if (!info.ok) out.apiWhy = info.why;

    /* 2. Узнаёт ли площадка ключ. Открываем ту же страницу входа, что
          увидит человек, и смотрим, не ругается ли она на client_key. */
    const q1 = new URLSearchParams({
      response_type: 'code', state: 'probe', redirect_uri: out.redirect, scope: cfg.scope,
    });
    if (p === 'youtube') { q1.set('client_id', cfg.id); q1.set('access_type', 'online'); }
    else q1.set('client_key', cfg.id);
    const auth = await grab(cfg.auth + '?' + q1.toString(), {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36', Accept: 'text/html' },
    });
    out.authReachable = auth.ok;
    if (!auth.ok) out.authWhy = auth.why;
    if (auth.ok) {
      const t = auth.text || '';
      out.authStatus = auth.status;
      /* Страница входа собирается скриптами: ошибка про ключ до тела ответа
         обычно не доходит, поэтому признак берём только явный. */
      out.keyRejected = /client_key/i.test(t) && /(invalid_client|unknown client|client key is)/i.test(t);
      out.scopeRejected = /invalid[_ ]?scope|scope.*not.*(approved|authorized)/i.test(t);
    }

    out.verdict = !out.apiReachable
      ? 'С этого сервера ' + out.apiHost + (out.tokenReachable && !out.infoReachable
          ? ' открывается наполовину: обмен кода проходит, а запрос данных аккаунта нет.'
          : ' не открывается.')
        + ' Обмен кода на данные делает сервер, поэтому вход не заработает, пока не пропишете рабочий адрес в TT_API_BASE.'
      : out.authReachable === false
        ? 'Страница входа ' + out.authHost + ' с сервера не открывается. Человеку она может быть доступна, проверьте вход руками.'
        : out.keyRejected
          ? 'Площадка не узнала ключ: нужен именно Client key из раздела Credentials — не App ID и не секрет.'
          : out.scopeRejected
            ? 'Ключ принят, но запрошенные права не одобрены. Оставьте в TT_SCOPE только user.info.basic и подайте приложение на проверку.'
            : 'Ключи заданы, адреса площадки с сервера открываются. Верен ли сам ключ,'
              + ' отсюда не проверить: TikTok сверяет его уже в браузере. Откройте вход'
              + ' в приложении — ошибка «client_key» там значит, что ключ не тот либо'
              + ' приложение ещё не одобрено (тогда входят только тестовые аккаунты).';
    return out;
}

const routes = {

  'GET /api/health': async () => ({ status: 200, body: { ok: true, version: 'bp-server-1' } }),

  /* ── Какая версия приложения лежит на сервере ──
     Установленное приложение живёт неделями и легко застревает на старой
     версии: служебный работник меняется только вместе со своим файлом, а
     мы правим сам мини-апп. Поэтому отдельная метка — отпечаток файла
     приложения. Приложение читает её при запуске и потом сверяет; стала
     другой — значит вышло обновление, надо перезагрузиться.
     Считаем по времени правки и размеру: читать пять мегабайт на каждый
     вопрос незачем, а этой пары хватает, чтобы заметить выкладку. */
  'GET /api/version': async () => {
    let v = 'нет';
    try {
      const f = path.join(__dirname, '..', SITE['/'].name);
      const st = fs.statSync(f);
      v = String(st.mtimeMs) + '-' + String(st.size);
    } catch (e) { /* файла нет — версии тоже */ }
    return { status: 200, headers: { 'Cache-Control': 'no-store' }, body: { v } };
  },

  /* ── Каталог блогеров ──
     GET открыт всем (каталог и так виден до входа), POST — только своей
     карточке. Чужую перезаписать нельзя даже с валидным токеном. */
  'GET /api/cards': async (req) => {
    if (!rateLimit(req, 'cards:list', 120, 60000)) return tooOften;
    const now = Date.now();
    if (!cardsCache.rows || now - cardsCache.at > 15000) {
      cardsCache.rows = q.cardsPublic.all(300).map((r) => {
        let card = {};
        try { card = JSON.parse(r.data); } catch (e) { card = {}; }
        return { id: r.id, userId: r.user_id, card, updatedAt: r.updated_at };
      });
      cardsCache.at = now;
    }
    return { status: 200, body: { rows: cardsCache.rows } };
  },

  /* ── Конверты: положить и забрать ──
     Кладёт только участник. Новый конверт: отправитель — a, адресат —
     b (to). Без адресата — общий (видят все вошедшие). Чужой конверт
     переписать нельзя, даже зная его номер. */
  /* Виды, которые приложение применяет к данным получателя: профиль
     (prof), личные настройки и избранное (mine), свободные дни (slot).
     Такой конверт человек пишет только сам себе — см. проверку ниже. */
  /* ждущий запрос (см. wakeUser): отвечает сразу, как у человека событие,
     или через WAKE_MS пустым списком — приложение тут же спрашивает снова */
  'GET /api/wake': async (req) => {
    const u = auth(req);
    if (!u) return { status: 401, body: { error: 'Нужен вход' } };
    if (!rateLimit(req, 'wake:' + u.id, 40, 60000)) return tooOften;
    const uid = Number(u.id);
    const late = wakeLate.get(uid);
    if (late && Date.now() - late.at < WAKE_KEEP_MS && late.kinds.size) {
      wakeLate.delete(uid);
      return { status: 200, body: { kinds: Array.from(late.kinds) } };
    }
    wakeLate.delete(uid);
    let set = wakeWait.get(uid);
    if (!set) { set = new Set(); wakeWait.set(uid, set); }
    /* не больше трёх ждущих на человека (вкладки, телефоны) — старший уходит */
    if (set.size >= 3) { const old = set.values().next().value; if (old) old.done([]); }
    return await new Promise((resolve) => {
      let fin = false;
      /* ушёл человек — слушаем СОЕДИНЕНИЕ: 'close' у самого запроса в Node
         приходит, как только запрос дочитан, и ожидание кончалось бы сразу */
      const sock = req.socket;
      const gone = () => { if (!fin) w.done([]); };
      const w = { done: (kinds) => {
        if (fin) return; fin = true;
        clearTimeout(w.t); set.delete(w); if (!set.size) wakeWait.delete(uid);
        try { if (sock) sock.removeListener('close', gone); } catch (e) {}
        resolve({ status: 200, body: { kinds: kinds || [] } });
      } };
      w.t = setTimeout(() => w.done([]), WAKE_MS);
      set.add(w);
      try { if (sock) sock.once('close', gone); } catch (e) {}
    });
  },

  'POST /api/sync/put': async (req, body) => {
    const u = auth(req);
    if (!u) return { status: 401, body: { error: 'Нужен вход' } };
    if (!rateLimit(req, 'sync:put:' + u.id, 240, 60000)) return tooOften;
    const kind = String(body.kind || '');
    const rid = String(body.rid || '');
    if (!/^[a-z]{2,16}$/.test(kind)) return { status: 400, body: { error: 'Неверный вид записи' } };
    if (!/^[\w.:+-]{3,80}$/.test(rid)) return { status: 400, body: { error: 'Неверный номер записи' } };
    /* ЛИЧНЫЙ КОНВЕРТ — «письмо себе». Приложение применяет виды prof,
       mine и slot к данным ТОГО, КТО ИХ ПОЛУЧИЛ, не спрашивая, кто
       прислал. Значит и завести такой конверт можно только на себя.
       Проверено живьём: посторонний клал в ящик другого человека
       {kind:'prof', rid:'self:<его номер>'} — и тот при следующей
       синхронизации переписывал себе имя, роль и фото. Заняв чужое имя
       записи первым, он же навсегда запирал человеку перенос профиля
       между устройствами. Само приложение это правило и подразумевает
       (profRid в мини-аппе): имя записи включает свой серверный номер,
       адресата у письма себе нет. Теперь так и на сервере. */
    if (SELF_KINDS.has(kind)) {
      if (rid !== 'self:' + u.id) {
        return { status: 403, body: { error: 'Личную запись можно вести только о себе' } };
      }
      if (body.to != null && String(body.to) !== '' && Number(body.to) !== u.id) {
        return { status: 400, body: { error: 'У личной записи не бывает адресата' } };
      }
      body = Object.assign({}, body); delete body.to;
    }
    if (body.data == null || typeof body.data !== 'object') return { status: 400, body: { error: 'Нет содержимого' } };
    let data = JSON.stringify(body.data);
    if (data.length > 400 * 1024) return { status: 413, body: { error: 'Запись слишком большая' } };
    /* Поле «toString»/«valueOf» в данных (аудит 16.10.2026): приложение их
       не пишет, а на сервере такой объект ломает String()/Number() у
       любого, кто читает конверт (витрина гостя отвечала 500 всем). В
       JSON без пробелов ключ узнаётся однозначно: в строке кавычка
       экранирована. */
    if (/"(?:toString|valueOf|toJSON)":/.test(data)) return { status: 400, body: { error: 'Неверное содержимое записи' } };
    const ex = q.syncGet.get(kind, rid);
    let a = u.id, b = null, created = null;
    if (ex) {
      if (ex.a_id !== u.id && ex.b_id !== u.id) return { status: 403, body: { error: 'Это чужая запись' } };
      a = ex.a_id; b = ex.b_id; created = ex.created_at;
      /* адресата можно назначить позже, но не сменить */
      if (b == null && body.to != null && String(body.to) !== '') {
        const to = Number(body.to);
        if (!Number.isInteger(to) || !q.userById.get(to)) return { status: 400, body: { error: 'Адресат не найден' } };
        b = to;
      }
    } else if (body.to != null && String(body.to) !== '') {
      const to = Number(body.to);
      if (!Number.isInteger(to) || to === u.id || !q.userById.get(to)) return { status: 400, body: { error: 'Адресат не найден' } };
      b = to;
    }
    /* ЗАДАНИЯ (аудит 16.10.2026): не больше SYNC_CAMP_LIVE «в работе» и
       SYNC_CAMP_ALL всего у одного автора. Пауза, «завершено» и правка
       уже запущенного проходят всегда. */
    if (kind === 'camp' && a === u.id) {
      /* Бюджет задания уже возвращён целиком — «активным» оно не станет:
         старая копия с другого устройства (или местная правка после
         «Удалить»/«Завершить») иначе вернула бы его в ленту всем. */
      if (campLiveStatus(body.data.status)) {
        const dl = q.deal.get('camp:' + rid);
        if (dl && dl.status === 'refunded') {
          body = Object.assign({}, body, { data: Object.assign({}, body.data, { status: 'done' }) });
          data = JSON.stringify(body.data);
        }
      }
      if (!ex && (Number((q.campCountAll.get(u.id) || {}).n) || 0) >= SYNC_CAMP_ALL) {
        return { status: 409, body: { error: 'Заданий в аккаунте больше ' + SYNC_CAMP_ALL + ' — напишите в поддержку', code: 'camp_limit' } };
      }
      if (campLiveStatus(body.data.status)) {
        let was = false;
        if (ex) { try { was = campLiveStatus((JSON.parse(ex.data) || {}).status); } catch (e) { was = false; } }
        if (!was && campLiveCount(u.id, rid) >= SYNC_CAMP_LIVE) return { status: 409, body: campLimitBody };
      }
    }
    /* ЛИЧНОЕ СООБЩЕНИЕ (аудит 16.10.2026): имя отправителя — из его
       аккаунта, а не из письма. Раньше получатель видел то имя, что
       написал отправитель («BloggerPay Поддержка», имя другого человека),
       и чат с ним так и заводился. Роль «рекламодатель» — только у того,
       кто им зарегистрирован или ведёт задания (роль в приложении
       переключается, поэтому «блогер» принимаем от любого). */
    if (kind === 'dm' && a === u.id && b != null) {
      if (!ex && !dmTied(u.id, b) && !dmNewAllowed(u.id)) {
        return { status: 429, body: { error: 'Сегодня вы начали слишком много новых диалогов — сообщение уйдёт позже', code: 'dm_new_limit' } };
      }
      const d = Object.assign({}, body.data);
      d.n = String(u.name || '').trim().slice(0, 60);
      const advLike = u.role === 'advertiser' || !!q.syncHasCamp.get(u.id);
      d.r = d.r === 'adv' ? (advLike ? 'adv' : 'blogger') : (d.r === 'blogger' || !advLike ? 'blogger' : 'adv');
      data = JSON.stringify(d);
      if (data.length > 400 * 1024) return { status: 413, body: { error: 'Запись слишком большая' } };
    }
    /* ЗАНЯТОЕ ЧЕЛОВЕКОМ: записи и их объём по последнему писавшему.
       Переписать своё тем же или меньшим можно и сверх предела. */
    const bytes = Buffer.byteLength(data);
    const own = !!(ex && ex.from_id === u.id);
    const oldBytes = ex ? Buffer.byteLength(ex.data) : 0;
    const use = syncUseOf(u.id);
    if (!own && use.n + 1 > SYNC_USER_ROWS) {
      return { status: 409, body: { error: 'В аккаунте слишком много записей — напишите в поддержку', code: 'sync_limit' } };
    }
    const grow = bytes - (own ? oldBytes : 0);
    if (grow > 0 && use.b + grow > SYNC_USER_BYTES) {
      return { status: 413, body: { error: 'Место для переписки и записей аккаунта закончилось ('
        + Math.round(SYNC_USER_BYTES / 1048576) + ' МБ) — напишите в поддержку', code: 'sync_limit' } };
    }
    let ver = 0;
    db.exec('BEGIN IMMEDIATE');
    try {
      if (ex) q.syncDel.run(kind, rid);
      q.syncIns.run(kind, rid, a, b, u.id, data, created || new Date().toISOString().slice(0, 19).replace('T', ' '));
      ver = Number(q.syncMax.get().v) || 0;
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch (_) {}
      throw e;
    }
    syncUseAdd(u.id, own ? 0 : 1, grow);
    if (ex && !own) syncUseAdd(ex.from_id, -1, -oldBytes);
    /* задание включили, поставили на паузу или завели — сводка «Главной» устарела */
    if (kind === 'camp') tsumCache.at = 0;
    /* вторая сторона конверта (сообщение, сделка) узнаёт сразу (/api/wake) */
    else {
      const other = Number(u.id) === Number(a) ? b : a;
      if (other && Number(other) !== Number(u.id)) wakeUser(other, 'sync');
    }
    return { status: 200, body: { ok: true, ver, a, b } };
  },

  /* since — последний виденный номер; отдаём до 200 конвертов новее.
     Если их больше, more:true — клиент придёт ещё раз. */
  /* ── Витрина заданий для гостя ──
     Человек, который ещё не завёл аккаунт, должен увидеть, ради чего его
     заводить. Отдаём только то, что и так написано в самом объявлении:
     что сделать, за сколько, на какой площадке. Ни номеров людей, ни
     внутренних полей, ни черновиков — они сюда не попадают, потому что
     черновики вообще не уезжают на сервер. */
  'GET /api/tasks/public': async (req) => {
    if (!rateLimit(req, 'tasks:pub' + softKey(req), 60, 60000)) return tooOften;
    const rows = q.publicCamps.all(60);
    const out = [];
    /* Каждая строка — в своём try (аудит 16.10.2026): один кривой конверт
       пропускаем, а не роняем витрину всем гостям. */
    for (const r of rows) {
     try {
      let d = null;
      try { d = JSON.parse(r.data); } catch (e) { continue; }
      if (!d || typeof d !== 'object' || d.status !== 'active') continue;
      const title = cardStr(d.title || d.name, 120);
      if (!title) continue;
      /* дата создания задания: из самого задания, иначе — когда конверт
         впервые лёг на сервер (SQLite хранит UTC без пояса — добавляем Z) */
      const cMs = vidMs(typeof d.createdAt === 'number' || typeof d.createdAt === 'string' ? d.createdAt : '')
        || Date.parse(safeStr(r.created_at).replace(' ', 'T') + 'Z');
      const atMs = Date.parse(safeStr(r.updated_at).replace(' ', 'T') + 'Z');
      out.push({
        id: String(r.rid).slice(0, 80),
        title,
        desc: cardStr(d.desc || d.description, 400),
        /* бюджет — сколько на самом деле заморожено под задание */
        budget: Math.max(0, Number(r.held_amount) || 0),
        perBlogger: pubNum(d.perBlogger || d.price),
        slots: pubNum(d.slots),
        accountType: cardStr(d.accountType, 40),
        createdAt: Number.isFinite(cMs) && cMs > 0 ? new Date(cMs).toISOString() : '',
        platform: cardStr(d.platform, 24),
        format: cardStr(d.format, 40),
        topics: Array.isArray(d.topics) ? d.topics.slice(0, 6).map((t) => cardStr(t, 40)) : [],
        advertiser: cardStr(d.advertiserName, 60),
        /* условия объявления — то, что гость и так прочтёт в задании:
           тип, площадки, ставка и потолок за видео, срок (10.10.2026,
           карточка «как у More Views»: чип формата, значки площадок,
           «10 ₽ за 1 000») */
        formatLabel: cardStr(d.formatLabel, 40),
        platforms: pubPlats(d.platforms),
        payMode: d.payMode === 'fixed' ? 'fixed' : '',
        fixedPrice: pubNum(d.fixedPrice),
        rate: pubNum(d.rate),
        maxPayout: pubNum(d.maxPayout || d.payMax),
        minViews: pubNum(d.minViews),
        /* и правила, которые гость читает в задании (11.10.2026): без
           них страница задания показывала «Минимальная длина: любая» */
        minDuration: pubNum(d.minDuration || d.videoMinSec),
        language: cardStr(d.language, 40),
        hashtags: cardStr(d.hashtags, 300),
        deadline: Number.isFinite(Date.parse(safeStr(d.deadline))) ? new Date(Date.parse(safeStr(d.deadline))).toISOString() : '',
        /* последняя правка — ISO с поясом (было «2026-10-15 20:08:23»:
           браузер читал её как местное время) */
        at: Number.isFinite(atMs) ? new Date(atMs).toISOString() : '',
      });
     } catch (e) { continue; }
    }
    return { status: 200, body: { rows: out } };
  },

  /* ── Сводка заданий для «Главной» (как у More Views) ──
     Карточка задания показывает «N видео · 👁 X» и «N ₽ из M ₽». Эти же
     цифры любой вошедший и так видит в шторке задания (/api/tasks/board),
     поэтому ручка открыта всем, гостю тоже. Наружу — только номер задания
     и пять чисел: ни людей, ни ников, ни каналов, ни названий.
       videos — роликов в статусах лидерборда (review, rejected, active, paid);
       views  — их просмотры (v.views, как в лидерборде);
       paid   — выплачено блогерам из заморозки задания;
       budget — заморожено под задание всего;
       reserved — держится под живые ролики (как reserved доски).
     Кэш общий на 60 секунд (tsumCache). Ключи — Object.create(null):
     номер задания пишет клиент, и «__proto__» иначе ушёл бы в прототип. */
  'GET /api/tasks/summary': async (req) => {
    if (!rateLimit(req, 'tsum' + softKey(req), 120, 60000)) return tooOften;
    const now = Date.now();
    if (!tsumCache.body || now - tsumCache.at >= 60000) {
      const camps = Object.create(null);
      for (const r of q.tasksSummary.all(1000)) {
        camps[String(r.id).slice(0, 80)] = {
          videos: Number(r.videos) || 0, views: Number(r.views) || 0,
          paid: Number(r.paid) || 0, budget: Number(r.budget) || 0,
          /* резерв живых роликов — как на доске: без него гость видел
             «Осталось» больше, чем есть (11.10.2026) */
          reserved: vidReserved(r.id),
          /* ставка комиссии с выплат блогерам: витрина показывает «вам N ₽» */
          payFeePct: vidPayFeePct(r.id),
        };
      }
      tsumCache.body = { ok: true, at: now, camps };
      tsumCache.at = now;
    }
    return { status: 200, body: tsumCache.body, headers: { 'Cache-Control': 'no-store' } };
  },

  'GET /api/sync/pull': async (req, body, url) => {
    const u = auth(req);
    if (!u) return { status: 401, body: { error: 'Нужен вход' } };
    if (!rateLimit(req, 'sync:pull:' + u.id, 240, 60000)) return tooOften;
    const since = Math.max(0, Number(url.searchParams.get('since')) || 0);
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 200));
    const rows = q.syncPull.all(since, u.id, u.id, limit + 1);
    const more = rows.length > limit;
    const out = rows.slice(0, limit).map((r) => {
      let data = null;
      try { data = JSON.parse(r.data); } catch (e) { data = null; }
      return { ver: r.ver, kind: r.kind, rid: r.rid, a: r.a_id, b: r.b_id, from: r.from_id, data, updatedAt: r.updated_at };
    });
    const ver = out.length ? out[out.length - 1].ver : since;
    return { status: 200, body: { rows: out, ver, more, me: u.id } };
  },

  'POST /api/cards': async (req, body) => {
    const u = auth(req);
    if (!u) return { status: 401, body: { error: 'Нужен вход' } };
    if (!rateLimit(req, 'cards:put:' + u.id, 30, 60000)) return tooOften;
    const id = cardStr(body.id, 64);
    if (!/^[A-Za-z0-9_.:-]{3,64}$/.test(id)) return { status: 400, body: { error: 'Неверный номер карточки' } };
    const card = cleanCard(body.card);
    if (!card.name) return { status: 400, body: { error: 'У карточки должно быть имя' } };
    const data = JSON.stringify(card);
    if (data.length > 400 * 1024) return { status: 413, body: { error: 'Карточка слишком большая' } };
    const ex = q.cardGet.get(id);
    if (ex && ex.user_id !== u.id) return { status: 403, body: { error: 'Это чужая карточка' } };
    /* Правка своей карты меняет только данные: снятие с витрины (hidden)
       — решение владельца площадки, синхронизация из приложения его не
       отменяет. */
    if (ex) q.cardUpd.run(data, id);
    else {
      if (q.cardsMine.all(u.id).length >= 3) return { status: 409, body: { error: 'Больше трёх карточек на аккаунт нельзя' } };
      /* Новая строка: снятая и удалённая автором карта с тем же номером
         ложится снятой, как была; пока витрина закрыта — любая новая
         тоже (см. card_tombs и cards_closed у таблиц). */
      const tomb = q.cardTombGet.get(id);
      /* Автор, чью карту владелец скрыл по одной, новой картой (под новым
         номером) это решение не обходит — ни сразу, ни через «Вернуть все». */
      const hidden = q.cardAuthorHid.get(u.id, u.id) ? 1
        : tomb ? (Number(tomb.hidden) === 2 ? 2 : 1) : (cardsClosed() ? 2 : 0);
      q.cardIns.run(id, u.id, data, hidden);
      if (tomb) q.cardTombDel.run(id);
    }
    cardsCache.at = 0;
    return { status: 200, body: { ok: true, id } };
  },

  'POST /api/cards/delete': async (req, body) => {
    const u = auth(req);
    if (!u) return { status: 401, body: { error: 'Нужен вход' } };
    const id = cardStr(body.id, 64);
    /* Удалить свою карту автор может всегда, но снятая не должна вернуться
       на витрину, если тот же номер пришлёт второй телефон: запоминаем
       отметку (только номер и отметку, без данных карты). */
    const ex = q.cardGet.get(id);
    if (ex && ex.user_id === u.id && Number(ex.hidden)) q.cardTombPut.run(id, u.id, Number(ex.hidden));
    const r = q.cardDel.run(id, u.id);
    cardsCache.at = 0;
    return { status: 200, body: { ok: true, removed: Number(r.changes) || 0 } };
  },

  /* Рубильник владельца: скрытая карточка исчезает из каталога у всех,
     но остаётся у автора — это не удаление работы, а снятие с витрины. */
  'POST /api/admin/cards/hide': async (req, body) => {
    if (!isAdmin(req)) return { status: 403, body: { error: 'Только владелец площадки' } };
    const id = cardStr(body.id, 64);
    const card = q.cardGet.get(id);
    if (!card) return { status: 404, body: { error: 'Карточка не найдена' } };
    q.cardHide.run(body.hidden === false ? 0 : 1, id);
    /* «Вернуть» у карты автора снимает и отметку об авторе (следы его
       удалённых карт, скрытых по одной): владелец ему снова доверяет. */
    if (body.hidden === false) q.cardTombsAuthorClear.run(card.user_id);
    cardsCache.at = 0;
    adminLog(req, body.hidden === false ? 'card-show' : 'card-hide', 'карточка ' + id, null);
    return { status: 200, body: { ok: true, id, hidden: body.hidden !== false } };
  },

  /* hidden в строке: 0 — на витрине, 1 — скрыта по одной, 2 — снята общей
     кнопкой. stats — по всей таблице (строк в ответе не больше 300). */
  'GET /api/admin/cards': async (req) => {
    if (!isAdmin(req)) return { status: 403, body: { error: 'Только владелец площадки' } };
    return { status: 200, body: { stats: cardsStatsBody(), rows: q.cardsAll.all().map((c) => ({
      id: c.id, user_id: c.user_id, hidden: c.hidden, updated_at: c.updated_at, owner: c.owner,
      owner_email: c.owner_email, owner_blocked: c.owner_blocked,
      card: Object.assign(cardBrief(c.data), { hasAvatar: !!c.has_avatar }),
    })) } };
  },

  /* Снять все карты с витрины разом (10.10.2026, решение владельца:
     модель как у More Views, карта блогера больше не услуга). Обратимо:
     карты остаются у авторов и в пульте со своей отметкой (hidden = 2).
     Витрина закрывается: пока не нажато «Вернуть все», новые карты и
     повторно присланные приложением тоже ложатся снятыми. Скрытые раньше
     по одной (hidden = 1) остаются при своей отметке. Повторное нажатие
     безопасно: снимать уже нечего — unpublished: 0. */
  'POST /api/admin/cards/unpublish-all': async (req) => {
    if (!isAdmin(req)) return { status: 403, body: { error: 'Только владелец площадки' } };
    let n = 0;
    db.exec('BEGIN IMMEDIATE');
    try {
      n = Number(q.cardsUnpublishAll.run().changes) || 0;
      q.flagSet.run('cards_closed', '1');
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch (_) {}
      throw e;
    }
    cardsCache.at = 0; cardsCache.rows = null;
    try { vidBoards.clear(); } catch (e) { /* доски заданий соберутся заново */ }
    const stats = cardsStatsBody();
    adminLog(req, 'cards-unpublish-all', 'витрина карт',
      'снято ' + n + ' · витрина закрыта, новые карты ложатся снятыми · скрытых по одной: ' + stats.hidden);
    return { status: 200, body: { ok: true, unpublished: n, closed: true, stats } };
  },

  /* Вернуть все карты, снятые общей кнопкой, и открыть витрину. Скрытые
     по одной (hidden = 1) не возвращаются — это отдельные решения; их
     «Вернуть» — по одной, через /api/admin/cards/hide. */
  'POST /api/admin/cards/restore-all': async (req) => {
    if (!isAdmin(req)) return { status: 403, body: { error: 'Только владелец площадки' } };
    let n = 0;
    db.exec('BEGIN IMMEDIATE');
    try {
      n = Number(q.cardsRestoreAll.run().changes) || 0;
      q.cardTombsRestoreAll.run();
      q.flagDel.run('cards_closed');
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch (_) {}
      throw e;
    }
    cardsCache.at = 0; cardsCache.rows = null;
    try { vidBoards.clear(); } catch (e) { /* доски заданий соберутся заново */ }
    const stats = cardsStatsBody();
    adminLog(req, 'cards-restore-all', 'витрина карт',
      'возвращено ' + n + ' · витрина открыта · скрытыми по одной остались: ' + stats.hidden);
    return { status: 200, body: { ok: true, restored: n, closed: false, stats } };
  },

  /* ── Рейтинг блогеров ──
     Публичная ручка: её видит и тот, кто ещё не вошёл (каталог тоже
     открыт всем). Отдаём НАМЕРЕННО МАЛО: id, имя и число выплат — то
     есть закрытых сделок и принятых заданий. Ни сумм, ни адресов
     каналов: заработок других людей — не для витрины. Своё место и свой
     счётчик получает только вошедший, и только про себя.
     Считается из журнала, а не из таблицы сделок: бюджет кампании
     платится частями разным людям, и у такой сделки один payee_id. */
  'GET /api/leaderboard': async (req) => {
    if (!rateLimit(req, 'lb', 60, 60000)) return tooOften;
    const now = Date.now();
    if (!lbCache.rows || now - lbCache.at > 60000) {
      /* Имя — как в лидерборде задания (vidPubName): почта вместо имени и
         номер Телеграма из имени по умолчанию наружу не уходят. id —
         служебный номер аккаунта (по нему приложение находит свою строку);
         он назван в политике конфиденциальности. */
      lbCache.rows = q.lbTop.all(10).map((r) => ({ id: r.id, name: vidPubName(r.name), deals: Number(r.deals) || 0 }));
      lbCache.total = Number((q.lbTotal.get() || {}).n) || 0;
      lbCache.at = now;
    }
    let me = null;
    const u = auth(req);
    if (u) {
      const mine = q.lbMine.get(u.id) || {};
      const deals = Number(mine.deals) || 0;
      const place = deals
        ? (Number((q.lbPlace.get(deals, deals, mine.last_at || '', mine.last_at || '', u.id) || {}).ahead) || 0) + 1
        : 0;
      me = { deals, place, total: lbCache.total };
    }
    return { status: 200, body: { rows: lbCache.rows, total: lbCache.total, me } };
  },

  'POST /api/register': async (req, body) => {
    if (!rateLimit(req, 'reg', 10, 60000)) return tooOften;
    const email = String(body.email || '').trim().toLowerCase();
    const name = String(body.name || '').trim().slice(0, 120);
    const role = body.role === 'advertiser' ? 'advertiser' : 'blogger';
    const pass = String(body.password || '');
    if (email.length > EMAIL_MAX) return { status: 400, body: { error: 'Слишком длинный адрес почты' } };
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { status: 400, body: { error: 'Некорректный email' } };
    /* Служебный домен входа по Телеграму. Живых ящиков там нет, а занятый
       заранее адрес позволял перехватить чужой аккаунт при первом входе
       из мини-аппа. Регистрация на него закрыта (и на google.local — тоже
       служебный, для входа через Google без почты). */
    if (isServiceEmail(email)) {
      return { status: 400, body: { error: /@google\.local$/i.test(email) ? 'Этот адрес занят служебным входом через Google' : 'Этот адрес занят служебным входом по Телеграму' } };
    }
    if (!name) return { status: 400, body: { error: 'Введите имя' } };
    if (pass.length < 8) return { status: 400, body: { error: 'Пароль — минимум 8 символов' } };
    if (pass.length > PASS_MAX) return { status: 400, body: { error: 'Слишком длинный пароль — не больше ' + PASS_MAX + ' символов' } };
    /* АДРЕС ВЛАДЕЛЬЦА ЗАНИМАЕТ ТОЛЬКО ВЛАДЕЛЕЦ.
       Аккаунт с почтой из ADMIN_EMAIL получает права на всю площадку
       (syncAdminFlag). Адрес этот не секрет — он стоит в политике и в
       письмах, — а почту здесь никто не подтверждает. Значит, пока
       такого аккаунта в базе нет, занять адрес мог посторонний и забрать
       площадку себе: чужие балансы, паспорта, реестр выплат, вход в
       любой аккаунт. Требуем ключ: у владельца он есть. */
    if (ADMIN_EMAILS.includes(email) && !isAdmin(req)) {
      return { status: 403, body: { error: 'Этот адрес принадлежит владельцу площадки — занять его можно только с ключом владельца' } };
    }
    if (q.userByEmail.get(email)) return { status: 409, body: { error: 'Этот email уже зарегистрирован' } };
    const salt = crypto.randomBytes(16).toString('hex');
    const info = q.insUser.run(email, name, role, salt, scrypt(pass, salt));
    const uid = Number(info.lastInsertRowid);
    const token = newToken();
    const exp = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
    q.insSession.run(token, uid, exp);
    /* Сюда доходит только владелец: регистрация на его адрес выше
       требует ключа. */
    const admin = ADMIN_EMAILS.includes(email) ? 1 : 0;
    if (admin) q.setAdmin.run(1, uid);
    return { status: 200, body: { token, user: { id: uid, email, name, role, isAdmin: !!admin } } };
  },

  'POST /api/login': async (req, body) => {
    if (!rateLimit(req, 'login', 20, 60000)) return tooOften;
    const email = String(body.email || '').trim().toLowerCase();
    /* Одинаковый ответ для «нет такого» и «пароль не тот» — чтобы по
       ответам нельзя было перебирать, кто зарегистрирован. */
    const bad = { status: 401, body: { error: 'Неверный email или пароль' } };
    if (email.length > EMAIL_MAX) { scrypt('заглушка-для-ровного-времени', 'соль'); return bad; }
    /* пауза после череды промахов по этой почте — до сверки пароля, иначе
       перебор шёл бы дальше (аудит 16.10.2026, loginMissed) */
    const ipk = loginIpKey(req);
    const paused = loginPausedFor(email, ipk);
    if (paused) return loginPausedReply(paused);
    const slow = loginSlowMs(email);
    if (slow) await new Promise((r) => setTimeout(r, slow));
    const u = q.userByEmail.get(email);
    if (!u) { scrypt('заглушка-для-ровного-времени', 'соль'); loginMissed(email, ipk, null); return bad; }
    const hash = scrypt(String(body.password || ''), u.pass_salt);
    const stored = String(u.pass_hash || '');
    if (hash.length !== stored.length || !crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(stored))) {
      loginMissed(email, ipk, u);
      return bad;
    }
    loginPairClear(email, ipk);
    if (u.is_blocked) return { status: 403, body: { error: 'Аккаунт заблокирован' } };
    syncAdminFlag(u);
    const token = newToken();
    const exp = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
    q.insSession.run(token, u.id, exp);
    return { status: 200, body: { token, user: { id: u.id, email: u.email, name: u.name, role: u.role } } };
  },

  /* ── Восстановление пароля по коду из письма ────────────────────
     Шаг 1: попросить код. Ответ всегда одинаковый — по нему нельзя
     узнать, есть ли такой аккаунт. Код уходит письмом через Resend. */
  'POST /api/password/forgot': async (req, body) => {
    if (!rateLimit(req, 'pwf', 5, 60000)) return tooOften;
    const email = String(body.email || '').trim().toLowerCase();
    if (email.length > EMAIL_MAX || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { status: 400, body: { error: 'Некорректный email' } };

    /* Ответ ОДИН И ТОТ ЖЕ во всех случаях: есть аккаунт или нет, ушло
       письмо или нет, сработал лимит или нет. Иначе страница входа
       превращается в справочник «кто здесь зарегистрирован».
       Поэтому же письмо отправляется ФОНОМ, без await: ожидание ответа
       Resend (сотни миллисекунд) выдавало бы существование аккаунта
       одним лишь временем ответа. Ошибку отправки узнает владелец
       тревогой, а не посторонний — по секундомеру. */
    const generic = { status: 200, body: { ok: true } };
    const u = q.userByEmail.get(email);
    if (!u || u.is_blocked) return generic;

    const iss = pwIssue(email);
    if (!iss.code) return generic;          /* пауза, потолок или минута ожидания */

    /* Ссылка на страницу показа кода. Работает только если сервер виден
       снаружи: без PUBLIC_URL кнопка вела бы в никуда, поэтому письмо
       тогда честно печатает код внутри себя, как раньше. */
    const linkUrl = PW_LINK_ON ? PUBLIC_URL + '/r/' + iss.token : '';

    const send = sendCodeEmail({
      to: email, code: iss.code, kind: 'reset', minutes: 10, linkUrl,
    })
      .then((r) => {
        if (r.ok) { if (!MAIL_DEBUG) pwCommit(email, iss.code, iss.token); return; }
        /* Письмо не ушло — код НЕ закрепляем: прежний, если он был, жив,
           и часовой лимит не сгорел. */
        if (r.dryRun) {
          console.error('[почта] Восстановление пароля не работает: RESEND_API_KEY не задан.');
          tgAlert('mail:off', '📪 Почта не настроена\n\nЧеловек просит код для входа, а RESEND_API_KEY'
            + ' в server/.env пуст — письмо не отправлено. Восстановление пароля не работает.', 'server', true);
        } else {
          tgAlert('mail:fail:' + String(r.error || '').slice(0, 60),
            '📪 Письмо с кодом не отправилось\n\nПричина: ' + String(r.error || 'неизвестна').slice(0, 300)
            + '\nЧеловек не может восстановить пароль.', 'server');
        }
      })
      .catch((e) => { console.error('[почта]', (e && e.message) || e); });

    /* В отладке ждём отправки и возвращаем код — этим режимом пользуются
       только тесты и локальная разработка, там утечка времени не важна. */
    if (MAIL_DEBUG) {
      await send; pwCommit(email, iss.code, iss.token);
      return { status: 200, body: { ok: true, devCode: iss.code, devLink: linkUrl } };
    }
    return generic;
  },

  /* Показать код по метке из письма.
     Нарочно POST, а не GET: почтовые сканеры и «предпросмотр ссылки»
     ходят GET-запросами и заранее открыли бы страницу за человека.
     Показ прячется за нажатием кнопки — сканеру до него не добраться. */
  'POST /api/password/reveal': async (req, body) => {
    if (!rateLimit(req, 'pwrv', 20, 60000)) return tooOften;
    const token = String(body.token || '').trim();
    const gone = { status: 404, body: { error: 'Ссылка недействительна или устарела. Запросите код заново.' } };
    if (!/^[a-f0-9]{32}$/i.test(token)) return gone;

    const rec = pwLinks.get(linkKey(token));
    if (!rec || Date.now() > rec.expires) return gone;

    /* Расшифровать может только сама метка из письма: в памяти сервера
       лежит её хеш и шифротекст, ключа там нет. */
    const code = linkOpen(token, rec);
    if (!code) return gone;

    /* Показов немного: человеку хватает одного-двух (перезагрузил
       страницу, вернулся назад). Десятки — признак того, что ссылку
       кому-то передали и её крутят. */
    rec.shown = (rec.shown || 0) + 1;
    if (rec.shown > 10) { pwLinks.delete(linkKey(token)); return gone; }

    /* Отдаём НАСТОЯЩИЙ остаток, а не всегда десять минут: письмо могли
       открыть через восемь минут после запроса, и обещание «код живёт
       ещё 10:00» было бы неправдой — счётчик дотикал бы до нуля, когда
       код уже мёртв. */
    const leftSec = Math.max(0, Math.round((rec.expires - Date.now()) / 1000));
    return { status: 200, body: { ok: true, code, email: rec.email, leftSec } };
  },

  /* Шаг 2 (необязательный): проверить код, не тратя его — чтобы экран
     ввода кода мог подсветить ошибку до запроса нового пароля. */
  'POST /api/password/verify': async (req, body) => {
    if (!rateLimit(req, 'pwv', 20, 60000)) return tooOften;
    const email = String(body.email || '').trim().toLowerCase();
    const code = String(body.code || '').replace(/\D/g, '');
    const v = pwVerify(email, code, false);
    if (v.ok) return { status: 200, body: { ok: true } };
    return { status: 400, body: { error: pwReason(v.reason, v.left), reason: v.reason } };
  },

  /* Шаг 3: проверить код и задать новый пароль. Код тратится, все
     прежние входы сбрасываются, и сразу выдаётся свежая сессия. */
  'POST /api/password/reset': async (req, body) => {
    if (!rateLimit(req, 'pwr', 10, 60000)) return tooOften;
    const email = String(body.email || '').trim().toLowerCase();
    const code = String(body.code || '').replace(/\D/g, '');
    const pass = String(body.password || '');
    if (pass.length < 8) return { status: 400, body: { error: 'Пароль — минимум 8 символов' } };
    if (pass.length > PASS_MAX) return { status: 400, body: { error: 'Слишком длинный пароль — не больше ' + PASS_MAX + ' символов' } };
    /* Сначала проверяем код НЕ тратя его, потом пишем в базу одной
       транзакцией, и только после успешной записи гасим код. Иначе
       падение на середине (например, база только для чтения) оставляло
       бы человека и без старого пароля, и без кода — с потраченным
       кодом и нетронутым паролем.

       Между проверкой и тратой нет ни одного await: node:sqlite пишет
       синхронно, поэтому второй запрос не может вклиниться и пройти по
       тому же коду. */
    const v = pwVerify(email, code, false);
    if (!v.ok) return { status: 400, body: { error: pwReason(v.reason, v.left), reason: v.reason } };
    const u = q.userByEmail.get(email);
    if (!u) return { status: 400, body: { error: 'Код недействителен' } };
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = scrypt(pass, salt);
    const token = newToken();
    const exp = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
    db.exec('BEGIN IMMEDIATE');
    try {
      q.updPass.run(salt, hash, u.id);
      q.delUserSessions.run(u.id);
      q.insSession.run(token, u.id, exp);
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch (_) { /* нечего откатывать */ }
      throw e;                                  /* наверх: 500 и тревога */
    }
    pwVerify(email, code, true);                /* код потрачен — пароль уже сменён */
    loginMiss.delete(email);                    /* пауза входа паролем снята: человек доказал почту */
    return { status: 200, body: { ok: true, token, user: { id: u.id, email: u.email, name: u.name, role: u.role } } };
  },

  /* Вход из мини-аппа. Пароль не нужен: личность подтверждает Телеграм,
     а подпись проверяется выше. Если человек уже заходил по email —
     привязываем телеграм к тому же аккаунту, а не заводим второй. */
  /* ── Вход через Google ──
     Три шага: приложение просит ссылку (start), человек входит у Google,
     Google возвращает его на callback — там мы заводим или находим
     аккаунт и кладём готовую сессию под метку. Приложение забирает её
     (claim) по метке или по коду со страницы возврата. */
  /* Какие способы входа настроены на сервере. Нужно интерфейсу: кнопку,
     за которой нет ключей, лучше не показывать вовсе, чем показывать и
     отвечать «не настроено» после нажатия. */
  /* ── Способы входа в ЭТОТ аккаунт ──
     Человеку надо видеть, чем он войдёт со второго устройства, и добавить
     недостающее. Отдаём только своё и без лишнего. */
  'GET /api/account/methods': async (req) => {
    const u = auth(req);
    if (!u) return { status: 401, body: { error: 'Нужен вход' } };
    const temp = isServiceEmail(u.email);
    return {
      status: 200,
      body: {
        /* Служебная почта — не почта: войти по ней нельзя, пароля нет. */
        email: temp ? '' : String(u.email || ''),
        needsEmail: temp,
        /* свой пароль есть? нет (вход был Google/Телеграмом) — «Настройки»
           предложат «Задать пароль» без «текущего» */
        hasPassword: hasOwnPass(u),
        telegram: !!u.tg_id,
        google: !!u.google_sub,
        canTelegram: !!(BOT_TOKEN && TG_BOT_ID),
        presence: !u.presence_off,
      },
    };
  },

  /* ── Имя ──
     Правит его профиль. Отдельной ручкой, потому что имя лежит в таблице
     users, а профиль ездит конвертами и до неё не доставал. */
  'POST /api/account/name': async (req, body) => {
    const u = auth(req);
    if (!u) return { status: 401, body: { error: 'Нужен вход' } };
    if (!rateLimit(req, 'accname', 30, 60000)) return tooOften;
    const name = String(body.name || '').trim().slice(0, 120);
    if (!name) return { status: 400, body: { error: 'Введите имя' } };
    if (name === String(u.name || '')) return { status: 200, body: { ok: true, name } };
    try { q.updName.run(name, u.id); }
    catch (e) { return { status: 500, body: { error: 'Не вышло сохранить имя' } }; }
    return { status: 200, body: { ok: true, name } };
  },

  /* ── Задать почту и пароль ──
     Только для аккаунта со служебной почтой (заведён входом через
     Телеграм). После этого человек входит той же почтой с компьютера и
     попадает в ТОТ ЖЕ аккаунт, а не заводит второй кошелёк. */
  'POST /api/account/email': async (req, body) => {
    const u = auth(req);
    if (!u) return { status: 401, body: { error: 'Нужен вход' } };
    if (!rateLimit(req, 'accmail', 10, 60000)) return tooOften;
    /* служебная почта — и Телеграма, и Google без почты: без настоящей
       не дойдёт код вывода (need_email в /api/withdraw, 16.10.2026) */
    if (!isServiceEmail(u.email)) {
      return { status: 400, body: { error: 'У аккаунта уже есть почта' } };
    }
    const email = String(body.email || '').trim().toLowerCase();
    const pass = String(body.password || '');
    if (email.length > EMAIL_MAX) return { status: 400, body: { error: 'Слишком длинный адрес почты' } };
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { status: 400, body: { error: 'Некорректный email' } };
    if (isServiceEmail(email)) {
      return { status: 400, body: { error: 'Это служебный адрес — укажите свою настоящую почту' } };
    }
    if (pass.length < 8) return { status: 400, body: { error: 'Пароль — минимум 8 символов' } };
    if (pass.length > PASS_MAX) return { status: 400, body: { error: 'Слишком длинный пароль — не больше ' + PASS_MAX + ' символов' } };
    /* АДРЕС ВЛАДЕЛЬЦА ЗАНИМАЕТ ТОЛЬКО ВЛАДЕЛЕЦ.
       Аккаунт с почтой из ADMIN_EMAIL получает права на всю площадку
       (syncAdminFlag). Адрес этот не секрет — он стоит в политике и в
       письмах, — а почту здесь никто не подтверждает. Значит, пока
       такого аккаунта в базе нет, занять адрес мог посторонний и забрать
       площадку себе: чужие балансы, паспорта, реестр выплат, вход в
       любой аккаунт. Требуем ключ: у владельца он есть. */
    if (ADMIN_EMAILS.includes(email) && !isAdmin(req)) {
      return { status: 403, body: { error: 'Этот адрес принадлежит владельцу площадки — занять его можно только с ключом владельца' } };
    }
    if (q.userByEmail.get(email)) return { status: 409, body: { error: 'Этот email уже зарегистрирован' } };
    const salt = crypto.randomBytes(16).toString('hex');
    try {
      q.updEmail.run(email, u.id);
      q.updPass.run(salt, scrypt(pass, salt), u.id);
    } catch (e) {
      return { status: 409, body: { error: 'Этот email уже зарегистрирован' } };
    }
    return { status: 200, body: { ok: true, email } };
  },

  'GET /api/auth/methods': async () => ({
    status: 200,
    body: {
      google: !!(OAUTH.youtube.id && OAUTH.youtube.secret),
      /* Телеграму хватает токена бота и домена, прописанного в BotFather:
         подпись ответа проверяется ключом SHA256 от токена. */
      telegram: !!(BOT_TOKEN && TG_BOT_ID),
    },
  }),

  'GET /api/auth/google/start': async (req, body, url) => {
    if (!rateLimit(req, 'glogin', 20, 60000)) return tooOften;
    const cfg = OAUTH.youtube;      /* тот же клиент Google, что и у подтверждения канала */
    if (!cfg.id || !cfg.secret) {
      return { status: 503, body: { error: 'Вход через Google ещё не настроен: на сервере нет ключей Google' } };
    }
    glogSweep();
    const role = url.searchParams.get('role') === 'advertiser' ? 'advertiser' : 'blogger';
    /* pk — секрет выдачи: только приложению и в куку этого браузера (см.
       «ВХОД ПРИВЯЗАН К БРАУЗЕРУ»). В ссылку Google идёт лишь метка. */
    const { nonce, pk } = loginNew(glog, { role });
    const q1 = new URLSearchParams({
      response_type: 'code',
      client_id: cfg.id,
      redirect_uri: OAUTH_BASE + '/api/auth/google/callback',
      /* просим только то, что нужно для входа: кто это и как зовут */
      scope: 'openid email profile',
      state: nonce,
      access_type: 'online',
      /* пусть человек сам выберет, каким аккаунтом входит */
      prompt: 'select_account',
    });
    return { status: 200, body: { url: 'https://accounts.google.com/o/oauth2/v2/auth?' + q1.toString(), nonce, pk },
      headers: { 'Set-Cookie': loginCookie(req, nonce, pk) } };
  },

  /* Приложение спрашивает: вход уже случился? Сессию отдаём только тому,
     кто знает секрет pk (начавшему вход), и только если возврат от Google
     пришёл в ТОТ ЖЕ браузер; иначе — state 'code'. Приложение шлёт POST
     (секрет в теле, не в адресе); GET с ?pk= оставлен для совместимости. */
  'POST /api/auth/google/pending': async (req, body) => {
    if (!rateLimit(req, 'glogpend', 120, 60000)) return tooOften;
    return loginPending(glog, body.nonce, body.pk);
  },
  'GET /api/auth/google/pending': async (req, body, url) => {
    if (!rateLimit(req, 'glogpend', 120, 60000)) return tooOften;
    return loginPending(glog, url.searchParams.get('nonce'), url.searchParams.get('pk'));
  },

  /* Возврат из другого браузера: человек видит код на странице возврата
     и вводит его в приложении.
     Код сверяем ТОЛЬКО с той меткой, которую это же приложение получило
     в начале входа. Раньше код искали по всем ожидающим входам сразу —
     и шесть цифр можно было подбирать вслепую, без метки, получая чужую
     готовую сессию: чем больше людей входит одновременно, тем выше шанс
     попасть. Теперь без своей метки код бесполезен, а пять ошибок её
     сжигают — тот же порядок, что и в подтверждении канала. */
  'POST /api/auth/google/claim': async (req, body) => {
    if (!rateLimit(req, 'glogclaim', 30, 60000)) return tooOften;
    return loginClaim(glog, body);
  },

  /* ── Вход через Телеграм в браузере ──
     Те же три шага, что и у Google: приложение просит ссылку, человек
     подтверждает вход у Телеграма, тот возвращает его на наш адрес — там
     мы меняем код на id_token, заводим или находим аккаунт и кладём
     готовую сессию под метку. */
  'GET /api/auth/telegram/start': async (req, body, url) => {
    if (!rateLimit(req, 'tglogin', 20, 60000)) return tooOften;
    if (!BOT_TOKEN || !TG_BOT_ID) {
      return { status: 503, body: { error: 'Вход через Телеграм ещё не настроен: на сервере нет токена бота' } };
    }
    glogSweep();
    const role = url.searchParams.get('role') === 'advertiser' ? 'advertiser' : 'blogger';
    /* Привязка, а не вход: человек уже внутри и добавляет Телеграм как
       второй способ попасть в ЭТОТ аккаунт. Метка помнит, к кому
       привязывать; без входа привязывать не к кому. Сама привязка — не на
       возврате, а по POST /api/auth/telegram/link-confirm от этого же
       аккаунта с секретом pk (и кодом, если возврат был в другом браузере). */
    let linkUser = null;
    if (url.searchParams.get('link') === '1') {
      const me = auth(req);
      if (!me) return { status: 401, body: { error: 'Нужен вход' } };
      linkUser = me.id;
    }
    const { nonce, pk } = loginNew(tglog, { role, linkUser });
    /* origin обязан совпадать с доменом, прописанным у бота в BotFather,
       иначе Телеграм откажет. return_to — куда вернуть человека. */
    const q1 = new URLSearchParams({
      bot_id: TG_BOT_ID,
      origin: OAUTH_BASE,
      embed: '0',
      request_access: 'write',
      return_to: OAUTH_BASE + '/api/auth/telegram/callback?n=' + nonce,
    });
    return { status: 200, body: { url: TG_WIDGET_AUTH + '?' + q1.toString(), nonce, pk },
      headers: { 'Set-Cookie': loginCookie(req, nonce, pk) } };
  },

  /* Как у Google: только с секретом pk и только при возврате в тот же
     браузер. Привязка сессию не выдаёт — отвечает link:true, и приложение
     подтверждает её через link-confirm. */
  'POST /api/auth/telegram/pending': async (req, body) => {
    if (!rateLimit(req, 'tglogpend', 120, 60000)) return tooOften;
    return loginPending(tglog, body.nonce, body.pk);
  },
  'GET /api/auth/telegram/pending': async (req, body, url) => {
    if (!rateLimit(req, 'tglogpend', 120, 60000)) return tooOften;
    return loginPending(tglog, url.searchParams.get('nonce'), url.searchParams.get('pk'));
  },

  /* Возврат открылся в другом браузере: код со страницы возврата.
     Как и у Google, код сверяется ТОЛЬКО со своей меткой и секретом. */
  'POST /api/auth/telegram/claim': async (req, body) => {
    if (!rateLimit(req, 'tglogclaim', 30, 60000)) return tooOften;
    return loginClaim(tglog, body);
  },

  /* Привязка Телеграма — только отсюда: тот же аккаунт, что начинал
     (Bearer), тот же секрет pk, и если Телеграм подтвердили в другом
     браузере — код с той страницы. Раньше привязка делалась прямо на
     возврате, и чужой Телеграм по присланной ссылке прирастал к аккаунту
     злоумышленника (жертва потом входила из бота в ЕГО кабинет). */
  'POST /api/auth/telegram/link-confirm': async (req, body) => {
    if (!rateLimit(req, 'tglogclaim', 30, 60000)) return tooOften;
    const me = auth(req);
    if (!me) return { status: 401, body: { error: 'Нужен вход' } };
    const nonce = String(body.nonce || '').slice(0, 64);
    const rec = tglog.get(nonce);
    if (!rec || !rec.linkUser || Number(rec.linkUser) !== Number(me.id) || !loginKeyOk(rec, body.pk)) {
      return { status: 404, body: { error: 'Привязка не найдена — начните заново' } };
    }
    if (Date.now() - rec.at > GLOG_TTL) {
      tglog.delete(nonce);
      return { status: 410, body: { error: 'Ссылка привязки живёт 15 минут — начните заново' } };
    }
    if (!rec.done || !rec.tg) return { status: 200, body: { state: 'waiting' } };
    if (!rec.bound) {
      const bad = loginCodeCheck(tglog, nonce, rec, String(body.code || '').replace(/\D/g, ''));
      if (bad) { bad.body.needCode = true; return bad; }
    }
    tglog.delete(nonce);
    const taken = q.userByTg.get(String(rec.tg.id));
    if (taken && Number(taken.id) !== Number(me.id)) {
      return { status: 409, body: { error: 'Этот Телеграм уже привязан к другому аккаунту BloggerPay' } };
    }
    if (!taken) {
      try { q.linkTg.run(String(rec.tg.id), me.id); }
      catch (e) { return { status: 409, body: { error: 'Не вышло привязать — попробуйте ещё раз через минуту' } }; }
    }
    return { status: 200, body: { state: 'ok', linked: true } };
  },

  'POST /api/auth/telegram': async (req, body) => {
    if (!rateLimit(req, 'tg', 30, 60000)) return tooOften;
    /* Порог давности — наш, не клиентский: иначе перехваченная строка
       initData работает вечно (достаточно прислать maxAgeSec побольше). */
    const check = checkInitData(String(body.initData || ''), 86400);
    if (!check.ok) {
      const noToken = /BOT_TOKEN/.test(check.why);
      return { status: noToken ? 503 : 401, body: { error: check.why } };
    }
    const tg = check.tg;
    const tgId = String(tg.id);

    let u = q.userByTg.get(tgId);

    /* Раньше здесь стояла привязка «по совпадению служебного адреса»:
       если нашёлся аккаунт с почтой tg<id>@telegram.local, телеграм
       привязывался к нему. Такой адрес мог занять кто угодно обычной
       регистрацией — и получал чужой аккаунт вместе с балансом. Связь
       ведём только по telegram-id, который проставляет сам сервер. */

    if (!u) {
      /* Заводим ТОЙ ЖЕ функцией, что и вход через браузер: иначе правила
         заведения аккаунтов разъедутся и один человек получит два счёта. */
      const name = [tg.first_name, tg.last_name].filter(Boolean).join(' ').trim()
        || tg.username || ('Пользователь ' + tgId);
      u = tgAccount(tgId, name, body.role);
      if (!u) return { status: 409, body: { error: 'Не удалось создать аккаунт по Телеграму' } };
    }

    if (u.is_blocked) return { status: 403, body: { error: 'Аккаунт заблокирован' } };

    const token = newToken();
    const exp = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
    q.insSession.run(token, u.id, exp);
    return {
      status: 200,
      body: { token, user: { id: u.id, email: u.email, name: u.name, role: u.role }, telegram: true },
    };
  },

  /* ── «Настройки» (15.10.2026) ──────────────────────────────────────
     Смена пароля вошедшим. Раньше «Сменить пароль» в настройках правило
     только копию в браузере, а вход идёт через сервер — новый пароль не
     работал. Старый пароль сверяем так же, как при входе; пять промахов за
     четверть часа — пауза. После смены гаснут все ДРУГИЕ сессии (этот
     телефон остаётся в аккаунте). */
  'POST /api/password/change': async (req, body) => {
    const u = auth(req);
    if (!u) return { status: 401, body: { error: 'Нужен вход' } };
    if (!rateLimit(req, 'pwchg:' + u.id, 10, 60000)) return tooOften;
    if (isServiceEmail(u.email)) {
      return { status: 400, body: { error: 'У аккаунта ещё нет пароля — сначала задайте почту и пароль', code: 'no_password' } };
    }
    /* Своего пароля нет — вход был через Google или Телеграм, почта
       настоящая (16.10.2026). «Текущий» спрашивать не у чего: пароль
       ЗАДАЁТСЯ. Другие входы не гасим — менять в них нечего. */
    if (!hasOwnPass(u)) {
      const np = String(body.password || '');
      if (np.length < 8) return { status: 400, body: { error: 'Пароль — минимум 8 символов' } };
      if (np.length > PASS_MAX) return { status: 400, body: { error: 'Слишком длинный пароль — не больше ' + PASS_MAX + ' символов' } };
      const salt0 = crypto.randomBytes(16).toString('hex');
      q.updPass.run(salt0, scrypt(np, salt0), u.id);
      pwChgMiss.delete(u.id);
      return { status: 200, body: { ok: true, set: true, email: String(u.email || '') } };
    }
    const now = Date.now();
    const miss = pwChgMiss.get(u.id);
    if (miss && miss.n >= 5 && now - miss.at < 15 * 60000) {
      return { status: 429, body: { error: 'Слишком много попыток — подождите 15 минут' } };
    }
    const old = String(body.old || ''), pass = String(body.password || '');
    /* oldAlt — второй вариант текущего пароля за ту же попытку (аудит
       16.10.2026): приложение кладёт на сервер производную пароля (bpSrvPass),
       но у части аккаунтов пароль лёг как есть. Окно «Пароль» не знает,
       какой из двух здесь, — шлёт оба; промах считается один. */
    const oldAlt = body.oldAlt == null ? '' : String(body.oldAlt).slice(0, 1024);
    if (pass.length < 8) return { status: 400, body: { error: 'Новый пароль — минимум 8 символов' } };
    if (pass.length > PASS_MAX) return { status: 400, body: { error: 'Слишком длинный пароль' } };
    const stored = Buffer.from(String(u.pass_hash || ''));
    const fits = (v) => { const h = Buffer.from(scrypt(v, u.pass_salt)); return h.length === stored.length && crypto.timingSafeEqual(h, stored); };
    const hit = fits(old) ? old : (oldAlt && oldAlt !== old && fits(oldAlt) ? oldAlt : null);
    if (hit === null) {
      const m = miss && now - miss.at < 15 * 60000 ? miss : { n: 0, at: now };
      m.n += 1; m.at = now;
      pwChgMiss.set(u.id, m);
      if (pwChgMiss.size > 5000) pwChgMiss.delete(pwChgMiss.keys().next().value);
      const left = Math.max(0, 5 - m.n);
      return { status: 403, body: { error: left ? 'Текущий пароль не подходит · осталось попыток: ' + left : 'Текущий пароль не подходит — подождите 15 минут', left } };
    }
    if (hit === pass) return { status: 400, body: { error: 'Новый пароль совпадает с текущим' } };
    pwChgMiss.delete(u.id);
    const salt = crypto.randomBytes(16).toString('hex');
    db.exec('BEGIN IMMEDIATE');
    try {
      q.updPass.run(salt, scrypt(pass, salt), u.id);
      q.delOtherSessions.run(u.id, bearerOf(req));
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch (_) { /* нечего откатывать */ }
      throw e;
    }
    return { status: 200, body: { ok: true } };
  },

  /* «Выйти на всех устройствах»: гасим все сессии, кроме этой. */
  'POST /api/logout-all': async (req) => {
    const u = auth(req);
    if (!u) return { status: 401, body: { error: 'Нужен вход' } };
    if (!rateLimit(req, 'logoutall:' + u.id, 10, 60000)) return tooOften;
    const info = q.delOtherSessions.run(u.id, bearerOf(req));
    return { status: 200, body: { ok: true, closed: Number(info.changes || 0) } };
  },

  /* Запрос на удаление аккаунта. Само удаление — у владельца в /admin
     («Удалить данные»: обезличивает, деньги и документы остаются по закону),
     поэтому здесь — честная заявка: тревога владельцу с балансом и строка в
     журнале. Раньше было «с сервера — по письму нам». */
  'POST /api/account/delete-request': async (req, body) => {
    const u = auth(req);
    if (!u) return { status: 401, body: { error: 'Нужен вход' } };
    if (!rateLimit(req, 'delreq:' + u.id, 3, 3600000)) return tooOften;
    const why = String((body && body.why) || '').replace(/\s+/g, ' ').trim().slice(0, 300);
    const b = q.balance.get(u.id) || {};
    try { q.insAdminLog.run('сам человек', 'erase-request', 'user ' + u.id, why || null); } catch (e) { /* журнал — не главное */ }
    tgAlert('erase:req:' + u.id,
      '🗑 Запрос на удаление аккаунта\n\n' + vidWho(u.id)
      + '\nБаланс: ' + (Number(b.available) || 0) + ' ₽, в заморозке: ' + (Number(b.hold) || 0) + ' ₽'
      + (why ? '\nПричина: ' + why : '')
      + '\n\nУдалить данные: ' + PUBLIC_URL + '/admin → Пользователи → человек → «Удалить данные»', 'server', true);
    return { status: 200, body: { ok: true } };
  },

  /* «В сети» для чатов: только да/нет, без времени входа, и только про тех,
     кто САМ писал спрашивающему (написать незнакомцу и следить за ним нельзя)
     и не выключил показ в «Настройках» (users.presence_off). */
  'GET /api/presence': async (req, body, url) => {
    const u = auth(req);
    if (!u) return { status: 401, body: { error: 'Нужен вход' } };
    if (!rateLimit(req, 'presence:' + u.id, 120, 60000)) return tooOften;
    const ids = [...new Set(String(url.searchParams.get('ids') || '').split(',')
      .map((x) => Number(x)).filter((n) => Number.isInteger(n) && n > 0 && n !== u.id))].slice(0, 60);
    const now = Date.now(), rows = {};
    for (const id of ids) {
      if (!q.dmFrom.get(id, u.id)) continue;
      const t = q.userById.get(id);
      if (!t || t.presence_off || t.is_blocked) continue;
      rows[id] = { on: now - (seenAt.get(id) || 0) < PRESENCE_MS };
    }
    return { status: 200, body: { ok: true, rows } };
  },

  /* «Показывать, что я в сети» — переключатель в «Настройках» */
  'POST /api/presence/me': async (req, body) => {
    const u = auth(req);
    if (!u) return { status: 401, body: { error: 'Нужен вход' } };
    if (!rateLimit(req, 'presence:me:' + u.id, 30, 60000)) return tooOften;
    const show = !(body && body.show === false);
    q.presenceSet.run(show ? 0 : 1, u.id);
    return { status: 200, body: { ok: true, show } };
  },

  'POST /api/logout': async (req) => {
    const m = /^Bearer\s+([a-f0-9]{64})$/i.exec(String(req.headers.authorization || ''));
    if (m) q.delSession.run(m[1]);
    return { status: 200, body: { ok: true } };
  },

  'GET /api/me': async (req) => {
    const u = auth(req);
    if (!u) return { status: 401, body: { error: 'Нужен вход' } };
    const b = q.balance.get(u.id);
    return { status: 200, body: { user: { id: u.id, email: u.email, name: u.name, role: u.role }, balance: b } };
  },

  'GET /api/balance': async (req) => {
    const u = auth(req);
    if (!u) return { status: 401, body: { error: 'Нужен вход' } };
    return { status: 200, body: q.balance.get(u.id) };
  },

  'GET /api/ledger': async (req, body, url) => {
    const u = auth(req);
    if (!u) return { status: 401, body: { error: 'Нужен вход' } };
    /* ?bucket=available|hold — одна корзина; ?before=<id> — следующая
       страница; ?limit= — до 200 (по умолчанию 100, как раньше). more —
       есть ли строки старше; totals — итоги по всему журналу. */
    const bucket = ['available', 'hold'].includes(url.searchParams.get('bucket')) ? url.searchParams.get('bucket') : '';
    const before = Math.max(0, Math.floor(Number(url.searchParams.get('before')) || 0));
    const limit = Math.min(200, Math.max(1, Math.floor(Number(url.searchParams.get('limit')) || 100)));
    const rows = q.myLedger.all(u.id, bucket, bucket, before, before, limit + 1);
    const more = rows.length > limit;
    if (more) rows.length = limit;
    for (const r of rows) { if (r.camp == null) delete r.camp; else r.camp = String(r.camp).slice(0, 120); }
    const t = q.myLedgerTotals.get(u.id);
    return { status: 200, body: { rows, more, totals: { topup: Number(t.topup) || 0, earned: Number(t.earned) || 0 } } };
  },

  /* ТЕСТОВОЕ пополнение. Живо только пока не настроена касса (и его
     можно выключить руками: TEST_TOPUP=0). На боевом сервере кнопки,
     рисующей деньги, быть не должно. */
  'POST /api/topup': async (req, body) => {
    /* лимит частоты, как у настоящей кассы: печать денег циклом не нужна никому */
    if (!rateLimit(req, 'topup', 20, 60000)) return tooOften;
    const u = auth(req);
    if (!u) return { status: 401, body: { error: 'Нужен вход' } };
    if (!TEST_TOPUP) {
      return { status: 503, body: { error: 'Тестовое пополнение выключено — оплата идёт через кассу' } };
    }
    /* На публичном сервере деньги из воздуха доступны только владельцу. */
    if (!testTopupAllowed(req, u)) {
      return { status: 403, body: { error: 'Пополнение пока недоступно — касса ещё не подключена' } };
    }
    const amount = body.amount;
    if (!amountOk(amount)) return { status: 400, body: { error: 'Сумма — целое число от 1 до 100 000 000' } };
    if (!userKey(body.opKey)) return badKey;
    const fee = pctOf(amount, TOPUP_FEE_PCT);
    return moneyOp(String(body.opKey || ''), u.id, 'topup', (add) => {
      add(u.id, 'available', amount, 'topup', TEST_TOPUP_REF + (fee > 0 ? ' · оплачено ' + (amount + fee) + ', комиссия ' + fee : ''));
      if (fee > 0) add(0, 'available', fee, 'topup-fee', TEST_TOPUP_FEE_REF);
      return { ok: true, amount, fee, total: amount + fee, balance: q.balance.get(u.id) };
    });
  },

  /* Пополнение по счёту: заявка → чат с ботом → счёт → зачисление
     владельцем (/admin → «Счета»). Денег здесь не двигаем. */
  'POST /api/topup/invoice': async (req, body) => {
    if (!rateLimit(req, 'invoice', 6, 60000)) return tooOften;
    const u = auth(req);
    if (!u) return { status: 401, body: { error: 'Нужен вход' } };
    const amount = body.amount;
    if (!Number.isInteger(amount) || amount < INV_MIN || amount > 100000000) {
      return { status: 400, body: { error: 'Сумма по счёту — от ' + rubTxt(INV_MIN) + ', целым числом' } };
    }
    const company = String(body.company || '').trim().replace(/\s+/g, ' ').slice(0, 160);
    if (company.length < 2) return { status: 400, body: { error: 'Укажите компанию или ИП' } };
    const inn = String(body.inn || '').replace(/\D/g, '');
    if (!innOk(inn)) return { status: 400, body: { error: 'ИНН — 10 цифр у компании или 12 у ИП; проверьте цифры' } };
    const email = String(body.email || u.email || '').trim().slice(0, 160);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { status: 400, body: { error: 'Проверьте почту для счёта' } };
    const comment = String(body.comment || '').trim().replace(/\s+/g, ' ').slice(0, 500);
    if (qi.openByUser.get(u.id).n >= 5) {
      return { status: 429, body: { error: 'Открытых заявок уже пять — дождитесь ответа менеджера или закройте старые' } };
    }
    const code = crypto.randomBytes(6).toString('hex');
    const info = qi.ins.run(u.id, code, amount, company, inn, email || null, comment || null);
    const id = Number(info.lastInsertRowid);
    if (ALERTS_ON) {
      tgSendTo(ADMIN_CHAT_ID, '🧾 Заявка на пополнение по счёту №' + id + '\n\n' + rubTxt(amount) + ' на баланс · счёт на '
        + rubTxt(amount + pctOf(amount, TOPUP_FEE_PCT)) + ' (комиссия ' + TOPUP_FEE_PCT + '%)\n' + company + ' · ИНН ' + inn
        + '\n' + (email || u.email) + (comment ? '\n«' + comment + '»' : '')
        + '\n\nКлиент откроет чат с ботом — его сообщения придут сюда. Зачислить после оплаты: админ-панель → Счета.', 'счёт');
    }
    /* заявку создаёт сам человек, а не владелец: adminWho() у обычного
       аккаунта отвечал «ключ» (аудит 16.10.2026) */
    try { q.insAdminLog.run('сам человек', 'inv-new', 'user ' + u.id, 'счёт №' + id + ' · ' + amount + ' ₽'); } catch (e) { /* журнал — не главное */ }
    const bot = (BOT && typeof BOT.botName === 'function' && BOT.botName()) || String(ENV.BOT_USERNAME || '').replace(/^@/, '') || 'BloggerPay_bot';
    const fee = pctOf(amount, TOPUP_FEE_PCT);
    return { status: 200, body: { ok: true, id, code, amount, fee, total: amount + fee, feePct: TOPUP_FEE_PCT, bot, min: INV_MIN } };
  },

  /* «Написать в поддержку» (15.10.2026): метка на сутки — по ней бот
     узнаёт, чей это вопрос, и владелец видит имя, почту и баланс. */
  'POST /api/support/start': async (req) => {
    const u = auth(req);
    if (!u) return { status: 401, body: { error: 'Нужен вход' } };
    if (!rateLimit(req, 'support:' + u.id, 10, 3600000)) return tooOften;
    if (!BOT_TOKEN) return { status: 503, body: { error: 'Поддержка в Телеграме сейчас недоступна', code: 'no_bot' } };
    const now = Date.now();
    try { qsup.codeGc.run(now - SUP_CODE_MS); } catch (e) { /* старые метки — не главное */ }
    const code = crypto.randomBytes(6).toString('hex');
    qsup.codePut.run(code, u.id, now);
    const bot = (BOT && typeof BOT.botName === 'function' && BOT.botName()) || String(ENV.BOT_USERNAME || '').replace(/^@/, '') || 'BloggerPay_bot';
    return { status: 200, body: { ok: true, code, bot, url: 'https://t.me/' + bot + '?start=sup_' + code } };
  },

  /* Имя бота для сайта (15.10.2026): открытый во встроенном браузере
     Телеграма сайт предлагает перейти в мини-приложение — ссылкой на бота. */
  'GET /api/tg/bot': async (req) => {
    if (!rateLimit(req, 'tgbot', 30, 60000)) return tooOften;
    const bot = (BOT && typeof BOT.botName === 'function' && BOT.botName()) || String(ENV.BOT_USERNAME || '').replace(/^@/, '') || '';
    return { status: 200, body: { bot: /^[A-Za-z0-9_]{5,64}$/.test(bot) ? bot : '' } };
  },

  'GET /api/topup/invoices': async (req) => {
    const u = auth(req);
    if (!u) return { status: 401, body: { error: 'Нужен вход' } };
    const bot = (BOT && typeof BOT.botName === 'function' && BOT.botName()) || String(ENV.BOT_USERNAME || '').replace(/^@/, '') || 'BloggerPay_bot';
    const rows = qi.mine.all(u.id).map((r) => {
      const open = r.status === 'new' || r.status === 'linked';
      return { id: r.id, amount: r.amount, fee: pctOf(r.amount, TOPUP_FEE_PCT), total: r.amount + pctOf(r.amount, TOPUP_FEE_PCT),
        company: r.company, inn: r.inn, status: r.status, paid: r.paid, note: r.note,
        tg: !!r.tg, created_at: r.created_at, updated_at: r.updated_at, code: open ? r.code : undefined };
    });
    return { status: 200, body: { rows, bot, min: INV_MIN } };
  },

  /* ── НАСТОЯЩИЕ ПЛАТЕЖИ (ЮKassa) ──────────────────────────────────
     Схема: создать платёж → человек платит на странице кассы → касса
     бьёт вебхуком ИЛИ приложение само спрашивает статус → зачисление
     через журнал. Обе дороги идемпотентны (op_key = yk:<id>). */

  'GET /api/pay/config': async (req) => {
    const u = auth(req);
    const test = testTopupAllowed(req, u);
    return {
      status: 200,
      body: { mode: YK_ON ? 'yookassa' : (test ? 'test' : 'off'), min: 1000,
        /* вывод закрыт, пока на боевом адресе пополнение тестовое (аудит 16.10.2026) */
        withdrawOpen: !TEST_MONEY_PUBLIC,
        /* комиссии — приложению для честного «к оплате / на баланс» (14.10.2026) */
        topupFeePct: TOPUP_FEE_PCT, taskFeePct: TASK_FEE_PCT, payoutFeePct: PAYOUT_FEE_PCT, withdrawFeePct: FEE_PCT },
    };
  },

  'POST /api/pay/create': async (req, body) => {
    if (!rateLimit(req, 'pay', 10, 60000)) return tooOften;
    const u = auth(req);
    if (!u) return { status: 401, body: { error: 'Нужен вход' } };
    if (!YK_ON) return { status: 503, body: { error: 'Касса ещё не настроена: в server/.env нет ключей ЮKassa' } };
    const amount = body.amount;
    if (!amountOk(amount) || amount < 1000) {
      return { status: 400, body: { error: 'Сумма пополнения — целое число от 1 000 ₽' } };
    }
    /* сумма — сколько придёт на баланс; к оплате — сумма + комиссия 7% */
    const fee = pctOf(amount, TOPUP_FEE_PCT);
    try {
      const p = await ykApi('POST', '/payments', {
        amount: { value: (amount + fee).toFixed(2), currency: 'RUB' },
        capture: true,
        confirmation: { type: 'redirect', return_url: PAY_RETURN_URL },
        description: 'Пополнение баланса BloggerPay на ' + amount + ' ₽ (комиссия ' + fee + ' ₽), аккаунт ' + u.id,
        metadata: { userId: u.id, credit: amount, fee },
      }, crypto.randomUUID());
      try { q.insPay.run(p.id, u.id, amount, p.status || 'pending'); q.payFee.run(fee, p.id); } catch (e) { /* повтор — не критично */ }
      const url = p.confirmation && p.confirmation.confirmation_url;
      if (!url) return { status: 502, body: { error: 'Касса не вернула страницу оплаты' } };
      return { status: 200, body: { ok: true, paymentId: p.id, url, amount, fee, total: amount + fee } };
    } catch (e) {
      return { status: e.httpStatus || 502, body: { error: String(e.message || 'Касса недоступна') } };
    }
  },

  /* Статус платежа спрашивает сам плательщик. Если касса говорит
     «оплачен» — зачисляем прямо здесь: вебхук может быть ещё не
     настроен или потеряться, а деньги дойти обязаны. */
  'GET /api/pay/status': async (req, body, url) => {
    /* Каждый такой запрос идёт к кассе. Без ограничителя один человек
       превращал наш сервер в усилитель запросов к ЮKassa — ровно то,
       от чего защищён соседний вебхук. */
    if (!rateLimit(req, 'paystatus', 30, 60000)) return tooOften;
    const u = auth(req);
    if (!u) return { status: 401, body: { error: 'Нужен вход' } };
    const id = String(url.searchParams.get('id') || '').slice(0, 80);
    const row = q.payById.get(id);
    if (!row || row.user_id !== u.id) return { status: 404, body: { error: 'Платёж не найден' } };
    if (row.status === 'succeeded') return { status: 200, body: { status: 'succeeded', credited: true } };
    if (!YK_ON) return { status: 200, body: { status: row.status, credited: false } };
    try {
      const p = await ykApi('GET', '/payments/' + encodeURIComponent(id), null, null);
      if (p.status === 'succeeded') {
        const r = creditYkPayment(p);
        /* «succeeded» отдаём ТОЛЬКО когда деньги реально в журнале: иначе
           клиент перестанет опрашивать, а зачисление так и не случится. */
        if (r.ok) return { status: 200, body: { status: 'succeeded', credited: true, balance: q.balance.get(u.id) } };
        return { status: 200, body: { status: 'processing', credited: false } };
      }
      if (p.status !== row.status) { try { q.updPay.run(p.status, id); } catch (e) {} }
      return { status: 200, body: { status: p.status, credited: false } };
    } catch (e) {
      return { status: 200, body: { status: row.status, credited: false, offline: true } };
    }
  },

  /* Вебхук кассы. Телу не верим ни на грош: берём только id и идём за
     правдой в API кассы. Отвечаем 200 всегда, иначе касса будет долбить
     повторами; повторное зачисление невозможно по построению журнала. */
  'POST /api/pay/webhook': async (req, body) => {
    try {
      /* Аноним не должен превращать вебхук в усилитель наших запросов к
         кассе: больше 30 обращений в минуту молча игнорируем. */
      /* Сначала ограничитель по адресу: шум одного источника не должен
         съедать общий счётчик и вытеснять настоящие уведомления. */
      if (!rateLimit(req, 'wh', 20, 60000)) return { status: 503, body: { error: 'Позже' } };
      const now = Date.now();
      whLog = whLog.filter((t) => now - t < 60000);
      /* 503, а не 200: для кассы 200 означает «доставлено», и повтора не
         будет — платёж потеряется молча. */
      if (whLog.length >= 60) return { status: 503, body: { error: 'Перегрузка, повторите' } };
      whLog.push(now);
      const id = String(body && body.object && body.object.id || '').slice(0, 80);
      if (YK_ON && id) {
        const p = await ykApi('GET', '/payments/' + encodeURIComponent(id), null, null);
        if (p.status === 'succeeded') {
          const r = creditYkPayment(p);
          /* Зачислить не вышло — отвечаем ошибкой, чтобы касса повторила.
             200 для неё значит «доставлено», и второго уведомления не
             будет: оплаченные деньги не дошли бы до человека вовсе. */
          if (!r.ok) return { status: 503, body: { error: 'Зачисление не прошло, повторите' } };
        } else { try { q.updPay.run(p.status, id); } catch (e) {} }
      }
    } catch (e) {
      console.error('[pay/webhook]', e.message || e);
      /* Касса ответила внятно («нет такого платежа», неверные ключи) —
         повторять нечего, отвечаем 200. А вот сбой связи или поломка на
         её стороне значит, что правду о платеже мы не узнали: просим
         повторить уведомление, иначе оплаченные деньги не дойдут. */
      const said = Number(e && e.ykStatus) || 0;
      if (!(said >= 400 && said < 500)) {
        return { status: 503, body: { error: 'Не удалось проверить платёж, повторите' } };
      }
    }
    return { status: 200, body: { ok: true } };
  },

  /* Заморозка под сделку: деньги уходят из available в hold плательщика. */
  'POST /api/deals/hold': async (req, body) => {
    if (!rateLimit(req, 'deal', 60, 60000)) return tooOften;
    const u = auth(req);
    if (!u) return { status: 401, body: { error: 'Нужен вход' } };
    const amount = body.amount;
    const dealId = String(body.dealId || '').slice(0, 80);
    /* ИМЯ СДЕЛКИ ПОД БЮДЖЕТ КАМПАНИИ ЗАНИМАЕТ ТОЛЬКО ЕЁ ХОЗЯИН.
       Эскроу кампании называется camp:<номер>, а номер открыто отдаёт
       витрина заданий (GET /api/tasks/public). Посторонний занимал это
       имя заморозкой в один рубль — и рекламодатель больше не мог
       запустить свою кампанию: сервер отвечал «сделка с таким id уже
       есть». Проверено живьём. Кампания серверу известна: она лежит
       конвертом kind='camp', где a_id — её хозяин. Его и спрашиваем. */
    const asCamp = /^camp:(.+)$/.exec(dealId);
    if (asCamp) {
      const env = q.syncGet.get('camp', asCamp[1]);
      if (env && env.a_id !== u.id) {
        return { status: 403, body: { error: 'Это бюджет чужой кампании' } };
      }
    }
    if (!amountOk(amount)) return { status: 400, body: { error: 'Сумма — целое число от 1 до 100 000 000' } };
    if (!dealId) return { status: 400, body: { error: 'Нужен dealId' } };
    if (q.deal.get(dealId)) return { status: 409, body: { error: 'Сделка с таким id уже есть' } };
    /* Получатель необязателен: заявку можно заморозить и до того, как
       известно, кто её возьмёт. Но если он назван — проверяем, что такой
       есть, иначе позже некому будет платить. */
    let payeeId = null;
    if (body.payeeId != null && body.payeeId !== '') {
      payeeId = Number(body.payeeId);
      if (!q.userById.get(payeeId)) return { status: 404, body: { error: 'Получатель не найден' } };
      if (payeeId === u.id) return { status: 400, body: { error: 'Нельзя назначить получателем себя' } };
    }
    if (!userKey(body.opKey)) return badKey;
    /* задание (camp:<id>): комиссия сервиса 7% сверху бюджета — бюджет целиком
       идёт на выплаты, комиссия списывается отдельной строкой. У обычной
       сделки комиссии нет. Ставки записываем в заморозку: дальше по ним
       считаются пополнения бюджета, выплаты блогерам и возврат остатка. */
    /* предел заданий «в работе» (аудит 16.10.2026) — до заморозки денег:
       иначе бюджет 51-го задания замёрз бы, а само задание никто не увидел */
    if (asCamp && campLiveCount(u.id, asCamp[1]) >= SYNC_CAMP_LIVE) return { status: 409, body: campLimitBody };
    const fee = asCamp ? pctUp(amount, TASK_FEE_PCT) : 0;
    const held = moneyOp(String(body.opKey || ''), u.id, 'hold', (add) => {
      add(u.id, 'available', -amount, 'hold', dealId);
      add(u.id, 'hold', amount, 'hold', dealId);
      if (fee > 0) {
        add(u.id, 'available', -fee, 'task-fee', dealId);
        add(0, 'available', fee, 'task-fee', dealId);
      }
      q.insDeal.run(dealId, u.id, payeeId, amount, 'held');
      if (asCamp) q.setDealFees.run(TASK_FEE_PCT, PAYOUT_FEE_PCT, fee, dealId);
      return { ok: true, dealId, payeeId, fee, feePct: asCamp ? TASK_FEE_PCT : 0, total: amount + fee, balance: q.balance.get(u.id) };
    });
    /* Конверт задания мог лечь раньше заморозки — тогда чужая лента его
       пропустила (без бюджета задание в неё не попадает). Новый ver — и
       лента отдаст его всем при следующем опросе. */
    if (asCamp && held && held.status === 200 && !(held.body && held.body.repeated)) syncBump('camp', asCamp[1]);
    return held;
  },

  /* Выплата по сделке: hold плательщика → available исполнителя.
     Комиссия сделки 0% — вся сумма исполнителю (правило продукта). */
  'POST /api/deals/release': async (req, body) => {
    if (!rateLimit(req, 'deal', 60, 60000)) return tooOften;
    const u = auth(req);
    if (!u) return { status: 401, body: { error: 'Нужен вход' } };
    const dealId = String(body.dealId || '');
    const toUserId = Number(body.toUserId);
    const d = q.deal.get(dealId);
    if (!d) return { status: 404, body: { error: 'Сделка не найдена' } };
    if (d.payer_id !== u.id) return { status: 403, body: { error: 'Выплату подтверждает только плательщик' } };
    if (d.status !== 'held') return { status: 409, body: { error: 'Сделка уже закрыта: ' + d.status } };
    const payee = q.userById.get(toUserId);
    if (!payee) return { status: 404, body: { error: 'Получатель не найден' } };
    if (payee.id === u.id) return { status: 400, body: { error: 'Нельзя выплатить самому себе' } };
    /* Получатель заблокирован владельцем (аудит 16.10.2026): деньги ему не
       уходят ни прибавками за видео (vidSettle), ни ручной выплатой. */
    if (payee.is_blocked) {
      return { status: 409, body: { error: 'Получатель заблокирован — выплата ему закрыта', code: 'payee_blocked' } };
    }
    /* Получателя назвали при заморозке — значит деньги предназначались
       именно ему. Подмена получателя перед выплатой закрыта.
       У бюджета кампании получателя не называют: из него платят многим. */
    if (d.payee_id != null && d.payee_id !== payee.id) {
      return { status: 409, body: { error: 'Деньги заморожены для другого исполнителя' } };
    }
    /* Спор держит деньги и на сервере: пока он открыт, выплату не провести
       ни кнопкой, ни прямым запросом. Снимает замок решение арбитра. */
    if (q.openDisputeFor.get(dealId, payee.id)) {
      return { status: 409, body: { error: 'Идёт спор — выплата заморожена до решения арбитра', dispute: true } };
    }

    /* Сумму можно не указывать — тогда уходит весь остаток. Так работает
       обычная сделка. Для бюджета кампании сумма указывается: из одной
       заморозки платят нескольким блогерам по очереди. */
    const left = d.amount - d.paid;
    let sum = (body.amount == null || body.amount === '') ? left : Number(body.amount);
    if (!Number.isInteger(sum) || sum <= 0) {
      return { status: 400, body: { error: 'Сумма выплаты — целое число больше нуля' } };
    }
    if (sum > left) {
      return { status: 409, body: { error: 'В заморозке осталось ' + left + ' — больше выплатить нельзя' } };
    }
    /* Бюджет кампании держит и загруженные видео: их сервер оплачивает
       сам, прибавками по мере роста просмотров. Ручной выплатой (старый
       путь) рекламодатель мог бы опустошить заморозку раньше — например,
       своему второму аккаунту, — и засчитанное видео стало бы не из чего
       оплатить (возврат бюджета при этом закрыт: videos_live). Держим не
       резерв по нынешним цифрам (сразу после зачёта с 0 просмотров он
       ноль), а будущее обязательство: у ролика с максимумом — максимум
       минус выплаченное, без максимума — весь остаток (см. vidOwed). */
    if (dealId.startsWith('camp:')) {
      const owed = vidOwed(dealId.slice(5));
      if (owed > 0 && sum > left - owed) {
        const free = Math.max(0, left - owed);
        if (!free) {
          return { status: 409, body: {
            error: 'По заданию есть видео на проверке или в подсчёте просмотров — бюджет держится под них, пока подсчёт не закончится',
            code: 'videos_live' } };
        }
        return { status: 409, body: {
          error: 'Часть бюджета держат видео по заданию (' + owed + ' ₽ — до максимума за ролики): вручную можно выплатить не больше '
            + free + ' ₽', code: 'videos_reserved', reserved: owed, free } };
      }
    }

    if (!userKey(body.opKey)) return badKey;
    return moneyOp(String(body.opKey || ''), u.id, 'release', (add) => {
      const done = dealPayMoves(add, d, payee.id, sum);
      return { ok: true, dealId, paid: sum, left: left - sum, closed: done, to: payee.id };
    });
  },

  /* Возврат: hold плательщика → его же available. Никаких «начислить
     тому, кто нажал» — возврат идёт только плательщику. */
  /* ── Спор по сделке: открыть / закрыть ──
     Открыть может плательщик или исполнитель (по своей выплате), закрыть —
     открывший, плательщик или оператор; решение арбитра (/api/deals/settle)
     закрывает само. Пока спор открыт, release и refund отвечают 409. */
  'POST /api/deals/dispute/open': async (req, body) => {
    const u = auth(req);
    if (!u) return { status: 401, body: { error: 'Нужен вход' } };
    if (!rateLimit(req, 'dispute', 20, 60000)) return tooOften;
    const dealId = String(body.dealId || '').slice(0, 120);
    const d = q.deal.get(dealId);
    if (!d) return { status: 404, body: { error: 'Сделка не найдена' } };
    if (d.status !== 'held') return { status: 409, body: { error: 'Сделка уже закрыта: ' + d.status } };
    const payeeId = body.payeeId == null || body.payeeId === '' ? null : Number(body.payeeId);
    if (payeeId != null && !Number.isInteger(payeeId)) return { status: 400, body: { error: 'Неверный исполнитель' } };
    /* Кто вправе: плательщик — по всей сделке; исполнитель — только по
       своей выплате (иначе любой мог бы заморозить чужие деньги). */
    const isPayer = d.payer_id === u.id;
    /* Спор «по себе» доступен любому вошедшему: он замораживает выплату
       только этому человеку, чужих денег не касается. Спор по всей
       сделке — привилегия плательщика. */
    const scope = isPayer ? payeeId : u.id;
    if (!isPayer && scope == null) {
      return { status: 403, body: { error: 'Спор по всей сделке открывает плательщик' } };
    }
    const already = q.openDisputeExact.get(dealId, scope, scope);
    if (already) return { status: 200, body: { ok: true, id: already.id, already: true } };
    const info = q.insDispute.run(dealId, scope, u.id);
    /* Тревогу шлём только по спорам, которые действительно держат деньги:
       иначе посторонний десятком «споров по себе» выжигает часовой лимит
       тревог, и настоящие сообщения до владельца не доходят. */
    const campD = /^camp:/.test(dealId);
    const holds = isPayer || (d.payee_id != null && d.payee_id === u.id) || !!q.paidTo.get(dealId, u.id)
      || (campD && Number((q.vidLiveOf.get(dealId.slice(5), u.id) || {}).n) > 0);
    if (holds) {
      /* бюджет задания: спор одного блогера держит только его начисления,
         возврат автору он не запирает (refundBlocked) */
      /* Подпись — сделка и сторона, а не номер строки (V1, аудит 16.10.2026):
         «открыть → снять → открыть» шло новой тревогой каждый раз (20 в
         минуту) и за минуту выжигало часовой лимит серверных тревог —
         теперь повтор той же стороной не чаще раза в 10 минут. */
      tgAlert('dispute:' + dealId + ':' + (scope == null ? 'all' : scope),
        '⚖️ Открыт спор по сделке ' + dealId + '\n\nОткрыл: ' + u.email
        + (scope != null ? '\nИсполнитель id ' + scope : '')
        + (campD && scope != null ? '\n\nНачисления этому блогеру по заданию стоят до решения.' : '\n\nДеньги заморожены до решения.')
        + '\nСнять или решить: ' + PUBLIC_URL + '/admin → «Спорные деньги»', 'server');
    }
    return { status: 200, body: { ok: true, id: Number(info.lastInsertRowid) } };
  },

  'POST /api/deals/dispute/close': async (req, body) => {
    const u = auth(req);
    /* Оператор приходит сюда одним ключом, без входа в приложение — так
       же, как в /api/deals/settle. Раз спор снимает только тот, кто его
       повесил, оператор обязан иметь эту дверь: иначе пропавший человек
       запирал бы чужие деньги навсегда. */
    const asOperator = isAdmin(req);
    if (!u && !asOperator) return { status: 401, body: { error: 'Нужен вход' } };
    if (!rateLimit(req, 'dispute', 20, 60000)) return tooOften;
    const dealId = String(body.dealId || '').slice(0, 120);
    const d = q.deal.get(dealId);
    if (!d) return { status: 404, body: { error: 'Сделка не найдена' } };
    const payeeId = body.payeeId == null || body.payeeId === '' ? null : Number(body.payeeId);
    /* ЗАМОК СНИМАЕТ ТОЛЬКО ТОТ, КТО ЕГО ПОВЕСИЛ.
       Раньше право давалось и плательщику — то есть ровно той стороне,
       от которой спор и защищает. Проверено живьём: блогер сдал работу
       и открыл спор, рекламодатель одним запросом снял его и вернул
       себе весь эскроу. Оператор снимает любой спор; решение арбитра
       (/api/deals/settle) снимает замок само. */
    if (asOperator) {
      const did = Number(body.id);
      const byId = Number.isInteger(did) && did > 0;
      const infoA = byId ? q.closeDisputeById.run(did, dealId)
        : payeeId == null ? q.closeDisputesAll.run(dealId) : q.closeDisputesFor.run(dealId, payeeId);
      const nA = Number(infoA.changes || 0);
      if (nA) {
        adminLog(req, 'dispute-close', 'сделка ' + dealId, byId ? 'спор №' + did + (payeeId == null ? '' : ', исполнитель id ' + payeeId)
          : payeeId == null ? 'все споры' : 'исполнитель id ' + payeeId);
        /* начисления за видео, которые держал спор, пойдут со следующего круга */
        if (/^camp:/.test(dealId)) vidBoardDrop(dealId.slice(5));
      }
      return { status: 200, body: { ok: true, closed: nA } };
    }
    const info = payeeId == null
      ? q.closeDisputesByOpener.run(dealId, u.id)
      : q.closeDisputesForByOpener.run(dealId, payeeId, u.id);
    const closed = Number(info.changes || 0);
    if (!closed) {
      /* Не сняли ничего: либо спора нет вовсе — это не ошибка, клиент
         повторяет снятие и не должен получать отказ, — либо он чужой. */
      const other = payeeId == null ? q.openDisputeAny.get(dealId) : q.openDisputeExact.get(dealId, payeeId, payeeId);
      if (other) return { status: 403, body: { error: 'Снять спор может только тот, кто его открыл, или оператор' } };
    }
    return { status: 200, body: { ok: true, closed } };
  },

  /* ── Мои выплаты по кампаниям ──
     Расход кампании считается в приложении из местного журнала. На новом
     устройстве журнал пуст, и расход показывался нулём. Отдаём ключи
     операций выплат — приложение восстановит записи. */
  'GET /api/ops/mine': async (req) => {
    const u = auth(req);
    if (!u) return { status: 401, body: { error: 'Нужен вход' } };
    const rows = q.myReleases.all(u.id).concat(q.myVidReleases.all(u.id)).map((r) => {
      let res = {};
      try { res = JSON.parse(r.result || '{}'); } catch (e) { /* пусто */ }
      return { opKey: r.op_key, dealId: res.dealId || null, paid: Number(res.paid) || 0, to: res.to || null, at: r.created_at };
    });
    /* v3: за ролик до ~30 прибавок — по строкам операций журнал на новом
       устройстве упирался в предел, и расход оффера занижался. Итог по
       каждому ролику (выплачено всего) — одной строкой: по нему приложение
       и восстанавливает журнал. */
    const videos = q.myVidPaid.all(u.id).map((v) => ({
      video: v.id, dealId: 'camp:' + v.camp_id, paid: v.paid || 0, to: v.blogger_id, at: v.paid_at || null }));
    return { status: 200, body: { rows, videos } };
  },

  'POST /api/deals/refund': async (req, body) => {
    if (!rateLimit(req, 'deal', 60, 60000)) return tooOften;
    const u = auth(req);
    if (!u) return { status: 401, body: { error: 'Нужен вход' } };
    const dealId = String(body.dealId || '');
    const d = q.deal.get(dealId);
    if (!d) return { status: 404, body: { error: 'Сделка не найдена' } };
    /* Отказ блогера — обычный ход событий, а не исключение: он тоже
       должен уметь вернуть деньги плательщику. Себе он их при этом не
       заберёт — возврат всегда идёт плательщику. */
    const mayRefund = d.payer_id === u.id || (d.payee_id != null && d.payee_id === u.id) || isAdmin(req);
    if (!mayRefund) {
      return { status: 403, body: { error: 'Возврат делает плательщик, исполнитель или оператор' } };
    }
    if (d.status !== 'held') return { status: 409, body: { error: 'Сделка уже закрыта: ' + d.status } };
    if (!isAdmin(req) && q.refundBlocked.get(dealId, d.payee_id, dealId)) {
      return { status: 409, body: { error: 'Идёт спор — возврат заморожен до решения арбитра', dispute: true } };
    }
    /* Часть бюджета задания (11.10.2026, «Вернуть остаток» на странице
       задания): раньше кнопка двигала только числа в браузере, касса о
       возврате не знала. Только хозяин заморозки camp:<id>. Вернуть можно
       свободное — vidReturnable: остаток минус будущие выплаты живым
       роликам (у ролика с максимумом — максимум минус выплаченное, без
       максимума — весь остаток). Заморозка остаётся открытой, бюджет
       задания (amount) уменьшается на вернувшееся. Вернули всё, и живых
       роликов нет — это обычный полный возврат (refunded). */
    if (body.amount != null && body.amount !== '') {
      if (!dealId.startsWith('camp:')) return { status: 400, body: { error: 'Вернуть часть можно только из бюджета задания' } };
      if (d.payer_id !== u.id) return { status: 403, body: { error: 'Вернуть часть бюджета может только автор задания' } };
      const sum = body.amount;
      if (!amountOk(sum)) return { status: 400, body: { error: 'Сумма — целое число от 1 до 100 000 000' } };
      const cid = dealId.slice(5);
      const left = d.amount - d.paid;
      const live = q.vidLive.all(cid).length;
      const free = vidReturnable(cid);
      if (sum > free) {
        /* Текст — по правде (аудит 16.10.2026): «держат видео» — только когда
           живые ролики есть; без них свободен весь остаток, и просили больше
           него; бюджет исчерпан (заморозка открыта с нулём) — вернуть нечего. */
        const noLeft = left <= 0;
        return { status: 409, body: {
          error: noLeft ? 'В бюджете задания не осталось денег — возвращать нечего'
            : !live ? 'В бюджете задания осталось ' + free + ' ₽ — больше вернуть нельзя'
            : free > 0 ? 'Свободно в бюджете задания ' + free + ' ₽ — остальное держат видео на проверке и в подсчёте просмотров'
            : 'Весь остаток бюджета держат видео на проверке и в подсчёте просмотров — вернуть можно, когда подсчёт закончится',
          code: noLeft || !live ? 'no_free' : (free > 0 ? 'videos_reserved' : 'videos_live'), free } };
      }
      if (!userKey(body.opKey)) return badKey;
      const all = sum >= left && !live;
      const rp = moneyOp(String(body.opKey || ''), u.id, 'refund', (add) => {
        add(d.payer_id, 'hold', -sum, 'refund', dealId);
        add(d.payer_id, 'available', sum, 'refund', dealId);
        const feeBack = all ? dealFeeBackAll(add, d) : dealFeeBack(add, d, sum);
        if (all) q.updDeal.run('refunded', d.payee_id, dealId);
        else q.cutDeal.run(sum, dealId);
        vidBoardDrop(cid);
        return { ok: true, dealId, refunded: sum, feeBack, left: left - sum, closed: all };
      });
      /* вернули всё — задание закрыто и в ленте у всех */
      if (rp.status === 200 && rp.body && rp.body.closed) syncCampClose(cid);
      return rp;
    }
    /* Пока по заданию есть ролики на проверке или в подсчёте просмотров
       (засчитанные: 30 дней сервер доначисляет по мере роста), бюджет —
       это их будущие выплаты: вернув его себе, рекламодатель оставил бы
       блогера без денег за загруженную работу. Так же держится и
       «Завершить задание» — оно возвращает остаток этим же запросом.
       Оператор может. Бюджет исчерпан (остаток 0, заморозка задания
       открыта — см. dealPayMoves) — держать нечего: «уже всё выплачено»
       раньше «видео в подсчёте», иначе «Завершить» не проходило бы. */
    /* Возвращаем ОСТАТОК: часть могла уже уйти исполнителям. */
    const rest = d.amount - d.paid;
    if (rest <= 0) return { status: 409, body: { error: 'Из этой заморозки уже всё выплачено' } };
    if (!isAdmin(req) && dealId.startsWith('camp:') && q.vidLive.all(dealId.slice(5)).length) {
      return { status: 409, body: {
        error: 'По заданию есть видео на проверке или в подсчёте просмотров — вернуть бюджет можно, когда подсчёт закончится',
        code: 'videos_live' } };
    }
    if (!userKey(body.opKey)) return badKey;
    const rf = moneyOp(String(body.opKey || ''), u.id, 'refund', (add) => {
      add(d.payer_id, 'hold', -rest, 'refund', dealId);
      add(d.payer_id, 'available', rest, 'refund', dealId);
      const feeBack = dealFeeBackAll(add, d);
      q.updDeal.run('refunded', d.payee_id, dealId);
      /* доска задания держит бюджет минуту — после возврата он другой */
      if (dealId.startsWith('camp:')) vidBoardDrop(dealId.slice(5));
      return { ok: true, dealId, refunded: rest, feeBack };
    });
    /* бюджет задания вернули целиком — задание закрыто и в ленте у всех */
    if (rf.status === 200 && dealId.startsWith('camp:')) syncCampClose(dealId.slice(5));
    return rf;
  },

  /* Пополнение бюджета задания (11.10.2026): кошелёк → заморозка
     camp:<id>, сумма прибавляется к бюджету (amount). Раньше «Пополнить»
     на странице задания двигал только числа в браузере: после
     перезагрузки деньги «возвращались», а местный журнал расходился с
     кассой навсегда. Только хозяин задания и только открытая заморозка
     (запуск задания её создаёт — /api/deals/hold). */
  'POST /api/deals/topup': async (req, body) => {
    if (!rateLimit(req, 'deal', 60, 60000)) return tooOften;
    const u = auth(req);
    if (!u) return { status: 401, body: { error: 'Нужен вход' } };
    const dealId = String(body.dealId || '').slice(0, 80);
    const m = /^camp:(.+)$/.exec(dealId);
    if (!m) return { status: 400, body: { error: 'Пополнить можно только бюджет задания' } };
    const amount = body.amount;
    if (!amountOk(amount)) return { status: 400, body: { error: 'Сумма — целое число от 1 до 100 000 000' } };
    const env = q.syncGet.get('camp', m[1]);
    if (env && env.a_id !== u.id) return { status: 403, body: { error: 'Это бюджет чужой кампании' } };
    const d = q.deal.get(dealId);
    if (!d) return { status: 404, body: { error: 'Бюджет задания ещё не заморожен — сначала запустите задание', code: 'no_deal' } };
    if (d.payer_id !== u.id) return { status: 403, body: { error: 'Это бюджет чужой кампании' } };
    /* Бюджет, закрытый исчерпанием до 16.10.2026 (released, выплачено всё,
       денег в нём 0), пополнение открывает снова — как и открытый с нулём. */
    const reopen = d.status === 'released' && d.paid >= d.amount;
    if (d.status !== 'held' && !reopen) return { status: 409, body: { error: 'Сделка уже закрыта: ' + d.status } };
    if (!userKey(body.opKey)) return badKey;
    const fee = pctUp(amount, d.fee_pct || 0);
    const r = moneyOp(String(body.opKey || ''), u.id, 'hold', (add) => {
      if (reopen && !q.reopenCampDeal.run(dealId).changes) throw httpError(409, 'Сделка уже закрыта: ' + d.status);
      add(u.id, 'available', -amount, 'hold', dealId);
      add(u.id, 'hold', amount, 'hold', dealId);
      if (fee > 0) {
        add(u.id, 'available', -fee, 'task-fee', dealId);
        add(0, 'available', fee, 'task-fee', dealId);
        q.addFeeIn.run(fee, dealId);
      }
      if (!q.growDeal.run(amount, dealId).changes) throw httpError(409, 'Бюджет задания закрыт — пополнить нельзя');
      vidBoardDrop(m[1]);
      return { ok: true, dealId, added: amount, fee, total: amount + fee, budget: d.amount + amount, balance: q.balance.get(u.id) };
    });
    /* В бюджете снова есть деньги — недоплата роликам на паузе «не хватило
       денег» уходит сразу, без владельца и без суток ожидания. Сбой здесь
       пополнение не отменяет: круг доплатит сам (vidSettle). */
    if (r.status === 200) {
      try {
        const res = await vidBudgetResume(m[1]);
        if (!r.body.repeated) r.body.resumed = res;
      } catch (e) { console.error('[видео] доплата после пополнения не прошла:', (e && e.message) || e); }
    }
    return r;
  },

  /* ── РЕШЕНИЕ СПОРА ────────────────────────────────────────────────
     Арбитр делит замороженные деньги между сторонами: доля исполнителю в
     процентах, остальное возвращается плательщику. Одной операцией,
     чтобы деньги не могли зависнуть посередине.

     Раньше это считалось в браузере, и при нехватке в резерве блогеру
     начислялась полная сумма, а разница просто записывалась полем. Здесь
     делится РОВНО то, что лежит в заморозке: больше взять неоткуда.

     Решение принимает оператор (ключ арбитра) — не сторона спора. */
  'POST /api/deals/settle': async (req, body) => {
    if (!isAdmin(req)) return { status: 403, body: { error: 'Решение по спору принимает арбитр' } };
    const dealId = String(body.dealId || '');
    const d = q.deal.get(dealId);
    if (!d) return { status: 404, body: { error: 'Сделка не найдена' } };
    if (d.status !== 'held') return { status: 409, body: { error: 'Сделка уже закрыта: ' + d.status } };

    /* Бюджет задания и спор ОДНОГО блогера (аудит 16.10.2026): арбитр
       решает только его часть — amount ₽ блогеру из свободного остатка
       (vidReturnable: резервы живых роликов не трогаем), его спор
       закрывается, бюджет остаётся открытым для остальных. amount 0 —
       в претензии отказано (спор просто снимается). Раньше «Решить спор»
       по бюджету задания умел только вернуть автору весь остаток и
       закрыть задание всем блогерам. Комиссию с этой суммы не режем —
       это решение арбитра (как у доли исполнителя ниже). */
    if (dealId.startsWith('camp:') && body.payeeId != null && body.payeeId !== '') {
      const pid = Number(body.payeeId);
      const who = Number.isInteger(pid) && pid > 0 ? q.userById.get(pid) : null;
      if (!who) return { status: 400, body: { error: 'Не указан блогер, по чьему спору решение' } };
      if (who.id === d.payer_id) return { status: 400, body: { error: 'Плательщик и исполнитель — один человек' } };
      const award = body.amount == null || body.amount === '' ? 0 : body.amount;
      if (!Number.isInteger(award) || award < 0 || award > 100000000) {
        return { status: 400, body: { error: 'Сумма блогеру — целое число от 0 до 100 000 000' } };
      }
      const cid = dealId.slice(5);
      if (award > 0) {
        const free = vidReturnable(cid);
        if (award > free) {
          return { status: 409, body: { error: 'Свободно в бюджете задания ' + free
            + ' ₽ — остальное держат видео на проверке и в подсчёте просмотров', code: 'no_free', free } };
        }
      }
      if (award === 0) {
        const n = Number(q.closeDisputesFor.run(dealId, who.id).changes || 0);
        if (n) adminLog(req, 'settle', 'сделка ' + dealId, 'спор блогера id ' + who.id + ' снят без выплаты');
        vidBoardDrop(cid);
        return { status: 200, body: { ok: true, dealId, payeeId: who.id, closed: n, исполнителю: 0, плательщику: 0, разделено: 0 } };
      }
      const part = moneyOp(String(body.opKey || ''), d.payer_id, 'settle', (add) => {
        const dd = q.deal.get(dealId);
        if (!dd || dd.status !== 'held') throw httpError(409, 'Сделка уже закрыта');
        if (vidReturnable(cid) < award) throw httpError(409, 'В бюджете задания стало меньше свободных денег — обновите');
        add(dd.payer_id, 'hold', -award, 'settle', dealId);
        add(who.id, 'available', award, 'settle-payout', dealId);
        q.payDeal.run(award, 'held', dealId);
        /* потрачено всё — лишнюю от округления комиссию назад (как dealPayMoves) */
        if (dd.paid + award >= dd.amount && Number(dd.fee_pct) > 0) {
          dealFeeBackAll(add, Object.assign({}, dd, { paid: dd.paid + award }));
        }
        const closed = Number(q.closeDisputesFor.run(dealId, who.id).changes || 0);
        return { ok: true, dealId, payeeId: who.id, closed, исполнителю: award, плательщику: 0, разделено: award,
          left: dd.amount - dd.paid - award };
      });
      if (part.status === 200 && !part.body.repeated) {
        vidBoardDrop(cid);
        adminLog(req, 'settle', 'сделка ' + dealId, 'блогеру id ' + who.id + ' ' + award + ' ₽ из бюджета задания, спор снят');
      }
      return part;
    }

    const share = Number(body.bloggerShare);
    if (!Number.isFinite(share) || share < 0 || share > 100) {
      return { status: 400, body: { error: 'Доля исполнителя — от 0 до 100' } };
    }

    const rest = d.amount - d.paid;
    if (rest <= 0) return { status: 409, body: { error: 'В заморозке ничего не осталось' } };

    /* Кому платить: либо назначенный при заморозке, либо явно указанный. */
    const toId = d.payee_id != null ? d.payee_id : Number(body.toUserId);
    const payee = toId ? q.userById.get(toId) : null;
    if (share > 0 && !payee) {
      return { status: 400, body: { error: 'Не указан исполнитель, которому присуждена доля' } };
    }
    if (payee && payee.id === d.payer_id) {
      return { status: 400, body: { error: 'Плательщик и исполнитель — один человек' } };
    }

    /* Округляем долю исполнителя, остаток отдаём плательщику: так копейки
       не теряются и сумма всегда сходится ровно. */
    const toBlogger = Math.round(rest * share / 100);
    const toPayer = rest - toBlogger;

    if (!isAdmin(req) && !userKey(body.opKey)) return badKey;
    const _settled = moneyOp(String(body.opKey || ''), d.payer_id, 'settle', (add) => {
      add(d.payer_id, 'hold', -rest, 'settle', dealId);
      if (toBlogger > 0) add(payee.id, 'available', toBlogger, 'settle-payout', dealId);
      if (toPayer > 0) add(d.payer_id, 'available', toPayer, 'settle-refund', dealId);
      /* задание с комиссией: заморозка закрывается целиком — плательщику вся
         невыбранная комиссия, кроме % от потраченного (выплаченное + доля
         исполнителя), 14–15.10.2026; доля исполнителя — решение арбитра, её не режем */
      dealFeeBackAll(add, Object.assign({}, d, { paid: d.paid + toBlogger }));
      q.payDeal.run(toBlogger, 'released', dealId);
      if (payee) q.updDeal.run('released', payee.id, dealId);
      q.closeDisputesAll.run(dealId);          /* решение вынесено — замок снят */
      return {
        ok: true, dealId,
        доля_исполнителя: share,
        исполнителю: toBlogger,
        плательщику: toPayer,
        разделено: rest,
      };
    });
    if (_settled.status === 200 && !_settled.body.repeated) {
      adminLog(req, 'settle', 'сделка ' + dealId, 'исполнителю ' + toBlogger + ' ₽, плательщику ' + toPayer + ' ₽ (' + share + '%)');
    }
    return _settled;
  },

  /* Заявка на вывод. Деньги уходят в hold и ЖДУТ ОПЕРАТОРА — статус
     меняет только он. Комиссия считается сразу и видна до подтверждения. */
  'POST /api/withdraw': async (req, body) => {
    if (!rateLimit(req, 'wd', 10, 60000)) return tooOften;
    const u = auth(req);
    if (!u) return { status: 401, body: { error: 'Нужен вход' } };
    /* Пока на боевом адресе тестовое пополнение открыто всем, деньги на
       балансах ненастоящие — наружу они уходить не должны (аудит 16.10.2026).
       Раньше проверки личности: незачем вести человека через верификацию
       к выводу, которого сейчас нет. */
    if (TEST_MONEY_PUBLIC) {
      return { status: 403, body: { error: 'Вывод откроется после запуска оплаты: сейчас пополнение тестовое, деньги на балансах ненастоящие', code: 'test_money' } };
    }
    /* Гейт верификации живёт и на сервере: клиентскую проверку в мини-аппе
       обходят одним fetch, а деньги наружу без проверенной личности
       уходить не должны. */
    const kycRow = q.myLastKyc.get(u.id);
    if (!kycRow || kycRow.status !== 'approved') {
      return { status: 403, body: { error: 'Вывод откроется после проверки личности оператором' } };
    }
    const amount = body.amount;
    const requisites = String(body.requisites || '').trim().slice(0, 200);
    if (!amountOk(amount)) return { status: 400, body: { error: 'Сумма — целое число от 1 до 100 000 000' } };
    /* Тот же минимум, что и на экране: иначе прямым запросом к API можно
       было завести заявку на 100 ₽, которой интерфейс не обещает. */
    if (amount < 1000) return { status: 400, body: { error: 'Минимальный вывод — 1 000 ₽' } };
    if (!requisites) return { status: 400, body: { error: 'Укажите реквизиты' } };
    const fee = Math.round(amount * FEE_PCT / 100);
    const net = amount - fee;

    /* ── Второй фактор ──
       Без кода первый запрос НИЧЕГО НЕ ДВИГАЕТ: только шлёт код на почту.
       Деньги трогает лишь повторный запрос, с кодом.

       Если почта не настроена — пропускаем проверку, а не запираем деньги.
       Запертый вывод хуже: человек не может забрать своё, и виноват в этом
       не он. О пропуске громко сообщаем владельцу. */
    const code = String(body.code || '').replace(/\D/g, '');
    let burned = null;                 /* снятый код: вернём, если заявка не пройдёт */
    if (mailConfigured()) {
      /* Служебная почта (вход через Телеграм / Google без почты) — код
         ушёл бы в никуда, а лимит wdIssueAllowed сгорал бы впустую.
         Просим задать настоящую почту; денег и кодов не трогаем
         (аудит 16.10.2026). Приложение по code открывает «Почту и пароль». */
      if (isServiceEmail(u.email)) {
        return { status: 400, body: { error: 'Сначала укажите почту в Настройках — на неё придёт код вывода', code: 'need_email' } };
      }
      if (!code) {
        if (!wdIssueAllowed(u.id)) {
          return { status: 429, body: { error: 'Код запрашивали слишком часто — попробуйте через час' } };
        }
        const fresh = wdIssue(u.id, amount, requisites);
        const r = await sendCodeEmail({ to: u.email, code: fresh, kind: 'withdraw', minutes: 10 });
        /* Письмо не ушло — код гасим и денег не трогаем. Оставить заявку
           «ждущей кода», которого человек не получит, значит запереть его
           деньги молча. В отладке письма нет по определению — там не беда. */
        if (!r.ok && !r.dryRun && !MAIL_DEBUG) {
          wdCodes.delete(u.id);
          return { status: 502, body: { error: 'Не удалось отправить код на почту. Попробуйте позже.' } };
        }
        const out = { needCode: true, sentTo: maskEmail(u.email), amount, fee, net };
        /* Тот же отладочный режим, что и у восстановления пароля: код
           возвращается в ответе, чтобы проверять поток без живой почты.
           На бою MAIL_DEBUG обязан быть выключен — сервер про это кричит
           при запуске. */
        if (MAIL_DEBUG) out.devCode = fresh;
        return { status: 200, body: out };
      }
      const chk = wdCheck(u.id, code, amount, requisites);
      if (!chk.ok) return { status: 400, body: { error: chk.why, needCode: true, dead: !!chk.dead } };
      /* Гасим СИНХРОННО, до первого await: иначе соседний запрос с тем же
         кодом успевал пройти проверку, пока этот ждал базу, и по одному
         коду создавалось несколько заявок. Если заявка не пройдёт — код
         вернём на место чуть ниже, человек ничего не заметит. */
      burned = wdCodes.get(u.id) || null;
      wdBurn(u.id);
    } else {
      tgAlert('wd:no2fa', '⚠️ Вывод без второго фактора\n\nПочта не настроена'
        + ' (RESEND_API_KEY пуст), поэтому заявка на вывод прошла без кода'
        + ' подтверждения. Настройте почту — иначе украденная сессия выводит деньги'
        + ' без единой преграды.', 'server');
    }

    if (!userKey(body.opKey)) { if (burned) wdCodes.set(u.id, burned); return badKey; }
    const done = await moneyOp(String(body.opKey || ''), u.id, 'withdraw', (add) => {
      add(u.id, 'available', -amount, 'withdraw', 'заявка на вывод');
      add(u.id, 'hold', amount, 'withdraw', 'заявка на вывод');
      const info = q.insWd.run(u.id, amount, fee, net, requisites, 'queued');
      const id = Number(info.lastInsertRowid);
      return { ok: true, withdrawalId: id, amount, fee, net, status: 'queued' };
    });
    /* Заявка не создалась — человек не виноват: возвращаем ему код, чтобы
       не идти за новым. Возврат безопасен: пока шла операция, кода в карте
       не было, и параллельный запрос получил честный отказ. */
    if (burned && !(done && done.status === 200) && !wdCodes.has(u.id)) {
      wdCodes.set(u.id, burned);
    }
    return done;
  },

  /* Отмена своей заявки — только пока оператор её не взял. */
  'POST /api/withdraw/cancel': async (req, body) => {
    if (!rateLimit(req, 'wd', 10, 60000)) return tooOften;
    const u = auth(req);
    if (!u) return { status: 401, body: { error: 'Нужен вход' } };
    const w = q.wd.get(Number(body.withdrawalId));
    if (!w || w.user_id !== u.id) return { status: 404, body: { error: 'Заявка не найдена' } };
    if (w.status !== 'queued') {
      return { status: 409, body: { error: 'Заявка уже в работе — отменить её может только оператор' } };
    }
    if (!userKey(body.opKey)) return badKey;
    return moneyOp(String(body.opKey || ''), u.id, 'wd-cancel', (add) => {
      add(u.id, 'hold', -w.amount, 'wd-cancel', 'заявка ' + w.id);
      add(u.id, 'available', w.amount, 'wd-cancel', 'заявка ' + w.id);
      q.updWd.run('cancelled', 'отменена пользователем', w.id);
      return { ok: true, withdrawalId: w.id, status: 'cancelled' };
    });
  },

  'GET /api/withdrawals': async (req) => {
    const u = auth(req);
    if (!u) return { status: 401, body: { error: 'Нужен вход' } };
    return { status: 200, body: { rows: q.myWds.all(u.id) } };
  },

  /* ── ПРОВЕРКА ЛИЧНОСТИ ПЕРЕД ВЫВОДОМ ─────────────────────────────
     Человек присылает ФИО, дату рождения и фото разворота паспорта.
     Сервер заявку только хранит; смотрит и решает оператор в консоли
     (/operator, раздел «Верификация»). */

  /* Картинка задания: баннер, фото товара, обложка. Только для вошедших;
     на человека — не больше 300 файлов и 150 МБ. Отдаётся по GET /media/<id>
     без входа: адрес из 32 случайных знаков не угадать, а блогеру баннер
     нужен без лишних шагов. */
  'POST /api/media': async (req, body) => {
    /* частоту проверяет диспетчер ДО чтения тела (до 8,6 МБ) */
    const u = auth(req);
    if (!u) return { status: 401, body: { error: 'Нужен вход' } };
    const m = /^data:(?:image\/(?:jpeg|png|webp|gif)|video\/(?:mp4|webm));base64,([A-Za-z0-9+/=]+)$/.exec(String(body.data || ''));
    if (!m) return { status: 400, body: { error: 'Нужна картинка (JPG, PNG, WebP, GIF) или видео MP4' } };
    const buf = Buffer.from(m[1], 'base64');
    const mime = mediaKind(buf);
    if (!mime) return { status: 400, body: { error: 'Файл не похож на картинку' } };
    if (buf.length > (mime === 'image/jpeg' ? MEDIA_MAX : MEDIA_MAX_RICH)) {
      return { status: 400, body: { error: mime === 'image/jpeg' ? 'Картинка больше 1 МБ — уменьшите её' : 'Файл больше 6 МБ — сожмите его' } };
    }
    const full = (s) => Number(s.n) >= MEDIA_USER_FILES || Number(s.bytes) + buf.length > MEDIA_USER_BYTES;
    let st = qm.stat.get(u.id) || {};
    if (full(st) && mediaGc(u.id) > 0) st = qm.stat.get(u.id) || {};
    if (full(st)) {
      return { status: 400, body: { error: 'Место для картинок закончилось (' + MEDIA_USER_FILES + ' файлов, '
        + Math.round(MEDIA_USER_BYTES / 1048576) + ' МБ) — напишите в поддержку', code: 'media_full' } };
    }
    const id = crypto.randomBytes(16).toString('hex');
    qm.ins.run(id, u.id, mime, buf, buf.length);
    return { status: 200, body: { ok: true, id, url: '/media/' + id } };
  },

  'POST /api/kyc/submit': async (req, body) => {
    if (!rateLimit(req, 'kyc', 6, 60000)) return tooOften;
    const u = auth(req);
    if (!u) return { status: 401, body: { error: 'Нужен вход' } };
    const name = String(body.name || '').trim().slice(0, 120);
    const birth = String(body.birth || '').trim().slice(0, 10);
    const photo = String(body.photo || '');
    const selfie = String(body.selfie || '');
    if (name.split(/\s+/).filter(Boolean).length < 2) {
      return { status: 400, body: { error: 'Укажите фамилию и имя полностью' } };
    }
    if (!/^\d{2}\.\d{2}\.\d{4}$/.test(birth)) {
      return { status: 400, body: { error: 'Дата рождения — в формате ДД.ММ.ГГГГ' } };
    }
    /* Аудит 16.10.2026 (C89): дата должна существовать и не быть в будущем,
       а человеку — исполниться 18 (условия и политика: сервис только для
       совершеннолетних). Раньше проходили и 31.02.2030, и 15-летние. */
    {
      const [bd, bmo, by] = birth.split('.').map(Number);
      const dt = new Date(Date.UTC(by, bmo - 1, bd));
      const now = new Date(Date.now() + 3 * 3600000);   /* день по Москве */
      if (dt.getUTCFullYear() !== by || dt.getUTCMonth() !== bmo - 1 || dt.getUTCDate() !== bd || dt.getTime() > now.getTime()) {
        return { status: 400, body: { error: 'Такой даты нет — проверьте дату рождения', code: 'bad_birth' } };
      }
      let age = now.getUTCFullYear() - by;
      if (now.getUTCMonth() + 1 < bmo || (now.getUTCMonth() + 1 === bmo && now.getUTCDate() < bd)) age--;
      if (age < 18) return { status: 400, body: { error: 'Вывод доступен с 18 лет', code: 'underage' } };
      if (age > 110) return { status: 400, body: { error: 'Проверьте год рождения', code: 'bad_birth' } };
    }
    const IMG = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;
    if (!IMG.test(photo) || photo.length > 700 * 1024) {
      return { status: 400, body: { error: 'Нужно фото документа (jpeg/png/webp, до 700 КБ)' } };
    }
    /* Селфи с паспортом в руках: оператор сверяет лицо с фото в документе —
       иначе вывод открывался бы по чужому отсканированному паспорту. */
    if (!IMG.test(selfie) || selfie.length > 700 * 1024) {
      return { status: 400, body: { error: 'Нужно селфи с паспортом в руках (jpeg/png/webp, до 700 КБ)' } };
    }
    const last = q.myLastKyc.get(u.id);
    if (last && last.status === 'approved') {
      return { status: 200, body: { ok: true, status: 'approved', already: true } };
    }
    if (last && last.status === 'queued') {
      /* переотправка, пока оператор не смотрел — просто обновляем заявку */
      q.updKycData.run(name, birth, photo, selfie, last.id);
      return { status: 200, body: { ok: true, status: 'queued', requestId: last.id } };
    }
    const info = q.insKyc.run(u.id, name, birth, photo, selfie, 'queued');
    /* Владельцу — сразу в Телеграм: заявка ждёт решения, иначе человек
       сидит в «на проверке», пока кто-нибудь не заглянет в панель. */
    tgAlert('kyc:new:' + info.lastInsertRowid,
      '🪪 Новая заявка на проверку личности\n\n' + name + '\n' + u.email
      + '\n\nОткройте админ-панель → Проверка документов.');
    return { status: 200, body: { ok: true, status: 'queued', requestId: Number(info.lastInsertRowid) } };
  },

  'GET /api/kyc/status': async (req) => {
    const u = auth(req);
    if (!u) return { status: 401, body: { error: 'Нужен вход' } };
    const last = q.myLastKyc.get(u.id);
    /* номер из «Верификации» — его же владельцу, чтобы новое устройство
       не спрашивало заново (C62) */
    const ph = qPhone.get.get(u.id) || {};
    const phone = ph.kyc_phone ? { phone: ph.kyc_phone, phoneAt: Number(ph.kyc_phone_at) || 0 } : {};
    if (!last) return { status: 200, body: { status: 'none', ...phone } };
    return { status: 200, body: { status: last.status, note: last.note || '', ...phone } };
  },

  /* Номер телефона из шага «Телефон» (аудит 16.10.2026, C62). Пишется один
     раз: тот же номер — ok, другой — 409 с записанным (решение владельца:
     после подтверждения номер не меняется). */
  'POST /api/kyc/phone': async (req, body) => {
    if (!rateLimit(req, 'kycphone', 10, 60000)) return tooOften;
    const u = auth(req);
    if (!u) return { status: 401, body: { error: 'Нужен вход' } };
    let d = String(body.phone || '').replace(/\D/g, '');
    if (d.length === 11 && d[0] === '8') d = '7' + d.slice(1);
    if (!/^7\d{10}$/.test(d)) return { status: 400, body: { error: 'Номер — в формате +7 (999) 123-45-67' } };
    let row = qPhone.get.get(u.id) || {};
    if (!row.kyc_phone) {
      qPhone.set.run(d, Date.now(), u.id);
      row = qPhone.get.get(u.id) || {};
    }
    if (row.kyc_phone === d) return { status: 200, body: { ok: true, phone: d, phoneAt: Number(row.kyc_phone_at) || 0 } };
    return { status: 409, body: { error: 'Номер уже подтверждён — изменить его нельзя', code: 'phone_locked',
      phone: row.kyc_phone, phoneAt: Number(row.kyc_phone_at) || 0 } };
  },

  /* ── ПОДТВЕРЖДЕНИЕ ВЛАДЕНИЯ КАНАЛОМ ──────────────────────────────
     Раньше «верификация» принимала любую ссылку и через две секунды
     рисовала галочку. Теперь человек входит в свой аккаунт на площадке,
     и она сама сообщает нам, чей это канал. */

  'GET /api/verify/start': async (req, body, url) => {
    const u = auth(req);
    if (!u) return { status: 401, body: { error: 'Нужен вход' } };
    if (!rateLimit(req, 'vfystart', 10, 60000)) return tooOften;
    const p = String(url.searchParams.get('platform') || '');
    const cfg = OAUTH[p];
    if (!cfg) return { status: 400, body: { error: 'Неизвестная площадка' } };
    if (!cfg.id || !cfg.secret) {
      return { status: 503, body: {
        error: 'Подтверждение через ' + cfg.label + ' ещё не настроено: в server/.env нет ключей площадки',
      } };
    }
    /* state — случайная одноразовая метка, а не подписанный id: см.
       комментарий к vfy выше. Угадать её нельзя (24 случайных байта). */
    vfySweep();
    const state = crypto.randomBytes(24).toString('hex');
    /* code=1 — подключение из мини-приложения Телеграма (аудит 16.10.2026):
       площадка открывается во внешнем браузере, где человек в BloggerPay не
       вошёл (входил через Телеграм, пароля нет), и пропуск из адреса возврата
       там привязать нечем. Таким страница возврата показывает шестизначный
       код — его вводят в мини-приложении (POST /api/verify/confirm, канал
       получает только начавший проверку аккаунт, 5 попыток). */
    const viaCode = url.searchParams.get('code') === '1';
    vfy.set(state, { userId: u.id, platform: p, at: Date.now(), channel: null, code: '', tries: 0, viaCode });
    const redirect = OAUTH_BASE + '/api/verify/callback/' + p;

    const q1 = new URLSearchParams({
      response_type: 'code', state, redirect_uri: redirect, scope: cfg.scope,
    });
    if (p === 'youtube') {
      q1.set('client_id', cfg.id);
      /* offline — Google отдаёт refresh: без него доступ живёт час, и
         проверить ролик в задании (механика v2) через день было бы нечем.
         Вход через Google (/api/auth/google/start) — отдельно, там online. */
      q1.set('access_type', 'offline');
      /* select_account — чтобы человек КАЖДЫЙ раз выбирал, каким аккаунтом
         входит. Без этого Google молча берёт тот, в котором браузер уже
         сидит: сменить аккаунт и подтвердить второй канал было нельзя. */
      q1.set('prompt', 'select_account consent');
    } else if (p === 'instagram') {
      q1.set('client_id', cfg.id);
      /* только вход Instagram (без Facebook) и каждый раз заново: человек
         выбирает, какой из своих аккаунтов подключает */
      q1.set('enable_fb_login', '0');
      q1.set('force_authentication', '1');
    } else {
      q1.set('client_key', cfg.id);
    }
    return { status: 200, body: { url: cfg.auth + '?' + q1.toString(), nonce: state } };
  },

  /* Приложение спрашивает, дошёл ли человек до конца на площадке.
     Кода здесь НЕТ — его видит только тот, кто входил. */
  'GET /api/verify/pending': async (req, body, url) => {
    const u = auth(req);
    if (!u) return { status: 401, body: { error: 'Нужен вход' } };
    const rec = vfy.get(String(url.searchParams.get('nonce') || ''));
    if (!rec || rec.userId !== u.id || Date.now() - rec.at > VFY_TTL) {
      return { status: 200, body: { state: 'none' } };
    }
    return {
      status: 200,
      body: rec.channel
        ? { state: 'awaiting_code', platform: rec.platform, title: rec.channel.title, subs: rec.channel.subs }
        : { state: 'waiting' },
    };
  },

  /* Привязка канала. Он записывается на ТОГО, КТО ВВЁЛ КОД, а не на
     того, кто начинал проверку: только так подменённая ссылка бесполезна. */
  'POST /api/verify/confirm': async (req, body) => {
    if (!rateLimit(req, 'vfy', 30, 60000)) return tooOften;
    const u = auth(req);
    if (!u) return { status: 401, body: { error: 'Нужен вход' } };
    const nonce = String(body.nonce || '').slice(0, 64);
    const code = String(body.code || '').replace(/\D/g, '');
    const claim = String(body.claim || '').slice(0, 64);
    const rec = vfy.get(nonce);
    if (!rec || !rec.channel) {
      return { status: 404, body: { error: 'Проверка не найдена — начните заново из приложения' } };
    }
    if (Date.now() - rec.at > VFY_TTL) {
      vfy.delete(nonce);
      return { status: 410, body: { error: 'Проверка живёт 15 минут — начните заново' } };
    }
    if (rec.tries >= 5) {
      vfy.delete(nonce);
      return { status: 429, body: { error: 'Слишком много попыток — начните проверку заново' } };
    }
    /* Канал получает ТОТ аккаунт, из которого начали проверку. Иначе
       подсунутая ссылка возврата (с чужим пропуском) привязала бы чужой
       канал к тому, кто по ней прошёл: он-то в приложении вошёл, и
       сервер записал бы канал на него. */
    if (rec.userId && rec.userId !== u.id) {
      return { status: 403, body: { error: 'Проверку начинал другой аккаунт — начните заново из приложения' } };
    }
    /* Пропуск из адреса возврата равносилен верно введённому коду:
       и то и другое доказывает, что человек в приложении — тот самый,
       кто только что вошёл на площадке. */
    /* Сравниваем БАЙТЫ, а не символы: в кириллице один символ — два
       байта, и «одинаковая длина строк» давала буферы разной длины.
       timingSafeEqual на таких падает, и запрос отвечал 500 вместо
       «код не подходит». */
    const claimBytes = Buffer.from(claim, 'utf8');
    const recBytes = Buffer.from(String(rec.claim || ''), 'utf8');
    const byClaim = !!(claimBytes.length && claimBytes.length === recBytes.length
      && crypto.timingSafeEqual(claimBytes, recBytes));
    if (!byClaim && (code.length !== 6 || code !== rec.code)) {
      rec.tries++;
      return { status: 400, body: { error: 'Код не подходит', left: Math.max(0, 5 - rec.tries) } };
    }
    /* Запрета «канал уже подтверждён в другом аккаунте» здесь больше нет:
       человек доказал вход в канал прямо сейчас, и второй его же аккаунт
       имеет на канал такое же право. Повторное подтверждение в ТОМ ЖЕ
       аккаунте просто обновляет строку (ON CONFLICT). */
    q.upsertChannel.run(u.id, rec.platform, String(rec.channel.id),
      rec.channel.title, rec.channel.url, rec.channel.subs, rec.channel.avatar || null);
    /* Остальные числа площадки и доступ к ней — тому, кто подтвердил.
       Доступ нужен, чтобы обновлять статистику потом: человек подтверждает
       канал один раз, а цифры рекламодателю нужны свежие. */
    try {
      q.chanNums.run(rec.channel.username || null, rec.channel.verified ? 1 : 0,
        rec.channel.following == null ? null : rec.channel.following,
        rec.channel.likesTotal == null ? null : rec.channel.likesTotal,
        rec.channel.videosTotal == null ? null : rec.channel.videosTotal,
        u.id, rec.platform, String(rec.channel.id));
    } catch (e) { /* колонки могли не появиться на старой базе */ }
    try {
      if (rec.access) {
        const exp = rec.expires
          ? new Date(Date.now() + rec.expires * 1000).toISOString()
          : null;
        q.putToken.run(u.id, rec.platform, String(rec.channel.id), rec.access, rec.refresh || null, exp);
      }
    } catch (e) { /* без доступа просто не будет обновлений */ }
    /* Первый разбор — сразу, но в стороне: человек не должен ждать
       площадку, а владелец получает картину в тот же момент. */
    if (rec.platform === 'tiktok' && rec.access) {
      setTimeout(() => {
        syncTikTok(u.id, String(rec.channel.id), { first: true }).catch(() => {});
      }, 50);
    }
    vfy.delete(nonce);
    return {
      status: 200,
      body: { ok: true, platform: rec.platform, title: rec.channel.title, subs: rec.channel.subs },
    };
  },

  /* ── YouTube: подключение кодом в описании канала (15.10.2026) ────────
     Владелец: «нажимаю „добавить аккаунт" YouTube — от Google жирное
     предупреждение, что этому сайту лучше не давать доступ». Это экран
     «приложение не проверено»: область youtube.readonly — «чувствительная»,
     а проверку Google проходит только приложение со своим доменом (у нас
     адрес хостинга). Здесь вход в Google не нужен: человек вписывает
     короткий код в описание своего канала, сервер читает описание открытым
     ключом (YT_API_KEY) и, если код там, записывает канал на того, кто
     начинал. Код — на 30 минут, проверок — до 30 (квота — ytChannelFor:
     10 % суточной на всех, 40 запросов на человека, кэш 30 с). Просмотры роликов сервер
     и так берёт этим ключом (ytVideos); доступ к аккаунту не нужен. После
     подключения код из описания можно удалить. */
  'POST /api/verify/youtube/code': async (req, body) => {
    const u = auth(req);
    if (!u) return { status: 401, body: { error: 'Нужен вход' } };
    if (!rateLimit(req, 'ytcode', 10, 60000)) return tooOften;
    if (!YT_API_KEY) return { status: 503, body: { error: 'Подключение YouTube кодом ещё не настроено: на сервере нет YT_API_KEY' } };
    const ref = ytChannelRef(body && body.channel);
    if (!ref) return { status: 400, body: { error: 'Вставьте ссылку на канал — youtube.com/@имя — или @имя' } };
    let ch;
    try { ch = await ytChannelFor(u.id, ref); }
    catch (e) { return ytCodeFail(e); }
    if (!ch) return { status: 404, body: { error: 'Канал не найден — проверьте ссылку' } };
    ytCodeSweep();
    const prev = ytCode.get(u.id);
    const keep = prev && prev.channel.id === ch.id && Date.now() - prev.at < YT_CODE_TTL;
    /* тот же код — и тот же счёт проверок: иначе повторная выдача давала
       ещё 30 запросов к YouTube (разбор 16.10) */
    const rec = { channel: ch, code: keep ? prev.code : ytNewCode(), at: keep ? prev.at : Date.now(), tries: keep ? (prev.tries || 0) : 0 };
    ytCode.set(u.id, rec);
    return { status: 200, body: {
      code: rec.code, left: Math.max(0, Math.round((rec.at + YT_CODE_TTL - Date.now()) / 1000)),
      channel: { id: ch.id, title: ch.title, url: ch.url, avatar: ch.avatar, subs: ch.subs, username: ch.username },
    } };
  },

  'POST /api/verify/youtube/check': async (req) => {
    const u = auth(req);
    if (!u) return { status: 401, body: { error: 'Нужен вход' } };
    if (!rateLimit(req, 'ytcheck', 20, 60000)) return tooOften;
    if (!YT_API_KEY) return { status: 503, body: { error: 'Подключение YouTube кодом ещё не настроено: на сервере нет YT_API_KEY' } };
    const rec = ytCode.get(u.id);
    if (!rec || Date.now() - rec.at > YT_CODE_TTL) {
      ytCode.delete(u.id);
      return { status: 410, body: { error: 'Код устарел — получите новый' } };
    }
    if (++rec.tries > 30) { ytCode.delete(u.id); return { status: 429, body: { error: 'Слишком много проверок — получите новый код' } }; }
    let ch;
    try { ch = await ytChannelFor(u.id, { id: rec.channel.id }); }
    catch (e) { return ytCodeFail(e); }
    if (!ch) return { status: 404, body: { error: 'Канал не найден' } };
    if (!ytHasCode(ch.description, rec.code)) {
      return { status: 409, body: { error: 'Код пока не виден в описании канала', code: rec.code } };
    }
    /* как и при входе через площадку (/api/verify/confirm): канал — тому,
       кто доказал, что управляет им сейчас; повтор в том же аккаунте
       просто обновляет строку */
    q.upsertChannel.run(u.id, 'youtube', ch.id, ch.title, ch.url, ch.subs, ch.avatar || null);
    try { q.chanNums.run(ch.username || null, 0, null, null, ch.videosTotal == null ? null : ch.videosTotal, u.id, 'youtube', ch.id); }
    catch (e) { /* колонки могли не появиться на старой базе */ }
    ytCode.delete(u.id);
    return { status: 200, body: { ok: true, platform: 'youtube', id: ch.id, title: ch.title, subs: ch.subs } };
  },

  'GET /api/verify/config': async (req) => {
    if (!rateLimit(req, 'vfycfg', 60, 60000)) return tooOften;
    const platforms = {};
    for (const p of Object.keys(OAUTH)) {
      platforms[p] = {
        label: OAUTH[p].label,
        configured: !!(OAUTH[p].id && OAUTH[p].secret),
        redirect: OAUTH_BASE + '/api/verify/callback/' + p,
      };
    }
    /* YouTube можно подключить и без входа в Google — кодом в описании
       канала (нужен только открытый ключ YT_API_KEY) */
    if (platforms.youtube) platforms.youtube.code = !!YT_API_KEY;
    return { status: 200, body: { platforms } };
  },

  'GET /api/admin/verify/probe': async (req, body, url) => {
    if (!isAdmin(req)) return { status: 403, body: { error: 'Нужен X-Admin-Key' } };
    const out = await platformProbe(String(url.searchParams.get('platform') || ''));
    if (!out) return { status: 400, body: { error: 'Неизвестная площадка' } };
    return { status: 200, body: out };
  },

  'GET /api/verify/list': async (req) => {
    const u = auth(req);
    if (!u) return { status: 401, body: { error: 'Нужен вход' } };
    return { status: 200, body: { rows: q.myChannels.all(u.id) } };
  },

  /* Проверка ЧУЖОГО блогера — то, что видит рекламодатель в карточке.
     Раньше подтверждение канала не давало блогеру ничего: карточка у
     всех одинаково писала «не проверено», а число подписчиков бралось
     из того, что человек вписал руками. Теперь рекламодатель может
     отличить подтверждённое входом на площадку от слов.

     Отдаём НАМЕРЕННО МАЛО: только площадку, число подписчиков и дату
     проверки. Ни адреса канала, ни его названия, ни внешнего id — они
     к решению «верить или нет» ничего не добавляют, а лишние поля
     превращают ручку в способ собирать чужие каналы пачками.
     Число подписчиков не тайна: оно и так открыто на самом канале. */
  'GET /api/verify/of': async (req, body, url) => {
    if (!auth(req)) return { status: 401, body: { error: 'Нужен вход' } };
    if (!rateLimit(req, 'vfyof', 60, 60000)) return tooOften;
    const id = Number(url.searchParams.get('userId'));
    if (!Number.isInteger(id) || id <= 0) return { status: 400, body: { error: 'Нужен userId' } };
    const rows = q.myChannels.all(id).map((c) => ({
      platform: c.platform,
      subs: Number(c.subs) || 0,
      checkedAt: c.checked_at,
    }));
    return { status: 200, body: { rows } };
  },

  /* Отвязка канала оператором: канал продали, аккаунт потеряли, привязали
     не туда. Без этого строку можно было убрать только правкой базы. */
  /* Отвязать свой канал: человек убирает ошибочный или больше не свой.
     Удаляем строго свою строку — тот же канал может быть подтверждён и у
     других, и они тут ни при чём. */
  /* «Обновить статистику» в приложении. Ходить к площадке на каждый
     показ страницы незачем — только по нажатию и по фоновому кругу. */
  'POST /api/verify/refresh': async (req, body) => {
    const u = auth(req);
    if (!u) return { status: 401, body: { error: 'Нужен вход' } };
    if (!rateLimit(req, 'vfyrefresh:' + u.id, 10, 60000)) return tooOften;
    const platform = String(body.platform || '');
    const externalId = String(body.externalId || '');
    if (platform !== 'tiktok') {
      return { status: 400, body: { error: 'Пока обновляется только TikTok' } };
    }
    const row = q.channelOf.get(u.id, platform, externalId);
    if (!row) return { status: 404, body: { error: 'Такой канал у вас не подтверждён' } };
    const r = await syncTikTok(u.id, externalId, {});
    if (!r.ok) return { status: 503, body: { error: 'Не вышло обновить: ' + (r.why || 'площадка не ответила') } };
    return { status: 200, body: r };
  },

  'POST /api/verify/unlink': async (req, body) => {
    const u = auth(req);
    if (!u) return { status: 401, body: { error: 'Нужен вход' } };
    if (!rateLimit(req, 'vfyunlink:' + u.id, 20, 60000)) return tooOften;
    const platform = String(body.platform || '');
    const externalId = String(body.externalId || '');
    if (!platform || !externalId) return { status: 400, body: { error: 'Нужны platform и externalId' } };
    const row = q.channelOf.get(u.id, platform, externalId);
    if (!row) return { status: 404, body: { error: 'Такой канал у вас не подтверждён' } };
    q.delChannel.run(u.id, platform, externalId);
    /* Отвязали — доступ к площадке держать не за чем и незачем. */
    try { q.delToken.run(u.id, platform, externalId); } catch (e) { /* мог не сохраниться */ }
    try { q.delStats.run(u.id, platform, externalId); } catch (e) { /* снимков могло не быть */ }
    /* Ролики с этого канала, которые ещё ждут проверки, снимаем; засчитанные
       остаются в работе (их решит владелец, если доступ не вернётся). */
    vidRevoke(u.id, platform, externalId, 'self');
    return { status: 200, body: { ok: true, platform, externalId } };
  },

  'POST /api/admin/verify/unlink': async (req, body) => {
    if (!isAdmin(req)) return { status: 403, body: { error: 'Нужен X-Admin-Key' } };
    const platform = String(body.platform || '');
    const externalId = String(body.externalId || '');
    if (!platform || !externalId) return { status: 400, body: { error: 'Нужны platform и externalId' } };
    const rows = q.channelsByExt.all(platform, externalId);
    if (!rows.length) return { status: 404, body: { error: 'Такой канал не подтверждён' } };
    q.delChannelEverywhere.run(platform, externalId);
    /* Доступ к площадке и снимки статистики — у каждого, от кого канал
       отвязан: раньше они оставались на сервере бессрочно, хотя канала
       уже не было (политика обещает удаление при отвязке). */
    for (const r of rows) {
      try { q.delToken.run(r.user_id, platform, externalId); } catch (e) { /* мог не сохраниться */ }
      try { q.delStats.run(r.user_id, platform, externalId); } catch (e) { /* снимков могло не быть */ }
    }
    for (const r of rows) vidRevoke(r.user_id, platform, externalId, 'admin');
    adminLog(req, 'channel-unlink', platform + ':' + externalId, 'у ' + rows.map((r) => 'user ' + r.user_id).join(', '));
    return { status: 200, body: { ok: true, freedFrom: rows.map((r) => r.user_id) } };
  },

  /* Приём ошибок от приложения. Без входа: ломается часто именно то,
     что мешает войти. Поэтому же ограничиваем размер и количество. */
  /* ── Уведомления на телефон ──
     Открытый ключ сервера: приложение подписывается им у своего
     браузера. Не секрет — он и задуман открытым. */
  'GET /api/push/key': async () => {
    try {
      return { status: 200, body: { key: pushLib.keys(DB_PATH).publicB64 } };
    } catch (e) {
      return { status: 503, body: { error: 'Уведомления не настроены' } };
    }
  },

  'POST /api/push/subscribe': async (req, body) => {
    const u = auth(req);
    if (!u) return { status: 401, body: { error: 'Нужен вход' } };
    if (!rateLimit(req, 'push', 20, 60000)) return tooOften;
    const s = (body && body.sub) || {};
    const endpoint = String(s.endpoint || '').slice(0, 700);
    const keys = (s.keys && typeof s.keys === 'object') ? s.keys : {};
    const p256dh = String(keys.p256dh || '').slice(0, 200);
    const secret = String(keys.auth || '').slice(0, 60);
    /* Адрес доставки задаёт браузер, но приходит он от клиента — значит
       подставить туда можно что угодно, и сервер послушно постучится по
       любому адресу. Пускаем только известные службы доставки и только
       по https (список и разбор — в push.js). */
    const whyBad = pushLib.endpointWhyBad(endpoint, ENV);
    if (whyBad) {
      /* Неизвестная служба — это либо чужая разведка, либо браузер, чей
         адрес мы не внесли в список, и тогда его владелец молча остался
         бы без уведомлений. Владельцу площадки лучше знать про оба. */
      tgAlert('push:host:' + String(endpoint).slice(0, 60),
        '🔕 Подписка на уведомления отклонена\n\n' + whyBad
        + '\n\nАдрес: ' + String(endpoint).slice(0, 200)
        + '\nЧеловек: ' + (u.email || u.id)
        + '\n\nЕсли это настоящий браузер — добавьте хост в PUSH_HOSTS в server/push.js.', 'server');
      return { status: 400, body: { error: 'Неизвестная служба доставки уведомлений' } };
    }
    if (!p256dh || !secret) return { status: 400, body: { error: 'Подписка без ключей' } };
    try {
      q.pushIns.run(endpoint, u.id, p256dh, secret,
        String(req.headers['user-agent'] || '').slice(0, 200) || null);
    } catch (e) {
      return { status: 500, body: { error: 'Не удалось сохранить подписку' } };
    }
    return { status: 200, body: { ok: true } };
  },

  /* Отписка: своё удаляем всегда, чужое — никогда. */
  'POST /api/push/unsubscribe': async (req, body) => {
    const u = auth(req);
    if (!u) return { status: 401, body: { error: 'Нужен вход' } };
    const endpoint = String((body && body.endpoint) || '').slice(0, 700);
    if (!endpoint) return { status: 400, body: { error: 'Нет адреса подписки' } };
    let removed = 0;
    try { removed = Number(q.pushDelMine.run(endpoint, u.id).changes) || 0; } catch (e) {}
    return { status: 200, body: { ok: true, removed } };
  },

  'POST /api/errors': async (req, body) => {
    if (!rateLimit(req, 'err', 30, 60000)) return tooOften;
    const list = Array.isArray(body.errors) ? body.errors.slice(0, 20) : [];
    if (!list.length) return { status: 200, body: { taken: 0 } };
    const u = auth(req);
    let taken = 0;
    /* гость — до 5 строк за запрос (было 20 × 30/мин = 600 строк в минуту) */
    for (const e of (u ? list : list.slice(0, 5))) {
      const msg = String((e && e.message) || '').trim().slice(0, 300);
      if (!msg) continue;
      const where = String((e && e.where) || '').slice(0, 120);
      const ver = String((e && e.version) || '').slice(0, 40);
      q.insError.run(
        u ? u.id : null,
        msg,
        where || null,
        ver || null,
        String(req.headers['user-agent'] || '').slice(0, 200) || null,
      );
      taken++;
      /* Каждая новая ошибка тут же уходит владельцу в Телеграм. Текст
         прислал браузер (у гостя — кто угодно без входа), поэтому ссылки,
         адреса и @имена обезврежены: бот не должен приносить владельцу
         кликабельную «срочно войдите по ссылке» (аудит 16.10.2026).
         Гости — свой кошелёк тревог, вошедших они не заглушат. */
      const safe = (s) => String(s).replace(/:\/\//g, ':∕∕').replace(/\.(?=\S)/g, '․').replace(/@/g, '＠');
      tgAlert('site:' + msg.slice(0, 120) + '|' + where,
        '🐞 Ошибка на сайте\n\n' + safe(msg)
        + (where ? '\n\nГде: ' + safe(where) : '')
        + (ver ? '\nВерсия: ' + safe(ver) : '')
        + '\nКто: ' + (u ? safe(u.name || 'без имени') + ' (id ' + u.id + ')' : 'гость (не вошёл)'), u ? 'client' : 'guest');
    }
    /* Журнал ошибок — не деньги, его можно и нужно подрезать, иначе
       одна зациклившаяся вкладка забьёт базу. */
    /* Подрезку перенесли в почасовую уборку ниже: раньше она шла на
       каждом обращении и синхронно держала весь сервер. */
    return { status: 200, body: { taken } };
  },

  'GET /api/admin/errors': async (req, body, url) => {
    if (!isAdmin(req)) return { status: 403, body: { error: 'Нужен X-Admin-Key' } };
    const days = Math.min(30, Math.max(1, Number(url.searchParams.get('days')) || 7));
    return { status: 200, body: { rows: q.errorGroups.all('-' + days + ' days'), days } };
  },

  /* ── Оператор ────────────────────────────────────────────────────── */

  'GET /api/admin/withdrawals': async (req, body, url) => {
    if (!isAdmin(req)) return { status: 403, body: { error: 'Нужен X-Admin-Key' } };
    const st = String(url.searchParams.get('status') || '');
    /* У кого на балансе были тестовые зачисления — помечаем заявку: эти
       деньги ненастоящие, платить их живыми рублями владелец не обязан
       (аудит 16.10.2026). Сам вывод не отклоняем — решает оператор. */
    const seen = new Map();
    const rows = q.allWds.all(st, st).map((w) => {
      if (!seen.has(w.user_id)) seen.set(w.user_id, q.testToppedBy.get(w.user_id, TEST_TOPUP_REF, TEST_TOPUP_REF).s);
      const t = seen.get(w.user_id);
      return t > 0 ? Object.assign({}, w, { test_topup: t }) : w;
    });
    return { status: 200, body: { rows } };
  },

  /* «Взял в работу» — с этого момента пользователь заявку не отменит. */
  'POST /api/admin/withdrawals/take': async (req, body) => {
    if (!isAdmin(req)) return { status: 403, body: { error: 'Нужен X-Admin-Key' } };
    const w = q.wd.get(Number(body.withdrawalId));
    if (!w) return { status: 404, body: { error: 'Заявка не найдена' } };
    if (w.status !== 'queued') return { status: 409, body: { error: 'Заявка не в очереди: ' + w.status } };
    q.updWd.run('processing', null, w.id);
    adminLog(req, 'wd-take', 'заявка ' + w.id, w.net + ' ₽ · user ' + w.user_id);
    return { status: 200, body: { ok: true, withdrawalId: w.id, status: 'processing' } };
  },

  /* «Отправил деньги»: hold списывается, комиссия остаётся платформе. */
  'POST /api/admin/withdrawals/paid': async (req, body) => {
    if (!isAdmin(req)) return { status: 403, body: { error: 'Нужен X-Admin-Key' } };
    const w = q.wd.get(Number(body.withdrawalId));
    if (!w) return { status: 404, body: { error: 'Заявка не найдена' } };
    if (w.status !== 'processing' && w.status !== 'queued') {
      return { status: 409, body: { error: 'Заявка уже закрыта: ' + w.status } };
    }
    const _wdPaid = moneyOp(sysKey('wd-paid', w.id), w.user_id, 'wd-paid', (add) => {
      add(w.user_id, 'hold', -w.amount, 'wd-paid', 'заявка ' + w.id);
      if (w.fee > 0) add(0, 'available', w.fee, 'fee', 'комиссия по заявке ' + w.id);
      q.updWd.run('paid', String(body.note || '').slice(0, 200) || null, w.id);
      /* Человек ждёт эти деньги и обновляет экран вручную — скажем сами. */
      pushTo(w.user_id, 'Деньги отправлены',
        w.net.toLocaleString('ru') + ' ₽ ушли на ваши реквизиты', '/');
      return { ok: true, withdrawalId: w.id, status: 'paid', net: w.net, fee: w.fee };
    });
    if (_wdPaid.status === 200 && !_wdPaid.body.repeated) adminLog(req, 'wd-paid', 'заявка ' + w.id, w.net + ' ₽ · user ' + w.user_id);
    return _wdPaid;
  },

  'POST /api/admin/withdrawals/reject': async (req, body) => {
    if (!isAdmin(req)) return { status: 403, body: { error: 'Нужен X-Admin-Key' } };
    const w = q.wd.get(Number(body.withdrawalId));
    if (!w) return { status: 404, body: { error: 'Заявка не найдена' } };
    if (w.status === 'paid' || w.status === 'rejected' || w.status === 'cancelled') {
      return { status: 409, body: { error: 'Заявка уже закрыта: ' + w.status } };
    }
    const _wdRej = moneyOp(sysKey('wd-reject', w.id), w.user_id, 'wd-reject', (add) => {
      add(w.user_id, 'hold', -w.amount, 'wd-reject', 'заявка ' + w.id);
      add(w.user_id, 'available', w.amount, 'wd-reject', 'заявка ' + w.id);
      q.updWd.run('rejected', String(body.note || '').slice(0, 200) || 'отклонена оператором', w.id);
      pushTo(w.user_id, 'Заявка на вывод отклонена',
        w.amount.toLocaleString('ru') + ' ₽ вернулись на баланс', '/');
      return { ok: true, withdrawalId: w.id, status: 'rejected' };
    });
    if (_wdRej.status === 200 && !_wdRej.body.repeated) adminLog(req, 'wd-reject', 'заявка ' + w.id, String(body.note || '').slice(0, 200));
    return _wdRej;
  },

  /* ── Верификация: оператор смотрит паспорт и решает ── */

  'GET /api/admin/kyc': async (req, body, url) => {
    if (!isAdmin(req)) return { status: 403, body: { error: 'Нужен X-Admin-Key' } };
    const st = String(url.searchParams.get('status') || '');
    return { status: 200, body: { rows: q.kycList.all(st, st) } };
  },

  'GET /api/admin/kyc/photo': async (req, body, url) => {
    if (!isAdmin(req)) return { status: 403, body: { error: 'Нужен X-Admin-Key' } };
    const k = q.kycPhoto.get(Number(url.searchParams.get('id')));
    if (!k) return { status: 404, body: { error: 'Заявка не найдена' } };
    const kind = url.searchParams.get('kind') === 'selfie' ? 'selfie' : 'photo';
    return { status: 200, body: { id: k.id, kind, photo: k[kind] || '', updated_at: k.updated_at } };
  },

  /* seenAt — updated_at заявки на момент, когда оператор её разглядывал.
     Пока он смотрел, человек мог переотправить данные (это разрешено до
     решения): тогда решение легло бы на фото, которого оператор не видел.
     Не совпало — 409, посмотрите заявку заново. */
  'POST /api/admin/kyc/approve': async (req, body) => {
    if (!isAdmin(req)) return { status: 403, body: { error: 'Нужен X-Admin-Key' } };
    const k = q.kycById.get(Number(body.requestId));
    if (!k) return { status: 404, body: { error: 'Заявка не найдена' } };
    if (k.status !== 'queued') return { status: 409, body: { error: 'Заявка уже решена: ' + k.status } };
    const seen = String(body.seenAt || '');
    if (seen && seen !== String(k.updated_at)) {
      return { status: 409, body: { error: 'Заявка изменилась, пока вы смотрели — обновите список и проверьте заново' } };
    }
    q.updKyc.run('approved', null, k.id);
    adminLog(req, 'kyc-approve', 'user ' + k.user_id, k.name);
    pushTo(k.user_id, 'Личность подтверждена', 'Вывод денег теперь открыт', '/');
    return { status: 200, body: { ok: true, requestId: k.id, status: 'approved' } };
  },

  'POST /api/admin/kyc/reject': async (req, body) => {
    if (!isAdmin(req)) return { status: 403, body: { error: 'Нужен X-Admin-Key' } };
    const k = q.kycById.get(Number(body.requestId));
    if (!k) return { status: 404, body: { error: 'Заявка не найдена' } };
    if (k.status !== 'queued') return { status: 409, body: { error: 'Заявка уже решена: ' + k.status } };
    const seen = String(body.seenAt || '');
    if (seen && seen !== String(k.updated_at)) {
      return { status: 409, body: { error: 'Заявка изменилась, пока вы смотрели — обновите список и проверьте заново' } };
    }
    q.updKyc.run('rejected', String(body.note || '').slice(0, 200) || 'отклонена оператором', k.id);
    adminLog(req, 'kyc-reject', 'user ' + k.user_id, String(body.note || '').slice(0, 200));
    pushTo(k.user_id, 'Проверка личности не пройдена',
      String(body.note || '').slice(0, 120) || 'Откройте приложение и подайте заявку заново', '/');
    return { status: 200, body: { ok: true, requestId: k.id, status: 'rejected' } };
  },

  /* ── Счета: пополнение по счёту ── */
  'GET /api/admin/invoices': async (req, body, url) => {
    if (!isAdmin(req)) return { status: 403, body: { error: 'Нужен X-Admin-Key' } };
    const st = String(url.searchParams.get('status') || '');
    /* fee/total — сумма счёта с комиссией: окно «Зачислить» сверяет с ней
       пришедшее (аудит 16.10.2026) */
    const rows = qi.list.all(st, st, st).map((r) => Object.assign({}, r, {
      fee: pctOf(r.amount, TOPUP_FEE_PCT), total: r.amount + pctOf(r.amount, TOPUP_FEE_PCT) }));
    return { status: 200, body: { rows, min: INV_MIN, feePct: TOPUP_FEE_PCT } };
  },

  'POST /api/admin/invoices/credit': async (req, body) => {
    if (!isAdmin(req)) return { status: 403, body: { error: 'Нужен X-Admin-Key' } };
    const r = qi.byId.get(Number(body.id));
    if (!r) return { status: 404, body: { error: 'Заявка не найдена' } };
    if (r.status === 'rejected') return { status: 409, body: { error: 'Заявка закрыта — зачислить нельзя' } };
    if (r.status !== 'paid') {
      const owner = q.userById.get(r.user_id);
      if (!owner || /@erased\.invalid$/.test(String(owner.email || ''))) {
        return { status: 409, body: { error: 'Данные этого человека удалены — зачислить некуда. Верните деньги плательщику'
          + ' по реквизитам из платёжки и закройте заявку.', code: 'erased' } };
      }
    }
    /* Два вида запроса (аудит 16.10.2026). paid — СКОЛЬКО ПРИШЛО на
       расчётный счёт (с комиссией): так спрашивает окно /admin, оператор
       переписывает число из выписки. На баланс — обратный расчёт счёта
       (наибольшая сумма, у которой сумма + 7% не больше пришедшего),
       комиссия — остаток: «внесено» в сверке = ровно то, что пришло.
       Раньше окно спрашивало «сколько пришло», а сервер клал всё это на
       баланс и дописывал 7% сверху — клиент получал лишние 7%.
       amount — сумма НА БАЛАНС (без комиссии), прежний вид, по умолчанию —
       сумма заявки. */
    const paidIn = body.paid == null || body.paid === '' ? null : Number(body.paid);
    let amount, fee;
    if (paidIn != null) {
      if (!Number.isInteger(paidIn) || paidIn < 2 || paidIn > 110000000) {
        return { status: 400, body: { error: 'Пришедшая сумма — целое число рублей' } };
      }
      amount = Math.floor(paidIn * 100 / (100 + TOPUP_FEE_PCT));
      while (amount > 0 && amount + pctOf(amount, TOPUP_FEE_PCT) > paidIn) amount--;
      while (amount + 1 + pctOf(amount + 1, TOPUP_FEE_PCT) <= paidIn) amount++;
      fee = paidIn - amount;
    } else {
      amount = body.amount == null || body.amount === '' ? r.amount : Number(body.amount);
      fee = null;
    }
    if (!Number.isInteger(amount) || amount < 1 || amount > 100000000) {
      return { status: 400, body: { error: 'Сумма — целое число от 1 ₽' } };
    }
    if (r.status === 'paid' && amount !== r.paid) {
      return { status: 409, body: { error: 'Счёт уже оплачен: зачислено ' + rubTxt(r.paid) } };
    }
    /* комиссия 7% сверху: счёт выставлен на сумму + комиссию, на баланс — сумма */
    if (fee == null) fee = pctOf(amount, TOPUP_FEE_PCT);
    /* Ключ — служебный sys:invoice:<id> (из приложения его не занять, см.
       RESERVED_OP). Прежнее зачисление ключом 'invoice:<id>' (до 16.10)
       узнаём: тот же человек, вид topup и счёт уже «оплачен» — повтор идёт
       старым ключом и второй раз не платит. Чужая запись под старым ключом
       (занятый заранее номер) зачислению больше не мешает. */
    const invSys = sysKey('invoice', r.id), invOld = 'invoice:' + r.id;
    const opOld = q.opByKey.get(invSys) ? null : q.opByKey.get(invOld);
    const invKey = opOld && opOld.user_id === r.user_id && opOld.kind === 'topup' && r.status === 'paid' ? invOld : invSys;
    /* страховка от двойного зачисления: «оплачен», а записи зачисления нет */
    if (r.status === 'paid' && !q.opByKey.get(invKey)) {
      return { status: 409, body: { error: 'Счёт уже оплачен: зачислено ' + rubTxt(r.paid) } };
    }
    const res = moneyOp(invKey, r.user_id, 'topup', (add) => {
      add(r.user_id, 'available', amount, 'topup', 'пополнение по счёту №' + r.id + (fee > 0 ? ' · оплачено ' + (amount + fee) + ', комиссия ' + fee : ''));
      if (fee > 0) add(0, 'available', fee, 'topup-fee', 'комиссия пополнения по счёту №' + r.id);
      return { ok: true, id: r.id, amount, fee, total: amount + fee, balance: q.balance.get(r.user_id) };
    });
    if (res.status === 200 && !res.body.repeated) {
      qi.setSt.run('paid', amount, null, r.id);
      adminLog(req, 'inv-credit', 'user ' + r.user_id, 'счёт №' + r.id + ' · ' + amount + ' ₽');
      pushTo(r.user_id, 'Оплата по счёту получена', rubTxt(amount) + ' на балансе', '/');
      invSay(r.tg_chat, '✅ Оплата по счёту №' + r.id + ' получена — ' + rubTxt(amount) + ' зачислены на баланс BloggerPay.');
    }
    return res;
  },

  'POST /api/admin/invoices/reject': async (req, body) => {
    if (!isAdmin(req)) return { status: 403, body: { error: 'Нужен X-Admin-Key' } };
    const r = qi.byId.get(Number(body.id));
    if (!r) return { status: 404, body: { error: 'Заявка не найдена' } };
    if (r.status === 'paid') return { status: 409, body: { error: 'Счёт уже оплачен — закрыть нельзя' } };
    if (r.status === 'rejected') return { status: 200, body: { ok: true, id: r.id, status: 'rejected', repeated: true } };
    const note = String(body.note || '').trim().slice(0, 200);
    qi.setSt.run('rejected', null, note || null, r.id);
    adminLog(req, 'inv-reject', 'user ' + r.user_id, 'счёт №' + r.id + (note ? ' · ' + note : ''));
    invSay(r.tg_chat, 'Заявка на счёт №' + r.id + ' закрыта' + (note ? ': ' + note : '') + '. Если нужно, создайте новую в приложении.');
    return { status: 200, body: { ok: true, id: r.id, status: 'rejected' } };
  },

  'GET /api/admin/deals': async (req) => {
    if (!isAdmin(req)) return { status: 403, body: { error: 'Нужен X-Admin-Key' } };
    /* Открытые споры со сторонами (аудит 16.10.2026): раньше раздел
       показывал только заморозки — какая из них под спором и чей он, было
       не видно, а снять спор было нечем. Для бюджета задания — что держит
       спор блогера и сколько свободно для решения по его части. */
    const disputes = q.openDisputesAdmin.all().map((x) => {
      const camp = /^camp:/.test(String(x.deal_id));
      const open = x.deal_status === 'held';
      const o = {
        id: x.id, dealId: x.deal_id, camp, dealStatus: x.deal_status || null,
        amount: x.amount || 0, paid: x.paid || 0, left: open ? Math.max(0, (x.amount || 0) - (x.paid || 0)) : 0,
        payerId: x.payer_id || null, payerName: x.payer_name || '', payerEmail: x.payer_email || '',
        openedBy: x.opened_by, openerName: x.opener_name || '', openerEmail: x.opener_email || '',
        byPayer: x.opened_by === x.payer_id,
        payeeId: x.payee_id == null ? null : x.payee_id, payeeName: x.payee_name || '', payeeEmail: x.payee_email || '',
        dealPayeeId: x.deal_payee_id == null ? null : x.deal_payee_id,
        createdAt: x.created_at,
      };
      if (open && x.payee_id != null) o.paidTo = Number((q.paidToSum.get(x.deal_id, x.payee_id) || {}).s) || 0;
      if (open && camp) {
        o.free = vidReturnable(String(x.deal_id).slice(5));
        if (x.payee_id != null) o.liveVideos = Number((q.vidLiveOf.get(String(x.deal_id).slice(5), x.payee_id) || {}).n) || 0;
      }
      o.blocksRefund = open && !!(x.payee_id == null || (!camp && (x.payee_id === x.deal_payee_id || o.paidTo > 0)));
      return o;
    });
    const per = new Map();
    for (const x of disputes) if (x.dealStatus === 'held') per.set(x.dealId, (per.get(x.dealId) || 0) + 1);
    const rows = q.openDeals.all().map((d) => Object.assign({}, d, { disputes: per.get(d.id) || 0 }));
    return { status: 200, body: { rows, disputes } };
  },

  'GET /api/admin/user': async (req, body, url) => {
    if (!isAdmin(req)) return { status: 403, body: { error: 'Нужен X-Admin-Key' } };
    const id = Number(url.searchParams.get('id'));
    const u = q.userById.get(id);
    if (!u) return { status: 404, body: { error: 'Нет такого пользователя' } };
    return {
      status: 200,
      body: {
        user: { id: u.id, email: u.email, name: u.name, role: u.role,
          created_at: u.created_at, is_admin: u.is_admin, is_blocked: u.is_blocked,
          tg: !!u.tg_id, google: !!u.google_sub },
        balance: q.balance.get(u.id),
        ledger: q.userLedger.all(u.id),
        kyc: q.userKycLast.get(u.id) || null,
        channels: q.myChannels.all(u.id).map((c) => ({
          platform: c.platform, external_id: c.external_id, title: c.title, url: c.url,
          subs: c.subs, username: c.username, checked_at: c.checked_at,
          risk_level: c.risk_level || null,
        })),
        cards: q.userCards.all(u.id).map((c) => ({ id: c.id, hidden: c.hidden, updated_at: c.updated_at, card: cardBrief(c.data) })),
        withdrawals: q.userWds.all(u.id),
      },
    };
  },

  /* Пульт · список людей. Ищет по имени, почте, номеру и Телеграму;
     фильтры — роль, заблокированные, владельцы. */
  'GET /api/admin/users': async (req, body, url) => {
    if (!isAdmin(req)) return { status: 403, body: { error: 'Только владелец площадки' } };
    const qs = String(url.searchParams.get('q') || '').trim().toLowerCase().slice(0, 80);
    const f = String(url.searchParams.get('filter') || '');
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 50));
    const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
    let rows = q.adminUsers.all();
    if (f === 'blocked') rows = rows.filter((r) => r.is_blocked);
    else if (f === 'admin') rows = rows.filter((r) => r.is_admin);
    else if (f === 'blogger' || f === 'advertiser') rows = rows.filter((r) => r.role === f);
    else if (f === 'kyc') rows = rows.filter((r) => r.kyc === 'queued');
    if (qs) {
      const idq = qs.replace(/^#|^id\s*/, '');
      const exact = (r) => String(r.id) === idq || (r.tg_id && String(r.tg_id) === qs);
      rows = rows.filter((r) => exact(r) || String(r.name || '').toLowerCase().includes(qs)
        || String(r.email || '').toLowerCase().includes(qs));
      /* «12» находит и человека №12, и почты tg12…@telegram.local — номер
         важнее, ставим его первым. */
      rows.sort((a, b) => (exact(b) ? 1 : 0) - (exact(a) ? 1 : 0));
    }
    const total = rows.length;
    return { status: 200, body: {
      total, limit, offset,
      rows: rows.slice(offset, offset + limit).map((r) => ({
        id: r.id, name: r.name, email: r.email, role: r.role, created_at: r.created_at,
        is_admin: r.is_admin, is_blocked: r.is_blocked, tg: !!r.tg_id, google: !!r.google,
        available: r.available, hold: r.hold, kyc: r.kyc || null, channels: r.channels, cards: r.cards,
      })),
    } };
  },

  /* Блокировка. Заблокированный не входит (auth отказывает), его
     карточка пропадает из каталога, он выпадает из рейтинга. Активные
     сессии гасим сразу. Владельца и счёт платформы блокировать нельзя —
     иначе можно запереть самого себя. Деньги не трогаем: заявки на
     вывод и заморозки остаются, решайте их в своих разделах. */
  'POST /api/admin/users/block': async (req, body) => {
    if (!isAdmin(req)) return { status: 403, body: { error: 'Только владелец площадки' } };
    const id = Number(body.userId);
    if (!Number.isInteger(id) || id <= 0) return { status: 400, body: { error: 'Нужен номер пользователя' } };
    const u = q.userById.get(id);
    if (!u) return { status: 404, body: { error: 'Нет такого пользователя' } };
    const blocked = body.blocked !== false;
    const owner = u.is_admin || ADMIN_EMAILS.includes(String(u.email || '').toLowerCase());
    if (blocked && owner) return { status: 409, body: { error: 'Владельца площадки заблокировать нельзя' } };
    q.setBlocked.run(blocked ? 1 : 0, id);
    if (blocked) q.delUserSessions.run(id);
    cardsCache.at = 0; lbCache.at = 0; tsumCache.at = 0;
    /* доски заданий прячут заблокированных — пересчитать сразу, а не через минуту */
    vidBoards.clear();
    adminLog(req, blocked ? 'user-block' : 'user-unblock', 'user ' + id,
      (u.email || '') + (body.reason ? ' · ' + String(body.reason).slice(0, 200) : ''));
    return { status: 200, body: { ok: true, userId: id, blocked } };
  },

  /* Удаление данных пользователя по его обращению (10.10.2026; политика
     конфиденциальности, раздел 7 — для проверки Google и TikTok нужен
     работающий путь удаления). Строку users не стираем — на неё ссылаются
     журнал денег, выводы и проверка личности, которые закон велит хранить, —
     а обезличиваем: почта, имя, пароль, входы через Telegram и Google
     стираются, вход закрыт навсегда. Удаляются: сессии, подписки на
     уведомления, подключённые каналы с доступом к площадкам и снимками
     статистики, карты блогера и их следы, личные конверты (профиль,
     настройки, свободные дни) и личные сообщения в обе стороны, участие в
     заданиях; у его роликов — ссылка, название и ник (цифры и суммы
     остаются в расчётах заданий). Задания, которые он создал, пропадают из
     общего списка вместе с аккаунтом (конверты заблокированных не
     показываются), а их условия остаются в записях о выплатах блогерам.
     Нельзя, пока на счёте есть деньги или по его роликам либо заданиям
     идут проверка и подсчёт — сначала вывод, возврат, конец подсчёта.
     confirm: 'erase' — защита от случайного нажатия. */
  'POST /api/admin/users/erase': async (req, body) => {
    if (!isAdmin(req)) return { status: 403, body: { error: 'Только владелец площадки' } };
    const id = Number(body.userId);
    if (!Number.isInteger(id) || id <= 0) return { status: 400, body: { error: 'Нужен номер пользователя' } };
    if (body.confirm !== 'erase') return { status: 400, body: { error: 'Нужно подтверждение: confirm = "erase"' } };
    const u = q.userById.get(id);
    if (!u) return { status: 404, body: { error: 'Нет такого пользователя' } };
    if (u.is_admin || ADMIN_EMAILS.includes(String(u.email || '').toLowerCase())) {
      return { status: 409, body: { error: 'Аккаунт владельца площадки так не удаляется' } };
    }
    if (/@erased\.invalid$/.test(String(u.email || ''))) {
      return { status: 409, body: { error: 'Данные этого пользователя уже удалены', code: 'already' } };
    }
    const b = q.balance.get(id) || {};
    if (Number(b.available) || Number(b.hold)) {
      return { status: 409, body: { error: 'На счёте остались деньги: доступно ' + (Number(b.available) || 0) + ' ₽, в заморозке '
        + (Number(b.hold) || 0) + ' ₽. Сначала вывод или возврат — потом удаление.', code: 'money' } };
    }
    const live = Number(db.prepare(`SELECT COUNT(*) AS n FROM task_videos
      WHERE (blogger_id = ? OR owner_id = ?) AND status IN ('review','active','rejected')`).get(id, id).n) || 0;
    if (live) {
      return { status: 409, body: { error: 'По роликам этого человека или его заданиям ещё идут проверка или подсчёт ('
        + live + '). Удалить можно, когда подсчёт закончится.', code: 'videos_live' } };
    }
    /* Открытый счёт (аудит 16.10.2026): клиент мог его оплатить уже после
       удаления — деньги легли бы на обезличенный аккаунт без входа. */
    const invOpen = Number((qi.openByUser.get(id) || {}).n) || 0;
    if (invOpen) {
      return { status: 409, body: { error: 'У человека открытые заявки на счёт (' + invOpen + '). Зачислите или закройте их'
        + ' в разделе «Счета» — потом удаление.', code: 'invoices' } };
    }
    const n = {};
    const run = (k, sql, ...a) => { n[k] = Number(db.prepare(sql).run(...a).changes) || 0; };
    db.exec('BEGIN IMMEDIATE');
    try {
      run('sessions', 'DELETE FROM sessions WHERE user_id = ?', id);
      run('push', 'DELETE FROM push_subs WHERE user_id = ?', id);
      run('tokens', 'DELETE FROM channel_tokens WHERE user_id = ?', id);
      run('stats', 'DELETE FROM channel_stats WHERE user_id = ?', id);
      run('channels', 'DELETE FROM channels WHERE user_id = ?', id);
      run('cards', 'DELETE FROM cards WHERE user_id = ?', id);
      run('tombs', 'DELETE FROM card_tombs WHERE user_id = ?', id);
      run('self', `DELETE FROM sync WHERE a_id = ? AND kind IN ('prof','mine','slot')`, id);
      run('dm', `DELETE FROM sync WHERE kind IN ('dm','dmr') AND (a_id = ? OR b_id = ?)`, id, id);
      run('members', 'DELETE FROM task_members WHERE user_id = ?', id);
      run('videos', 'UPDATE task_videos SET url = NULL, title = NULL, handle = NULL WHERE blogger_id = ?', id);
      run('errors', 'UPDATE errors SET user_id = NULL WHERE user_id = ?', id);
      db.prepare(`UPDATE users SET email = ?, name = ?, pass_salt = ?, pass_hash = ?, is_blocked = 1,
        tg_id = NULL, google_sub = NULL WHERE id = ?`)
        .run('erased-' + id + '@erased.invalid', 'Удалённый пользователь',
          crypto.randomBytes(16).toString('hex'), crypto.randomBytes(32).toString('hex'), id);
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch (_) {}
      throw e;
    }
    cardsCache.at = 0; cardsCache.rows = null; lbCache.at = 0; tsumCache.at = 0;
    try { vidBoards.clear(); } catch (e) { /* доски соберутся заново */ }
    adminLog(req, 'user-erase', 'user ' + id,
      'данные удалены по обращению' + (body.reason ? ' · ' + String(body.reason).slice(0, 200) : '')
      + ' · ' + Object.keys(n).map((k) => k + ' ' + n[k]).join(', '));
    return { status: 200, body: { ok: true, userId: id, removed: n } };
  },

  /* Журнал действий владельца — кто и что сделал в пульте. */
  'GET /api/admin/log': async (req, body, url) => {
    if (!isAdmin(req)) return { status: 403, body: { error: 'Только владелец площадки' } };
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 200));
    return { status: 200, body: { rows: q.adminLogList.all(limit) } };
  },

  /* Сводка и сверка: сумма журнала должна сходиться сама с собой. */
  /* Приложение спрашивает, показывать ли админ-разделы, и может один раз
     обменять ключ владельца на постоянные права для своего аккаунта —
     чтобы дальше ключ уже нигде не вводить. */
  /* Один вход на всё: ключ (или уже выполненный вход владельца) в обмен
     на сессию. После этого ни приложение, ни пульт выплат ключ не
     спрашивают, пока сессия не кончилась. */
  'POST /api/admin/session': async (req, body) => {
    if (!rateLimit(req, 'admsess', 20, 60000)) return tooOften;
    const u = auth(req);
    /* уже владелец — по аккаунту, по ключу в заголовке или по живой сессии */
    let pass = isAdmin(req);
    /* переход из приложения во внешний браузер */
    if (!pass && body && body.ticket) pass = ticketOk(body.ticket);
    if (!pass) {
      if (adminBlocked(req)) {
        return { status: 429, body: { error: 'Слишком много попыток — подождите десять минут' } };
      }
      const given = String((body && body.key) || req.headers['x-admin-key'] || '');
      /* Ключа нет вовсе — это не подбор (аудит 16.10.2026): вход «почтой»
         обычным аккаунтом считался промахом ключа, 8 таких входов запирали
         ключ и Телеграм на 10 минут и слали тревогу «ошибся ключом».
         Негодный билет по-прежнему считается промахом. */
      if (!given) {
        if (body && body.ticket) adminMissed(req);
        return { status: 403, body: { error: u ? 'Этот аккаунт не владелец площадки' : 'Нужен ключ владельца' } };
      }
      const a = Buffer.from(given, 'utf8'), b = Buffer.from(ADMIN_KEY, 'utf8');
      pass = !!(b.length && a.length === b.length && crypto.timingSafeEqual(a, b));
      /* ключ из заголовка уже посчитал isAdmin — второй раз не считаем */
      if (!pass) { if (!req.headers['x-admin-key']) adminMissed(req); return { status: 403, body: { error: 'Ключ владельца не подошёл' } }; }
    }
    const until = Date.now() + ADMIN_SESSION_MS;
    /* Кто входит — пишется в куку и потом в журнал действий. */
    const who = (u && u.is_admin) ? String(u.email || ('id ' + u.id))
      : (adminCookieWho(req) || (body && body.ticket ? 'билет из приложения' : 'ключ владельца'));
    return {
      status: 200,
      body: {
        ok: true, until, who,
        by: (u && u.is_admin) ? 'аккаунт' : (body && body.ticket ? 'билет' : 'ключ'),
        /* билет отдаём только приложению — чтобы открыть пульт без ключа */
        ticket: (body && body.wantTicket) ? ticketMake() : undefined,
      },
      headers: { 'Set-Cookie': adminCookie(req, until, who) },
    };
  },

  /* ── Вход владельца из Телеграма (15.10.2026) ──────────────────────
     Кнопка «Админ панель» в боте (только в чате владельца) открывает /admin
     мини-приложением Телеграма. Страница присылает initData — строку,
     подписанную ключом бота; сервер проверяет подпись (checkInitData),
     свежесть (10 минут) и что это САМ владелец: его Телеграм-id совпадает с
     ADMIN_CHAT_ID (личный чат владельца с ботом — тот же номер) или есть в
     списке ADMIN_TG_IDS. Тогда — та же сессия-кука, что после ключа.
     Неудачи считаются промахами (adminMissed): перебор упрётся в замок. */
  'POST /api/admin/tg-session': async (req, body) => {
    if (!rateLimit(req, 'admtg', 20, 60000)) return tooOften;
    if (adminBlocked(req)) {
      return { status: 429, body: { error: 'Слишком много попыток — подождите десять минут' } };
    }
    const ids = adminTgIds();
    if (!ids.length) return { status: 503, body: { error: 'Вход через Телеграм не настроен: нет ADMIN_CHAT_ID' } };
    const check = checkInitData(String((body && body.initData) || ''), 600);
    if (!check.ok) { adminMissed(req); return { status: 403, body: { error: check.why } }; }
    const id = String(check.tg.id);
    if (!ids.includes(id)) {
      adminMissed(req);
      return { status: 403, body: { error: 'Этот Телеграм-аккаунт не владелец площадки' } };
    }
    const until = Date.now() + ADMIN_SESSION_MS;
    const who = 'Телеграм ' + (check.tg.username ? '@' + String(check.tg.username).slice(0, 40)
      : String(check.tg.first_name || '').slice(0, 40)) + ' (' + id + ')';
    return { status: 200, body: { ok: true, until, who, by: 'телеграм' },
      headers: { 'Set-Cookie': adminCookie(req, until, who) } };
  },

  /* Проверка: пустит ли сервер без ключа. Страница пульта спрашивает это
     первым делом и показывает поле ключа, только если ответ «нет». */
  'GET /api/admin/session': async (req) => {
    const ok = isAdmin(req);
    let who = '';
    if (ok) { try { const u = auth(req); who = (u && u.is_admin) ? String(u.email || '') : adminCookieWho(req); } catch (e) { who = ''; } }
    return { status: 200, body: { ok, until: 0, who } };
  },

  /* ── Полный доступ к сайту (как до переделки под More Views) ──
     Кнопка в админке ставит в браузере флаг bp_full_access и открывает
     сайт; сайт при старте спрашивает здесь, правда ли перед ним владелец.
     Проверка та же, что у всех /api/admin/* (isAdmin): сессия-кука пульта
     (на GET хватает её одной), аккаунт владельца или ключ. Ничего не
     меняет и не кэшируется.
     Отказ — 403, а не 401: на 401 с токеном приложение считает, что
     кончился вход в аккаунт, и выкидывает человека из кассы. */
  'GET /api/admin/full-access': async (req) => {
    const nc = { 'Cache-Control': 'no-store, private' };
    if (!rateLimit(req, 'fullacc', 60, 60000)) return { status: 429, body: tooOften.body, headers: nc };
    if (!isAdmin(req)) {
      return { status: 403, headers: nc,
        body: { ok: false, code: 'not_admin', error: 'Полный доступ — только владельцу: войдите в админку /admin' } };
    }
    const c = adminCookieParse(req);
    return { status: 200, headers: nc, body: { ok: true, full: true, until: c ? c.exp : 0 } };
  },

  'POST /api/admin/logout': async () => ({
    status: 200,
    body: { ok: true },
    headers: { 'Set-Cookie': 'bp_admin=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0' },
  }),

  'GET /api/admin/whoami': async (req) => {
    const u = auth(req);
    if (!u) return { status: 401, body: { error: 'Нужен вход' } };
    syncAdminFlag(u);
    return { status: 200, body: { isAdmin: !!u.is_admin, email: u.email, name: u.name } };
  },

  'POST /api/admin/claim': async (req, body) => {
    if (!rateLimit(req, 'claim', 10, 60000)) return tooOften;
    const u = auth(req);
    if (!u) return { status: 401, body: { error: 'Нужен вход' } };
    if (u.is_admin) return { status: 200, body: { ok: true, isAdmin: true, already: true } };
    if (adminBlocked(req)) {
      return { status: 429, body: { error: 'Слишком много попыток — подождите десять минут' } };
    }
    const key = String(body.key || '');
    /* Сравниваем байты, а не символы: ключ из двухбайтовых символов
       нужной длины ронял timingSafeEqual (та же ловушка, что в isAdmin). */
    const kb = Buffer.from(key, 'utf8'), ab = Buffer.from(ADMIN_KEY, 'utf8');
    const okKey = !!ADMIN_KEY && kb.length === ab.length && crypto.timingSafeEqual(kb, ab);
    if (!okKey) {
      adminMissed(req);
      return { status: 403, body: { error: 'Ключ владельца не подошёл' } };
    }
    q.setAdmin.run(1, u.id);
    try { db.prepare('UPDATE users SET admin_fp = ? WHERE id = ?').run(ADMIN_FP, u.id); } catch (e) { /* колонка есть всегда */ }
    return { status: 200, body: { ok: true, isAdmin: true } };
  },

  /* ── «ЗАГРУЗИТЬ ВИДЕО» (механика v3, server/VIDEO-SPEC.md, раздел 11) ──
     Блогер загружает ролик со своего подтверждённого TikTok или YouTube
     сразу после публикации — с любым числом просмотров, хоть с нулём.
     Всё, что касается цифр и денег, сервер узнаёт сам: от клиента
     приходят только ссылка, номер задания и (по желанию) выбранный
     аккаунт. minViews — порог начала начислений, а не условие загрузки. */
  'POST /api/tasks/video/bind': async (req, body) => {
    const u = auth(req);
    if (!u) return vidFail('auth');
    if (!rateLimit(req, 'vbind:' + u.id, 10, 60000)) return vidFail('often');
    const link = vidLink(body.url);
    if (!link) return vidFail('bad_url');
    const p = link.platform;
    /* Площадку определяет ссылка. Выбранный аккаунт другой площадки —
       это не «не ваш ролик», а промах в окне: говорим прямо, что не так. */
    const want = body.platform == null || body.platform === '' ? '' : vidPlatNorm(body.platform);
    if (VID_PLAT[want] && want !== p) return vidFail('wrong_link', { p, other: want });
    /* Галочку «в видео есть реклама» владелец убрал (07.10): блок с
       предупреждением в окне остался, интеграцию проверяет рекламодатель. */
    const campId = String(body.campId == null ? '' : body.campId).slice(0, 80);
    const ci = campId ? vidCamp(campId) : null;
    if (!ci) return vidFail('no_camp');
    if (!vidCampOpen(ci, campId)) return vidFail('camp_closed');
    if (ci.env.a_id === u.id) return vidFail('own_camp');
    if (!vidCampAllows(ci.camp, p)) return vidFail('wrong_platform', { list: vidCampPlatNames(ci.camp) });
    /* Бюджет: свободное = остаток заморозки минус резервы роликов, которые
       ещё ждут решения. Проверяем до площадки — и ещё раз перед записью. */
    if (vidFree(campId) <= 0) return vidFail('budget');

    const all = q.vidChannels.all(u.id, p);
    if (!all.length) return vidFail('no_channel', { p });
    const account = body.account == null || body.account === '' ? '' : String(body.account).slice(0, 200);
    let chans = all;
    if (account) {
      const one = all.find((c) => String(c.external_id) === account);
      if (!one) return vidFail('no_account', { p });
      chans = [one];
    }
    /* Свой уже загруженный ролик — отвечаем сразу, площадку не спрашиваем:
       повтор одной ссылки не должен тратить квоту YouTube. Чужой ролик
       идёт обычным путём (ответ «не ваш», а не «кто-то уже загрузил»). */
    const known = link.id ? q.vidByVideo.get(p, link.id) : null;
    if (known && known.blogger_id === u.id) return vidFail('taken', { p });
    if (p === 'youtube') {
      /* Квота YouTube — общая на проект: загрузки берут не больше своей
         доли (запас — под замеры при зачёте), и один человек — не больше
         VID_YT_HOUR проверок в час, с любого адреса. */
      if (!ytBindRoom()) return vidFail('yt_quota', { p });
      if (!vidUserQuota(vidYtHour, u.id, VID_YT_HOUR, 3600000)) return vidFail('often', { p, hour: true });
    }
    const found = await vidLocate(u.id, link, chans, !!account);
    if (found.fail) return vidFail(found.fail, Object.assign({ p }, found.x || {}));
    const owner = found.owner, v = found.v, id = found.id;
    /* YouTube Shorts (15.10.2026): Shorts ли ролик — отмечаем у каждого
       YouTube-ролика (по ней приложение пишет «YouTube Shorts»); задание
       «только Shorts» обычное видео не принимает. Instagram — всегда Reels. */
    let vkind = p === 'instagram' ? 'reels' : null;
    if (p === 'youtube') {
      const sh = await ytIsShort(id);
      /* «YouTube Shorts» на ролике — только наверняка: страница ответила или
         ссылка сама /shorts/. Короткое обычное видео без связи с youtube.com
         раньше подписывалось как Shorts. */
      if (sh === true || (sh == null && link.shorts)) vkind = 'shorts';
      if (vidCampShortsOnly(ci.camp)) {
        /* Приём в задание «только Shorts» решают только данные сервера:
           страница YouTube или (если она не открылась) длительность из API —
           Shorts до 3 минут. Форму ссылки задаёт сам блогер: обычное видео
           под адресом /shorts/<id> проходило бы проверку. */
        const ok = sh === true || (sh == null && v.duration != null && v.duration <= 180);
        if (!ok) return vidFail('not_shorts', { p });
        vkind = 'shorts';
      }
    }
    /* Пока ждали площадку, канал могли отвязать (сам блогер или владелец),
       а задание — закрыть. Дальше до записи await нет. */
    if (!q.channelOf.get(u.id, p, String(owner.external_id))) return vidFail(account ? 'no_account' : 'no_channel', { p });
    const ciNow = vidCamp(campId);
    if (!ciNow || !vidCampOpen(ciNow, campId)) return vidFail('camp_closed');

    /* Ролик снят до оффера — значит не под него. Десять минут запаса на
       расхождение часов. После срока задания — не оплачивается. */
    const created = vidCampCreated(ci);
    if (created && v.at && v.at * 1000 < created - 10 * 60000) return vidFail('too_old', { p });
    const dl = vidDeadline(ci.camp.deadline);
    if (dl && v.at && v.at * 1000 > dl + 10 * 60000) return vidFail('too_late', { p });
    const minSec = Math.max(0, Math.round(Number(ci.camp.minDuration || ci.camp.videoMinSec) || 0));
    if (minSec && v.duration != null && v.duration < minSec) return vidFail('too_short', { p, n: minSec });
    if (q.vidByVideo.get(p, id)) return vidFail('taken', { p });
    /* v3: мало просмотров — не причина отказа. minViews остаётся в снимке
       условий и решает только, с какого момента пойдут начисления. */
    const terms = vidTermsOf(ci.camp);
    const free = vidFree(campId);
    if (free <= 0) return vidFail('budget');
    /* Ролик уже сейчас стоит больше, чем свободно в бюджете, — принимаем,
       но платить за него будем не больше этого остатка: предел пишется в
       снимок условий (limit), иначе резерв ушёл бы за бюджет и «Свободно»
       стало бы отрицательным. */
    if (vidEarnBy(terms, v.views) > free) terms.limit = free;
    /* Длину ролика площадка не сообщила (Instagram её не отдаёт вовсе,
       VIDEO-SPEC §12.3): правило «мин. N сек» сервер проверить не может.
       Не молчим (аудит 16.10.2026, #27): пометка в снимке условий —
       рекламодатель видит «длину проверьте сами» в карточке и в
       уведомлении, блогер — что ролик короче N сек не засчитают. */
    if (minSec && v.duration == null) terms.durUnchecked = minSec;

    const now = Date.now();
    const handle = p === 'youtube'
      ? (vidNick(owner.username) || v.channelTitle || '')
      : p === 'instagram'
        ? vidNick(owner.username)
        : (vidHandleOf(v.share) || vidHandleOf((found.page || link.url).pathname) || vidNick(owner.username));
    const url = p === 'youtube'
      ? (link.shorts || vkind === 'shorts' ? 'https://www.youtube.com/shorts/' : 'https://www.youtube.com/watch?v=') + id
      : p === 'instagram'
        ? (v.share || 'https://www.instagram.com/reel/' + (v.code || link.code) + '/')
        : vidCanon(v.share, handle, id, found.page);
    let rowId;
    try {
      const info = q.vidIns.run(campId, ci.env.a_id, u.id, p, String(owner.external_id), id,
        url, handle || null, v.title || null, v.duration,
        v.at ? v.at * 1000 : null, v.views, v.likes, v.comments, v.shares, now,
        JSON.stringify(terms), v.views, vidEarnBy(terms, v.views), v.views, now, now, now);
      rowId = Number(info.lastInsertRowid);
    } catch (e) {
      /* Два одновременных запроса с одним роликом: второй упрётся в UNIQUE. */
      if (/UNIQUE/i.test(String((e && e.message) || ''))) return vidFail('taken', { p });
      throw e;
    }
    /* Загрузил видео — значит участник задания, даже если приложение
       старое и о вступлении сервер не знал. */
    try { q.tmJoin.run(campId, u.id, now); } catch (e) { /* участник — не главное */ }
    q.vidSnap.run(rowId, dayOf(now), v.views, v.likes, v.comments, v.shares, now);
    if (vkind) vidKindSet.run(vkind, rowId);
    if (v.cover) vidCoverSet(rowId, v.cover);
    vidJudge(q.vidById.get(rowId), v);
    vidBoardDrop(campId);
    const name = vidCampName(ci);
    /* Загрузил → отвязал → загрузил: рекламодателю о том же ролике в том
       же задании пишем не чаще раза в сутки, иначе это рассылка спама его
       руками. */
    if (vidOnce(vidBindSeen, campId + '|' + id)) {
      vidNotify(ci.env.a_id, 'Новое видео по заданию', '«' + name + '»: проверьте интеграцию'
        + (terms.durUnchecked ? '. ' + vidPlatName(p) + ' не сообщает длину ролика — проверьте сами, что он не короче '
          + terms.durUnchecked + ' сек' : ''), '/?go=campaigns');
    }
    return { status: 200, body: { ok: true, video: vidDTO(q.vidById.get(rowId), 'blogger') } };
  },

  /* Аккаунты для окна «Загрузка видео»: свои подтверждённые каналы TikTok
     и YouTube. ready = false — спросить площадку нечем (доступ протух и
     обновить его нечем): такой аккаунт надо переподключить. */
  'GET /api/tasks/video/accounts': async (req) => {
    const u = auth(req);
    if (!u) return vidFail('auth');
    if (!rateLimit(req, 'vacc:' + u.id, 60, 60000)) return vidFail('often');
    const accounts = q.vidAccounts.all(u.id).map((c) => {
      const ready = vidReady(c);
      const nick = vidNick(c.username);
      return {
        platform: c.platform, id: String(c.external_id),
        handle: nick ? '@' + nick : '', title: String(c.title || '').slice(0, 80),
        avatar: vidHttps(c.avatar), ready, why: ready ? '' : 'token',
      };
    });
    return { status: 200, body: { ok: true, accounts } };
  },

  /* Вступление в задание. До v2 оно жило только в приложении, и сервер не
     знал участников — не из чего было собрать список и лидерборд. */
  'POST /api/tasks/join': async (req, body) => {
    const u = auth(req);
    if (!u) return vidFail('auth');
    if (!rateLimit(req, 'tjoin:' + u.id, 30, 60000)) return vidFail('often');
    const campId = String(body.campId == null ? '' : body.campId).slice(0, 80);
    const ci = campId ? vidCamp(campId) : null;
    if (!ci) return vidFail('no_camp');
    if (ci.env.a_id === u.id) return vidFail('own_camp');
    const was = q.tmGet.get(campId, u.id);
    if (was && was.left_at == null) {
      return { status: 200, body: { ok: true, already: true, joinedAt: was.joined_at } };
    }
    /* Вступить — только в задание, бюджет которого заморожен сейчас и не
       исчерпан (аудит 16.10.2026): раньше хватало слова «active» в
       конверте — вступали в «задание» без единого рубля и в удалённое
       (деньги возвращены, конверт остался прежним). */
    if (!vidCampOpen(ci, campId)) {
      return { status: 409, body: { error: 'Задание сейчас не принимает участников', code: 'camp_closed' } };
    }
    const now = Date.now();
    q.tmJoin.run(campId, u.id, now);
    vidBoardDrop(campId);
    const m = q.tmGet.get(campId, u.id);
    return { status: 200, body: { ok: true, already: false, joinedAt: m ? m.joined_at : now } };
  },

  'POST /api/tasks/leave': async (req, body) => {
    const u = auth(req);
    if (!u) return vidFail('auth');
    if (!rateLimit(req, 'tleave:' + u.id, 30, 60000)) return vidFail('often');
    const campId = String(body.campId == null ? '' : body.campId).slice(0, 80);
    if (!campId) return vidFail('no_camp');
    const info = q.tmLeave.run(Date.now(), campId, u.id);
    vidBoardDrop(campId);
    return { status: 200, body: { ok: true, left: Number(info.changes || 0) > 0 } };
  },

  /* Страница задания, как у More Views: счётчики, полоса бюджета,
     лидерборд и участники. Видит любой вошедший — задание и его лидерборд
     открыты всем. Наружу только имя из профиля, ник и аватар
     подтверждённого аккаунта и цифры по этому заданию: ни почты, ни
     номеров аккаунтов, ни внешних id каналов (номер участника — только
     автору задания, см. vidBoardOut). */
  'GET /api/tasks/board': async (req, body, url) => {
    const u = auth(req);
    if (!u) return vidFail('auth');
    if (!rateLimit(req, 'vboard:' + u.id, 120, 60000)) return vidFail('often');
    const campId = String(url.searchParams.get('campId') || '').slice(0, 80);
    const ci = campId ? vidCamp(campId) : null;
    if (!ci) return vidFail('no_camp');
    const offset = Math.min(100000, Math.max(0, Math.floor(Number(url.searchParams.get('offset')) || 0)));
    const lim0 = Math.floor(Number(url.searchParams.get('limit')) || 0);
    const limit = lim0 > 0 ? Math.min(100, lim0) : 100;
    /* Как у More Views: по умолчанию «по сумме выплаты», можно «по просмотрам». */
    const sort = url.searchParams.get('sort') === 'views' ? 'views' : 'earned';
    const agg = vidBoardAgg(campId);
    const page = vidBoardPage(agg, campId, offset, limit);
    const board = vidBoardSorted(agg, sort);
    const mine = board.mine.get(u.id) || null;
    const memb = q.tmGet.get(campId, u.id);
    const isOwn = ci.env.a_id === u.id;
    return { status: 200, body: {
      ok: true, campId, sort,
      members: agg.members, videos: agg.videos, views: agg.views,
      paid: agg.paid, reserved: agg.reserved, budget: agg.budget, left: agg.left,
      /* выплачено «на баланс» блогерам (за вычетом комиссии с каждого ролика) */
      paidNet: agg.paidNet,
      /* комиссии задания (14.10.2026): с рекламодателя сверху бюджета и с выплат блогерам */
      feePct: agg.feePct, payFeePct: agg.payFeePct,
      /* автору — сколько можно вернуть в кошелёк сейчас (не из кэша доски) */
      free: isOwn ? vidReturnable(campId) : undefined,
      /* автору — что вернёт «Завершить задание»: остаток и комиссия */
      close: isOwn ? vidCloseOut(campId) : undefined,
      leaders: vidBoardOut(board.leaders, board.uids, u.id, isOwn),
      participants: vidBoardOut(page.rows, page.uids, u.id, isOwn), offset, limit,
      more: offset + page.rows.length < agg.members,
      me: {
        rank: mine ? mine.rank : null,
        videos: mine ? mine.videos : 0, views: mine ? mine.views : 0, earned: mine ? mine.earned : 0,
        earnedNet: mine ? mine.earnedNet || 0 : 0,
        joined: !!(memb && memb.left_at == null), owner: ci.env.a_id === u.id,
      },
    } };
  },

  /* «Чат» у участника задания (10.10.2026): в строках доски номера
     аккаунта нет (кроме ответа автору задания), есть только who. Номер
     для доставки сообщения приложение спрашивает здесь — в момент, когда
     человек нажал «Чат», а не для всех строк сразу. Ищем только среди
     участников этого задания; частота ограничена. */
  'POST /api/tasks/peer': async (req, body) => {
    const u = auth(req);
    if (!u) return vidFail('auth');
    if (!rateLimit(req, 'vpeer:' + u.id, 30, 60000)) return vidFail('often');
    const campId = String(body.campId || '').slice(0, 80);
    const who = String(body.who || '');
    if (!campId || !/^[A-Za-z0-9_-]{10,40}$/.test(who)) return { status: 400, body: { error: 'Нужны campId и who' } };
    if (!vidCamp(campId)) return vidFail('no_camp');
    let uid = null;
    for (const r of vidPeerIds.all(campId, campId)) {
      if (vidWhoKey(r.id) === who) { uid = Number(r.id); break; }
    }
    const p = uid != null ? q.userById.get(uid) : null;
    if (!p || p.is_blocked) return { status: 404, body: { error: 'Участник не найден', code: 'no_peer' } };
    if (p.id === u.id) return { status: 400, body: { error: 'Это вы', code: 'self' } };
    return { status: 200, body: { ok: true, uid: p.id } };
  },

  /* Список: автору оффера — все ролики оффера, блогеру — свои. */
  'GET /api/tasks/videos': async (req, body, url) => {
    const u = auth(req);
    if (!u) return vidFail('auth');
    if (!rateLimit(req, 'vlist:' + u.id, 120, 60000)) return vidFail('often');
    const campId = String(url.searchParams.get('campId') || '').slice(0, 80);
    let rows;
    if (campId) {
      const env = q.syncGet.get('camp', campId);
      rows = env && env.a_id === u.id ? q.vidByCamp.all(campId) : q.vidMineCamp.all(campId, u.id);
    } else {
      rows = q.vidMineAll.all(u.id, u.id);
    }
    return { status: 200, body: { ok: true,
      videos: rows.map((r) => vidDTO(r, r.owner_id === u.id ? 'owner' : 'blogger')) } };
  },

  /* Один ролик с историей по дням — участнику или владельцу площадки.
     Постороннему — «нет такого», а не «нельзя»: номера не перебрать. */
  'GET /api/tasks/video': async (req, body, url) => {
    const u = auth(req);
    const admin = isAdmin(req);
    if (!u && !admin) return vidFail('auth');
    const row = q.vidById.get(Number(url.searchParams.get('id')) || 0);
    const view = !row ? null : admin ? 'admin'
      : row.owner_id === u.id ? 'owner' : row.blogger_id === u.id ? 'blogger' : null;
    if (!view) return vidFail('no_video');
    return { status: 200, body: { ok: true, video: vidDTO(row, view, { history: true }) } };
  },

  /* Проверка интеграции автором оффера: «всё верно» — ролик засчитан,
     сразу первый замер и первое начисление, дальше VID_TRACK_DAYS суток
     сервер сам доначисляет по мере роста просмотров; «есть проблема» —
     сразу владельцу площадки. settle — чем кончилось начисление:
     active (считаем дальше; paid — сколько начислено сейчас), paid
     (подсчёт сразу закончен — максимум за ролик), held (накрутка, спор,
     деньги, доступ), wait (площадка не ответила — начислим на следующем
     круге), removed (ролика нет), fail. */
  'POST /api/tasks/video/review': async (req, body) => {
    const u = auth(req);
    if (!u) return vidFail('auth');
    if (!rateLimit(req, 'vreview:' + u.id, 60, 60000)) return vidFail('often');
    const row = q.vidById.get(Number(body.id) || 0);
    if (!row || (row.owner_id !== u.id && row.blogger_id !== u.id)) return vidFail('no_video');
    if (row.owner_id !== u.id) {
      return { status: 403, body: { error: 'Интеграцию проверяет автор задания', code: 'forbidden' } };
    }
    if (row.status !== 'review') {
      return { status: 409, body: { error: 'Это видео уже проверено', code: 'state' } };
    }
    const now = Date.now();
    const ci = vidCamp(row.camp_id);
    const name = vidCampName(ci);
    let res = null;
    if (body.ok === true) {
      const info = q.vidAccept.run(now, now, now + VID_TRACK_MS, now, row.id);
      if (!info.changes) return { status: 409, body: { error: 'Это видео уже проверено', code: 'state' } };
      try { res = await vidAccrue(row.id, { accept: true }); }
      catch (e) { console.error('[видео] начисление при зачёте упало:', (e && e.message) || e); res = { state: 'fail' }; }
    } else if (body.ok === false) {
      const reason = String(body.reason == null ? '' : body.reason).trim();
      if (reason.length < 5 || reason.length > 500) {
        return { status: 400, body: { error: 'Опишите проблему: от 5 до 500 символов', code: 'reason' } };
      }
      const info = q.vidReviewBad.run(reason, now, now, row.id);
      if (!info.changes) return { status: 409, body: { error: 'Это видео уже проверено', code: 'state' } };
      tgAlert('vid:rej:' + row.id,
        '↩️ Рекламодатель вернул видео (' + vidPlatName(row.platform) + ')\n\nПричина: ' + reason
        + '\nЗадание: «' + name + '» (' + row.camp_id + ')'
        + '\nРекламодатель: ' + vidWho(row.owner_id)
        + '\nБлогер: ' + vidWho(row.blogger_id)
        + '\nВидео: ' + (row.url || '')
        + '\n\nРешение за вами: ' + PUBLIC_URL + '/admin', 'server');
      vidNotify(row.blogger_id, 'Видео на проверке у администратора',
        '«' + name + '»: рекламодатель указал проблему — решение примет администратор', '/?go=tasks');
    } else {
      return { status: 400, body: { error: 'Нужен ответ: ok true или false', code: 'ok' } };
    }
    vidBoardDrop(row.camp_id);
    return { status: 200, body: { ok: true, settle: res ? res.state : null, paid: res && res.paid ? res.paid : 0,
      total: res && res.total ? res.total : 0, video: vidDTO(q.vidById.get(row.id), 'owner') } };
  },

  /* Ошибся ссылкой — убрать свою загрузку можно, пока её не проверили. */
  'POST /api/tasks/video/unbind': async (req, body) => {
    const u = auth(req);
    if (!u) return vidFail('auth');
    /* Пять в час: отвязка + новая загрузка — это новое письмо рекламодателю. */
    if (!rateLimit(req, 'vunbind:' + u.id, 5, 3600000)) return vidFail('often');
    const row = q.vidById.get(Number(body.id) || 0);
    if (!row || (row.owner_id !== u.id && row.blogger_id !== u.id)) return vidFail('no_video');
    if (row.blogger_id !== u.id) {
      return { status: 403, body: { error: 'Отвязать видео может только блогер', code: 'forbidden' } };
    }
    if (row.status !== 'review') {
      return { status: 409, body: { error: 'Видео уже проверено — отвязать его нельзя', code: 'state' } };
    }
    if (!q.vidDel.run(row.id).changes) {
      return { status: 409, body: { error: 'Видео уже проверено — отвязать его нельзя', code: 'state' } };
    }
    q.vidDelHist.run(row.id);
    vidCovers.delete(row.id);
    vidBoardDrop(row.camp_id);
    return { status: 200, body: { ok: true, id: row.id } };
  },

  /* «Обновить сейчас». Засчитанный ролик (active) — это замер и
     начисление прибавки той же дорогой, что у круга (vidAccrue), и не
     чаще раза в 20 часов: сервер и так считает его раз в сутки. Ролик на
     проверке — не чаще раза в 10 минут. Закрытый подсчётом (paid) —
     только для показа и только до конца срока подсчёта. */
  'POST /api/tasks/video/refresh': async (req, body) => {
    const u = auth(req);
    if (!u) return vidFail('auth');
    if (!rateLimit(req, 'vrefresh:' + u.id, 20, 60000)) return vidFail('often');
    const row = q.vidById.get(Number(body.id) || 0);
    if (!row || (row.owner_id !== u.id && row.blogger_id !== u.id)) return vidFail('no_video');
    const view = row.owner_id === u.id ? 'owner' : 'blogger';
    const now = Date.now();
    const tracked = row.status === 'paid' && vidTracked(row, now);
    if (row.status !== 'review' && row.status !== 'active' && !tracked) {
      return { status: 409, body: { error: 'Цифры этого видео больше не обновляются', code: 'state' } };
    }
    /* Порог — по последней ПОПЫТКЕ, а не по удачному замеру: иначе ролик,
       который площадка не отдаёт, дёргали бы на каждое нажатие.
       Замороженный не обновляется вовсе. */
    const tried = Math.max(row.last_try_at || 0, row.stats_at || 0);
    /* Пауза «нет доступа»: блогер переподключил канал и жмёт «Обновить» —
       подсчёт должен продолжиться сразу, а не через сутки. */
    const accessHeld = row.status === 'active' && !!row.pay_hold && row.hold_kind === 'access';
    const gap = row.status === 'active' && !accessHeld ? VID_MANUAL_ACTIVE_MS : 10 * 60000;
    if ((tried && now - tried < gap) || row.frozen) {
      return { status: 200, body: { ok: true, video: vidDTO(row, view), fresh: false } };
    }
    /* Нет доступа к аккаунту блогера (token/scope/no_channel): блогеру —
       просьба переподключить, а рекламодателю она ни к чему — чужой
       аккаунт он не переподключит. Ему — карточка ролика (пауза видна по
       holdKind) и свой текст (аудит 16.10.2026, #30). */
    const ownerAccess = (code) => {
      if (view !== 'owner' || !VID_ACCESS_FAIL.has(code)) return null;
      const cur = q.vidById.get(row.id) || row;
      return { status: 200, body: { ok: true, video: vidDTO(cur, view), fresh: false, wait: 'access',
        note: 'Блогер потерял доступ к аккаунту ' + vidPlatName(row.platform) + ' — цифры обновятся, когда он переподключит его' } };
    };
    if (row.status === 'active') {
      let s;
      try { s = await vidAccrue(row.id, { manual: true }); }
      catch (e) { console.error('[видео] начисление по кнопке упало:', (e && e.message) || e); s = { state: 'fail' }; }
      if (s.code) return ownerAccess(s.code) || vidFail(s.code, { p: row.platform || 'tiktok' });
      return { status: 200, body: { ok: true, video: vidDTO(q.vidById.get(row.id), view), fresh: s.state !== 'busy',
        credited: s.paid || 0 } };
    }
    const res = await vidRefresh([row], now);
    const code = res.errors[row.id];
    if (code) return ownerAccess(code) || vidFail(code, { p: row.platform || 'tiktok' });
    return { status: 200, body: { ok: true, video: vidDTO(q.vidById.get(row.id), view), fresh: true } };
  },

  /* Пульт: очередь решений и всё по видео. queue — вернул рекламодатель,
     держит подозрение на накрутку или нехватка денег, либо выплату держит
     спор. */
  'GET /api/admin/task-videos': async (req, body, url) => {
    if (!isAdmin(req)) return { status: 403, body: { error: 'Нужен X-Admin-Key' } };
    const st = String(url.searchParams.get('status') || 'queue');
    if (!['queue', 'rejected', 'risk', 'review', 'active', 'paid', 'all'].includes(st)) {
      return { status: 400, body: { error: 'status: queue, rejected, risk, review, active, paid или all' } };
    }
    const rows = q.vidAdmin.all({ $st: st });
    return { status: 200, body: { ok: true, videos: rows.map((r) => Object.assign(
      vidDTO(r, 'admin', { history: true }), {
        campName: r.camp_name || '', ownerEmail: r.owner_email || '', ownerName: r.owner_name || '',
        bloggerEmail: r.blogger_email || '', bloggerName: r.blogger_name || '',
        channelTitle: r.channel_title || '', channelRiskLevel: r.channel_risk_level || null,
      })) } };
  },

  /* Решение владельца. «Засчитать»: из возражения рекламодателя — это
     зачёт: свежий замер, первое начисление и 30 дней подсчёта; снятая
     пауза по накрутке или деньгам — начисление по цифрам на момент
     решения, дальше подсчёт идёт как обычно; пауза «нет доступа» и
     снятый с проверки (revoked) — считать нечем: начисление по цифрам на
     момент решения, и подсчёт на этом закрывается. «Не засчитывать»
     закрывает ролик: дальше не начисляется, выплаченное остаётся у
     блогера, резерв освобождается. */
  'POST /api/admin/task-videos/decide': async (req, body) => {
    if (!isAdmin(req)) return { status: 403, body: { error: 'Нужен X-Admin-Key' } };
    const row = q.vidById.get(Number(body.id) || 0);
    if (!row) return vidFail('no_video');
    const decision = String(body.decision || '');
    if (decision !== 'count' && decision !== 'decline') {
      return { status: 400, body: { error: 'decision: count или decline' } };
    }
    /* revoked — ролик сняли с проверки, потому что канал отвязан. Если
       владелец уверен, что работа честная, он может засчитать его сам. */
    if (!['review', 'active', 'rejected', 'revoked'].includes(row.status)) {
      return { status: 409, body: { error: 'По этому видео решение уже не нужно: ' + row.status, code: 'state' } };
    }
    /* Засчитанное без паузы и так считается само — «засчитать» тут нечего
       (спор снимается в «Спорных деньгах»). «Не засчитывать» — можно. */
    if (decision === 'count' && row.status === 'active' && !row.risk_hold && !row.pay_hold) {
      return { status: 409, body: { error: 'Видео уже засчитано — подсчёт просмотров идёт сам', code: 'state' } };
    }
    /* Пауза «не хватило денег», а бюджет задания пуст: «засчитать» снова
       поставило бы её же (и снова письмо блогеру). Платить нечем — ждём
       пополнения, оно снимет паузу само (vidBudgetResume). Есть деньги —
       «засчитать» доплачивает сразу. */
    if (decision === 'count' && row.status === 'active' && !row.risk_hold && row.pay_hold && row.hold_kind === 'money'
      && vidCampLeft(row.camp_id) <= 0) {
      return { status: 409, body: { error: 'Бюджет задания исчерпан — платить нечем. Начисления продолжатся сами, '
        + 'когда рекламодатель пополнит бюджет', code: 'no_budget' } };
    }
    const note = String(body.note == null ? '' : body.note).trim().slice(0, 500);
    const now = Date.now();
    const name = vidCampName(vidCamp(row.camp_id));
    const stale = { status: 409, body: { error: 'Видео только что изменилось — обновите список', code: 'state' } };
    let res = null;
    if (decision === 'count') {
      let status = row.status, approved = row.approved_at || null, frozen = row.frozen ? 1 : 0, track = null;
      const accepting = row.status === 'rejected' || row.status === 'revoked';
      if (accepting) {
        status = 'active'; approved = now; track = now + VID_TRACK_MS;
        /* Канала нет — опрашивать нечем: начисляем по цифрам, что есть
           сейчас, и подсчёт на этом закрывается. */
        if (row.status === 'revoked') frozen = 1;
      }
      const wasHeld = row.status === 'active' && !!(row.risk_hold || row.pay_hold);
      /* Пауза «нет доступа»: ждать переподключения владелец не стал —
         считать дальше нечем, начисление по цифрам на момент решения и
         конец подсчёта (как у revoked). */
      if (row.status === 'active' && row.pay_hold && row.hold_kind === 'access') frozen = 1;
      /* Решение снимает подозрение в накрутке только с тех цифр, что
         владелец видел: decided_views. Если решение было не о накрутке
         (рекламодатель вернул ролик, не хватило денег), прежняя отметка
         остаётся как была — новая накрутка снова встанет на паузу. */
      const dv = row.risk_hold ? (row.views || 0) : (row.decided_views == null ? null : row.decided_views);
      if (!q.vidDecide.run(status, 'count', note || null, now, approved, 0, dv, frozen, track, now, row.id, row.status).changes) {
        return stale;
      }
      /* Пауза была за накрутку — считаем по тем цифрам, что владелец видит
         сейчас: пик накрутки (площадка могла его уже вычистить) из базы
         начислений уходит. Иначе «засчитать» платило бы за ботов. */
      if (row.risk_hold) {
        const t0 = vidTerms(row);
        const base = Math.max(Number(row.views) || 0, Number(row.paid_views) || 0);
        q.vidRebase.run(base, Math.max(row.paid || 0, t0 ? vidEarnBy(t0, base) : 0), now, row.id);
      }
      const how = 'Администратор засчитал видео' + (note ? ' — ' + note : '');
      vidNotify(row.owner_id, 'Решение по видео',
        '«' + name + '»: администратор засчитал видео' + (note ? ' — ' + note : ''), '/?go=campaigns');
      adminLog(req, 'video-count', 'видео ' + row.id, note || null);
      if (status === 'active') {
        /* Блогеру — одно уведомление: о деньгах (с решением в том же
           тексте) или, если денег пока нет, о самом решении. */
        try { res = await vidAccrue(row.id, { noMeasure: wasHeld || frozen === 1, how, accept: accepting }); }
        catch (e) { console.error('[видео] начисление по решению упало:', (e && e.message) || e); res = { state: 'fail' }; }
      } else {
        vidNotify(row.blogger_id, 'Решение по видео', '«' + name + '»: ' + how
          + '. Видео ждёт проверки рекламодателя', '/?go=tasks');
      }
    } else {
      if (!q.vidDecide.run('declined', 'decline', note || null, now, row.approved_at || null, 0,
        row.decided_views == null ? null : row.decided_views, row.frozen ? 1 : 0, null, now, row.id, row.status).changes) {
        return stale;
      }
      const kept = row.paid || 0;
      vidNotify(row.blogger_id, 'Видео не засчитано',
        '«' + name + '»: администратор решил не засчитывать видео' + (note ? ' — ' + note : '')
        + (kept > 0 ? '. Начисления остановлены, выплаченные ' + vidNum(kept) + ' ₽ остаются у вас' : ''), '/?go=tasks');
      vidNotify(row.owner_id, 'Решение по видео',
        '«' + name + '»: администратор не засчитал видео — ' + (kept > 0 ? 'начисления по нему остановлены' : 'выплаты по нему не будет'),
        '/?go=campaigns');
      adminLog(req, 'video-decline', 'видео ' + row.id, note || null);
    }
    vidBoardDrop(row.camp_id);
    return { status: 200, body: { ok: true, settle: res ? res.state : null,
      video: vidDTO(q.vidById.get(row.id), 'admin') } };
  },

  /* Тот же фоновый круг по кнопке (и в проверках). force — освежить все
     ролики в работе, не дожидаясь суток. */
  'POST /api/admin/task-videos/sync': async (req, body) => {
    if (!isAdmin(req)) return { status: 403, body: { error: 'Нужен X-Admin-Key' } };
    /* Фоновый круг уже идёт (в том числе первый после старта) — дождёмся
       его, а не отвечаем «занято»: кнопка и проверки хотят свой круг. */
    for (let i = 0; vidSyncBusy && i < 600; i++) await new Promise((ok) => setTimeout(ok, 100));
    const r = await vidSyncRound({ force: body.force === true });
    return { status: r.busy ? 409 : 200, body: Object.assign({ ok: !r.busy && !r.error }, r) };
  },

  'GET /api/admin/overview': async (req) => {
    if (!isAdmin(req)) return { status: 403, body: { error: 'Нужен X-Admin-Key' } };
    const t = q.totals.get();
    const fees = q.platformIncome.get();
    const queued = q.allWds.all('queued', 'queued');
    const processing = q.allWds.all('processing', 'processing');
    const paidOut = q.paidOut.get().s;
    const toppedUp = q.toppedUp.get().s;
    const inSystem = t.available + t.hold;
    /* Сверка: всё, что внесли, либо лежит в системе, либо ушло наружу
       выплатами. Если равенство разошлось — где-то потеряны деньги, и
       это надо увидеть сразу, а не по недостаче на счёте. */
    const expected = toppedUp - paidOut;
    const tst = q.testTopped.get(TEST_TOPUP_REF, TEST_TOPUP_REF, TEST_TOPUP_FEE_REF);
    return {
      status: 200,
      body: {
        /* тестовые деньги (аудит 16.10.2026): «открыто_всем» — красная
           плашка в /admin; внесено/комиссия — сколько из «внесено» и
           «дохода» ненастоящие */
        тестовые_деньги: {
          открыто_всем: TEST_MONEY_PUBLIC,
          предупреждение: TEST_MONEY_PUBLIC ? TEST_MONEY_MSG : '',
          режим: YK_ON ? 'yookassa' : (!TEST_TOPUP ? 'off' : (TEST_TOPUP_OPEN ? 'open' : 'owner')),
          вывод_закрыт: TEST_MONEY_PUBLIC,
          внесено: tst.amount,
          комиссия: tst.fee,
          людей: tst.people,
        },
        /* адрес клиента за прокси хостинга: что видно по первым запросам */
        прокси: proxyAdvice(),
        всего_в_системе: { available: t.available, hold: t.hold },
        доход_платформы: fees.fees,
        заявок_в_очереди: queued.length,
        сумма_к_выплате: queued.reduce((s, w) => s + w.net, 0),
        взято_в_работу: processing.length,
        верификаций_в_очереди: q.kycQueuedCount.get().n,
        счетов_ждут: qi.openCount.get().n,
        /* значок раздела «Видео»: вернул рекламодатель, держит накрутка,
           не хватило денег или замера, либо выплату держит спор */
        видео_на_решении: q.vidQueueCount.get().n,
        внесено_всего: toppedUp,
        выплачено_наружу: paidOut,
        ошибок_за_сутки: q.errorCount.get(),
        сверка: {
          ожидается_в_системе: expected,
          фактически_в_системе: inSystem,
          расхождение: inSystem - expected,
          сходится: inSystem === expected,
        },
      },
    };
  },
};

/* ── Сервер ────────────────────────────────────────────────────────── */

/* Человек вернулся с площадки. Меняем код на токен, спрашиваем у
   площадки, чей это канал, и записываем. Токен после этого выбрасываем:
   хранить его — значит держать ключ от чужого аккаунта. */
/* goto — адрес, куда вернуть человека: страница уходит туда сама через
   пару секунд, а кнопка остаётся на случай, если переход не сработал.
   Нужно для входа через Google: в том же браузере приложение подхватит
   вход по метке в адресе, и код вводить не придётся. */
/* ── Возврат после входа: крошечная страница вместо всего приложения ──
   Было: сервер отвечал переходом на сам сайт с меткой в адресе. Но вход
   начинается в новом окне (его открывает кнопка «Войти через…»), значит
   и переход приходил в НЕГО. Окно поднимало все пять мегабайт
   приложения, признавало метку своей — метка лежит в localStorage,
   общем для всех окон одного адреса, — и первым забирало вход себе. Той
   вкладке, где человек смотрел на «Заканчиваем вход», не доставалось
   ничего: сервер отвечал ей «метки нет», а приложение этот ответ молча
   глотало и крутило точки до двух минут. Человек обновлял страницу — и
   оказывался внутри, потому что вход давно состоялся, просто в соседнем
   окне.

   Стало: окно возврата получает страницу на полтора килобайта. Она
   ничего не забирает, а только говорит «готово» тому, кто ждёт:
     1) окну, которое её открыло, — postMessage;
     2) остальным вкладкам — отметкой в localStorage и BroadcastChannel;
   и закрывается. Вход забирает ровно та вкладка, где человек ждёт.

   Если открывшего окна нет (вход шёл в этой же вкладке — так бывает,
   когда браузер запретил всплывающее окно), ждать некому: страница
   короткую секунду слушает ответ от других вкладок и, не дождавшись,
   уходит в приложение сама — как раньше. */
function authRelayPage(res, kind, state, goto) {
  const j = (v) => JSON.stringify(String(v));
  const code = '(function(){'
    + 'var K=' + j(kind) + ',N=' + j(state) + ',GO=' + j(goto) + ';'
    + 'var m=document.getElementById("m");'
    + 'function say(t){ if(m) m.textContent=t; }'
    + 'var msg={bp:"auth",kind:K,nonce:N};'
    /* Отметка и вещание — для вкладок, до которых не дотянуться напрямую.
       Имена без префикса bp_: этот префикс приложение считает своим
       хранилищем и гоняет такие ключи на сервер. */
    + 'try{ localStorage.setItem("bpAuthReady", JSON.stringify({kind:K,nonce:N,at:Date.now()})); }catch(e){}'
    + 'try{ var ch=new BroadcastChannel("bp-auth"); ch.postMessage(msg); ch.close(); }catch(e){}'
    + 'var done=false;'
    + 'function finish(){ if(done) return; done=true;'
    + ' say("Готово. Возвращайтесь во вкладку BloggerPay.");'
    + ' setTimeout(function(){ try{ window.close(); }catch(e){} }, 200); }'
    + 'try{ if(window.opener && !window.opener.closed){'
    + '  window.opener.postMessage(msg, location.origin); finish(); return; } }catch(e){}'
    /* Открывшего окна нет. Ждёт ли нас кто-нибудь вообще? Вкладка, которая
       показывает «Заканчиваем вход», каждые две секунды обновляет отметку
       bpAuthWaiting. Свежая отметка (моложе шести секунд) значит: она жива
       и заберёт вход сама — тогда мы просто закрываемся. Отметка старая
       или её нет — ждать некому, человек смотрит именно сюда, и мы идём в
       приложение, как раньше. Никаких догадок по таймеру. */
    + 'var alive=false;'
    + 'try{ var w=JSON.parse(localStorage.getItem("bpAuthWaiting")||"null");'
    + ' alive = !!(w && w.kind === K && (Date.now() - (w.at||0)) < 6000); }catch(e){}'
    + 'if(alive){ finish(); return; }'
    + 'var t=setTimeout(function(){ if(!done) location.replace(GO); }, 1200);'
    + 'window.addEventListener("storage", function(e){'
    + ' if(e && e.key === "bpAuthTaken"){ clearTimeout(t); finish(); } });'
    + '})();';
  const html = '<!doctype html><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>Готово</title>'
    + '<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;'
    + 'background:#0f1115;color:#e8eaed;font:600 15px/1.55 -apple-system,Segoe UI,Roboto,sans-serif;'
    + 'text-align:center;padding:28px}</style>'
    + '<div id="m">Возвращаемся в BloggerPay…</div>'
    + '<script>' + code + '</' + 'script>';
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  return res.end(html);
}

function verifyPage(res, title, text, good, code, goto) {
  const esc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
  const html = '<!doctype html><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>' + esc(title) + '</title>'
    + '<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;'
    + 'background:#0f1115;color:#e8eaed;font:600 16px/1.55 -apple-system,Segoe UI,Roboto,sans-serif;'
    + 'text-align:center;padding:28px}div{max-width:340px}'
    + 'b{display:block;font-size:19px;margin-bottom:8px;color:' + (good ? '#3ddc84' : '#ff6b6b') + '}'
    + 'p{color:#a2a9b4;font-weight:500;font-size:14px;margin:0}'
    + 'code{display:block;margin:18px auto 6px;padding:14px 10px;max-width:260px;'
    + 'background:#171a20;border:1px solid #2f6ce0;border-radius:14px;'
    + 'font:800 34px/1 ui-monospace,Menlo,Consolas,monospace;letter-spacing:8px;color:#fff}'
    /* Код — запасной путь, а не задание: он нужен только тому, у кого
       приложение осталось в другом браузере. Поэтому прячем его под
       строку-раскрывашку, чтобы главным на экране было «возвращаем вас
       обратно», а не шесть цифр. */
    + 'details{margin-top:18px}summary{cursor:pointer;color:#7d818c;font-size:12.5px;font-weight:600}'
    + 'details code{margin-top:10px}</style>'
    + (goto ? '<meta http-equiv="refresh" content="1;url=' + esc(goto) + '">' : '')
    + '<style>a.go{display:inline-block;margin-top:16px;padding:13px 20px;border-radius:14px;'
    + 'background:#2f6ce0;color:#fff;text-decoration:none;font-weight:700;font-size:15px}</style>'
    + '<div><b>' + esc(title) + '</b><p>' + esc(text) + '</p>'
    + (code
        ? (goto
            ? '<details><summary>Приложение открыто в другом браузере? Показать код</summary>'
              + '<code>' + esc(code) + '</code></details>'
            : '<code>' + esc(code) + '</code>')
        : '')
    + (goto ? '<a class="go" href="' + esc(goto) + '">Вернуться в приложение</a>' : '')
    + '</div>';
  res.writeHead(good ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(html);
}

/* ══ КАЧЕСТВО КАНАЛА TIKTOK ══════════════════════════════════════════
   Площадка отдаёт список последних роликов с просмотрами, лайками,
   комментариями и репостами. По ним видно то, чего не видно по числу
   подписчиков: смотрят ли этого человека вообще.

   Чего у площадки НЕТ и придумывать не будем: «избранного» в открытом
   интерфейсе нет вовсе (оно есть только в исследовательском, куда
   коммерческим сервисам вход закрыт), суммарных просмотров канала тоже
   нет — их складываем из роликов сами.

   Доступ живёт сутки, поэтому перед каждым обновлением при необходимости
   меняем его на новый по refresh. Площадка иногда возвращает НОВЫЙ
   refresh — тогда старый больше не годится, и надо сохранить новый. */

async function ttAsk(url, opts) {
  let last;
  for (let i = 0; i < 2; i++) {
    try {
      const stop = AbortSignal.timeout ? AbortSignal.timeout(12000) : undefined;
      const r = await fetch(url, Object.assign({ signal: stop }, opts || {}));
      const j = await r.json();
      return { status: r.status, body: j };
    } catch (e) { last = e; }
  }
  throw new Error('TikTok не ответил: ' + ((last && last.message) || 'нет связи'));
}

/* Свежий доступ. Возвращает строку токена или пусто, если обновить нечем. */
async function ttAccess(row) {
  const cfg = OAUTH.tiktok;
  if (!row || !row.access) return '';
  const alive = row.expires_at && new Date(row.expires_at).getTime() > Date.now() + 60000;
  if (alive) return row.access;
  if (!row.refresh || !cfg.id || !cfg.secret) return '';
  const r = await ttAsk(cfg.token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_key: cfg.id, client_secret: cfg.secret,
      grant_type: 'refresh_token', refresh_token: row.refresh,
    }),
  });
  const t = r.body || {};
  if (!t.access_token) return '';
  const exp = t.expires_in ? new Date(Date.now() + Number(t.expires_in) * 1000).toISOString() : null;
  q.putToken.run(row.user_id, row.platform, row.external_id, t.access_token,
    t.refresh_token || row.refresh, exp);
  return t.access_token;
}

/* Последние ролики. Больше сорока не берём: для картины хватает, а
   лимит площадки тратить незачем. */
async function ttVideos(access, want) {
  const cfg = OAUTH.tiktok;
  const fields = 'id,create_time,title,like_count,comment_count,share_count,view_count';
  const out = [];
  let cursor = 0;
  for (let page = 0; page < 2 && out.length < (want || 40); page++) {
    const r = await ttAsk(cfg.videos + '?fields=' + fields, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + access },
      body: JSON.stringify({ max_count: 20, cursor }),
    });
    const d = (r.body && r.body.data) || {};
    const list = Array.isArray(d.videos) ? d.videos : [];
    list.forEach((v) => out.push({
      id: String(v.id || ''),
      at: Number(v.create_time) || 0,
      title: String(v.title || '').slice(0, 120),
      views: Number(v.view_count) || 0,
      likes: Number(v.like_count) || 0,
      comments: Number(v.comment_count) || 0,
      shares: Number(v.share_count) || 0,
    }));
    if (!d.has_more) break;
    cursor = Number(d.cursor) || 0;
    if (!cursor) break;
  }
  return out;
}

/* Свежие числа профиля. */
async function ttProfile(access) {
  const cfg = OAUTH.tiktok;
  const fields = 'open_id,avatar_url,display_name,username,profile_deep_link,is_verified,'
    + 'follower_count,following_count,likes_count,video_count';
  const r = await ttAsk(cfg.userInfo + '?fields=' + fields, {
    headers: { Authorization: 'Bearer ' + access },
  });
  return (r.body && r.body.data && r.body.data.user) || null;
}

/* Тексты для владельца: коротко и по-русски, без «anomaly score». */
function riskWord(level) {
  return quality.LEVEL_RU[level] || String(level || '');
}

/* Полный проход по одному каналу: доступ → цифры → оценка → запись.
   Ничего не бросает наружу: обновление статистики не должно ронять то,
   ради чего человек пришёл. */
async function syncTikTok(userId, extId, opts) {
  const o = opts || {};
  const row = q.getToken.get(userId, 'tiktok', String(extId));
  if (!row) return { ok: false, why: 'нет доступа к каналу' };
  let access = '';
  try { access = await ttAccess(row); }
  catch (e) { return { ok: false, why: String((e && e.message) || e) }; }
  if (!access) {
    tgAlert('tt:token:' + userId + ':' + extId,
      '🔑 TikTok: доступ к каналу больше не действует\n\n'
      + 'Аккаунт #' + userId + ', канал ' + extId + '.\n'
      + 'Статистику по нему обновить нечем — человеку нужно подтвердить канал заново.',
      'server');
    return { ok: false, why: 'доступ устарел' };
  }

  let prof = null, videos = [];
  try { prof = await ttProfile(access); } catch (e) { /* профиль не обязателен */ }
  try { videos = await ttVideos(access, 40); }
  catch (e) {
    tgAlert('tt:videos:' + userId + ':' + extId,
      '⚠️ TikTok: не удалось получить список роликов\n\n'
      + 'Аккаунт #' + userId + ', канал ' + extId + '.\n'
      + String((e && e.message) || e).slice(0, 200),
      'server');
    return { ok: false, why: 'список роликов недоступен' };
  }

  const followers = prof ? (Number(prof.follower_count) || 0) : 0;
  const res = quality.assess({ followers, videos, platform: 'tiktok' });

  try {
    if (prof) {
      q.upsertChannel.run(userId, 'tiktok', String(extId),
        prof.display_name || '', prof.profile_deep_link
          || (prof.username ? 'https://www.tiktok.com/@' + prof.username : ''),
        followers, prof.avatar_url || null);
      q.chanNums.run(prof.username || null, prof.is_verified ? 1 : 0,
        Number(prof.following_count) || null, Number(prof.likes_count) || null,
        Number(prof.video_count) || null, userId, 'tiktok', String(extId));
    }
    q.chanRisk.run(res.risk, res.level, res.reasons.join(' • ').slice(0, 900),
      userId, 'tiktok', String(extId));
    q.insStats.run(userId, 'tiktok', String(extId), followers, res.stats.videos,
      res.stats.medViews, res.stats.avgViews, res.stats.erLikes, res.stats.erComments,
      res.stats.erShares, res.risk, res.level,
      JSON.stringify({ stats: res.stats, reasons: res.reasons, confidence: res.confidence }).slice(0, 8000));
  } catch (e) { console.error('[tiktok] не записалось: ' + ((e && e.message) || e)); }

  /* Владельцу пишем только о том, что требует его внимания. */
  const name = prof && (prof.username || prof.display_name) ? ('@' + (prof.username || prof.display_name)) : String(extId);
  if (o.first) {
    tgAlert('tt:new:' + userId + ':' + extId,
      '🔗 Подключён TikTok\n\n'
      + 'Аккаунт #' + userId + '\nКанал: ' + name + '\n'
      + 'Подписчиков: ' + followers + ', роликов разобрано: ' + res.stats.videos + '\n'
      + 'Оценка: ' + riskWord(res.level) + (res.risk == null ? '' : ' (' + res.risk + ' из 100)'),
      'server');
  }
  if (res.level === 'risk' || res.level === 'bad') {
    tgAlert('tt:risk:' + userId + ':' + extId + ':' + res.level,
      '🚩 TikTok: цифры канала выбиваются\n\n'
      + 'Аккаунт #' + userId + '\nКанал: ' + name + '\n'
      + 'Оценка: ' + riskWord(res.level) + ' (' + res.risk + ' из 100), уверенность '
      + res.confidence + '\n\n'
      + 'Подписчиков: ' + followers + '\n'
      + 'Роликов разобрано: ' + res.stats.videos + '\n'
      + 'Медиана просмотров: ' + res.stats.medViews + '\n'
      + 'Лайков к просмотрам: ' + (res.stats.erLikes * 100).toFixed(1) + '%\n'
      + 'Комментариев к просмотрам: ' + (res.stats.erComments * 100).toFixed(2) + '%\n\n'
      + 'Что именно выбилось:\n• ' + res.reasons.join('\n• ') + '\n\n'
      + 'Это не доказательство накрутки — это повод посмотреть внимательнее.',
      'server');
  }
  return { ok: true, risk: res.risk, level: res.level, confidence: res.confidence,
    stats: res.stats, reasons: res.reasons };
}

/* Фоновое обновление: понемногу и редко, чтобы не упереться в лимит
   площадки (600 запросов в минуту) и не будить владельца зря. */
let ttSyncBusy = false;
async function ttSyncRound() {
  if (ttSyncBusy || !OAUTH.tiktok.id || !OAUTH.tiktok.secret) return;
  ttSyncBusy = true;
  try {
    const rows = q.staleChannels.all(3);
    for (const r of rows) {
      try { await syncTikTok(r.user_id, r.external_id, {}); }
      catch (e) { console.error('[tiktok] обновление упало: ' + ((e && e.message) || e)); }
    }
  } catch (e) { console.error('[tiktok] круг обновления упал: ' + ((e && e.message) || e)); }
  finally { ttSyncBusy = false; }
}
setInterval(() => { ttSyncRound().catch(() => {}); }, 30 * 60 * 1000).unref();

/* ══ «ЗАГРУЗИТЬ ВИДЕО» (07.10.2026, механика v3) ═══════════════════════
   Контракт — server/VIDEO-SPEC.md, раздел 11. Коротко: блогер загружает
   ролик со своего подтверждённого TikTok или YouTube сразу после
   публикации — хоть с нулём просмотров — и больше ничего не делает.
   Сервер сам спрашивает площадку, ролик ли это этого аккаунта и сколько
   у него просмотров, и резервирует под него оценку из бюджета.
   Рекламодатель проверяет интеграцию; засчитанный ролик VID_TRACK_DAYS
   суток считается: раз в сутки свежий замер и прибавка на баланс
   (начислено по наибольшим просмотрам − уже выплачено), пока не взят
   максимум за ролик или не вышел срок. minViews — порог начала начислений.

   Почему владение доказывает именно площадка: TikTok по video/query
   отдаёт ТОЛЬКО ролики владельца токена; YouTube в videos.list называет
   channelId ролика, и он обязан совпасть с подтверждённым каналом. */

const VID_PLAT = { tiktok: 'TikTok', youtube: 'YouTube', instagram: 'Instagram' };
function vidPlatName(p) { return VID_PLAT[p] || 'TikTok'; }
/* 12345 → «12 345»: так числа читаются в тексте ошибки и уведомлении. */
function vidNum(n) { return String(Math.max(0, Math.round(Number(n) || 0))).replace(/\B(?=(\d{3})+(?!\d))/g, ' '); }
function vidViewsWord(n) {
  const a = Math.abs(Math.round(Number(n) || 0)) % 100, b = a % 10;
  if (a > 10 && a < 20) return 'просмотров';
  if (b === 1) return 'просмотр';
  if (b >= 2 && b <= 4) return 'просмотра';
  return 'просмотров';
}

/* Ошибки загрузки: код для приложения и готовый русский текст. Тексты с
   площадкой собираются по месту: x.p — площадка ссылки. */
const VID_ERR = {
  auth: [401, 'Нужен вход'],
  often: [429, (x) => (x.hour
    ? 'Слишком много проверок YouTube за час — попробуйте позже'
    : 'Слишком часто — подождите минуту и попробуйте снова')],
  yt_quota: [503, 'Проверки YouTube-видео на сегодня закончились — попробуйте завтра'],
  bad_url: [400, 'Это не ссылка на видео TikTok, YouTube или Instagram'],
  wrong_link: [400, (x) => 'Ссылка с ' + vidPlatName(x.p) + ', а выбран аккаунт ' + vidPlatName(x.other)
    + ' — выберите ' + (x.p === 'youtube' ? 'YouTube-канал' : x.p === 'instagram' ? 'Instagram-аккаунт' : 'TikTok-аккаунт')
    + ' или вставьте другую ссылку'],
  agree: [400, 'Подтвердите, что в видео есть реклама из задания'],
  no_camp: [404, 'Задание не найдено'],
  camp_closed: [409, 'Задание уже не принимает видео'],
  own_camp: [409, 'Это ваше задание — видео в своё задание загрузить нельзя'],
  wrong_platform: [409, (x) => 'В этом задании принимаются видео только из: ' + (x.list || '—')],
  /* Старый код: v2 его не возвращает (теперь wrong_platform), оставлен,
     чтобы старое приложение понимало ответ, если он придёт откуда-то ещё. */
  not_tiktok: [409, 'В этом задании нет TikTok'],
  budget: [409, 'Бюджет задания закончился'],
  no_channel: [409, (x) => 'Сначала подключите свой ' + vidPlatName(x.p)],
  no_account: [409, 'Этот аккаунт не подключён — подключите его заново'],
  token: [409, (x) => (x.p === 'youtube'
    ? 'Доступ к YouTube истёк — переподключите канал'
    : 'Доступ к ' + vidPlatName(x.p) + ' истёк — переподключите аккаунт')],
  scope: [409, (x) => (x.p === 'youtube'
    ? 'Переподключите YouTube и разрешите доступ к каналу'
    : x.p === 'instagram'
      ? 'Переподключите Instagram и разрешите доступ к публикациям и их статистике'
      : 'Переподключите TikTok и разрешите доступ к роликам')],
  not_found: [404, 'Видео не найдено — проверьте ссылку'],
  /* фото-карусель TikTok (/photo/…): у площадки это не ролик, Display API
     её не отдаёт, и в задания, как у More Views, она не принимается */
  not_video: [409, (x) => (x.p === 'instagram'
    ? 'Это фото или карусель, а не видео — в задания принимаются только Reels'
    : 'Это фото-пост, а не видео — в задания принимаются только видеоролики')],
  /* задание «YouTube Shorts» (15.10.2026) — обычное видео не принимаем */
  not_shorts: [409, 'Это обычное видео YouTube, а в задании принимаются только Shorts — вертикальные ролики до 3 минут'],
  not_public: [409, 'Видео закрыто — откройте его для всех и попробуйте снова'],
  not_yours: [409, (x) => (x.chosen
    ? 'Этого видео нет на ' + (x.handle ? 'аккаунте ' + x.handle : 'выбранном аккаунте')
      + ' — выберите другой аккаунт или проверьте ссылку'
    : 'Это видео не с ваших подключённых аккаунтов ' + vidPlatName(x.p))],
  too_old: [409, 'Видео опубликовано раньше, чем появилось задание'],
  too_late: [409, 'Видео опубликовано после срока задания — такие не оплачиваются'],
  too_short: [409, (x) => 'Видео короче ' + x.n + ' сек — так в условиях задания'],
  /* Старый код: v3 его не возвращает — загрузить можно с любым числом
     просмотров, minViews только решает, с какого момента пойдут деньги.
     Текст оставлен, чтобы старое приложение понимало ответ. */
  few_views: [409, (x) => 'У видео ' + vidNum(x.views) + ' ' + vidViewsWord(x.views) + ', а в задании минимум '
    + vidNum(x.minViews) + ' — загрузите, когда наберёт'],
  taken: [409, 'Это видео уже загружено — одно видео можно отправить только один раз. Загрузите другой ролик'],
  no_video: [404, 'Видео не найдено'],
  tiktok: [502, 'TikTok сейчас не отвечает — попробуйте через минуту'],
  youtube: [502, 'YouTube сейчас не отвечает — попробуйте через минуту'],
  instagram: [502, 'Instagram сейчас не отвечает — попробуйте через минуту'],
};
function vidFail(code, x) {
  const o = x || {};
  let c = VID_ERR[code] ? code : vidPlatErr(o.p);
  /* Сбой площадки называем по той площадке, о которой речь. */
  if (VID_PLAT[c] && VID_PLAT[o.p]) c = o.p;
  const e = VID_ERR[c];
  const body = { error: typeof e[1] === 'function' ? e[1](o) : e[1], code: c };
  if (VID_PLAT[o.p]) body.platform = o.p;
  if (c === 'few_views') { body.views = Number(o.views) || 0; body.minViews = Number(o.minViews) || 0; }
  return { status: e[0], body };
}
function ttErr(code, message) {
  const e = new Error(message || code);
  e.vidCode = code;
  return e;
}
/* Ответ площадки → наш код. Права (scope) и доступ (token) человек чинит
   сам, переподключив TikTok; остальное — сбой площадки, лечится временем. */
function ttCodeOf(code) {
  const c = String(code || '');
  if (c === 'scope_not_authorized' || c === 'scope_permission_missed') return 'scope';
  if (/token/i.test(c)) return 'token';
  return 'tiktok';
}

/* ── Ссылки ──
   TikTok: только хосты TikTok и только https — сервер ходит по короткой
   ссылке сам, и без белого списка его можно было бы послать куда угодно
   (в том числе во внутреннюю сеть хостинга). Хост TT_WEB_BASE добавлен,
   чтобы проверки могли подставить свою площадку.
   YouTube: по ссылке сервер НИКУДА не ходит — id достаём разбором, цифры
   спрашиваем у API по id. Белый список хостов, только https, без пароля
   и порта в адресе: youtube.com.evil.ru или youtube.com@evil.ru — не YouTube. */
const TT_HOSTS = new Set(['www.tiktok.com', 'tiktok.com', 'm.tiktok.com', 'vm.tiktok.com', 'vt.tiktok.com']);
const TT_WEB_ORIGIN = (() => { try { return new URL(TT_WEB_BASE).origin; } catch (e) { return ''; } })();
const TT_VID_RE = /(?:\/video\/|\/v\/|\/embed\/v2\/|\/player\/v1\/)(\d{15,21})/;
const TT_PHOTO_RE = /\/photo\/(\d{15,21})/;
const TT_UA = 'Mozilla/5.0 (compatible; BloggerPay/1.0; +' + PUBLIC_URL + ')';
function ttUrlOk(u) {
  if (!u) return false;
  if (u.protocol === 'https:' && TT_HOSTS.has(u.hostname.toLowerCase())) return true;
  return !!TT_WEB_ORIGIN && u.origin === TT_WEB_ORIGIN;
}
/* null — это не ролик TikTok; id пуст — короткая ссылка, её раскроем. */
function ttLinkOf(u) {
  if (!ttUrlOk(u)) return null;
  const id = TT_VID_RE.exec(u.pathname);
  if (id) return { url: u, id: id[1] };
  if (TT_PHOTO_RE.test(u.pathname)) return { url: u, id: '', photo: true };
  const host = u.hostname.toLowerCase();
  if ((host === 'vm.tiktok.com' || host === 'vt.tiktok.com') && /^\/[\w-]{3,}\/?$/.test(u.pathname)) return { url: u, id: '' };
  if (/^\/t\/[\w-]{3,}\/?$/.test(u.pathname)) return { url: u, id: '' };
  return null;
}
const YT_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be']);
const YT_ID_RE = /^[A-Za-z0-9_-]{11}$/;
function ytLinkOf(u) {
  if (!u || u.protocol !== 'https:' || u.username || u.password || u.port) return null;
  const host = u.hostname.toLowerCase();
  if (!YT_HOSTS.has(host)) return null;
  const seg = u.pathname.split('/').filter(Boolean);
  let id = '', shorts = false;
  if (host === 'youtu.be') id = seg.length === 1 ? seg[0] : '';
  else if (seg.length === 1 && seg[0] === 'watch') id = String(u.searchParams.get('v') || '');
  else if (seg.length === 2 && (seg[0] === 'shorts' || seg[0] === 'live' || seg[0] === 'embed')) {
    id = seg[1]; shorts = seg[0] === 'shorts';
  }
  if (!YT_ID_RE.test(id)) return null;
  return { platform: 'youtube', id, shorts, url: u };
}
/* Instagram: instagram.com/reel/<код>/, /reels/, /p/ (видео-пост), /tv/,
   с ником впереди (/ник/reel/<код>) и хвостом ?igsh=… Только https, без
   пароля и порта. По ссылке сервер никуда не ходит — код ищем среди
   публикаций подключённого аккаунта. */
const IG_HOSTS = new Set(['instagram.com', 'www.instagram.com', 'm.instagram.com', 'instagr.am', 'www.instagr.am']);
function igLinkOf(u) {
  if (!u || u.protocol !== 'https:' || u.username || u.password || u.port) return null;
  if (!IG_HOSTS.has(u.hostname.toLowerCase())) return null;
  const seg = u.pathname.split('/').filter(Boolean);
  let i = seg.findIndex((x) => /^(reels?|p|tv)$/i.test(x));
  if (i < 0 || i > 1 || !seg[i + 1]) return null;
  const code = seg[i + 1];
  if (!IG_CODE_RE.test(code)) return null;
  return { platform: 'instagram', id: '', code, url: u };
}
/* Разбор того, что вставил человек: ссылка может прийти вместе с текстом
   («Смотри! https://vm.tiktok.com/…»), без https:// или с хвостом ?_r=1.
   Площадку определяет сама ссылка. null — не ролик TikTok и не YouTube. */
function vidLink(raw) {
  let s = String(raw == null ? '' : raw).trim().slice(0, 600);
  const m = /https?:\/\/[^\s<>"']+/i.exec(s);
  if (m) s = m[0];
  else {
    const b = /(?:^|\s)((?:(?:www|m|vm|vt)\.)?tiktok\.com\/[^\s<>"']+|(?:(?:www|m)\.)?youtube\.com\/[^\s<>"']+|youtu\.be\/[^\s<>"']+|(?:(?:www|m)\.)?instagram\.com\/[^\s<>"']+|instagr\.am\/[^\s<>"']+)/i.exec(s);
    if (!b) return null;
    s = 'https://' + b[1];
  }
  /* «…https://youtu.be/xxxxxxxxxxx.» — точка конца фразы не часть ссылки. */
  s = s.replace(/[.,!?;:)\]}»"'…]+$/, '');
  let u;
  try { u = new URL(s); } catch (e) { return null; }
  const yt = ytLinkOf(u);
  if (yt) return yt;
  const ig = igLinkOf(u);
  if (ig) return ig;
  const tt = ttLinkOf(u);
  return tt ? Object.assign({ platform: 'tiktok' }, tt) : null;
}
/* Короткая ссылка → адрес ролика. HEAD без автоперехода: каждый шаг
   сверяем с белым списком сами, не больше пяти шагов, на каждый пять
   секунд. Переход на главную (/?_r=1 и прочее без /video/) — значит
   ролика по ссылке нет. */
async function ttResolve(start) {
  let cur = start;
  for (let hop = 0; hop < 5; hop++) {
    let r;
    try {
      r = await fetch(cur.href, {
        method: 'HEAD', redirect: 'manual', headers: { 'User-Agent': TT_UA },
        signal: AbortSignal.timeout(5000),
      });
      /* Некоторые узлы на HEAD отвечают 405 — тогда тот же шаг через GET. */
      if (r.status === 405) {
        r = await fetch(cur.href, {
          method: 'GET', redirect: 'manual', headers: { 'User-Agent': TT_UA },
          signal: AbortSignal.timeout(5000),
        });
        try { if (r.body) await r.body.cancel(); } catch (e) { /* тело не нужно */ }
      }
    } catch (e) {
      throw ttErr('tiktok', 'короткая ссылка не раскрылась: ' + ((e && e.message) || e));
    }
    const loc = r.status >= 300 && r.status < 400 ? r.headers.get('location') : '';
    if (!loc) {
      /* Переадресации нет — площадка отдала страницу (так бывает с
         браузерной заглушкой). Ищем адрес поста в её разметке: canonical,
         og:url или первую ссылку вида /@ник/video|photo/<id>. Хост тот же,
         из белого списка, читаем не больше 300 КБ. */
      const pg = r.status === 200 ? await ttPageLink(cur) : null;
      if (pg && TT_PHOTO_RE.test(pg.pathname)) throw ttErr('not_video');
      const m0 = pg ? TT_VID_RE.exec(pg.pathname) : null;
      if (m0) return { url: pg, id: m0[1] };
      throw ttErr('not_found');
    }
    let next;
    try { next = new URL(loc, cur); } catch (e) { throw ttErr('not_found'); }
    if (!ttUrlOk(next)) throw ttErr('not_found');
    const m = TT_VID_RE.exec(next.pathname);
    if (m) return { url: next, id: m[1] };
    if (TT_PHOTO_RE.test(next.pathname)) throw ttErr('not_video');
    cur = next;
  }
  throw ttErr('not_found');
}
async function ttPageLink(cur) {
  try {
    const r = await fetch(cur.href, {
      method: 'GET', redirect: 'manual',
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36' },
      signal: AbortSignal.timeout(6000),
    });
    const loc = r.status >= 300 && r.status < 400 ? r.headers.get('location') : '';
    if (loc) { try { if (r.body) await r.body.cancel(); } catch (e) { /* не нужно */ } const u = new URL(loc, cur); return ttUrlOk(u) ? u : null; }
    if (!r.ok || !r.body) return null;
    const rd = r.body.getReader(); let html = '', n = 0;
    while (n < 300 * 1024) { const ch = await rd.read(); if (ch.done) break; n += ch.value.length; html += Buffer.from(ch.value).toString('utf8'); }
    try { await rd.cancel(); } catch (e) { /* дочитывать не нужно */ }
    /* в JSON страницы слэши экранированы: «\u002F» или «\/» */
    const txt = html.replace(/\\u002F/gi, '/').replace(/\\\//g, '/');
    const m = /https:\/\/(?:www\.|m\.)?tiktok\.com\/@[\w.-]+\/(?:video|photo)\/\d{15,21}/.exec(txt);
    if (!m) return null;
    const u = new URL(m[0]);
    return ttUrlOk(u) ? u : null;
  } catch (e) { return null; }
}
/* oEmbed площадки: открытый, без токена. Нужен ровно для одного —
   отличить «ролика нет вовсе» (400/404) от «ролик есть, но не ваш». */
async function ttOembed(link) {
  let r;
  try {
    r = await fetch(TT_WEB_BASE + '/oembed?url=' + encodeURIComponent(link), {
      headers: { 'User-Agent': TT_UA }, signal: AbortSignal.timeout(5000),
    });
  } catch (e) { return { ok: false, net: true }; }
  if (!r.ok) {
    try { if (r.body) await r.body.cancel(); } catch (e) { /* тело не нужно */ }
    return { ok: false, status: r.status };
  }
  const j = await r.json().catch(() => null);
  return j ? { ok: true, data: j } : { ok: false, status: r.status };
}

/* Ролик из ответа TikTok → наш вид. id строкой (см. ttQuery). */
function ttVid(v) {
  const n = (x) => Math.max(0, Math.round(Number(x) || 0));
  return {
    id: String(v && v.id != null ? v.id : ''),
    at: Number(v && v.create_time) || 0,
    cover: v && typeof v.cover_image_url === 'string' ? v.cover_image_url.slice(0, 1000) : '',
    share: v && typeof v.share_url === 'string' ? v.share_url.slice(0, 600) : '',
    title: String((v && (v.title || v.video_description)) || '').slice(0, 150),
    duration: v && Number.isFinite(Number(v.duration)) && v.duration !== null ? Math.round(Number(v.duration)) : null,
    views: n(v && v.view_count), likes: n(v && v.like_count),
    comments: n(v && v.comment_count), shares: n(v && v.share_count),
  };
}
const TT_QUERY_FIELDS = 'id,create_time,cover_image_url,share_url,title,video_description,duration,'
  + 'like_count,comment_count,share_count,view_count';
/* Цифры конкретных роликов (до 20 за раз) — только своих для токена.
   Ответ читаем ТЕКСТОМ и берём id в кавычки до JSON.parse: если площадка
   пришлёт его числом, 19 цифр не влезут в double и id молча станет
   соседним. Успех у TikTok — error.code === 'ok', а не HTTP 200. */
async function ttQuery(access, ids) {
  const list = [...new Set((ids || []).map(String).filter((x) => /^\d{1,25}$/.test(x)))].slice(0, 20);
  if (!list.length) return [];
  let last;
  for (let i = 0; i < 2; i++) {
    let r, txt;
    try {
      r = await fetch(TT_API_BASE + '/v2/video/query/?fields=' + TT_QUERY_FIELDS, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + access },
        body: JSON.stringify({ filters: { video_ids: list } }),
        signal: AbortSignal.timeout(12000),
      });
      txt = await r.text();
    } catch (e) { last = e; continue; }
    let j;
    try { j = JSON.parse(txt.replace(/("id"\s*:\s*)(\d{16,})/g, '$1"$2"')); }
    catch (e) { throw ttErr('tiktok', 'TikTok ответил не JSON (HTTP ' + r.status + ')'); }
    const code = String((j && j.error && j.error.code) || '');
    if (code !== 'ok') {
      throw ttErr(ttCodeOf(code), 'TikTok: ' + (code || ('HTTP ' + r.status))
        + (j && j.error && j.error.message ? ' — ' + String(j.error.message).slice(0, 160) : ''));
    }
    const vids = j && j.data && Array.isArray(j.data.videos) ? j.data.videos : [];
    return vids.map(ttVid).filter((v) => v.id);
  }
  throw ttErr('tiktok', 'TikTok не ответил: ' + ((last && last.message) || 'нет связи'));
}

/* ── YouTube ──
   videos.list отдаёт по id название, обложку, дату, длительность (ISO 8601),
   статус доступа, канал и счётчики. Спрашиваем ключом API (YT_API_KEY),
   а без него — доступом выбранного канала блогера (ytAccess). */
function ytIsoSec(s) {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(String(s || ''));
  if (!m || String(s) === 'P' || String(s) === 'PT') return null;
  return Number(m[1] || 0) * 86400 + Number(m[2] || 0) * 3600 + Number(m[3] || 0) * 60 + Math.round(Number(m[4] || 0));
}
function ytThumb(id) { return YT_ID_RE.test(String(id || '')) ? 'https://i.ytimg.com/vi/' + id + '/hqdefault.jpg' : null; }
function ytVid(it) {
  const n = (x) => Math.max(0, Math.round(Number(x) || 0));
  const sn = (it && it.snippet) || {}, stt = (it && it.statistics) || {};
  const cd = (it && it.contentDetails) || {}, st = (it && it.status) || {};
  const th = sn.thumbnails || {};
  const cover = String(((th.high || th.medium || th.default || {}).url) || '');
  const at = Date.parse(String(sn.publishedAt || ''));
  return {
    id: String((it && it.id) || ''),
    at: Number.isFinite(at) ? Math.floor(at / 1000) : 0,
    cover: /^https:\/\//i.test(cover) ? cover.slice(0, 1000) : '',
    share: '',
    title: String(sn.title || '').slice(0, 150),
    duration: ytIsoSec(cd.duration),
    views: n(stt.viewCount), likes: n(stt.likeCount), comments: n(stt.commentCount), shares: 0,
    /* Оценке накрутки: репостов YouTube не отдаёт вовсе, а без likeCount /
       commentCount лайки скрыты / комментарии выключены — это «неизвестно»,
       а не ноль (аудит 16.10.2026, #31). */
    noShares: true, likesHidden: stt.likeCount == null, commentsOff: stt.commentCount == null,
    channelId: String(sn.channelId || ''),
    channelTitle: String(sn.channelTitle || '').slice(0, 80),
    privacy: String(st.privacyStatus || ''),
  };
}
/* Ответ Google → наш код. По доступу канала 401 — протух (token), 403 «не
   хватает прав» — нет права на чтение (scope). Остальное (квота, ключ,
   сбой) — сбой площадки: человек тут ничего не починит. */
function ytCodeOf(status, j, viaToken) {
  const errs = j && j.error && Array.isArray(j.error.errors) ? j.error.errors : [];
  const reason = String((errs[0] && errs[0].reason) || (j && j.error && j.error.status) || '');
  if (viaToken && (status === 401 || /authError|UNAUTHENTICATED/i.test(reason))) return 'token';
  if (viaToken && status === 403 && /insufficientPermissions|PERMISSION_DENIED/i.test(reason)) return 'scope';
  return 'youtube';
}
/* Квота YouTube Data API — одна на весь проект (по умолчанию 10 000
   единиц в сутки, videos.list стоит 1). Загрузки берут из неё не больше
   70 %: остальное — запас под замеры при зачёте и суточное обновление,
   иначе один настойчивый аккаунт выжег бы квоту, и выплаты встали бы.
   Сутки у Google — по тихоокеанскому времени; считаем по UTC−8. Счёт в
   памяти процесса: после перезапуска он начнётся заново — это запас, а
   не точный учёт. */
const YT_DAY_UNITS = Math.max(100, Math.round(Number(ENV.YT_DAILY_UNITS) || 10000));
const YT_BIND_UNITS = Math.floor(YT_DAY_UNITS * 0.7);
const ytUnits = { day: '', n: 0, code: 0 };   /* code — из них на подключение кодом */
function ytUnitsNow() {
  const d = new Date(Date.now() - 8 * 3600e3).toISOString().slice(0, 10);
  if (ytUnits.day !== d) { ytUnits.day = d; ytUnits.n = 0; ytUnits.code = 0; }
  return ytUnits;
}
function ytBindRoom() { return ytUnitsNow().n < YT_BIND_UNITS; }
/* Ответ videos.list при загрузке живёт 3 минуты: повтор той же ссылки
   (в том числе отказ «не ваш», «слишком короткое») квоту не тратит.
   Замеры подсчёта и обновление идут мимо — им нужны свежие цифры. */
const ytLook = new Map();
const YT_LOOK_MS = 3 * 60000;
function ytLookGet(k) {
  const c = ytLook.get(k);
  if (!c) return null;
  if (Date.now() - c.at > YT_LOOK_MS) { ytLook.delete(k); return null; }
  return c.items;
}
function ytLookSet(k, items) {
  ytLook.set(k, { at: Date.now(), items });
  if (ytLook.size > 2000) ytLook.delete(ytLook.keys().next().value);
}
/* Не больше limit раз за ms на человека — с любого адреса (rateLimit
   считает пару «человек + адрес»). */
const VID_YT_HOUR = 30;
const vidYtHour = new Map();
function vidUserQuota(map, key, limit, ms) {
  const now = Date.now();
  const arr = (map.get(key) || []).filter((t) => now - t < ms);
  if (arr.length >= limit) { map.set(key, arr); return false; }
  arr.push(now);
  map.set(key, arr);
  if (map.size > 5000) map.delete(map.keys().next().value);
  return true;
}
async function ytVideos(ids, how) {
  const list = [...new Set((ids || []).map(String).filter((x) => YT_ID_RE.test(x)))].slice(0, 50);
  if (!list.length) return [];
  const qs = new URLSearchParams({ part: 'snippet,statistics,contentDetails,status', id: list.join(','), maxResults: '50' });
  if (how && how.key) qs.set('key', how.key);
  const headers = how && how.access ? { Authorization: 'Bearer ' + how.access } : {};
  let last;
  for (let i = 0; i < 2; i++) {
    let r, j;
    try {
      ytUnitsNow().n++;
      r = await fetch(YT_API_BASE + '/youtube/v3/videos?' + qs.toString(), { headers, signal: AbortSignal.timeout(12000) });
      j = await r.json().catch(() => null);
    } catch (e) { last = e; continue; }
    if (r.ok && j) return (Array.isArray(j.items) ? j.items : []).map(ytVid).filter((v) => v.id);
    const code = ytCodeOf(r.status, j, !!(how && how.access));
    if (code === 'youtube' && r.status >= 500) { last = new Error('HTTP ' + r.status); continue; }
    throw ttErr(code, 'YouTube: HTTP ' + r.status
      + (j && j.error && j.error.message ? ' — ' + String(j.error.message).slice(0, 160) : ''));
  }
  throw ttErr('youtube', 'YouTube не ответил: ' + ((last && last.message) || 'нет связи'));
}
/* ── YouTube: подключение кодом в описании канала (15.10.2026) ──────────
   Ссылка на канал → { id } или { handle }. Принимаем youtube.com/@имя,
   youtube.com/channel/UC…, m./www., просто @имя или UC-номер. */
const YT_CODE_TTL = 30 * 60 * 1000;
const ytCode = new Map();               /* id человека → { channel, code, at, tries } */
function ytCodeSweep() { const now = Date.now(); for (const [k, v] of ytCode) if (now - v.at > YT_CODE_TTL) ytCode.delete(k); }
function ytNewCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c = '';
  for (let i = 0; i < 6; i++) c += A[crypto.randomInt(A.length)];
  return 'BP-' + c;
}
function ytHasCode(desc, code) {
  const flat = (x) => String(x || '').toUpperCase().replace(/[\s\u00a0\u200b]+/g, '');
  return !!code && flat(desc).includes(flat(code));
}
function ytChannelRef(raw) {
  const s = String(raw == null ? '' : raw).trim().slice(0, 300);
  if (!s) return null;
  let m = /(?:^|\/)channel\/(UC[\w-]{22})(?:[/?#]|$)/.exec(s) || /^(UC[\w-]{22})$/.exec(s);
  if (m) return { id: m[1] };
  m = /(?:^|youtube\.com\/|youtu\.be\/)@([\p{L}\p{N}_.\-]{3,100})/iu.exec(s) || /^@([\p{L}\p{N}_.\-]{3,100})$/u.exec(s);
  if (m) return { handle: '@' + m[1] };
  if (/^[\p{L}\p{N}_\-]{3,100}$/u.test(s)) return { handle: '@' + s };
  return null;
}
/* канал открытым ключом: имя, счётчики, аватар и ОПИСАНИЕ (в нём код) */
async function ytChannelGet(ref) {
  const qs = new URLSearchParams({ part: 'snippet,statistics', key: YT_API_KEY });
  if (ref.id) qs.set('id', ref.id); else qs.set('forHandle', ref.handle);
  ytUnitsNow().n++;
  const r = await fetch(YT_API_BASE + '/youtube/v3/channels?' + qs.toString(), { signal: AbortSignal.timeout(12000) });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error('YouTube: HTTP ' + r.status);
  const it = j && Array.isArray(j.items) ? j.items[0] : null;
  if (!it || !it.id) return null;
  const sn = it.snippet || {}, st = it.statistics || {}, th = sn.thumbnails || {};
  return {
    id: String(it.id), title: String(sn.title || '').slice(0, 200), url: 'https://youtube.com/channel/' + it.id,
    subs: Number(st.subscriberCount) || 0, avatar: String((th.medium || th.default || {}).url || ''),
    username: String(sn.customUrl || '').slice(0, 120), videosTotal: Number(st.videoCount) || 0,
    description: String(sn.description || ''),
  };
}
/* Квота при подключении кодом (разбор 16.10). /code и /check спрашивают
   channels.list — это та же квота проекта, что у загрузок и замеров; без
   предела один человек по кругу выжигал её за несколько часов, и у всех
   вставали загрузки и суточные начисления по YouTube. Теперь: на всех —
   не больше 10 % суточной квоты и только пока у загрузок есть место
   (ytBindRoom), запас под замеры не трогаем; на человека — 40 запросов к
   YouTube за сутки с любых адресов; ответ по каналу живёт 30 с (повтор
   «Проверить» или той же ссылки квоту не тратит — описание YouTube и сам
   обновляет не сразу). Сверх — ttErr 'yt_code_quota' / 'yt_code_often'. */
const YT_CODE_UNITS = Math.max(20, Math.floor(YT_DAY_UNITS * 0.1));
const YT_CODE_USER_DAY = 40;
const ytCodeUser = new Map();
const YT_CHAN_MS = ENV.YT_CHAN_CACHE_MS != null && ENV.YT_CHAN_CACHE_MS !== '' && Number(ENV.YT_CHAN_CACHE_MS) >= 0
  ? Math.min(300000, Number(ENV.YT_CHAN_CACHE_MS)) : 30000;
const ytChan = new Map();
async function ytChannelFor(uid, ref) {
  const key = ref.id ? 'id:' + ref.id : 'h:' + String(ref.handle || '').toLowerCase();
  const c = ytChan.get(key);
  if (c && Date.now() - c.at < YT_CHAN_MS) return c.ch;
  if (c) ytChan.delete(key);
  const units = ytUnitsNow();
  if (units.code >= YT_CODE_UNITS || !ytBindRoom()) throw ttErr('yt_code_quota');
  if (!vidUserQuota(ytCodeUser, uid, YT_CODE_USER_DAY, 24 * 3600e3)) throw ttErr('yt_code_often');
  units.code++;
  const ch = await ytChannelGet(ref);
  if (YT_CHAN_MS > 0) {
    const at = Date.now();
    ytChan.set(key, { at, ch });
    if (ch) ytChan.set('id:' + ch.id, { at, ch });
    while (ytChan.size > 2000) ytChan.delete(ytChan.keys().next().value);
  }
  return ch;
}
function ytCodeFail(e) {
  const c = e && e.vidCode;
  if (c === 'yt_code_quota') {
    return { status: 503, body: { code: 'yt_quota',
      error: 'Подключение YouTube на сегодня недоступно: дневной лимит проверок YouTube исчерпан. Попробуйте завтра.' } };
  }
  if (c === 'yt_code_often') {
    return { status: 429, body: { code: 'often', error: 'Слишком много проверок YouTube за сутки — попробуйте завтра.' } };
  }
  return { status: 502, body: { error: 'YouTube не ответил — попробуйте ещё раз' } };
}
/* Свежий доступ к YouTube-каналу. Google живёт часом, дальше меняем по
   refresh (его даёт access_type=offline при подтверждении канала).
   Пусто — обновить нечем, канал надо переподключить: refresh нет, или
   Google сказал invalid_grant / unauthorized_client (доступ отозван).
   Сбой самого Google (5xx, не JSON, нет связи) — это не «доступ истёк»:
   повторяем и бросаем 'youtube', чтобы не просить человека зря. */
async function ytAccess(row) {
  const cfg = OAUTH.youtube;
  if (!row || !row.access) return '';
  const alive = row.expires_at && new Date(row.expires_at).getTime() > Date.now() + 60000;
  if (alive) return row.access;
  if (!row.refresh || !cfg.id || !cfg.secret) return '';
  let t = null, last;
  for (let i = 0; i < 2 && !t; i++) {
    try {
      const r = await fetch(YT_TOKEN_URL, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: cfg.id, client_secret: cfg.secret,
          grant_type: 'refresh_token', refresh_token: row.refresh,
        }),
        signal: AbortSignal.timeout(12000),
      });
      const j = await r.json().catch(() => null);
      if (r.ok && j && j.access_token) { t = j; break; }
      const err = String((j && j.error) || '');
      if (err === 'invalid_grant' || err === 'unauthorized_client') return '';
      last = new Error('HTTP ' + r.status + (err ? ' ' + err : (j ? '' : ', не JSON')));
    } catch (e) { last = e; }
  }
  if (!t) throw ttErr('youtube', 'Google не обновил доступ: ' + ((last && last.message) || 'нет связи'));
  const exp = t.expires_in ? new Date(Date.now() + Number(t.expires_in) * 1000).toISOString() : null;
  q.putToken.run(row.user_id, row.platform, row.external_id, t.access_token, t.refresh_token || row.refresh, exp);
  return t.access_token;
}

/* ── Instagram (15.10.2026) ──
   Ролики берём ТОЛЬКО доступом подключённого аккаунта: /me/media отдаёт
   публикации владельца доступа — значит, найденный там ролик его. Ссылка
   даёт короткий код (instagram.com/reel/<код>/), номер публикации ищем по
   нему среди последних публикаций (IG_PAGES страниц по 50). Просмотры —
   insights (views; у старых версий площадки — plays). Доступ долгий (60
   дней) и продлевается сам, пока аккаунтом пользуются. */
const IG_PAGES = 4;
const IG_CODE_RE = /^[A-Za-z0-9_-]{5,40}$/;
const IG_ID_RE = /^\d{5,30}$/;
const IG_FIELDS = 'id,caption,media_type,media_product_type,permalink,shortcode,thumbnail_url,timestamp,like_count,comments_count';
const IG_GRAPH_ORIGIN = (() => { try { return new URL(IG_GRAPH_BASE).origin; } catch (e) { return ''; } })();
function igUrl(path) { return IG_GRAPH_BASE + (IG_GRAPH_VER ? '/' + IG_GRAPH_VER : '') + path; }
/* Ошибка Graph → наш код: 190 — доступ протух или отозван (token), 10 и
   200–299 — нет права (scope), остальное — сбой площадки. */
function igCodeOf(j, status) {
  const c = Number(j && j.error && j.error.code) || 0;
  if (c === 190 || status === 401) return 'token';
  if (c === 10 || (c >= 200 && c < 300)) return 'scope';
  return 'instagram';
}
async function igGet(address) {
  let last;
  for (let i = 0; i < 2; i++) {
    let r, j;
    try {
      r = await fetch(address, { signal: AbortSignal.timeout(12000) });
      j = await r.json().catch(() => null);
    } catch (e) { last = e; continue; }
    if (r.ok && j && !j.error) return j;
    if (r.status >= 500 && i === 0) { last = new Error('HTTP ' + r.status); continue; }
    const err = ttErr(igCodeOf(j, r.status), 'Instagram: HTTP ' + r.status
      + (j && j.error && j.error.message ? ' — ' + String(j.error.message).slice(0, 160) : ''));
    err.igCode = Number(j && j.error && j.error.code) || 0;
    throw err;
  }
  throw ttErr('instagram', 'Instagram не ответил: ' + ((last && last.message) || 'нет связи'));
}
/* Свежий доступ. Долгий токен Instagram продлевается им же самим (refresh
   отдельно нет): за 15 дней до конца и не чаще раза в сутки. Протух —
   пусто, аккаунт надо переподключить. */
async function igAccess(row) {
  if (!row || !row.access) return '';
  const now = Date.now();
  const exp = row.expires_at ? new Date(row.expires_at).getTime() : 0;
  if (exp && exp <= now + 60000) return '';
  const upd = Date.parse(String(row.updated_at || '').replace(' ', 'T') + 'Z') || 0;
  if (exp && exp - now < 15 * 864e5 && now - upd > 864e5) {
    try {
      const j = await igGet(IG_GRAPH_BASE + '/refresh_access_token?'
        + new URLSearchParams({ grant_type: 'ig_refresh_token', access_token: row.access }));
      if (j && j.access_token) {
        const e2 = new Date(now + (Number(j.expires_in) || 60 * 86400) * 1000).toISOString();
        q.putToken.run(row.user_id, row.platform, row.external_id, j.access_token, null, e2);
        return j.access_token;
      }
    } catch (e) { /* продлить не вышло — прежний ещё живёт */ }
  }
  return row.access;
}
/* Просмотры, лайки, комментарии, репосты ролика. Имя метрики просмотров у
   площадки сменилось (plays → views) — спрашиваем новое, затем старое. */
async function igInsights(access, id) {
  const pick = (j) => {
    const out = {};
    for (const m of (j && Array.isArray(j.data) ? j.data : [])) {
      const v = m && (m.total_value ? m.total_value.value : (Array.isArray(m.values) && m.values[0] ? m.values[0].value : null));
      if (m && m.name && v != null) out[m.name] = Math.max(0, Math.round(Number(v) || 0));
    }
    return out;
  };
  for (const metric of ['views,likes,comments,shares', 'plays,likes,comments,shares']) {
    try {
      const j = await igGet(igUrl('/' + encodeURIComponent(id) + '/insights') + '?' + new URLSearchParams({ metric, access_token: access }));
      const o = pick(j);
      if (o.views == null && o.plays != null) o.views = o.plays;
      if (o.views != null) return o;
    } catch (e) {
      /* 100 — такой метрики у этой версии нет: пробуем прежнее имя */
      if (e.vidCode === 'token' || e.vidCode === 'scope' || e.igCode !== 100) throw e;
    }
  }
  throw ttErr('instagram', 'Instagram не отдал просмотры ролика');
}
function igVid(m, ins) {
  const n = (x) => Math.max(0, Math.round(Number(x) || 0));
  const at = Date.parse(String((m && m.timestamp) || ''));
  const cover = String((m && m.thumbnail_url) || ''), link = String((m && m.permalink) || '');
  const i = ins || {};
  return {
    id: String((m && m.id) || ''), code: String((m && m.shortcode) || ''),
    at: Number.isFinite(at) ? Math.floor(at / 1000) : 0,
    cover: /^https:\/\//i.test(cover) ? cover.slice(0, 1000) : '',
    share: /^https:\/\/(www\.)?instagram\.com\/[^\s"'<>]+$/i.test(link) ? link.slice(0, 300) : '',
    title: String((m && m.caption) || '').replace(/\s+/g, ' ').trim().slice(0, 150),
    duration: null,
    views: n(i.views), likes: i.likes != null ? n(i.likes) : n(m && m.like_count),
    comments: i.comments != null ? n(i.comments) : n(m && m.comments_count), shares: n(i.shares),
    video: !!m && (String(m.media_product_type || '') === 'REELS' || String(m.media_type || '') === 'VIDEO'),
  };
}
/* Публикация по короткому коду среди последних публикаций аккаунта. */
async function igFind(access, code) {
  if (!IG_CODE_RE.test(String(code || ''))) return null;
  const inLink = new RegExp('/(?:reels?|p|tv)/' + code + '(?:/|[?#]|$)');
  let next = igUrl('/me/media') + '?' + new URLSearchParams({ fields: IG_FIELDS, limit: '50', access_token: access });
  for (let page = 0; page < IG_PAGES && next; page++) {
    const j = await igGet(next);
    const hit = (Array.isArray(j.data) ? j.data : []).find((m) => m
      && (String(m.shortcode || '') === code || inLink.test(String(m.permalink || ''))));
    if (hit) return hit;
    const nx = j.paging && j.paging.next ? String(j.paging.next) : '';
    /* дальше — только по адресу самой площадки */
    next = (() => { try { return IG_GRAPH_ORIGIN && new URL(nx).origin === IG_GRAPH_ORIGIN ? nx : ''; } catch (e) { return ''; } })();
  }
  return null;
}
function igEmbed(url) {
  const m = /instagram\.com\/(?:[\w.]+\/)?(?:reels?|p|tv)\/([A-Za-z0-9_-]{5,40})/i.exec(String(url || ''));
  return m ? 'https://www.instagram.com/reel/' + m[1] + '/embed/' : '';
}
/* YouTube Shorts ли ролик: true / false, null — не узнали. Нет связи или
   площадка увела на согласие — решаем по длительности (Shorts — до 3
   минут). Ответ помним. */
const ytShortSeen = new Map();
async function ytIsShort(id) {
  if (!YT_ID_RE.test(String(id || ''))) return null;
  if (ytShortSeen.has(id)) return ytShortSeen.get(id);
  let res = null;
  for (const method of ['HEAD', 'GET']) {
    try {
      const r = await fetch(YT_WEB_BASE + '/shorts/' + id, {
        method, redirect: 'manual', headers: { 'User-Agent': TT_UA }, signal: AbortSignal.timeout(6000) });
      try { if (r.body && r.body.cancel) r.body.cancel(); } catch (e) { /* тело не нужно */ }
      if (r.status === 405 && method === 'HEAD') continue;
      if (r.status === 200) res = true;
      else if (r.status >= 300 && r.status < 400 && /\/watch\b|[?&]v=/.test(String(r.headers.get('location') || ''))) res = false;
    } catch (e) { /* нет связи — по длительности */ }
    break;
  }
  /* нет ответа — «неизвестно» (null): догадку по длительности делает только
     проверка задания «только Shorts», подпись ролика её не берёт */
  if (res !== null) {
    ytShortSeen.set(id, res);
    if (ytShortSeen.size > 5000) ytShortSeen.delete(ytShortSeen.keys().next().value);
  }
  return res;
}
/* Код сбоя по площадке ссылки. */
function vidPlatErr(p) { return VID_PLAT[p] ? p : 'tiktok'; }

/* Цифры роликов ОДНОГО канала блогера — только найденные и только этого
   канала. Бросает ttErr с кодом token / scope / tiktok / youtube / instagram. */
async function vidFetch(platform, userId, extId, ids) {
  const list = (ids || []).map(String);
  if (platform === 'instagram') {
    const access = await igAccess(q.getToken.get(userId, 'instagram', String(extId)));
    if (!access) throw ttErr('token');
    const out = [];
    for (const id of list) {
      if (!IG_ID_RE.test(id)) continue;
      let m;
      try { m = await igGet(igUrl('/' + id) + '?' + new URLSearchParams({ fields: IG_FIELDS, access_token: access })); }
      catch (e) {
        /* публикации нет (удалена) — не отдаём её: круг сочтёт промах */
        if (e.vidCode === 'instagram' && e.igCode === 100) continue;
        throw e;
      }
      out.push(igVid(m, await igInsights(access, id)));
    }
    return out;
  }
  if (platform === 'youtube') {
    let how;
    if (YT_API_KEY) how = { key: YT_API_KEY };
    else {
      const access = await ytAccess(q.getToken.get(userId, 'youtube', String(extId)));
      if (!access) throw ttErr('token');
      how = { access };
    }
    const out = [];
    for (let i = 0; i < list.length; i += 50) out.push(...await ytVideos(list.slice(i, i + 50), how));
    return out.filter((v) => v.channelId === String(extId));
  }
  const tok = q.getToken.get(userId, 'tiktok', String(extId));
  let access = '';
  try { access = tok ? await ttAccess(tok) : ''; }
  catch (e) { throw ttErr('tiktok', String((e && e.message) || e)); }
  if (!access) throw ttErr('token');
  const out = [];
  for (let i = 0; i < list.length; i += 20) out.push(...await ttQuery(access, list.slice(i, i + 20)));
  return out;
}
/* Ролик виден всем. Закрытый или «по ссылке» на YouTube — для задания
   его всё равно что нет: рекламу в нём никто не увидит. */
function vidSeen(platform, v) {
  return platform !== 'youtube' || !v.privacy || v.privacy === 'public';
}

/* Чей ролик. chans — каналы площадки, среди которых ищем (один, если
   блогер выбрал аккаунт). Если ни один канал не ответил, причину берём
   самую полезную человеку: права → доступ → сбой площадки. */
async function vidLocate(userId, link, chans, chosen) {
  const p = link.platform;
  let id = link.id, page = link.url;
  if (link.photo) return { fail: 'not_video' };
  if (p === 'tiktok' && !id) {
    try { const r = await ttResolve(link.url); id = r.id; page = r.url; }
    catch (e) { return { fail: e.vidCode || 'tiktok' }; }
  }
  const rank = { scope: 3, token: 2, tiktok: 1, youtube: 1, instagram: 1 };
  let why = '';
  const note = (code) => { if (!why || (rank[code] || 0) > (rank[why] || 0)) why = code; };
  const yours = chosen ? { chosen: true, handle: vidShowName(chans[0]) } : {};

  if (p === 'instagram') {
    if (!IG_CODE_RE.test(String(link.code || ''))) return { fail: 'bad_url' };
    let answered = false;
    for (const ch of chans) {
      if (!ch.has_token) { note('token'); continue; }
      let access = '';
      try { access = await igAccess(q.getToken.get(userId, 'instagram', String(ch.external_id))); }
      catch (e) { note(e.vidCode || 'instagram'); continue; }
      if (!access) { note('token'); continue; }
      let m = null;
      try { m = await igFind(access, link.code); answered = true; }
      catch (e) { note(e.vidCode || 'instagram'); continue; }
      if (!m) continue;
      const v0 = igVid(m, null);
      if (!v0.video) return { fail: 'not_video' };
      if (!IG_ID_RE.test(v0.id)) return { fail: 'instagram' };
      let ins;
      try { ins = await igInsights(access, v0.id); }
      catch (e) { return { fail: e.vidCode || 'instagram' }; }
      return { owner: ch, v: igVid(m, ins), id: v0.id, page: link.url };
    }
    if (!answered) return { fail: why || 'instagram' };
    return { fail: 'not_yours', x: yours };
  }

  if (p === 'tiktok') {
    let answered = false;
    for (const ch of chans) {
      if (!ch.has_token) { note('token'); continue; }
      try {
        const got = await vidFetch('tiktok', userId, ch.external_id, [id]);
        answered = true;
        const hit = got.find((x) => x.id === id);
        if (hit) return { owner: ch, v: hit, id, page };
      } catch (e) { note(e.vidCode || 'tiktok'); }
    }
    if (!answered) return { fail: why || 'tiktok' };
    /* Свои каналы ответили, ролика среди своих нет. Есть ли он вообще? */
    const emb = await ttOembed(vidCanon('', vidHandleOf(page.pathname), id, page));
    if (!emb.ok && (emb.status === 400 || emb.status === 404)) return { fail: 'not_found' };
    return { fail: 'not_yours', x: yours };
  }

  let items = [];
  if (YT_API_KEY) {
    const ck = 'k|' + id;
    items = ytLookGet(ck);
    if (!items) {
      try { items = await ytVideos([id], { key: YT_API_KEY }); }
      catch (e) { return { fail: e.vidCode || 'youtube' }; }
      ytLookSet(ck, items);
    }
  } else {
    /* Без ключа спрашиваем доступом канала. Публичный ролик видит любой
       доступ; закрытый — только доступ его владельца, поэтому при пустом
       ответе пробуем остальные свои каналы. */
    let answered = false;
    for (const ch of chans) {
      if (!ch.has_token) { note('token'); continue; }
      const ck = 'a|' + userId + '|' + ch.external_id + '|' + id;
      const hit = ytLookGet(ck);
      if (hit) {
        answered = true;
        if (hit.length) { items = hit; break; }
        continue;
      }
      let access = '';
      try { access = await ytAccess(q.getToken.get(userId, 'youtube', String(ch.external_id))); }
      catch (e) { note(e.vidCode || 'youtube'); continue; }
      if (!access) { note('token'); continue; }
      try {
        const got = await ytVideos([id], { access });
        answered = true;
        ytLookSet(ck, got);
        if (got.length) { items = got; break; }
      } catch (e) { note(e.vidCode || 'youtube'); }
    }
    if (!answered) return { fail: why || 'youtube' };
  }
  const v = items.find((x) => x.id === id);
  if (!v) return { fail: 'not_found' };
  const owner = chans.find((c) => String(c.external_id) === v.channelId);
  if (!owner) return { fail: 'not_yours', x: yours };
  if (!vidSeen('youtube', v)) return { fail: 'not_public' };
  return { owner, v, id, page };
}

/* Обложка у TikTok — ссылка с подписью, которая живёт несколько часов.
   Хранить её в базе бессмысленно: держим в памяти свежей и отдаём, пока
   не протухла. У YouTube обложка постоянная — её собираем по id. */
const vidCovers = new Map();
const VID_COVER_MS = 5 * 3600 * 1000;
function vidCoverSet(id, url) {
  if (!url) return;
  vidCovers.set(id, { url, at: Date.now() });
  if (vidCovers.size > 5000) vidCovers.delete(vidCovers.keys().next().value);
}
function vidCoverOf(id) {
  const c = vidCovers.get(id);
  if (!c) return null;
  if (Date.now() - c.at > VID_COVER_MS) { vidCovers.delete(id); return null; }
  return c.url;
}
function dayOf(ms) { return new Date(ms).toISOString().slice(0, 10); }
function vidHandleOf(s) {
  const m = /\/@([\w.-]{1,40})\/video\//.exec(String(s || ''));
  return m ? m[1] : '';
}
/* Ник канала без «@» (у YouTube customUrl приходит как «@name»). */
function vidNick(s) {
  const t = String(s == null ? '' : s).trim().replace(/^@+/, '');
  return /^[\w.\-À-ɏЀ-ӿ]{1,60}$/.test(t) ? t : '';
}
/* Как назвать канал человеку: «@ник» или название. */
function vidShowName(c) {
  if (!c) return '';
  const n = vidNick(c.username);
  return n ? '@' + n : String(c.title || '').trim().slice(0, 60);
}
function vidHttps(u) { const s = String(u || ''); return /^https:\/\/[^\s"'<>]+$/i.test(s) ? s.slice(0, 1000) : ''; }
/* Постоянная ссылка ролика TikTok: без меток ?_r=1 и с ником, если он известен. */
function vidCanon(share, handle, id, page) {
  if (handle) return 'https://www.tiktok.com/@' + handle + '/video/' + id;
  try { const s = new URL(share); if (ttUrlOk(s)) return s.origin + s.pathname; } catch (e) { /* ниже */ }
  if (page && TT_VID_RE.test(page.pathname)) return page.origin + page.pathname;
  return 'https://www.tiktok.com/video/' + id;
}

/* Задание (оффер) — это конверт kind='camp': a_id — его автор, данные — в
   том виде, в каком их пишет приложение. Сервер их не правит, только читает. */
function vidCamp(campId) {
  const env = q.syncGet.get('camp', String(campId));
  if (!env) return null;
  let camp = null;
  try { camp = JSON.parse(env.data); } catch (e) { camp = null; }
  if (!camp || typeof camp !== 'object') return null;
  return { env, camp };
}
function vidCampName(ci) {
  return String((ci && ci.camp && (ci.camp.name || ci.camp.title)) || 'Задание').slice(0, 80);
}
/* Время в любом виде, которое пишет приложение: ISO-строка, мс или секунды. */
function vidMs(v) {
  if (v == null || v === '') return 0;
  const n = Number(v);
  if (Number.isFinite(n) && n > 0) return n < 1e11 ? n * 1000 : n;
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : 0;
}
/* Срок задания. Шторка «Условия задания» пишет его датой без времени
   («2026-10-10» из <input type=date>), а Date.parse читает такую дату как
   полночь UTC — и ролик, вышедший днём последнего дня, оказался бы «после
   срока». Дата без времени — это конец того дня по Москве. */
function vidDeadline(v) {
  const s = String(v == null ? '' : v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const t = Date.parse(s + 'T23:59:59.999+03:00');
    return Number.isFinite(t) ? t : 0;
  }
  return vidMs(v);
}
/* Когда оффер появился: из самого оффера, а если поля нет — когда его
   конверт впервые лёг на сервер (SQLite хранит это в UTC без пояса). */
function vidCampCreated(ci) {
  const own = vidMs(ci.camp.createdAt);
  if (own) return own;
  const t = Date.parse(String(ci.env.created_at || '').replace(' ', 'T') + 'Z');
  return Number.isFinite(t) ? t : 0;
}
/* Площадки оффера приходят по-разному: списком, строкой «tt,tg» или
   объектом {tt:true, yt:false}, и в двух полях — platforms и
   platformsList (мастер заданий пишет второе), а у старых — одной
   строкой platform. Берём объединение, имена приводим к одному виду. */
function vidPlatList(v) {
  if (typeof v === 'string') v = v.split(/[,;\s]+/);
  else if (v && typeof v === 'object' && !Array.isArray(v)) v = Object.keys(v).filter((k) => v[k]);
  if (!Array.isArray(v)) return [];
  return v.map((x) => String((x && typeof x === 'object' ? (x.id || x.key || x.platform) : x) || '').trim().toLowerCase())
    .filter(Boolean);
}
const VID_SYN = { tt: 'tiktok', tiktok: 'tiktok', 'тикток': 'tiktok', yt: 'youtube', youtube: 'youtube', 'ютуб': 'youtube',
  ys: 'shorts', yts: 'shorts', shorts: 'shorts', youtube_shorts: 'shorts', youtubeshorts: 'shorts', 'шортс': 'shorts',
  tg: 'telegram', telegram: 'telegram', ig: 'instagram', inst: 'instagram', insta: 'instagram', instagram: 'instagram',
  reels: 'instagram', 'инстаграм': 'instagram', vk: 'vk', vkontakte: 'vk', twitch: 'twitch' };
const VID_PNAMES = { tiktok: 'TikTok', youtube: 'YouTube', shorts: 'YouTube Shorts', telegram: 'Telegram', instagram: 'Instagram',
  vk: 'VK', twitch: 'Twitch', rutube: 'RUTUBE', dzen: 'Дзен' };
function vidPlatNorm(x) { const k = String(x == null ? '' : x).trim().toLowerCase(); return VID_SYN[k] || k; }
function vidCampPlats(camp) {
  let all = vidPlatList(camp.platforms).concat(vidPlatList(camp.platformsList));
  if (!all.length && typeof camp.platform === 'string') all = vidPlatList(camp.platform);
  return [...new Set(all.map(vidPlatNorm).filter(Boolean))];
}
/* Видео с этой площадки оффер принимает? Площадки не заданы — TikTok и
   YouTube. ФОРМАТ оффера (клипы, баннеры, UGC) не ограничивает. */
function vidCampAllows(camp, platform) {
  const all = vidCampPlats(camp);
  if (!all.length) return platform === 'tiktok' || platform === 'youtube';
  /* «YouTube Shorts» — тот же YouTube-канал, но только Shorts (проверка при загрузке) */
  if (platform === 'youtube') return all.includes('youtube') || all.includes('shorts');
  return all.includes(platform);
}
/* Задание только для Shorts: YouTube разрешён лишь как Shorts. */
function vidCampShortsOnly(camp) { const all = vidCampPlats(camp); return all.includes('shorts') && !all.includes('youtube'); }
function vidCampPlatNames(camp) {
  return vidCampPlats(camp).map((p) => VID_PNAMES[p] || (p.charAt(0).toUpperCase() + p.slice(1)).slice(0, 24)).join(', ');
}
/* Оффер принимает видео: он активен и в заморозке есть деньги — без них
   платить было бы не из чего. Срок задания сюда не входит: после срока
   ролик, вышедший ДО него, загрузить можно (как в More Views — блогер
   сам решает, когда зафиксировать просмотры), а вышедший после — нет
   (too_late). */
function vidCampOpen(ci, campId) {
  if (ci.camp.status !== 'active') return false;
  const d = q.deal.get('camp:' + campId);
  return !!(d && d.status === 'held' && d.amount - d.paid > 0);
}
/* Условия оффера, по которым считается ролик, — снимок в момент загрузки.
   Конверт оффера рекламодатель переписывает сам (sync/put), и считай мы
   по живому конверту, после загрузки он мог бы поставить ставку в ноль. */
function vidTermsOf(c) {
  const n = (x) => Math.max(0, Math.round(Number(x) || 0));
  return {
    payMode: c && c.payMode === 'fixed' ? 'fixed' : 'views',
    rate: Math.max(0, Number(c && c.rate) || 0),
    fixedPrice: n(c && c.fixedPrice),
    cap: n(c && (c.maxPayout || c.payMax)),
    minViews: n(c && c.minViews),
  };
}
/* Снимок строки. У старых строк (до снимков) его нет — один раз берём
   живой конверт и сразу записываем: дальше условия уже не поплывут.
   null — ни снимка, ни оффера. */
function vidTerms(row) {
  if (row && row.terms) {
    try { const t = JSON.parse(row.terms); if (t && typeof t === 'object') return t; } catch (e) { /* ниже */ }
  }
  const ci = row ? vidCamp(row.camp_id) : null;
  if (!ci) return null;
  const t = vidTermsOf(ci.camp);
  try { q.vidTerms.run(JSON.stringify(t), row.id); row.terms = JSON.stringify(t); } catch (e) { /* не записалось — посчитаем ещё раз */ }
  return t;
}
/* Сумма по условиям: фикс — fixedPrice, если минимум просмотров взят;
   иначе floor(views × rate / 1000), сверху потолок cap; ниже minViews — 0.
   Остаток заморозки здесь НЕ учитывается: его сверяет выплата, и
   нехватка денег уходит владельцу, а не тихо срезает сумму. */
function vidEarnBy(t, views) {
  if (!t) return 0;
  const n = (x) => Math.max(0, Math.round(Number(x) || 0));
  const v = n(views);
  const minV = n(t.minViews);
  let s;
  if (minV && v < minV) s = 0;
  else if (t.payMode === 'fixed') s = n(t.fixedPrice);
  else {
    s = Math.floor(v * Math.max(0, Number(t.rate) || 0) / 1000);
    const cap = n(t.cap);
    if (cap) s = Math.min(s, cap);
  }
  /* limit — сколько было свободно в бюджете, когда ролик загружали, если
     ролик стоил больше (см. загрузку): дальше этого остатка он не идёт. */
  const lim = n(t.limit);
  if (lim) s = Math.min(s, lim);
  return Math.max(0, s);
}
/* null — условий нет, прежнюю сумму не трогать. */
function vidEarn(row, views) {
  const t = vidTerms(row);
  return t ? vidEarnBy(t, views) : null;
}
/* Просмотры, по которым ролик считается: НАИБОЛЬШИЕ из всех замеров (при
   загрузке, на проверке, за дни подсчёта) — ролик, потерявший часть
   просмотров на площадке, не теряет в деньгах. */
function vidTopViews(r) {
  /* top_views уже включает просмотры при загрузке (их пишет загрузка, и
     дальше он только растёт); submit_views — только для строк, где его нет.
     Иначе база, пересчитанная решением владельца по накрутке (vidRebase),
     снова поднималась бы до накрученного «при загрузке». */
  const top = r.top_views != null ? Number(r.top_views) || 0 : Number(r.submit_views) || 0;
  return Math.max(top, Number(r.views) || 0, Number(r.paid_views) || 0);
}
/* Сколько ролик стоит сейчас по условиям: по наибольшим просмотрам и не
   меньше уже записанного начисления (начисленное не уменьшается). */
function vidEst(r) {
  const e = vidEarn(r, vidTopViews(r));
  return Math.max(Number(r.earned) || 0, e == null ? 0 : e);
}
/* Максимум за ролик: у фикса — fixedPrice, у оплаты за просмотры —
   потолок cap; предел остатком бюджета (limit) режет оба. 0 — потолка нет
   (тогда подсчёт закончит только срок). */
function vidMaxPay(t) {
  if (!t) return 0;
  const n = (x) => Math.max(0, Math.round(Number(x) || 0));
  const lim = n(t.limit);
  let m = t.payMode === 'fixed' ? n(t.fixedPrice) : n(t.cap);
  if (lim) m = m ? Math.min(m, lim) : lim;
  return m;
}
/* Сколько суток подсчёта осталось (вверх: идёт последний день — «1»). */
function vidDaysLeft(r, now) {
  const end = Number(r && r.track_ends_at) || 0;
  return end ? Math.max(0, Math.ceil((end - (now || Date.now())) / 864e5)) : 0;
}
function vidDaysWord(n) {
  const a = Math.abs(Math.round(Number(n) || 0)) % 100, b = a % 10;
  if (a > 10 && a < 20) return 'дней';
  if (b === 1) return 'день';
  if (b >= 2 && b <= 4) return 'дня';
  return 'дней';
}
/* Резерв одного ролика — сколько из бюджета ещё может уйти этому ролику
   по нынешним цифрам: оценка по наибольшим просмотрам минус уже
   выплаченное (не меньше нуля). Закрытый ролик (подсчёт закончен,
   отклонён, удалён, отвязан) ничего не держит. */
const VID_LIVE = new Set(['review', 'rejected', 'active']);
function vidHoldOf(r) {
  if (!r || !VID_LIVE.has(r.status)) return 0;
  return Math.max(0, vidEst(r) - (r.paid || 0));
}
function vidReserved(campId) {
  let s = 0;
  for (const r of q.vidLive.all(String(campId))) s += vidHoldOf(r);
  return s;
}
/* Сколько бюджета ещё МОЖЕТ уйти живым роликам (на проверке,
   возвращённым, в подсчёте) — для ручной выплаты из бюджета задания: у
   ролика с максимумом — максимум минус выплаченное (не меньше резерва),
   без максимума — неизвестно сколько (Infinity: держим весь остаток). */
function vidOwed(campId) {
  let s = 0;
  for (const r of q.vidLive.all(String(campId))) {
    const m = vidMaxPay(vidTerms(r));
    if (!m) return Infinity;
    s += Math.max(vidHoldOf(r), m - (r.paid || 0));
  }
  return s;
}
/* Сколько автор может вернуть себе из бюджета задания прямо сейчас
   (11.10.2026): остаток открытой заморозки минус будущие выплаты живым
   роликам (vidOwed; ролик без потолка держит весь остаток). Это же
   правило — у частичного возврата (/api/deals/refund с amount) и у
   ручной выплаты (/api/deals/release), а число автор видит на доске
   (free) — чтобы шторка «Вернуть в кошелёк» не обещала больше. */
/* Что вернёт «Завершить задание» (полный возврат /api/deals/refund, аудит
   16.10.2026): остаток заморозки и невыбранная комиссия — та же формула,
   что dealFeeBackAll; live — живые ролики (с ними касса откажет videos_live).
   Окно «Завершить» и тост называли сумму по местному журналу, без комиссии. */
function vidCloseOut(campId) {
  const d = q.deal.get('camp:' + campId);
  if (!d || d.status !== 'held') return { rest: 0, feeBack: 0, live: 0 };
  const rest = Math.max(0, d.amount - d.paid), p = Number(d.fee_pct) || 0;
  const feeBack = rest > 0 && p > 0 ? Math.max(0, (Number(d.fee_in) || 0) - (Number(d.fee_back) || 0) - pctUp(d.paid, p)) : 0;
  return { rest, feeBack, live: q.vidLive.all(campId).length };
}
function vidReturnable(campId) {
  const d = q.deal.get('camp:' + campId);
  if (!d || d.status !== 'held') return 0;
  const left = Math.max(0, d.amount - d.paid);
  const owed = vidOwed(campId);
  return owed === Infinity ? 0 : Math.max(0, left - owed);
}
/* Свободно в бюджете задания: остаток заморозки минус резервы. */
function vidFree(campId) {
  const d = q.deal.get('camp:' + campId);
  const left = d && d.status === 'held' ? Math.max(0, d.amount - d.paid) : 0;
  return left - vidReserved(campId);
}
/* Закрытый подсчётом ролик ещё обновляем для показа? — до конца срока
   подсчёта (максимум за ролик бывает взят раньше срока); у строк v2 без
   срока — VID_TRACK_DAYS с публикации. */
function vidTrackEnd(r) {
  return Number(r.track_ends_at) || ((Number(r.posted_at || r.created_at) || 0) + VID_TRACK_MS);
}
function vidTracked(r, now) {
  return !!r && r.status === 'paid' && vidTrackEnd(r) > (now || Date.now());
}
/* Есть ли чем спросить площадку о роликах этого канала. */
function vidReady(c) {
  if (c.platform === 'youtube' && YT_API_KEY) return true;
  if (!c.has_token) return false;
  const exp = c.expires_at ? new Date(c.expires_at).getTime() : 0;
  if (exp && exp > Date.now() + 60000) return true;
  const cfg = OAUTH[c.platform];
  return !!(c.has_refresh && cfg && cfg.id && cfg.secret);
}
/* Не чаще раза в сутки на ключ (в памяти процесса). true — можно. */
function vidOnce(map, key, ms) {
  const now = Date.now();
  if (now - (map.get(key) || 0) < (ms || 864e5)) return false;
  map.delete(key);
  map.set(key, now);
  if (map.size > 5000) map.delete(map.keys().next().value);
  return true;
}
const vidBindSeen = new Map();
const vidTokenSeen = new Map();

/* Объект ролика наружу — один на все ручки. Почему именно накрутка
   подозревается, блогеру не говорим (только уровень): иначе это готовая
   инструкция, как обойти проверку. */
function vidDTO(r, view, opts) {
  let why = [];
  if (view !== 'blogger' && r.risk_why) {
    try { why = JSON.parse(r.risk_why); } catch (e) { why = [String(r.risk_why)]; }
    if (!Array.isArray(why)) why = [];
  }
  const yt = r.platform === 'youtube';
  const vid = String(r.video_id);
  /* earned — начислено по наибольшим просмотрам (на проверке — сколько
     ролик стоит сейчас по условиям); у закрытых — сколько начислено к
     закрытию. paid — выплачено всего. */
  const est = VID_LIVE.has(r.status) ? vidEst(r) : (r.earned || 0);
  const t = vidTerms(r) || {};
  /* Ролик пришёл, когда в бюджете оставалось меньше, чем он стоил: за него
     заплатят не больше этого остатка — человеку надо это видеть. */
  const budgetCap = Number(t.limit) > 0 ? Math.round(Number(t.limit)) : null;
  const maxPay = vidMaxPay(t);
  const minViews = Math.max(0, Math.round(Number(t.minViews) || 0));
  const top = vidTopViews(r);
  const counting = r.status === 'active';
  const feePctV = vidPayFeePct(r.camp_id);
  const out = {
    id: r.id, campId: r.camp_id, bloggerId: r.blogger_id, ownerId: r.owner_id,
    platform: r.platform || 'tiktok', videoId: vid,
    url: r.url || '', handle: r.handle || '', title: r.title || '',
    duration: r.duration == null ? null : r.duration, postedAt: r.posted_at || null,
    /* «мин. N сек» не проверено сервером: площадка не сообщила длину (#27) */
    durUnchecked: r.duration == null && Number(t.durUnchecked) > 0 ? Math.round(Number(t.durUnchecked)) : null,
    views: r.views || 0, likes: r.likes || 0, comments: r.comments || 0, shares: r.shares || 0,
    statsAt: r.stats_at || null,
    submitViews: r.submit_views == null ? null : r.submit_views,
    paidViews: r.paid_views == null ? null : r.paid_views,
    status: r.status, reviewNote: r.review_note || '', reviewedAt: r.reviewed_at || null,
    approvedAt: r.approved_at || null, decision: r.decision || null,
    decisionNote: r.decision_note || '', decidedAt: r.decided_at || null,
    /* Для старых приложений: конец подсчёта (у строк v2 — момент зачёта). */
    windowEndsAt: r.track_ends_at || r.approved_at || null,
    earned: est, paid: r.paid || 0, paidAt: r.paid_at || null,
    /* комиссия с выплат (14.10.2026): ставка задания и суммы «на баланс»
       блогера — paid/earned/maxPay выше по-прежнему из бюджета (gross) */
    feePct: feePctV, paidNet: vidNetOf(r.paid || 0, feePctV), earnedNet: vidNetOf(est, feePctV),
    /* кто смотрит: блогеру приложение показывает суммы «на баланс» (за вычетом
       комиссии), автору задания — суммы из бюджета (14.10.2026) */
    viewer: view || null,
    /* Подсчёт v3: до какого момента считаем, сколько суток осталось
       (только у active), всего суток подсчёта, максимум за ролик (null —
       потолка нет), взят ли он, порог начислений и сколько до него. */
    trackEndsAt: r.track_ends_at || null,
    daysLeft: counting && r.track_ends_at ? vidDaysLeft(r) : null,
    trackDays: VID_TRACK_DAYS,
    maxPay: maxPay || null,
    maxPayNet: maxPay ? vidNetOf(maxPay, feePctV) : null,
    capReached: maxPay > 0 && est >= maxPay,
    minViews,
    viewsToMin: minViews && top < minViews ? minViews - top : 0,
    countViews: top,
    payMode: t.payMode === 'fixed' ? 'fixed' : 'views',
    rate: Math.max(0, Number(t.rate) || 0),
    fixedPrice: Math.max(0, Math.round(Number(t.fixedPrice) || 0)),
    reserved: vidHoldOf(r), budgetCap,
    risk: view === 'blogger' || r.risk == null ? null : r.risk,
    riskLevel: r.risk_level || null, riskWhy: why, riskHold: !!r.risk_hold,
    /* Начисления на паузе не из-за накрутки: не хватило денег в
       заморозке или нет доступа к каналу. Вид паузы видят все (блогеру он
       нужен, чтобы знать, переподключать ли канал), текст причины —
       рекламодатель и владелец. */
    payHold: !!r.pay_hold,
    holdKind: r.pay_hold ? (r.hold_kind || 'money') : null,
    holdReason: view !== 'blogger' && r.pay_hold ? (r.pay_why || '') : '',
    /* Пометка для владельца: например, подсчёт закрыт по последнему замеру. */
    payNote: view !== 'blogger' ? (r.pay_note || '') : '',
    /* Засчитано, а начисления держит открытый спор по заданию. */
    disputeHeld: r.status === 'active' && !!q.openDisputeFor.get('camp:' + r.camp_id, r.blogger_id),
    /* Владельцу: блогер заблокирован — начисления по ролику стоят (vidSettle). */
    blockedHeld: view === 'admin' && r.status === 'active'
      && (r.blogger_blocked != null ? !!r.blogger_blocked : vidBlocked(r.blogger_id)),
    cover: yt ? (vidCoverOf(r.id) || ytThumb(vid)) : vidCoverOf(r.id),
    player: yt ? 'https://www.youtube.com/embed/' + vid
      : r.platform === 'instagram' ? igEmbed(r.url) : 'https://www.tiktok.com/player/v1/' + vid,
    /* 'shorts' — YouTube Shorts, 'reels' — Instagram Reels (15.10.2026) */
    kind: r.vkind || null,
  };
  if (opts && opts.history) out.history = q.vidHist.all(r.id);
  return out;
}

/* Уведомление человеку: на телефон и, если он пришёл из Телеграма, ботом. */
function vidNotify(userId, title, body, url) {
  pushTo(userId, title, body, url);
  tgDM(userId, title + '\n\n' + body + '\n\n' + APP_BASE + String(url || '').replace(/^\//, ''));
}
function vidWho(uid) {
  const u = q.userById.get(Number(uid));
  return u ? (u.email + ' (#' + u.id + ')') : ('#' + uid);
}

/* Оценка накрутки после каждого замера. «Очень похоже» — начисления
   встают на паузу до решения владельца. Решение «засчитать» снимает
   подозрение только с тех цифр, что владелец видел (decided_views): пока
   просмотров не больше чем вдвое против них, ролик сам себя не заморозит.
   Дальше — это уже новый рост, и плохая оценка снова ставит паузу. Иначе
   одно решение по 5 000 просмотров пропускало бы потом накрутку до
   миллиона. Ролик с закрытым подсчётом оценку получает (её видят
   рекламодатель и владелец), но паузы и тревоги уже не будет. */
/* v — свежий ответ площадки (если есть): чего она не сообщила (#31). */
function vidJudge(row, v) {
  if (!row) return null;
  const plat = row.platform || 'tiktok';
  const today = dayOf(row.stats_at || Date.now());
  const prev = q.vidHist.all(row.id).filter((h) => h.day !== today);
  const st = q.lastStats.get(row.blogger_id, plat, row.external_id) || {};
  const ch = q.channelOf.get(row.blogger_id, plat, row.external_id) || {};
  const res = quality.assessVideo(
    { views: row.views, likes: row.likes, comments: row.comments, shares: row.shares,
      noShares: plat === 'youtube' || !!(v && v.noShares),
      likesHidden: !!(v && v.likesHidden), commentsOff: !!(v && v.commentsOff) },
    prev,
    { medViews: st.med_views, followers: st.followers != null ? st.followers : ch.subs,
      erLikes: st.er_likes, riskLevel: ch.risk_level });
  const now = Date.now();
  const live = row.status === 'review' || row.status === 'active';
  const exempt = row.decided_views != null && (row.views || 0) <= row.decided_views * 2;
  const hold = row.risk_hold ? 1 : (res.level === 'bad' && live && !exempt ? 1 : 0);
  const why = JSON.stringify(res.reasons.slice(0, 8).map((s) => String(s).slice(0, 300)));
  q.vidRisk.run(res.risk, res.level, why, now, hold, now, row.id);
  /* Тревога — когда оценка поменялась или ролик только что встал на паузу:
     засчитанный ролик замеряется каждый день 30 дней, и та же оценка иначе
     приходила бы владельцу каждые сутки по каждому ролику. */
  const fresh = res.level !== row.risk_level || (hold && !row.risk_hold);
  if ((res.level === 'risk' || res.level === 'bad') && live && fresh) {
    const ci = vidCamp(row.camp_id);
    tgAlert('vid:risk:' + row.id + ':' + res.level,
      '🚩 Видео по заданию (' + vidPlatName(plat) + '): цифры выбиваются\n\n'
      + 'Оценка: ' + riskWord(res.level) + ' (' + res.risk + ' из 100)\n'
      + 'Задание: «' + vidCampName(ci) + '»\nБлогер: ' + vidWho(row.blogger_id) + '\n'
      + 'Просмотров ' + row.views
      + ', лайков ' + (v && v.likesHidden ? 'скрыто' : row.likes)
      + ', комментариев ' + (v && v.commentsOff ? 'выключены' : row.comments)
      + (plat === 'youtube' ? '' : ', репостов ' + row.shares) + '\n' + (row.url || '') + '\n\n'
      + 'Что выбилось:\n• ' + res.reasons.join('\n• ') + '\n\n'
      + (hold && !row.risk_hold ? 'Начисления по ролику заморожены до вашего решения: ' : 'Посмотреть: ')
      + PUBLIC_URL + '/admin', 'server');
  }
  return res;
}

/* Свежие цифры ролика → строка (и наибольшие просмотры), снимок дня,
   оценка. Деньги здесь не двигаются: начисление считает vidSettle. */
function vidApply(row, v, now) {
  /* Строку закрыли, пока ждали площадку, — цифры уже не её дело. */
  if (!q.vidNums.run(v.views, v.views, v.likes, v.comments, v.shares, v.title || null, v.duration,
    now, now, row.id).changes) return false;
  q.vidSnap.run(row.id, dayOf(now), v.views, v.likes, v.comments, v.shares, now);
  if (v.cover) vidCoverSet(row.id, v.cover);
  vidJudge(q.vidById.get(row.id), v);
  /* Просмотры и резерв задания поменялись — лидерборд пересчитаем. */
  vidBoardDrop(row.camp_id);
  return true;
}

/* Канал отвязан (сам, владельцем или пропал из базы). Снимаем только
   ролики, которые ещё ждут проверки рекламодателя, и честно говорим об
   этом обеим сторонам. Засчитанные (active) остаются: без канала их
   просмотры не проверить, и начисления стоят (пауза 'access') — подсчёт
   продолжит круг, когда блогер переподключит канал, или решит владелец.
   why: 'self' — блогер отвязал сам, 'admin' — владелец, 'gone' — канала нет. */
function vidRevoke(userId, platform, extId, why) {
  let n = 0;
  const P = vidPlatName(platform);
  try {
    const now = Date.now();
    for (const r of q.vidRevokable.all(Number(userId), String(platform), String(extId))) {
      if (!q.vidRevokeOne.run(now, r.id).changes) continue;
      n++;
      vidBoardDrop(r.camp_id);
      const name = vidCampName(vidCamp(r.camp_id));
      const cause = why === 'admin' ? 'администратор отключил ' + P + '-канал, с которого оно загружено'
        : why === 'self' ? 'вы отключили ' + P + '-канал, с которого оно загружено'
        : P + '-канал, с которого оно загружено, больше не подключён к профилю';
      vidNotify(r.blogger_id, 'Видео снято с проверки',
        '«' + name + '»: ' + cause + '. Без канала видео не проверить, и выплаты по нему не будет. '
        + 'Если это ошибка — напишите в поддержку.', '/?go=tasks');
      vidNotify(r.owner_id, 'Видео снято с проверки',
        '«' + name + '»: блогер больше не подключён к ' + P + '-каналу этого видео — проверять его не нужно, '
        + 'бюджет по нему не расходуется', '/?go=campaigns');
    }
  } catch (e) { console.error('[видео] отзыв не записался:', (e && e.message) || e); }
  return n;
}

/* Нет доступа к площадке блогера: владельцу — тревога, блогеру — просьба
   переподключить. И то и другое не чаще раза в сутки на блогера: круг
   идёт каждые полчаса, и без порога это был бы поток одинаковых писем. */
function vidTokenAlert(b, platform, ext, n, detail) {
  if (!vidOnce(vidTokenSeen, String(b) + '|' + platform)) return;
  const P = vidPlatName(platform);
  tgAlert('vid:token:' + b + ':' + platform,
    '🔑 Видео по заданиям: нет доступа к ' + P + ' блогера' + (detail ? ' (' + detail + ')' : '') + '\n\n'
    + 'Блогер: ' + vidWho(b) + ', канал ' + ext
    + '\nРоликов ждут обновления: ' + n + '. Цифры не обновляются, пока человек не переподключит ' + P
    + '; начисления по засчитанным стоят — ждут его или вашего решения.',
    'server');
  vidNotify(b, 'Переподключите ' + P,
    'Нет доступа к вашему ' + P + ' — мы не видим загруженные видео: просмотры не обновляются, а начисления за '
    + 'засчитанные стоят. Подключите ' + P + ' в профиле заново, и подсчёт продолжится.', '/?go=profile');
}

/* Освежить пачку роликов ТОЛЬКО цифрами: на проверке (рекламодатель
   видит рост, проверка накрутки) и закрытые подсчётом (только показ).
   Засчитанные (active) сюда не попадают — их замеряет и оплачивает
   vidAccrue. Группируем по каналу: у каждого свой доступ. Нет доступа или
   прав — цифры не трогаем (это не «ролик пропал»), а владельцу пишем
   тревогу. Каждую попытку отмечаем в last_try_at — по ней очередь круга.
   После каждого await строку перечитываем: пока ждали площадку, её могли
   закрыть (решение владельца), и старый снимок не должен её переписать.
   Закрытый подсчётом ролик освежается только для показа: промахи по нему
   не считаются, деньги уже ушли. */
const VID_MISS_GAP_MS = 20 * 3600 * 1000;
async function vidRefresh(rows0, now) {
  const out = { checked: 0, updated: 0, missed: 0, removed: 0, revoked: 0, failed: 0, errors: {} };
  const live = (r) => r && (r.status === 'review' || r.status === 'paid');
  const rows = (rows0 || []).filter(live);
  const groups = new Map();
  for (const r of rows) {
    const k = r.blogger_id + '|' + (r.platform || 'tiktok') + '|' + r.external_id;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  for (const list of groups.values()) {
    const b = list[0].blogger_id, p = list[0].platform || 'tiktok', ext = String(list[0].external_id);
    for (const r of list) q.vidTry.run(now, r.id);
    const fail = (code, part) => { for (const r of (part || list)) out.errors[r.id] = code; out.failed += (part || list).length; };
    if (!q.channelOf.get(b, p, ext)) {
      /* Канала больше нет: снимаем то, что ждёт проверки; закрытые
         подсчётом просто больше не обновляются. */
      out.revoked += vidRevoke(b, p, ext, 'gone');
      const act = list.map((r) => q.vidById.get(r.id)).filter((r) => r && r.status === 'paid');
      if (act.length) fail('no_channel', act);
      continue;
    }
    let got;
    try { got = await vidFetch(p, b, ext, list.map((r) => String(r.video_id))); }
    catch (e) {
      const code = e.vidCode || vidPlatErr(p);
      /* Тревога и просьба переподключить — только если на кону ещё что-то
         есть (ролик на проверке). Закрытые подсчётом обновляются лишь для
         показа: по ним молчим. */
      const open = list.some((r) => { const c = q.vidById.get(r.id); return !!c && c.status !== 'paid'; });
      if (code === 'token' || code === 'scope') {
        if (open) vidTokenAlert(b, p, ext, list.length, code + ': ' + String(e.message || '').slice(0, 160));
      } else console.error('[видео] площадка не ответила:', (e && e.message) || e);
      fail(code);
      continue;
    }
    const byId = new Map(got.filter((v) => vidSeen(p, v)).map((v) => [v.id, v]));
    for (const r0 of list) {
      const r = q.vidById.get(r0.id);
      if (!live(r)) continue;
      out.checked++;
      const v = byId.get(String(r.video_id));
      if (v) { if (vidApply(r, v, now)) out.updated++; continue; }
      if (r.status === 'paid') { out.missed++; continue; }
      /* Не вернулся: удалён, скрыт или стал приватным. Один раз — бывает
         и сбой; дважды — ролика нет. Промахи считаем не чаще раза в 20
         часов: два круга подряд по полчаса — это одна и та же минута
         площадки, а не «дважды». */
      if (r.last_miss_at && now - r.last_miss_at < VID_MISS_GAP_MS) { out.missed++; continue; }
      if (!q.vidMiss.run(now, now, r.id).changes) continue;
      if ((r.miss || 0) + 1 >= 2 && q.vidRemove.run(now, r.id).changes) {
        out.removed++;
        vidBoardDrop(r.camp_id);
        const name = vidCampName(vidCamp(r.camp_id));
        vidNotify(r.blogger_id, 'Видео больше не видно',
          '«' + name + '»: ролик удалён или скрыт на ' + vidPlatName(p) + ' — выплаты по нему не будет', '/?go=tasks');
        vidNotify(r.owner_id, 'Видео по заданию удалено',
          '«' + name + '»: блогер удалил или скрыл ролик до проверки — выплаты по нему не будет', '/?go=campaigns');
      } else {
        out.missed++;
      }
    }
  }
  return out;
}

/* Тревога владельцу о задержанных начислениях — не чаще раза в сутки на ролик. */
const vidHoldSeen = new Map();
function vidHoldAlert(row, why) {
  if (!vidOnce(vidHoldSeen, row.id)) return;
  tgAlert('vid:hold:' + row.id,
    '⏸ Начисления за видео ждут вашего решения\n\n' + why + '\n'
    + 'Задание: «' + vidCampName(vidCamp(row.camp_id)) + '»\nБлогер: ' + vidWho(row.blogger_id) + '\n'
    + 'Площадка: ' + vidPlatName(row.platform) + '\n'
    + 'Начислено по цифрам: ' + vidEst(row) + ' ₽, выплачено: ' + (row.paid || 0) + ' ₽\n' + (row.url || '')
    + '\n\nРешение: ' + PUBLIC_URL + '/admin',
    'server');
}

/* Заблокирован ли человек владельцем — деньги за видео ему не уходят. */
function vidBlocked(uid) {
  const u = uid ? q.userById.get(uid) : null;
  return !!(u && u.is_blocked);
}
/* Сколько денег в заморозке задания сейчас (открыта — остаток, иначе 0). */
function vidCampLeft(campId) {
  const d = q.deal.get('camp:' + campId);
  return d && d.status === 'held' ? Math.max(0, d.amount - d.paid) : 0;
}
/* Бюджет задания кончился, а ролику начислено больше (аудит 16.10.2026).
   Это обычный конец бюджета, а не поломка: заморозка открыта с нулём
   (dealPayMoves), пополнение снимает паузу и доплачивает само
   (vidBudgetResume). Рекламодателю — «пополните» (раз в сутки на задание),
   владельцу — спокойная заметка, без «критично» и без «ждут решения»:
   раньше на каждый ролик шла критическая тревога, а блогеру — «администратор
   уже разбирается», хотя разбирать нечего. */
const vidBudgetSeen = new Map();
function vidBudgetOut(row, short, name) {
  const nm = name || vidCampName(vidCamp(row.camp_id));
  tgAlert('vid:budget:' + row.camp_id, '💸 Бюджет задания исчерпан\n\n'
    + 'Задание: «' + nm + '»\nАвтор: ' + vidWho(row.owner_id) + '\n'
    + 'Блогер: ' + vidWho(row.blogger_id) + ' — недоплачено ' + short + ' ₽\n'
    + 'Начисления продолжатся сами, когда автор пополнит бюджет задания: ' + PUBLIC_URL + '/admin', 'server');
  if (vidOnce(vidBudgetSeen, String(row.camp_id))) {
    vidNotify(row.owner_id, 'Бюджет задания закончился', '«' + nm + '»: бюджет потрачен целиком — блогерам не хватило '
      + vidNum(short) + ' ₽ за набранные просмотры. Пополните бюджет задания: недоплата уйдёт им сама, '
      + 'и задание снова начнёт принимать видео', '/?go=campaigns');
  }
}
/* Поставить начисления на паузу «в бюджете не хватило денег» (pay_hold,
   'money') с причиной. Заметки и письмо блогеру — только при переходе в
   паузу, а не каждый круг. */
function vidPayHoldSet(row, why, now, blogMsg, short, name) {
  if (!q.vidPayHold.run('money', why, now, row.id).changes) return false;
  vidBudgetOut(row, short || 0, name);
  if (blogMsg) vidNotify(row.blogger_id, 'Выплата за видео задерживается', blogMsg, '/?go=tasks');
  return true;
}
function vidDate(ms) {
  const d = new Date(Number(ms) || 0);
  return ('0' + d.getUTCDate()).slice(-2) + '.' + ('0' + (d.getUTCMonth() + 1)).slice(-2) + ' '
    + ('0' + d.getUTCHours()).slice(-2) + ':' + ('0' + d.getUTCMinutes()).slice(-2) + ' UTC';
}

/* Свежий замер одного засчитанного ролика (для vidAccrue). ok: цифры
   записаны (и оценка накрутки пересчитана); gone: площадка ролика не
   отдала (удалён, скрыт, закрыт); fail: спросить не вышло (нет доступа,
   сбой). */
async function vidMeasure(row, now) {
  const p = row.platform || 'tiktok';
  q.vidTry.run(now, row.id);
  if (!q.channelOf.get(row.blogger_id, p, row.external_id)) {
    /* Канал отвязан. С ключом YouTube ролик всё равно видно: удалён или
       закрыт — так и запишем. Начислять без канала не будем — решит владелец. */
    if (p === 'youtube' && YT_API_KEY) {
      try {
        const got = await ytVideos([String(row.video_id)], { key: YT_API_KEY });
        const v = got.find((x) => x.id === String(row.video_id) && x.channelId === String(row.external_id));
        if (!v || !vidSeen(p, v)) return { gone: true };
        const cur = q.vidById.get(row.id);
        if (cur && cur.status === 'active') vidApply(cur, v, now);
      } catch (e) { /* не вышло — решит владелец */ }
    }
    return { fail: 'no_channel' };
  }
  let got;
  try { got = await vidFetch(p, row.blogger_id, row.external_id, [String(row.video_id)]); }
  catch (e) {
    const code = e.vidCode || vidPlatErr(p);
    if (code === 'token' || code === 'scope') vidTokenAlert(row.blogger_id, p, row.external_id, 1, code);
    return { fail: code };
  }
  const v = got.find((x) => x.id === String(row.video_id));
  if (!v || !vidSeen(p, v)) return { gone: true };
  const cur = q.vidById.get(row.id);
  if (!cur || cur.status !== 'active') return { skip: true };
  vidApply(cur, v, now);
  return { ok: true };
}

/* ── НАЧИСЛЕНИЕ ПО МЕРЕ РОСТА (механика v3, VIDEO-SPEC.md, раздел 11) ──
   Единственная дорога денег за видео — vidAccrue. Её зовут все пути:
   зачёт (рекламодатель, автозачёт через VID_AUTO_ACCEPT_H, владелец),
   круг (раз в сутки на ролик), «Обновить» (не чаще раза в 20 ч) и
   решение владельца по паузе. Порядок:
     свежий замер (один запрос к площадке; сбой площадки — ничего нового,
     ждём следующего круга; нет доступа — пауза 'access'; ролика нет —
     removed) → начислено по снимку условий и НАИБОЛЬШИМ просмотрам
     (только растёт) → держат накрутка, спор, пауза → прибавка
     (начислено − выплачено) из заморозки одним движением → конец
     подсчёта (максимум за ролик взят, срок вышел, цифры заморожены) или
     сводка блогеру не чаще раза в сутки.
   Двойной выплаты нет: замок vidPaying на процесс, ключ операции на
   НАКОПЛЕННУЮ сумму sys:vidpay:<id>:<выплачено после> (второй процесс с
   теми же цифрами получит «уже проведено»), а статус, паузы, спор и
   выплаченное сверяются ещё раз внутри транзакции.
   o.accept — это зачёт (блогеру одно уведомление: о деньгах или о самом
   зачёте); o.how — кто засчитал или снял паузу, строкой в том же тексте;
   o.noMeasure — по цифрам, что есть (решение владельца); o.manual —
   «Обновить» (пауза «нет доступа» пробуется сразу). */
const VID_RETRY_MS = 20 * 60 * 1000;
const VID_ACCESS_RETRY_MS = 3 * 3600 * 1000;
/* «Раз в сутки» — порог 20 часов: круг идёт каждые полчаса, и ровно 24
   часа сдвигали бы замер ролика на круг вперёд каждый день. */
const VID_DAILY_MS = 20 * 3600 * 1000;
const VID_MANUAL_ACTIVE_MS = VID_DAILY_MS;
/* Финальный замер позже конца срока больше чем на это — уже не «30 дней»:
   подсчёт закрывается по последнему замеру (аудит 16.10.2026). Порог —
   те же «сутки», с которыми идут ежедневные замеры. */
const VID_LATE_MS = VID_DAILY_MS;
const VID_ACCESS_FAIL = new Set(['token', 'scope', 'no_channel']);
const vidPaying = new Set();
async function vidAccrue(id, opts) {
  if (vidPaying.has(id)) return { state: 'busy', paid: 0 };
  vidPaying.add(id);
  try { return await vidAccrueRun(id, opts || {}); }
  finally { vidPaying.delete(id); }
}
async function vidAccrueRun(id, o) {
  let row = q.vidById.get(id);
  if (!row || row.status !== 'active') return { state: 'skip', paid: 0 };
  const now = Date.now();
  if (!row.track_ends_at) {
    q.vidTrackSet.run((Number(row.approved_at) || now) + VID_TRACK_MS, id);
    row = q.vidById.get(id);
    if (!row || row.status !== 'active') return { state: 'skip', paid: 0 };
  }
  const name = vidCampName(vidCamp(row.camp_id));
  const P = vidPlatName(row.platform);
  const tail = o.how ? '. ' + o.how : '';
  let note = null;
  /* Срок подсчёта вышел больше суток назад, а финального замера нет
     (аудит 16.10.2026): пауза «нет доступа» тянулась за конец срока
     (блогер отозвал доступ на 29-й день и вернул через недели) или круг
     не шёл. Свежие цифры сейчас — просмотры уже после срока: раньше
     переподключение платило за них. Закрываем по последнему замеру, как
     после VID_PAY_TRIES сбоев площадки, к площадке не идём; пауза «нет
     доступа» снимается — новых цифр не будет. */
  if (!o.noMeasure && !row.frozen && now >= Number(row.track_ends_at) + VID_LATE_MS) {
    const wasAccess = !!(row.pay_hold && row.hold_kind === 'access');
    note = 'Подсчёт закрыт по последнему замеру' + (row.stats_at ? ' от ' + vidDate(row.stats_at) : '')
      + ': финальный замер не снят в срок (' + (wasAccess ? 'не было доступа к ' + P + ' блогера' : 'замер опоздал')
      + ') — просмотры после конца срока не считаются';
    tgAlert('vid:lastknown:' + id, '⚠️ Подсчёт видео закрыт без финального замера\n\n' + note
      + '\nЗадание: «' + name + '»\nБлогер: ' + vidWho(row.blogger_id) + '\n' + (row.url || '')
      + '\n\nПроверить: ' + PUBLIC_URL + '/admin', 'server');
    if (wasAccess) q.vidUnhold.run(now, id);
    q.vidFreeze.run(now, id);
    row = q.vidById.get(id);
    if (!row || row.status !== 'active') return { state: 'skip', paid: 0 };
  }
  if (!o.noMeasure && !row.frozen) {
    const accessHeld = !!(row.pay_hold && row.hold_kind === 'access');
    /* Пауза «нет доступа» повторяется не чаще раза в 3 часа: ждём, пока
       блогер переподключит канал. Его «Обновить» пробует сразу. */
    if (accessHeld && !o.manual && row.last_try_at && now - row.last_try_at < VID_ACCESS_RETRY_MS) {
      return { state: 'held', why: 'access', wait: true, paid: 0, total: row.paid || 0 };
    }
    const ended = now >= Number(row.track_ends_at);
    const m = await vidMeasure(row, now);
    row = q.vidById.get(id);
    if (!row || row.status !== 'active') return { state: 'skip', paid: 0 };
    /* Ролика нет при зачёте — как раньше: removed без выплаты. В дни
       подсчёта (до 30 замеров) один промах бывает и сбоем площадки
       (модерация, временно скрыт): как у роликов на проверке (vidRefresh),
       промахи считаются не чаще раза в 20 ч, снимает ролик только второй.
       Пока промах один, ничего нового не начисляем — ждём следующего
       круга. Удачный замер промахи сбрасывает (vidNums). */
    if (m.gone && o.accept) return vidGone(row, now, name, P, o);
    if (m.gone) {
      if (!(row.last_miss_at && now - row.last_miss_at < VID_MISS_GAP_MS)) {
        if (!q.vidMiss.run(now, now, id).changes) return { state: 'skip', paid: 0 };
        if ((row.miss || 0) + 1 >= 2) return vidGone(row, now, name, P, o);
      }
      return { state: 'wait', why: 'miss', paid: 0, total: row.paid || 0 };
    }
    if (!m.ok && VID_ACCESS_FAIL.has(m.fail)) return vidAccessFail(row, m.fail, now, name, P, o);
    if (!m.ok) {
      /* Сбой площадки (5xx, таймаут, нет связи): ничего нового не
         начисляем — прибавка ждёт следующего круга. Срок вышел, а
         финальный замер не удаётся VID_PAY_TRIES раза подряд — подсчёт
         закрывается по последнему удачному замеру (нового не начисляем). */
      const tries = (row.pay_tries || 0) + 1;
      q.vidTries.run(tries, now, id);
      if (!ended || tries < VID_PAY_TRIES) {
        if (o.accept) {
          const dl = vidDaysLeft(row, now);
          vidNotify(row.blogger_id, 'Видео засчитано — считаем просмотры', '«' + name + '»: ' + P
            + ' сейчас не отдал цифры — проверим их на следующем круге и начислим деньги. Дальше сайт сам '
            + 'обновляет просмотры каждый день — ещё ' + dl + ' ' + vidDaysWord(dl) + tail, '/?go=tasks');
        }
        return { state: 'wait', why: m.fail, code: m.fail, tries, paid: 0, total: row.paid || 0 };
      }
      note = 'Подсчёт закрыт по последнему замеру' + (row.stats_at ? ' от ' + vidDate(row.stats_at) : '')
        + ': ' + P + ' не отдал цифры ' + tries + ' раза подряд после конца срока (' + m.fail + ')';
      tgAlert('vid:lastknown:' + id, '⚠️ Подсчёт видео закрыт без финального замера\n\n' + note
        + '\nЗадание: «' + name + '»\nБлогер: ' + vidWho(row.blogger_id) + '\n' + (row.url || '')
        + '\n\nПроверить: ' + PUBLIC_URL + '/admin', 'server');
      q.vidFreeze.run(now, id);
    } else {
      if (accessHeld) q.vidUnhold.run(now, id);
      else if (row.pay_tries) q.vidTries.run(0, now, id);
      /* Срок вышел — это и был финальный замер: дальше цифры не опрашиваем. */
      if (ended) q.vidFreeze.run(now, id);
    }
    row = q.vidById.get(id);
    if (!row || row.status !== 'active') return { state: 'skip', paid: 0 };
  }
  return vidSettle(row, now, o, note);
}

/* Ролика больше нет на площадке (удалён, скрыт, закрыт): подсчёт
   останавливается, выплаченное остаётся у блогера, остаток резерва
   возвращается в бюджет. */
function vidGone(row, now, name, P, o) {
  if (!q.vidRemove.run(now, row.id).changes) return { state: 'skip', paid: 0 };
  vidBoardDrop(row.camp_id);
  const kept = row.paid || 0;
  if (kept > 0) {
    vidNotify(row.blogger_id, 'Видео больше не видно', '«' + name + '»: ролик удалён или скрыт на ' + P
      + ' — начисления по нему остановлены. Выплаченные ' + vidNum(kept) + ' ₽ остаются у вас', '/?go=tasks');
  } else if (o.accept) {
    vidNotify(row.blogger_id, 'Видео не засчитано', '«' + name + '»: при проверке ролика не нашлось на ' + P
      + ' — он удалён или скрыт. Выплаты по нему не будет', '/?go=tasks');
  } else {
    vidNotify(row.blogger_id, 'Видео больше не видно', '«' + name + '»: ролик удалён или скрыт на ' + P
      + ' — начисления по нему остановлены', '/?go=tasks');
  }
  vidNotify(row.owner_id, 'Видео по заданию удалено', '«' + name + '»: ролика больше нет на ' + P
    + ' — начисления по нему остановлены, остаток резерва вернулся в бюджет', '/?go=campaigns');
  return { state: 'removed', paid: 0, total: kept };
}

/* Замер не удался по вине доступа (канал отвязан, доступ отозван, нет
   прав): начисления стоят — пауза 'access', владельцу в очередь, блогеру —
   что сделать. По старым цифрам не начисляем: иначе ролик можно было бы
   удалить и закрыть доступ, чтобы его не проверили. */
function vidAccessFail(row, code, now, name, P, o) {
  const was = !!(row.pay_hold && row.hold_kind === 'access');
  const why = (code === 'no_channel' ? P + '-канал блогера отвязан' : 'Нет доступа к ' + P + ' блогера (' + code + ')')
    + ' — просмотры не проверить, начисления стоят. Дождитесь, пока блогер переподключит канал, или решите сами';
  const base = { paid: 0, total: row.paid || 0, code };
  if (!q.vidAccessHold.run(why, now, row.id).changes) {
    return Object.assign({ state: 'held', why: row.risk_hold ? 'risk' : (row.hold_kind || 'money') }, base);
  }
  if (!was) {
    vidHoldAlert(row, why + '.');
    const tail = o.how ? '. ' + o.how : '';
    if (o.accept) {
      vidNotify(row.blogger_id, 'Видео засчитано — нужен доступ к ' + P, '«' + name + '»: нет доступа к вашему ' + P
        + ' — просмотры не проверить, и начисления не начнутся. Подключите ' + P + ' в профиле заново' + tail, '/?go=profile');
    } else if (code === 'no_channel') {
      vidNotify(row.blogger_id, 'Начисления за видео стоят', '«' + name + '»: ' + P + '-канал, с которого загружено видео, '
        + 'отключён — без него просмотры не проверить. Подключите ' + P + ' в профиле заново, и подсчёт продолжится', '/?go=profile');
    }
    /* Про доступ и права блогеру уже написал vidTokenAlert (раз в сутки). */
  }
  return Object.assign({ state: 'held', why: 'access' }, base);
}

/* Деньги по ролику: начислено по снимку условий и наибольшим просмотрам
   (не меньше записанного раньше); держат накрутка, спор и пауза; прибавка
   (начислено − выплачено) — vidPayStep. Потом — конец подсчёта (максимум
   за ролик взят, срок вышел, цифры заморожены) или уведомление блогеру:
   первое начисление — сразу, дальше сводка не чаще раза в сутки. */
/* Ставка комиссии с выплат по заданию (0 — задание запущено до 14.10.2026)
   и сумма «на баланс» блогера от выплаченного из бюджета. */
function vidPayFeePct(campId) {
  const d = q.deal.get('camp:' + campId);
  return d ? Number(d.pay_fee_pct) || 0 : 0;
}
function vidNetOf(gross, pct) {
  const g = Math.max(0, Math.round(Number(gross) || 0));
  return g - pctUp(g, pct);   /* как комиссия с выплат (dealPayFee) */
}
function vidSettle(row, now, o, note) {
  if (!row || row.status !== 'active') return { state: 'skip', paid: 0 };
  const name = vidCampName(vidCamp(row.camp_id));
  const tail = o.how ? '. ' + o.how : '';
  const lead = (txt) => (o.how ? o.how + '. ' + txt.charAt(0).toUpperCase() + txt.slice(1) : txt);
  const t = vidTerms(row);
  const top = vidTopViews(row);
  const est = t ? vidEarnBy(t, top) : 0;
  if (est > (Number(row.earned) || 0)) {
    q.vidEarned.run(est, now, row.id, est);
    row = q.vidById.get(row.id);
    if (!row || row.status !== 'active') return { state: 'skip', paid: 0 };
  }
  const earned = Math.max(0, Number(row.earned) || 0);
  const before = row.paid || 0;
  const base = { paid: 0, total: before, earned };
  if (row.risk_hold) {
    vidHoldAlert(row, 'Подозрение на накрутку просмотров.');
    if (o.accept) {
      vidNotify(row.blogger_id, 'Видео засчитано', '«' + name + '»: '
        + lead('перед начислением администратор проверит просмотры — деньги придут после его решения'), '/?go=tasks');
    }
    return Object.assign({ state: 'held', why: 'risk' }, base);
  }
  /* Блогер заблокирован владельцем (аудит 16.10.2026): не платим ни
     кругом, ни зачётом, ни доплатой после пополнения. Раньше прибавки шли
     на заблокированный счёт, а доска их прятала. Подсчёт (замеры, срок)
     идёт как обычно — разблокировали, и следующий круг доплатит по тем же
     правилам; не платить совсем — «Не засчитывать» в /admin (ролик в
     очереди владельца, vidQueueCount). */
  if (vidBlocked(row.blogger_id)) return Object.assign({ state: 'held', why: 'blocked' }, base);
  if (q.openDisputeFor.get('camp:' + row.camp_id, row.blogger_id)) {
    vidHoldAlert(row, 'По заданию открыт спор.');
    if (o.accept) {
      vidNotify(row.blogger_id, 'Видео засчитано', '«' + name + '»: ' + lead('начисления ждут решения спора по заданию'), '/?go=tasks');
    }
    return Object.assign({ state: 'held', why: 'dispute' }, base);
  }
  /* Пауза «не хватило денег» ждёт денег, а не владельца (16.10.2026): в
     заморозке они снова есть (пополнили, пока ролик ждал) — снимаем и
     платим как обычно. */
  if (row.pay_hold && row.hold_kind === 'money' && vidCampLeft(row.camp_id) > 0) {
    if (q.vidUnholdMoney.run(now, row.id).changes) row = q.vidById.get(row.id);
    if (!row || row.status !== 'active') return { state: 'skip', paid: 0 };
  }
  if (row.pay_hold) return Object.assign({ state: 'held', why: row.hold_kind || 'money' }, base);
  const owe = earned - before;
  let credited = 0;
  if (owe > 0) {
    const r = vidPayStep(row, earned, owe, top, now, name);
    if (r.state) return r;
    credited = r.credited;
    row = q.vidById.get(row.id);
    if (!row || row.status !== 'active') return { state: 'skip', paid: credited };
  }
  const total = row.paid || 0;
  /* блогеру говорим, сколько пришло НА БАЛАНС (за вычетом комиссии) */
  const fp = vidPayFeePct(row.camp_id);
  const N = (g) => vidNetOf(g, fp);
  const feeTail = fp > 0 ? ' (за вычетом комиссии сервиса ' + fp + '%)' : '';
  const maxPay = vidMaxPay(t);
  const capped = maxPay > 0 && earned >= maxPay;
  const ended = !!row.frozen || now >= Number(row.track_ends_at) || capped;
  const views = vidNum(top) + ' ' + vidViewsWord(top);
  const minV = t ? Math.max(0, Math.round(Number(t.minViews) || 0)) : 0;
  const first = !row.notif_at;
  if (credited > 0) vidBoardDrop(row.camp_id);
  if (ended) {
    if (!q.vidEnd.run(note, now, row.id).changes) return { state: 'skip', paid: credited, total };
    vidBoardDrop(row.camp_id);
    let title, body;
    if (total > 0 && first) {
      title = 'Видео засчитано — ' + vidNum(N(total)) + ' ₽ на балансе';
      body = '«' + name + '»: ' + vidNum(N(total)) + ' ₽ за ' + views + feeTail
        + (capped ? '. Это максимум за видео — подсчёт закончен' : '. Подсчёт закончен') + tail;
    } else if (total > 0) {
      title = 'Подсчёт закончен — всего ' + vidNum(N(total)) + ' ₽';
      body = '«' + name + '»: ' + (credited > 0 ? 'последняя прибавка +' + vidNum(N(total) - N(total - credited)) + ' ₽, ' : '')
        + 'всего ' + vidNum(N(total)) + ' ₽ за ' + views + feeTail + (capped ? ' — это максимум за видео' : '') + tail;
    } else {
      title = o.accept ? 'Видео засчитано' : 'Подсчёт закончен';
      body = '«' + name + '»: по условиям задания выплаты нет — ' + views
        + (minV && top < minV ? ', а начисления начинаются с ' + vidNum(minV) : '') + tail;
    }
    vidNotify(row.blogger_id, title, body, '/?go=tasks');
    q.vidNotified.run(now, total, row.id);
    return { state: 'paid', paid: credited, total, earned, ended: true };
  }
  const days = vidDaysLeft(row, now);
  const dleft = days + ' ' + vidDaysWord(days);
  const pending = total > (row.notif_paid || 0);
  if (pending && (first || o.how || now - (Number(row.notif_at) || 0) >= VID_DAILY_MS)) {
    if (first) {
      vidNotify(row.blogger_id, 'Видео засчитано — ' + vidNum(N(total)) + ' ₽ на балансе', '«' + name + '»: '
        + vidNum(N(total)) + ' ₽ за ' + views + feeTail + '. Дальше сайт сам обновляет просмотры и доначисляет — ещё ' + dleft + tail,
        '/?go=tasks');
    } else {
      const plus = N(total) - N(row.notif_paid || 0);
      vidNotify(row.blogger_id, '+' + vidNum(plus) + ' ₽ за просмотры: «' + name + '»', 'Всего по видео начислено '
        + vidNum(N(total)) + ' ₽ за ' + views + feeTail + '. Считаем ещё ' + dleft + tail, '/?go=tasks');
    }
    q.vidNotified.run(now, total, row.id);
  } else if (o.accept) {
    vidNotify(row.blogger_id, 'Видео засчитано — считаем просмотры', '«' + name + '»: '
      + (minV && top < minV
        ? 'начисления начнутся с ' + vidNum(minV) + ' просмотров (сейчас ' + vidNum(top) + ')'
        : 'начисления пойдут по мере роста просмотров')
      + '. Сайт сам обновляет их каждый день — ещё ' + dleft + tail, '/?go=tasks');
  } else if (o.how) {
    vidNotify(row.blogger_id, 'Решение по видео', '«' + name + '»: ' + o.how
      + '. Подсчёт просмотров продолжается — ещё ' + dleft, '/?go=tasks');
  }
  return { state: 'active', paid: credited, total, earned };
}

/* Прибавка из заморозки кампании тем же движением, что /api/deals/release
   (dealPayMoves). Ключ — на НАКОПЛЕННУЮ сумму (sys:vidpay:<id>:<выплачено
   после>): второй процесс или повтор с теми же цифрами получат «уже
   проведено», а не вторую выплату. Внутри транзакции ещё раз сверяются
   статус, паузы, спор, выплаченное и остаток заморозки. Денег меньше
   прибавки — платим, что есть, остаток ждёт владельца (pay_hold, 'money');
   блогеру — правда: сколько начислено и что остаток задерживается. */
function vidPayStep(row, earned, owe, views, now, name) {
  const dealId = 'camp:' + row.camp_id;
  const d = q.deal.get(dealId);
  const left0 = d && d.status === 'held' ? Math.max(0, d.amount - d.paid) : 0;
  const before = row.paid || 0;
  const msgShort = (paidNow, short) => '«' + name + '»: начислено по просмотрам ' + vidNum(earned) + ' ₽'
    + (before + paidNow > 0 ? ', выплачено ' + vidNum(before + paidNow) + ' ₽' : '')
    + '. ' + (before + paidNow > 0 ? 'Остальные ' + vidNum(short) + ' ₽ задерживаются' : 'Выплата задерживается')
    + ': бюджет задания исчерпан — начислим, как только рекламодатель его пополнит.';
  if (left0 <= 0) {
    vidPayHoldSet(row, 'В заморозке кампании не хватило денег: недоплачено ' + owe + ' ₽', now, msgShort(0, owe), owe, name);
    return { state: 'held', why: 'money', paid: 0, short: owe, total: before, earned };
  }
  const sum = Math.min(owe, left0);
  const after = before + sum;
  const r = moneyOp(sysKey('vidpay', row.id + ':' + after), d.payer_id, 'release', (add) => {
    const cur = q.vidById.get(row.id);
    if (!cur || cur.status !== 'active' || cur.pay_hold || cur.risk_hold) throw httpError(409, 'Ролик уже не ждёт начисления');
    if ((cur.paid || 0) !== before) throw httpError(409, 'Начисление по ролику уже прошло');
    if (q.openDisputeFor.get(dealId, cur.blogger_id)) throw httpError(409, 'По заданию открыт спор');
    if (vidBlocked(cur.blogger_id)) throw httpError(409, 'Блогер заблокирован');
    const dd = q.deal.get(dealId);
    const left = dd && dd.status === 'held' ? Math.max(0, dd.amount - dd.paid) : 0;
    if (left < sum) throw httpError(409, 'В заморозке стало меньше денег');
    const closed = dealPayMoves(add, dd, cur.blogger_id, sum, dealPayFee(dd, sum, before));
    q.vidAccrued.run(after, now, sum >= owe ? views : null, now, cur.id);
    if (sum < owe) q.vidShort.run('В заморозке кампании не хватило денег: недоплачено ' + (owe - sum) + ' ₽', now, cur.id);
    return { ok: true, dealId, paid: sum, left: left - sum, closed, to: cur.blogger_id, video: cur.id,
      total: after, short: owe - sum, views };
  });
  if (r.status !== 200) {
    const err = String((r.body && r.body.error) || r.status);
    /* Ролик поменялся между чтением и транзакцией (решение владельца,
       спор, второй процесс) — не поломка: следующий круг посчитает заново. */
    if (r.status === 409 && /уже|спор|меньше|заблокирован/.test(err)) return { state: 'skip', why: 'race', paid: 0, total: before, earned };
    console.error('[видео] начисление не прошло:', row.id, r.status, err);
    tgAlert('vid:payfail:' + row.id, '💥 Начисление за видео не прошло\n\nРолик #' + row.id
      + ', задание «' + name + '»\n' + err, 'server', true);
    return { state: 'fail', paid: 0, total: before, earned };
  }
  if (r.body.repeated) return { credited: 0 };
  const paid = Number(r.body.paid) || 0;
  const short = Number(r.body.short) || 0;
  if (short > 0) {
    /* pay_hold уже поставлен в той же транзакции, что и выплата; бюджет
       исчерпан — заметки как у паузы (vidBudgetOut), блогеру — правда. */
    vidBudgetOut(row, short, name);
    vidNotify(row.blogger_id, 'Выплата за видео задерживается', msgShort(paid, short), '/?go=tasks');
    vidBoardDrop(row.camp_id);
    return { state: 'held', why: 'money', paid, short, total: after, earned };
  }
  return { credited: paid };
}

/* В заморозке задания снова есть деньги (пополнение, 16.10.2026): снять
   паузу «не хватило денег» с роликов задания и доплатить тем же путём, что
   у круга, — vidAccrue без замера (цифры уже есть; накрутка и спор держат
   по-прежнему). По очереди зачёта, пока есть деньги: кому снова не хватило —
   пауза и правда в письме (vidPayStep), остальные ждут следующего
   пополнения. Раньше паузу снимал только владелец, а «Засчитать» при
   закрытой заморозке ставило её снова. */
async function vidBudgetResume(campId) {
  const out = { videos: 0, paid: 0 };
  const cid = String(campId);
  for (const { id } of q.vidMoneyHeld.all(cid)) {
    if (vidCampLeft(cid) <= 0) break;
    if (!q.vidUnholdMoney.run(Date.now(), id).changes) continue;
    let s;
    try { s = await vidAccrue(id, { noMeasure: true, how: 'Рекламодатель пополнил бюджет задания' }); }
    catch (e) { console.error('[видео] доплата после пополнения упала:', id, (e && e.message) || e); s = { state: 'fail' }; }
    out.videos++;
    out.paid += Number(s && s.paid) || 0;
  }
  if (out.videos) vidBoardDrop(cid);
  return out;
}

/* Рекламодатель не ответил за VID_AUTO_ACCEPT_H часов — ролик засчитан
   сам: первый замер и первое начисление сразу, дальше подсчёт как обычно.
   Иначе молчанием можно было бы держать блогера без денег сколько угодно. */
async function vidAutoAccept(now, count) {
  let n = 0;
  for (const r of q.vidReviewStale.all(now - VID_AUTO_ACCEPT_MS)) {
    if (!q.vidAutoOk.run(now, now, now + VID_TRACK_MS, now, now, r.id).changes) continue;
    n++;
    vidBoardDrop(r.camp_id);
    const name = vidCampName(vidCamp(r.camp_id));
    const days = Math.round(VID_AUTO_ACCEPT_MS / 864e5);
    const txt = 'Рекламодатель не ответил за ' + (days >= 1 ? days + ' ' + (days === 1 ? 'день' : days < 5 ? 'дня' : 'дней')
      : Math.round(VID_AUTO_ACCEPT_MS / 3600e3) + ' ч') + ' — видео засчитано автоматически';
    vidNotify(r.owner_id, 'Видео засчитано', '«' + name + '»: ' + txt, '/?go=campaigns');
    let s = null;
    try { s = await vidAccrue(r.id, { accept: true, how: txt }); }
    catch (e) { console.error('[видео] начисление при автозачёте упало:', (e && e.message) || e); }
    if (count) count(s);
  }
  return n;
}

/* Фоновый круг: раз в 30 минут. Сначала автозачёт (с первым
   начислением), потом засчитанные — замер и прибавка раз в сутки на
   ролик, сразу после конца срока — финальный замер (vidAccrueDue), потом
   обновление цифр роликов на проверке и закрытых подсчётом (только
   показ). force — освежить всё, не дожидаясь суток (кнопка владельца). */
let vidSyncBusy = false;
async function vidSyncRound(opts) {
  if (vidSyncBusy) return { busy: true };
  vidSyncBusy = true;
  try {
    const force = !!(opts && opts.force);
    const tally = { counted: 0, credited: 0, creditedSum: 0, paid: 0, held: 0, waiting: 0, removedAtPay: 0 };
    const count = (s) => {
      if (!s) return;
      if (s.paid > 0) { tally.credited++; tally.creditedSum += s.paid; }
      if (s.state === 'paid') tally.paid++;
      else if (s.state === 'held') tally.held++;
      else if (s.state === 'wait') tally.waiting++;
      else if (s.state === 'removed') tally.removedAtPay++;
    };
    const auto = await vidAutoAccept(Date.now(), count);
    const t0 = Date.now();
    const due = q.vidAccrueDue.all({ $force: force ? 1 : 0, $now: t0, $stale: t0 - VID_DAILY_MS,
      $retry: t0 - VID_RETRY_MS, $access: t0 - VID_ACCESS_RETRY_MS, $miss: t0 - VID_MISS_GAP_MS });
    tally.counted = due.length;
    for (const r of due) {
      let s;
      try { s = await vidAccrue(r.id, {}); }
      catch (e) { console.error('[видео] начисление упало:', (e && e.message) || e); continue; }
      count(s);
    }
    const now = Date.now();
    const rows = q.vidDue.all({ $track: VID_TRACK_MS, $now: now, $force: force ? 1 : 0,
      $stale: now - VID_DAILY_MS, $miss: now - VID_MISS_GAP_MS, $lim: 200 });
    const res = await vidRefresh(rows, now);
    delete res.errors;
    return Object.assign(res, { autoAccepted: auto }, tally);
  } catch (e) {
    console.error('[видео] круг обновления упал:', (e && e.message) || e);
    return { error: String((e && e.message) || e) };
  } finally {
    vidSyncBusy = false;
  }
}
setInterval(() => { vidSyncRound().catch(() => {}); }, 30 * 60 * 1000).unref();
/* Первый круг — вскоре после старта (аудит 16.10.2026, #33): каждая
   выкладка перезапускает процесс, и с одним setInterval автозачёт,
   суточные прибавки и финальные замеры ждали полчаса после каждого
   перезапуска, а при частых выкладках не шли вовсе. VID_SYNC_FIRST_S —
   через сколько секунд (по умолчанию 90: ретранслятор и бот успевают
   подняться); 0 — без раннего круга (проверки, которые сами «старят»
   строки и считают итоги круга). */
const VID_SYNC_FIRST_MS = (() => {
  const raw = String(ENV.VID_SYNC_FIRST_S == null ? '' : ENV.VID_SYNC_FIRST_S).trim();
  const n = Number(raw);
  return raw !== '' && Number.isFinite(n) && n >= 0 ? Math.round(n * 1000) : 90 * 1000;
})();
if (VID_SYNC_FIRST_MS > 0) setTimeout(() => { vidSyncRound().catch(() => {}); }, VID_SYNC_FIRST_MS).unref();

/* ── Лидерборд и участники задания (как в More Views) ──
   Наружу — имя из профиля, ник и аватар подтверждённого аккаунта, число
   роликов, просмотры и выплаченное в этом задании. Номера аккаунтов,
   почта и внешние id каналов остаются здесь: в кэше они нужны, чтобы
   найти «моё место», но в ответ не попадают. Кэш на оффер — 60 секунд,
   сбрасывается, когда в задании что-то поменялось. */
const vidBoards = new Map();
function vidBoardDrop(campId) { vidBoards.delete(String(campId)); tsumCache.at = 0; }
function vidPubName(s) {
  let t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  /* Почта вместо имени — не показываем; номер Телеграма из имени по
     умолчанию («Пользователь 123456») — тоже. */
  if (/[^\s@]+@[^\s@]+\.[^\s@]+/.test(t)) t = '';
  if (/^Пользователь\s+\d+$/.test(t)) t = 'Пользователь';
  return (t || 'Блогер').slice(0, 40);
}
function vidPubChan(campId, uid) {
  const top = campId ? q.boardChan.get(String(campId), uid) : null;
  let ch = null, platform = '';
  if (top) {
    platform = top.platform || 'tiktok';
    ch = q.channelOf.get(uid, platform, String(top.external_id));
  } else {
    ch = q.mainChan.get(uid);
    platform = ch ? ch.platform : '';
  }
  let nick = vidNick(ch && ch.username);
  if (!nick && top && platform === 'tiktok') nick = vidNick(top.handle);
  return {
    handle: nick ? '@' + nick : '',
    platform: VID_PLAT[platform] ? platform : '',
    avatar: vidHttps(ch && ch.avatar),
  };
}
function vidBoardAgg(campId) {
  const key = String(campId);
  const now = Date.now();
  const hit = vidBoards.get(key);
  if (hit && now - hit.at < 60000) return hit;
  const ranked = q.boardRows.all(key).map((r, i) => ({
    uid: r.uid, rank: i + 1, name: r.name, firstAt: Number(r.first_at) || 0,
    videos: Number(r.videos) || 0, views: Number(r.views) || 0, earned: Number(r.earned) || 0,
  }));
  const d = q.deal.get('camp:' + key);
  const reserved = vidReserved(key);
  /* «на баланс» блогеру (аудит 16.10.2026): касса берёт комиссию с КАЖДОГО
     ролика по накопленному (вверх), поэтому сумма строки «на баланс» — это
     Σ vidNetOf(paid ролика), а не vidNetOf(суммы); иначе лидерборд и
     «Выплачено блогерам» расходились с кошельком на 1 ₽ за ролик. */
  const pfp = d ? Number(d.pay_fee_pct) || 0 : 0;
  const netBy = new Map();
  let feeAll = 0;
  for (const v of q.boardPaid.all(key)) {
    const n = vidNetOf(v.paid, pfp);
    feeAll += Math.max(0, Math.round(Number(v.paid) || 0)) - n;
    netBy.set(v.uid, (netBy.get(v.uid) || 0) + n);
  }
  for (const r of ranked) r.earnedNet = netBy.get(r.uid) || 0;
  const agg = {
    paidNet: Math.max(0, (d ? Number(d.paid) || 0 : 0) - feeAll),
    at: now, key, ranked, sorted: {}, byUid: new Map(ranked.map((r) => [r.uid, r])), pages: new Map(),
    members: Number((q.tmCount.get(key) || {}).n) || 0,
    videos: ranked.reduce((s, r) => s + r.videos, 0),
    views: ranked.reduce((s, r) => s + r.views, 0),
    budget: d ? d.amount : 0, paid: d ? d.paid : 0, reserved,
    left: d && d.status === 'held' ? Math.max(0, d.amount - d.paid - reserved) : 0,
    feePct: d ? Number(d.fee_pct) || 0 : 0, payFeePct: d ? Number(d.pay_fee_pct) || 0 : 0,
  };
  vidBoards.set(key, agg);
  if (vidBoards.size > 500) vidBoards.delete(vidBoards.keys().next().value);
  return agg;
}
/* Лидерборд в нужном порядке: по просмотрам (по умолчанию) или по сумме
   выплаты. Номера аккаунтов в строках нет (контракт v2, п. 3): для
   кнопок «Профиль» и «Чат» — card, id открытой карточки в каталоге (её и
   так видят все в /api/cards), а «вы» сервер отмечает сам (me). Номер
   аккаунта получает только автор задания (uid в ответе ему) — чтобы
   написать участнику без карточки; номера участников его роликов он и
   так видит в /api/tasks/videos. Внутренние номера держим рядом, в uids. */
function vidCardOf(uid) { const r = q.cardPubOf.get(uid); return r ? String(r.id) : ''; }
/* who — постоянный ключ участника для «Профиль» и «Чат» (10.10.2026).
   Раньше единственным ключом у всех, кроме автора задания, была открытая
   карта каталога: когда карты сняли с витрины, кнопки «Профиль» и «Чат»
   у других участников пропали. who от каталога не зависит и номера
   аккаунта не раскрывает (HMAC по секрету сервера). Номер для чата
   приложение спрашивает отдельно (POST /api/tasks/peer) — только когда
   человек нажал «Чат». Секрет лежит в server_flags и наружу не уходит. */
let vidWhoSecret = '';
function vidWhoKey(uid) {
  if (!vidWhoSecret) {
    try {
      const f = q.flagGet.get('who_secret');
      if (f && /^[a-f0-9]{64}$/.test(f.value)) vidWhoSecret = f.value;
      else { vidWhoSecret = crypto.randomBytes(32).toString('hex'); q.flagSet.run('who_secret', vidWhoSecret); }
    } catch (e) { if (!vidWhoSecret) vidWhoSecret = crypto.randomBytes(32).toString('hex'); }
  }
  return crypto.createHmac('sha256', vidWhoSecret).update('who:' + uid).digest('base64url').slice(0, 22);
}
/* Кто может стоять в лидерборде или списке участников задания: вступившие
   (в том числе вышедшие — их ролики остаются в лидерборде) и авторы роликов. */
const vidPeerIds = db.prepare(`SELECT user_id AS id FROM task_members WHERE camp_id = ?
  UNION SELECT blogger_id FROM task_videos WHERE camp_id = ?`);
function vidBoardSorted(agg, sort) {
  if (agg.sorted[sort]) return agg.sorted[sort];
  const list = sort === 'views' ? agg.ranked.slice() : agg.ranked.slice().sort((a, b) =>
    (b.earned - a.earned) || (b.views - a.views) || (a.firstAt - b.firstAt) || (a.uid - b.uid));
  const mine = new Map(list.map((r, i) => [r.uid, Object.assign({}, r, { rank: i + 1 })]));
  const top = list.slice(0, 50);
  const leaders = top.map((r, i) => Object.assign({ rank: i + 1, name: vidPubName(r.name) },
    vidPubChan(agg.key, r.uid), { card: vidCardOf(r.uid), who: vidWhoKey(r.uid), videos: r.videos, views: r.views, earned: r.earned, earnedNet: r.earnedNet || 0 }));
  agg.sorted[sort] = { leaders, uids: top.map((r) => r.uid), mine };
  return agg.sorted[sort];
}
function vidBoardPage(agg, campId, offset, limit) {
  const k = offset + '|' + limit;
  if (agg.pages.has(k)) return agg.pages.get(k);
  const ms = q.tmList.all(String(campId), limit, offset);
  const rows = ms.map((m, i) => {
    const r = agg.byUid.get(m.user_id);
    return Object.assign({ rank: offset + i + 1, name: vidPubName(m.name) }, vidPubChan(campId, m.user_id),
      { card: vidCardOf(m.user_id), who: vidWhoKey(m.user_id), videos: r ? r.videos : 0, joinedAt: m.joined_at });
  });
  const page = { rows, uids: ms.map((m) => m.user_id) };
  if (agg.pages.size < 50) agg.pages.set(k, page);
  return page;
}
/* Строки наружу для того, кто спрашивает: «вы» — его строка, uid — только
   автору задания. */
function vidBoardOut(rows, uids, me, owner) {
  return rows.map((x, i) => {
    const o = Object.assign({}, x);
    if (uids[i] === me) o.me = true;
    if (owner) o.uid = uids[i];
    return o;
  });
}

/* ── Возврат от Телеграма после входа ──
   Телеграм возвращает человека с полями id, first_name, last_name,
   username, photo_url, auth_date и hash. Кладёт он их по-разному: в
   адресе или во фрагменте (#tgAuthResult=…). Фрагмент до сервера не
   доезжает вовсе — его видит только браузер. Поэтому: если поля в
   адресе, разбираем сразу; если их нет, отдаём крошечную страницу,
   которая перекладывает фрагмент в обычный запрос. Так работают оба
   случая и ничего не приходится угадывать. */
function tgFinish(req, res, state, rec, fields) {
  /* rec.at — начало ЭТОГО входа: ответ, выданный раньше, не годится. */
  const chk = tgWidgetCheck(fields, rec.at);
  if (!chk.ok) return verifyPage(res, 'Не вышло войти', chk.why, false);

  /* ── ПРИВЯЗКА ──
     Человек уже внутри и добавляет Телеграм к своему аккаунту. Балансы
     НЕ сливаем: если этот Телеграм уже заведён отдельным аккаунтом, у
     него могут быть свои деньги и своя история, и молча склеить два
     кошелька нельзя. Такое решение принимает человек, а не сервер. */
  if (rec.linkUser) {
    const mine = q.userById.get(rec.linkUser);
    if (!mine) return verifyPage(res, 'Не вышло привязать', 'Аккаунт не найден — войдите заново.', false);
    const taken = q.userByTg.get(String(chk.tg.id));
    if (taken && Number(taken.id) !== Number(mine.id)) {
      return verifyPage(res, 'Этот Телеграм уже занят',
        'Он привязан к другому аккаунту BloggerPay. Войдите в тот аккаунт через Телеграм или напишите в поддержку.', false);
    }
    /* Здесь ничего не привязываем: только запоминаем, КТО подтвердил.
       Привязывает link-confirm от того же аккаунта (см. выше). */
    rec.tg = { id: String(chk.tg.id), name: chk.tg.name, username: chk.tg.username };
    rec.token = '';
    return loginDone(req, res, 'tg', tglog, state, rec, null);
  }

  const u = tgAccount(chk.tg.id, chk.tg.name, rec.role);
  if (!u) return verifyPage(res, 'Не вышло создать аккаунт', 'Попробуйте ещё раз через минуту.', false);
  if (u.is_blocked) {
    tglog.delete(state);
    return verifyPage(res, 'Аккаунт заблокирован', 'Напишите в поддержку.', false);
  }
  syncAdminFlag(u);

  /* Сессию заведёт выдача (pending/claim) — см. loginIssue. */
  return loginDone(req, res, 'tg', tglog, state, rec, u);
}

/* Страница-перекладчик: читает фрагмент и отправляет его на тот же адрес
   ФОРМОЙ (POST), а фрагмент стирает из истории. Раньше поля уходили
   переходом в адрес (?id=…&hash=…) и оседали в истории браузера и
   журналах прокси (аудит 16.10). Никакой логики входа здесь нет. */
function tgHashPage(res, state) {
  const esc = (v) => String(v).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
  const html = '<!doctype html><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>Заканчиваем вход</title>'
    + '<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;'
    + 'background:#0f1115;color:#a2a9b4;font:500 14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif}</style>'
    + '<div>Заканчиваем вход…</div>'
    + '<script>(function(){try{'
    + 'var h=String(location.hash||"").replace(/^#/,"");'
    + 'var p=new URLSearchParams(h);var r=p.get("tgAuthResult");'
    + 'var out=new URLSearchParams();out.set("n",' + JSON.stringify(state) + ');'
    + 'if(r){var t=r.replace(/-/g,"+").replace(/_/g,"/");'
    + 'while(t.length%4)t+="=";var o=JSON.parse(decodeURIComponent(escape(atob(t))));'
    + 'Object.keys(o).forEach(function(k){ if(o[k]!=null) out.set(k,String(o[k])); });}'
    + 'else{p.forEach(function(v,k){ out.set(k,v); });}'
    + 'if(!out.get("hash")){document.body.textContent="Телеграм не прислал ответ. Начните вход заново.";return;}'
    + 'try{history.replaceState(null,"",location.pathname+"?n="+encodeURIComponent(out.get("n")));}catch(e){}'
    + 'var f=document.createElement("form");f.method="POST";f.action=location.pathname;'
    + 'out.forEach(function(v,k){var i=document.createElement("input");i.type="hidden";i.name=k;i.value=v;f.appendChild(i);});'
    + 'document.body.appendChild(f);f.submit();'
    + '}catch(e){document.body.textContent="Не вышло разобрать ответ Телеграма.";}})();<\/script>';
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  return res.end(html);
}

async function handleTelegramCallback(req, res, url) {
  /* Поля приходят либо в адресе (так их кладёт Телеграм), либо формой
     со страницы-перекладчика (POST). */
  let src = url.searchParams;
  if (req.method === 'POST') {
    let raw = '';
    try { raw = await readRaw(req, 8 * 1024); } catch (e) { raw = ''; }
    src = new URLSearchParams(raw);
    if (!src.get('n') && url.searchParams.get('n')) src.set('n', url.searchParams.get('n'));
  }
  const state = String(src.get('n') || src.get('state') || '');
  const rec = tglog.get(state);

  if (!rec) return verifyPage(res, 'Ссылка не найдена', 'Начните вход заново из приложения.', false);
  if (Date.now() - rec.at > GLOG_TTL) {
    tglog.delete(state);
    return verifyPage(res, 'Слишком долго', 'Ссылка входа живёт 15 минут. Начните заново.', false);
  }
  /* Кода здесь больше нет: метку знает и тот, кто прислал ссылку, — по
     ней он открыл бы эту страницу и прочёл код чужого входа. */
  if (rec.done) {
    return verifyPage(res, 'Вход уже подтверждён',
      'Вернитесь в приложение — оно уже впустило вас. Если нет, начните вход заново.',
      false, '', APP_BASE + '?tglogin=' + encodeURIComponent(state));
  }

  const fields = {};
  for (const [k, v] of src.entries()) {
    if (k === 'n' || k === 'state') continue;
    fields[k] = v;
  }
  /* Телеграм при отказе просто возвращает человека без полей. */
  if (!fields.hash) return tgHashPage(res, state);

  try {
    return tgFinish(req, res, state, rec, fields);
  } catch (e) {
    return verifyPage(res, 'Не вышло войти', String((e && e.message) || e).slice(0, 160), false);
  }
}

/* ── Возврат от Google после входа ──
   Меняем код на токен, спрашиваем у Google, кто это, находим или заводим
   аккаунт и кладём готовую сессию под метку. Дальше человека сразу
   уводит обратно в приложение — оно заберёт вход по метке само. Код
   остаётся под раскрывашкой: он нужен только тому, у кого приложение
   осталось в другом браузере. */
async function handleGoogleCallback(req, res, url) {
  const cfg = OAUTH.youtube;
  const state = String(url.searchParams.get('state') || '');
  const code = url.searchParams.get('code');
  const rec = glog.get(state);

  if (!rec) return verifyPage(res, 'Ссылка не найдена', 'Начните вход заново из приложения.', false);
  if (Date.now() - rec.at > GLOG_TTL) {
    glog.delete(state);
    return verifyPage(res, 'Слишком долго', 'Ссылка входа живёт 15 минут. Начните заново.', false);
  }
  /* Сначала «уже подтверждён» и БЕЗ кода: метку знает и тот, кто прислал
     ссылку, — по ней он открыл бы эту страницу и прочёл код чужого входа
     (или стёр бы чужой вход адресом без code). */
  if (rec.done) {
    return verifyPage(res, 'Вход уже подтверждён',
      'Вернитесь в приложение — оно уже впустило вас. Если нет, начните вход заново.',
      false, '', APP_BASE + '?glogin=' + encodeURIComponent(state));
  }
  if (!code) {
    glog.delete(state);
    return verifyPage(res, 'Вход отменён', 'Вы не разрешили доступ — аккаунт не создан.', false);
  }

  const ask = async (address, opts) => {
    let last;
    for (let i = 0; i < 2; i++) {
      try {
        const stop = AbortSignal.timeout ? AbortSignal.timeout(12000) : undefined;
        const r = await fetch(address, Object.assign({ signal: stop }, opts || {}));
        return await r.json();
      } catch (e) { last = e; }
    }
    throw new Error('Google не ответил вовремя. Попробуйте ещё раз через минуту.');
  };

  try {
    const tok = await ask(cfg.token, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code, client_id: cfg.id, client_secret: cfg.secret,
        redirect_uri: OAUTH_BASE + '/api/auth/google/callback',
        grant_type: 'authorization_code',
      }),
    });
    if (!tok.access_token) throw new Error(tok.error_description || 'Google не выдал доступ');

    const me = await ask('https://www.googleapis.com/oauth2/v3/userinfo',
      { headers: { Authorization: 'Bearer ' + tok.access_token } });
    const sub = String(me.sub || '');
    if (!sub) throw new Error('Google не сказал, кто вошёл');
    /* Непроверенную почту не принимаем: иначе чужой аккаунт с такой же
       почтой мог бы отобрать вход. */
    const mail = (me.email_verified === false) ? '' : String(me.email || '').toLowerCase();
    const name = String(me.name || '').trim().slice(0, 120)
      || (mail ? mail.split('@')[0] : 'Пользователь Google');

    let u = q.userByGoogle.get(sub);
    if (!u) {
      /* Пароля у такого аккаунта нет: вход только через Google, поэтому
         в поля хеша кладём случайный мусор, которым войти нельзя. */
      const email = mail || ('g' + sub + '@google.local');
      /* Почта уже занята обычной регистрацией. Чужой аккаунт по почте не
         отдаём: при регистрации почту никто не подтверждал, и на чужой
         адрес можно завести аккаунт заранее, чтобы поймать в него
         хозяина почты. Раньше в этом случае молча заводился второй
         аккаунт на служебном адресе — человек попадал в пустой кабинет
         и думал, что вход сломан, а вернуть его было нечем. Теперь
         говорим прямо. */
      if (q.userByEmail.get(email)) {
        glog.delete(state);
        return verifyPage(res, 'Такая почта уже занята',
          'В BloggerPay уже есть аккаунт на ' + email + '. Войдите паролем — '
          + 'через Google в него пока не пускаем, иначе чужой аккаунт можно было бы '
          + 'забрать себе. Пароль забыт — восстановите его по почте.', false);
      }
      const salt = deadSalt();   /* метка «своего пароля нет» — «Настройки» дадут его задать */
      const dead = crypto.randomBytes(32).toString('hex');
      const role = rec.role === 'advertiser' ? 'advertiser' : 'blogger';
      try {
        q.insGoogleUser.run(email, name, role, salt, dead, sub);
      } catch (e) {
        return verifyPage(res, 'Не вышло создать аккаунт', 'Попробуйте ещё раз через минуту.', false);
      }
      u = q.userByGoogle.get(sub);
    }
    if (!u) return verifyPage(res, 'Не вышло войти', 'Попробуйте ещё раз через минуту.', false);
    if (u.is_blocked) {
      glog.delete(state);
      return verifyPage(res, 'Аккаунт заблокирован', 'Напишите в поддержку.', false);
    }
    syncAdminFlag(u);

    /* Сессию заведёт выдача (pending/claim) — см. loginIssue. Возврат не
       в тот браузер, что начинал, получает код, а не сессию. */
    return loginDone(req, res, 'g', glog, state, rec, u);
  } catch (e) {
    return verifyPage(res, 'Не вышло войти', String((e && e.message) || e).slice(0, 160), false);
  }
}

async function handleVerifyCallback(req, res, url) {
  const p = url.pathname.split('/').pop();
  const cfg = OAUTH[p];
  if (!cfg) return verifyPage(res, 'Неизвестная площадка', 'Проверьте ссылку возврата.', false);

  const code = url.searchParams.get('code');
  const state = String(url.searchParams.get('state') || '');
  if (!code) return verifyPage(res, 'Проверка отменена', 'Вы не разрешили доступ — канал не подтверждён.', false);

  const rec = vfy.get(state);
  if (!rec || rec.platform !== p) {
    return verifyPage(res, 'Ссылка не найдена', 'Начните проверку заново из приложения.', false);
  }
  if (Date.now() - rec.at > VFY_TTL) {
    vfy.delete(state);
    return verifyPage(res, 'Слишком долго', 'Проверка живёт 15 минут. Начните заново.', false);
  }
  if (rec.channel) {
    return verifyPage(res, 'Код уже выдан',
      'Введите его в приложении. Если код потерян — начните проверку заново.', false);
  }

  const redirect = OAUTH_BASE + '/api/verify/callback/' + p;

  /* Запрос к площадке с ограничением по времени и одной повторной
     попыткой: разовый обрыв бывает, вечное ожидание — нет. */
  const ask = async (address, opts) => {
    let last;
    for (let i = 0; i < 2; i++) {
      try {
        const stop = AbortSignal.timeout ? AbortSignal.timeout(12000) : undefined;
        const r = await fetch(address, Object.assign({ signal: stop }, opts || {}));
        return await r.json();
      } catch (e) { last = e; }
    }
    throw new Error('Площадка не ответила вовремя. Попробуйте ещё раз через минуту.');
  };

  try {
    let channel;
    if (p === 'youtube') {
      const tok = await ask(YT_TOKEN_URL, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code, client_id: cfg.id, client_secret: cfg.secret,
          redirect_uri: redirect, grant_type: 'authorization_code',
        }),
      });
      if (!tok.access_token) throw new Error(tok.error_description || 'YouTube не выдал доступ');
      const me = await ask(
        YT_API_BASE + '/youtube/v3/channels?part=snippet,statistics&mine=true',
        { headers: { Authorization: 'Bearer ' + tok.access_token } });
      const it = me.items && me.items[0];
      if (!it) throw new Error('У этого аккаунта нет канала на YouTube');
      const th = (it.snippet && it.snippet.thumbnails) || {};
      channel = {
        id: it.id, title: (it.snippet && it.snippet.title) || '',
        url: 'https://youtube.com/channel/' + it.id,
        subs: Number(it.statistics && it.statistics.subscriberCount) || 0,
        /* картинку канала площадка отдаёт вместе с именем — по ней человек
           узнаёт свой канал в списке с одного взгляда */
        avatar: ((th.medium || th.default || {}).url) || '',
        username: (it.snippet && it.snippet.customUrl) || '',
        videosTotal: Number(it.statistics && it.statistics.videoCount) || 0,
        viewsTotal: Number(it.statistics && it.statistics.viewCount) || 0,
      };
      rec.access = tok.access_token || '';
      rec.refresh = tok.refresh_token || '';
      rec.expires = Number(tok.expires_in) || 0;
    } else if (p === 'instagram') {
      const tok = await ask(cfg.token, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: cfg.id, client_secret: cfg.secret,
          grant_type: 'authorization_code', redirect_uri: redirect, code,
        }),
      });
      /* ответ бывает двух видов: { access_token, user_id } и { data: [ … ] } */
      const t0 = (tok && Array.isArray(tok.data) ? tok.data[0] : tok) || {};
      if (!t0.access_token) {
        throw new Error(String((tok && (tok.error_message || (tok.error && (tok.error.message || tok.error))))
          || 'Instagram не выдал доступ').slice(0, 200));
      }
      /* короткий доступ живёт час — меняем на долгий (60 дней), его продлевает igAccess */
      let access = t0.access_token, expires = 3600;
      try {
        const ll = await ask(IG_GRAPH_BASE + '/access_token?' + new URLSearchParams({
          grant_type: 'ig_exchange_token', client_secret: cfg.secret, access_token: t0.access_token }));
        if (ll && ll.access_token) { access = ll.access_token; expires = Number(ll.expires_in) || 60 * 86400; }
      } catch (e) { /* остаётся короткий: продлить можно будет, переподключив */ }
      const me = await ask(igUrl('/me') + '?' + new URLSearchParams({
        fields: 'user_id,username,name,profile_picture_url,followers_count,media_count,account_type',
        access_token: access }));
      if (!me || (!me.user_id && !me.id)) {
        throw new Error('Instagram не отдал данные аккаунта'
          + (me && me.error && me.error.message ? ': ' + String(me.error.message).slice(0, 160) : ''));
      }
      const nick = String(me.username || '').replace(/[^\w.]/g, '').slice(0, 40);
      const pic = String(me.profile_picture_url || '');
      channel = {
        id: String(me.user_id || me.id), title: String(me.name || nick || '').slice(0, 80),
        url: nick ? 'https://www.instagram.com/' + nick + '/' : '',
        subs: Number(me.followers_count) || 0,
        avatar: /^https:\/\//i.test(pic) ? pic.slice(0, 1000) : '',
        username: nick, videosTotal: Number(me.media_count) || 0,
      };
      rec.access = access;
      rec.refresh = '';
      rec.expires = expires;
    } else {
      const tok = await ask(cfg.token, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code, client_key: cfg.id, client_secret: cfg.secret,
          redirect_uri: redirect, grant_type: 'authorization_code',
        }),
      });
      if (!tok.access_token) throw new Error((tok.error_description || tok.error) || 'TikTok не выдал доступ');
      const scope = String(cfg.scope || '');
      /* Просим ВСЁ, что даёт выданное право: по имени и числу подписчиков
         нельзя отличить живой канал от накрученного, а по картине из
         просмотров, лайков и комментариев — можно. */
      const fields = ['open_id', 'union_id', 'avatar_url', 'display_name'];
      if (/user\.info\.profile/.test(scope)) fields.push('username', 'profile_deep_link', 'is_verified');
      if (/user\.info\.stats/.test(scope)) {
        fields.push('follower_count', 'following_count', 'likes_count', 'video_count');
      }
      const head = { headers: { Authorization: 'Bearer ' + tok.access_token } };
      let me = await ask(cfg.userInfo + '?fields=' + fields.join(','), head);
      let d = me.data && me.data.user;
      if (!d && /scope/i.test(String((me.error && (me.error.message || me.error.code)) || ''))) {
        /* Права уже, чем мы просили: берём только то, что дают всем. */
        me = await ask(cfg.userInfo + '?fields=open_id,display_name', head);
        d = me.data && me.data.user;
      }
      if (!d) {
        const why = (me.error && (me.error.message || me.error.code)) || '';
        throw new Error('TikTok не отдал данные аккаунта' + (why ? ': ' + why : ''));
      }
      channel = {
        id: d.open_id, title: d.display_name || '',
        /* Ссылку строим из ника, если площадка не дала прямую. Без прав на
           профиль ссылки нет вовсе — канал всё равно подтверждён, адрес
           допишет сам блогер. */
        url: d.profile_deep_link || (d.username ? 'https://www.tiktok.com/@' + d.username : ''),
        subs: Number(d.follower_count) || 0,
        avatar: d.avatar_url || '',
        username: d.username || '',
        verified: d.is_verified ? 1 : 0,
        following: Number(d.following_count) || 0,
        likesTotal: Number(d.likes_count) || 0,
        videosTotal: Number(d.video_count) || 0,
      };
      rec.access = tok.access_token || '';
      rec.refresh = tok.refresh_token || '';
      rec.expires = Number(tok.expires_in) || 0;
    }

    if (!channel.id) throw new Error('Площадка не назвала аккаунт');

    /* Не привязываем здесь: канал получит тот, кто введёт код в приложении.
       Так подсунутая кем-то ссылка авторизации не запишет ваш канал на него. */
    rec.channel = channel;
    rec.code = String(crypto.randomInt(100000, 1000000));
    rec.claim = crypto.randomBytes(24).toString('hex');
    /* Начинали в мини-приложении Телеграма — код на странице (см. start). */
    if (rec.viaCode) {
      const pn = { tiktok: 'TikTok', youtube: 'YouTube', instagram: 'Instagram' }[rec.platform] || 'Аккаунт';
      return verifyPage(res, pn + ' найден' + (channel.title ? ': ' + String(channel.title).slice(0, 60) : ''),
        'Вернитесь в Телеграм — в BloggerPay откроется окно для кода. Введите там эти шесть цифр.'
        + ' Никому их не сообщайте — даже поддержке BloggerPay.', true, rec.code);
    }
    /* Возвращаем человека прямо в приложение. Пропуск живёт в адресе —
       его получает только этот браузер. */
    const back = APP_BASE + '?vfy=' + encodeURIComponent(state) + '&claim=' + rec.claim;
    res.writeHead(302, { Location: back, 'Cache-Control': 'no-store' });
    return res.end();
  } catch (e) {
    console.error('[verify]', e);
    return verifyPage(res, 'Проверка не прошла', String(e.message || e), false);
  }
}

/* Страница оператора лежит отдельным файлом и НЕ входит в мини-апп:
   ключ оператора нельзя класть в файл, который скачивает каждый
   пользователь. Здесь отдаём её только по прямому запросу. */
function sendOperatorPage(res) {
  let html;
  try { html = fs.readFileSync(path.join(__dirname, 'operator.html')); }
  catch (e) { return send(res, 404, { error: 'operator.html рядом с сервером не найден' }); }
  /* Пульт выплат во фрейме не открывают вовсе: у него своя сессия и
     кнопки «выплачено». Здесь можно и нужно запрещать жёстко. */
  res.writeHead(200, Object.assign({}, PAGE_SECURITY, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    /* Единственное исключение — веб-Телеграм (аудит 16.10.2026): кнопка
       «Админ панель» там открывает мини-приложение во фрейме, и при 'none'
       владелец видел пустое «отказано в подключении» вместо подсказки
       «откройте в приложении Телеграма». Действий во фрейме всё равно нет:
       кука bp_admin SameSite=Strict чужому фрейму не достаётся. Прочие
       сайты обернуть страницу по-прежнему не могут (X-Frame-Options не
       умеет список, поэтому его нет — правило задаёт CSP). */
    'Content-Security-Policy': "frame-ancestors https://web.telegram.org",
  }));
  res.end(html);
}

/* Страница показа кода — отдельный файл рядом с сервером, как и пульт
   оператора. Referrer-Policy стоит намеренно: со страницы человек
   уходит по кнопке в приложение, и адрес с меткой не должен уехать
   в заголовке Referer на чужой домен. */
function sendRecoverPage(res) {
  let html;
  try { html = fs.readFileSync(path.join(__dirname, 'recover.html'), 'utf8'); }
  catch (e) { return send(res, 404, { error: 'recover.html рядом с сервером не найден' }); }
  /* Адрес мини-аппа отдаём атрибутом: страница лежит статикой, а знать,
     куда возвращать человека, ей надо. Кавычки вычищаем — иначе адресом
     из .env можно было бы дописать свой атрибут в тег. */
  const app = APP_BASE.replace(/\/+$/, '').replace(/[^A-Za-z0-9:/._~%?#\[\]@!$&'()*+,;=-]/g, '');
  const safe = /^https?:\/\//i.test(app) ? app : '';
  html = html.replace('<html lang="ru">', '<html lang="ru" data-app="' + safe + '">');
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  res.end(html);
}

/* ── Раздача сайта ───────────────────────────────────────────────────
   Приложение — один HTML-файл в папке над сервером. Отдаём его как
   главную страницу, рядом — то, что ему нужно: знакомство, политика,
   офлайн-режим и логотип.

   Белый список, а не «отдавай что попросят»: рядом лежат .env, база с
   паспортами и папки с черновиками. Любая ошибка в разборе пути при
   свободной раздаче открыла бы их наружу, поэтому путей ровно столько,
   сколько нужно, и вычисляются они не из запроса. */
const SITE_DIR = path.join(__dirname, '..');
const SITE = {
  '/': { name: 'bloggerpay-1008-v100.html', type: 'text/html; charset=utf-8' },
  '/index.html': { name: 'bloggerpay-1008-v100.html', type: 'text/html; charset=utf-8' },
  '/onboarding.html': { name: 'onboarding.html', type: 'text/html; charset=utf-8' },
  '/privacy.html': { name: 'privacy.html', type: 'text/html; charset=utf-8' },
  /* Условия использования: их адрес спрашивают площадки при проверке
     приложения, ссылка внутри мини-аппа им не подходит. */
  '/terms.html': { name: 'terms.html', type: 'text/html; charset=utf-8' },
  '/sw.js': { name: 'sw.js', type: 'text/javascript; charset=utf-8' },
  '/logo.jpg': { name: 'logo.jpg', type: 'image/jpeg' },
  /* Установка приложения на телефон. Манифест и иконки должны быть
     НАСТОЯЩИМИ файлами: манифест, собранный в браузере через blob:, и
     иконки в виде data: браузер для установки не принимает — предложение
     «Установить приложение» просто не появлялось. */
  '/manifest.webmanifest': { name: 'manifest.webmanifest', type: 'application/manifest+json; charset=utf-8' },
  '/icon-192.png': { name: 'icon-192.png', type: 'image/png' },
  '/icon-512.png': { name: 'icon-512.png', type: 'image/png' },
  '/icon-512-maskable.png': { name: 'icon-512-maskable.png', type: 'image/png' },
};
/* ── Магазин соусов «Санчоус» по адресу /sauce/ ──────────────────────
   У магазина есть свой бот на этом же хостинге, но его узел (de2) не
   отвечает: соединение и TLS проходят, а до контейнера прокси не
   достаёт — сайт снаружи висит до таймаута. Узел, на котором живёт
   BloggerPay, работает, поэтому магазин раздаём отсюда.

   Здесь, в отличие от списка выше, файлов десятки, и перечислять их
   поимённо не имеет смысла. Поэтому раздаём папку — но по правилам, а
   не «что попросят»:
     · только внутри /sauce/ и только из папки sauce;
     · путь после разбора обязан остаться ВНУТРИ этой папки (проверяем
       результат path.resolve, а не сам запрос: «..» умеют прятать в
       кодировке);
     · расширение — из списка; неизвестное просто не отдаём.
   Секретов в этой папке нет: там лежит только сайт магазина. */
const SAUCE_DIR = path.join(SITE_DIR, 'sauce');
const SAUCE_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};
function sauceFile(pathname) {
  if (!pathname.startsWith('/sauce/')) return null;
  let rest = pathname.slice('/sauce/'.length);
  try { rest = decodeURIComponent(rest); } catch (e) { return null; }
  if (rest === '' || rest.endsWith('/')) rest += 'index.html';
  /* Обратный слэш на Windows — тоже разделитель, а нулевой байт обрезает
     имя в системном вызове. Ни того, ни другого в адресе быть не может. */
  if (rest.includes('\0') || rest.includes('\\')) return null;
  const file = path.resolve(SAUCE_DIR, rest);
  if (file !== SAUCE_DIR && !file.startsWith(SAUCE_DIR + path.sep)) return null;
  const type = SAUCE_TYPES[path.extname(file).toLowerCase()];
  if (!type) return null;
  return { file, type };
}

function staticFile(pathname) {
  const rec = SITE[pathname];
  if (rec) return { file: path.join(SITE_DIR, rec.name), type: rec.type };
  /* Файл-подпись площадки: /tiktok<буквы и цифры>.txt из корня проекта. */
  const sign = /^\/(tiktok[A-Za-z0-9]{8,64}\.txt)$/.exec(pathname);
  if (sign) return { file: path.join(SITE_DIR, sign[1]), type: 'text/plain; charset=utf-8' };
  return sauceFile(pathname);
}
/* Заголовки безопасности для страниц, которые отдаёт сам сервер.
   На Netlify их ставит netlify.toml, но сайт раздаёт и этот сервер —
   без них приложение с деньгами открывается во фрейме чужого сайта,
   и поверх настоящей кнопки оплаты рисуется поддельная.

   frame-ancestors: мини-апп Телеграм открывает во фрейме на своих
   доменах — их и разрешаем. X-Frame-Options здесь не ставим: он не
   умеет список доменов и сломал бы веб-версию Телеграма. */
const FRAME_CSP = "frame-ancestors 'self' https://web.telegram.org https://*.telegram.org https://telegram.org";
const PAGE_SECURITY = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Content-Security-Policy': FRAME_CSP,
};

/* Файлы сайта держим в памяти.
   Главная страница весит 5,3 МБ, и раньше КАЖДЫЙ заход читал её с диска
   заново — синхронно, то есть на это время весь сервер (и касса вместе с
   ним) стоял. Ни входа, ни ограничителя частоты перед раздачей нет, так
   что десяток параллельных запросов от кого угодно клал приём платежей.
   Теперь читаем один раз и следим за временем правки: обновили файл на
   хостинге — отдача подхватит новый сам. */
/* Сжатие и переспрос (аудит 16.10, C52). Главная весит 7 МБ и уходила
   целиком, без сжатия и с no-store: КАЖДОЕ открытие мини-аппа по
   мобильному интернету — 7 МБ заново (на живом адресе 38 с заставки).
   Теперь:
     · сжатые копии (br и gzip) готовятся ОДИН раз на версию файла, в
       фоне (пул потоков zlib — сервер и касса не стоят), пока не готовы —
       отдаём как есть;
     · отпечаток (ETag по содержимому) и Last-Modified, Cache-Control:
       no-cache — браузер хранит копию, но КАЖДЫЙ раз переспрашивает:
       не изменилась — 304 в пару сотен байт, изменилась — новая версия
       сразу (свежесть как при no-store, застрять старой версии нельзя).
   ETag слабый (W/) и общий для всех сжатий: тело одно и то же по смыслу. */
const zlib = require('node:zlib');
function packable(type) {
  return /^(text\/|application\/(json|manifest\+json|javascript)|image\/svg\+xml)/.test(String(type || ''));
}
const fileCache = new Map();
function readCached(file, type) {
  let st;
  try { st = fs.statSync(file); } catch (e) { fileCache.delete(file); return null; }
  const stamp = String(st.mtimeMs) + ':' + String(st.size);
  const hit = fileCache.get(file);
  if (hit && hit.stamp === stamp) return hit;
  let buf;
  try { buf = fs.readFileSync(file); } catch (e) { fileCache.delete(file); return null; }
  const ent = {
    stamp,
    buf,
    etag: 'W/"' + crypto.createHash('sha1').update(buf).digest('base64url') + '"',
    mtime: new Date(Math.floor(st.mtimeMs / 1000) * 1000),
    pack: packable(type) && buf.length >= 1024,
    gz: null,
    br: null,
  };
  fileCache.set(file, ent);
  if (ent.pack) {
    zlib.gzip(buf, { level: 9 }, (err, out) => {
      if (!err && fileCache.get(file) === ent && out.length < buf.length) ent.gz = out;
    });
    zlib.brotliCompress(buf, { params: {
      [zlib.constants.BROTLI_PARAM_QUALITY]: 9,
      [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length,
    } }, (err, out) => {
      if (!err && fileCache.get(file) === ent && out.length < buf.length) ent.br = out;
    });
  }
  return ent;
}
/* Принимает ли клиент сжатие name (с q > 0). */
function acceptsEnc(req, name) {
  const parts = String(req.headers['accept-encoding'] || '').toLowerCase().split(',');
  for (const part of parts) {
    const bits = part.split(';');
    if (bits[0].trim() !== name) continue;
    let qv = 1;
    for (const b of bits.slice(1)) {
      const m = /^\s*q\s*=\s*([0-9.]+)\s*$/.exec(b);
      if (m) qv = Number(m[1]);
    }
    return qv > 0;
  }
  return false;
}
function notModified(req, ent) {
  const inm = req.headers['if-none-match'];
  if (inm) {
    const want = ent.etag.replace(/^W\//, '');
    return String(inm).split(',').some((t) => {
      const v = t.trim();
      return v === '*' || v.replace(/^W\//, '') === want;
    });
  }
  const ims = Date.parse(String(req.headers['if-modified-since'] || ''));
  return Number.isFinite(ims) && ent.mtime.getTime() <= ims;
}

function sendFile(req, res, file, type) {
  const ent = readCached(file, type);
  if (!ent) return send(res, 404, { error: 'Файл не найден: ' + path.basename(file) });
  /* Страницу приложения браузер хранит, но каждый раз переспрашивает
     (no-cache, не no-store): иначе у людей застрянет старая версия с
     деньгами. Картинку — можно держать сутки, она не меняется. */
  const fresh = /^image\//.test(type) ? 'public, max-age=86400' : 'no-cache';
  const head = Object.assign({}, PAGE_SECURITY, {
    'Cache-Control': fresh,
    ETag: ent.etag,
    'Last-Modified': ent.mtime.toUTCString(),
  });
  if (ent.pack) head.Vary = 'Accept-Encoding';
  if (notModified(req, ent)) {
    res.writeHead(304, head);
    return res.end();
  }
  let body = ent.buf;
  if (ent.pack && ent.br && acceptsEnc(req, 'br')) {
    body = ent.br;
    head['Content-Encoding'] = 'br';
  } else if (ent.pack && ent.gz && acceptsEnc(req, 'gzip')) {
    body = ent.gz;
    head['Content-Encoding'] = 'gzip';
  }
  head['Content-Type'] = type;
  head['Content-Length'] = body.length;
  res.writeHead(200, head);
  if (req.method === 'HEAD') return res.end();
  res.end(body);
}
/* Главную и sw.js читаем и сжимаем сразу при старте: первый человек
   после выкладки уже получает сжатую страницу. */
setTimeout(() => {
  for (const p of ['/', '/sw.js']) {
    const hit = staticFile(p);
    if (hit) { try { readCached(hit.file, hit.type); } catch (e) { /* нет файла — не беда */ } }
  }
}, 50).unref();

/* Обработчик вынесен отдельно: слушать приходится не один порт (почему —
   у listenOn ниже), а один http.Server умеет слушать только один. */
const handler = async (req, res) => {
  proxyProbe(req);
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch (e) {
    /* «GET //», «GET ///» и прочие адреса без хоста разбору не поддаются.
       Это не повод падать: отвечаем 400 и живём дальше. */
    return send(res, 400, { error: 'Неверный адрес запроса' });
  }
  if (req.method === 'OPTIONS') return send(res, 204, {});
  if (req.method === 'GET' && (url.pathname === '/operator' || url.pathname === '/operator.html'
      || url.pathname === '/admin' || url.pathname === '/admin.html')) {
    return sendOperatorPage(res);
  }
  if (req.method === 'GET' && url.pathname.startsWith('/api/verify/callback/')) {
    return handleVerifyCallback(req, res, url);
  }
  /* Instagram (Meta): человек отключил наше приложение или попросил удалить
     данные — площадка присылает signed_request формой, а не JSON. */
  if (req.method === 'POST' && (url.pathname === '/api/verify/instagram/deauth'
      || url.pathname === '/api/verify/instagram/delete')) {
    return handleIgSigned(req, res, url);
  }
  /* Возврат человека от Google после входа. Отдаём страницу, а не JSON:
     сюда приходит браузер, а не приложение. */
  if (req.method === 'GET' && url.pathname === '/api/auth/google/callback') {
    return handleGoogleCallback(req, res, url);
  }
  /* POST — поля из фрагмента, которые прислала страница-перекладчик. */
  if ((req.method === 'GET' || req.method === 'POST') && url.pathname === '/api/auth/telegram/callback') {
    return handleTelegramCallback(req, res, url);
  }
  /* Страница показа кода. Саму метку страница берёт из адреса уже в
     браузере — сервер здесь отдаёт только вёрстку и ничего не решает. */
  if (req.method === 'GET' && /^\/r\/[a-f0-9]{32}$/i.test(url.pathname)) {
    return sendRecoverPage(res);
  }
  /* Картинки заданий (POST /api/media). Неизменны — кэшируем надолго. */
  if ((req.method === 'GET' || req.method === 'HEAD') && /^\/media\/[a-f0-9]{32}$/.test(url.pathname)) {
    const row = qm.get.get(url.pathname.slice(7));
    if (!row) return send(res, 404, { error: 'Картинки нет' });
    const buf = Buffer.from(row.data);
    const head = Object.assign({}, PAGE_SECURITY, {
      'Content-Type': row.mime,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'public, max-age=31536000, immutable',
      /* Access-Control-Allow-Origin: * снят (аудит 16.10.2026): приложение
         показывает файлы тегами img/video, которым CORS не нужен, а читать
         их скриптом с чужих сайтов незачем. Показ в чужих страницах
         (Телеграм, превью) — по-прежнему через CORP cross-origin. */
      'Cross-Origin-Resource-Policy': 'cross-origin',
    });
    /* Видео-баннер Safari (и Телеграм на iPhone) без ответа по кускам
       (206) не проигрывает вовсе. */
    const rg = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
    if (rg && (rg[1] !== '' || rg[2] !== '')) {
      const len = buf.length;
      let s, e;
      if (rg[1] === '') { s = Math.max(0, len - Number(rg[2])); e = len - 1; }
      else { s = Number(rg[1]); e = rg[2] === '' ? len - 1 : Math.min(Number(rg[2]), len - 1); }
      if (!(s >= 0 && s <= e && s < len)) {
        res.writeHead(416, Object.assign(head, { 'Content-Range': 'bytes */' + len }));
        return res.end();
      }
      res.writeHead(206, Object.assign(head, { 'Content-Range': 'bytes ' + s + '-' + e + '/' + len, 'Content-Length': e - s + 1 }));
      if (req.method === 'HEAD') return res.end();
      return res.end(buf.subarray(s, e + 1));
    }
    res.writeHead(200, Object.assign(head, { 'Content-Length': buf.length }));
    if (req.method === 'HEAD') return res.end();
    return res.end(buf);
  }
  /* Сам сайт. Раздаём его отсюда же, из папки над сервером: тогда всё
     хозяйство — сайт, касса и бот — живёт по одному адресу, и боту
     некуда ссылаться, кроме как на нас. Отдельный хостинг для статики
     не нужен. */
  if (req.method === 'GET' || req.method === 'HEAD') {
    /* Без косой черты в конце браузер считает «sauce» файлом, и все
       относительные пути страницы (css/style.css) уезжают в корень. */
    if (url.pathname === '/sauce') {
      res.writeHead(301, { Location: '/sauce/' });
      return res.end();
    }
    const hit = staticFile(url.pathname);
    if (hit) return sendFile(req, res, hit.file, hit.type);
  }
  const handler = routes[req.method + ' ' + url.pathname];
  if (!handler) return send(res, 404, { error: 'Нет такого пути' });
  /* Отпор перебору ключа владельца отвечал «Нужен X-Admin-Key» — и человек
     с ВЕРНЫМ ключом видел, будто ключ не тот, вместо «подождите».
     Только когда ключ ДЕЙСТВИТЕЛЬНО прислан: запрос вообще без ключа —
     это не перебор, ему по-прежнему отвечаем «нужен ключ». */
  if (url.pathname.startsWith('/api/admin/') && req.headers['x-admin-key']
      && !auth(req) && adminBlocked(req)) {
    return send(res, 429, { error: 'Слишком много попыток с ключом — подождите десять минут' });
  }
  try {
    /* Фото паспорта и селфи в /api/kyc/submit в общий лимит 64 КБ не влезают.
       Но большой буфер — только для вошедших: токен проверяем ДО чтения
       тела, чтобы аноним не заставлял сервер глотать по полтора мегабайта. */
    const isBig = req.method === 'POST'
      && (url.pathname === '/api/kyc/submit' || url.pathname === '/api/cards' || url.pathname === '/api/sync/put'
          || url.pathname === '/api/media');
    if (isBig && !auth(req)) return send(res, 401, { error: 'Нужен вход' });
    /* /api/media: лимит частоты — до того, как тело до 8,6 МБ ляжет в память */
    if (req.method === 'POST' && url.pathname === '/api/media' && !rateLimit(req, 'media', 30, 60000)) {
      return send(res, tooOften.status, tooOften.body);
    }
    /* /api/media: анимированный баннер до 6 МБ — в base64 это ~8 МБ */
    const maxBody = isBig ? (url.pathname === '/api/media' ? 8600 * 1024 : 1500 * 1024) : undefined;
    const body = req.method === 'POST' ? await readBody(req, maxBody) : {};
    const out = await handler(req, body, url);
    send(res, out.status, out.body, out.headers);
  } catch (e) {
    if (e && e.httpStatus) return send(res, e.httpStatus, { error: e.message });
    console.error('[http]', e);
    tgAlert('http:' + url.pathname + ':' + String((e && e.message) || e).slice(0, 120),
      '💥 Сервер споткнулся\n\nЗапрос: ' + req.method + ' ' + url.pathname
      + '\n' + String((e && (e.stack || e.message)) || e).slice(0, 700));
    send(res, 500, { error: 'Внутренняя ошибка' });
  }
};

const server = http.createServer(handler);

/* ── На каком порту слушать ─────────────────────────────────────────
   Слушаем 0.0.0.0, а не «как получится»: без явного адреса Node берёт
   :: , и в контейнере, где IPv6 не проброшен, обратный прокси стучится
   на 127.0.0.1 и получает отказ.

   И слушаем НЕСКОЛЬКО портов, а не один. Причина неприятная: хостинг
   не всегда говорит, куда на самом деле идёт его прокси. На Bothost
   системная переменная PORT=8090 перебивает пользовательскую, сервер
   честно занимает 8090 — а прокси идёт на 3000, и снаружи 502 при
   совершенно здоровом процессе, без единой строки в логах.

   Лишний слушатель внутри контейнера ничего не стоит и никому не виден
   снаружи, поэтому дешевле занять оба, чем гадать. Если порт занят —
   молча пропускаем, это не беда. */
const PORTS = [...new Set([PORT, 3000, 8090].map(Number).filter((p) => p > 0))];
let listening = 0;

function listenOn(port, first) {
  const srv = first ? server : http.createServer(handler);
  srv.on('error', (e) => {
    /* EADDRINUSE на запасном порту — норма: значит его занял кто-то
       ещё. Ронять из-за этого весь сервер нельзя. */
    if (e && e.code === 'EADDRINUSE') {
      console.warn('[BloggerPay] порт ' + port + ' занят — пропускаем');
      return;
    }
    console.error('[BloggerPay] порт ' + port + ': ' + ((e && e.message) || e));
  });
  srv.listen(port, '0.0.0.0', () => {
    listening += 1;
    console.log('[BloggerPay] слушаю 0.0.0.0:' + port);
    if (first) boot();
  });
}

/* Отпечаток выложенной версии: короткий хеш файла сайта. */
function siteFingerprint() {
  try {
    const file = path.join(SITE_DIR, 'bloggerpay-1008-v100.html');
    return crypto.createHash('md5').update(fs.readFileSync(file)).digest('hex').slice(0, 8);
  } catch (e) { return ''; }
}
function announceUpdate() {
  const fp = siteFingerprint();
  if (!fp) return;
  const mark = path.join(path.dirname(DB_PATH), 'last-version.txt');
  let was = '';
  try { was = fs.readFileSync(mark, 'utf8').trim(); } catch (e) { /* первого запуска нет */ }
  if (was === fp) return;                       /* тот же файл — просто перезапуск */
  try { fs.writeFileSync(mark, fp); } catch (e) { /* не смогли запомнить — не беда */ }
  if (!was) return;                             /* самый первый запуск: обновлением не считаем */
  const when = new Date().toLocaleString('ru', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  tgSendRaw('🔄 Бот обновлён\n\n' + APP_BASE + '\n\nВерсия ' + fp + ' · ' + when
    + '\nОткройте ссылку заново — старая страница осталась на прежней версии.')
    .catch(() => {});
}
setTimeout(announceUpdate, 2500).unref();

PORTS.slice(1).forEach((p) => listenOn(p, false));
listenOn(PORTS[0], true);

function boot() {
  console.log('[BloggerPay] касса поднята, портов занято: ' + PORTS.length
    + '  база: ' + DB_PATH);
  console.log(ALERTS_ON
    ? '[BloggerPay] тревога: ошибки уходят в Телеграм, чат ' + ADMIN_CHAT_ID
    : '[BloggerPay] тревога в Телеграм выключена (нужны BOT_TOKEN и ADMIN_CHAT_ID в .env)');
  /* Тестовые деньги на боевом адресе (аудит 16.10.2026): громко при каждом
     запуске, пока это не исправлено в переменных хостинга. */
  try {
    if (TEST_MONEY_PUBLIC) {
      tgAlert('topup:open', '🚨 Тестовое пополнение открыто всем\n\n' + PUBLIC_URL
        + ' виден из интернета, и любой вошедший пополняет баланс без оплаты — деньги'
        + ' на балансах ненастоящие, поэтому вывод закрыт.\n\nПеред запуском: в переменных'
        + ' хостинга убрать TEST_TOPUP_OPEN и поставить TEST_TOPUP=0.', 'server', true);
    } else if (SERVER_IS_PUBLIC) {
      const tst = q.testTopped.get(TEST_TOPUP_REF, TEST_TOPUP_REF, TEST_TOPUP_FEE_REF);
      if (tst.amount > 0) {
        console.error('[BloggerPay] ВНИМАНИЕ: в базе тестовые зачисления — ' + tst.amount + ' ₽ у '
          + tst.people + ' чел. Эти деньги ненастоящие; их заявки на вывод помечены в /admin.');
        tgAlert('topup:left', '⚠️ В базе остались тестовые деньги\n\n' + tst.amount + ' ₽ у ' + tst.people
          + ' чел. зачислены тестовым пополнением, без оплаты. Заявки на вывод от этих людей'
          + ' помечены в /admin → «Выплаты» — проверяйте, прежде чем платить.', 'server');
      }
    }
  } catch (e) { console.error('[тестовые деньги]', (e && e.message) || e); }
  /* Почта — единственный путь восстановить пароль. Молча неработающей
     она быть не должна: без ключа человек жмёт «Забыли пароль?», видит
     экран ввода кода и ждёт письмо, которого никто не отправлял. */
  if (!process.env.RESEND_API_KEY) {
    console.error('[BloggerPay] ВНИМАНИЕ: RESEND_API_KEY в .env пуст —'
      + ' письма с кодом никуда не уходят.');
  } else {
    console.log('[BloggerPay] почта: письма с кодом уходят через Resend, отправитель '
      + (process.env.MAIL_FROM || 'BloggerPay <onboarding@resend.dev>'));
  }
  /* Предупреждение про MAIL_DEBUG — ОТДЕЛЬНО от проверки ключа: условия
     независимы, и вложенным оно молчало ровно там, где опаснее всего.
     Без ключа, но с MAIL_DEBUG=1 сервер раздаёт код прямо в ответе
     любому, кто знает чей-нибудь адрес: этого достаточно, чтобы сменить
     чужой пароль одним запросом. */
  /* Файлы, которые площадки читают по прямой ссылке. Пропажа любого из
     них ломает уже выданное подтверждение — поэтому проверяем всегда. */
  try {
    const need = [
      ['/terms.html', 'условия использования'],
      ['/privacy.html', 'политика конфиденциальности'],
    ];
    const missing = [];
    for (const [route, what] of need) {
      const hit = staticFile(route);
      if (!hit || !fs.existsSync(hit.file)) missing.push(what + ' (' + route + ')');
    }
    /* Файл-подпись площадки: имя выдаёт сама площадка, поэтому ищем любой. */
    const signs = fs.readdirSync(SITE_DIR).filter((n) => /^tiktok[A-Za-z0-9]{8,64}\.txt$/.test(n));
    if (!signs.length) missing.push('файл-подпись TikTok (tiktok<буквы-цифры>.txt в корне проекта)');
    if (missing.length) {
      console.error('[BloggerPay] ПРОПАЛИ ПУБЛИЧНЫЕ ФАЙЛЫ: ' + missing.join(', ')
        + '. Площадки читают их по прямой ссылке — без них подтверждение сайта'
        + ' и проверка приложения отваливаются.');
      tgAlert('files:missing:' + missing.length,
        '⚠️ На сервере нет файлов, которые читают площадки:\n\n' + missing.join('\n')
        + '\n\nБез них TikTok отзовёт подтверждение сайта.', 'server');
    } else {
      console.log('[BloggerPay] публичные файлы на месте: условия, политика, подпись ' + signs.join(', '));
    }
  } catch (e) { /* проверка не обязана удаться */ }

  /* Площадки: ключи и связь. Обмен кода на данные аккаунта делает сам
     сервер, поэтому его доступ к площадке важнее, чем доступ телефона.
     Проверяем тем же кодом, что и кнопка в пульте, и пишем в журнал —
     чтобы причина «вход не работает» была видна без всяких ключей. */
  setTimeout(() => {
    for (const name of Object.keys(OAUTH)) {
      platformProbe(name).then((r) => {
        if (!r) return;
        if (!r.keys) { console.log('[BloggerPay] ' + r.label + ': ключи не заданы, вход через площадку выключен'); return; }
        const bad = !r.apiReachable;
        const rows = [
          '[BloggerPay] ' + r.label + ': ключи заданы, права ' + r.scope,
          '           ' + r.apiHost + ' с сервера: ' + (r.apiReachable ? 'открывается' : 'НЕ ОТКРЫВАЕТСЯ')
            + (r.apiWhy ? ' (' + r.apiWhy + ')' : ''),
          '           ' + r.authHost + ' с сервера: ' + (r.authReachable ? 'открывается' : 'не открывается'),
          '           адрес возврата: ' + r.redirect,
          '           ' + r.verdict,
        ];
        console[bad ? 'error' : 'log'](rows.join('\n'));
      }).catch(() => {});
    }
  }, 1500).unref();

  if (MAIL_DEBUG) {
    console.error('[BloggerPay] ВНИМАНИЕ: MAIL_DEBUG=1 — код восстановления'
      + ' возвращается прямо в ответе сервера. Любой, кто знает адрес'
      + ' зарегистрированного человека, сменит ему пароль. Только для тестов,'
      + ' на бою обязательно выключите.');
  }
  /* Адрес приложения без https:// превращает кнопку в письме в'
     относительную ссылку: почта раскроет её от своего домена и человек
     упрётся в 404. Сервер об этом никогда не узнает — ошибка целиком на
     стороне получателя, поэтому предупреждаем при запуске. */
  /* Про письмо-ссылку говорим прямо: молчаливое переключение назад,
     на код внутри письма, выглядело бы как «настройка не applied». */
  console.log(PW_LINK_ON
    ? '[BloggerPay] письмо с кодом: без кода, кнопка «Открыть» ведёт на ' + PUBLIC_URL + '/r/…'
    : '[BloggerPay] письмо с кодом: код печатается внутри письма'
      + (String(ENV.MAIL_LINK == null ? '1' : ENV.MAIL_LINK) !== '0'
        ? ' (режим ссылки выключен: PUBLIC_URL=' + PUBLIC_URL + ' не виден из интернета —'
          + ' пропишите адрес сервера, например https://kassa.вашдомен.ru)'
        : ''));
  /* ── Бот поднимается здесь же ──────────────────────────────────────
     Один процесс на всё: сайт, касса и бот. Так у бота есть адрес, на
     который вести человека, — наш собственный, и отдельный хостинг для
     сайта не нужен. Бот не роняет сервер: не заладилось с токеном —
     сайт продолжает работать, в консоли причина. */
  try {
    const botMod = require('./bot');
    BOT = botMod;
    if (typeof botMod.setHooks === 'function') botMod.setHooks(invoiceHooks(botMod));
    /* Телеграм отверг токен посреди работы (отозван в @BotFather) — бот
       стоит, сайт работает. Тревога в Телеграм тем же токеном не дойдёт,
       поэтому — запись в «Поломки» /admin. */
    if (typeof botMod.setHooks === 'function') botMod.setHooks({ onStop: () => {
      try {
        q.insError.run(null, '[сервер] Бот остановлен: Телеграм не принял BOT_TOKEN (401 — токен отозван или сменён).'
          + ' Сайт и касса работают. Впишите новый токен и перезапустите сервер.', 'server:bot', null, null);
      } catch (e) { console.error('[бот] не записал остановку: ' + ((e && e.message) || e)); }
    } });
    botMod.boot().then((ok) => {
      if (ok) console.log('[BloggerPay] бот запущен, кнопка ведёт на ' + PUBLIC_URL);
    }).catch((e) => console.error('[бот] ' + ((e && e.message) || e)));
  } catch (e) {
    console.error('[бот] не подключился: ' + ((e && e.message) || e));
  }

  const appUrlRaw = String(process.env.APP_URL || '').trim();
  if (appUrlRaw && !/^https?:\/\//i.test(appUrlRaw)) {
    console.error('[BloggerPay] ВНИМАНИЕ: APP_URL="' + appUrlRaw + '" без https:// —'
      + ' кнопка «Вернуться на сайт» и логотип в письме работать не будут.'
      + ' Напишите полный адрес, например https://' + appUrlRaw);
  }
}

/* ── Падения процесса ────────────────────────────────────────────────
   Самая скрытая ошибка из всех — когда касса умерла, а сайт-статика
   жива: всё выглядит работающим, только деньги не ходят. Перед смертью
   успеваем крикнуть в Телеграм и падаем честно, чтобы менеджер
   процессов (pm2, systemd) перезапустил. */
function dieLoud(tag, e) {
  console.error('[' + tag + ']', e);
  const bye = () => process.exit(1);
  if (!ALERTS_ON) return bye();
  const t = setTimeout(bye, 5000);
  tgSendRaw('💀 СЕРВЕР УПАЛ (' + tag + ') и будет перезапущен\n\n'
    + String((e && (e.stack || e.message)) || e).slice(0, 700))
    .finally(() => { clearTimeout(t); bye(); });
}
/* Node без обработчика сам роняет процесс и на исключении, и на
   оборванном обещании. Сохраняем это честное поведение — денежному
   серверу нельзя жить в неопределённом состоянии — но перед смертью
   успеваем отправить тревогу. */
/* Раз в час подрезаем журнал ошибок — вместо прежней подрезки на каждом
   обращении к /api/errors (синхронный SQLite вставал поперёк всего). */
setInterval(() => {
  try {
    const n = db.prepare('SELECT COUNT(*) AS n FROM errors').get().n;
    if (n > 25000) q.trimErrors.run();
    try { q.trimAdminLog.run(); } catch (e) { /* журнал владельца не критичен */ }
  } catch (e) { /* уборка не обязана удаться */ }
}, 3600000).unref();

process.on('unhandledRejection', (e) => dieLoud('обещание без catch', e));
process.on('uncaughtException', (e) => dieLoud('исключение', e));

/* ── Сторож денег ────────────────────────────────────────────────────
   Та же сверка, что в пульте оператора, но сама, раз в 10 минут:
   всё внесённое либо лежит в системе, либо выплачено наружу. Если
   равенство разошлось — это тихая ошибка страшнее любого исключения,
   и о ней надо узнать раньше, чем позвонит пользователь. */
function moneyWatch() {
  try {
    const t = q.totals.get();
    const gap = (t.available + t.hold) - (q.toppedUp.get().s - q.paidOut.get().s);
    if (gap !== 0) {
      tgAlert('money:' + gap,
        '🚨 ДЕНЬГИ НЕ СХОДЯТСЯ\n\nРасхождение сверки: ' + gap + ' ₽.'
        + '\nОткройте пульт оператора и приостановите выплаты, пока не найдена причина.',
        'server', true);
    }
  } catch (e) { console.error('[сторож денег]', (e && e.message) || e); }
}
if (ALERTS_ON) {
  setTimeout(moneyWatch, 15000).unref();
  setInterval(moneyWatch, 10 * 60 * 1000).unref();
}
