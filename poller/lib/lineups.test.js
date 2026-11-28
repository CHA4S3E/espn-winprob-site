// Minimal self-test, no framework needed. Run: node lib/lineups.test.js
const assert = require('assert');
const { buildPlayers, diffEvents } = require('./lineups');

// An ESPN roster entry, in the shape mRoster returns.
function entry({ id, name, pos = 1, team = 'KC', slot = 0, pts = 0, proj = 20, stats = {} }) {
  return {
    lineupSlotId: slot,
    playerPoolEntry: { player: {
      id, fullName: name, defaultPositionId: pos, proTeamAbbrev: team,
      stats: [
        { statSourceId: 0, appliedTotal: pts, stats },
        { statSourceId: 1, appliedTotal: proj, stats: {} },
      ],
    } },
  };
}
const live = { KC: { state: 'in' }, BUF: { state: 'in' } };
const done = { KC: { state: 'post' }, BUF: { state: 'post' } };

// buildPlayers
const p0 = buildPlayers([
  entry({ id: 1, name: 'Pat QB', pts: 10, stats: { 3: 180, 4: 1 } }),
  entry({ id: 2, name: 'Bench Guy', pos: 2, slot: 20, pts: 3 }),
  { lineupSlotId: 0 }, // malformed entry is skipped
], live);
assert.strictEqual(p0.length, 2);
assert.deepStrictEqual(p0[0], { id: 1, n: 'Pat QB', pos: 'QB', tm: 'KC', bench: false, pts: 10, proj: 20, g: 'in', st: { passYds: 180, passTd: 1 } });
assert.strictEqual(p0[1].bench, true);
assert.strictEqual(buildPlayers([entry({ id: 3, name: 'X', team: 'NYJ' })], live)[0].g, 'bye');

// First poll of the week: nothing to compare, no events.
assert.deepStrictEqual(diffEvents(null, p0), []);
assert.deepStrictEqual(diffEvents([], p0), []);

// A passing TD + crossing 300 yards.
const p1 = buildPlayers([
  entry({ id: 1, name: 'Pat QB', pts: 20.5, stats: { 3: 305, 4: 2 } }),
  entry({ id: 2, name: 'Bench Guy', pos: 2, slot: 20, pts: 3 }),
], live);
const e1 = diffEvents(p0, p1);
const kinds1 = e1.map((e) => e.kind).sort();
assert.deepStrictEqual(kinds1, ['pass_milestone', 'pass_td']);
const td = e1.find((e) => e.kind === 'pass_td');
assert.strictEqual(td.player_name, 'Pat QB');
assert.strictEqual(td.delta, 10.5);
assert.strictEqual(td.detail.count, 1);

// Unchanged poll: no events.
assert.deepStrictEqual(diffEvents(p1, p1), []);

// Interception, and a big play without a TD.
const wrA = buildPlayers([entry({ id: 5, name: 'Wide Out', pos: 3, team: 'BUF', pts: 4, stats: { 42: 40, 53: 3 } })], live);
const wrB = buildPlayers([entry({ id: 5, name: 'Wide Out', pos: 3, team: 'BUF', pts: 13, stats: { 42: 110, 53: 4 } })], live);
assert.deepStrictEqual(diffEvents(wrA, wrB).map((e) => e.kind).sort(), ['big_play', 'rec_milestone']);
const qbInt = buildPlayers([entry({ id: 1, name: 'Pat QB', pts: 18.5, stats: { 3: 305, 4: 2, 20: 1 } })], live);
assert.ok(diffEvents(p1, qbInt).some((e) => e.kind === 'interception'));

// Game ends: dud for a starter way under projection, bench boom for a benched star.
const before = buildPlayers([
  entry({ id: 7, name: 'Dud Back', pos: 2, team: 'BUF', pts: 2, proj: 15 }),
  entry({ id: 8, name: 'Benched Star', pos: 3, team: 'KC', slot: 20, pts: 24, proj: 12 }),
], live);
const after = buildPlayers([
  entry({ id: 7, name: 'Dud Back', pos: 2, team: 'BUF', pts: 2, proj: 15 }),
  entry({ id: 8, name: 'Benched Star', pos: 3, team: 'KC', slot: 20, pts: 24, proj: 12 }),
], done);
assert.deepStrictEqual(diffEvents(before, after).map((e) => e.kind).sort(), ['bench_boom', 'dud']);

// Benched players never generate starter news.
const benchA = buildPlayers([entry({ id: 9, name: 'Bench TD', slot: 20, pts: 2, stats: { 25: 0 } })], live);
const benchB = buildPlayers([entry({ id: 9, name: 'Bench TD', slot: 20, pts: 14, stats: { 25: 1 } })], live);
assert.deepStrictEqual(diffEvents(benchA, benchB), []);

console.log('All lineups tests passed.');
