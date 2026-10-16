/* Оценка качества канала: считаем ли мы честно и не обвиняем ли зря.
   Проверки на выдуманных, но правдоподобных наборах цифр.
   Запуск: node test-quality.mjs */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { assess, assessVideo, median, quantile } = require('./quality.js');

let passed = 0, failed = 0;
function ok(c, name, extra) {
  if (c) { passed++; console.log('  ok  ' + name); }
  else { failed++; console.log('  FAIL ' + name + (extra ? '  ← ' + JSON.stringify(extra).slice(0, 260) : '')); }
}
/* Ролики с заданными просмотрами и долями вовлечения. */
function vids(views, { like = 0.06, com = 0.004, sh = 0.005 } = {}) {
  return views.map((v) => ({
    views: v,
    likes: Math.round(v * like),
    comments: Math.round(v * com),
    shares: Math.round(v * sh),
  }));
}

console.log('\nОценка качества канала');

/* ── мелочи ── */
ok(median([1, 2, 3]) === 2, 'медиана нечётного списка');
ok(median([1, 2, 3, 4]) === 2.5, 'медиана чётного списка');
ok(median([]) === 0, 'пустой список не роняет');
ok(quantile([1, 2, 3, 4, 5], 0.75) === 4, 'квантиль считается');

/* ── живой блогер: просмотры гуляют, вовлечение обычное ── */
const live = assess({
  followers: 42000,
  videos: vids([9000, 15000, 4000, 60000, 12000, 7000, 22000, 5000, 31000, 11000, 8000, 17000]),
});
ok(live.level === 'ok', 'живой канал не помечен', live);
ok(live.confidence === 'высокая', 'при двенадцати роликах уверенность высокая', live.confidence);
ok(live.risk <= 20, 'у живого канала оценка низкая', live.risk);
ok(live.reasons.length === 1 && /обычно/i.test(live.reasons[0]), 'без выдуманных претензий', live.reasons);

/* ── накрученные подписчики: аудитория есть, зрителей нет ── */
const fakeSubs = assess({
  followers: 250000,
  videos: vids([1200, 900, 1400, 1100, 800, 1500, 1000, 1300, 950, 1250]),
});
ok(fakeSubs.risk >= 51, 'мёртвые просмотры при большой аудитории — высокая оценка', fakeSubs);
ok(/подписчиков/.test(fakeSubs.reasons.join(' ')), 'причина названа по-человечески', fakeSubs.reasons);
ok(fakeSubs.stats.medViews === 1150, 'медиана посчитана', fakeSubs.stats);

/* ── накрученные просмотры: цифры есть, людей нет ── */
const fakeViews = assess({
  followers: 30000,
  videos: vids([50000, 52000, 48000, 51000, 49000, 50500, 49500, 50200, 51500, 48500],
    { like: 0.001, com: 0.00005, sh: 0.00002 }),
});
ok(fakeViews.risk >= 51, 'просмотры без вовлечения — высокая оценка', fakeViews);
const why = fakeViews.reasons.join(' ');
ok(/лайков почти нет/.test(why), 'сказано про лайки', fakeViews.reasons);
ok(/комментариев практически нет/.test(why), 'сказано про комментарии', fakeViews.reasons);
ok(/одинаковые просмотры/.test(why), 'сказано про ровный разброс', fakeViews.reasons);

/* ── мало данных: приговор не выносим ── */
const few = assess({
  followers: 100000,
  videos: vids([500, 400, 600], { like: 0.001, com: 0.00001, sh: 0.00001 }),
});
ok(few.confidence === 'низкая', 'три ролика — низкая уверенность', few.confidence);
ok(few.risk <= 50, 'при малых данных оценка ограничена', few);
ok(/для уверенной оценки этого мало/.test(few.reasons.join(' ')), 'о нехватке данных сказано прямо', few.reasons);

/* ── совсем нет роликов ── */
const none = assess({ followers: 5000, videos: [] });
ok(none.risk === null && none.level === 'unknown', 'без роликов оценки нет, а не ноль', none);
ok(/не дала список/.test(none.reasons[0]), 'объяснено, почему оценки нет', none.reasons);

/* ── маленький канал не ругаем за низкое отношение ── */
const small = assess({
  followers: 300,
  videos: vids([40, 120, 25, 300, 60, 80, 45, 200, 90, 55]),
});
ok(small.risk <= 20, 'на маленьком канале отношение не считаем', small);

/* ── неправдоподобно много лайков ── */
const tooMany = assess({
  followers: 20000,
  videos: vids([9000, 12000, 7000, 15000, 8000, 11000], { like: 0.6, com: 0.01, sh: 0.02 }),
});
ok(/лайков неправдоподобно много/i.test(tooMany.reasons.join(' ')), 'перебор лайков замечен', tooMany.reasons);

/* ── пороги можно менять снаружи ── */
const strict = assess({
  followers: 42000,
  videos: vids([9000, 15000, 4000, 60000, 12000, 7000, 22000, 5000, 31000, 11000, 8000, 17000]),
}, { erLikesLow: 0.9 });
ok(strict.risk > live.risk, 'пороги настраиваются снаружи', { strict: strict.risk, live: live.risk });

