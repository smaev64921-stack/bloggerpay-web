/* Рейтинг блогеров: публичная ручка без денег.
   Поднимает СВОЙ сервер на 8097 с тестовым пополнением, проводит две
   сделки на одного блогера и одну на другого, проверяет порядок, счётчики,
   своё место и что чужие суммы наружу не уходят.
   Запуск: node test-leaderboard.mjs */

import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const PORT = 8097;
const BASE = 'http://127.0.0.1:' + PORT;
let passed = 0, failed = 0;
function ok(c, name, extra) {
  if (c) { passed++; console.log('  ok  ' + name); }
  else { failed++; console.log('  FAIL ' + name + (extra ? '  ← ' + JSON.stringify(extra) : '')); }
}
async function api(method, p, body, token, admin) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  if (admin) headers['X-Admin-Key'] = 'test-key';
  const r = await fetch(BASE + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const txt = await r.text();
  let j = {}; try { j = JSON.parse(txt); } catch (e) { j = { _raw: txt }; }
  return { status: r.status, body: j };
}
const dir = mkdtempSync(path.join(tmpdir(), 'bp-lb-'));
const srv = spawn(process.execPath, ['server.js'], {
  cwd: fileURLToPath(new URL('.', import.meta.url)),
  env: { ...process.env, PORT: String(PORT), DB_PATH: path.join(dir, 'db.sqlite'), ADMIN_KEY: 'test-key',
    TEST_TOPUP: '1', YOOKASSA_SHOP_ID: '', YOOKASSA_SECRET_KEY: '', BOT_TOKEN: '', ADMIN_CHAT_ID: '' },
  stdio: 'ignore',
});
async function waitUp() {
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) return true; } catch (e) {}
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}
async function reg(tag, role) {
  const r = await api('POST', '/api/register', { email: `lb${tag}@t.ru`, name: 'Юзер ' + tag, role, password: 'парольВ12345' });
  return { token: r.body.token, id: r.body.user && r.body.user.id };
}
try {
  console.log('\nРейтинг блогеров');
  ok(await waitUp(), 'сервер поднялся');
  const empty = await api('GET', '/api/leaderboard');
  ok(empty.status === 200 && Array.isArray(empty.body.rows) && empty.body.rows.length === 0 && empty.body.me === null, 'пустой рейтинг без входа', empty.body);

  const tag = Date.now();
  const adv = await reg('a' + tag, 'advertiser');
  const b1 = await reg('b1' + tag, 'blogger');
  const b2 = await reg('b2' + tag, 'blogger');
  ok(adv.token && b1.token && b2.token, 'три пользователя зарегистрированы');

  const top = await api('POST', '/api/topup', { amount: 90000, opKey: randomUUID() }, adv.token);
  ok(top.status === 200, 'тестовое пополнение', top.body);
  async function deal(id, amount, to) {
    const h = await api('POST', '/api/deals/hold', { dealId: id, amount, payeeId: to, opKey: randomUUID() }, adv.token);
    const r = await api('POST', '/api/deals/release', { dealId: id, toUserId: to, opKey: randomUUID() }, adv.token);
    return h.status === 200 && r.status === 200;
  }
  ok(await deal('lb-d1-' + tag, 10000, b1.id), 'сделка 1 → блогер 1');
  ok(await deal('lb-d2-' + tag, 10000, b1.id), 'сделка 2 → блогер 1');
  ok(await deal('lb-d3-' + tag, 10000, b2.id), 'сделка 3 → блогер 2');
  /* бюджет кампании: одна заморозка, две выплаты разным людям */
  const camp = 'camp:lb-' + tag;
  const hc = await api('POST', '/api/deals/hold', { dealId: camp, amount: 20000, opKey: randomUUID() }, adv.token);
  const r1 = await api('POST', '/api/deals/release', { dealId: camp, toUserId: b2.id, amount: 5000, opKey: randomUUID() }, adv.token);
  const r2 = await api('POST', '/api/deals/release', { dealId: camp, toUserId: b1.id, amount: 5000, opKey: randomUUID() }, adv.token);
  ok(hc.status === 200 && r1.status === 200 && r2.status === 200, 'кампания: две частичные выплаты', { hc: hc.body, r1: r1.body, r2: r2.body });

  const lb = await api('GET', '/api/leaderboard');
  ok(lb.status === 200, 'рейтинг отвечает без входа');
  const rows = lb.body.rows || [];
  ok(rows.length === 2, 'в рейтинге два блогера', rows);
  ok(rows[0] && rows[0].id === b1.id && rows[0].deals === 3, 'первый — блогер 1 с тремя выплатами', rows[0]);
  ok(rows[1] && rows[1].id === b2.id && rows[1].deals === 2, 'второй — блогер 2 с двумя', rows[1]);
  ok(rows.every((r) => !('amount' in r) && !('earned' in r) && !('email' in r)), 'ни сумм, ни почты наружу');
  ok(lb.body.total === 2, 'total = 2', lb.body.total);
  ok(lb.body.me === null, 'без входа своего места нет');

  const mine = await api('GET', '/api/leaderboard', null, b2.token);
  ok(mine.body.me && mine.body.me.place === 2 && mine.body.me.deals === 2, 'блогер 2 видит своё второе место', mine.body.me);
  const none = await api('GET', '/api/leaderboard', null, adv.token);
  ok(none.body.me && none.body.me.place === 0 && none.body.me.deals === 0, 'рекламодатель без выплат — место 0', none.body.me);

  /* кэш живёт минуту, но новая выплата сбрасывает его сразу */
  ok(await deal('lb-d4-' + tag, 10000, b2.id), 'сделка 4 → блогер 2');
  const fresh = await api('GET', '/api/leaderboard', null, b2.token);
  const r2b = (fresh.body.rows || []).find((r) => r.id === b2.id) || {};
  ok(r2b.deals === 3, 'после выплаты список свежий', fresh.body.rows);
  ok(fresh.body.me.deals === 3 && fresh.body.me.place === 2, 'при равенстве место совпадает с местом в списке', fresh.body.me);
  const again = await api('GET', '/api/leaderboard');
  ok(JSON.stringify(again.body.rows) === JSON.stringify(fresh.body.rows), 'повторный запрос — из кэша, тот же список');

  /* раунды одной кампании — это ОДНА сделка, а не три */
  const camp2 = 'camp:rounds-' + tag;
  await api('POST', '/api/topup', { amount: 30000, opKey: randomUUID() }, adv.token);
  await api('POST', '/api/deals/hold', { dealId: camp2, amount: 9000, opKey: randomUUID() }, adv.token);
  for (let i = 0; i < 3; i++) {
    await api('POST', '/api/deals/release', { dealId: camp2, toUserId: b1.id, amount: 3000, opKey: randomUUID() }, adv.token);
  }
  const rounds = await api('GET', '/api/leaderboard', null, b1.token);
  ok(rounds.body.me.deals === 4, 'три раунда одной кампании = одна сделка (3 + 1)', rounds.body.me);

  /* делёж арбитра: блогер получил деньги — сделка закрыта и она в рейтинге */
  const b3 = await reg('b3' + tag, 'blogger');
  const dis = 'lb-dis-' + tag;
  await api('POST', '/api/topup', { amount: 10000, opKey: randomUUID() }, adv.token);
  const hd = await api('POST', '/api/deals/hold', { dealId: dis, amount: 4000, payeeId: b3.id, opKey: randomUUID() }, adv.token);
  const st = await api('POST', '/api/deals/settle', { dealId: dis, bloggerShare: 100, opKey: randomUUID() }, null, true);
  ok(hd.status === 200 && st.status === 200, 'арбитр отдал сделку блогеру 3', { hd: hd.body, st: st.body });
  const bal3 = await api('GET', '/api/balance', null, b3.token);
  const lb3 = await api('GET', '/api/leaderboard', null, b3.token);
  ok(Number(bal3.body.available) === 4000, 'деньги у блогера 3 на счету', bal3.body);
  ok(lb3.body.me.deals === 1 && lb3.body.me.place > 0, 'делёж арбитра посчитан в рейтинге', lb3.body.me);
  ok((lb3.body.rows || []).some((r) => r.id === b3.id), 'блогер 3 появился в списке', lb3.body.rows);

  /* выплата по спору — тоже выполненная работа */
  const dsp = 'lb-d5-' + tag;
  await api('POST', '/api/deals/hold', { dealId: dsp, amount: 10000, payeeId: b1.id, opKey: randomUUID() }, adv.token);
  const settled = await api('POST', '/api/deals/settle', { dealId: dsp, bloggerShare: 60, opKey: randomUUID() }, null, true);
  ok(settled.status === 200, 'арбитр разделил спорную сделку', settled.body);
  const afterD = await api('GET', '/api/leaderboard', null, b1.token);
  ok(afterD.body.me.deals === 5, 'выплата по спору попала в счётчик', afterD.body.me);
} catch (e) {
  failed++; console.log('  FAIL исключение: ' + e.message);
} finally {
  srv.kill();
}
console.log(`\nИтого: ${passed} ok, ${failed} FAIL\n`);
process.exit(failed ? 1 : 0);
