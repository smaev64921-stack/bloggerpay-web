/* «Написать в поддержку» через бота (15.10.2026): метка из приложения,
   разговор в боте, переписка с владельцем в обе стороны, /support без
   приложения. Свой сервер на 8498 и заглушка API Телеграма на 8499 —
   настоящий Телеграм не трогаем.
   Запуск: node test-support.mjs */

import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = 8498, TGP = 8499;
const BASE = 'http://127.0.0.1:' + PORT;
const KEY = 'test-support-key';
const ADMIN = '424242';
let passed = 0, failed = 0;
function ok(c, name, extra) {
  if (c) { passed++; console.log('  ok  ' + name); }
  else { failed++; console.log('  FAIL ' + name + (extra !== undefined ? '  ← ' + JSON.stringify(extra).slice(0, 300) : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── заглушка Телеграма ── */
const sent = [], copies = [], cfg = [];
let queue = [], updId = 700, msgId = 30000;
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
    else if (method === 'setMyCommands') cfg.push(data);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, result }));
  });
});
await new Promise((r) => stub.listen(TGP, '127.0.0.1', r));

const CWD = fileURLToPath(new URL('.', import.meta.url));
const dir = mkdtempSync(path.join(tmpdir(), 'bp-sup-'));
const srv = spawn(process.execPath, ['server.js'], {
  cwd: CWD,
  env: {
    ...process.env, PORT: String(PORT), DB_PATH: path.join(dir, 'db.sqlite'), PUBLIC_URL: BASE, APP_URL: BASE + '/',
    ADMIN_KEY: KEY, ADMIN_EMAIL: '', BOT_TOKEN: '111:TEST-SUPPORT', BOT_USERNAME: '', ADMIN_CHAT_ID: ADMIN,
    TG_API_BASE: 'http://127.0.0.1:' + TGP, RESEND_API_KEY: '', YOOKASSA_SHOP_ID: '', YOOKASSA_SECRET_KEY: '', TEST_TOPUP: '0',
  },
  stdio: process.env.BP_DEBUG ? 'inherit' : 'ignore',
});
async function api(method, p, body, token) {
  const h = { 'Content-Type': 'application/json' };
  if (token) h.Authorization = 'Bearer ' + token;
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
const toChat = (id, from) => sent.slice(from).filter((m) => String(m.chat_id) === String(id));

try {
  console.log('\nПоддержка через бота');
  let upOk = false;
  for (let i = 0; i < 60; i++) { try { const r = await fetch(BASE + '/api/health'); if (r.ok) { upOk = true; break; } } catch (e) {} await sleep(150); }
  ok(upOk, 'сервер поднялся');
  const cmds = await until(() => cfg.find((c) => !c.scope && Array.isArray(c.commands)), 5000);
  ok(!!cmds && cmds.commands.some((c) => c.command === 'support'), 'в меню бота есть команда /support', cmds);

  const reg = await api('POST', '/api/register', { email: 'sup1@t.ru', name: 'Аня Блогер', role: 'blogger', password: 'парольС12345' });
  const T = reg.body.token;
  ok(reg.status === 200 && !!T, 'блогер зарегистрирован');

  ok((await api('POST', '/api/support/start', {})).status === 401, 'без входа метку не дают');
  const st = await api('POST', '/api/support/start', {}, T);
  ok(st.status === 200 && /^[0-9a-f]{12}$/.test(st.body.code) && st.body.bot === 'test_bot'
    && st.body.url === 'https://t.me/test_bot?start=sup_' + st.body.code, 'метка выдана: ссылка на бота с sup_<метка>', st.body);

  /* ── человек открыл бота по ссылке из приложения ── */
  const s1 = sent.length;
  push({ message_id: 101, chat: { id: 555, type: 'private' }, from: { id: 555, username: 'anya_b', first_name: 'Аня' }, text: '/start sup_' + st.body.code });
  const hi = await until(() => toChat(555, s1).find((m) => /Поддержка BloggerPay/.test(m.text)));
  ok(!!hi && /Оператор ответит в этом чате/.test(hi.text), 'человеку: «Поддержка BloggerPay», как писать и где будет ответ', hi && hi.text);
  const adm = await until(() => toChat(ADMIN, s1).find((m) => /Обращение в поддержку/.test(m.text)));
  ok(!!adm && /@anya_b/.test(adm.text) && /Аня Блогер/.test(adm.text) && /sup1@t\.ru/.test(adm.text) && /баланс 0 ₽/.test(adm.text) && /Ответить/.test(adm.text),
    'владельцу: кто пишет — @ник, имя, почта, баланс; как ответить', adm && adm.text);
  ok(!!adm && /Телеграм к аккаунту не привязан/.test(adm.text), 'владельцу — сверка: Телеграм к аккаунту не привязан, сверить личность', adm && adm.text);

  /* метка одноразовая: та же ссылка у другого человека аккаунт уже не подставляет */
  const s1b = sent.length;
  push({ message_id: 150, chat: { id: 559, type: 'private' }, from: { id: 559, username: 'thief' }, text: '/start sup_' + st.body.code });
  const reuse = await until(() => toChat(ADMIN, s1b).find((m) => /Обращение в поддержку — @thief/.test(m.text)));
  ok(!!reuse && /Аккаунт не указан/.test(reuse.text) && !/sup1@t\.ru/.test(reuse.text), 'повтор той же метки (переслали ссылку) — без аккаунта: метка одноразовая', reuse && reuse.text);

  /* ── переписка ── */
  const s2 = sent.length, c2 = copies.length;
  push({ message_id: 102, chat: { id: 555, type: 'private' }, from: { id: 555, username: 'anya_b' }, text: 'Не вижу ролик в задании' });
  const hdr = await until(() => toChat(ADMIN, s2).find((m) => /Поддержка · @anya_b · #\d+ пишет/.test(m.text)));
  const cp = await until(() => copies.slice(c2).find((m) => String(m.chat_id) === ADMIN && String(m.from_chat_id) === '555' && m.message_id === 102));
  ok(!!hdr && !!cp, 'сообщение человека ушло владельцу (заголовок + копия)', { hdr: hdr && hdr.text, cp });
  ok(!!(await until(() => toChat(555, s2).find((m) => /Передали оператору/.test(m.text)))), 'человеку один раз — «передали оператору»');
  const s3 = sent.length;
  push({ message_id: 103, chat: { id: 555, type: 'private' }, from: { id: 555, username: 'anya_b' }, text: 'вот скрин' });
  await until(() => copies.find((m) => m.message_id === 103 && String(m.chat_id) === ADMIN));
  await sleep(300);
  ok(!toChat(555, s3).length, 'второе сообщение — без лишних ответов бота');
  const c4 = copies.length, s4 = sent.length;
  push({ message_id: 3001, chat: { id: Number(ADMIN), type: 'private' }, from: { id: Number(ADMIN) }, text: 'Ролик на проверке, ответим завтра', reply_to_message: { message_id: hdr._id } });
  ok(!!(await until(() => copies.slice(c4).find((m) => String(m.chat_id) === '555' && String(m.from_chat_id) === ADMIN && m.message_id === 3001))), 'ответ владельца «Ответить» — человеку');
  ok(!!(await until(() => toChat(ADMIN, s4).find((m) => /Ответ передан в чат поддержки/.test(m.text)))), 'владельцу — «ответ передан»');

  /* ── без приложения: /support и чужая метка ── */
  const s5 = sent.length;
  push({ message_id: 201, chat: { id: 556, type: 'private' }, from: { id: 556, first_name: 'Пётр' }, text: '/support' });
  ok(!!(await until(() => toChat(556, s5).find((m) => /Поддержка BloggerPay/.test(m.text)))), '/support в боте открывает тот же разговор');
  ok(!!(await until(() => toChat(ADMIN, s5).find((m) => /Обращение в поддержку — Пётр/.test(m.text) && /Аккаунт не указан/.test(m.text)))), 'владельцу: имя из Телеграма, аккаунт не указан');
  const s6 = sent.length;
  push({ message_id: 202, chat: { id: 557, type: 'private' }, from: { id: 557 }, text: '/start sup_ffffffffffff' });
  ok(!!(await until(() => toChat(ADMIN, s6).find((m) => /Обращение в поддержку/.test(m.text) && /Аккаунт не указан/.test(m.text)))), 'неизвестная метка — разговор без аккаунта (чужой аккаунт не подставляется)');

  /* ── обычный чат не затронут ── */
  const s7 = sent.length, c7 = copies.length;
  push({ message_id: 301, chat: { id: 558, type: 'private' }, from: { id: 558 }, text: 'привет' });
  const plain = await until(() => toChat(558, s7)[0]);
  ok(!!plain && /приложени/.test(plain.text) && /\/support/.test(plain.text), 'без обращения бот отвечает как раньше и подсказывает /support', plain && plain.text);
  ok(!copies.slice(c7).some((m) => String(m.from_chat_id) === '558'), 'сообщение без обращения владельцу не пересылается');
  const s8 = sent.length;
  push({ message_id: 3002, chat: { id: Number(ADMIN), type: 'private' }, from: { id: Number(ADMIN) }, text: '/support' });
  ok(!!(await until(() => toChat(ADMIN, s8).find((m) => /Это чат владельца/.test(m.text)))), 'владелец сам себе обращение не открывает');
} catch (e) {
  failed++; console.log('  FAIL исключение: ' + (e && e.stack || e));
} finally {
  try { srv.kill(); } catch (e) {}
  try { stub.close(); } catch (e) {}
}
console.log(`\nИтого: ${passed} ok, ${failed} FAIL`);
process.exit(failed ? 1 : 0);
