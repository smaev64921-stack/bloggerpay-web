/* Ретранслятор (16.10.2026): сайт, касса и база — в Москве, площадки,
   закрытые из России, — через второй сервер в Нидерландах (relay.js).
   Обе половины проверяются без интернета: «площадки» — одна заглушка на
   localhost (RELAY_TEST_UPSTREAM, хост едет в x-bp-test-host), «Москва» —
   заглушка за старым адресом. Под конец — настоящий server.js: его бот и
   адреса возврата идут через ретранслятор и старый адрес (OAUTH_BASE).
   Свои порты 8510–8513. Запуск: node test-relay.mjs */

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const relayLib = require('./relay.js');
const CWD = fileURLToPath(new URL('.', import.meta.url));
const ROOT = path.join(CWD, '..');
const P_RELAY = 8510, P_UP = 8511, P_RU = 8512, P_SRV = 8513;
const RELAY = 'http://127.0.0.1:' + P_RELAY;
const RU = 'http://127.0.0.1:' + P_RU;
const TOKEN = '123456789:AArelay-test-token';
const KEY = relayLib.relayKey({ BOT_TOKEN: TOKEN });
let passed = 0, failed = 0;
function ok(c, name, extra) {
  if (c) { passed++; console.log('  ok  ' + name); }
  else { failed++; console.log('  FAIL ' + name + (extra !== undefined ? '  ← ' + JSON.stringify(extra).slice(0, 300) : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const realFetch = globalThis.fetch;
/* «Напрямую» в тестах интернета не трогает: адрес площадки → заглушечный
   ответ «напрямую», остальное — настоящий fetch (так ходят к самому
   ретранслятору). */
let directHttps = 0;
const fakeDirect = (input, init) => {
  if (String(input).startsWith('https://')) { directHttps += 1; return Promise.resolve(new Response('напрямую', { status: 200 })); }
  return realFetch(input, init);
};

/* ── «Площадки»: одна заглушка на все хосты ─────────────────────────── */
const upLog = [];
let slowClosed = false;
const upSrv = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    const host = req.headers['x-bp-test-host'] || '';
    const u = new URL(req.url, 'http://x');
    upLog.push({ method: req.method, host, path: u.pathname, headers: req.headers, body });
    const json = (s, o) => { res.writeHead(s, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(o)); };
    if (u.pathname === '/echo') {
      return json(200, { method: req.method, host, query: u.search, body, ct: req.headers['content-type'] || '',
        auth: req.headers.authorization || '', ua: req.headers['user-agent'] || '',
        key: req.headers['x-bp-relay'] || '', xff: req.headers['x-forwarded-for'] || '' });
    }
    if (u.pathname === '/gzip') {
      const z = zlib.gzipSync(Buffer.from('сжатый ответ'));
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Encoding': 'gzip', 'Content-Length': z.length });
      return res.end(z);
    }
    if (u.pathname === '/redir') { res.writeHead(302, { Location: '/final' }); return res.end(); }
    if (u.pathname === '/final') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('final'); }
    if (u.pathname === '/shorts/abc') { res.writeHead(303, { Location: 'https://www.youtube.com/watch?v=abc' }); return res.end(); }
    if (u.pathname === '/cookies') {
      res.setHeader('Set-Cookie', ['a=1; Path=/', 'b=2; Path=/']);
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end('c');
    }
    if (u.pathname === '/slow') {
      const t = setTimeout(() => json(200, { late: true }), 3000);
      res.on('close', () => { clearTimeout(t); if (!res.writableEnded) slowClosed = true; });
      return;
    }
    /* Телеграм: /bot<токен>/<метод> */
    const tg = /^\/bot[^/]+\/(\w+)$/.exec(u.pathname);
    if (tg) {
      if (tg[1] === 'getUpdates') return setTimeout(() => json(200, { ok: true, result: [] }), 300);
      if (tg[1] === 'getMe') return json(200, { ok: true, result: { id: 123456789, is_bot: true, username: 'bp_test_bot', first_name: 'BP' } });
      return json(200, { ok: true, result: true });
    }
    json(404, { error: 'нет такого', path: u.pathname });
  });
});

