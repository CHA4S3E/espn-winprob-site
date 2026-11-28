// desk-records.js -- the league record book, and live "record watch".
//
// History comes from the past seasons entered on the Settings page
// (legacy_matchups / legacy_teams) plus every finished game the poller has
// recorded (snapshot_summary). From that: highest and lowest score, biggest
// blowout, closest game, most combined points, most points in a loss, longest
// winning streak. While games are live, check() reports when a team is on pace
// for, or has just broken, a league record.
(function () {
  'use strict';
  const books = new Map(); // league id -> { games, records, names }

  async function fetchAll(sb, build) {
    const out = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await build(from, from + 999);
      if (error) throw error;
      out.push(...(data || []));
      if (!data || data.length < 1000) return out;
    }
  }

  async function load(sb, L) {
    const names = {};
    for (const id of Object.keys(L.teams)) names[id] = L.teams[id].name;
    let legacy = [], legacyTeams = [];
    try {
      [legacy, legacyTeams] = await Promise.all([
        fetchAll(sb, (a, b) => sb.from('legacy_matchups').select('year, week, home_legacy_team_id, away_legacy_team_id, home_live_team_id, away_live_team_id, home_score, away_score').eq('league_id', L.id).range(a, b)),
        sb.from('legacy_teams').select('id, name').eq('league_id', L.id).then((r) => r.data || []),
      ]);
    } catch (e) { legacy = []; }
    for (const t of legacyTeams) names['legacy:' + t.id] = t.name;
    const games = [];
    for (const g of legacy) {
      const a = g.home_live_team_id || (g.home_legacy_team_id && 'legacy:' + g.home_legacy_team_id);
      const b = g.away_live_team_id || (g.away_legacy_team_id && 'legacy:' + g.away_legacy_team_id);
      if (!a || !b || g.home_score == null || g.away_score == null) continue;
      games.push({ year: g.year, week: g.week, a, b, sa: Number(g.home_score), sb: Number(g.away_score) });
    }
    // Finished games from this season (and any other tracked season).
    let summary = [];
    try { summary = await fetchAll(sb, (a, b) => sb.from('snapshot_summary').select('year, week, matchup_id, team_id, is_home, actual_score, all_starters_done, ts').eq('league_id', L.id).range(a, b)); } catch (e) { summary = []; }
    const latest = new Map();
    for (const r of summary) { const k = r.year + '|' + r.week + '|' + r.matchup_id + '|' + r.team_id; const ex = latest.get(k); if (!ex || r.ts > ex.ts) latest.set(k, r); }
    const pairs = new Map();
    for (const r of latest.values()) { const k = r.year + '|' + r.week + '|' + r.matchup_id; if (!pairs.has(k)) pairs.set(k, []); pairs.get(k).push(r); }
    const seen = new Set(games.map((g) => g.year + '|' + g.week + '|' + [g.a, g.b].sort().join('|')));
    for (const p of pairs.values()) {
      if (p.length !== 2 || !p[0].all_starters_done || !p[1].all_starters_done) continue;
      const [h, a] = p[0].is_home ? p : [p[1], p[0]];
      const key = h.year + '|' + h.week + '|' + [h.team_id, a.team_id].sort().join('|');
      if (seen.has(key)) continue;
      games.push({ year: h.year, week: h.week, a: h.team_id, b: a.team_id, sa: Number(h.actual_score), sb: Number(a.actual_score) });
    }
    games.sort((x, y) => x.year - y.year || x.week - y.week);
    const book = { games, names, records: compute(games, names) };
    books.set(L.id, book);
    return book;
  }

  function compute(games, names) {
    // Leave out two-week matchups (some leagues' playoff rounds add two weeks
    // together): any game where a score is more than 1.8x that season's median.
    const med = new Map();
    for (const y of new Set(games.map((g) => g.year))) {
      const s = games.filter((g) => g.year === y).flatMap((g) => [g.sa, g.sb]).sort((a, b) => a - b);
      med.set(y, s[Math.floor(s.length / 2)] || 0);
    }
    games = games.filter((g) => !med.get(g.year) || Math.max(g.sa, g.sb) <= med.get(g.year) * 1.8);
    if (!games.length) return [];
    const nm = (id) => names[id] || 'A former team';
    const rows = [];
    for (const g of games) { rows.push({ team: g.a, opp: g.b, s: g.sa, o: g.sb, year: g.year, week: g.week }); rows.push({ team: g.b, opp: g.a, s: g.sb, o: g.sa, year: g.year, week: g.week }); }
    const max = (arr, f) => arr.reduce((b, x) => (f(x) > f(b) ? x : b), arr[0]);
    const min = (arr, f) => arr.reduce((b, x) => (f(x) < f(b) ? x : b), arr[0]);
    const hi = max(rows, (r) => r.s), lo = min(rows.filter((r) => r.s > 0), (r) => r.s);
    const blow = max(games, (g) => Math.abs(g.sa - g.sb));
    const close = min(games.filter((g) => g.sa !== g.sb), (g) => Math.abs(g.sa - g.sb));
    const combo = max(games, (g) => g.sa + g.sb);
    const lossHi = max(rows.filter((r) => r.s < r.o), (r) => r.s);
    // Longest winning streak, per team, in order.
    let streak = { n: 0 };
    const run = new Map();
    for (const r of rows.slice().sort((x, y) => x.year - y.year || x.week - y.week)) {
      const cur = run.get(r.team) || { n: 0 };
      const next = r.s > r.o ? { n: cur.n + 1, from: cur.n ? cur.from : r, to: r } : { n: 0 };
      run.set(r.team, next);
      if (next.n > streak.n) streak = { n: next.n, team: r.team, from: next.from, to: next.to };
    }
    const when = (x) => `Wk ${x.week}, ${x.year}`;
    const winLose = (g) => (g.sa >= g.sb ? [g.a, g.b, g.sa, g.sb] : [g.b, g.a, g.sb, g.sa]);
    const out = [
      { key: 'high', label: 'Highest score', value: hi.s, text: hi.s.toFixed(1), who: nm(hi.team), team: hi.team, when: when(hi), note: `vs ${nm(hi.opp)}` },
      { key: 'low', label: 'Lowest score', value: lo.s, text: lo.s.toFixed(1), who: nm(lo.team), team: lo.team, when: when(lo), note: `vs ${nm(lo.opp)}` },
      (() => { const [w, l, ws, ls] = winLose(blow); return { key: 'margin', label: 'Biggest blowout', value: ws - ls, text: '+' + (ws - ls).toFixed(1), who: nm(w), team: w, when: when(blow), note: `${ws.toFixed(1)}–${ls.toFixed(1)} over ${nm(l)}` }; })(),
      close && (() => { const [w, l, ws, ls] = winLose(close); return { key: 'close', label: 'Closest game', value: ws - ls, text: (ws - ls).toFixed(2), who: nm(w), team: w, when: when(close), note: `${ws.toFixed(1)}–${ls.toFixed(1)} over ${nm(l)}` }; })(),
      { key: 'combined', label: 'Most combined points', value: combo.sa + combo.sb, text: (combo.sa + combo.sb).toFixed(1), who: `${nm(combo.a)} & ${nm(combo.b)}`, team: combo.a, when: when(combo), note: `${combo.sa.toFixed(1)}–${combo.sb.toFixed(1)}` },
      lossHi && { key: 'lossHigh', label: 'Most points in a loss', value: lossHi.s, text: lossHi.s.toFixed(1), who: nm(lossHi.team), team: lossHi.team, when: when(lossHi), note: `lost to ${nm(lossHi.opp)}` },
      streak.n >= 3 && { key: 'streak', label: 'Longest win streak', value: streak.n, text: streak.n + ' straight', who: nm(streak.team), team: streak.team, when: `${when(streak.from)} → ${when(streak.to)}`, note: '' },
    ].filter(Boolean);
    return out;
  }

  // Live checks against the book. Returns events for desk-data's event stream:
  // record_watch (projected to beat it) and record_broken (actually beat it).
  // Each fires once per team per record per week.
  const fired = new Set();
  function check(L) {
    const book = books.get(L.id); if (!book || !book.records.length) return [];
    const rec = Object.fromEntries(book.records.map((r) => [r.key, r]));
    const out = [];
    const once = (k) => { const key = L.id + '|' + L.year + '|' + L.week + '|' + k; if (fired.has(key)) return false; fired.add(key); return true; };
    for (const m of L.matchups) {
      for (const [id, s, x, oid, os, ox] of [[m.home, m.hs, m.hx, m.away, m.as, m.ax], [m.away, m.as, m.ax, m.home, m.hs, m.hx]]) {
        if (rec.high) {
          if (s > rec.high.value && once(id + '|high|broken')) out.push({ kind: 'record_broken', priority: 3, teamId: id, oppId: oid, record: rec.high, value: s, matchup: m });
          else if (!m.done && x > rec.high.value + 2 && s > rec.high.value * 0.55 && once(id + '|high|watch')) out.push({ kind: 'record_watch', priority: 2, teamId: id, oppId: oid, record: rec.high, value: x, matchup: m });
        }
        if (m.done && rec.lossHigh && s < os && s > rec.lossHigh.value && once(id + '|lossHigh')) out.push({ kind: 'record_broken', priority: 2, teamId: id, oppId: oid, record: rec.lossHigh, value: s, matchup: m });
      }
      if (m.done && rec.margin && Math.abs(m.hs - m.as) > rec.margin.value && once(m.id + '|margin')) { const w = m.hs > m.as ? m.home : m.away; out.push({ kind: 'record_broken', priority: 3, teamId: w, oppId: w === m.home ? m.away : m.home, record: rec.margin, value: Math.abs(m.hs - m.as), matchup: m }); }
      if (m.done && rec.combined && m.hs + m.as > rec.combined.value && once(m.id + '|combined')) out.push({ kind: 'record_broken', priority: 2, teamId: m.home, oppId: m.away, record: rec.combined, value: m.hs + m.as, matchup: m });
    }
    return out;
  }

  window.DeskRecords = { load, check, book: (L) => books.get(L.id) || null, _compute: compute };
})();
