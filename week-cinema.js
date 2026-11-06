/* Week cinematic: "Play the week" replay under the week recap. Self-contained; opened via window.WeekCinema.open(). */
(function () {
  'use strict';
  const CSS = '#wc_cine { --text: #e8ebf3; --muted: #9aa2b6; --A: #4f8cff; color: var(--text); font-family: system-ui, -apple-system, sans-serif; }\n#wc_cine button { font: inherit; color: var(--text); border: 1px solid rgba(255,255,255,.2); border-radius: 8px; cursor: pointer; }\n#wc_cine .final .btns { display: flex; gap: 8px; justify-content: center; }\n#wc_cine .final .btns button { padding: 10px 16px; background: rgba(255,255,255,.1); }\n@keyframes upp { from { filter: brightness(.8); } to { filter: brightness(1.4); } }\n#wc_cine { position: fixed; inset: 0; z-index: 50; background: #05060a; display: none; }\n#wc_cine.on { display: block; }\n#wc_cine canvas { position: absolute; inset: 0; width: 100%; height: 100%; }\n#wc_cine .hud { position: absolute; left: 0; right: 0; top: 0; padding: 16px 20px; display: flex; justify-content: space-between; align-items: flex-start; pointer-events: none; }\n#wc_cine .hud .side { display: grid; gap: 2px; }\n#wc_cine .hud .side.r { text-align: right; }\n#wc_cine .hud .tn { font-weight: 800; font-size: clamp(15px, 3vw, 22px); }\n#wc_cine .hud .sc { font-size: clamp(26px, 6vw, 46px); font-weight: 800; font-variant-numeric: tabular-nums; }\n#wc_cine .hud .mid { text-align: center; color: var(--muted); font-size: 12px; letter-spacing: .12em; text-transform: uppercase; padding-top: 6px; }\n#wc_cine .cup { display: none; font-style: normal; font-weight: 800; font-size: 11px; letter-spacing: .1em; margin-top: 5px; padding: 2px 10px; border-radius: 999px; background: var(--upc, #ff5a5f); color: #0b0d11; animation: upp 1s ease-in-out infinite alternate; }\n#wc_cine .cup.on { display: inline-block; }\n#wc_cine .hud .mid b { display: block; color: var(--text); font-size: 13px; margin-top: 2px; }\n#wc_cine .lower { position: absolute; left: 0; right: 0; bottom: 70px; display: flex; justify-content: center; pointer-events: none; }\n#wc_cine .cap { opacity: 0; transform: translateY(14px) scale(.96); transition: opacity .25s, transform .25s; text-align: center; padding: 10px 22px; border-radius: 12px; background: rgba(8,10,16,.82); border: 1.5px solid var(--c, #fff); box-shadow: 0 0 30px -4px var(--c, #fff); }\n#wc_cine .cap.show { opacity: 1; transform: none; }\n#wc_cine .cap .k { font-size: 11px; letter-spacing: .18em; text-transform: uppercase; color: var(--c); font-weight: 700; }\n#wc_cine .cap .m { font-size: clamp(16px, 3.4vw, 26px); font-weight: 800; }\n#wc_cine .cap.big .m { font-size: clamp(22px, 5vw, 40px); }\n#wc_cine .cap.big { padding: 14px 30px; }\n#wc_cine .bar { position: absolute; left: 20px; right: 20px; bottom: 26px; height: 6px; border-radius: 3px; background: rgba(255,255,255,.1); }\n#wc_cine .bar i { position: absolute; left: 0; top: 0; bottom: 0; border-radius: 3px; background: linear-gradient(90deg, var(--A), #fff); width: 0; }\n#wc_cine .days { position: absolute; left: 20px; right: 20px; bottom: 36px; display: flex; justify-content: space-between; font-size: 10px; color: var(--muted); letter-spacing: .1em; text-transform: uppercase; }\n#wc_cine .ctl { position: absolute; right: 16px; bottom: 54px; display: flex; gap: 8px; }\n#wc_cine .ctl button { padding: 6px 10px; font-size: 12px; background: rgba(255,255,255,.08); }\n#wc_cine .dots { position: absolute; left: 0; right: 0; top: 74px; display: flex; justify-content: center; gap: 8px; pointer-events: none; }\n#wc_cine .dots i { width: 22px; height: 4px; border-radius: 2px; background: rgba(255,255,255,.18); }\n#wc_cine .dots i.on { background: #fff; }\n#wc_cine .dots i.done { background: rgba(255,255,255,.55); }\n#wc_cine .final { position: absolute; inset: 0; display: none; align-items: center; justify-content: center; background: rgba(4,5,9,.78); text-align: center; }\n#wc_cine .final.show { display: flex; }\n#wc_cine .final .box { padding: 24px 30px; max-width: 520px; }\n#wc_cine .final h2 { margin: 0 0 6px; font-size: clamp(22px, 5vw, 34px); }\n#wc_cine .final p { margin: 4px 0; color: var(--muted); }\n#wc_cine .final .big { font-size: clamp(28px, 7vw, 54px); font-weight: 800; font-variant-numeric: tabular-nums; margin: 8px 0; }\n#wc_cine .final ul { text-align: left; margin: 12px auto; padding: 0 0 0 18px; color: var(--text); }\n#wc_cine .final li { margin: 4px 0; }';
  const HTML = '<canvas id="wc_cc"></canvas>\n  <div class="hud">\n    <div class="side"><span class="tn" id="wc_cTnH"></span><span class="sc" id="wc_cScH">0.0</span></div>\n    <div class="mid"><span id="wc_cWeek"></span><b id="wc_cClock"></b><i id="wc_cUp" class="cup">\u{1F6A8} UPSET WATCH</i></div>\n    <div class="side r"><span class="tn" id="wc_cTnA"></span><span class="sc" id="wc_cScA">0.0</span></div>\n  </div>\n  <div class="dots" id="wc_cDots"></div>\n  <div class="lower"><div class="cap" id="wc_cap"><div class="k" id="wc_capK"></div><div class="m" id="wc_capM"></div></div></div>\n  <div class="days"><span id="wc_d0"></span><span id="wc_d1"></span></div>\n  <div class="bar"><i id="wc_cBar"></i></div>\n  <div class="ctl"><button id="wc_cFast">1x</button><button id="wc_cSkip">Skip matchup &#9654;&#9654;</button><button id="wc_cClose">Close &#10005;</button></div>\n  <div class="final" id="wc_cFinal"><div class="box" id="wc_cFinalBox"></div></div>';
  const $ = (id) => document.getElementById(id);
  const rgba = (hex, a) => { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${Number.isFinite(a) ? a : 0})`; };
  const SCORE_MIN = 5; // points: a score smaller than this isn't an event (no burst, no slow-down)
  const fit = (n, k = 18) => (n.length > k ? n.slice(0, k - 1) + '…' : n);
  // A lead only "changes" once the new leader is clearly ahead (>= 60%), so a super close game
  // wobbling around 50% doesn't flag every flip. Returns the confirmed side after each point.
  const LEAD_CONFIRM = 60;
  function confSeq(p) { let s = null; return p.map((v) => { if (v >= LEAD_CONFIRM) s = 'h'; else if (v <= 100 - LEAD_CONFIRM) s = 'a'; return s; }); }

  // shared burst renderer (live chart + cinematic). `k` scales the size of the whole burst.
  function drawBursts(c, list, now, hx, hy, area, k) {
    let tagIdx = 0;
    for (let i = list.length - 1; i >= 0; i--) {
      const b = list[i], age = (now - b.t0) / 1000, sz = (b.scale || 1) * k, life = 2.4 + (b.scale ? (b.scale - 1) * 1.2 : 0);
      if (age > life) { list.splice(i, 1); continue; }
      c.save(); c.globalCompositeOperation = 'lighter';
      for (const [j, d] of [[0, 0], [1, 0.12], [2, 0.26]]) { const u = (age - d) / 0.9; if (u < 0 || u > 1) continue; c.strokeStyle = rgba(b.color, 0.9 * (1 - u)); c.lineWidth = (3 - j * 0.7) * Math.min(2, sz); c.beginPath(); c.arc(hx, hy, 6 + u * (b.kind === 'score' ? 64 : 48) * sz, 0, 6.3); c.stroke(); }
      const R = 42 * sz, fl = c.createRadialGradient(hx, hy, 0, hx, hy, R); fl.addColorStop(0, rgba(b.color, Math.max(0, 0.55 - age * 1.1))); fl.addColorStop(1, rgba(b.color, 0)); c.fillStyle = fl; c.beginPath(); c.arc(hx, hy, R, 0, 6.3); c.fill();
      for (const sp of b.sparks) { const x = hx + sp.vx * age * 36 * sz, y = hy + sp.vy * age * 36 * sz + 30 * age * age, lf = 1 - age / (1.6 + (sz - 1) * 0.6); if (lf <= 0) continue; c.fillStyle = sp.hot ? `rgba(255,248,230,${lf})` : rgba(b.color, lf); c.beginPath(); c.arc(x, y, sp.r * (0.6 + lf * 0.6) * Math.min(2, sz), 0, 6.3); c.fill(); }
      c.restore();
      if (b.noTag) continue;
      const ta = age < 0.15 ? age / 0.15 : Math.max(0, 1 - (age - 1.3) / 1.0), ty = Math.max(area.top + 12, hy - 24 - age * 22 - tagIdx * 28);
      if (ta > 0) {
        c.save(); c.globalAlpha = ta; c.font = '700 12px system-ui, sans-serif'; const tw = c.measureText(b.label).width + 18, tx = Math.min(area.right - tw / 2, Math.max(area.left + tw / 2, hx));
        c.fillStyle = 'rgba(10,12,18,.85)'; c.strokeStyle = rgba(b.color, 0.9); c.lineWidth = 1.5; c.beginPath(); c.roundRect(tx - tw / 2, ty - 11, tw, 22, 11); c.fill(); c.stroke();
        c.fillStyle = b.color; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(b.label, tx, ty + 1); c.restore(); tagIdx++;
      }
    }
  }
  let cine, cc, cx, built = false;
  let CW = 0, CH = 0, cdpr = 1;
  function cresize() { cdpr = Math.min(window.devicePixelRatio || 1, 2); CW = window.innerWidth; CH = window.innerHeight; cc.width = Math.round(CW * cdpr); cc.height = Math.round(CH * cdpr); cx.setTransform(cdpr, 0, 0, cdpr, 0, 0); }
  window.addEventListener('resize', () => { if (cine && cine.classList.contains('on')) cresize(); });

  let mi = 0, tt = 0, running = false, speedMul = 1, hold = 0, evPtr = 0, camZoom = 1, vignette = 0, slowShown = 0, finishedAt = 0, endState = null;
  const cBursts = [], cRipples = [];
  const stats = []; let MATCHUPS = [], WEEK = '';
  let capEl;
  const DUR = 11; // seconds per matchup at normal speed (before slowdowns)

  function setDots() { $('wc_cDots').innerHTML = MATCHUPS.map((_, k) => `<i class="${k < mi ? 'done' : k === mi ? 'on' : ''}"></i>`).join(''); }
  function startMatchup(k) {
    mi = k; tt = 0; hold = 0; evPtr = 0; camZoom = 1; vignette = 0; cBursts.length = 0; cRipples.length = 0; endState = null;
    const m = MATCHUPS[mi];
    $('wc_cTnH').textContent = m.h.name; $('wc_cTnH').style.color = m.h.color; $('wc_cTnA').textContent = m.a.name; $('wc_cTnA').style.color = m.a.color;
    $('wc_cScH').textContent = '0.0'; $('wc_cScA').textContent = '0.0'; $('wc_cFinal').classList.remove('show'); capEl.classList.remove('show'); setDots();
    m.stat = { slow: 0 };
  }
  function closeCine() { running = false; cine.classList.remove('on'); document.body.style.overflow = ''; }

  function showCap(ev, big) {
    capEl.style.setProperty('--c', ev.color); $('wc_capK').textContent = ev.kind === 'score' ? 'Score' : ev.kind === 'lead' ? 'Lead change' : ev.kind === 'upset' ? 'Upset watch' : 'Final';
    $('wc_capM').textContent = ev.label; capEl.classList.toggle('big', !!big); capEl.classList.add('show');
  }

  let lastT = 0, capUntil = 0;
  function cineFrame(now) {
    if (!running) return;
    const dt = Math.max(0, Math.min(0.05, (now - lastT) / 1000)); lastT = now;
    const m = MATCHUPS[mi], base = (NP / DUR) * speedMul; // points per second
    // ---- pacing: the bigger the next event, the earlier and deeper it slows ----
    let factor = 1, zoomT = 1, vigT = 0;
    const next = m.events[evPtr];
    if (hold > 0) { hold -= dt; factor = 0; zoomT = camZoom; vigT = vignette; }
    else if (next && !endState) {
      const w = next.w, ahead = next.i - tt, win = 3 + 9 * w; // bigger events start slowing sooner
      if (ahead < win) {
        const u = Math.max(0, 1 - ahead / win), e = u * u * (3 - 2 * u);
        const floor = 0.78 - 0.73 * Math.pow(w, 1.4); // minor ~0.7x (barely slows), huge ~0.05x
        factor = 1 - (1 - floor) * e;
        zoomT = 1 + (0.12 + 0.55 * w) * e; vigT = (0.15 + 0.6 * w) * e;
      }
      if (tt >= next.i) { trigger(next); evPtr++; hold = (0.05 + 1.6 * Math.pow(next.w, 1.6)) / (speedMul > 1 ? 1.6 : 1); }
    }
    if (endState) { factor = 0; zoomT = 1.06; vigT = 0.35; }
    tt = Math.min(NP - 1, tt + base * factor * dt);
    camZoom += (zoomT - camZoom) * Math.min(1, dt * 5); vignette += (vigT - vignette) * Math.min(1, dt * 5);
    if (factor < 0.6) m.stat.slow += dt;
    draw(m, now);
    if (!endState && tt >= NP - 1 && evPtr >= m.events.length) { endState = { t0: now }; }
    if (endState && now - endState.t0 > 3200) { if (mi < MATCHUPS.length - 1) startMatchup(mi + 1); else { showWeekSummary(); return; } }
    if (capUntil && now > capUntil) { capEl.classList.remove('show'); capUntil = 0; }
    requestAnimationFrame(cineFrame);
  }
  function trigger(ev) {
    const m = MATCHUPS[mi], k = Math.max(0.8, 0.8 + ev.w * 1.6); // burst size scales with the moment
    cBursts.push({ t0: performance.now(), sparks: mkSparks(ev.kind === 'score' ? 26 : 40 + Math.round(ev.w * 30)), kind: ev.kind === 'score' ? 'score' : 'lead', color: ev.color, scale: k, noTag: true });
    showCap(ev, ev.w >= 0.7 || ev.big);
    capUntil = performance.now() + 1500 + ev.w * 2200;
    if (ev.big) { cBursts.push({ t0: performance.now() + 140, sparks: mkSparks(60), kind: 'lead', color: '#ffffff', scale: k * 1.3, noTag: true }); }
    if (ev.kind === 'final') { const hw = m.p[NP - 1] >= 50; $('wc_capK').textContent = 'Final'; }
    if (ev.kind === 'final') { stats.push({ m, big: m.events.find((e) => e.big), slow: m.stat.slow }); }
  }
  function mkSparks(n) { const a = []; for (let i = 0; i < n; i++) { const an = Math.random() * 6.28, s = 0.6 + Math.random() * 2.8; a.push({ vx: Math.cos(an) * s, vy: Math.sin(an) * s - 0.8, r: 1 + Math.random() * 2, hot: Math.random() < 0.4 }); } return a; }

  const CP = { l: 60, r: 40, t: 150, b: 130 };
  function draw(m, now) {
    const t = now / 1000, W2 = CW, H2 = CH;
    cx.fillStyle = '#05060a'; cx.fillRect(0, 0, W2, H2);
    const cxp = (i) => CP.l + (W2 - CP.l - CP.r) * (i / (NP - 1)), cyp = (p) => CP.t + (H2 - CP.t - CP.b) * (1 - p / 100);
    const head = Math.min(NP - 1, tt), hi = Math.floor(head), fr = head - hi;
    const hv = m.p[hi] + ((m.p[Math.min(NP - 1, hi + 1)] - m.p[hi]) * fr), hx = cxp(head), hy = cyp(hv);
    // camera: zoom toward the head
    cx.save(); cx.translate(hx, hy); cx.scale(camZoom, camZoom); cx.translate(-hx, -hy);
    const lead = hv >= 50 ? m.h : m.a, strength = Math.min(1, Math.abs(hv - 50) / 45);
    const gy = hv >= 50 ? CP.t : H2 - CP.b, g = cx.createRadialGradient(W2 / 2, gy, 0, W2 / 2, gy, W2 * 0.6); g.addColorStop(0, rgba(lead.color, 0.1 + 0.14 * strength)); g.addColorStop(1, rgba(lead.color, 0)); cx.fillStyle = g; cx.fillRect(0, 0, W2, H2);
    for (const gv of [0, 25, 50, 75, 100]) { cx.strokeStyle = gv === 50 ? 'rgba(255,255,255,.3)' : 'rgba(255,255,255,.07)'; cx.lineWidth = gv === 50 ? 1.5 : 1; cx.beginPath(); cx.moveTo(CP.l, cyp(gv)); cx.lineTo(W2 - CP.r, cyp(gv)); cx.stroke(); }
    cx.font = '12px system-ui'; cx.textAlign = 'left'; cx.fillStyle = m.h.color; cx.fillText('100%', 8, cyp(100) + 4); cx.fillStyle = '#9aa2b6'; cx.fillText('50', 20, cyp(50) + 4); cx.fillStyle = m.a.color; cx.fillText('100%', 8, cyp(0) + 4);
    // fill + line up to the head
    const y50 = cyp(50), gH = cx.createLinearGradient(0, cyp(100), 0, y50), gA = cx.createLinearGradient(0, cyp(0), 0, y50);
    gH.addColorStop(0, rgba(m.h.color, 0.36)); gH.addColorStop(1, rgba(m.h.color, 0.03)); gA.addColorStop(0, rgba(m.a.color, 0.36)); gA.addColorStop(1, rgba(m.a.color, 0.03));
    // insert an exact point wherever the line crosses 50%, so the color flips right at the 50% line
    const P0 = []; for (let i = 0; i <= hi; i++) P0.push([cxp(i), cyp(m.p[i])]); P0.push([hx, hy]);
    const P = [P0[0]]; for (let i = 1; i < P0.length; i++) { const a = P0[i - 1], b = P0[i]; if ((a[1] - y50) * (b[1] - y50) < 0) { const u = (y50 - a[1]) / (b[1] - a[1]); P.push([a[0] + (b[0] - a[0]) * u, y50]); } P.push(b); }
    for (let i = 1; i < P.length; i++) { cx.fillStyle = (P[i][1] + P[i - 1][1]) / 2 <= y50 ? gH : gA; cx.beginPath(); cx.moveTo(P[i - 1][0], P[i - 1][1]); cx.lineTo(P[i][0], P[i][1]); cx.lineTo(P[i][0], y50); cx.lineTo(P[i - 1][0], y50); cx.closePath(); cx.fill(); }
    cx.lineCap = 'round'; cx.lineJoin = 'round';
    cx.save(); cx.globalCompositeOperation = 'lighter'; cx.lineWidth = 6;
    for (let i = 1; i < P.length; i++) { cx.strokeStyle = rgba((P[i][1] + P[i - 1][1]) / 2 <= y50 ? m.h.color : m.a.color, 0.09 + 0.1 * vignette); cx.beginPath(); cx.moveTo(P[i - 1][0], P[i - 1][1]); cx.lineTo(P[i][0], P[i][1]); cx.stroke(); }
    cx.restore();
    cx.lineWidth = 3; for (let i = 1; i < P.length; i++) { cx.strokeStyle = (P[i][1] + P[i - 1][1]) / 2 <= y50 ? m.h.color : m.a.color; cx.beginPath(); cx.moveTo(P[i - 1][0], P[i - 1][1]); cx.lineTo(P[i][0], P[i][1]); cx.stroke(); }
    // head
    const hc = hv >= 50 ? m.h.color : m.a.color;
    for (const k of [0, 1.1]) { const u = ((t + k) % 2.2) / 2.2; cx.strokeStyle = rgba(hc, 0.6 * (1 - u)); cx.lineWidth = 2; cx.beginPath(); cx.arc(hx, hy, 6 + u * 24, 0, 6.3); cx.stroke(); }
    cx.shadowColor = hc; cx.shadowBlur = 18; cx.fillStyle = '#fff'; cx.beginPath(); cx.arc(hx, hy, 5.5, 0, 6.3); cx.fill(); cx.shadowBlur = 0; cx.fillStyle = hc; cx.beginPath(); cx.arc(hx, hy, 3.6, 0, 6.3); cx.fill();
    // win % label that follows the head
    cx.font = '800 22px system-ui'; cx.textAlign = 'left'; cx.fillStyle = hc; cx.fillText(Math.round(hv >= 50 ? hv : 100 - hv) + '%', Math.min(hx + 14, W2 - 80), hy - 12);
    drawBursts(cx, cBursts, now, hx, hy, { left: CP.l, right: W2 - CP.r, top: CP.t }, 1);
    cx.restore();
    // vignette during big moments
    if (vignette > 0.01) { const vg = cx.createRadialGradient(hx, hy, Math.min(W2, H2) * 0.18, hx, hy, Math.max(W2, H2) * 0.75); vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, `rgba(0,0,0,${Math.min(0.85, vignette)})`); cx.fillStyle = vg; cx.fillRect(0, 0, W2, H2); }
    // letterbox slides in for huge moments
    const lb = Math.max(0, (vignette - 0.45) / 0.4) * 38; if (lb > 0) { cx.fillStyle = '#000'; cx.fillRect(0, 0, W2, lb); cx.fillRect(0, H2 - lb, W2, lb); }
    // HUD readouts
    { const sc = m.score[hi]; $('wc_cScH').textContent = sc.h.toFixed(1); $('wc_cScA').textContent = sc.a.toFixed(1); }
    $('wc_cBar').style.width = (tt / (NP - 1) * 100).toFixed(1) + '%'; $('wc_cBar').style.background = `linear-gradient(90deg, ${m.h.color}, ${m.a.color})`;
    $('wc_cClock').textContent = clockLabel(m.ts[hi]);
    { const ws = m.watch[hi], up = $('wc_cUp'); up.classList.toggle('on', !!ws.watch); if (ws.watch) { up.style.setProperty('--upc', ws.up === 'h' ? m.h.color : m.a.color); cx.strokeStyle = ws.up === 'h' ? m.h.color : m.a.color; cx.globalAlpha = 0.35 + 0.25 * Math.sin(performance.now() / 180); cx.lineWidth = 6; cx.strokeRect(3, 3, W2 - 6, H2 - 6); cx.globalAlpha = 1; } }
    if (endState) finalCard(m);
  }
  function finalCard(m) {
    if ($('wc_cFinal').classList.contains('show')) return;
    const fin = m.score[NP - 1], hw = m.homeWon, wn = hw ? m.h : m.a, ls = hw ? m.a : m.h;
    const flips = m.events.filter((e) => e.kind === 'lead').length;
    const big = m.events.find((e) => e.big);
    $('wc_cFinalBox').innerHTML = `<p style="letter-spacing:.2em;text-transform:uppercase;font-size:12px">Final &middot; ${mi + 1} of ${MATCHUPS.length}</p><h2 style="color:${wn.color}">${wn.name} wins</h2><div class="big"><span style="color:${m.h.color}">${fin.h.toFixed(1)}</span> <span style="color:var(--muted)">&ndash;</span> <span style="color:${m.a.color}">${fin.a.toFixed(1)}</span></div><p>${flips} lead change${flips === 1 ? '' : 's'}${m.events.some((e) => e.kind === 'upset') ? ' &middot; Upset Watch triggered' : ''}</p><p>Biggest moment: ${big ? big.label : '-'}</p>`;
    $('wc_cFinal').classList.add('show'); capEl.classList.remove('show');
  }
  function showWeekSummary() {
    running = false;
    const items = MATCHUPS.map((m) => { const big = m.events.find((e) => e.big); const fin = m.score[NP - 1]; return `<li><b>${m.homeWon ? m.h.name : m.a.name}</b> over ${m.homeWon ? m.a.name : m.h.name}, ${fin.h.toFixed(1)}&ndash;${fin.a.toFixed(1)}<br><span style="color:var(--muted)">Moment of the game: ${big ? big.label : '-'}</span></li>`; }).join('');
    $('wc_cFinalBox').innerHTML = `<p style="letter-spacing:.2em;text-transform:uppercase;font-size:12px">That's the week</p><h2>${WEEK} in review</h2><ul>${items}</ul><div class="btns" style="justify-content:center;margin-top:10px"><button id="againBtn">&#8635; Watch again</button><button id="doneBtn">Done</button></div>`;
    $('wc_cFinal').classList.add('show');
    $('wc_againBtn').onclick = () => { $('wc_cFinal').classList.remove('show'); running = true; stats.length = 0; startMatchup(0); lastT = performance.now(); requestAnimationFrame(cineFrame); };
    $('wc_doneBtn').onclick = closeCine;
  }

  // ---- real data -> cinematic timeline ----
  const NP = 150;
  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  function clockLabel(ts) {
    const d = new Date(ts), h = d.getHours(), day = DAYS[d.getDay()];
    if (d.getDay() === 0) return h < 16 ? 'Sunday early games' : h < 20 ? 'Sunday late games' : 'Sunday night';
    return day + (h >= 17 ? ' night' : h >= 12 ? ' afternoon' : ' morning');
  }
  // d: { home:{name,color}, away:{name,color}, p:[homeWinProb], hs:[homeScore], as:[awayScore], ts:[], watch:[{watch,up:'h'|'a'}] }
  function buildMatchup(d) {
    const n = d.p.length, m = { h: d.home, a: d.away, p: [], score: [], ts: [], watch: [], events: [] };
    let lh = 0, la = 0;
    for (let k = 0; k < NP; k++) {
      const i = Math.round(k * (n - 1) / (NP - 1));
      m.p.push(Math.max(0, Math.min(100, d.p[i])));
      if (Number.isFinite(d.hs[i])) lh = d.hs[i]; if (Number.isFinite(d.as[i])) la = d.as[i];
      m.score.push({ h: lh, a: la }); m.ts.push(d.ts[i]); m.watch.push(d.watch[i] || { watch: false, up: null });
    }
    const p = m.p, cs = confSeq(p);
    for (let i = 1; i < NP; i++) {
      const dh = m.score[i].h - m.score[i - 1].h, da = m.score[i].a - m.score[i - 1].a, dd = p[i] - p[i - 1];
      const side = dh >= da ? 'h' : 'a', pts = Math.max(dh, da);
      if (pts >= SCORE_MIN) { const tm = side === 'h' ? m.h : m.a; m.events.push({ i, kind: 'score', color: tm.color || tm.c, label: fit(tm.name) + ' +' + pts.toFixed(1) + ' pts', w: Math.min(1, Math.abs(dd) / 14) * 0.7 + 0.1, _side: side, _pts: pts }); }
      // lead change: only when the CONFIRMED leader changes (new leader reaches 60%+); one event, merged with a score that caused it
      if (cs[i] && cs[i - 1] && cs[i] !== cs[i - 1]) {
        const tm = cs[i] === 'h' ? m.h : m.a, late = i / NP;
        let extra = '', ww = 0; const prev = m.events[m.events.length - 1];
        if (prev && prev.kind === 'score' && prev.i === i) { m.events.pop(); ww = prev.w; if (prev._side === cs[i]) extra = ' (+' + prev._pts.toFixed(1) + ')'; }
        m.events.push({ i, kind: 'lead', color: tm.color, label: fit(tm.name) + ' takes the lead' + extra, w: Math.min(1, Math.max(ww, 0.5 + late * 0.4 + Math.abs(dd) / 40)) });
      }
      if (m.watch[i].watch && !m.watch[i - 1].watch) { const u = m.watch[i].up === 'h' ? m.h : m.a; m.events.push({ i, kind: 'upset', color: u.color, label: 'Upset watch: ' + fit(u.name) + ' is closing in', w: 0.9 }); }
    }
    m.events.sort((a, b) => a.i - b.i);
    m.homeWon = m.score[NP - 1].h !== m.score[NP - 1].a ? m.score[NP - 1].h > m.score[NP - 1].a : p[NP - 1] >= 50;
    if (m.events.length) { const big = m.events.reduce((a, b) => (b.w > a.w ? b : a), m.events[0]); big.big = true; }
    m.events.push({ i: NP - 1, kind: 'final', color: (m.homeWon ? m.h : m.a).color, label: 'FINAL', w: 1 });
    return m;
  }
  function build() {
    if (built) return; built = true;
    const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
    cine = document.createElement('div'); cine.id = 'wc_cine'; cine.innerHTML = HTML; document.body.appendChild(cine);
    cc = $('wc_cc'); cx = cc.getContext('2d'); capEl = $('wc_cap');
    $('wc_cClose').onclick = closeCine; document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && running) closeCine(); });
    $('wc_cFast').onclick = () => { speedMul = speedMul === 1 ? 2 : 1; $('wc_cFast').textContent = speedMul + 'x'; };
    $('wc_cSkip').onclick = () => { if (mi < MATCHUPS.length - 1) startMatchup(mi + 1); else showWeekSummary(); };
  }
  window.WeekCinema = {
    open(matchups, weekLabel) {
      const ok = matchups.filter((d) => d.p && d.p.length >= 4);
      if (!ok.length) return;
      build(); MATCHUPS = ok.map(buildMatchup); WEEK = weekLabel || 'This week';
      $('wc_cWeek').textContent = WEEK;
      const t0 = MATCHUPS[0].ts[0], t1 = MATCHUPS[0].ts[NP - 1];
      $('wc_d0').textContent = DAYS[new Date(t0).getDay()]; $('wc_d1').textContent = DAYS[new Date(t1).getDay()];
      cresize(); cine.classList.add('on'); document.body.style.overflow = 'hidden'; stats.length = 0; running = true; $('wc_cFinal').classList.remove('show'); startMatchup(0); lastT = performance.now(); requestAnimationFrame(cineFrame);
    },
  };

})();
