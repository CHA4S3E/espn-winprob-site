// outlook.js -- Season Outlook page (replaces Playoff Race).
//
// The first block below (config, paging, Power Ratings, standings, color
// helpers, lastCompletedWeek) is duplicated from playoff-race.js / standings.js,
// the same cross-file-duplication convention every standalone page on this
// site follows. Everything after it is new.

if (!window.SUPABASE_CONFIG) {
  document.getElementById('loadingState').textContent =
    'Could not find Supabase configuration (config.js). Check that config.js is deployed alongside this page.';
  throw new Error('window.SUPABASE_CONFIG is missing -- config.js did not load or ran after this script');
}
const { url, anonKey } = window.SUPABASE_CONFIG;
const sb = window.supabase.createClient(url, anonKey);

const PAGE_SIZE = 1000;
async function fetchAllRows(buildQuery) {
  // First page alone, then further pages in parallel batches.
  const first = await buildQuery(0, PAGE_SIZE - 1);
  if (first.error) throw first.error;
  let all = first.data || [];
  if (all.length < PAGE_SIZE) return all;
  const BATCH = 4;
  let page = 1;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const results = await Promise.all(
      Array.from({ length: BATCH }, (_, i) => {
        const from = (page + i) * PAGE_SIZE;
        return buildQuery(from, from + PAGE_SIZE - 1);
      })
    );
    let done = false;
    for (const { data, error } of results) {
      if (error) throw error;
      all = all.concat(data || []);
      if (!data || data.length < PAGE_SIZE) { done = true; break; }
    }
    if (done) break;
    page += BATCH;
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

// computeStandings only ever returns a row for a team that has at least
// one FINISHED matchup -- fine for the main Standings page (nothing to
// show for a team with zero games), but wrong here: the Playoff Picture,
// Next Reseed Matchups, and the simulation all need every real team in
// the league, including one that joined late or simply hasn't finished a
// game yet this season, starting from a 0-0 record rather than being
// silently left off entirely (which is exactly what made the Playoff
// Picture look "incomplete" -- a missing team isn't just missing from the
// picture, it also throws off reseed pairing counts and the simulation's
// own field size).
function fillMissingTeams(standings, teamIds, teamInfoMap) {
  const present = new Set(standings.map((s) => s.teamId));
  const missing = teamIds.filter((id) => !present.has(id));
  const combined = standings.concat(missing.map((id) => ({
    teamId: id, team: teamInfoMap[id] || { name: 'Unknown', color: '#888' },
    wins: 0, losses: 0, ties: 0, winPct: 0, pointsFor: 0, pointsAgainst: 0,
  })));
  combined.sort((x, y) => y.winPct - x.winPct || y.pointsFor - x.pointsFor);
  return combined;
}

function computePowerRatings(rows, teamIds, pregameWinProbByKey, throughWeek, opts) {
  // ----------------------------------------------------------------------
  // Power Rating v2. Replaces the old opponent-adjusted margin (SRS) +
  // z-score version, which swung ~12 points a week on average. Tested
  // against thousands of simulated seasons where each team's true strength
  // was known: this version moves ~2-3 points a week and ranks teams
  // measurably more accurately. Why the old one was jumpy:
  //   1. Margins include the OPPONENT's score. In fantasy your score doesn't
  //      depend on who you face, so adjusting for opponents only imported
  //      their noise -- roughly doubling the noise per game.
  //   2. The 0-100 score was a z-score against the league's CURRENT spread.
  //      Early in a season ratings are tightly bunched, so dividing by that
  //      tiny spread blew small gaps up into 1-vs-99 scores, and one team's
  //      week re-scaled everyone. It also silently cancelled the shrinkage
  //      toward average (shrinking every team equally is undone by
  //      re-standardizing), so the "prior" never actually calmed anything.
  // What this does instead:
  //   * Performance per game blends the ACTUAL score with the team's
  //     PREGAME PROJECTION (calibrated league-wide to the actual-score
  //     scale). A projection reflects roster strength and injuries without
  //     one week's luck, so it's far less noisy than a single score.
  //   * Each team's rating = recency-weighted average performance minus the
  //     league average, shrunk toward 0 by n/(n+priorK) -- now meaningful,
  //     because the score below is on a fixed scale.
  //   * ~85% of the rating is that predictive strength; ~15% is a
  //     "resume" term from actual win% (also shrunk), so winning counts a
  //     little even where the underlying numbers say it shouldn't.
  //   * Power Score = 100 * normalCdf(rating / scale), a FIXED scale (+12
  //     points of rating = ~84), so a team's score only moves when ITS
  //     numbers move, not because the rest of the league shifted.
  // Same return shape as before: Map teamId -> { score, rating, stdErr, gamesPlayed }.
  // ----------------------------------------------------------------------
  const o = opts || {};
  const decay = o.decay ?? 0.93;        // per-week memory; gentle recency
  const priorK = o.priorK ?? 5;         // effective games of "prior" pulling toward average
  const projWeight = o.projWeight ?? 0.6; // share of a game's signal taken from the pregame projection
  const resumeShare = o.resumeShare ?? 0.15;
  const resumeK = o.resumeK ?? 4;
  const resumePts = o.resumePts ?? 30;  // rating points a 100% vs 0% win rate would span
  const scale = o.scale ?? 12;
  const SD = 21;                        // per-team weekly score stddev, same as winProb.js

  // Latest row per matchup-team (final state) AND earliest row (the
  // pregame projection), unless the summary view already supplies it.
  const byKey = new Map();
  for (const r of rows) {
    if (throughWeek != null && r.week > throughWeek) continue;
    const key = `${r.year}|${r.week}|${r.matchup_id}|${r.team_id}`;
    const e = byKey.get(key);
    if (!e) { byKey.set(key, { latest: r, earliest: r }); continue; }
    if (new Date(r.ts) > new Date(e.latest.ts)) e.latest = r;
    if (new Date(r.ts) < new Date(e.earliest.ts)) e.earliest = r;
  }
  const matchupGroups = new Map();
  for (const e of byKey.values()) {
    const mKey = `${e.latest.year}|${e.latest.week}|${e.latest.matchup_id}`;
    if (!matchupGroups.has(mKey)) matchupGroups.set(mKey, []);
    matchupGroups.get(mKey).push(e);
  }

  const maxSeenWeek = throughWeek != null ? throughWeek : rows.reduce((m, r) => Math.max(m, r.week), 0);
  const sidesList = []; // one entry per finished team-game
  for (const group of matchupGroups.values()) {
    if (group.length !== 2) continue;
    const [a, b] = group;
    if (!a.latest.all_starters_done || !b.latest.all_starters_done) continue;
    const weight = Math.pow(decay, Math.max(0, maxSeenWeek - a.latest.week));
    for (const [me, opp] of [[a, b], [b, a]]) {
      const proj = me.latest.pregame_expected_score != null ? me.latest.pregame_expected_score : me.earliest.expected_score;
      const actual = me.latest.actual_score;
      const diff = actual - opp.latest.actual_score;
      sidesList.push({ team: me.latest.team_id, weight, actual, proj: proj != null ? Number(proj) : null, result: diff > 0 ? 1 : diff < 0 ? 0 : 0.5 });
    }
  }

  const result = new Map();
  if (!sidesList.length) {
    for (const id of teamIds) result.set(id, { score: 50, rating: 0, stdErr: SD, gamesPlayed: 0 });
    return result;
  }

  // Calibrate projections to the actual-score scale (a league-wide offset).
  let biasSum = 0, biasN = 0;
  for (const s of sidesList) if (s.proj != null) { biasSum += s.actual - s.proj; biasN++; }
  const bias = biasN ? biasSum / biasN : 0;

  const acc = new Map(teamIds.map((id) => [id, { n: 0, x: 0, w: 0 }]));
  let totN = 0, totX = 0;
  for (const s of sidesList) {
    const x = s.proj != null ? projWeight * (s.proj + bias) + (1 - projWeight) * s.actual : s.actual;
    totN += s.weight; totX += s.weight * x;
    const e = acc.get(s.team);
    if (!e) continue;
    e.n += s.weight; e.x += s.weight * x; e.w += s.weight * s.result;
  }
  const leagueMean = totX / totN;

  for (const id of teamIds) {
    const e = acc.get(id);
    const n = e.n;
    const predictive = n ? (n / (n + priorK)) * (e.x / n - leagueMean) : 0;
    const resume = n ? (n / (n + resumeK)) * (e.w / n - 0.5) * resumePts : 0;
    const rating = (1 - resumeShare) * predictive + resumeShare * resume;
    result.set(id, { score: 100 * normalCdf(rating / scale), rating, stdErr: SD / Math.sqrt(n + priorK), gamesPlayed: n });
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
const simCountSelect = document.getElementById('simCountSelect');

// ============================================================
// Season Outlook -- everything below is new to this page.
//
// What it answers, per team, as of any chosen week: how likely is each
// playoff outcome (make it, bye, semis, final, title), what record is it
// projected to finish with, and how does each remaining game look.
//
// How the odds are built (see simulateOutlook):
//   * Team strength = the SAME Power Rating Standings shows
//     (computePowerRatings, solved using only games through the chosen
//     week), blended with each team's last three scores so a team that's
//     heating up or cooling off moves the odds more than a season-long
//     average alone would.
//   * Remaining games use the REAL schedule when we have it (saved by the
//     poller into the `schedule` table -- migration 020). Standings-based
//     reseed weeks are re-paired inside every simulated season, exactly as
//     the old Playoff Race page did. Anything we still can't pair falls
//     back to a random opponent and is flagged on the page.
//   * Thousands of simulated seasons, then the playoff bracket itself is
//     simulated (byes for the top seeds, reseeding each round).
//   * "As of week X" recomputes all of that using only what was known after
//     week X -- nothing is stored, so improving the method later also
//     improves the old weeks.
// ============================================================
const REG_SEASON_END_DEFAULT_BASE = 17; // last fantasy week; the bracket's rounds count back from it
const SCORE_SD = 21;
const COLS_ALL = [
  ['playoffs', 'Make<br>Playoffs'], ['bye', '1st-Round<br>Bye'], ['semis', 'Make<br>Semis'],
  ['final', 'Make<br>Final'], ['title', 'Win<br>Title'],
];

const asOfSlider = document.getElementById('asOfSlider');
const asOfLabel = document.getElementById('asOfLabel');
const playBtn = document.getElementById('playBtn');
const regEndInput = document.getElementById('regEndInput');
const boardEl = document.getElementById('board');
const subtextEl = document.getElementById('subtext');
const noteEl = document.getElementById('note');

let scheduleRows = [];   // [{week, home_team_id, away_team_id}] for the current year
let state = {            // everything that doesn't change with the week slider
  teamIds: [], cw: 0, playoffSpots: 6, reseedWeeks: [], regEnd: 14, bracket: null,
  pregameMap: new Map(), pairingsByWeek: new Map(), scheduleWeeks: new Set(),
};
let asOfWeek = 1, sortKey = 'power';
const openTeams = new Set();
const outlookCache = new Map(); // `${week}|${sims}` -> results

function nextPow2(n) { let p = 1; while (p < n) p *= 2; return p; }
function seededMean(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }

// ---------- data ----------
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
  outlookCache.clear();

  // Outlook only changes when a week FINISHES, so the heavy download (the
  // whole season's game summary + schedule) is cached in this browser and
  // only repeated once the next week is completely final. Between those
  // moments a visit costs one tiny check (a dozen rows) plus the team list.
  const CACHE_KEY = `winProbOutlookCache:v1:${leagueId}`;
  const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // self-heal: never trust a cache older than a week
  const SUMMARY_COLS = 'year, week, matchup_id, team_id, is_home, actual_score, all_starters_done, ts, pregame_win_prob, pregame_expected_score';
  let cache = null;
  try { cache = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'); } catch { cache = null; }
  if (cache && !(cache.rows && cache.rows.length && cache.year && cache.cw != null && Date.now() - cache.savedAt < CACHE_MAX_AGE_MS)) cache = null;
  // No saved schedule yet (migration pending / poller hasn't filled it) --
  // keep re-checking rather than freezing the "approximated" state.
  if (cache && !(cache.schedule && cache.schedule.length)) cache = null;

  const teamsPromise = sb.from('teams').select('id, espn_team_name, team_settings(color, display_name, emoji, logo_url)').eq('league_id', leagueId).then(({ data, error }) => { if (error) throw error; return data; });

  let teams, snapshots, schedule;
  let usedCache = false;
  try {
    if (cache) {
      // Has the NEXT week finished since we cached? Only that week's rows (~12) are looked at.
      const { data: nextRows, error: nextErr } = await sb.from('snapshot_summary')
        .select('matchup_id, team_id, all_starters_done, ts')
        .eq('league_id', leagueId).eq('year', cache.year).eq('week', cache.cw + 1);
      if (!nextErr) {
        const latest = new Map();
        for (const r of nextRows || []) {
          const k = `${r.matchup_id}|${r.team_id}`;
          if (!latest.has(k) || r.ts > latest.get(k).ts) latest.set(k, r);
        }
        const nextWeekFinal = latest.size > 0 && [...latest.values()].every((r) => r.all_starters_done);
        // Also catches a brand-new season (cache.year no longer the newest).
        const { data: newest } = await sb.from('snapshot_summary').select('year').eq('league_id', leagueId).order('year', { ascending: false }).limit(1);
        const newerYear = newest && newest[0] && newest[0].year > cache.year;
        if (!nextWeekFinal && !newerYear) {
          teams = await teamsPromise;
          snapshots = cache.rows;
          schedule = cache.schedule;
          usedCache = true;
        }
      }
    }
    if (!usedCache) {
      // Newest season only: older seasons are never used on this page.
      const { data: yr, error: yrErr } = await sb.from('snapshot_summary').select('year').eq('league_id', leagueId).order('year', { ascending: false }).limit(1);
      if (yrErr) throw yrErr;
      const newestYear = yr && yr[0] ? yr[0].year : null;
      [teams, snapshots, schedule] = await Promise.all([
        teamsPromise,
        newestYear == null ? Promise.resolve([]) : fetchAllRows((from, to) =>
          sb.from('snapshot_summary').select(SUMMARY_COLS)
            .eq('league_id', leagueId).eq('year', newestYear).order('ts').range(from, to)
        ),
        // Missing table (migration not run yet) or no rows yet is fine -- the
        // page falls back to approximating, and says so.
        fetchAllRows((from, to) => sb.from('schedule').select('year, week, home_team_id, away_team_id').eq('league_id', leagueId).eq('year', newestYear ?? 0).range(from, to))
          .catch((err) => { console.warn('schedule table not available yet:', err.message || err); return []; }),
      ]);
    }
  } catch (err) { showError('Could not load outlook data', err); return; }

  teamInfo = {};
  for (const t of teams) {
    const s = t.team_settings || {};
    teamInfo[t.id] = { name: s.display_name || t.espn_team_name, color: themedColor(s.color || '#888888'), emoji: s.emoji || '', logoUrl: s.logo_url || '' };
  }

  // Everything below is scoped to the NEWEST season in the data -- the
  // other pages key by week number only, which merges seasons together;
  // an outlook for THIS season has to ignore last year's weeks.
  const latestYear = snapshots.reduce((m, r) => Math.max(m, r.year), 0);
  allRows = snapshots.filter((r) => r.year === latestYear);
  scheduleRows = schedule.filter((r) => r.year === latestYear);

  const teamIds = Object.keys(teamInfo);
  const cw = lastCompletedWeek(allRows);
  if (!cw || !teamIds.length) { loadingState.style.display = 'none'; emptyState.style.display = 'block'; return; }
  if (!usedCache && allRows.length) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ year: latestYear, cw, savedAt: Date.now(), rows: allRows, schedule: scheduleRows }));
    } catch { /* storage full/unavailable -- just means no caching */ }
  }

  const rawSpots = currentLeague && currentLeague.playoff_spots;
  const playoffSpots = rawSpots == null ? Math.max(1, Math.floor(teamIds.length / 2)) : rawSpots;
  const size = nextPow2(Math.max(2, playoffSpots));
  const rounds = Math.round(Math.log2(size));
  const reseedWeeks = (currentLeague && currentLeague.reseed_weeks) || [];

  // Real pairings per week, preferring what actually happened/was posted:
  // matchups already in snapshots, then the saved schedule.
  const pairingsByWeek = new Map();
  const groups = new Map();
  for (const r of allRows) {
    const k = `${r.week}|${r.matchup_id}`;
    if (!groups.has(k)) groups.set(k, new Map());
    groups.get(k).set(r.team_id, r);
  }
  for (const [k, sides] of groups) {
    if (sides.size !== 2) continue;
    const wk = Number(k.split('|')[0]);
    if (!pairingsByWeek.has(wk)) pairingsByWeek.set(wk, []);
    pairingsByWeek.get(wk).push([...sides.keys()]);
  }
  const scheduleWeeks = new Set();
  for (const r of scheduleRows) {
    if (pairingsByWeek.has(r.week) && !scheduleWeeks.has(r.week)) continue; // snapshots win
    if (!pairingsByWeek.has(r.week)) pairingsByWeek.set(r.week, []);
    pairingsByWeek.get(r.week).push([r.home_team_id, r.away_team_id]);
    scheduleWeeks.add(r.week);
  }

  state = {
    teamIds, cw, playoffSpots, rawSpotsMissing: rawSpots == null, reseedWeeks, size, byes: size - playoffSpots,
    regEnd: Math.max(cw, REG_SEASON_END_DEFAULT_BASE - rounds),
    pregameMap: extractPregameWinProb(allRows), pairingsByWeek, scheduleWeeks,
    usedRealSchedule: scheduleRows.length > 0,
  };
  regEndInput.value = state.regEnd;
  regEndInput.min = cw;
  asOfSlider.min = 1; asOfSlider.max = cw;
  asOfWeek = cw; asOfSlider.value = cw;
  openTeams.clear();
  loadingState.style.display = 'none';
  emptyState.style.display = 'none';
  contentEl.style.display = 'block';
  render(true);
}

