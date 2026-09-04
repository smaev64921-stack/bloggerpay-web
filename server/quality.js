'use strict';

/* ══ ОЦЕНКА КАЧЕСТВА КАНАЛА ══════════════════════════════════════════
   Считает по тому, что площадка отдала официально: число подписчиков и
   список последних роликов с просмотрами, лайками, комментариями и
   репостами. Ничего не домысливает и ничего не «доказывает».

   Важное про язык: это НЕ обвинение в накрутке. Мы считаем, насколько
   картина цифр обычна для живого канала, и говорим, что именно выбилось.
   У честного человека бывает и вирусный ролик, и мёртвый месяц — поэтому
   опираемся на медиану и разброс, а не на среднее, и при малом числе
   роликов честно понижаем уверенность вместо того, чтобы делать вид, что
   всё понятно.

   Наружу отдаём:
     risk       0..100, больше — больше поводов присмотреться
     level      'ok' | 'watch' | 'risk' | 'bad'
     confidence 'низкая' | 'средняя' | 'высокая'
     stats      посчитанные показатели
     reasons    человеческие объяснения на русском

   Пороги собраны в THRESHOLDS: их правят на сервере, не в приложении. */

const THRESHOLDS = {
  /* Сколько роликов нужно, чтобы верить цифрам. */
  minVideosLow: 1,
  minVideosMid: 5,
  minVideosHigh: 10,

  /* Просмотры относительно числа подписчиков. У живого канала медиана
     просмотров обычно хотя бы несколько процентов от аудитории. */
  /* Три ступени, а не две: «в разы меньше ожидаемого» и «аудитории как бы
     нет вовсе» — это разные истории, и вторая гораздо красноречивее. */
  viewsPerFollowerDead: 0.01,
  viewsPerFollowerBad: 0.02,
  viewsPerFollowerWeak: 0.05,
  followersForRatio: 1000,        /* на маленьких каналах отношение шумит */
  followersForStrong: 5000,

  /* Лайки к просмотрам. Обычная вилка — единицы и десятки процентов. */
  erLikesDead: 0.005,
  erLikesLow: 0.02,
  erLikesTooHigh: 0.35,

  /* Комментарии к просмотрам: их всегда мало, но не ноль. */
  erCommentsDead: 0.0002,
  viewsForComments: 5000,

  /* Репосты к просмотрам. */
  erSharesDead: 0.0001,

  /* Разброс просмотров. У живого канала ролики расходятся в разы;
     почти одинаковые числа — это ровная закупка, а не зрители. */
  spreadFlat: 0.06,
  minVideosForSpread: 8,

  /* Границы уровней. */
  levelOk: 20,
  levelWatch: 50,
  levelRisk: 75,

  /* Потолок оценки, пока данных мало: не выносим приговор по трём роликам. */
  capWhenLowConfidence: 50,
};

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function median(list) {
  const a = list.filter((x) => Number.isFinite(x)).slice().sort((x, y) => x - y);
  if (!a.length) return 0;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/* Квантиль по ближайшему значению: списки у нас короткие (10-20 роликов),
   и точная интерполяция тут ничего не добавляет. */
function quantile(list, q) {
  const a = list.filter((x) => Number.isFinite(x)).slice().sort((x, y) => x - y);
  if (!a.length) return 0;
  const i = Math.min(a.length - 1, Math.max(0, Math.round((a.length - 1) * q)));
  return a[i];
}

function avg(list) {
  const a = list.filter((x) => Number.isFinite(x));
  if (!a.length) return 0;
  return a.reduce((s, x) => s + x, 0) / a.length;
}

function pct(v) { return Math.round(v * 1000) / 10; }      /* 0.0123 → 1.2 */

/* Красивое число для человека: 12 345 → «12 345». */
function ru(n) {
  return String(Math.round(num(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

/* ── Главная функция ──
   input = {
     followers: число подписчиков (0, если площадка не дала),
     videos: [{ views, likes, comments, shares, at }],
     platform: 'tiktok' | 'youtube'
   } */
function assess(input, over) {
  const T = Object.assign({}, THRESHOLDS, over || {});
  const followers = Math.max(0, num(input && input.followers));
  const raw = Array.isArray(input && input.videos) ? input.videos : [];
  const videos = raw.filter((v) => v && Number.isFinite(Number(v.views)));

  const n = videos.length;
  const views = videos.map((v) => num(v.views));
  const likes = videos.map((v) => num(v.likes));
  const comments = videos.map((v) => num(v.comments));
  const shares = videos.map((v) => num(v.shares));

  const medViews = median(views);
  const avgViews = avg(views);
  const q25 = quantile(views, 0.25);
  const q75 = quantile(views, 0.75);
  const spread = medViews > 0 ? (q75 - q25) / medViews : 0;

  const medLikes = median(likes);
  const medComments = median(comments);
  const medShares = median(shares);

  const erLikes = medViews > 0 ? medLikes / medViews : 0;
  const erComments = medViews > 0 ? medComments / medViews : 0;
  const erShares = medViews > 0 ? medShares / medViews : 0;
  const viewsPerFollower = followers > 0 ? medViews / followers : 0;

  const stats = {
    videos: n,
    followers,
    medViews: Math.round(medViews),
    avgViews: Math.round(avgViews),
    spread: Math.round(spread * 100) / 100,
    erLikes: Math.round(erLikes * 10000) / 10000,
    erComments: Math.round(erComments * 10000) / 10000,
    erShares: Math.round(erShares * 10000) / 10000,
    viewsPerFollower: Math.round(viewsPerFollower * 1000) / 1000,
  };

  /* Нечего считать. Это не «плохо» — это «неизвестно». */
  if (!n) {
    return {
      risk: null,
      level: 'unknown',
      confidence: 'низкая',
      stats,
      reasons: ['Площадка не дала список роликов — оценить нечего.'],
    };
  }

  const confidence = n >= T.minVideosHigh ? 'высокая'
    : n >= T.minVideosMid ? 'средняя' : 'низкая';

  let risk = 0;
  const reasons = [];

  /* 1. Просмотры относительно аудитории. */
  if (followers >= T.followersForRatio && medViews > 0) {
    if (viewsPerFollower < T.viewsPerFollowerDead && followers >= T.followersForStrong) {
      /* Одного этого признака хватает, чтобы вывести канал за «присмотреться»:
         аудитория в сотни тысяч, которая не смотрит, — не совпадение. */
      risk += 55;
      reasons.push('При ' + ru(followers) + ' подписчиков ролики смотрят '
        + ru(medViews) + ' раз — это ' + pct(viewsPerFollower)
        + '% аудитории. Такой разрыв сам по себе не доказательство, но объяснить его нечем.');
    } else if (viewsPerFollower < T.viewsPerFollowerBad) {
      risk += followers >= T.followersForStrong ? 35 : 22;
      reasons.push('При ' + ru(followers) + ' подписчиков медиана просмотров всего '
        + ru(medViews) + ' — это ' + pct(viewsPerFollower)
        + '% аудитории. У живых каналов обычно в разы больше.');
    } else if (viewsPerFollower < T.viewsPerFollowerWeak) {
      risk += 12;
      reasons.push('Просмотры заметно ниже, чем ожидаемо при ' + ru(followers)
        + ' подписчиках: медиана ' + ru(medViews) + ' (' + pct(viewsPerFollower) + '% аудитории).');
    }
  }

  /* 2. Лайки к просмотрам. */
  if (medViews > 0) {
    if (erLikes < T.erLikesDead) {
      risk += 25;
      reasons.push('Просмотры есть, а лайков почти нет: ' + pct(erLikes)
        + '% от просмотров. Обычно это единицы процентов.');
    } else if (erLikes < T.erLikesLow) {
      risk += 10;
      reasons.push('Мало лайков относительно просмотров — ' + pct(erLikes) + '%.');
    } else if (erLikes > T.erLikesTooHigh) {
      risk += 10;
      reasons.push('Лайков неправдоподобно много относительно просмотров — ' + pct(erLikes) + '%.');
    }
  }

  /* 3. Комментарии. Их всегда мало, но полная тишина при больших
        просмотрах — это заметно. */
  if (medViews >= T.viewsForComments && erComments < T.erCommentsDead) {
    risk += 15;
    reasons.push('При медиане ' + ru(medViews) + ' просмотров комментариев практически нет.');
  }

  /* 4. Репосты. */
  if (medViews >= T.viewsForComments && erShares < T.erSharesDead) {
    risk += 5;
    reasons.push('Роликами почти не делятся — репостов близко к нулю.');
  }

  /* 5. Ровные просмотры. */
  if (n >= T.minVideosForSpread && medViews > 0 && spread < T.spreadFlat) {
    risk += 15;
    reasons.push('У всех роликов почти одинаковые просмотры (разброс '
      + Math.round(spread * 100) + '%). У живого канала они расходятся в разы.');
  }

  if (confidence === 'низкая') {
    risk = Math.min(risk, T.capWhenLowConfidence);
    reasons.push('Роликов всего ' + n + ' — для уверенной оценки этого мало.');
  }

  risk = Math.max(0, Math.min(100, Math.round(risk)));
  const level = risk <= T.levelOk ? 'ok'
    : risk <= T.levelWatch ? 'watch'
      : risk <= T.levelRisk ? 'risk' : 'bad';

  if (!reasons.length) reasons.push('Цифры выглядят обычно для живого канала.');

  return { risk, level, confidence, stats, reasons };
}

const LEVEL_RU = {
  ok: 'обычный канал',
  watch: 'стоит присмотреться',
  risk: 'много несовпадений',
  bad: 'очень похоже на накрутку',
  unknown: 'данных нет',
};

module.exports = { assess, median, quantile, THRESHOLDS, LEVEL_RU };
