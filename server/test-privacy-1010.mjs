/* Доводка 10.10.2026 после разбора юридических текстов и снятия карт.
   Проверяем то, что обещают terms.html и privacy.html:
   - карты блогеров, опубликованные до перехода на задания, при первом
     запуске новой версии снимаются с витрины сами (разовый перенос), и
     перезапуск не отменяет «Вернуть все»;
   - скрытие карты по одной — решение об авторе: новая карта под новым
     номером ложится скрытой, «Вернуть все» её не публикует, «Вернуть» у
     карты автора снимает отметку;
   - отвязка канала (самим блогером и оператором) удаляет доступ к площадке
     и снимки статистики; при старте убираются доступы отвязанных раньше;
   - в лидерборде и участниках задания у каждой строки есть who (ключ без
     номера аккаунта): «Профиль» и «Чат» работают и без карт каталога;
     номер для чата — POST /api/tasks/peer, только по участникам задания;
   - общий рейтинг отдаёт имена так же, как доска задания (vidPubName);
   - «Удалить данные пользователя» в пульте: только владелец, только с
     подтверждением, не при деньгах на счёте и не при роликах в подсчёте;
     личное стирается, журнал денег остаётся, вход закрыт.
   Поднимает свой сервер на 8119 и гасит его в конце.
   Запуск: node test-privacy-1010.mjs */

import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const PORT = 8119;
const BASE = 'http://127.0.0.1:' + PORT;
const KEY = 'test-key-privacy-1010';
const HERE = fileURLToPath(new URL('.', import.meta.url));
let passed = 0, failed = 0;
function ok(c, name, extra) {
  if (c) { passed++; console.log('  ok  ' + name); }
  else { failed++; console.log('  FAIL ' + name + (extra !== undefined ? '  ← ' + JSON.stringify(extra).slice(0, 300) : '')); }
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
  if (o.admin) { if (jar) headers.Cookie = jar; headers['X-Admin-Session'] = '1'; }
  const r = await fetch(BASE + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  remember(r);
  const txt = await r.text();
  let j = {}; try { j = JSON.parse(txt); } catch (e) { j = { _raw: txt.slice(0, 160) }; }
  return { status: r.status, body: j };
}
const A = { admin: true };
const dir = mkdtempSync(path.join(tmpdir(), 'bp-priv-'));
const DB = path.join(dir, 'db.sqlite');
let srv = null;
function start() {
  srv = spawn(process.execPath, ['server.js'], {
    cwd: HERE,
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, ADMIN_KEY: KEY, ADMIN_EMAIL: '',
      TEST_TOPUP: '1', YOOKASSA_SHOP_ID: '', YOOKASSA_SECRET_KEY: '', BOT_TOKEN: '', ADMIN_CHAT_ID: '',
      RL_DISABLE: '1' },
    stdio: 'ignore',
  });
}
async function stop() {
  if (!srv) return;
  const p = new Promise((r) => srv.once('exit', r));
  srv.kill();
  await p;
  srv = null;
}
async function waitUp() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) return true; } catch (e) {}
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}
async function restart() { await stop(); start(); return waitUp(); }
function sql(fn) {
  const d = new DatabaseSync(DB);
  try { d.exec('PRAGMA busy_timeout = 5000'); return fn(d); } finally { d.close(); }
}
const one = (s, ...a) => sql((d) => d.prepare(s).get(...a));
const cnt = (s, ...a) => Number((one(s, ...a) || {}).n) || 0;
async function reg(tag, role, name) {
  const r = await api('POST', '/api/register', { email: `pv${tag}@t.ru`, name: name || ('Пользователь ' + tag), role, password: 'парольТест12345' });
  return { token: r.body.token, id: r.body.user && r.body.user.id, email: `pv${tag}@t.ru` };
}
const card = (name) => ({ name, initials: 'БЛ', platforms: ['youtube'],
  platData: { youtube: { url: 'https://youtube.com/@x' + Date.now(), subs: 1000, reach: 500, er: 3 } },
  integrations: { youtube: [{ fmtId: 'yt_pre', price: 1000 }] }, topics: ['Еда'] });
