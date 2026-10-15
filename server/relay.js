/* ══════════════════════════════════════════════════════════════════════
   Ретранслятор: два сервера BloggerPay вместо одного (16.10.2026).

   Зачем. Сайт, касса и база живут на московском сервере, чтобы приложение
   быстро открывалось в России. Но из российского дата-центра плохо или
   совсем не открываются площадки: Телеграм (бот, тревоги, вход), TikTok,
   Instagram, YouTube, почта Resend. Поэтому прежний сервер в Нидерландах
   остался вторым: московский ходит к этим площадкам через него.

   В файле две половины:

   · installFetchRelay(env) — работает в Москве. Подменяет глобальный
     fetch: запрос к площадке из списка уходит на
     RELAY_URL/__relay/<хост><путь>, всё остальное (ЮKassa, свои адреса,
     заглушки тестов на localhost) идёт напрямую. server.js, bot.js,
     mail.js и push.js при этом не меняются: подмена ловит и адреса,
     вписанные в код, и те, что заданы переменными (TG_API_BASE и т. п.).
     Если ретранслятор не ответил, запрос сам повторяется напрямую: хуже,
     чем без ретранслятора, не станет.

   · runRelay() — работает в Нидерландах (BP_MODE=relay). Своей базы и
     бота у него нет, на старом адресе он делает три вещи:
       /__relay/…  — пересылает запрос площадке и отдаёт ответ как есть;
       файлы подтверждения сайта (tiktok….txt) и правовые страницы — отдаёт
                     сам: по старому адресу их проверяют TikTok и Google;
       остальное   — GET переадресует на MOVED_TO (туда же площадки
                     возвращают человека после входа: OAUTH_BASE в
                     server.js — это старый адрес), а обратные вызовы
                     площадок (/api/verify/…, вебхук оплаты) пересылает в
                     Москву телом один в один.

   Ключ. Обе стороны вычисляют его из BOT_TOKEN (HMAC), заводить отдельный
   секрет не нужно; RELAY_KEY перекрывает его, если ключ захочется сменить.
   Без ключа ретранслятор не пускает никого. Это не открытый прокси:
   список хостов у него тоже свой.
   ══════════════════════════════════════════════════════════════════════ */

'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');

/* Площадки, которые из России открываются плохо или не открываются
   вовсе. Совпадение — сам домен или любой его поддомен. RELAY_HOSTS
   (через запятую) заменяет список целиком. */
const DEFAULT_HOSTS = [
  'telegram.org',                                 /* бот, тревоги, вход через Телеграм */
  'tiktok.com', 'tiktokapis.com', 'tiktokv.com', 'tiktokcdn.com', 'tiktokcdn-us.com',
  'instagram.com', 'cdninstagram.com', 'facebook.com', 'fbcdn.net',
  'youtube.com', 'youtu.be', 'ytimg.com', 'googleapis.com', 'accounts.google.com',
  'resend.com',                                   /* письма с кодом */
];

function hostList(raw) {
  const s = String(raw || '').trim();
  const list = s ? s.split(/[\s,;]+/) : DEFAULT_HOSTS;
  return list.map((h) => h.trim().toLowerCase().replace(/^\*?\./, '')).filter(Boolean);
}

function hostAllowed(host, list) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '');
  return !!h && list.some((e) => h === e || h.endsWith('.' + e));
}

/* Ключ всегда 64 hex-символа: в заголовок HTTP нельзя положить кириллицу,
   поэтому даже свой RELAY_KEY не отправляется как есть, а хешируется. */
function relayKey(env) {
  const own = String(env.RELAY_KEY || '').trim();
  const tok = String(env.BOT_TOKEN || '').trim();
  if (!own && !tok) return '';
  return crypto.createHmac('sha256', own || tok).update(own ? 'bp-relay-own-1' : 'bp-relay-1').digest('hex');
}

function sameKey(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
}

/* Отправить тело второй раз (напрямую, когда ретранслятор не ответил)
   можно, только если это не поток: поток уже прочитан первой попыткой. */
