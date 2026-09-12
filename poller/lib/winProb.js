// Core win-probability model -- ported from the Chrome extension's
// background.js. Kept as plain, dependency-free JS so the math can be
// unit-tested in isolation from network/DB code.

const LINEUP_SLOT_BENCH = 20;
const LINEUP_SLOT_IR = 21;
const STAT_SOURCE_PROJECTED = 1;
const STAT_SOURCE_ACTUAL = 0;

const DEFAULT_STDDEV = 10;
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

// Per-player expected contribution: if their real NFL game is over, only
// their actual points count (leftover projection is gone). Otherwise use
// whichever is higher of actual-so-far or pre-game projection.
function playerExpected(player, nflStatusMap) {
  const proTeamAbbrev = player.proTeamAbbrev;
  const gameOver = nflStatusMap ? nflStatusMap[proTeamAbbrev] === 'post' : false;

  const actual = getStatPoints(player, STAT_SOURCE_ACTUAL);
  const projected = getStatPoints(player, STAT_SOURCE_PROJECTED);

  if (gameOver) return { expected: actual, done: true };
  return { expected: Math.max(actual, projected), done: false };
}

function getStatPoints(player, statSourceId) {
  const entry = (player.stats || []).find((s) => s.statSourceId === statSourceId);
  return entry ? entry.appliedTotal || 0 : 0;
}

// Sums the starting lineup only (bench/IR excluded), returning the expected
// total, the summed *actual* live points (per-player, not ESPN's team-level
// totalPoints field which can lag/stay stale mid-game), and whether every
// starter's real game has finished.
function teamExpected(roster, nflStatusMap) {
  let expected = 0;
  let actual = 0;
  let allDone = true;
  for (const entry of roster || []) {
    if (entry.lineupSlotId === LINEUP_SLOT_BENCH || entry.lineupSlotId === LINEUP_SLOT_IR) continue;
    const player = entry.playerPoolEntry.player;
    const { expected: playerPts, done } = playerExpected(player, nflStatusMap);
    expected += playerPts;
    actual += getStatPoints(player, STAT_SOURCE_ACTUAL);
    if (!done) allDone = false;
  }
  return { expected, actual, allDone };
}

// Variance shrinks as fewer starters remain in play. Scales stddev by
// sqrt(remaining projected / total projected) across both teams combined,
// floored so it never collapses to (near) zero.
function computeDynamicStddev(totalProjectedBoth, remainingProjectedBoth, baseStddev = DEFAULT_STDDEV) {
  if (totalProjectedBoth <= 0) return MIN_STDDEV;
  const ratio = Math.max(remainingProjectedBoth / totalProjectedBoth, 0);
  const scaled = baseStddev * Math.sqrt(ratio);
  return Math.max(scaled, MIN_STDDEV);
}

// expectedA/expectedB are each team's expected final score; stddev is the
// (possibly dynamic) spread. Returns team A's win probability, 0-100.
function winProbability(expectedA, expectedB, stddev = DEFAULT_STDDEV) {
  const z = (expectedA - expectedB) / (stddev * Math.SQRT2);
  return normalCdf(z) * 100;
}

module.exports = {
  normalCdf,
  playerExpected,
  teamExpected,
  computeDynamicStddev,
  winProbability,
  DEFAULT_STDDEV,
  MIN_STDDEV,
};
