/* «Настройки» (15.10.2026): смена пароля вошедшим, выход на всех
   устройствах, запрос на удаление аккаунта. Настоящий server.js на своём
   порту 8496. Запуск: node test-account.mjs
   16.10.2026: вывод у аккаунта со служебной почтой (вход через Телеграм) —
   второй сервер на 8497 с «настроенной» почтой: Resend — заглушка этого
   теста через ретранслятор (RELAY_URL), писем наружу нет.
   Аудит 16.10.2026 (R3), на втором сервере: «Почта и пароль» только кодом
   с нового адреса, сброс пароля по коду на неподтверждённой почте отвязывает
   Телеграм и гасит сессии, перебор пароля — скидка только «двойнику»
   (производная + сырой), замок на почту после 50 промахов со всех адресов.
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
/* второй сервер: запросы, письма Resend, вход мини-аппом — заводит withdrawNeedsEmail */
let apiM = null, mailsM = null, tgLoginM = null;
const MDB = { path: '' };
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

  /* oldAlt (аудит 16.10.2026): окно «Пароль» шлёт текущий пароль двумя видами
     — производной (old) и как есть (oldAlt); промах за попытку — один */
  {
    const em2 = 'alt' + tag + '@t.ru', RAW = 'пароль-открытый-56', D1 = 'd'.repeat(64), D2 = 'e'.repeat(64);
    const T7 = (await api('POST', '/api/register', { email: em2, name: 'Старый', role: 'blogger', password: RAW })).body.token;
    const miss2 = await api('POST', '/api/password/change', { old: 'f'.repeat(64), oldAlt: 'не-тот', password: D1 }, T7);
    ok(miss2.status === 403 && miss2.body.left === 4, 'oldAlt: оба варианта мимо — один промах (осталось 4)', miss2.body);
    const alt = await api('POST', '/api/password/change', { old: 'f'.repeat(64), oldAlt: RAW, password: D1 }, T7);
    ok(alt.status === 200, 'oldAlt: подошёл пароль «как есть» — сменён на производную', alt.body);
    ok((await api('POST', '/api/login', { email: em2, password: D1 })).status === 200, 'oldAlt: новый (производная) входит');
    const alt2 = await api('POST', '/api/password/change', { old: D1, oldAlt: 'что-то-ещё', password: D2 }, T7);
    ok(alt2.status === 200, 'old (производная) подходит и с oldAlt рядом', alt2.body);
    const same2 = await api('POST', '/api/password/change', { old: D2, oldAlt: 'x', password: D2 }, T7);
    ok(same2.status === 400 && /совпадает/.test(same2.body.error || ''), 'oldAlt: «совпадает с текущим» по подошедшему варианту', same2.body);
  }

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
  if (apiM) { await emailBindByCode(); await resetUnlinks(); await loginBrute(); }
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
  MDB.path = path.join(dirM, 'db.sqlite');
  srvM = spawn(process.execPath, ['server.js'], { cwd: fileURLToPath(new URL('.', import.meta.url)), stdio: process.env.BP_DEBUG ? 'inherit' : 'ignore', env: {
    ...process.env, PORT: String(MPORT), DB_PATH: MDB.path, ADMIN_KEY: KEY, ADMIN_EMAIL: '', PUBLIC_URL: MBASE,
    TRUST_PROXY: '1', BOT_TOKEN: BOT, BOT_USERNAME: '', TG_API_BASE: SB, ADMIN_CHAT_ID: '',
    RESEND_API_KEY: 're_test_acct_stub', MAIL_DEBUG: '1', RELAY_URL: SB, RELAY_KEY: 'acct-relay', RELAY_REPORT: '0',
    TEST_TOPUP: '1', TEST_TOPUP_OPEN: '1', YOOKASSA_SHOP_ID: '', YOOKASSA_SECRET_KEY: '' } });
  let upM = false;
  for (let i = 0; i < 100 && !upM; i++) { try { const r = await fetch(MBASE + '/api/health'); await r.text(); upM = r.ok; } catch (e) {} if (!upM) await sleep(150); }
  ok(upM, 'второй сервер (почта настроена, Resend — заглушка) поднялся');
  /* ip — свой адрес (X-Forwarded-For при TRUST_PROXY=1): лимиты и паузы входа считаются по нему */
  apiM = async (m, p, b, token, admin, ip, cookie) => {
    const h = { 'Content-Type': 'application/json', 'X-Forwarded-For': ip || ('10.78.' + (process.pid % 250) + '.9') }; if (token) h.Authorization = 'Bearer ' + token; if (admin) h['X-Admin-Key'] = KEY; if (cookie) h.Cookie = cookie;
    const r = await fetch(MBASE + p, { method: m, headers: h, body: b ? JSON.stringify(b) : undefined });
    const t = await r.text(); let j = {}; try { j = JSON.parse(t); } catch (e) {} return { status: r.status, body: j, setCookie: r.headers.get('set-cookie') || '' };
  };
  mailsM = mails;
  /* initData мини-аппа — как его подписывает Телеграм */
  tgLoginM = (id) => {
    const params = new URLSearchParams();
    params.set('user', JSON.stringify({ id, first_name: 'Блогер', last_name: 'Из Телеграма' }));
    params.set('auth_date', String(Math.floor(Date.now() / 1000)));
    params.set('query_id', 'AAH' + Math.random().toString(36).slice(2, 10));
    const pairs = []; for (const [k, v] of params.entries()) pairs.push(k + '=' + v); pairs.sort();
    const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT).digest();
    params.set('hash', crypto.createHmac('sha256', secret).update(pairs.join('\n')).digest('hex'));
    return apiM('POST', '/api/auth/telegram', { initData: params.toString(), role: 'blogger' });
  };
  const tgId = 600000 + (Date.now() % 99991);
  const tg = await tgLoginM(tgId);
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
  const setM1 = await apiM('POST', '/api/account/email', { email: realMail, password: 'пароль-тг-12345' }, TT);
  ok(setM1.status === 200 && setM1.body.needCode === true && setM1.body.sentTo === realMail && /^\d{6}$/.test(String(setM1.body.devCode || '')),
    '«Почта и пароль»: сначала код на новый адрес (needCode, sentTo)', setM1.body);
  ok(mails.length === 1 && mails[0] === realMail, 'письмо с кодом ушло на новый адрес', mails);
  const setM = await apiM('POST', '/api/account/email', { email: realMail, code: setM1.body.devCode }, TT);
  ok(setM.status === 200 && setM.body.email === realMail && setM.body.verified === true, '«Почта и пароль»: код верный — настоящая почта задана', setM.body);
  const wd2 = await apiM('POST', '/api/withdraw', { amount: 1000, requisites: 'карта 2200 0000', opKey: crypto.randomUUID() }, TT);
  ok(wd2.status === 200 && wd2.body.needCode && wd2.body.sentTo === 'tg***@t.ru' && /^\d{6}$/.test(String(wd2.body.devCode || '')),
    'после этого код вывода уходит на настоящую почту (tg***@t.ru)', wd2.body);
  ok(mails.length === 2 && mails[1] === realMail, 'письмо ушло ровно на заданный адрес', mails);
  const wd3 = await apiM('POST', '/api/withdraw', { amount: 1000, requisites: 'карта 2200 0000', code: wd2.body.devCode, opKey: crypto.randomUUID() }, TT);
  const b2 = (await apiM('GET', '/api/balance', null, TT)).body;
  ok(wd3.status === 200 && wd3.body.status === 'queued' && Number(b2.available) === 4000 && Number(b2.hold) === 1000,
    'с кодом заявка создана: доступно 4 000, в заморозке 1 000', { wd3: wd3.body, b2 });

  const regG = await apiM('POST', '/api/register', { email: 'g' + tag + '@google.local', name: 'Захватчик', role: 'blogger', password: 'пароль-12345678' });
  ok(regG.status === 400, 'регистрация на служебный адрес google.local закрыта', regG.body);
}

