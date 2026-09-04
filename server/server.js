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
const TEST_TOPUP_OPEN = String(ENV.TEST_TOPUP_OPEN || '') === '1' || !SERVER_IS_PUBLIC;
if (TEST_TOPUP && !TEST_TOPUP_OPEN) {
  console.error('[BloggerPay] Тестовое пополнение оставлено только владельцу:'
    + ' сервер виден снаружи (' + PUBLIC_URL + '). Остальным пополнение отвечает,'
    + ' что оплата идёт через кассу. Открыть всем — TEST_TOPUP_OPEN=1.');
}

/* Кавычки и пробелы вокруг значения — самая частая причина «неизвестный
   client_key»: площадка получает ключ вместе с ними и не узнаёт его. */
const cleanKey = (v) => String(v == null ? '' : v).trim().replace(/^["']+|["']+$/g, '').trim();
/* Свои адреса площадки: сюда вписывают прокси, если напрямую не пускают. */
const TT_AUTH_BASE = (cleanKey(ENV.TT_AUTH_BASE) || 'https://www.tiktok.com').replace(/\/+$/, '');
const TT_API_BASE = (cleanKey(ENV.TT_API_BASE) || 'https://open.tiktokapis.com').replace(/\/+$/, '');
/* Куда возвращать человека после площадки: обычно это сам сайт, который
   раздаёт этот же сервер. APP_URL нужен, только если сайт живёт отдельно. */
const APP_BASE = (String(ENV.APP_URL || '').trim().replace(/\/+$/, '') || PUBLIC_URL) + '/';

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
    scope: cleanKey(ENV.TT_SCOPE) || 'user.info.basic,user.info.profile,user.info.stats',
    label: 'TikTok',
  },
};
const FEE_PCT = 4;                       /* комиссия сервиса при выводе */
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
  UNIQUE(platform, external_id)
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

/* Телеграм-id: по нему узнаём человека, вошедшего из мини-аппа. */
/* Селфи с паспортом (02.09.2026): второй снимок в заявке на проверку
   личности. Базы, созданные раньше, получают колонку здесь. */
try { db.exec('ALTER TABLE kyc_requests ADD COLUMN selfie TEXT'); } catch (e) { /* уже есть */ }
try { db.exec('ALTER TABLE users ADD COLUMN tg_id TEXT'); }
catch (e) { /* уже есть */ }
try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_tg ON users(tg_id) WHERE tg_id IS NOT NULL'); }
catch (e) { /* индекс мог не создаться на старом движке — не критично */ }

/* ── Мелкая утварь ─────────────────────────────────────────────────── */

