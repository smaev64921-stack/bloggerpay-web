/* ══════════════════════════════════════════════════════════════════════
   BloggerPay — почта. Отправка писем через Resend и вёрстка письма с
   кодом (вход и восстановление пароля).

   Почему Resend, а не SMTP: сервер живёт без зависимостей (node:http,
   node:sqlite). Resend — это обычный HTTPS-запрос, его делает встроенный
   fetch. Ключ (re_…) лежит в server/.env как RESEND_API_KEY и НИКОГДА
   не попадает ни в приложение, ни в репозиторий.

   Два внешних входа:
     renderCodeEmail({ code, kind, minutes, email })  → { subject, html, text }
     sendMail({ to, subject, html, text })            → { ok, id?, error? }
     sendCodeEmail({ to, code, kind, minutes })       → удобная обёртка

   Если ключа нет (RESEND_API_KEY пуст) — режим «на сухую»: письмо не
   уходит, а печатается в консоль. Удобно для локальной отладки, не роняет
   поток восстановления пароля, если почта ещё не настроена.
   ══════════════════════════════════════════════════════════════════════ */

'use strict';

const RESEND_URL = 'https://api.resend.com/emails';

/* Читается лениво из process.env — server.js кладёт туда .env целиком. */
function cfg() {
  const appRaw = String(process.env.APP_URL || '').trim().replace(/\/+$/, '');
  /* Без схемы адрес — не адрес, а относительная ссылка: почтовый клиент
     раскроет её от СВОЕГО домена (mail.google.com/…/app.example.com) и
     человек упрётся в 404. Лучше письмо совсем без кнопки и логотипа —
     оно и так рабочее, код в нём напечатан — чем письмо с кнопкой,
     которая обещает открыть приложение и никуда не ведёт. */
  const app = /^https?:\/\//i.test(appRaw) ? appRaw : '';
  const srvRaw = String(process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
  const srv = /^https?:\/\//i.test(srvRaw) ? srvRaw : '';
  return {
    key: String(process.env.RESEND_API_KEY || '').trim(),
    from: String(process.env.MAIL_FROM || 'BloggerPay <onboarding@resend.dev>').trim(),
    replyTo: String(process.env.MAIL_REPLY_TO || '').trim(),
    /* Адрес мини-аппа — на него ведёт кнопка «Вернуться на сайт». */
    appUrl: app,
    /* Логотип В ПИСЬМЕ ДОЛЖЕН ЛЕЖАТЬ ОТДЕЛЬНЫМ ФАЙЛОМ ПО HTTPS.
       Вшить его в письмо (data:base64) нельзя: Gmail такие картинки
       вырезает — вместо знака был бы пустой квадрат.

       По умолчанию берём с САМОГО СЕРВЕРА (он отдаёт /logo.jpg): он
       обязан быть доступен, иначе и ссылка в письме не откроется. Сайт
       приложения — запасной вариант: он может быть ещё не выложен. */
    logoUrl: String(
      process.env.MAIL_LOGO_URL
      || (srv ? srv + '/logo.jpg' : '')
      || (app ? app + '/logo.jpg' : '')
    ).trim(),
  };
}

/* Виден ли адрес из интернета. Нужен, чтобы решить, слать ли письмо со
   ссылкой на страницу кода: проверять одну схему мало — значение по
   умолчанию http://127.0.0.1:<порт> схему имеет, и человек получил бы
   письмо БЕЗ кода и с кнопкой на собственный localhost, то есть вообще
   без способа восстановить пароль. */
function reachableOutside(u) {
  let h;
  try { h = new URL(u).hostname.toLowerCase(); } catch (e) { return false; }
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]') return false;
  if (h.endsWith('.local') || h.endsWith('.localhost')) return false;
  if (/^10\./.test(h) || /^192\.168\./.test(h)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return false;
  if (/^169\.254\./.test(h)) return false;                /* адрес «сети нет» */
  return true;
}

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/* ── Палитра письма ────────────────────────────────────────────────
   Цвета сняты с живого приложения (слой bp-onb, который висит на html
   постоянно и перекрашивает всё приложение): синий #2f6ce0, а не
   фиолетовый из базового :root. Мерено computed-стилем в браузере —
   грепать литералы в файле бесполезно, их перекрывают слои. */
const C = {
  bg: '#08080b', card: '#121218', panel: '#0d0d12',
  line: '#22222b', box: '#1f1f28', boxLine: '#31313d',
  ink: '#ffffff', mut: '#b9bcc4', dim: '#7d818c',
  acc: '#2f6ce0', acc2: '#1b49a8', accT: '#5b93f5',
};

const KIND = {
  login:  { title: 'Код для входа',            lead: 'Введите этот код в приложении BloggerPay, чтобы войти.' },
  reset:  { title: 'Восстановление пароля',     lead: 'Вы запросили сброс пароля. Введите код в приложении, чтобы задать новый.' },
  verify: { title: 'Подтверждение почты',       lead: 'Введите код в приложении, чтобы подтвердить адрес.' },
  /* Вывод денег. Текст намеренно называет сумму и реквизиты: если заявку
     создал не хозяин аккаунта, именно здесь он это увидит — код в письме
     оказывается последней преградой между вором и деньгами. */
  withdraw: { title: 'Подтверждение вывода',    lead: 'Вы запросили вывод средств. Введите код в приложении, чтобы заявка ушла оператору.' },
};

/* Тексты для письма-ссылки: кода внутри нет, он ждёт на странице. */
const KIND_LINK = {
  login:  { title: 'Вход в BloggerPay',      lead: 'Нажмите кнопку — откроется страница, где будет ваш код для входа.' },
  reset:  { title: 'Восстановление пароля',  lead: 'Нажмите кнопку — откроется страница, где будет ваш код. Мы не печатаем его прямо в письме, чтобы он не появлялся в уведомлениях на экране телефона.' },
  verify: { title: 'Подтверждение почты',    lead: 'Нажмите кнопку — откроется страница, где будет ваш код подтверждения.' },
  withdraw: { title: 'Подтверждение вывода', lead: 'Вы запросили вывод средств. Нажмите кнопку — откроется страница с кодом подтверждения.' },
};

/* Один разряд кода в своей рамке — привычный вид одноразового кода. */
function digitCell(d) {
  return (
    '<td class="bp-digit" align="center" valign="middle" width="42" '
    + 'style="width:42px;height:54px;background:' + C.box + ';border:1px solid ' + C.boxLine + ';'
    + 'border-radius:11px;font-family:\'SFMono-Regular\',Consolas,\'Liberation Mono\',Menlo,monospace;'
    + 'font-size:26px;font-weight:700;color:' + C.ink + ';mso-line-height-rule:exactly;line-height:54px;">'
    + esc(d) + '</td>'
  );
}

function codeBoxes(code) {
  const digits = String(code).split('');
  let cells = '';
  digits.forEach((d, i) => {
    if (i) cells += '<td width="6" style="width:6px;font-size:0;line-height:0;">&nbsp;</td>';
    cells += digitCell(d);
  });
  return (
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" '
    + 'style="margin:0 auto;"><tr>' + cells + '</tr></table>'
  );
}

/* ── Само письмо ───────────────────────────────────────────────────
   Табличная вёрстка и инлайновые стили — так письмо одинаково выглядит
   в Gmail, Apple Mail, Outlook и мобильных клиентах. Единственная
   внешняя картинка — логотип; если её не показали, на месте знака
   остаётся синий квадрат с буквой, а не пустая рамка.

   Ширину держат ДВА механизма, и оба нужны. Обычные клиенты слушают
   max-width:480px. Outlook для Windows рисует движком Word, а тот
   max-width не понимает вовсе — для него письмо растянулось бы на всю
   ширину окна: строки текста по 1300 пикселей и код, потерянный
   посередине. Поэтому вокруг стоит «призрачная» таблица в условном
   комментарии <!--[if mso]-->: её видит только Outlook, и она жёстко
   задаёт 480. Остальные клиенты этот комментарий пропускают. */
function renderCodeEmail(opts) {
  const o = opts || {};
  const code = String(o.code || '').trim();
  const kind = KIND[o.kind] ? o.kind : 'reset';
  const minutes = Number(o.minutes) > 0 ? Math.round(Number(o.minutes)) : 10;
  const minWord = pluralMin(minutes);

  /* Два вида письма. Со ссылкой — кода внутри нет, он ждёт на странице
     (не светится в уведомлениях, не достаётся почтовым сканерам).
     Без ссылки — старый вид с кодом: так письмо остаётся рабочим, даже
     когда сервер не виден снаружи и открывать страницу негде. */
  const linkUrl = /^https?:\/\//i.test(String(o.linkUrl || '')) ? String(o.linkUrl) : '';
  const K = linkUrl ? KIND_LINK[kind] : KIND[kind];

  /* В теме и в предпросмотре кода тоже нет — иначе вся затея теряет
     смысл: именно их и видно в списке писем и на заблокированном экране. */
  const subject = linkUrl ? K.title : (K.title + ' · код ' + code);
  const preheader = linkUrl
    ? 'Нажмите «Открыть» — код на странице. Ссылка живёт ' + minutes + ' мин.'
    : (K.title + ': ' + code + '. Код действует ' + minutes + ' мин.');

  const { appUrl, logoUrl } = cfg();

  /* Знак отправителя. Картинка лежит на хостинге; на подложку ставим тот
     же синий, что и в приложении — пока картинка не загрузилась (или её
     запретил клиент), человек видит фирменный квадрат с буквой, а не
     сломанную иконку. */
  const logoCell = logoUrl
    ? '<td valign="middle" width="34" style="width:34px;height:34px;background:' + C.acc
      + ';background-image:linear-gradient(135deg,' + C.acc + ',' + C.acc2 + ');border-radius:9px;'
      + 'text-align:center;mso-line-height-rule:exactly;line-height:34px;">'
      /* alt пустой намеренно. Слово «BloggerPay» стоит текстом сразу
         справа, поэтому картинка здесь — украшение, а не сообщение:
         с подписью читалка озвучила бы название дважды. Заодно это
         лучший вид при отказе — если картинку не отдали или человек
         запретил показ, остаётся чистый фирменный квадрат, а не значок
         сломанного изображения с текстом поверх. */
      + '<img src="' + esc(logoUrl) + '" width="34" height="34" alt="" role="presentation"'
      + ' style="width:34px;height:34px;display:block;border:0;border-radius:9px;outline:none;text-decoration:none;">'
      + '</td>'
    : '<td valign="middle" width="34" style="width:34px;height:34px;background:' + C.acc
      + ';background-image:linear-gradient(135deg,' + C.acc + ',' + C.acc2 + ');border-radius:9px;'
      + 'text-align:center;font-family:\'Manrope\',-apple-system,\'Segoe UI\',Arial,sans-serif;'
      + 'font-size:19px;font-weight:800;color:#ffffff;mso-line-height-rule:exactly;line-height:34px;">Б</td>';

  /* Кнопка «Вернуться на сайт». Ведёт на мини-апп и сразу открывает шаг
     ввода кода, уже заполненный: человеку не нужно ничего переписывать
     руками. Код в ссылке — это тот же код, что напечатан рядом в письме,
     поэтому ничего нового ссылка не раскрывает. */
  const backUrl = (appUrl && !linkUrl)
    ? appUrl + '#/recover?code=' + encodeURIComponent(code)
      + (o.to ? '&email=' + encodeURIComponent(String(o.to)) : '')
    : '';
  /* Письмо-ссылка: вместо цифр — одна кнопка. Ниже неё тот же адрес
     обычной строкой: часть почтовых клиентов режет кнопки-таблицы, и
     без запасной ссылки человек остался бы вообще без пути. */
  const openBlock = !linkUrl ? '' : `
          <tr><td align="center" style="padding:2px 0 18px;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center"><tr>
              <td align="center" bgcolor="${C.acc}" style="border-radius:14px;background:${C.acc};background-image:linear-gradient(135deg,${C.acc},${C.acc2});">
                <a href="${esc(linkUrl)}" target="_blank" style="display:block;padding:16px 40px;font-family:'Manrope',-apple-system,'Segoe UI',Arial,sans-serif;font-size:16px;font-weight:800;color:#ffffff;text-decoration:none;border-radius:14px;">Открыть</a>
              </td>
            </tr></table>
          </td></tr>

          <tr><td align="center" style="font-family:'Manrope',-apple-system,'Segoe UI',Arial,sans-serif;font-size:12.5px;font-weight:600;color:${C.dim};padding:0 6px 16px;">
            Ссылка живёт <span style="color:${C.accT};font-weight:700;">${minutes} ${minWord}</span> и открывается один раз для вас
          </td></tr>

          <tr><td align="center" style="font-family:'Manrope',-apple-system,'Segoe UI',Arial,sans-serif;font-size:11px;font-weight:500;line-height:17px;color:${C.dim};padding:0 4px 18px;word-break:break-all;">
            Кнопка не нажимается? Откройте адрес вручную:<br>
            <a href="${esc(linkUrl)}" target="_blank" style="color:${C.accT};text-decoration:underline;">${esc(linkUrl)}</a>
          </td></tr>`;

  const backBtn = backUrl
    ? `
          <tr><td align="center" style="padding:2px 0 20px;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center"><tr>
              <td align="center" bgcolor="${C.acc}" style="border-radius:14px;background:${C.acc};background-image:linear-gradient(135deg,${C.acc},${C.acc2});">
                <a href="${esc(backUrl)}" target="_blank" style="display:block;padding:15px 34px;font-family:'Manrope',-apple-system,'Segoe UI',Arial,sans-serif;font-size:15px;font-weight:800;color:#ffffff;text-decoration:none;border-radius:14px;">Вернуться на сайт</a>
              </td>
            </tr></table>
          </td></tr>

          <tr><td align="center" style="font-family:'Manrope',-apple-system,'Segoe UI',Arial,sans-serif;font-size:12px;font-weight:500;line-height:19px;color:${C.dim};padding:0 8px 20px;">
            Кнопка откроет BloggerPay с уже вписанным кодом — набирать вручную не нужно.
          </td></tr>`
    : '';

  const html =
`<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark">
<meta name="supported-color-schemes" content="dark">
<title>${esc(subject)}</title>
<style>
  /* Узкие экраны: разряды кода сжимаются, а не уезжают за край.
     Клиенты без поддержки @media просто покажут базовый размер. */
  @media only screen and (max-width:420px){
    .bp-digit{width:38px!important;height:50px!important;font-size:23px!important;line-height:50px!important;}
    .bp-codepad{padding:18px 12px!important;}
    .bp-card{padding:26px 16px 22px!important;}
    .bp-title{font-size:21px!important;}
  }
</style>
</head>
<body style="margin:0;padding:0;background:${C.bg};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${C.bg};font-size:1px;line-height:1px;">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.bg}" style="background:${C.bg};margin:0;padding:0;">
  <tr><td align="center" style="padding:30px 14px;">
    <!--[if mso]><table role="presentation" width="480" align="center" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" align="center" style="width:100%;max-width:480px;margin:0 auto;">

      <!-- Шапка: знак + логотип -->
      <tr><td align="center" style="padding:0 0 22px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center"><tr>
          ${logoCell}
          <td width="9" style="width:9px;">&nbsp;</td>
          <td valign="middle" style="font-family:'Manrope',-apple-system,'Segoe UI',Arial,sans-serif;font-size:18px;font-weight:800;letter-spacing:-.2px;color:${C.ink};">BloggerPay</td>
        </tr></table>
      </td></tr>

      <!-- Карточка -->
      <tr><td class="bp-card" style="background:${C.card};border:1px solid ${C.line};border-radius:20px;padding:32px 22px 26px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">

          <tr><td align="center" style="font-family:'Manrope',-apple-system,'Segoe UI',Arial,sans-serif;font-size:12px;font-weight:800;letter-spacing:1.6px;text-transform:uppercase;color:${C.accT};padding:0 0 10px;">Одноразовый код</td></tr>

          <tr><td class="bp-title" align="center" style="font-family:'Manrope',-apple-system,'Segoe UI',Arial,sans-serif;font-size:23px;font-weight:800;letter-spacing:-.3px;color:${C.ink};padding:0 0 8px;">${esc(K.title)}</td></tr>

          <tr><td align="center" style="font-family:'Manrope',-apple-system,'Segoe UI',Arial,sans-serif;font-size:14px;font-weight:500;line-height:22px;color:${C.mut};padding:0 6px 26px;">${esc(K.lead)}</td></tr>

          ${linkUrl ? openBlock : `
          <!-- Код -->
          <tr><td align="center" style="padding:0 0 14px;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="background:${C.panel};border:1px solid ${C.line};border-radius:16px;">
              <tr><td class="bp-codepad" style="padding:22px 20px 16px;">${codeBoxes(code)}</td></tr>
              <!-- Тот же код одной строкой. Разряды выше разложены по
                   ячейкам таблицы: выделить их пальцем и скопировать не
                   выходит — между ячейками рвётся выделение. Здесь код
                   лежит цельной строкой, её долгое нажатие берёт
                   целиком. Кнопки «Скопировать» в письме быть не может:
                   почта не выполняет скрипты, ни у кого. -->
              <tr><td align="center" style="padding:0 20px 20px;">
                <div style="font-family:'Manrope',-apple-system,'Segoe UI',Arial,sans-serif;font-size:11px;font-weight:600;color:${C.dim};padding:0 0 5px;">скопировать одной строкой</div>
                <div style="font-family:'SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace;font-size:17px;font-weight:700;letter-spacing:3px;color:${C.accT};-webkit-user-select:all;user-select:all;">${esc(code)}</div>
              </td></tr>
            </table>
          </td></tr>

          <tr><td align="center" style="font-family:'Manrope',-apple-system,'Segoe UI',Arial,sans-serif;font-size:13px;font-weight:600;color:${C.dim};padding:4px 0 20px;">
            Код действует <span style="color:${C.accT};font-weight:700;">${minutes} ${minWord}</span>
          </td></tr>
${backBtn}
          `}

          <tr><td style="border-top:1px solid ${C.line};font-size:0;line-height:0;">&nbsp;</td></tr>

          <tr><td style="font-family:'Manrope',-apple-system,'Segoe UI',Arial,sans-serif;font-size:12.5px;font-weight:500;line-height:20px;color:${C.dim};padding:20px 2px 0;">
            Если вы не запрашивали код — просто не обращайте на письмо внимания и никому его не сообщайте. Сотрудники BloggerPay никогда не спрашивают код.
          </td></tr>

        </table>
      </td></tr>

      <!-- Подвал -->
      <tr><td align="center" style="font-family:'Manrope',-apple-system,'Segoe UI',Arial,sans-serif;font-size:11.5px;font-weight:500;line-height:18px;color:${C.dim};padding:22px 10px 0;">
        Это письмо отправлено автоматически, отвечать на него не нужно.<br>
        BloggerPay — оплата рекламы у блогеров без риска.
      </td></tr>

    </table>
    <!--[if mso]></td></tr></table><![endif]-->
  </td></tr>
</table>
</body>
</html>`;

  const text = linkUrl
    ? `${K.title}

${K.lead}

Откройте страницу — код будет там:
${linkUrl}

Ссылка живёт ${minutes} ${minWord}.

Если вы не запрашивали код — не обращайте внимания на это письмо и никому не пересылайте ссылку.

BloggerPay`
    : `${K.title}

Ваш код: ${code}
${K.lead}

Код действует ${minutes} ${minWord}.
${backUrl ? '\nВернуться на сайт (код подставится сам):\n' + backUrl + '\n' : ''}
Если вы не запрашивали код — не обращайте внимания на это письмо и никому его не сообщайте.

BloggerPay`;

  return { subject, html, text };
}

function pluralMin(n) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return 'минут';
  if (b > 1 && b < 5) return 'минуты';
  if (b === 1) return 'минуту';
  return 'минут';
}

