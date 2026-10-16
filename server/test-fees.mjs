/* Комиссии сервиса (14.10.2026, решение владельца):
   · пополнение — 7% СВЕРХУ: на баланс ровно сумма, комиссия — сервису;
   · задание — 7% сверху бюджета с рекламодателя (возвращается за
     неистраченный остаток) и 7% с каждой выплаты блогеру (по накопленному,
     без дрейфа округления);
   · вывод — без комиссии (было 4%);
   · сверка денег сходится, доход сервиса = сумма всех комиссий.
   Свой сервер на 8478 со ставками по умолчанию (как на бою).
   Запуск: node test-fees.mjs */

import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = 8478;
const BASE = 'http://127.0.0.1:' + PORT;
const KEY = 'test-fees-key';
const PIX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';
let passed = 0, failed = 0;
function ok(c, name, extra) {
  if (c) { passed++; console.log('  ok  ' + name); }
  else { failed++; console.log('  FAIL ' + name + (extra !== undefined ? '  ← ' + JSON.stringify(extra).slice(0, 400) : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CWD = fileURLToPath(new URL('.', import.meta.url));
const dir = mkdtempSync(path.join(tmpdir(), 'bp-fees-'));
/* ставки НЕ задаём — должны взяться значения по умолчанию (7/7/7, вывод 0) */
const env = { ...process.env };
for (const k of ['TOPUP_FEE_PCT', 'TASK_FEE_PCT', 'PAYOUT_FEE_PCT', 'WITHDRAW_FEE_PCT']) delete env[k];
const srv = spawn(process.execPath, ['server.js'], {
  cwd: CWD,
  env: {
    ...env, PORT: String(PORT), DB_PATH: path.join(dir, 'db.sqlite'), PUBLIC_URL: BASE, APP_URL: BASE + '/',
    ADMIN_KEY: KEY, ADMIN_EMAIL: '', BOT_TOKEN: '', ADMIN_CHAT_ID: '', RESEND_API_KEY: '',
    YOOKASSA_SHOP_ID: '', YOOKASSA_SECRET_KEY: '', TEST_TOPUP: '1', TEST_TOPUP_OPEN: '1', INVOICE_MIN: '10000',
  },
  stdio: process.env.BP_DEBUG ? 'inherit' : 'ignore',
});
async function api(method, p, body, token, admin) {
  const h = { 'Content-Type': 'application/json' };
  if (token) h.Authorization = 'Bearer ' + token;
  if (admin) h['X-Admin-Key'] = KEY;
  const r = await fetch(BASE + p, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const txt = await r.text();
  let j = {}; try { j = JSON.parse(txt); } catch (e) { j = { _raw: txt.slice(0, 200) }; }
  return { status: r.status, body: j };
}
for (let i = 0; i < 100; i++) { try { const r = await fetch(BASE + '/api/health'); await r.text(); if (r.ok) break; } catch (e) {} await sleep(120); }

const tag = Date.now().toString(36);
const PASS = 'пароль-подлиннее-12';
let n = 0;
const op = (k) => 'fee-' + tag + '-' + k + '-' + (++n);
async function reg(name, role) {
  const r = await api('POST', '/api/register', { email: name + tag + '@t.ru', name, role, password: PASS });
  return r.body.token;
}
const bal = async (t) => (await api('GET', '/api/balance', null, t)).body;
const overview = async () => (await api('GET', '/api/admin/overview', null, null, true)).body;
const ADV = await reg('adv', 'advertiser');
const BLG = await reg('blg', 'blogger');
const BLG2 = await reg('blgb', 'blogger');
ok(ADV && BLG && BLG2, 'заведены рекламодатель и два блогера');
const me = async (t) => (await api('GET', '/api/me', null, t)).body.user || {};
const blgId = (await me(BLG)).id, blg2Id = (await me(BLG2)).id;

/* ── 1 · ставки наружу ── */
const cfg = (await api('GET', '/api/pay/config', null, ADV)).body;
ok(cfg.topupFeePct === 7 && cfg.taskFeePct === 7 && cfg.payoutFeePct === 7 && cfg.withdrawFeePct === 0,
  '/api/pay/config: пополнение 7%, задание 7%, выплаты 7%, вывод 0%', cfg);

/* ── 2 · пополнение: на баланс ровно сумма, 7% сверху — сервису ── */
const t1 = await api('POST', '/api/topup', { amount: 10000, opKey: op('top') }, ADV);
ok(t1.status === 200 && t1.body.amount === 10000 && t1.body.fee === 700 && t1.body.total === 10700, 'пополнение 10 000 ₽: комиссия 700 ₽, к оплате 10 700 ₽', t1.body);
let b = await bal(ADV);
ok(b.available === 10000 && b.hold === 0, 'на баланс пришло ровно 10 000 ₽', b);
let ov = await overview();
ok(ov.доход_платформы === 700 && ov.внесено_всего === 10700 && ov.сверка.сходится, 'доход сервиса 700 ₽, внесено 10 700 ₽, сверка сходится', ov);
const led1 = (await api('GET', '/api/ledger', null, ADV)).body.rows || [];
ok(led1.length === 1 && led1[0].kind === 'topup' && led1[0].amount === 10000 && /оплачено 10700, комиссия 700/.test(led1[0].ref || ''),
  'в истории одна строка пополнения +10 000 ₽ с пометкой «оплачено 10700, комиссия 700»', led1);
await api('POST', '/api/topup', { amount: 50000, opKey: op('top') }, ADV);
b = await bal(ADV);
ok(b.available === 60000, 'второе пополнение 50 000 ₽ — на балансе 60 000 ₽', b);
/* повтор с тем же ключом комиссию дважды не берёт */
const k1 = op('top');
await api('POST', '/api/topup', { amount: 1000, opKey: k1 }, BLG);
const rep = await api('POST', '/api/topup', { amount: 1000, opKey: k1 }, BLG);
ov = await overview();
ok(rep.body.repeated && (await bal(BLG)).available === 1000 && ov.доход_платформы === 700 + 3500 + 70, 'повтор пополнения с тем же ключом — без второй комиссии', [rep.body, ov.доход_платформы]);

/* ── 3 · запуск задания: бюджет + 7% сверху ── */
const D1 = 'camp:fee' + tag;
const h1 = await api('POST', '/api/deals/hold', { dealId: D1, amount: 10000, opKey: op('hold') }, ADV);
ok(h1.status === 200 && h1.body.fee === 700 && h1.body.feePct === 7 && h1.body.total === 10700, 'запуск задания с бюджетом 10 000 ₽: комиссия 700 ₽, всего 10 700 ₽', h1.body);
b = await bal(ADV);
ok(b.available === 60000 - 10700 && b.hold === 10000, 'со счёта ушло 10 700 ₽, в заморозке ровно бюджет 10 000 ₽', b);
const led2 = (await api('GET', '/api/ledger', null, ADV)).body.rows || [];
ok(led2.some((r) => r.kind === 'task-fee' && r.amount === -700 && r.ref === D1), 'в истории — строка «комиссия задания» −700 ₽', led2.slice(0, 4));
/* денег на бюджет хватает, на бюджет с комиссией — нет */
const D2 = 'camp:fee2' + tag;
const h2 = await api('POST', '/api/deals/hold', { dealId: D2, amount: 48000, opKey: op('hold') }, ADV);
ok(h2.status === 409 && (await bal(ADV)).available === 49300, 'бюджет 48 000 ₽ при 49 300 ₽ на счёте: с комиссией не хватает — отказ, деньги на месте', h2);
/* обычная сделка — без комиссии */
const DL = 'deal-fee-' + tag;
const hl = await api('POST', '/api/deals/hold', { dealId: DL, amount: 1000, opKey: op('hold') }, ADV);
ok(hl.status === 200 && hl.body.fee === 0 && (await bal(ADV)).available === 48300, 'обычная сделка (не задание) — без комиссии', hl.body);

/* ── 4 · пополнение бюджета задания — тоже +7% ── */
const tu = await api('POST', '/api/deals/topup', { dealId: D1, amount: 1000, opKey: op('dtop') }, ADV);
ok(tu.status === 200 && tu.body.fee === 70 && tu.body.total === 1070 && tu.body.budget === 11000, 'пополнение бюджета на 1 000 ₽: комиссия 70 ₽, бюджет 11 000 ₽', tu.body);
b = await bal(ADV);
ok(b.available === 48300 - 1070 && b.hold === 11000 + 1000, 'со счёта 1 070 ₽, в заморозке +1 000 ₽', b);

/* ── 5 · выплата блогеру из задания: −7%, по накопленному ── */
const r1 = await api('POST', '/api/deals/release', { dealId: D1, toUserId: blgId, amount: 2000, opKey: op('rel') }, ADV);
ok(r1.status === 200 && (await bal(BLG)).available === 1000 + 1860, 'выплата 2 000 ₽ из бюджета: блогеру 1 860 ₽ (−7%)', [r1.body, await bal(BLG)]);
await api('POST', '/api/deals/release', { dealId: D1, toUserId: blgId, amount: 1, opKey: op('rel') }, ADV);
await api('POST', '/api/deals/release', { dealId: D1, toUserId: blgId, amount: 99, opKey: op('rel') }, ADV);
/* всего выплачено 2 100: комиссия = 7% от 2 100 = 147, блогеру 1 953 — без дрейфа округления */
ok((await bal(BLG)).available === 1000 + 2100 - 147, 'три выплаты 2 000 + 1 + 99: блогеру ровно 2 100 − 7% = 1 953 ₽', await bal(BLG));
const led3 = (await api('GET', '/api/ledger', null, BLG)).body.rows || [];
ok(led3.filter((r) => r.kind === 'payout').reduce((s, r) => s + r.amount, 0) === 1953, 'в истории блогера выплаты «на руки»: 1 860 + 0 + 93 (комиссия по накопленному, вверх)', led3);
/* обычная сделка — блогеру целиком */
await api('POST', '/api/deals/release', { dealId: DL, toUserId: blg2Id, opKey: op('rel') }, ADV);
ok((await bal(BLG2)).available === 1000, 'выплата по обычной сделке — без комиссии, 1 000 ₽', await bal(BLG2));

/* ── 6 · возврат остатка: комиссия за неистраченное возвращается ── */
const rf1 = await api('POST', '/api/deals/refund', { dealId: D1, amount: 3000, opKey: op('ref') }, ADV);
ok(rf1.status === 200 && rf1.body.refunded === 3000 && rf1.body.feeBack === 210, 'вернули 3 000 ₽ остатка — и 210 ₽ комиссии за них', rf1.body);
const before = (await bal(ADV)).available;
const rf2 = await api('POST', '/api/deals/refund', { dealId: D1, opKey: op('ref') }, ADV);
/* бюджет 11 000 − 3 000 = 8 000, выплачено 2 100 → остаток 5 900; комиссия
   взята 770, возвращено 210, за потраченные 2 100 остаётся 147 → вернуть 413 */
ok(rf2.status === 200 && rf2.body.refunded === 5900 && rf2.body.feeBack === 413, 'закрыли задание: остаток 5 900 ₽ + комиссия 413 ₽', rf2.body);
b = await bal(ADV);
ok(b.available === before + 5900 + 413 && b.hold === 0, 'на счёте рекламодателя всё вернулось, заморозки нет', b);
/* итог: рекламодатель потратил на задание 2 100 ₽ выплат + 7% = 147 ₽ */
ok(b.available === 60000 - 1000 - 2100 - 147, 'итого задание стоило 2 100 ₽ выплат + 147 ₽ комиссии (7% от потраченного)', b);

/* ── 6б · округление не даёт обойти комиссию (разбор 15.10.2026) ──
   по 7 ₽ комиссия была 0 (0,49 → 0), возврат по 8 ₽ отдавал лишнюю (0,56 → 1) */
const D3 = 'camp:fee3' + tag;
const a3 = (await bal(ADV)).available;
const h3 = await api('POST', '/api/deals/hold', { dealId: D3, amount: 7, opKey: op('hold') }, ADV);
ok(h3.status === 200 && h3.body.fee === 1, 'задание на 7 ₽: комиссия 1 ₽, а не 0 (берём с округлением вверх)', h3.body);
const t3 = await api('POST', '/api/deals/topup', { dealId: D3, amount: 7, opKey: op('dtop') }, ADV);
ok(t3.status === 200 && t3.body.fee === 1, 'пополнение бюджета на 7 ₽: комиссия 1 ₽', t3.body);
const r3 = await api('POST', '/api/deals/refund', { dealId: D3, amount: 8, opKey: op('ref') }, ADV);
ok(r3.status === 200 && r3.body.feeBack === 0, 'вернули 8 ₽ из 14: комиссии за них — 0 ₽ (возвращаем с округлением вниз)', r3.body);
const r4 = await api('POST', '/api/deals/refund', { dealId: D3, opKey: op('ref') }, ADV);
ok(r4.status === 200 && r4.body.feeBack === 2 && (await bal(ADV)).available === a3, 'закрыли задание без трат: вернулся остаток и вся комиссия (2 ₽) — на счёте как до него', [r4.body, a3]);

/* бюджет 10 001 ₽: комиссия 701 ₽ (7% с округлением вверх); потрачен целиком —
   удерживается те же 701 ₽, и с выплаты блогеру — 701 ₽ */
const D4 = 'camp:fee4' + tag;
const a4 = (await bal(ADV)).available;
const h4 = await api('POST', '/api/deals/hold', { dealId: D4, amount: 10001, opKey: op('hold') }, ADV);
const p4 = await api('POST', '/api/deals/release', { dealId: D4, toUserId: blg2Id, amount: 10001, opKey: op('rel') }, ADV);
ok(h4.body.fee === 701 && p4.status === 200 && (await bal(ADV)).available === a4 - 10001 - 701, 'бюджет 10 001 ₽ потрачен целиком: комиссия 701 ₽ (7% вверх), ничего лишнего', [h4.body, p4.body, a4]);
/* задание на 7 ₽, потраченное целиком: без округления вверх оно шло бы совсем без комиссий */
const D5 = 'camp:fee5' + tag;
const a5 = (await bal(ADV)).available, g5 = (await bal(BLG2)).available;
const h5 = await api('POST', '/api/deals/hold', { dealId: D5, amount: 7, opKey: op('hold') }, ADV);
const p5 = await api('POST', '/api/deals/release', { dealId: D5, toUserId: blg2Id, amount: 7, opKey: op('rel') }, ADV);
ok(h5.body.fee === 1 && p5.status === 200 && (await bal(ADV)).available === a5 - 8 && (await bal(BLG2)).available === g5 + 6,
  'задание на 7 ₽ потрачено целиком: рекламодатель заплатил 7 + 1 ₽, блогеру 6 ₽ — обе комиссии взяты', [h5.body, p5.body]);
/* бюджет кончился — заморозка задания открыта (аудит 16.10.2026): пополнение
   проходит (раньше 409 «Сделка уже закрыта: released»), комиссия задания —
   7% от ВСЕГО потраченного с округлением вверх, лишний рубль — назад */
const t5 = await api('POST', '/api/deals/topup', { dealId: D5, amount: 7, opKey: op('dtop') }, ADV);
const p5b = await api('POST', '/api/deals/release', { dealId: D5, toUserId: blg2Id, amount: 7, opKey: op('rel') }, ADV);
ok(t5.status === 200 && t5.body.fee === 1 && t5.body.budget === 14 && p5b.status === 200 && p5b.body.closed === true
  && (await bal(ADV)).available === a5 - 15 && (await bal(BLG2)).available === g5 + 13,
  'исчерпанный бюджет 7 ₽ пополнили ещё на 7 ₽: за 14 ₽ потраченных — 14 + 1 ₽ (7% вверх от всего, лишний рубль вернулся), блогеру 13 ₽', [t5.body, p5b.body]);

/* ── 7 · пополнение по счёту: счёт на сумму + 7%, на баланс — сумма ── */
const inv = await api('POST', '/api/topup/invoice', { amount: 20000, company: 'ООО Ромашка', inn: '7707083893', email: 'a@b.ru' }, ADV);
ok(inv.status === 200 && inv.body.fee === 1400 && inv.body.total === 21400 && inv.body.feePct === 7, 'заявка на счёт 20 000 ₽: счёт на 21 400 ₽ (комиссия 1 400 ₽)', inv.body);
const invList = (await api('GET', '/api/topup/invoices', null, ADV)).body.rows || [];
ok(invList[0] && invList[0].fee === 1400 && invList[0].total === 21400, 'в списке счетов — сумма счёта с комиссией', invList[0]);
const b0 = (await bal(ADV)).available;
const cr = await api('POST', '/api/admin/invoices/credit', { id: inv.body.id }, null, true);
ok(cr.status === 200 && cr.body.amount === 20000 && cr.body.fee === 1400 && (await bal(ADV)).available === b0 + 20000, '«Зачислить»: на баланс 20 000 ₽, комиссия 1 400 ₽ — сервису', cr.body);

/* ── 8 · вывод — без комиссии ── */
const kyc = await api('POST', '/api/kyc/submit', { name: 'Иванов Иван Иванович', birth: '01.01.1990', photo: PIX, selfie: PIX }, BLG);
await api('POST', '/api/admin/kyc/approve', { requestId: kyc.body.requestId }, null, true);
const wd = await api('POST', '/api/withdraw', { amount: 1000, requisites: 'карта 2200 0000 0000 0001', opKey: op('wd') }, BLG);
ok(wd.status === 200 && wd.body.fee === 0 && wd.body.net === 1000, 'заявка на вывод 1 000 ₽: комиссия 0, к выплате 1 000 ₽', wd.body);
await api('POST', '/api/admin/withdrawals/take', { withdrawalId: wd.body.withdrawalId }, null, true);
const pd = await api('POST', '/api/admin/withdrawals/paid', { withdrawalId: wd.body.withdrawalId }, null, true);
ok(pd.status === 200 && pd.body.net === 1000 && pd.body.fee === 0, 'выплата вывода: ушло 1 000 ₽, комиссии нет', pd.body);

/* ── 9 · сверка и доход сервиса ── */
ov = await overview();
/* комиссии: пополнения 700 + 3 500 + 70 (блогер 1 000) · задание 700 + 70 − 210 − 413 ·
   выплаты 147 · счёт 1 400 · бюджет 10 001: 701 + 701 с выплаты · 7 ₽ потраченные:
   1 + 1, пополненные ещё на 7 ₽: +1 комиссия пополнения, −1 назад, 0 с выплаты
   (7% от 14 вверх = 1) · задания по 7 ₽ без трат — в ноль (2 взято, 2 вернули) */
const income = 700 + 3500 + 70 + 700 + 70 - 210 - 413 + 147 + 1400 + 701 + 701 + 1 + 1 + 1 - 1;
ok(ov.доход_платформы === income, 'доход сервиса = сумма всех комиссий (' + income + ' ₽)', ov.доход_платформы);
ok(ov.сверка.сходится && ov.сверка.расхождение === 0, 'сверка денег сходится: всё внесённое лежит в системе или выплачено', ov.сверка);
ok(ov.выплачено_наружу === 1000, 'наружу выплачено 1 000 ₽ — ровно сумма вывода', ov.выплачено_наружу);

console.log('\nИтого: ' + passed + ' ok, ' + failed + ' FAIL');
try { srv.kill(); } catch (e) {}
process.exit(failed ? 1 : 0);
