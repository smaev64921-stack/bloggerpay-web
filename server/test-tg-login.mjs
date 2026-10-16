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

const PORT = Number(process.env.TGLOGIN_PORT || 8096);
const BASE = 'http://127.0.0.1:' + PORT;
const BOT_ID = '123456789';
const BOT_TOKEN = BOT_ID + ':AAtest-token-not-real';
let passed = 0, failed = 0;
function ok(c, name, extra) {
  if (c) { passed++; console.log('  ok  ' + name); }
  else { failed++; console.log('  FAIL ' + name + (extra ? '  ← ' + JSON.stringify(extra).slice(0, 240) : '')); }
}
async function api(method, p, body, token) {
  const h = { 'Content-Type': 'application/json' };
  if (token) h.Authorization = 'Bearer ' + token;
  const r = await fetch(BASE + p, {
    method,
    headers: h,
    body: body ? JSON.stringify(body) : undefined,
  });
  const txt = await r.text();
  let j = {}; try { j = JSON.parse(txt); } catch (e) { j = { _raw: txt.slice(0, 200) }; }
  return { status: r.status, body: j, text: txt, headers: r.headers };
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
/* 16.10 (аудит): start отдаёт ещё секрет pk и куку «этого браузера».
   Вход отдаётся только с pk и — без кода — только при возврате с кукой. */
async function startTg(p, token) {
  const r = await api('GET', p || '/api/auth/telegram/start', null, token);
  const sc = r.headers.get('set-cookie') || '';
  return Object.assign(r, { cookie: sc.split(';')[0] });
}
function back(st, f, init) {
  return fetch(BASE + '/api/auth/telegram/callback?' + asQuery(st.body.nonce, f),
    Object.assign({ headers: { Cookie: st.cookie } }, init || {}));
}
const pending = (st) => api('POST', '/api/auth/telegram/pending', { nonce: st.body.nonce, pk: st.body.pk });

const CWD = fileURLToPath(new URL('.', import.meta.url));
function start(port, env) {
  return spawn(process.execPath, ['server.js'], {
    cwd: CWD,
    env: {
      ...process.env, PORT: String(port), ADMIN_KEY: 'test-key',
      YOOKASSA_SHOP_ID: '', YOOKASSA_SECRET_KEY: '', ADMIN_CHAT_ID: '',
      YT_CLIENT_ID: '', YT_CLIENT_SECRET: '',
      /* почта выключена явно: иначе server/.env включил бы настоящую, и
         «Почта и пароль» слала бы письма наружу (аудит 16.10.2026) */
      RESEND_API_KEY: '', MAIL_DEBUG: '', RELAY_URL: '',
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
  const st = await startTg();
  ok(st.status === 200 && typeof st.body.url === 'string', 'ссылка входа выдана', st.body);
  ok(/^[0-9a-f]{48}$/.test(st.body.pk || '') && st.body.url.indexOf(st.body.pk) < 0,
    'секрет выдачи pk отдан приложению и в ссылку не попал');
  ok(/HttpOnly/i.test(st.headers.get('set-cookie') || ''), 'кука «этого браузера» поставлена');
  const u = new URL(st.body.url);
  ok(u.origin + u.pathname === 'https://oauth.telegram.org/auth', 'ведёт на Телеграм', u.href.slice(0, 60));
  ok(u.searchParams.get('bot_id') === BOT_ID, 'номер бота взят из токена', u.searchParams.get('bot_id'));
  ok(u.searchParams.get('origin') === BASE, 'origin — наш адрес (он же прописан в BotFather)');
  ok(u.searchParams.get('return_to') === BASE + '/api/auth/telegram/callback?n=' + st.body.nonce,
    'адрес возврата наш и с меткой', u.searchParams.get('return_to'));
  ok(u.searchParams.get('embed') === '0', 'полностраничный вход, не рамка');

  /* ── пока человек не вошёл ── */
  const pend = await pending(st);
  ok(pend.status === 200 && pend.body.state === 'waiting', 'до входа — «ждём»', pend.body);
  const bad = await api('POST', '/api/auth/telegram/pending', { nonce: 'f'.repeat(48), pk: st.body.pk });
  ok(bad.status === 404, 'чужая метка не отвечает', bad.body);
  const noPk = await api('GET', '/api/auth/telegram/pending?nonce=' + st.body.nonce);
  ok(noPk.status === 404, 'метка без секрета pk не отвечает', noPk.body);

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
  const old15 = tgReply({ auth_date: String(Math.floor(Date.now() / 1000) - 15 * 60) });
  const old15Res = await fetch(BASE + '/api/auth/telegram/callback?' + asQuery(st.body.nonce, old15));
  ok(/просрочен/i.test(await old15Res.text()), 'ответ 15-минутной давности тоже (срок — 10 минут)');

  /* ── настоящий вход (возврат в тот же браузер — с его кукой) ── */
  const good = tgReply();
  const okRes = await back(st, good, { redirect: 'manual' });
  const okTxt = await okRes.text();
  /* Возврат приходит в ОКНО, которое открыла кнопка входа, а не в ту
     вкладку, где человек ждёт. Раньше сервер отвечал ему переходом на
     приложение — окно поднимало все пять мегабайт и первым забирало
     вход себе, а ждущая вкладка две минуты крутила точки. Теперь оно
     получает страничку, которая только будит ждущего и закрывается. */
  ok(okRes.status === 200 && /Готово|Возвращаемся/.test(okTxt),
    'верная подпись отдаёт страницу возврата, а не переход в приложение',
    { status: okRes.status, len: okTxt.length });
  ok(okTxt.length < 4000, 'страница возврата крошечная', okTxt.length);
  ok(/postMessage/.test(okTxt) && /bpAuthReady/.test(okTxt) && /BroadcastChannel/.test(okTxt),
    'она будит ждущую вкладку тремя способами');
  ok(/bpAuthWaiting/.test(okTxt),
    'и сама смотрит, ждёт ли её живая вкладка, — иначе уходит в приложение');
  ok(!/api\/auth\/telegram\/pending/.test(okTxt),
    'сама вход не забирает — метка остаётся тому, кто ждёт');
  ok(okTxt.indexOf('tglogin=' + st.body.nonce) > 0,
    'если ждать некому — уходит в приложение, как раньше');

  const got = await pending(st);
  ok(got.status === 200 && got.body.state === 'ok' && got.body.token, 'сессия отдана приложению', got.body);
  ok(got.body.user && got.body.user.name === 'Иван', 'имя из Телеграма', got.body.user);

  const me = await fetch(BASE + '/api/me', { headers: { Authorization: 'Bearer ' + got.body.token } });
  const meJ = await me.json();
  ok(me.status === 200 && meJ.user && /telegram\.local$/.test(meJ.user.email),
    'сессия рабочая, аккаунт заведён по Телеграму', meJ.user);

  /* Метка живёт ещё минуту после первой выдачи. Пока она сгорала сразу,
     вход был гонкой двух окон: проигравшему сервер отвечал «не найден»,
     и человек смотрел на «Заканчиваем вход» до победного конца. */
  const twice = await pending(st);
  ok(twice.status === 200 && twice.body.token === got.body.token,
    'ту же метку можно забрать второй раз — гонки окон больше нет', twice.status);

  /* ── второй вход тем же человеком — тот же аккаунт, а не второй ──
     Ответ Телеграма каждый раз новый (свой auth_date): прежний второй раз
     не принимается — см. test-login-hijack.mjs. */
  const st2 = await startTg();
  await back(st2, tgReply({ auth_date: String(Math.floor(Date.now() / 1000) - 2) }));
  const got2 = await pending(st2);
  ok(got2.body.user && got2.body.user.id === got.body.user.id,
    'повторный вход даёт тот же аккаунт', { first: got.body.user, second: got2.body.user });

  /* ── код возврата для другого браузера ── */
  const st3 = await startTg();
  const blind = await api('POST', '/api/auth/telegram/claim', { code: '000000' });
  ok(blind.status === 404, 'код без метки не ищется по чужим входам', blind.body);
  const noPkClaim = await api('POST', '/api/auth/telegram/claim', { nonce: st3.body.nonce, code: '000001' });
  ok(noPkClaim.status === 404, 'код без секрета pk не сверяется вовсе', noPkClaim.body);
  let last = null;
  for (let i = 0; i < 5; i++) {
    last = await api('POST', '/api/auth/telegram/claim', { nonce: st3.body.nonce, pk: st3.body.pk, code: '000001' });
  }
  ok(last.status === 400 && last.body.left === 0, 'ошибки считаются, попытки кончаются', last.body);
  const burnt = await api('POST', '/api/auth/telegram/claim', { nonce: st3.body.nonce, pk: st3.body.pk, code: '000001' });
  ok(burnt.status === 429, 'после пяти ошибок метка сгорает', burnt.body);

  /* ── СКЛЕЙКА АККАУНТОВ ──
     Самая дорогая ошибка входа: человек пришёл из бота, потом сел за
     компьютер, зарегистрировался почтой — и получил ВТОРОЙ кошелёк.
     Лечится двумя дорогами: телеграм-аккаунту задают почту с паролем,
     почтовому — привязывают Телеграм. */
  const reg = await api('POST', '/api/register', {
    email: 'sklejka@t.ru', name: 'Почтовый', role: 'blogger', password: 'пароль-подлиннее',
  });
  const tokA = reg.body.token;
  ok(reg.status === 200 && !!tokA, 'почтовый аккаунт заведён', reg.body);

  const m0 = await api('GET', '/api/account/methods', null, tokA);
  ok(m0.status === 200 && m0.body.email === 'sklejka@t.ru' && m0.body.needsEmail === false
    && m0.body.telegram === false, 'способы входа: только почта', m0.body);
  const mNo = await api('GET', '/api/account/methods');
  ok(mNo.status === 401, 'чужие способы входа не показываем');

  const linkNoAuth = await api('GET', '/api/auth/telegram/start?link=1');
  ok(linkNoAuth.status === 401, 'привязка без входа отбита', linkNoAuth.body);

  const linkSt = await startTg('/api/auth/telegram/start?link=1', tokA);
  ok(linkSt.status === 200 && !!linkSt.body.nonce, 'привязка началась', linkSt.body);
  const tgNew = tgReply({ id: '424242', first_name: 'Привязка' });
  const linkRes = await back(linkSt, tgNew);
  const linkTxt = await linkRes.text();
  ok(linkRes.status === 200 && /Готово|Возвращаемся/.test(linkTxt),
    'привязка завершилась страницей возврата', linkRes.status);
  const m05 = await api('GET', '/api/account/methods', null, tokA);
  ok(m05.body.telegram === false, 'сам возврат ничего не привязывает (16.10)', m05.body);
  const linkPend = await pending(linkSt);
  ok(linkPend.status === 200 && linkPend.body.link === true && !linkPend.body.token,
    'привязка не выдаёт сессию — просит подтверждения из приложения', linkPend.body);
  const linkOk = await api('POST', '/api/auth/telegram/link-confirm',
    { nonce: linkSt.body.nonce, pk: linkSt.body.pk }, tokA);
  ok(linkOk.status === 200 && linkOk.body.linked === true, 'привязку подтвердил тот же аккаунт', linkOk.body);
  const m1 = await api('GET', '/api/account/methods', null, tokA);
  ok(m1.body.telegram === true, 'Телеграм привязан к почтовому аккаунту', m1.body);

  /* Тот же Телеграм ко ВТОРОМУ аккаунту — отказ: два кошелька молча не
     смешиваем. */
  const reg2 = await api('POST', '/api/register', {
    email: 'vtoroy@t.ru', name: 'Второй', role: 'blogger', password: 'пароль-подлиннее',
  });
  const st2b = await startTg('/api/auth/telegram/start?link=1', reg2.body.token);
  const busy = await back(st2b, tgReply({ id: '424242', first_name: 'Привязка', auth_date: String(Math.floor(Date.now() / 1000) - 1) }));
  const busyTxt = await busy.text();
  ok(/уже занят|другому аккаунту/i.test(busyTxt), 'занятый Телеграм ко второму аккаунту не привязывается');
  const m2 = await api('GET', '/api/account/methods', null, reg2.body.token);
  ok(m2.body.telegram === false, 'у второго аккаунта Телеграма так и нет', m2.body);

  /* Обратная дорога: телеграм-аккаунт задаёт почту и пароль. */
  const stTg = await startTg();
  await back(stTg, tgReply({ id: '909090', first_name: 'Ботовый' }));
  const gotTg = await pending(stTg);
  const tokB = gotTg.body.token;
  ok(!!tokB, 'телеграм-аккаунт вошёл');
  const mB = await api('GET', '/api/account/methods', null, tokB);
  ok(mB.body.needsEmail === true && mB.body.email === '' && mB.body.telegram === true,
    'у телеграм-аккаунта почты нет', mB.body);

  const badMail = await api('POST', '/api/account/email', { email: 'не-почта', password: 'пароль-подлиннее' }, tokB);
  ok(badMail.status === 400, 'кривую почту не принимаем', badMail.body);
  const shortPass = await api('POST', '/api/account/email', { email: 'bot@t.ru', password: '123' }, tokB);
  ok(shortPass.status === 400, 'короткий пароль не принимаем', shortPass.body);
  const takenMail = await api('POST', '/api/account/email', { email: 'sklejka@t.ru', password: 'пароль-подлиннее' }, tokB);
  ok(takenMail.status === 409, 'занятую почту не отдаём', takenMail.body);
  const fake = await api('POST', '/api/account/email', { email: 'tg1@telegram.local', password: 'пароль-подлиннее' }, tokB);
  ok(fake.status === 400, 'служебный домен не принимаем', fake.body);

  /* Аудит 16.10.2026: почта привязывается только кодом, ушедшим на неё
     (полный путь с кодом — test-account.mjs). Здесь почта на сервере не
     настроена — подтвердить адрес нечем, и сервер честно отказывает, а не
     привязывает чужой адрес без проверки. */
  const setMail = await api('POST', '/api/account/email', { email: 'bot@t.ru', password: 'пароль-подлиннее' }, tokB);
  ok(setMail.status === 503 && setMail.body.code === 'mail_off' && /почта на сервере/i.test(setMail.body.error || ''),
    'почта на сервере не настроена — честный отказ, а не привязка без проверки', setMail.body);
  const mB2 = await api('GET', '/api/account/methods', null, tokB);
  ok(mB2.body.needsEmail === true && mB2.body.email === '', 'почта так и не задана', mB2.body);
  const logIn = await api('POST', '/api/login', { email: 'bot@t.ru', password: 'пароль-подлиннее' });
  ok(logIn.status === 401, 'по непривязанной почте не войти', logIn.body);
  const withCode = await api('POST', '/api/account/email', { email: 'bot@t.ru', code: '123456' }, tokB);
  ok(withCode.status === 503 || withCode.status === 400, 'и с выдуманным кодом почту не привязать', withCode.body);

  /* ── имя одно везде ──
     Профиль правил своё имя, а в таблице users оставалось прежнее — его
     и показывали рейтинг, тревоги владельцу и пульт оператора. */
  const nameNoAuth = await api('POST', '/api/account/name', { name: 'Кто-то' });
  ok(nameNoAuth.status === 401, 'чужое имя менять нельзя');
  const nameEmpty = await api('POST', '/api/account/name', { name: '   ' }, tokA);
  ok(nameEmpty.status === 400, 'пустое имя не принимаем', nameEmpty.body);
  const nameOk = await api('POST', '/api/account/name', { name: 'Новое Имя' }, tokA);
  ok(nameOk.status === 200 && nameOk.body.name === 'Новое Имя', 'имя поправлено', nameOk.body);
  const meName = await fetch(BASE + '/api/me', { headers: { Authorization: 'Bearer ' + tokA } }).then((r) => r.json());
  ok(meName.user && meName.user.name === 'Новое Имя', 'сервер отдаёт новое имя', meName.user);
  const nameLong = await api('POST', '/api/account/name', { name: 'я'.repeat(200) }, tokA);
  ok(nameLong.status === 200 && nameLong.body.name.length === 120, 'длинное имя обрезается', nameLong.body.name.length);

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
