/* Оценка качества канала: считаем ли мы честно и не обвиняем ли зря.
   Проверки на выдуманных, но правдоподобных наборах цифр.
   Запуск: node test-quality.mjs */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { assess, median, quantile } = require('./quality.js');

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

console.log(`\nИтого: ${passed} ok, ${failed} FAIL\n`);
process.exit(failed ? 1 : 0);
