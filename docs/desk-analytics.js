// desk-analytics.js -- season analysis for the News Desk.
//
// From each finished week's win-probability history (snapshots), per game:
// excitement (total win-% movement), lead changes, the winner's lowest and the
// loser's highest win %, each team's points by time window (Thursday, Sunday
// early/late, Sunday night, Monday...) and the win % gained or lost from
// Monday on. Those per-week results are small and never change once a week
// is final, so they're cached on this device: the history is downloaded once
// (about 16 MB through week 12), then only each newly finished week (~1.5 MB).
// Weeks still in progress are never downloaded here.
//
// Also, from saved lineups / transactions / summary rows (already small):
// lineup IQ (actual vs best possible lineup), projection accuracy (teams and
// players), waiver and trade grades, and weekly report cards.
(function () {
  'use strict';
  const CACHE_KEY = 'winProbDeskAnalytics:v4'; // v2: in-game rows only (v1 counted post-final stat corrections); v3: one decimal on min/max; v4: win % recalibrated
  let cache = {};
  try { cache = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}') || {}; } catch (e) { cache = {}; }
  const saveCache = () => { try { localStorage.setItem(CACHE_KEY, JSON.stringify(cache)); } catch (e) { /* storage full or blocked: recompute next time */ } };

  async function fetchAll(build) {
    const out = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await build(from, from + 999);
      if (error) throw error;
      out.push(...(data || []));
      if (!data || data.length < 1000) return out;
    }
  }

  // ---------------------------------------------------------------- time windows (US Eastern)
  const etParts = (ms) => {
    const f = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', hour12: false });
    const parts = Object.fromEntries(f.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
    return { day: parts.weekday, hour: Number(parts.hour) % 24 };
  };
  const WINDOWS = ['thu', 'sat', 'sunEarly', 'sunLate', 'snf', 'mon'];
  const WINDOW_NAME = { thu: 'Thursday night', sat: 'Friday/Saturday', sunEarly: 'Sunday early', sunLate: 'Sunday late', snf: 'Sunday night', mon: 'Monday night' };
  function windowOf(ms) {
    const { day, hour } = etParts(ms);
    if (day === 'Thu') return 'thu';
    if (day === 'Fri' || day === 'Sat') return 'sat';
    if (day === 'Sun') return hour < 16 ? 'sunEarly' : hour < 20 ? 'sunLate' : 'snf';
    if (day === 'Mon') return 'mon';
    return hour < 12 && day === 'Tue' ? 'mon' : null; // late Monday games finish after midnight
  }

  // ---------------------------------------------------------------- one week
  async function weekMetrics(sb, L, week) {
    const key = L.id + '|' + L.year + '|' + week;
    if (cache[key]) return cache[key];
    const rows = await fetchAll((a, b) => sb.from('snapshots').select('matchup_id, team_id, is_home, ts, actual_score, win_prob, all_starters_done')
      .eq('league_id', L.id).eq('year', L.year).eq('week', week).order('ts').order('id').range(a, b));
    const byM = new Map();
    for (const r of rows) { if (!byM.has(r.matchup_id)) byM.set(r.matchup_id, []); byM.get(r.matchup_id).push(r); }
    const games = [], timing = {};
    let allFinal = byM.size > 0;
    for (const [mid, rs] of byM) {
      const homeId = (rs.find((r) => r.is_home) || {}).team_id, awayId = (rs.find((r) => !r.is_home) || {}).team_id;
      if (!homeId || !awayId) continue;
      const lastH = [...rs].reverse().find((r) => r.is_home), lastA = [...rs].reverse().find((r) => !r.is_home);
      if (!(lastH.all_starters_done && lastA.all_starters_done)) { allFinal = false; continue; }
      // Joint home win % series in time order -- in-game rows only. Rows written
      // after the game went final (including a stat correction days later that
      // can flip the winner) would show a 0%/100% "comeback" that never happened.
      let ex = 0, lc = 0, mnH = 100, mxH = 0, prev = null, side = null, monStart = null;
      for (const r of rs) {
        if (r.all_starters_done) continue;
        const wp = r.is_home ? Number(r.win_prob) : 100 - Number(r.win_prob);
        if (prev != null) ex += Math.abs(wp - prev);
        prev = wp; mnH = Math.min(mnH, wp); mxH = Math.max(mxH, wp);
        const s = wp >= 55 ? 'h' : wp <= 45 ? 'a' : side; if (side && s !== side) lc++; side = s;
        if (monStart == null && windowOf(Date.parse(r.ts)) === 'mon') monStart = wp;
      }
      const hs = Number(lastH.actual_score), as = Number(lastA.actual_score);
      const final = hs > as ? 100 : hs < as ? 0 : 50;
      games.push({ mid, h: homeId, a: awayId, hs: +hs.toFixed(2), as: +as.toFixed(2), ex: Math.round(ex), lc, mnH: Math.round(mnH * 10) / 10, mxH: Math.round(mxH * 10) / 10, mon: monStart == null ? null : Math.round(final - monStart) });
      // Points by time window, per team.
      for (const id of [homeId, awayId]) {
        const t = timing[id] || (timing[id] = Object.fromEntries(WINDOWS.map((w) => [w, 0])));
        let last = 0;
        for (const r of rs) { if (r.team_id !== id) continue; const d = Number(r.actual_score) - last; last = Number(r.actual_score); if (d > 0) { const w = windowOf(Date.parse(r.ts)); if (w) t[w] += d; } }
      }
    }
    for (const id of Object.keys(timing)) for (const w of WINDOWS) timing[id][w] = +timing[id][w].toFixed(1);
    const out = { week, games, timing, final: allFinal };
    if (allFinal) { cache[key] = out; saveCache(); }
    return out;
  }

  // ---------------------------------------------------------------- load everything (background)
  const state = new Map(); // league id -> { weeks: [], lineups: [], txns: [], loading, ready }
  async function load(sb, L) {
    const st = state.get(L.id) || { weeks: [], lineups: [], txns: [], ready: false };
    state.set(L.id, st);
    if (st.loading) return st;
    st.loading = true;
    try {
      const weeks = [];
      // Finished weeks only: they never change (so they're cached), and a live
      // week would otherwise be re-downloaded on every refresh.
      const curDone = (L.matchups || []).length > 0 && L.matchups.every((m) => m.done);
      const lastWeek = curDone ? L.week : L.week - 1;
      for (let w = 1; w <= lastWeek; w++) {
        try { const m = await weekMetrics(sb, L, w); if (m.games.length && m.final) weeks.push(m); } catch (e) { /* skip a week that fails */ }
      }
      st.weeks = weeks;
      const [lu, tx] = await Promise.all([
        sb.from('lineups').select('team_id, week, players').eq('league_id', L.id).eq('year', L.year),
        sb.from('transactions').select('espn_id, ts, week, kind, team_id, items').eq('league_id', L.id).eq('year', L.year).order('ts'),
      ]);
      st.lineups = lu.error ? [] : lu.data || [];
      st.txns = tx.error ? [] : tx.data || [];
      st.ready = true;
    } finally { st.loading = false; }
    return st;
  }

  // ---------------------------------------------------------------- analyses
  const allGames = (st) => st.weeks.flatMap((w) => w.games.map((g) => ({ ...g, week: w.week })));
  const winnerOf = (g) => (g.hs > g.as ? g.h : g.as > g.hs ? g.a : null);
  const teamMin = (g, id) => (id === g.h ? g.mnH : 100 - g.mxH); // a team's lowest win % in the game
  const teamMax = (g, id) => (id === g.h ? g.mxH : 100 - g.mnH);

  // 1. Excitement: total win-% movement per game; a team's drama rating = its average.
  function drama(L) {
    const st = state.get(L.id); if (!st || !st.ready) return null;
    const games = allGames(st); if (!games.length) return null;
    const top = games.slice().sort((a, b) => b.ex - a.ex).slice(0, 5);
    const byTeam = new Map();
    for (const g of games) for (const id of [g.h, g.a]) { const x = byTeam.get(id) || { id, sum: 0, n: 0, lc: 0 }; x.sum += g.ex; x.n++; x.lc += g.lc; byTeam.set(id, x); }
    const teams = [...byTeam.values()].map((x) => ({ ...x, avg: x.sum / x.n })).sort((a, b) => b.avg - a.avg);
    const latest = st.weeks[st.weeks.length - 1];
    const weekTop = latest ? latest.games.slice().sort((a, b) => b.ex - a.ex)[0] : null;
    return { top, teams, weekTop: weekTop ? { ...weekTop, week: latest.week } : null };
  }

  // 2. Comebacks & collapses.
  function comebacks(L) {
    const st = state.get(L.id); if (!st || !st.ready) return null;
    const games = allGames(st).filter((g) => winnerOf(g)); if (!games.length) return null;
    const cb = games.map((g) => { const w = winnerOf(g), l = w === g.h ? g.a : g.h; return { g, w, l, low: teamMin(g, w), high: teamMax(g, l) }; });
    const comebacks = cb.slice().sort((a, b) => a.low - b.low).slice(0, 5);
    const collapses = cb.filter((x) => x.high >= 80).sort((a, b) => b.high - a.high).slice(0, 5);
    const byTeam = new Map();
    const T = (id) => byTeam.get(id) || byTeam.set(id, { id, trailed: 0, trailedWon: 0, heartbreaks: 0, blew: 0 }).get(id);
    for (const x of cb) {
      for (const id of [x.w, x.l]) if (teamMin(x.g, id) <= 25) { T(id).trailed++; if (id === x.w) T(id).trailedWon++; }
      if (x.high >= 90) T(x.l).heartbreaks++;
      if (x.high >= 75) T(x.l).blew++;
    }
    const teams = [...byTeam.values()];
    const clutch = teams.filter((t) => t.trailed >= 2).sort((a, b) => b.trailedWon / b.trailed - a.trailedWon / a.trailed)[0] || null;
    const heartbroken = teams.slice().sort((a, b) => b.heartbreaks - a.heartbreaks)[0] || null;
    return { comebacks, collapses, clutch, heartbroken, teams };
  }

  // 3. Scoring timing: each team's share of points by window vs the league's.
  function timing(L) {
    const st = state.get(L.id); if (!st || !st.ready || !st.weeks.length) return null;
    const tot = new Map(), league = Object.fromEntries(WINDOWS.map((w) => [w, 0]));
    const mon = new Map();
    for (const wk of st.weeks) {
      for (const [id, t] of Object.entries(wk.timing)) { const x = tot.get(id) || Object.fromEntries(WINDOWS.map((w) => [w, 0])); for (const w of WINDOWS) { x[w] += t[w]; league[w] += t[w]; } tot.set(id, x); }
      for (const g of wk.games) if (g.mon != null) { mon.set(g.h, (mon.get(g.h) || 0) + g.mon); mon.set(g.a, (mon.get(g.a) || 0) - g.mon); }
    }
    const lsum = WINDOWS.reduce((s, w) => s + league[w], 0) || 1;
    const teams = [...tot.entries()].map(([id, x]) => {
      const sum = WINDOWS.reduce((s, w) => s + x[w], 0) || 1;
      const share = Object.fromEntries(WINDOWS.map((w) => [w, x[w] / sum]));
      // Identity: the window where this team out-scores the league's usual share the most (big windows only count if meaningful).
      const ident = WINDOWS.filter((w) => league[w] / lsum > 0.04).map((w) => [w, share[w] / (league[w] / lsum)]).sort((a, b) => b[1] - a[1])[0];
      return { id, share, ident: ident ? ident[0] : null, lift: ident ? ident[1] : 1, monGain: mon.get(id) || 0 };
    });
    const leagueShare = Object.fromEntries(WINDOWS.map((w) => [w, league[w] / lsum]));
    return { teams: teams.sort((a, b) => b.lift - a.lift), leagueShare, windowName: WINDOW_NAME, windows: WINDOWS, mondayMagic: teams.slice().sort((a, b) => b.monGain - a.monGain)[0] || null };
  }

  // 4. Lineup IQ: actual starters vs the best lineup with the same positions.
  function bestPossible(players) {
    const starters = players.filter((p) => !p.bench), need = {};
    for (const p of starters) need[p.pos] = (need[p.pos] || 0) + 1;
    let best = 0;
    for (const [pos, n] of Object.entries(need)) best += players.filter((p) => p.pos === pos).map((p) => p.pts).sort((a, b) => b - a).slice(0, n).reduce((s, x) => s + x, 0);
    const actual = starters.reduce((s, p) => s + p.pts, 0);
    return { actual, best: Math.max(best, actual) };
  }
  function lineupIQ(L) {
    const st = state.get(L.id); if (!st || !st.ready || !st.lineups.length) return null;
    const oppScore = new Map(); // week|team -> opponent final
    for (const wk of st.weeks) for (const g of wk.games) { oppScore.set(wk.week + '|' + g.h, g.as); oppScore.set(wk.week + '|' + g.a, g.hs); }
    const per = [];
    for (const r of st.lineups) {
      const ps = r.players || []; if (!ps.length || ps.some((p) => !p.bench && (p.g === 'pre' || p.g === 'in'))) continue; // week not finished
      const { actual, best } = bestPossible(ps);
      const opp = oppScore.get(r.week + '|' + r.team_id);
      per.push({ id: r.team_id, week: r.week, actual, best, lost: best - actual, eff: best ? actual / best : 1, costly: opp != null && actual < opp && best > opp });
    }
    if (!per.length) return null;
    const byTeam = new Map();
    for (const x of per) { const t = byTeam.get(x.id) || { id: x.id, weeks: 0, lost: 0, eff: 0, costly: 0 }; t.weeks++; t.lost += x.lost; t.eff += x.eff; t.costly += x.costly ? 1 : 0; byTeam.set(x.id, t); }
    const teams = [...byTeam.values()].map((t) => ({ ...t, eff: t.eff / t.weeks })).sort((a, b) => b.eff - a.eff);
    return { teams, weeks: [...new Set(per.map((x) => x.week))].sort((a, b) => a - b), worstWeek: per.slice().sort((a, b) => b.lost - a.lost)[0], per };
  }

  // 5. Projection accuracy: teams (pregame projection vs final) and players (lineups).
  function projections(L) {
    const st = state.get(L.id); if (!st || !st.ready) return null;
    const latest = new Map();
    for (const r of L.summary) { if (!r.all_starters_done || r.pregame_expected_score == null) continue; const k = r.week + '|' + r.team_id; const ex = latest.get(k); if (!ex || r.ts > ex.ts) latest.set(k, r); }
    const byTeam = new Map();
    for (const r of latest.values()) { const d = Number(r.actual_score) - Number(r.pregame_expected_score); const t = byTeam.get(r.team_id) || { id: r.team_id, n: 0, diff: 0, beat: 0 }; t.n++; t.diff += d; t.beat += d > 0 ? 1 : 0; byTeam.set(r.team_id, t); }
    const teams = [...byTeam.values()].filter((t) => t.n >= 2).map((t) => ({ ...t, avg: t.diff / t.n })).sort((a, b) => b.avg - a.avg);
    const pl = new Map();
    for (const r of st.lineups) for (const p of r.players || []) {
      if (p.g !== 'post' || !p.proj) continue;
      const x = pl.get(p.id) || { id: p.id, n: p.n, pos: p.pos, tm: p.tm, team: r.team_id, games: 0, diff: 0 };
      x.games++; x.diff += p.pts - p.proj; x.team = r.team_id; pl.set(p.id, x);
    }
    const players = [...pl.values()].map((x) => ({ ...x, avg: x.diff / x.games }));
    if (!teams.length && !players.length) return null;
    return { teams, overs: players.slice().sort((a, b) => b.avg - a.avg).slice(0, 5), unders: players.slice().sort((a, b) => a.avg - b.avg).slice(0, 5) };
  }

  // 7. Waiver & trade grades: points each acquired player has scored for the new team since.
  function moves(L) {
    const st = state.get(L.id); if (!st || !st.ready || !st.txns.length) return null;
    const ptsFor = (pid, teamId, fromWeek) => {
      let total = 0, started = 0, weeks = 0;
      for (const r of st.lineups) { if (r.team_id !== teamId || r.week < fromWeek) continue; const p = (r.players || []).find((x) => x.id === pid); if (!p) continue; weeks++; total += p.pts; if (!p.bench) started += p.pts; }
      return { total, started, weeks };
    };
    const pickups = [], trades = [];
    for (const t of st.txns) {
      if (t.kind === 'trade') {
        const sides = new Map();
        for (const it of t.items) { if (!it.to_team_id) continue; const s = sides.get(it.to_team_id) || { team: it.to_team_id, got: [], pts: 0 }; const p = ptsFor(it.player_id, it.to_team_id, t.week); s.got.push({ ...it, ...p }); s.pts += p.started; sides.set(it.to_team_id, s); }
        if (sides.size >= 2) trades.push({ t, sides: [...sides.values()].sort((a, b) => b.pts - a.pts) });
      } else for (const it of t.items) if (it.type === 'ADD' && t.team_id) pickups.push({ t, it, team: t.team_id, ...ptsFor(it.player_id, t.team_id, t.week) });
    }
    return { pickups: pickups.sort((a, b) => b.started - a.started || b.total - a.total).slice(0, 6), trades: trades.slice(-4).reverse(), haveLineups: st.lineups.length > 0 };
  }

  // 11. Weekly report cards for the latest finished week.
  const LETTERS = [[93, 'A+'], [86, 'A'], [80, 'A-'], [75, 'B+'], [70, 'B'], [65, 'B-'], [60, 'C+'], [55, 'C'], [50, 'C-'], [44, 'D+'], [38, 'D'], [0, 'F']];
  function reportCards(L) {
    const st = state.get(L.id); if (!st || !st.ready) return null;
    const wk = [...st.weeks].reverse().find((w) => w.final); if (!wk) return null;
    const scores = wk.games.flatMap((g) => [{ id: g.h, s: g.hs, o: g.as }, { id: g.a, s: g.as, o: g.hs }]).sort((a, b) => b.s - a.s);
    const n = scores.length, median = (scores[Math.floor((n - 1) / 2)].s + scores[Math.ceil((n - 1) / 2)].s) / 2;
    const proj = new Map();
    for (const r of L.summary) if (r.week === wk.week && r.pregame_expected_score != null) proj.set(r.team_id, Number(r.pregame_expected_score));
    const lu = new Map(st.lineups.filter((r) => r.week === wk.week).map((r) => [r.team_id, bestPossible(r.players || [])]));
    const cards = scores.map((x, i) => {
      const scorePart = n > 1 ? (n - 1 - i) / (n - 1) * 100 : 50; // where the score ranked this week
      const p = proj.get(x.id), projPart = p ? Math.max(0, Math.min(100, 50 + (x.s - p) * 2)) : 50;
      const l = lu.get(x.id), lineupPart = l && l.best ? Math.max(0, Math.min(100, (l.actual / l.best - 0.8) / 0.2 * 100)) : null;
      const won = x.s > x.o;
      let score = lineupPart == null ? scorePart * 0.6 + projPart * 0.25 + (won ? 15 : 0) : scorePart * 0.5 + projPart * 0.15 + lineupPart * 0.2 + (won ? 15 : 0);
      score = Math.round(Math.max(0, Math.min(100, score)));
      const letter = LETTERS.find(([min]) => score >= min)[1];
      const notes = [];
      if (i === 0) notes.push('top score of the week');
      if (i === n - 1) notes.push('lowest score of the week');
      if (won && x.s < median) notes.push('won with a below-median score');
      if (!won && x.s > median) notes.push('lost despite an above-median score');
      if (p && x.s - p >= 20) notes.push(`beat projection by ${(x.s - p).toFixed(1)}`);
      if (p && p - x.s >= 20) notes.push(`missed projection by ${(p - x.s).toFixed(1)}`);
      if (l && l.best - l.actual >= 15) notes.push(`left ${(l.best - l.actual).toFixed(1)} on the bench`);
      return { id: x.id, score, letter, pts: x.s, won, notes };
    });
    return { week: wk.week, cards };
  }

  window.DeskAnalytics = { load, ready: (L) => !!(state.get(L.id) || {}).ready, drama, comebacks, timing, lineupIQ, projections, moves, reportCards, WINDOW_NAME, _cache: () => cache };
})();
