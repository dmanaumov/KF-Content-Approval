(function () {
  'use strict';

  var fromInput = document.getElementById('tsFrom');
  var toInput = document.getElementById('tsTo');
  var refreshBtn = document.getElementById('tsRefreshBtn');
  var rangeHint = document.getElementById('tsRangeHint');
  var loadingEl = document.getElementById('loading');
  var errorEl = document.getElementById('errorBox');
  var rootEl = document.getElementById('root');

  function toIsoDate(d) {
    return d.toISOString().slice(0, 10);
  }

  function defaultRange() {
    var to = new Date();
    var from = new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);
    return { from: from, to: to };
  }

  function initRange() {
    var r = defaultRange();
    fromInput.value = toIsoDate(r.from);
    toInput.value = toIsoDate(r.to);
  }

  function fmtNum(n) {
    if (n == null) return '—';
    return Number(n).toLocaleString('ru-RU');
  }

  function fmtPercent(n) {
    if (n == null) return '—';
    return (n * 100).toFixed(1).replace('.', ',') + '%';
  }

  function fmtDelta(n) {
    if (n == null) return '';
    if (n > 0) return '<span class="ts-delta up">+' + fmtNum(n) + '</span>';
    if (n < 0) return '<span class="ts-delta down">' + fmtNum(n) + '</span>';
    return '<span class="ts-delta flat">±0</span>';
  }

  function fmtDate(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' }) +
      ' ' + d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function postRowHtml(p, channelUsername) {
    var url = p.url || (channelUsername ? ('https://t.me/' + channelUsername + '/' + p.telegramMessageId) : '');
    var excerpt = (p.text || '').trim();
    if (excerpt.length > 160) excerpt = excerpt.slice(0, 160) + '…';
    return '' +
      '<div class="ts-post">' +
        '<div class="ts-post-main">' +
          '<div class="ts-post-date">' + fmtDate(p.publishedAt) + '</div>' +
          '<div class="ts-post-text">' + (excerpt ? escapeHtml(excerpt) : '<span class="ts-post-empty">(медиа без текста)</span>') + '</div>' +
          (url ? '<a class="ts-post-link" href="' + escapeHtml(url) + '" target="_blank" rel="noopener">Открыть пост →</a>' : '') +
        '</div>' +
        '<div class="ts-post-metrics">' +
          '<span class="ts-metric" title="Просмотры">👁 ' + fmtNum(p.views) + '</span>' +
          '<span class="ts-metric" title="Реакции">❤ ' + fmtNum(p.reactionsTotal) + '</span>' +
          '<span class="ts-metric" title="Комментарии">💬 ' + fmtNum(p.commentsCount) + '</span>' +
        '</div>' +
      '</div>';
  }

  function channelCardHtml(c) {
    var postsHtml = c.posts && c.posts.length
      ? c.posts.map(function (p) { return postRowHtml(p, c.username); }).join('')
      : '<div class="ts-empty">За этот период постов не было.</div>';
    var usernameHtml = c.username
      ? ('<a class="ts-channel-username" href="https://t.me/' + escapeHtml(c.username) + '" target="_blank" rel="noopener">@' + escapeHtml(c.username) + '</a>')
      : '';
    return '' +
      '<section class="ts-card">' +
        '<header class="ts-card-head">' +
          '<h2 class="ts-card-title">' + escapeHtml(c.title || c.chatId) + '</h2>' +
          usernameHtml +
        '</header>' +
        '<div class="ts-stats-row">' +
          '<div class="ts-stat"><div class="ts-stat-value">' + fmtNum(c.postsCount) + '</div><div class="ts-stat-label">постов</div></div>' +
          '<div class="ts-stat"><div class="ts-stat-value">' + fmtNum(c.viewsTotal) + '</div><div class="ts-stat-label">просмотров</div></div>' +
          '<div class="ts-stat"><div class="ts-stat-value">' + fmtNum(c.reactionsTotal) + '</div><div class="ts-stat-label">реакций</div></div>' +
          '<div class="ts-stat"><div class="ts-stat-value">' + fmtNum(c.commentsTotal) + '</div><div class="ts-stat-label">комментариев</div></div>' +
          '<div class="ts-stat"><div class="ts-stat-value">' + fmtNum(c.subscriberCount) + ' ' + fmtDelta(c.subscriberDelta) + '</div><div class="ts-stat-label">подписчиков</div></div>' +
          '<div class="ts-stat"><div class="ts-stat-value">' + fmtPercent(c.engagementRate) + '</div><div class="ts-stat-label">вовлечённость</div></div>' +
        '</div>' +
        '<div class="ts-posts">' + postsHtml + '</div>' +
      '</section>';
  }

  function render(channels) {
    if (!channels || !channels.length) {
      rootEl.innerHTML = '<div class="ts-empty ts-empty-page">Нет каналов, куда бот добавлен администратором. Добавьте бота администратором в канал, чтобы здесь появилась статистика.</div>';
      return;
    }
    rootEl.innerHTML = channels.map(channelCardHtml).join('');
  }

  function load() {
    loadingEl.hidden = false;
    errorEl.hidden = true;
    rootEl.hidden = true;

    var from = fromInput.value;
    var to = toInput.value;
    var params = [];
    if (from) params.push('from=' + encodeURIComponent(new Date(from + 'T00:00:00Z').toISOString()));
    if (to) params.push('to=' + encodeURIComponent(new Date(to + 'T23:59:59Z').toISOString()));
    var qs = params.length ? ('?' + params.join('&')) : '';

    fetch('/api/ceo/telegram/channel-stats' + qs, { credentials: 'same-origin' })
      .then(function (res) {
        if (res.status === 401 || res.status === 403) {
          window.location.href = '/ceo';
          return Promise.reject(new Error('unauthorized'));
        }
        return res.json().then(function (data) {
          if (!res.ok) throw new Error(data.message || data.error || 'Ошибка загрузки');
          return data;
        });
      })
      .then(function (data) {
        loadingEl.hidden = true;
        rootEl.hidden = false;
        rangeHint.textContent = data.from && data.to
          ? ('Период: ' + fmtDate(data.from) + ' — ' + fmtDate(data.to))
          : '';
        render(data.channels);
      })
      .catch(function (err) {
        if (err.message === 'unauthorized') return;
        loadingEl.hidden = true;
        errorEl.hidden = false;
        errorEl.textContent = 'Не удалось загрузить статистику: ' + err.message;
      });
  }

  refreshBtn.addEventListener('click', load);
  initRange();
  load();
})();