function bodyReusable(b) {
  return b == null || typeof b === 'string' || b instanceof URLSearchParams
    || b instanceof ArrayBuffer || ArrayBuffer.isView(b)
    || (typeof Blob !== 'undefined' && b instanceof Blob)
    || (typeof FormData !== 'undefined' && b instanceof FormData);
}

const why = (e) => String((e && (e.cause && e.cause.code || e.message)) || e);

/* ── Москва: fetch через ретранслятор ──────────────────────────────── */

function makeRelayFetch(env, direct) {
  const base = String(env.RELAY_URL || '').trim().replace(/\/+$/, '');
  let baseHost = '';
  try { baseHost = new URL(base).host.toLowerCase(); } catch (e) { return null; }
  if (!/^https?:$/.test(new URL(base).protocol)) return null;
  const key = relayKey(env);
  if (!key) return null;
  const hosts = hostList(env.RELAY_HOSTS);
  const stats = { relayed: 0, direct: 0, fallback: 0 };
  let warnedAt = 0;

  /* Только через ретранслятор, без запасного пути. Ответ ретранслятора о
     собственной беде (нет ключа, хост не из списка, площадка не открылась)
     помечен заголовком x-bp-relay-error. */
  async function viaRelay(u, opts) {
    const mode = opts.redirect === 'manual' || opts.redirect === 'error' ? opts.redirect : 'follow';
    const headers = new Headers(opts.headers || undefined);
    headers.set('x-bp-relay', key);
    headers.set('x-bp-relay-redirect', mode);
    const res = await direct(base + '/__relay/' + u.hostname + u.pathname + u.search,
      Object.assign({}, opts, { headers, redirect: 'manual' }));
    const failed = res.headers.get('x-bp-relay-error');
    if (!failed) {
      /* Код смотрит на res.url (куда привела переадресация), поэтому
         показываем адрес площадки, а не ретранслятора. */
      const finalUrl = res.headers.get('x-bp-relay-url') || u.href;
      try { Object.defineProperty(res, 'url', { value: finalUrl, configurable: true }); } catch (e) { /* не страшно */ }
    }
    return { res, failed };
  }

  async function relayFetch(input, init) {
    let u = null;
    if (typeof input === 'string' || input instanceof URL) {
      try { u = new URL(String(input)); } catch (e) { u = null; }
    }
    if (!u || u.protocol !== 'https:' || u.port || u.host.toLowerCase() === baseHost
      || !hostAllowed(u.hostname, hosts)) {
      stats.direct += 1;
      return direct(input, init);
    }
    const opts = Object.assign({}, init || {});
    let res = null, failed = '', err = null;
    try { ({ res, failed } = await viaRelay(u, opts)); } catch (e) { err = e; }
    /* Вызывающий сам передумал (истекло его время) — это не беда
       ретранслятора, повторять напрямую нечего. */
    if (err && opts.signal && opts.signal.aborted) throw err;
    if (res && !failed) {
      stats.relayed += 1;
      if (opts.redirect === 'error' && res.status >= 300 && res.status < 400) {
        throw new TypeError('fetch failed: unexpected redirect');
      }
      return res;
    }
    if (!bodyReusable(opts.body)) {
      if (res) return res;
      throw err;
    }
    if (res && res.body) { try { await res.body.cancel(); } catch (e) { /* уже закрыт */ } }
    stats.fallback += 1;
    if (Date.now() - warnedAt > 60000) {
      warnedAt = Date.now();
      console.warn('[ретранслятор] ' + base + (res ? ' ответил ' + res.status + ' (' + failed + ')' : ' не ответил (' + why(err) + ')')
        + ' — запрос к ' + u.hostname + ' пошёл напрямую');
    }
    return direct(input, init);
  }

  relayFetch.__bpRelay = { base, hosts, stats, viaRelay };
  return relayFetch;
}

/* Сводка в журнал при запуске: что открывается напрямую, а что только
   через Нидерланды. По ней видно, зачем ретранслятор и жив ли он. */
const REPORT_URLS = [
  'https://api.telegram.org/', 'https://open.tiktokapis.com/', 'https://www.tiktok.com/',
  'https://graph.instagram.com/', 'https://www.youtube.com/', 'https://www.googleapis.com/',
  'https://api.resend.com/',
];

