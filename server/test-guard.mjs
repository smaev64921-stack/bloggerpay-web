/* Защита денег и доступа: одноразовость кода вывода, права владельца,
   отпор перебору ключа. Запуск: node test-guard.mjs (сервер должен работать). */

import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const BASE = 'http://127.0.0.1:8090';
const ADMIN_KEY = /ADMIN_KEY=(\S+)/.exec(readFileSync(new URL('./.env', import.meta.url), 'utf8'))[1];
const PIX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';

let passed = 0, failed = 0;
function ok(c, name, extra) {
  if (c) { passed++; console.log('  ok  ' + name); }
  else { failed++; console.log('  FAIL ' + name + (extra ? '  ← ' + JSON.stringify(extra) : '')); }
}
async function api(method, path, body, token, adminKey) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  if (adminKey) headers['X-Admin-Key'] = adminKey;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const tag = Date.now();
console.log('\nЗащита денег и доступа');

/* готовим человека, которому можно выводить */
const u = await api('POST', '/api/register', { email: `g${tag}@t.ru`, name: 'Выводящий', role: 'blogger', password: 'обычныйПароль12' });
const T = u.body.token;
await api('POST', '/api/topup', { amount: 50000, opKey: randomUUID() }, T);
const kyc = await api('POST', '/api/kyc/submit', { name: 'Иванов Иван Иванович', birth: '01.01.1990', photo: PIX, selfie: PIX }, T);
await api('POST', '/api/admin/kyc/approve', { requestId: kyc.body.requestId }, null, ADMIN_KEY);

/* ── один код — одна заявка ── */
const first = await api('POST', '/api/withdraw', { amount: 1000, requisites: 'карта 1111', opKey: randomUUID() }, T);
ok(first.status === 200 && first.body.needCode === true, 'первый запрос только шлёт код и денег не трогает', first.body);
const code = first.body.devCode;
ok(!!code, 'код доступен в отладочном режиме');

/* пять одновременных попыток с одним кодом и разными ключами операции */
const salvo = await Promise.all([1, 2, 3, 4, 5].map(() =>
  api('POST', '/api/withdraw', { amount: 1000, requisites: 'карта 1111', code, opKey: randomUUID() }, T)));
const created = salvo.filter((r) => r.status === 200 && r.body.status === 'queued').length;
ok(created === 1, 'по одному коду создаётся ровно одна заявка', { создано: created, ответы: salvo.map((r) => r.status) });

/* тот же код повторно уже не работает */
const again = await api('POST', '/api/withdraw', { amount: 1000, requisites: 'карта 1111', code, opKey: randomUUID() }, T);
ok(again.status === 400 && again.body.dead === true, 'использованный код помечен как мёртвый', again.body);

/* ── неверный код: попытки считаются, признак dead=false ── */
const w2 = await api('POST', '/api/withdraw', { amount: 1000, requisites: 'карта 2222', opKey: randomUUID() }, T);
const bad = await api('POST', '/api/withdraw', { amount: 1000, requisites: 'карта 2222', code: '000000', opKey: randomUUID() }, T);
ok(bad.status === 400 && bad.body.dead === false, 'неверный код оставляет попытку, код ещё жив', bad.body);
const right = await api('POST', '/api/withdraw', { amount: 1000, requisites: 'карта 2222', code: w2.body.devCode, opKey: randomUUID() }, T);
ok(right.status === 200 && right.body.status === 'queued', 'после промаха верный код проходит', right.body);

/* ── сумма изменилась — нужен новый код ── */
const w3 = await api('POST', '/api/withdraw', { amount: 1000, requisites: 'карта 3333', opKey: randomUUID() }, T);
const other = await api('POST', '/api/withdraw', { amount: 2000, requisites: 'карта 3333', code: w3.body.devCode, opKey: randomUUID() }, T);
ok(other.status === 400 && other.body.dead === true, 'код не подходит к другой сумме', other.body);

/* ── перебор ключа владельца упирается в стену ── */
let blocked = 0;
for (let i = 0; i < 12; i++) {
  const r = await api('GET', '/api/admin/overview', null, null, 'x'.repeat(ADMIN_KEY.length));
  if (r.status === 403) blocked++;
}
ok(blocked === 12, 'неверный ключ всегда отклоняется', { отказов: blocked });
const afterBrute = await api('GET', '/api/admin/overview', null, null, ADMIN_KEY);
ok(afterBrute.status === 403, 'после перебора адрес отрезан даже с верным ключом', afterBrute.body);

console.log(`\nИтого: ${passed} ok, ${failed} fail\n`);
process.exit(failed ? 1 : 0);
