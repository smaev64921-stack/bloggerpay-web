/* Проверка личности перед выводом: заявка с фото паспорта и селфи, решения оператора.
   Проверяем: отправку, статусы, переотправку, повтор после отказа,
   защиту от кривых данных и от решения по уже решённой заявке.
   Запуск: node test-kyc.mjs (сервер должен работать). */

import { readFileSync } from 'node:fs';

const BASE = 'http://127.0.0.1:8090';
const ADMIN_KEY = /ADMIN_KEY=(\S+)/.exec(readFileSync(new URL('./.env', import.meta.url), 'utf8'))[1];

let passed = 0, failed = 0;
function ok(c, name, extra) {
  if (c) { passed++; console.log('  ok  ' + name); }
  else { failed++; console.log('  FAIL ' + name + (extra ? '  ← ' + JSON.stringify(extra) : '')); }
}
async function api(method, path, body, token, admin) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  if (admin) headers['X-Admin-Key'] = ADMIN_KEY;
  const res = await fetch(BASE + path, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

/* однопиксельный jpeg — роль фото паспорта в тесте */
const PHOTO = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';
/* однопиксельный png — роль селфи с паспортом */
const SELFIE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

const tag = Date.now();
console.log('\nВерификация личности перед выводом');

const u1 = await api('POST', '/api/register', { email: `k1${tag}@t.ru`, name: 'Проверяемый', role: 'blogger', password: 'парольБ12345' });
const T1 = u1.body.token;

/* до заявки статуса нет */
const s0 = await api('GET', '/api/kyc/status', null, T1);
ok(s0.status === 200 && s0.body.status === 'none', 'до заявки статус none', s0.body);

/* кривые данные не проходят */
const bad1 = await api('POST', '/api/kyc/submit', { name: 'Иван', birth: '01.01.1990', photo: PHOTO, selfie: SELFIE }, T1);
ok(bad1.status === 400, 'одно слово вместо ФИО отклонено', bad1.body);
const bad2 = await api('POST', '/api/kyc/submit', { name: 'Иванов Иван', birth: '1990-01-01', photo: PHOTO, selfie: SELFIE }, T1);
ok(bad2.status === 400, 'дата не в формате ДД.ММ.ГГГГ отклонена', bad2.body);
const bad3 = await api('POST', '/api/kyc/submit', { name: 'Иванов Иван', birth: '01.01.1990', photo: 'привет', selfie: SELFIE }, T1);
ok(bad3.status === 400, 'не-картинка вместо фото отклонена', bad3.body);
const bad4 = await api('POST', '/api/kyc/submit', { name: 'Иванов Иван', birth: '01.01.1990', photo: PHOTO, selfie: SELFIE }, null);
ok(bad4.status === 401, 'без входа заявку не подать', bad4.body);
const bad5 = await api('POST', '/api/kyc/submit', { name: 'Иванов Иван', birth: '01.01.1990', photo: PHOTO }, T1);
ok(bad5.status === 400 && /селфи/i.test(bad5.body.error || ''), 'без селфи заявка не принята', bad5.body);

/* нормальная заявка встаёт в очередь */
const sub = await api('POST', '/api/kyc/submit', { name: 'Иванов Иван Иванович', birth: '01.01.1990', photo: PHOTO, selfie: SELFIE }, T1);
ok(sub.status === 200 && sub.body.status === 'queued', 'заявка принята в очередь', sub.body);
const reqId = sub.body.requestId;

const s1 = await api('GET', '/api/kyc/status', null, T1);
ok(s1.body.status === 'queued', 'статус queued', s1.body);

/* переотправка до решения обновляет ту же заявку, а не плодит новые */
const re = await api('POST', '/api/kyc/submit', { name: 'Иванов Пётр Иванович', birth: '02.02.1992', photo: PHOTO, selfie: SELFIE }, T1);
ok(re.status === 200 && re.body.requestId === reqId, 'переотправка обновила ту же заявку', re.body);

/* оператор видит заявку; фото — отдельным запросом, не в списке */
const list = await api('GET', '/api/admin/kyc?status=queued', null, null, true);
const mine = (list.body.rows || []).find((r) => r.id === reqId);
ok(!!mine && mine.name === 'Иванов Пётр Иванович' && mine.photo === undefined && mine.selfie === undefined && mine.has_photo === 1 && mine.has_selfie === 1,
   'оператор видит заявку с отметками о двух фото, самих фото в списке нет', mine && { name: mine.name, has_photo: mine.has_photo });
const ph = await api('GET', '/api/admin/kyc/photo?id=' + reqId, null, null, true);
ok(ph.status === 200 && ph.body.photo === PHOTO, 'фото отдаётся по одному', { len: (ph.body.photo || '').length });
const sf = await api('GET', '/api/admin/kyc/photo?id=' + reqId + '&kind=selfie', null, null, true);
ok(sf.status === 200 && sf.body.photo === SELFIE && sf.body.kind === 'selfie', 'селфи отдаётся отдельным запросом', sf.body && { kind: sf.body.kind, len: (sf.body.photo || '').length });
const noKey = await api('GET', '/api/admin/kyc', null, null, false);
ok(noKey.status === 403, 'без ключа оператора списка нет', noKey.body);

/* решение по устаревшему снимку заявки отклоняется */
const stale = await api('POST', '/api/admin/kyc/approve', { requestId: reqId, seenAt: '2000-01-01 00:00:00' }, null, true);
ok(stale.status === 409, 'approve по устаревшему seenAt отклонён', stale.body);

/* подтверждение со свежим seenAt */
const app = await api('POST', '/api/admin/kyc/approve', { requestId: reqId, seenAt: mine.updated_at }, null, true);
ok(app.status === 200 && app.body.status === 'approved', 'оператор подтвердил', app.body);
const s2 = await api('GET', '/api/kyc/status', null, T1);
ok(s2.body.status === 'approved', 'человек видит approved', s2.body);
const twice = await api('POST', '/api/admin/kyc/approve', { requestId: reqId }, null, true);
ok(twice.status === 409, 'повторное решение по той же заявке отклонено', twice.body);
const again = await api('POST', '/api/kyc/submit', { name: 'Иванов Пётр Иванович', birth: '02.02.1992', photo: PHOTO, selfie: SELFIE }, T1);
ok(again.status === 200 && again.body.status === 'approved' && again.body.already, 'после подтверждения новая заявка не нужна', again.body);

/* отказ и повторная попытка */
const u2 = await api('POST', '/api/register', { email: `k2${tag}@t.ru`, name: 'Отклонённый', role: 'blogger', password: 'парольБ12345' });
const T2 = u2.body.token;
const sub2 = await api('POST', '/api/kyc/submit', { name: 'Петров Пётр Петрович', birth: '03.03.1993', photo: PHOTO, selfie: SELFIE }, T2);
const rej = await api('POST', '/api/admin/kyc/reject', { requestId: sub2.body.requestId, note: 'Фото не читается' }, null, true);
ok(rej.status === 200 && rej.body.status === 'rejected', 'оператор отклонил', rej.body);
const s3 = await api('GET', '/api/kyc/status', null, T2);
ok(s3.body.status === 'rejected' && s3.body.note === 'Фото не читается', 'человек видит отказ с причиной', s3.body);
const sub3 = await api('POST', '/api/kyc/submit', { name: 'Петров Пётр Петрович', birth: '03.03.1993', photo: PHOTO, selfie: SELFIE }, T2);
ok(sub3.status === 200 && sub3.body.status === 'queued' && sub3.body.requestId !== sub2.body.requestId,
   'после отказа новая заявка встаёт в очередь', sub3.body);

/* сводка считает очередь верификации (sub3 ещё в очереди) */
const ov0 = await api('GET', '/api/admin/overview', null, null, true);
ok(ov0.status === 200 && Number(ov0.body.верификаций_в_очереди) >= 1, 'сводка видит очередь верификации', ov0.body.верификаций_в_очереди);

/* вывод закрыт, пока личность не подтверждена — и на сервере тоже */
const { randomUUID } = await import('node:crypto');
await api('POST', '/api/topup', { amount: 5000, opKey: randomUUID() }, T2);
const wdNo = await api('POST', '/api/withdraw', { amount: 1000, requisites: 'карта 0000', opKey: randomUUID() }, T2);
ok(wdNo.status === 403, 'вывод без подтверждённой личности отклонён сервером', wdNo.body);
await api('POST', '/api/admin/kyc/approve', { requestId: sub3.body.requestId }, null, true);
/* Вывод двухшаговый: первый запрос шлёт код и не двигает деньги.
   Здесь проверяется гейт KYC, а не почта, поэтому код берём из ответа
   (сервер для прогона поднят с MAIL_DEBUG=1). Если почта не настроена,
   сервер пропускает второй фактор сам и заявка создаётся сразу. */
let wdYes = await api('POST', '/api/withdraw', { amount: 1000, requisites: 'карта 0000', opKey: randomUUID() }, T2);
if (wdYes.body && wdYes.body.needCode && wdYes.body.devCode) {
  wdYes = await api('POST', '/api/withdraw',
    { amount: 1000, requisites: 'карта 0000', code: wdYes.body.devCode, opKey: randomUUID() }, T2);
}
ok(wdYes.status === 200 && wdYes.body.status === 'queued', 'после подтверждения вывод проходит', wdYes.body);

console.log(`\nИтого: ${passed} ok, ${failed} fail\n`);
process.exit(failed ? 1 : 0);
