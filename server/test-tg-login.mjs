/* Вход через Телеграм в обычном браузере (Login Widget по домену).
   Здесь, в отличие от Google, проверить можно ПОЧТИ всё: подпись ответа
   считается ключом SHA256 от токена бота, а токен в проверке наш —
   значит мы умеем подделать настоящий ответ Телеграма и убедиться, что
   сервер его принимает, а испорченный отвергает.
   Запуск: node test-tg-login.mjs */

import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const PORT = 8096;
const BASE = 'http://127.0.0.1:' + PORT;
const BOT_ID = '123456789';
const BOT_TOKEN = BOT_ID + ':AAtest-token-not-real';
let passed = 0, failed = 0;
function ok(c, name, extra) {
  if (c) { passed++; console.log('  ok  ' + name); }
  else { failed++; console.log('  FAIL ' + name + (extra ? '  ← ' + JSON.stringify(extra).slice(0, 240) : '')); }
}
async function api(method, p, body) {
  const r = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const txt = await r.text();
  let j = {}; try { j = JSON.parse(txt); } catch (e) { j = { _raw: txt.slice(0, 200) }; }
  return { status: r.status, body: j, text: txt };
}

/* Ровно то, что делает Телеграм: поля по алфавиту, «ключ=значение»
   через перевод строки, ключ — SHA256 от токена бота. */
function sign(fields, token) {
  const line = Object.keys(fields).sort().map((k) => k + '=' + fields[k]).join('\n');
  const secret = crypto.createHash('sha256').update(token).digest();
  return crypto.createHmac('sha256', secret).update(line).digest('hex');
}
function tgReply(over) {
  const f = Object.assign({
    id: '777000',
    first_name: 'Иван',
    username: 'ivan',
    auth_date: String(Math.floor(Date.now() / 1000)),
  }, over || {});
  f.hash = sign(f, BOT_TOKEN);
  return f;
}
function asQuery(nonce, f) {
  const q = new URLSearchParams({ n: nonce });
  Object.keys(f).forEach((k) => q.set(k, f[k]));
  return q.toString();
}

const CWD = fileURLToPath(new URL('.', import.meta.url));
function start(port, env) {
  return spawn(process.execPath, ['server.js'], {
    cwd: CWD,
    env: {
      ...process.env, PORT: String(port), ADMIN_KEY: 'test-key',
      YOOKASSA_SHOP_ID: '', YOOKASSA_SECRET_KEY: '', ADMIN_CHAT_ID: '',
      YT_CLIENT_ID: '', YT_CLIENT_SECRET: '',
      ...env,
    },
    stdio: 'ignore',
  });
}
async function up(port) {
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch('http://127.0.0.1:' + port + '/api/health'); if (r.ok) return true; } catch (e) {}
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

const dir = mkdtempSync(path.join(tmpdir(), 'bp-tglog-'));
const srv = start(PORT, { DB_PATH: path.join(dir, 'db.sqlite'), PUBLIC_URL: BASE, BOT_TOKEN });
let srv2 = null;

