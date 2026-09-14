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
  const now = new Date();
  const plottingOpen = !weekStart || now >= weekStart;
  if (!plottingOpen) {
    console.log(
      `[${league.slug}] week ${week}'s plotting window hasn't opened yet ` +
        `(starts ${weekStart.toISOString()}) -- computing but not writing snapshots`
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
      const { expected, actual, allDone, totalCount, doneCount } = teamExpected(
        side.rosterForCurrentScoringPeriod?.entries,
        nflStatusMap
      );
      return { side, isHome, expected, allDone, actual, totalCount, doneCount };
    });

    const totalProjectedBoth = computed.reduce((sum, c) => sum + c.expected, 0);
    const remainingProjectedBoth = computed.reduce(
      (sum, c) => sum + Math.max(c.expected - c.actual, 0),
      0
    );
    const totalPlayersBoth = computed.reduce((sum, c) => sum + c.totalCount, 0);
    const remainingPlayersBoth = computed.reduce(
      (sum, c) => sum + (c.totalCount - c.doneCount),
      0
    );
    const stddev = computeDynamicStddev(totalProjectedBoth, remainingProjectedBoth, DEFAULT_STDDEV, {
      totalPlayersBoth,
      remainingPlayersBoth,
    });

    const [homeC, awayC] = computed;
    const allStartersDone = homeC.allDone && awayC.allDone;
    const homeWinProb = matchupWinProbability({
      homeExpected: homeC.expected,
      awayExpected: awayC.expected,
      homeActual: homeC.actual,
      awayActual: awayC.actual,
      allDone: allStartersDone,
      stddev,
    });
    const awayWinProb = 100 - homeWinProb;

    if (!plottingOpen) continue; // computed above for visibility; not written

    const homeTeamId = teamIdByEspnId[homeC.side.teamId];
    const awayTeamId = teamIdByEspnId[awayC.side.teamId];
    if (!homeTeamId || !awayTeamId) continue;

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
      p_away_team_id: awayTeamId,
      p_away_actual_score: awayC.actual,
      p_away_expected_score: awayC.expected,
      p_away_win_prob: awayWinProb,
      p_all_starters_done: allStartersDone,
    });

    if (rpcError) throw rpcError;
    const result = rows?.[0];
    if (!result) continue;

    if (result.rejected) {
      rejectedCount++;
      console.warn(
        `[${league.slug}] matchup ${matchup.id}: rejected this poll's data for BOTH teams -- ` +
          `one side's actual_score dropped implausibly (likely a bad ESPN read)`
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
