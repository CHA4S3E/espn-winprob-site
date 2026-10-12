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

  document.addEventListener('DOMContentLoaded', function () {
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
