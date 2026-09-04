/* Прогон всех проверок по порядку. Порядок важен: test-guard проверяет
   отпор перебору ключа владельца и в конце отрезает свой адрес от
   админских ручек на десять минут — поэтому он идёт последним.

   ВАЖНО про повторный прогон: счётчик неудачных попыток живёт в памяти
   сервера, и сразу после предыдущего прогона половина наборов упадёт с
   «Слишком много попыток» — это не поломка кода. Перед повторным
   прогоном перезапустите сервер на 8090 (или подождите десять минут).

   Запуск: npm test (сервер должен работать на 8090). */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const SUITES = [
  'test-scenario.mjs', 'test-kyc.mjs', 'test-verify.mjs', 'test-pay.mjs',
  'test-partial.mjs', 'test-disputes.mjs', 'test-alerts.mjs', 'test-bot.mjs',
  'test-telegram.mjs', 'test-mail.mjs', 'test-return.mjs', 'test-forge.mjs', 'test-leaderboard.mjs', 'test-cards.mjs', 'test-admin-session.mjs', 'test-google-login.mjs', 'test-sync.mjs', 'test-chan-migrate.mjs', 'test-tg-login.mjs',
  'test-guard.mjs',                       /* последним: блокирует адрес */
];

/* Перед стартом: не заперт ли ключ владельца.
   test-guard в конце прошлого прогона нарочно перебирает ключ, и сервер
   отрезает наш адрес от админских ручек на десять минут. Следующий
   прогон в это окно валит половину наборов — и выглядит это как поломка
   кода, хотя сломан только сторож. Проверяем это сразу и говорим прямо. */
const KEY = /ADMIN_KEY=(\S+)/.exec(readFileSync(join(here, '.env'), 'utf8'))[1];
try {
  const BASE = process.env.BP_TEST_BASE || 'http://127.0.0.1:8090';
  const r = await fetch(BASE + '/api/admin/overview', { headers: { 'X-Admin-Key': KEY } });
  if (r.status !== 200) {
    console.log('');
    console.log('Ключ владельца сейчас не работает (ответ ' + r.status + ').');
    console.log('Скорее всего он заперт сторожем после прошлого прогона test-guard.');
    console.log('Перезапустите сервер и повторите — иначе половина наборов упадёт зря.');
    console.log('');
    process.exit(1);
  }
} catch (e) {
  console.log('');
  console.log('Сервер не отвечает по адресу '
    + (process.env.BP_TEST_BASE || 'http://127.0.0.1:8090') + ' — запустите его и повторите.');
  console.log('');
  process.exit(1);
}

let bad = 0;
const lines = [];
for (const s of SUITES) {
  const r = spawnSync(process.execPath, [join(here, s)], { encoding: 'utf8' });
  const out = (r.stdout || '') + (r.stderr || '');
  const tail = (out.match(/(Итого|Итог)[^\n]*/g) || []).pop()
    || (out.match(/✓[^\n]*/g) || []).pop()
    || (r.status === 0 ? 'прошло' : 'упало без итога');
  if (r.status !== 0) bad++;
  lines.push((r.status === 0 ? '  ok  ' : '  FAIL ') + s.padEnd(20) + tail.trim());
}
console.log('\nВсе проверки BloggerPay\n');
console.log(lines.join('\n'));
console.log(bad ? `\nУпало наборов: ${bad}\n` : '\nВсё зелёное\n');
process.exit(bad ? 1 : 0);
