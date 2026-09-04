/* Возврат с площадки: человек входит в TikTok и возвращается в приложение,
   канал привязывается САМ — без переписывания шести цифр.

   Настоящий TikTok здесь не нужен: сервер умеет ходить за токеном и данными
   аккаунта по адресу из TT_API_BASE, поэтому поднимаем крошечную поддельную
   площадку и указываем на неё. Проверяем и сам возврат, и всё, чем его можно
   сломать: чужой пропуск, повтор, чужой аккаунт, подмена длины.

   Запуск: node test-return.mjs (свой сервер поднимает сам). */

import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = 8097;
const FAKE = 8098;
const BASE = 'http://127.0.0.1:' + PORT;
const APP = 'http://127.0.0.1:9999/app';

let passed = 0, failed = 0;
function ok(c, name, extra) {
  if (c) { passed++; console.log('  ok  ' + name); }
  else { failed++; console.log('  FAIL ' + name + (extra ? '  ← ' + JSON.stringify(extra) : '')); }
}

/* ── Поддельный TikTok ──
   Отдаёт токен на любой код и один и тот же аккаунт. Этого хватает: нас
   интересует не разбор ответа площадки, а что делает наш сервер после. */
const fake = createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.url.startsWith('/v2/oauth/token')) {
    res.end(JSON.stringify({ access_token: 'токен', scope: 'user.info.basic' }));
    return;
  }
  if (req.url.startsWith('/v2/user/info')) {
    res.end(JSON.stringify({ data: { user: {
      open_id: 'канал-1', display_name: 'Канал для проверки',
      username: 'proverka', follower_count: 1234,
    } } }));
    return;
  }
  res.statusCode = 404;
  res.end('{}');
});

const dir = mkdtempSync(path.join(tmpdir(), 'bp-ret-'));
const srv = spawn(process.execPath, ['server.js'], {
  cwd: fileURLToPath(new URL('.', import.meta.url)),
  env: {
    ...process.env,
    PORT: String(PORT),
    DB_PATH: path.join(dir, 'db.sqlite'),
    ADMIN_KEY: 'ключ-проверки',
    PUBLIC_URL: BASE,
    APP_URL: APP,
    TT_CLIENT_KEY: 'ключ', TT_CLIENT_SECRET: 'секрет',
    TT_AUTH_BASE: 'http://127.0.0.1:' + FAKE,
    TT_API_BASE: 'http://127.0.0.1:' + FAKE,
    TT_SCOPE: 'user.info.basic',
    BOT_TOKEN: '', ADMIN_CHAT_ID: '', RESEND_API_KEY: '',
  },
  stdio: 'ignore',
});

async function api(method, p, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const r = await fetch(BASE + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const txt = await r.text();
  let j = {}; try { j = JSON.parse(txt); } catch (e) { j = { _text: txt }; }
  return { status: r.status, body: j };
}
async function waitUp() {
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) return true; } catch (e) { /* ещё не поднялся */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}
function stop() { try { srv.kill(); } catch (e) { /* уже мёртв */ } try { fake.close(); } catch (e) { /* закрыт */ } }

/* Возврат площадки: сервер отвечает перенаправлением, за ним не идём. */
function callback(state, code) {
  return fetch(BASE + '/api/verify/callback/tiktok?code=' + encodeURIComponent(code || 'код')
    + '&state=' + encodeURIComponent(state), { redirect: 'manual' });
}
function claimOf(location) {
  try { return new URL(location, BASE).searchParams.get('claim') || ''; } catch (e) { return ''; }
}

