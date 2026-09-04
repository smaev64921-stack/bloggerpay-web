/* Бюджет кампании делится между несколькими блогерами.
   Проверяем: частичные выплаты, остаток, возврат остатка, перерасход.
   Запуск: node test-partial.mjs (сервер должен работать). */

import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

/* Адрес сервера можно подменить: BP_TEST_BASE=http://127.0.0.1:8091 npm test.
   Нужно, когда над проектом работают в две руки и порт 8090 занят чужим
   сервером — иначе проверки идут не по тому коду. */
const BASE = process.env.BP_TEST_BASE || 'http://127.0.0.1:8090';
let passed = 0, failed = 0;
function ok(c, name, extra) {
  if (c) { passed++; console.log('  ok  ' + name); }
  else { failed++; console.log('  FAIL ' + name + (extra ? '  ← ' + JSON.stringify(extra) : '')); }
}
async function api(m, p, b, t) {
  const h = { 'Content-Type': 'application/json' };
  if (t) h.Authorization = 'Bearer ' + t;
  const r = await fetch(BASE + p, { method: m, headers: h, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, body: await r.json() };
}

const tag = Date.now();
console.log('\nБюджет кампании на нескольких блогеров');

const adv = await api('POST', '/api/register', { email: `ca${tag}@t.ru`, name: 'Кампания', role: 'advertiser', password: 'парольК12345' });
const ADV = adv.body.token;
const b1 = await api('POST', '/api/register', { email: `c1${tag}@t.ru`, name: 'Блогер 1', role: 'blogger', password: 'парольБ12345' });
const b2 = await api('POST', '/api/register', { email: `c2${tag}@t.ru`, name: 'Блогер 2', role: 'blogger', password: 'парольБ12345' });
const B1 = b1.body.user.id, B2 = b2.body.user.id;

await api('POST', '/api/topup', { amount: 100000, opKey: randomUUID() }, ADV);

/* Бюджет кампании замораживаем БЕЗ назначенного получателя — платить будем разным */
const camp = 'camp-' + tag;
const hold = await api('POST', '/api/deals/hold', { dealId: camp, amount: 60000, opKey: randomUUID() }, ADV);
ok(hold.status === 200 && hold.body.balance.hold === 60000, 'бюджет кампании заморожен: 60 000', hold.body);

const p1 = await api('POST', '/api/deals/release', { dealId: camp, toUserId: B1, amount: 20000, opKey: randomUUID() }, ADV);
ok(p1.status === 200 && p1.body.paid === 20000 && p1.body.left === 40000 && p1.body.closed === false,
   'первому блогеру 20 000, осталось 40 000', p1.body);

const p2 = await api('POST', '/api/deals/release', { dealId: camp, toUserId: B2, amount: 15000, opKey: randomUUID() }, ADV);
ok(p2.status === 200 && p2.body.left === 25000, 'второму 15 000, осталось 25 000', p2.body);

const over = await api('POST', '/api/deals/release', { dealId: camp, toUserId: B1, amount: 99000, opKey: randomUUID() }, ADV);
ok(over.status === 409, 'выплата больше остатка отклонена', over.body);

const zero = await api('POST', '/api/deals/release', { dealId: camp, toUserId: B1, amount: 0, opKey: randomUUID() }, ADV);
ok(zero.status === 400, 'нулевая выплата отклонена');

const bal1 = await api('GET', '/api/balance', null, b1.body.token);
const bal2 = await api('GET', '/api/balance', null, b2.body.token);
ok(bal1.body.available === 20000 && bal2.body.available === 15000, 'у блогеров ровно их суммы', { bal1: bal1.body, bal2: bal2.body });

/* Кампанию закрыли — остаток возвращается рекламодателю, а не «сгорает» */
const advBefore = (await api('GET', '/api/balance', null, ADV)).body;
const ref = await api('POST', '/api/deals/refund', { dealId: camp, opKey: randomUUID() }, ADV);
ok(ref.status === 200 && ref.body.refunded === 25000, 'возвращён остаток 25 000, а не весь бюджет', ref.body);
const advAfter = (await api('GET', '/api/balance', null, ADV)).body;
ok(advAfter.available === advBefore.available + 25000 && advAfter.hold === 0,
   'остаток вернулся рекламодателю, заморозка пуста', advAfter);

const refAgain = await api('POST', '/api/deals/refund', { dealId: camp, opKey: randomUUID() }, ADV);
ok(refAgain.status === 409, 'повторный возврат отклонён');

/* Обычная сделка: сумму не указываем — уходит всё, сделка закрывается */
const one = 'one-' + tag;
await api('POST', '/api/deals/hold', { dealId: one, amount: 8000, payeeId: B1, opKey: randomUUID() }, ADV);
const full = await api('POST', '/api/deals/release', { dealId: one, toUserId: B1, opKey: randomUUID() }, ADV);
ok(full.status === 200 && full.body.paid === 8000 && full.body.closed === true, 'обычная сделка платится целиком', full.body);
const после = await api('POST', '/api/deals/release', { dealId: one, toUserId: B1, amount: 1, opKey: randomUUID() }, ADV);
ok(после.status === 409, 'после закрытия платить нельзя');

console.log('\nИтого: ' + passed + ' прошло, ' + failed + ' упало');
process.exit(failed ? 1 : 0);
