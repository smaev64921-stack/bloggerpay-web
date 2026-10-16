/* Единый веб-пульт владельца: разделы «Пользователи», «Каталог», «Журнал».
   Проверяем, что список людей и блокировка открыты только владельцу,
   что поиск находит кириллицу без учёта регистра, что заблокированный
   теряет вход и витрину, а владельца заблокировать нельзя, и что каждое
   решение ложится в журнал с тем, кто его принял.
   Поднимает свой сервер на 8106 и гасит его в конце.
   Запуск: node test-admin-console.mjs */

import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = 8106;
const BASE = 'http://127.0.0.1:' + PORT;
const KEY = 'test-key-console';
const OWNER = 'owner-console@t.ru';
let passed = 0, failed = 0;
function ok(c, name, extra) {
  if (c) { passed++; console.log('  ok  ' + name); }
  else { failed++; console.log('  FAIL ' + name + (extra ? '  ← ' + JSON.stringify(extra).slice(0, 240) : '')); }
}
let jar = '';
function remember(res) {
  const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const line of sc) {
    const kv = line.split(';')[0];
    if (kv.startsWith('bp_admin=')) jar = kv.endsWith('=') ? '' : kv;
  }
}
async function api(method, p, body, opt) {
  const o = opt || {};
  const headers = { 'Content-Type': 'application/json' };
  if (o.token) headers.Authorization = 'Bearer ' + o.token;
  if (o.key) headers['X-Admin-Key'] = o.key;
  if (o.session !== false) headers['X-Admin-Session'] = '1';
  if (o.cookie !== false && jar) headers.Cookie = jar;
  const r = await fetch(BASE + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  remember(r);
  const txt = await r.text();
  let j = {}; try { j = JSON.parse(txt); } catch (e) { j = { _raw: txt.slice(0, 160) }; }
  return { status: r.status, body: j, headers: r.headers };
}
async function reg(email, name, role, extraHeaders) {
  const r = await fetch(BASE + '/api/register', {
    method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, extraHeaders || {}),
    body: JSON.stringify({ email, name, role, password: 'парольТест12345' }),
  });
  return r.json();
}
async function login(email) {
  const r = await fetch(BASE + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'парольТест12345' }),
  });
  let j = {}; try { j = await r.json(); } catch (e) {}
  return { status: r.status, body: j };
}
const card = (name) => ({ name, initials: 'МО', platforms: ['youtube'],
  platData: { youtube: { url: 'https://youtube.com/@maria', subs: 125000, reach: 40000, er: 4.2 } },
  integrations: { youtube: [{ fmtId: 'yt_pre', price: 15000 }, { fmtId: 'yt_mid', price: 9000 }] },
  topics: ['Бьюти', 'Лайфстайл'] });

