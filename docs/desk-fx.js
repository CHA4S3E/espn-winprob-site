// desk-fx.js -- things that make the News Desk behave like a real TV channel.
//
//  * Holiday sets: season-look.js (shared with the rest of the site) decides
//    whether this is Halloween / Thanksgiving / Christmas / cold-snap week
//    from the real NFL schedule and sets html[data-seasonal-theme]. Here both
//    studios get dressed for it: accent colors (desk.html CSS), a show-name
//    tag, and leaves / bats / snow drifting behind the panels.
//  * Keeps the screen awake (Wake Lock API) for a whole game day.
//  * Notices a dropped connection, shows "Reconnecting", and refreshes the
//    moment it's back. Reloads itself once overnight so it can run for days.
(function () {
  'use strict';
  const root = document.documentElement;
  const HOLIDAY = {
    halloween: { tag: { pro: 'Halloween Edition', casual: 'Spooky Season' }, kind: 'bat', n: 10 },
    thanksgiving: { tag: { pro: 'Thanksgiving Special', casual: 'Turkey Day' }, kind: 'leaf', n: 30 },
    christmas: { tag: { pro: 'Holiday Special', casual: 'Holiday Couch' }, kind: 'snow', n: 90 },
    'coldsnap-pre': { tag: { pro: 'Cold Snap', casual: 'Bundle Up' }, kind: 'ice', n: 34 },
    'coldsnap-post': { tag: { pro: 'Cold Snap', casual: 'Bundle Up' }, kind: 'ice', n: 34 },
  };
  const theme = () => root.dataset.seasonalTheme || (new URLSearchParams(location.search).get('holiday')) || null;

  // ---------------------------------------------------------------- holiday particles
  let cv = null, raf = 0, parts = [], kind = null;
  const LEAF = ['#c65d1e', '#d98324', '#8a3b12', '#e0a940', '#9c4a1a', '#b8461f'];
  let W = 1920, H = 1080;
  function resize(w, h) { W = Math.round(w); H = Math.round(h); if (cv) { cv.width = W; cv.height = H; } }
  function mk(init) {
    if (kind === 'bat') return { x: init ? Math.random() * W : -40, y: 60 + Math.random() * 500, v: 1 + Math.random() * 1.6, s: 18 + Math.random() * 16, ph: Math.random() * 6 };
    return { x: Math.random() * W, y: init ? Math.random() * H : -20, v: kind === 'leaf' ? 0.7 + Math.random() * 0.9 : 0.5 + Math.random() * 1.2, s: kind === 'leaf' ? 9 + Math.random() * 9 : kind === 'ice' ? 5 + Math.random() * 6 : 2 + Math.random() * 3.5,
      sw: 10 + Math.random() * 30, ph: Math.random() * 6, r: Math.random() * 360, vr: (Math.random() - 0.5) * 2, c: LEAF[Math.floor(Math.random() * LEAF.length)], a: 0.5 + Math.random() * 0.5 };
  }
  function frame(ts) {
    raf = requestAnimationFrame(frame);
    const x = cv.getContext('2d'), t = ts / 1000, light = root.dataset.daypart !== 'night';
    x.clearRect(0, 0, W, H);
    for (const p of parts) {
      if (kind === 'bat') {
        p.x += p.v; p.y += Math.sin(t * 1.3 + p.ph) * 0.6; if (p.x > W + 60) Object.assign(p, mk(false));
        const f = 0.5 + 0.5 * Math.sin(t * 9 + p.ph), w = p.s * (0.8 + f * 0.6);
        x.save(); x.translate(p.x, p.y); x.globalAlpha = 0.6; x.fillStyle = light ? '#2a2238' : '#5b4a80';
        x.beginPath(); x.moveTo(0, 0); x.quadraticCurveTo(-w * 0.5, -p.s * 0.6, -w, 0); x.quadraticCurveTo(-w * 0.5, p.s * 0.15, 0, 0);
        x.quadraticCurveTo(w * 0.5, -p.s * 0.6, w, 0); x.quadraticCurveTo(w * 0.5, p.s * 0.15, 0, 0); x.fill(); x.restore();
        continue;
      }
      p.y += p.v; p.x += Math.sin(t * 0.6 + p.ph) * p.sw * 0.012; p.r += p.vr;
      if (p.y > H + 20) Object.assign(p, mk(false));
      x.save(); x.globalAlpha = p.a * 0.75; x.translate(p.x, p.y); x.rotate(p.r * Math.PI / 180);
      if (kind === 'leaf') { const s = p.s; x.fillStyle = p.c; x.beginPath(); x.moveTo(0, -s); x.bezierCurveTo(s * 0.8, -s * 0.4, s * 0.6, s * 0.6, 0, s); x.bezierCurveTo(-s * 0.6, s * 0.6, -s * 0.8, -s * 0.4, 0, -s); x.fill(); }
      else if (kind === 'ice') { x.strokeStyle = light ? '#5b9bd5' : '#cfe8ff'; x.lineWidth = 1.4; for (let i = 0; i < 3; i++) { x.rotate(Math.PI / 3); x.beginPath(); x.moveTo(0, -p.s); x.lineTo(0, p.s); x.stroke(); } }
      else { x.fillStyle = light ? '#7fa7e8' : '#ffffff'; x.beginPath(); x.arc(0, 0, p.s, 0, 7); x.fill(); }
      x.restore();
    }
  }
  function applyHoliday() {
    const th = theme(), h = HOLIDAY[th];
    root.dataset.holiday = h ? th.replace(/-.*/, '') : '';
    cancelAnimationFrame(raf); parts = [];
    if (cv) cv.style.display = 'none';
    const reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!h || reduce) return;
    if (!cv) { cv = document.createElement('canvas'); cv.id = 'holidayFx'; cv.width = W; cv.height = H; const tv = document.getElementById('tv'); tv.insertBefore(cv, tv.firstChild); }
    cv.style.display = '';
    kind = h.kind; parts = Array.from({ length: h.n }, () => mk(true));
    raf = requestAnimationFrame(frame);
    if (window.DeskFx.onHoliday) window.DeskFx.onHoliday();
  }
  new MutationObserver(applyHoliday).observe(root, { attributes: true, attributeFilter: ['data-seasonal-theme'] });

  // ---------------------------------------------------------------- stay awake
  let lock = null;
  async function wake() {
    try { if ('wakeLock' in navigator && document.visibilityState === 'visible' && !lock) { lock = await navigator.wakeLock.request('screen'); lock.addEventListener('release', () => { lock = null; }); } } catch (e) { /* not allowed (e.g. battery saver) */ }
  }
  document.addEventListener('visibilitychange', wake);
  addEventListener('click', wake);

  // ---------------------------------------------------------------- connection
  let banner = null, fails = 0;
  function showBanner(on, text) {
    if (!banner) { banner = document.createElement('div'); banner.id = 'netBanner'; document.body.appendChild(banner); }
    banner.textContent = text || 'Reconnecting…';
    banner.classList.toggle('show', !!on);
  }
  addEventListener('offline', () => showBanner(true, 'Connection lost — reconnecting…'));
  addEventListener('online', () => { showBanner(false); if (window.DeskFx.onOnline) window.DeskFx.onOnline(); });
  function refreshResult(ok) { fails = ok ? 0 : fails + 1; showBanner(fails >= 2 || navigator.onLine === false, fails >= 2 ? 'Data feed interrupted — retrying…' : undefined); }

  // Reload once overnight (4-5am local) when nothing is live, so it can run for days.
  const loadedAt = Date.now();
  setInterval(() => {
    const h = new Date().getHours();
    const live = window.DeskData && window.DeskData.anyLive && window.DeskData.anyLive();
    if (!live && h === 4 && Date.now() - loadedAt > 3 * 3600 * 1000) location.reload();
  }, 10 * 60 * 1000);

  window.DeskFx = {
    holidayTag: (studio) => { const h = HOLIDAY[theme()]; return h ? h.tag[studio === 'casual' ? 'casual' : 'pro'] : ''; },
    holiday: theme, applyHoliday, wake, resize, refreshResult, onOnline: null, onHoliday: null,
  };
  applyHoliday(); wake();
})();