/* ── «Почта и пароль» только кодом с нового адреса (аудит 16.10.2026) ──
   Захват заранее: аккаунт из Телеграма записывал на себя чужую почту без
   проверки, хозяин почты потом входил «Забыли пароль?» в этот же аккаунт,
   а у захватчика оставался вход Телеграмом. */
async function methodsM(t) { return (await apiM('GET', '/api/account/methods', null, t)).body; }
async function meIdM(t) { const b = (await apiM('GET', '/api/me', null, t)).body; return Number((b.user && b.user.id) || b.id); }
async function emailBindByCode() {
  console.log('\nПочта к аккаунту из Телеграма — только кодом с этого адреса');
  const PW = 'пароль-захвата-1', IPA = '10.79.1.9';
  const a = await tgLoginM(700000 + (Date.now() % 99991));
  const b = await tgLoginM(710000 + (Date.now() % 99991));
  const TA = a.body.token, TB = b.body.token;
  ok(!!TA && !!TB, 'два аккаунта из Телеграма (служебные почты)');
  const E1 = 'svoya' + tag + '@t.ru', E2 = 'drugaya' + tag + '@t.ru';
  const n0 = mailsM.length;
  const s1 = await apiM('POST', '/api/account/email', { email: E1, password: PW }, TA, null, IPA);
  ok(s1.status === 200 && s1.body.needCode === true && s1.body.sentTo === E1 && /^\d{6}$/.test(String(s1.body.devCode || '')),
    'без кода: ответ needCode + sentTo, код ушёл письмом', s1.body);
  ok(mailsM.length === n0 + 1 && mailsM[mailsM.length - 1] === E1, 'письмо — ровно на новый адрес', mailsM.slice(n0));
  const mA = await methodsM(TA);
  ok(mA.needsEmail === true && mA.email === '' && mA.emailVerified === false, 'привязка без кода почту НЕ меняет', mA);
  ok((await apiM('POST', '/api/login', { email: E1, password: PW }, null, null, '10.79.1.1')).status === 401, 'по этой почте войти нельзя, пока код не введён');
  const again = await apiM('POST', '/api/account/email', { email: E1, password: PW }, TA, null, IPA);
  ok(again.status === 429 && again.body.code === 'cooldown' && again.body.wait > 0, 'новый код — не раньше чем через минуту', again.body);

  const code = s1.body.devCode, wrongCode = code === '000000' ? '111111' : '000000';
  const w1 = await apiM('POST', '/api/account/email', { email: E1, code: wrongCode }, TA, null, IPA);
  ok(w1.status === 400 && w1.body.needCode === true && /Неверный код/.test(w1.body.error || '') && !w1.body.dead, 'неверный код — «Неверный код», почта не меняется', w1.body);
  ok((await methodsM(TA)).needsEmail === true, 'после неверного кода почта так и не задана');
  const other = await apiM('POST', '/api/account/email', { email: E2, code }, TA, null, IPA);
  ok(other.status === 400 && other.body.dead === true, 'код, выданный на другой адрес, другую почту не подтверждает', other.body);
  const foreign = await apiM('POST', '/api/account/email', { email: E1, code, password: PW }, TB, null, '10.79.2.1');
  ok(foreign.status === 400 && (await methodsM(TB)).needsEmail === true, 'чужой аккаунт этим кодом почту не получит (код привязан к аккаунту)', foreign.body);
  /* второй аккаунт тоже ждёт код на E1 — проверим потом, что адрес уже занят */
  const sB = await apiM('POST', '/api/account/email', { email: E1, password: PW }, TB, null, '10.79.2.2');
  ok(sB.status === 429 && sB.body.code === 'cooldown', 'на один адрес — не чаще письма в минуту и с разных аккаунтов', sB.body);

  const good = await apiM('POST', '/api/account/email', { email: E1, code }, TA, null, IPA);
  ok(good.status === 200 && good.body.email === E1 && good.body.verified === true, 'верный код — почта привязана', good.body);
  const mA2 = await methodsM(TA);
  ok(mA2.email === E1 && mA2.needsEmail === false && mA2.emailVerified === true && mA2.telegram === true, '«Способы входа»: почта задана и подтверждена, Телеграм на месте', mA2);
  const li = await apiM('POST', '/api/login', { email: E1, password: PW }, null, null, '10.79.1.2');
  ok(li.status === 200 && li.body.user && li.body.user.id === await meIdM(TA), 'вход по новой почте (пароль из первого шага) — в ТОТ ЖЕ аккаунт', li.body);
  const reuse = await apiM('POST', '/api/account/email', { email: E1, code }, TA, null, IPA);
  ok(reuse.status === 400, 'повтор того же кода — отказ (почта уже есть, код погашен)', reuse.body);
  const taken = await apiM('POST', '/api/account/email', { email: E1, password: PW }, TB, null, '10.79.2.3');
  ok(taken.status === 409, 'чужая занятая почта — 409', taken.body);

  /* пять неверных — код мёртв, и верный уже не подходит */
  const E3 = 'tretya' + tag + '@t.ru';
  const s3 = await apiM('POST', '/api/account/email', { email: E3, password: PW }, TB, null, '10.79.2.4');
  ok(s3.status === 200 && /^\d{6}$/.test(String(s3.body.devCode || '')), 'второй аккаунт запросил код на свой адрес', s3.body);
  const bad3 = s3.body.devCode === '999999' ? '888888' : '999999';
  let last = null;
  for (let i = 0; i < 5; i++) last = await apiM('POST', '/api/account/email', { email: E3, code: bad3 }, TB, null, '10.79.2.4');
  ok(last && last.status === 400 && last.body.dead === true, 'пятый неверный код — код сгорел (dead)', last && last.body);
  const late = await apiM('POST', '/api/account/email', { email: E3, code: s3.body.devCode }, TB, null, '10.79.2.4');
  ok(late.status === 400 && /попыток/.test(late.body.error || '') && (await methodsM(TB)).needsEmail === true, 'после пяти промахов и верный код не привязывает', late.body);
}

