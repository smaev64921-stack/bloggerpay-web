/* ══════════════════════════════════════════════════════════════════════
   Проверка восстановления пароля по коду из письма.

   Запуск (сервер поднимается сам, на своём порту и своей базе):
       node server/test-mail.mjs

   Письма НЕ отправляются: тест поднимает сервер с MAIL_DEBUG=1 и пустым
   RESEND_API_KEY — код приходит в ответе, почта не трогается. Проверяется
   логика: выдача кода, срок, лимиты, неверный код, смена пароля, вход по
   новому паролю и то, что старые сессии сброшены.
   ══════════════════════════════════════════════════════════════════════ */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8097;
const BASE = 'http://127.0.0.1:' + PORT;
const DB = path.join(DIR, 'data', 'test-mail.db');

for (const f of [DB, DB + '-wal', DB + '-shm']) { try { fs.unlinkSync(f); } catch {} }

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '\n      ' + extra : '')); }
}

async function api(pathname, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const r = await fetch(BASE + pathname, {
    method: body ? 'POST' : 'GET',
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

const srv = spawn(process.execPath, [path.join(DIR, 'server.js')], {
  env: {
    ...process.env,
    PORT: String(PORT),
    DB_PATH: DB,
    MAIL_DEBUG: '1',
    RESEND_API_KEY: '',      /* почта намеренно не настроена — писем не будет */
    BOT_TOKEN: '',
    ADMIN_CHAT_ID: '',
    TEST_TOPUP: '0',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
srv.stdout.on('data', () => {});
srv.stderr.on('data', (d) => process.stderr.write('[сервер] ' + d));

async function waitUp() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) return true; } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

try {
  if (!(await waitUp())) throw new Error('сервер не поднялся');
  console.log('\nВосстановление пароля\n');

  const email = 'vasya' + Date.now() + '@example.com';
  const reg = await api('/api/register', { email, name: 'Вася', role: 'blogger', password: 'staryi-parol-1' });
  ok('регистрация прошла', reg.status === 200 && reg.body.token);
  const oldToken = reg.body.token;

  /* ── Несуществующий адрес не выдаёт себя ── */
  const ghost = await api('/api/password/forgot', { email: 'nikogo' + Date.now() + '@example.com' });
  ok('на чужой адрес ответ такой же (200, без кода)', ghost.status === 200 && !ghost.body.devCode,
    JSON.stringify(ghost.body));

  /* ── Код приходит ── */
  const f1 = await api('/api/password/forgot', { email });
  ok('код выдан', f1.status === 200 && /^\d{6}$/.test(String(f1.body.devCode || '')),
    JSON.stringify(f1.body));
  const code = f1.body.devCode;

  /* ── Повтор раньше минуты не выдаёт новый код ── */
  const f2 = await api('/api/password/forgot', { email });
  ok('повторный запрос в течение минуты не шлёт второй код', f2.status === 200 && !f2.body.devCode);

  /* ── Проверка кода, не тратя его ── */
  const vBad = await api('/api/password/verify', { email, code: '000000' });
  ok('неверный код отклонён', vBad.status === 400, JSON.stringify(vBad.body));
  const vOk = await api('/api/password/verify', { email, code });
  ok('верный код принят и не потрачен', vOk.status === 200 && vOk.body.ok);

  /* ── Короткий пароль ── */
  const short = await api('/api/password/reset', { email, code, password: '123' });
  ok('короткий пароль отклонён', short.status === 400);

  /* ── Смена пароля ── */
  const res = await api('/api/password/reset', { email, code, password: 'novyi-parol-2' });
  ok('пароль изменён и выдана сессия', res.status === 200 && res.body.token, JSON.stringify(res.body));

  /* ── Код одноразовый ── */
  const again = await api('/api/password/reset', { email, code, password: 'esche-odin-3' });
  ok('тот же код второй раз не работает', again.status === 400, JSON.stringify(again.body));

  /* ── Старые входы сброшены ── */
  const meOld = await api('/api/me', null, oldToken);
  ok('старая сессия больше не действует', meOld.status === 401, 'статус ' + meOld.status);
  const meNew = await api('/api/me', null, res.body.token);
  ok('новая сессия работает', meNew.status === 200);

  /* ── Вход по новому и старому паролю ── */
  const loginNew = await api('/api/login', { email, password: 'novyi-parol-2' });
  ok('вход по новому паролю', loginNew.status === 200 && loginNew.body.token);
  const loginOld = await api('/api/login', { email, password: 'staryi-parol-1' });
  ok('старый пароль больше не подходит', loginOld.status === 401);

  /* ── Пять попыток гасят код ── */
  const email2 = 'petya' + Date.now() + '@example.com';
  await api('/api/register', { email: email2, name: 'Петя', role: 'blogger', password: 'parol-petya-1' });
  const f3 = await api('/api/password/forgot', { email: email2 });
  const code2 = f3.body.devCode;
  for (let i = 0; i < 5; i++) await api('/api/password/verify', { email: email2, code: '111111' });
  const locked = await api('/api/password/verify', { email: email2, code: code2 });
  ok('после пяти неверных попыток код гаснет', locked.status === 400 && locked.body.reason === 'locked',
    JSON.stringify(locked.body));

  /* ── Погашенный код не запирает человека навсегда ──
     Чужой мог сжечь попытки, зная только адрес. Новый код обязан
     работать — иначе это способ отнять доступ у любого. */
  const em3 = 'masha' + Date.now() + '@example.com';
  await api('/api/register', { email: em3, name: 'Маша', role: 'blogger', password: 'parol-mashi-1' });
  await api('/api/password/forgot', { email: em3 });
  for (let i = 0; i < 6; i++) await api('/api/password/verify', { email: em3, code: '222222' });
  const lockedNow = await api('/api/password/verify', { email: em3, code: '333333' });
  ok('код заперт после перебора', lockedNow.body.reason === 'locked');
  /* ждём минуту кулдауна и просим новый код */
  await new Promise((r) => setTimeout(r, 61000));
  const fresh = await api('/api/password/forgot', { email: em3 });
  ok('новый код выдаётся после перебора (нельзя запереть навсегда)',
    /^\d{6}$/.test(String(fresh.body.devCode || '')), JSON.stringify(fresh.body));
  const useFresh = await api('/api/password/verify', { email: em3, code: fresh.body.devCode });
  ok('новый код сразу работает', useFresh.status === 200, JSON.stringify(useFresh.body));

  /* ── Часовой потолок переживает успешную смену пароля ──
     Раньше код удалялся вместе со счётчиками, и потолок обнулялся. */
  const em4 = 'kolya' + Date.now() + '@example.com';
  await api('/api/register', { email: em4, name: 'Коля', role: 'blogger', password: 'parol-koli-1' });
  const c1 = await api('/api/password/forgot', { email: em4 });
  const r1 = await api('/api/password/reset', { email: em4, code: c1.body.devCode, password: 'novyi-koli-22' });
  ok('пароль сменён', r1.status === 200);
  const immediately = await api('/api/password/forgot', { email: em4 });
  ok('сразу после смены новый код не выдаётся (минута ожидания цела)',
    !immediately.body.devCode, JSON.stringify(immediately.body));

  /* ── Ответ не выдаёт, есть ли аккаунт ── */
  const known = await api('/api/password/forgot', { email: 'proba-net' + Date.now() + '@example.com' });
  ok('неизвестный адрес получает ровно {ok:true}',
    known.status === 200 && JSON.stringify(known.body) === '{"ok":true}', JSON.stringify(known.body));

  /* ── Вид письма: логотип, кнопка возврата, копируемый код ──
     Проверяем сам шаблон, без отправки. Логотип и кнопка появляются
     только когда задан APP_URL — иначе вести некуда. */
  const mailMod = await import('./mail.js');
  const { renderCodeEmail } = mailMod.default || mailMod;

  process.env.APP_URL = 'https://app.example.com';
  const withApp = renderCodeEmail({ code: '013579', kind: 'reset', minutes: 10, to: 'petya@example.com' });

  ok('в письме есть логотип отдельным файлом (не data:base64 — Gmail его вырезает)',
    /<img[^>]+src="https:\/\/app\.example\.com\/logo\.jpg"/.test(withApp.html));
  ok('логотип помечен украшением: рядом уже стоит слово BloggerPay текстом, '
    + 'и при отказе картинки остаётся чистый квадрат, а не битый значок',
    /<img[^>]+alt=""[^>]*role="presentation"/.test(withApp.html));
  ok('есть кнопка «Вернуться на сайт»', /Вернуться на сайт/.test(withApp.html));
  ok('кнопка ведёт на шаг ввода кода с самим кодом',
    /href="https:\/\/app\.example\.com#\/recover\?code=013579/.test(withApp.html),
    (withApp.html.match(/href="[^"]*recover[^"]*"/) || [])[0]);
  ok('адрес получателя уходит в ссылку — приложению надо знать, чей код',
    /email=petya%40example\.com/.test(withApp.html));
  ok('код есть отдельной строкой, которую можно выделить и скопировать',
    /user-select:all;">013579</.test(withApp.html));
  ok('ссылка на возврат продублирована в текстовой версии письма',
    withApp.text.includes('https://app.example.com#/recover?code=013579'));

  /* Без APP_URL вести некуда: кнопки быть не должно, но письмо с кодом
     обязано остаться рабочим — иначе восстановление сломается совсем. */
  delete process.env.APP_URL;
  const noApp = renderCodeEmail({ code: '024680', kind: 'reset', minutes: 10, to: 'petya@example.com' });
  ok('без APP_URL кнопки возврата нет', !/Вернуться на сайт/.test(noApp.html));
  ok('без APP_URL вместо картинки — фирменный квадрат с буквой, а не битая ссылка',
    !/<img/.test(noApp.html) && />Б</.test(noApp.html));
  ok('без APP_URL код в письме всё равно есть', /024680/.test(noApp.html));

  /* ── Письмо-ссылка: кода внутри нет ──
     Главная мысль всей затеи: код не должен светиться ни в теле письма,
     ни в теме, ни в предпросмотре — иначе он виден в уведомлении на
     заблокированном экране. */
  const LINK = 'https://kassa.example.com/r/' + 'a'.repeat(32);
  process.env.APP_URL = 'https://app.example.com';
  const lm = renderCodeEmail({ code: '987654', kind: 'reset', minutes: 10, to: 'petya@example.com', linkUrl: LINK });

  ok('в письме-ссылке кода НЕТ в теле', !/987654/.test(lm.html));
  ok('в письме-ссылке кода НЕТ в теме', !/987654/.test(lm.subject));
  ok('в письме-ссылке кода НЕТ в текстовой версии', !/987654/.test(lm.text));
  ok('есть кнопка «Открыть»', />Открыть<\/a>/.test(lm.html));
  ok('кнопка ведёт на страницу показа кода', lm.html.includes('href="' + LINK + '"'));
  ok('адрес продублирован строкой — часть клиентов режет кнопки',
    (lm.html.match(new RegExp(LINK.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length >= 2);
  ok('в текстовой версии ссылка есть', lm.text.includes(LINK));
  ok('в письме-ссылке нет кнопки «Вернуться на сайт» — возвращает страница, а не письмо',
    !/Вернуться на сайт/.test(lm.html));

  /* ── Сторож адреса сервера ──
     Письмо-ссылка имеет смысл, только если сервер виден из интернета.
     Проверять одну схему мало: значение по умолчанию http://127.0.0.1
     схему имеет — и человек получил бы письмо БЕЗ кода и с кнопкой на
     собственный localhost, то есть без единого способа войти. */
  const { reachableOutside } = mailMod.default || mailMod;
  const off = ['http://127.0.0.1:8090', 'http://localhost:3000', 'http://192.168.1.5',
    'http://10.0.0.4', 'http://172.16.0.9', 'http://kassa.local', 'http://169.254.1.1', 'не-адрес'];
  const on = ['https://kassa.example.com', 'https://bloggerpay.ru', 'http://203.0.113.7'];
  ok('локальные и частные адреса не считаются видимыми снаружи',
    off.every((u) => reachableOutside(u) === false),
    off.filter((u) => reachableOutside(u) !== false).join(', '));
  ok('настоящий домен считается видимым снаружи',
    on.every((u) => reachableOutside(u) === true),
    on.filter((u) => reachableOutside(u) !== true).join(', '));

  /* Ссылка без схемы игнорируется — иначе кнопка вела бы в никуда. */
  const badLink = renderCodeEmail({ code: '555666', kind: 'reset', minutes: 10, to: 'p@e.co', linkUrl: 'kassa.example.com/r/abc' });
  ok('битая ссылка не принимается — письмо возвращается к виду с кодом',
    /555666/.test(badLink.html) && !/>Открыть<\/a>/.test(badLink.html));

  /* Ширина в Outlook. Он рисует движком Word, который max-width не знает:
     без «призрачной» таблицы письмо растянулось бы на всю ширину окна. */
  process.env.APP_URL = 'https://app.example.com';
  const wide = renderCodeEmail({ code: '111222', kind: 'reset', minutes: 10, to: 'a@b.co' });
  ok('для Outlook стоит призрачная таблица с жёсткой шириной 480',
    /<!--\[if mso\]><table[^>]+width="480"/.test(wide.html));
  ok('призрачная таблица закрыта — иначе Outlook съест остаток письма',
    /<!--\[if mso\]><\/td><\/tr><\/table><!\[endif\]-->/.test(wide.html));

  /* Адрес без https:// — относительная ссылка: почта раскроет её от
     своего домена. Лучше письмо без кнопки, чем кнопка в никуда. */
  process.env.APP_URL = 'app.example.com';
  const bare = renderCodeEmail({ code: '333444', kind: 'reset', minutes: 10, to: 'a@b.co' });
  ok('APP_URL без https:// не превращается в битую кнопку',
    !/Вернуться на сайт/.test(bare.html) && !/<img/.test(bare.html));
  ok('APP_URL без https:// — код в письме всё равно на месте',
    /333444/.test(bare.html));
  delete process.env.APP_URL;

  console.log('\n' + (fail ? '✗ ' : '✓ ') + pass + ' из ' + (pass + fail) + ' проверок пройдено\n');
} catch (e) {
  fail++;
  console.error('\nСломалось: ' + ((e && e.stack) || e) + '\n');
} finally {
  srv.kill();
  setTimeout(() => process.exit(fail ? 1 : 0), 300);
}
