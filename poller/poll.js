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
  // ----------------------------------------------------------------------
  // Power Rating v2. Replaces the old opponent-adjusted margin (SRS) +
  // z-score version, which swung ~12 points a week on average. Tested
  // against thousands of simulated seasons where each team's true strength
  // was known: this version moves ~2-3 points a week and ranks teams
  // measurably more accurately. Why the old one was jumpy:
  //   1. Margins include the OPPONENT's score. In fantasy your score doesn't
  //      depend on who you face, so adjusting for opponents only imported
  //      their noise -- roughly doubling the noise per game.
  //   2. The 0-100 score was a z-score against the league's CURRENT spread.
  //      Early in a season ratings are tightly bunched, so dividing by that
  //      tiny spread blew small gaps up into 1-vs-99 scores, and one team's
  //      week re-scaled everyone. It also silently cancelled the shrinkage
  //      toward average (shrinking every team equally is undone by
  //      re-standardizing), so the "prior" never actually calmed anything.
  // What this does instead:
  //   * Performance per game blends the ACTUAL score with the team's
  //     PREGAME PROJECTION (calibrated league-wide to the actual-score
  //     scale). A projection reflects roster strength and injuries without
  //     one week's luck, so it's far less noisy than a single score.
  //   * Each team's rating = recency-weighted average performance minus the
  //     league average, shrunk toward 0 by n/(n+priorK) -- now meaningful,
  //     because the score below is on a fixed scale.
  //   * ~85% of the rating is that predictive strength; ~15% is a
  //     "resume" term from actual win% (also shrunk), so winning counts a
  //     little even where the underlying numbers say it shouldn't.
  //   * Power Score = 100 * normalCdf(rating / scale), a FIXED scale (+12
  //     points of rating = ~84), so a team's score only moves when ITS
  //     numbers move, not because the rest of the league shifted.
  // Same return shape as before: Map teamId -> { score, rating, stdErr, gamesPlayed }.
  // ----------------------------------------------------------------------
  const o = opts || {};
  const decay = o.decay ?? 0.93;        // per-week memory; gentle recency
  const priorK = o.priorK ?? 5;         // effective games of "prior" pulling toward average
  const projWeight = o.projWeight ?? 0.6; // share of a game's signal taken from the pregame projection
  const resumeShare = o.resumeShare ?? 0.15;
  const resumeK = o.resumeK ?? 4;
  const resumePts = o.resumePts ?? 30;  // rating points a 100% vs 0% win rate would span
  const scale = o.scale ?? 12;
  const SD = 21;                        // per-team weekly score stddev, same as winProb.js

  // Latest row per matchup-team (final state) AND earliest row (the
  // pregame projection), unless the summary view already supplies it.
  const byKey = new Map();
  for (const r of rows) {
    if (throughWeek != null && r.week > throughWeek) continue;
    const key = `${r.year}|${r.week}|${r.matchup_id}|${r.team_id}`;
    const e = byKey.get(key);
    if (!e) { byKey.set(key, { latest: r, earliest: r }); continue; }
    if (new Date(r.ts) > new Date(e.latest.ts)) e.latest = r;
    if (new Date(r.ts) < new Date(e.earliest.ts)) e.earliest = r;
  }
  const matchupGroups = new Map();
  for (const e of byKey.values()) {
    const mKey = `${e.latest.year}|${e.latest.week}|${e.latest.matchup_id}`;
    if (!matchupGroups.has(mKey)) matchupGroups.set(mKey, []);
    matchupGroups.get(mKey).push(e);
  }

  const maxSeenWeek = throughWeek != null ? throughWeek : rows.reduce((m, r) => Math.max(m, r.week), 0);
  const sidesList = []; // one entry per finished team-game
  for (const group of matchupGroups.values()) {
    if (group.length !== 2) continue;
    const [a, b] = group;
    if (!a.latest.all_starters_done || !b.latest.all_starters_done) continue;
    const weight = Math.pow(decay, Math.max(0, maxSeenWeek - a.latest.week));
    for (const [me, opp] of [[a, b], [b, a]]) {
      const proj = me.latest.pregame_expected_score != null ? me.latest.pregame_expected_score : me.earliest.expected_score;
      const actual = me.latest.actual_score;
      const diff = actual - opp.latest.actual_score;
      sidesList.push({ team: me.latest.team_id, weight, actual, proj: proj != null ? Number(proj) : null, result: diff > 0 ? 1 : diff < 0 ? 0 : 0.5 });
    }
  }

  const result = new Map();
  if (!sidesList.length) {
    for (const id of teamIds) result.set(id, { score: 50, rating: 0, stdErr: SD, gamesPlayed: 0 });
    return result;
  }

  // Calibrate projections to the actual-score scale (a league-wide offset).
  let biasSum = 0, biasN = 0;
  for (const s of sidesList) if (s.proj != null) { biasSum += s.actual - s.proj; biasN++; }
  const bias = biasN ? biasSum / biasN : 0;

  const acc = new Map(teamIds.map((id) => [id, { n: 0, x: 0, w: 0 }]));
  let totN = 0, totX = 0;
  for (const s of sidesList) {
    const x = s.proj != null ? projWeight * (s.proj + bias) + (1 - projWeight) * s.actual : s.actual;
    totN += s.weight; totX += s.weight * x;
    const e = acc.get(s.team);
    if (!e) continue;
    e.n += s.weight; e.x += s.weight * x; e.w += s.weight * s.result;
  }
  const leagueMean = totX / totN;

  for (const id of teamIds) {
    const e = acc.get(id);
    const n = e.n;
    const predictive = n ? (n / (n + priorK)) * (e.x / n - leagueMean) : 0;
    const resume = n ? (n / (n + resumeK)) * (e.w / n - 0.5) * resumePts : 0;
    const rating = (1 - resumeShare) * predictive + resumeShare * resume;
    result.set(id, { score: 100 * normalCdf(rating / scale), rating, stdErr: SD / Math.sqrt(n + priorK), gamesPlayed: n });
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
      .select('year, week, matchup_id, team_id, actual_score, all_starters_done, ts, pregame_win_prob, pregame_expected_score')
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

// How many ESPN scoring corrections after the fact are permanently
// missed without this: the poller only ever polled `currentNflWeek()`,
// so a stat correction ESPN applies to an already-final week (a
// touchdown re-attributed to a different player, a defensive score
// reversed, etc.) after the poller has already moved on to the next
// week was never re-checked, ever -- the stale pre-correction score just
// sat in the DB permanently, silently wrong in standings, Power
// Rankings, and every Year in Review award computed from it. ESPN's own
// corrections are rare but do land more than a week after a game in
// practice, hence checking back this far rather than just one week.
const STAT_CORRECTION_LOOKBACK_WEEKS = 3;

// Mirror the thresholds in migration 009's guard 3 (max_plausible_expected_drop /
// min_actual_movement_to_explain_jump) -- keep in sync if those change.
const HOLD_MAX_EXPECTED_DROP = 3;
const HOLD_MIN_ACTUAL_MOVEMENT = 1;

// Fetches, computes, and (if changed) writes snapshots for exactly ONE
// week of one league -- shared by both the normal current-week poll and
// the stat-correction look-back below, which is the same work against a
// different `week` and without the Power Picks plotting-window gate (a
// past, already-played week has nothing left to gate; the gate only ever
// existed to hold back an upcoming week's pregame reveal). Returns
// insertedCount so callers can decide whether it's worth refreshing the
// Power Rankings cache afterward.
// Saves the league's whole-season matchup schedule (see 020_schedule.sql) --
// ESPN's response already includes every week's pairings, not just this
// week's. Best-effort on purpose: a failure here (e.g. the migration hasn't
// been run yet) must never stop the snapshot polling that actually matters.
async function saveFullSchedule(league, year, leagueData, teamIdByEspnId) {
  const byKey = new Map();
  for (const m of leagueData.schedule || []) {
    if (!m.home || !m.away || !m.matchupPeriodId) continue; // skip byes
    const home = teamIdByEspnId[m.home.teamId];
    const away = teamIdByEspnId[m.away.teamId];
    if (!home || !away) continue;
    byKey.set(`${m.matchupPeriodId}|${home}`, {
      league_id: league.id, year, week: m.matchupPeriodId, home_team_id: home, away_team_id: away,
    });
  }
  if (!byKey.size) return;
  const { error } = await supabase.from('schedule').upsert([...byKey.values()], { onConflict: 'league_id,year,week,home_team_id' });
  if (error) console.warn(`[${league.slug}] could not save schedule (has 020_schedule.sql been run?): ${error.message}`);
}

async function pollLeagueWeek(league, year, week, teamIdByEspnId, { plottingOpen = true, quiet = false, saveSchedule = false } = {}) {
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

  const { statusMap: nflStatusMap } = nflGameData;

  for (const t of leagueData.teams || []) {
    teamIdByEspnId[t.id] = await upsertTeam(league.id, t);
  }

  if (saveSchedule) await saveFullSchedule(league, year, leagueData, teamIdByEspnId);

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

    // Hold a questionable/Out PREGAME starter's projection drop at its last
    // plotted value, per side -- instead of letting the DB guard (migration
    // 009, guard 3) reject the WHOLE matchup. That guard exists so a
    // temporary "Out" designation on a player whose game hasn't kicked off
    // doesn't crater the chart, but rejecting both teams' rows meant the
    // OTHER team's live scoring (and the real win-probability movement it
    // causes) never got plotted for as long as the one side's projection
    // sat at zero. Here the affected side keeps its previous expected_score
    // (so its win probability is computed from the held value, not the
    // zeroed one) while everything else -- the other team's live points,
    // this team's own actuals -- flows through normally. Same conditions as
    // the DB guard: same lineup, the side still has a pregame starter,
    // expected fell by more than the plausible drop, and actual_score
    // barely moved (a stat correction or real scoring skips the hold). The
    // moment that player's own game starts, hasPendingPregamePlayer goes
    // false and the real number is plotted; a lineup change bypasses it
    // the same way it bypasses the DB guard.
    if (plottingOpen) {
      for (const c of computed) {
        if (!c.hasPendingPregamePlayer) continue;
        const teamUuid = teamIdByEspnId[c.side.teamId];
        if (!teamUuid) continue;
        const { data: prevRows, error: prevErr } = await supabase
          .from('snapshots')
          .select('actual_score, expected_score, all_starters_done, lineup_fingerprint')
          .eq('team_id', teamUuid).eq('league_id', league.id).eq('year', year).eq('week', week)
          .order('ts', { ascending: false }).limit(1);
        if (prevErr) throw prevErr;
        const prev = prevRows && prevRows[0];
        if (!prev || prev.all_starters_done) continue;
        const actualMoved = c.actual - prev.actual_score;
        if (
          prev.lineup_fingerprint === c.lineupFingerprint &&
          prev.expected_score - c.expected > HOLD_MAX_EXPECTED_DROP &&
          actualMoved >= 0 && actualMoved < HOLD_MIN_ACTUAL_MOVEMENT
        ) {
          if (process.env.DEBUG_SNAPSHOTS) {
            console.log(`[${league.slug}] holding expected ${c.expected.toFixed(2)} -> ${Number(prev.expected_score).toFixed(2)} (pregame starter projection drop)`);
          }
          c.expected = Number(prev.expected_score);
        }
      }
    }

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

  // For a normal current-week poll this always logs (quiet=false, the
  // default). For a stat-correction look-back week (see pollLeague below)
  // it's called with quiet=true, so the routine "nothing changed" cases
  // stay silent and only an actual insert/rejection gets logged -- without
  // this, every 5-minute cycle would print up to 3 extra "0 snapshots"
  // look-back lines per league even when ESPN hasn't corrected anything.
  const shouldLog = !quiet || insertedCount > 0 || rejectedCount > 0;
  if (shouldLog) {
    if (!plottingOpen) {
      console.log(`[${league.slug}] week ${week}: plotting window closed -- 0 snapshots written this poll`);
    } else if (schedule.length === 0) {
      console.log(`[${league.slug}] week ${week}: no active matchups found (bye week?)`);
    } else {
      console.log(
        `[${league.slug}] week ${week}: inserted ${insertedCount} changed snapshot row(s)` +
          (skippedCount ? `, skipped ${skippedCount} unchanged` : '') +
          (rejectedCount ? `, rejected ${rejectedCount} matchup(s) as implausible` : '')
      );
    }
  }

  return { insertedCount, skippedCount, rejectedCount };
}

// The actual per-league entry point main() calls. Computes the current
// week + Power Picks plotting gate exactly as before, polls it, then also
// re-polls the last few weeks (see STAT_CORRECTION_LOOKBACK_WEEKS above)
// so a post-hoc ESPN stat correction to an already-final week gets picked
// up automatically instead of sitting stale in the DB forever. Look-back
// weeks are always "plotting open" -- they're already in the past, so
// there's nothing left to gate; the plotting window only ever existed to
// hold back an upcoming week's pregame reveal.
async function pollLeague(league) {
  const year = new Date().getFullYear();
  const week = await currentNflWeek(year);

  console.log(`[${league.slug}] polling year=${year} week=${week}`);

  // Only need weekStart here, to compute the plotting gate up front --
  // pollLeagueWeek() re-fetches NFL game status itself below (a cheap
  // public scoreboard call) since plottingOpen has to already be known
  // before calling it.
  const { weekStart } = await fetchNflGameStatusMap({ year, week });

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
  let totalInserted = 0;

  const current = await pollLeagueWeek(league, year, week, teamIdByEspnId, { plottingOpen, saveSchedule: true });
  totalInserted += current.insertedCount;

  for (let back = 1; back <= STAT_CORRECTION_LOOKBACK_WEEKS; back++) {
    const lookbackWeek = week - back;
    if (lookbackWeek < 1) break;
    const result = await pollLeagueWeek(league, year, lookbackWeek, teamIdByEspnId, { quiet: true });
    totalInserted += result.insertedCount;
    if (result.insertedCount > 0) {
      console.log(
        `[${league.slug}] week ${lookbackWeek} look-back: picked up ${result.insertedCount} ` +
          `changed snapshot row(s) -- likely a post-hoc ESPN stat correction`
      );
    }
  }

  // Only worth refreshing the Power Rankings cache when this poll cycle
  // (current week + all look-back weeks combined) actually changed
  // something -- an idle period between real updates would otherwise burn
  // a Supabase round-trip re-deriving the exact same history over and
  // over. Best-effort and non-fatal: year-in-review.js already falls back
  // to computing it client-side whenever the cache is empty for a
  // league/year, so a failure here (project not migrated yet, a transient
  // error) should never take down the actual snapshot poll above.
  if (totalInserted > 0) {
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
