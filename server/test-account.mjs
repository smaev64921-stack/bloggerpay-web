/* «Настройки» (15.10.2026): смена пароля вошедшим, выход на всех
   устройствах, запрос на удаление аккаунта. Настоящий server.js на своём
   порту 8496. Запуск: node test-account.mjs
   16.10.2026: вывод у аккаунта со служебной почтой (вход через Телеграм) —
   второй сервер на 8497 с «настроенной» почтой: Resend — заглушка этого
   теста через ретранслятор (RELAY_URL), писем наружу нет.
   Свои порты: BP_ACCT_PORT=<p> → p и p+1. */
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = +(process.env.BP_ACCT_PORT || 8496), BASE = 'http://127.0.0.1:' + PORT, KEY = 'test-acct-key';
const MPORT = PORT + 1, MBASE = 'http://127.0.0.1:' + MPORT, BOT = '4242:TEST-ACCT-MAIL';
let passed = 0, failed = 0;
function ok(c, name, extra) {
  if (c) { passed++; console.log('  ok  ' + name); }
  else { failed++; console.log('  FAIL ' + name + (extra !== undefined ? '  ← ' + JSON.stringify(extra).slice(0, 300) : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dir = mkdtempSync(path.join(tmpdir(), 'bp-acct-'));
const srv = spawn(process.execPath, ['server.js'], { cwd: fileURLToPath(new URL('.', import.meta.url)), stdio: process.env.BP_DEBUG ? 'inherit' : 'ignore', env: {
  ...process.env, PORT: String(PORT), DB_PATH: path.join(dir, 'db.sqlite'), ADMIN_KEY: KEY, ADMIN_EMAIL: '', PUBLIC_URL: BASE,
  TRUST_PROXY: '1', BOT_TOKEN: '', ADMIN_CHAT_ID: '', RESEND_API_KEY: '', TEST_TOPUP: '1', TEST_TOPUP_OPEN: '1', YOOKASSA_SHOP_ID: '', YOOKASSA_SECRET_KEY: '' } });
async function up() { for (let i = 0; i < 100; i++) { try { const r = await fetch(BASE + '/api/health'); await r.text(); if (r.ok) return true; } catch (e) {} await sleep(150); } return false; }
async function api(m, p, b, token, admin) {
  /* TRUST_PROXY=1 + свой адрес: на петле лимиты не считаются, а их тоже проверяем */
  const h = { 'Content-Type': 'application/json', 'X-Forwarded-For': '10.77.' + (process.pid % 250) + '.9' }; if (token) h.Authorization = 'Bearer ' + token; if (admin) h['X-Admin-Key'] = KEY;
  const r = await fetch(BASE + p, { method: m, headers: h, body: b ? JSON.stringify(b) : undefined });
  const t = await r.text(); let j = {}; try { j = JSON.parse(t); } catch (e) {} return { status: r.status, body: j };
}
let srvM = null, stub = null;   /* второй сервер и заглушка — раздел need_email */
const tag = Date.now().toString(36), email = 'acc' + tag + '@t.ru', P1 = 'пароль-первый-12', P2 = 'пароль-второй-34';
try {
  console.log('\nНастройки: пароль, сессии, удаление');
  ok(await up(), 'сервер поднялся');
  const reg = await api('POST', '/api/register', { email, name: 'Ваня', role: 'blogger', password: P1 });
  const T1 = reg.body.token;
  const T2 = (await api('POST', '/api/login', { email, password: P1 })).body.token;   // второе устройство
  const T3 = (await api('POST', '/api/login', { email, password: P1 })).body.token;   // третье
  ok(T1 && T2 && T3 && T1 !== T2, 'три устройства вошли в один аккаунт');

  const noAuth = await api('POST', '/api/password/change', { old: P1, password: P2 });
  ok(noAuth.status === 401, 'без входа пароль не меняется', noAuth.status);
  const short = await api('POST', '/api/password/change', { old: P1, password: 'корот' }, T1);
  ok(short.status === 400 && /минимум 8/.test(short.body.error || ''), 'новый пароль короче 8 символов — отказ', short.body);
  const wrong = await api('POST', '/api/password/change', { old: 'не-тот-пароль', password: P2 }, T1);
  ok(wrong.status === 403 && /не подходит/.test(wrong.body.error || '') && wrong.body.left === 4, 'неверный текущий пароль — «не подходит», осталось 4 попытки', wrong.body);
  const same = await api('POST', '/api/password/change', { old: P1, password: P1 }, T1);
  ok(same.status === 400 && /совпадает/.test(same.body.error || ''), 'новый пароль совпадает с текущим — отказ', same.body);
  const chg = await api('POST', '/api/password/change', { old: P1, password: P2 }, T1);
  ok(chg.status === 200 && chg.body.ok, 'пароль сменён', chg.body);
  ok((await api('GET', '/api/me', null, T1)).status === 200, 'это устройство осталось в аккаунте');
  ok((await api('GET', '/api/me', null, T2)).status === 401 && (await api('GET', '/api/me', null, T3)).status === 401, 'другие устройства вышли (их сессии погашены)');
  ok((await api('POST', '/api/login', { email, password: P1 })).status === 401, 'старый пароль больше не входит');
  const T4 = (await api('POST', '/api/login', { email, password: P2 })).body.token;
  ok(!!T4, 'новый пароль входит');

  /* перебор старого пароля упирается в паузу */
  let locked = false;
  for (let i = 0; i < 7 && !locked; i++) {
    const r = await api('POST', '/api/password/change', { old: 'перебор-' + i, password: 'новый-пароль-99' }, T4);
    if (r.status === 429) locked = true;
  }
  ok(locked, 'пять неверных старых паролей подряд — пауза 15 минут');
  const afterLock = await api('POST', '/api/password/change', { old: P2, password: 'новый-пароль-99' }, T4);
  ok(afterLock.status === 429, 'во время паузы даже верный пароль не меняется', afterLock.body);

  /* выйти на всех устройствах */
  const T5 = (await api('POST', '/api/login', { email, password: P2 })).body.token;
  const T6 = (await api('POST', '/api/login', { email, password: P2 })).body.token;
  const out = await api('POST', '/api/logout-all', {}, T5);
  ok(out.status === 200 && out.body.closed >= 2, '«Выйти на всех устройствах» — закрыты остальные сессии', out.body);
  ok((await api('GET', '/api/me', null, T5)).status === 200 && (await api('GET', '/api/me', null, T6)).status === 401 && (await api('GET', '/api/me', null, T4)).status === 401,
    'это устройство в аккаунте, остальные вышли');

  /* запрос на удаление */
  const del = await api('POST', '/api/account/delete-request', { why: 'больше не пользуюсь' }, T5);
  ok(del.status === 200 && del.body.ok, 'запрос на удаление аккаунта принят', del.body);
  const log = await api('GET', '/api/admin/log', null, null, true);
  const row = ((log.body && (log.body.rows || log.body.log)) || []).find((r) => r.action === 'erase-request');
  ok(!!row && /больше не пользуюсь/.test(String(row.detail || '')), 'владелец видит запрос в журнале админки', row || log.body);
  let lim = 0;
  for (let i = 0; i < 4; i++) { const r = await api('POST', '/api/account/delete-request', {}, T5); if (r.status === 429) lim++; }
  ok(lim >= 1, 'запросы на удаление не чаще трёх в час');
  ok((await api('POST', '/api/account/delete-request', {})).status === 401, 'без входа запрос не принимается');

  /* «в сети»: только если человек сам писал спрашивающему; можно выключить */
  const rA = await api('POST', '/api/register', { email: 'pa' + tag + '@t.ru', name: 'Аня', role: 'blogger', password: P1 });
  const rB = await api('POST', '/api/register', { email: 'pb' + tag + '@t.ru', name: 'Борис', role: 'advertiser', password: P1 });
  const TA = rA.body.token, TB = rB.body.token;
  const idOf = async (t) => { const b = (await api('GET', '/api/me', null, t)).body; return Number((b.user && b.user.id) || b.id); };
  const idA = await idOf(TA), idB = await idOf(TB);
  const dm = (t, from, to, id) => api('POST', '/api/sync/put', { kind: 'dm', rid: 'dm.' + from + '.' + to + '.' + id, data: { v: 1, t: 'привет', at: Date.now() }, to }, t);
  ok((await dm(TA, idA, idB, 'm1aaaa')).status === 200, 'Аня написала Борису');
  const p1 = await api('GET', '/api/presence?ids=' + idB, null, TA);
  ok(p1.status === 200 && p1.body.rows && p1.body.rows[idB] === undefined, 'Аня не видит «в сети» Бориса: он ей не писал (написать незнакомцу и следить нельзя)', p1.body);
  const p2 = await api('GET', '/api/presence?ids=' + idA, null, TB);
  ok(p2.body.rows && p2.body.rows[idA] && p2.body.rows[idA].on === true && Object.keys(p2.body.rows[idA]).join() === 'on', 'Борис видит, что Аня в сети, — только да/нет, без времени', p2.body);
  ok((await api('POST', '/api/presence/me', { show: false }, TA)).body.show === false, 'Аня выключила «Показывать, что я в сети»');
  const p3 = await api('GET', '/api/presence?ids=' + idA, null, TB);
  ok(p3.body.rows && p3.body.rows[idA] === undefined, 'после выключения Борис её «в сети» не видит', p3.body);
  ok((await api('GET', '/api/account/methods', null, TA)).body.presence === false, 'в «Настройках» переключатель — выключен (methods.presence)');
  await api('POST', '/api/presence/me', { show: true }, TA);
  ok(((await api('GET', '/api/presence?ids=' + idA, null, TB)).body.rows[idA] || {}).on === true, 'включила снова — видно');
  await dm(TB, idB, idA, 'm2bbbb');
  ok(((await api('GET', '/api/presence?ids=' + idB, null, TA)).body.rows[idB] || {}).on === true, 'Борис ответил — теперь и Аня видит его «в сети»');
  ok((await api('GET', '/api/presence?ids=' + idA)).status === 401 && (await api('POST', '/api/presence/me', { show: false })).status === 401, 'без входа — 401');

  await withdrawNeedsEmail();
} catch (e) {
  failed++; console.log('  FAIL исключение: ' + (e && e.stack || e));
} finally {
  try { srv.kill(); } catch (e) {}
  try { if (srvM) srvM.kill(); } catch (e) {}
  try { if (stub) stub.close(); } catch (e) {}
}

/* ── Вывод у аккаунта со служебной почтой (аудит 16.10.2026) ──────────
   Аккаунт из Телеграма заведён с почтой tg<id>@telegram.local. Когда почта
   на сервере настроена, код вывода уходил туда — в никуда, и вывести было
   нельзя. Теперь сервер до выдачи кода отвечает 400 need_email, денег и
   лимита кодов не трогает; после «Почты и пароля» код идёт на настоящую. */
async function withdrawNeedsEmail() {
  console.log('\nВывод: служебная почта → сначала настоящая (need_email)');
  const mails = [];
  /* заглушка: Resend через ретранслятор (/__relay/api.resend.com/…) и API Телеграма для бота */
  stub = http.createServer((req, res) => {
    let raw = ''; req.on('data', (c) => { raw += c; }); req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url.startsWith('/__relay/api.resend.com/')) {
        let j = {}; try { j = JSON.parse(raw); } catch (e) {}
        mails.push([].concat(j.to || []).join(','));
        return res.end(JSON.stringify({ id: 'stub-' + mails.length }));
      }
      const method = req.url.split('/').pop();
      if (method === 'getUpdates') { setTimeout(() => res.end(JSON.stringify({ ok: true, result: [] })), 400); return; }
      res.end(JSON.stringify({ ok: true, result: method === 'getMe' ? { id: 4242, username: 'acct_test_bot', first_name: 'Тест' } : (method === 'sendMessage' ? { message_id: 1 } : true) }));
    });
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  const SB = 'http://127.0.0.1:' + stub.address().port;
  const dirM = mkdtempSync(path.join(tmpdir(), 'bp-acct-mail-'));
  srvM = spawn(process.execPath, ['server.js'], { cwd: fileURLToPath(new URL('.', import.meta.url)), stdio: process.env.BP_DEBUG ? 'inherit' : 'ignore', env: {
    ...process.env, PORT: String(MPORT), DB_PATH: path.join(dirM, 'db.sqlite'), ADMIN_KEY: KEY, ADMIN_EMAIL: '', PUBLIC_URL: MBASE,
    TRUST_PROXY: '1', BOT_TOKEN: BOT, BOT_USERNAME: '', TG_API_BASE: SB, ADMIN_CHAT_ID: '',
    RESEND_API_KEY: 're_test_acct_stub', MAIL_DEBUG: '1', RELAY_URL: SB, RELAY_KEY: 'acct-relay', RELAY_REPORT: '0',
    TEST_TOPUP: '1', TEST_TOPUP_OPEN: '1', YOOKASSA_SHOP_ID: '', YOOKASSA_SECRET_KEY: '' } });
  let upM = false;
  for (let i = 0; i < 100 && !upM; i++) { try { const r = await fetch(MBASE + '/api/health'); await r.text(); upM = r.ok; } catch (e) {} if (!upM) await sleep(150); }
  ok(upM, 'второй сервер (почта настроена, Resend — заглушка) поднялся');
  const apiM = async (m, p, b, token, admin) => {
    const h = { 'Content-Type': 'application/json', 'X-Forwarded-For': '10.78.' + (process.pid % 250) + '.9' }; if (token) h.Authorization = 'Bearer ' + token; if (admin) h['X-Admin-Key'] = KEY;
    const r = await fetch(MBASE + p, { method: m, headers: h, body: b ? JSON.stringify(b) : undefined });
    const t = await r.text(); let j = {}; try { j = JSON.parse(t); } catch (e) {} return { status: r.status, body: j };
  };
  /* initData мини-аппа — как его подписывает Телеграм */
  const tgId = 600000 + (Date.now() % 99991);
  const params = new URLSearchParams();
  params.set('user', JSON.stringify({ id: tgId, first_name: 'Блогер', last_name: 'Из Телеграма' }));
  params.set('auth_date', String(Math.floor(Date.now() / 1000)));
  params.set('query_id', 'AAH' + Math.random().toString(36).slice(2, 10));
  const pairs = []; for (const [k, v] of params.entries()) pairs.push(k + '=' + v); pairs.sort();
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT).digest();
  params.set('hash', crypto.createHmac('sha256', secret).update(pairs.join('\n')).digest('hex'));
  const tg = await apiM('POST', '/api/auth/telegram', { initData: params.toString(), role: 'blogger' });
  const TT = tg.body.token;
  ok(tg.status === 200 && TT && /@telegram\.local$/.test(String(tg.body.user && tg.body.user.email)), 'вход мини-аппом: аккаунт со служебной почтой tg…@telegram.local', tg.body);
  await apiM('POST', '/api/topup', { amount: 5000, opKey: crypto.randomUUID() }, TT);
  const PHOTO = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';
  const SELFIE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
  const kyc = await apiM('POST', '/api/kyc/submit', { name: 'Иванов Пётр Иванович', birth: '02.02.1992', photo: PHOTO, selfie: SELFIE }, TT);
  const appr = await apiM('POST', '/api/admin/kyc/approve', { requestId: kyc.body.requestId }, null, true);
  ok(kyc.status === 200 && appr.status === 200, 'пополнил 5 000 ₽ и прошёл проверку личности', { kyc: kyc.body, appr: appr.body });

  const wd1 = await apiM('POST', '/api/withdraw', { amount: 1000, requisites: 'карта 2200 0000', opKey: crypto.randomUUID() }, TT);
  ok(wd1.status === 400 && wd1.body.code === 'need_email' && /укажите почту/i.test(wd1.body.error || '') && !wd1.body.needCode && !wd1.body.devCode,
    'вывод со служебной почтой — 400 need_email «Сначала укажите почту…», кода нет', wd1.body);
  ok(mails.length === 0, 'письмо на tg…@telegram.local не отправлялось', mails);
  let still = 0;
  for (let i = 0; i < 5; i++) { const r = await apiM('POST', '/api/withdraw', { amount: 1000, requisites: 'карта 2200 0000', opKey: crypto.randomUUID() }, TT); if (r.body.code === 'need_email') still++; }
  ok(still === 5 && mails.length === 0, 'повторные нажатия — тот же need_email, лимит кодов (5 в час) не сгорает', { still, mails });
  const b1 = (await apiM('GET', '/api/balance', null, TT)).body;
  ok(Number(b1.available) === 5000 && !Number(b1.hold), 'деньги не тронуты: доступно 5 000, в заморозке 0', b1);
  const m1 = (await apiM('GET', '/api/account/methods', null, TT)).body;
  ok(m1.needsEmail === true && m1.email === '', '«Способы входа»: почта не задана (needsEmail)', m1);

  const svc = await apiM('POST', '/api/account/email', { email: 'x' + tgId + '@google.local', password: 'пароль-тг-12345' }, TT);
  ok(svc.status === 400, 'служебный адрес google.local почтой не задать', svc.body);
  const realMail = 'tg' + tag + '@t.ru';
  const setM = await apiM('POST', '/api/account/email', { email: realMail, password: 'пароль-тг-12345' }, TT);
  ok(setM.status === 200 && setM.body.email === realMail, '«Почта и пароль»: настоящая почта задана', setM.body);
  const wd2 = await apiM('POST', '/api/withdraw', { amount: 1000, requisites: 'карта 2200 0000', opKey: crypto.randomUUID() }, TT);
  ok(wd2.status === 200 && wd2.body.needCode && wd2.body.sentTo === 'tg***@t.ru' && /^\d{6}$/.test(String(wd2.body.devCode || '')),
    'после этого код вывода уходит на настоящую почту (tg***@t.ru)', wd2.body);
  ok(mails.length === 1 && mails[0] === realMail, 'письмо ушло ровно на заданный адрес', mails);
  const wd3 = await apiM('POST', '/api/withdraw', { amount: 1000, requisites: 'карта 2200 0000', code: wd2.body.devCode, opKey: crypto.randomUUID() }, TT);
  const b2 = (await apiM('GET', '/api/balance', null, TT)).body;
  ok(wd3.status === 200 && wd3.body.status === 'queued' && Number(b2.available) === 4000 && Number(b2.hold) === 1000,
    'с кодом заявка создана: доступно 4 000, в заморозке 1 000', { wd3: wd3.body, b2 });

  const regG = await apiM('POST', '/api/register', { email: 'g' + tag + '@google.local', name: 'Захватчик', role: 'blogger', password: 'пароль-12345678' });
  ok(regG.status === 400, 'регистрация на служебный адрес google.local закрыта', regG.body);
}
console.log(`\nИтого: ${passed} ok, ${failed} FAIL`);
process.exit(failed ? 1 : 0);
