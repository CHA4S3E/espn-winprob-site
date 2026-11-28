// League transactions for the News Desk's "transaction wire": waiver claims,
// free-agent pickups, drops and trades. ESPN's mTransactions2 view lists every
// transaction for a scoring period, including lineup moves and pending or
// failed claims; only executed adds, drops and trades are kept. Pure functions
// (see transactions.test.js); the fetch/save lives in poll.js.

const KEEP_TYPES = new Set(['FREEAGENT', 'WAIVER', 'TRADE_ACCEPT', 'TRADE_PROPOSAL', 'ROSTER']);

// json: the ESPN response. teamIdByEspnId: ESPN team id -> our team uuid.
// Returns rows ready for the `transactions` table (names filled in later).
function parseTransactions(json, teamIdByEspnId) {
  const out = [];
  for (const t of (json && json.transactions) || []) {
    if (!t || t.status !== 'EXECUTED' || !KEEP_TYPES.has(t.type)) continue;
    const items = (t.items || []).filter((it) => it && (it.type === 'ADD' || it.type === 'DROP' || it.type === 'TRADE'));
    if (!items.length) continue;
    const isTrade = t.type.startsWith('TRADE') || items.some((it) => it.type === 'TRADE');
    out.push({
      espn_id: String(t.id),
      ts: new Date(Number(t.processDate || t.proposedDate || Date.now())).toISOString(),
      kind: isTrade ? 'trade' : t.type === 'WAIVER' ? 'waiver' : 'free_agent',
      team_id: teamIdByEspnId[t.teamId] || null,
      items: items.map((it) => ({
        player_id: it.playerId,
        type: it.type,
        from_team_id: it.fromTeamId > 0 ? teamIdByEspnId[it.fromTeamId] || null : null,
        to_team_id: it.toTeamId > 0 ? teamIdByEspnId[it.toTeamId] || null : null,
        name: null, pos: null, pro: null,
      })),
    });
  }
  return out;
}

module.exports = { parseTransactions };
