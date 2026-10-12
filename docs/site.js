// Shared by every page except Matchups: applies the saved/system theme before
// first paint (so there's no flash), keeps the browser's theme-color meta in
// sync, and wires the Light/Dark toggle in the nav. Load it in <head>, right
// after the <meta id="themeColorMeta"> tag.
(function () {
  var theme;
  try { theme = localStorage.getItem('winProbTheme'); } catch (e) { theme = null; }
  if (theme !== 'dark' && theme !== 'light') {
    theme = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  document.documentElement.setAttribute('data-theme', theme);
  var meta = document.getElementById('themeColorMeta');
  if (meta) meta.setAttribute('content', theme === 'dark' ? '#14161a' : '#ffffff');

  // Same "reduce motion" preference the Display page sets for Matchups.
  try {
    if (localStorage.getItem('winProbReduceMotion') === 'true') document.documentElement.setAttribute('data-reduce-motion', 'true');
  } catch (e) { /* ignore */ }

  // Staggered fade/slide-in, the same effect Matchups cards use: call with a
  // container (and optionally a selector for which children). Safe to call
  // repeatedly; skipped entirely when motion is reduced.
  window.siteEnter = function (parent, childSelector) {
    if (!parent) return;
    var root = document.documentElement;
    if (root.hasAttribute('data-reduce-motion')) return;
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    var kids = Array.prototype.slice.call(childSelector ? parent.querySelectorAll(childSelector) : parent.children, 0, 60);
    kids.forEach(function (el, i) {
      el.classList.remove('fx-in');
      void el.offsetWidth; // restart the animation if it's already playing
      el.style.animationDelay = (0.02 + Math.min(i, 12) * 0.04).toFixed(2) + 's';
      el.classList.add('fx-in');
      el.addEventListener('animationend', function done() {
        el.classList.remove('fx-in');
        el.style.animationDelay = '';
        el.removeEventListener('animationend', done);
      });
    });
  };

  document.addEventListener('DOMContentLoaded', function () {
    var auto = document.querySelectorAll('[data-enter]');
    for (var k = 0; k < auto.length; k++) window.siteEnter(auto[k]);
    var btn = document.getElementById('themeToggle');
    if (!btn) return;
    btn.textContent = theme === 'dark' ? '☀️ Light' : '🌙 Dark';
    btn.addEventListener('click', function () {
      try { localStorage.setItem('winProbTheme', theme === 'dark' ? 'light' : 'dark'); } catch (e) { /* ignore */ }
      // Team colors on these pages are computed per-theme when the page
      // loads, so a reload is the simplest way to apply the switch cleanly.
      location.reload();
    });
  });
})();
