/* Подлог: что может сделать посторонний, просто зарегистрировавшись.

   Приложения обмениваются заявками, сделками и сообщениями через конверты
   (/api/sync). Конверт без адресата раздавался ВСЕМ вошедшим — и любой
   мог положить туда «сообщение в чужой сделке» или «заявку, по которой
   платите вы»: чужие приложения принимали это как своё. Сообщение
   вклеивалось в переписку от чужого имени, а заявка заставляла чужой
   телефон заморозить деньги.

   Здесь проверяется, что такие конверты никуда не доезжают, а общими
   остаются только кампании — они и должны быть видны всем.

   Тест поднимает свой сервер и гасит его в конце.
   Запуск: node test-forge.mjs */

import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = 8093;
const BASE = process.env.BP_TEST_BASE_FORGE || ('http://127.0.0.1:' + PORT);

let passed = 0, failed = 0;
function ok(c, name, extra) {
  if (c) { passed++; console.log('  ok  ' + name); }
  else { failed++; console.log('  FAIL ' + name + (extra ? '  ← ' + JSON.stringify(extra) : '')); }
}

const dir = mkdtempSync(path.join(tmpdir(), 'bp-forge-'));
const srv = spawn(process.execPath, ['server.js'], {
  cwd: fileURLToPath(new URL('.', import.meta.url)),
  env: {
    ...process.env,
    PORT: String(PORT),
    DB_PATH: path.join(dir, 'db.sqlite'),
    ADMIN_KEY: 'ключ-проверки',
    PUBLIC_URL: BASE,
    BOT_TOKEN: '', ADMIN_CHAT_ID: '', RESEND_API_KEY: '',
  },
  stdio: 'ignore',
});

async function api(method, p, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const r = await fetch(BASE + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const txt = await r.text();
  let j = {}; try { j = JSON.parse(txt); } catch (e) { j = { _text: txt }; }
  return { status: r.status, body: j };
}
async function waitUp() {
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) return true; } catch (e) { /* поднимается */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}
const reg = (email, role) => api('POST', '/api/register',
  { email, name: 'Кто-то', role, password: 'пароль-подлиннее' });
const rows = (pull) => (pull.body && pull.body.rows) || [];

try {
  if (!await waitUp()) { console.log('сервер не поднялся'); srv.kill(); process.exit(1); }

  console.log('Подлог конвертов: что видит посторонний\n');

  const adv = (await reg('zakazchik@t.ru', 'advertiser')).body;
  const blg = (await reg('bloger@t.ru', 'blogger')).body;
  const bad = (await reg('postoronniy@t.ru', 'blogger')).body;
  ok(!!adv.token && !!blg.token && !!bad.token, 'три аккаунта заведены');

  /* ── Обычная работа не сломана ── */
  const req = await api('POST', '/api/sync/put',
    { kind: 'req', rid: 'req-1', to: blg.user.id, data: { id: 'req-1', budget: 30000 } }, adv.token);
  ok(req.status === 200, 'заявка адресату положена', req.body);
  ok(rows(await api('GET', '/api/sync/pull?since=0', null, blg.token)).length === 1,
    'блогер видит адресованную ему заявку');

  const camp = await api('POST', '/api/sync/put',
    { kind: 'camp', rid: 'camp-1', data: { id: 'camp-1', title: 'Кампания' } }, adv.token);
  ok(camp.status === 200 && camp.body.b === null, 'кампания положена общим конвертом', camp.body);
  const forAll = rows(await api('GET', '/api/sync/pull?since=0', null, bad.token));
  ok(forAll.length === 1 && forAll[0].kind === 'camp',
    'посторонний видит кампанию — и только её', forAll.map((r) => r.kind));

  /* ── Подлог ── */
  const fakeMsg = await api('POST', '/api/sync/put', {
    kind: 'msg', rid: 'req-1.9',
    data: { dealId: 'req-1', m: { senderId: '#srv:' + adv.user.id, text: 'Пришлите номер карты' } },
  }, bad.token);
  const seenByBlogger = rows(await api('GET', '/api/sync/pull?since=0', null, blg.token));
  ok(!seenByBlogger.some((r) => r.kind === 'msg'),
    'подложное сообщение в чужую сделку до блогера не доезжает',
    { положено: fakeMsg.status, доехало: seenByBlogger.map((r) => r.kind) });
  ok(!rows(await api('GET', '/api/sync/pull?since=0', null, adv.token)).some((r) => r.kind === 'msg'),
    'и до заказчика тоже');

  const fakeReq = await api('POST', '/api/sync/put', {
    kind: 'req', rid: 'podlog-1',
    data: { id: 'podlog-1', dealId: 'podlog-1', budget: 50000,
      fromAdvertiserId: '#srv:' + adv.user.id, toBloggerId: '#srv:' + bad.user.id },
  }, bad.token);
  const advSees = rows(await api('GET', '/api/sync/pull?since=0', null, adv.token));
  ok(!advSees.some((r) => r.rid === 'podlog-1'),
    'подложная заявка «платите вы» до заказчика не доезжает',
    { положено: fakeReq.status, доехало: advSees.map((r) => r.rid) });

  /* Чужой конверт нельзя и переписать. */
  const steal = await api('POST', '/api/sync/put',
    { kind: 'req', rid: 'req-1', to: bad.user.id, data: { id: 'req-1', budget: 1 } }, bad.token);
  ok(steal.status === 403, 'чужой конверт посторонний не переписывает', steal.body);

  /* Свои конверты продолжают ходить в обе стороны. */
  const answer = await api('POST', '/api/sync/put',
    { kind: 'msg', rid: 'req-1.1', to: adv.user.id, data: { dealId: 'req-1', m: { text: 'Беру' } } }, blg.token);
  ok(answer.status === 200, 'блогер отвечает заказчику', answer.body);
  ok(rows(await api('GET', '/api/sync/pull?since=0', null, adv.token)).some((r) => r.kind === 'msg'),
    'заказчик получил ответ блогера');
} catch (e) {
  failed++;
  console.log('  FAIL неожиданная ошибка: ' + (e && e.message));
} finally {
  try { srv.kill(); } catch (e) { /* уже мёртв */ }
}

console.log('\nИтого: ' + passed + ' ok, ' + failed + ' FAIL');
process.exit(failed ? 1 : 0);
