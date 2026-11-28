// wp-chart.js -- draws a win-probability chart the same way the Matchups
// page's ESPN cards do (app.js, renderEspnCard): points evenly spaced by
// update (not by clock time), a smooth line colored by whoever is ahead, an
// exact crossing point at 50%, a fill toward the 50% line that fades from the
// team's color at 100% (top, home) or 0% (bottom, away), faint grid lines, a
// stronger 50% line, and "100 / 50 / 100" labels in the team colors.
// Used by the News Desk and the recap video, so both match the real charts.
//
//   WPChart.draw(ctx, { x, y, w, h }, homeWinPcts, homeColor, awayColor,
//                { dark, progress (0-1, draws left to right), lineWidth, font, dot })
(function () {
  'use strict';
  function rgba(hex, a) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '')); if (!m) return `rgba(128,128,128,${a})`;
    const n = parseInt(m[1], 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
  }
  // Insert exact 50% points where the line crosses, so the color switches right at the crossing.
  function withCrossings(vals) {
    const out = [];
    for (let i = 0; i < vals.length; i++) {
      if (i > 0) {
        const a = vals[i - 1], b = vals[i];
        if ((a - 50) * (b - 50) < 0) out.push({ x: i - 1 + (50 - a) / (b - a), y: 50 });
      }
      out.push({ x: i, y: vals[i] });
    }
    return out;
  }

  function draw(ctx, box, vals, homeColor, awayColor, opts) {
    opts = opts || {};
    const dark = !!opts.dark, lw = opts.lineWidth || 3, font = opts.font || 14;
    const padL = Math.round(font * 2.6), padR = 10, padT = 8, padB = 8;
    const L = box.x + padL, R = box.x + box.w - padR, T = box.y + padT, B = box.y + box.h - padB;
    if (!vals || vals.length < 2) vals = [50, vals && vals.length ? vals[0] : 50];
    const maxX = vals.length - 1;
    const X = (i) => L + (i / (maxX || 1)) * (R - L), Y = (v) => T + (1 - v / 100) * (B - T), y50 = Y(50);
    const grid = dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)';
    // grid
    ctx.save();
    ctx.lineWidth = 1; ctx.strokeStyle = grid;
    for (const v of [0, 25, 75, 100]) { ctx.beginPath(); ctx.moveTo(L, Y(v)); ctx.lineTo(R, Y(v)); ctx.stroke(); }
    const vCount = Math.min(10, Math.max(4, Math.round((R - L) / 120)));
    for (let k = 0; k <= vCount; k++) { const xx = L + (k / vCount) * (R - L); ctx.beginPath(); ctx.moveTo(xx, T); ctx.lineTo(xx, B); ctx.stroke(); }
    ctx.strokeStyle = dark ? '#888' : '#999'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(L, y50); ctx.lineTo(R, y50); ctx.stroke();
    // labels
    ctx.font = `600 ${font}px Inter, system-ui, sans-serif`; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    ctx.fillStyle = homeColor; ctx.fillText('100', L - 8, Y(100) + font * 0.35);
    ctx.fillStyle = dark ? '#aaa' : '#555'; ctx.fillText('50', L - 8, y50);
    ctx.fillStyle = awayColor; ctx.fillText('100', L - 8, Y(0) - font * 0.35);
    // data (up to progress)
    const pts = withCrossings(vals.map(Number));
    const prog = opts.progress == null ? 1 : Math.max(0, Math.min(1, opts.progress));
    const xEnd = maxX * prog;
    const shown = [];
    for (let i = 0; i < pts.length; i++) {
      if (pts[i].x <= xEnd) shown.push(pts[i]);
      else { const p = pts[i - 1]; if (p) { const u = (xEnd - p.x) / (pts[i].x - p.x); shown.push({ x: xEnd, y: p.y + (pts[i].y - p.y) * u }); } break; }
    }
    const gHome = ctx.createLinearGradient(0, T, 0, y50); gHome.addColorStop(0, rgba(homeColor, 0.34)); gHome.addColorStop(1, rgba(homeColor, 0.02));
    const gAway = ctx.createLinearGradient(0, y50, 0, B); gAway.addColorStop(0, rgba(awayColor, 0.02)); gAway.addColorStop(1, rgba(awayColor, 0.34));
    for (let i = 1; i < shown.length; i++) {
      const a = shown[i - 1], b = shown[i], homeSide = (a.y + b.y) / 2 >= 50;
      ctx.fillStyle = homeSide ? gHome : gAway;
      ctx.beginPath(); ctx.moveTo(X(a.x), y50); ctx.lineTo(X(a.x), Y(a.y)); ctx.lineTo(X(b.x), Y(b.y)); ctx.lineTo(X(b.x), y50); ctx.closePath(); ctx.fill();
    }
    ctx.lineWidth = lw; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    for (let i = 1; i < shown.length; i++) {
      const a = shown[i - 1], b = shown[i];
      ctx.strokeStyle = (a.y + b.y) / 2 >= 50 ? homeColor : awayColor;
      ctx.beginPath(); ctx.moveTo(X(a.x), Y(a.y)); ctx.lineTo(X(b.x), Y(b.y)); ctx.stroke();
    }
    const last = shown[shown.length - 1];
    if (last && opts.dot !== false) {
      const c = last.y >= 50 ? homeColor : awayColor;
      ctx.fillStyle = c; ctx.shadowColor = c; ctx.shadowBlur = lw * 4;
      ctx.beginPath(); ctx.arc(X(last.x), Y(last.y), lw * 2.2, 0, 7); ctx.fill(); ctx.shadowBlur = 0;
    }
    ctx.restore();
    return { last, X, Y };
  }

  // Team colors the way the site adjusts them: only near-black colors get
  // lifted (to 50% lightness, keeping their hue and saturation) on dark
  // backgrounds; on light backgrounds only near-white ones get deepened.
  function hexToHsl(hex) {
    const n = parseInt(hex.replace('#', ''), 16); let r = (n >> 16) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b); let h = 0, s = 0; const l = (mx + mn) / 2;
    if (mx !== mn) { const d = mx - mn; s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn); h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; h /= 6; }
    return { h, s, l };
  }
  function hslToHex(h, s, l) {
    const f = (p, q, t) => { if (t < 0) t += 1; if (t > 1) t -= 1; if (t < 1 / 6) return p + (q - p) * 6 * t; if (t < 1 / 2) return q; if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6; return p; };
    let r, g, b;
    if (!s) r = g = b = l; else { const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q; r = f(p, q, h + 1 / 3); g = f(p, q, h); b = f(p, q, h - 1 / 3); }
    return '#' + [r, g, b].map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
  }
  // Same rule as the main site (app.js themedColor): only on dark backgrounds,
  // and only colors too close to black to read (lightness under 20%), which
  // are lifted to 50% keeping their hue and saturation exactly.
  const MIN_LIGHTNESS = 0.20, TARGET_LIGHTNESS = 0.50;
  const valid = (hex) => /^#?[0-9a-f]{6}$/i.test(String(hex || '').trim());
  const norm = (hex) => '#' + String(hex).trim().replace('#', '').toLowerCase();
  function adjust(hex, dark) {
    if (!valid(hex)) return { color: '#1a3fa0', wasAdjusted: false };
    hex = norm(hex);
    const { h, s, l } = hexToHsl(hex);
    if (!dark || l >= MIN_LIGHTNESS) return { color: hex, wasAdjusted: false };
    return { color: hslToHex(h, s, TARGET_LIGHTNESS), wasAdjusted: true };
  }
  function teamColor(hex, dark) { return adjust(hex, dark).color; }
  // Same as the site's deconflictColors: across a whole league, a color WE
  // lifted that now looks like another team's gets its hue rotated (40 degrees
  // at a time) until it's clearly different. Colors the league picked that
  // were already fine never move.
  function redmean(a, b) {
    const p = (x) => { const n = parseInt(x.slice(1), 16); return [n >> 16, (n >> 8) & 255, n & 255]; };
    const [r1, g1, b1] = p(a), [r2, g2, b2] = p(b), rb = (r1 + r2) / 2, dr = r1 - r2, dg = g1 - g2, db = b1 - b2;
    return Math.sqrt((2 + rb / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rb) / 256) * db * db);
  }
  function rotate(hex, deg) { const { h, s, l } = hexToHsl(hex); return hslToHex((((h * 360 + deg) % 360) + 360) % 360 / 360, s, l); }
  // teams: [{ id, color }] in the league's order -> { id: color }
  function leaguePalette(teams, dark) {
    const entries = teams.map((t) => Object.assign({ id: t.id }, adjust(t.color, dark)));
    const fixed = entries.filter((e) => !e.wasAdjusted).map((e) => e.color), out = {};
    for (const e of entries) {
      if (!e.wasAdjusted) { out[e.id] = e.color; continue; }
      let c = e.color, n = 0;
      while (n < 8 && fixed.some((f) => redmean(f, c) < 150)) { c = rotate(c, 40); n++; }
      out[e.id] = c; fixed.push(c);
    }
    return out;
  }

  window.WPChart = { draw, teamColor, leaguePalette, rgba };
})();
