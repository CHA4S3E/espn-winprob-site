// playoff-race.js
//
// Three things live on this page, in increasing order of how much they
// actually predict:
//   1. Playoff Picture    -- deterministic: real standings, real cutoff,
//                             "if the season ended today."
//   2. Next Reseed Matchups -- deterministic: for leagues that re-pair an
//      upcoming week by standings (leagues.reseed_weeks, see
//      018_reseed_weeks.sql) instead of ESPN's own fixed schedule.
//   3. Playoff Odds        -- an actual Monte Carlo simulation of the rest
//      of the season, re-applying #1 and #2's exact logic thousands of
//      times over randomly-drawn remaining results.
//
// See the disclaimer rendered at the bottom of the page for the one real
// limitation worth knowing up front: this tool doesn't pull ESPN's real
// future schedule, so any remaining week that ISN'T a standings-based
// reseed is approximated as a random opponent draw rather than the real
// matchup. For a league whose entire remaining season is reseed weeks,
// that's not an approximation at all -- it's exact.

if (!window.SUPABASE_CONFIG) {
  document.getElementById('loadingState').textContent =
    'Could not find Supabase configuration (config.js). Check that config.js is deployed alongside this page.';
  throw new Error('window.SUPABASE_CONFIG is missing -- config.js did not load or ran after this script');
}
const { url, anonKey } = window.SUPABASE_CONFIG;
const sb = window.supabase.createClient(url, anonKey);

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
  document.getElementById('content').style.display = 'none';
  document.getElementById('emptyState').style.display = 'none';
}

const leagueSelect = document.getElementById('leagueSelect');
const throughWeekInput = document.getElementById('throughWeekInput');
const simCountSelect = document.getElementById('simCountSelect');
const loadingState = document.getElementById('loadingState');
const emptyState = document.getElementById('emptyState');
const contentEl = document.getElementById('content');

let allRows = [];
let teamInfo = {};
let leaguesById = {};
let currentLeague = null; // { id, name, playoff_spots, reseed_weeks }

// ============================================================
// Duplicated verbatim from standings.js -- same cross-file-duplication
// convention every other standalone page on this site already follows
// (see standings.js's own comment on themedColor for the reasoning).
// ============================================================
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

function extractPregameWinProb(rows) {
  const result = new Map();
  for (const r of rows) {
    if (r.pregame_win_prob == null) continue;
    const key = `${r.year}|${r.week}|${r.matchup_id}|${r.team_id}`;
    result.set(key, r.pregame_win_prob);
  }
  return result;
}

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
    if (!records.has(teamId)) records.set(teamId, { wins: 0, losses: 0, ties: 0, pointsFor: 0, pointsAgainst: 0 });
    return records.get(teamId);
  }

  for (const sides of matchupGroups.values()) {
    if (sides.length !== 2) continue;
    const [a, b] = sides;
    if (!a.all_starters_done || !b.all_starters_done) continue;
    const recA = getRecord(a.team_id), recB = getRecord(b.team_id);
    recA.pointsFor += a.actual_score; recA.pointsAgainst += b.actual_score;
    recB.pointsFor += b.actual_score; recB.pointsAgainst += a.actual_score;
    if (a.actual_score > b.actual_score) { recA.wins++; recB.losses++; }
    else if (b.actual_score > a.actual_score) { recB.wins++; recA.losses++; }
    else { recA.ties++; recB.ties++; }
  }

  const standings = [];
  for (const [teamId, rec] of records) {
    const gamesPlayed = rec.wins + rec.losses + rec.ties;
    const winPct = gamesPlayed ? (rec.wins + rec.ties * 0.5) / gamesPlayed : 0;
    standings.push({
      teamId, team: teamInfoMap[teamId] || { name: 'Unknown', color: '#888' },
      wins: rec.wins, losses: rec.losses, ties: rec.ties, winPct,
      pointsFor: rec.pointsFor, pointsAgainst: rec.pointsAgainst,
    });
  }

  // Points-for tiebreaker: ESPN's most common default -- same caveat as
  // standings.js: a league with a different real tiebreaker rule could
  // misorder two teams tied on record.
  standings.sort((x, y) => y.winPct - x.winPct || y.pointsFor - x.pointsFor);
  return standings;
}

