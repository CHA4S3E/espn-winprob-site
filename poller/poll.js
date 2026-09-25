// Main poller entry point. Run on a schedule (GitHub Actions cron / an
// external workflow_dispatch caller) instead of chrome.alarms -- works
// whether or not any browser is open.
//
// For every league stored in Supabase:
//   1. Pull current-week matchup + roster data from ESPN (private, via cookies)
//   2. Pull real NFL game states so we know which players are "done", and
//      that week's earliest kickoff date (used to gate plotting -- see below)
//   3. Compute each team's expected score + win probability (see lib/winProb.js)
//   4. Atomically insert one snapshot row per team, per matchup -- but only
//      if (a) the fantasy week's plotting window has actually opened, and
//      (b) the values actually changed since that team's last snapshot.

const { createClient } = require('@supabase/supabase-js');
const { fetchLeagueWeek, fetchNflGameStatusMap } = require('./lib/espnClient');
const { teamExpected, computeDynamicStddev, matchupWinProbability, DEFAULT_STDDEV } = require('./lib/winProb');
const PRO_TEAM_MAP = require('./lib/proTeamMap');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY env vars.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// Figures out the current NFL week number from ESPN's own scoreboard
// response so we don't have to hardcode a schedule.
async function currentNflWeek(year) {
  const res = await fetch(
    `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?year=${year}`
  );
  const data = await res.json();
  return data.week?.number || 1;
}

function attachProTeamAbbrev(player) {
  player.proTeamAbbrev = PRO_TEAM_MAP[player.proTeamId] || null;
  return player;
}

// ============================================================
// Power Rankings cache refresh -- see PART 2 of
// 017_performance_latest_snapshots_and_power_cache.sql. Computes the same
// six-layer Power Score (weighted SRS + recency decay + Bayesian
// shrinkage + luck adjustment + uncertainty, normalized via normalCdf)
// that standings.js and year-in-review.js already implement, ported here
// rather than shared -- same cross-file-duplication convention every
// other copy of this math already follows (see standings.js for the
// fully-commented original). Running it here, once per poll cycle, means
// year-in-review.js's visitors read a cached row instead of every single
// page load re-solving the regression itself from scratch.
// ============================================================

