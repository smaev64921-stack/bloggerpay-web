/* Вход владельца в админку из Телеграма (15.10.2026): кнопка «Админ панель»
   в боте открывает /admin мини-приложением, страница присылает initData,
   сервер (POST /api/admin/tg-session) проверяет подпись ключом бота,
   свежесть и что это сам владелец (ADMIN_CHAT_ID / ADMIN_TG_IDS) — и выдаёт
   ту же сессию-куку, что после ключа. Подделать подпись можно только зная
   токен бота — в тесте он наш, поэтому проверяем и «настоящий» вход, и
   отказы. Свои порты 8486/8487. Запуск: node test-admin-tg.mjs */

import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const PORT = 8486, BASE = 'http://127.0.0.1:' + PORT;
const BOT_TOKEN = '987654321:AAadmin-test-token';
const OWNER = '424242';
let passed = 0, failed = 0;
function ok(c, name, extra) {
  if (c) { passed++; console.log('  ok  ' + name); }
  else { failed++; console.log('  FAIL ' + name + (extra !== undefined ? '  ← ' + JSON.stringify(extra).slice(0, 300) : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/* initData мини-приложения: секрет = HMAC("WebAppData", токен), подпись =
   HMAC(секрет, пары по алфавиту через перевод строки) — как у Телеграма */
function initData(user, over) {
  const f = Object.assign({ auth_date: String(Math.floor(Date.now() / 1000)), query_id: 'AAH' + Date.now(),
    user: JSON.stringify(user) }, over || {});
  const line = Object.keys(f).sort().map((k) => k + '=' + f[k]).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  f.hash = crypto.createHmac('sha256', secret).update(line).digest('hex');
  return new URLSearchParams(f).toString();
}
const CWD = fileURLToPath(new URL('.', import.meta.url));
function start(port, env) {
  const dir = mkdtempSync(path.join(tmpdir(), 'bp-admtg-'));
  return spawn(process.execPath, ['server.js'], {
    cwd: CWD,
    env: { ...process.env, PORT: String(port), DB_PATH: path.join(dir, 'db.sqlite'), ADMIN_KEY: 'test-admtg-key', ADMIN_EMAIL: '',
      PUBLIC_URL: 'http://127.0.0.1:' + port, BOT_TOKEN, TG_API_BASE: 'http://127.0.0.1:9', RESEND_API_KEY: '',
      YOOKASSA_SHOP_ID: '', YOOKASSA_SECRET_KEY: '', ADMIN_TG_IDS: '', ...env },
    stdio: process.env.BP_DEBUG ? 'inherit' : 'ignore',
  });
}
async function up(port) {
  for (let i = 0; i < 80; i++) { try { const r = await fetch('http://127.0.0.1:' + port + '/api/health'); await r.text(); if (r.ok) return true; } catch (e) {} await sleep(150); }
  return false;
}
async function post(port, p, body, cookie) {
  const h = { 'Content-Type': 'application/json', 'X-Admin-Session': '1' };
  if (cookie) h.Cookie = cookie;
  const r = await fetch('http://127.0.0.1:' + port + p, { method: 'POST', headers: h, body: JSON.stringify(body || {}) });
  const t = await r.text(); let j = {}; try { j = JSON.parse(t); } catch (e) {}
  return { status: r.status, body: j, cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
}
async function get(port, p, cookie) {
  const r = await fetch('http://127.0.0.1:' + port + p, { headers: cookie ? { Cookie: cookie, 'X-Admin-Session': '1' } : {} });
  const t = await r.text(); let j = {}; try { j = JSON.parse(t); } catch (e) {}
  return { status: r.status, body: j };
}

const srv = start(PORT, { ADMIN_CHAT_ID: OWNER });
let srv2 = null;
try {
  console.log('\nВход в админку из Телеграма');
  ok(await up(PORT), 'сервер поднялся');
  const owner = { id: Number(OWNER), first_name: 'Владелец', username: 'owner_bp' };

  const r1 = await post(PORT, '/api/admin/tg-session', { initData: initData(owner) });
  ok(r1.status === 200 && r1.body.ok && /^bp_admin=/.test(r1.cookie) && /@owner_bp \(424242\)/.test(r1.body.who || ''), 'владелец из Телеграма: вход без ключа, сессия-кука', r1);
  const s1 = await get(PORT, '/api/admin/session', r1.cookie);
  ok(s1.body.ok === true && /Телеграм @owner_bp/.test(s1.body.who || ''), 'сессия признана, в журнале — «Телеграм @owner_bp»', s1.body);
  const ov = await get(PORT, '/api/admin/overview', r1.cookie);
  ok(ov.status === 200, 'с этой сессией открывается сводка админки', ov.status);
  const fa = await get(PORT, '/api/admin/full-access', r1.cookie);
  ok(fa.status === 200 && fa.body.full === true, 'и полный доступ к сайту', fa.body);

  const other = await post(PORT, '/api/admin/tg-session', { initData: initData({ id: 777000, first_name: 'Чужой', username: 'stranger' }) });
  ok(other.status === 403 && /не владелец/.test(other.body.error || '') && !other.cookie, 'чужой Телеграм-аккаунт — отказ, куки нет', other);

  const good = initData(owner);
  const tampered = new URLSearchParams(good); const u0 = JSON.parse(tampered.get('user')); u0.username = 'hacker'; tampered.set('user', JSON.stringify(u0));
  const t1 = await post(PORT, '/api/admin/tg-session', { initData: tampered.toString() });
  ok(t1.status === 403 && /Подпись/.test(t1.body.error || '') && !t1.cookie, 'данные подменены после подписи — отказ', t1);
  const old = await post(PORT, '/api/admin/tg-session', { initData: initData(owner, { auth_date: String(Math.floor(Date.now() / 1000) - 3600) }) });
  ok(old.status === 403 && /устарели/.test(old.body.error || ''), 'подпись старше 10 минут — отказ (переоткрыть кнопку)', old.body);
  const empty = await post(PORT, '/api/admin/tg-session', {});
  ok(empty.status === 403 && !empty.cookie, 'без данных Телеграма — отказ', empty.body);
  const noCookie = await get(PORT, '/api/admin/overview');
  ok(noCookie.status === 403, 'без куки админка по-прежнему закрыта', noCookie.status);

  /* без ADMIN_CHAT_ID вход из Телеграма честно выключен; список ADMIN_TG_IDS работает */
  srv2 = start(PORT + 1, { ADMIN_CHAT_ID: '-100123', ADMIN_TG_IDS: '555, abc' });
  ok(await up(PORT + 1), 'второй сервер поднялся');
  const r2 = await post(PORT + 1, '/api/admin/tg-session', { initData: initData({ id: 555, first_name: 'Зам' }) });
  ok(r2.status === 200 && /^bp_admin=/.test(r2.cookie), 'номер из ADMIN_TG_IDS — тоже владелец', r2.body);
  const r3 = await post(PORT + 1, '/api/admin/tg-session', { initData: initData({ id: 100123, first_name: 'Группа' }) });
  ok(r3.status === 403, 'отрицательный ADMIN_CHAT_ID (группа) входа не даёт', r3.body);
  try { srv2.kill(); } catch (e) {}
  srv2 = start(PORT + 1, { ADMIN_CHAT_ID: '', ADMIN_TG_IDS: '' });
  await sleep(300);
  ok(await up(PORT + 1), 'третий сервер поднялся');
  const r4 = await post(PORT + 1, '/api/admin/tg-session', { initData: initData(owner) });
  ok(r4.status === 503 && /не настроен/.test(r4.body.error || ''), 'без ADMIN_CHAT_ID — «вход через Телеграм не настроен»', r4.body);

  /* промахи считаются в замок от перебора (последним — замок держит адрес) */
  let locked = false;
  for (let i = 0; i < 25 && !locked; i++) {
    const r = await post(PORT, '/api/admin/tg-session', { initData: initData({ id: 1000 + i, first_name: 'x' }) });
    if (r.status === 429) locked = true;
  }
  ok(locked, 'череда отказов упирается в замок «подождите десять минут»');
} catch (e) {
  failed++; console.log('  FAIL исключение: ' + (e && e.stack || e));
} finally {
  try { srv.kill(); } catch (e) {}
  try { if (srv2) srv2.kill(); } catch (e) {}
}
console.log(`\nИтого: ${passed} ok, ${failed} FAIL`);
process.exit(failed ? 1 : 0);