function computePowerRatings(rows, teamIds, pregameWinProbByKey, throughWeek, opts) {
  const decay = (opts && opts.decay) ?? 0.85;
  const priorK = (opts && opts.priorK) ?? 3;
  const luckLambda = (opts && opts.luckLambda) ?? 0.15;
  const DEFAULT_STDDEV = 21;

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
  const games = [];
  const finishedPairs = [];
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
  const ratingVals = [...ratings.values()];
  const meanRating = ratingVals.reduce((s, v) => s + v, 0) / (ratingVals.length || 1);
  for (const id of teamIds) ratings.set(id, ratings.get(id) - meanRating);

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

  const stdErr = new Map();
  for (const id of teamIds) {
    const n = effN.get(id) || 0;
    stdErr.set(id, n > 0 ? (DEFAULT_STDDEV * Math.SQRT2) / Math.sqrt(n) : DEFAULT_STDDEV * Math.SQRT2);
  }

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

// Same dark-mode color nudge as standings.js, duplicated for the same
// reason (standalone page, no shared module between them).
const pageTheme = document.documentElement.getAttribute('data-theme') || 'light';
function prHexToRgb(hex) {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const num = parseInt(full, 16);
  return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
}
function prRgbToHex(r, g, b) {
  return '#' + [r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
}
function prRgbToHsl(r, g, b) {
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
function prHslToRgb(h, s, l) {
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
const PR_MIN_LIGHTNESS = 0.20;
const PR_TARGET_LIGHTNESS = 0.50;
function prIsTooCloseToBlack(hex) {
  try {
    const { r, g, b } = prHexToRgb(hex);
    return prRgbToHsl(r, g, b).l < PR_MIN_LIGHTNESS;
  } catch { return false; }
}
function themedColor(hex) {
  if (pageTheme !== 'dark' || !prIsTooCloseToBlack(hex)) return hex;
  try {
    const { r, g, b } = prHexToRgb(hex);
    const { h, s } = prRgbToHsl(r, g, b);
    const { r: nr, g: ng, b: nb } = prHslToRgb(h, s, PR_TARGET_LIGHTNESS);
    return prRgbToHex(nr, ng, nb);
  } catch { return hex; }
}
function renderTeamIcon(team) {
  if (team.logoUrl) return `<img class="team-icon-img" src="${team.logoUrl}" alt="">`;
  if (team.emoji) return `<span>${team.emoji}</span>`;
  return '';
}
function getCssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// ============================================================
// Last fully-decided week -- a week only counts as "completed" when
// EVERY matchup in it has both sides all_starters_done. A week that's
// live right now (partially in) is deliberately NOT completed, so the
// simulation starts fresh there rather than treating a half-finished
// week as locked in.
// ============================================================
function lastCompletedWeek(rows) {
  const latestByKey = new Map();
  for (const r of rows) {
    const key = `${r.year}|${r.week}|${r.matchup_id}|${r.team_id}`;
    const existing = latestByKey.get(key);
    if (!existing || new Date(r.ts) > new Date(existing.ts)) latestByKey.set(key, r);
  }
  const byWeekMatchup = new Map();
  for (const r of latestByKey.values()) {
    const wKey = r.week;
    if (!byWeekMatchup.has(wKey)) byWeekMatchup.set(wKey, new Map());
    const groups = byWeekMatchup.get(wKey);
    const mKey = `${r.year}|${r.matchup_id}`;
    if (!groups.has(mKey)) groups.set(mKey, []);
    groups.get(mKey).push(r);
  }
  let last = 0;
  for (const [week, groups] of byWeekMatchup) {
    const allDone = [...groups.values()].every((sides) => sides.length === 2 && sides.every((s) => s.all_starters_done));
    if (allDone && week > last) last = week;
  }
  return last;
}

// ============================================================
// Data loading
// ============================================================
async function loadLeagues() {
  const { data, error } = await sb.from('leagues').select('id, name, playoff_spots, reseed_weeks').order('name');
  if (error) { showError('Could not load leagues', error); return; }
  if (!data.length) { showError('No leagues found', 'The leagues table returned zero rows for this Supabase project.'); return; }
  leaguesById = Object.fromEntries(data.map((l) => [l.id, l]));
  leagueSelect.innerHTML = data.map((l) => `<option value="${l.id}">${l.name}</option>`).join('');
  await loadLeagueData(data[0].id);
}

async function loadLeagueData(leagueId) {
  loadingState.style.display = 'block';
  contentEl.style.display = 'none';
  emptyState.style.display = 'none';
  currentLeague = leaguesById[leagueId];

  let teams, snapshots;
  try {
    [teams, snapshots] = await Promise.all([
      sb.from('teams').select('id, espn_team_name, team_settings(color, display_name, emoji, logo_url)').eq('league_id', leagueId).then(({ data, error }) => { if (error) throw error; return data; }),
      fetchAllRows((from, to) =>
        sb.from('snapshot_summary')
          .select('year, week, matchup_id, team_id, actual_score, all_starters_done, ts, pregame_win_prob')
          .eq('league_id', leagueId).order('ts').range(from, to)
      ),
    ]);
  } catch (err) { showError('Could not load playoff race data', err); return; }

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

  const cw = lastCompletedWeek(allRows);
  if (!cw) { loadingState.style.display = 'none'; emptyState.style.display = 'block'; return; }

  // Only reset the "simulate through week" control when the league
  // actually changes (or on first load) -- not on every re-render, so a
  // manual edit to this control survives a re-render triggered by, say,
  // the simulation-count dropdown.
  const reseedWeeks = (currentLeague && currentLeague.reseed_weeks) || [];
  throughWeekInput.min = cw + 1;
  throughWeekInput.value = reseedWeeks.length ? Math.max(...reseedWeeks) : cw + 4;

  renderAll();
}

// ============================================================
// Rendering -- Playoff Picture + Next Reseed Matchups are pure, cheap
// functions of the real standings; Playoff Odds is the one that actually
// runs the simulation, re-triggered whenever a control changes.
// ============================================================
function gamesBack(ahead, behind) {
  // Standard "games back" formula: how many more wins (or fewer losses)
  // the trailing team needs, averaged between the two routes to close it.
  return ((ahead.wins - behind.wins) + (behind.losses - ahead.losses)) / 2;
}

function renderPicture(standings, playoffSpots, isDefault) {
  const pictureTable = document.getElementById('pictureTable');
  document.getElementById('pictureSub').textContent = isDefault
    ? `If the season ended today -- top ${playoffSpots} (playoff spot count not set for this league, defaulting to half the field -- set the real number on the Settings page)`
    : `If the season ended today -- top ${playoffSpots} make it`;

  const bubbleOut = standings[playoffSpots]; // first team currently OUT, if any
  const bubbleIn = standings[playoffSpots - 1]; // last team currently IN

  const header = `
    <div class="picture-header">
      <span></span><span>Team</span>
      <span style="text-align:right">Record</span>
      <span style="text-align:right">Pct</span>
      <span style="text-align:right">GB</span>
    </div>
  `;
  const rows = standings.map((s, i) => {
    const inPlayoffs = i < playoffSpots;
    let gbHtml = '—';
    if (inPlayoffs && bubbleOut) {
      gbHtml = `<span class="in-cutoff">+${gamesBack(s, bubbleOut).toFixed(1)}</span>`;
    } else if (!inPlayoffs && bubbleIn) {
      gbHtml = `<span class="out-cutoff">${gamesBack(bubbleIn, s).toFixed(1)}</span>`;
    }
    const cutoffClass = (i === playoffSpots - 1 && standings.length > playoffSpots) ? ' cutoff-row' : '';
    return `
      <div class="picture-row${cutoffClass}" style="--team-color:${s.team.color}">
        <div class="col-rank">${i + 1}</div>
        <div class="col-team"><span class="team-name">${renderTeamIcon(s.team)}${s.team.name}</span></div>
        <div class="col-record">${s.wins}-${s.losses}${s.ties ? '-' + s.ties : ''}</div>
        <div class="col-pct">${s.winPct.toFixed(3).replace(/^0/, '')}</div>
        <div class="col-gb">${gbHtml}</div>
      </div>
    `;
  }).join('');
  pictureTable.innerHTML = header + rows;
}

function renderReseedPreview(standings, reseedWeeks, cw) {
  const section = document.getElementById('reseedSection');
  const nextReseed = reseedWeeks.filter((w) => w > cw).sort((a, b) => a - b)[0];
  if (!nextReseed) { section.style.display = 'none'; return; }
  section.style.display = 'block';
  document.getElementById('reseedNote').textContent =
    `Week ${nextReseed} re-pairs by current standings (1 vs 2, 3 vs 4, ...) instead of a normal schedule. ` +
    `This is a projection based on standings through week ${cw} -- it'll keep shifting until week ${nextReseed - 1} is final.`;

  const cards = [];
  for (let i = 0; i < standings.length; i += 2) {
    const a = standings[i], b = standings[i + 1];
    if (!b) {
      cards.push(`<div class="reseed-card"><span class="reseed-side"><span class="reseed-seed">${i + 1}</span> ${renderTeamIcon(a.team)}${a.team.name}</span><span class="reseed-vs">bye</span></div>`);
      continue;
    }
    cards.push(`
      <div class="reseed-card">
        <span class="reseed-side"><span class="reseed-seed">${i + 1}</span> ${renderTeamIcon(a.team)}${a.team.name}</span>
        <span class="reseed-vs">vs</span>
        <span class="reseed-side"><span class="reseed-seed">${i + 2}</span> ${renderTeamIcon(b.team)}${b.team.name}</span>
      </div>
    `);
  }
  document.getElementById('reseedGrid').innerHTML = cards.join('');
}

// ============================================================
// Monte Carlo simulation
// ============================================================
const SIM_SCORE_STDDEV = 21; // same per-team score stddev computePowerRatings/winProb.js already use

// Box-Muller -- doesn't need to be cryptographically random, just roughly
// normal, so the simple textbook transform is plenty here.
function sampleNormal(mu, sigma) {
  const u1 = Math.random() || 1e-9;
  const u2 = Math.random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return mu + sigma * z;
}

function simulateSeason({ teamIds, standings, ratings, leagueAvgScore, cw, throughWeek, reseedWeeks, playoffSpots, numSims }) {
  const reseedSet = new Set(reseedWeeks);
  const n = teamIds.length;

  // Each team's simulated mean score = league average, offset by its
  // current Power Rating -- already a point-margin-scale, zero-centered
  // number (see computePowerRatings). Deliberately NOT using stdErr here:
  // stdErr measures uncertainty about the RATING estimate itself, not a
  // single game's score swing, which is what sampleNormal needs below.
  const muByTeam = new Map(teamIds.map((id) => [id, leagueAvgScore + (ratings.get(id)?.rating || 0)]));

  const startRecord = new Map(standings.map((s) => [s.teamId, { wins: s.wins, losses: s.losses, ties: s.ties, pointsFor: s.pointsFor }]));
  // Any team with no standings row yet (zero games played so far) --
  // still needs to be simulable, just starting from nothing.
  for (const id of teamIds) if (!startRecord.has(id)) startRecord.set(id, { wins: 0, losses: 0, ties: 0, pointsFor: 0 });

  const seedHist = new Map(teamIds.map((id) => [id, new Array(n + 1).fill(0)])); // index 1..n
  const winsHist = new Map(teamIds.map((id) => [id, new Map()])); // final wins -> count
  const playoffCount = new Map(teamIds.map((id) => [id, 0]));

  function finalSort(recMap) {
    return teamIds.slice().sort((x, y) => {
      const rx = recMap.get(x), ry = recMap.get(y);
      const gx = rx.wins + rx.losses + rx.ties, gy = ry.wins + ry.losses + ry.ties;
      const pctX = gx ? (rx.wins + rx.ties * 0.5) / gx : 0;
      const pctY = gy ? (ry.wins + ry.ties * 0.5) / gy : 0;
      return pctY - pctX || ry.pointsFor - rx.pointsFor;
    });
  }

  for (let sim = 0; sim < numSims; sim++) {
    const rec = new Map();
    for (const [id, r] of startRecord) rec.set(id, { wins: r.wins, losses: r.losses, ties: r.ties, pointsFor: r.pointsFor });

    for (let wk = cw + 1; wk <= throughWeek; wk++) {
      let order;
      if (reseedSet.has(wk)) {
        // Weekly reseed -- re-pair by THIS simulated run's current
        // standings, not the season's real ones, since every simulated
        // season branches differently from here on.
        order = finalSort(rec);
      } else {
        // No real future schedule is pulled from ESPN by this tool yet,
        // so a normal (non-reseed) remaining week is approximated as a
        // random opponent draw -- see the on-page disclaimer.
        order = teamIds.slice();
        for (let i = order.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [order[i], order[j]] = [order[j], order[i]];
        }
      }
      for (let i = 0; i + 1 < order.length; i += 2) {
        const a = order[i], b = order[i + 1];
        const scoreA = sampleNormal(muByTeam.get(a), SIM_SCORE_STDDEV);
        const scoreB = sampleNormal(muByTeam.get(b), SIM_SCORE_STDDEV);
        const ra = rec.get(a), rb = rec.get(b);
        ra.pointsFor += scoreA; rb.pointsFor += scoreB;
        if (scoreA > scoreB) { ra.wins++; rb.losses++; }
        else if (scoreB > scoreA) { rb.wins++; ra.losses++; }
        else { ra.ties++; rb.ties++; }
      }
      // An odd team count leaves the last team in that week's order
      // sitting out as a bye, rather than crashing on an undefined partner.
    }

    const finalOrder = finalSort(rec);
    finalOrder.forEach((id, idx) => {
      const seed = idx + 1;
      seedHist.get(id)[seed]++;
      if (seed <= playoffSpots) playoffCount.set(id, playoffCount.get(id) + 1);
      const wins = rec.get(id).wins;
      const hist = winsHist.get(id);
      hist.set(wins, (hist.get(wins) || 0) + 1);
    });
  }

  const result = new Map();
  for (const id of teamIds) {
    result.set(id, {
      odds: (playoffCount.get(id) / numSims) * 100,
      seedHist: seedHist.get(id),
      winsHist: winsHist.get(id),
    });
  }
  return result;
}

function renderOdds(sim, playoffSpots, teamIds, numTeams, numSims) {
  const oddsTable = document.getElementById('oddsTable');
  const ranked = teamIds.map((id) => ({ id, team: teamInfo[id], ...sim.get(id) })).sort((a, b) => b.odds - a.odds);

  const header = `<div class="odds-header"><span></span><span>Team</span><span style="text-align:right">Playoff odds</span><span></span></div>`;
  const rows = ranked.map((r, i) => `
    <div class="odds-row" style="--team-color:${r.team.color}">
      <div class="col-rank">${i + 1}</div>
      <div class="col-team"><span class="team-name">${renderTeamIcon(r.team)}${r.team.name}</span></div>
      <div class="odds-cell">
        <span class="odds-pct">${r.odds.toFixed(1)}%</span>
        <div class="odds-bar"><div class="odds-bar-fill" style="width:${r.odds.toFixed(1)}%"></div></div>
      </div>
      <button class="magnify-btn" type="button" data-team-id="${r.id}" title="See how the simulations actually played out">🔍</button>
    </div>
  `).join('');
  oddsTable.innerHTML = header + rows;

  oddsTable.querySelectorAll('.magnify-btn').forEach((btn) => {
    btn.addEventListener('click', () => openModal(btn.dataset.teamId, sim.get(btn.dataset.teamId), playoffSpots, numTeams, numSims));
  });
}

function buildDisclaimer(playoffSpotsIsDefault, playoffSpots, reseedWeeks, throughWeek, cw) {
  const bits = [];
  bits.push(`Playoff odds are a simulation, not an official number: each remaining game is drawn from each team's current Power Rating (see Standings), so it won't match reality exactly.`);
  if (reseedWeeks.length) {
    bits.push(`Week${reseedWeeks.length > 1 ? 's' : ''} ${reseedWeeks.join(', ')} ${reseedWeeks.length > 1 ? 'are' : 'is'} simulated as standings-based reseed${reseedWeeks.length > 1 ? 's' : ''} (1 vs 2, 3 vs 4, ...), re-applied fresh in every simulated season.`);
  }
  bits.push(`Any other remaining week is simulated against a randomly-drawn opponent each run, since this tool doesn't pull ESPN's real future schedule yet -- so odds for a league with normal (non-reseed) remaining weeks are an approximation, not exact.`);
  if (playoffSpotsIsDefault) bits.push(`This league hasn't set its real playoff spot count yet -- set it on the Settings page for an accurate cutoff.`);
  bits.push(`Simulated through week ${throughWeek}, starting from week ${cw}'s real standings.`);
  return bits.join(' ');
}

// ============================================================
// Magnifying-glass modal -- shows what the simulation actually produced
// for one team, rather than handing over just the one summary percent.
// ============================================================
let chartInstances = { seed: null, wins: null };

function buildSeedChart(teamSim, playoffSpots, numTeams, numSims) {
  const labels = Array.from({ length: numTeams }, (_, i) => `${i + 1}`);
  const data = labels.map((_, i) => ((teamSim.seedHist[i + 1] || 0) / numSims) * 100);
  const winColor = getCssVar('--win') || '#2e8b57';
  const mutedColor = getCssVar('--muted') || '#888888';
  const colors = labels.map((_, i) => (i + 1 <= playoffSpots ? winColor : mutedColor));
  if (chartInstances.seed) chartInstances.seed.destroy();
  chartInstances.seed = new Chart(document.getElementById('seedChart'), {
    type: 'bar',
    data: { labels, datasets: [{ data, backgroundColor: colors, borderRadius: 4 }] },
    options: {
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx) => `${ctx.parsed.y.toFixed(1)}% of simulations` } } },
      scales: { x: { title: { display: true, text: 'Final seed' } }, y: { ticks: { callback: (v) => v + '%' } } },
    },
  });
}