const pubIds = async () => ((await api('GET', '/api/cards')).body.rows || []).map((r) => r.id).sort();
const hiddenOf = (id) => { const r = one('SELECT hidden FROM cards WHERE id = ?', id); return r ? Number(r.hidden) : null; };

try {
  const t = Date.now();
  console.log('\nРазовое снятие карт при первом запуске');
  start();
  ok(await waitUp(), 'сервер поднялся на пустой базе');
  ok(one("SELECT value FROM server_flags WHERE key = 'cards_unpub_1010'").value === 'нечего снимать',
    'на пустой базе снимать нечего — отметка стоит, витрина открыта');
  const enter = await api('POST', '/api/admin/session', { key: KEY }, A);
  ok(enter.status === 200 && !!jar, 'владелец вошёл в пульт');

  const p1 = await reg('p1' + t, 'blogger', 'Пётр');
  const p2 = await reg('p2' + t, 'blogger', 'Полина');
  const K1 = 'pv_k1_' + t, K2 = 'pv_k2_' + t;
  await api('POST', '/api/cards', { id: K1, card: card('Пётр') }, { token: p1.token });
  await api('POST', '/api/cards', { id: K2, card: card('Полина') }, { token: p2.token });
  ok((await pubIds()).length === 2, 'до переноса на витрине две карты (как на бою до выкладки)');

  /* как на бою: база старой версии — отметки переноса ещё нет */
  sql((d) => d.prepare("DELETE FROM server_flags WHERE key IN ('cards_unpub_1010','cards_closed')").run());
  ok(await restart(), 'сервер перезапущен — как первая выкладка новой версии');
  ok((await pubIds()).length === 0, 'после запуска публичный каталог пуст');
  ok(hiddenOf(K1) === 2 && hiddenOf(K2) === 2, 'карты сняты общей отметкой (hidden = 2), не удалены', [hiddenOf(K1), hiddenOf(K2)]);
  ok(one("SELECT value FROM server_flags WHERE key = 'cards_closed'").value === '1', 'витрина закрыта');
  const logm = one("SELECT who, detail FROM admin_log WHERE action = 'cards-unpublish-all' ORDER BY id DESC LIMIT 1");
  ok(!!logm && logm.who === 'сервер' && /разовый перенос/.test(logm.detail) && /снято 2/.test(logm.detail), 'в журнале запись переноса', logm);

  await api('POST', '/api/admin/session', { key: KEY }, A);
  const back = await api('POST', '/api/admin/cards/restore-all', {}, A);
  ok(back.status === 200 && back.body.restored === 2, 'владелец нажал «Вернуть все»', back.body);
  ok(await restart(), 'ещё один перезапуск');
  ok((await pubIds()).length === 2, 'перезапуск не снимает карты повторно — решение владельца в силе');
  await api('POST', '/api/admin/session', { key: KEY }, A);

  console.log('\nСкрытие по одной — решение об авторе');
  const hz = await api('POST', '/api/admin/cards/hide', { id: K1, hidden: true }, A);
  ok(hz.status === 200 && hiddenOf(K1) === 1, 'карта Петра скрыта по одной');
  const K1b = 'pv_k1b_' + t;
  await api('POST', '/api/cards', { id: K1b, card: card('Пётр · новая') }, { token: p1.token });
  ok(hiddenOf(K1b) === 1 && !(await pubIds()).includes(K1b), 'витрина открыта, а новая карта Петра под новым номером ложится скрытой', hiddenOf(K1b));
  await api('POST', '/api/admin/cards/unpublish-all', {}, A);
  await api('POST', '/api/cards/delete', { id: K1 }, { token: p1.token });
  await api('POST', '/api/cards/delete', { id: K1b }, { token: p1.token });
  const K1c = 'pv_k1c_' + t;
  await api('POST', '/api/cards', { id: K1c, card: card('Пётр · третья') }, { token: p1.token });
  ok(hiddenOf(K1c) === 1, 'автор удалил скрытые и прислал третью при закрытой витрине — скрыта по одной, а не снята', hiddenOf(K1c));
  const ra = await api('POST', '/api/admin/cards/restore-all', {}, A);
  const ids = await pubIds();
  ok(ra.status === 200 && !ids.includes(K1c) && ids.includes(K2), '«Вернуть все» вернуло Полину, а карту Петра — нет', ids);
  ok(ra.body.stats && ra.body.stats.hidden === 1, 'пульт считает её скрытой по одной', ra.body.stats);
  const un = await api('POST', '/api/admin/cards/hide', { id: K1c, hidden: false }, A);
  ok(un.status === 200 && (await pubIds()).includes(K1c), '«Вернуть» у карты автора — она на витрине');
  ok(cnt('SELECT COUNT(*) AS n FROM card_tombs WHERE user_id = ? AND hidden = 1', p1.id) === 0, 'и отметка об авторе снята');
  const K1d = 'pv_k1d_' + t;
  await api('POST', '/api/cards', { id: K1d, card: card('Пётр · снова') }, { token: p1.token });
  ok(hiddenOf(K1d) === 0, 'после «Вернуть» новая карта автора снова сразу на витрине', hiddenOf(K1d));

  console.log('\nОтвязка канала: доступ и снимки статистики');
  const put = (uid, plat, ext) => sql((d) => {
    d.prepare('INSERT INTO channels (user_id, platform, external_id, title, url, subs) VALUES (?,?,?,?,?,?)').run(uid, plat, ext, 'Канал', 'https://x/' + ext, 10);
    d.prepare('INSERT INTO channel_tokens (user_id, platform, external_id, access, refresh) VALUES (?,?,?,?,?)').run(uid, plat, ext, 'ACCESS', 'REFRESH-TOK');
    d.prepare('INSERT INTO channel_stats (user_id, platform, external_id, followers) VALUES (?,?,?,?)').run(uid, plat, ext, 10);
  });
  const left = (uid, plat, ext) => [
    cnt('SELECT COUNT(*) AS n FROM channels WHERE user_id = ? AND platform = ? AND external_id = ?', uid, plat, ext),
    cnt('SELECT COUNT(*) AS n FROM channel_tokens WHERE user_id = ? AND platform = ? AND external_id = ?', uid, plat, ext),
    cnt('SELECT COUNT(*) AS n FROM channel_stats WHERE user_id = ? AND platform = ? AND external_id = ?', uid, plat, ext),
  ].join('/');
  put(p2.id, 'youtube', 'UCself' + t);
  const su = await api('POST', '/api/verify/unlink', { platform: 'youtube', externalId: 'UCself' + t }, { token: p2.token });
  ok(su.status === 200 && left(p2.id, 'youtube', 'UCself' + t) === '0/0/0', 'блогер отвязал канал — нет ни канала, ни доступа, ни снимков', left(p2.id, 'youtube', 'UCself' + t));
  put(p1.id, 'tiktok', 'tt' + t);
  put(p2.id, 'tiktok', 'tt' + t);
  const au = await api('POST', '/api/admin/verify/unlink', { platform: 'tiktok', externalId: 'tt' + t }, A);
  ok(au.status === 200 && left(p1.id, 'tiktok', 'tt' + t) === '0/0/0' && left(p2.id, 'tiktok', 'tt' + t) === '0/0/0',
    'оператор отвязал канал у двух аккаунтов — доступ (refresh token) и снимки удалены у обоих', [left(p1.id, 'tiktok', 'tt' + t), left(p2.id, 'tiktok', 'tt' + t)]);
  sql((d) => {
    d.prepare('INSERT INTO channel_tokens (user_id, platform, external_id, access, refresh) VALUES (?,?,?,?,?)').run(p1.id, 'youtube', 'UCorphan', 'A', 'R');
    d.prepare('INSERT INTO channel_stats (user_id, platform, external_id, followers) VALUES (?,?,?,?)').run(p1.id, 'youtube', 'UCorphan', 1);
  });
  put(p1.id, 'youtube', 'UCkeep' + t);
  ok(await restart(), 'перезапуск с «осиротевшим» доступом (отвязан прежней версией)');
  await api('POST', '/api/admin/session', { key: KEY }, A);
  ok(left(p1.id, 'youtube', 'UCorphan') === '0/0/0', 'при старте доступ и снимки без канала удалены');
  ok(left(p1.id, 'youtube', 'UCkeep' + t) === '1/1/1', 'а у подключённого канала всё на месте');

  console.log('\nЛидерборд задания без карт: who и номер для чата');
  const adv = await reg('ad' + t, 'advertiser', 'Рекламодатель');
  const b1 = await reg('b1' + t, 'blogger', 'Борис');
  const b2 = await reg('b2' + t, 'blogger', 'Вера');
  const outsider = await reg('ou' + t, 'blogger', 'Посторонний');
  const camp = 'pvcamp' + t;
  const cp = await api('POST', '/api/sync/put', { kind: 'camp', rid: camp, data: { id: camp, name: 'Тест', status: 'active' } }, { token: adv.token });
  ok(cp.status === 200, 'задание заведено', cp.body);
  /* вступить можно только в задание с замороженным бюджетом (аудит 16.10.2026);
     бюджет задания + 7% комиссии сверху (14.10.2026) — в пополнение 5 000 */
  await api('POST', '/api/topup', { amount: 5000, opKey: randomUUID() }, { token: adv.token });
  const hd = await api('POST', '/api/deals/hold', { dealId: 'camp:' + camp, amount: 4000, opKey: randomUUID() }, { token: adv.token });
  ok(hd.status === 200, 'бюджет задания заморожен', hd.body);
  for (const u of [b1, b2]) {
    const j = await api('POST', '/api/tasks/join', { campId: camp }, { token: u.token });
    ok(j.status === 200, 'вступил ' + u.id, j.body);
  }
  await api('POST', '/api/admin/cards/unpublish-all', {}, A);
  const bd = await api('GET', '/api/tasks/board?campId=' + camp, null, { token: b2.token });
  const ps = bd.body.participants || [];
  const r1 = ps.find((r) => !r.me), r2 = ps.find((r) => r.me);
  ok(bd.status === 200 && ps.length === 2, 'участников двое', bd.body);
  ok(r1 && /^[A-Za-z0-9_-]{10,40}$/.test(r1.who || '') && !('uid' in r1) && !r1.card, 'у чужой строки есть who, нет номера и карты', r1);
  ok(r2 && r2.who && r2.who !== r1.who, 'у своей строки свой who', r2);
  const bd2 = await api('GET', '/api/tasks/board?campId=' + camp, null, { token: outsider.token });
  ok((bd2.body.participants || []).some((r) => r.who === r1.who), 'who одинаковый для всех, кто смотрит доску');
  const peer = await api('POST', '/api/tasks/peer', { campId: camp, who: r1.who }, { token: b2.token });
  ok(peer.status === 200 && peer.body.uid === b1.id, '«Чат»: номер участника приходит по who', peer.body);
  const selfp = await api('POST', '/api/tasks/peer', { campId: camp, who: r2.who }, { token: b2.token });
  ok(selfp.status === 400 && selfp.body.code === 'self', 'себе — нельзя', selfp.body);
  const bad = await api('POST', '/api/tasks/peer', { campId: camp, who: 'AAAAAAAAAAAAAAAAAAAAAA' }, { token: b2.token });
  ok(bad.status === 404, 'выдуманный who — «не найден»', bad.body);
  const camp2 = 'pvcamp2' + t;
  await api('POST', '/api/sync/put', { kind: 'camp', rid: camp2, data: { id: camp2, name: 'Другое', status: 'active' } }, { token: adv.token });
  const other = await api('POST', '/api/tasks/peer', { campId: camp2, who: r1.who }, { token: b2.token });
  ok(other.status === 404, 'по чужому заданию, где человека нет, номер не выдаётся', other.body);
  const anon = await api('POST', '/api/tasks/peer', { campId: camp, who: r1.who });
  ok(anon.status === 401, 'без входа — отказ', anon.body);
  const own = await api('GET', '/api/tasks/board?campId=' + camp, null, { token: adv.token });
  ok((own.body.participants || []).every((r) => Number.isInteger(r.uid) && r.who), 'автору задания — номер и who, как раньше');

  console.log('\nОбщий рейтинг: имена как на доске задания');
  const tgName = await reg('tg' + t, 'blogger', 'Пользователь 7654321');
  /* бюджет задания заморожен выше, до вступления */
  const rel = await api('POST', '/api/deals/release', { dealId: 'camp:' + camp, toUserId: tgName.id, amount: 2000, opKey: randomUUID() }, { token: adv.token });
  ok(rel.status === 200, 'выплата блогеру с именем по умолчанию', rel.body);
  const lb = await api('GET', '/api/leaderboard');
  const row = (lb.body.rows || []).find((r) => r.id === tgName.id);
  ok(row && row.name === 'Пользователь', 'номер Телеграма из имени по умолчанию наружу не уходит', row);

  console.log('\nУдаление данных пользователя по обращению');
  /* у Бориса: канал с доступом, карта, профиль, личные сообщения, подписка на уведомления */
  put(b1.id, 'youtube', 'UCb1' + t);
  await api('POST', '/api/cards', { id: 'pv_b1_' + t, card: card('Борис') }, { token: b1.token });
  const pr = await api('POST', '/api/sync/put', { kind: 'prof', rid: 'self:' + b1.id, data: { name: 'Борис', phone: '+7900' } }, { token: b1.token });
  const dm1 = await api('POST', '/api/sync/put', { kind: 'dm', rid: 'dm.' + b1.id + '.' + b2.id + '.aaaa1111', data: { t: 'привет' }, to: b2.id }, { token: b1.token });
  const dm2 = await api('POST', '/api/sync/put', { kind: 'dm', rid: 'dm.' + b2.id + '.' + b1.id + '.bbbb2222', data: { t: 'ответ' }, to: b1.id }, { token: b2.token });
  ok(pr.status === 200 && dm1.status === 200 && dm2.status === 200, 'профиль и переписка лежат на сервере', [pr.body, dm1.body, dm2.body]);
  sql((d) => d.prepare('INSERT INTO push_subs (endpoint, user_id, p256dh, auth) VALUES (?,?,?,?)').run('https://push.example/' + t, b1.id, 'k', 'a'));
  sql((d) => d.prepare(`INSERT INTO task_videos (camp_id, owner_id, blogger_id, platform, external_id, video_id, url, handle, title, status, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(camp, adv.id, b1.id, 'youtube', 'UCb1' + t, 'vid' + t, 'https://youtu.be/vid' + t, '@boris', 'Ролик Бориса', 'paid', t, t));

  const noKey = await api('POST', '/api/admin/users/erase', { userId: b1.id, confirm: 'erase' }, { token: b2.token });
  ok(noKey.status === 403, 'не владелец — отказ', noKey.body);
  const noConf = await api('POST', '/api/admin/users/erase', { userId: b1.id }, A);
  ok(noConf.status === 400, 'без подтверждения — отказ', noConf.body);
  const money = await api('POST', '/api/admin/users/erase', { userId: tgName.id, confirm: 'erase' }, A);
  ok(money.status === 409 && money.body.code === 'money', 'на счёте деньги — сначала вывод', money.body);
  sql((d) => d.prepare("UPDATE task_videos SET status = 'active' WHERE video_id = ?").run('vid' + t));
  const live = await api('POST', '/api/admin/users/erase', { userId: b1.id, confirm: 'erase' }, A);
  ok(live.status === 409 && live.body.code === 'videos_live', 'ролик в подсчёте — сначала конец подсчёта', live.body);
  sql((d) => d.prepare("UPDATE task_videos SET status = 'paid' WHERE video_id = ?").run('vid' + t));
  const ledgerBefore = cnt('SELECT COUNT(*) AS n FROM ledger WHERE user_id = ?', adv.id);

  const er = await api('POST', '/api/admin/users/erase', { userId: b1.id, confirm: 'erase', reason: 'письмо от 10.10' }, A);
  ok(er.status === 200 && er.body.ok === true, 'данные Бориса удалены', er.body);
  const u1 = one('SELECT * FROM users WHERE id = ?', b1.id);
  ok(u1 && /@erased\.invalid$/.test(u1.email) && u1.name === 'Удалённый пользователь' && Number(u1.is_blocked) === 1
    && u1.tg_id == null && u1.google_sub == null, 'учётная запись обезличена и закрыта', u1 && { email: u1.email, name: u1.name });
  ok(cnt('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?', b1.id) === 0, 'сессии удалены');
  ok(left(b1.id, 'youtube', 'UCb1' + t) === '0/0/0', 'канал, доступ к YouTube и снимки удалены');
  ok(cnt('SELECT COUNT(*) AS n FROM cards WHERE user_id = ?', b1.id) === 0, 'карта удалена');
  ok(cnt("SELECT COUNT(*) AS n FROM sync WHERE kind = 'prof' AND a_id = ?", b1.id) === 0, 'профиль удалён');
  ok(cnt("SELECT COUNT(*) AS n FROM sync WHERE kind = 'dm' AND (a_id = ? OR b_id = ?)", b1.id, b1.id) === 0, 'личные сообщения в обе стороны удалены');
  ok(cnt('SELECT COUNT(*) AS n FROM push_subs WHERE user_id = ?', b1.id) === 0, 'подписка на уведомления удалена');
  ok(cnt('SELECT COUNT(*) AS n FROM task_members WHERE user_id = ?', b1.id) === 0, 'из участников задания убран');
  const v = one('SELECT url, title, handle, status FROM task_videos WHERE video_id = ?', 'vid' + t);
  ok(v && v.url == null && v.title == null && v.handle == null && v.status === 'paid', 'у ролика стёрты ссылка, название и ник, запись для расчётов осталась', v);
  ok(cnt('SELECT COUNT(*) AS n FROM ledger WHERE user_id = ?', adv.id) === ledgerBefore, 'журнал денег не тронут');
  const login = await api('POST', '/api/login', { email: b1.email, password: 'парольТест12345' });
  ok(login.status !== 200, 'войти по старой почте и паролю нельзя', login.status);
  const oldTok = await api('GET', '/api/balance', null, { token: b1.token });
  ok(oldTok.status === 401, 'старый вход больше не работает', oldTok.status);
  const bd3 = await api('GET', '/api/tasks/board?campId=' + camp, null, { token: b2.token });
  ok(!(bd3.body.participants || []).some((r) => r.who === r1.who), 'в участниках задания его больше нет');
  const again = await api('POST', '/api/admin/users/erase', { userId: b1.id, confirm: 'erase' }, A);
  ok(again.status === 409 && again.body.code === 'already', 'повторно — «уже удалены»', again.body);
  const lg = one("SELECT detail FROM admin_log WHERE action = 'user-erase' ORDER BY id DESC LIMIT 1");
  ok(lg && /письмо от 10\.10/.test(lg.detail) && !/pvb1/.test(lg.detail), 'в журнале запись без почты человека', lg);
} catch (e) {
  failed++;
  console.log('  FAIL исключение: ' + (e && e.stack || e));
} finally {
  await stop().catch(() => {});
  console.log('\nИтого: ' + passed + ' ok, ' + failed + ' FAIL\n');
  process.exit(failed ? 1 : 0);
}
