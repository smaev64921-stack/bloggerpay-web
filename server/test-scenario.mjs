/* Прогон всей денежной цепочки по живому серверу.
   Не юнит-тесты, а сценарий из жизни: рекламодатель и блогер проходят
   сделку, вывод и все способы сломать кассу, которые нашёл аудит.
   Запуск: node test-scenario.mjs (сервер должен работать). */

import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const BASE = 'http://127.0.0.1:8090';
const ADMIN_KEY = /ADMIN_KEY=(\S+)/.exec(readFileSync(new URL('./.env', import.meta.url), 'utf8'))[1];

let passed = 0, failed = 0;
function ok(cond, name, extra) {
  if (cond) { passed++; console.log('  ok  ' + name); }
  else { failed++; console.log('  FAIL ' + name + (extra ? '  ← ' + JSON.stringify(extra) : '')); }
}

async function api(method, path, body, token, admin) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  if (admin) headers['X-Admin-Key'] = ADMIN_KEY;
  const res = await fetch(BASE + path, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}


/* Вывод теперь двухшаговый: первый запрос не двигает деньги, а шлёт код
   на почту. Чтобы сценарий проверял money-контур, а не почту, сервер для
   прогона поднимают с MAIL_DEBUG=1 — тогда код приходит прямо в ответе.
   Если почта не настроена вовсе, второй фактор пропускается сервером
   сам, и первый же запрос создаёт заявку — helper это тоже переживёт. */
async function withdraw(amount, requisites, token) {
  const first = await api('POST', '/api/withdraw', { amount, requisites, opKey: randomUUID() }, token);
  if (!(first.body && first.body.needCode)) return first;
  if (!first.body.devCode) {
    throw new Error('Вывод требует код, но сервер его не показал. Поднимите сервер с MAIL_DEBUG=1.');
  }
  return api('POST', '/api/withdraw',
    { amount, requisites, code: first.body.devCode, opKey: randomUUID() }, token);
}

const tag = Date.now();

/* База общая для всех прогонов, поэтому сверяем НЕ абсолютные суммы, а
   разницу: сколько денег прибавилось за этот прогон. Иначе тест ломается
   от любого соседнего сценария, хотя касса в порядке. */
const before = (await api('GET', '/api/admin/overview', null, null, true)).body;

console.log('\n1. Регистрация и вход');
const reg1 = await api('POST', '/api/register', { email: `adv${tag}@t.ru`, name: 'Рекламодатель', role: 'advertiser', password: 'парольП12345' });
ok(reg1.status === 200 && reg1.body.token, 'рекламодатель зарегистрирован', reg1.body);
const reg2 = await api('POST', '/api/register', { email: `blg${tag}@t.ru`, name: 'Блогер', role: 'blogger', password: 'парольБ12345' });
ok(reg2.status === 200, 'блогер зарегистрирован');
const ADV = reg1.body.token, BLG = reg2.body.token;
const ADV_ID = reg1.body.user.id, BLG_ID = reg2.body.user.id;

const dup = await api('POST', '/api/register', { email: `adv${tag}@t.ru`, name: 'Дубль', role: 'blogger', password: 'парольП12345' });
ok(dup.status === 409, 'повторный email отклонён');
const badPass = await api('POST', '/api/login', { email: `adv${tag}@t.ru`, password: 'не тот пароль' });
ok(badPass.status === 401, 'неверный пароль отклонён');
const noAuth = await api('GET', '/api/balance');
ok(noAuth.status === 401, 'баланс без входа закрыт');

console.log('\n2. Пополнение и идемпотентность');
const k1 = randomUUID();
const t1 = await api('POST', '/api/topup', { amount: 50000, opKey: k1 }, ADV);
ok(t1.status === 200 && t1.body.balance.available === 50000, 'пополнение 50 000', t1.body);
const t1r = await api('POST', '/api/topup', { amount: 50000, opKey: k1 }, ADV);
ok(t1r.status === 200 && t1r.body.repeated === true, 'повтор того же opKey не удваивает');
const b1 = await api('GET', '/api/balance', null, ADV);
ok(b1.body.available === 50000, 'после повтора по-прежнему 50 000', b1.body);
const steal = await api('POST', '/api/topup', { amount: 50000, opKey: k1 }, BLG);
ok(steal.status === 409, 'чужой opKey не отдаёт чужой результат');
const frac = await api('POST', '/api/topup', { amount: 10.5, opKey: randomUUID() }, ADV);
ok(frac.status === 400, 'дробная сумма отклонена');
const neg = await api('POST', '/api/topup', { amount: -100, opKey: randomUUID() }, ADV);
ok(neg.status === 400, 'отрицательная сумма отклонена');

