// If config.js failed to load (wrong path, 404, etc.), SUPABASE_CONFIG
// won't exist -- destructuring it directly would throw immediately and
// halt this entire script before anything else runs, which is its own
// silent-failure trap (the page would just sit on its default "Loading"
// text forever with nothing in the console explaining why).
if (!window.SUPABASE_CONFIG) {
  document.getElementById('loadingState').textContent =
    'Could not find Supabase configuration (config.js). Check that config.js is deployed alongside this page.';
  throw new Error('window.SUPABASE_CONFIG is missing -- config.js did not load or ran after this script');
}
const { url, anonKey } = window.SUPABASE_CONFIG;
const sb = window.supabase.createClient(url, anonKey);

// Supabase's default 1000-row cap on unpaginated queries -- ported from
// year-in-review.js, which solved this same problem first. Needed here now
// that Power Rankings' luck-adjustment term requires each matchup's EARLY
// (pregame) win_prob polls, not just the final all_starters_done=true row
// the win-loss table alone would need -- so the query below can no longer
// filter down to just-the-finals server-side.
const PAGE_SIZE = 1000;
async function fetchAllRows(buildQuery) {
  let all = [];
  let from = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { data, error } = await buildQuery(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    all = all.concat(data || []);
    if (!data || data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return all;
}

function showError(headline, detail) {
  console.error(headline, detail);
  const loadingEl = document.getElementById('loadingState');
  loadingEl.style.display = 'block';
  loadingEl.textContent = `${headline} -- check the browser console for details.`;
  document.getElementById('standingsTable').style.display = 'none';
  document.getElementById('emptyState').style.display = 'none';
}

const leagueSelect = document.getElementById('leagueSelect');
const weekSelect = document.getElementById('weekSelect');
const loadingState = document.getElementById('loadingState');
const standingsTable = document.getElementById('standingsTable');
const emptyState = document.getElementById('emptyState');
const subtext = document.getElementById('subtext');

let allRows = []; // every snapshot row for the currently-selected league, all years/weeks
let teamInfo = {}; // team_id -> { name, color }

// ============================================================
// Aggregation -- verified separately against six scenarios (a normal
// season, a bye week, snapshot deduplication, a still-live matchup, a
// points-based tiebreaker, and the "through week X" historical filter)
// before being wired up to real data here.
// ============================================================
function computeStandings(rows, teamInfoMap, throughWeek) {
  const latestByKey = new Map();
  for (const r of rows) {
    if (throughWeek != null && r.week > throughWeek) continue;
    const key = `${r.year}|${r.week}|${r.matchup_id}|${r.team_id}`;
    const existing = latestByKey.get(key);
    if (!existing || new Date(r.ts) > new Date(existing.ts)) latestByKey.set(key, r);
  }

  const matchupGroups = new Map();
  for (const r of latestByKey.values()) {
    const mKey = `${r.year}|${r.week}|${r.matchup_id}`;
    if (!matchupGroups.has(mKey)) matchupGroups.set(mKey, []);
    matchupGroups.get(mKey).push(r);
  }

  const records = new Map();
  function getRecord(teamId) {
    if (!records.has(teamId)) records.set(teamId, { wins: 0, losses: 0, ties: 0, pointsFor: 0, pointsAgainst: 0, resultsByWeek: [] });
    return records.get(teamId);
  }

  for (const sides of matchupGroups.values()) {
    if (sides.length !== 2) continue;
    const [a, b] = sides;
    if (!a.all_starters_done || !b.all_starters_done) continue;
    const recA = getRecord(a.team_id), recB = getRecord(b.team_id);
    recA.pointsFor += a.actual_score; recA.pointsAgainst += b.actual_score;
    recB.pointsFor += b.actual_score; recB.pointsAgainst += a.actual_score;
    let resultA, resultB;
    if (a.actual_score > b.actual_score) { recA.wins++; recB.losses++; resultA = 'W'; resultB = 'L'; }
    else if (b.actual_score > a.actual_score) { recB.wins++; recA.losses++; resultA = 'L'; resultB = 'W'; }
    else { recA.ties++; recB.ties++; resultA = 'T'; resultB = 'T'; }
    recA.resultsByWeek.push({ week: a.week, result: resultA });
    recB.resultsByWeek.push({ week: b.week, result: resultB });
  }

  const standings = [];
  for (const [teamId, rec] of records) {
    const gamesPlayed = rec.wins + rec.losses + rec.ties;
    const winPct = gamesPlayed ? (rec.wins + rec.ties * 0.5) / gamesPlayed : 0;
    rec.resultsByWeek.sort((x, y) => x.week - y.week);
    let streak = '';
    if (rec.resultsByWeek.length) {
      const lastResult = rec.resultsByWeek[rec.resultsByWeek.length - 1].result;
      let count = 0;
      for (let i = rec.resultsByWeek.length - 1; i >= 0 && rec.resultsByWeek[i].result === lastResult; i--) count++;
      streak = `${lastResult}${count}`;
    }
    standings.push({
      teamId, team: teamInfoMap[teamId] || { name: 'Unknown', color: '#888' },
      wins: rec.wins, losses: rec.losses, ties: rec.ties, winPct,
      pointsFor: rec.pointsFor, pointsAgainst: rec.pointsAgainst, streak,
    });
  }

  // Points-for tiebreaker: ESPN's most common default. Actual league
  // settings (head-to-head, division record, etc.) aren't something the
  // poller currently reads -- if a league uses a different tiebreaker,
  // this can misorder two teams tied on record. Worth flagging rather
  // than silently assuming this is always right.
  standings.sort((x, y) => y.winPct - x.winPct || y.pointsFor - x.pointsFor);
  return standings;
}

// ============================================================
// Power Rankings
//
// A "Power Score" (0-100) per team, built in layers rather than as one
// flat formula:
//   1. Opponent-adjusted scoring power via a weighted Simple Rating
//      System (SRS) -- each team's rating is solved so that, across every
//      game played, ratingA - ratingB approximates the actual margin.
//      Solved iteratively (Gauss-Seidel-style) rather than via a matrix
//      library: each team's rating converges to the weighted average,
//      across its own games, of (its margin + its opponent's current
//      rating), which converges to the same answer a full least-squares
//      solve would for this problem structure.
//   2. Recency weighting baked directly into that same regression --
//      each game's weight decays the older it gets (relative to whatever
//      week is being viewed), so early-season blowouts don't carry the
//      same weight forever.
//   3. Bayesian shrinkage toward the league-average rating, weighted by
//      each team's EFFECTIVE sample size (the sum of its games' recency
//      weights, not a raw count) -- keeps a 2-0 start from reading as an
//      all-time juggernaut before it's earned a real sample.
//   4. A luck adjustment using the win-prob model this site already runs:
//      actual wins minus each matchup's PREGAME win_prob (its earliest
//      recorded poll) -- a team running well ahead of what the model gave
//      them gets nudged down slightly, and vice versa. This term is
//      skipped entirely (contributes 0) wherever pregame win_prob isn't
//      available, same graceful-degrade convention every other win_prob-
//      dependent stat on this site already follows.
//   5. Uncertainty that shrinks with effective sample size, and a final
//      normalization to 0-100 via the exact same normal CDF the win-
//      probability engine itself uses (see normalCdf in winProb.js) --
//      so a "Power Score" reads on the same statistical footing as every
//      percentage already shown elsewhere on this site.
// ============================================================

// Same corrected Abramowitz & Stegun erf approximation as winProb.js --
// duplicated rather than shared, same as every other cross-file utility on
// this standalone page (see themedColor above).
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

// The closest thing to "what the model thought before this game" --
// pulled straight off snapshot_summary's own pregame_win_prob column
// (the earliest recorded win_prob per matchup-team, computed server-side
// now -- see 017_performance_latest_snapshots_and_power_cache.sql) rather
// than scanning the full poll history for it client-side. Returns a Map
// keyed `${year}|${week}|${matchup_id}|${team_id}` -- year matters here
// the same way it does in computeStandings' own keys above: matchup_id is
// only unique WITHIN a season, so a league with multiple years of history
// would otherwise silently merge, say, 2024's week 3 matchup 2 with
// 2025's week 3 matchup 2 as if they were one game.
function extractPregameWinProb(rows) {
  const result = new Map();
  for (const r of rows) {
    if (r.pregame_win_prob == null) continue;
    const key = `${r.year}|${r.week}|${r.matchup_id}|${r.team_id}`;
    result.set(key, r.pregame_win_prob);
  }
  return result;
}

// rows: raw (unfiltered) snapshot rows -- same shape computeStandings
//   takes; this does its own latest-per-key + all_starters_done filtering.
// teamIds: every team that should appear in the output, even ones with
//   zero games so far this season (they'll just sit at the shrunk prior).
// pregameWinProbByKey: result of extractPregameWinProb, or null/undefined
//   to skip the luck term entirely (e.g. no win_prob tracked at all).
// throughWeek: only consider games at or before this week; null = whole
//   season so far.
function computePowerRatings(rows, teamIds, pregameWinProbByKey, throughWeek, opts) {
  const decay = (opts && opts.decay) ?? 0.85;
  const priorK = (opts && opts.priorK) ?? 3;
  const luckLambda = (opts && opts.luckLambda) ?? 0.15;
  const DEFAULT_STDDEV = 21; // same per-team score stddev winProb.js's model uses

  const latestByKey = new Map();
  for (const r of rows) {
    if (throughWeek != null && r.week > throughWeek) continue;
    const key = `${r.year}|${r.week}|${r.matchup_id}|${r.team_id}`;
    const existing = latestByKey.get(key);
    if (!existing || new Date(r.ts) > new Date(existing.ts)) latestByKey.set(key, r);
  }
  const matchupGroups = new Map();
  for (const r of latestByKey.values()) {
    const mKey = `${r.year}|${r.week}|${r.matchup_id}`;
    if (!matchupGroups.has(mKey)) matchupGroups.set(mKey, []);
    matchupGroups.get(mKey).push(r);
  }

  const maxSeenWeek = throughWeek != null ? throughWeek : rows.reduce((m, r) => Math.max(m, r.week), 0);
  const games = []; // { teamA, teamB, margin (A - B), weight }
  const finishedPairs = []; // matchup groups that actually went final, for the luck term below
  for (const sides of matchupGroups.values()) {
    if (sides.length !== 2) continue;
    const [a, b] = sides;
    if (!a.all_starters_done || !b.all_starters_done) continue;
    const age = maxSeenWeek - a.week;
    const weight = Math.pow(decay, Math.max(0, age));
    games.push({ teamA: a.team_id, teamB: b.team_id, margin: a.actual_score - b.actual_score, weight });
    finishedPairs.push([a, b]);
  }

  const result = new Map();
  if (!games.length) {
    for (const id of teamIds) result.set(id, { score: 50, rating: 0, stdErr: DEFAULT_STDDEV * Math.SQRT2, gamesPlayed: 0 });
    return result;
  }

  // Iterative weighted SRS solve.
  const ratings = new Map(teamIds.map((id) => [id, 0]));
  const gamesByTeam = new Map(teamIds.map((id) => [id, []]));
  for (const g of games) {
    if (gamesByTeam.has(g.teamA)) gamesByTeam.get(g.teamA).push({ opp: g.teamB, margin: g.margin, weight: g.weight });
    if (gamesByTeam.has(g.teamB)) gamesByTeam.get(g.teamB).push({ opp: g.teamA, margin: -g.margin, weight: g.weight });
  }
  for (let iter = 0; iter < 100; iter++) {
    let maxDelta = 0;
    for (const id of teamIds) {
      const gs = gamesByTeam.get(id);
      if (!gs || !gs.length) continue;
      let num = 0, den = 0;
      for (const g of gs) { num += g.weight * (g.margin + ratings.get(g.opp)); den += g.weight; }
      const next = den ? num / den : 0;
      maxDelta = Math.max(maxDelta, Math.abs(next - ratings.get(id)));
      ratings.set(id, next);
    }
    if (maxDelta < 0.0005) break;
  }
  // Ratings are only meaningful as differences -- center to mean 0 so the
  // otherwise-arbitrary additive constant lands somewhere legible.
  const ratingVals = [...ratings.values()];
  const meanRating = ratingVals.reduce((s, v) => s + v, 0) / (ratingVals.length || 1);
  for (const id of teamIds) ratings.set(id, ratings.get(id) - meanRating);

  // Bayesian shrinkage, weighted by effective (recency-decayed) sample size.
  const effN = new Map(teamIds.map((id) => [id, 0]));
  for (const g of games) {
    if (effN.has(g.teamA)) effN.set(g.teamA, effN.get(g.teamA) + g.weight);
    if (effN.has(g.teamB)) effN.set(g.teamB, effN.get(g.teamB) + g.weight);
  }
  const shrunk = new Map();
  for (const id of teamIds) {
    const n = effN.get(id) || 0;
    shrunk.set(id, (n / (n + priorK)) * ratings.get(id));
  }

  // Luck adjustment (skipped entirely, contributing 0, when no pregame
  // win_prob data is available at all).
  const luck = new Map(teamIds.map((id) => [id, 0]));
  if (pregameWinProbByKey) {
    const winsExpected = new Map(teamIds.map((id) => [id, 0]));
    const winsActual = new Map(teamIds.map((id) => [id, 0]));
    for (const [a, b] of finishedPairs) {
      for (const side of [a, b]) {
        const pregame = pregameWinProbByKey.get(`${side.year}|${side.week}|${side.matchup_id}|${side.team_id}`);
        if (pregame != null && winsExpected.has(side.team_id)) {
          winsExpected.set(side.team_id, winsExpected.get(side.team_id) + pregame / 100);
        }
      }
      if (a.actual_score > b.actual_score) { if (winsActual.has(a.team_id)) winsActual.set(a.team_id, winsActual.get(a.team_id) + 1); }
      else if (b.actual_score > a.actual_score) { if (winsActual.has(b.team_id)) winsActual.set(b.team_id, winsActual.get(b.team_id) + 1); }
      else {
        if (winsActual.has(a.team_id)) winsActual.set(a.team_id, winsActual.get(a.team_id) + 0.5);
        if (winsActual.has(b.team_id)) winsActual.set(b.team_id, winsActual.get(b.team_id) + 0.5);
      }
    }
    for (const id of teamIds) luck.set(id, luckLambda * ((winsActual.get(id) || 0) - (winsExpected.get(id) || 0)));
  }

  const adjusted = new Map();
  for (const id of teamIds) adjusted.set(id, shrunk.get(id) + luck.get(id));

  // Standard error shrinks with effective sample size -- reported
  // alongside the score rather than folded into it.
  const stdErr = new Map();
  for (const id of teamIds) {
    const n = effN.get(id) || 0;
    stdErr.set(id, n > 0 ? (DEFAULT_STDDEV * Math.SQRT2) / Math.sqrt(n) : DEFAULT_STDDEV * Math.SQRT2);
  }

  // Normalize to 0-100 via the standard normal CDF.
  const adjVals = [...adjusted.values()];
  const meanAdj = adjVals.reduce((s, v) => s + v, 0) / (adjVals.length || 1);
  const variance = adjVals.reduce((s, v) => s + (v - meanAdj) ** 2, 0) / (adjVals.length || 1);
  const stdAdj = Math.sqrt(variance) || 1;

  for (const id of teamIds) {
    const z = (adjusted.get(id) - meanAdj) / stdAdj;
    result.set(id, { score: 100 * normalCdf(z), rating: adjusted.get(id), stdErr: stdErr.get(id), gamesPlayed: effN.get(id) || 0 });
  }
  return result;
}

// ============================================================
// Data loading
// ============================================================
async function loadLeagues() {
  const { data, error } = await sb.from('leagues').select('id, name').order('name');
  if (error) { showError('Could not load leagues', error); return; }
  if (!data.length) { showError('No leagues found', 'The leagues table returned zero rows for this Supabase project.'); return; }
  leagueSelect.innerHTML = data.map((l) => `<option value="${l.id}">${l.name}</option>`).join('');
  await loadLeagueData(data[0].id);
}

async function loadLeagueData(leagueId) {
  loadingState.style.display = 'block';
  standingsTable.style.display = 'none';
  emptyState.style.display = 'none';

  // Needs BOTH the final (all_starters_done=true) row of every matchup,
  // for the win-loss table, AND each matchup's earliest poll, for Power
  // Rankings' luck-adjustment term (see computePowerRatings) -- snapshot_summary
  // (see 017_performance_latest_snapshots_and_power_cache.sql) already reduces
  // the raw poll history down to exactly that, one row per matchup-team,
  // server-side -- instead of this page fetching a league's ENTIRE raw
  // snapshot history (every 5-minute poll, every season) just to do the
  // same reduction client-side and throw the rest away. fetchAllRows still
  // paginates around Supabase's 1000-row cap, just over a much smaller result.
  let teams, snapshots;
  try {
    [teams, snapshots] = await Promise.all([
      sb.from('teams').select('id, espn_team_name, team_settings(color, display_name, emoji, logo_url)').eq('league_id', leagueId).then(({ data, error }) => { if (error) throw error; return data; }),
      fetchAllRows((from, to) =>
        sb.from('snapshot_summary')
          .select('year, week, matchup_id, team_id, actual_score, win_prob, all_starters_done, ts, pregame_win_prob')
          .eq('league_id', leagueId).order('ts').range(from, to)
      ),
    ]);
  } catch (err) { showError('Could not load standings data', err); return; }
  console.log(`Loaded ${teams.length} teams and ${snapshots.length} total snapshot rows for this league.`);

  teamInfo = {};
  for (const t of teams) {
    const settings = t.team_settings || {};
    teamInfo[t.id] = {
      name: settings.display_name || t.espn_team_name,
      color: themedColor(settings.color || '#888888'),
      emoji: settings.emoji || '',
      logoUrl: settings.logo_url || '',
    };
  }
  allRows = snapshots;

  const weeks = [...new Set(allRows.map((r) => r.week))].sort((a, b) => a - b);
  weekSelect.innerHTML =
    `<option value="">Full season</option>` +
    weeks.map((w) => `<option value="${w}">Through week ${w}</option>`).join('');

  render();
}

// Logo if uploaded, else the older emoji field, else nothing -- same
// fallback order as the main matchup page, so a team shows consistently
// across both places regardless of whether they've uploaded a logo yet.
// Same color-adjustment logic app.js already applies to the ESPN view --
// ported here rather than shared, since this is a separate, standalone
// script file. Without this, a team color dark enough to work fine on a
// light background (which is genuinely most colors -- this only
// intervenes on ones close to true black) would stay exactly that dark,
// unreadable value even when this page is in dark mode, since nothing
// here was otherwise theme-aware about team colors at all.
const standingsTheme = document.documentElement.getAttribute('data-theme') || 'light';
function stHexToRgb(hex) {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const num = parseInt(full, 16);
  return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
}
function stRgbToHex(r, g, b) {
  return '#' + [r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
}
function stRgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h, s, l = (max + min) / 2;
  if (max === min) { h = s = 0; }
  else {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      case b: h = (r - g) / d + 4; break;
    }
    h /= 6;
  }
  return { h, s, l };
}
function stHslToRgb(h, s, l) {
  let r, g, b;
  if (s === 0) { r = g = b = l; }
  else {
    const hue2rgb = (p, q, t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }
  return { r: r * 255, g: g * 255, b: b * 255 };
}
const ST_MIN_LIGHTNESS = 0.20;
const ST_TARGET_LIGHTNESS = 0.50;
function stIsTooCloseToBlack(hex) {
  try {
    const { r, g, b } = stHexToRgb(hex);
    return stRgbToHsl(r, g, b).l < ST_MIN_LIGHTNESS;
  } catch {
    return false;
  }
}
function themedColor(hex) {
  if (standingsTheme !== 'dark' || !stIsTooCloseToBlack(hex)) return hex;
  try {
    const { r, g, b } = stHexToRgb(hex);
    const { h, s } = stRgbToHsl(r, g, b);
    const { r: nr, g: ng, b: nb } = stHslToRgb(h, s, ST_TARGET_LIGHTNESS);
    return stRgbToHex(nr, ng, nb);
  } catch {
    return hex; // malformed color -- don't crash the page over it
  }
}

function renderTeamIcon(team) {
  if (team.logoUrl) return `<img class="team-icon-img" src="${team.logoUrl}" alt="">`;
  if (team.emoji) return `<span>${team.emoji}</span>`;
  return '';
}

function render() {
  loadingState.style.display = 'none';
  const throughWeek = weekSelect.value ? Number(weekSelect.value) : null;
  const standings = computeStandings(allRows, teamInfo, throughWeek);

  if (!standings.length) {
    standingsTable.style.display = 'none';
    emptyState.style.display = 'block';
    return;
  }
  emptyState.style.display = 'none';
  standingsTable.style.display = 'block';

  subtext.textContent = throughWeek
    ? `Standings through week ${throughWeek}`
    : 'Season record, based on completed weeks';

  const header = `
    <div class="standings-header">
      <span></span>
      <span>Team</span>
      <span style="text-align:right">Record</span>
      <span class="col-pct" style="text-align:right">Pct</span>
      <span style="text-align:right">PF</span>
      <span class="header-pa" style="text-align:right">PA</span>
      <span style="text-align:right">Streak</span>
    </div>
  `;

  const rows = standings.map((s, i) => {
    const streakClass = s.streak.startsWith('W') ? 'streak-w' : s.streak.startsWith('L') ? 'streak-l' : s.streak.startsWith('T') ? 'streak-t' : '';
    return `
      <div class="standings-row" style="--team-color:${s.team.color}">
        <div class="col-rank">${i + 1}</div>
        <div class="col-team"><span class="team-name">${renderTeamIcon(s.team)}${s.team.name}</span></div>
        <div class="col-record">${s.wins}-${s.losses}${s.ties ? '-' + s.ties : ''}</div>
        <div class="col-pct">${s.winPct.toFixed(3).replace(/^0/, '')}</div>
        <div class="col-pf">${s.pointsFor.toFixed(1)}</div>
        <div class="col-pa">${s.pointsAgainst.toFixed(1)}</div>
        <div class="col-streak ${streakClass}">${s.streak || '—'}</div>
      </div>
    `;
  }).join('');

  standingsTable.innerHTML = header + rows;

  renderPowerRankings(standings, throughWeek);
}

// Only computed/rendered once the win-loss table above has something to
// show -- render() already returns early (showing emptyState) before this
// would ever get called with zero completed matchups. Takes the SAME
// `standings` array just rendered above (rather than every team.js knows
// about) so a team with no completed games yet -- which the win-loss table
// above already leaves out entirely, rather than showing an empty 0-0 row
// -- doesn't show up here either, sitting at an uninformative default
// "50.0, Low confidence" forever.
function renderPowerRankings(standings, throughWeek) {
  const powerTable = document.getElementById('powerRankingsTable');
  if (!powerTable) return; // standings.html not yet updated with the section -- degrade quietly
  const teamIds = standings.map((s) => s.teamId);
  const pregameMap = extractPregameWinProb(allRows);

  // "Through week X" already means "as of week X" for the win-loss table
  // above; Power Rankings' own week-over-week delta needs an actual
  // number to diff against even when "Full season" is selected (throughWeek
  // is null there), so this resolves it to the latest week with any data
  // at all in that case -- same week-only convention (not year-aware)
  // computeStandings/computePowerRatings already use elsewhere in this
  // file, so "latest" here means the same thing "Full season" already
  // means for the table above.
  const effectiveWeek = throughWeek != null ? throughWeek : allRows.reduce((m, r) => Math.max(m, r.week), 0);
  const previousWeek = effectiveWeek - 1;

  const ratings = computePowerRatings(allRows, teamIds, pregameMap, throughWeek);
  // null (not computed at all) when there's no prior week to compare
  // against -- e.g. viewing week 1 itself, or "through week 1" -- rather
  // than running a needless computePowerRatings(..., 0) that would just
  // return every team at the shrunk-to-nothing default anyway.
  const previousRatings = previousWeek >= 1 ? computePowerRatings(allRows, teamIds, pregameMap, previousWeek) : null;

  const ranked = teamIds
    .map((id) => ({ teamId: id, team: teamInfo[id], ...ratings.get(id) }))
    .sort((a, b) => b.score - a.score);

  const header = `
    <div class="standings-header power-header">
      <span></span>
      <span>Team</span>
      <span style="text-align:right">Power Score</span>
    </div>
  `;
  const rows = ranked.map((r, i) => {
    const prev = previousRatings ? previousRatings.get(r.teamId) : null;
    // No prior week counted, or the team hadn't played a single game as
    // of it yet -- a delta against the shrunk-to-nothing default score
    // every unplayed team starts at would read as a meaningless "+11.4"
    // on a team's very first appearance, so this shows "New" instead.
    const deltaHtml = (!prev || !prev.gamesPlayed)
      ? '<span class="power-delta power-delta-new">New</span>'
      : renderPowerDelta(r.score - prev.score);
    return `
      <div class="standings-row power-row" style="--team-color:${r.team.color}">
        <div class="col-rank">${i + 1}</div>
        <div class="col-team"><span class="team-name">${renderTeamIcon(r.team)}${r.team.name}</span></div>
        <div class="col-power">
          ${r.score.toFixed(1)} ${deltaHtml}
          <span class="power-confidence">${confidenceLabel(r.gamesPlayed)}</span>
        </div>
      </div>
    `;
  }).join('');
  powerTable.innerHTML = header + rows;
}

// "+3.2" in the win color, "-1.8" in the loss color, or a neutral "±0.0"
// for anything close enough to flat to just be rounding noise -- same
// three-way convention (win/loss/neutral) the streak column above already
// uses, just applied to a continuous number instead of a W/L/T letter.
function renderPowerDelta(delta) {
  if (Math.abs(delta) < 0.05) return '<span class="power-delta power-delta-flat">±0.0</span>';
  const sign = delta > 0 ? '+' : '−'; // true minus sign, not a hyphen, to match the '+' glyph's weight
  const cls = delta > 0 ? 'power-delta-up' : 'power-delta-down';
  return `<span class="power-delta ${cls}">${sign}${Math.abs(delta).toFixed(1)}</span>`;
}

// A team's rating uncertainty (stdErr, computed alongside the score)
// shrinks monotonically with effective games played -- rather than
// showing a raw "±" number in a completely different unit than the 0-100
// score itself (confusing without real payoff), this reports the same
// underlying signal as a plain-language confidence label instead, same
// spirit as the "why is this the number" confidence badges elsewhere on
// this site.
function confidenceLabel(effectiveGamesPlayed) {
  if (effectiveGamesPlayed < 2) return 'Low confidence (early season)';
  if (effectiveGamesPlayed < 5) return 'Medium confidence';
  return 'High confidence';
}

leagueSelect.addEventListener('change', () => loadLeagueData(leagueSelect.value));
weekSelect.addEventListener('change', render);

loadLeagues();
