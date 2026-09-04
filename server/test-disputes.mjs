/* Решение споров: арбитр делит замороженные деньги между сторонами.
   Проверяем доли, округление, границы и защиту от повторного решения.
   Запуск: node test-disputes.mjs (сервер должен работать). */

import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

/* Адрес сервера можно подменить: BP_TEST_BASE=http://127.0.0.1:8091 npm test.
   Нужно, когда над проектом работают в две руки и порт 8090 занят чужим
   сервером — иначе проверки идут не по тому коду. */
const BASE = process.env.BP_TEST_BASE || 'http://127.0.0.1:8090';
const ADMIN_KEY = /ADMIN_KEY=(\S+)/.exec(readFileSync(new URL('./.env', import.meta.url), 'utf8'))[1];

let passed = 0, failed = 0;
function ok(c, name, extra) {
  if (c) { passed++; console.log('  ok  ' + name); }
  else { failed++; console.log('  FAIL ' + name + (extra ? '  ← ' + JSON.stringify(extra) : '')); }
}
async function api(m, p, b, t, admin) {
  const h = { 'Content-Type': 'application/json' };
  if (t) h.Authorization = 'Bearer ' + t;
  if (admin) h['X-Admin-Key'] = ADMIN_KEY;
  const r = await fetch(BASE + p, { method: m, headers: h, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, body: await r.json() };
}

const tag = Date.now();
console.log('\nСпоры: арбитр делит заморозку');

const adv = await api('POST', '/api/register', { email: `da${tag}@t.ru`, name: 'Заказчик', role: 'advertiser', password: 'парольЗ12345' });
const blg = await api('POST', '/api/register', { email: `db${tag}@t.ru`, name: 'Исполнитель', role: 'blogger', password: 'парольИ12345' });
const ADV = adv.body.token, BLG = blg.body.token, BLG_ID = blg.body.user.id;
await api('POST', '/api/topup', { amount: 100000, opKey: randomUUID() }, ADV);

/* Спор решён пополам */
const d1 = 'dis-' + tag + '-1';
await api('POST', '/api/deals/hold', { dealId: d1, amount: 30000, payeeId: BLG_ID, opKey: randomUUID() }, ADV);
const advBefore = (await api('GET', '/api/balance', null, ADV)).body.available;
const blgBefore = (await api('GET', '/api/balance', null, BLG)).body.available;

const s1 = await api('POST', '/api/deals/settle', { dealId: d1, bloggerShare: 50, opKey: randomUUID() }, null, true);
ok(s1.status === 200 && s1.body.исполнителю === 15000 && s1.body.плательщику === 15000, 'пополам: по 15 000 каждому', s1.body);

const advAfter = (await api('GET', '/api/balance', null, ADV)).body;
const blgAfter = (await api('GET', '/api/balance', null, BLG)).body.available;
ok(advAfter.available === advBefore + 15000 && advAfter.hold === 0, 'заказчику вернулась половина, заморозка пуста', advAfter);
ok(blgAfter === blgBefore + 15000, 'исполнителю досталась половина');

const again = await api('POST', '/api/deals/settle', { dealId: d1, bloggerShare: 100, opKey: randomUUID() }, null, true);
ok(again.status === 409, 'повторное решение по тому же спору отклонено');

/* Полностью в пользу заказчика */
const d2 = 'dis-' + tag + '-2';
await api('POST', '/api/deals/hold', { dealId: d2, amount: 9000, payeeId: BLG_ID, opKey: randomUUID() }, ADV);
const b2 = (await api('GET', '/api/balance', null, BLG)).body.available;
const s2 = await api('POST', '/api/deals/settle', { dealId: d2, bloggerShare: 0, opKey: randomUUID() }, null, true);
ok(s2.status === 200 && s2.body.исполнителю === 0 && s2.body.плательщику === 9000, 'ноль исполнителю — всё вернулось заказчику', s2.body);
ok((await api('GET', '/api/balance', null, BLG)).body.available === b2, 'исполнителю ничего не начислено');

/* Округление: сумма долей всегда равна заморозке, копейки не теряются */
const d3 = 'dis-' + tag + '-3';
await api('POST', '/api/deals/hold', { dealId: d3, amount: 10001, payeeId: BLG_ID, opKey: randomUUID() }, ADV);
const s3 = await api('POST', '/api/deals/settle', { dealId: d3, bloggerShare: 33, opKey: randomUUID() }, null, true);
ok(s3.status === 200 && (s3.body.исполнителю + s3.body.плательщику) === 10001,
   'доли сходятся ровно: ' + s3.body.исполнителю + ' + ' + s3.body.плательщику + ' = 10 001', s3.body);

/* Границы и права */
const d4 = 'dis-' + tag + '-4';
await api('POST', '/api/deals/hold', { dealId: d4, amount: 5000, payeeId: BLG_ID, opKey: randomUUID() }, ADV);
const bad1 = await api('POST', '/api/deals/settle', { dealId: d4, bloggerShare: 150, opKey: randomUUID() }, null, true);
ok(bad1.status === 400, 'доля больше 100 отклонена');
const bad2 = await api('POST', '/api/deals/settle', { dealId: d4, bloggerShare: -10, opKey: randomUUID() }, null, true);
ok(bad2.status === 400, 'отрицательная доля отклонена');
const bad3 = await api('POST', '/api/deals/settle', { dealId: d4, bloggerShare: 50, opKey: randomUUID() }, ADV);
ok(bad3.status === 403, 'сторона спора решать не может — только арбитр');
const bad4 = await api('POST', '/api/deals/settle', { dealId: d4, bloggerShare: 50, opKey: randomUUID() }, BLG);
ok(bad4.status === 403, 'вторая сторона тоже не может');

const stillHeld = (await api('GET', '/api/balance', null, ADV)).body.hold;
ok(stillHeld === 5000, 'после всех отказов деньги на месте, в заморозке', { stillHeld });

/* Спор по частично выплаченной заморозке делит ОСТАТОК */
const d5 = 'dis-' + tag + '-5';
await api('POST', '/api/deals/hold', { dealId: d5, amount: 20000, opKey: randomUUID() }, ADV);
await api('POST', '/api/deals/release', { dealId: d5, toUserId: BLG_ID, amount: 8000, opKey: randomUUID() }, ADV);
const s5 = await api('POST', '/api/deals/settle', { dealId: d5, bloggerShare: 100, toUserId: BLG_ID, opKey: randomUUID() }, null, true);
ok(s5.status === 200 && s5.body.разделено === 12000, 'делится остаток 12 000, а не вся сумма', s5.body);

console.log('\nИтого: ' + passed + ' прошло, ' + failed + ' упало');
process.exit(failed ? 1 : 0);