/* ── Отправка ──────────────────────────────────────────────────────
   Возвращает { ok, id? , error? , dryRun? }. Никогда не бросает: тот,
   кто вызывает (восстановление пароля), не должен падать из-за почты. */
async function sendMail(msg) {
  const { key, from, replyTo } = cfg();
  const to = Array.isArray(msg.to) ? msg.to : [msg.to];

  if (!key) {
    /* Почта не настроена. В журнал — ТОЛЬКО факт и адрес: тема письма
       содержит сам код, а журналы читают и хранят куда шире, чем память
       процесса, ради которой код и держат отпечатком. */
    console.log('[почта] RESEND_API_KEY пуст — письмо НЕ отправлено. Кому: ' + to.join(', '));
    return { ok: false, dryRun: true, error: 'MAIL_NOT_CONFIGURED' };
  }

  const payload = {
    from,
    to,
    subject: msg.subject,
    html: msg.html,
    text: msg.text,
  };
  if (replyTo) payload.reply_to = replyTo;

  try {
    const r = await fetch(RESEND_URL, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + key,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(12000),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const reason = (data && (data.message || data.name)) || ('HTTP ' + r.status);
      console.error('[почта] Resend отклонил письмо: ' + reason);
      return { ok: false, error: reason, status: r.status };
    }
    return { ok: true, id: data && data.id };
  } catch (e) {
    const reason = (e && e.message) || String(e);
    console.error('[почта] письмо не ушло: ' + reason);
    return { ok: false, error: reason };
  }
}

async function sendCodeEmail(opts) {
  const mail = renderCodeEmail(opts);
  return sendMail({ to: opts.to, subject: mail.subject, html: mail.html, text: mail.text });
}

module.exports = { renderCodeEmail, sendMail, sendCodeEmail, reachableOutside, mailConfigured: () => !!cfg().key };
