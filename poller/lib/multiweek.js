// Multi-week matchups (e.g. a championship played over NFL weeks 16 and 17,
// scores added together). ESPN files such a matchup under its first matchup
// period (matchupPeriodId 16), so a poll in week 17 finds no matchup with
// matchupPeriodId === 17. These helpers find the matchup period that contains
// the current week and the points each side already banked in earlier weeks
// of it, so the poller can keep writing the combined score. Pure functions:
// see multiweek.test.js.

// matchupPeriods: ESPN settings.scheduleSettings.matchupPeriods, e.g.
// { "15": [15], "16": [16, 17] }. Returns { periodId, weeks } or null.
function periodForWeek(matchupPeriods, week) {
  for (const [pid, weeks] of Object.entries(matchupPeriods || {})) {
    const ws = (weeks || []).map(Number);
    if (ws.includes(Number(week))) return { periodId: Number(pid), weeks: ws.sort((a, b) => a - b) };
  }
  return null;
}

// Points this side scored in earlier weeks of the period. ESPN's
// pointsByScoringPeriod ({ "16": 121.4 }) when present, else `fallback`
// (the poller passes the last saved final score from the earlier week(s)).
function carryIn(side, weeks, week, fallback) {
  const earlier = (weeks || []).filter((w) => w < week);
  if (!earlier.length) return 0;
  const by = side && side.pointsByScoringPeriod;
  if (by && earlier.every((w) => by[w] != null || by[String(w)] != null)) {
    return earlier.reduce((s, w) => s + Number(by[w] != null ? by[w] : by[String(w)]), 0);
  }
  return Number(fallback) || 0;
}

// True if every side of these matchups has a roster for the current scoring
// period -- without it the poller would compute 0 points and must not write.
function rostersPresent(matchups) {
  return (matchups || []).every((m) => [m.home, m.away].every((s) => s && s.rosterForCurrentScoringPeriod && (s.rosterForCurrentScoringPeriod.entries || []).length));
}

module.exports = { periodForWeek, carryIn, rostersPresent };
