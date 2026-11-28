// Win-probability calibration check + refit.
//
// Pulls every snapshot (public read key from docs/config.js), samples each
// finished matchup once at ten fixed moments of its week (so a game that sits
// at 75% all Thursday counts once, not dozens of times), compares the model's
// spread with how far final margins actually landed, prints calibration by
// band and checkpoint, and refits the five calibration numbers in
// lib/winProb.js (projection trust early/late, spread scale, floor, tail dof),
// checking each candidate on held-out weeks.
//
//   node tools/calibrate.js
//
// Note: the stored win_prob of matchups played after the calibration went
// live already includes it, so refit only from weeks before it, or compare
// against those raw numbers with care.
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '../../docs/config.js'), 'utf8');
const url = /url:\s*'([^']+)'/.exec(src)[1], key = /anonKey:\s*'([^']+)'/.exec(src)[1];
const H = { apikey: key, Authorization: 'Bearer ' + key };
async function get(path) { const r = await fetch(url + '/rest/v1/' + path, { headers: H }); if (!r.ok) throw new Error(r.status + ' ' + await r.text()); return r.json(); }
async function fetchAll() {
  const leagues = await get('leagues?select=id,slug,name');
  const out = [];
  for (const L of leagues) {
    
    let from = 0;
    for (;;) {
      const rows = await get(`snapshots?select=year,week,matchup_id,team_id,ts,actual_score,expected_score,win_prob,all_starters_done&league_id=eq.${L.id}&order=id.asc&offset=${from}&limit=1000`);
      out.push(...rows.map((r) => ({ lg: L.name, ...r })));
      if (rows.length < 1000) break; from += 1000;
    }
  }
  const ys = {}; for (const r of out) ys[r.lg + ' ' + r.year] = (ys[r.lg + ' ' + r.year] || 0) + 1;
  console.log('rows', out.length, ys);
  return out;
}

function analyze(rows) {
// erf inverse via bisection on CDF
const cdf = (z) => { const s = z < 0 ? -1 : 1, x = Math.abs(z) / Math.SQRT2, t = 1 / (1 + 0.3275911 * x); const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return 0.5 * (1 + s * y); };
const inv = (p) => { let lo = -9, hi = 9; for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (cdf(m) < p) lo = m; else hi = m; } return (lo + hi) / 2; };
// group by league|year|week|matchup, then pair by ts
const G = new Map();
for (const r of rows) { const k = r.lg + '|' + r.year + '|' + r.week + '|' + r.matchup_id; if (!G.has(k)) G.set(k, []); G.get(k).push(r); }
const games = [];
for (const [k, rs] of G) {
  const teams = [...new Set(rs.map((r) => r.team_id))].sort(); if (teams.length !== 2) continue;
  const byTs = new Map(); for (const r of rs) { if (!byTs.has(r.ts)) byTs.set(r.ts, {}); byTs.get(r.ts)[r.team_id === teams[0] ? 'A' : 'B'] = r; }
  const pts = [...byTs.entries()].filter(([, v]) => v.A && v.B).map(([ts, v]) => ({ t: Date.parse(ts), eA: +v.A.expected_score, eB: +v.B.expected_score, aA: +v.A.actual_score, aB: +v.B.actual_score, wp: +v.A.win_prob, done: v.A.all_starters_done && v.B.all_starters_done })).sort((a, b) => a.t - b.t);
  const fin = pts.filter((p) => p.done).pop(); if (!fin) continue;
  games.push({ k, pts, final: fin.aA - fin.aB, week: +k.split('|')[2], lg: k.split('|')[0] });
}
// week anchors: Thursday ET date from the median first ts of the week (+ ~1 day); use NFL convention: find Thursday on/after first ts
const ET = (t) => new Date(new Date(t).toLocaleString('en-US', { timeZone: 'America/New_York' }));
const weekStart = new Map();
for (const g of games) { const w = g.week; const f = g.pts[0].t; if (!weekStart.has(w) || f < weekStart.get(w)) weekStart.set(w, f); }
function thursdayOf(w) { // first Thursday on/after the earliest snapshot minus 1 day
  let d = new Date(weekStart.get(w) - 12 * 3600e3); for (let i = 0; i < 8; i++) { const e = ET(d); if (e.getDay() === 4) break; d = new Date(d.getTime() + 86400e3); }
  const e = ET(d); return { y: e.getFullYear(), m: e.getMonth(), d: e.getDate() };
}
// ET wall-clock -> UTC ms (EDT/EST)
function etToUtc(y, m, d, hh, mm) { for (const off of [4, 5]) { const t = Date.UTC(y, m, d, hh + off, mm); const e = ET(t); if (e.getHours() === hh && e.getDate() === new Date(Date.UTC(y, m, d)).getUTCDate()) return t; } return Date.UTC(y, m, d, hh + 5, mm); }
const CK = [['1 pre-TNF (Thu 7pm)', 0, 19, 0], ['2 after TNF (Fri 3am)', 1, 3, 0], ['3 Sun 2pm', 3, 14, 0], ['4 Sun 4pm', 3, 16, 0], ['5 Sun 6pm', 3, 18, 0], ['6 Sun 8pm', 3, 20, 0], ['7 Sun 10pm', 3, 22, 0], ['8 Mon 7pm', 4, 19, 0], ['9 Mon 10pm', 4, 22, 0], ['10 Mon 11:30pm', 4, 23, 30]];
const samples = [];
for (const g of games) {
  const th = thursdayOf(g.week);
  for (const [name, dd, hh, mm] of CK) {
    const base = new Date(Date.UTC(th.y, th.m, th.d + dd));
    const t = etToUtc(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), hh, mm);
    const p = g.pts.filter((x) => x.t <= t).pop(); if (!p || p.done) continue;
    const dE = p.eA - p.eB; let sig = null;
    if (p.wp > 0.5 && p.wp < 99.5 && Math.abs(dE) > 0.3) { const z = inv(p.wp / 100); if (Math.abs(z) > 0.02) sig = dE / (Math.SQRT2 * z); }
    samples.push({ g: g.k, week: g.week, lg: g.lg, t: p.t, aD: p.aA - p.aB, ck: name, dE, wp: p.wp, sig, final: g.final, win: g.final > 0 ? 1 : g.final < 0 ? 0 : 0.5, res: g.final - dE });
  }
}
console.log('finished matchups', games.length, 'weeks', [...new Set(games.map((g) => g.week))].sort((a, b) => a - b).join(','), 'samples', samples.length);
const rms = (a) => Math.sqrt(a.reduce((s, x) => s + x * x, 0) / a.length);
console.log('\ncheckpoint            n   model sd(margin)  real sd(margin)  mean err   fav-win%  model-fav%');
for (const [name] of CK) {
  const s = samples.filter((x) => x.ck === name); if (!s.length) continue;
  const ss = s.filter((x) => x.sig && x.sig > 0);
  const modelSd = rms(ss.map((x) => x.sig * Math.SQRT2));
  const fav = s.filter((x) => x.wp !== 50).map((x) => ({ p: Math.max(x.wp, 100 - x.wp), w: x.wp > 50 ? x.win : 1 - x.win }));
  console.log(name.padEnd(22), String(s.length).padStart(3), modelSd.toFixed(1).padStart(12), rms(s.map((x) => x.res)).toFixed(1).padStart(16), (s.reduce((a, x) => a + x.res * Math.sign(x.dE || 1), 0) / s.length).toFixed(1).padStart(10), (100 * fav.reduce((a, x) => a + x.w, 0) / fav.length).toFixed(0).padStart(9), (fav.reduce((a, x) => a + x.p, 0) / fav.length).toFixed(0).padStart(10));
}
console.log('\n(mean err = final margin minus expected margin, signed toward the favorite; negative = favorites underperform the projection)');
console.log('\ncalibration by band, all checkpoints (distinct matchups in band in brackets):');
for (const [lo, hi] of [[50, 60], [60, 70], [70, 80], [80, 90], [90, 97], [97, 99.5], [99.5, 100.1]]) {
  const s = samples.map((x) => ({ ...x, p: Math.max(x.wp, 100 - x.wp), w: x.wp >= 50 ? x.win : 1 - x.win })).filter((x) => x.p >= lo && x.p < hi);
  if (!s.length) continue;
  console.log(`${lo}-${hi}%`.padEnd(12), 'n', String(s.length).padStart(4), `[${new Set(s.map((x) => x.g)).size}]`.padStart(6), 'predicted', (s.reduce((a, x) => a + x.p, 0) / s.length).toFixed(1).padStart(6), 'actual', (100 * s.reduce((a, x) => a + x.w, 0) / s.length).toFixed(1).padStart(6));
}
// standardized residual tails
const z = samples.filter((x) => x.sig > 0).map((x) => x.res / (x.sig * Math.SQRT2));
console.log('\nresiduals vs model spread: |z|>2:', (100 * z.filter((v) => Math.abs(v) > 2).length / z.length).toFixed(1) + '% (normal 4.6%)', ' |z|>3:', (100 * z.filter((v) => Math.abs(v) > 3).length / z.length).toFixed(1) + '% (normal 0.3%)', ' rms z', rms(z).toFixed(2), '(1.00 = right)');
return samples;
}

