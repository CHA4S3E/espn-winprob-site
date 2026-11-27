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
  #sl_canvas { position: fixed; inset: 0; width: 100%; height: 100%; pointer-events: none; z-index: 0; }
  #sl_fx { position: fixed; left: 0; right: 0; bottom: 0; pointer-events: none; z-index: 0; opacity: 0; transition: opacity 1.4s ease; height: 22vh; min-height: 140px; max-height: 260px; overflow: hidden; }
  html[data-seasonal-theme="halloween"] #sl_fx { opacity: 1; }
  #sl_fx i { position: absolute; top: 0; left: 0; height: 100%; width: 200%; background-repeat: repeat-x; background-size: 50% 100%; filter: blur(8px); }
  #sl_fx i:nth-child(1) { background-image: radial-gradient(ellipse 60% 90% at 25% 100%, rgba(170,120,220,.35) 0%, transparent 72%); opacity: .55; animation: slDrift 46s linear infinite; }
  #sl_fx i:nth-child(2) { background-image: radial-gradient(ellipse 50% 85% at 70% 100%, rgba(255,150,60,.25) 0%, transparent 72%); opacity: .4; animation: slDrift 64s linear infinite reverse; }
  @keyframes slDrift { from { transform: translateX(0); } to { transform: translateX(-50%); } }
  html[data-reduce-motion="true"] #sl_fx i { animation: none !important; }
  #sl_frost { position: fixed; inset: 0; pointer-events: none; z-index: 0; opacity: 0; transition: opacity .6s ease; }
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
  let raf = 0, cv = null, parts = [];
  const reduce = () => document.documentElement.getAttribute('data-reduce-motion') === 'true' || (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  function stopParticles() { cancelAnimationFrame(raf); raf = 0; if (cv) cv.remove(); cv = null; parts = []; }
  function startParticles(theme) {
    stopParticles(); if (reduce()) return;
    const kind = theme === 'thanksgiving' ? 'leaf' : theme === 'halloween' ? 'bat' : 'snow';
    const N = { leaf: 22, bat: 9, snow: theme === 'christmas' ? 70 : 28 }[kind];
    cv = document.createElement('canvas'); cv.id = 'sl_canvas'; document.body.appendChild(cv);
    const x = cv.getContext('2d'); const size = () => { cv.width = innerWidth; cv.height = innerHeight; }; size(); addEventListener('resize', size);
    const light = document.documentElement.getAttribute('data-theme') === 'light';
    const mk = (init) => ({ x: Math.random() * cv.width, y: init ? Math.random() * cv.height : -20, r: 2 + Math.random() * 3, v: .3 + Math.random() * .9, s: Math.random() * 6, a: .5 + Math.random() * .5, e: ['🍁', '🍂', '🍃'][Math.floor(Math.random() * 3)] });
    parts = Array.from({ length: N }, () => mk(true));
    const t0 = performance.now();
    const f = (now) => {
      raf = requestAnimationFrame(f); const t = (now - t0) / 1000; x.clearRect(0, 0, cv.width, cv.height);
      for (const p of parts) {
        if (kind === 'bat') { p.x += p.v * 1.4; p.y += Math.sin(t * 1.5 + p.s) * .8; if (p.x > cv.width + 30) { p.x = -30; p.y = Math.random() * cv.height * .7; } x.globalAlpha = .55; x.font = (14 + p.r * 2) + 'px serif'; x.fillText('\u{1F987}', p.x, p.y); continue; }
        p.y += p.v * (kind === 'leaf' ? 1.1 : .8); p.x += Math.sin(t + p.s) * (kind === 'leaf' ? .9 : .4);
        if (p.y > cv.height + 20) { p.y = -20; p.x = Math.random() * cv.width; }
        x.globalAlpha = p.a * .8;
        if (kind === 'leaf') { x.font = (14 + p.r * 3) + 'px serif'; x.fillText(p.e, p.x, p.y); }
        else { x.fillStyle = light ? '#1a3fa0' : '#fff'; x.beginPath(); x.arc(p.x, p.y, p.r * .7, 0, 6.3); x.fill(); }
      }
    };
    raf = requestAnimationFrame(f);
  }
  function apply(theme) {
    const root = document.documentElement;
    if (!theme || theme === 'none') { root.removeAttribute('data-seasonal-theme'); stopParticles(); return; }
    addFonts(); root.setAttribute('data-seasonal-theme', theme);
    if (!document.getElementById('sl_fx')) { const f = document.createElement('div'); f.id = 'sl_fx'; f.innerHTML = '<i></i><i></i>'; document.body.appendChild(f); const fr = document.createElement('div'); fr.id = 'sl_frost'; document.body.appendChild(fr); }
    startParticles(theme === 'coldsnap-pre' || theme === 'coldsnap-post' ? 'coldsnap' : theme);
  }

  async function init() {
    const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
    // instant paint from the last answer (so the look doesn't pop in late), then confirm against the live schedule
    let saved = null; try { saved = JSON.parse(ls('winProbSeasonLook') || 'null'); } catch (e) { /* ignore */ }
    if (saved && saved.theme && Date.now() - saved.t < 6 * 3600 * 1000) apply(saved.theme);
    const theme = await currentTheme();
    try { localStorage.setItem('winProbSeasonLook', JSON.stringify({ theme, t: Date.now() })); } catch (e) { /* ignore */ }
    if (!saved || saved.theme !== theme || Date.now() - saved.t >= 6 * 3600 * 1000) apply(theme);
  }
  if (document.body) init(); else document.addEventListener('DOMContentLoaded', init);
})();
