// Core win-probability model -- ported from the Chrome extension's
// background.js. Kept as plain, dependency-free JS so the math can be
// unit-tested in isolation from network/DB code.

const LINEUP_SLOT_BENCH = 20;
const LINEUP_SLOT_IR = 21;
const STAT_SOURCE_PROJECTED = 1;
const STAT_SOURCE_ACTUAL = 0;

// Based on an analysis of full half-PPR starting lineups (~117 avg points,
// ~21.7 stddev per team per week -- see
// https://dynastynerds.com/fantasy-football-wins-above-replacement-the-theory/).
// The previous value of 10 here was too small for a full team's weekly
// score spread, which made the model overconfident in general -- most
// visible early in a week when a single player's routine boom/bust (a
// 15-20 point swing off projection is completely normal for one skill
// player) got compared against a stddev far smaller than real full-team
// variance, producing 90%+ results before most rosters had even played.
const DEFAULT_STDDEV = 21;
const MIN_STDDEV = 1.5; // safety floor so variance never hits ~0 and breaks the CDF

// Standard normal CDF via Abramowitz & Stegun erf approximation.
// NOTE: this is the corrected version -- the original extension had a sign
// bug here (a stray `if (z > 0) p = 1 - p;` followed by an unconditional
// `return 1 - p;`, which canceled out for z>0 and double-inverted for z<0).
function normalCdf(z) {
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const y =
    1 -
    (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-x * x);
  const erf = sign * y;
  return 0.5 * (1 + erf);
}

// Per-player expected contribution. Three real states, not two:
//   - their NFL game is FINISHED ('post')      -> locked in: actual only.
//   - they have NO game at all this week (bye)  -> also locked in, since
//     there's nothing left to resolve.
//   - their NFL game is upcoming/in progress    -> actual so far, PLUS
//     whatever's left of (projected - actual), scaled down proportionally
//     to how much of THEIR specific game clock remains (remainingFraction,
//     from espnClient.js's estimateRemainingFraction). This is what makes
//     "expected" move continuously throughout a game -- the previous
//     version used max(actual, projected), which stayed frozen at the
//     static pre-game projection for as long as a player's actual hadn't
//     yet exceeded it, producing long flat/stuck stretches in the chart
//     even while real points were accumulating.
// This assumes fetchNflGameStatusMap() only includes teams with an actual
// game this week (true for ESPN's public scoreboard endpoint, which simply
// has no event for a bye team) -- if that assumption ever changes, this is
// the first place to revisit.
function playerExpected(player, nflStatusMap) {
  const proTeamAbbrev = player.proTeamAbbrev;
  const status = nflStatusMap ? nflStatusMap[proTeamAbbrev] : undefined;
  const actual = getStatPoints(player, STAT_SOURCE_ACTUAL);
  const projected = getStatPoints(player, STAT_SOURCE_PROJECTED);

  const isFinished = status?.state === 'post';
  const isBye = status === undefined; // no game found for their team this week

  if (isFinished || isBye) return { expected: actual, done: true, remainingFraction: 0 };

  const remainingFraction = status.remainingFraction ?? 1;
  const expected = actual + Math.max(projected - actual, 0) * remainingFraction;
  return { expected, done: false, remainingFraction };
}

function getStatPoints(player, statSourceId) {
  const entry = (player.stats || []).find((s) => s.statSourceId === statSourceId);
  return entry ? entry.appliedTotal || 0 : 0;
}

// True if this specific player's own NFL game hasn't kicked off yet.
// Deliberately distinct from "bye" (status === undefined, no game at all
// this week) -- a bye player can never become "pending" since there's no
// kickoff to wait for. Only an explicit 'pre' state counts. This is the
// signal the dedupe logic (see poll.js / migration 009) uses to tell "an
// injury-driven projection swing that hasn't been confirmed by a real
// kickoff yet" apart from "this team's projection changed for a reason
// that's actually final" -- while ANY starter's own game is still 'pre',
// their current designation (healthy or Out) hasn't been tested by
// anything real actually happening, so a sudden drop in THEIR
// contribution is presumed transient until either their game starts or
// the manager benches them for someone else.
function isPlayerPending(player, nflStatusMap) {
  const status = nflStatusMap ? nflStatusMap[player.proTeamAbbrev] : undefined;
  return status !== undefined && status.state === 'pre';
}