try {
  console.log('\nВход через Телеграм в браузере');
  ok(await up(PORT), 'сервер поднялся');

  /* ── ссылка входа ── */
  const st = await api('GET', '/api/auth/telegram/start');
  ok(st.status === 200 && typeof st.body.url === 'string', 'ссылка входа выдана', st.body);
  const u = new URL(st.body.url);
  ok(u.origin + u.pathname === 'https://oauth.telegram.org/auth', 'ведёт на Телеграм', u.href.slice(0, 60));
  ok(u.searchParams.get('bot_id') === BOT_ID, 'номер бота взят из токена', u.searchParams.get('bot_id'));
  ok(u.searchParams.get('origin') === BASE, 'origin — наш адрес (он же прописан в BotFather)');
  ok(u.searchParams.get('return_to') === BASE + '/api/auth/telegram/callback?n=' + st.body.nonce,
    'адрес возврата наш и с меткой', u.searchParams.get('return_to'));
  ok(u.searchParams.get('embed') === '0', 'полностраничный вход, не рамка');

  /* ── пока человек не вошёл ── */
  const pend = await api('GET', '/api/auth/telegram/pending?nonce=' + st.body.nonce);
  ok(pend.status === 200 && pend.body.state === 'waiting', 'до входа — «ждём»', pend.body);
  const bad = await api('GET', '/api/auth/telegram/pending?nonce=' + 'f'.repeat(48));
  ok(bad.status === 404, 'чужая метка не отвечает', bad.body);

  /* ── возврат без метки ── */
  const noState = await fetch(BASE + '/api/auth/telegram/callback');
  ok(/не найдена/i.test(await noState.text()), 'возврат без метки отбит');

  /* ── возврат без полей: отдаём страницу-перекладчик ── */
  const empty = await fetch(BASE + '/api/auth/telegram/callback?n=' + st.body.nonce);
  const emptyTxt = await empty.text();
  ok(empty.status === 200 && /Заканчиваем вход/.test(emptyTxt),
    'ответ во фрагменте: отдаём страницу-перекладчик');
  ok(/tgAuthResult/.test(emptyTxt), 'страница знает, где искать ответ Телеграма');

  /* ── испорченная подпись ── */
  const forged = tgReply();
  forged.hash = forged.hash.replace(/.$/, (c) => (c === '0' ? '1' : '0'));
  const badSig = await fetch(BASE + '/api/auth/telegram/callback?' + asQuery(st.body.nonce, forged));
  ok(/подпись/i.test(await badSig.text()), 'подделанная подпись отбита');

  /* ── просроченный ответ ── */
  const old = tgReply({ auth_date: String(Math.floor(Date.now() / 1000) - 90000) });
  const oldRes = await fetch(BASE + '/api/auth/telegram/callback?' + asQuery(st.body.nonce, old));
  ok(/просрочен/i.test(await oldRes.text()), 'вчерашний ответ не принимается');

  /* ── настоящий вход ── */
  const good = tgReply();
  const okRes = await fetch(BASE + '/api/auth/telegram/callback?' + asQuery(st.body.nonce, good),
    { redirect: 'manual' });
  const loc = okRes.headers.get('location') || '';
  /* Успех возвращает переходом, а не страницей «Вы вошли»: лишняя
     остановка посреди дороги — это и есть «долго грузит». */
  ok(okRes.status === 302 && loc.indexOf('tglogin=' + st.body.nonce) > 0,
    'верная подпись пускает и сразу возвращает в приложение', { status: okRes.status, loc: loc.slice(0, 90) });

  const got = await api('GET', '/api/auth/telegram/pending?nonce=' + st.body.nonce);
  ok(got.status === 200 && got.body.state === 'ok' && got.body.token, 'сессия отдана приложению', got.body);
  ok(got.body.user && got.body.user.name === 'Иван', 'имя из Телеграма', got.body.user);

  const me = await fetch(BASE + '/api/me', { headers: { Authorization: 'Bearer ' + got.body.token } });
  const meJ = await me.json();
  ok(me.status === 200 && meJ.user && /telegram\.local$/.test(meJ.user.email),
    'сессия рабочая, аккаунт заведён по Телеграму', meJ.user);

  const twice = await api('GET', '/api/auth/telegram/pending?nonce=' + st.body.nonce);
  ok(twice.status === 404, 'метка забирается один раз');

  /* ── второй вход тем же человеком — тот же аккаунт, а не второй ── */
  const st2 = await api('GET', '/api/auth/telegram/start');
  await fetch(BASE + '/api/auth/telegram/callback?' + asQuery(st2.body.nonce, tgReply()));
  const got2 = await api('GET', '/api/auth/telegram/pending?nonce=' + st2.body.nonce);
  ok(got2.body.user && got2.body.user.id === got.body.user.id,
    'повторный вход даёт тот же аккаунт', { first: got.body.user, second: got2.body.user });

  /* ── код возврата для другого браузера ── */
  const st3 = await api('GET', '/api/auth/telegram/start');
  const blind = await api('POST', '/api/auth/telegram/claim', { code: '000000' });
  ok(blind.status === 404, 'код без метки не ищется по чужим входам', blind.body);
  let last = null;
  for (let i = 0; i < 5; i++) {
    last = await api('POST', '/api/auth/telegram/claim', { nonce: st3.body.nonce, code: '000001' });
  }
  ok(last.status === 400 && last.body.left === 0, 'ошибки считаются, попытки кончаются', last.body);
  const burnt = await api('POST', '/api/auth/telegram/claim', { nonce: st3.body.nonce, code: '000001' });
  ok(burnt.status === 429, 'после пяти ошибок метка сгорает', burnt.body);

  /* ── без токена бота вход честно отказывает ── */
  const PORT2 = PORT + 1;
  const dir2 = mkdtempSync(path.join(tmpdir(), 'bp-tglog2-'));
  srv2 = start(PORT2, { DB_PATH: path.join(dir2, 'db.sqlite'), BOT_TOKEN: '' });
  if (await up(PORT2)) {
    const r = await fetch('http://127.0.0.1:' + PORT2 + '/api/auth/telegram/start');
    const j = await r.json();
    ok(r.status === 503 && /не настроен/i.test(j.error || ''), 'без токена — честный отказ', j);
    const m = await fetch('http://127.0.0.1:' + PORT2 + '/api/auth/methods').then((x) => x.json());
    ok(m.telegram === false, 'способ входа помечен ненастроенным', m);
  } else {
    ok(false, 'второй сервер не поднялся');
  }
} catch (e) {
  failed++; console.log('  FAIL исключение: ' + e.message);
} finally {
  try { srv.kill(); } catch (e) { /* уже мёртв */ }
  try { if (srv2) srv2.kill(); } catch (e) { /* уже мёртв */ }
}
console.log(`\nИтого: ${passed} ok, ${failed} FAIL`);
console.log('Не покрыто: сама страница Телеграма — её показывает Телеграм.\n');
process.exit(failed ? 1 : 0);