/* ── мусор на входе не роняет ── */
const junk = assess({ followers: 'ой', videos: [{ views: 'нет' }, null, { views: 100 }] });
ok(junk && junk.stats.videos === 1, 'мусорные записи отброшены', junk.stats);
ok(assess(null).level === 'unknown', 'пустой вход не роняет');

/* ── один ролик задания (assessVideo) ── */
console.log('\nОценка ролика задания');
const chan = { medViews: 600, followers: 2000, erLikes: 0.07, riskLevel: 'ok' };
const vOk = assessVideo({ views: 12000, likes: 900, comments: 40, shares: 25 }, [], chan);
ok(vOk.level === 'ok' && vOk.risk === 0, 'обычный ролик не помечен', vOk);
ok(vOk.reasons.length === 1 && /обычно/.test(vOk.reasons[0]), 'без выдуманных претензий', vOk.reasons);
const vViral = assessVideo({ views: 200000, likes: 16000, comments: 500, shares: 900 }, [], chan);
ok(vViral.level === 'ok', 'вирусный ролик с лайками — не накрутка', vViral);
const vSmall = assessVideo({ views: 1500, likes: 1, comments: 0, shares: 0 }, [], chan);
ok(vSmall.level === 'ok', 'на полутора тысячах просмотров доли не судим', vSmall);
const vBad = assessVideo({ views: 100000, likes: 100, comments: 0, shares: 0 }, [], chan);
ok(vBad.level === 'bad' && vBad.risk === 100, 'сто тысяч просмотров без лайков и разговоров у канала на 600 — bad', vBad);
ok(vBad.reasons.length === 3, 'названы все три признака', vBad.reasons);
const vQuiet = assessVideo({ views: 8000, likes: 30, comments: 0, shares: 0 }, [], {});
ok(vQuiet.level === 'risk' && vQuiet.risk === 60, 'мало лайков и полная тишина — risk', vQuiet);
const days = [{ day: '2026-10-01', views: 3000, likes: 240 }, { day: '2026-10-02', views: 5000, likes: 400 }];
const vJump = assessVideo({ views: 60000, likes: 700, comments: 30, shares: 10 }, days, {});
ok(vJump.reasons.some((r) => /За сутки/.test(r)) && vJump.level === 'watch', 'скачок за сутки без лайков замечен', vJump);
const vGrow = assessVideo({ views: 60000, likes: 4800, comments: 90, shares: 40 }, days, {});
ok(!vGrow.reasons.some((r) => /За сутки/.test(r)), 'скачок вместе с лайками — не повод', vGrow.reasons);
const vChan = assessVideo({ views: 12000, likes: 900, comments: 40, shares: 25 }, [], { riskLevel: 'bad' });
ok(vChan.risk === 15 && /канал/.test(vChan.reasons[0]), 'плохой канал добавляет 15', vChan);
ok(assessVideo(null, null, null).level === 'ok', 'пустой вход не роняет');
ok(assessVideo({ views: 8000, likes: 30, comments: 0, shares: 0 }, [], {}, { vidWeightSilent: 0 }).risk === 35,
  'пороги ролика настраиваются снаружи');

/* #31: чего площадка не сообщила — неизвестно, а не ноль (YouTube: репостов нет вовсе) */
const ytOk = assessVideo({ views: 9000, likes: 600, comments: 25, shares: 0, noShares: true }, [], {});
ok(ytOk.level === 'ok' && ytOk.risk === 0, 'YouTube: живые комментарии, репостов у площадки нет — не «тишина»', ytOk);
const ytOff = assessVideo({ views: 9000, likes: 600, comments: 0, shares: 0, noShares: true, commentsOff: true }, [], {});
ok(ytOff.level === 'ok' && ytOff.risk === 0, 'YouTube: комментарии выключены — «ни одного комментария и репоста» не считается', ytOff);
const ytHid = assessVideo({ views: 9000, likes: 0, comments: 0, shares: 0, noShares: true, commentsOff: true, likesHidden: true }, days, { medViews: 100, followers: 50 });
ok(ytHid.level === 'ok' && ytHid.risk === 0, 'YouTube: лайки скрыты и комментарии выключены — ни «нет лайков», ни «тишины», ни скачка', ytHid);
const ytQuiet = assessVideo({ views: 9000, likes: 600, comments: 0, shares: 0, noShares: true }, [], {});
ok(ytQuiet.risk === 25 && /ни одного комментария\.$/.test(ytQuiet.reasons[0]) && !/репост/.test(ytQuiet.reasons[0]),
  'YouTube: комментарии открыты и их ноль — признак по комментариям, без слова «репост»', ytQuiet.reasons);
const ytNoLikes = assessVideo({ views: 9000, likes: 5, comments: 20, shares: 0, noShares: true }, [], {});
ok(ytNoLikes.risk === 35, 'YouTube: лайки видны, их почти нет — признак лайков остаётся', ytNoLikes);

console.log(`\nИтого: ${passed} ok, ${failed} FAIL\n`);
process.exit(failed ? 1 : 0);
