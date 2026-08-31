/* Вход по Телеграму: проверка подписи initData.
   Подделать подпись без токена бота нельзя — это и проверяем.
   Запуск: node test-telegram.mjs (сервер должен работать с BOT_TOKEN в .env). */

import { readFileSync } from 'node:fs';
import crypto from 'node:crypto';

const BASE = 'http://127.0.0.1:8090';
const env = readFileSync(new URL('./.env', import.meta.url), 'utf8');
const BOT_TOKEN = (/BOT_TOKEN=(\S+)/.exec(env) || [])[1] || '';

let passed = 0, failed = 0;
function ok(c, name, extra) {
  if (c) { passed++; console.log('  ok  ' + name); }
  else { failed++; console.log('  FAIL ' + name + (extra ? '  ← ' + JSON.stringify(extra) : '')); }
}
async function api(m, p, b) {
  const r = await fetch(BASE + p, {
    method: m, headers: { 'Content-Type': 'application/json' },
    body: b ? JSON.stringify(b) : undefined,
  });
  return { status: r.status, body: await r.json() };
}

/* Собираем initData ровно так, как это делает Телеграм. */
function makeInitData(user, token, authDate) {
  const params = new URLSearchParams();
  params.set('user', JSON.stringify(user));
  params.set('auth_date', String(authDate || Math.floor(Date.now() / 1000)));
  params.set('query_id', 'AAH' + Math.random().toString(36).slice(2, 10));

  const pairs = [];
  for (const [k, v] of params.entries()) pairs.push(k + '=' + v);
  pairs.sort();

  const secret = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
  const hash = crypto.createHmac('sha256', secret).update(pairs.join('\n')).digest('hex');
  params.set('hash', hash);
  return params.toString();
}

console.log('\nВход по Телеграму');

if (!BOT_TOKEN) {
  console.log('  BOT_TOKEN в .env не задан — проверяем, что сервер честно об этом говорит');
  const off = await api('POST', '/api/auth/telegram', { initData: 'что угодно' });
  ok(off.status === 503 && /BOT_TOKEN/.test(off.body.error || ''), 'без токена вход отключён с внятным ответом', off.body);
  console.log('\nИтого: ' + passed + ' прошло, ' + failed + ' упало');
  console.log('Чтобы прогнать проверку подписи целиком, впишите BOT_TOKEN в server/.env.');
  process.exit(failed ? 1 : 0);
}

const tg = { id: 700100200, first_name: 'Пётр', last_name: 'Блогеров', username: 'petr' };

/* 1. Настоящая подпись */
const good = await api('POST', '/api/auth/telegram', { initData: makeInitData(tg, BOT_TOKEN) });
ok(good.status === 200 && good.body.token, 'вход с настоящей подписью', good.body);
ok(good.body.user && good.body.user.name === 'Пётр Блогеров', 'имя взято из Телеграма', good.body.user);

/* 2. Повторный вход — тот же аккаунт, а не второй */
const again = await api('POST', '/api/auth/telegram', { initData: makeInitData(tg, BOT_TOKEN) });
ok(again.status === 200 && again.body.user.id === good.body.user.id, 'повторный вход — тот же аккаунт');

/* 3. Подпись чужим токеном — самое главное */
const forged = await api('POST', '/api/auth/telegram', { initData: makeInitData({ id: 999, first_name: 'Чужой' }, 'токен-злоумышленника') });
ok(forged.status === 401, 'подпись чужим токеном отклонена', forged.body);

/* 4. Подмена данных при верной подписи */
const base = makeInitData(tg, BOT_TOKEN);
const tampered = base.replace(/user=[^&]*/, 'user=' + encodeURIComponent(JSON.stringify({ id: 1, first_name: 'Админ' })));
const t = await api('POST', '/api/auth/telegram', { initData: tampered });
ok(t.status === 401, 'подменённые данные при старой подписи отклонены', t.body);

/* 5. Без подписи вовсе */
const nohash = await api('POST', '/api/auth/telegram', { initData: 'user=%7B%22id%22%3A5%7D&auth_date=' + Math.floor(Date.now() / 1000) });
ok(nohash.status === 401, 'данные без подписи отклонены');

/* 6. Просроченная подпись */
const old = await api('POST', '/api/auth/telegram', {
  initData: makeInitData(tg, BOT_TOKEN, Math.floor(Date.now() / 1000) - 90000),
});
ok(old.status === 401 && /устарел/.test(old.body.error || ''), 'просроченная подпись отклонена', old.body);

/* 7. Токен из входа действительно работает */
const me = await fetch(BASE + '/api/me', { headers: { Authorization: 'Bearer ' + good.body.token } });
const meBody = await me.json();
ok(me.status === 200 && meBody.user.id === good.body.user.id, 'выданным токеном можно работать');
ok(meBody.balance && meBody.balance.available === 0, 'у нового аккаунта пустой баланс', meBody.balance);

console.log('\nИтого: ' + passed + ' прошло, ' + failed + ' упало');
process.exit(failed ? 1 : 0);