function fitAll(S0) {
// fill unrecoverable sigma (extreme wp): median recoverable sigma at the same checkpoint+league
const med = (a) => { a = a.slice().sort((x, y) => x - y); return a[Math.floor(a.length / 2)]; };
const byCk = new Map(); for (const x of S0) if (x.sig > 0) { const k = x.ck + x.lg; if (!byCk.has(k)) byCk.set(k, []); byCk.get(k).push(x.sig); }
const S = S0.map((x) => ({ ...x, s: x.sig > 0 ? x.sig : med(byCk.get(x.ck + x.lg) || [5]) }));
console.log('samples with estimated sigma:', S.filter((x) => !(x.sig > 0)).length, 'of', S.length);
const cdf = (z) => { const s = z < 0 ? -1 : 1, x = Math.abs(z) / Math.SQRT2, t = 1 / (1 + 0.3275911 * x); const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return 0.5 * (1 + s * y); };
// Student-t CDF via regularized incomplete beta (continued fraction)
function lgamma(x) { const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5]; let y = x, t = x + 5.5; t -= (x + 0.5) * Math.log(t); let s = 1.000000000190015; for (const k of c) s += k / ++y; return -t + Math.log(2.5066282746310005 * s / x); }
function betacf(a, b, x) { let qab = a + b, qap = a + 1, qam = a - 1, c = 1, d = 1 - qab * x / qap; d = 1 / d; let h = d; for (let m = 1; m <= 200; m++) { const m2 = 2 * m; let aa = m * (b - m) * x / ((qam + m2) * (a + m2)); d = 1 + aa * d; c = 1 + aa / c; d = 1 / d; h *= d * c; aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2)); d = 1 + aa * d; c = 1 + aa / c; d = 1 / d; const del = d * c; h *= del; if (Math.abs(del - 1) < 3e-12) break; } return h; }
function ibeta(a, b, x) { if (x <= 0) return 0; if (x >= 1) return 1; const bt = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x)); return x < (a + 1) / (a + b + 2) ? bt * betacf(a, b, x) / a : 1 - bt * betacf(b, a, 1 - x) / b; }
function tcdf(t, nu) { if (!isFinite(nu)) return cdf(t); const x = nu / (nu + t * t), p = 0.5 * ibeta(nu / 2, 0.5, x); return t > 0 ? 1 - p : p; }
// model: d = aD + beta*(dE - aD); sd = sqrt((k*s*sqrt2)^2 + c^2); p = T_nu(d/sd * sqrt((nu-2)/nu))  (t scaled to unit variance)
function prob(x, P) { const r = Math.min(1, (x.s / 21) ** 2), be = P.b1 == null ? P.beta : P.beta * (1 - r) + P.b1 * r; const d = x.aD + be * (x.dE - x.aD); const sd = Math.sqrt((P.k * x.s * Math.SQRT2) ** 2 + P.c ** 2); const sc = isFinite(P.nu) ? Math.sqrt((P.nu - 2) / P.nu) : 1; return Math.min(1 - 1e-6, Math.max(1e-6, tcdf(d / sd / sc, P.nu))); }
const loss = (D, P) => D.reduce((a, x) => { const p = prob(x, P); return a - (x.win * Math.log(p) + (1 - x.win) * Math.log(1 - p)); }, 0) / D.length;
const brier = (D, P) => D.reduce((a, x) => a + (prob(x, P) - x.win) ** 2, 0) / D.length;
const CUR = { beta: 1, k: 1, c: 0, nu: Infinity };
function fit(D, nus) {
  let best = null;
  for (const nu of nus) for (let beta = 0.6; beta <= 1.001; beta += 0.05) for (const b1 of [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0]) for (let k = 1.0; k <= 1.8; k += 0.05) for (const c of [0, 2]) {
    const P = { beta, b1, k, c, nu }, L = loss(D, P); if (!best || L < best.L) best = { ...P, L };
  }
  return best;
}
const NUS = [Infinity, 10, 6];
const all = fit(S, NUS);
console.log('best fit (all data):', JSON.stringify({ betaLate: +all.beta.toFixed(2), betaEarly: all.b1, k: +all.k.toFixed(2), c: all.c, nu: all.nu }), 'logloss', all.L.toFixed(4), 'vs current', loss(S, CUR).toFixed(4));
// leave-one-week-out CV
const weeks = [...new Set(S.map((x) => x.week))];
let cvNew = 0, cvCur = 0, bNew = 0, bCur = 0, n = 0; const picks = [];
for (const w of weeks) { const tr = S.filter((x) => x.week !== w), te = S.filter((x) => x.week === w); const P = fit(tr, NUS); picks.push(`${w}:b${P.beta.toFixed(2)}/${P.b1},k${P.k.toFixed(2)},c${P.c},nu${P.nu}`); cvNew += loss(te, P) * te.length; cvCur += loss(te, CUR) * te.length; bNew += brier(te, P) * te.length; bCur += brier(te, CUR) * te.length; n += te.length; }
console.log('held-out weeks: logloss new', (cvNew / n).toFixed(4), 'current', (cvCur / n).toFixed(4), '| brier new', (bNew / n).toFixed(4), 'current', (bCur / n).toFixed(4));
console.log('per-fold picks:', picks.join('  '));
// calibration table with the new fit
console.log('\nband        n  [games]  current-pred  new-pred  actual');
for (const [lo, hi] of [[50, 60], [60, 70], [70, 80], [80, 90], [90, 97], [97, 99.5], [99.5, 100.1]]) {
  const rows = S.map((x) => { const pn = 100 * prob(x, all); const fav = pn >= 50; return { g: x.g, pc: fav ? x.wp : 100 - x.wp, pn: fav ? pn : 100 - pn, w: fav ? x.win : 1 - x.win }; }).filter((r) => r.pn >= lo && r.pn < hi);
  if (!rows.length) continue;
  const m = (f) => rows.reduce((a, r) => a + f(r), 0) / rows.length;
  console.log(`${lo}-${hi}`.padEnd(10), String(rows.length).padStart(4), `[${new Set(rows.map((r) => r.g)).size}]`.padStart(7), m((r) => r.pc).toFixed(1).padStart(11), m((r) => r.pn).toFixed(1).padStart(9), (100 * m((r) => r.w)).toFixed(1).padStart(7));
}
console.log('\nby checkpoint: model-fav% current / new vs actual fav-win%');
for (const ck of [...new Set(S.map((x) => x.ck))]) { const D = S.filter((x) => x.ck === ck); const r = D.map((x) => { const pn = 100 * prob(x, all), f = pn >= 50; return { pn: f ? pn : 100 - pn, w: f ? x.win : 1 - x.win, pc: x.wp >= 50 ? x.wp : 100 - x.wp, wc: x.wp >= 50 ? x.win : 1 - x.win }; }); const m = (f) => r.reduce((a, q) => a + f(q), 0) / r.length; console.log(ck.padEnd(22), 'current', m((q) => q.pc).toFixed(0), '->', (100 * m((q) => q.wc)).toFixed(0), '| new', m((q) => q.pn).toFixed(0), '->', (100 * m((q) => q.w)).toFixed(0)); }
}

(async () => { const rows = await fetchAll(); const samples = analyze(rows); fitAll(samples); })();
