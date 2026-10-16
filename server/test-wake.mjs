/* «Уведомления сразу» (15.10.2026): ждущий запрос GET /api/wake. Свой сервер
   на 8520 (WAKE_MS=2500, чтобы не ждать 25 с).
   Проверяем: без входа — 401; конверт от собеседника будит сразу (< 1 с);
   событие, пока никто не ждал, уходит со следующим запросом; без событий —
   пустой список через WAKE_MS; решение по проверке личности (push) будит
   человека; брошенный запрос не мешает следующему.
   Запуск: node test-wake.mjs */

import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = 8520, BASE = 'http://127.0.0.1:' + PORT, KEY = 'test-wake-key';
let passed = 0, failed = 0;
function ok(c, name, extra) {
  if (c) { passed++; console.log('  ok  ' + name); }
  else { failed++; console.log('  FAIL ' + name + (extra !== undefined ? '  ← ' + JSON.stringify(extra).slice(0, 300) : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CWD = fileURLToPath(new URL('.', import.meta.url));
const dir = mkdtempSync(path.join(tmpdir(), 'bp-wake-'));
const srv = spawn(process.execPath, ['server.js'], {
  cwd: CWD,
  env: { ...process.env, PORT: String(PORT), DB_PATH: path.join(dir, 'db.sqlite'), PUBLIC_URL: BASE, APP_URL: BASE + '/', ADMIN_KEY: KEY, ADMIN_EMAIL: '',
    BOT_TOKEN: '', ADMIN_CHAT_ID: '', RESEND_API_KEY: '', YOOKASSA_SHOP_ID: '', YOOKASSA_SECRET_KEY: '', TEST_TOPUP: '1', WAKE_MS: '2500' },
  stdio: process.env.BP_DEBUG ? 'inherit' : 'ignore',
});
for (let i = 0; i < 100; i++) { try { const r = await fetch(BASE + '/api/health'); await r.text(); if (r.ok) break; } catch (e) {} await sleep(150); }
async function api(method, p, body, token, admin, signal) {
  const h = { 'Content-Type': 'application/json' };
  if (token) h.Authorization = 'Bearer ' + token;
  if (admin) h['X-Admin-Key'] = KEY;
  const r = await fetch(BASE + p, { method, headers: h, body: body ? JSON.stringify(body) : undefined, signal });
  const t = await r.text(); let j = {}; try { j = JSON.parse(t); } catch (e) { j = { _t: t.slice(0, 200) }; }
  return { status: r.status, body: j };
}
const tag = Date.now().toString(36), PASS = 'пароль-подлиннее-12';
const A = (await api('POST', '/api/register', { email: 'wa' + tag + '@t.ru', name: 'Аня', role: 'advertiser', password: PASS })).body;
const B = (await api('POST', '/api/register', { email: 'wb' + tag + '@t.ru', name: 'Боря', role: 'blogger', password: PASS })).body;
const bId = B.user && B.user.id;

try {
  ok((await api('GET', '/api/wake')).status === 401, 'без входа — 401');

  /* 1 · сообщение будит собеседника сразу */
  const t0 = Date.now();
  const waitB = api('GET', '/api/wake', null, B.token);
  await sleep(300);
  const put = await api('POST', '/api/sync/put', { kind: 'dm', rid: 'dm-' + tag + '-1', to: bId, data: { text: 'привет' } }, A.token);
  const w1 = await waitB;
  const dt = Date.now() - t0 - 300;
  ok(put.status === 200, 'Аня пишет Боре (конверт dm)', put);
  ok(w1.status === 200 && (w1.body.kinds || []).includes('sync') && dt < 1000, 'ждущий запрос Бори ответил сразу: kinds [sync], ' + dt + ' мс', { w1, dt });

  /* 2 · событие, пока никто не ждал, — со следующим запросом */
  await api('POST', '/api/sync/put', { kind: 'dm', rid: 'dm-' + tag + '-2', to: bId, data: { text: 'ещё' } }, A.token);
  const t1 = Date.now();
  const w2 = await api('GET', '/api/wake', null, B.token);
  ok((w2.body.kinds || []).includes('sync') && Date.now() - t1 < 800, 'событие между запросами не потерялось — отдано сразу', w2);

  /* 3 · без событий — пустой список через WAKE_MS */
  const t2 = Date.now();
  const w3 = await api('GET', '/api/wake', null, B.token);
  const d3 = Date.now() - t2;
  ok(w3.status === 200 && Array.isArray(w3.body.kinds) && !w3.body.kinds.length && d3 >= 2300 && d3 < 4500, 'без событий — пустой список примерно через 2,5 с (' + d3 + ' мс)', { w3, d3 });

  /* 4 · своё действие самого себя не будит */
  const waitA = api('GET', '/api/wake', null, A.token);
  await sleep(200);
  await api('POST', '/api/sync/put', { kind: 'dm', rid: 'dm-' + tag + '-3', to: bId, data: { text: 'и ещё' } }, A.token);
  const wa = await waitA;
  ok(!(wa.body.kinds || []).length, 'отправитель сам себя не будит (ответ — по тайм-ауту, пустой)', wa);
  await api('GET', '/api/wake', null, B.token);   /* снять событие Бори */

  /* 5 · push-событие (решение по проверке личности) будит человека */
  const kyc = await api('POST', '/api/kyc/submit', { name: 'Боря Тестов', birth: '01.01.1995', photo: 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2w==', selfie: 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2w==' }, B.token);
  const list = await api('GET', '/api/admin/kyc?status=queued', null, null, true);
  const row = (list.body.rows || []).find((r) => r.email === 'wb' + tag + '@t.ru');
  const waitK = api('GET', '/api/wake', null, B.token);
  await sleep(250);
  const t5 = Date.now();
  const ap = row ? await api('POST', '/api/admin/kyc/approve', { requestId: row.id }, null, true) : { status: 0 };
  const wk = await waitK;
  ok(kyc.status === 200 && ap.status === 200, 'Боря отправил документы, владелец одобрил', [kyc.status, ap.status]);
  ok((wk.body.kinds || []).includes('note') && Date.now() - t5 < 1000, 'решение по документам разбудило Борю сразу (kinds [note])', wk);

  /* 6 · брошенный запрос не мешает следующему */
  const ac = new AbortController();
  const lost = api('GET', '/api/wake', null, B.token, false, ac.signal).catch(() => null);
  await sleep(200); ac.abort(); await lost; await sleep(200);
  const waitB2 = api('GET', '/api/wake', null, B.token);
  await sleep(200);
  await api('POST', '/api/sync/put', { kind: 'dm', rid: 'dm-' + tag + '-4', to: bId, data: { text: 'после обрыва' } }, A.token);
  const w6 = await waitB2;
  ok((w6.body.kinds || []).includes('sync'), 'после брошенного запроса новый ждёт и будится как обычно', w6);
  ok((await api('GET', '/api/health')).status === 200, 'сервер жив');
} catch (e) {
  failed++; console.log('  FAIL исключение: ' + (e && e.stack || e));
} finally {
  try { srv.kill(); } catch (e) {}
}
console.log(`\nИтого: ${passed} ok, ${failed} FAIL`);
process.exit(failed ? 1 : 0);