console.log('\n3. Сделка: заморозка → выплата');
const deal1 = 'deal-' + tag + '-1';
const h1 = await api('POST', '/api/deals/hold', { dealId: deal1, amount: 30000, opKey: randomUUID() }, ADV);
ok(h1.status === 200 && h1.body.balance.available === 20000 && h1.body.balance.hold === 30000, 'заморозка 30 000', h1.body);
const hBig = await api('POST', '/api/deals/hold', { dealId: 'deal-' + tag + '-big', amount: 999999, opKey: randomUUID() }, ADV);
ok(hBig.status === 409, 'заморозка больше баланса отклонена', hBig.body);
const bAfterBig = await api('GET', '/api/balance', null, ADV);
ok(bAfterBig.body.available === 20000 && bAfterBig.body.hold === 30000, 'после отказа деньги не тронуты');

const relForeign = await api('POST', '/api/deals/release', { dealId: deal1, toUserId: BLG_ID, opKey: randomUUID() }, BLG);
ok(relForeign.status === 403, 'выплату подтверждает только плательщик');
const relSelf = await api('POST', '/api/deals/release', { dealId: deal1, toUserId: ADV_ID, opKey: randomUUID() }, ADV);
ok(relSelf.status === 400, 'себе выплатить нельзя');
const rel = await api('POST', '/api/deals/release', { dealId: deal1, toUserId: BLG_ID, opKey: randomUUID() }, ADV);
ok(rel.status === 200 && rel.body.paid === 30000, 'выплата блогеру прошла');
const relAgain = await api('POST', '/api/deals/release', { dealId: deal1, toUserId: BLG_ID, opKey: randomUUID() }, ADV);
ok(relAgain.status === 409, 'вторая выплата по той же сделке отклонена');
const bBlg = await api('GET', '/api/balance', null, BLG);
ok(bBlg.body.available === 30000, 'блогер получил ровно 30 000 (комиссия сделки 0%)', bBlg.body);

console.log('\n4. Сделка: заморозка → возврат');
const deal2 = 'deal-' + tag + '-2';
await api('POST', '/api/deals/hold', { dealId: deal2, amount: 10000, opKey: randomUUID() }, ADV);
const ref = await api('POST', '/api/deals/refund', { dealId: deal2, opKey: randomUUID() }, ADV);
ok(ref.status === 200 && ref.body.refunded === 10000, 'возврат плательщику');
const bAdv = await api('GET', '/api/balance', null, ADV);
ok(bAdv.body.available === 20000 && bAdv.body.hold === 0, 'после возврата: 20 000 доступно, 0 заморожено', bAdv.body);

console.log('\n5. Вывод: очередь → оператор');
/* с v100 вывод открыт только после проверки личности оператором */
const KYC_PHOTO = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';
const wdEarly = await withdraw(20000, 'карта', BLG);
ok(wdEarly.status === 403, 'вывод до проверки личности отклонён', wdEarly.body);
const kycSub = await api('POST', '/api/kyc/submit', { name: 'Блогер Тестовый Сценарный', birth: '01.01.1990', photo: KYC_PHOTO, selfie: KYC_PHOTO }, BLG);
await api('POST', '/api/admin/kyc/approve', { requestId: kycSub.body.requestId }, null, true);
const wd = await withdraw(20000, 'карта 2200 **** 1234', BLG);
ok(wd.status === 200 && wd.body.fee === 800 && wd.body.net === 19200, 'заявка: комиссия 4% = 800, к выплате 19 200', wd.body);
const wdId = wd.body.withdrawalId;
const wdOver = await withdraw(999999, 'карта', BLG);
ok(wdOver.status === 409, 'вывод больше баланса отклонён');

const list = await api('GET', '/api/admin/withdrawals?status=queued', null, null, true);
ok(list.status === 200 && list.body.rows.some(w => w.id === wdId), 'оператор видит заявку в реестре');
const noKey = await api('GET', '/api/admin/withdrawals');
ok(noKey.status === 403, 'реестр без ключа закрыт');

const take = await api('POST', '/api/admin/withdrawals/take', { withdrawalId: wdId }, null, true);
ok(take.status === 200, 'оператор взял в работу');
const cancelLate = await api('POST', '/api/withdraw/cancel', { withdrawalId: wdId, opKey: randomUUID() }, BLG);
ok(cancelLate.status === 409, 'отмена после взятия в работу отклонена (дыра «заплатите дважды» закрыта)');

const paid = await api('POST', '/api/admin/withdrawals/paid', { withdrawalId: wdId, opKey: randomUUID() }, null, true);
ok(paid.status === 200 && paid.body.status === 'paid', 'оператор отметил «выплачено»');
const paidAgain = await api('POST', '/api/admin/withdrawals/paid', { withdrawalId: wdId, opKey: randomUUID() }, null, true);
ok(paidAgain.status === 409, 'второе «выплачено» по той же заявке отклонено');
const bBlg2 = await api('GET', '/api/balance', null, BLG);
ok(bBlg2.body.available === 10000 && bBlg2.body.hold === 0, 'у блогера осталось 10 000, заморозки нет', bBlg2.body);