/* ── Сброс пароля по коду: неподтверждённая почта — прочь чужие входы ── */
async function resetUnlinks() {
  console.log('\nСброс пароля: неподтверждённая почта отвязывает Телеграм, подтверждённая — нет');
  const { DatabaseSync } = await import('node:sqlite');
  const reset = async (email, pass, ip) => {
    const f = await apiM('POST', '/api/password/forgot', { email }, null, null, ip);
    if (!f.body.devCode) return { status: 0, body: f.body };
    return apiM('POST', '/api/password/reset', { email, code: f.body.devCode, password: pass }, null, null, ip);
  };
  /* подтверждённая: привязана кодом */
  const tgV = 720000 + (Date.now() % 99991);
  const TV = (await tgLoginM(tgV)).body.token;
  const EV = 'podtv' + tag + '@t.ru';
  const sv = await apiM('POST', '/api/account/email', { email: EV, password: 'пароль-старый-1' }, TV, null, '10.80.1.1');
  await apiM('POST', '/api/account/email', { email: EV, code: sv.body.devCode }, TV, null, '10.80.1.1');
  const idV = await meIdM(TV);
  const rV = await reset(EV, 'пароль-новый-11', '10.80.1.2');
  ok(rV.status === 200 && rV.body.token && !rV.body.unlinked, 'сброс по коду на подтверждённой почте — прошёл, ничего не отвязано', rV.body);
  const mV = await methodsM(rV.body.token);
  ok(mV.telegram === true && mV.emailVerified === true, 'Телеграм у подтверждённой почты остался', mV);
  const backV = await tgLoginM(tgV);
  ok(backV.status === 200 && backV.body.user && backV.body.user.id === idV, 'вход Телеграмом ведёт в тот же аккаунт', backV.body);

  /* неподтверждённая: так выглядит аккаунт, куда почту записали без кода
     до заплаты (захват заранее) — ставим метку 0 прямо в базе */
  const tgX = 730000 + (Date.now() % 99991);
  const TX = (await tgLoginM(tgX)).body.token;
  const EX = 'chuzhaya' + tag + '@t.ru';
  const sx = await apiM('POST', '/api/account/email', { email: EX, password: 'пароль-захватчика' }, TX, null, '10.80.2.1');
  await apiM('POST', '/api/account/email', { email: EX, code: sx.body.devCode }, TX, null, '10.80.2.1');
  const idX = await meIdM(TX);
  const db = new DatabaseSync(MDB.path);
  try { db.prepare('UPDATE users SET email_verified = 0 WHERE id = ?').run(idX); } finally { db.close(); }
  ok((await methodsM(TX)).emailVerified === false && (await methodsM(TX)).telegram === true, 'аккаунт: чужая почта без подтверждения + Телеграм захватчика');
  const TX2 = (await tgLoginM(tgX)).body.token;   /* второе устройство захватчика */
  const rX = await reset(EX, 'пароль-хозяина-1', '10.80.2.2');
  ok(rX.status === 200 && rX.body.token && rX.body.unlinked && rX.body.unlinked.telegram === true, 'хозяин почты сбросил пароль по коду — ответ: Телеграм отвязан', rX.body);
  ok((await apiM('GET', '/api/me', null, TX)).status === 401 && (await apiM('GET', '/api/me', null, TX2)).status === 401, 'все сессии захватчика погашены');
  const mX = await methodsM(rX.body.token);
  ok(mX.telegram === false && mX.google === false && mX.emailVerified === true && mX.email === EX, 'в аккаунте: Телеграма нет, почта подтверждена', mX);
  const tgAgain = await tgLoginM(tgX);
  ok(tgAgain.status === 200 && tgAgain.body.user && tgAgain.body.user.id !== idX && /@telegram\.local$/.test(String(tgAgain.body.user.email)),
    'Телеграм захватчика теперь ведёт в НОВЫЙ пустой аккаунт, а не к хозяину почты', tgAgain.body);
}

