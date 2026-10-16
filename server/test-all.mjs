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
  'test-telegram.mjs', 'test-mail.mjs', 'test-return.mjs', 'test-forge.mjs', 'test-leaderboard.mjs', 'test-cards.mjs', 'test-cards-unpublish.mjs', 'test-privacy-1010.mjs','test-admin-session.mjs', 'test-admin-tg.mjs', 'test-admin-console.mjs', 'test-google-login.mjs', 'test-sync.mjs', 'test-chan-migrate.mjs', 'test-tg-login.mjs', 'test-quality.mjs',
  'test-audit.mjs',                       /* заплаты после разбора 06.09.2026 */
  'test-push.mjs',                        /* шифрование и подпись уведомлений */
  'test-push-api.mjs',                    /* подписки и доставка по событиям */
  'test-media.mjs',                       /* картинки заданий: баннеры, фото товара */
  'test-videos.mjs',                      /* «Загрузить видео» v3: загрузка с нуля, начисления 30 дней, лидерборд */
  'test-invoice.mjs',                     /* пополнение по счёту: заявка, бот, зачисление в «Счетах» */
  'test-fees.mjs', 'test-instagram.mjs', 'test-account.mjs', 'test-support.mjs',                        /* комиссии 14.10: пополнение 7% сверху, задание 7% + 7% с выплат, вывод 0% */
  'test-relay.mjs',                       /* переезд 15.10: сайт в России, площадки через Нидерланды */
  'test-ytcode.mjs',                      /* 15.10: YouTube кодом в описании канала — без экрана Google «не проверено» */
  'test-login-hijack.mjs',                /* 16.10: перехват входа Google/Телеграм, чужая привязка, повтор подписи (свой 8516) */
  'test-wake.mjs',                        /* 15.10: уведомления сразу — ждущий запрос /api/wake */
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
