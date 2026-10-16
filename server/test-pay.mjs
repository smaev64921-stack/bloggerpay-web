/* Платёжный контур: режимы кассы и предохранитель тестового пополнения.
   Тест сам поднимает два дополнительных сервера с другими настройками
   (TEST_TOPUP=0 и с ключами ЮKassa) и гасит их в конце.
   Запуск: node test-pay.mjs (основной сервер должен работать на 8090). */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* Адрес сервера можно подменить: BP_TEST_BASE=http://127.0.0.1:8091 npm test.
   Нужно, когда над проектом работают в две руки и порт 8090 занят чужим
   сервером — иначе проверки идут не по тому коду. */
const MAIN = process.env.BP_TEST_BASE || 'http://127.0.0.1:8090';
let passed = 0, failed = 0;
function ok(c, name, extra) {
  if (c) { passed++; console.log('  ok  ' + name); }
  else { failed++; console.log('  FAIL ' + name + (extra ? '  ← ' + JSON.stringify(extra) : '')); }
}
async function api(base, method, p, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const r = await fetch(base + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
function boot(port, env) {
  const dir = mkdtempSync(path.join(tmpdir(), 'bp-pay-'));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: fileURLToPath(new URL('.', import.meta.url)),
    /* бот и тревоги — выключены: иначе токен из server/.env поднял бы на
       проверочном сервере настоящего бота (он забирает getUpdates у боевого) */
    env: { ...process.env, PORT: String(port), DB_PATH: path.join(dir, 'db.sqlite'), ADMIN_KEY: 'test-key', BOT_TOKEN: '', ADMIN_CHAT_ID: '', ...env },
    stdio: 'ignore',
  });
  return child;
}
async function waitUp(base) {
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(base + '/api/health'); if (r.ok) return true; } catch (e) {}
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}
async function reg(base, tag) {
  const r = await api(base, 'POST', '/api/register',
    { email: `pay${tag}@t.ru`, name: 'Плательщик', role: 'advertiser', password: 'парольП12345' });
  return r.body.token;
}

const tag = Date.now();
console.log('\nПлатежи: режимы кассы и предохранители');

/* ── основной сервер: касса не настроена, тестовое пополнение живо ── */
const cfg1 = await api(MAIN, 'GET', '/api/pay/config');
ok(cfg1.status === 200 && cfg1.body.mode === 'test', 'без ключей кассы режим test', cfg1.body);
const T1 = await reg(MAIN, 'a' + tag);
const tu1 = await api(MAIN, 'POST', '/api/topup', { amount: 2000, opKey: randomUUID() }, T1);
ok(tu1.status === 200 && tu1.body.ok, 'тестовое пополнение работает', tu1.body);
const cr1 = await api(MAIN, 'POST', '/api/pay/create', { amount: 2000, opKey: randomUUID() }, T1);
ok(cr1.status === 503, 'создать платёж без ключей нельзя (503, честно)', cr1.body);

/* ── сервер с TEST_TOPUP=0: пополнение выключено совсем ── */
const c2 = boot(8097, { TEST_TOPUP: '0' });
ok(await waitUp('http://127.0.0.1:8097'), 'сервер с TEST_TOPUP=0 поднялся');
const cfg2 = await api('http://127.0.0.1:8097', 'GET', '/api/pay/config');
ok(cfg2.body.mode === 'off', 'режим off при выключенном тестовом пополнении', cfg2.body);
const T2 = await reg('http://127.0.0.1:8097', 'b' + tag);
const tu2 = await api('http://127.0.0.1:8097', 'POST', '/api/topup', { amount: 2000, opKey: randomUUID() }, T2);
ok(tu2.status === 503, 'тестовое пополнение отвечает 503', tu2.body);
c2.kill();

/* ── сервер с ключами ЮKassa: тестовое пополнение мертво всегда ── */
const c3 = boot(8098, { YOOKASSA_SHOP_ID: '000000', YOOKASSA_SECRET_KEY: 'test_fake', TEST_TOPUP: '1' });
ok(await waitUp('http://127.0.0.1:8098'), 'сервер с ключами кассы поднялся');
const B3 = 'http://127.0.0.1:8098';
const cfg3 = await api(B3, 'GET', '/api/pay/config');
ok(cfg3.body.mode === 'yookassa', 'с ключами режим yookassa', cfg3.body);
const T3 = await reg(B3, 'c' + tag);
const tu3 = await api(B3, 'POST', '/api/topup', { amount: 2000, opKey: randomUUID() }, T3);
ok(tu3.status === 503, 'тестовое пополнение выключено даже при TEST_TOPUP=1', tu3.body);
const crBad = await api(B3, 'POST', '/api/pay/create', { amount: 500 }, T3);
ok(crBad.status === 400, 'платёж меньше 1000 ₽ отклонён', crBad.body);
const crNoAuth = await api(B3, 'POST', '/api/pay/create', { amount: 2000 });
ok(crNoAuth.status === 401, 'платёж без входа отклонён', crNoAuth.body);
const cr3 = await api(B3, 'POST', '/api/pay/create', { amount: 2000 }, T3);
ok(cr3.status === 502 || cr3.status === 400, 'с поддельными ключами касса честно отказывает', { status: cr3.status });
/* Мусор без номера платежа: наружу сервер не ходит вовсе, ответ всегда 200. */
const whJunk = await api(B3, 'POST', '/api/pay/webhook', { event: 'payment.succeeded', привет: 'мусор' });
ok(whJunk.status === 200, 'мусор в теле вебхука не роняет сервер', whJunk.body);

