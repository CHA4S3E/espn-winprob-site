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

// Returns:
//   statusMap  -- NFL team abbreviation -> { state, remainingFraction }.
//                 state is 'pre' | 'in' | 'post', same as before.
//                 remainingFraction (0-1) estimates how much of THIS team's
//                 game is left, from the real game clock/period -- 1 before
//                 kickoff, shrinking smoothly toward 0 as the game plays
//                 out, 0 once final. Lets winProb.js blend a still-playing
//                 player's actual-so-far with their remaining projection
//                 proportionally to real time left, instead of only
//                 updating once their actual happens to exceed their
//                 pre-game projection (which made "expected" freeze for
//                 long stretches -- see the conversation this was
//                 diagnosed from).
//   weekStart  -- Date of that week's EARLIEST kickoff (whatever day that
//                 actually falls on), or null if no events were found.
async function fetchNflGameStatusMap({ year, week }) {
  const url = `${NFL_SCOREBOARD}?year=${year}&week=${week}&seasontype=2`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) {
    throw new Error(`ESPN NFL scoreboard ${res.status} ${res.statusText}`);
  }
  const data = await res.json();

  // A 200 OK with zero events is a real failure mode, not a legitimate
  // state -- during the season there should always be multiple games in a
  // given week. Without this check, an empty (but "successful") response
  // silently produces an empty statusMap, which downstream code has no way
  // to distinguish from "every player happens to be on a bye" -- locking
  // every player's score in immediately at whatever they'd scored so far,
  // regardless of whether their real game had even started. Throwing here
  // instead lets the existing per-league try/catch in poll.js's main()
  // skip this cycle entirely, rather than writing a snapshot built on a
  // false "everyone's done" assumption.
  if (!data.events || data.events.length === 0) {
    throw new Error('ESPN NFL scoreboard returned zero events -- treating as a failed fetch, not an empty week');
  }

  const statusMap = {};
  let weekStart = null;

  for (const event of data.events) {
    const state = event.status?.type?.state; // 'pre' | 'in' | 'post'
    const remainingFraction = estimateRemainingFraction(state, event.status?.period, event.status?.displayClock);

    for (const competitor of event.competitions?.[0]?.competitors || []) {
      const abbrev = competitor.team?.abbreviation;
      if (abbrev) statusMap[abbrev] = { state, remainingFraction };
    }

    if (event.date) {
      const eventDate = new Date(event.date);
      if (!isNaN(eventDate) && (!weekStart || eventDate < weekStart)) {
        weekStart = eventDate;
      }
    }
  }

  return { statusMap, weekStart };
}

// NFL regulation is 4 x 15-minute quarters (900s each) = 3600s total.
// Overtime (period > 4) is treated as "essentially decided" (0 remaining)
// for our purposes rather than trying to model sudden-death precisely.
// Falls back to a sane default (start of game) if the clock string is
// missing or unparseable, rather than throwing.
function estimateRemainingFraction(state, period, displayClock) {
  if (state === 'post') return 0;
  if (state === 'pre' || period == null) return 1;
  if (period > 4) return 0;

  const parts = String(displayClock || '15:00').split(':').map(Number);
  const [mm, ss] = parts;
  const remainingInPeriod = (isNaN(mm) || isNaN(ss)) ? 900 : mm * 60 + ss;
  const elapsed = (period - 1) * 900 + (900 - remainingInPeriod);
  return Math.max(0, Math.min(1, 1 - elapsed / 3600));
}

module.exports = { fetchLeagueWeek, fetchNflGameStatusMap };