// ---------- odds engine ----------
function sampleNormalFast(mu, sd) {
  const u1 = Math.random() || 1e-9, u2 = Math.random();
  return mu + sd * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}
const winProbFromMu = (mi, mj) => normalCdf((mi - mj) / (SCORE_SD * Math.SQRT2));

// Per-team expected score as of week W: league average, offset by the
// Power Rating (point-margin scale, zero-centered) blended with recent form.
function strengthAsOf(W) {
  const teamIds = state.teamIds;
  const ratings = computePowerRatings(allRows, teamIds, state.pregameMap, W);
  const standings = fillMissingTeams(computeStandings(allRows, teamInfo, W), teamIds, teamInfo);
  const totalGames = standings.reduce((s, t) => s + t.wins + t.losses + t.ties, 0);
  const lg = totalGames ? standings.reduce((s, t) => s + t.pointsFor, 0) / totalGames : 110;

  // Last-three-finished-scores per team (newest weighted most).
  const scoresByTeam = new Map(teamIds.map((id) => [id, []]));
  const latest = new Map();
  for (const r of allRows) {
    if (r.week > W || !r.all_starters_done) continue;
    const key = `${r.week}|${r.matchup_id}|${r.team_id}`;
    const ex = latest.get(key);
    if (!ex || new Date(r.ts) > new Date(ex.ts)) latest.set(key, r);
  }
  [...latest.values()].sort((a, b) => a.week - b.week).forEach((r) => { if (scoresByTeam.has(r.team_id)) scoresByTeam.get(r.team_id).push(r.actual_score); });
  const mix = Math.min(0.4, 0.15 + W * 0.03); // share given to recent form grows as there's more of it
  const mu = new Map();
  for (const id of teamIds) {
    const last = scoresByTeam.get(id).slice(-3);
    let recentDev = 0;
    if (last.length) { let ws = 0, s = 0; last.forEach((v, j) => { ws += j + 1; s += (j + 1) * v; }); recentDev = s / ws - lg; }
    const power = ratings.get(id)?.rating || 0;
    mu.set(id, lg + (1 - mix) * power + mix * recentDev);
  }
  return { ratings, standings, mu, lg };
}

