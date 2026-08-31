/* Подтверждение владения каналом (TikTok / YouTube).
   Проверяем всё, что не требует настоящих ключей площадок: сборку ссылки
   авторизации, подпись state, срок её жизни, отказ без ключей и защиту
   страницы возврата. Разбор ответа площадки проверить нельзя без ключей —
   это единственное, что остаётся на день подключения.
   Тест сам поднимает сервер с поддельными ключами и гасит его в конце.
   Запуск: node test-verify.mjs (основной сервер должен работать на 8090). */

import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAIN = 'http://127.0.0.1:8090';
const KEY = 'test-key';
const PUB = 'http://127.0.0.1:8096';

let passed = 0, failed = 0;
function ok(c, name, extra) {
  if (c) { passed++; console.log('  ok  ' + name); }
  else { failed++; console.log('  FAIL ' + name + (extra ? '  ← ' + JSON.stringify(extra) : '')); }
}
async function api(base, method, p, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const r = await fetch(base + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const txt = await r.text();
  let j = {}; try { j = JSON.parse(txt); } catch (e) { j = { _html: txt }; }
  return { status: r.status, body: j };
}
function boot(port, env) {
  const dir = mkdtempSync(path.join(tmpdir(), 'bp-vfy-'));
  return spawn(process.execPath, ['server.js'], {
    cwd: fileURLToPath(new URL('.', import.meta.url)),
    env: { ...process.env, PORT: String(port), DB_PATH: path.join(dir, 'db.sqlite'), ADMIN_KEY: KEY, ...env },
    stdio: 'ignore',
  });
}
async function waitUp(base) {
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(base + '/api/health'); if (r.ok) return true; } catch (e) {}
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}
async function reg(base, tag) {
  const r = await api(base, 'POST', '/api/register',
    { email: `vfy${tag}@t.ru`, name: 'Блогер', role: 'blogger', password: 'парольВ12345' });
  return { token: r.body.token, id: r.body.user && r.body.user.id };
}
const tag = Date.now();
console.log('\nПодтверждение канала: ссылка авторизации и защита возврата');

/* ── без ключей площадок ──
   Проверяем на ОТДЕЛЬНОМ сервере, которому ключи стёрты: у настоящего
   .env они уже могут быть заполнены, и тест не должен от этого зависеть. */
const bare = boot(8095, { TT_CLIENT_KEY: '', TT_CLIENT_SECRET: '', YT_CLIENT_ID: '', YT_CLIENT_SECRET: '' });
const BARE = 'http://127.0.0.1:8095';
ok(await waitUp(BARE), 'сервер без ключей площадок поднялся');
const noKeys = await reg(BARE, 'a' + tag);
const off = await api(BARE, 'GET', '/api/verify/start?platform=tiktok', null, noKeys.token);
ok(off.status === 503 && /не настроено/.test(off.body.error || ''),
   'без ключей TikTok сервер честно отвечает 503', off.body);
const offNoAuth = await api(BARE, 'GET', '/api/verify/start?platform=tiktok');
ok(offNoAuth.status === 401, 'начать проверку без входа нельзя', offNoAuth.body);
const offBadPlat = await api(BARE, 'GET', '/api/verify/start?platform=vk', null, noKeys.token);
ok(offBadPlat.status === 400, 'неизвестная площадка отклонена', offBadPlat.body);
bare.kill();

/* ── сервер с поддельными ключами: проверяем сборку ссылки ── */
const child = boot(8096, {
  TT_CLIENT_KEY: 'ttkey123', TT_CLIENT_SECRET: 'ttsecret',
  YT_CLIENT_ID: 'ytid123', YT_CLIENT_SECRET: 'ytsecret',
  PUBLIC_URL: PUB,
});
ok(await waitUp(PUB), 'сервер с ключами площадок поднялся');
const me = await reg(PUB, 'b' + tag);

const tt = await api(PUB, 'GET', '/api/verify/start?platform=tiktok', null, me.token);
ok(tt.status === 200 && typeof tt.body.url === 'string', 'ссылка авторизации TikTok выдана', tt.body);
const ttU = new URL(tt.body.url);
ok(ttU.origin + ttU.pathname === 'https://www.tiktok.com/v2/auth/authorize/',
   'TikTok: адрес авторизации версии v2', ttU.origin + ttU.pathname);
ok(ttU.searchParams.get('client_key') === 'ttkey123' && !ttU.searchParams.get('client_id'),
   'TikTok: ключ уходит как client_key (не client_id)');
ok(ttU.searchParams.get('response_type') === 'code', 'TikTok: response_type=code');
ok(ttU.searchParams.get('scope') === 'user.info.basic,user.info.profile,user.info.stats',
   'TikTok: запрошены имя, профиль и счётчики', ttU.searchParams.get('scope'));
ok(ttU.searchParams.get('redirect_uri') === PUB + '/api/verify/callback/tiktok',
   'TikTok: адрес возврата совпадает с тем, что ждёт сервер', ttU.searchParams.get('redirect_uri'));