const q = {
  userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
  userById: db.prepare('SELECT * FROM users WHERE id = ?'),
  userByTg: db.prepare('SELECT * FROM users WHERE tg_id = ?'),
  insTgUser: db.prepare(`INSERT INTO users (email, name, role, pass_salt, pass_hash, tg_id)
    VALUES (?,?,?,?,?,?)`),
  linkTg: db.prepare('UPDATE users SET tg_id = ? WHERE id = ?'),
  insUser: db.prepare('INSERT INTO users (email, name, role, pass_salt, pass_hash) VALUES (?,?,?,?,?)'),
  insSession: db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?,?)'),
  session: db.prepare(`SELECT s.token, s.expires_at, u.* FROM sessions s
                       JOIN users u ON u.id = s.user_id WHERE s.token = ?`),
  delSession: db.prepare('DELETE FROM sessions WHERE token = ?'),
  delUserSessions: db.prepare('DELETE FROM sessions WHERE user_id = ?'),
  updPass: db.prepare('UPDATE users SET pass_salt = ?, pass_hash = ? WHERE id = ?'),
  setAdmin: db.prepare('UPDATE users SET is_admin = ? WHERE id = ?'),
  opByKey: db.prepare('SELECT * FROM ops WHERE op_key = ?'),
  insOp: db.prepare('INSERT INTO ops (op_key, user_id, kind, result) VALUES (?,?,?,?)'),
  updOpResult: db.prepare('UPDATE ops SET result = ? WHERE op_key = ?'),
  insLedger: db.prepare('INSERT INTO ledger (op_key, user_id, bucket, amount, kind, ref) VALUES (?,?,?,?,?,?)'),
  balance: db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN bucket='available' THEN amount END), 0) AS available,
      COALESCE(SUM(CASE WHEN bucket='hold' THEN amount END), 0) AS hold
    FROM ledger WHERE user_id = ?`),
  myLedger: db.prepare(`SELECT id, bucket, amount, kind, ref, created_at
    FROM ledger WHERE user_id = ? ORDER BY id DESC LIMIT 100`),
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
  syncPull: db.prepare(`SELECT ver, kind, rid, a_id, b_id, from_id, data, created_at, updated_at
    FROM sync WHERE ver > ? AND (a_id = ? OR b_id = ? OR (b_id IS NULL AND kind = 'camp'))
    ORDER BY ver ASC LIMIT ?`),
  syncMax: db.prepare('SELECT COALESCE(MAX(ver), 0) AS v FROM sync'),
  cardGet: db.prepare('SELECT * FROM cards WHERE id = ?'),
  cardsMine: db.prepare('SELECT id FROM cards WHERE user_id = ?'),
  cardIns: db.prepare('INSERT INTO cards (id, user_id, data) VALUES (?,?,?)'),
  cardUpd: db.prepare("UPDATE cards SET data = ?, updated_at = datetime('now') WHERE id = ?"),
  cardDel: db.prepare('DELETE FROM cards WHERE id = ? AND user_id = ?'),
  cardHide: db.prepare("UPDATE cards SET hidden = ?, updated_at = datetime('now') WHERE id = ?"),
  cardsPublic: db.prepare(`SELECT c.id, c.user_id, c.data, c.updated_at
    FROM cards c JOIN users u ON u.id = c.user_id
    WHERE c.hidden = 0 AND u.is_blocked = 0
    ORDER BY c.updated_at DESC LIMIT ?`),
  cardsAll: db.prepare(`SELECT c.id, c.user_id, c.hidden, c.updated_at, u.name AS owner
    FROM cards c JOIN users u ON u.id = c.user_id ORDER BY c.updated_at DESC LIMIT 300`),
  insDeal: db.prepare('INSERT INTO deals (id, payer_id, payee_id, amount, status) VALUES (?,?,?,?,?)'),
  deal: db.prepare('SELECT * FROM deals WHERE id = ?'),
  updDeal: db.prepare(`UPDATE deals SET status = ?, payee_id = ?, updated_at = datetime('now') WHERE id = ?`),
  payDeal: db.prepare(`UPDATE deals SET paid = paid + ?, status = ?, updated_at = datetime('now') WHERE id = ?`),
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
  platformIncome: db.prepare(`SELECT COALESCE(SUM(amount),0) AS fees
    FROM ledger WHERE user_id = 0 AND kind = 'fee'`),
  paidOut: db.prepare(`SELECT COALESCE(SUM(net),0) AS s FROM withdrawals WHERE status = 'paid'`),
  toppedUp: db.prepare(`SELECT COALESCE(SUM(amount),0) AS s FROM ledger WHERE kind = 'topup'`),
  openDeals: db.prepare(`SELECT d.id, d.amount, d.paid, d.payer_id, d.payee_id, d.created_at,
      u.name AS payer_name
    FROM deals d JOIN users u ON u.id = d.payer_id
    WHERE d.status = 'held' ORDER BY d.created_at DESC LIMIT 100`),
  userLedger: db.prepare(`SELECT id, bucket, amount, kind, ref, created_at
    FROM ledger WHERE user_id = ? ORDER BY id DESC LIMIT 60`),
  insError: db.prepare('INSERT INTO errors (user_id, message, where_at, version, ua) VALUES (?,?,?,?,?)'),
  myChannels: db.prepare(`SELECT platform, external_id, title, url, subs, checked_at
    FROM channels WHERE user_id = ? ORDER BY checked_at DESC`),
  channelByExt: db.prepare('SELECT * FROM channels WHERE platform = ? AND external_id = ?'),
  delChannel: db.prepare('DELETE FROM channels WHERE platform = ? AND external_id = ?'),
  upsertChannel: db.prepare(`INSERT INTO channels (user_id, platform, external_id, title, url, subs)
    VALUES (?,?,?,?,?,?)
    ON CONFLICT(platform, external_id) DO UPDATE SET
      user_id = excluded.user_id, title = excluded.title, url = excluded.url,
      subs = excluded.subs, checked_at = datetime('now')`),
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
     платили. Спор постороннего «по себе» возврату не помеха. */
  refundBlocked: db.prepare(`SELECT 1 AS x FROM disputes d
    WHERE d.deal_id = ? AND d.status = 'open' AND (
      d.payee_id IS NULL
      OR d.payee_id = ?
      OR EXISTS (SELECT 1 FROM ledger l WHERE l.ref = ? AND l.user_id = d.payee_id
                 AND l.kind IN ('payout','settle-payout'))
    ) LIMIT 1`),
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
  /* выплаты по кампаниям, чтобы рекламодатель видел расход на любом устройстве */
  myReleases: db.prepare(`SELECT op_key, result, created_at FROM ops
    WHERE user_id = ? AND kind = 'release' ORDER BY created_at DESC LIMIT 500`),
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
  const amount = Math.round(Number(p.amount && p.amount.value) || 0);
  if (!uid || !q.userById.get(uid) || amount <= 0) return { ok: false, status: 'bad-payment' };
  const r = moneyOp('yk:' + p.id, uid, 'topup', (add) => {
    add(uid, 'available', amount, 'topup', 'пополнение ЮKassa ' + p.id);
    return { ok: true, credited: amount };
  });
  if (r.status === 200) {
    try { q.updPay.run('succeeded', p.id); } catch (e) { /* строки могло не быть */ }
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
const RESERVED_OP = /^\s*(sys:|bp-op-)/i;
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
        /* «null» и «строка» — валидный JSON, но маршруты ждут объект:
           без этого body.что-нибудь бросает TypeError и плодит ложные 500. */
        resolve(parsed !== null && typeof parsed === 'object' ? parsed : {});
      }
      catch (e) { reject(httpError(400, 'Тело запроса — не JSON')); }
    });
    req.on('error', reject);
  });
}

function auth(req) {
  const h = String(req.headers.authorization || '');
  const m = /^Bearer\s+([a-f0-9]{64})$/i.exec(h);
  if (!m) return null;
  const row = q.session.get(m[1]);
  if (!row) return null;
  if (row.expires_at < new Date().toISOString()) { q.delSession.run(row.token); return null; }
  if (row.is_blocked) return null;
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
function adminSign(exp) {
  return crypto.createHmac('sha256', ADMIN_KEY || 'нет-ключа').update('adm:' + exp).digest('hex').slice(0, 32);
}
function cookieOf(req, name) {
  const raw = String(req.headers.cookie || '');
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return '';
}
function adminCookie(req, exp) {
  const https = /^https:/i.test(String(ENV.PUBLIC_URL || ''))
    || String(req.headers['x-forwarded-proto'] || '') === 'https';
  return 'bp_admin=' + encodeURIComponent(exp + '.' + adminSign(exp))
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
function adminCookieOk(req) {
  if (!ADMIN_KEY) return false;
  const raw = cookieOf(req, 'bp_admin');
  const i = raw.indexOf('.');
  if (i < 0) return false;
  const exp = Number(raw.slice(0, i));
  if (!Number.isFinite(exp) || exp <= Date.now()) return false;
  const a = Buffer.from(raw.slice(i + 1), 'utf8'), b = Buffer.from(adminSign(exp), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
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
   при входе и регистрации — вводить ключ никому не нужно.
   ADMIN_EMAIL=почта или почта1,почта2 */
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
  }
  return String((req.socket && req.socket.remoteAddress) || '');
}
function rateLimit(req, key, limit, windowMs) {
  if (RL_OFF) return true;
  const ip = clientIp(req);
  /* Петля не ограничивается только без прокси — это разработка и тесты,
     где 127.0.0.1 действительно свой. За прокси (TRUST_PROXY=1) петля
     означает сам прокси, и поблажка выключила бы защиту для всех. */
  if (!TRUST_PROXY && (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1')) return true;
  const k = key + '|' + ip;
  const now = Date.now();
  let arr = rlMap.get(k);
  if (!arr) { arr = []; rlMap.set(k, arr); }
  while (arr.length && now - arr[0] > windowMs) arr.shift();
  if (arr.length >= limit) return false;
  arr.push(now);
  return true;
}
const tooOften = { status: 429, body: { error: 'Слишком часто — подождите минуту и попробуйте снова' } };
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
function cardStr(v, max) { return String(v == null ? '' : v).slice(0, max); }
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

/* Рейтинг пересчитывается не чаще раза в минуту: запрос групповой, а ручка открытая. */
const lbCache = { at: 0, rows: null, total: 0 };

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
const TG_CAP = { client: 15, server: 10 };   /* тревог в час на каждый кошелёк */
const TG_REPEAT_MS = 10 * 60 * 1000;
const tgLane = {
  client: { sent: 0, muted: false },
  server: { sent: 0, muted: false },
};
let tgHourAt = 0;

function tgSendRaw(text) {
  return fetch(TG_API_BASE + '/bot' + BOT_TOKEN + '/sendMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: ADMIN_CHAT_ID,
      text: String(text).slice(0, 3800),
      disable_web_page_preview: true,
    }),
    signal: AbortSignal.timeout(8000),
  }).then(async (r) => {
    if (!r.ok) console.error('[тревога] Телеграм ответил ' + r.status + ': ' + (await r.text()).slice(0, 200));
  }).catch((e) => console.error('[тревога] не отправилось: ' + ((e && e.message) || e)));
}

function tgAlert(sig, text, lane, critical) {
  if (!ALERTS_ON) return;
  const now = Date.now();
  if (now - tgHourAt > 3600000) {
    tgHourAt = now;
    tgLane.client.sent = 0; tgLane.client.muted = false;
    tgLane.server.sent = 0; tgLane.server.muted = false;
  }
  const key = lane === 'client' ? 'client' : 'server';
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
      tgSendRaw('⚠️ Тревог ' + (key === 'client' ? 'с сайта' : 'серверных')
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
    while (arr.length && now - arr[0] > 300000) arr.shift();
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
     · пятьдесят неверных попыток в сутки на адрес — дальше час паузы
       и тревога владельцу. Это тот самый случай, когда счётчик суточный:
       он ловит долгий тихий перебор, который часовые потолки пропускают.

   Ни один обруч не запирает человека навсегда: худшее, что может сделать
   чужой, — заставить подождать час. */
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
  if (!rec || !rec.hash || now > rec.expires) return { ok: false, reason: 'expired' };
  if (rec.attempts >= PW_MAX_ATTEMPTS) return { ok: false, reason: 'locked' };
  const good = crypto.timingSafeEqual(
    Buffer.from(rec.hash, 'hex'), Buffer.from(pwHash(email, code), 'hex'));
  if (!good) {
    rec.attempts += 1;
    pwRec(email);                      /* прокрутит суточное окно, если пора */
    rec.dayFails = (rec.dayFails || 0) + 1;
    if (rec.dayFails === PW_MAX_FAILS_DAY) {
      rec.pauseUntil = now + PW_ABUSE_PAUSE_MS;
      tgAlert('pwbrute:' + email,
        '🔐 Похоже на перебор кода восстановления\n\nАдрес: ' + email
        + '\nНеверных попыток за сутки: ' + rec.dayFails
        + '\nНовые коды на этот адрес — через час.', 'server');
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
      redirect: PUBLIC_URL + '/api/verify/callback/' + p,
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
  'POST /api/sync/put': async (req, body) => {
    const u = auth(req);
    if (!u) return { status: 401, body: { error: 'Нужен вход' } };
    if (!rateLimit(req, 'sync:put:' + u.id, 240, 60000)) return tooOften;
    const kind = String(body.kind || '');
    const rid = String(body.rid || '');
    if (!/^[a-z]{2,16}$/.test(kind)) return { status: 400, body: { error: 'Неверный вид записи' } };
    if (!/^[\w.:+-]{3,80}$/.test(rid)) return { status: 400, body: { error: 'Неверный номер записи' } };
    if (body.data == null || typeof body.data !== 'object') return { status: 400, body: { error: 'Нет содержимого' } };
    const data = JSON.stringify(body.data);
    if (data.length > 400 * 1024) return { status: 413, body: { error: 'Запись слишком большая' } };
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
    return { status: 200, body: { ok: true, ver, a, b } };
  },

  /* since — последний виденный номер; отдаём до 200 конвертов новее.
     Если их больше, more:true — клиент придёт ещё раз. */
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
    if (ex) q.cardUpd.run(data, id);
    else {
      if (q.cardsMine.all(u.id).length >= 3) return { status: 409, body: { error: 'Больше трёх карточек на аккаунт нельзя' } };
      q.cardIns.run(id, u.id, data);
    }
    cardsCache.at = 0;
    return { status: 200, body: { ok: true, id } };
  },

  'POST /api/cards/delete': async (req, body) => {
    const u = auth(req);
    if (!u) return { status: 401, body: { error: 'Нужен вход' } };
    const id = cardStr(body.id, 64);
    const r = q.cardDel.run(id, u.id);
    cardsCache.at = 0;
    return { status: 200, body: { ok: true, removed: Number(r.changes) || 0 } };
  },

  /* Рубильник владельца: скрытая карточка исчезает из каталога у всех,
     но остаётся у автора — это не удаление работы, а снятие с витрины. */
  'POST /api/admin/cards/hide': async (req, body) => {
    if (!isAdmin(req)) return { status: 403, body: { error: 'Только владелец площадки' } };
    const id = cardStr(body.id, 64);
    if (!q.cardGet.get(id)) return { status: 404, body: { error: 'Карточка не найдена' } };
    q.cardHide.run(body.hidden === false ? 0 : 1, id);
    cardsCache.at = 0;
    return { status: 200, body: { ok: true, id, hidden: body.hidden !== false } };
  },

  'GET /api/admin/cards': async (req) => {
    if (!isAdmin(req)) return { status: 403, body: { error: 'Только владелец площадки' } };
    return { status: 200, body: { rows: q.cardsAll.all() } };
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
      lbCache.rows = q.lbTop.all(10).map((r) => ({ id: r.id, name: r.name, deals: Number(r.deals) || 0 }));
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
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { status: 400, body: { error: 'Некорректный email' } };
    /* Служебный домен входа по Телеграму. Живых ящиков там нет, а занятый
       заранее адрес позволял перехватить чужой аккаунт при первом входе
       из мини-аппа. Регистрация на него закрыта. */
    if (/@telegram\.local$/i.test(email)) {
      return { status: 400, body: { error: 'Этот адрес занят служебным входом по Телеграму' } };
    }
    if (!name) return { status: 400, body: { error: 'Введите имя' } };
    if (pass.length < 8) return { status: 400, body: { error: 'Пароль — минимум 8 символов' } };
    if (q.userByEmail.get(email)) return { status: 409, body: { error: 'Этот email уже зарегистрирован' } };
    const salt = crypto.randomBytes(16).toString('hex');
    const info = q.insUser.run(email, name, role, salt, scrypt(pass, salt));
    const uid = Number(info.lastInsertRowid);
    const token = newToken();
    const exp = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
    q.insSession.run(token, uid, exp);
    const admin = ADMIN_EMAILS.includes(email) ? 1 : 0;
    if (admin) q.setAdmin.run(1, uid);
    return { status: 200, body: { token, user: { id: uid, email, name, role, isAdmin: !!admin } } };
  },

  'POST /api/login': async (req, body) => {
    if (!rateLimit(req, 'login', 20, 60000)) return tooOften;
    const email = String(body.email || '').trim().toLowerCase();
    const u = q.userByEmail.get(email);
    /* Одинаковый ответ для «нет такого» и «пароль не тот» — чтобы по
       ответам нельзя было перебирать, кто зарегистрирован. */
    const bad = { status: 401, body: { error: 'Неверный email или пароль' } };
    if (!u) { scrypt('заглушка-для-ровного-времени', 'соль'); return bad; }
    const hash = scrypt(String(body.password || ''), u.pass_salt);
    if (!crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(u.pass_hash))) return bad;
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
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { status: 400, body: { error: 'Некорректный email' } };

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
    return { status: 200, body: { ok: true, token, user: { id: u.id, email: u.email, name: u.name, role: u.role } } };
  },

  /* Вход из мини-аппа. Пароль не нужен: личность подтверждает Телеграм,
     а подпись проверяется выше. Если человек уже заходил по email —
     привязываем телеграм к тому же аккаунту, а не заводим второй. */
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
      /* Заводим аккаунт. Пароля у него нет: вход только через Телеграм,
         поэтому в поля хеша кладём случайный мусор, которым нельзя войти. */
      const name = [tg.first_name, tg.last_name].filter(Boolean).join(' ').trim()
        || tg.username || ('Пользователь ' + tgId);
      /* Адрес мог быть занят до того, как регистрацию на служебный домен
         закрыли. Тогда берём соседний свободный, а не отказываем входу. */
      let email = 'tg' + tgId + '@telegram.local';
      if (q.userByEmail.get(email)) email = 'tg' + tgId + '.' + crypto.randomBytes(3).toString('hex') + '@telegram.local';
      const salt = crypto.randomBytes(16).toString('hex');
      const dead = crypto.randomBytes(32).toString('hex');
      const role = body.role === 'advertiser' ? 'advertiser' : 'blogger';
      try {
        q.insTgUser.run(email, name.slice(0, 120), role, salt, dead, tgId);
      } catch (e) {
        return { status: 409, body: { error: 'Не удалось создать аккаунт по Телеграму' } };
      }
      u = q.userByTg.get(tgId);
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

  'GET /api/ledger': async (req) => {
    const u = auth(req);
    if (!u) return { status: 401, body: { error: 'Нужен вход' } };
    return { status: 200, body: { rows: q.myLedger.all(u.id) } };
  },

  /* ТЕСТОВОЕ пополнение. Живо только пока не настроена касса (и его
     можно выключить руками: TEST_TOPUP=0). На боевом сервере кнопки,
     рисующей деньги, быть не должно. */
  'POST /api/topup': async (req, body) => {
    const u = auth(req);
    if (!u) return { status: 401, body: { error: 'Нужен вход' } };
    if (!TEST_TOPUP) {
      return { status: 503, body: { error: 'Тестовое пополнение выключено — оплата идёт через кассу' } };
    }
    /* На публичном сервере деньги из воздуха доступны только владельцу. */
    if (!TEST_TOPUP_OPEN && !u.is_admin) {
      return { status: 403, body: { error: 'Пополнение пока недоступно — касса ещё не подключена' } };
    }
    const amount = body.amount;
    if (!amountOk(amount)) return { status: 400, body: { error: 'Сумма — целое число от 1 до 100 000 000' } };
    if (!userKey(body.opKey)) return badKey;
    return moneyOp(String(body.opKey || ''), u.id, 'topup', (add) => {
      add(u.id, 'available', amount, 'topup', 'тестовое пополнение');
      return { ok: true, balance: q.balance.get(u.id) };
    });
  },

  /* ── НАСТОЯЩИЕ ПЛАТЕЖИ (ЮKassa) ──────────────────────────────────
     Схема: создать платёж → человек платит на странице кассы → касса
     бьёт вебхуком ИЛИ приложение само спрашивает статус → зачисление
     через журнал. Обе дороги идемпотентны (op_key = yk:<id>). */

  'GET /api/pay/config': async (req) => {
    const u = auth(req);
    const test = TEST_TOPUP && (TEST_TOPUP_OPEN || !!(u && u.is_admin));
    return {
      status: 200,
      body: { mode: YK_ON ? 'yookassa' : (test ? 'test' : 'off'), min: 1000 },
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
    try {
      const p = await ykApi('POST', '/payments', {
        amount: { value: amount.toFixed(2), currency: 'RUB' },
        capture: true,
        confirmation: { type: 'redirect', return_url: PAY_RETURN_URL },
        description: 'Пополнение баланса BloggerPay, аккаунт ' + u.id,
        metadata: { userId: u.id },
      }, crypto.randomUUID());
      try { q.insPay.run(p.id, u.id, amount, p.status || 'pending'); } catch (e) { /* повтор — не критично */ }
      const url = p.confirmation && p.confirmation.confirmation_url;
      if (!url) return { status: 502, body: { error: 'Касса не вернула страницу оплаты' } };
      return { status: 200, body: { ok: true, paymentId: p.id, url } };
    } catch (e) {
      return { status: e.httpStatus || 502, body: { error: String(e.message || 'Касса недоступна') } };
    }
  },

  /* Статус платежа спрашивает сам плательщик. Если касса говорит
     «оплачен» — зачисляем прямо здесь: вебхук может быть ещё не
     настроен или потеряться, а деньги дойти обязаны. */
  'GET /api/pay/status': async (req, body, url) => {
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
        if (p.status === 'succeeded') creditYkPayment(p);
        else { try { q.updPay.run(p.status, id); } catch (e) {} }
      }
    } catch (e) { console.error('[pay/webhook]', e.message || e); }
    return { status: 200, body: { ok: true } };
  },

  /* Заморозка под сделку: деньги уходят из available в hold плательщика. */
  'POST /api/deals/hold': async (req, body) => {
    const u = auth(req);
    if (!u) return { status: 401, body: { error: 'Нужен вход' } };
    const amount = body.amount;
    const dealId = String(body.dealId || '').slice(0, 80);
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
    return moneyOp(String(body.opKey || ''), u.id, 'hold', (add) => {
      add(u.id, 'available', -amount, 'hold', dealId);
      add(u.id, 'hold', amount, 'hold', dealId);
      q.insDeal.run(dealId, u.id, payeeId, amount, 'held');
      return { ok: true, dealId, payeeId, balance: q.balance.get(u.id) };
    });
  },

  /* Выплата по сделке: hold плательщика → available исполнителя.
     Комиссия сделки 0% — вся сумма исполнителю (правило продукта). */
  'POST /api/deals/release': async (req, body) => {
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

    if (!userKey(body.opKey)) return badKey;
    return moneyOp(String(body.opKey || ''), u.id, 'release', (add) => {
      add(u.id, 'hold', -sum, 'release', dealId);
      add(payee.id, 'available', sum, 'payout', dealId);
      const done = (d.paid + sum) >= d.amount;
      q.payDeal.run(sum, done ? 'released' : 'held', dealId);
      if (done) q.updDeal.run('released', d.payee_id != null ? d.payee_id : payee.id, dealId);
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
    const holds = isPayer || (d.payee_id != null && d.payee_id === u.id) || !!q.paidTo.get(dealId, u.id);
    if (holds) {
      tgAlert('dispute:' + dealId + ':' + info.lastInsertRowid,
        '⚖️ Открыт спор по сделке ' + dealId + '\n\nОткрыл: ' + u.email
        + (scope != null ? '\nИсполнитель id ' + scope : '') + '\n\nДеньги заморожены до решения.', 'server');
    }
    return { status: 200, body: { ok: true, id: Number(info.lastInsertRowid) } };
  },

  'POST /api/deals/dispute/close': async (req, body) => {
    const u = auth(req);
    if (!u) return { status: 401, body: { error: 'Нужен вход' } };
    const dealId = String(body.dealId || '').slice(0, 120);
    const d = q.deal.get(dealId);
    if (!d) return { status: 404, body: { error: 'Сделка не найдена' } };
    const payeeId = body.payeeId == null || body.payeeId === '' ? null : Number(body.payeeId);
    const open = payeeId == null ? q.openDisputeAny.get(dealId) : q.openDisputeExact.get(dealId, payeeId, payeeId);
    if (!open) return { status: 200, body: { ok: true, closed: 0 } };
    const may = isAdmin(req) || d.payer_id === u.id || (open.opened_by != null && open.opened_by === u.id)
      || (d.payee_id != null && d.payee_id === u.id);
    if (!may) return { status: 403, body: { error: 'Закрыть спор может открывший, плательщик или оператор' } };
    const info = payeeId == null ? q.closeDisputesAll.run(dealId) : q.closeDisputesFor.run(dealId, payeeId);
    return { status: 200, body: { ok: true, closed: Number(info.changes || 0) } };
  },

  /* ── Мои выплаты по кампаниям ──
     Расход кампании считается в приложении из местного журнала. На новом
     устройстве журнал пуст, и расход показывался нулём. Отдаём ключи
     операций выплат — приложение восстановит записи. */
  'GET /api/ops/mine': async (req) => {
    const u = auth(req);
    if (!u) return { status: 401, body: { error: 'Нужен вход' } };
    const rows = q.myReleases.all(u.id).map((r) => {
      let res = {};
      try { res = JSON.parse(r.result || '{}'); } catch (e) { /* пусто */ }
      return { opKey: r.op_key, dealId: res.dealId || null, paid: Number(res.paid) || 0, to: res.to || null, at: r.created_at };
    });
    return { status: 200, body: { rows } };
  },

  'POST /api/deals/refund': async (req, body) => {
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
    /* Возвращаем ОСТАТОК: часть могла уже уйти исполнителям. */
    const rest = d.amount - d.paid;
    if (rest <= 0) return { status: 409, body: { error: 'Из этой заморозки уже всё выплачено' } };
    if (!userKey(body.opKey)) return badKey;
    return moneyOp(String(body.opKey || ''), u.id, 'refund', (add) => {
      add(d.payer_id, 'hold', -rest, 'refund', dealId);
      add(d.payer_id, 'available', rest, 'refund', dealId);
      q.updDeal.run('refunded', d.payee_id, dealId);
      return { ok: true, dealId, refunded: rest };
    });
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
    return moneyOp(String(body.opKey || ''), d.payer_id, 'settle', (add) => {
      add(d.payer_id, 'hold', -rest, 'settle', dealId);
      if (toBlogger > 0) add(payee.id, 'available', toBlogger, 'settle-payout', dealId);
      if (toPayer > 0) add(d.payer_id, 'available', toPayer, 'settle-refund', dealId);
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
  },

  /* Заявка на вывод. Деньги уходят в hold и ЖДУТ ОПЕРАТОРА — статус
     меняет только он. Комиссия считается сразу и видна до подтверждения. */
  'POST /api/withdraw': async (req, body) => {
    if (!rateLimit(req, 'wd', 10, 60000)) return tooOften;
    const u = auth(req);
    if (!u) return { status: 401, body: { error: 'Нужен вход' } };
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
    if (!last) return { status: 200, body: { status: 'none' } };
    return { status: 200, body: { status: last.status, note: last.note || '' } };
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
    vfy.set(state, { userId: u.id, platform: p, at: Date.now(), channel: null, code: '', tries: 0 });
    const redirect = PUBLIC_URL + '/api/verify/callback/' + p;

    const q1 = new URLSearchParams({
      response_type: 'code', state, redirect_uri: redirect, scope: cfg.scope,
    });
    if (p === 'youtube') {
      q1.set('client_id', cfg.id);
      q1.set('access_type', 'online');
      q1.set('prompt', 'consent');
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
    const taken = q.channelByExt.get(rec.platform, String(rec.channel.id));
    if (taken && taken.user_id !== u.id) {
      vfy.delete(nonce);
      return { status: 409, body: { error: 'Этот канал уже подтверждён в другом аккаунте BloggerPay' } };
    }
    q.upsertChannel.run(u.id, rec.platform, String(rec.channel.id),
      rec.channel.title, rec.channel.url, rec.channel.subs);
    vfy.delete(nonce);
    return {
      status: 200,
      body: { ok: true, platform: rec.platform, title: rec.channel.title, subs: rec.channel.subs },
    };
  },

  'GET /api/verify/config': async (req) => {
    if (!rateLimit(req, 'vfycfg', 60, 60000)) return tooOften;
    const platforms = {};
    for (const p of Object.keys(OAUTH)) {
      platforms[p] = {
        label: OAUTH[p].label,
        configured: !!(OAUTH[p].id && OAUTH[p].secret),
        redirect: PUBLIC_URL + '/api/verify/callback/' + p,
      };
    }
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
  'POST /api/admin/verify/unlink': async (req, body) => {
    if (!isAdmin(req)) return { status: 403, body: { error: 'Нужен X-Admin-Key' } };
    const platform = String(body.platform || '');
    const externalId = String(body.externalId || '');
    if (!platform || !externalId) return { status: 400, body: { error: 'Нужны platform и externalId' } };
    const row = q.channelByExt.get(platform, externalId);
    if (!row) return { status: 404, body: { error: 'Такой канал не подтверждён' } };
    q.delChannel.run(platform, externalId);
    return { status: 200, body: { ok: true, freedFrom: row.user_id } };
  },

  /* Приём ошибок от приложения. Без входа: ломается часто именно то,
     что мешает войти. Поэтому же ограничиваем размер и количество. */
  'POST /api/errors': async (req, body) => {
    if (!rateLimit(req, 'err', 30, 60000)) return tooOften;
    const list = Array.isArray(body.errors) ? body.errors.slice(0, 20) : [];
    if (!list.length) return { status: 200, body: { taken: 0 } };
    const u = auth(req);
    let taken = 0;
    for (const e of list) {
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
      /* Каждая новая ошибка тут же уходит владельцу в Телеграм. */
      tgAlert('site:' + msg.slice(0, 120) + '|' + where,
        '🐞 Ошибка на сайте\n\n' + msg
        + (where ? '\n\nГде: ' + where : '')
        + (ver ? '\nВерсия: ' + ver : '')
        + '\nКто: ' + (u ? (u.name || 'без имени') + ' (id ' + u.id + ')' : 'гость (не вошёл)'), 'client');
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
    return { status: 200, body: { rows: q.allWds.all(st, st) } };
  },

  /* «Взял в работу» — с этого момента пользователь заявку не отменит. */
  'POST /api/admin/withdrawals/take': async (req, body) => {
    if (!isAdmin(req)) return { status: 403, body: { error: 'Нужен X-Admin-Key' } };
    const w = q.wd.get(Number(body.withdrawalId));
    if (!w) return { status: 404, body: { error: 'Заявка не найдена' } };
    if (w.status !== 'queued') return { status: 409, body: { error: 'Заявка не в очереди: ' + w.status } };
    q.updWd.run('processing', null, w.id);
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
    return moneyOp(sysKey('wd-paid', w.id), w.user_id, 'wd-paid', (add) => {
      add(w.user_id, 'hold', -w.amount, 'wd-paid', 'заявка ' + w.id);
      add(0, 'available', w.fee, 'fee', 'комиссия по заявке ' + w.id);
      q.updWd.run('paid', String(body.note || '').slice(0, 200) || null, w.id);
      return { ok: true, withdrawalId: w.id, status: 'paid', net: w.net, fee: w.fee };
    });
  },

  'POST /api/admin/withdrawals/reject': async (req, body) => {
    if (!isAdmin(req)) return { status: 403, body: { error: 'Нужен X-Admin-Key' } };
    const w = q.wd.get(Number(body.withdrawalId));
    if (!w) return { status: 404, body: { error: 'Заявка не найдена' } };
    if (w.status === 'paid' || w.status === 'rejected' || w.status === 'cancelled') {
      return { status: 409, body: { error: 'Заявка уже закрыта: ' + w.status } };
    }
    return moneyOp(sysKey('wd-reject', w.id), w.user_id, 'wd-reject', (add) => {
      add(w.user_id, 'hold', -w.amount, 'wd-reject', 'заявка ' + w.id);
      add(w.user_id, 'available', w.amount, 'wd-reject', 'заявка ' + w.id);
      q.updWd.run('rejected', String(body.note || '').slice(0, 200) || 'отклонена оператором', w.id);
      return { ok: true, withdrawalId: w.id, status: 'rejected' };
    });
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
    return { status: 200, body: { ok: true, requestId: k.id, status: 'rejected' } };
  },

  'GET /api/admin/deals': async (req) => {
    if (!isAdmin(req)) return { status: 403, body: { error: 'Нужен X-Admin-Key' } };
    return { status: 200, body: { rows: q.openDeals.all() } };
  },

  'GET /api/admin/user': async (req, body, url) => {
    if (!isAdmin(req)) return { status: 403, body: { error: 'Нужен X-Admin-Key' } };
    const id = Number(url.searchParams.get('id'));
    const u = q.userById.get(id);
    if (!u) return { status: 404, body: { error: 'Нет такого пользователя' } };
    return {
      status: 200,
      body: {
        user: { id: u.id, email: u.email, name: u.name, role: u.role },
        balance: q.balance.get(u.id),
        ledger: q.userLedger.all(u.id),
      },
    };
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
      const a = Buffer.from(given, 'utf8'), b = Buffer.from(ADMIN_KEY, 'utf8');
      pass = !!(b.length && a.length === b.length && crypto.timingSafeEqual(a, b));
      if (!pass) { adminMissed(req); return { status: 403, body: { error: 'Ключ владельца не подошёл' } }; }
    }
    const until = Date.now() + ADMIN_SESSION_MS;
    return {
      status: 200,
      body: {
        ok: true, until,
        by: (u && u.is_admin) ? 'аккаунт' : (body && body.ticket ? 'билет' : 'ключ'),
        /* билет отдаём только приложению — чтобы открыть пульт без ключа */
        ticket: (body && body.wantTicket) ? ticketMake() : undefined,
      },
      headers: { 'Set-Cookie': adminCookie(req, until) },
    };
  },

  /* Проверка: пустит ли сервер без ключа. Страница пульта спрашивает это
     первым делом и показывает поле ключа, только если ответ «нет». */
  'GET /api/admin/session': async (req) => ({
    status: 200,
    body: { ok: isAdmin(req), until: 0 },
  }),

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
    return { status: 200, body: { ok: true, isAdmin: true } };
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
    return {
      status: 200,
      body: {
        всего_в_системе: { available: t.available, hold: t.hold },
        доход_платформы: fees.fees,
        заявок_в_очереди: queued.length,
        сумма_к_выплате: queued.reduce((s, w) => s + w.net, 0),
        взято_в_работу: processing.length,
        верификаций_в_очереди: q.kycQueuedCount.get().n,
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
function verifyPage(res, title, text, good, code) {
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
    + 'font:800 34px/1 ui-monospace,Menlo,Consolas,monospace;letter-spacing:8px;color:#fff}</style>'
    + '<div><b>' + esc(title) + '</b><p>' + esc(text) + '</p>'
    + (code ? '<code>' + esc(code) + '</code>' : '') + '</div>';
  res.writeHead(good ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(html);
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

  const redirect = PUBLIC_URL + '/api/verify/callback/' + p;

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
      const tok = await ask(cfg.token, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code, client_id: cfg.id, client_secret: cfg.secret,
          redirect_uri: redirect, grant_type: 'authorization_code',
        }),
      });
      if (!tok.access_token) throw new Error(tok.error_description || 'YouTube не выдал доступ');
      const me = await ask(
        'https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&mine=true',
        { headers: { Authorization: 'Bearer ' + tok.access_token } });
      const it = me.items && me.items[0];
      if (!it) throw new Error('У этого аккаунта нет канала на YouTube');
      channel = {
        id: it.id, title: (it.snippet && it.snippet.title) || '',
        url: 'https://youtube.com/channel/' + it.id,
        subs: Number(it.statistics && it.statistics.subscriberCount) || 0,
      };
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
      const fields = ['open_id', 'display_name'];
      if (/user\.info\.profile/.test(scope)) fields.push('username', 'profile_deep_link');
      if (/user\.info\.stats/.test(scope)) fields.push('follower_count');
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
      };
    }

    if (!channel.id) throw new Error('Площадка не назвала аккаунт');

    /* Один канал — один аккаунт: иначе двое «подтвердят» один и тот же. */
    const taken = q.channelByExt.get(p, String(channel.id));
    if (taken) {
      vfy.delete(state);
      return verifyPage(res, 'Канал уже привязан',
        'Этот канал подтверждён в аккаунте BloggerPay. Если это ваш канал и доступ потерян — напишите в поддержку.', false);
    }

    /* Не привязываем здесь: канал получит тот, кто введёт код в приложении.
       Так подсунутая кем-то ссылка авторизации не запишет ваш канал на него. */
    rec.channel = channel;
    rec.code = String(crypto.randomInt(100000, 1000000));
    rec.claim = crypto.randomBytes(24).toString('hex');
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
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
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
  const app = String(process.env.APP_URL || '').trim().replace(/[^A-Za-z0-9:/._~%?#\[\]@!$&'()*+,;=-]/g, '');
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
};
function staticFile(pathname) {
  const rec = SITE[pathname];
  if (rec) return { file: path.join(SITE_DIR, rec.name), type: rec.type };
  /* Файл-подпись площадки: /tiktok<буквы и цифры>.txt из корня проекта. */
  const sign = /^\/(tiktok[A-Za-z0-9]{8,64}\.txt)$/.exec(pathname);
  if (sign) return { file: path.join(SITE_DIR, sign[1]), type: 'text/plain; charset=utf-8' };
  return null;
}
function sendFile(req, res, file, type) {
  let buf;
  try { buf = fs.readFileSync(file); }
  catch (e) { return send(res, 404, { error: 'Файл не найден: ' + path.basename(file) }); }
  /* Страницу приложения не кэшируем: иначе у людей застрянет старая
     версия с деньгами. Картинку — можно, она не меняется. */
  const fresh = /^image\//.test(type) ? 'public, max-age=86400' : 'no-store';
  res.writeHead(200, {
    'Content-Type': type,
    'Cache-Control': fresh,
    'X-Content-Type-Options': 'nosniff',
    'Content-Length': buf.length,
  });
  if (req.method === 'HEAD') return res.end();
  res.end(buf);
}

/* Обработчик вынесен отдельно: слушать приходится не один порт (почему —
   у listenOn ниже), а один http.Server умеет слушать только один. */
const handler = async (req, res) => {
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch (e) {
    /* «GET //», «GET ///» и прочие адреса без хоста разбору не поддаются.
       Это не повод падать: отвечаем 400 и живём дальше. */
    return send(res, 400, { error: 'Неверный адрес запроса' });
  }
  if (req.method === 'OPTIONS') return send(res, 204, {});
  if (req.method === 'GET' && (url.pathname === '/operator' || url.pathname === '/operator.html')) {
    return sendOperatorPage(res);
  }
  if (req.method === 'GET' && url.pathname.startsWith('/api/verify/callback/')) {
    return handleVerifyCallback(req, res, url);
  }
  /* Страница показа кода. Саму метку страница берёт из адреса уже в
     браузере — сервер здесь отдаёт только вёрстку и ничего не решает. */
  if (req.method === 'GET' && /^\/r\/[a-f0-9]{32}$/i.test(url.pathname)) {
    return sendRecoverPage(res);
  }
  /* Сам сайт. Раздаём его отсюда же, из папки над сервером: тогда всё
     хозяйство — сайт, касса и бот — живёт по одному адресу, и боту
     некуда ссылаться, кроме как на нас. Отдельный хостинг для статики
     не нужен. */
  if (req.method === 'GET' || req.method === 'HEAD') {
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
      && (url.pathname === '/api/kyc/submit' || url.pathname === '/api/cards' || url.pathname === '/api/sync/put');
    if (isBig && !auth(req)) return send(res, 401, { error: 'Нужен вход' });
    const maxBody = isBig ? 1500 * 1024 : undefined;
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
    require('./bot').boot().then((ok) => {
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
