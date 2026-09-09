/* =========================================================
   САНЧОУС — логика магазина
   Корзина со счётчиком, избранное, карточка товара,
   Telegram Mini App и установка приложения.
   ========================================================= */
(function () {
  'use strict';

  /* ---------------- Данные о товарах ---------------- */
  var PRODUCTS = {
    cheese: {
      id: 'cheese',
      name: 'Сырный соус',
      img: 'p-cheese',
      volume: '250 мл',
      price: 99,
      badge: 'Хит',
      short: 'Нежный, сливочный, сырный.',
      lead: 'Идеален для картошки, бургеров и всего, что любишь!',
      desc: 'Густой сырный соус с насыщенным вкусом выдержанного чеддера. ' +
            'Не растекается, ложится плотным слоем и остаётся кремовым даже когда остынет. ' +
            'Тот самый вкус, ради которого берут вторую порцию картошки.',
      pairs: ['Картошка фри', 'Бургеры', 'Наггетсы', 'Начос', 'Пицца'],
      comp: 'Вода, сыр твёрдый, масло подсолнечное, крахмал, сухое молоко, соль, ' +
            'паприка, регулятор кислотности. Без искусственных красителей.',
      keep: 'До 12 мес.'
    },
    ketchup: {
      id: 'ketchup',
      name: 'Кетчуп',
      img: 'p-ketchup',
      volume: '340 мл',
      price: 99,
      badge: 'Топ',
      short: 'Насыщенный, томатный, идеальный.',
      lead: 'Классика, которая всегда в тему!',
      desc: 'Кетчуп из спелых томатов — густой, с ярким томатным вкусом и лёгкой сладостью. ' +
            'Без лишней кислоты и водянистости: 100 г томатов на каждые 40 г соуса. ' +
            'Классика, которая подходит вообще ко всему.',
      pairs: ['Картошка фри', 'Хот-доги', 'Шашлык', 'Паста', 'Яичница'],
      comp: 'Томатная паста, вода, сахар, соль, уксус, лук, специи. ' +
            'Без крахмала и искусственных ароматизаторов.',
      keep: 'До 18 мес.'
    },
    signature: {
      id: 'signature',
      name: 'Фирменный соус Санчоус',
      img: 'p-signature',
      volume: '290 мл',
      price: 149,
      badge: 'Новинка',
      short: 'Уникальный вкус, который запомнится.',
      lead: 'Секретный рецепт Санчоуса!',
      desc: 'Сливочная основа, чеснок, зелень и наш секретный набор специй. ' +
            'Мягкий старт, пряная середина и долгое послевкусие — соус, ' +
            'который превращает обычный ужин в что-то своё, фирменное.',
      pairs: ['Шаурма', 'Бургеры', 'Мясо на гриле', 'Овощи', 'Салаты'],
      comp: 'Масло подсолнечное, вода, яичный желток, чеснок, укроп, петрушка, ' +
            'горчица, чёрный перец, соль, лимонный сок.',
      keep: 'До 6 мес.'
    },
    honey: {
      id: 'honey',
      name: 'Медово-чили',
      img: 'p-honey',
      volume: '250 мл',
      price: 149,
      badge: 'Хит',
      short: 'Сладость мёда и острота перца.',
      lead: 'Для тех, кто любит сладкое, но не боится острого!',
      desc: 'Мёд и красный чили в идеальном балансе: сначала сладко, потом приятно жжёт. ' +
            'Острота средняя — заходит даже тем, кто обычно обходит острое стороной. ' +
            'Отлично карамелизуется, если полить им крылья перед духовкой.',
      pairs: ['Куриные крылья', 'Наггетсы', 'Рёбра', 'Креветки', 'Жареный сыр'],
      comp: 'Мёд натуральный, перец чили, томатная паста, чеснок, уксус, ' +
            'соевый соус, имбирь, соль.',
      keep: 'До 12 мес.'
    }
  };

  var ORDER = ['cheese', 'ketchup', 'signature', 'honey'];
  var STORE_KEY = 'sanchous.shop.v1';

  /* ---------------- Состояние ---------------- */
  var state = { cart: {}, fav: [] };

  function load() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (!raw) return;
      var data = JSON.parse(raw);
      if (data && typeof data === 'object') {
        state.cart = data.cart && typeof data.cart === 'object' ? data.cart : {};
        state.fav = Array.isArray(data.fav) ? data.fav : [];
      }
    } catch (e) { /* приватный режим — работаем без сохранения */ }

    // отбрасываем товары, которых больше нет в каталоге
    Object.keys(state.cart).forEach(function (id) {
      if (!PRODUCTS[id] || !(state.cart[id] > 0)) delete state.cart[id];
    });
    state.fav = state.fav.filter(function (id) { return !!PRODUCTS[id]; });
  }

  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); }
    catch (e) { /* нет доступа к хранилищу — просто не сохраняем */ }
  }

  var qty = function (id) { return state.cart[id] || 0; };
  var isFav = function (id) { return state.fav.indexOf(id) !== -1; };
  var totalCount = function () {
    return Object.keys(state.cart).reduce(function (n, id) { return n + state.cart[id]; }, 0);
  };
  var totalSum = function () {
    return Object.keys(state.cart).reduce(function (n, id) {
      return n + state.cart[id] * PRODUCTS[id].price;
    }, 0);
  };
  var money = function (n) { return n.toLocaleString('ru-RU') + ' ₽'; };

  /* ---------------- Ссылки на DOM ---------------- */
  var $ = function (id) { return document.getElementById(id); };
  var topbar = $('topbar'), burger = $('burger'), mmenu = $('mobileMenu');
  var cartBtn = $('cartBtn'), favBtn = $('favBtn');
  var cartCount = $('cartCount'), favCount = $('favCount');
  var scrim = $('scrim'), drawer = $('drawer'), drawerClose = $('drawerClose');
  var cartList = $('cartList'), favList = $('favList');
  var cartEmpty = $('cartEmpty'), favEmpty = $('favEmpty');
  var cartTotal = $('cartTotal'), drawerFoot = $('drawerFoot'), orderBtn = $('orderBtn');
  var tabCartNum = $('tabCartNum'), tabFavNum = $('tabFavNum');
  var modal = $('modal'), modalClose = $('modalClose'), toast = $('toast');

  /* ---------------- Telegram Mini App ---------------- */
  var tg = (window.Telegram && window.Telegram.WebApp) ? window.Telegram.WebApp : null;
  var inTelegram = !!(tg && tg.initData !== undefined && tg.platform && tg.platform !== 'unknown');

  if (tg) {
    try {
      tg.ready();
      tg.expand();
      if (tg.setHeaderColor) tg.setHeaderColor('#151513');
      if (tg.setBackgroundColor) tg.setBackgroundColor('#f4f4f4');
      if (tg.enableClosingConfirmation) tg.enableClosingConfirmation();
    } catch (e) { /* старая версия клиента */ }
  }

  function haptic(type) {
    if (!tg || !tg.HapticFeedback) return;
    try {
      if (type === 'select') tg.HapticFeedback.selectionChanged();
      else tg.HapticFeedback.impactOccurred(type || 'light');
    } catch (e) { /* не поддерживается */ }
  }

  function syncMainButton() {
    if (!tg || !tg.MainButton) return;
    try {
      // в открытой панели корзины своя кнопка «Оформить заказ»
      if (totalCount() > 0 && !isDrawerOpen()) {
        tg.MainButton.setText('Оформить заказ · ' + money(totalSum()));
        tg.MainButton.show();
      } else {
        tg.MainButton.hide();
      }
    } catch (e) { /* не поддерживается */ }
  }

  /* ---------------- Иконки ---------------- */
  var ICON_CART = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 3.5h3l2.6 11.4h9.9l2.1-8.2H7"/>' +
                  '<circle cx="10" cy="19.4" r="1.7"/><circle cx="17.6" cy="19.4" r="1.7"/></svg>';
  var ICON_MINUS = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14"/></svg>';
  var ICON_PLUS = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
  var ICON_X = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5l14 14M19 5L5 19"/></svg>';

  /* ---------------- Кнопка покупки / счётчик ---------------- */
  function buyMarkup(id, compact) {
    var n = qty(id);
    if (n <= 0) {
      return '<button class="btn btn--red ' + (compact ? 'ditem__add' : 'btn--cart') +
             '" type="button" data-add="' + id + '">' +
             (compact ? '' : ICON_CART) + '<span>В корзину</span></button>';
    }
    return '<div class="stepper">' +
             '<button type="button" data-dec="' + id + '" aria-label="Убрать одну штуку">' + ICON_MINUS + '</button>' +
             '<span class="stepper__num" aria-live="polite">' + n + '</span>' +
             '<button type="button" data-inc="' + id + '" aria-label="Добавить ещё одну">' + ICON_PLUS + '</button>' +
           '</div>';
  }

  function renderBuyControls() {
    document.querySelectorAll('[data-buy]').forEach(function (box) {
      var id = box.dataset.buy;
      var n = qty(id);
      if (box.dataset.rendered === String(n)) return;   // лишний раз не перерисовываем
      box.innerHTML = buyMarkup(id, false);
      box.dataset.rendered = String(n);
    });

    var mb = $('modalBuy');
    if (mb && mb.dataset.id) {
      var n2 = qty(mb.dataset.id);
      if (mb.dataset.rendered !== String(n2)) {
        mb.innerHTML = buyMarkup(mb.dataset.id, false);
        mb.dataset.rendered = String(n2);
      }
    }
  }

  function renderFavStates() {
    document.querySelectorAll('[data-fav]').forEach(function (b) {
      b.setAttribute('aria-pressed', isFav(b.dataset.fav) ? 'true' : 'false');
    });
    var mf = $('modalFav');
    if (mf && mf.dataset.id) mf.setAttribute('aria-pressed', isFav(mf.dataset.id) ? 'true' : 'false');
    if (favBtn) favBtn.classList.toggle('is-on', state.fav.length > 0);
  }

  function setCount(el, n) {
    if (!el) return;
    el.textContent = String(n);
    el.classList.toggle('is-on', n > 0);
    el.classList.remove('is-bump');
    void el.offsetWidth;
    if (n > 0) el.classList.add('is-bump');
  }

  function renderCounters() {
    setCount(cartCount, totalCount());
    setCount(favCount, state.fav.length);
    if (tabCartNum) tabCartNum.textContent = String(totalCount());
    if (tabFavNum) tabFavNum.textContent = String(state.fav.length);
    if (cartTotal) cartTotal.textContent = money(totalSum());
    if (drawerFoot) drawerFoot.hidden = !(totalCount() > 0 && activeTab === 'cart');
  }

  /* ---------------- Список в панели ---------------- */
  function itemMarkup(id, mode) {
    var p = PRODUCTS[id];
    var n = qty(id);
    return '<li class="ditem" data-item="' + id + '">' +
      '<img class="ditem__img" src="img/' + p.img + '-400.webp" alt="" width="64" height="70" loading="lazy" data-open="' + id + '">' +
      '<div class="ditem__main">' +
        '<button class="ditem__name" type="button" data-open="' + id + '">' + p.name + '</button>' +
        '<span class="ditem__vol">' + p.volume + ' · ' + money(p.price) + '</span>' +
        '<div class="ditem__row">' +
          (mode === 'cart'
            ? '<span class="ditem__price">' + money(p.price * n) + '</span>' + buyMarkup(id, true)
            : buyMarkup(id, true) +
              '<button class="ditem__del" type="button" data-unfav="' + id + '" aria-label="Убрать из избранного">' + ICON_X + '</button>') +
        '</div>' +
      '</div>' +
    '</li>';
  }

  function renderLists() {
    var ids = ORDER.filter(function (id) { return qty(id) > 0; });
    cartList.innerHTML = ids.map(function (id) { return itemMarkup(id, 'cart'); }).join('');
    cartEmpty.hidden = ids.length > 0;

    favList.innerHTML = state.fav.map(function (id) { return itemMarkup(id, 'fav'); }).join('');
    favEmpty.hidden = state.fav.length > 0;
  }

  function renderAll() {
    renderBuyControls();
    renderFavStates();
    renderCounters();
    if (isDrawerOpen()) renderLists();
    syncMainButton();
  }

  /* ---------------- Действия ---------------- */
  function add(id, silent) {
    state.cart[id] = qty(id) + 1;
    save();
    renderAll();
    haptic('light');
    if (!silent) showToast(PRODUCTS[id].name + ' — в корзине · ' + state.cart[id] + ' шт.');
  }

  function dec(id) {
    var n = qty(id) - 1;
    if (n > 0) state.cart[id] = n;
    else delete state.cart[id];
    save();
    renderAll();
    haptic('light');
    if (n <= 0) showToast(PRODUCTS[id].name + ' убран из корзины');
  }

  function toggleFav(id, btn) {
    var i = state.fav.indexOf(id);
    if (i === -1) { state.fav.push(id); showToast(PRODUCTS[id].name + ' — в избранном'); }
    else { state.fav.splice(i, 1); showToast(PRODUCTS[id].name + ' убран из избранного'); }
    save();
    renderAll();
    haptic('select');
    if (btn) { btn.classList.remove('is-pop'); void btn.offsetWidth; btn.classList.add('is-pop'); }
  }

  /* ---------------- Панель корзины ---------------- */
  var activeTab = 'cart';
  var isDrawerOpen = function () { return drawer && !drawer.hidden; };

  function setTab(name) {
    activeTab = name;
    document.querySelectorAll('.tab').forEach(function (t) {
      var on = t.dataset.tab === name;
      t.classList.toggle('is-active', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    document.querySelectorAll('.drawer__pane').forEach(function (p) {
      p.classList.toggle('is-active', p.dataset.pane === name);
    });
    renderCounters();
  }

  function lockBody(on) {
    document.body.classList.toggle('is-locked', on);
  }

  function showScrim(on) {
    if (on) {
      scrim.hidden = false;
      requestAnimationFrame(function () { scrim.classList.add('is-on'); });
    } else {
      scrim.classList.remove('is-on');
      setTimeout(function () {
        if (!isDrawerOpen() && modal.hidden) scrim.hidden = true;
      }, 300);
    }
  }

  function openDrawer(tab) {
    closeMenu();
    setTab(tab || 'cart');
    renderLists();
    renderCounters();
    drawer.hidden = false;
    showScrim(true);
    lockBody(true);
    requestAnimationFrame(function () { drawer.classList.add('is-open'); });
    syncBackButton();
    syncMainButton();
    haptic('light');
  }

  function closeDrawer() {
    if (!isDrawerOpen()) return;
    drawer.classList.remove('is-open');
    setTimeout(function () { drawer.hidden = true; }, 340);
    if (modal.hidden) { showScrim(false); lockBody(false); }
    syncBackButton();
    syncMainButton();
  }

  /* ---------------- Карточка товара ---------------- */
  function openModal(id) {
    var p = PRODUCTS[id];
    if (!p) return;
    closeMenu();

    var img = $('modalImg');
    img.src = 'img/' + p.img + '-700.webp';
    img.srcset = 'img/' + p.img + '-700.webp 700w, img/' + p.img + '-1100.webp 1100w';
    img.sizes = '(min-width:900px) 480px, 100vw';
    img.alt = p.name + ' Санчоус, ' + p.volume;

    $('modalBadge').textContent = p.badge || '';
    $('modalTitle').textContent = p.name;
    $('modalLead').textContent = p.lead;
    $('modalDesc').textContent = p.desc;
    $('modalComp').textContent = p.comp;

    $('modalSpecs').innerHTML =
      '<div><dt>Объём</dt><dd>' + p.volume + '</dd></div>' +
      '<div><dt>Цена</dt><dd>' + money(p.price) + '</dd></div>' +
      '<div><dt>Срок хранения</dt><dd>' + p.keep + '</dd></div>';

    $('modalPairs').innerHTML = p.pairs.map(function (x) { return '<li>' + x + '</li>'; }).join('');

    $('modalOld').textContent = '';
    $('modalPrice').textContent = money(p.price);

    var mf = $('modalFav');
    mf.dataset.id = id;
    mf.setAttribute('aria-pressed', isFav(id) ? 'true' : 'false');

    var mb = $('modalBuy');
    mb.dataset.id = id;
    mb.dataset.rendered = '';
    renderBuyControls();

    modal.hidden = false;
    showScrim(true);
    lockBody(true);
    requestAnimationFrame(function () { modal.classList.add('is-open'); });
    modal.querySelector('.modal__sheet').scrollTop = 0;
    syncBackButton();
    haptic('light');
  }

  function closeModal() {
    if (modal.hidden) return;
    modal.classList.remove('is-open');
    setTimeout(function () { modal.hidden = true; }, 320);
    if (!isDrawerOpen()) { showScrim(false); lockBody(false); }
    syncBackButton();
  }

  /* ---------------- Кнопка «Назад» в Telegram ---------------- */
  function syncBackButton() {
    if (!tg || !tg.BackButton) return;
    try {
      if (!modal.hidden || isDrawerOpen()) tg.BackButton.show();
      else tg.BackButton.hide();
    } catch (e) { /* не поддерживается */ }
  }

  if (tg && tg.BackButton && tg.BackButton.onClick) {
    tg.BackButton.onClick(function () {
      if (!modal.hidden) closeModal();
      else if (isDrawerOpen()) closeDrawer();
    });
  }
  if (tg && tg.MainButton && tg.MainButton.onClick) {
    tg.MainButton.onClick(function () { openDrawer('cart'); });
  }

  /* ---------------- Оформление заказа ---------------- */
  function makeOrder() {
    if (totalCount() === 0) return;

    var items = ORDER.filter(function (id) { return qty(id) > 0; }).map(function (id) {
      return { id: id, name: PRODUCTS[id].name, volume: PRODUCTS[id].volume,
               price: PRODUCTS[id].price, qty: qty(id) };
    });
    var payload = { type: 'order', items: items, count: totalCount(), total: totalSum() };

    haptic('medium');

    if (tg && typeof tg.sendData === 'function' && inTelegram) {
      try {
        tg.sendData(JSON.stringify(payload));
        return;                       // Telegram закроет приложение сам
      } catch (e) { /* приложение открыто не с клавиатурной кнопки */ }
    }

    var text = items.map(function (i) { return i.name + ' × ' + i.qty; }).join('\n');
    var msg = 'Заказ на ' + money(totalSum()) + ':\n' + text;

    if (tg && tg.showAlert && inTelegram) {
      try { tg.showAlert(msg); return; } catch (e) { /* ignore */ }
    }
    showToast('Заказ собран: ' + totalCount() + ' шт. на ' + money(totalSum()));
    closeDrawer();
  }

  /* ---------------- Тост ---------------- */
  var toastTimer = null;
  function showToast(text) {
    if (!toast) return;
    toast.textContent = text;
    toast.classList.add('is-on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toast.classList.remove('is-on'); }, 2200);
  }

  /* ---------------- Мобильное меню ---------------- */
  function openMenu() {
    if (!mmenu || !burger) return;
    mmenu.hidden = false;
    requestAnimationFrame(function () { mmenu.classList.add('is-open'); });
    burger.setAttribute('aria-expanded', 'true');
  }

  function closeMenu() {
    if (!mmenu || !burger) return;
    if (burger.getAttribute('aria-expanded') !== 'true') return;
    mmenu.classList.remove('is-open');
    burger.setAttribute('aria-expanded', 'false');
    setTimeout(function () {
      if (!mmenu.classList.contains('is-open')) mmenu.hidden = true;
    }, 280);
  }

  /* ---------------- Прилипающая шапка ---------------- */
  var ticking = false;
  function onScroll() {
    if (topbar) topbar.classList.toggle('is-stuck', window.pageYOffset > 120);
    ticking = false;
  }
  window.addEventListener('scroll', function () {
    if (!ticking) { ticking = true; requestAnimationFrame(onScroll); }
  }, { passive: true });

  /* ---------------- Один общий обработчик кликов ---------------- */
  document.addEventListener('click', function (e) {
    var t = e.target;

    var addBtn = t.closest('[data-add]');
    if (addBtn) { add(addBtn.dataset.add); return; }

    var incBtn = t.closest('[data-inc]');
    if (incBtn) { add(incBtn.dataset.inc, true); return; }

    var decBtn = t.closest('[data-dec]');
    if (decBtn) { dec(decBtn.dataset.dec); return; }

    var favEl = t.closest('[data-fav]');
    if (favEl) { toggleFav(favEl.dataset.fav, favEl); return; }

    var unfav = t.closest('[data-unfav]');
    if (unfav) { toggleFav(unfav.dataset.unfav); return; }

    var openEl = t.closest('[data-open]');
    if (openEl) { openModal(openEl.dataset.open); return; }

    var tabEl = t.closest('.tab');
    if (tabEl) { setTab(tabEl.dataset.tab); return; }

    if (t.closest('#modalFav')) { toggleFav($('modalFav').dataset.id, $('modalFav')); return; }
    if (t.closest('#cartBtn')) { openDrawer('cart'); return; }
    if (t.closest('#favBtn')) { openDrawer('fav'); return; }
    if (t.closest('#drawerClose')) { closeDrawer(); return; }
    if (t.closest('#orderBtn')) { makeOrder(); return; }
    if (t.closest('#modalClose')) { closeModal(); return; }

    if (t === scrim) { closeModal(); closeDrawer(); return; }
    if (t === modal) { closeModal(); return; }

    if (t.closest('#burger')) {
      if (burger.getAttribute('aria-expanded') === 'true') closeMenu();
      else openMenu();
      return;
    }
    if (mmenu && !mmenu.hidden && t.closest('.mmenu a')) { closeMenu(); return; }
  });

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (!modal.hidden) closeModal();
    else if (isDrawerOpen()) closeDrawer();
    else closeMenu();
  });

  /* ---------------- Установка приложения ---------------- */
  var installBox = $('install');
  var deferred = null;
  var INSTALL_KEY = 'sanchous.install.hidden';

  function installHidden() {
    try { return localStorage.getItem(INSTALL_KEY) === '1'; } catch (e) { return false; }
  }
  function hideInstall(remember) {
    if (!installBox) return;
    installBox.classList.remove('is-on');
    setTimeout(function () { installBox.hidden = true; }, 420);
    if (remember) { try { localStorage.setItem(INSTALL_KEY, '1'); } catch (e) {} }
  }
  function showInstall() {
    if (!installBox || installHidden() || inTelegram) return;
    if (window.matchMedia('(display-mode: standalone)').matches) return;
    if (window.navigator.standalone) return;
    installBox.hidden = false;
    requestAnimationFrame(function () { installBox.classList.add('is-on'); });
  }

  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferred = e;
    setTimeout(showInstall, 2500);
  });

  window.addEventListener('appinstalled', function () {
    hideInstall(true);
    showToast('Приложение установлено. Приятного аппетита!');
  });

  document.addEventListener('click', function (e) {
    if (e.target.closest('#installNo')) { hideInstall(true); return; }
    if (!e.target.closest('#installYes')) return;

    if (deferred) {
      deferred.prompt();
      deferred.userChoice.then(function (res) {
        if (res && res.outcome === 'accepted') hideInstall(true);
      });
      deferred = null;
    } else {
      // iOS Safari: своего диалога установки нет
      showToast('Нажми «Поделиться» → «На экран «Домой»');
    }
  });

  // iOS: подсказка вместо системного окна
  var isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  if (isIOS && !window.navigator.standalone && !inTelegram) setTimeout(showInstall, 6000);

  /* ---------------- Service worker ---------------- */
  if ('serviceWorker' in navigator && location.protocol.indexOf('http') === 0) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function () { /* офлайн-режим необязателен */ });
    });
  }

  /* ---------------- Старт ---------------- */
  load();
  renderAll();
  onScroll();
})();