// A stable fingerprint of exactly who's in the starting lineup right now
// (bench/IR excluded) -- just the sorted list of player IDs, joined into a
// string. Sorted so the fingerprint never changes just because ESPN happens
// to return the roster array in a different order; only an actual lineup
// change (a real swap) changes this value. Used by poll.js/the DB layer to
// tell "this team's expected_score jumped because a manager made a real
// swap" apart from "this team's expected_score jumped for no reason" --
// the latter being a strong signal of a bad ESPN read, the former being a
// completely legitimate reason for a big, real jump.
function buildLineupFingerprint(roster) {
  const ids = [];
  for (const entry of roster || []) {
    if (entry.lineupSlotId === LINEUP_SLOT_BENCH || entry.lineupSlotId === LINEUP_SLOT_IR) continue;
    const player = entry.playerPoolEntry?.player;
    if (player && player.id != null) ids.push(player.id);
  }
  ids.sort((a, b) => a - b);
  return ids.join(',');
}

// Sums the starting lineup only (bench/IR excluded), returning the expected
// total, the summed *actual* live points (per-player, not ESPN's team-level
// totalPoints field which can lag/stay stale mid-game), whether every
// starter's real game has finished, and player counts (used by
// computeDynamicStddev to avoid over-reacting to a single early result --
// see its comment for why point-value alone isn't a reliable "how much of
// the game is decided yet" signal).
function teamExpected(roster, nflStatusMap) {
  let expected = 0;
  let actual = 0;
  let allDone = true;
  let totalCount = 0;
  let doneCount = 0;
  let remainingFractionSum = 0; // time-weighted "remaining player-equivalents" -- see computeDynamicStddev
  let hasPendingPregamePlayer = false; // see isPlayerPending -- used by the dedupe/hold-steady logic
  for (const entry of roster || []) {
    if (entry.lineupSlotId === LINEUP_SLOT_BENCH || entry.lineupSlotId === LINEUP_SLOT_IR) continue;
    totalCount++;
    const player = entry.playerPoolEntry.player;
    const { expected: playerPts, done, remainingFraction } = playerExpected(player, nflStatusMap);
    expected += playerPts;
    actual += getStatPoints(player, STAT_SOURCE_ACTUAL);
    remainingFractionSum += remainingFraction;
    if (done) doneCount++;
    else allDone = false;
    if (isPlayerPending(player, nflStatusMap)) hasPendingPregamePlayer = true;
  }
  return {
    expected,
    actual,
    allDone,
    totalCount,
    doneCount,
    remainingFractionSum,
    lineupFingerprint: buildLineupFingerprint(roster),
    hasPendingPregamePlayer,
  };
}

