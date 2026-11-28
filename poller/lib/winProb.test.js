// Minimal self-test, no framework needed. Run: node lib/winProb.test.js
const assert = require('assert');
const { normalCdf, winProbability, computeDynamicStddev, calibratedWinProbability, studentTCdf, matchupWinProbability, DEFAULT_STDDEV } = require('./winProb');

assert(Math.abs(normalCdf(-3) - 0.0013) < 0.001, 'z=-3 should be near 0');
assert(Math.abs(normalCdf(3) - 0.9987) < 0.001, 'z=3 should be near 1');
assert(Math.abs(normalCdf(0) - 0.5) < 1e-9, 'z=0 should be exactly 0.5');

assert(winProbability(120, 100, 10) > 90, 'big lead should be a heavy favorite');
assert(Math.abs(winProbability(100, 100, 10) - 50) < 1e-4, 'tied scores should be 50/50');

assert(computeDynamicStddev(200, 200) === DEFAULT_STDDEV, 'full remaining variance should equal base stddev');
assert(computeDynamicStddev(200, 2) < 5, 'little remaining variance should shrink stddev a lot');

// Student-t CDF against table values (10 degrees of freedom).
assert(Math.abs(studentTCdf(1.812, 10) - 0.95) < 0.001, 't10 95th percentile');
assert(Math.abs(studentTCdf(2.764, 10) - 0.99) < 0.001, 't10 99th percentile');
assert(Math.abs(studentTCdf(-2.764, 10) - 0.01) < 0.001, 't10 symmetry');
assert(Math.abs(studentTCdf(0, 10) - 0.5) < 1e-9, 't10 median');

// Calibrated model: symmetric, monotonic, and humbler than the raw one.
const cal = (hE, aE, hA, aA, sd) => calibratedWinProbability({ homeExpected: hE, awayExpected: aE, homeActual: hA, awayActual: aA, stddev: sd });
assert(Math.abs(cal(110, 110, 0, 0, 21) - 50) < 1e-6, 'even matchup is 50/50');
assert(Math.abs(cal(120, 100, 0, 0, 21) + cal(100, 120, 0, 0, 21) - 100) < 1e-6, 'symmetric');
assert(cal(130, 100, 0, 0, 21) > cal(120, 100, 0, 0, 21), 'bigger gap -> more likely');
assert(cal(120, 100, 0, 0, 21) < winProbability(120, 100, 21), 'start of week: less sure than the raw model');
assert(cal(120, 100, 0, 0, 21) < 70 && cal(120, 100, 0, 0, 21) > 55, 'a 20-point projected edge pregame is a modest favorite');
// Late with a big lead: very likely, but no longer "certain".
const late = cal(115, 100, 110, 96, 3);
assert(late > 95 && late < 99.9, `late 15-point lead should be ~95-99.x%, got ${late}`);
// Points already scored count fully: same projected gap, but earned already -> more confident.
assert(cal(120, 100, 60, 40, 15) > cal(120, 100, 0, 0, 15), 'real points count more than projected ones');
// Locked-in cases unchanged.
assert(matchupWinProbability({ homeExpected: 90, awayExpected: 100, homeActual: 90, awayActual: 100, allDone: true, stddev: 2 }) === 0, 'final is final');

console.log('All winProb tests passed.');
