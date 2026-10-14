/* Дыры, найденные разбором 06.09.2026, и заплаты на них.
   Каждая проверка здесь — про конкретный ход, которым раньше уводили
   деньги или чужие данные. Если набор покраснел, дыру открыли заново.

   Запуск: node test-audit.mjs (сервер должен работать на 8090).
   Свой порт: BP_TEST_BASE=http://127.0.0.1:8091 node test-audit.mjs */

import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const BASE = process.env.BP_TEST_BASE || 'http://127.0.0.1:8090';
const ADMIN_KEY = /ADMIN_KEY=(\S+)/.exec(readFileSync(new URL('./.env', import.meta.url), 'utf8'))[1];

let passed = 0, failed = 0;
function ok(c, name, extra) {
  if (c) { passed++; console.log('  ok  ' + name); }
  else { failed++; console.log('  FAIL ' + name + (extra ? '  ← ' + JSON.stringify(extra).slice(0, 240) : '')); }
}
async function api(method, path, body, token, key) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  if (key) headers['X-Admin-Key'] = key;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let b = {}; try { b = await res.json(); } catch (e) { b = {}; }
  return { status: res.status, body: b };
}
const tag = 'a' + Date.now().toString(36);
async function reg(who, role) {
  const r = await api('POST', '/api/register',
    { email: who + tag + '@t.ru', name: who, role, password: 'парольДлинный12' });
  return { token: r.body.token, id: r.body.user && r.body.user.id };
}

console.log('\nЗаплаты после разбора');

const A = await reg('adv', 'advertiser');      /* рекламодатель  */
const B = await reg('blg', 'blogger');         /* блогер         */
const C = await reg('out', 'blogger');         /* посторонний    */

/* ══ 1. Спор снимает только тот, кто его открыл ══════════════════════
   Было: право давалось и плательщику. Рекламодатель снимал спор блогера
   и тут же забирал весь эскроу возвратом — замок снимала ровно та
   сторона, от которой он защищает. */
console.log('\n  Спор: замок снимает только повесивший');
await api('POST', '/api/topup', { amount: 100000, opKey: randomUUID() }, A.token);
const deal = 'd-' + tag;
const hold = await api('POST', '/api/deals/hold',
  { dealId: deal, amount: 100000, payeeId: B.id, opKey: randomUUID() }, A.token);
ok(hold.status === 200, 'бюджет сделки заморожен', hold.body);

const opened = await api('POST', '/api/deals/dispute/open', { dealId: deal, reason: 'работа сдана' }, B.token);
ok(opened.status === 200, 'блогер открыл спор по своей выплате', opened.body);

const closeByPayer = await api('POST', '/api/deals/dispute/close', { dealId: deal }, A.token);
ok(closeByPayer.status === 403, 'ПЛАТЕЛЬЩИК чужой спор не снимает', closeByPayer.body);

const closeByOther = await api('POST', '/api/deals/dispute/close', { dealId: deal }, C.token);
ok(closeByOther.status === 403 || (closeByOther.body && closeByOther.body.closed === 0),
  'посторонний чужой спор не снимает', closeByOther.body);

const refund = await api('POST', '/api/deals/refund', { dealId: deal, opKey: randomUUID() }, A.token);
ok(refund.status === 409, 'возврат по-прежнему заперт спором', refund.body);

const balB = await api('GET', '/api/balance', null, B.token);
const balA = await api('GET', '/api/balance', null, A.token);
ok(balA.body.hold === 100000, 'деньги остались в заморозке, а не вернулись плательщику', balA.body);
ok(balB.body.available === 0 && balB.body.hold === 0, 'блогеру ничего не начислено раньше времени', balB.body);

const closeByOpener = await api('POST', '/api/deals/dispute/close', { dealId: deal }, B.token);
ok(closeByOpener.status === 200 && closeByOpener.body.closed === 1, 'открывший снимает свой спор', closeByOpener.body);

/* Оператор снимает любой спор — иначе тупик, когда человек пропал. */
const deal2 = 'd2-' + tag;
await api('POST', '/api/topup', { amount: 5000, opKey: randomUUID() }, A.token);
await api('POST', '/api/deals/hold', { dealId: deal2, amount: 5000, payeeId: B.id, opKey: randomUUID() }, A.token);
await api('POST', '/api/deals/dispute/open', { dealId: deal2, reason: 'спор' }, B.token);
const byAdmin = await api('POST', '/api/deals/dispute/close', { dealId: deal2 }, null, ADMIN_KEY);
ok(byAdmin.status === 200 && byAdmin.body.closed === 1, 'оператор снимает любой спор', byAdmin.body);

