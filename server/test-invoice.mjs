/* Пополнение по счёту через Телеграм (14.10.2026): заявка из приложения,
   бот связывает чат с заявкой и передаёт переписку владельцу и обратно,
   владелец зачисляет деньги в /admin → «Счета» через журнал.
   Свой сервер на 8472 и заглушка API Телеграма на 8473 — настоящий
   Телеграм не трогаем.
   Запуск: node test-invoice.mjs */

import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = 8472, TGP = 8473;
const BASE = 'http://127.0.0.1:' + PORT;
const KEY = 'test-invoice-key';
const ADMIN = '424242';
let passed = 0, failed = 0;
function ok(c, name, extra) {
  if (c) { passed++; console.log('  ok  ' + name); }
  else { failed++; console.log('  FAIL ' + name + (extra !== undefined ? '  ← ' + JSON.stringify(extra).slice(0, 300) : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── заглушка Телеграма ── */
const sent = [];            /* sendMessage */
const copies = [];          /* copyMessage */
let queue = [], updId = 500, msgId = 9000;
function push(message) { queue.push({ update_id: ++updId, message }); }
const stub = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', async () => {
    const method = req.url.split('/').pop();
    let data = {}; try { data = JSON.parse(body || '{}'); } catch (e) {}
    let result = true;
    if (method === 'getMe') result = { id: 1, username: 'test_bot', first_name: 'Тест' };
    else if (method === 'getUpdates') {
      if (!queue.length) await sleep(60);
      result = queue; queue = [];
    } else if (method === 'sendMessage') { const id = ++msgId; sent.push(Object.assign({ _id: id }, data)); result = { message_id: id }; }
    else if (method === 'copyMessage') { const id = ++msgId; copies.push(Object.assign({ _id: id }, data)); result = { message_id: id }; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, result }));
  });
});
await new Promise((r) => stub.listen(TGP, '127.0.0.1', r));

