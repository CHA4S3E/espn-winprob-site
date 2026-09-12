// Main poller entry point. Run on a schedule (GitHub Actions cron) instead
// of chrome.alarms -- works whether or not any browser is open.
//
// For every league stored in Supabase:
//   1. Pull current-week matchup + roster data from ESPN (private, via cookies)
//   2. Pull real NFL game states so we know which players are "done"
//   3. Compute each team's expected score + win probability (see lib/winProb.js)
//   4. Upsert teams, then insert one snapshot row per team per matchup --
//      but ONLY if that team's numbers actually changed since its last
//      recorded snapshot. Without this, a poll that runs every 5 minutes
//      all week (not just during games) would insert an identical row on
//      every single tick, even with zero players active -- the same
//      problem the Chrome extension's content.js/background.js avoided by
//      only appending a chart point when the percentage actually moved.
 
const { createClient } = require('@supabase/supabase-js');
const { fetchLeagueWeek, fetchNflGameStatusMap } = require('./lib/espnClient');
const { teamExpected, computeDynamicStddev, winProbability, DEFAULT_STDDEV } = require('./lib/winProb');
const PRO_TEAM_MAP = require('./lib/proTeamMap');
 
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
 
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY env vars.');
  process.exit(1);
}
 
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
 
// How many decimal places matter for "did this actually change?" -- matches
// the 1-decimal-place precision the UI displays, so we don't insert a new
// row over float noise that wouldn't even be visible on the chart.
const WIN_PROB_PRECISION = 1;
const SCORE_PRECISION = 1;
 
function round(value, precision) {
  const factor = 10 ** precision;
  return Math.round((value || 0) * factor) / factor;
}
 
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
 
// Fetches the single most recent snapshot row per team for this
// league/year/week, in ONE query (rather than one query per team), and
// returns a Map keyed by team_id. Used to decide whether a freshly computed
// value actually differs from what's already stored.
async function fetchLatestSnapshotsByTeam(leagueId, year, week) {
  const { data, error } = await supabase
    .from('snapshots')
    .select('team_id, win_prob, actual_score, expected_score, all_starters_done, id')
    .eq('league_id', leagueId)
    .eq('year', year)
    .eq('week', week)
    .order('id', { ascending: false });
 
  if (error) throw error;
 
  const latestByTeam = new Map();
  for (const row of data || []) {
    // Rows come back newest-first, so the first time we see a given
    // team_id is its most recent snapshot -- skip any older duplicates.
    if (!latestByTeam.has(row.team_id)) {
      latestByTeam.set(row.team_id, row);
    }
  }
  return latestByTeam;
}
 
function hasChanged(prevRow, nextRow) {
  if (!prevRow) return true; // no prior snapshot this week -- always record the first one
  return (
    round(prevRow.win_prob, WIN_PROB_PRECISION) !== round(nextRow.win_prob, WIN_PROB_PRECISION) ||
    round(prevRow.actual_score, SCORE_PRECISION) !== round(nextRow.actual_score, SCORE_PRECISION) ||
    round(prevRow.expected_score, SCORE_PRECISION) !== round(nextRow.expected_score, SCORE_PRECISION) ||
    !!prevRow.all_starters_done !== !!nextRow.all_starters_done
  );
}
 
async function pollLeague(league) {
  const year = new Date().getFullYear();
  const week = await currentNflWeek(year);
 
  console.log(`[${league.slug}] polling year=${year} week=${week}`);
 
  const [leagueData, nflStatusMap, latestByTeam] = await Promise.all([
    fetchLeagueWeek({
      espnLeagueId: league.espn_league_id,
      espnS2: league.espn_s2,
      swid: league.swid,
      year,
      week,
    }),
    fetchNflGameStatusMap({ year, week }),
    fetchLatestSnapshotsByTeam(league.id, year, week),
  ]);
 
  const teamIdByEspnId = {};
  for (const t of leagueData.teams || []) {
    teamIdByEspnId[t.id] = await upsertTeam(league.id, t);
  }
 
  const schedule = (leagueData.schedule || []).filter(
    (m) => m.matchupPeriodId === week && m.away // skip byes
  );
 
  const rows = [];
  let skippedUnchanged = 0;
 
  for (const matchup of schedule) {
    const sides = [
      { side: matchup.home, isHome: true },
      { side: matchup.away, isHome: false },
    ];
 
    const computed = sides.map(({ side, isHome }) => {
      for (const entry of side.rosterForCurrentScoringPeriod?.entries || []) {
        attachProTeamAbbrev(entry.playerPoolEntry.player);
      }
      // actual now comes from summing each starter's live per-player
      // statSourceId===0 points (same source `expected` already uses),
      // not ESPN's team-level totalPoints field -- that field can lag or
      // stay stale mid-game, which was causing actual_score to read 0
      // even when players had already scored real points.
      const { expected, actual, allDone } = teamExpected(
        side.rosterForCurrentScoringPeriod?.entries,
        nflStatusMap
      );
      return { side, isHome, expected, allDone, actual };
    });
 
    const totalProjectedBoth = computed.reduce((sum, c) => sum + c.expected, 0);
    // "Remaining" proxy: expected total minus actual-so-far, summed both sides.
    const remainingProjectedBoth = computed.reduce(
      (sum, c) => sum + Math.max(c.expected - c.actual, 0),
      0
    );
    const stddev = computeDynamicStddev(totalProjectedBoth, remainingProjectedBoth, DEFAULT_STDDEV);
 
    const [homeC, awayC] = computed;
    const homeWinProb = winProbability(homeC.expected, awayC.expected, stddev);
    const allStartersDone = homeC.allDone && awayC.allDone;
 
    for (const c of computed) {
      const teamId = teamIdByEspnId[c.side.teamId];
      if (!teamId) continue;
      const winProb = c.isHome ? homeWinProb : 100 - homeWinProb;
 
      const nextRow = {
        league_id: league.id,
        year,
        week,
        matchup_id: matchup.id,
        team_id: teamId,
        is_home: c.isHome,
        actual_score: c.actual,
        expected_score: c.expected,
        win_prob: winProb,
        all_starters_done: allStartersDone,
      };
 
      if (hasChanged(latestByTeam.get(teamId), nextRow)) {
        rows.push(nextRow);
      } else {
        skippedUnchanged++;
      }
    }
  }
 
  if (rows.length) {
    const { error } = await supabase.from('snapshots').insert(rows);
    if (error) throw error;
    console.log(
      `[${league.slug}] inserted ${rows.length} changed snapshot row(s)` +
        (skippedUnchanged ? `, skipped ${skippedUnchanged} unchanged` : '')
    );
  } else if (schedule.length === 0) {
    console.log(`[${league.slug}] no active matchups found (bye week?)`);
  } else {
    console.log(`[${league.slug}] nothing changed since last poll -- skipped all ${skippedUnchanged} team(s)`);
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
 
