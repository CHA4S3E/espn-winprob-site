// desk-playoffs.js -- the playoff bracket and championship for the News Desk.
//
// Each league's playoff format (which weeks are which round, two-week rounds,
// byes) is below. The bracket is built from the final regular-season
// standings (record, then points for) using a standard fixed bracket (1 v 8,
// 4 v 5, 2 v 7, 3 v 6; seeds past the playoff spots are byes), and filled in
// from the real results as the poller records them. Before the playoffs it's
// a projected bracket from the current standings.
//
//   DeskPlayoffs.bracket(L)  -> { phase, rounds, seeds, champion, final, ... }
//   DeskPlayoffs.check(L)    -> new events (advance / champion) since last call
(function () {
  'use strict';

  // Playoff formats. Rounds are listed in order; a round with two weeks is
  // played over both, scores added together (the poller records week 2 of it
  // as the running two-week total). Leagues not listed: one week per round
  // right after the regular season, sized from playoff_spots.
  const FORMATS = [
    { match: /family/i, rounds: [{ name: 'Semifinals', weeks: [15] }, { name: 'Championship', weeks: [16, 17] }] },
    { match: /branford/i, rounds: [{ name: 'Wild Card', weeks: [15] }, { name: 'Semifinals', weeks: [16] }, { name: 'Championship', weeks: [17] }] },
  ];

  const nextPow2 = (n) => Math.pow(2, Math.ceil(Math.log2(Math.max(2, n))));
  // Standard bracket order for N slots: 1 v N, then the halves mirrored (1,8,4,5,2,7,3,6 for 8).
  function seedOrder(n) {
    let order = [1, 2];
    while (order.length < n) { const m = order.length * 2 + 1; order = order.flatMap((s) => [s, m - s]); }
    return order;
  }

  function format(L) {
    const f = FORMATS.find((x) => x.match.test(L.name));
    const P = L.playoffSpots, size = nextPow2(P), R = Math.round(Math.log2(size));
    if (f) return { rounds: f.rounds, P, size };
    return { rounds: Array.from({ length: R }, (_, i) => ({ name: i === R - 1 ? 'Championship' : i === R - 2 ? 'Semifinals' : `Round ${i + 1}`, weeks: [L.regEnd + 1 + i] })), P, size };
  }

  // Latest row per team per week from the summary.
  function finalsByWeek(L) {
    const latest = new Map();
    for (const r of L.summary) { const k = r.week + '|' + r.team_id; const ex = latest.get(k); if (!ex || r.ts > ex.ts) latest.set(k, r); }
    // The current week from the live matchups (fresher than the summary).
    for (const m of L.matchups || []) {
      latest.set(L.week + '|' + m.home, { week: L.week, team_id: m.home, matchup_id: m.id, actual_score: m.hs, all_starters_done: m.done, wp: m.wp, live: true });
      latest.set(L.week + '|' + m.away, { week: L.week, team_id: m.away, matchup_id: m.id, actual_score: m.as, all_starters_done: m.done, wp: 100 - m.wp, live: true });
    }
    return latest;
  }

  // Final regular-season standings (record, then points for).
  function regularSeasonSeeds(L) {
    const latest = new Map();
    for (const r of L.summary) { if (r.week > L.regEnd) continue; const k = r.week + '|' + r.matchup_id + '|' + r.team_id; const ex = latest.get(k); if (!ex || r.ts > ex.ts) latest.set(k, r); }
    const rec = new Map(Object.keys(L.teams).map((id) => [id, { id, w: 0, l: 0, t: 0, pf: 0 }]));
    const g = new Map();
    for (const r of latest.values()) { const k = r.week + '|' + r.matchup_id; if (!g.has(k)) g.set(k, []); g.get(k).push(r); }
    for (const pair of g.values()) {
      if (pair.length !== 2 || !pair[0].all_starters_done || !pair[1].all_starters_done) continue;
      const [a, b] = pair, A = rec.get(a.team_id), B = rec.get(b.team_id); if (!A || !B) continue;
      const sa = Number(a.actual_score), sb = Number(b.actual_score); A.pf += sa; B.pf += sb;
      if (sa > sb) { A.w++; B.l++; } else if (sb > sa) { B.w++; A.l++; } else { A.t++; B.t++; }
    }
    return [...rec.values()].sort((x, y) => (y.w + y.t / 2) - (x.w + x.t / 2) || y.pf - x.pf);
  }

  function bracket(L) {
    if (!L.year) return null;
    const fmt = format(L), { rounds, P, size } = fmt;
    const champWeeks = rounds[rounds.length - 1].weeks;
    const firstWeek = rounds[0].weeks[0];
    const projected = L.week < firstWeek;
    const order = projected ? (L.standings || []).map((r) => ({ id: r.id, w: r.w, l: r.l, t: r.t, pf: r.pf })) : regularSeasonSeeds(L);
    const seeds = order.slice(0, P);
    const seedOf = new Map(seeds.map((s, i) => [s.id, i + 1]));
    const byes = size - P;
    // Round 1 slots from the bracket order; seeds above P are empty (a bye for the opponent).
    const so = seedOrder(size), slots = so.map((s) => (s <= P ? seeds[s - 1].id : null));
    const finals = projected ? new Map() : finalsByWeek(L);
    const scoreIn = (teamId, weeks) => { // a team's score in a round: the last recorded week (two-week rounds carry the total)
      for (const w of weeks.slice().reverse()) { const r = finals.get(w + '|' + teamId); if (r) return { s: Number(r.actual_score), done: !!r.all_starters_done && w === weeks[weeks.length - 1], live: !!r.live, week: w, wp: r.wp, leg: weeks.indexOf(w) + 1, matchupId: r.matchup_id }; }
      return null;
    };
    const out = [];
    let alive = slots; // teams (or null) in bracket order for the current round
    for (let ri = 0; ri < rounds.length; ri++) {
      const rd = rounds[ri], games = [];
      for (let k = 0; k < alive.length; k += 2) {
        let a = alive[k], b = alive[k + 1];
        // Byes only exist in the first round (empty bracket slots). Later on, a
        // missing side just means that game hasn't been decided yet (TBD).
        if (ri === 0 && (a && !b || !a && b)) { games.push({ a: a || b, b: null, bye: true, winner: a || b }); continue; }
        if (!a || !b) { games.push({ a, b, winner: null, tbd: true }); continue; }
        const ra = scoreIn(a, rd.weeks), rb = scoreIn(b, rd.weeks);
        const g = { a, b, sa: ra ? ra.s : null, sb: rb ? rb.s : null, weeks: rd.weeks, live: !!(ra && ra.live && !ra.done), done: !!(ra && rb && ra.done && rb.done), leg: ra ? ra.leg : 0, matchupId: ra && ra.matchupId, wp: ra ? ra.wp : null, started: !!(ra && rb && (ra.s > 0 || rb.s > 0)) };
        if (g.done) g.winner = g.sa > g.sb ? a : g.sb > g.sa ? b : (seedOf.get(a) < seedOf.get(b) ? a : b);
        else if (projected) g.winner = null;
        games.push(g);
      }
      out.push({ ...rd, index: ri, games });
      alive = games.map((g) => g.winner || null);
    }
    const finalGame = out[out.length - 1].games[0] || null;
    const champion = finalGame && finalGame.done ? finalGame.winner : null;
    const curRound = out.find((r) => r.weeks.includes(L.week)) || null;
    const phase = projected ? 'projected' : champion ? 'champion' : champWeeks.includes(L.week) ? 'championship' : curRound ? 'playoffs' : L.week > champWeeks[champWeeks.length - 1] ? 'offseason' : 'between';
    return { phase, rounds: out, seeds, seedOf, size, byes, P, champion, final: finalGame, curRound, champWeeks, firstWeek, format: fmt };
  }

  // Events: a playoff game going final (team advances / is eliminated), and the champion.
  const seen = new Map(); // league id -> Set of game keys already announced
  function check(L, quiet) {
    const br = bracket(L); if (!br || br.phase === 'projected') return [];
    const done = seen.get(L.id) || new Set(), first = !seen.has(L.id);
    seen.set(L.id, done);
    const out = [];
    br.rounds.forEach((rd, ri) => rd.games.forEach((g, gi) => {
      if (!g.done || g.bye) return;
      const key = ri + '|' + gi + '|' + g.winner;
      if (done.has(key)) return; done.add(key);
      if (first || quiet) return;
      const loser = g.winner === g.a ? g.b : g.a;
      const last = ri === br.rounds.length - 1;
      out.push({ kind: last ? 'champion' : 'advance', priority: 3, teamId: g.winner, oppId: loser, round: rd.name, next: last ? null : br.rounds[ri + 1].name, sa: g.winner === g.a ? g.sa : g.sb, sb: g.winner === g.a ? g.sb : g.sa });
    }));
    return out;
  }

  window.DeskPlayoffs = { bracket, check, format, seedOrder };
})();