function simulateOutlook(W, numSims) {
  const key = `${W}|${numSims}`;
  if (outlookCache.has(key)) return outlookCache.get(key);
  const { teamIds, regEnd, playoffSpots, reseedWeeks, size, byes, pairingsByWeek } = state;
  const reseedSet = new Set(reseedWeeks);
  const { ratings, standings, mu } = strengthAsOf(W);
  const start = new Map(standings.map((s) => [s.teamId, { w: s.wins, l: s.losses, t: s.ties, pf: s.pointsFor }]));
  const stats = new Map(teamIds.map((id) => [id, { playoffs: 0, bye: 0, semis: 0, final: 0, title: 0, winSum: 0, wins: new Map(), gamesLeft: 0 }]));
  const approxWeeks = new Set();

  function sortRec(rec) {
    return teamIds.slice().sort((x, y) => {
      const a = rec.get(x), b = rec.get(y);
      const ga = a.w + a.l + a.t, gb = b.w + b.l + b.t;
      const pa = ga ? (a.w + a.t / 2) / ga : 0, pb = gb ? (b.w + b.t / 2) / gb : 0;
      return pb - pa || b.pf - a.pf;
    });
  }
  const game = (a, b, rec) => {
    const sa = sampleNormalFast(mu.get(a), SCORE_SD), sb2 = sampleNormalFast(mu.get(b), SCORE_SD);
    const ra = rec.get(a), rb = rec.get(b);
    ra.pf += sa; rb.pf += sb2;
    if (sa > sb2) { ra.w++; rb.l++; } else if (sb2 > sa) { rb.w++; ra.l++; } else { ra.t++; rb.t++; }
  };
  const knockout = (a, b) => (sampleNormalFast(mu.get(a), SCORE_SD) >= sampleNormalFast(mu.get(b), SCORE_SD) ? a : b);

  for (let sim = 0; sim < numSims; sim++) {
    const rec = new Map();
    for (const [id, r] of start) rec.set(id, { ...r });
    for (let wk = W + 1; wk <= regEnd; wk++) {
      let pairs;
      if (reseedSet.has(wk)) {
        const order = sortRec(rec); pairs = [];
        for (let i = 0; i + 1 < order.length; i += 2) pairs.push([order[i], order[i + 1]]);
      } else if (pairingsByWeek.has(wk)) {
        pairs = pairingsByWeek.get(wk);
      } else {
        approxWeeks.add(wk);
        const order = teamIds.slice();
        for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
        pairs = [];
        for (let i = 0; i + 1 < order.length; i += 2) pairs.push([order[i], order[i + 1]]);
      }
      for (const [a, b] of pairs) { game(a, b, rec); if (sim === 0) { stats.get(a).gamesLeft++; stats.get(b).gamesLeft++; } }
    }
    const order = sortRec(rec);
    order.forEach((id) => { const s = stats.get(id); s.winSum += rec.get(id).w; const wm = s.wins; wm.set(rec.get(id).w, (wm.get(rec.get(id).w) || 0) + 1); });

    // ---- bracket ----
    const seeds = order.slice(0, playoffSpots);
    seeds.forEach((id) => stats.get(id).playoffs++);
    seeds.slice(0, byes).forEach((id) => stats.get(id).bye++);
    const seedOf = new Map(seeds.map((id, i) => [id, i]));
    let alive = seeds.slice();
    let semisMarked = false;
    let firstRound = true;
    while (alive.length > 1) {
      if (!semisMarked && alive.length <= 4) { alive.forEach((id) => stats.get(id).semis++); semisMarked = true; }
      if (alive.length <= 2) alive.forEach((id) => stats.get(id).final++);
      const byeTeams = firstRound ? alive.slice(0, byes) : [];
      const playing = firstRound ? alive.slice(byes) : alive;
      const winners = [];
      for (let i = 0, j = playing.length - 1; i < j; i++, j--) winners.push(knockout(playing[i], playing[j]));
      if (playing.length % 2 === 1) winners.push(playing[Math.floor(playing.length / 2)]); // odd field: middle seed advances
      alive = byeTeams.concat(winners).sort((x, y) => seedOf.get(x) - seedOf.get(y));
      firstRound = false;
    }
    stats.get(alive[0]).title++;
  }

  const result = new Map();
  const power = new Map(teamIds.map((id) => [id, ratings.get(id)?.score ?? 50]));
  for (const id of teamIds) {
    const s = stats.get(id), cur = start.get(id);
    result.set(id, {
      id, mu: mu.get(id), power: power.get(id), cur,
      playoffs: s.playoffs / numSims, bye: s.bye / numSims, semis: s.semis / numSims, final: s.final / numSims, title: s.title / numSims,
      exp: s.winSum / numSims, gamesLeft: s.gamesLeft,
      dist: s.wins, numSims,
    });
  }
  result.approxWeeks = [...approxWeeks].sort((a, b) => a - b);
  outlookCache.set(key, result);
  return result;
}