// Variance shrinks as the week plays out, but NOT based on point-value
// resolved alone. Point-value is a misleading signal early in a week: if
// only 1 of e.g. 18 total starters (both teams combined) has played, that
// one player's own personal bust/boom can resolve 10-15% of the total
// *projected points* almost by chance (a single skill player being 15-20
// points off their own projection is completely ordinary), which would
// make the points-based ratio shrink stddev noticeably even though 17 of
// 18 players' outcomes -- the vast majority of the week's real uncertainty
// -- haven't happened yet. That combination (one early outlier + a
// prematurely shrunk stddev) is exactly what produces a 90%+ win
// probability before most of the week has even started.
//
// Fix: compute BOTH a points-based remaining fraction and a TIME-weighted
// remaining fraction, and use whichever is LARGER (i.e. whichever signal
// says more uncertainty is still outstanding).
//
// The time-weighted fraction (remainingPlayerEquivalentsBoth) is a sum of
// each still-active player's own remainingFraction from playerExpected --
// not a raw count of "how many players aren't done yet." A raw count would
// treat a player with 2 minutes left on the clock as carrying the exact
// same remaining uncertainty as one who hasn't kicked off at all, which
// keeps the model needlessly hedged in the closing minutes of a game (e.g.
// showing ~67% for a 3-point lead with one player and 2 minutes left, when
// the real answer is closer to 99% -- there's essentially no game clock
// left for anything to change). Weighting by actual remaining time fixes
// that specific case while leaving early-week behavior just as
// conservative as before (a player 5 minutes into their game still
// contributes ~0.92 of a "remaining player," not close to 0).
function computeDynamicStddev(
  totalProjectedBoth,
  remainingProjectedBoth,
  baseStddev = DEFAULT_STDDEV,
  playerCounts = null // optional: { totalPlayersBoth, remainingPlayerEquivalentsBoth }
) {
  if (totalProjectedBoth <= 0) return MIN_STDDEV;

  const pointsRemainingFraction = Math.max(remainingProjectedBoth / totalProjectedBoth, 0);

  let ratio = pointsRemainingFraction;
  if (playerCounts && playerCounts.totalPlayersBoth > 0) {
    const timeWeightedRemainingFraction = Math.max(
      playerCounts.remainingPlayerEquivalentsBoth / playerCounts.totalPlayersBoth,
      0
    );
    ratio = Math.max(pointsRemainingFraction, timeWeightedRemainingFraction);
  }

  const scaled = baseStddev * Math.sqrt(Math.min(ratio, 1));
  return Math.max(scaled, MIN_STDDEV);
}

// expectedA/expectedB are each team's expected final score; stddev is the
// (possibly dynamic) spread. Returns team A's win probability, 0-100.
// Clamped defensively -- the erf approximation is accurate to ~1e-7 in
// practice, but nothing here depends on trusting that blindly.
function winProbability(expectedA, expectedB, stddev = DEFAULT_STDDEV) {
  const z = (expectedA - expectedB) / (stddev * Math.SQRT2);
  const pct = normalCdf(z) * 100;
  return Math.max(0, Math.min(100, pct));
}

// The entry point poll.js should actually call.
//
// If BOTH teams are locked in, the outcome is a known fact, not a random
// variable -- there is no more uncertainty left to model. Running a
// finished blowout through the normal-distribution formula would still cap
// it around 90-99% (MIN_STDDEV keeps stddev slightly above zero), which is
// wrong: a concluded matchup should show the actual winner at (essentially)
// 100%, not "very likely."
//
// A subtler case: if only ONE team is locked in and that team's actual
// score is already BELOW the other (still-playing) team's current actual,
// the still-playing team can't be caught -- the locked team has no players
// left to add any points, and a team's own actual score essentially never
// decreases (see the DB-level guard on implausible decreases for why).
// Without this check, that situation still runs through the same
// symmetric normal-distribution formula used for a fully open game, which
// has no way to know one side has zero remaining upside OR downside left
// -- producing a number like "56%" for a lead that's actually
// unassailable. This treats it as a near-certain (not absolute -- there's
// a small residual chance of an unusual negative-scoring correction,
// e.g. a D/ST swing) win for the still-playing, already-ahead side.
function matchupWinProbability({
  homeExpected,
  awayExpected,
  homeActual,
  awayActual,
  allDone,
  homeAllDone,
  awayAllDone,
  stddev,
}) {
  if (allDone) {
    if (homeActual > awayActual) return 100;
    if (homeActual < awayActual) return 0;
    return 50; // exact tie, no more randomness left, and no rule to break it here
  }

  if (homeAllDone && !awayAllDone && homeActual < awayActual) return 1; // home locked & already behind -> away can't be caught
  if (awayAllDone && !homeAllDone && awayActual < homeActual) return 99; // away locked & already behind -> home can't be caught

  return winProbability(homeExpected, awayExpected, stddev);
}

module.exports = {
  normalCdf,
  playerExpected,
  teamExpected,
  buildLineupFingerprint,
  isPlayerPending,
  computeDynamicStddev,
  winProbability,
  matchupWinProbability,
  DEFAULT_STDDEV,
  MIN_STDDEV,
};
