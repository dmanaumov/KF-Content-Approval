// welcome.js — тёплая заставка на 3-5 сек при входе в интерфейс: логотип КФ
// с bounce-анимацией + текст «КонтентФерма», собирающийся буква за буквой,
// сезонные частицы (снег/листья/цветы/блики — по текущему месяцу) и тёплая
// фраза (случайная из библиотеки, либо «с возвращением», если не заходили
// несколько дней). Полностью самодостаточный файл — сам вставляет свои
// стили, ничего не трогает в существующих app.css/team.css и т.п.
//
// Подключение: <script src="/welcome.js?v=1" defer data-audience="client"></script>
// data-audience — "client" (кабинет клиента, index.html) или "staff"
// (интерфейс команды — team/projects/ceo/bot-chats/bot-leads/api-keys/stat).
//
// Показывается максимум один раз за вкладку (sessionStorage) — при переходах
// между страницами команды (team → projects → ceo и т.п.) не повторяется,
// но появится снова в новой вкладке/окне.
(function () {
  'use strict';

  var scriptEl = document.currentScript;
  var audience = (scriptEl && scriptEl.getAttribute('data-audience')) === 'client' ? 'client' : 'staff';

  var SESSION_FLAG = 'kf-welcome-shown';
  try {
    if (sessionStorage.getItem(SESSION_FLAG)) return;
  } catch (e) { /* приватный режим без sessionStorage — просто не мешаем */ }

  var PHRASES_CLIENT = [
    'Сегодня отличный день для крутых постов ✨',
    'Рады видеть вас снова!',
    'Ваш проект в надёжных руках',
    'Хорошего дня — и продуктивной недели!',
    'Контент готовится с любовью 💚',
    'Пусть сегодняшний день будет ярким',
    'Спасибо, что вы с нами!',
    'Новая неделя — новые идеи для вашего бренда',
    'Заглянули вовремя — есть что показать',
    'Команда КонтентФермы уже в деле',
    'Хорошего настроения на весь день!',
    'Пусть всё складывается легко',
    'Ваш бренд растёт — мы рядом',
    'Маленькими шагами к большим результатам',
    'С добрым утром! Как дела у бренда?',
    'Держим курс на классный контент',
    'Рады новой встрече',
    'Пусть сегодня будет продуктивно и легко',
    'Заходите чаще — всегда есть новости',
    'На связи и в деле — как всегда',
  ];

  var PHRASES_STAFF = [
    'Сегодня точно будет продуктивный день 💪',
    'Команда, вы огонь!',
    'Хорошего дня и вдохновляющих идей',
    'Пусть все дедлайны дадутся легко',
    'Рады видеть вас в деле!',
    'Кофе в одну руку, идеи — в другую ☕',
    'Сегодня отличный день для крутых постов',
    'Спасибо, что вы делаете это возможным',
    'Новый день — новые классные проекты',
    'Заряд бодрости на весь день!',
    'Клиенты в надёжных руках — в ваших',
    'Погнали делать красиво',
    'С добрым утром, творим шедевры',
    'Каждый пост — маленькая победа',
    'Хорошего настроения на смену!',
    'Сегодня точно всё получится',
    'Вы делаете контент, который заметен',
    'Команда КФ — на подъёме',
    'Пусть работается легко и в кайф',
    'Отличного дня, звёзды контента ⭐',
  ];

  function pluralDays(n) {
    var mod10 = n % 10, mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return 'день';
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return 'дня';
    return 'дней';
  }

  function getSeason(d) {
    var m = d.getMonth(); // 0=янв
    if (m === 11 || m === 0 || m === 1) return 'winter';
    if (m >= 2 && m <= 4) return 'spring';
    if (m >= 5 && m <= 7) return 'summer';
    return 'autumn';
  }

  var SEASON_CONFIG = {
    winter: { symbols: ['❄', '❅', '❆'], fall: true },
    autumn: { symbols: ['🍂', '🍁'], fall: true },
    spring: { symbols: ['✿', '❀', '🌸'], fall: false },
    summer: { symbols: ['✦', '☀', '✧'], fall: false },
  };

  // Ключ для "не заходили N дней" — у клиента свой на каждый /l/{token}
  // (чтобы не путать разных клиентов на одном браузере), у команды один
  // общий (обычно один сотрудник на профиль браузера).
  function storageKey() {
    if (audience === 'client') {
      var m = location.pathname.match(/^\/l\/([^/]+)/);
      return 'kf-welcome-last-' + (m ? m[1] : 'client');
    }
    return 'kf-welcome-last-staff';
  }

  function pickPhraseOrWelcomeBack() {
    var key = storageKey();
    var now = Date.now();
    var raw = null;
    try { raw = localStorage.getItem(key); } catch (e) {}

    var text;
    if (!raw) {
      text = audience === 'client'
        ? 'Добро пожаловать! Рады, что вы с нами.'
        : 'Добро пожаловать в КонтентФерму!';
    } else {
      var days = Math.floor((now - Number(raw)) / 86400000);
      if (days >= 3) {
        text = 'Не заходили ' + days + ' ' + pluralDays(days) + ' — рады видеть снова!';
      } else {
        var pool = audience === 'client' ? PHRASES_CLIENT : PHRASES_STAFF;
        text = pool[Math.floor(Math.random() * pool.length)];
      }
    }

    try { localStorage.setItem(key, String(now)); } catch (e) {}
    return text;
  }

  function injectStyles() {
    var css = ''
      + '.kf-welcome-overlay{position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;'
      + 'background:var(--bg,#F6F8F7);overflow:hidden;transition:opacity .5s ease;}'
      + '.kf-welcome-overlay.kf-welcome-hide{opacity:0;pointer-events:none;}'
      + '.kf-welcome-card{position:relative;z-index:2;display:flex;flex-direction:column;align-items:center;gap:14px;text-align:center;padding:24px;}'
      + '.kf-welcome-logo{width:84px;height:auto;opacity:0;animation:kfLogoBounce .9s cubic-bezier(.34,1.56,.64,1) forwards;}'
      + '.kf-welcome-brand{font-size:22px;font-weight:700;letter-spacing:.02em;color:var(--ink,#17201F);}'
      + '.kf-welcome-letter{display:inline-block;opacity:0;transform:translateY(14px);animation:kfLetterIn .5s cubic-bezier(.34,1.56,.64,1) forwards;}'
      + '.kf-welcome-phrase{font-size:15px;color:var(--muted,#5B6864);max-width:320px;opacity:0;transform:translateY(8px);'
      + 'animation:kfPhraseIn .6s ease-out forwards;animation-delay:.95s;}'
      + '@keyframes kfLogoBounce{0%{transform:scale(.35) translateY(-30px);opacity:0}60%{transform:scale(1.08) translateY(4px);opacity:1}'
      + '80%{transform:scale(.96)}100%{transform:scale(1) translateY(0);opacity:1}}'
      + '@keyframes kfLetterIn{to{opacity:1;transform:translateY(0)}}'
      + '@keyframes kfPhraseIn{to{opacity:1;transform:translateY(0)}}'
      + '.kf-welcome-particles{position:absolute;inset:0;z-index:1;pointer-events:none;}'
      + '.kf-welcome-particle{position:absolute;will-change:transform,opacity;}'
      + '.kf-welcome-particle.kf-fall{top:-10%;animation-name:kfFall;animation-timing-function:linear;animation-fill-mode:both;}'
      + '.kf-welcome-particle.kf-float{bottom:-10%;animation-name:kfFloat;animation-timing-function:ease-in-out;animation-fill-mode:both;}'
      + '@keyframes kfFall{from{transform:translateY(-10vh) rotate(0deg);opacity:0}10%{opacity:1}to{transform:translateY(115vh) rotate(200deg);opacity:.15}}'
      + '@keyframes kfFloat{from{transform:translateY(0) translateX(0);opacity:0}15%{opacity:1}50%{transform:translateY(-45vh) translateX(10px)}'
      + 'to{transform:translateY(-100vh) translateX(-8px);opacity:0}}'
      + '.kf-welcome-reduced .kf-welcome-logo,.kf-welcome-reduced .kf-welcome-letter,.kf-welcome-reduced .kf-welcome-phrase'
      + '{animation:none !important;opacity:1 !important;transform:none !important;}';
    var style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
  }

  function buildLetters(text) {
    var out = '';
    for (var i = 0; i < text.length; i++) {
      var ch = text[i] === ' ' ? '&nbsp;' : text[i];
      out += '<span class="kf-welcome-letter" style="animation-delay:' + (0.05 * i).toFixed(2) + 's">' + ch + '</span>';
    }
    return out;
  }

  function spawnParticles(container, season) {
    var cfg = SEASON_CONFIG[season];
    var n = 16;
    for (var i = 0; i < n; i++) {
      var el = document.createElement('span');
      el.className = 'kf-welcome-particle ' + (cfg.fall ? 'kf-fall' : 'kf-float');
      el.textContent = cfg.symbols[i % cfg.symbols.length];
      el.style.left = (Math.random() * 100) + '%';
      el.style.animationDelay = (Math.random() * 1.2).toFixed(2) + 's';
      el.style.animationDuration = (3 + Math.random() * 1.8).toFixed(2) + 's';
      el.style.fontSize = (14 + Math.random() * 14).toFixed(0) + 'px';
      el.style.opacity = (0.35 + Math.random() * 0.45).toFixed(2);
      container.appendChild(el);
    }
  }

  function show() {
    var reduced = false;
    try { reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) {}

    injectStyles();

    var text = pickPhraseOrWelcomeBack();

    var overlay = document.createElement('div');
    overlay.className = 'kf-welcome-overlay' + (reduced ? ' kf-welcome-reduced' : '');
    overlay.innerHTML =
      '<div class="kf-welcome-particles"></div>' +
      '<div class="kf-welcome-card">' +
        '<img class="kf-welcome-logo" src="/kf-logo.png" alt="КФ">' +
        '<div class="kf-welcome-brand">' + buildLetters('КонтентФерма') + '</div>' +
        '<div class="kf-welcome-phrase"></div>' +
      '</div>';
    overlay.querySelector('.kf-welcome-phrase').textContent = text;

    document.body.appendChild(overlay);

    if (!reduced) {
      spawnParticles(overlay.querySelector('.kf-welcome-particles'), getSeason(new Date()));
    }

    var prevOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden';

    var HOLD_MS = reduced ? 2200 : 3800;
    setTimeout(function () {
      overlay.classList.add('kf-welcome-hide');
      document.documentElement.style.overflow = prevOverflow;
      setTimeout(function () { overlay.remove(); }, 550);
    }, HOLD_MS);

    try { sessionStorage.setItem(SESSION_FLAG, '1'); } catch (e) {}
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', show);
  } else {
    show();
  }
})();
