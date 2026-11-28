// Player-level data for the News Desk (docs/desk.html).
//
// Each poll, every team's lineup is reduced to a small per-player summary
// (buildPlayers) and compared with the summary saved on the previous poll
// (diffEvents). What changed becomes a list of player events -- touchdowns,
// turnovers, yardage milestones, big days -- that the desk turns into
// breaking-news headlines. Pure functions, no network or DB: see
// lineups.test.js.

const LINEUP_SLOT_BENCH = 20;
const LINEUP_SLOT_IR = 21;
const STAT_SOURCE_ACTUAL = 0;
const STAT_SOURCE_PROJECTED = 1;

const POSITION = { 1: 'QB', 2: 'RB', 3: 'WR', 4: 'TE', 5: 'K', 16: 'D/ST' };

// ESPN raw stat ids (stats[].stats) for the things worth a headline.
const STAT = {
  passYds: 3, passTd: 4, passInt: 20,
  rushYds: 24, rushTd: 25,
  recYds: 42, recTd: 43, rec: 53,
  fumLost: 72,
  fgMade: 83, fg50: 74,
};

function statLine(player, statSourceId) {
  return (player.stats || []).find((s) => s.statSourceId === statSourceId) || null;
}

function round1(x) { return Math.round((Number(x) || 0) * 10) / 10; }

// One compact object per rostered player. Keys are short on purpose: this is
// stored as JSON for every team, every poll.
function buildPlayers(entries, nflStatusMap) {
  const out = [];
  for (const entry of entries || []) {
    const player = entry && entry.playerPoolEntry && entry.playerPoolEntry.player;
    if (!player) continue;
    const actual = statLine(player, STAT_SOURCE_ACTUAL);
    const proj = statLine(player, STAT_SOURCE_PROJECTED);
    const raw = (actual && actual.stats) || {};
    const st = {};
    for (const [key, id] of Object.entries(STAT)) {
      const v = Number(raw[id]);
      if (v) st[key] = round1(v);
    }
    const status = nflStatusMap ? nflStatusMap[player.proTeamAbbrev] : undefined;
    out.push({
      id: player.id,
      n: player.fullName || [player.firstName, player.lastName].filter(Boolean).join(' ') || 'Unknown',
      pos: POSITION[player.defaultPositionId] || 'FLEX',
      tm: player.proTeamAbbrev || null,
      bench: entry.lineupSlotId === LINEUP_SLOT_BENCH || entry.lineupSlotId === LINEUP_SLOT_IR,
      pts: round1(actual ? actual.appliedTotal : 0),
      proj: round1(proj ? proj.appliedTotal : 0),
      g: status ? status.state : 'bye', // 'pre' | 'in' | 'post' | 'bye'
      st,
    });
    const inj = player.injuryStatus;
    if (inj && inj !== 'ACTIVE' && inj !== 'NORMAL') out[out.length - 1].inj = inj; // QUESTIONABLE, DOUBTFUL, OUT, INJURY_RESERVE...
  }
  return out;
}

const MILESTONES = [
  { key: 'passYds', at: [300, 400], kind: 'pass_milestone' },
  { key: 'rushYds', at: [100, 150, 200], kind: 'rush_milestone' },
  { key: 'recYds', at: [100, 150, 200], kind: 'rec_milestone' },
];
const BIG_DAY = [25, 35, 45];

// Events for one team: what changed between the previous poll's players and
// this one's. Only starters make news (plus one "bench boom" note). With no
// previous snapshot (first poll of the week) there is nothing to compare, so
// no events -- that keeps a fresh start from replaying the whole week.
function diffEvents(prevPlayers, players) {
  if (!prevPlayers || !prevPlayers.length) return [];
  const prevById = new Map(prevPlayers.map((p) => [p.id, p]));
  const events = [];
  const push = (p, kind, delta, detail) => events.push({
    player_id: p.id, player_name: p.n, position: p.pos, pro_team: p.tm,
    kind, points: p.pts, delta: round1(delta), detail: detail || {},
  });

  for (const p of players) {
    const q = prevById.get(p.id);
    if (!q) continue; // just added to the roster
    const d = p.pts - q.pts;
    const s = p.st || {}, t = q.st || {};
    const inc = (k) => (Number(s[k]) || 0) - (Number(t[k]) || 0);

    if (p.bench) {
      // Points left on the bench: worth one note when that player's game ends.
      if (q.g !== 'post' && p.g === 'post' && p.pts >= 20) push(p, 'bench_boom', d, { proj: p.proj });
      continue;
    }

    // Injury news for a starter whose game hasn't started (e.g. ruled OUT).
    const INJ_RANK = { QUESTIONABLE: 1, DOUBTFUL: 2, OUT: 3, INJURY_RESERVE: 3, SUSPENSION: 3 };
    if (p.g === 'pre' && p.inj && p.inj !== q.inj && (INJ_RANK[p.inj] || 0) > (INJ_RANK[q.inj] || 0)) push(p, 'injury', 0, { status: p.inj, proj: p.proj });

    let scored = false;
    for (const [k, kind] of [['passTd', 'pass_td'], ['rushTd', 'rush_td'], ['recTd', 'rec_td']]) {
      const n = inc(k);
      if (n > 0) { push(p, kind, d, { count: n, total: s[k] }); scored = true; }
    }
    if (inc('passInt') > 0) push(p, 'interception', d, { total: s.passInt });
    if (inc('fumLost') > 0) push(p, 'fumble', d, { total: s.fumLost });
    if (inc('fg50') > 0) { push(p, 'fg_50', d, {}); scored = true; }
    if (p.pos === 'D/ST' && d >= 5.5) { push(p, 'dst_score', d, {}); scored = true; }
    if (!scored && d >= 8) push(p, 'big_play', d, {});
    if (d <= -2.5 && p.pts < q.pts) push(p, 'stat_correction', d, {});

    for (const m of MILESTONES) {
      const before = Number(t[m.key]) || 0, now = Number(s[m.key]) || 0;
      const crossed = m.at.filter((x) => before < x && now >= x).pop();
      if (crossed) push(p, m.kind, d, { yards: now, mark: crossed });
    }
    const big = BIG_DAY.filter((x) => q.pts < x && p.pts >= x).pop();
    if (big) push(p, 'big_day', d, { mark: big, proj: p.proj });

    if (q.g === 'in' && p.g === 'post') {
      if (p.proj >= 8 && p.pts <= p.proj * 0.35) push(p, 'dud', d, { proj: p.proj });
      else if (p.proj > 0 && p.pts >= p.proj * 1.8 && p.pts >= 15) push(p, 'boom_final', d, { proj: p.proj });
    }
  }
  return events;
}

module.exports = { buildPlayers, diffEvents, POSITION, STAT };
