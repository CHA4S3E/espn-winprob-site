// Thin wrappers around ESPN's public endpoints. No official API/auth docs
// exist for these -- this mirrors the same request shape the Chrome
// extension used successfully (lm-api-reads for fantasy data, site.api for
// real NFL game status).

const FANTASY_BASE = 'https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons';
const NFL_SCOREBOARD = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';

async function fetchLeagueWeek({ espnLeagueId, espnS2, swid, year, week }) {
  const url =
    `${FANTASY_BASE}/${year}/segments/0/leagues/${espnLeagueId}` +
    `?view=mMatchupScore&view=mRoster&view=mScoreboard&view=mTeam&scoringPeriodId=${week}`;

  const res = await fetch(url, {
    headers: {
      Cookie: `espn_s2=${espnS2}; SWID=${swid}`,
      Accept: 'application/json',
    },
  });

  if (!res.ok) {
    throw new Error(`ESPN fantasy API ${res.status} ${res.statusText} for league ${espnLeagueId}`);
  }
  return res.json();
}

// Returns a map of NFL team abbreviation -> game state ('pre' | 'in' | 'post')
async function fetchNflGameStatusMap({ year, week }) {
  const url = `${NFL_SCOREBOARD}?year=${year}&week=${week}&seasontype=2`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) {
    throw new Error(`ESPN NFL scoreboard ${res.status} ${res.statusText}`);
  }
  const data = await res.json();
  const map = {};
  for (const event of data.events || []) {
    const state = event.status?.type?.state; // 'pre' | 'in' | 'post'
    for (const competitor of event.competitions?.[0]?.competitors || []) {
      const abbrev = competitor.team?.abbreviation;
      if (abbrev) map[abbrev] = state;
    }
  }
  return map;
}

module.exports = { fetchLeagueWeek, fetchNflGameStatusMap };