const PAGE_SIZE = 1000;
async function fetchAllRows(buildQuery) {
  let all = [];
  let from = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { data, error } = await buildQuery(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    all = all.concat(data || []);
    if (!data || data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return all;
}

function erf(x) {
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const t = 1 / (1 + p * x);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return sign * y;
}
function normalCdf(z) {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

function computePowerRatings(rows, teamIds, pregameWinProbByKey, throughWeek, opts) {
  const decay = (opts && opts.decay) ?? 0.85;
  const priorK = (opts && opts.priorK) ?? 3;
  const luckLambda = (opts && opts.luckLambda) ?? 0.15;
  const PR_DEFAULT_STDDEV = 21; // same per-team score stddev winProb.js's model uses

  const latestByKey = new Map();
  for (const r of rows) {
    if (throughWeek != null && r.week > throughWeek) continue;
    const key = `${r.year}|${r.week}|${r.matchup_id}|${r.team_id}`;
    const existing = latestByKey.get(key);
    if (!existing || new Date(r.ts) > new Date(existing.ts)) latestByKey.set(key, r);
  }
  const matchupGroups = new Map();
  for (const r of latestByKey.values()) {
    const mKey = `${r.year}|${r.week}|${r.matchup_id}`;
    if (!matchupGroups.has(mKey)) matchupGroups.set(mKey, []);
    matchupGroups.get(mKey).push(r);
  }

  const maxSeenWeek = throughWeek != null ? throughWeek : rows.reduce((m, r) => Math.max(m, r.week), 0);
  const games = [];
  const finishedPairs = [];
  for (const sides of matchupGroups.values()) {
    if (sides.length !== 2) continue;
    const [a, b] = sides;
    if (!a.all_starters_done || !b.all_starters_done) continue;
    const age = maxSeenWeek - a.week;
    const weight = Math.pow(decay, Math.max(0, age));
    games.push({ teamA: a.team_id, teamB: b.team_id, margin: a.actual_score - b.actual_score, weight });
    finishedPairs.push([a, b]);
  }

  const result = new Map();
  if (!games.length) {
    for (const id of teamIds) result.set(id, { score: 50, rating: 0, stdErr: PR_DEFAULT_STDDEV * Math.SQRT2, gamesPlayed: 0 });
    return result;
  }

  const ratings = new Map(teamIds.map((id) => [id, 0]));
  const gamesByTeam = new Map(teamIds.map((id) => [id, []]));
  for (const g of games) {
    if (gamesByTeam.has(g.teamA)) gamesByTeam.get(g.teamA).push({ opp: g.teamB, margin: g.margin, weight: g.weight });
    if (gamesByTeam.has(g.teamB)) gamesByTeam.get(g.teamB).push({ opp: g.teamA, margin: -g.margin, weight: g.weight });
  }
  for (let iter = 0; iter < 100; iter++) {
    let maxDelta = 0;
    for (const id of teamIds) {
      const gs = gamesByTeam.get(id);
      if (!gs || !gs.length) continue;
      let num = 0, den = 0;
      for (const g of gs) { num += g.weight * (g.margin + ratings.get(g.opp)); den += g.weight; }
      const next = den ? num / den : 0;
      maxDelta = Math.max(maxDelta, Math.abs(next - ratings.get(id)));
      ratings.set(id, next);
    }
    if (maxDelta < 0.0005) break;
  }
  const ratingVals = [...ratings.values()];
  const meanRating = ratingVals.reduce((s, v) => s + v, 0) / (ratingVals.length || 1);
  for (const id of teamIds) ratings.set(id, ratings.get(id) - meanRating);

  const effN = new Map(teamIds.map((id) => [id, 0]));
  for (const g of games) {
    if (effN.has(g.teamA)) effN.set(g.teamA, effN.get(g.teamA) + g.weight);
    if (effN.has(g.teamB)) effN.set(g.teamB, effN.get(g.teamB) + g.weight);
  }
  const shrunk = new Map();
  for (const id of teamIds) {
    const n = effN.get(id) || 0;
    shrunk.set(id, (n / (n + priorK)) * ratings.get(id));
  }

  const luck = new Map(teamIds.map((id) => [id, 0]));
  if (pregameWinProbByKey) {
    const winsExpected = new Map(teamIds.map((id) => [id, 0]));
    const winsActual = new Map(teamIds.map((id) => [id, 0]));
    for (const [a, b] of finishedPairs) {
      for (const side of [a, b]) {
        const pregame = pregameWinProbByKey.get(`${side.year}|${side.week}|${side.matchup_id}|${side.team_id}`);
        if (pregame != null && winsExpected.has(side.team_id)) {
          winsExpected.set(side.team_id, winsExpected.get(side.team_id) + pregame / 100);
        }
      }
      if (a.actual_score > b.actual_score) { if (winsActual.has(a.team_id)) winsActual.set(a.team_id, winsActual.get(a.team_id) + 1); }
      else if (b.actual_score > a.actual_score) { if (winsActual.has(b.team_id)) winsActual.set(b.team_id, winsActual.get(b.team_id) + 1); }
      else {
        if (winsActual.has(a.team_id)) winsActual.set(a.team_id, winsActual.get(a.team_id) + 0.5);
        if (winsActual.has(b.team_id)) winsActual.set(b.team_id, winsActual.get(b.team_id) + 0.5);
      }
    }
    for (const id of teamIds) luck.set(id, luckLambda * ((winsActual.get(id) || 0) - (winsExpected.get(id) || 0)));
  }

  const adjusted = new Map();
  for (const id of teamIds) adjusted.set(id, shrunk.get(id) + luck.get(id));

  const stdErr = new Map();
  for (const id of teamIds) {
    const n = effN.get(id) || 0;
    stdErr.set(id, n > 0 ? (PR_DEFAULT_STDDEV * Math.SQRT2) / Math.sqrt(n) : PR_DEFAULT_STDDEV * Math.SQRT2);
  }

  const adjVals = [...adjusted.values()];
  const meanAdj = adjVals.reduce((s, v) => s + v, 0) / (adjVals.length || 1);
  const variance = adjVals.reduce((s, v) => s + (v - meanAdj) ** 2, 0) / (adjVals.length || 1);
  const stdAdj = Math.sqrt(variance) || 1;

  for (const id of teamIds) {
    const z = (adjusted.get(id) - meanAdj) / stdAdj;
    result.set(id, { score: 100 * normalCdf(z), rating: adjusted.get(id), stdErr: stdErr.get(id), gamesPlayed: effN.get(id) || 0 });
  }
  return result;
}

// Recomputes every week's Power Score for this league/year and upserts it
// into power_rating_history -- best-effort: a failure here (a missing
// table on a not-yet-migrated project, a transient network error) is
// caught and logged by the caller, never allowed to fail the actual
// snapshot poll it runs alongside. Only called when this poll cycle
// actually wrote something new (see pollLeague), so an idle period
// between polls doesn't burn a Supabase round-trip recomputing the same
// unchanged history over and over.
async function refreshPowerRatingCache(league, year, teamIds) {
  const rows = await fetchAllRows((from, to) =>
    supabase
      .from('snapshot_summary')
      .select('year, week, matchup_id, team_id, actual_score, all_starters_done, ts, pregame_win_prob')
      .eq('league_id', league.id).eq('year', year).range(from, to)
  );
  if (!rows.length) return;

  const pregameWinProbByKey = new Map();
  for (const r of rows) {
    if (r.pregame_win_prob == null) continue;
    pregameWinProbByKey.set(`${r.year}|${r.week}|${r.matchup_id}|${r.team_id}`, r.pregame_win_prob);
  }

  const maxWeek = rows.reduce((m, r) => Math.max(m, r.week), 0);
  const records = [];
  for (let w = 1; w <= maxWeek; w++) {
    const ratings = computePowerRatings(rows, teamIds, pregameWinProbByKey, w);
    for (const teamId of teamIds) {
      const r = ratings.get(teamId);
      if (!r || !r.gamesPlayed) continue; // not yet played this far -- no bare-prior row, same rule the client-side chart uses
      records.push({
        league_id: league.id, year, week: w, team_id: teamId,
        score: r.score, rating: r.rating, std_err: r.stdErr, games_played: r.gamesPlayed,
      });
    }
  }
  if (!records.length) return;

  const { error } = await supabase
    .from('power_rating_history')
    .upsert(records, { onConflict: 'league_id,year,week,team_id' });
  if (error) throw error;
}

async function upsertTeam(leagueId, espnTeam) {
  const espnTeamId = espnTeam.id;
  const name = `${espnTeam.location || ''} ${espnTeam.nickname || ''}`.trim() || `Team ${espnTeamId}`;

  const { data, error } = await supabase
    .from('teams')
    .upsert(
      { league_id: leagueId, espn_team_id: espnTeamId, espn_team_name: name },
      { onConflict: 'league_id,espn_team_id' }
    )
    .select()
    .single();

  if (error) throw error;

  // Make sure a team_settings row exists so the settings page always has
  // something to edit, without wiping a color the user already picked.
  await supabase
    .from('team_settings')
    .upsert({ team_id: data.id }, { onConflict: 'team_id', ignoreDuplicates: true });

  return data.id;
}

async function pollLeague(league) {
  const year = new Date().getFullYear();
  const week = await currentNflWeek(year);

  console.log(`[${league.slug}] polling year=${year} week=${week}`);

  const [leagueData, nflGameData] = await Promise.all([
    fetchLeagueWeek({
      espnLeagueId: league.espn_league_id,
      espnS2: league.espn_s2,
      swid: league.swid,
      year,
      week,
    }),
    fetchNflGameStatusMap({ year, week }),
  ]);

  const { statusMap: nflStatusMap, weekStart } = nflGameData;

  // Thursday-Monday plotting window, determined from ESPN's actual game
  // dates rather than assuming "the week number changed" is enough. We
  // still fetch and compute everything below regardless (so roster changes
  // during Tue/Wed are visible in logs and nothing here depends on this
  // flag to function) -- it ONLY gates whether we write snapshot rows.
  // Fails OPEN (keeps the previous always-on behavior) if we can't
  // determine a start date for some reason, rather than silently losing
  // data over an edge case in the schedule response.
  //
  // Opens 24h before the week's first kickoff rather than exactly AT it --
  // this is what powers the site's "Power Picks" pregame view (see app.js):
  // once these rows exist, the real matchup pairings and this week's
  // pregame win_prob/expected_score are visible a day early, with actual
  // scores sitting at 0 and all_starters_done=false until games actually
  // start. currentNflWeek() (above) already flips over to the new week
  // several days ahead of its own kickoff, so this doesn't need to look
  // ahead to a different week -- `week` is already the right one.
  const POWER_PICKS_LEAD_MS = 24 * 60 * 60 * 1000;
  const now = new Date();
  const plottingOpen = !weekStart || now >= new Date(weekStart.getTime() - POWER_PICKS_LEAD_MS);
  if (!plottingOpen) {
    console.log(
      `[${league.slug}] week ${week}'s plotting window hasn't opened yet ` +
        `(opens ${new Date(weekStart.getTime() - POWER_PICKS_LEAD_MS).toISOString()}, ` +
        `24h before kickoff at ${weekStart.toISOString()}) -- computing but not writing snapshots`
    );
  }

  const teamIdByEspnId = {};
  for (const t of leagueData.teams || []) {
    teamIdByEspnId[t.id] = await upsertTeam(league.id, t);
  }

  const schedule = (leagueData.schedule || []).filter(
    (m) => m.matchupPeriodId === week && m.away // skip byes
  );

  let insertedCount = 0;
  let skippedCount = 0;
  let rejectedCount = 0;

  for (const matchup of schedule) {
    const sides = [
      { side: matchup.home, isHome: true },
      { side: matchup.away, isHome: false },
    ];

    const computed = sides.map(({ side, isHome }) => {
      for (const entry of side.rosterForCurrentScoringPeriod?.entries || []) {
        attachProTeamAbbrev(entry.playerPoolEntry.player);
      }
      const {
        expected, actual, allDone, totalCount, doneCount, remainingFractionSum, lineupFingerprint, hasPendingPregamePlayer,
      } = teamExpected(side.rosterForCurrentScoringPeriod?.entries, nflStatusMap);
      return { side, isHome, expected, allDone, actual, totalCount, doneCount, remainingFractionSum, lineupFingerprint, hasPendingPregamePlayer };
    });

    const totalProjectedBoth = computed.reduce((sum, c) => sum + c.expected, 0);
    const remainingProjectedBoth = computed.reduce(
      (sum, c) => sum + Math.max(c.expected - c.actual, 0),
      0
    );
    const totalPlayersBoth = computed.reduce((sum, c) => sum + c.totalCount, 0);
    const remainingPlayerEquivalentsBoth = computed.reduce(
      (sum, c) => sum + c.remainingFractionSum,
      0
    );
    const stddev = computeDynamicStddev(totalProjectedBoth, remainingProjectedBoth, DEFAULT_STDDEV, {
      totalPlayersBoth,
      remainingPlayerEquivalentsBoth,
    });

    const [homeC, awayC] = computed;
    const allStartersDone = homeC.allDone && awayC.allDone;
    const homeWinProb = matchupWinProbability({
      homeExpected: homeC.expected,
      awayExpected: awayC.expected,
      homeActual: homeC.actual,
      awayActual: awayC.actual,
      allDone: allStartersDone,
      homeAllDone: homeC.allDone,
      awayAllDone: awayC.allDone,
      stddev,
    });
    const awayWinProb = 100 - homeWinProb;

    if (!plottingOpen) continue; // computed above for visibility; not written

    const homeTeamId = teamIdByEspnId[homeC.side.teamId];
    const awayTeamId = teamIdByEspnId[awayC.side.teamId];
    if (!homeTeamId || !awayTeamId) continue;

    // Opt-in verbose logging (set DEBUG_SNAPSHOTS=1 in the environment) --
    // prints exactly what's about to be sent to the guard/insert function
    // for this matchup, since a REJECTED write is never persisted
    // anywhere -- without this, there's no way to see what was actually
    // computed and blocked, only that something's missing from the table.
    if (process.env.DEBUG_SNAPSHOTS) {
      console.log(
        `[${league.slug}] matchup ${matchup.id} computed (pre-guard):\n` +
          `  home: expected=${homeC.expected.toFixed(2)} actual=${homeC.actual.toFixed(2)} ` +
          `winProb=${homeWinProb.toFixed(2)} pending=${homeC.hasPendingPregamePlayer} ` +
          `fingerprint=${homeC.lineupFingerprint}\n` +
          `  away: expected=${awayC.expected.toFixed(2)} actual=${awayC.actual.toFixed(2)} ` +
          `winProb=${awayWinProb.toFixed(2)} pending=${awayC.hasPendingPregamePlayer} ` +
          `fingerprint=${awayC.lineupFingerprint}`
      );
    }

    // Both sides validated and written atomically together -- see
    // db/005_matchup_level_validation.sql for why this replaced two
    // separate per-team calls: a bad read for one team's data also
    // contaminates the OTHER team's win_prob (since it's a joint
    // computation), so if either side looks implausible, neither side gets
    // written this cycle, rather than risk writing one correct-looking row
    // whose win_prob was actually computed from the other side's bad data.
    const { data: rows, error: rpcError } = await supabase.rpc('insert_matchup_snapshot_if_changed', {
      p_league_id: league.id,
      p_year: year,
      p_week: week,
      p_matchup_id: matchup.id,
      p_home_team_id: homeTeamId,
      p_home_actual_score: homeC.actual,
      p_home_expected_score: homeC.expected,
      p_home_win_prob: homeWinProb,
      p_home_lineup_fingerprint: homeC.lineupFingerprint,
      p_home_has_pending_pregame: homeC.hasPendingPregamePlayer,
      p_away_team_id: awayTeamId,
      p_away_actual_score: awayC.actual,
      p_away_expected_score: awayC.expected,
      p_away_win_prob: awayWinProb,
      p_away_lineup_fingerprint: awayC.lineupFingerprint,
      p_away_has_pending_pregame: awayC.hasPendingPregamePlayer,
      p_all_starters_done: allStartersDone,
    });

    if (rpcError) throw rpcError;
    const result = rows?.[0];
    if (!result) continue;

    if (result.rejected) {
      rejectedCount++;
      console.warn(
        `[${league.slug}] matchup ${matchup.id}: rejected this poll's data for BOTH teams -- ` +
          `either an implausible actual_score drop, an unexplained expected_score jump with an ` +
          `unchanged lineup, or an unexplained expected_score drop while a starter's own game ` +
          `hasn't kicked off yet (likely a temporary Out designation, not a confirmed final state)`
      );
      continue;
    }
    if (result.home_inserted) insertedCount++; else skippedCount++;
    if (result.away_inserted) insertedCount++; else skippedCount++;
  }

  if (!plottingOpen) {
    console.log(`[${league.slug}] plotting window closed -- 0 snapshots written this poll`);
  } else if (schedule.length === 0) {
    console.log(`[${league.slug}] no active matchups found (bye week?)`);
  } else {
    console.log(
      `[${league.slug}] inserted ${insertedCount} changed snapshot row(s)` +
        (skippedCount ? `, skipped ${skippedCount} unchanged` : '') +
        (rejectedCount ? `, rejected ${rejectedCount} matchup(s) as implausible` : '')
    );
  }

  // Only worth refreshing the Power Rankings cache when this poll cycle
  // actually changed something -- an idle period between real updates
  // would otherwise burn a Supabase round-trip re-deriving the exact same
  // history over and over. Best-effort and non-fatal: year-in-review.js
  // already falls back to computing it client-side whenever the cache is
  // empty for a league/year, so a failure here (project not migrated yet,
  // a transient error) should never take down the actual snapshot poll
  // above, which is why this is caught separately rather than left to
  // pollLeague's own caller in main().
  if (insertedCount > 0) {
    try {
      await refreshPowerRatingCache(league, year, Object.values(teamIdByEspnId));
    } catch (err) {
      console.warn(`[${league.slug}] could not refresh Power Rankings cache (non-fatal):`, err.message);
    }
  }
}

async function main() {
  const { data: leagues, error } = await supabase.from('leagues').select('*');
  if (error) throw error;

  if (!leagues || leagues.length === 0) {
    console.log('No leagues configured yet -- run addLeague.js first.');
    return;
  }

  for (const league of leagues) {
    try {
      await pollLeague(league);
    } catch (err) {
      // One league failing (e.g. a stale cookie) shouldn't stop the others.
      console.error(`[${league.slug}] poll failed:`, err.message);
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Fatal poller error:', err);
    process.exit(1);
  });