/* ── «Москва»: новый адрес за старым ─────────────────────────────────── */
const ruLog = [];
const ruSrv = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    ruLog.push({ method: req.method, url: req.url, headers: req.headers, body });
    if (req.url === '/terms.html') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end('Условия из Москвы'); }
    if (req.url.startsWith('/api/verify/instagram/')) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ method: req.method, body, ct: req.headers['content-type'] || '' }));
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('нет');
  });
});

const listen = (srv, port) => new Promise((r) => srv.listen(port, '127.0.0.1', r));
async function upOk(port, check) {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await realFetch('http://127.0.0.1:' + port + '/api/health');
      const j = await r.json().catch(() => ({}));
      if (r.ok && (!check || check(j))) return j;
    } catch (e) { /* ещё поднимается */ }
    await sleep(150);
  }
  return null;
}
const clean = { RELAY_URL: '', RELAY_KEY: '', RELAY_HOSTS: '', RELAY_PASS: '', RELAY_PORTS: '', MOVED_TO: '',
  OAUTH_BASE: '', BP_MODE: '', RELAY_TEST_UPSTREAM: '', DOMAIN: '' };

await listen(upSrv, P_UP);
await listen(ruSrv, P_RU);
const relayDir = mkdtempSync(path.join(tmpdir(), 'bp-relay-'));
const relayProc = spawn(process.execPath, ['server.js'], {
  cwd: CWD,
  env: { ...process.env, ...clean, BP_MODE: 'relay', PORT: String(P_RELAY), RELAY_PORTS: String(P_RELAY),
    BOT_TOKEN: TOKEN, MOVED_TO: RU, RELAY_TEST_UPSTREAM: 'http://127.0.0.1:' + P_UP,
    RELAY_PASS: '/api/verify/instagram/',
    DB_PATH: path.join(relayDir, 'db.sqlite') },
  stdio: process.env.BP_DEBUG ? 'inherit' : 'ignore',
});
let srvProc = null;