function buildWinsChart(teamSim, numSims) {
  const keys = [...teamSim.winsHist.keys()];
  const minW = keys.length ? Math.min(...keys) : 0;
  const maxW = keys.length ? Math.max(...keys) : 0;
  const labels = [];
  const data = [];
  for (let w = minW; w <= maxW; w++) { labels.push(String(w)); data.push(((teamSim.winsHist.get(w) || 0) / numSims) * 100); }
  const accentColor = getCssVar('--accent') || '#1a3fa0';
  if (chartInstances.wins) chartInstances.wins.destroy();
  chartInstances.wins = new Chart(document.getElementById('winsChart'), {
    type: 'bar',
    data: { labels, datasets: [{ data, backgroundColor: accentColor, borderRadius: 4 }] },
    options: {
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx) => `${ctx.parsed.y.toFixed(1)}% of simulations` } } },
      scales: { x: { title: { display: true, text: 'Final wins' } }, y: { ticks: { callback: (v) => v + '%' } } },
    },
  });
}

function openModal(teamId, teamSim, playoffSpots, numTeams, numSims) {
  document.getElementById('modalTitle').textContent = teamInfo[teamId].name;

  const modeWins = [...teamSim.winsHist.entries()].sort((a, b) => b[1] - a[1])[0];
  const modeWinsPct = modeWins ? (modeWins[1] / numSims) * 100 : 0;
  document.getElementById('modalStats').innerHTML = `
    <div class="modal-stat"><b>${teamSim.odds.toFixed(1)}%</b>made the playoffs</div>
    <div class="modal-stat"><b>${modeWins ? modeWins[0] + ' wins' : '—'}</b>most common final total${modeWins ? ` (${modeWinsPct.toFixed(0)}% of sims)` : ''}</div>
  `;

  buildSeedChart(teamSim, playoffSpots, numTeams, numSims);
  buildWinsChart(teamSim, numSims);

  document.getElementById('modalOverlay').hidden = false;
}

