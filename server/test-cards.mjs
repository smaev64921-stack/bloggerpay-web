/* Общий каталог карточек: два «телефона» одного человека и посторонний.
   Проверяем главное, из-за чего это писалось: карточка, опубликованная
   на одном устройстве, обязана появиться и на втором, и у другого
   человека. Плюс — что в витрину не уезжает лишнее (почта владельца,
   местный id, чужая разметка) и что чужую карточку не перезаписать.
   Поднимает свой сервер на 8099 и гасит его в конце.
   Запуск: node test-cards.mjs */

import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const PORT = 8099;
const BASE = 'http://127.0.0.1:' + PORT;
const KEY = 'test-key';
let passed = 0, failed = 0;
function ok(c, name, extra) {
  if (c) { passed++; console.log('  ok  ' + name); }
  else { failed++; console.log('  FAIL ' + name + (extra ? '  ← ' + JSON.stringify(extra).slice(0, 300) : '')); }
}
async function api(method, p, body, token, admin) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  if (admin) headers['X-Admin-Key'] = KEY;
  const r = await fetch(BASE + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const txt = await r.text();
  let j = {}; try { j = JSON.parse(txt); } catch (e) { j = { _raw: txt.slice(0, 200) }; }
  return { status: r.status, body: j };
}
const dir = mkdtempSync(path.join(tmpdir(), 'bp-cards-'));
const srv = spawn(process.execPath, ['server.js'], {
  cwd: fileURLToPath(new URL('.', import.meta.url)),
  env: { ...process.env, PORT: String(PORT), DB_PATH: path.join(dir, 'db.sqlite'), ADMIN_KEY: KEY,
    TEST_TOPUP: '1', YOOKASSA_SHOP_ID: '', YOOKASSA_SECRET_KEY: '', BOT_TOKEN: '', ADMIN_CHAT_ID: '' },
  stdio: 'ignore',
});
async function waitUp() {
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) return true; } catch (e) {}
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}
async function reg(tag, role) {
  const r = await api('POST', '/api/register', { email: `cd${tag}@t.ru`, name: 'Юзер ' + tag, role, password: 'парольВ12345' });
  return { token: r.body.token, id: r.body.user && r.body.user.id };
}
/* карточка в том виде, в каком её кладёт мастер: со служебными полями */
function card(name) {
  return {
    name, initials: 'ЮТ', col: '#2f6ce0,#1b49a8', catsText: 'Еда · Техника',
    sinceText: 'сегодня', subsVal: '15.6K', reachVal: '40K', erVal: '4.2%', cpvVal: '0.35 ₽',
    publishedAt: new Date(2026, 8, 4).toISOString(), msg: 'Пишите, отвечаю быстро',
    platforms: ['youtube', 'telegram'], topics: ['food', 'tech'],
    platData: {
      youtube: { url: 'https://youtube.com/@test', subs: 12400, er: 4.2, reach: 30000, verified: true, enabled: true },
      telegram: { url: 'https://t.me/test', subs: 3200, er: 4.1, reach: 10000, verified: true, enabled: true },
    },
    integrations: { youtube: [{ fmtId: 'yt_pre', price: 12000 }] },
    genderF: 60, genderM: 40, kids: 5, showGender: true, showKids: false,
    /* служебное — в каталог попасть не должно */
    userId: 1757000000000, userEmail: 'secret@example.com', srvId: 999, hidden: 1,
    socsHtml: '<img src=x onerror="alert(1)">', rating: 5, reviews: 99,
  };
}
try {
  console.log('\nОбщий каталог карточек');
  ok(await waitUp(), 'сервер поднялся');

  const empty = await api('GET', '/api/cards');
  ok(empty.status === 200 && Array.isArray(empty.body.rows) && empty.body.rows.length === 0, 'пустой каталог виден без входа', empty.body);

  const tag = Date.now();
  const blg = await reg('b' + tag, 'blogger');      /* телефон 1 */
  const adv = await reg('a' + tag, 'advertiser');   /* другой человек */
  ok(blg.token && adv.token, 'блогер и рекламодатель зарегистрированы');

  const anon = await api('POST', '/api/cards', { id: 'mycard_1', card: card('Аноним') });
  ok(anon.status === 401, 'без входа карточку не опубликовать', anon.body);

  const put = await api('POST', '/api/cards', { id: 'mycard_' + tag, card: card('Блогер Один') }, blg.token);
  ok(put.status === 200, 'карточка опубликована с телефона 1', put.body);

  /* ── то, ради чего всё это: второй телефон и посторонний видят карточку ── */
  const seen = await api('GET', '/api/cards', null, adv.token);
  const row = (seen.body.rows || [])[0];
  ok(seen.body.rows.length === 1 && row.id === 'mycard_' + tag, 'карточка видна другому человеку', seen.body.rows);
  ok(row && row.userId === blg.id, 'у строки указан серверный владелец', row && row.userId);
  ok(row && row.card.name === 'Блогер Один' && row.card.subsVal === '15.6K', 'поля витрины на месте', row && row.card);
  ok(row && row.card.platData.youtube.subs === 12400 && row.card.integrations.youtube[0].price === 12000, 'площадки и цены на месте', row && row.card.platData);

  /* ── чего в витрине быть не должно ── */
  const c = (row && row.card) || {};
  ok(!('userEmail' in c), 'почта владельца не уехала в каталог');
  ok(!('userId' in c) && !('srvId' in c), 'местные id не уехали');
  ok(!('socsHtml' in c), 'чужая разметка значков не сохранена');
  ok(!('hidden' in c) && !('rating' in c), 'служебные отметки не сохранены');

  /* ── чужую карточку не перезаписать ── */
  const steal = await api('POST', '/api/cards', { id: 'mycard_' + tag, card: card('Подмена') }, adv.token);
  ok(steal.status === 403, 'чужую карточку перезаписать нельзя', steal.body);
  const after = await api('GET', '/api/cards');
  ok((after.body.rows[0] || {}).card.name === 'Блогер Один', 'карточка не изменилась после попытки подмены');

  /* ── правка со второго телефона того же человека ── */
  const upd = await api('POST', '/api/cards', { id: 'mycard_' + tag, card: Object.assign(card('Блогер Один'), { subsVal: '20K' }) }, blg.token);
  const afterUpd = await api('GET', '/api/cards');
  ok(upd.status === 200 && afterUpd.body.rows[0].card.subsVal === '20K', 'правка видна сразу, без ожидания кэша', afterUpd.body.rows[0].card.subsVal);

  /* ── мусор и пределы ── */
  const noName = await api('POST', '/api/cards', { id: 'mycard_x' + tag, card: { name: '' } }, blg.token);
  ok(noName.status === 400, 'карточка без имени не принимается', noName.body);
  const badId = await api('POST', '/api/cards', { id: 'ой!', card: card('Плохой номер') }, blg.token);
  ok(badId.status === 400, 'кривой номер карточки отклонён', badId.body);
  const badUrl = await api('POST', '/api/cards', { id: 'mycard_u' + tag,
    card: Object.assign(card('Ссылка'), { platData: { youtube: { url: 'javascript:alert(1)', subs: 1 } } }) }, blg.token);
  const urlRow = (await api('GET', '/api/cards')).body.rows.find((r) => r.id === 'mycard_u' + tag);
  ok(badUrl.status === 200 && urlRow && !urlRow.card.platData.youtube, 'ссылка javascript: выброшена', urlRow && urlRow.card.platData);
  const badAva = await api('POST', '/api/cards', { id: 'mycard_a' + tag,
    card: Object.assign(card('Фото'), { avatar: 'https://example.com/me.jpg' }) }, blg.token);
  const avaRow = (await api('GET', '/api/cards')).body.rows.find((r) => r.id === 'mycard_a' + tag);
  ok(badAva.status === 200 && avaRow && !avaRow.card.avatar, 'фото по чужой ссылке не сохранено', avaRow && avaRow.card.avatar);
  const goodAva = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';
  await api('POST', '/api/cards', { id: 'mycard_a' + tag, card: Object.assign(card('Фото'), { avatar: goodAva }) }, blg.token);
  const avaRow2 = (await api('GET', '/api/cards')).body.rows.find((r) => r.id === 'mycard_a' + tag);
  ok(avaRow2 && avaRow2.card.avatar === goodAva, 'вшитое фото сохраняется', avaRow2 && String(avaRow2.card.avatar).slice(0, 20));

  const fourth = await api('POST', '/api/cards', { id: 'mycard_z' + tag, card: card('Четвёртая') }, blg.token);
  ok(fourth.status === 409, 'больше трёх карточек на аккаунт нельзя', fourth.body);

  /* ── рубильник владельца площадки ── */
  const hide = await api('POST', '/api/admin/cards/hide', { id: 'mycard_' + tag, hidden: true }, null, true);
  const hidden = await api('GET', '/api/cards');
  ok(hide.status === 200 && !hidden.body.rows.some((r) => r.id === 'mycard_' + tag), 'скрытая карточка исчезла из каталога', hide.body);
  const notAdmin = await api('POST', '/api/admin/cards/hide', { id: 'mycard_' + tag, hidden: false }, blg.token);
  ok(notAdmin.status === 403, 'скрывать может только владелец площадки', notAdmin.body);
  await api('POST', '/api/admin/cards/hide', { id: 'mycard_' + tag, hidden: false }, null, true);
  ok((await api('GET', '/api/cards')).body.rows.some((r) => r.id === 'mycard_' + tag), 'карточку вернули в каталог');

  /* ── удаление ── */
  const delAlien = await api('POST', '/api/cards/delete', { id: 'mycard_' + tag }, adv.token);
  ok(delAlien.status === 200 && delAlien.body.removed === 0, 'чужую карточку удалить нельзя', delAlien.body);
  const del = await api('POST', '/api/cards/delete', { id: 'mycard_' + tag }, blg.token);
  const gone = await api('GET', '/api/cards');
  ok(del.body.removed === 1 && !gone.body.rows.some((r) => r.id === 'mycard_' + tag), 'свою — можно, и она пропала у всех', del.body);

  /* ── заблокированный аккаунт исчезает из витрины ──
     Ручки «заблокировать» на сервере нет (отметку ставят в базе), поэтому
     ставим её прямо в базу — проверяем именно фильтр каталога. */
  const dbw = new DatabaseSync(path.join(dir, 'db.sqlite'));
  dbw.prepare('UPDATE users SET is_blocked = 1 WHERE id = ?').run(blg.id);
  dbw.close();
  /* чужая публикация сбрасывает кэш витрины — ждать его срок не нужно */
  await api('POST', '/api/cards', { id: 'mycard_adv' + tag, card: card('Рекламодатель') }, adv.token);
  const afterBlock = await api('GET', '/api/cards');
  ok(!afterBlock.body.rows.some((r) => r.userId === blg.id), 'карточки заблокированного не показываются', afterBlock.body.rows.map((r) => r.userId));
  ok(afterBlock.body.rows.some((r) => r.userId === adv.id), 'карточки остальных на месте');
} catch (e) {
  failed++; console.log('  FAIL исключение: ' + e.message);
} finally {
  srv.kill();
}
console.log(`\nИтого: ${passed} ok, ${failed} FAIL\n`);
process.exit(failed ? 1 : 0);
