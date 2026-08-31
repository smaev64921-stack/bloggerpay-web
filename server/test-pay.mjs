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

const MAIN = 'http://127.0.0.1:8090';
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
    env: { ...process.env, PORT: String(port), DB_PATH: path.join(dir, 'db.sqlite'), ADMIN_KEY: 'test-key', ...env },
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
const wh = await api(B3, 'POST', '/api/pay/webhook', { event: 'payment.succeeded', object: { id: 'нет-такого' } });
ok(wh.status === 200, 'вебхук всегда отвечает 200 (мусор не роняет)', wh.body);
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
c4.kill();

console.log(`\nИтого: ${passed} ok, ${failed} fail\n`);
process.exit(failed ? 1 : 0);