document.getElementById('modalClose').addEventListener('click', () => { document.getElementById('modalOverlay').hidden = true; });
document.getElementById('modalOverlay').addEventListener('click', (e) => {
  if (e.target.id === 'modalOverlay') document.getElementById('modalOverlay').hidden = true;
});

// ============================================================
// Top-level render -- recomputes everything from allRows/currentLeague
// plus whatever the controls currently say. Re-running the whole
// simulation on every control change is cheap enough (a few thousand
// simulations of a dozen-team, single-digit-week season is well under a
// second of plain JS) that there's no need to cache or debounce it.
// ============================================================
function renderAll() {
  loadingState.style.display = 'none';
  const teamIds = Object.keys(teamInfo);
  const cw = lastCompletedWeek(allRows);
  if (!cw) { contentEl.style.display = 'none'; emptyState.style.display = 'block'; return; }

  const standings = computeStandings(allRows, teamInfo, cw);
  if (!standings.length) { contentEl.style.display = 'none'; emptyState.style.display = 'block'; return; }

  emptyState.style.display = 'none';
  contentEl.style.display = 'block';
  document.getElementById('subtext').textContent = `Through week ${cw}`;

  const reseedWeeks = (currentLeague && currentLeague.reseed_weeks) || [];
  const rawPlayoffSpots = currentLeague && currentLeague.playoff_spots;
  const playoffSpotsIsDefault = rawPlayoffSpots == null;
  const playoffSpots = playoffSpotsIsDefault ? Math.max(1, Math.floor(teamIds.length / 2)) : rawPlayoffSpots;

  renderPicture(standings, playoffSpots, playoffSpotsIsDefault);
  renderReseedPreview(standings, reseedWeeks, cw);

  const throughWeek = Math.max(cw + 1, Number(throughWeekInput.value) || (reseedWeeks.length ? Math.max(...reseedWeeks) : cw + 4));
  const numSims = Number(simCountSelect.value) || 5000;

  const pregameMap = extractPregameWinProb(allRows);
  const ratings = computePowerRatings(allRows, teamIds, pregameMap, cw);
  const totalGames = standings.reduce((s, t) => s + t.wins + t.losses + t.ties, 0);
  const totalPoints = standings.reduce((s, t) => s + t.pointsFor, 0);
  const leagueAvgScore = totalGames ? totalPoints / totalGames : 110; // 110 is a reasonable generic fallback before any games exist

  const sim = simulateSeason({ teamIds, standings, ratings, leagueAvgScore, cw, throughWeek, reseedWeeks, playoffSpots, numSims });
  renderOdds(sim, playoffSpots, teamIds, teamIds.length, numSims);

  document.getElementById('disclaimerText').innerHTML = buildDisclaimer(playoffSpotsIsDefault, playoffSpots, reseedWeeks, throughWeek, cw);
}

leagueSelect.addEventListener('change', () => loadLeagueData(leagueSelect.value));
throughWeekInput.addEventListener('change', renderAll);
simCountSelect.addEventListener('change', renderAll);

loadLeagues();