// ---------- rendering ----------
const pct = (p) => (p < 0.005 ? '<1%' : p > 0.995 ? '>99%' : Math.round(p * 100) + '%');
function activeCols() {
  const { byes, size, playoffSpots } = state;
  return COLS_ALL.filter(([k]) => (k !== 'bye' || byes > 0) && (k !== 'semis' || size > 4 || playoffSpots > 4));
}
function numSims() { return Number(simCountSelect.value) || 3000; }

function render(animate) {
  const sims = numSims();
  const W = asOfWeek;
  const cur = simulateOutlook(W, sims);
  const prev = W > 1 ? simulateOutlook(W - 1, sims) : null;
  const cols = activeCols();
  const gridCols = `34px 74px minmax(170px,1fr) 62px 62px repeat(${cols.length}, 74px)`;
  const rows = state.teamIds.map((id) => cur.get(id)).sort((a, b) => b[sortKey] - a[sortKey]);

  const head = `<div class="head" style="grid-template-columns:${gridCols}"><div class="gap"></div>
    <div data-k="power" class="${sortKey === 'power' ? 'sorted' : ''}">Power<br>Score ${sortKey === 'power' ? '↓' : ''}</div>
    <div class="teamh gap">Team</div><div class="gap">Current<br>Record</div><div class="gap">Projected<br>Record</div>
    ${cols.map(([k, l]) => `<div class="cellh ${sortKey === k ? 'sorted' : ''}" data-k="${k}">${l} ${sortKey === k ? '↓' : ''}</div>`).join('')}</div>`;
  const body = rows.map((x) => {
    const team = teamInfo[x.id] || { name: 'Unknown', color: '#888', emoji: '', logoUrl: '' };
    const p = prev ? prev.get(x.id) : null;
    const dPow = p ? x.power - p.power : 0;
    const gamesPlayed = x.cur.w + x.cur.l + x.cur.t;
    const projW = Math.round(x.exp), totalG = gamesPlayed + x.gamesLeft;
    const cells = cols.map(([k]) => {
      const d = p ? Math.round((x[k] - p[k]) * 100) : 0;
      const heat = Math.min(0.95, 0.04 + x[k] * 0.9).toFixed(2);
      return `<div class="cell ${k === 'title' ? 'title' : ''} ${x[k] > 0.7 ? 'hot' : ''}" style="--heat:${heat}"><span data-v="${x[k]}">${pct(x[k])}</span>${Math.abs(d) >= 3 ? `<em class="d">${d > 0 ? '▲' : '▼'}${Math.abs(d)}</em>` : ''}</div>`;
    }).join('');
    return `<div class="item ${openTeams.has(x.id) ? 'open' : ''}" data-id="${x.id}" style="--tc:${team.color}">
      <div class="row" style="grid-template-columns:${gridCols}"><div class="chev">▶</div>
        <div class="rating">${x.power.toFixed(1)}${Math.abs(dPow) >= 0.05 ? `<small class="${dPow > 0 ? 'up' : 'down'}">${dPow > 0 ? '▲' : '▼'}${Math.abs(dPow).toFixed(1)}</small>` : ''}</div>
        <div class="team"><div class="logo">${team.logoUrl ? `<img src="${team.logoUrl}" alt="">` : (team.emoji || '')}</div><div class="tn"><b>${team.name}</b></div></div>
        <div class="rec">${x.cur.w}-${x.cur.l}${x.cur.t ? '-' + x.cur.t : ''}</div><div class="rec proj">${projW}-${Math.max(0, totalG - projW)}</div>${cells}</div>
      <div class="panel" data-panel></div></div>`;
  }).join('');
  boardEl.innerHTML = head + body;

  asOfLabel.textContent = `As of week ${W}`;
  asOfSlider.value = W;
  const left = state.regEnd - W;
  subtextEl.textContent = left > 0
    ? `Odds for the ${left} remaining regular-season ${left === 1 ? 'week' : 'weeks'} and the playoff bracket, using only what was known after week ${W}`
    : 'Final regular-season picture';

  const approx = cur.approxWeeks;
  const bits = [];
  bits.push(`Top ${state.playoffSpots} make the playoffs${state.byes ? `, top ${state.byes} get a first-round bye` : ''}${state.rawSpotsMissing ? ' (playoff spots not set for this league -- assuming half the league)' : ''}. Team strength is the Power Rating from Standings, blended with each team's last three scores; ${sims.toLocaleString()} simulated seasons per week.`);
  if (state.reseedWeeks.length) bits.push(`Week${state.reseedWeeks.length > 1 ? 's' : ''} ${state.reseedWeeks.join(', ')} ${state.reseedWeeks.length > 1 ? 'are' : 'is'} re-paired by standings inside every simulated season.`);
  if (approx.length) bits.push(`<b>Week${approx.length > 1 ? 's' : ''} ${approx.join(', ')} use${approx.length > 1 ? '' : 's'} a random-opponent approximation</b> -- the real schedule for ${approx.length > 1 ? 'those weeks hasn’t' : 'that week hasn’t'} been saved yet${state.usedRealSchedule ? '' : ' (the poller saves it on its next run once migration 020 is applied)'}.`);
  bits.push('Odds are a simulation, not a guarantee.');
  noteEl.innerHTML = bits.join(' ');

  boardEl.querySelectorAll('.head [data-k]').forEach((h) => { h.onclick = () => { sortKey = h.dataset.k === 'rating' ? 'power' : h.dataset.k; render(); }; });
  boardEl.querySelectorAll('.item .row').forEach((r) => {
    r.onclick = () => {
      const item = r.parentNode, id = item.dataset.id;
      if (openTeams.has(id)) { openTeams.delete(id); item.classList.remove('open'); return; }
      openTeams.add(id); item.classList.add('open'); fillPanel(item);
    };
  });
  boardEl.querySelectorAll('.item.open').forEach(fillPanel);
  if (animate) countUp();
}

