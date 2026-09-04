/* Защита денег и доступа: одноразовость кода вывода, права владельца,
   отпор перебору ключа. Запуск: node test-guard.mjs (сервер должен работать). */

import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import net from 'node:net';

/* Адрес сервера можно подменить: BP_TEST_BASE=http://127.0.0.1:8091 npm test.
   Нужно, когда над проектом работают в две руки и порт 8090 занят чужим
   сервером — иначе проверки идут не по тому коду. */
const BASE = process.env.BP_TEST_BASE || 'http://127.0.0.1:8090';
const ADMIN_KEY = /ADMIN_KEY=(\S+)/.exec(readFileSync(new URL('./.env', import.meta.url), 'utf8'))[1];
const PIX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';

let passed = 0, failed = 0;
function ok(c, name, extra) {
  if (c) { passed++; console.log('  ok  ' + name); }
  else { failed++; console.log('  FAIL ' + name + (extra ? '  ← ' + JSON.stringify(extra) : '')); }
}
async function api(method, path, body, token, adminKey) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  if (adminKey) headers['X-Admin-Key'] = adminKey;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const tag = Date.now();
console.log('\nЗащита денег и доступа');

/* готовим человека, которому можно выводить */
const u = await api('POST', '/api/register', { email: `g${tag}@t.ru`, name: 'Выводящий', role: 'blogger', password: 'обычныйПароль12' });
const T = u.body.token;
await api('POST', '/api/topup', { amount: 50000, opKey: randomUUID() }, T);
const kyc = await api('POST', '/api/kyc/submit', { name: 'Иванов Иван Иванович', birth: '01.01.1990', photo: PIX, selfie: PIX }, T);
await api('POST', '/api/admin/kyc/approve', { requestId: kyc.body.requestId }, null, ADMIN_KEY);

/* ── один код — одна заявка ── */
const first = await api('POST', '/api/withdraw', { amount: 1000, requisites: 'карта 1111', opKey: randomUUID() }, T);
ok(first.status === 200 && first.body.needCode === true, 'первый запрос только шлёт код и денег не трогает', first.body);
const code = first.body.devCode;
ok(!!code, 'код доступен в отладочном режиме');

/* пять одновременных попыток с одним кодом и разными ключами операции */
const salvo = await Promise.all([1, 2, 3, 4, 5].map(() =>
  api('POST', '/api/withdraw', { amount: 1000, requisites: 'карта 1111', code, opKey: randomUUID() }, T)));
const created = salvo.filter((r) => r.status === 200 && r.body.status === 'queued').length;
ok(created === 1, 'по одному коду создаётся ровно одна заявка', { создано: created, ответы: salvo.map((r) => r.status) });

/* тот же код повторно уже не работает */
const again = await api('POST', '/api/withdraw', { amount: 1000, requisites: 'карта 1111', code, opKey: randomUUID() }, T);
ok(again.status === 400 && again.body.dead === true, 'использованный код помечен как мёртвый', again.body);

/* ── неверный код: попытки считаются, признак dead=false ── */
const w2 = await api('POST', '/api/withdraw', { amount: 1000, requisites: 'карта 2222', opKey: randomUUID() }, T);
const bad = await api('POST', '/api/withdraw', { amount: 1000, requisites: 'карта 2222', code: '000000', opKey: randomUUID() }, T);
ok(bad.status === 400 && bad.body.dead === false, 'неверный код оставляет попытку, код ещё жив', bad.body);
const right = await api('POST', '/api/withdraw', { amount: 1000, requisites: 'карта 2222', code: w2.body.devCode, opKey: randomUUID() }, T);
ok(right.status === 200 && right.body.status === 'queued', 'после промаха верный код проходит', right.body);

/* ── сумма изменилась — нужен новый код ── */
const w3 = await api('POST', '/api/withdraw', { amount: 1000, requisites: 'карта 3333', opKey: randomUUID() }, T);
const other = await api('POST', '/api/withdraw', { amount: 2000, requisites: 'карта 3333', code: w3.body.devCode, opKey: randomUUID() }, T);
ok(other.status === 400 && other.body.dead === true, 'код не подходит к другой сумме', other.body);

