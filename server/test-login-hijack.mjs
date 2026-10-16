/* Аудит 16.10: перехват входа через Google и Телеграм.
   Три атаки, которые раньше работали, и что теперь:
   1) «Сессию забирает тот, кто начал вход». Злоумышленник берёт start и
      присылает жертве настоящую ссылку Google/Телеграма. Жертва входит —
      и pending отдавал её сессию злоумышленнику по метке. Теперь вход
      отдаётся только с секретом pk И только если возврат пришёл в тот же
      браузер (кука bpal_<метка>); иначе — лишь по коду со страницы
      возврата, который видит только сам вошедший.
   2) Привязка ?link=1: чужой Телеграм прирастал к аккаунту злоумышленника
      прямо на возврате. Теперь привязка — только link-confirm от того же
      аккаунта с pk (и кодом, если возврат в другом браузере).
   3) Повтор подписанного ответа виджета Телеграма на своей метке (сутки,
      сколько угодно раз). Теперь — 10 минут, не старше начала входа, один
      раз.
   Google подделываем подменой fetch в процессе сервера (--import): к
   настоящему Google проверка не ходит.
   Запуск: node test-login-hijack.mjs   (порт — HIJACK_PORT, по умолчанию 8516) */

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const PORT = Number(process.env.HIJACK_PORT || 8516);
const BASE = 'http://127.0.0.1:' + PORT;
const BOT_TOKEN = '123456789:AAhijack-test-not-real';
let passed = 0, failed = 0;
function ok(c, name, extra) {
  if (c) { passed++; console.log('  ok  ' + name); }
  else { failed++; console.log('  FAIL ' + name + (extra !== undefined ? '  ← ' + JSON.stringify(extra).slice(0, 260) : '')); }
}
async function api(method, p, body, token) {
  const h = { 'Content-Type': 'application/json' };
  if (token) h.Authorization = 'Bearer ' + token;
  const r = await fetch(BASE + p, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const txt = await r.text();
  let j = {}; try { j = JSON.parse(txt); } catch (e) { j = { _raw: txt.slice(0, 200) }; }
  return { status: r.status, body: j, headers: r.headers };
}
/* Страница (возврат от площадки). cookie — «тот же браузер, что начинал». */
async function page(p, cookie, init) {
  const h = Object.assign({}, (init && init.headers) || {});
  if (cookie) h.Cookie = cookie;
  const r = await fetch(BASE + p, Object.assign({ redirect: 'manual' }, init || {}, { headers: h }));
  return { status: r.status, text: await r.text() };
}
/* start: метка, секрет и кука этого «браузера». */
async function begin(p, token) {
  const r = await api('GET', p, null, token);
  const sc = r.headers.get('set-cookie') || '';
  return { status: r.status, nonce: r.body.nonce, pk: r.body.pk, url: r.body.url || '', setCookie: sc,
    cookie: sc.split(';')[0] };
}
const codeOf = (html) => { const m = /<code>(\d{6})<\/code>/.exec(html); return m ? m[1] : ''; };
const isRelay = (html) => /bpAuthReady/.test(html) && /postMessage/.test(html);

/* Ответ виджета Телеграма: поля по алфавиту, ключ — SHA256(токен). */
function tgSign(f) {
  const line = Object.keys(f).sort().map((k) => k + '=' + f[k]).join('\n');
  return crypto.createHmac('sha256', crypto.createHash('sha256').update(BOT_TOKEN).digest()).update(line).digest('hex');
}
function tgReply(over) {
  const f = Object.assign({ id: '555001', first_name: 'Жертва', auth_date: String(Math.floor(Date.now() / 1000)) }, over || {});
  f.hash = tgSign(f);
  return f;
}
const tgQ = (n, f) => { const s = new URLSearchParams({ n }); for (const k of Object.keys(f)) s.set(k, f[k]); return s.toString(); };
/* initData мини-приложения */
function initData(user) {
  const f = { auth_date: String(Math.floor(Date.now() / 1000)), query_id: 'AAH' + Date.now(), user: JSON.stringify(user) };
  const line = Object.keys(f).sort().map((k) => k + '=' + f[k]).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  f.hash = crypto.createHmac('sha256', secret).update(line).digest('hex');
  return new URLSearchParams(f).toString();
}

const dir = mkdtempSync(path.join(tmpdir(), 'bp-hijack-'));
const DB = path.join(dir, 'db.sqlite');
/* Подмена Google: code=<кто> → access_token at-<кто> → userinfo <кто>@gmail.test */
const PRE = path.join(dir, 'fake-google.mjs');
writeFileSync(PRE, `
const real = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const u = String((input && input.url) || input);
  const J = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
  if (u.startsWith('https://oauth2.googleapis.com/token')) {
    const code = new URLSearchParams(String((init && init.body) || '')).get('code') || '';
    return J({ access_token: 'at-' + code });
  }
  if (u.startsWith('https://www.googleapis.com/oauth2/v3/userinfo')) {
    const h = (init && init.headers) || {};
    const who = String(h.Authorization || h.authorization || '').replace(/^Bearer at-/, '');
    return J({ sub: 'sub-' + who, email: who + '@gmail.test', email_verified: true, name: 'G ' + who });
  }
  return real(input, init);
};
`);
const srv = spawn(process.execPath, ['--import', pathToFileURL(PRE).href, 'server.js'], {
  cwd: fileURLToPath(new URL('.', import.meta.url)),
  env: { ...process.env, PORT: String(PORT), DB_PATH: DB, ADMIN_KEY: 'test-hijack-key', ADMIN_EMAIL: '',
    PUBLIC_URL: BASE, APP_URL: BASE + '/', BOT_TOKEN, ADMIN_CHAT_ID: '', TG_API_BASE: 'http://127.0.0.1:9',
    YT_CLIENT_ID: 'test-client-id', YT_CLIENT_SECRET: 'test-secret', YT_API_KEY: '',
    YOOKASSA_SHOP_ID: '', YOOKASSA_SECRET_KEY: '', RELAY_URL: '', RESEND_API_KEY: '' },
  stdio: 'ignore',
});
async function up() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) return true; } catch (e) {}
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}
function sessionsOf(email) {
  const db = new DatabaseSync(DB);
  try {
    const u = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (!u) return -1;
    return db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').get(u.id).n;
  } finally { db.close(); }
}

