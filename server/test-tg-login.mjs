/* Вход через Телеграм в обычном браузере (OpenID Connect).
   Настоящий обмен кода на id_token проверить нельзя — для этого нужен
   живой аккаунт и согласие человека. Проверяем всё остальное: выдачу
   ссылки, её состав (PKCE, адрес возврата, набор прав), честный отказ
   без ключей, срок и одноразовость метки, отпор подделанному возврату и
   перебору шестизначного кода.
   Запуск: node test-tg-login.mjs */

import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = 8096;
const BASE = 'http://127.0.0.1:' + PORT;
const BOT_ID = '123456789';
let passed = 0, failed = 0;
function ok(c, name, extra) {
  if (c) { passed++; console.log('  ok  ' + name); }
  else { failed++; console.log('  FAIL ' + name + (extra ? '  ← ' + JSON.stringify(extra).slice(0, 220) : '')); }
}
async function api(method, p, body) {
  const headers = { 'Content-Type': 'application/json' };
  const r = await fetch(BASE + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const txt = await r.text();
  let j = {}; try { j = JSON.parse(txt); } catch (e) { j = { _raw: txt.slice(0, 200) }; }
  return { status: r.status, body: j, text: txt };
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
const srv = start(PORT, {
  DB_PATH: path.join(dir, 'db.sqlite'),
  PUBLIC_URL: BASE,
  BOT_TOKEN: BOT_ID + ':AAtest-token-not-real',
  TG_CLIENT_SECRET: 'test-secret',
});

let srv2 = null;
try {
  console.log('\nВход через Телеграм в браузере');
  ok(await up(PORT), 'сервер поднялся');

  /* ── ссылка входа ── */
  const st = await api('GET', '/api/auth/telegram/start');
  ok(st.status === 200 && typeof st.body.url === 'string', 'ссылка входа выдана', st.body);
  const u = new URL(st.body.url);
  ok(u.origin + u.pathname === 'https://oauth.telegram.org/auth', 'ведёт на Телеграм', u.href.slice(0, 60));
  ok(u.searchParams.get('client_id') === BOT_ID, 'номер бота взят из токена', u.searchParams.get('client_id'));
  ok(u.searchParams.get('response_type') === 'code', 'просим код, а не токен в адресе');
  ok(u.searchParams.get('scope') === 'openid profile', 'просим только имя, без телефона', u.searchParams.get('scope'));
  ok(u.searchParams.get('redirect_uri') === BASE + '/api/auth/telegram/callback', 'адрес возврата наш');
  ok(u.searchParams.get('state') === st.body.nonce, 'метка совпадает с ответом');
  ok(u.searchParams.get('code_challenge_method') === 'S256', 'PKCE включён');
  ok((u.searchParams.get('code_challenge') || '').length >= 42, 'проверочная строка PKCE не пустая');

  /* ── пока человек не вошёл ── */
  const pend = await api('GET', '/api/auth/telegram/pending?nonce=' + st.body.nonce);
  ok(pend.status === 200 && pend.body.state === 'waiting', 'до входа — «ждём»', pend.body);
  const bad = await api('GET', '/api/auth/telegram/pending?nonce=' + 'f'.repeat(48));
  ok(bad.status === 404, 'чужая метка не отвечает', bad.body);

  /* ── подделанный возврат ── */
  const noState = await fetch(BASE + '/api/auth/telegram/callback?code=x');
  ok(/не найдена/i.test(await noState.text()), 'возврат без метки отбит');
  const denied = await fetch(BASE + '/api/auth/telegram/callback?state=' + st.body.nonce);
  ok(/отмен/i.test(await denied.text()), 'отказ у Телеграма показан по-человечески');
  const afterDeny = await api('GET', '/api/auth/telegram/pending?nonce=' + st.body.nonce);
  ok(afterDeny.status === 404, 'после отказа метка стёрта');

  /* ── код возврата: только со своей меткой и с ограничением попыток ── */
  const blind = await api('POST', '/api/auth/telegram/claim', { code: '000000' });
  ok(blind.status === 404, 'код без метки не ищется по чужим входам', blind.body);

  const st2 = await api('GET', '/api/auth/telegram/start');
  const n2 = st2.body.nonce;
  const short = await api('POST', '/api/auth/telegram/claim', { nonce: n2, code: '12' });
  ok(short.status === 400 && /шесть/i.test(short.body.error || ''), 'короткий код отбит', short.body);
  let last = null;
  for (let i = 0; i < 5; i++) {
    last = await api('POST', '/api/auth/telegram/claim', { nonce: n2, code: '000001' });
  }
  ok(last.status === 400 && last.body.left === 0, 'ошибки считаются, попытки кончаются', last.body);
  const burnt = await api('POST', '/api/auth/telegram/claim', { nonce: n2, code: '000001' });
  ok(burnt.status === 429, 'после пяти ошибок метка сгорает', burnt.body);

  /* ── две метки не мешают друг другу ── */
  const a = await api('GET', '/api/auth/telegram/start');
  const b = await api('GET', '/api/auth/telegram/start');
  ok(a.body.nonce !== b.body.nonce, 'у каждой попытки своя метка');
  ok(new URL(a.body.url).searchParams.get('code_challenge')
    !== new URL(b.body.url).searchParams.get('code_challenge'), 'у каждой попытки своя строка PKCE');

  /* ── без секрета вход честно отказывает ── */
  const PORT2 = PORT + 1;
  const dir2 = mkdtempSync(path.join(tmpdir(), 'bp-tglog2-'));
  srv2 = start(PORT2, {
    DB_PATH: path.join(dir2, 'db.sqlite'),
    BOT_TOKEN: BOT_ID + ':AAtest-token-not-real',
    TG_CLIENT_SECRET: '',
  });
  if (await up(PORT2)) {
    const r = await fetch('http://127.0.0.1:' + PORT2 + '/api/auth/telegram/start');
    const j = await r.json();
    ok(r.status === 503 && /не настроен/i.test(j.error || ''), 'без ключей — честный отказ, а не пустая ссылка', j);
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
console.log('Не покрыто без настоящего Телеграма: обмен кода на id_token и проверка его подписи.\n');
process.exit(failed ? 1 : 0);