const dir = mkdtempSync(path.join(tmpdir(), 'bp-cons-'));
const srv = spawn(process.execPath, ['server.js'], {
  cwd: fileURLToPath(new URL('.', import.meta.url)),
  env: { ...process.env, PORT: String(PORT), DB_PATH: path.join(dir, 'db.sqlite'), ADMIN_KEY: KEY,
    ADMIN_EMAIL: OWNER, TEST_TOPUP: '1', YOOKASSA_SHOP_ID: '', YOOKASSA_SECRET_KEY: '',
    BOT_TOKEN: '', ADMIN_CHAT_ID: '', RL_DISABLE: '1' },
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
  console.log('\nЕдиный веб-пульт владельца');
  ok(await waitUp(), 'сервер поднялся');

  /* ── страница ── */
  for (const p of ['/admin', '/operator']) {
    const r = await fetch(BASE + p);
    const html = await r.text();
    ok(r.status === 200 && /text\/html/.test(r.headers.get('content-type') || '')
      && (r.headers.get('content-security-policy') || '') === 'frame-ancestors https://web.telegram.org'
      && /BloggerPay/.test(html), 'страница пульта открывается по ' + p + ' (во фрейме — только веб-Телеграм)');
  }
  const adminHtml = await (await fetch(BASE + '/admin')).text();
  ok(/data-act="fullsite"/.test(adminHtml) && /data-act="fulloff"/.test(adminHtml)
    && /localStorage\.setItem\(FULL_KEY, '1'\)/.test(adminHtml) && /FULL_KEY = 'bp_full_access'/.test(adminHtml)
    && /Перейти на сайт с полным доступом/.test(adminHtml) && /Выключить полный доступ на этом устройстве/.test(adminHtml),
  'в пульте есть «Перейти на сайт с полным доступом» и «Выключить полный доступ на этом устройстве»');

  /* ── посторонним закрыто ── */
  ok((await api('GET', '/api/admin/users', null, { cookie: false })).status === 403, 'список людей без входа закрыт');
  ok((await api('GET', '/api/admin/log', null, { cookie: false })).status === 403, 'журнал без входа закрыт');
  ok((await api('POST', '/api/admin/users/block', { userId: 1 }, { cookie: false })).status === 403, 'блокировка без входа закрыта');

  const maria = await reg('maria@t.ru', 'Мария Орлова', 'blogger');
  const brand = await reg('brand@t.ru', 'Бренд Косметика', 'advertiser');
  const owner = await reg(OWNER, 'Владелец', 'advertiser', { 'X-Admin-Key': KEY });
  ok(!!(maria.token && brand.token && owner.token), 'три аккаунта заведены', { maria, brand });
  ok((await api('GET', '/api/admin/users', null, { token: brand.token })).status === 403, 'обычный пользователь список людей не видит');

  const put = await api('POST', '/api/cards', { id: 'mycard_maria1', card: card('Мария Орлова') }, { token: maria.token });
  ok(put.status === 200, 'Мария опубликовала карточку', put.body);

  /* ── вход ключом ── */
  const enter = await api('POST', '/api/admin/session', { key: KEY });
  ok(enter.status === 200 && !!jar, 'владелец вошёл ключом');

  /* ── список людей ── */
  const all = await api('GET', '/api/admin/users');
  const rows = (all.body && all.body.rows) || [];
  const m = rows.find((r) => r.email === 'maria@t.ru');
  ok(all.status === 200 && all.body.total >= 3 && !!m, 'список людей отдаётся', all.body);
  ok(!!m && m.role === 'blogger' && m.cards === 1 && m.is_blocked === 0 && typeof m.available === 'number',
    'в строке роль, карточки, баланс и блокировка', m);
  ok(!rows.some((r) => 'pass_hash' in r || 'pass_salt' in r || 'tg_id' in r), 'хеши паролей и Телеграм-номера наружу не уходят');
  const search = await api('GET', '/api/admin/users?q=' + encodeURIComponent('мария'));
  ok(search.body.total === 1 && search.body.rows[0].email === 'maria@t.ru', 'поиск «мария» находит «Марию» — регистр кириллицы не мешает', search.body);
  const byId = await api('GET', '/api/admin/users?q=' + m.id);
  ok(byId.body.rows.length >= 1 && byId.body.rows[0].id === m.id, 'поиск по номеру');
  const onlyAdv = await api('GET', '/api/admin/users?filter=advertiser');
  ok(onlyAdv.body.rows.every((r) => r.role === 'advertiser') && onlyAdv.body.total >= 2, 'фильтр по роли');
  const admins = await api('GET', '/api/admin/users?filter=admin');
  ok(admins.body.rows.length === 1 && admins.body.rows[0].email === OWNER, 'фильтр «владельцы»');
  const page = await api('GET', '/api/admin/users?limit=1&offset=1');
  ok(page.body.rows.length === 1 && page.body.total >= 3, 'постраничная выдача');

  /* ── карточка человека ── */
  const card1 = await api('GET', '/api/admin/user?id=' + m.id);
  ok(card1.status === 200 && card1.body.user.email === 'maria@t.ru' && Array.isArray(card1.body.ledger)
    && Array.isArray(card1.body.channels) && Array.isArray(card1.body.withdrawals)
    && card1.body.cards.length === 1 && card1.body.cards[0].card.name === 'Мария Орлова',
    'карточка человека: профиль, журнал, каналы, выводы, карточки', card1.body);

  /* ── блокировка ── */
  const forged = await api('POST', '/api/admin/users/block', { userId: m.id }, { session: false });
  ok(forged.status === 403, 'чужой сайт с одной кукой заблокировать не может', forged.body);
  const selfBlock = await api('POST', '/api/admin/users/block', { userId: owner.user ? owner.user.id : admins.body.rows[0].id });
  ok(selfBlock.status === 409, 'владельца заблокировать нельзя', selfBlock.body);
  const badId = await api('POST', '/api/admin/users/block', { userId: 'abc' });
  ok(badId.status === 400, 'мусорный номер отклонён');
  const none = await api('POST', '/api/admin/users/block', { userId: 999999 });
  ok(none.status === 404, 'несуществующий человек — 404');

  const cat0 = await api('GET', '/api/cards');
  ok((cat0.body.rows || cat0.body.cards || []).length >= 1, 'до блокировки карточка Марии в каталоге', cat0.body);
  const blk = await api('POST', '/api/admin/users/block', { userId: m.id, blocked: true, reason: 'накрутка' });
  ok(blk.status === 200 && blk.body.blocked === true, 'Мария заблокирована', blk.body);
  const me = await api('GET', '/api/me', null, { token: maria.token, cookie: false });
  ok(me.status === 401 || me.status === 403, 'её сессия больше не работает', me);
  const li = await login('maria@t.ru');
  ok(li.status === 403, 'войти заново она не может', li);
  const cat1 = await api('GET', '/api/cards', null, { cookie: false });
  ok(!(cat1.body.rows || cat1.body.cards || []).some((c) => c.id === 'mycard_maria1'), 'её карточка ушла из каталога', cat1.body);
  const blocked = await api('GET', '/api/admin/users?filter=blocked');
  ok(blocked.body.rows.length === 1 && blocked.body.rows[0].id === m.id, 'фильтр «заблокированные»');

  const unb = await api('POST', '/api/admin/users/block', { userId: m.id, blocked: false });
  ok(unb.status === 200 && unb.body.blocked === false, 'разблокирована');
  ok((await login('maria@t.ru')).status === 200, 'вход снова открыт');

  /* ── каталог ── */
  const cards = await api('GET', '/api/admin/cards');
  const cm = (cards.body.rows || []).find((c) => c.id === 'mycard_maria1');
  ok(!!cm && cm.card && cm.card.name === 'Мария Орлова' && cm.card.priceFrom === 9000
    && cm.card.platforms[0].id === 'youtube' && !('data' in cm), 'каталог пульта: сводка карточки, цена «от», без сырых данных', cm);
  const hide = await api('POST', '/api/admin/cards/hide', { id: 'mycard_maria1', hidden: true });
  ok(hide.status === 200 && hide.body.hidden === true, 'карточка снята с витрины');
  const show = await api('POST', '/api/admin/cards/hide', { id: 'mycard_maria1', hidden: false });
  ok(show.status === 200 && show.body.hidden === false, 'и возвращена');

  /* ── журнал ── */
  const log = await api('GET', '/api/admin/log');
  const acts = (log.body.rows || []).map((r) => r.action);
  ok(log.status === 200 && acts.includes('user-block') && acts.includes('user-unblock')
    && acts.includes('card-hide') && acts.includes('card-show'), 'журнал записал блокировку и витрину', acts);
  const rowBlk = (log.body.rows || []).find((r) => r.action === 'user-block');
  ok(!!rowBlk && rowBlk.who === 'ключ владельца' && /накрутка/.test(rowBlk.detail || ''), 'в журнале видно, кто и почему', rowBlk);
  const byAcc = await api('POST', '/api/admin/users/block', { userId: m.id, blocked: false }, { token: owner.token, cookie: false });
  ok(byAcc.status === 200, 'владелец-аккаунт тоже может');
  const log2 = await api('GET', '/api/admin/log?limit=1');
  ok(log2.body.rows.length === 1 && log2.body.rows[0].who === OWNER, 'действие аккаунтом подписано его почтой', log2.body.rows);

  /* ── вход в пульт почтой: сессия подписана именем владельца ── */
  const saved = jar; jar = '';
  const li2 = await login(OWNER);
  ok(li2.status === 200 && !!li2.body.token, 'владелец вошёл почтой');
  const sess = await api('POST', '/api/admin/session', {}, { token: li2.body.token });
  ok(sess.status === 200 && sess.body.who === OWNER && !!jar, 'сессия пульта выдана на его имя', sess.body);
  const probeWho = await api('GET', '/api/admin/session');
  ok(probeWho.body.ok === true && probeWho.body.who === OWNER, 'пульт знает, кто вошёл', probeWho.body);
  await api('POST', '/api/admin/cards/hide', { id: 'mycard_maria1', hidden: true });
  await api('POST', '/api/admin/cards/hide', { id: 'mycard_maria1', hidden: false });
  const log3 = await api('GET', '/api/admin/log?limit=1');
  ok(log3.body.rows[0].who === OWNER, 'действие из пульта подписано почтой, а не «сессией»', log3.body.rows);
  const forgedCookie = jar.replace(/\.[A-Za-z0-9_-]+\.([0-9a-f]{32})$/, '.' + Buffer.from('чужой@t.ru').toString('base64url') + '.$1');
  const jarReal = jar; jar = forgedCookie;
  const fake = await api('GET', '/api/admin/session');
  ok(fake.body.ok === false, 'подменить имя в куке нельзя — подпись не сходится', fake.body);
  jar = saved || jarReal;

  /* ── задания заблокированного рекламодателя уходят из общей ленты ── */
  const camp = { id: 'camp_test_1', name: 'Задание бренда', status: 'active', budget: 1000 };
  const putC = await api('POST', '/api/sync/put', { kind: 'camp', rid: 'camp_test_1', data: camp }, { token: brand.token, cookie: false });
  ok(putC.status === 200, 'бренд опубликовал задание', putC.body);
  /* в общую ленту и витрину попадает только задание с бюджетом (аудит 16.10.2026) */
  const pubNo = await api('GET', '/api/tasks/public', null, { cookie: false });
  ok(!JSON.stringify(pubNo.body).includes('camp_test_1'), 'без заморозки бюджета задания в витрине нет', pubNo.body);
  const sumNo = await api('GET', '/api/tasks/summary', null, { cookie: false });
  const stNo = sumNo.body.camps && sumNo.body.camps.camp_test_1;
  ok(sumNo.status === 200 && !!stNo && stNo.videos === 0 && stNo.views === 0 && stNo.paid === 0 && stNo.budget === 0,
    'задание есть в сводке «Главной» (без заморозки — нули)', sumNo.body);
  await api('POST', '/api/topup', { amount: 5000, opKey: 'adm-topup-camp-test-1' }, { token: brand.token, cookie: false });
  const holdC = await api('POST', '/api/deals/hold', { dealId: 'camp:camp_test_1', amount: 1000, opKey: 'adm-hold-camp-test-1' }, { token: brand.token, cookie: false });
  ok(holdC.status === 200, 'бренд заморозил бюджет задания', holdC.body);
  const pub0 = await api('GET', '/api/tasks/public', null, { cookie: false });
  const has0 = JSON.stringify(pub0.body).includes('camp_test_1');
  ok(has0, 'задание видно в общей ленте', pub0.body);
  /* прежний ключ Марии погас при её блокировке выше — входим заново */
  const mariaTok = (await login('maria@t.ru')).body.token;
  const pullM0 = await api('GET', '/api/sync/pull?since=0', null, { token: mariaTok, cookie: false });
  ok(pullM0.status === 200 && JSON.stringify(pullM0.body).includes('camp_test_1'), 'и в обмене другим людям', pullM0);
  const sum0 = await api('GET', '/api/tasks/summary', null, { cookie: false });
  const st0 = sum0.body.camps && sum0.body.camps.camp_test_1;
  ok(sum0.status === 200 && !!st0 && st0.videos === 0 && st0.paid === 0 && st0.budget === 1000,
    'и в сводке «Главной» — с замороженным бюджетом', sum0.body);
  const brandId = (onlyAdv.body.rows.find((r) => r.email === 'brand@t.ru') || {}).id;
  await api('POST', '/api/admin/users/block', { userId: brandId, blocked: true, reason: 'мошенничество' });
  const pub1 = await api('GET', '/api/tasks/public', null, { cookie: false });
  ok(!JSON.stringify(pub1.body).includes('camp_test_1'), 'после блокировки автора задание из ленты ушло', pub1.body);
  const sum1 = await api('GET', '/api/tasks/summary', null, { cookie: false });
  ok(sum1.status === 200 && !('camp_test_1' in (sum1.body.camps || {})), 'и из сводки — сразу, без минуты кэша', sum1.body);
  const pullM = await api('GET', '/api/sync/pull?since=0', null, { token: mariaTok, cookie: false });
  ok(pullM.status === 200 && !JSON.stringify(pullM.body).includes('camp_test_1'), 'и в обмен другим людям больше не приходит', pullM);
  await api('POST', '/api/admin/users/block', { userId: brandId, blocked: false });
  const sum2 = await api('GET', '/api/tasks/summary', null, { cookie: false });
  ok('camp_test_1' in (sum2.body.camps || {}), 'разблокировали — задание вернулось в сводку');

  /* ── поиск числом: сам номер — первым ── */
  const byNum = await api('GET', '/api/admin/users?q=' + m.id);
  ok(byNum.body.rows[0] && byNum.body.rows[0].id === m.id, 'точное совпадение номера стоит первым');
} catch (e) {
  failed++;
  console.log('  FAIL исключение: ' + (e && e.stack || e));
} finally {
  srv.kill();
  console.log('\n' + passed + ' ok, ' + failed + ' fail');
  process.exit(failed ? 1 : 0);
}
