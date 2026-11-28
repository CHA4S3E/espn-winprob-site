// Minimal self-test, no framework needed. Run: node lib/transactions.test.js
const assert = require('assert');
const { parseTransactions } = require('./transactions');

const teams = { 1: 'uuid-a', 2: 'uuid-b' };
const json = { transactions: [
  { id: 101, status: 'EXECUTED', type: 'WAIVER', teamId: 1, processDate: 1764100000000,
    items: [{ playerId: 4430807, type: 'ADD', fromTeamId: 0, toTeamId: 1 }, { playerId: 3918298, type: 'DROP', fromTeamId: 1, toTeamId: 0 }] },
  { id: 102, status: 'FAILED_INVALIDPLAYERSOURCE', type: 'WAIVER', teamId: 2, items: [{ playerId: 1, type: 'ADD' }] },
  { id: 103, status: 'EXECUTED', type: 'ROSTER', teamId: 2, items: [{ playerId: 5, type: 'LINEUP', fromLineupSlotId: 20, toLineupSlotId: 2 }] },
  { id: 104, status: 'EXECUTED', type: 'TRADE_ACCEPT', teamId: 2, proposedDate: 1764200000000,
    items: [{ playerId: 7, type: 'TRADE', fromTeamId: 2, toTeamId: 1 }, { playerId: 8, type: 'TRADE', fromTeamId: 1, toTeamId: 2 }] },
  { id: 105, status: 'EXECUTED', type: 'FREEAGENT', teamId: 2, processDate: 1764300000000, items: [{ playerId: -16001, type: 'ADD', fromTeamId: 0, toTeamId: 2 }] },
] };

const rows = parseTransactions(json, teams);
assert.deepStrictEqual(rows.map((r) => [r.espn_id, r.kind, r.team_id]), [['101', 'waiver', 'uuid-a'], ['104', 'trade', 'uuid-b'], ['105', 'free_agent', 'uuid-b']]);
assert.deepStrictEqual(rows[0].items.map((i) => [i.player_id, i.type, i.from_team_id, i.to_team_id]), [[4430807, 'ADD', null, 'uuid-a'], [3918298, 'DROP', 'uuid-a', null]]);
assert.deepStrictEqual(rows[1].items.map((i) => [i.from_team_id, i.to_team_id]), [['uuid-b', 'uuid-a'], ['uuid-a', 'uuid-b']]);
assert.strictEqual(rows[0].ts, new Date(1764100000000).toISOString());
assert.deepStrictEqual(parseTransactions(null, teams), []);
assert.deepStrictEqual(parseTransactions({}, teams), []);

console.log('All transactions tests passed.');
