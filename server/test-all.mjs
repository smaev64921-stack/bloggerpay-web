/* Прогон всех проверок по порядку. Порядок важен: test-guard проверяет
   отпор перебору ключа владельца и в конце отрезает свой адрес от
   админских ручек на десять минут — поэтому он идёт последним.
   Запуск: npm test (сервер должен работать на 8090). */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const SUITES = [
  'test-scenario.mjs', 'test-kyc.mjs', 'test-verify.mjs', 'test-pay.mjs',
  'test-partial.mjs', 'test-disputes.mjs', 'test-alerts.mjs', 'test-bot.mjs',
  'test-telegram.mjs', 'test-mail.mjs',
  'test-guard.mjs',                       /* последним: блокирует адрес */
];

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