/* ══ 2. Личный конверт — «письмо себе» ══════════════════════════════
   Было: конверт любого вида можно было адресовать кому угодно, а
   приложение применяет виды prof/mine/slot к данным ПОЛУЧАТЕЛЯ, не
   спрашивая отправителя. Посторонний переписывал чужой профиль. */
console.log('\n  Конверты: личное — только о себе');

const intoOther = await api('POST', '/api/sync/put',
  { kind: 'prof', rid: 'self:' + B.id, to: B.id, data: { val: { name: 'ВЗЛОМАНО' }, at: { name: 9e12 } } }, C.token);
ok(intoOther.status === 403, 'чужой профиль переписать нельзя', intoOther.body);

const pulled = await api('GET', '/api/sync/pull?since=0', null, B.token);
const profRows = (pulled.body.rows || []).filter((r) => r.kind === 'prof');
ok(profRows.length === 0, 'подложный профиль до человека не доехал', profRows[0]);

const squatRid = await api('POST', '/api/sync/put',
  { kind: 'prof', rid: 'self:' + B.id, data: { val: {}, at: {} } }, C.token);
ok(squatRid.status === 403, 'чужое имя личной записи занять нельзя', squatRid.body);

const mineToOther = await api('POST', '/api/sync/put',
  { kind: 'mine', rid: 'self:' + C.id, to: B.id, data: { v: 1, favs: [] } }, C.token);
ok(mineToOther.status === 400, 'у личной записи не бывает адресата', mineToOther.body);

const own = await api('POST', '/api/sync/put',
  { kind: 'prof', rid: 'self:' + C.id, data: { val: { name: 'Своё' }, at: { name: 1 } } }, C.token);
ok(own.status === 200, 'свою личную запись вести можно', own.body);

/* Обычные конверты между двумя людьми работают как работали. */
const pair = await api('POST', '/api/sync/put',
  { kind: 'req', rid: 'r-' + tag, to: B.id, data: { id: 'r-' + tag, budget: 1000 } }, A.token);
ok(pair.status === 200, 'заявка второй стороне уходит по-прежнему', pair.body);

/* ══ 3. Бюджет кампании занимает только её хозяин ════════════════════
   Было: эскроу кампании называется camp:<номер>, а номер открыто отдаёт
   витрина заданий. Посторонний занимал имя заморозкой в рубль, и
   рекламодатель больше не мог запустить свою кампанию. */
console.log('\n  Кампания: чужой бюджет не занять');

const campId = 'c-' + tag;
const camp = await api('POST', '/api/sync/put',
  { kind: 'camp', rid: campId, data: { id: campId, title: 'Кампания', status: 'active' } }, A.token);
ok(camp.status === 200, 'рекламодатель опубликовал кампанию', camp.body);

await api('POST', '/api/topup', { amount: 1000, opKey: randomUUID() }, C.token);
const squat = await api('POST', '/api/deals/hold',
  { dealId: 'camp:' + campId, amount: 1, opKey: randomUUID() }, C.token);
ok(squat.status === 403, 'посторонний имя бюджета кампании не занимает', squat.body);

await api('POST', '/api/topup', { amount: 50000, opKey: randomUUID() }, A.token);
/* бюджет задания + 7% комиссии сверху (14.10.2026) должны уместиться в 50 000 */
const real = await api('POST', '/api/deals/hold',
  { dealId: 'camp:' + campId, amount: 40000, opKey: randomUUID() }, A.token);
ok(real.status === 200, 'хозяин кампании замораживает бюджет', real.body);

/* ══ 4. Ключи кассы — служебное пространство ═════════════════════════
   Было: занять заранее ключ 'yk:<номер платежа>' мог кто угодно, и
   оплаченное пополнение потом «уже проведено» — деньги не приходили. */
console.log('\n  Ключи операций');
const ykKey = await api('POST', '/api/topup', { amount: 1000, opKey: 'yk:чужой-платёж' }, C.token);
ok(ykKey.status === 400, 'ключ из пространства yk: отклонён', ykKey.body);

console.log('\nИтого: ' + passed + ' ok, ' + failed + ' FAIL\n');
process.exit(failed ? 1 : 0);
