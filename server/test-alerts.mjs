/* Тревога в Телеграм: скрытые ошибки сайта летят владельцу.
   Настоящий server.js + заглушка API Телеграма на localhost —
   проверяем весь путь: приём ошибки → сообщение админу, дедупликацию,
   потолок в час и полное молчание, когда тревога не настроена. */
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let passed = 0, failed = 0;
function ok(c, name, extra) {
  if (c) { passed++; console.log('  ok  ' + name); }
  else { failed++; console.log('  FAIL ' + name + (extra ? '  ← ' + JSON.stringify(extra).slice(0, 300) : '')); }
}

/* ── Заглушка Телеграма: копим все sendMessage ── */
const sent = [];
const stub = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const method = req.url.split('/').pop();
    let data = {};
    try { data = JSON.parse(body || '{}'); } catch (e) {}
    /* «Бот обновлён» — не тревога, а сигнал о запуске: сервер поднимает
       бота в том же процессе, и тот пишет владельцу одну строку. В счёт
       тревог он идти не должен, иначе каждый прогон сдвигал бы все
       ожидаемые числа на единицу. */
    if (method === 'sendMessage' && !/^Бот обновлён/.test(String(data.text || ''))) {
      sent.push(data);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, result: { message_id: sent.length } }));
  });
});
await new Promise((r) => stub.listen(8127, '127.0.0.1', r));

function boot(port, extraEnv) {
  const dir = mkdtempSync(path.join(tmpdir(), 'bp-alerts-'));
  return spawn(process.execPath, ['server.js'], {
    cwd: fileURLToPath(new URL('.', import.meta.url)),
    env: {
      ...process.env,
      PORT: String(port),
      DB_PATH: path.join(dir, 'db.sqlite'),
      ADMIN_KEY: 'test-key',
      BOT_TOKEN: '111:TESTTOKEN',
      ADMIN_CHAT_ID: '424242',
      TG_API_BASE: 'http://127.0.0.1:8127',
      YOOKASSA_SHOP_ID: '', YOOKASSA_SECRET_KEY: '',
      ...extraEnv,
    },
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function report(base, errors) {
  const r = await fetch(base + '/api/errors', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ errors }),
  });
  return { status: r.status, body: await r.json() };
}

console.log('\nТревога в Телеграм: путь ошибки до админа');

const BASE = 'http://127.0.0.1:8098';
const srv = boot(8098);
ok(await waitUp(BASE), 'сервер с тревогой поднялся');

/* 1. Новая ошибка → сообщение админу */
const r1 = await report(BASE, [{ message: 'Сломалась кнопка вывода', where: 'app.js:10', version: 'v100' }]);
await sleep(600);
ok(r1.status === 200 && r1.body.taken === 1, 'ошибка принята сервером', r1);
ok(sent.length === 1, 'админу ушло ровно одно сообщение', { got: sent.length });
const m1 = sent[0] || {};
ok(String(m1.chat_id) === '424242', 'сообщение адресовано чату из ADMIN_CHAT_ID', m1);
ok(/Сломалась кнопка вывода/.test(m1.text || '') && /app\.js:10/.test(m1.text || ''),
  'в сообщении есть текст ошибки и место', m1.text);
ok(/гость/.test(m1.text || ''), 'видно, что ошибка у невошедшего', m1.text);

/* 2. Та же ошибка снова → в базу пишется, но чат не заваливается */
const r2 = await report(BASE, [{ message: 'Сломалась кнопка вывода', where: 'app.js:10', version: 'v100' }]);
await sleep(600);
ok(r2.body.taken === 1 && sent.length === 1, 'повтор той же ошибки не дублируется в чат', { sent: sent.length });

/* 3. Другая ошибка → новое сообщение */
await report(BASE, [{ message: 'Экран профиля пустой', where: 'app.js:77' }]);
await sleep(600);
ok(sent.length === 2, 'другая ошибка — новое сообщение', { sent: sent.length });

/* 4. Пустое сообщение не шлётся никуда */
const r4 = await report(BASE, [{ message: '', where: 'x' }]);
await sleep(400);
ok(r4.body.taken === 0 && sent.length === 2, 'пустая ошибка отброшена', r4);

/* 5. Потолок кошелька сайта: не больше 15 тревог в час + одно «молчу» */
for (let i = 0; i < 25; i++) {
  await report(BASE, [{ message: 'Разная ошибка №' + i, where: 'loop.js:' + i }]);
}
await sleep(1200);
/* уже ушло 2; новых разных 25 → доехать должны 13 до потолка (15) и одно «молчу» */
ok(sent.length === 16, 'после потопа сообщений ровно 16 (потолок 15 + «молчу»)', { sent: sent.length });
ok(/молчу/i.test((sent[15] || {}).text || '') && /с сайта/.test((sent[15] || {}).text || ''),
  'последнее сообщение честно говорит, что молчит именно про сайт', (sent[15] || {}).text);

/* 6. И после потолка — тишина, хотя сервер ошибки принимает */
const r6 = await report(BASE, [{ message: 'Ошибка после потолка', where: 'late.js:1' }]);
await sleep(500);
ok(r6.body.taken === 1 && sent.length === 16, 'после потолка база пишется, чат молчит', { sent: sent.length });

/* 7. Тело «null» — валидный JSON, но не объект: раньше это давало
   ложный 500 и тревогу; теперь тихо приводится к пустому телу */
const rNull = await fetch(BASE + '/api/errors', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'null',
});
const rNullBody = await rNull.json();
await sleep(400);
ok(rNull.status === 200 && rNullBody.taken === 0, 'тело null не роняет маршрут ошибок', rNullBody);
const rNullReg = await fetch(BASE + '/api/register', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'null',
});
ok(rNullReg.status === 400, 'тело null на регистрации — честный 400, а не 500', { status: rNullReg.status });
await sleep(400);
ok(sent.length === 16, 'ложных тревог о 500 из-за null не появилось', { sent: sent.length });

srv.kill();

/* 8. Без ADMIN_CHAT_ID тревога выключена: в чат не уходит ничего */
const BASE2 = 'http://127.0.0.1:8099';
const srv2 = boot(8099, { ADMIN_CHAT_ID: '' });
ok(await waitUp(BASE2), 'сервер без ADMIN_CHAT_ID поднялся');
const before7 = sent.length;
const r7 = await report(BASE2, [{ message: 'Ошибка при выключенной тревоге', where: 'off.js:1' }]);
await sleep(600);
ok(r7.body.taken === 1 && sent.length === before7, 'без ADMIN_CHAT_ID ошибка пишется в базу, но в Телеграм не идёт',
  { sent: sent.length - before7 });
srv2.kill();

stub.close();
console.log('\nИтог: ' + passed + ' прошло, ' + failed + ' упало');
process.exit(failed ? 1 : 0);