async function relayReport(relay, direct) {
  const probe = async (fn) => {
    const t = Date.now();
    try {
      const r = await fn({ method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(7000) });
      if (r.failed) return 'нет (' + r.failed + ')';
      return 'да, ' + (Date.now() - t) + ' мс';
    } catch (e) {
      return 'нет (' + (e && e.name === 'TimeoutError' ? '7 с без ответа' : why(e)) + ')';
    }
  };
  const lines = await Promise.all(REPORT_URLS.map(async (url) => {
    const u = new URL(url);
    const [d, r] = await Promise.all([
      probe(async (o) => ({ res: await direct(url, o) })),
      probe((o) => relay.__bpRelay.viaRelay(u, o)),
    ]);
    return '  ' + u.hostname + ': напрямую — ' + d + '; через ретранслятор — ' + r;
  }));
  console.log('[ретранслятор] доступность площадок отсюда:\n' + lines.join('\n'));
}

function installFetchRelay(env) {
  const e = env || process.env;
  if (!String(e.RELAY_URL || '').trim()) return false;
  if (globalThis.fetch && globalThis.fetch.__bpRelay) return true;
  const direct = globalThis.fetch;
  const relay = makeRelayFetch(e, direct);
  if (!relay) {
    console.error('[ретранслятор] RELAY_URL задан, но ретранслятор не включён: нужен адрес вида'
      + ' https://… и BOT_TOKEN (или RELAY_KEY). Площадки идут напрямую.');
    return false;
  }
  globalThis.fetch = relay;
  console.log('[ретранслятор] Телеграм, TikTok, Instagram, YouTube и почта — через ' + relay.__bpRelay.base);
  if (String(e.RELAY_REPORT || '') !== '0') {
    setTimeout(() => { relayReport(relay, direct).catch(() => {}); }, 4000).unref();
  }
  return true;
}

/* ── Нидерланды: сам ретранслятор (BP_MODE=relay) ───────────────────── */

const DROP_REQ = new Set(['host', 'connection', 'keep-alive', 'proxy-connection', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'content-length', 'accept-encoding', 'expect',
  'forwarded', 'via', 'x-real-ip', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto',
  'x-forwarded-port', 'x-forwarded-server', 'cdn-loop']);
const DROP_RES = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding',
  'content-encoding', 'content-length', 'trailer', 'upgrade']);
const dropReq = (k) => DROP_REQ.has(k) || k.startsWith('x-bp-') || k.startsWith('cf-');

/* Файлы, которые площадки читают по старому адресу: подтверждение сайта
   для TikTok и правовые страницы из кабинетов TikTok и Google. На них
   нужен прямой ответ 200, переадресация не годится. */
const SITE_FILES = {
  '/terms.html': 'text/html; charset=utf-8',
  '/privacy.html': 'text/html; charset=utf-8',
};
const SIGN_RE = /^\/(tiktok[A-Za-z0-9]{8,64}\.txt)$/;

/* Куда пускать не-GET запросы со старого адреса: обратные вызовы
   площадок (отзыв доступа и удаление данных у Meta, проверка канала) и
   вебхук оплаты. Входы, деньги и прочее API по старому адресу больше не
   работают — сайт переехал, и пускать перебор паролей в обход Москвы
   незачем. RELAY_PASS (через запятую) заменяет список. */
const DEFAULT_PASS = ['/api/verify/', '/api/pay/webhook'];