console.log('\n6. Отмена заявки, пока она в очереди');
const wd2 = await withdraw(5000, 'карта', BLG);
const cancel = await api('POST', '/api/withdraw/cancel', { withdrawalId: wd2.body.withdrawalId, opKey: randomUUID() }, BLG);
ok(cancel.status === 200 && cancel.body.status === 'cancelled', 'отмена из очереди прошла');
const bBlg3 = await api('GET', '/api/balance', null, BLG);
ok(bBlg3.body.available === 10000, 'деньги вернулись', bBlg3.body);

console.log('\n6б. Назначенный получатель и отказ второй стороны');
const dealP = 'deal-' + tag + '-p';
await api('POST', '/api/topup', { amount: 30000, opKey: randomUUID() }, ADV);
const hp = await api('POST', '/api/deals/hold', { dealId: dealP, amount: 12000, payeeId: BLG_ID, opKey: randomUUID() }, ADV);
ok(hp.status === 200 && hp.body.payeeId === BLG_ID, 'заморозка с назначенным получателем', hp.body);
const hpGhost = await api('POST', '/api/deals/hold', { dealId: 'deal-' + tag + '-ghost', amount: 1000, payeeId: 999999, opKey: randomUUID() }, ADV);
ok(hpGhost.status === 404, 'несуществующий получатель отклонён');
const hpSelf = await api('POST', '/api/deals/hold', { dealId: 'deal-' + tag + '-self', amount: 1000, payeeId: ADV_ID, opKey: randomUUID() }, ADV);
ok(hpSelf.status === 400, 'себя получателем назначить нельзя');

const reg3 = await api('POST', '/api/register', { email: 'x' + tag + '@t.ru', name: 'Чужой', role: 'blogger', password: 'парольЧ12345' });
const X_ID = reg3.body.user.id;
const swap = await api('POST', '/api/deals/release', { dealId: dealP, toUserId: X_ID, opKey: randomUUID() }, ADV);
ok(swap.status === 409, 'подмена получателя перед выплатой отклонена', swap.body);

const advBefore = (await api('GET', '/api/balance', null, ADV)).body.available;
const blgBefore = (await api('GET', '/api/balance', null, BLG)).body.available;
const refByPayee = await api('POST', '/api/deals/refund', { dealId: dealP, opKey: randomUUID() }, BLG);
ok(refByPayee.status === 200, 'исполнитель может отказаться от сделки', refByPayee.body);
const advAfter = (await api('GET', '/api/balance', null, ADV)).body.available;
const blgAfter = (await api('GET', '/api/balance', null, BLG)).body.available;
ok(advAfter === advBefore + 12000, 'деньги вернулись ПЛАТЕЛЬЩИКУ');
ok(blgAfter === blgBefore, 'исполнителю при отказе не досталось ничего');

const dealQ = 'deal-' + tag + '-q';
await api('POST', '/api/deals/hold', { dealId: dealQ, amount: 5000, payeeId: BLG_ID, opKey: randomUUID() }, ADV);
const refStranger = await api('POST', '/api/deals/refund', { dealId: dealQ, opKey: randomUUID() }, reg3.body.token);
ok(refStranger.status === 403, 'посторонний вернуть чужую сделку не может');

console.log('\n7. Сводка и сверка');
const ov = await api('GET', '/api/admin/overview', null, null, true);
ok(ov.status === 200, 'сводка оператора открылась', ov.body);
/* Сверка: в системе должно остаться пополнение минус ушедшее наружу.
   50 000 внесли, 19 200 ушло блогеру на карту, 800 — доход платформы:
   50 000 − 19 200 = 30 800 (из них 800 на счёте платформы). */
/* Сверка после всех сценариев: в заморозке осталась ровно одна сделка
   (dealQ, 5 000), всё остальное закрыто. Общая сумма = внесено минус
   выплачено наружу. */
const holdDelta = ov.body.всего_в_системе.hold - before.всего_в_системе.hold;
ok(holdDelta === 5000, 'в заморозке прибавилась ровно незакрытая сделка на 5 000', { holdDelta });

/* За прогон внесено 80 000, наружу ушло 19 200 (выплата блогеру на карту).
   Комиссия 800 осталась внутри, на счету платформы, — она часть системы. */
const sumBefore = before.всего_в_системе.available + before.всего_в_системе.hold;
const sumAfter = ov.body.всего_в_системе.available + ov.body.всего_в_системе.hold;
ok(sumAfter - sumBefore === 80000 - 19200,
   'журнал сходится: прибавилось ' + (sumAfter - sumBefore) + ' = внесено 80 000 − выплачено наружу 19 200',
   { sumBefore, sumAfter });

const feeDelta = ov.body.доход_платформы - before.доход_платформы;
ok(feeDelta === 800, 'доход платформы вырос ровно на одну комиссию 800', { feeDelta });

console.log('\nИтого: ' + passed + ' прошло, ' + failed + ' упало');
process.exit(failed ? 1 : 0);
