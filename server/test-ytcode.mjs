/* YouTube: подключение кодом в описании канала (15.10.2026). Вместо входа в
   Google (экран «приложение не проверено» у области youtube.readonly)
   человек вписывает код в описание канала, сервер читает описание открытым
   ключом. Свой сервер на 8504 и заглушка YouTube Data API на 8505 —
   настоящий YouTube не трогаем.
   Запуск: node test-ytcode.mjs */

import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = 8504, YTP = 8505, PORT0 = 8506;
const BASE = 'http://127.0.0.1:' + PORT, BASE0 = 'http://127.0.0.1:' + PORT0;
let passed = 0, failed = 0;
function ok(c, name, extra) {
  if (c) { passed++; console.log('  ok  ' + name); }
  else { failed++; console.log('  FAIL ' + name + (extra !== undefined ? '  ← ' + JSON.stringify(extra).slice(0, 300) : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── заглушка YouTube Data API: два канала, описание меняем сами ── */
const CH = {
  UCaaaaaaaaaaaaaaaaaaaaaa: { handle: '@vanya_shorts', title: 'Ваня Shorts', subs: 15300, desc: 'Ролики про бег' },
  UCbbbbbbbbbbbbbbbbbbbbbb: { handle: '@чужой', title: 'Чужой канал', subs: 90, desc: '' },
  UCcccccccccccccccccccccc: { handle: '@ccc_chan', title: 'Третий', subs: 5, desc: '' },
};
/* сколько раз сервер спросил channels.list (квота YouTube) */
const chAsks = () => asks.filter((a) => a.startsWith('/youtube/v3/channels')).length;
/* кэш channels.list в тесте — 3 с (в бою 30 с) */
const CACHE_MS = 3000;
const asks = [];
const stub = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  asks.push(u.pathname + '?' + u.searchParams.toString());
  res.setHeader('Content-Type', 'application/json');
  if (u.pathname !== '/youtube/v3/channels') { res.statusCode = 404; return res.end('{}'); }
  if (u.searchParams.get('key') !== 'yt-key') { res.statusCode = 403; return res.end(JSON.stringify({ error: { message: 'API key not valid' } })); }
  const id = u.searchParams.get('id'), h = u.searchParams.get('forHandle');
  const k = id ? (CH[id] ? id : null) : Object.keys(CH).find((x) => CH[x].handle.toLowerCase() === String(h || '').toLowerCase());
  const items = k ? [{ id: k, snippet: { title: CH[k].title, description: CH[k].desc, customUrl: CH[k].handle, thumbnails: { default: { url: 'https://i.example/' + k + '.jpg' } } },
    statistics: { subscriberCount: String(CH[k].subs), videoCount: '12' } }] : [];
  res.end(JSON.stringify({ items }));
});
await new Promise((r) => stub.listen(YTP, '127.0.0.1', r));

const CWD = fileURLToPath(new URL('.', import.meta.url));
function boot(port, key) {
  const dir = mkdtempSync(path.join(tmpdir(), 'bp-ytc-'));
  return spawn(process.execPath, ['server.js'], {
    cwd: CWD,
    env: {
      ...process.env, PORT: String(port), DB_PATH: path.join(dir, 'db.sqlite'), PUBLIC_URL: 'http://127.0.0.1:' + port, APP_URL: 'http://127.0.0.1:' + port + '/',
      ADMIN_KEY: 'k', ADMIN_EMAIL: '', BOT_TOKEN: '', ADMIN_CHAT_ID: '', RESEND_API_KEY: '', YOOKASSA_SHOP_ID: '', YOOKASSA_SECRET_KEY: '', TEST_TOPUP: '0',
      YT_API_KEY: key, YT_API_BASE: 'http://127.0.0.1:' + YTP, YT_CLIENT_ID: 'cid', YT_CLIENT_SECRET: 'sec',
      TRUST_PROXY: '1',
      /* квота 1000 → на подключение кодом 10 % = 100 единиц */
      YT_DAILY_UNITS: '1000', YT_CHAN_CACHE_MS: String(CACHE_MS),
    },
    stdio: process.env.BP_DEBUG ? 'inherit' : 'ignore',
  });
}
const srv = boot(PORT, 'yt-key'), srv0 = boot(PORT0, '');
async function waitUp(b) { for (let i = 0; i < 100; i++) { try { const r = await fetch(b + '/api/health'); await r.text(); if (r.ok) return; } catch (e) {} await sleep(150); } }
await waitUp(BASE); await waitUp(BASE0);
let ip = 10;
async function api(b, method, p, body, token, fixedIp) {
  const h = { 'Content-Type': 'application/json', 'X-Forwarded-For': fixedIp || ('10.9.0.' + (++ip % 250)) };
  if (token) h.Authorization = 'Bearer ' + token;
  const r = await fetch(b + p, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j = {}; try { j = JSON.parse(t); } catch (e) { j = { _t: t.slice(0, 200) }; }
  return { status: r.status, body: j };
}
const tag = Date.now().toString(36), PASS = 'пароль-подлиннее-12';
const A = (await api(BASE, 'POST', '/api/register', { email: 'ya' + tag + '@t.ru', name: 'Ваня', role: 'blogger', password: PASS })).body.token;
const B = (await api(BASE, 'POST', '/api/register', { email: 'yb' + tag + '@t.ru', name: 'Петя', role: 'blogger', password: PASS })).body.token;
const Z = (await api(BASE0, 'POST', '/api/register', { email: 'yz' + tag + '@t.ru', name: 'Зина', role: 'blogger', password: PASS })).body.token;

try {
  console.log('\nНастройки');
  const c1 = await api(BASE, 'GET', '/api/verify/config');
  ok(c1.status === 200 && c1.body.platforms.youtube.code === true, 'с YT_API_KEY в /api/verify/config у YouTube code: true', c1.body);
  const c0 = await api(BASE0, 'GET', '/api/verify/config');
  ok(c0.status === 200 && c0.body.platforms.youtube.code === false, 'без ключа — code: false', c0.body);
  const n0 = await api(BASE0, 'POST', '/api/verify/youtube/code', { channel: '@vanya_shorts' }, Z);
  ok(n0.status === 503 && /YT_API_KEY/.test(n0.body.error), 'без ключа подключение кодом честно отвечает «не настроено» (503)', n0);

  console.log('\nВыдать код');
  ok((await api(BASE, 'POST', '/api/verify/youtube/code', { channel: '@vanya_shorts' })).status === 401, 'без входа — 401');
  const bad = await api(BASE, 'POST', '/api/verify/youtube/code', { channel: 'https://example.com/x y' }, A);
  ok(bad.status === 400, 'мусор вместо ссылки — 400 с подсказкой', bad);
  const nf = await api(BASE, 'POST', '/api/verify/youtube/code', { channel: 'https://youtube.com/@nobody_here' }, A);
  ok(nf.status === 404 && /не найден/.test(nf.body.error), 'нет такого канала — 404 «Канал не найден»', nf);
  const s1 = await api(BASE, 'POST', '/api/verify/youtube/code', { channel: 'https://www.youtube.com/@vanya_shorts/videos' }, A);
  ok(s1.status === 200 && /^BP-[A-HJ-NP-Z2-9]{6}$/.test(s1.body.code) && s1.body.channel.id === 'UCaaaaaaaaaaaaaaaaaaaaaa' && s1.body.channel.title === 'Ваня Shorts' && s1.body.channel.subs === 15300,
    'ссылка youtube.com/@имя/videos → канал найден, код вида BP-XXXXXX', s1.body);
  ok(s1.body.left > 1700 && s1.body.left <= 1800, 'код живёт 30 минут', s1.body.left);
  ok(asks.some((a) => /forHandle=%40vanya_shorts/.test(a) && /key=yt-key/.test(a)), 'сервер спросил YouTube открытым ключом по @имени', asks.slice(-3));
  const askS1 = chAsks();
  const s2 =await api(BASE, 'POST', '/api/verify/youtube/code', { channel: 'UCaaaaaaaaaaaaaaaaaaaaaa' }, A);
  ok(s2.status === 200 && s2.body.code === s1.body.code, 'тот же канал ещё раз — тот же код (не меняется под рукой)', [s1.body.code, s2.body.code]);
  const s3 = await api(BASE, 'POST', '/api/verify/youtube/code', { channel: 'youtube.com/channel/UCaaaaaaaaaaaaaaaaaaaaaa' }, A);
  ok(s3.status === 200 && s3.body.channel.id === 'UCaaaaaaaaaaaaaaaaaaaaaa', 'ссылка youtube.com/channel/UC… тоже понимается', s3.body);
  ok(chAsks() === askS1, 'повтор по тому же каналу (по @имени или UC-номеру) — из кэша, квота YouTube не тратится', [askS1, chAsks()]);
  const cyr = await api(BASE, 'POST', '/api/verify/youtube/code', { channel: '@чужой' }, B);
  ok(cyr.status === 200 && cyr.body.channel.id === 'UCbbbbbbbbbbbbbbbbbbbbbb', '@имя кириллицей тоже находится', cyr.body);

  console.log('\nПроверить');
  const k0 = await api(BASE, 'POST', '/api/verify/youtube/check', {}, A);
  ok(k0.status === 409 && k0.body.code === s1.body.code, 'кода в описании ещё нет — 409 «пока не виден» (и тот же код)', k0);
  let l0 = (await api(BASE, 'GET', '/api/verify/list', null, A)).body.rows || [];
  ok(!l0.some((r) => r.platform === 'youtube'), 'канал не записан, пока кода нет', l0);
  CH.UCaaaaaaaaaaaaaaaaaaaaaa.desc = 'Ролики про бег.\nКод для BloggerPay: ' + s1.body.code.toLowerCase().replace('-', '- ');
  const kc = await api(BASE, 'POST', '/api/verify/youtube/check', {}, A);
  ok(kc.status === 409, 'сразу после правки описания ответ ещё из кэша (≤30 с в бою) — 409, не ошибка', kc);
  await sleep(CACHE_MS + 200);
  const k1 =await api(BASE, 'POST', '/api/verify/youtube/check', {}, A);
  ok(k1.status === 200 && k1.body.ok && k1.body.id === 'UCaaaaaaaaaaaaaaaaaaaaaa' && k1.body.title === 'Ваня Shorts', 'код в описании (другим регистром и с пробелом) — канал подключён', k1);
  l0 = (await api(BASE, 'GET', '/api/verify/list', null, A)).body.rows || [];
  const row = l0.find((r) => r.platform === 'youtube');
  ok(row && row.external_id === 'UCaaaaaaaaaaaaaaaaaaaaaa' && row.title === 'Ваня Shorts' && Number(row.subs) === 15300, 'в «Подключённых аккаунтах»: канал, имя, подписчики', row);
  const k2 = await api(BASE, 'POST', '/api/verify/youtube/check', {}, A);
  ok(k2.status === 410, 'код одноразовый: после подключения проверка — 410', k2);
  const kb = await api(BASE, 'POST', '/api/verify/youtube/check', {}, B);
  ok(kb.status === 409, 'чужой канал без кода в его описании другому не достаётся', kb);
  CH.UCbbbbbbbbbbbbbbbbbbbbbb.desc = 'вот код ' + s1.body.code;
  await sleep(CACHE_MS + 200);
  const kb2 =await api(BASE, 'POST', '/api/verify/youtube/check', {}, B);
  ok(kb2.status === 409, 'код ДРУГОГО человека в описании не подходит — у каждого свой', kb2);
  const lb = (await api(BASE, 'GET', '/api/verify/list', null, B)).body.rows || [];
  ok(!lb.some((r) => r.platform === 'youtube'), '…и канал Пете не записан', lb);

  console.log('\nОграничения');
  const s4 = await api(BASE, 'POST', '/api/verify/youtube/code', { channel: '@чужой' }, B, '10.8.8.8');
  let last = null;
  for (let i = 0; i < 31 && !(last && last.status === 429); i++) last = await api(BASE, 'POST', '/api/verify/youtube/check', {}, B, '10.7.' + Math.floor(i / 200) + '.' + (i % 200 + 1));
  ok(s4.status === 200 && last.status === 429, 'больше 30 проверок одного кода — 429, код сгорает', last);
  const after = await api(BASE, 'POST', '/api/verify/youtube/check', {}, B);
  ok(after.status === 410, 'после 429 нужен новый код', after);

  console.log('\nКвота YouTube: повторная выдача кода не обнуляет проверки');
  const reg = async (n) => (await api(BASE, 'POST', '/api/register', { email: n + tag + '@t.ru', name: n, role: 'blogger', password: PASS })).body.token;
  const C = await reg('yc');
  const cc1 = await api(BASE, 'POST', '/api/verify/youtube/code', { channel: '@ccc_chan' }, C);
  let cr = null;
  for (let i = 0; i < 25; i++) cr = await api(BASE, 'POST', '/api/verify/youtube/check', {}, C);
  ok(cc1.status === 200 && cr.status === 409, '25 проверок без кода в описании — 409', cr);
  const cc2 = await api(BASE, 'POST', '/api/verify/youtube/code', { channel: 'youtube.com/@ccc_chan' }, C);
  ok(cc2.status === 200 && cc2.body.code === cc1.body.code, 'тот же канал ещё раз — тот же код', [cc1.body.code, cc2.body.code]);
  const tail = [];
  for (let i = 0; i < 6; i++) tail.push((await api(BASE, 'POST', '/api/verify/youtube/check', {}, C)).status);
  ok(tail.slice(0, 5).every((s) => s === 409) && tail[5] === 429, 'счёт проверок не обнулился: 31-я по коду — 429 (было: новый /code давал ещё 30)', tail);

  console.log('\nКвота YouTube: предел на человека в сутки');
  const D = await reg('yd');
  const dSt = [];
  const dA0 = chAsks();
  for (let i = 0; i < 40; i++) dSt.push((await api(BASE, 'POST', '/api/verify/youtube/code', { channel: '@no_such_d' + i }, D)).status);
  const dA1 = chAsks();
  const d41 = await api(BASE, 'POST', '/api/verify/youtube/code', { channel: '@no_such_d40' }, D);
  ok(dSt.every((s) => s === 404) && dA1 - dA0 === 40, '40 запросов к YouTube за сутки от одного человека проходят', [dSt.filter((s) => s !== 404), dA1 - dA0]);
  ok(d41.status === 429 && /сутки|завтра/i.test(d41.body.error) && chAsks() === dA1, '41-й — 429 с понятным текстом, YouTube не спрошен', [d41, chAsks() - dA1]);
  const dRep = await api(BASE, 'POST', '/api/verify/youtube/code', { channel: '@no_such_d39' }, D);
  ok(dRep.status === 404, 'ответ из кэша (тот же канал) предел не тратит — по-прежнему 404, а не 429', dRep);

  console.log('\nКвота YouTube: общий бюджет подключения — 10 % суточной');
  const H = await reg('yh');
  const hc = await api(BASE, 'POST', '/api/verify/youtube/code', { channel: '@ccc_chan' }, H);
  ok(hc.status === 200, 'Х получил код до исчерпания', hc);
  let quota = null, n = 0, lastOk = null;
  const who = [];
  for (let u = 0; u < 6 && !quota; u++) {
    const T = await reg('yq' + u);
    for (let i = 0; i < 45 && !quota; i++) {
      const h = '@no_such_q' + u + '_' + i;
      const r = await api(BASE, 'POST', '/api/verify/youtube/code', { channel: h }, T);
      n++;
      if (r.status === 503) quota = r;
      else if (r.status === 429) break;
      else if (r.status === 404) lastOk = { h, T };
      else { who.push(r); break; }
    }
  }
  ok(!!quota && /завтра/.test(quota.body.error) && !/YT_API_KEY|не ответил/.test(quota.body.error) && who.length === 0,
    'при исчерпании — 503 «на сегодня закончилось, попробуйте завтра»', [quota, n, who.slice(0, 2)]);
  const qA = chAsks();
  ok(qA === 100, 'за весь тест YouTube спрошен ровно 100 раз = 10 % квоты 1000', qA);
  const G = await reg('yg');
  const g1 = await api(BASE, 'POST', '/api/verify/youtube/code', { channel: '@vanya_shorts_new' }, G);
  ok(g1.status === 503 && chAsks() === qA, 'дальше — 503 и YouTube не спрашиваем (запас квоты — загрузкам и замерам)', [g1.status, chAsks() - qA]);
  const gRep = lastOk ? await api(BASE, 'POST', '/api/verify/youtube/code', { channel: lastOk.h }, lastOk.T) : null;
  ok(gRep && gRep.status === 404, 'ответ из кэша отдаётся и после исчерпания', gRep);
  await sleep(CACHE_MS + 200);
  const hk = await api(BASE, 'POST', '/api/verify/youtube/check', {}, H);
  ok(hk.status === 503 && /завтра/.test(hk.body.error), '«Проверить» после исчерпания — тот же понятный ответ', hk);
  const vc = await api(BASE, 'GET', '/api/verify/config');
  ok(vc.status === 200 && vc.body.platforms.youtube.code === true, 'настройки не ломаются', vc.body);
} catch (e) {
  failed++; console.log('  FAIL исключение: ' + (e && e.stack || e));
} finally {
  try { srv.kill(); } catch (e) {} try { srv0.kill(); } catch (e) {} try { stub.close(); } catch (e) {}
}
console.log(`\nИтого: ${passed} ok, ${failed} FAIL`);
process.exit(failed ? 1 : 0);