function readAll(req, limit) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let n = 0;
    req.on('data', (c) => {
      n += c.length;
      if (n > limit) { reject(Object.assign(new Error('слишком большое тело'), { status: 413 })); req.destroy(); return; }
      parts.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}

function runRelay(opt) {
  const http = require('node:http');
  const { Readable } = require('node:stream');
  const env = (opt && opt.env) || process.env;
  const key = relayKey(env);
  const hosts = hostList(env.RELAY_HOSTS);
  const moved = String(env.MOVED_TO || '').trim().replace(/\/+$/, '');
  const pass = String(env.RELAY_PASS || '').trim()
    ? String(env.RELAY_PASS).split(/[\s,;]+/).filter(Boolean) : DEFAULT_PASS;
  /* Только для тестов: все пересылки уходят на эту заглушку, а исходный
     хост едет в заголовке x-bp-test-host. */
  const testUp = String(env.RELAY_TEST_UPSTREAM || '').trim().replace(/\/+$/, '');
  const ROOT = path.join(__dirname, '..');
  const ports = (String(env.RELAY_PORTS || '').trim() ? String(env.RELAY_PORTS).split(',') : [env.PORT, 3000, 8090])
    .map(Number).filter((p, i, a) => p > 0 && a.indexOf(p) === i);
  const errAt = new Map();

  const logErr = (tag, msg) => {
    if (Date.now() - (errAt.get(tag) || 0) < 60000) return;
    errAt.set(tag, Date.now());
    console.error('[ретранслятор] ' + msg);
  };
  const fail = (res, status, code, msg) => {
    if (res.headersSent) { res.destroy(); return; }
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'x-bp-relay-error': code, 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ error: msg }));
  };
  const pipeBack = (req, res, up, extra) => {
    const h = {};
    up.headers.forEach((v, k) => { if (!DROP_RES.has(k) && k !== 'set-cookie') h[k] = v; });
    const cookies = typeof up.headers.getSetCookie === 'function' ? up.headers.getSetCookie() : [];
    if (cookies.length) h['set-cookie'] = cookies;
    Object.assign(h, extra || {});
    res.writeHead(up.status, h);
    if (req.method === 'HEAD' || !up.body || up.status === 204 || up.status === 304) {
      if (up.body) up.body.cancel().catch(() => {});
      res.end();
      return;
    }
    const s = Readable.fromWeb(up.body);
    s.on('error', () => res.destroy());
    s.pipe(res);
  };
  /* Запрос клиента оборвался — обрываем и запрос к площадке: иначе
     длинный опрос Телеграма висел бы впустую. */
  const abortOnClose = (res) => {
    const ac = new AbortController();
    res.on('close', () => { if (!res.writableEnded) ac.abort(); });
    return ac;
  };

  async function relayOut(req, res, raw) {
    if (!key) return fail(res, 503, 'nokey', 'ретранслятор без ключа: нужен BOT_TOKEN или RELAY_KEY');
    if (!sameKey(req.headers['x-bp-relay'], key)) return fail(res, 403, 'auth', 'не тот ключ ретранслятора');
    const m = /^\/__relay\/([a-z0-9.-]+)(\/[^?#]*)?(\?[^#]*)?$/i.exec(raw);
    if (!m) return fail(res, 400, 'path', 'адрес не разобран');
    const host = m[1].toLowerCase();
    if (!hostAllowed(host, hosts)) return fail(res, 403, 'host', 'хост не из списка ретранслятора: ' + host);
    const mode = req.headers['x-bp-relay-redirect'] === 'follow' || !req.headers['x-bp-relay-redirect'] ? 'follow' : 'manual';
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (!dropReq(k)) headers[k] = v;
    let body;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      try { body = await readAll(req, 50 * 1024 * 1024); } catch (e) { return fail(res, e.status || 400, 'body', 'тело запроса не прочитано'); }
    }
    const origin = 'https://' + host;
    const target = (testUp || origin) + (m[2] || '/') + (m[3] || '');
    if (testUp) headers['x-bp-test-host'] = host;
    const ac = abortOnClose(res);
    let up;
    try {
      up = await fetch(target, { method: req.method, headers, body, redirect: mode, signal: ac.signal });
    } catch (e) {
      if (ac.signal.aborted) return;
      logErr('up:' + host, host + ' не открылся: ' + why(e));
      return fail(res, 502, 'upstream', host + ': ' + why(e));
    }
    let finalUrl = up.url || target;
    if (testUp && finalUrl.startsWith(testUp)) finalUrl = origin + finalUrl.slice(testUp.length);
    pipeBack(req, res, up, { 'x-bp-relay-url': finalUrl });
  }

  async function siteFile(req, res, pathname, type) {
    /* Сначала — свежая копия из Москвы (тексты правят там), при сбое —
       своя, из того же репозитория. */
    if (moved) {
      try {
        const r = await fetch(moved + pathname, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
        if (r.status === 200) {
          const buf = Buffer.from(await r.arrayBuffer());
          res.writeHead(200, { 'Content-Type': r.headers.get('content-type') || type, 'Cache-Control': 'no-cache' });
          return res.end(req.method === 'HEAD' ? undefined : buf);
        }
        r.body && r.body.cancel().catch(() => {});
      } catch (e) { /* Москва молчит — отдаём своё */ }
    }
    fs.readFile(path.join(ROOT, path.basename(pathname)), (err, buf) => {
      if (err) return fail(res, 404, 'nofile', 'нет файла');
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : buf);
    });
  }

  async function passIn(req, res, raw) {
    if (!moved) return fail(res, 503, 'moved', 'новый адрес не задан (MOVED_TO)');
    let body;
    try { body = await readAll(req, 20 * 1024 * 1024); } catch (e) { return fail(res, e.status || 400, 'body', 'тело запроса не прочитано'); }
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (!dropReq(k)) headers[k] = v;
    const ac = abortOnClose(res);
    let up;
    try {
      up = await fetch(moved + raw, { method: req.method, headers, body: body.length ? body : undefined,
        redirect: 'manual', signal: AbortSignal.any([ac.signal, AbortSignal.timeout(60000)]) });
    } catch (e) {
      if (ac.signal.aborted) return;
      logErr('in', 'новый адрес ' + moved + ' не ответил: ' + why(e));
      return fail(res, 502, 'moved', 'новый адрес не ответил');
    }
    pipeBack(req, res, up);
  }

  async function handler(req, res) {
    const raw = String(req.url || '/');
    if (raw.startsWith('/__relay/')) return relayOut(req, res, raw);
    const pathname = raw.split('?')[0];
    if (pathname === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ ok: true, mode: 'relay', movedTo: moved || null, key: !!key }));
    }
    const get = req.method === 'GET' || req.method === 'HEAD';
    if (get && SITE_FILES[pathname]) return siteFile(req, res, pathname, SITE_FILES[pathname]);
    if (get && SIGN_RE.test(pathname)) return siteFile(req, res, pathname, 'text/plain; charset=utf-8');
    if (!moved) return fail(res, 503, 'moved', 'BloggerPay переезжает — загляните через минуту');
    if (get) {
      /* 302, а не 301: постоянную переадресацию браузер запомнит навсегда,
         и вернуть старый адрес было бы уже нельзя. */
      res.writeHead(302, { Location: moved + (raw.startsWith('/') ? raw : '/' + raw), 'Cache-Control': 'no-store' });
      return res.end();
    }
    if (pass.some((p) => pathname.startsWith(p))) return passIn(req, res, raw);
    return fail(res, 410, 'moved', 'BloggerPay переехал: ' + moved);
  }

  const onReq = (req, res) => {
    handler(req, res).catch((e) => {
      logErr('500', 'сбой: ' + why(e));
      fail(res, 500, 'crash', 'сбой ретранслятора');
    });
  };
  for (const port of ports) {
    const srv = http.createServer(onReq);
    srv.on('error', (e) => {
      if (e && e.code === 'EADDRINUSE') { console.warn('[ретранслятор] порт ' + port + ' занят — пропускаем'); return; }
      console.error('[ретранслятор] порт ' + port + ': ' + why(e));
    });
    srv.listen(port, '0.0.0.0', () => console.log('[ретранслятор] слушаю 0.0.0.0:' + port));
  }
  console.log('[ретранслятор] режим BP_MODE=relay: базы и бота здесь нет.'
    + ' Старый адрес ведёт на ' + (moved || '(MOVED_TO не задан!)')
    + '; площадки: ' + hosts.join(', ') + (key ? '' : '; КЛЮЧА НЕТ — нужен BOT_TOKEN или RELAY_KEY'));
}

module.exports = { installFetchRelay, makeRelayFetch, runRelay, hostList, hostAllowed, relayKey, DEFAULT_HOSTS };
