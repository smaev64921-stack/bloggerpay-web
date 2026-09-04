/* Конверты между устройствами: заявка/сделка/сообщение от одного человека
   к другому едет через сервер. Проверяем, что участник видит, посторонний —
   нет, чужое переписать нельзя, правка получает новый номер, «новее N»
   отдаёт только новое, общий конверт видят все, а мусор и великаны
   отклоняются. Свой сервер на 8092, в конце гасится.
   Запуск: node test-sync.mjs */

import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = 8092;
const BASE = 'http://127.0.0.1:' + PORT;
let passed = 0, failed = 0;
function ok(c, name, extra) {
  if (c) { passed++; console.log('  ok  ' + name); }
  else { failed++; console.log('  FAIL ' + name + (extra ? '  ← ' + JSON.stringify(extra).slice(0, 260) : '')); }
}
async function api(method, p, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const r = await fetch(BASE + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const txt = await r.text();
  let j = {}; try { j = JSON.parse(txt); } catch (e) { j = { _raw: txt.slice(0, 160) }; }
  return { status: r.status, body: j };
}
const dir = mkdtempSync(path.join(tmpdir(), 'bp-sync-'));
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
  const r = await api('POST', '/api/register', { email: `sy${tag}@t.ru`, name: 'Юзер ' + tag, role, password: 'парольВ12345' });
  return { token: r.body.token, id: r.body.user && r.body.user.id };
}
try {
  console.log('\nКонверты между устройствами');
  ok(await waitUp(), 'сервер поднялся');
  const tag = Date.now();
  const adv = await reg('a' + tag, 'advertiser');
  const blg = await reg('b' + tag, 'blogger');
  const other = await reg('c' + tag, 'blogger');
  ok(adv.token && blg.token && other.token, 'три человека зарегистрированы');

  const anon = await api('POST', '/api/sync/put', { kind: 'request', rid: 'req_1', to: blg.id, data: { x: 1 } });
  ok(anon.status === 401, 'без входа конверт не положить', anon.body);

  /* ── заявка от рекламодателя блогеру ── */
  const put = await api('POST', '/api/sync/put',
    { kind: 'request', rid: 'req_' + tag, to: blg.id, data: { budget: 12000, status: 'pending', note: 'Обзор' } }, adv.token);
  ok(put.status === 200 && put.body.ver > 0 && put.body.a === adv.id && put.body.b === blg.id, 'заявка положена, участники записаны', put.body);
  const v1 = put.body.ver;

  const inbox = await api('GET', '/api/sync/pull?since=0', null, blg.token);
  ok(inbox.status === 200 && inbox.body.rows.length === 1 && inbox.body.rows[0].rid === 'req_' + tag, 'блогер видит заявку', inbox.body);
  ok(inbox.body.rows[0].data.budget === 12000 && inbox.body.rows[0].from === adv.id, 'содержимое и отправитель на месте', inbox.body.rows[0]);
  ok(inbox.body.me === blg.id && inbox.body.ver === v1, 'ответ говорит, кто я и до какого номера прочитано', inbox.body);

  const spy = await api('GET', '/api/sync/pull?since=0', null, other.token);
  ok(spy.body.rows.length === 0, 'посторонний чужую заявку не видит', spy.body);

  /* ── чужое переписать нельзя ── */
  const steal = await api('POST', '/api/sync/put', { kind: 'request', rid: 'req_' + tag, data: { status: 'accepted', budget: 1 } }, other.token);
  ok(steal.status === 403, 'посторонний не может переписать заявку', steal.body);

  /* ── ответ блогера: правка получает НОВЫЙ номер ── */
  const acc = await api('POST', '/api/sync/put', { kind: 'request', rid: 'req_' + tag, data: { budget: 12000, status: 'accepted' } }, blg.token);
  ok(acc.status === 200 && acc.body.ver > v1 && acc.body.a === adv.id && acc.body.b === blg.id, 'блогер ответил, номер вырос, участники прежние', acc.body);
  const advSees = await api('GET', '/api/sync/pull?since=' + v1, null, adv.token);
  ok(advSees.body.rows.length === 1 && advSees.body.rows[0].data.status === 'accepted' && advSees.body.rows[0].from === blg.id, 'рекламодатель забрал ответ по «новее N»', advSees.body);
  const nothing = await api('GET', '/api/sync/pull?since=' + advSees.body.ver, null, adv.token);
  ok(nothing.body.rows.length === 0, 'второй раз ничего нового', nothing.body);

  /* ── сообщение в чат ── */
  const msg = await api('POST', '/api/sync/put', { kind: 'msg', rid: 'm_' + tag + '_1', to: adv.id, data: { text: 'Привет, беру', at: tag } }, blg.token);
  ok(msg.status === 200, 'сообщение положено', msg.body);
  const advMsg = await api('GET', '/api/sync/pull?since=' + advSees.body.ver, null, adv.token);
  ok(advMsg.body.rows.length === 1 && advMsg.body.rows[0].kind === 'msg' && advMsg.body.rows[0].data.text === 'Привет, беру', 'рекламодатель получил сообщение', advMsg.body);

  /* ── общий конверт (без адресата): видят все вошедшие ── */
  const pub = await api('POST', '/api/sync/put', { kind: 'camp', rid: 'camp_' + tag, data: { name: 'Кампания', budget: 50000 } }, adv.token);
  ok(pub.status === 200 && pub.body.b === null, 'общий конверт положен', pub.body);
  const otherSees = await api('GET', '/api/sync/pull?since=0', null, other.token);
  ok(otherSees.body.rows.length === 1 && otherSees.body.rows[0].kind === 'camp', 'посторонний видит общий конверт и только его', otherSees.body.rows.map((r) => r.kind));
  const pubSteal = await api('POST', '/api/sync/put', { kind: 'camp', rid: 'camp_' + tag, data: { name: 'Подмена' } }, other.token);
  ok(pubSteal.status === 403, 'общий конверт чужому не переписать', pubSteal.body);

  /* ── адресата можно назначить позже (отклик на общую кампанию), но не сменить ── */
  const join = await api('POST', '/api/sync/put', { kind: 'join', rid: 'join_' + tag, to: adv.id, data: { campId: 'camp_' + tag, status: 'joined' } }, other.token);
  ok(join.status === 200 && join.body.a === other.id && join.body.b === adv.id, 'отклик адресован владельцу кампании', join.body);
  const swap = await api('POST', '/api/sync/put', { kind: 'join', rid: 'join_' + tag, to: blg.id, data: { status: 'joined' } }, other.token);
  ok(swap.status === 200 && swap.body.b === adv.id, 'адресата сменить нельзя — остался прежний', swap.body);

  /* ── мусор и пределы ── */
  const badKind = await api('POST', '/api/sync/put', { kind: 'DROP TABLE', rid: 'x_1', data: {} }, adv.token);
  ok(badKind.status === 400, 'кривой вид записи отклонён', badKind.body);
  const badRid = await api('POST', '/api/sync/put', { kind: 'deal', rid: 'плохой номер', data: {} }, adv.token);
  ok(badRid.status === 400, 'кривой номер отклонён', badRid.body);
  const noData = await api('POST', '/api/sync/put', { kind: 'deal', rid: 'deal_x', data: 'строка' }, adv.token);
  ok(noData.status === 400, 'содержимое обязано быть объектом', noData.body);
  const ghost = await api('POST', '/api/sync/put', { kind: 'deal', rid: 'deal_y', to: 999999, data: { a: 1 } }, adv.token);
  ok(ghost.status === 400, 'несуществующий адресат отклонён', ghost.body);
  const self = await api('POST', '/api/sync/put', { kind: 'deal', rid: 'deal_z', to: adv.id, data: { a: 1 } }, adv.token);
  ok(self.status === 400, 'самому себе конверт не нужен', self.body);
  const huge = await api('POST', '/api/sync/put', { kind: 'msg', rid: 'm_huge', to: blg.id, data: { blob: 'x'.repeat(450 * 1024) } }, adv.token);
  ok(huge.status === 413, 'великан отклонён', huge.body);

  /* ── лента порциями ── */
  for (let i = 0; i < 5; i++) await api('POST', '/api/sync/put', { kind: 'msg', rid: 'm_p' + i, to: blg.id, data: { i } }, adv.token);
  const page = await api('GET', '/api/sync/pull?since=0&limit=3', null, blg.token);
  ok(page.body.rows.length === 3 && page.body.more === true, 'порция из трёх и признак «есть ещё»', { n: page.body.rows.length, more: page.body.more });
  const rest = await api('GET', '/api/sync/pull?since=' + page.body.ver + '&limit=100', null, blg.token);
  ok(rest.body.more === false && rest.body.rows.every((r) => r.ver > page.body.ver), 'остаток без повторов', { n: rest.body.rows.length });
  /* ── витрина заданий для гостя ──
     Ручка открыта без входа, поэтому проверяем не только «что-то
     вернулось», а ЧТО именно: не утекают ли номера людей и не попадают
     ли туда черновики. */
  await api('POST', '/api/sync/put', {
    kind: 'camp', rid: 'camp_pub_1', shared: true,
    data: { id: 'camp_pub_1', status: 'active', title: 'Ролик про сервис',
      desc: 'снять обзор', budget: 5000, perBlogger: 5000, slots: 1,
      platform: 'youtube', topics: ['Игры'], ownerId: '#srv:' + adv.id,
      advertiserName: 'Рекламодатель' },
  }, adv.token);
  await api('POST', '/api/sync/put', {
    kind: 'camp', rid: 'camp_pub_2', shared: true,
    data: { id: 'camp_pub_2', status: 'draft', title: 'Черновик', budget: 1 },
  }, adv.token);

  const pubRes = await fetch(BASE + '/api/tasks/public');
  const shop = await pubRes.json();
  ok(pubRes.status === 200, 'витрина заданий открыта без входа', pubRes.status);
  const one = (shop.rows || []).find((r) => r.id === 'camp_pub_1');
  ok(!!one, 'опубликованное задание в витрине есть', shop.rows);
  ok(!(shop.rows || []).some((r) => r.id === 'camp_pub_2'), 'черновик в витрину не попал');
  ok(one && one.title === 'Ролик про сервис' && one.perBlogger === 5000,
    'текст и цена на месте', one);
  const leak = JSON.stringify(shop.rows || []);
  ok(leak.indexOf('#srv:') < 0 && leak.indexOf('ownerId') < 0,
    'номеров людей в витрине нет', leak.slice(0, 160));
} catch (e) {
  failed++; console.log('  FAIL исключение: ' + e.message);
} finally {
  srv.kill();
}
console.log(`\nИтого: ${passed} ok, ${failed} FAIL\n`);
process.exit(failed ? 1 : 0);