/* Номер платежа есть, но касса его не знает.
   200 — когда касса ответила внятно (неверные ключи, нет такого платежа):
         повторять нечего.
   503 — когда до кассы не дозвонились: правду о платеже мы не узнали, и
         просим повторить уведомление. Раньше здесь всегда стоял 200, а
         для кассы 200 значит «доставлено» — оплаченные деньги молча
         терялись, если наш запрос к ней не прошёл.
   Что именно вернётся, зависит от связи с api.yookassa.ru, поэтому
   допустимы оба ответа; недопустимо только падение. */
const wh = await api(B3, 'POST', '/api/pay/webhook', { event: 'payment.succeeded', object: { id: 'нет-такого' } });
ok(wh.status === 200 || wh.status === 503, 'неизвестный платёж: 200 при внятном отказе кассы, 503 при сбое связи', wh.body);
const stBad = await api(B3, 'GET', '/api/pay/status?id=nope', null, T3);
ok(stBad.status === 404, 'статус чужого/несуществующего платежа — 404', stBad.body);
c3.kill();

/* ── ограничение частоты: за прокси, чужой IP, перебор регистраций ── */
const c4 = boot(8099, { TRUST_PROXY: '1' });
ok(await waitUp('http://127.0.0.1:8099'), 'сервер с TRUST_PROXY=1 поднялся');
async function regAs(ip, n) {
  const r = await fetch('http://127.0.0.1:8099/api/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
    body: JSON.stringify({ email: `rl${n}${tag}@t.ru`, name: 'Перебор', role: 'blogger', password: 'парольР12345' }),
  });
  return r.status;
}
let last = 0;
for (let n = 0; n < 11; n++) last = await regAs('10.7.7.7', n);
ok(last === 429, '11-я регистрация подряд с одного IP отбита (429)', { last });
const other = await regAs('10.8.8.8', 99);
ok(other === 200, 'другой IP при этом регистрируется свободно', { other });
/* TRUST_PROXY=1 и прокси передаёт адрес — совета в /admin нет */
const ov4 = await fetch('http://127.0.0.1:8099/api/admin/overview', { headers: { 'X-Admin-Key': 'test-key', 'X-Forwarded-For': '10.9.9.9' } }).then((r) => r.json()).catch(() => ({}));
ok(ov4.прокси && ov4.прокси.trust === true && ov4.прокси.заголовки_прокси === true && !ov4.прокси.совет, 'TRUST_PROXY=1 с X-Forwarded-For: /admin без совета', ov4.прокси);
c4.kill();

/* ── тестовые деньги на боевом адресе (аудит 16.10.2026) ──
   Сервер виден снаружи и тестовое пополнение открыто всем: деньги
   ненастоящие — вывод закрыт, /admin знает об этом, зачисления помечены.
   Порт 8097 освободился (сервер с TEST_TOPUP=0 погашен выше). */
const c5 = boot(8097, { PUBLIC_URL: 'https://bp-test-public.example.com', APP_URL: '', TEST_TOPUP: '1', TEST_TOPUP_OPEN: '1',
  BOT_TOKEN: '', ADMIN_CHAT_ID: '', RESEND_API_KEY: '', TRUST_PROXY: '', YOOKASSA_SHOP_ID: '', YOOKASSA_SECRET_KEY: '' });
const B5 = 'http://127.0.0.1:8097';
ok(await waitUp(B5), 'сервер «публичный адрес + TEST_TOPUP_OPEN=1» поднялся');
const cfg5 = await api(B5, 'GET', '/api/pay/config');
ok(cfg5.body.mode === 'test' && cfg5.body.withdrawOpen === false, 'режим test, вывод закрыт (withdrawOpen:false)', cfg5.body);
const r5 = await api(B5, 'POST', '/api/register', { email: 'pub' + tag + '@t.ru', name: 'Публичный', role: 'blogger', password: 'парольР12345' });
const T5 = r5.body.token;
const tu5 = await api(B5, 'POST', '/api/topup', { amount: 2000, opKey: randomUUID() }, T5);
ok(tu5.status === 200, 'тестовое пополнение открыто всем', tu5.body);
const wd5 = await api(B5, 'POST', '/api/withdraw', { amount: 1000, requisites: '2200 0000 0000 0000', opKey: randomUUID() }, T5);
ok(wd5.status === 403 && wd5.body.code === 'test_money' && /^Вывод откроется после запуска оплаты/.test(wd5.body.error || ''),
  'вывод закрыт: 403 «Вывод откроется после запуска оплаты»', wd5);
const ov5 = await fetch(B5 + '/api/admin/overview', { headers: { 'X-Admin-Key': 'test-key', 'X-Forwarded-For': '10.5.5.5' } }).then((r) => r.json()).catch(() => ({}));
const t5 = ov5.тестовые_деньги || {};
ok(t5.открыто_всем === true && /TEST_TOPUP_OPEN/.test(t5.предупреждение || '') && t5.внесено === 2000 && t5.людей === 1,
  '/admin: «тестовое пополнение открыто всем», тестовых 2 000 ₽ у 1 человека', t5);
ok(ov5.сверка && ov5.сверка.сходится, 'сверка с тестовыми зачислениями сходится', ov5.сверка);
ok(ov5.прокси && ov5.прокси.заголовки_прокси === true && /TRUST_PROXY=1/.test(ov5.прокси.совет || ''),
  'прокси передаёт X-Forwarded-For, а TRUST_PROXY нет — /admin советует TRUST_PROXY=1', ov5.прокси);
c5.kill();

console.log(`\nИтого: ${passed} ok, ${failed} fail\n`);
process.exit(failed ? 1 : 0);