function countUp() {
  boardEl.querySelectorAll('.cell span[data-v]').forEach((el) => {
    const to = Number(el.dataset.v), t0 = performance.now();
    const step = (t) => { const k = Math.min(1, (t - t0) / 450), e = 1 - Math.pow(1 - k, 3); el.textContent = pct(to * e); if (k < 1) requestAnimationFrame(step); else el.textContent = pct(to); };
    requestAnimationFrame(step);
  });
}

function fillPanel(item) {
  const id = item.dataset.id, W = asOfWeek, sims = numSims();
  const x = simulateOutlook(W, sims).get(id);
  const team = teamInfo[id];

  // Remaining schedule with per-game win odds
  const games = [];
  for (let wk = W + 1; wk <= state.regEnd; wk++) {
    if (state.reseedWeeks.includes(wk)) { games.push({ wk, label: 'Matched by standings (reseed week)' }); continue; }
    const pairs = state.pairingsByWeek.get(wk);
    const pair = pairs && pairs.find(([a, b]) => a === id || b === id);
    if (!pair) { games.push({ wk, label: pairs ? 'Bye' : 'Opponent not saved yet' }); continue; }
    const opp = pair[0] === id ? pair[1] : pair[0];
    const o = simulateOutlook(W, sims).get(opp);
    games.push({ wk, opp, p: winProbFromMu(x.mu, o.mu) });
  }
  const sched = games.length ? games.map((g) => g.opp
    ? `<div class="g"><span class="w">Wk ${g.wk}</span><span class="opp">${teamInfo[g.opp].emoji ? teamInfo[g.opp].emoji + ' ' : ''}${teamInfo[g.opp].name}</span><div class="bar"><i style="width:${g.p * 100}%"></i></div><span class="p">${Math.round(g.p * 100)}%</span></div>`
    : `<div class="g"><span class="w">Wk ${g.wk}</span><span class="opp muted">${g.label}</span><span></span><span></span></div>`).join('')
    : '<div class="g"><span class="opp muted">No regular-season games left.</span></div>';

  // Odds history across every as-of week (all cached after the first open)
  const weeks = []; for (let w = 1; w <= state.cw; w++) weeks.push(w);
  const po = weeks.map((w) => simulateOutlook(w, sims).get(id).playoffs);
  const ti = weeks.map((w) => simulateOutlook(w, sims).get(id).title);
  const Wd = 360, Hd = 110, n = Math.max(1, weeks.length - 1);
  const px = (i) => 10 + (i / n) * (Wd - 20), py = (v) => Hd - 8 - v * (Hd - 18);
  const line = (vals, upto) => vals.slice(0, upto).map((v, i) => `${i ? 'L' : 'M'}${px(i).toFixed(1)},${py(v).toFixed(1)}`).join(' ');
  const mk = W - 1;
  const svg = `<svg viewBox="0 0 ${Wd} ${Hd}" preserveAspectRatio="none">
    ${[0, .5, 1].map((v) => `<line x1="10" x2="${Wd - 10}" y1="${py(v)}" y2="${py(v)}" stroke="var(--border)" stroke-dasharray="2 4"/>`).join('')}
    <path d="${line(po, weeks.length)}" fill="none" stroke="${team.color}" stroke-width="1" opacity=".3" stroke-dasharray="3 4"/>
    <path d="${line(po, W)}" fill="none" stroke="${team.color}" stroke-width="2.4" stroke-linecap="round"/>
    <path d="${line(ti, W)}" fill="none" stroke="#f4c430" stroke-width="2.2" stroke-linecap="round"/>
    <line x1="${px(mk)}" x2="${px(mk)}" y1="4" y2="${Hd - 4}" stroke="var(--fg)" opacity=".35"/>
    <circle cx="${px(mk)}" cy="${py(po[mk])}" r="4" fill="${team.color}"/><circle cx="${px(mk)}" cy="${py(ti[mk])}" r="4" fill="#f4c430"/></svg>`;

  // Final regular-season wins distribution
  const centre = Math.round(x.exp), lo = Math.max(0, centre - 4), hi = lo + 8;
  const vals = []; for (let w = lo; w <= hi; w++) vals.push((x.dist.get(w) || 0) / x.numSims);
  const mx = Math.max(...vals, 0.001);
  const dist = vals.map((v, i) => `<div class="${lo + i === centre ? 'cur' : ''}" style="height:${(v / mx) * 100}%" title="${Math.round(v * 100)}% finish with ${lo + i} wins"><em>${lo + i}</em></div>`).join('');

  item.querySelector('[data-panel]').innerHTML = `<div class="trend"><h4>How the odds have moved</h4>${svg}
      <div class="legend2"><span><i style="background:${team.color}"></i>Make playoffs</span><span><i style="background:#f4c430"></i>Win title</span><span>marker = week ${W}</span></div>
      <h4 style="margin-top:16px">Final regular-season wins</h4><div class="distwrap"><div class="dist">${dist}</div></div></div>
    <div><h4>Remaining schedule &middot; win odds</h4><div class="sched">${sched}</div></div>`;
}

// ---------- controls ----------
let playTimer = null;
asOfSlider.addEventListener('input', () => { asOfWeek = Number(asOfSlider.value); render(true); });
playBtn.addEventListener('click', () => {
  if (playTimer) { clearInterval(playTimer); playTimer = null; playBtn.textContent = '▶ Play'; return; }
  if (asOfWeek >= state.cw) asOfWeek = 1;
  playBtn.textContent = '⏸ Pause'; render(true);
  playTimer = setInterval(() => {
    if (asOfWeek >= state.cw) { clearInterval(playTimer); playTimer = null; playBtn.textContent = '▶ Play'; return; }
    asOfWeek++; render(true);
  }, 1400);
});
regEndInput.addEventListener('change', () => { state.regEnd = Math.max(state.cw, Number(regEndInput.value) || state.regEnd); outlookCache.clear(); render(true); });
simCountSelect.addEventListener('change', () => { outlookCache.clear(); render(true); });
leagueSelect.addEventListener('change', () => loadLeagueData(leagueSelect.value));

loadLeagues();
