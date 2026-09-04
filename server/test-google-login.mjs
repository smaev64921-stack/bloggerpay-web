/* Вход через Google: что можно проверить без настоящего Google.
   Настоящий обмен кода на токен проверить нельзя — для этого нужен живой
   аккаунт и согласие человека. Проверяем всё остальное: выдачу ссылки,
   выбор аккаунта в ней, срок и одноразовость метки, честные отказы на
   подделанный возврат, а сам вход подделываем прямой записью в базу и
   смотрим, что сессия работает.
   Запуск: node test-google-login.mjs */

import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const PORT = 8098;
const BASE = 'http://127.0.0.1:' + PORT;
let passed = 0, failed = 0;
function ok(c, name, extra) {
  if (c) { passed++; console.log('  ok  ' + name); }
  else { failed++; console.log('  FAIL ' + name + (extra ? '  ← ' + JSON.stringify(extra).slice(0, 220) : '')); }
}
async function api(method, p, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const r = await fetch(BASE + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const txt = await r.text();
  let j = {}; try { j = JSON.parse(txt); } catch (e) { j = { _raw: txt.slice(0, 200) }; }
  return { status: r.status, body: j, text: txt };
}
const dir = mkdtempSync(path.join(tmpdir(), 'bp-glog-'));
const DB = path.join(dir, 'db.sqlite');
const srv = spawn(process.execPath, ['server.js'], {
  cwd: fileURLToPath(new URL('.', import.meta.url)),
  env: { ...process.env, PORT: String(PORT), DB_PATH: DB, ADMIN_KEY: 'test-key',
    YT_CLIENT_ID: 'test-client-id', YT_CLIENT_SECRET: 'test-secret',
    PUBLIC_URL: BASE, TEST_TOPUP: '1',
    YOOKASSA_SHOP_ID: '', YOOKASSA_SECRET_KEY: '', BOT_TOKEN: '', ADMIN_CHAT_ID: '' },
  stdio: 'ignore',
});
async function waitUp() {
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) return true; } catch (e) {}
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}
try {
  console.log('\nВход через Google');
  ok(await waitUp(), 'сервер поднялся');

  /* ── ссылка входа ── */
  const st = await api('GET', '/api/auth/google/start');
  ok(st.status === 200 && typeof st.body.url === 'string', 'ссылка входа выдана', st.body);
  const u = new URL(st.body.url);
  ok(u.host === 'accounts.google.com', 'ведёт на Google', u.host);
  ok(u.searchParams.get('prompt') === 'select_account', 'человек выберет аккаунт сам', u.searchParams.get('prompt'));
  ok(u.searchParams.get('scope') === 'openid email profile', 'просим только имя и почту', u.searchParams.get('scope'));
  ok(u.searchParams.get('redirect_uri') === BASE + '/api/auth/google/callback', 'адрес возврата наш', u.searchParams.get('redirect_uri'));
  ok(u.searchParams.get('state') === st.body.nonce, 'метка совпадает с ответом');
  ok(!/access_type=offline/.test(st.body.url), 'долгий доступ не просим — вход разовый');

  /* ── пока человек не вошёл ── */
  const pend = await api('GET', '/api/auth/google/pending?nonce=' + st.body.nonce);
  ok(pend.status === 200 && pend.body.state === 'waiting', 'до входа — «ждём»', pend.body);
  const bad = await api('GET', '/api/auth/google/pending?nonce=' + 'f'.repeat(48));
  ok(bad.status === 404, 'чужая метка не отвечает', bad.body);

  /* ── подделанный возврат ── */
  const noState = await fetch(BASE + '/api/auth/google/callback?code=x');
  const noStateTxt = await noState.text();
  ok(/не найдена/i.test(noStateTxt), 'возврат без метки отбит');
  const denied = await fetch(BASE + '/api/auth/google/callback?state=' + st.body.nonce);
  const deniedTxt = await denied.text();
  ok(/отмен/i.test(deniedTxt), 'отказ в Google показан по-человечески');
  const afterDeny = await api('GET', '/api/auth/google/pending?nonce=' + st.body.nonce);
  ok(afterDeny.status === 404, 'после отказа метка стёрта');

  /* ── подделываем успешный вход: пишем пользователя и сессию как это
        сделал бы callback, и проверяем, что сессия настоящая ── */
  const db = new DatabaseSync(DB);
  db.prepare(`INSERT INTO users (email, name, role, pass_salt, pass_hash, google_sub)
    VALUES (?,?,?,?,?,?)`).run('gtest@google.local', 'Гость Google', 'blogger', 'salt', 'dead', 'sub-123');
  const uid = db.prepare('SELECT id FROM users WHERE google_sub = ?').get('sub-123').id;
  const token = 'a'.repeat(64);
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?,?)')
    .run(token, uid, new Date(Date.now() + 864e5).toISOString());
  db.close();

  const me = await api('GET', '/api/me', null, token);
  ok(me.status === 200 && me.body.user.name === 'Гость Google', 'сессия работает, человек узнан', me.body.user);
  ok(me.body.user.email === 'gtest@google.local', 'почта на месте');

  /* пароля у такого аккаунта нет — войти им нельзя */
  const byPass = await api('POST', '/api/login', { email: 'gtest@google.local', password: 'dead' });
  ok(byPass.status !== 200, 'паролем в такой аккаунт не войти', byPass.body);

  /* ── код возврата ── */
  const wrong = await api('POST', '/api/auth/google/claim', { code: '000000' });
  ok(wrong.status === 404, 'неверный код не пускает', wrong.body);
  const short = await api('POST', '/api/auth/google/claim', { code: '12' });
  ok(short.status === 400, 'короткий код отбит', short.body);

  /* ── без ключей Google вход честно отказывает ── */
  const PORT2 = 8099;
  const dir2 = mkdtempSync(path.join(tmpdir(), 'bp-glog2-'));
  const srv2 = spawn(process.execPath, ['server.js'], {
    cwd: fileURLToPath(new URL('.', import.meta.url)),
    env: { ...process.env, PORT: String(PORT2), DB_PATH: path.join(dir2, 'db.sqlite'),
      ADMIN_KEY: 'test-key', YT_CLIENT_ID: '', YT_CLIENT_SECRET: '',
      YOOKASSA_SHOP_ID: '', YOOKASSA_SECRET_KEY: '', BOT_TOKEN: '' },
    stdio: 'ignore',
  });
  let up2 = false;
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch('http://127.0.0.1:' + PORT2 + '/api/health'); if (r.ok) { up2 = true; break; } } catch (e) {}
    await new Promise((r) => setTimeout(r, 150));
  }
  if (up2) {
    const r = await fetch('http://127.0.0.1:' + PORT2 + '/api/auth/google/start');
    const j = await r.json();
    ok(r.status === 503 && /не настроен/i.test(j.error || ''), 'без ключей — честный отказ, а не пустая ссылка', j);
  } else {
    ok(false, 'второй сервер не поднялся');
  }
  srv2.kill();
} catch (e) {
  failed++; console.log('  FAIL исключение: ' + e.message);
} finally {
  srv.kill();
}
console.log(`\nИтого: ${passed} ok, ${failed} FAIL`);
console.log('Не покрыто без настоящего Google: обмен кода на токен и разбор ответа о человеке.\n');
process.exit(failed ? 1 : 0);