try {
  console.log('\nПерехват входа (аудит 16.10)');
  ok(await up(), 'сервер поднялся');

  /* ══ Телеграм: start ══ */
  const s0 = await begin('/api/auth/telegram/start');
  ok(s0.status === 200 && /^[0-9a-f]{48}$/.test(s0.nonce) && /^[0-9a-f]{48}$/.test(s0.pk || ''),
    'start выдаёт метку и отдельный секрет pk', { nonce: s0.nonce, pk: s0.pk });
  ok(s0.url && s0.url.indexOf(s0.pk) < 0, 'секрета pk нет в ссылке Телеграма');
  ok(s0.setCookie.indexOf('bpal_' + s0.nonce.slice(0, 16) + '=' + s0.pk) === 0
    && /HttpOnly/i.test(s0.setCookie) && /SameSite=Lax/i.test(s0.setCookie) && /Path=\/api\/auth\//.test(s0.setCookie),
    'кука браузера: HttpOnly, SameSite=Lax, путь /api/auth/', s0.setCookie);
  const p0 = await api('POST', '/api/auth/telegram/pending', { nonce: s0.nonce });
  ok(p0.status === 404, 'pending без секрета — «не найдено»', p0.body);
  const p0b = await api('POST', '/api/auth/telegram/pending', { nonce: s0.nonce, pk: 'ab'.repeat(24) });
  ok(p0b.status === 404, 'pending с чужим секретом — «не найдено»', p0b.body);
  const p0c = await api('POST', '/api/auth/telegram/pending', { nonce: s0.nonce, pk: s0.pk });
  ok(p0c.status === 200 && p0c.body.state === 'waiting', 'со своим секретом — «ждём»', p0c.body);

  /* ══ Атака 1 (Телеграм): злоумышленник начал, жертва подтвердила у себя ══ */
  const att = await begin('/api/auth/telegram/start');
  const victimFields = tgReply({ id: '555001', first_name: 'Жертва' });
  const cb = await page('/api/auth/telegram/callback?' + tgQ(att.nonce, victimFields), '' /* браузер жертвы: куки злоумышленника нет */);
  const vCode = codeOf(cb.text);
  ok(cb.status === 200 && /^\d{6}$/.test(vCode) && !isRelay(cb.text),
    'возврат в ЧУЖОЙ браузер: страница с кодом, а не «будильник» вкладки', { status: cb.status, code: vCode });
  ok(/Никому/.test(cb.text), 'на странице — «никому не сообщайте код»');
  ok(sessionsOf('tg555001@telegram.local') === 0, 'сессия жертвы на возврате НЕ заведена', sessionsOf('tg555001@telegram.local'));
  const steal = await api('POST', '/api/auth/telegram/pending', { nonce: att.nonce, pk: att.pk });
  ok(steal.status === 200 && steal.body.state === 'code' && !steal.body.token,
    'злоумышленник (с меткой и pk) сессию жертвы НЕ получает — только «нужен код»', steal.body);
  const stealGet = await api('GET', '/api/auth/telegram/pending?nonce=' + att.nonce);
  ok(stealGet.status === 404 && !stealGet.body.token, 'старый GET без pk тоже ничего не отдаёт', stealGet.body);
  const reopen = await page('/api/auth/telegram/callback?n=' + att.nonce, '');
  ok(/уже подтвержд/i.test(reopen.text) && !codeOf(reopen.text) && reopen.text.indexOf(vCode) < 0,
    'повторное открытие возврата по метке кода НЕ показывает', reopen.text.slice(0, 120));
  const guess = await api('POST', '/api/auth/telegram/claim', { nonce: att.nonce, pk: att.pk, code: vCode === '000000' ? '000001' : '000000' });
  ok(guess.status === 400 && !guess.body.token, 'наугад код не подходит', guess.body);
  const noPkClaim = await api('POST', '/api/auth/telegram/claim', { nonce: att.nonce, code: vCode });
  ok(noPkClaim.status === 404 && !noPkClaim.body.token, 'даже верный код без pk — «не найдено»', noPkClaim.body);
  ok(sessionsOf('tg555001@telegram.local') === 0, 'у жертвы так и нет ни одной сессии');

  /* Законный вход «в другом браузере»: тот, кто начал, вводит код со страницы. */
  const leg = await begin('/api/auth/telegram/start');
  const legCb = await page('/api/auth/telegram/callback?' + tgQ(leg.nonce, tgReply({ id: '555010', first_name: 'Свой' })), '');
  const legCode = codeOf(legCb.text);
  const legClaim = await api('POST', '/api/auth/telegram/claim', { nonce: leg.nonce, pk: leg.pk, code: legCode });
  ok(legClaim.status === 200 && !!legClaim.body.token && legClaim.body.user && /555010/.test(legClaim.body.user.email),
    'вход в другом браузере работает по коду + pk', legClaim.body);
  const legMe = await api('GET', '/api/me', null, legClaim.body.token);
  ok(legMe.status === 200 && legMe.body.user && /555010/.test(legMe.body.user.email), 'выданная сессия рабочая');

  /* Тот же браузер: возврат с кукой — приложение забирает вход само. */
  const same = await begin('/api/auth/telegram/start');
  const sameFields = tgReply({ id: '555020', first_name: 'Тот же' });
  const sameCb = await page('/api/auth/telegram/callback?' + tgQ(same.nonce, sameFields), same.cookie);
  ok(sameCb.status === 200 && isRelay(sameCb.text) && !codeOf(sameCb.text), 'тот же браузер: страница-будильник, без кода');
  const leak = await api('POST', '/api/auth/telegram/pending', { nonce: same.nonce });
  ok(leak.status === 404, 'утёкшая метка без pk сессию не отдаёт', leak.body);
  const mine = await api('POST', '/api/auth/telegram/pending', { nonce: same.nonce, pk: same.pk });
  ok(mine.status === 200 && mine.body.state === 'ok' && !!mine.body.token, 'со своим pk — сессия выдана', mine.body);

  /* ══ Атака 3: повтор подписанного ответа виджета ══ */
  const rep = await begin('/api/auth/telegram/start');
  const repCb = await page('/api/auth/telegram/callback?' + tgQ(rep.nonce, sameFields), rep.cookie);
  ok(/уже использован/i.test(repCb.text) && !isRelay(repCb.text), 'тот же ответ Телеграма второй раз не принимается', repCb.text.slice(0, 160));
  const repP = await api('POST', '/api/auth/telegram/pending', { nonce: rep.nonce, pk: rep.pk });
  ok(repP.body.state === 'waiting' && !repP.body.token, 'и сессии по повтору нет', repP.body);
  const old20 = tgReply({ id: '555030', auth_date: String(Math.floor(Date.now() / 1000) - 20 * 60) });
  const oldCb = await page('/api/auth/telegram/callback?' + tgQ(rep.nonce, old20), rep.cookie);
  ok(/просрочен/i.test(oldCb.text), 'ответ 20-минутной давности не принимается (было — сутки)');
  const before = tgReply({ id: '555031', auth_date: String(Math.floor(Date.now() / 1000) - 5 * 60) });
  const befCb = await page('/api/auth/telegram/callback?' + tgQ(rep.nonce, before), rep.cookie);
  ok(/просрочен/i.test(befCb.text), 'ответ, выданный раньше начала этого входа, не принимается');
  const fresh = tgReply({ id: '555032', first_name: 'Свежий' });
  const frCb = await page('/api/auth/telegram/callback?' + tgQ(rep.nonce, fresh), rep.cookie);
  ok(isRelay(frCb.text), 'свежий ответ на той же метке принимается');

  /* Перекладчик фрагмента шлёт поля ФОРМОЙ, а не в адрес. */
  const hp = await begin('/api/auth/telegram/start');
  const hpPage = await page('/api/auth/telegram/callback?n=' + hp.nonce, hp.cookie);
  ok(/f\.method="POST"/.test(hpPage.text) && !/location\.replace\(location\.pathname\+"\?"\+out/.test(hpPage.text)
    && /replaceState/.test(hpPage.text), 'страница-перекладчик отправляет поля формой и стирает их из истории');
  const form = new URLSearchParams(Object.assign({ n: hp.nonce }, tgReply({ id: '555040', first_name: 'Форма' }))).toString();
  const post = await page('/api/auth/telegram/callback', hp.cookie,
    { method: 'POST', body: form, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  ok(post.status === 200 && isRelay(post.text), 'возврат формой (POST) принимается', post.text.slice(0, 120));
  const postP = await api('POST', '/api/auth/telegram/pending', { nonce: hp.nonce, pk: hp.pk });
  ok(postP.body.state === 'ok' && postP.body.user && /555040/.test(postP.body.user.email), 'и вход по нему выдан', postP.body);

  /* ══ Атака 2: привязка ?link=1 чужого Телеграма ══ */
  const regA = await api('POST', '/api/register', { email: 'att-link@t.ru', name: 'Злоумышленник', role: 'blogger', password: 'пароль-подлиннее' });
  const tokA = regA.body.token;
  const la = await begin('/api/auth/telegram/start?link=1', tokA);
  ok(la.status === 200 && !!la.pk, 'привязка началась (метка + pk)');
  const laCb = await page('/api/auth/telegram/callback?' + tgQ(la.nonce, tgReply({ id: '555100', first_name: 'Жертва-2' })), '');
  const laCode = codeOf(laCb.text);
  ok(!!laCode && !isRelay(laCb.text), 'возврат привязки в чужой браузер — только код на странице');
  const mA = await api('GET', '/api/account/methods', null, tokA);
  ok(mA.body.telegram === false, 'на возврате НИЧЕГО не привязано', mA.body);
  const lp = await api('POST', '/api/auth/telegram/pending', { nonce: la.nonce, pk: la.pk });
  ok(lp.body.state === 'code' && !lp.body.token, 'опрос привязки: «нужен код»', lp.body);
  const lc1 = await api('POST', '/api/auth/telegram/link-confirm', { nonce: la.nonce, pk: la.pk }, tokA);
  ok(lc1.status === 400 && lc1.body.needCode === true, 'link-confirm без кода отбит', lc1.body);
  const lc2 = await api('POST', '/api/auth/telegram/link-confirm', { nonce: la.nonce, pk: la.pk, code: laCode === '111111' ? '222222' : '111111' }, tokA);
  ok(lc2.status === 400, 'link-confirm с неверным кодом отбит', lc2.body);
  const mA2 = await api('GET', '/api/account/methods', null, tokA);
  ok(mA2.body.telegram === false, 'Телеграм жертвы к аккаунту злоумышленника так и не привязан', mA2.body);
  const vIn = await api('POST', '/api/auth/telegram', { initData: initData({ id: 555100, first_name: 'Жертва-2' }) });
  ok(vIn.status === 200 && vIn.body.user && vIn.body.user.id !== regA.body.user.id && vIn.body.user.email !== 'att-link@t.ru',
    'жертва из бота входит в СВОЙ аккаунт, а не в кабинет злоумышленника', vIn.body.user);

  /* Законная привязка в том же браузере: только link-confirm того же аккаунта. */
  const regB = await api('POST', '/api/register', { email: 'own-link@t.ru', name: 'Свой', role: 'blogger', password: 'пароль-подлиннее' });
  const tokB = regB.body.token;
  const lb = await begin('/api/auth/telegram/start?link=1', tokB);
  const lbCb = await page('/api/auth/telegram/callback?' + tgQ(lb.nonce, tgReply({ id: '555200', first_name: 'Свой ТГ' })), lb.cookie);
  ok(isRelay(lbCb.text), 'привязка в том же браузере — страница-будильник');
  const mB0 = await api('GET', '/api/account/methods', null, tokB);
  ok(mB0.body.telegram === false, 'до подтверждения из приложения — не привязан', mB0.body);
  const lbp = await api('POST', '/api/auth/telegram/pending', { nonce: lb.nonce, pk: lb.pk });
  ok(lbp.body.state === 'ok' && lbp.body.link === true && !lbp.body.token, 'опрос: «готово, подтвердите привязку»', lbp.body);
  const lbX = await api('POST', '/api/auth/telegram/link-confirm', { nonce: lb.nonce, pk: lb.pk }, tokA);
  ok(lbX.status === 404, 'чужой аккаунт подтвердить привязку не может', lbX.body);
  const lbNoPk = await api('POST', '/api/auth/telegram/link-confirm', { nonce: lb.nonce }, tokB);
  ok(lbNoPk.status === 404, 'без pk — не может и свой', lbNoPk.body);
  const lbOk = await api('POST', '/api/auth/telegram/link-confirm', { nonce: lb.nonce, pk: lb.pk }, tokB);
  ok(lbOk.status === 200 && lbOk.body.linked === true, 'свой аккаунт с pk — привязано', lbOk.body);
  const mB1 = await api('GET', '/api/account/methods', null, tokB);
  ok(mB1.body.telegram === true, 'Телеграм привязан', mB1.body);

  /* Законная привязка «в другом браузере»: код со страницы + pk + свой аккаунт. */
  const regC = await api('POST', '/api/register', { email: 'far-link@t.ru', name: 'Далёкий', role: 'blogger', password: 'пароль-подлиннее' });
  const lc = await begin('/api/auth/telegram/start?link=1', regC.body.token);
  const lcCb = await page('/api/auth/telegram/callback?' + tgQ(lc.nonce, tgReply({ id: '555300', first_name: 'Далёкий ТГ' })), '');
  const lcOk = await api('POST', '/api/auth/telegram/link-confirm', { nonce: lc.nonce, pk: lc.pk, code: codeOf(lcCb.text) }, regC.body.token);
  ok(lcOk.status === 200 && lcOk.body.linked === true, 'привязка в другом браузере — по коду', lcOk.body);

  /* ══ Google ══ */
  const g0 = await begin('/api/auth/google/start');
  ok(/^[0-9a-f]{48}$/.test(g0.pk || '') && g0.url.indexOf(g0.pk) < 0 && g0.setCookie.indexOf('bpal_') === 0,
    'Google: start выдаёт pk и куку, в ссылке только метка');
  const gAtt = await begin('/api/auth/google/start');
  const gCb = await page('/api/auth/google/callback?state=' + gAtt.nonce + '&code=victim', '');
  ok(gCb.status === 200 && !!codeOf(gCb.text) && !isRelay(gCb.text), 'Google: возврат в чужой браузер — страница с кодом');
  ok(sessionsOf('victim@gmail.test') === 0, 'Google: сессия жертвы на возврате не заведена');
  const gSteal = await api('POST', '/api/auth/google/pending', { nonce: gAtt.nonce, pk: gAtt.pk });
  ok(gSteal.status === 200 && gSteal.body.state === 'code' && !gSteal.body.token,
    'Google: злоумышленник сессию жертвы НЕ получает', gSteal.body);
  const gReopen = await page('/api/auth/google/callback?state=' + gAtt.nonce, '');
  ok(/уже подтвержд/i.test(gReopen.text) && !codeOf(gReopen.text), 'Google: повторное открытие — без кода');
  const gStill = await api('POST', '/api/auth/google/pending', { nonce: gAtt.nonce, pk: gAtt.pk });
  ok(gStill.body.state === 'code', 'Google: адрес без code чужой вход больше не стирает', gStill.body);

  const gSame = await begin('/api/auth/google/start');
  const gsCb = await page('/api/auth/google/callback?state=' + gSame.nonce + '&code=owner', gSame.cookie);
  ok(isRelay(gsCb.text) && !codeOf(gsCb.text), 'Google: тот же браузер — страница-будильник');
  const gLeak = await api('GET', '/api/auth/google/pending?nonce=' + gSame.nonce);
  ok(gLeak.status === 404, 'Google: утёкшая метка без pk ничего не даёт', gLeak.body);
  const gMine = await api('POST', '/api/auth/google/pending', { nonce: gSame.nonce, pk: gSame.pk });
  ok(gMine.body.state === 'ok' && !!gMine.body.token, 'Google: со своим pk — сессия выдана', gMine.body);
  const gMe = await api('GET', '/api/me', null, gMine.body.token);
  ok(gMe.status === 200 && gMe.body.user && gMe.body.user.email === 'owner@gmail.test', 'Google: сессия рабочая', gMe.body.user);
  const gAgain = await api('POST', '/api/auth/google/pending', { nonce: gSame.nonce, pk: gSame.pk });
  ok(gAgain.body.token === gMine.body.token, 'Google: повторный опрос в минуту — тот же ключ (гонки окон нет)');
} catch (e) {
  failed++; console.log('  FAIL исключение: ' + (e && e.stack || e));
} finally {
  try { srv.kill(); } catch (e) { /* уже */ }
}
console.log(`\nИтого: ${passed} ok, ${failed} FAIL\n`);
process.exit(failed ? 1 : 0);