const CWD = fileURLToPath(new URL('.', import.meta.url));
const dir = mkdtempSync(path.join(tmpdir(), 'bp-inv-'));
const srv = spawn(process.execPath, ['server.js'], {
  cwd: CWD,
  env: {
    ...process.env, PORT: String(PORT), DB_PATH: path.join(dir, 'db.sqlite'), PUBLIC_URL: BASE, APP_URL: BASE + '/',
    ADMIN_KEY: KEY, ADMIN_EMAIL: '', BOT_TOKEN: '111:TEST-INVOICE', BOT_USERNAME: '', ADMIN_CHAT_ID: ADMIN,
    TG_API_BASE: 'http://127.0.0.1:' + TGP, RESEND_API_KEY: '', YOOKASSA_SHOP_ID: '', YOOKASSA_SECRET_KEY: '',
    TEST_TOPUP: '0', INVOICE_MIN: '10000',
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
async function until(fn, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < (ms || 6000)) { const v = fn(); if (v) return v; await sleep(80); }
  return fn();
}
/* ИНН с верными контрольными цифрами */
function innFix(d) {
  const k = (w, s) => w.reduce((sum, c, i) => sum + c * Number(s[i]), 0) % 11 % 10;
  if (d.length === 9) return d + k([2, 4, 10, 3, 5, 9, 4, 6, 8], d);
  const a = d + k([7, 2, 4, 10, 3, 5, 9, 4, 6, 8], d);
  return a + k([3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8], a);
}

try {
  console.log('\nПополнение по счёту через Телеграм');
  let upOk = false;
  for (let i = 0; i < 60; i++) { try { const r = await fetch(BASE + '/api/health'); if (r.ok) { upOk = true; break; } } catch (e) {} await sleep(150); }
  ok(upOk, 'сервер поднялся');
  await until(() => sent.some((m) => String(m.chat_id) === ADMIN), 4000);   /* бот проснулся */

  const reg = await api('POST', '/api/register', { email: 'inv1@t.ru', name: 'ООО Ромашка', role: 'advertiser', password: 'парольВ12345' });
  ok(reg.status === 200 && reg.body.token, 'рекламодатель зарегистрирован', reg.body);
  const T = reg.body.token;
  const INN10 = innFix('770708389');
  const INN12 = innFix('5001007322');

  /* ── заявка ── */
  ok((await api('POST', '/api/topup/invoice', { amount: 50000, company: 'ООО Ромашка', inn: INN10 })).status === 401, 'без входа — 401');
  const badInn = await api('POST', '/api/topup/invoice', { amount: 50000, company: 'ООО Ромашка', inn: '7707083890' }, T);
  ok(badInn.status === 400 && /ИНН/.test(badInn.body.error), 'ИНН с неверной контрольной цифрой — отказ', badInn.body);
  const small = await api('POST', '/api/topup/invoice', { amount: 5000, company: 'ООО Ромашка', inn: INN10 }, T);
  ok(small.status === 400 && /10 000/.test(small.body.error), 'меньше 10 000 ₽ — отказ с суммой в тексте', small.body);
  const noCo = await api('POST', '/api/topup/invoice', { amount: 50000, company: ' ', inn: INN10 }, T);
  ok(noCo.status === 400, 'без компании — отказ', noCo.body);
  const n0 = sent.length;
  const inv = await api('POST', '/api/topup/invoice', { amount: 50000, company: '  ООО   Ромашка ', inn: INN10, comment: 'Нужен договор' }, T);
  ok(inv.status === 200 && inv.body.id && /^[0-9a-f]{12}$/.test(inv.body.code) && inv.body.bot === 'test_bot', 'заявка создана: номер, метка, имя бота', inv.body);
  const ID = inv.body.id, CODE = inv.body.code;
  const alert = await until(() => sent.slice(n0).find((m) => String(m.chat_id) === ADMIN && /Заявка на пополнение по счёту №/.test(m.text)));
  ok(!!alert && /50 000 ₽/.test(alert.text) && /ООО Ромашка/.test(alert.text) && alert.text.includes(INN10) && /Нужен договор/.test(alert.text),
    'владельцу в Телеграм: сумма, компания (без лишних пробелов), ИНН, комментарий', alert && alert.text);
  const mine0 = await api('GET', '/api/topup/invoices', null, T);
  ok(mine0.status === 200 && mine0.body.rows[0].id === ID && mine0.body.rows[0].status === 'new' && mine0.body.rows[0].code === CODE && mine0.body.min === 10000,
    'в «моих заявках»: новая, с меткой для ссылки', mine0.body.rows && mine0.body.rows[0]);

  /* ── клиент открыл бота по ссылке ── */
  const s1 = sent.length;
  push({ message_id: 1001, chat: { id: 777, type: 'private' }, from: { id: 777, username: 'client1', first_name: 'Иван' }, text: '/start inv_' + CODE });
  const hi = await until(() => sent.slice(s1).find((m) => String(m.chat_id) === '777'));
  ok(!!hi && new RegExp('№' + ID).test(hi.text) && /50 000 ₽/.test(hi.text) && /менеджер/i.test(hi.text), 'клиенту в боте: номер заявки, сумма, что будет дальше', hi && hi.text);
  const toAdm = await until(() => sent.slice(s1).find((m) => String(m.chat_id) === ADMIN && /на связи в боте/.test(m.text)));
  ok(!!toAdm && /@client1/.test(toAdm.text) && /Ответьте на это сообщение/.test(toAdm.text), 'владельцу: клиент на связи, @ник, как ответить', toAdm && toAdm.text);
  const mine1 = await api('GET', '/api/topup/invoices', null, T);
  ok(mine1.body.rows[0].status === 'linked' && mine1.body.rows[0].tg === true, 'заявка связана с чатом', mine1.body.rows[0]);

  /* ── переписка ── */
  const s2 = sent.length, c2 = copies.length;
  push({ message_id: 1002, chat: { id: 777, type: 'private' }, from: { id: 777, username: 'client1' }, text: 'Нужен договор и закрывающие' });
  const hdr = await until(() => sent.slice(s2).find((m) => String(m.chat_id) === ADMIN && /Счёт №/.test(m.text) && /пишет/.test(m.text)));
  const cp = await until(() => copies.slice(c2).find((m) => String(m.chat_id) === ADMIN && String(m.from_chat_id) === '777' && m.message_id === 1002));
  ok(!!hdr && !!cp, 'сообщение клиента ушло владельцу (заголовок + копия)', { hdr, cp });
  ok(!sent.slice(s2).some((m) => String(m.chat_id) === '777'), 'клиенту бот не отвечает своей заглушкой — разговор идёт с менеджером');
  const c3 = copies.length, s3 = sent.length;
  push({ message_id: 2001, chat: { id: Number(ADMIN), type: 'private' }, from: { id: Number(ADMIN) }, text: 'Счёт во вложении', reply_to_message: { message_id: hdr._id } });
  const back = await until(() => copies.slice(c3).find((m) => String(m.chat_id) === '777' && String(m.from_chat_id) === ADMIN && m.message_id === 2001));
  ok(!!back, 'ответ владельца на заголовок — клиенту', copies.slice(c3));
  ok(!!(await until(() => sent.slice(s3).find((m) => String(m.chat_id) === ADMIN && /Передано клиенту/.test(m.text)))), 'владельцу — «передано»');
  const c4 = copies.length;
  push({ message_id: 2002, chat: { id: Number(ADMIN), type: 'private' }, from: { id: Number(ADMIN) }, text: 'и ещё', reply_to_message: { message_id: cp._id } });
  ok(!!(await until(() => copies.slice(c4).find((m) => String(m.chat_id) === '777' && m.message_id === 2002))), 'ответ на копию сообщения клиента — тоже клиенту');
  const c5 = copies.length;
  push({ message_id: 2003, chat: { id: Number(ADMIN), type: 'private' }, from: { id: Number(ADMIN) }, text: 'не туда', reply_to_message: { message_id: 1 } });
  await sleep(700);
  ok(!copies.slice(c5).length, 'ответ на постороннее сообщение никуда не пересылается');
  const s6 = sent.length;
  push({ message_id: 1003, chat: { id: 888, type: 'private' }, from: { id: 888 }, text: '/start inv_ffffffffffff' });
  ok(!!(await until(() => sent.slice(s6).find((m) => String(m.chat_id) === '888' && /не найдена/.test(m.text)))), 'чужая или старая метка — «заявка не найдена»');
  const s7 = sent.length;
  push({ message_id: 1004, chat: { id: 888, type: 'private' }, from: { id: 888 }, text: 'привет' });
  ok(!!(await until(() => sent.slice(s7).find((m) => String(m.chat_id) === '888' && /приложени/.test(m.text)))), 'без заявки бот отвечает как раньше');

  /* ── зачисление ── */
  ok((await api('POST', '/api/admin/invoices/credit', { id: ID })).status === 403, 'зачислить без ключа владельца нельзя');
  const list = await api('GET', '/api/admin/invoices?status=open', null, null, true);
  ok(list.status === 200 && list.body.rows.some((r) => r.id === ID && r.tg_user === '@client1' && r.user_email === 'inv1@t.ru'), 'в админке «Счета»: заявка с Телеграмом и почтой', list.body.rows && list.body.rows[0]);
  const ov0 = await api('GET', '/api/admin/overview', null, null, true);
  ok(ov0.body.счетов_ждут === 1, 'значок «Счета» на обзоре: 1', ov0.body.счетов_ждут);
  const s8 = sent.length;
  const cr = await api('POST', '/api/admin/invoices/credit', { id: ID }, null, true);
  ok(cr.status === 200 && cr.body.amount === 50000 && !cr.body.repeated, 'зачислено 50 000 ₽', cr.body);
  const b1 = await api('GET', '/api/balance', null, T);
  ok(b1.body.available === 50000, 'на балансе рекламодателя 50 000 ₽', b1.body);
  const cr2 = await api('POST', '/api/admin/invoices/credit', { id: ID }, null, true);
  const b2 = await api('GET', '/api/balance', null, T);
  ok(cr2.status === 200 && cr2.body.repeated && b2.body.available === 50000, 'повторное «зачислить» второй раз не платит', { cr2: cr2.body, b2: b2.body });
  const cr3 = await api('POST', '/api/admin/invoices/credit', { id: ID, amount: 60000 }, null, true);
  ok(cr3.status === 409, 'другая сумма по оплаченному счёту — 409', cr3.body);
  ok(!!(await until(() => sent.slice(s8).find((m) => String(m.chat_id) === '777' && /Оплата по счёту №/.test(m.text) && /50 000 ₽/.test(m.text)))), 'клиенту в бот: оплата получена');
  const mine2 = await api('GET', '/api/topup/invoices', null, T);
  ok(mine2.body.rows[0].status === 'paid' && mine2.body.rows[0].paid === 50000 && mine2.body.rows[0].code === undefined, 'у клиента: «оплачено», метка больше не выдаётся', mine2.body.rows[0]);
  const led = await api('GET', '/api/ledger', null, T);
  ok((led.body.rows || []).some((r) => r.kind === 'topup' && r.amount === 50000 && /по счёту №/.test(r.ref || '')), 'в журнале — пополнение по счёту', led.body.rows);
  const ov = await api('GET', '/api/admin/overview', null, null, true);
  ok(ov.body.сверка && ov.body.сверка.сходится === true && ov.body.счетов_ждут === 0, 'сверка денег сходится, открытых счетов нет', ov.body.сверка);
  const s9 = sent.length;
  push({ message_id: 1005, chat: { id: 777, type: 'private' }, from: { id: 777 }, text: 'спасибо' });
  ok(!!(await until(() => sent.slice(s9).find((m) => String(m.chat_id) === '777' && /приложени/.test(m.text)))), 'после оплаты переписка закрыта — обычный ответ бота');

  /* ── отклонение ── */
  const inv2 = await api('POST', '/api/topup/invoice', { amount: 12000, company: 'ИП Петров', inn: INN12 }, T);
  ok(inv2.status === 200, 'вторая заявка, ИНН ИП из 12 цифр', inv2.body);
  ok((await api('POST', '/api/admin/invoices/reject', { id: inv2.body.id, note: 'дубль' })).status === 403, 'закрыть без ключа нельзя');
  const rj = await api('POST', '/api/admin/invoices/reject', { id: inv2.body.id, note: 'дубль' }, null, true);
  ok(rj.status === 200 && rj.body.status === 'rejected', 'заявка закрыта', rj.body);
  ok((await api('POST', '/api/admin/invoices/credit', { id: inv2.body.id }, null, true)).status === 409, 'закрытую зачислить нельзя');
  ok((await api('POST', '/api/admin/invoices/reject', { id: ID }, null, true)).status === 409, 'оплаченную закрыть нельзя');
  const mine3 = await api('GET', '/api/topup/invoices', null, T);
  ok(mine3.body.rows[0].status === 'rejected' && mine3.body.rows[0].note === 'дубль', 'у клиента: закрыта с причиной', mine3.body.rows[0]);

  /* ── не больше пяти открытых ── */
  let last = null;
  for (let i = 0; i < 6; i++) last = await api('POST', '/api/topup/invoice', { amount: 10000 + i, company: 'ООО Ромашка', inn: INN10 }, T);
  ok(last.status === 429, 'шестая открытая заявка — отказ', last.body);

  /* ── чужая заявка не видна ── */
  const reg2 = await api('POST', '/api/register', { email: 'inv2@t.ru', name: 'Другой', role: 'advertiser', password: 'парольВ12345' });
  const other = await api('GET', '/api/topup/invoices', null, reg2.body.token);
  ok(other.status === 200 && other.body.rows.length === 0, 'другой человек чужих заявок не видит', other.body);

  /* ── ключ зачисления не занять заранее (аудит 16.10.2026) ──
     Было: ключ 'invoice:<номер>' строил сервер, номера идут подряд — любой
     с 1 ₽ на балансе занимал будущие номера заморозкой, и оплаченный счёт
     потом не зачислялся (409 «opKey уже занят»). Теперь ключ служебный
     sys:invoice:<номер>, а обе приставки из приложения не принимаются.
     Записи «до исправления» кладём прямо в базу сервера. */
  const db = new DatabaseSync(path.join(dir, 'db.sqlite'));
  db.exec('PRAGMA busy_timeout = 5000');
  const uidOf = (email) => db.prepare('SELECT id FROM users WHERE email = ?').get(email).id;
  const reg3 = await api('POST', '/api/register', { email: 'inv3@t.ru', name: 'ООО Лютик', role: 'advertiser', password: 'парольВ12345' });
  const T3 = reg3.body.token, U1 = uidOf('inv1@t.ru'), U3 = uidOf('inv3@t.ru');
  const balOf = async (tok) => (await api('GET', '/api/balance', null, tok)).body.available;
  const NEXT = db.prepare('SELECT COALESCE(MAX(id), 0) + 1 AS n FROM invoice_requests').get().n;
  const t0 = await balOf(T);
  for (const k of ['invoice:' + NEXT, 'INVOICE:' + NEXT, ' invoice:' + NEXT, 'sys:invoice:' + NEXT]) {
    const sq = await api('POST', '/api/deals/hold', { dealId: 'sq-' + Math.random().toString(36).slice(2), amount: 1, opKey: k }, T);
    ok(sq.status === 400 && /служебн/.test(sq.body.error || ''), 'чужой не занимает заранее ключ «' + k + '»', sq.body);
  }
  ok(await balOf(T) === t0, 'попытки занять ключ денег не тронули');
  const inv3 = await api('POST', '/api/topup/invoice', { amount: 20000, company: 'ООО Лютик', inn: INN10 }, T3);
  ok(inv3.status === 200 && inv3.body.id === NEXT, 'заявка получила тот самый номер', inv3.body);
  const cr4 = await api('POST', '/api/admin/invoices/credit', { id: NEXT }, null, true);
  ok(cr4.status === 200 && cr4.body.amount === 20000 && !cr4.body.repeated && await balOf(T3) === 20000, 'счёт зачислен', cr4.body);
  const op4 = db.prepare('SELECT user_id, kind FROM ops WHERE op_key = ?').get('sys:invoice:' + NEXT);
  ok(!!op4 && op4.user_id === U3 && op4.kind === 'topup', 'ключ зачисления — служебный sys:invoice:<номер>', op4);

  /* номер, занятый чужим ДО исправления, зачислению не мешает */
  const inv4 = await api('POST', '/api/topup/invoice', { amount: 15000, company: 'ООО Лютик', inn: INN10 }, T3);
  const ID4 = inv4.body.id;
  db.prepare("INSERT INTO ops (op_key, user_id, kind, result) VALUES (?, ?, 'hold', '{}')").run('invoice:' + ID4, U1);
  const v0 = await balOf(T3);
  const cr5 = await api('POST', '/api/admin/invoices/credit', { id: ID4 }, null, true);
  const v1 = await balOf(T3);
  ok(cr5.status === 200 && !cr5.body.repeated && v1 - v0 === 15000, 'старая чужая запись invoice:<номер> не мешает зачислить', { cr5: cr5.body, d: v1 - v0 });
  const cr6 = await api('POST', '/api/admin/invoices/credit', { id: ID4 }, null, true);
  ok(cr6.status === 200 && cr6.body.repeated && await balOf(T3) === v1, 'повтор — без второго зачисления', cr6.body);

  /* счёт, зачисленный ДО исправления прежним ключом: повтор не платит второй раз */
  const inv5 = await api('POST', '/api/topup/invoice', { amount: 11000, company: 'ООО Лютик', inn: INN10 }, T3);
  const ID5 = inv5.body.id, K5 = 'invoice:' + ID5;
  db.exec('BEGIN IMMEDIATE');
  db.prepare("INSERT INTO ops (op_key, user_id, kind, result) VALUES (?, ?, 'topup', ?)").run(K5, U3, JSON.stringify({ ok: true, id: ID5, amount: 11000, fee: 770, total: 11770 }));
  db.prepare("INSERT INTO ledger (op_key, user_id, bucket, amount, kind, ref) VALUES (?, ?, 'available', 11000, 'topup', ?)").run(K5, U3, 'пополнение по счёту №' + ID5);
  db.prepare("INSERT INTO ledger (op_key, user_id, bucket, amount, kind, ref) VALUES (?, 0, 'available', 770, 'topup-fee', ?)").run(K5, 'комиссия пополнения по счёту №' + ID5);
  db.prepare("UPDATE invoice_requests SET status = 'paid', paid = 11000 WHERE id = ?").run(ID5);
  db.exec('COMMIT');
  const w0 = await balOf(T3);
  const cr7 = await api('POST', '/api/admin/invoices/credit', { id: ID5 }, null, true);
  ok(cr7.status === 200 && cr7.body.repeated && await balOf(T3) === w0 && !db.prepare('SELECT 1 FROM ops WHERE op_key = ?').get('sys:invoice:' + ID5),
    'счёт, зачисленный прежним ключом, второй раз не платит', cr7.body);

  /* «оплачен», а записи зачисления нет — не платим вслепую */
  const inv6 = await api('POST', '/api/topup/invoice', { amount: 10000, company: 'ООО Лютик', inn: INN10 }, T3);
  db.prepare("UPDATE invoice_requests SET status = 'paid', paid = 10000 WHERE id = ?").run(inv6.body.id);
  const x0 = await balOf(T3);
  const cr8 = await api('POST', '/api/admin/invoices/credit', { id: inv6.body.id }, null, true);
  ok(cr8.status === 409 && await balOf(T3) === x0, '«оплачен» без записи зачисления — 409, без денег', cr8.body);
  const ov3 = await api('GET', '/api/admin/overview', null, null, true);
  ok(ov3.body.сверка && ov3.body.сверка.сходится === true, 'сверка денег сходится', ov3.body.сверка);
  db.close();
} catch (e) {
  failed++; console.log('  FAIL исключение: ' + (e && e.stack || e));
} finally {
  try { srv.kill(); } catch (e) {}
  try { stub.close(); } catch (e) {}
}
console.log('\nИтого: ' + passed + ' ok, ' + failed + ' FAIL');
process.exit(failed ? 1 : 0);
