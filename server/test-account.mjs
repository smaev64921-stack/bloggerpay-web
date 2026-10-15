/* «Настройки» (15.10.2026): смена пароля вошедшим, выход на всех
   устройствах, запрос на удаление аккаунта. Настоящий server.js на своём
   порту 8496. Запуск: node test-account.mjs */
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = 8496, BASE = 'http://127.0.0.1:' + PORT, KEY = 'test-acct-key';
let passed = 0, failed = 0;
function ok(c, name, extra) {
  if (c) { passed++; console.log('  ok  ' + name); }
  else { failed++; console.log('  FAIL ' + name + (extra !== undefined ? '  ← ' + JSON.stringify(extra).slice(0, 300) : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dir = mkdtempSync(path.join(tmpdir(), 'bp-acct-'));
const srv = spawn(process.execPath, ['server.js'], { cwd: fileURLToPath(new URL('.', import.meta.url)), stdio: process.env.BP_DEBUG ? 'inherit' : 'ignore', env: {
  ...process.env, PORT: String(PORT), DB_PATH: path.join(dir, 'db.sqlite'), ADMIN_KEY: KEY, ADMIN_EMAIL: '', PUBLIC_URL: BASE,
  TRUST_PROXY: '1', BOT_TOKEN: '', ADMIN_CHAT_ID: '', RESEND_API_KEY: '', TEST_TOPUP: '1', TEST_TOPUP_OPEN: '1', YOOKASSA_SHOP_ID: '', YOOKASSA_SECRET_KEY: '' } });
async function up() { for (let i = 0; i < 100; i++) { try { const r = await fetch(BASE + '/api/health'); await r.text(); if (r.ok) return true; } catch (e) {} await sleep(150); } return false; }
async function api(m, p, b, token, admin) {
  /* TRUST_PROXY=1 + свой адрес: на петле лимиты не считаются, а их тоже проверяем */
  const h = { 'Content-Type': 'application/json', 'X-Forwarded-For': '10.77.' + (process.pid % 250) + '.9' }; if (token) h.Authorization = 'Bearer ' + token; if (admin) h['X-Admin-Key'] = KEY;
  const r = await fetch(BASE + p, { method: m, headers: h, body: b ? JSON.stringify(b) : undefined });
  const t = await r.text(); let j = {}; try { j = JSON.parse(t); } catch (e) {} return { status: r.status, body: j };
}
const tag = Date.now().toString(36), email = 'acc' + tag + '@t.ru', P1 = 'пароль-первый-12', P2 = 'пароль-второй-34';
try {
  console.log('\nНастройки: пароль, сессии, удаление');
  ok(await up(), 'сервер поднялся');
  const reg = await api('POST', '/api/register', { email, name: 'Ваня', role: 'blogger', password: P1 });
  const T1 = reg.body.token;
  const T2 = (await api('POST', '/api/login', { email, password: P1 })).body.token;   // второе устройство
  const T3 = (await api('POST', '/api/login', { email, password: P1 })).body.token;   // третье
  ok(T1 && T2 && T3 && T1 !== T2, 'три устройства вошли в один аккаунт');

  const noAuth = await api('POST', '/api/password/change', { old: P1, password: P2 });
  ok(noAuth.status === 401, 'без входа пароль не меняется', noAuth.status);
  const short = await api('POST', '/api/password/change', { old: P1, password: 'корот' }, T1);
  ok(short.status === 400 && /минимум 8/.test(short.body.error || ''), 'новый пароль короче 8 символов — отказ', short.body);
  const wrong = await api('POST', '/api/password/change', { old: 'не-тот-пароль', password: P2 }, T1);
  ok(wrong.status === 403 && /не подходит/.test(wrong.body.error || '') && wrong.body.left === 4, 'неверный текущий пароль — «не подходит», осталось 4 попытки', wrong.body);
  const same = await api('POST', '/api/password/change', { old: P1, password: P1 }, T1);
  ok(same.status === 400 && /совпадает/.test(same.body.error || ''), 'новый пароль совпадает с текущим — отказ', same.body);
  const chg = await api('POST', '/api/password/change', { old: P1, password: P2 }, T1);
  ok(chg.status === 200 && chg.body.ok, 'пароль сменён', chg.body);
  ok((await api('GET', '/api/me', null, T1)).status === 200, 'это устройство осталось в аккаунте');
  ok((await api('GET', '/api/me', null, T2)).status === 401 && (await api('GET', '/api/me', null, T3)).status === 401, 'другие устройства вышли (их сессии погашены)');
  ok((await api('POST', '/api/login', { email, password: P1 })).status === 401, 'старый пароль больше не входит');
  const T4 = (await api('POST', '/api/login', { email, password: P2 })).body.token;
  ok(!!T4, 'новый пароль входит');

  /* перебор старого пароля упирается в паузу */
  let locked = false;
  for (let i = 0; i < 7 && !locked; i++) {
    const r = await api('POST', '/api/password/change', { old: 'перебор-' + i, password: 'новый-пароль-99' }, T4);
    if (r.status === 429) locked = true;
  }
  ok(locked, 'пять неверных старых паролей подряд — пауза 15 минут');
  const afterLock = await api('POST', '/api/password/change', { old: P2, password: 'новый-пароль-99' }, T4);
  ok(afterLock.status === 429, 'во время паузы даже верный пароль не меняется', afterLock.body);

  /* выйти на всех устройствах */
  const T5 = (await api('POST', '/api/login', { email, password: P2 })).body.token;
  const T6 = (await api('POST', '/api/login', { email, password: P2 })).body.token;
  const out = await api('POST', '/api/logout-all', {}, T5);
  ok(out.status === 200 && out.body.closed >= 2, '«Выйти на всех устройствах» — закрыты остальные сессии', out.body);
  ok((await api('GET', '/api/me', null, T5)).status === 200 && (await api('GET', '/api/me', null, T6)).status === 401 && (await api('GET', '/api/me', null, T4)).status === 401,
    'это устройство в аккаунте, остальные вышли');

  /* запрос на удаление */
  const del = await api('POST', '/api/account/delete-request', { why: 'больше не пользуюсь' }, T5);
  ok(del.status === 200 && del.body.ok, 'запрос на удаление аккаунта принят', del.body);
  const log = await api('GET', '/api/admin/log', null, null, true);
  const row = ((log.body && (log.body.rows || log.body.log)) || []).find((r) => r.action === 'erase-request');
  ok(!!row && /больше не пользуюсь/.test(String(row.detail || '')), 'владелец видит запрос в журнале админки', row || log.body);
  let lim = 0;
  for (let i = 0; i < 4; i++) { const r = await api('POST', '/api/account/delete-request', {}, T5); if (r.status === 429) lim++; }
  ok(lim >= 1, 'запросы на удаление не чаще трёх в час');
  ok((await api('POST', '/api/account/delete-request', {})).status === 401, 'без входа запрос не принимается');

  /* «в сети»: только если человек сам писал спрашивающему; можно выключить */
  const rA = await api('POST', '/api/register', { email: 'pa' + tag + '@t.ru', name: 'Аня', role: 'blogger', password: P1 });
  const rB = await api('POST', '/api/register', { email: 'pb' + tag + '@t.ru', name: 'Борис', role: 'advertiser', password: P1 });
  const TA = rA.body.token, TB = rB.body.token;
  const idOf = async (t) => { const b = (await api('GET', '/api/me', null, t)).body; return Number((b.user && b.user.id) || b.id); };
  const idA = await idOf(TA), idB = await idOf(TB);
  const dm = (t, from, to, id) => api('POST', '/api/sync/put', { kind: 'dm', rid: 'dm.' + from + '.' + to + '.' + id, data: { v: 1, t: 'привет', at: Date.now() }, to }, t);
  ok((await dm(TA, idA, idB, 'm1aaaa')).status === 200, 'Аня написала Борису');
  const p1 = await api('GET', '/api/presence?ids=' + idB, null, TA);
  ok(p1.status === 200 && p1.body.rows && p1.body.rows[idB] === undefined, 'Аня не видит «в сети» Бориса: он ей не писал (написать незнакомцу и следить нельзя)', p1.body);
  const p2 = await api('GET', '/api/presence?ids=' + idA, null, TB);
  ok(p2.body.rows && p2.body.rows[idA] && p2.body.rows[idA].on === true && Object.keys(p2.body.rows[idA]).join() === 'on', 'Борис видит, что Аня в сети, — только да/нет, без времени', p2.body);
  ok((await api('POST', '/api/presence/me', { show: false }, TA)).body.show === false, 'Аня выключила «Показывать, что я в сети»');
  const p3 = await api('GET', '/api/presence?ids=' + idA, null, TB);
  ok(p3.body.rows && p3.body.rows[idA] === undefined, 'после выключения Борис её «в сети» не видит', p3.body);
  ok((await api('GET', '/api/account/methods', null, TA)).body.presence === false, 'в «Настройках» переключатель — выключен (methods.presence)');
  await api('POST', '/api/presence/me', { show: true }, TA);
  ok(((await api('GET', '/api/presence?ids=' + idA, null, TB)).body.rows[idA] || {}).on === true, 'включила снова — видно');
  await dm(TB, idB, idA, 'm2bbbb');
  ok(((await api('GET', '/api/presence?ids=' + idB, null, TA)).body.rows[idB] || {}).on === true, 'Борис ответил — теперь и Аня видит его «в сети»');
  ok((await api('GET', '/api/presence?ids=' + idA)).status === 401 && (await api('POST', '/api/presence/me', { show: false })).status === 401, 'без входа — 401');
} catch (e) {
  failed++; console.log('  FAIL исключение: ' + (e && e.stack || e));
} finally {
  try { srv.kill(); } catch (e) {}
}
console.log(`\nИтого: ${passed} ok, ${failed} FAIL`);
process.exit(failed ? 1 : 0);