/* ── спор держит деньги и на сервере ── */
{
  const adv = await api('POST', '/api/register', { email: `da${tag}@t.ru`, name: 'Заказчик', role: 'advertiser', password: 'обычныйПароль12' });
  const blg = await api('POST', '/api/register', { email: `db${tag}@t.ru`, name: 'Исполнитель', role: 'blogger', password: 'обычныйПароль12' });
  const TA = adv.body.token, TB = blg.body.token, BID = blg.body.user.id;
  await api('POST', '/api/topup', { amount: 20000, opKey: randomUUID() }, TA);
  const dealId = 'deal_dsp_' + tag;
  const hold = await api('POST', '/api/deals/hold', { dealId, amount: 5000, payeeId: BID, opKey: randomUUID() }, TA);
  ok(hold.status === 200, 'заморозка под сделку прошла', hold.body);

  const stranger = await api('POST', '/api/register', { email: `dc${tag}@t.ru`, name: 'Посторонний', role: 'blogger', password: 'обычныйПароль12' });
  const TC = stranger.body.token;
  const noWhole = await api('POST', '/api/deals/dispute/open', { dealId, payeeId: null }, TC);
  ok(noWhole.status === 200 && noWhole.body.ok, 'посторонний открывает спор только «по себе»', noWhole.body);

  /* Главное: такой спор не запирает чужие деньги — возврат плательщику проходит. */
  const dealFree = 'deal_free_' + tag;
  await api('POST', '/api/deals/hold', { dealId: dealFree, amount: 1000, opKey: randomUUID() }, TA);
  await api('POST', '/api/deals/dispute/open', { dealId: dealFree }, TC);
  const backOk = await api('POST', '/api/deals/refund', { dealId: dealFree, opKey: randomUUID() }, TA);
  ok(backOk.status === 200 && backOk.body.ok, 'спор постороннего не мешает возврату плательщику', backOk.body);

  const opened = await api('POST', '/api/deals/dispute/open', { dealId }, TB);
  ok(opened.status === 200 && opened.body.ok, 'исполнитель открыл спор по своей сделке', opened.body);

  const rel = await api('POST', '/api/deals/release', { dealId, toUserId: BID, opKey: randomUUID() }, TA);
  ok(rel.status === 409 && rel.body.dispute === true, 'выплата во время спора отклонена сервером', rel.body);
  const ref = await api('POST', '/api/deals/refund', { dealId, opKey: randomUUID() }, TA);
  ok(ref.status === 409 && ref.body.dispute === true, 'возврат во время спора отклонён сервером', ref.body);

  const closeNo = await api('POST', '/api/deals/dispute/close', { dealId, payeeId: BID }, TC);
  ok(closeNo.status === 403, 'посторонний не может закрыть чужой спор', closeNo.body);
  const closed = await api('POST', '/api/deals/dispute/close', { dealId, payeeId: BID }, TB);
  ok(closed.status === 200 && closed.body.closed === 1, 'открывший закрыл свой спор', closed.body);

  const rel2 = await api('POST', '/api/deals/release', { dealId, toUserId: BID, opKey: 'cp:test:' + tag }, TA);
  ok(rel2.status === 200 && rel2.body.ok, 'после закрытия спора выплата проходит', rel2.body);

  const mine = await api('GET', '/api/ops/mine', null, TA);
  ok(mine.status === 200 && (mine.body.rows || []).some((r) => r.opKey === 'cp:test:' + tag && r.paid === 5000),
     'журнал выплат отдаёт ключ операции и сумму', mine.body);

  /* спор по выплате одному исполнителю из бюджета кампании закрывает решение арбитра */
  const camp = 'camp:dsp' + tag;
  await api('POST', '/api/deals/hold', { dealId: camp, amount: 3000, opKey: randomUUID() }, TA);
  const o2 = await api('POST', '/api/deals/dispute/open', { dealId: camp, payeeId: BID }, TB);
  ok(o2.status === 200, 'спор по своей выплате из бюджета кампании открыт', o2.body);
  const rel3 = await api('POST', '/api/deals/release', { dealId: camp, toUserId: BID, amount: 1000, opKey: randomUUID() }, TA);
  ok(rel3.status === 409, 'выплата этому исполнителю заморожена', rel3.body);
  const settled = await api('POST', '/api/deals/settle', { dealId: camp, bloggerShare: 50, toUserId: BID, opKey: randomUUID() }, null, ADMIN_KEY);
  ok(settled.status === 200, 'арбитр вынес решение', settled.body);
  const after = await api('POST', '/api/deals/dispute/close', { dealId: camp, payeeId: BID }, TB);
  ok(after.status === 200 && after.body.closed === 0, 'после решения арбитра открытых споров не осталось', after.body);
}

