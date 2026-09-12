// Minimal self-test, no framework needed. Run: node lib/winProb.test.js
const assert = require('assert');
const { normalCdf, winProbability, computeDynamicStddev } = require('./winProb');

assert(Math.abs(normalCdf(-3) - 0.0013) < 0.001, 'z=-3 should be near 0');
assert(Math.abs(normalCdf(3) - 0.9987) < 0.001, 'z=3 should be near 1');
assert(Math.abs(normalCdf(0) - 0.5) < 1e-9, 'z=0 should be exactly 0.5');

assert(winProbability(120, 100, 10) > 90, 'big lead should be a heavy favorite');
assert(Math.abs(winProbability(100, 100, 10) - 50) < 1e-4, 'tied scores should be 50/50');

assert(computeDynamicStddev(200, 200) === 10, 'full remaining variance should equal base stddev');
assert(computeDynamicStddev(200, 2) < 5, 'little remaining variance should shrink stddev a lot');

console.log('All winProb tests passed.');
