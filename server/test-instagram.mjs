/* Instagram (Reels) и YouTube Shorts (15.10.2026, владелец: «добавь полностью
   соцсеть инсту и шортс»). Настоящий server.js + поддельная площадка: вход
   Instagram (код → короткий доступ → долгий, профиль), поиск ролика по
   ссылке среди публикаций аккаунта (страницы), просмотры из insights (и
   прежнее имя метрики plays), зачёт и выплата, рост и суточный круг,
   чужой ролик, фото вместо видео, нет прав, продление долгого доступа,
   отключение приложения и удаление данных по запросу Meta (signed_request).
   YouTube Shorts: задание «только Shorts» обычное видео не принимает,
   Shorts принимает и помечает. Свои порты 8494/8495. Запуск: node test-instagram.mjs */
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const PORT = 8494, FAKE = 8495, BASE = 'http://127.0.0.1:' + PORT, FK = 'http://127.0.0.1:' + FAKE, KEY = 'test-ig-key';
const IG_SECRET = 'ig-secret-test';
let passed = 0, failed = 0;
function ok(c, name, extra) {
  if (c) { passed++; console.log('  ok  ' + name); }
  else { failed++; console.log('  FAIL ' + name + (extra !== undefined ? '  ← ' + JSON.stringify(extra).slice(0, 500) : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = Date.now();

/* ── поддельная площадка ── */
const IGA = {   // аккаунты Instagram: код входа → данные
  'ig-V': { tok: 'V', uid: '17841400000000001', username: 'vanya_reels', name: 'Ваня Reels', followers: 12000 },
  'ig-K': { tok: 'K', uid: '17841400000000002', username: 'katya_reels', name: 'Катя', followers: 3100 },
};
const IGM = new Map();  // публикации: id → данные
const media = (id, owner, code, type, product, views) => IGM.set(id, { id, owner, code, type, product, views, likes: Math.round(views * 0.08), comments: Math.round(views * 0.006), shares: Math.round(views * 0.002), at: new Date(now - 60e3).toISOString() });
media('18000000000000001', 'V', 'PH0to1', 'IMAGE', 'FEED', 0);
media('18000000000000002', 'V', 'RC0de0', 'VIDEO', 'REELS', 900);
media('18000000000000003', 'V', 'RC0de1', 'VIDEO', 'REELS', 4200);
media('18000000000000004', 'K', 'KReel01', 'VIDEO', 'REELS', 7000);
media('18000000000000005', 'V', 'RC0de2', 'VIDEO', 'REELS', 2500);
const ig = { noViews: false, dead: new Set(), refreshed: [], tokens: new Map() };   // tok → long-lived token
const YCH = { 'UC-Vanya00000000000000': 'Ваня Влог' };
const YTV = new Map([
  ['ShortVid001', { ch: 'UC-Vanya00000000000000', dur: 'PT41S', views: 3000, short: true, title: 'Shorts про FitLab' }],
  ['LongVideo01', { ch: 'UC-Vanya00000000000000', dur: 'PT9M12S', views: 8000, short: false, title: 'Большой обзор FitLab' }],
  ['ShortVid002', { ch: 'UC-Vanya00000000000000', dur: 'PT55S', views: 1500, short: true, title: 'Ещё Shorts' }],
]);
const fakeLog = [];
const igMedia = (m) => ({ id: m.id, caption: 'Reels ' + m.code + ' #fitlab', media_type: m.type, media_product_type: m.product,
  permalink: 'https://www.instagram.com/' + (m.product === 'REELS' ? 'reel' : 'p') + '/' + m.code + '/', shortcode: m.code,
  thumbnail_url: 'https://scontent.cdninstagram.com/v/t51/' + m.code + '.jpg', timestamp: m.at, like_count: m.likes, comments_count: m.comments });
function tokOf(t) { for (const [k, v] of ig.tokens) if (v === t && !ig.dead.has(k)) return k; return null; }
const fake = http.createServer((req, res) => {
  let raw = ''; req.on('data', (c) => { raw += c; }); req.on('end', () => {
    const u = new URL(req.url, FK); res.setHeader('Content-Type', 'application/json');
    fakeLog.push(req.method + ' ' + u.pathname);
    const send = (code, o) => { res.statusCode = code; res.end(JSON.stringify(o)); };
    const igErr = (code, msg) => send(400, { error: { message: msg, type: 'OAuthException', code } });
    if (u.pathname === '/__set') { const m = IGM.get(u.searchParams.get('id')); if (m) m.views = Number(u.searchParams.get('views')) || 0; return send(200, {}); }
    // Instagram: код → короткий доступ
    if (u.pathname === '/oauth/access_token' && req.method === 'POST') {
      const f = new URLSearchParams(raw);
      const a = IGA[f.get('code')];
      if (!a || f.get('client_id') !== 'ig-client' || f.get('client_secret') !== IG_SECRET || f.get('grant_type') !== 'authorization_code'
          || !/\/api\/verify\/callback\/instagram$/.test(f.get('redirect_uri') || '')) {
        return send(400, { error_type: 'OAuthException', code: 400, error_message: 'Invalid authorization code' });
      }
      return send(200, { data: [{ access_token: 'short-' + a.tok, user_id: a.uid, permissions: 'instagram_business_basic,instagram_business_manage_insights' }] });
    }
    // долгий доступ и продление
    if (u.pathname === '/access_token') {
      const t = u.searchParams.get('access_token') || '';
      if (u.searchParams.get('grant_type') !== 'ig_exchange_token' || u.searchParams.get('client_secret') !== IG_SECRET || !/^short-/.test(t)) return igErr(190, 'bad exchange');
      const k = t.slice(6); const long = 'long-' + k + '-' + Math.random().toString(36).slice(2, 7);
      ig.tokens.set(k, long);
      return send(200, { access_token: long, token_type: 'bearer', expires_in: 5184000 });
    }
    if (u.pathname === '/refresh_access_token') {
      const k = tokOf(u.searchParams.get('access_token'));
      if (!k || u.searchParams.get('grant_type') !== 'ig_refresh_token') return igErr(190, 'bad refresh');
      const long = 'long2-' + k + '-' + Math.random().toString(36).slice(2, 7);
      ig.tokens.set(k, long); ig.refreshed.push(k);
      return send(200, { access_token: long, token_type: 'bearer', expires_in: 5184000 });
    }
    // данные Graph (без версии в адресе — так сервер настроен в проверке)
    if (u.pathname === '/me' || u.pathname === '/me/media' || /^\/\d+(\/insights)?$/.test(u.pathname)) {
      const k = tokOf(u.searchParams.get('access_token'));
      if (!k) return igErr(190, 'Error validating access token: Session has expired');
      const acc = Object.values(IGA).find((x) => x.tok === k);
      if (u.pathname === '/me') return send(200, { user_id: acc.uid, id: 'app-scoped-' + k, username: acc.username, name: acc.name,
        profile_picture_url: 'https://scontent.cdninstagram.com/v/pic-' + acc.username + '.jpg', followers_count: acc.followers, media_count: 40, account_type: 'MEDIA_CREATOR' });
      if (u.pathname === '/me/media') {
        const all = [...IGM.values()].filter((m) => m.owner === k);
        const page = Number(u.searchParams.get('page') || 1);
        const part = page === 1 ? all.slice(0, 2) : all.slice(2);
        const body = { data: part.map(igMedia) };
        if (page === 1 && all.length > 2) body.paging = { cursors: {}, next: FK + '/me/media?page=2&fields=' + encodeURIComponent(u.searchParams.get('fields') || '') + '&access_token=' + encodeURIComponent(u.searchParams.get('access_token')) };
        return send(200, body);
      }
      const id = u.pathname.split('/')[1], m = IGM.get(id);
      if (!m || m.owner !== k) return igErr(100, 'Unsupported get request. Object with ID does not exist');
      if (u.pathname.endsWith('/insights')) {
        const metric = String(u.searchParams.get('metric') || '');
        if (ig.noViews && /views/.test(metric)) return igErr(100, '(#100) metric[0] must be one of the following values: plays, likes, comments, shares');
        if (ig.noInsights) return igErr(10, 'Application does not have permission for this action');
        const mk = (name, value) => ({ name, period: 'lifetime', values: [{ value }] });
        return send(200, { data: [mk(/views/.test(metric) ? 'views' : 'plays', m.views), mk('likes', m.likes), mk('comments', m.comments), mk('shares', m.shares)] });
      }
      return send(200, igMedia(m));
    }
    // YouTube: Shorts ли ролик (страница сайта)
    const ms = /^\/shorts\/([\w-]{11})$/.exec(u.pathname);
    if (ms) {
      const v = YTV.get(ms[1]);
      if (v && v.short) { res.setHeader('Content-Type', 'text/html'); res.statusCode = 200; return res.end(req.method === 'HEAD' ? '' : '<html>shorts</html>'); }
      res.statusCode = 303; res.setHeader('Location', 'https://www.youtube.com/watch?v=' + ms[1]); return res.end('');
    }
    // Google: вход канала и данные роликов
    if (u.pathname === '/token') {
      const f = new URLSearchParams(raw);
      if (f.get('code') !== 'yt-V') return send(400, { error: 'invalid_grant' });
      return send(200, { access_token: 'yta-V', refresh_token: 'ytr-V', expires_in: 3600, token_type: 'Bearer' });
    }
    if (u.pathname === '/youtube/v3/channels') {
      if (String(req.headers.authorization || '') !== 'Bearer yta-V') return send(401, { error: { code: 401 } });
      return send(200, { items: [{ id: 'UC-Vanya00000000000000', snippet: { title: 'Ваня Влог', customUrl: '@vanyavlog', thumbnails: {} }, statistics: { subscriberCount: '8200', videoCount: '40', viewCount: '900000' } }] });
    }
    if (u.pathname === '/youtube/v3/videos') {
      if (u.searchParams.get('key') !== 'yt-key') return send(403, { error: { code: 403, errors: [{ reason: 'keyInvalid' }] } });
      const ids = String(u.searchParams.get('id') || '').split(',').filter(Boolean);
      return send(200, { items: ids.filter((id) => YTV.has(id)).map((id) => { const v = YTV.get(id); return { id,
        snippet: { publishedAt: new Date(now - 50e3).toISOString(), channelId: v.ch, title: v.title, channelTitle: YCH[v.ch], thumbnails: {} },
        statistics: { viewCount: String(v.views), likeCount: String(Math.round(v.views * 0.08)), commentCount: '12' },
        contentDetails: { duration: v.dur }, status: { privacyStatus: 'public' } }; }) });
    }
    send(404, {});
  });
});
await new Promise((r) => fake.listen(FAKE, '127.0.0.1', r));

/* ── настоящий сервер ── */
const dir = mkdtempSync(path.join(tmpdir(), 'bp-ig-'));
const DB = path.join(dir, 'db.sqlite');
const CWD = fileURLToPath(new URL('.', import.meta.url));
const srv = spawn(process.execPath, ['server.js'], { cwd: CWD, stdio: process.env.BP_DEBUG ? 'inherit' : 'ignore', env: {
  ...process.env, PORT: String(PORT), DB_PATH: DB, ADMIN_KEY: KEY, ADMIN_EMAIL: '', PUBLIC_URL: BASE, APP_URL: BASE + '/',
  IG_CLIENT_ID: 'ig-client', IG_CLIENT_SECRET: IG_SECRET, IG_AUTH_BASE: FK, IG_API_BASE: FK, IG_GRAPH_BASE: FK, IG_GRAPH_VER: '',
  YT_CLIENT_ID: 'yt-client', YT_CLIENT_SECRET: 'yt-secret', YT_API_BASE: FK, YT_OAUTH_BASE: FK, YT_WEB_BASE: FK, YT_API_KEY: 'yt-key',
  TT_CLIENT_KEY: '', TT_CLIENT_SECRET: '', VID_AUTO_ACCEPT_H: '', VID_TRACK_DAYS: '', VID_SYNC_FIRST_S: '0',
  BOT_TOKEN: '', ADMIN_CHAT_ID: '', RESEND_API_KEY: '', TOPUP_FEE_PCT: '0', TASK_FEE_PCT: '0', PAYOUT_FEE_PCT: '0', WITHDRAW_FEE_PCT: '0',
  TEST_TOPUP: '1', TEST_TOPUP_OPEN: '1', YOOKASSA_SHOP_ID: '', YOOKASSA_SECRET_KEY: '' } });
async function up() { for (let i = 0; i < 100; i++) { try { const r = await fetch(BASE + '/api/health'); await r.text(); if (r.ok) return true; } catch (e) {} await sleep(150); } return false; }
async function api(m, p, b, token, admin) {
  const h = { 'Content-Type': 'application/json' }; if (token) h.Authorization = 'Bearer ' + token; if (admin) h['X-Admin-Key'] = KEY;
  const r = await fetch(BASE + p, { method: m, headers: h, body: b ? JSON.stringify(b) : undefined, redirect: 'manual' });
  const t = await r.text(); let j = {}; try { j = JSON.parse(t); } catch (e) { j = { _t: t.slice(0, 200) }; } return { status: r.status, body: j, headers: r.headers };
}
const tag = Date.now().toString(36), PASS = 'пароль-подлиннее-12';
async function reg(nick, name, role) { const r = await api('POST', '/api/register', { email: nick + tag + '@t.ru', name, role, password: PASS }); return { token: r.body.token, id: r.body.user && r.body.user.id }; }
async function link(user, platform, code) {
  const st = await api('GET', '/api/verify/start?platform=' + platform, null, user.token);
  if (!st.body.nonce) return { start: st.body };
  const back = await fetch(BASE + '/api/verify/callback/' + platform + '?code=' + code + '&state=' + st.body.nonce, { redirect: 'manual' });
  await back.text();
  const claim = new URL(back.headers.get('location') || '/', BASE).searchParams.get('claim') || '';
  const c = await api('POST', '/api/verify/confirm', { nonce: st.body.nonce, claim }, user.token);
  return { st: st.body, back: back.status, confirm: c };
}
const camps = {};
async function camp(key, data, escrow, adv) {
  const rid = 'ig' + tag + key; camps[key] = rid;
  const put = await api('POST', '/api/sync/put', { kind: 'camp', rid, data: Object.assign({ id: rid, status: 'active', name: 'Задание ' + key, payMode: 'cpm', rate: 100, maxPayout: 3000, minViews: 1000,
    budget: escrow, createdAt: new Date(now - 3600e3).toISOString(), deadline: new Date(now + 14 * 864e5).toISOString() }, data) }, adv.token);
  const h = await api('POST', '/api/deals/hold', { dealId: 'camp:' + rid, amount: escrow, opKey: 'hold-' + rid }, adv.token);
  return put.status === 200 && h.status === 200;
}
const bind = (u, key, url, more) => api('POST', '/api/tasks/video/bind', Object.assign({ campId: camps[key], url, agree: true }, more || {}), u.token);
const bal = async (u) => (await api('GET', '/api/balance', null, u.token)).body;
const sync = () => api('POST', '/api/admin/task-videos/sync', { force: true }, null, true);
function signed(data, secret) {
  const b64 = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const payload = b64(JSON.stringify(Object.assign({ algorithm: 'HMAC-SHA256', issued_at: Math.floor(Date.now() / 1000) }, data)));
  const sig = b64(crypto.createHmac('sha256', secret).update(payload).digest());
  return sig + '.' + payload;
}
const form = (p, sr) => fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'signed_request=' + encodeURIComponent(sr) })
  .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

try {
  console.log('\nInstagram и YouTube Shorts');
  ok(await up(), 'сервер поднялся');
  const cfg = await api('GET', '/api/verify/config');
  const ic = cfg.body.platforms && cfg.body.platforms.instagram;
  ok(ic && ic.configured === true && ic.label === 'Instagram' && ic.redirect === BASE + '/api/verify/callback/instagram', 'Instagram в настройках площадок: ключи заданы, адрес возврата', ic);

  const ADV = await reg('adv', 'FitLab', 'advertiser'), BLG = await reg('blg', 'Ваня', 'blogger'), BL2 = await reg('blk', 'Катя', 'blogger');
  await api('POST', '/api/topup', { amount: 100000, opKey: 'top-' + tag }, ADV.token);

  /* 1 · вход Instagram */
  const st = await api('GET', '/api/verify/start?platform=instagram', null, BLG.token);
  const au = st.body.url ? new URL(st.body.url) : null;
  ok(au && au.origin === FK && au.pathname === '/oauth/authorize' && au.searchParams.get('client_id') === 'ig-client'
    && au.searchParams.get('response_type') === 'code' && /instagram_business_basic/.test(au.searchParams.get('scope') || '')
    && /instagram_business_manage_insights/.test(au.searchParams.get('scope') || '') && au.searchParams.get('enable_fb_login') === '0'
    && au.searchParams.get('force_authentication') === '1' && au.searchParams.get('redirect_uri') === BASE + '/api/verify/callback/instagram'
    && au.searchParams.get('state') === st.body.nonce, 'вход: адрес авторизации Instagram — client_id, права basic + insights, только Instagram, каждый раз заново', st.body.url);
  const lv = await link(BLG, 'instagram', 'ig-V');
  ok(lv.back === 302 && lv.confirm.status === 200 && lv.confirm.body.platform === 'instagram' && lv.confirm.body.subs === 12000,
    'код → короткий доступ → долгий (60 дней) → профиль: Instagram подтверждён (12 000 подписчиков)', lv.confirm.body);
  ok(fakeLog.includes('GET /access_token') && fakeLog.includes('GET /me'), 'сервер обменял короткий доступ на долгий и спросил профиль', fakeLog.slice(-6));
  const lst = await api('GET', '/api/verify/list', null, BLG.token);
  const row = (lst.body.rows || []).find((r) => r.platform === 'instagram');
  ok(row && row.external_id === '17841400000000001' && row.username === 'vanya_reels' && row.subs === 12000 && /instagram\.com\/vanya_reels\/$/.test(row.url || ''),
    'канал записан: id профессионального аккаунта, ник, подписчики, адрес профиля', row);
  const bad = await link(BLG, 'instagram', 'wrong-code');
  ok(bad.back !== 302 && !(bad.confirm.body && bad.confirm.body.ok), 'неверный код Instagram — подтверждения нет (страница ошибки вместо возврата)', { back: bad.back, c: bad.confirm && bad.confirm.body });
  const acc = await api('GET', '/api/tasks/video/accounts', null, BLG.token);
  const ia = (acc.body.accounts || []).find((a) => a.platform === 'instagram');
  ok(ia && ia.handle === '@vanya_reels' && ia.ready === true && /^https:\/\//.test(ia.avatar), 'окно «Загрузка видео»: аккаунт Instagram @vanya_reels готов', ia);
  ok((await link(BL2, 'instagram', 'ig-K')).confirm.status === 200, 'второй блогер подключил свой Instagram (@katya_reels)');

  /* 2 · задание с Instagram, загрузка Reels */
  ok(await camp('A', { platforms: 'tt,inst' }, 20000, ADV), 'задание «TikTok, Instagram» с бюджетом 20 000 ₽');
  ok(await camp('B', { platforms: 'tt' }, 10000, ADV), 'задание только для TikTok');
  const b1 = await bind(BLG, 'A', 'Смотри мой рилс https://www.instagram.com/reel/RC0de1/?igsh=MWl0Z3c', { platform: 'instagram', account: '17841400000000001' });
  const v1 = b1.body.video || {};
  ok(b1.status === 200 && v1.platform === 'instagram' && v1.videoId === '18000000000000003' && v1.views === 4200 && v1.kind === 'reels'
    && v1.url === 'https://www.instagram.com/reel/RC0de1/' && v1.handle === 'vanya_reels' && v1.player === 'https://www.instagram.com/reel/RC0de1/embed/'
    && /cdninstagram/.test(v1.cover || '') && v1.status === 'review', 'Reels найден по ссылке среди публикаций (на второй странице): 4 200 просмотров из статистики, пометка reels, плеер', { st: b1.status, v1, err: b1.body.error });
  ok(fakeLog.filter((x) => x === 'GET /me/media').length >= 2 && fakeLog.some((x) => /^GET \/18000000000000003\/insights$/.test(x)), 'поиск прошёл обе страницы публикаций и взял статистику ролика', fakeLog.slice(-8));
  const again = await bind(BLG, 'A', 'https://www.instagram.com/reel/RC0de1/');
  ok(again.status === 409 && again.body.code === 'taken', 'тот же Reels второй раз — «уже загружено»', again.body);
  const photo = await bind(BLG, 'A', 'https://www.instagram.com/p/PH0to1/');
  ok(photo.status === 409 && photo.body.code === 'not_video' && /Reels/.test(photo.body.error), 'фото вместо видео — «в задания принимаются только Reels»', photo.body);
  const alien = await bind(BLG, 'A', 'https://www.instagram.com/reel/KReel01/');
  ok(alien.status === 409 && alien.body.code === 'not_yours' && alien.body.platform === 'instagram', 'чужой Reels (другого блогера) — «не с ваших подключённых аккаунтов»', alien.body);
  const prof = await bind(BLG, 'A', 'https://www.instagram.com/vanya_reels/');
  ok(prof.status === 400 && prof.body.code === 'bad_url' && /Instagram/.test(prof.body.error), 'ссылка на профиль, а не на ролик — «не ссылка на видео TikTok, YouTube или Instagram»', prof.body);
  const wp = await bind(BLG, 'B', 'https://www.instagram.com/reel/RC0de0/');
  ok(wp.status === 409 && wp.body.code === 'wrong_platform' && /TikTok/.test(wp.body.error), 'в задании только TikTok — Reels не принимается', wp.body);
  const wl = await bind(BLG, 'A', 'https://www.instagram.com/reel/RC0de0/', { platform: 'tiktok' });
  ok(wl.status === 400 && wl.body.code === 'wrong_link' && /Instagram-аккаунт/.test(wl.body.error), 'ссылка Instagram при выбранном TikTok — подсказка «выберите Instagram-аккаунт»', wl.body);
  /* #27: длину ролика Instagram не отдаёт — правило «мин. N сек» сервер не
     проверил; не молча: пометка durUnchecked у ролика (её видят обе стороны) */
  ok(await camp('L', { platforms: 'inst', minDuration: 15, videoMinSec: 15 }, 5000, ADV), 'задание только для Instagram с минимальной длиной 15 сек');
  const dur = await bind(BLG, 'L', 'https://www.instagram.com/reel/RC0de2/');
  const vd = dur.body.video || {};
  ok(dur.status === 200 && vd.status === 'review' && vd.duration === null && vd.durUnchecked === 15,
    'Reels в задание «мин. 15 сек»: принят, длина помечена «не проверена сервером» (durUnchecked 15)', dur.body);
  ok(v1.durUnchecked === null, 'в задании без минимальной длины пометки нет', { durUnchecked: v1.durUnchecked });
  const vda = (await api('GET', '/api/tasks/video?id=' + vd.id, null, ADV.token)).body.video || {};
  ok(vda.durUnchecked === 15, 'рекламодатель видит пометку в карточке ролика', { durUnchecked: vda.durUnchecked });

  /* 3 · зачёт, выплата, рост и суточный круг */
  const rv = await api('POST', '/api/tasks/video/review', { id: v1.id, ok: true }, ADV.token);
  let g = {};
  for (let i = 0; i < 30; i++) { g = (await api('GET', '/api/tasks/video?id=' + v1.id, null, BLG.token)).body.video || {}; if (g.status === 'active' && g.paid >= 420) break; await sleep(300); }
  ok(rv.status === 200 && g.status === 'active' && g.paid === 420, 'засчитано: 4 200 просмотров × 100 ₽ / 1 000 — начислено 420 ₽', { rv: rv.body, g: { status: g.status, paid: g.paid, views: g.views } });
  ok((await bal(BLG)).available === 420, 'у блогера на балансе 420 ₽');
  await fetch(FK + '/__set?id=18000000000000003&views=12000');
  await sync();
  g = (await api('GET', '/api/tasks/video?id=' + v1.id, null, BLG.token)).body.video || {};
  ok(g.views === 12000 && g.paid === 1200, 'суточный круг: просмотров 12 000 — доначислено до 1 200 ₽', { views: g.views, paid: g.paid });
  ig.noViews = true;
  await fetch(FK + '/__set?id=18000000000000003&views=15000');
  await sync();
  ig.noViews = false;
  g = (await api('GET', '/api/tasks/video?id=' + v1.id, null, BLG.token)).body.video || {};
  ok(g.views === 15000 && g.paid === 1500, 'у старой версии площадки метрика называется plays — просмотры всё равно сняты (15 000 → 1 500 ₽)', { views: g.views, paid: g.paid });

  /* 4 · права и доступ */
  ig.noInsights = true;
  const ni = await bind(BLG, 'A', 'https://www.instagram.com/reel/RC0de0/');
  ig.noInsights = false;
  ok(ni.status === 409 && ni.body.code === 'scope' && /статистик/.test(ni.body.error), 'нет права на статистику — «переподключите Instagram и разрешите доступ к статистике»', ni.body);
  /* долгий доступ продлевается сам за 15 дней до конца */
  const db = new DatabaseSync(DB);
  db.prepare("UPDATE channel_tokens SET expires_at = ?, updated_at = datetime('now','-2 days') WHERE platform = 'instagram' AND external_id = '17841400000000001'")
    .run(new Date(Date.now() + 10 * 864e5).toISOString());
  const before = db.prepare("SELECT access FROM channel_tokens WHERE platform = 'instagram' AND external_id = '17841400000000001'").get().access;
  const b2 = await bind(BLG, 'A', 'https://www.instagram.com/reel/RC0de0/');
  const after = db.prepare("SELECT access, expires_at FROM channel_tokens WHERE platform = 'instagram' AND external_id = '17841400000000001'").get();
  ok(b2.status === 200 && ig.refreshed.includes('V') && after.access !== before && new Date(after.expires_at).getTime() > Date.now() + 50 * 864e5,
    'за 10 дней до конца доступ продлён сам (refresh_access_token) — загрузка прошла', { st: b2.status, refreshed: ig.refreshed, err: b2.body.error });
  /* доступ протух — переподключить */
  db.prepare("UPDATE channel_tokens SET expires_at = ? WHERE platform = 'instagram' AND external_id = '17841400000000002'").run(new Date(Date.now() - 60e3).toISOString());
  ok(await camp('C', { platforms: 'inst' }, 10000, ADV), 'задание только для Instagram');
  const exp = await bind(BL2, 'C', 'https://www.instagram.com/reel/KReel01/');
  ok(exp.status === 409 && exp.body.code === 'token' && /Instagram/.test(exp.body.error), 'доступ Instagram истёк — «переподключите аккаунт»', exp.body);
  const acc2 = await api('GET', '/api/tasks/video/accounts', null, BL2.token);
  ok(((acc2.body.accounts || []).find((a) => a.platform === 'instagram') || {}).ready === false, 'в окне загрузки такой аккаунт помечен «переподключите»');

  /* 5 · Meta: удаление данных и отключение приложения */
  const badSig = await form('/api/verify/instagram/delete', signed({ user_id: '17841400000000002' }, 'не-тот-секрет'));
  ok(badSig.status === 400, 'запрос на удаление с чужой подписью — отказ', badSig);
  const del = await form('/api/verify/instagram/delete', signed({ user_id: '17841400000000002' }, IG_SECRET));
  const l2 = await api('GET', '/api/verify/list', null, BL2.token);
  ok(del.status === 200 && /^[a-f0-9]{16}$/.test(del.body.confirmation_code || '') && /privacy\.html/.test(del.body.url || '')
    && !(l2.body.rows || []).some((r) => r.platform === 'instagram'), 'удаление данных по запросу Meta: Instagram отвязан, ответ — адрес и код подтверждения', { del, rows: l2.body.rows });
  const de = await form('/api/verify/instagram/deauth', signed({ user_id: '17841400000000001' }, IG_SECRET));
  const l1 = await api('GET', '/api/verify/list', null, BLG.token);
  ok(de.status === 200 && de.body.ok && !(l1.body.rows || []).some((r) => r.platform === 'instagram'), 'приложение отключено в Instagram — канал и доступ сняты', { de, rows: l1.body.rows });
  const gv = (await api('GET', '/api/tasks/video?id=' + v1.id, null, BLG.token)).body.video || {};
  ok(gv.status === 'active' && gv.paid === 1500, 'засчитанный ролик остаётся, выплаченное не трогаем', { status: gv.status, paid: gv.paid });

  /* 6 · YouTube Shorts */
  ok((await link(BLG, 'youtube', 'yt-V')).confirm.status === 200, 'блогер подключил YouTube-канал');
  ok(await camp('S', { platforms: 'ys' }, 10000, ADV), 'задание «YouTube Shorts»');
  ok(await camp('Y', { platforms: 'yt' }, 10000, ADV), 'задание «YouTube» (любые видео)');
  const ln = await bind(BLG, 'S', 'https://www.youtube.com/watch?v=LongVideo01');
  ok(ln.status === 409 && ln.body.code === 'not_shorts' && /только Shorts/.test(ln.body.error), 'задание «Shorts»: обычное видео — «принимаются только Shorts»', ln.body);
  const sh = await bind(BLG, 'S', 'https://youtu.be/ShortVid001');
  const vs = sh.body.video || {};
  ok(sh.status === 200 && vs.platform === 'youtube' && vs.kind === 'shorts' && vs.url === 'https://www.youtube.com/shorts/ShortVid001', 'Shorts (даже по ссылке youtu.be) принят, помечен shorts, адрес /shorts/', { st: sh.status, vs, err: sh.body.error });
  const yl = await bind(BLG, 'Y', 'https://www.youtube.com/watch?v=LongVideo01');
  ok(yl.status === 200 && (yl.body.video || {}).kind === null, 'задание «YouTube»: обычное видео принято, без пометки Shorts', yl.body.video || yl.body);
  const ys = await bind(BLG, 'Y', 'https://www.youtube.com/shorts/ShortVid002');
  ok(ys.status === 200 && (ys.body.video || {}).kind === 'shorts', 'задание «YouTube»: Shorts тоже принят и помечен', ys.body.video || ys.body);
  ok(await camp('M', { platforms: 'ys,inst' }, 5000, ADV), 'задание «Shorts и Instagram»');
  const mw = await bind(BLG, 'M', 'https://www.tiktok.com/@vanya/video/7400000000000000001');
  ok(mw.status === 409 && mw.body.code === 'wrong_platform' && /YouTube Shorts, Instagram/.test(mw.body.error), 'TikTok в задание «Shorts и Instagram» — «принимаются видео только из: YouTube Shorts, Instagram»', mw.body);
  db.close();
} catch (e) {
  failed++; console.log('  FAIL исключение: ' + (e && e.stack || e));
} finally {
  try { srv.kill(); } catch (e) {}
  try { fake.close(); } catch (e) {}
}
console.log(`\nИтого: ${passed} ok, ${failed} FAIL`);
process.exit(failed ? 1 : 0);
