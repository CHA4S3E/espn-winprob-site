// Minimal self-test, no framework needed. Run: node lib/multiweek.test.js
const assert = require('assert');
const { periodForWeek, carryIn, rostersPresent } = require('./multiweek');

const periods = { 14: [14], 15: [15], 16: [16, 17] };
assert.deepStrictEqual(periodForWeek(periods, 15), { periodId: 15, weeks: [15] });
assert.deepStrictEqual(periodForWeek(periods, 17), { periodId: 16, weeks: [16, 17] });
assert.deepStrictEqual(periodForWeek(periods, 16), { periodId: 16, weeks: [16, 17] });
assert.strictEqual(periodForWeek(periods, 18), null);
assert.strictEqual(periodForWeek(null, 17), null);

// Week 17 of a 16-17 final: week 16's points carry in.
assert.strictEqual(carryIn({ pointsByScoringPeriod: { 16: 121.4, 17: 12 } }, [16, 17], 17, 0), 121.4);
assert.strictEqual(carryIn({ pointsByScoringPeriod: { '16': 99.5 } }, [16, 17], 17, 0), 99.5);
// Missing from ESPN: use the fallback (last saved final from week 16).
assert.strictEqual(carryIn({}, [16, 17], 17, 118.2), 118.2);
// First week of the period, or a one-week period: nothing to carry.
assert.strictEqual(carryIn({ pointsByScoringPeriod: { 16: 50 } }, [16, 17], 16, 0), 0);
assert.strictEqual(carryIn({}, [15], 15, 77), 0);

const side = (n) => ({ rosterForCurrentScoringPeriod: { entries: new Array(n).fill({}) } });
assert.strictEqual(rostersPresent([{ home: side(9), away: side(9) }]), true);
assert.strictEqual(rostersPresent([{ home: side(9), away: side(0) }]), false);
assert.strictEqual(rostersPresent([{ home: side(9), away: {} }]), false);

console.log('All multiweek tests passed.');