try {
  await new Promise((r) => fake.listen(FAKE, '127.0.0.1', r));
  if (!await waitUp()) { console.log('сервер не поднялся'); stop(); process.exit(1); }

  console.log('Возврат с площадки: канал привязывается сам\n');

  const blogger = (await api('POST', '/api/register', {
    email: 'vozvrat@t.ru', name: 'Блогер', role: 'blogger', password: 'пароль-подлиннее',
  })).body;
  const other = (await api('POST', '/api/register', {
    email: 'chuzhoy@t.ru', name: 'Посторонний', role: 'blogger', password: 'пароль-подлиннее',
  })).body;
  ok(!!blogger.token && !!other.token, 'два аккаунта заведены');

  /* ── Обычный путь ── */
  const start = await api('GET', '/api/verify/start?platform=tiktok', null, blogger.token);
  ok(start.status === 200 && !!start.body.nonce, 'проверка началась', start.body);
  const nonce = start.body.nonce;
  ok(String(start.body.url || '').startsWith('http://127.0.0.1:' + FAKE),
    'ссылка ведёт на площадку из настроек');

  const back = await callback(nonce);
  const loc = back.headers.get('location') || '';
  if (back.status !== 302) console.log('    (ответ возврата: ' + back.status + ' ' + (await back.clone().text()).replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 300) + ')');
  ok(back.status === 302, 'площадка вернула человека перенаправлением, а не страницей с кодом', back.status);
  ok(loc.startsWith(APP), 'возврат ведёт в приложение (APP_URL)', loc.slice(0, 80));
  ok(loc.includes('vfy=' + nonce), 'в адресе возврата есть метка проверки');
  const claim = claimOf(loc);
  ok(claim.length === 48, 'в адресе возврата есть разовый пропуск', claim.length);

  /* ── Чем это можно сломать ── */
  const noAuth = await api('POST', '/api/verify/confirm', { nonce, claim });
  ok(noAuth.status === 401, 'без входа пропуск не работает', noAuth.body);

  const stranger = await api('POST', '/api/verify/confirm', { nonce, claim }, other.token);
  ok(stranger.status === 403,
    'чужой аккаунт по подсунутой ссылке канал себе не запишет', stranger.body);

  const shortClaim = await api('POST', '/api/verify/confirm', { nonce, claim: 'коротко' }, blogger.token);
  ok(shortClaim.status === 400, 'пропуск другой длины отклонён, а не уронил сервер', shortClaim.body);

  const wrongClaim = await api('POST', '/api/verify/confirm',
    { nonce, claim: 'f'.repeat(claim.length) }, blogger.token);
  ok(wrongClaim.status === 400, 'неверный пропуск отклонён', wrongClaim.body);

  const wrongCode = await api('POST', '/api/verify/confirm', { nonce, code: '000000' }, blogger.token);
  ok(wrongCode.status === 400, 'неверный код по-прежнему отклоняется', wrongCode.body);

  /* ── Настоящее подтверждение ── */
  const good = await api('POST', '/api/verify/confirm', { nonce, claim }, blogger.token);
  ok(good.status === 200 && good.body.ok, 'канал привязался по пропуску', good.body);
  ok(good.body.title === 'Канал для проверки', 'название канала пришло с площадки', good.body);

  const again = await api('POST', '/api/verify/confirm', { nonce, claim }, blogger.token);
  ok(again.status === 404, 'повтор того же пропуска не проходит', again.body);

  const mine = await api('GET', '/api/channels', null, blogger.token);
  const list = (mine.body && (mine.body.channels || mine.body.rows)) || [];
  ok(list.length === 1 && String(list[0].ext_id || list[0].extId) === 'канал-1',
    'канал виден в аккаунте блогера', mine.body);

  /* ── Тот же канал во второй аккаунт ── */
  const start2 = await api('GET', '/api/verify/start?platform=tiktok', null, other.token);
  const back2 = await callback(start2.body.nonce);
  const loc2 = back2.headers.get('location') || '';
  const body2 = await back2.text();
  ok(back2.status !== 302 || !loc2.startsWith(APP),
    'занятый канал во второй аккаунт не возвращают с пропуском',
    { status: back2.status, loc: loc2.slice(0, 60) });
  ok(/уже подтверждён|занят/i.test(body2 + loc2), 'человеку сказали, что канал уже занят');

  /* ── Просроченная и выдуманная метка ── */
  const junk = await api('POST', '/api/verify/confirm', { nonce: 'нет-такой', claim }, blogger.token);
  ok(junk.status === 404, 'выдуманная метка отклонена', junk.body);

  const badState = await callback('нет-такой-метки');
  const badText = await badState.text();
  ok(badState.status !== 302, 'возврат с чужой меткой никуда не перенаправляет', badState.status);
  ok(/не найдена|заново/i.test(badText), 'и объясняет, что проверку надо начать заново');
} catch (e) {
  failed++;
  console.log('  FAIL неожиданная ошибка: ' + (e && e.message));
} finally {
  stop();
}

console.log('\nИтого: ' + passed + ' ok, ' + failed + ' FAIL');
process.exit(failed ? 1 : 0);
