/* Единый вход владельца: ключ вводится ОДИН раз.
   Проверяем три пути внутрь — ключ, аккаунт с почтой из ADMIN_EMAIL и
   одноразовый билет для перехода в пульт выплат, — и что сессия не
   открывает дверь чужому сайту (подделка запроса) и посторонним.
   Поднимает свой сервер на 8093 и гасит его в конце.
   Запуск: node test-admin-session.mjs */

import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = 8093;
const BASE = 'http://127.0.0.1:' + PORT;
const KEY = 'test-key-owner';
const OWNER = 'owner-sess@t.ru';
let passed = 0, failed = 0;
function ok(c, name, extra) {
  if (c) { passed++; console.log('  ok  ' + name); }
  else { failed++; console.log('  FAIL ' + name + (extra ? '  ← ' + JSON.stringify(extra).slice(0, 240) : '')); }
}
/* свой мешок кук: fetch в Node их сам не хранит */
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
  return { status: r.status, body: j };
}
const dir = mkdtempSync(path.join(tmpdir(), 'bp-adm-'));
const srv = spawn(process.execPath, ['server.js'], {
  cwd: fileURLToPath(new URL('.', import.meta.url)),
  env: { ...process.env, PORT: String(PORT), DB_PATH: path.join(dir, 'db.sqlite'), ADMIN_KEY: KEY,
    ADMIN_EMAIL: OWNER, TEST_TOPUP: '1', YOOKASSA_SHOP_ID: '', YOOKASSA_SECRET_KEY: '',
    BOT_TOKEN: '', ADMIN_CHAT_ID: '' },
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
  console.log('\nЕдиный вход владельца');
  ok(await waitUp(), 'сервер поднялся');

  /* ── посторонний ── */
  const closed = await api('GET', '/api/admin/overview');
  ok(closed.status === 403, 'без ключа и без сессии дверь закрыта', closed.body);
  const probe = await api('GET', '/api/admin/session');
  ok(probe.status === 200 && probe.body.ok === false, 'проверка «пустит ли» отвечает честно: нет', probe.body);

  /* ── путь 1: ключ, один раз ── */
  const bad = await api('POST', '/api/admin/session', { key: 'не-тот-ключ' });
  ok(bad.status === 403 && !jar, 'неверный ключ сессию не даёт', bad.body);
  const enter = await api('POST', '/api/admin/session', { key: KEY });
  ok(enter.status === 200 && enter.body.by === 'ключ', 'ключ принят', enter.body);
  ok(!!jar, 'сервер выдал сессию');

  const after = await api('GET', '/api/admin/overview');
  ok(after.status === 200, 'после ввода ключа реестр открыт БЕЗ ключа', after.body);
  const probe2 = await api('GET', '/api/admin/session');
  ok(probe2.body.ok === true, 'проверка «пустит ли» отвечает: да');
  const wd = await api('GET', '/api/admin/withdrawals');
  const kyc = await api('GET', '/api/admin/kyc');
  const errs = await api('GET', '/api/admin/errors?days=7');
  const dls = await api('GET', '/api/admin/deals');
  ok([wd, kyc, errs, dls].every((r) => r.status === 200), 'все разделы пульта открыты одной сессией',
    [wd.status, kyc.status, errs.status, dls.status]);
  const cardsAdmin = await api('GET', '/api/admin/cards');
  ok(cardsAdmin.status === 200, 'каталог в админке тоже открыт', cardsAdmin.body);

  /* ── подделка запроса с чужого сайта ──
     Кука уйдёт (браузер приложит её сам), но заголовок чужая страница
     поставить не сможет — значит менять данные ей нельзя. */
  const forged = await api('POST', '/api/admin/cards/hide', { id: 'нет-такой' }, { session: false });
  ok(forged.status === 403, 'запрос без нашего заголовка не проходит', forged.body);
  const honest = await api('POST', '/api/admin/cards/hide', { id: 'нет-такой' });
  ok(honest.status === 404, 'наш собственный запрос проходит (карточки просто нет)', honest.body);

  /* ── путь 2: билет для пульта во внешнем браузере ── */
  const tk = await api('POST', '/api/admin/session', { wantTicket: true });
  ok(tk.status === 200 && typeof tk.body.ticket === 'string' && tk.body.ticket.length > 20, 'выдан билет', tk.body.ticket);
  const ticket = tk.body.ticket;
  const jarSaved = jar; jar = '';                      /* «другой браузер» */
  const noSess = await api('GET', '/api/admin/overview');
  ok(noSess.status === 403, 'в другом браузере сессии нет');
  const byTicket = await api('POST', '/api/admin/session', { ticket });
  ok(byTicket.status === 200 && byTicket.body.by === 'билет', 'билет открыл пульт без ключа', byTicket.body);
  ok((await api('GET', '/api/admin/overview')).status === 200, 'и разделы работают');
  const jarFromTicket = jar; jar = '';
  const again = await api('POST', '/api/admin/session', { ticket });
  ok(again.status === 403, 'тот же билет второй раз не срабатывает', again.body);
  jar = jarFromTicket;

  /* ── выход ── */
  const out = await api('POST', '/api/admin/logout');
  ok(out.status === 200 && !jar, 'выход гасит сессию', out.body);
  ok((await api('GET', '/api/admin/overview')).status === 403, 'после выхода дверь снова закрыта');

  /* ── путь 3: владелец вошёл своей почтой — ключ не нужен вовсе ── */
  const reg = await fetch(BASE + '/api/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: OWNER, name: 'Владелец', role: 'advertiser', password: 'парольВ12345' }),
  }).then((r) => r.json());
  const who = await api('GET', '/api/admin/whoami', null, { token: reg.token });
  ok(who.body && who.body.isAdmin === true, 'аккаунт из ADMIN_EMAIL — владелец', who.body);
  const bySession = await api('POST', '/api/admin/session', {}, { token: reg.token });
  ok(bySession.status === 200 && bySession.body.by === 'аккаунт', 'вход по аккаунту, ключ не спрашивали', bySession.body);
  jar = '';                                            /* пульт в другом браузере */
  const tk2 = await api('POST', '/api/admin/session', { wantTicket: true }, { token: reg.token });
  jar = '';
  const open2 = await api('POST', '/api/admin/session', { ticket: tk2.body.ticket });
  ok(open2.status === 200, 'из приложения в пульт — по билету, без ключа', open2.body);

  /* ── обычный человек ── */
  const guest = await fetch(BASE + '/api/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'guest-sess@t.ru', name: 'Гость', role: 'blogger', password: 'парольВ12345' }),
  }).then((r) => r.json());
  jar = '';
  const guestTry = await api('POST', '/api/admin/session', {}, { token: guest.token });
  ok(guestTry.status === 403 && !jar, 'обычному человеку сессия владельца не выдаётся', guestTry.body);
  ok((await api('GET', '/api/admin/overview', null, { token: guest.token })).status === 403, 'и разделы ему закрыты');
} catch (e) {
  failed++; console.log('  FAIL исключение: ' + e.message);
} finally {
  srv.kill();
}
console.log(`\nИтого: ${passed} ok, ${failed} FAIL\n`);
process.exit(failed ? 1 : 0);