const yt = await api(PUB, 'GET', '/api/verify/start?platform=youtube', null, me.token);
const ytU = new URL(yt.body.url);
ok(ytU.origin + ytU.pathname === 'https://accounts.google.com/o/oauth2/v2/auth', 'YouTube: адрес авторизации Google');
ok(ytU.searchParams.get('client_id') === 'ytid123' && !ytU.searchParams.get('client_key'),
   'YouTube: ключ уходит как client_id');
ok(ytU.searchParams.get('scope') === 'https://www.googleapis.com/auth/youtube.readonly',
   'YouTube: доступ только на чтение', ytU.searchParams.get('scope'));
ok(ytU.searchParams.get('redirect_uri') === PUB + '/api/verify/callback/youtube',
   'YouTube: адрес возврата совпадает', ytU.searchParams.get('redirect_uri'));

/* state — случайная одноразовая метка, а НЕ подписанный id пользователя:
   иначе ссылку можно было подсунуть жертве и записать её канал на себя */
const st = ttU.searchParams.get('state') || '';
ok(/^[0-9a-f]{48}$/.test(st), 'state — случайная метка (48 hex), без id внутри', st);
ok(!st.includes(String(me.id) + '.'), 'id пользователя в ссылку не утекает');
ok(tt.body.nonce === st, 'приложение получает ту же метку, чтобы следить за ходом проверки');

/* ── страница возврата ── */
async function cb(qs) {
  const r = await fetch(PUB + '/api/verify/callback/tiktok?' + qs);
  return { status: r.status, html: await r.text() };
}
const noCode = await cb('state=' + encodeURIComponent(st));
ok(noCode.status === 400 && /отменена/i.test(noCode.html), 'возврат без разрешения: «проверка отменена»');

const forged = await cb('code=x&state=' + 'f'.repeat(48));
ok(forged.status === 400 && /не найдена/i.test(forged.html),
   'выдуманная метка отбита (подобрать её нельзя)');

const badPlat = await fetch(PUB + '/api/verify/callback/vk?code=x');
ok(badPlat.status === 400, 'возврат с неизвестной площадки отклонён');

/* ── привязка идёт по коду, а не по метке ── */
const pend = await api(PUB, 'GET', '/api/verify/pending?nonce=' + encodeURIComponent(st), null, me.token);
ok(pend.status === 200 && pend.body.state === 'waiting', 'пока человек не вошёл — состояние «ждём»', pend.body);
const alien = await reg(PUB, 'c' + tag);          /* посторонний на ТОМ ЖЕ сервере */
const pendAlien = await api(PUB, 'GET', '/api/verify/pending?nonce=' + encodeURIComponent(st), null, alien.token);
ok(pendAlien.body.state === 'none', 'чужую проверку по метке не подсмотреть', pendAlien.body);
const pendNoAuth = await api(PUB, 'GET', '/api/verify/pending?nonce=' + encodeURIComponent(st));
ok(pendNoAuth.status === 401, 'состояние проверки без входа не отдаётся');

const confEarly = await api(PUB, 'POST', '/api/verify/confirm', { nonce: st, code: '123456' }, me.token);
ok(confEarly.status === 404, 'подтвердить до входа на площадке нельзя', confEarly.body);
const confNoAuth = await api(PUB, 'POST', '/api/verify/confirm', { nonce: st, code: '123456' });
ok(confNoAuth.status === 401, 'подтверждение без входа отклонено');
const confJunk = await api(PUB, 'POST', '/api/verify/confirm', { nonce: 'нет-такой', code: '123456' }, me.token);
ok(confJunk.status === 404, 'подтверждение по выдуманной метке отклонено');

/* отвязка канала оператором */
const unlinkNoKey = await api(PUB, 'POST', '/api/admin/verify/unlink', { platform: 'tiktok', externalId: 'x' });
ok(unlinkNoKey.status === 403, 'отвязка канала без ключа оператора закрыта');
const unlinkMissing = await fetch(PUB + '/api/admin/verify/unlink', {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Admin-Key': KEY },
  body: JSON.stringify({ platform: 'tiktok', externalId: 'нет-такого' }),
});
ok(unlinkMissing.status === 404, 'отвязка несуществующего канала — 404');

/* список подтверждённых каналов */
const list = await api(PUB, 'GET', '/api/verify/list', null, me.token);
ok(list.status === 200 && Array.isArray(list.body.rows) && list.body.rows.length === 0,
   'список подтверждённых каналов пока пуст', list.body);
const listNoAuth = await api(PUB, 'GET', '/api/verify/list');
ok(listNoAuth.status === 401, 'чужой список каналов не отдаётся');

child.kill();
console.log(`\nИтого: ${passed} ok, ${failed} fail`);
console.log('Не покрыто без настоящих ключей: разбор ответа площадки (имя канала и подписчики).\n');
process.exit(failed ? 1 : 0);