/* ── служебные ключи операций пользователю недоступны ── */
{
  const u = await api('POST', '/api/register', { email: `ok${tag}@t.ru`, name: 'Ключник', role: 'advertiser', password: 'обычныйПароль12' });
  const T = u.body.token;
  await api('POST', '/api/topup', { amount: 5000, opKey: randomUUID() }, T);
  const sys = await api('POST', '/api/deals/hold', { dealId: 'k1_' + tag, amount: 100, opKey: 'sys:wd-paid:1' }, T);
  ok(sys.status === 400, 'ключ из пространства sys: отклонён', sys.body);
  const old = await api('POST', '/api/deals/hold', { dealId: 'k2_' + tag, amount: 100, opKey: 'bp-op-paid-1' }, T);
  ok(old.status === 400, 'ключ пульта оператора занять нельзя', old.body);
}

/* ── адрес без хоста не роняет сервер ── */
{
  const r = await fetch(BASE + '/api/health');
  ok(r.status === 200, 'сервер жив перед проверкой адреса');
  const bad = await new Promise((resolve) => {
    const u = new URL(BASE);
    const c = net.connect(Number(u.port) || 80, u.hostname, () => {
      c.write('GET // HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
    });
    let out = '';
    c.on('data', (d) => { out += d.toString(); });
    c.on('end', () => resolve(out));
    c.on('error', () => resolve(''));
    setTimeout(() => { try { c.destroy(); } catch (e) {} resolve(out); }, 3000);
  });
  ok(/HTTP\/1\.1 400/.test(bad), 'на «GET //» приходит 400, а не тишина', bad.slice(0, 60));
  const alive = await api('GET', '/api/health');
  ok(alive.status === 200, 'после кривого адреса сервер жив');
}

/* ── регистрация на служебный домен закрыта ── */
{
  const r = await api('POST', '/api/register', { email: 'tg777000@telegram.local', name: 'Захват', role: 'blogger', password: 'обычныйПароль12' });
  ok(r.status === 400, 'на @telegram.local зарегистрироваться нельзя', r.body);
}

/* ── ключ оператора из кириллицы не роняет запрос ── */
{
  /* Заголовок допускает только байты 0–255, поэтому берём латиницу с
     диакритикой: в utf-8 такой символ занимает два байта, и длина в
     символах расходится с длиной в байтах — на этом сравнение падало. */
  const r = await api('GET', '/api/admin/overview', null, null, 'é'.repeat(ADMIN_KEY.length));
  ok(r.status === 403, 'ключ из двухбайтовых символов отвергается без ошибки сервера', r.status);
}

/* ── перебор ключа владельца упирается в стену ── */
let blocked = 0;
for (let i = 0; i < 12; i++) {
  const r = await api('GET', '/api/admin/overview', null, null, 'x'.repeat(ADMIN_KEY.length));
  /* 403 — ключ не подошёл, 429 — попытки кончились: и то и другое отказ */
  if (r.status === 403 || r.status === 429) blocked++;
}
ok(blocked === 12, 'неверный ключ всегда отклоняется', { отказов: blocked });
const afterBrute = await api('GET', '/api/admin/overview', null, null, ADMIN_KEY);
ok(afterBrute.status === 429, 'после перебора адрес отрезан даже с верным ключом', afterBrute.body);
ok(/подождите/i.test(String((afterBrute.body && afterBrute.body.error) || '')),
  'и говорит человеку, что дело в попытках, а не в ключе', afterBrute.body);

console.log(`\nИтого: ${passed} ok, ${failed} fail\n`);
process.exit(failed ? 1 : 0);
