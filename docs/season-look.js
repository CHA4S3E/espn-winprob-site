/* Holiday looks on the data pages (Standings, Outlook, Year in Review, Playoff Race, Display).
 * The Matchups page runs the full show (cinematics, garlands, countdown); here the page just wears the same weekly look:
 * the holiday background and accent colors, festive headings, and a light drift of leaves / snow / bats.
 * Which look applies mirrors app.js: the REAL NFL schedule decides the week (never a hardcoded number), meteor holidays
 * (Halloween / Thanksgiving / Christmas) only start at that week's first kickoff, Cold Snap runs the weeks around Christmas,
 * and the same Display-page debug toggles force a look for testing. */
(function () {
  'use strict';
  if (window.__seasonLook) return; window.__seasonLook = true;
  const SB = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';
  const CHAMP_WEEK = 17;
  const METEOR = { halloween: 1, thanksgiving: 1, christmas: 1 };
  const DAY = 86400000;
  const ls = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };

  const CSS = `
  html[data-seasonal-theme="halloween"] { --fest-font: 'Creepster', var(--font-display); }
html[data-theme="dark"][data-seasonal-theme="halloween"] { --fest-bg: radial-gradient(ellipse at 50% -10%, #5b2a86 0%, #2a1240 38%, #120a1c 78%); --fest-vignette: rgba(0,0,0,.5); --fest-frame: #ff8a1f; --fest-glow: rgba(255,138,31,.38); --fest-banner: linear-gradient(90deg,#ff8a1f,#c2410c 55%,#6d28d9); --fest-banner-text: #1a0b00; --accent: #ff8a1f; --accent-glow-a: rgba(255,138,31,0.35); --accent-glow-b: rgba(255,138,31,0.9); }
html[data-theme="light"][data-seasonal-theme="halloween"] { --fest-bg: radial-gradient(ellipse at 50% -10%, #ffd9a8 0%, #ffe9d0 40%, #fff6ec 80%); --fest-vignette: rgba(120,60,0,.14); --fest-frame: #e2640a; --fest-glow: rgba(226,100,10,.3); --fest-banner: linear-gradient(90deg,#ff9d3d,#e2640a 55%,#7c3aed); --fest-banner-text: #fff; --accent: #e2640a; --accent-glow-a: rgba(226,100,10,0.3); --accent-glow-b: rgba(226,100,10,0.8); }
html[data-seasonal-theme="thanksgiving"] { --fest-font: 'Fraunces', Georgia, serif; }
html[data-theme="dark"][data-seasonal-theme="thanksgiving"] { --fest-bg: radial-gradient(ellipse at 50% -10%, #7a3b12 0%, #3b1c0a 40%, #170c05 80%); --fest-vignette: rgba(0,0,0,.5); --fest-frame: #c9772b; --fest-glow: rgba(232,163,61,.34); --fest-banner: linear-gradient(90deg,#e8a33d,#b5441c 60%,#7a2e12); --fest-banner-text: #1b0c02; --accent: #e8a33d; --accent-glow-a: rgba(232,163,61,0.35); --accent-glow-b: rgba(232,163,61,0.9); }
html[data-theme="light"][data-seasonal-theme="thanksgiving"] { --fest-bg: radial-gradient(ellipse at 50% -10%, #ffe2b3 0%, #fff0d6 42%, #fff9ee 82%); --fest-vignette: rgba(140,70,10,.12); --fest-frame: #c9772b; --fest-glow: rgba(201,119,43,.3); --fest-banner: linear-gradient(90deg,#e8a33d,#c9772b 55%,#a23a14); --fest-banner-text: #fff; --accent: #c9772b; --accent-glow-a: rgba(201,119,43,0.3); --accent-glow-b: rgba(201,119,43,0.8); }
html[data-seasonal-theme="christmas"] { --fest-font: 'Cinzel Decorative', Georgia, serif; }
html[data-theme="dark"][data-seasonal-theme="christmas"] { --fest-bg: radial-gradient(ellipse at 50% -10%, #17603a 0%, #0c3321 40%, #07140d 80%); --fest-vignette: rgba(0,0,0,.5); --fest-frame: #ff4d4d; --fest-glow: rgba(255,77,77,.32); --fest-banner: linear-gradient(90deg,#d62828,#0b6b3a 60%,#d62828); --fest-banner-text: #fff; --accent: #ff4d4d; --accent-glow-a: rgba(255,77,77,0.35); --accent-glow-b: rgba(255,77,77,0.9); }
html[data-theme="light"][data-seasonal-theme="christmas"] { --fest-bg: radial-gradient(ellipse at 50% -10%, #ffd6d6 0%, #f2fff5 45%, #ffffff 85%); --fest-vignette: rgba(160,20,20,.1); --fest-frame: #d62828; --fest-glow: rgba(214,40,40,.26); --fest-banner: linear-gradient(90deg,#d62828,#0b6b3a 60%,#d62828); --fest-banner-text: #fff; --accent: #d62828; --accent-glow-a: rgba(214,40,40,0.3); --accent-glow-b: rgba(214,40,40,0.8); }
  html[data-seasonal-theme="halloween"] body, html[data-seasonal-theme="thanksgiving"] body, html[data-seasonal-theme="christmas"] body {
    background: radial-gradient(ellipse at center, transparent 55%, var(--fest-vignette) 100%), var(--fest-bg), var(--bg); background-attachment: fixed; }
  html[data-seasonal-theme="halloween"] body, html[data-seasonal-theme="thanksgiving"] body, html[data-seasonal-theme="christmas"] body { min-height: 100vh; }
  html[data-seasonal-theme] .page-title, html[data-seasonal-theme] h1, html[data-seasonal-theme] h2 { font-family: var(--fest-font, var(--font-display)); }
  html[data-seasonal-theme="christmas"] .page-title { letter-spacing: 0; }
  #sl_canvas { position: fixed; inset: 0; width: 100vw; height: 100vh; z-index: -1; pointer-events: none; }
  #sl_fx { --fog-color: rgba(108, 96, 132, 0.4); position: fixed; left: 0; right: 0; bottom: 0; pointer-events: none; z-index: -1; opacity: 0; transition: opacity 1.4s ease; height: 22vh; min-height: 140px; max-height: 260px; overflow: hidden; }
  html[data-theme="dark"] #sl_fx { --fog-color: rgba(176, 164, 205, 0.24); }
  html[data-seasonal-theme="halloween"] #sl_fx { opacity: 1; }
  #sl_fx i { position: absolute; top: 0; left: 0; height: 100%; width: 200%; background-repeat: repeat-x; filter: blur(8px); }
  #sl_fx i:nth-child(1) { background-image: radial-gradient(ellipse 60% 90% at 25% 100%, var(--fog-color) 0%, transparent 72%); background-size: 50% 100%; opacity: 0.55; animation: slDrift 46s linear infinite; }
  #sl_fx i:nth-child(2) { background-image: radial-gradient(ellipse 50% 85% at 70% 100%, var(--fog-color) 0%, transparent 72%); background-size: 50% 100%; opacity: 0.4; animation: slDrift 64s linear infinite reverse; }
  @keyframes slDrift { from { transform: translateX(0); } to { transform: translateX(-50%); } }
  html[data-reduce-motion="true"] #sl_fx i { animation: none !important; }
  #sl_frost { position: fixed; inset: 0; pointer-events: none; z-index: -1; opacity: 0; transition: opacity .6s ease; }
  html[data-seasonal-theme="coldsnap-pre"] #sl_frost, html[data-seasonal-theme="coldsnap-post"] #sl_frost { opacity: 1; }
  #sl_frost::before, #sl_frost::after { content: ''; position: absolute; bottom: 0; width: 46vw; height: 32vh; background: radial-gradient(ellipse at bottom, rgba(168,216,255,.22), transparent 70%); }
  html[data-theme="dark"] #sl_frost::before, html[data-theme="dark"] #sl_frost::after { background: radial-gradient(ellipse at bottom, rgba(140,190,255,.16), transparent 70%); }
  #sl_frost::before { left: 0; } #sl_frost::after { right: 0; }
  `;

  // ---- which look is it? (ported from app.js, same rules) ----
  const eastKey = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  const thanksKey = (y) => { const d = new Date(Date.UTC(y, 10, 1)); let n = 0; while (n < 4) { if (d.getUTCDay() === 4) n++; if (n < 4) d.setUTCDate(d.getUTCDate() + 1); } return `${y}-11-${String(d.getUTCDate()).padStart(2, '0')}`; };
  const cache = {};
  async function events(y, w) {
    const k = y + '-' + w; if (k in cache) return cache[k];
    try { const r = await fetch(`${SB}?year=${y}&week=${w}&seasontype=2`); if (!r.ok) throw 0; const j = await r.json(); cache[k] = (j.events || []).map((e) => new Date(e.date)).filter((d) => !isNaN(d)); }
    catch (e) { cache[k] = null; }
    return cache[k];
  }
  const startOf = async (y, w) => { const d = await events(y, w); return d && d.length ? new Date(Math.min(...d)) : null; };
  const hasDate = async (y, w, key) => { const d = await events(y, w); return !!d && d.some((x) => eastKey(x) === key); };
  const spans = async (y, w, key) => { const s = await startOf(y, w), n = await startOf(y, w + 1); if (!s) return false; const t = new Date(key + 'T12:00:00Z'); return t >= s && (!n || t < n); };
  const shifted = (y) => hasDate(y, CHAMP_WEEK, `${y}-12-25`);
  const isXmas = async (y, w) => { if (w === CHAMP_WEEK) return false; if (w === CHAMP_WEEK - 1 && await shifted(y)) return true; return hasDate(y, w, `${y}-12-25`); };
  async function realTheme(y, w) {
    try {
      if (w === CHAMP_WEEK) return 'none';
      if (await spans(y, w, `${y}-10-31`)) return 'halloween';
      if (await hasDate(y, w, thanksKey(y))) return 'thanksgiving';
      if (await isXmas(y, w)) return 'christmas';
      if (await isXmas(y, w + 1)) return 'coldsnap-pre';
      if (!(await shifted(y)) && await isXmas(y, w - 1)) return 'coldsnap-post';
    } catch (e) { /* fall through */ }
    return 'none';
  }
  async function currentTheme() {
    if (ls('winProbDebugThanksgivingWeek') === 'true') return 'thanksgiving';
    if (ls('winProbDebugChristmasWeek') === 'true') return 'christmas';
    if (ls('winProbDebugHalloweenWeek') === 'true') return 'halloween';
    if (ls('winProbDebugColdSnapPreWeek') === 'true') return 'coldsnap-pre';
    if (ls('winProbDebugColdSnapPostWeek') === 'true') return 'coldsnap-post';
    const now = Date.now();
    let r; try { r = await (await fetch(`${SB}?seasontype=2`)).json(); } catch (e) { return 'none'; }
    const y = r && r.season && r.season.year, wk = r && r.week && r.week.number; if (!y || !wk) return 'none';
    // latest week the site shows = the current week, or next week once its Power Picks are up (~2 days before kickoff)
    let latest = wk;
    const nxt = await startOf(y, wk + 1), cur = await startOf(y, wk);
    if (nxt && nxt.getTime() - now <= 2 * DAY && nxt.getTime() > now) latest = wk + 1;
    else if (cur && now < cur.getTime() - 2 * DAY && wk > 1) latest = wk - 1;
    const theme = await realTheme(y, latest);
    if (METEOR[theme]) { const s = await startOf(y, latest); if (s && now < s.getTime()) return 'none'; }
    return theme;
  }

  // ---- decor ----
  function addFonts() {
    if (document.getElementById('sl_fonts')) return;
    const l = document.createElement('link'); l.id = 'sl_fonts'; l.rel = 'stylesheet';
    l.href = 'https://fonts.googleapis.com/css2?family=Creepster&family=Fraunces:opsz,wght@9..144,600;9..144,700&family=Cinzel+Decorative:wght@700&display=swap'; document.head.appendChild(l);
  }
  // Particle field: a straight port of app.js's makeSeasonalParticle / stepSeasonalParticle / drawSeasonalParticle so every page
  // draws the SAME leaves, bats, snow and ice crystals as the Matchups page (same counts, sizes, speeds and shapes).
  const LEAF_COLORS = ['#c65d1e', '#d98324', '#8a3b12', '#e0a940', '#9c4a1a', '#b8461f'];
  const COUNTS = { thanksgiving: 45, christmas: 90, halloween: 22, coldsnap: 28 };
  const rnd = (a, b) => a + Math.random() * (b - a), pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const cssTheme = (t) => (t === 'coldsnap-pre' || t === 'coldsnap-post' ? 'coldsnap' : t);
  const isLight = () => document.documentElement.getAttribute('data-theme') === 'light';
  function mkBat(w, h, initial) {
    const dirX = pick([-1, 1]);
    return { isBat: true, x: initial ? rnd(0, w) : (dirX === 1 ? -30 : w + 30), y: rnd(h * 0.06, h * 0.55), dirX, speed: rnd(1.1, 2.3), size: rnd(24, 34), bobSpeed: rnd(0.6, 1.3), bobPhase: rnd(0, Math.PI * 2), flapPhase: rnd(0, Math.PI * 2), opacity: rnd(0.82, 1) };
  }
  function mkIce(w, h, initial) {
    return { x: rnd(0, w), y: initial ? rnd(0, h) : rnd(-40, -10), size: rnd(5, 10), speedY: rnd(0.25, 0.6), speedX: rnd(-0.15, 0.15), swayAmp: rnd(10, 28), swaySpeed: rnd(0.2, 0.5), swayPhase: rnd(0, Math.PI * 2), rotation: rnd(0, 360), rotSpeed: rnd(-0.3, 0.3), twinklePhase: rnd(0, Math.PI * 2), twinkleSpeed: rnd(0.4, 0.9), baseOpacity: rnd(0.35, 0.7) };
  }
  function mk(theme, w, h, initial) {
    const leaf = theme === 'thanksgiving';
    if (theme === 'halloween') return mkBat(w, h, initial);
    if (cssTheme(theme) === 'coldsnap') return mkIce(w, h, initial);
    return { x: rnd(0, w), y: initial ? rnd(0, h) : rnd(-40, -10), size: leaf ? rnd(9, 16) : rnd(2.5, 5.5), speedY: leaf ? rnd(0.5, 1.1) : rnd(0.7, 1.7), speedX: rnd(-0.2, 0.2), swayAmp: rnd(15, 40), swaySpeed: rnd(0.4, 1.0), swayPhase: rnd(0, Math.PI * 2), rotation: rnd(0, 360), rotSpeed: rnd(-1.2, 1.2), color: leaf ? pick(LEAF_COLORS) : '#ffffff', opacity: leaf ? rnd(0.75, 1) : rnd(0.45, 0.95) };
  }
  function step(p, theme, t, w, h) {
    if (p.isBat) { p.x += p.dirX * p.speed; p.y += Math.sin(t * 0.001 * p.bobSpeed + p.bobPhase) * 0.4; const m = p.size * 2; if (p.x < -m) { p.dirX = 1; p.x = -m; } else if (p.x > w + m) { p.dirX = -1; p.x = w + m; } return; }
    p.y += p.speedY; p.x += p.speedX + Math.sin(t * 0.001 * p.swaySpeed + p.swayPhase) * (p.swayAmp * 0.01); p.rotation += p.rotSpeed;
    if (p.y > h + 30) Object.assign(p, mk(theme, w, h, false));
  }
  function drawLeaf(c, p) {
    c.save(); c.translate(p.x, p.y); c.rotate(p.rotation * Math.PI / 180); c.globalAlpha = p.opacity; c.fillStyle = p.color; c.beginPath();
    const s = p.size; c.moveTo(0, -s); c.bezierCurveTo(s * 0.8, -s * 0.4, s * 0.6, s * 0.6, 0, s); c.bezierCurveTo(-s * 0.6, s * 0.6, -s * 0.8, -s * 0.4, 0, -s); c.fill();
    c.strokeStyle = 'rgba(0,0,0,0.25)'; c.lineWidth = 0.6; c.beginPath(); c.moveTo(0, -s * 0.85); c.lineTo(0, s * 0.85); c.stroke(); c.restore();
  }
  function drawSnow(c, p) {
    const L = isLight(); c.save(); c.globalAlpha = p.opacity; c.fillStyle = L ? '#1a3fa0' : '#ffffff'; c.shadowColor = L ? 'rgba(26, 63, 160, 0.45)' : 'rgba(255,255,255,0.8)'; c.shadowBlur = 4;
    c.beginPath(); c.arc(p.x, p.y, p.size, 0, Math.PI * 2); c.fill(); c.restore();
  }
  function drawBat(c, p, t) {
    const L = isLight(); c.save(); c.translate(p.x, p.y); c.scale(p.dirX, 1); c.globalAlpha = p.opacity;
    c.shadowColor = L ? 'rgba(91, 42, 134, 0.4)' : 'rgba(190, 150, 255, 0.55)'; c.shadowBlur = 10; c.fillStyle = L ? '#241f33' : '#4a3d66'; c.strokeStyle = L ? 'rgba(91, 42, 134, 0.55)' : 'rgba(214, 190, 255, 0.6)'; c.lineWidth = 1;
    const s = p.size, flap = 0.5 + 0.5 * Math.sin(t * 0.008 + p.flapPhase), ww = s * (0.85 + flap * 0.55);
    c.beginPath(); c.moveTo(0, 0); c.quadraticCurveTo(-ww * 0.5, -s * 0.65, -ww, 0); c.quadraticCurveTo(-ww * 0.55, s * 0.18, -ww * 0.3, -s * 0.05); c.quadraticCurveTo(-s * 0.15, s * 0.12, 0, 0);
    c.quadraticCurveTo(s * 0.15, s * 0.12, ww * 0.3, -s * 0.05); c.quadraticCurveTo(ww * 0.55, s * 0.18, ww, 0); c.quadraticCurveTo(ww * 0.5, -s * 0.65, 0, 0); c.fill(); c.stroke(); c.restore();
  }
  function drawIce(c, p, t) {
    const L = isLight(), tw = 0.65 + 0.35 * Math.sin(t * 0.001 * p.twinkleSpeed + p.twinklePhase);
    c.save(); c.translate(p.x, p.y); c.rotate(p.rotation * Math.PI / 180); c.globalAlpha = p.baseOpacity * tw; c.strokeStyle = L ? '#5b9bd5' : '#bfe0ff'; c.lineWidth = Math.max(0.8, p.size * 0.1); c.lineCap = 'round';
    const s = p.size;
    for (let i = 0; i < 3; i++) { c.save(); c.rotate((Math.PI / 3) * i); c.beginPath(); c.moveTo(0, -s); c.lineTo(0, s); c.stroke(); c.beginPath(); c.moveTo(0, -s); c.lineTo(s * 0.3, -s * 0.65); c.moveTo(0, -s); c.lineTo(-s * 0.3, -s * 0.65); c.moveTo(0, s); c.lineTo(s * 0.3, s * 0.65); c.moveTo(0, s); c.lineTo(-s * 0.3, s * 0.65); c.stroke(); c.restore(); }
    c.restore();
  }
  const draw = (c, theme, p, t) => { if (theme === 'thanksgiving') drawLeaf(c, p); else if (theme === 'halloween') drawBat(c, p, t); else if (cssTheme(theme) === 'coldsnap') drawIce(c, p, t); else drawSnow(c, p); };

  const reduce = () => document.documentElement.getAttribute('data-reduce-motion') === 'true' || (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  let raf = 0, cv = null, ctx = null, parts = [], cur = 'none';
  const size = () => { if (cv) { cv.width = innerWidth; cv.height = innerHeight; } };
  function stopParticles() { cancelAnimationFrame(raf); raf = 0; if (cv) cv.remove(); cv = null; ctx = null; parts = []; }
  function startParticles(theme) {
    stopParticles(); cur = theme; if (reduce()) return;
    cv = document.createElement('canvas'); cv.id = 'sl_canvas'; document.body.insertBefore(cv, document.body.firstChild); ctx = cv.getContext('2d'); size();
    parts = Array.from({ length: COUNTS[cssTheme(theme)] || 0 }, () => mk(theme, cv.width, cv.height, true));
    const tick = (t) => { raf = requestAnimationFrame(tick); ctx.clearRect(0, 0, cv.width, cv.height); for (const p of parts) { step(p, cur, t, cv.width, cv.height); draw(ctx, cur, p, t); } };
    raf = requestAnimationFrame(tick);
  }
  addEventListener('resize', size);
  function apply(theme) {
    const root = document.documentElement;
    if (!theme || theme === 'none') { root.removeAttribute('data-seasonal-theme'); stopParticles(); return; }
    addFonts(); root.setAttribute('data-seasonal-theme', theme);
    if (!document.getElementById('sl_fx')) { const f = document.createElement('div'); f.id = 'sl_fx'; f.innerHTML = '<i></i><i></i>'; document.body.appendChild(f); const fr = document.createElement('div'); fr.id = 'sl_frost'; document.body.appendChild(fr); }
    startParticles(theme);
  }

  // Runs as early as possible (script lives in <head>): inject the CSS and stamp the cached theme on <html> before first paint,
  // so there is no flash of the default (blue) look while the page loads.
  let saved = null; try { saved = JSON.parse(ls('winProbSeasonLook') || 'null'); } catch (e) { /* ignore */ }
  const fresh = saved && saved.theme && Date.now() - saved.t < 6 * 3600 * 1000;
  { const st = document.createElement('style'); st.textContent = CSS; (document.head || document.documentElement).appendChild(st); }
  if (fresh && saved.theme !== 'none') document.documentElement.setAttribute('data-seasonal-theme', saved.theme);
  async function init() {
    if (fresh) apply(saved.theme);
    const theme = await currentTheme();
    try { localStorage.setItem('winProbSeasonLook', JSON.stringify({ theme, t: Date.now() })); } catch (e) { /* ignore */ }
    if (!fresh || saved.theme !== theme) apply(theme);
  }
  if (document.body) init(); else document.addEventListener('DOMContentLoaded', init);
})();
