/* Бот: проверяем разговор целиком, не обращаясь к Телеграму.
   Поднимаем заглушку его API на localhost, запускаем bot.js через
   TG_API_BASE и смотрим, что бот шлёт в ответ на реальные сообщения.
   Запуск: node test-bot.mjs */

import { spawn } from 'node:child_process';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

let passed = 0, failed = 0;
function ok(c, name, extra) {
  if (c) { passed++; console.log('  ok  ' + name); }
  else { failed++; console.log('  FAIL ' + name + (extra ? '  ← ' + JSON.stringify(extra) : '')); }
}

const APP = 'https://пример.ru/app';
const sent = [];          /* что бот отправил */
const calls = [];         /* какие методы вызвал */
let queue = [];           /* что заглушка отдаст на getUpdates */
let updId = 100;

function pushUpdate(text) {
  queue.push({
    update_id: ++updId,
    message: { message_id: updId, chat: { id: 555, type: 'private' }, from: { id: 555 }, text },
  });
}

const stub = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const method = req.url.split('/').pop();
    let data = {};
    try { data = JSON.parse(body || '{}'); } catch (e) {}
    calls.push(method);
    let result = true;
    if (method === 'getMe') result = { id: 1, username: 'test_bot', first_name: 'Тест' };
    else if (method === 'getUpdates') { result = queue; queue = []; }
    else if (method === 'sendMessage') { sent.push(data); result = { message_id: 1 }; }
    else if (method === 'setChatMenuButton' || method === 'setMyCommands') { sent.push({ _cfg: method, ...data }); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, result }));
  });
});
await new Promise((r) => stub.listen(8123, '127.0.0.1', r));

console.log('\nТелеграм-бот: разговор и кнопка');

const bot = spawn(process.execPath, ['bot.js'], {
  cwd: fileURLToPath(new URL('.', import.meta.url)),
  env: {
    ...process.env,
    BOT_TOKEN: '111:TESTTOKEN',
    APP_URL: APP,
    TG_API_BASE: 'http://127.0.0.1:8123',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let out = '';
bot.stdout.on('data', (c) => { out += c; });
bot.stderr.on('data', (c) => { out += c; });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await wait(1200);

ok(/подключился: @test_bot/.test(out), 'бот представился именем из Телеграма', out.slice(0, 120));

/* кнопка меню рядом с полем ввода */
const menu = sent.find((s) => s._cfg === 'setChatMenuButton');
ok(!!menu && menu.menu_button && menu.menu_button.type === 'web_app',
   'поставлена постоянная кнопка меню «Открыть»', menu && menu.menu_button);
ok(!!menu && menu.menu_button.web_app.url === APP, 'кнопка меню ведёт на приложение');
const cmds = sent.find((s) => s._cfg === 'setMyCommands');
ok(!!cmds && cmds.commands.some((c) => c.command === 'start'), 'команда /start зарегистрирована');

/* обычный /start */
pushUpdate('/start');
await wait(1500);
const first = sent.filter((s) => s.text)[0];
ok(!!first, 'на /start бот ответил сообщением');
const kb = first && first.reply_markup && first.reply_markup.inline_keyboard;
ok(!!kb && kb[0] && kb[0][0].web_app, 'в ответе — кнопка открытия приложения (web_app)', kb && kb[0]);
ok(!!kb && /Открыть/.test(kb[0][0].text), 'на кнопке написано «Открыть…»', kb && kb[0][0].text);
ok(!!kb && kb[0][0].web_app.url === APP, 'кнопка ведёт ровно на APP_URL', kb && kb[0][0].web_app.url);
ok(/BloggerPay/.test(first.text) && first.parse_mode === 'HTML', 'приветствие с разметкой');

/* /start с приглашением — метка должна доехать до приложения */
pushUpdate('/start r_12345');
await wait(1500);
const ref = sent.filter((s) => s.text).pop();
const refUrl = ref && ref.reply_markup.inline_keyboard[0][0].web_app.url;
ok(refUrl === APP + '?startapp=r_12345', 'приглашение передаётся приложению через адрес', refUrl);

/* произвольное сообщение — бот не молчит */
pushUpdate('привет');
await wait(1500);
const any = sent.filter((s) => s.text).pop();
ok(!!any && /Чаты/.test(any.text), 'на обычное сообщение бот отвечает и даёт кнопку');
ok(!!any.reply_markup, 'кнопка есть и там');

/* «уже опрашивают» и плохой токен — понятные сообщения */
bot.kill();
await wait(300);

const bad = spawn(process.execPath, ['bot.js'], {
  cwd: fileURLToPath(new URL('.', import.meta.url)),
  env: { ...process.env, BOT_TOKEN: '111:X', APP_URL: 'http://небезопасно.ru', TG_API_BASE: 'http://127.0.0.1:8123' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let badOut = '';
bad.stdout.on('data', (c) => { badOut += c; });
bad.stderr.on('data', (c) => { badOut += c; });
await wait(900);
ok(/APP_URL/.test(badOut) && /HTTPS/i.test(badOut), 'без https бот честно отказывается стартовать', badOut.slice(0, 100));
bad.kill();

stub.close();
console.log(`\nИтого: ${passed} ok, ${failed} fail\n`);
process.exit(failed ? 1 : 0);