try {
  console.log('\nРетранслятор поднят');
  const h = await upOk(P_RELAY, (j) => j.mode === 'relay');
  ok(h && h.mode === 'relay' && h.key === true && h.movedTo === RU, 'режим BP_MODE=relay: /api/health, ключ из BOT_TOKEN, новый адрес', h);
  ok(!existsSync(path.join(relayDir, 'db.sqlite')) && readdirSync(relayDir).length === 0, 'базы у ретранслятора нет — server.js ушёл в relay.js до неё');

  console.log('\nМосква → площадки через ретранслятор');
  const f = relayLib.makeRelayFetch({ RELAY_URL: RELAY, BOT_TOKEN: TOKEN }, fakeDirect);
  const st = f.__bpRelay.stats;
  let r = await f('https://api.telegram.org/bot' + TOKEN + '/getMe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  let j = await r.json();
  let last = upLog[upLog.length - 1] || {};
  ok(j.ok && j.result.username === 'bp_test_bot' && last.host === 'api.telegram.org' && last.path === '/bot' + TOKEN + '/getMe',
    'Телеграм getMe: дошёл до api.telegram.org и вернулся', { j, last: { host: last.host, path: last.path } });
  ok(r.url === 'https://api.telegram.org/bot' + TOKEN + '/getMe', 'res.url — адрес площадки, а не ретранслятора', r.url);

  r = await f('https://api.telegram.org/echo?x=1', { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t1', 'User-Agent': 'BP-UA' },
    body: JSON.stringify({ a: 'привет' }) });
  j = await r.json();
  ok(j.method === 'POST' && j.body === '{"a":"привет"}' && j.ct === 'application/json' && j.query === '?x=1',
    'метод, тело, тип и строка запроса — один в один', j);
  ok(j.auth === 'Bearer t1' && j.ua === 'BP-UA', 'заголовки вызывающего (доступ, User-Agent) доходят до площадки', j);
  ok(j.key === '' && j.xff === '', 'ключ ретранслятора и адрес сервера площадке не уходят', j);

  r = await f('https://open.tiktokapis.com/echo', { method: 'POST', body: new URLSearchParams({ code: 'abc', grant_type: 'authorization_code' }) });
  j = await r.json();
  ok(j.host === 'open.tiktokapis.com' && j.body === 'code=abc&grant_type=authorization_code' && /^application\/x-www-form-urlencoded/.test(j.ct),
    'TikTok: форма обмена кода (URLSearchParams) доходит целой', j);

  r = await f('https://www.tiktok.com/redir');
  ok(r.status === 200 && (await r.text()) === 'final' && r.url === 'https://www.tiktok.com/final',
    'переадресацию площадки ретранслятор проходит сам, res.url — конечный адрес', r.url);

  r = await f('https://www.youtube.com/shorts/abc', { method: 'HEAD', redirect: 'manual' });
  ok(r.status === 303 && r.headers.get('location') === 'https://www.youtube.com/watch?v=abc',
    'redirect:manual (проверка Shorts): 303 и Location отдаются как есть', { s: r.status, l: r.headers.get('location') });
  r = await f('https://www.youtube.com/shorts/abc', { redirect: 'manual' });
  ok(r.status === 303 && r.headers.get('location') === 'https://www.youtube.com/watch?v=abc', 'и для GET тоже', r.status);

  r = await f('https://graph.instagram.com/gzip');
  ok((await r.text()) === 'сжатый ответ' && !r.headers.get('content-encoding'), 'сжатый ответ площадки приходит распакованным', r.headers.get('content-encoding'));

  r = await f('https://www.tiktok.com/cookies');
  ok((r.headers.getSetCookie ? r.headers.getSetCookie() : []).length === 2, 'несколько Set-Cookie не склеиваются', r.headers.getSetCookie && r.headers.getSetCookie());

  const fb0 = st.fallback;
  r = await f('https://www.googleapis.com/nope');
  ok(r.status === 404 && st.fallback === fb0, 'ошибка самой площадки (404) — это ответ, а не повод идти напрямую', r.status);

  const n0 = upLog.length;
  r = await f('http://127.0.0.1:' + P_UP + '/echo');
  j = await r.json();
  ok(j.host === '' && upLog.length === n0 + 1, 'адрес не из списка (свой, localhost) — напрямую, мимо ретранслятора', j);
  const d0 = directHttps;
  r = await f('https://api.telegram.org:8443/x');
  ok((await r.text()) === 'напрямую' && directHttps === d0 + 1, 'адрес с портом — напрямую');
  const L = relayLib.hostList('');
  ok(relayLib.hostAllowed('api.telegram.org', L) && relayLib.hostAllowed('WWW.TikTok.com', L)
    && relayLib.hostAllowed('graph.instagram.com', L) && relayLib.hostAllowed('i.ytimg.com', L),
  'в списке: Телеграм, TikTok, Instagram, YouTube');
  ok(!relayLib.hostAllowed('api.yookassa.ru', L) && !relayLib.hostAllowed('evil-telegram.org', L)
    && !relayLib.hostAllowed('telegram.org.evil.com', L), 'не в списке: ЮKassa, похожие и чужие домены');

  console.log('\nКлюч и список у ретранслятора');
  r = await realFetch(RELAY + '/__relay/api.telegram.org/echo');
  ok(r.status === 403 && r.headers.get('x-bp-relay-error') === 'auth', 'без ключа — 403', r.status);
  r = await realFetch(RELAY + '/__relay/api.telegram.org/echo', { headers: { 'x-bp-relay': KEY.replace(/.$/, (c) => (c === 'a' ? 'b' : 'a')) } });
  ok(r.status === 403 && r.headers.get('x-bp-relay-error') === 'auth', 'чужой ключ — 403', r.status);
  r = await realFetch(RELAY + '/__relay/example.com/echo', { headers: { 'x-bp-relay': KEY } });
  ok(r.status === 403 && r.headers.get('x-bp-relay-error') === 'host', 'свой ключ, но хост не из списка — 403: это не открытый прокси', r.status);
  const own = relayLib.relayKey({ BOT_TOKEN: TOKEN, RELAY_KEY: 'свой ключ' });
  ok(/^[0-9a-f]{64}$/.test(KEY) && KEY !== relayLib.relayKey({ BOT_TOKEN: '1:other' })
    && /^[0-9a-f]{64}$/.test(own) && own !== KEY && own === relayLib.relayKey({ RELAY_KEY: 'свой ключ' }),
  'ключ: HMAC от токена бота; RELAY_KEY перекрывает (тоже hex — кириллица в заголовок не пролезла бы)');

  console.log('\nЗапасной путь');
  const f2 = relayLib.makeRelayFetch({ RELAY_URL: RELAY, RELAY_KEY: 'чужой' }, fakeDirect);
  ok(f2.__bpRelay && f2.__bpRelay.stats.fallback === 0, 'кириллический RELAY_KEY не роняет запрос');
  r = await f2('https://api.telegram.org/echo');
  ok((await r.text()) === 'напрямую' && f2.__bpRelay.stats.fallback === 1, 'ретранслятор отказал (403) — запрос ушёл напрямую');
  const f3 = relayLib.makeRelayFetch({ RELAY_URL: 'http://127.0.0.1:1', BOT_TOKEN: TOKEN }, fakeDirect);
  r = await f3('https://api.telegram.org/echo', { method: 'POST', body: 'x' });
  ok((await r.text()) === 'напрямую', 'ретранслятор лежит — напрямую');
  r = await f2('https://api.telegram.org/echo', { method: 'POST', duplex: 'half',
    body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('x')); c.close(); } }) });
  ok(r.status === 403, 'тело-поток второй раз не отправить — отдаём отказ ретранслятора как есть', r.status);
  const d1 = directHttps;
  let threw = '';
  try { await f('https://api.telegram.org/slow', { signal: AbortSignal.timeout(400) }); } catch (e) { threw = e.name; }
  for (let i = 0; i < 20 && !slowClosed; i++) await sleep(100);
  ok(threw && directHttps === d1, 'вызывающий сам оборвал (его таймаут) — напрямую не повторяем', { threw, d: directHttps - d1 });
  ok(slowClosed, 'обрыв доходит до площадки: длинный опрос не висит впустую');

  console.log('\nСтарый адрес');
  r = await realFetch(RELAY + '/some/page?x=1', { redirect: 'manual' });
  ok(r.status === 302 && r.headers.get('location') === RU + '/some/page?x=1', 'GET — 302 на новый адрес с тем же путём', r.headers.get('location'));
  r = await realFetch(RELAY + '/api/verify/callback/tiktok?code=a&state=b', { redirect: 'manual' });
  ok(r.status === 302 && r.headers.get('location') === RU + '/api/verify/callback/tiktok?code=a&state=b',
    'возврат площадки после входа уходит в Москву с кодом и меткой', r.headers.get('location'));
  r = await realFetch(RELAY + '/', { method: 'HEAD', redirect: 'manual' });
  ok(r.status === 302 && r.headers.get('location') === RU + '/', 'HEAD / — тоже 302', r.status);
  r = await realFetch(RELAY + '/terms.html', { redirect: 'manual' });
  ok(r.status === 200 && (await r.text()) === 'Условия из Москвы', 'terms.html — 200 со свежим текстом из Москвы');
  r = await realFetch(RELAY + '/privacy.html', { redirect: 'manual' });
  ok(r.status === 200 && (await r.text()) === readFileSync(path.join(ROOT, 'privacy.html'), 'utf8'),
    'privacy.html — Москва не ответила, отдан свой файл', r.status);
  const sign = readdirSync(ROOT).find((n) => /^tiktok[A-Za-z0-9]{8,64}\.txt$/.test(n));
  if (sign) {
    r = await realFetch(RELAY + '/' + sign, { redirect: 'manual' });
    ok(r.status === 200 && (await r.text()) === readFileSync(path.join(ROOT, sign), 'utf8'), 'файл подтверждения TikTok — прямой ответ 200', r.status);
  }
  const k0 = ruLog.length;
  r = await realFetch(RELAY + '/api/verify/instagram/deauth', { method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Forwarded-For': '6.6.6.6' }, body: 'signed_request=abc.def%3D' });
  j = await r.json();
  const got = ruLog[ruLog.length - 1] || {};
  ok(r.status === 200 && j.method === 'POST' && j.body === 'signed_request=abc.def%3D' && j.ct === 'application/x-www-form-urlencoded'
    && ruLog.length === k0 + 1, 'путь из RELAY_PASS (обратный вызов Meta): POST уходит в Москву телом один в один', j);
  ok(!got.headers['x-bp-relay'] && !got.headers['x-forwarded-for'], 'чужой X-Forwarded-For дальше не идёт (перебор паролей в обход не пройдёт)', got.headers);
  r = await realFetch(RELAY + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  j = await r.json().catch(() => ({}));
  ok(r.status === 410 && (j.error || '').includes(RU) && ruLog.length === k0 + 1, 'вход, деньги и прочее API по старому адресу — 410, в Москву не пускаем', { s: r.status, j });
  r = await realFetch(RELAY + '/api/verify/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  ok(r.status === 410 && ruLog.length === k0 + 1 && relayLib.DEFAULT_PASS.length === 0,
    'без RELAY_PASS ни один POST в Москву не идёт: общий адрес ретранслятора не исчерпает лимиты за всех', r.status);

  console.log('\nНастоящий сервер за ретранслятором');
  const srvDir = mkdtempSync(path.join(tmpdir(), 'bp-relay-srv-'));
  srvProc = spawn(process.execPath, ['server.js'], {
    cwd: CWD,
    env: { ...process.env, ...clean, PORT: String(P_SRV), DB_PATH: path.join(srvDir, 'db.sqlite'), ADMIN_KEY: 'test-relay-key',
      PUBLIC_URL: 'http://127.0.0.1:' + P_SRV, OAUTH_BASE: 'https://old.example.com', RELAY_URL: RELAY, RELAY_REPORT: '0',
      BOT_TOKEN: TOKEN, TG_API_BASE: '', ADMIN_CHAT_ID: '', ADMIN_EMAIL: '', ADMIN_TG_IDS: '', APP_URL: '',
      YT_CLIENT_ID: 'yt-id.apps.googleusercontent.com', YT_CLIENT_SECRET: 'yt-secret',
      TT_CLIENT_KEY: 'tt-key', TT_CLIENT_SECRET: 'tt-secret', RESEND_API_KEY: '', YOOKASSA_SHOP_ID: '', YOOKASSA_SECRET_KEY: '' },
    stdio: process.env.BP_DEBUG ? 'inherit' : 'ignore',
  });
  ok(!!(await upOk(P_SRV)), 'сервер с RELAY_URL поднялся');
  let polled = null;
  for (let i = 0; i < 60 && !polled; i++) {
    polled = upLog.find((e) => e.host === 'api.telegram.org' && /\/getUpdates$/.test(e.path));
    if (!polled) await sleep(150);
  }
  ok(!!polled && polled.path === '/bot' + TOKEN + '/getUpdates', 'бот (bot.js) опрашивает Телеграм через ретранслятор', polled && polled.path);
  r = await realFetch('http://127.0.0.1:' + P_SRV + '/api/verify/config');
  j = await r.json();
  ok(j.platforms && j.platforms.youtube.redirect === 'https://old.example.com/api/verify/callback/youtube'
    && j.platforms.tiktok.redirect === 'https://old.example.com/api/verify/callback/tiktok',
  'адрес возврата для TikTok и YouTube — старый (OAUTH_BASE), он прописан в кабинетах', j.platforms);
  r = await realFetch('http://127.0.0.1:' + P_SRV + '/api/auth/google/start?role=blogger');
  j = await r.json();
  ok(r.status === 200 && String(j.url || '').includes('redirect_uri=' + encodeURIComponent('https://old.example.com/api/auth/google/callback')),
    'вход через Google: redirect_uri — старый адрес', j.url);
  r = await realFetch('http://127.0.0.1:' + P_SRV + '/api/auth/telegram/start?role=blogger');
  j = await r.json();
  const tq = new URL(String(j.url || 'http://x/')).searchParams;
  ok(r.status === 200 && tq.get('origin') === 'https://old.example.com' && (tq.get('return_to') || '').startsWith('https://old.example.com/api/auth/telegram/callback?n='),
    'вход через Телеграм: origin и return_to — старый адрес', j.url);
} finally {
  relayProc.kill();
  if (srvProc) srvProc.kill();
  upSrv.close();
  ruSrv.close();
  upSrv.closeAllConnections && upSrv.closeAllConnections();
  ruSrv.closeAllConnections && ruSrv.closeAllConnections();
}

console.log('\n' + (failed ? '✖' : '✔') + ' ретранслятор: ' + passed + ' ок, ' + failed + ' с ошибкой');
process.exit(failed ? 1 : 0);