/* ── Перебор пароля (аудит 16.10.2026, R3) ── */
async function loginBrute() {
  console.log('\nПеребор пароля: скидка только «двойнику», замок на почту');
  const PWD = 'пароль-хозяина-77';
  const reg = async (em) => apiM('POST', '/api/register', { email: em, name: 'Хозяин', role: 'blogger', password: PWD }, null, null, '10.81.0.' + (1 + Math.floor(Math.random() * 200)));
  const hex = () => crypto.randomBytes(32).toString('hex');
  const login = (em, pw, ip) => apiM('POST', '/api/login', { email: em, password: pw }, null, null, ip);
  /* 1) чередование производной и сырого пароля с одного адреса */
  const EA = 'brA' + tag + '@t.ru'; await reg(EA);
  let misses = 0, st = null;
  for (let i = 0; i < 30; i++) {
    const r = await login(EA, i % 2 ? 'не-тот-' + i : hex(), '10.82.1.1');
    if (r.status === 401) misses++; else { st = r; break; }
  }
  ok(misses === 13 && st && st.status === 429 && st.body.code === 'login_paused',
    'чередование hex/сырой: пауза пары после 13 промахов (10 со скидкой полпромаха на каждую пару, раньше — 19)', { misses, st: st && st.body });
  /* 2) частые попытки одного вида — полный счёт */
  const EB = 'brB' + tag + '@t.ru'; await reg(EB);
  misses = 0; st = null;
  for (let i = 0; i < 30; i++) {
    const r = await login(EB, 'не-тот-' + i, '10.82.2.1');
    if (r.status === 401) misses++; else { st = r; break; }
  }
  ok(misses === 10 && st && st.status === 429 && st.body.code === 'login_paused', 'частые сырые пароли подряд — полный счёт, пауза после 10', { misses, st: st && st.body });
  misses = 0; st = null;
  for (let i = 0; i < 30; i++) {
    const r = await login(EB, hex(), '10.82.2.2');
    if (r.status === 401) misses++; else { st = r; break; }
  }
  ok(misses === 10 && st && st.status === 429, 'частые производные подряд — тоже полный счёт', { misses, st: st && st.body });
  ok((await login(EB, PWD, '10.82.2.3')).status === 200, 'хозяин с другого адреса входит (пауза — только на пару почта+адрес)');

  /* 3) замок на почту: 50 промахов со всех адресов */
  const EL = 'brL' + tag + '@t.ru'; await reg(EL);
  for (let i = 0; i < 20; i++) {
    const r = await login(EL, 'перебор-' + i, '10.83.' + i + '.1');
    if (r.status !== 401) { ok(false, 'промах ' + i + ' — ожидался 401', r); break; }
  }
  const owner1 = await login(EL, PWD, '10.84.0.1');
  ok(owner1.status === 200 && owner1.body.token, 'после 20 промахов с разных адресов хозяин с верным паролем проходит (потолок не достигнут)', owner1.body);
  /* 40 одновременно: замедление (sleep) их не пропускает — ровно 30 промахов до потолка 50 */
  const burst = await Promise.all(Array.from({ length: 40 }, (_, i) => login(EL, 'пачка-' + i, '10.85.' + i + '.1')));
  const n401 = burst.filter((r) => r.status === 401).length;
  const lk = burst.filter((r) => r.status === 429 && r.body.code === 'login_locked');
  ok(n401 === 30 && lk.length === 10, '40 одновременных попыток: 30 промахов до потолка 50, остальные — 429 (параллельно не обойти)', { n401, n429: lk.length, other: burst.filter((r) => r.status !== 401 && r.status !== 429).map((r) => r.status) });
  const owner2 = await login(EL, PWD, '10.84.0.2');
  ok(owner2.status === 429 && owner2.body.code === 'login_locked' && /Слишком много попыток входа к этой почте/.test(owner2.body.error || '') && /Забыли пароль/.test(owner2.body.error || ''),
    'замок: и верный пароль с нового адреса — 429 «Слишком много попыток входа к этой почте… «Забыли пароль?»»', owner2.body);
  const xff = await apiM('POST', '/api/login', { email: EL, password: PWD }, null, null, '1.2.3.4, 10.84.0.3');
  ok(xff.status === 429, 'подставной адрес в начале X-Forwarded-For замок не обходит', xff.body);
  const dev = String(owner1.setCookie || '').split(';')[0];
  ok(/^bpld=\d+\.\d+\.[0-9a-f]{32}$/.test(dev) && /HttpOnly/i.test(owner1.setCookie) && /Path=\/api\/login/i.test(owner1.setCookie), 'успешный вход ставит метку устройства bpld (HttpOnly, только для /api/login)', owner1.setCookie);
  const sameIp = await login(EL, PWD, '10.84.0.1');
  ok(sameIp.status === 429, 'тот же адрес без метки устройства замок не обходит (адрес делят соседи по сети)', sameIp.body);
  const ownerKnown = await apiM('POST', '/api/login', { email: EL, password: PWD }, null, null, '10.84.0.77', dev);
  ok(ownerKnown.status === 200 && ownerKnown.body.token, 'во время замка хозяин входит с устройства с меткой (с любого адреса) — постороннему не запереть', ownerKnown.body);
  const knownBad = await apiM('POST', '/api/login', { email: EL, password: 'не-тот' }, null, null, '10.84.0.77', dev);
  ok(knownBad.status === 401, '…а неверный пароль с меткой — обычный промах', knownBad.body);
  const forged = await apiM('POST', '/api/login', { email: EL, password: PWD }, null, null, '10.84.0.78', dev.replace(/.$/, (c) => (c === '0' ? '1' : '0')));
  ok(forged.status === 429, 'подделанная метка не действует', forged.body);
  ok((await apiM('GET', '/api/me', null, owner1.body.token)).status === 200, 'уже вошедшего хозяина замок не выкидывает');
  /* сброс по коду снимает замок */
  const f = await apiM('POST', '/api/password/forgot', { email: EL }, null, null, '10.84.0.4');
  ok(/^\d{6}$/.test(String(f.body.devCode || '')), '«Забыли пароль?» во время замка — код выдаётся', f.body);
  const rs = await apiM('POST', '/api/password/reset', { email: EL, code: f.body.devCode, password: 'пароль-после-замка' }, null, null, '10.84.0.4');
  ok(rs.status === 200 && rs.body.token, 'сброс пароля по коду прошёл', rs.body);
  const after = await login(EL, 'пароль-после-замка', '10.84.0.5');
  ok(after.status === 200 && after.body.token, 'после сброса по коду замок снят — новый пароль входит', after.body);
}
console.log(`\nИтого: ${passed} ok, ${failed} FAIL`);
process.exit(failed ? 1 : 0);
