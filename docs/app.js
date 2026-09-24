const { url, anonKey } = window.SUPABASE_CONFIG;
const sb = window.supabase.createClient(url, anonKey);

const leagueSelect = document.getElementById('leagueSelect');
const yearSelect = document.getElementById('yearSelect');
const weekSelect = document.getElementById('weekSelect');
const statusEl = document.getElementById('status');
const matchupsEl = document.getElementById('matchups');
const viewButtons = document.querySelectorAll('.view-btn');
const themeToggle = document.getElementById('themeToggle');

const charts = {}; // matchupId -> { mode, chart? , el?, needle? } depending on view
let refreshTimer = null;
// Timeline and Postcard are being deprecated -- hidden from the view
// switcher unless explicitly re-enabled (see preferences.html). Default
// OFF, matching the convention for other opt-in visual toggles.
let showLegacyViews = localStorage.getItem('winProbShowLegacyViews') === 'true';
let viewMode = localStorage.getItem('winProbViewMode') || 'espn'; // 'timeline' | 'postcard' | 'needle' | 'espn'
if (!showLegacyViews && (viewMode === 'timeline' || viewMode === 'postcard')) {
  // Falls back for THIS session without touching what's saved in
  // localStorage -- if the preference gets turned back on later, whatever
  // view they'd previously chosen is still there waiting for them.
  viewMode = 'espn';
}
// Respects the OS's prefers-color-scheme on a first visit (no saved
// preference yet) -- once someone manually toggles via themeToggle, that
// explicit choice is saved and takes over from then on regardless of what
// the system setting does.
function systemPrefersDark() {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches;
}
let theme = localStorage.getItem('winProbTheme') || (systemPrefersDark() ? 'dark' : 'light'); // 'light' | 'dark'
// Defaults on (only off if explicitly set to 'false') -- shows, on hover
// in ESPN view, whether Upset Watch was active at that historical point.
let showUpsetHistory = localStorage.getItem('winProbShowUpsetHistory') !== 'false'; // set on preferences.html
// Defaults OFF (only 'true' turns it on) -- opposite convention from the
// preference above, since this adds a visual layer to every chart rather
// than just extra info on an already-opt-in hover.
let showConfidenceBand = localStorage.getItem('winProbShowConfidenceBand') === 'true'; // set on preferences.html
// Defaults on (only off if explicitly set to 'false') -- the NYT-style
// "+X.X%"/"-X.X%" popup that appears next to a team's percentage ~500ms
// after a poll actually moves it. See scheduleDeltaBadge below.
let showDeltaPopups = localStorage.getItem('winProbShowDeltaPopups') !== 'false'; // set on preferences.html
// Tracks which of the two leader-bar layers is currently the visible one,
// so updateLeaderBar (see WEEKLY RECAP section) knows which layer to
// write the NEW gradient into and crossfade up, and which one to fade
// out -- alternating every time the leader actually changes.
let leaderBarActiveLayer = null; // 'A' | 'B' | null (nothing shown yet)
let leaderBarCurrentTeamId = null;
document.documentElement.setAttribute('data-theme', theme);

// ============================== THEME / COLOR ADJUSTMENT ==============================

// ============================== FORECASTING MATH ==============================
// The poller computes win_prob using a normal-distribution model over the
// projected score margin (see poller/lib/winProb.js), but only the
// RESULT gets stored -- not the stddev it used to get there. To build a
// projected score range, a "points needed to win" figure, or a
// confidence band, we need that stddev back. Since win_prob was computed
// as Phi((homeExpected - awayExpected) / (stddev * sqrt(2))), and we DO
// have the stored win_prob plus both expected scores, the implied stddev
// can be recovered exactly by inverting that formula -- which just needs
// the inverse of the standard normal CDF (the "probit" function).

// erf via the Abramowitz & Stegun 7.1.26 approximation -- max error
// ~1.5e-7, comfortably precise enough for a visual estimate.
function erf(x) {
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const t = 1 / (1 + p * x);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return sign * y;
}
function normalCdf(z) {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}
// Inverse of the standard normal CDF ("probit"), via Peter Acklam's
// rational approximation. Takes p in (0,1), returns z such that
// normalCdf(z) === p. Accurate to about 1.15e-9 in the central region.
function probit(p) {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const pLow = 0.02425, pHigh = 1 - pLow;
  let q, r;
  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  } else if (p <= pHigh) {
    q = p - 0.5; r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  } else {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
}

// Recovers the stddev (in points) the poller must have used for this
// specific snapshot, given the stored win_prob and both expected scores.
// Clamped away from exact 0/100 (which would imply infinite certainty --
// z would be +/-Infinity) and guarded against a near-zero z with a
// meaningful diff (which shouldn't happen given the model, but falls
// back to a sane default rather than dividing by ~0 if it ever does).
const FORECAST_FALLBACK_STDDEV = 21; // matches the poller's own DEFAULT_STDDEV
function impliedStddev(homeExpected, awayExpected, winProbHome) {
  const diff = homeExpected - awayExpected;
  const p = Math.max(0.001, Math.min(0.999, winProbHome / 100));
  const z = probit(p);
  if (Math.abs(z) < 0.05) return FORECAST_FALLBACK_STDDEV;
  const stddev = diff / (z * Math.SQRT2);
  return stddev > 0 ? stddev : FORECAST_FALLBACK_STDDEV;
}

// For the optional confidence-band chart overlay (see preferences.html):
// given the RAW (pre-withCrossings) chart points, returns two parallel
// arrays of {x, y} representing the upper/lower bounds of a "+/- 1 model
// stddev" band around the plotted win_prob line. Works entirely in
// z-score space -- shift the implied z-score by +/-1, convert back via
// normalCdf -- so it never needs the stddev in points at all, just the
// stored win_prob itself. This is also why the band naturally narrows as
// a game becomes decided: normalCdf flattens out near its tails, so the
// same +/-1 shift in z produces a much smaller swing in win_prob terms
// once the line is already close to 0 or 100 than it does near 50.
function computeConfidenceBand(rawPoints) {
  const upper = [], lower = [];
  for (const p of rawPoints) {
    if (p.y === undefined) continue;
    const pClamped = Math.max(0.1, Math.min(99.9, p.y)) / 100;
    const z = probit(pClamped);
    upper.push({ x: p.x, y: Math.min(100, normalCdf(z + 1) * 100) });
    lower.push({ x: p.x, y: Math.max(0, normalCdf(z - 1) * 100) });
  }
  return { upper, lower };
}

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const num = parseInt(full, 16);
  return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
}
function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
}
function rgbToHsl(r, g, b) {
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
function hslToRgb(h, s, l) {
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

// A team color is only adjusted if it's genuinely too close to black to read
// against a dark background (HSL lightness below MIN_LIGHTNESS) -- not just
// "somewhat dark." A saturated navy or forest green stays clearly identifiable
// by hue even at moderate darkness, so those are left alone; this only
// catches colors (true black, near-black grays, very dark navy/etc.) that
// would genuinely blend into a dark page background. When it does need to
// lighten a color, it preserves the original hue and saturation exactly and
// only raises lightness -- so a near-black navy becomes a lighter blue, not
// some unrelated color, and true black/gray becomes a clean neutral gray
// rather than an invented tint.
const MIN_LIGHTNESS = 0.20;
const TARGET_LIGHTNESS = 0.50;

function isTooCloseToBlack(hex) {
  try {
    const { r, g, b } = hexToRgb(hex);
    return rgbToHsl(r, g, b).l < MIN_LIGHTNESS;
  } catch {
    return false;
  }
}

// Returns { color, wasAdjusted }. wasAdjusted matters for deconflictColors()
// below -- only colors we ourselves modified are allowed to move further to
// resolve a collision; a color the user picked that was already fine is
// never touched, even if it happens to collide with a color we boosted.
function themedColor(hex) {
  if (theme !== 'dark' || !isTooCloseToBlack(hex)) return { color: hex, wasAdjusted: false };
  try {
    const { r, g, b } = hexToRgb(hex);
    const { h, s } = rgbToHsl(r, g, b);
    const { r: nr, g: ng, b: nb } = hslToRgb(h, s, TARGET_LIGHTNESS);
    return { color: rgbToHex(nr, ng, nb), wasAdjusted: true };
  } catch {
    return { color: hex, wasAdjusted: false }; // malformed color -- don't crash the page over it
  }
}

// 'redmean' -- a cheap, well-known approximation of perceptual color
// distance. Good enough to detect "these look basically the same," without
// needing full Lab-space color math.
function colorDistance(hex1, hex2) {
  const c1 = hexToRgb(hex1), c2 = hexToRgb(hex2);
  const rBar = (c1.r + c2.r) / 2;
  const dr = c1.r - c2.r, dg = c1.g - c2.g, db = c1.b - c2.b;
  return Math.sqrt((2 + rBar / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rBar) / 256) * db * db);
}

function rotateHue(hex, degrees) {
  const { r, g, b } = hexToRgb(hex);
  let { h, s, l } = rgbToHsl(r, g, b);
  h = (((h * 360 + degrees) % 360) + 360) % 360 / 360;
  const { r: nr, g: ng, b: nb } = hslToRgb(h, s, l);
  return rgbToHex(nr, ng, nb);
}

// Boosting every too-dark color to the SAME target lightness (above) can
// occasionally make two originally-distinguishable colors (different only by
// darkness) converge on a near-identical hue+lightness once flattened --
// e.g. a dark forest green and a bright lime green can end up looking almost
// the same once the dark one is lightened, even though they looked nothing
// alike before. This checks every pair of team colors actually being shown
// together and, if any are too close, rotates the hue of whichever one WE
// already modified (never a color the user picked that was already fine)
// until it clears a safe distance from everything else.
const MIN_COLOR_DISTANCE = 150;
const HUE_NUDGE_STEP = 40;
const MAX_NUDGE_ATTEMPTS = 8;

function deconflictColors(entries) {
  // entries: [{ id, color, wasAdjusted }]
  const finalized = entries.filter((e) => !e.wasAdjusted).map((e) => e.color); // anchors, never moved
  const out = {};
  for (const e of entries) {
    if (!e.wasAdjusted) { out[e.id] = e.color; continue; }
    let color = e.color;
    let attempts = 0;
    while (attempts < MAX_NUDGE_ATTEMPTS && finalized.some((c) => colorDistance(c, color) < MIN_COLOR_DISTANCE)) {
      color = rotateHue(color, HUE_NUDGE_STEP);
      attempts++;
    }
    out[e.id] = color;
    finalized.push(color);
  }
  return out;
}

// Small helper for values (chart grid/tick colors) that just need to flip
// between a light-mode and dark-mode constant, no per-color math needed.
function themeVar(lightVal, darkVal) {
  return theme === 'dark' ? darkVal : lightVal;
}

// "Live" (all_starters_done = false) only glows if the matchup has actually
// produced a new snapshot recently. This is a reliable signal specifically
// because of how the poller's dedupe works: expected_score keeps drifting
// on its own (from the pace-based remaining-time decay) for as long as
// anyone is genuinely mid-game, even through a scoring lull -- so a long
// stretch with zero new rows really does mean nobody in this matchup is
// currently playing (between game windows, bye-week stragglers, etc.), not
// just "nothing happened for a few minutes." A matchup in that state is
// still technically "Live" (not Final), but shouldn't visually pulse like
// something is actively happening right now.
const LIVE_STALE_MS = 20 * 60 * 1000; // 20 minutes, generous over ~1-min polling
function isRecentlyActive(rows) {
  if (!rows.length) return false;
  const latestTs = rows.reduce((max, r) => Math.max(max, new Date(r.ts).getTime()), 0);
  return Date.now() - latestTs < LIVE_STALE_MS;
}

function setTheme(next) {
  if (next === theme) return;
  theme = next;
  localStorage.setItem('winProbTheme', theme);
  document.documentElement.setAttribute('data-theme', theme);
  // Keeps the browser's own UI chrome color (status bar, overscroll area
  // on mobile) in sync with a manually-toggled theme -- see the meta
  // tag's own comment in index.html for why this exists at all.
  const themeColorMeta = document.getElementById('themeColorMeta');
  if (themeColorMeta) themeColorMeta.setAttribute('content', theme === 'dark' ? '#14161a' : '#ffffff');
  if (themeToggle) themeToggle.textContent = theme === 'dark' ? '\u2600\ufe0f Light' : '\ud83c\udf19 Dark';
  loadMatchups({ preserveCharts: false }); // re-fetch so team colors re-run through themedColor()
}

// Supabase/PostgREST silently caps any query at 1000 rows by default -- no
// error, it just returns the first 1000 and stops. With frequent polling
// (every 1 min) a single week's snapshots blow past that within a few
// hours of live games, and since queries below order by `ts` ascending,
// that meant getting stuck on the OLDEST 1000 rows forever, no matter how
// hard you refreshed -- it wasn't a caching issue, the query itself never
// asked for more than page 1. This pages through .range() until a page
// comes back with fewer than PAGE_SIZE rows (i.e. we've reached the end).
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

async function loadLeagues() {
  const { data, error } = await sb.from('leagues').select('id, slug, name').order('name');
  if (error) { statusEl.textContent = 'Failed to load leagues: ' + error.message; return; }
  leagueSelect.innerHTML = data.map((l) => `<option value="${l.id}">${l.name}</option>`).join('');
}

// Given snapshot rows for a SPECIFIC week, determines whether every
// matchup that week has gone fully final -- both sides' latest snapshot
// showing all_starters_done=true. False on empty input (the season
// hasn't reached that week yet), not vacuously true.
function isWeekFullyComplete(rows) {
  if (!rows.length) return false;
  const latestByKey = new Map();
  for (const r of rows) {
    const key = `${r.matchup_id}|${r.team_id}`;
    const existing = latestByKey.get(key);
    if (!existing || new Date(r.ts) > new Date(existing.ts)) latestByKey.set(key, r);
  }
  const matchupGroups = new Map();
  for (const r of latestByKey.values()) {
    if (!matchupGroups.has(r.matchup_id)) matchupGroups.set(r.matchup_id, []);
    matchupGroups.get(r.matchup_id).push(r);
  }
  if (!matchupGroups.size) return false;
  for (const sides of matchupGroups.values()) {
    if (sides.length !== 2) return false;
    if (!sides.every((s) => s.all_starters_done)) return false;
  }
  return true;
}

const YEAR_IN_REVIEW_WEEK = 17; // the last week of an NFL fantasy season
const yearInReviewLink = document.getElementById('yearInReviewLink');

// Checks whether week 17 of the LATEST year (yearSelect.value, already
// sorted descending by loadYearsWeeks) has gone fully final for the
// currently-selected league, and shows/hides the top-of-page button
// accordingly. The early-access preference bypasses this check entirely
// when enabled, regardless of what week the season is actually on.
async function checkYearInReviewAvailability(leagueId) {
  if (!yearInReviewLink) return;
  if (localStorage.getItem('winProbYearInReviewEarly') === 'true') {
    yearInReviewLink.hidden = false;
    return;
  }
  const latestYear = Number(yearSelect.value);
  if (!leagueId || !latestYear) { yearInReviewLink.hidden = true; return; }
  const { data, error } = await sb
    .from('snapshots')
    .select('matchup_id, team_id, all_starters_done, ts')
    .eq('league_id', leagueId)
    .eq('year', latestYear)
    .eq('week', YEAR_IN_REVIEW_WEEK);
  if (error) { yearInReviewLink.hidden = true; return; }
  yearInReviewLink.hidden = !isWeekFullyComplete(data || []);
}

async function loadYearsWeeks(leagueId) {
  let data;
  try {
    data = await fetchAllRows((from, to) =>
      sb.from('snapshots').select('year, week').eq('league_id', leagueId).order('id').range(from, to)
    );
  } catch (err) {
    data = [];
  }

  if (!data.length) {
    const now = new Date();
    yearSelect.innerHTML = `<option value="${now.getFullYear()}">${now.getFullYear()}</option>`;
    weekSelect.innerHTML = `<option value="1">Week 1</option>`;
    return;
  }
  const years = [...new Set(data.map((d) => d.year))].sort((a, b) => b - a);
  yearSelect.innerHTML = years.map((y) => `<option value="${y}">${y}</option>`).join('');

  const weeksForYear = (year) =>
    [...new Set(data.filter((d) => d.year === year).map((d) => d.week))].sort((a, b) => b - a);

  const updateWeeks = () => {
    const weeks = weeksForYear(Number(yearSelect.value));
    weekSelect.innerHTML = weeks.map((w) => `<option value="${w}">Week ${w}</option>`).join('');
  };
  yearSelect.onchange = () => { updateWeeks(); loadMatchups(); };
  updateWeeks();
}

// Periodically checks whether a NEWER week's data has started arriving
// (the poller writing its first row once a new week's kickoff happens),
// and if so, auto-advances the dropdowns to it -- without this, the week
// selector only ever gets rebuilt on a league switch or the initial page
// load, so a page left open across a week transition would otherwise just
// keep sitting on the now-stale week forever.
//
// Only acts when the person is ALREADY on what they believe is the latest
// week (selectedIndex 0 in both dropdowns, same convention
// updateKickoffCountdown uses) -- if they've manually navigated to browse
// an older week, this must never yank them away to something they didn't
// ask for. Returns true if it performed a reload, so the caller can skip
// a redundant one on the same cycle.
async function checkForLatestWeekAdvance() {
  if (yearSelect.selectedIndex !== 0 || weekSelect.selectedIndex !== 0) return false;

  const leagueId = leagueSelect.value;
  if (!leagueId) return false;

  let data;
  try {
    data = await fetchAllRows((from, to) =>
      sb.from('snapshots').select('year, week').eq('league_id', leagueId).order('id').range(from, to)
    );
  } catch {
    return false; // transient error -- try again next cycle
  }
  if (!data.length) return false;

  const years = [...new Set(data.map((d) => d.year))].sort((a, b) => b - a);
  const latestYear = years[0];
  const weeksForLatestYear = [...new Set(data.filter((d) => d.year === latestYear).map((d) => d.week))].sort((a, b) => b - a);
  const latestWeek = weeksForLatestYear[0];

  const currentYear = Number(yearSelect.value);
  const currentWeek = Number(weekSelect.value);
  if (latestYear === currentYear && latestWeek === currentWeek) return false; // nothing new -- skip the unnecessary DOM rebuild

  // A newer week (or year) has appeared since the dropdowns were last
  // populated -- rebuild them (loadYearsWeeks always defaults to the
  // latest option in each) and reload the page's data to match.
  await loadYearsWeeks(leagueId);
  await loadMatchups({ preserveCharts: false });
  return true;
}

function colorWithAlpha(hex, alpha) {
  const h = hex.replace('#', '');
  const bigint = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  const r = (bigint >> 16) & 255, g = (bigint >> 8) & 255, b = bigint & 255;
  return `rgba(${r},${g},${b},${alpha})`;
}

function intensity(y) {
  return Math.min(Math.abs(y - 50) / 50, 1);
}

async function fetchMatchupData(leagueId, year, week) {
  const [snaps, { data: teams, error: teamErr }] = await Promise.all([
    fetchAllRows((from, to) =>
      sb.from('snapshots').select('*').eq('league_id', leagueId).eq('year', year).eq('week', week).order('ts').range(from, to)
    ),
    sb.from('teams').select('id, espn_team_name, team_settings(color, display_name, emoji, logo_url)').eq('league_id', leagueId),
  ]);
  if (teamErr) throw teamErr;

  const rawEntries = (teams || []).map((t) => {
    const settings = t.team_settings || {};
    const { color, wasAdjusted } = themedColor(settings.color || '#1a3fa0');
    return {
      id: t.id,
      name: settings.display_name || t.espn_team_name,
      color,
      wasAdjusted,
      emoji: settings.emoji || '',
      logoUrl: settings.logo_url || '',
    };
  });

  // Deconflict across the WHOLE league's teams at once, not just within one
  // matchup -- Postcard/Needle views show every matchup on screen together,
  // so a collision can happen between teams in completely different games.
  const deconflicted = deconflictColors(rawEntries);

  const teamInfo = {};
  for (const e of rawEntries) {
    teamInfo[e.id] = { name: e.name, color: deconflicted[e.id], emoji: e.emoji, logoUrl: e.logoUrl };
  }

  const byMatchup = {};
  for (const s of snaps || []) {
    (byMatchup[s.matchup_id] ||= []).push(s);
  }

  return { byMatchup, teamInfo };
}

// ============================== TIMELINE VIEW ==============================
// The original line-chart-per-matchup view, stacked vertically.

// Insert an exact y=50 point at every crossing so the line pivots color
// precisely at the true crossing instead of jumping between sides.
function withCrossings(points) {
  const out = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (i > 0) {
      const prev = points[i - 1];
      const crosses = (prev.y - 50) * (p.y - 50) < 0;
      if (crosses) {
        const t = (50 - prev.y) / (p.y - prev.y);
        // ts is carried forward from the preceding REAL point so that
        // lookups keyed by timestamp (e.g. the Upset Watch hover-history
        // map) still resolve for this synthetic point, rather than
        // missing and falling back to "not active." Without this, ESPN
        // view's hover badge would flicker on/off as the mouse swept
        // across any 50%-crossing, alternating between a real point (has
        // a match) and this one (previously had none) even when both
        // genuinely belong to the same historical moment. This does NOT
        // affect the separate "is this point real or synthetic" check
        // used elsewhere (afterLabel etc.), which tests homeActual, not
        // ts -- this point still correctly has no real scores of its own.
        out.push({ x: prev.x + t * (p.x - prev.x), y: 50, ts: prev.ts });
      }
    }
    out.push(p);
  }
  return out;
}

// Finds the row in `sortedRows` (sorted ascending by ts) closest in time to
// `targetTs`, via binary search. Needed because home/away snapshots don't
// share identical timestamps -- each team dedupes independently, so a given
// home row's nearest away row could be a few seconds or a few minutes away,
// not the same array index.
function nearestByTs(sortedRows, targetTs) {
  if (!sortedRows.length) return undefined;
  const targetTime = new Date(targetTs).getTime();
  let lo = 0, hi = sortedRows.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (new Date(sortedRows[mid].ts).getTime() < targetTime) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0) {
    const a = sortedRows[lo], b = sortedRows[lo - 1];
    const da = Math.abs(new Date(a.ts).getTime() - targetTime);
    const db = Math.abs(new Date(b.ts).getTime() - targetTime);
    return db < da ? b : a;
  }
  return sortedRows[lo];
}

// ============================== UPSET WATCH ==============================
// Per-card alert (not a banner) that flags when a team who was heavily
// favored has fallen far enough that a genuine upset is possible. Walks
// the HOME win_prob sequence exactly once, in chronological order, using
// a single state machine -- rather than checking "is win_prob currently
// below 65" in isolation on every render, which has no memory of whether
// anyone was ever actually dominant and would misfire on a game that
// simply started close and stayed close.
//
// State machine (thresholds from home's perspective; away is always
// 100 - home, so every threshold has a mirror-image counterpart):
//   ARM:     home >= 90  -> home is the armed favorite (peak tracked)
//            home <= 10  -> away is the armed favorite (peak = 100-home)
//            Reaching either extreme always clears any prior watch --
//            re-securing a commanding lead means the last scare is over.
//   TRIGGER: armed=home and home drops below 65        -> watch on, away is the upset side
//            armed=away and home rises above 35 (=100-65) -> watch on, home is the upset side
//   CLEAR:   once watching, hitting the SAME 70 threshold from either
//            direction turns watch off and fully un-arms both sides --
//            hp >= 70 means the upset side clearly took over, hp <= 30
//            (its mirror) means the original favorite clearly reclaimed
//            control. Using one consistent number both ways matters: an
//            earlier version only cleared via the favorite re-reaching
//            the full 90 ARM threshold, which meant some games visibly
//            cleared right around 70% while others didn't clear until
//            90% -- an inconsistency that was a real bug, not a feature.
//            Per spec, the newly-settled side only becomes "armed" again
//            the next time it itself reaches the 90/10 extreme.
// This naturally gives hysteresis (65 to trigger, 70 to clear) so a team
// bouncing right around either line doesn't flicker the alert on and off,
// and naturally supports a game flipping favorites multiple times, since
// each arm/trigger/clear cycle is independent of any earlier one.
//
// This is pure client-side computation over snapshots that already exist
// in the database -- it reads win_prob history, it never writes anything,
// so it cannot create, duplicate, or otherwise affect any real snapshot
// row, and has no interaction with the poller at all.
const UPSET_ARM = 85; // lowered from 90 -- a team peaking at 85-89% was previously excluded entirely, even from a genuine, dramatic collapse, since arming never happened at all below 90
const UPSET_ARM_TRIGGER_GAP = 25; // same gap size as the old fixed 90-to-65 pairing, now measured from wherever the armed side ACTUALLY peaked rather than always from a flat 90 -- so a 99% peak needs to fall further to trigger than an 85% peak does, matching how much more dominant it actually was
const UPSET_CLEAR = 70; // the challenger's OWN threshold reaching this clears the watch -- unchanged, this is about the NEW favorite's own established dominance, unrelated to the original favorite's peak
const UPSET_CLEAR_HYSTERESIS_BUFFER = 5; // the old system's own implicit 65-to-70 gap. With a FIXED trigger floor this fell out automatically; with a dynamic one it doesn't -- a peak above 95% pushes the dynamic trigger floor (peak-25) ABOVE the flat 70% clear line, which would let the alert clear while still technically below its own trigger threshold and flicker on ordinary noise. This buffer guarantees the gap between trigger and the favorite's own reclaim floor is always at least 5 points, at any peak height.

// sortedHomeWinProbs: home's win_prob values in ascending ts order.
// Returns the state as of the LAST value (for live card display) plus
// every distinct triggered episode across the whole sequence (for the
// weekly recap, which cares about the most dramatic moment of the whole
// game, not just wherever things ended up).
//
// onStep, if given, is called once per input value with the `watch` state
// and `upsetSide` as of THAT point -- used to build a hover-over-history
// lookup (see getUpsetWatchHistory) without duplicating this whole state
// machine.
function walkUpsetState(sortedHomeWinProbs, onStep) {
  let armed = null; // 'home' | 'away' | null
  let peak = null; // the armed side's peak favorite % reached
  let watch = false;
  let upsetSide = null; // the side currently threatening the upset, while watch is true
  let currentEpisode = null;
  const episodes = [];

  for (const hp of sortedHomeWinProbs) {
    if (hp >= UPSET_ARM) {
      if (armed !== 'home') {
        armed = 'home'; peak = hp;
        currentEpisode = { favoriteSide: 'home', peakFavoritePct: hp };
      } else {
        peak = Math.max(peak, hp);
        currentEpisode.peakFavoritePct = peak;
      }
      watch = false; upsetSide = null;
    } else if (hp <= 100 - UPSET_ARM) {
      if (armed !== 'away') {
        armed = 'away'; peak = 100 - hp;
        currentEpisode = { favoriteSide: 'away', peakFavoritePct: peak };
      } else {
        peak = Math.max(peak, 100 - hp);
        currentEpisode.peakFavoritePct = peak;
      }
      watch = false; upsetSide = null;
    } else {
      // Dynamic trigger floor: how far the armed side has to fall from
      // its OWN peak, not a flat number every team is measured against
      // regardless of how dominant they actually were.
      const triggerFloor = peak !== null ? peak - UPSET_ARM_TRIGGER_GAP : null;
      if (armed === 'home' && !watch && triggerFloor !== null && hp < triggerFloor) {
        watch = true; upsetSide = 'away';
        episodes.push({ ...currentEpisode, upsetSide: 'away' });
      } else if (armed === 'away' && !watch && triggerFloor !== null && (100 - hp) < triggerFloor) {
        watch = true; upsetSide = 'home';
        episodes.push({ ...currentEpisode, upsetSide: 'home' });
      }
      // Clear: the CHALLENGER'S own threshold (UPSET_CLEAR, flat 70) is
      // unchanged either way. The FAVORITE'S OWN reclaim floor, though,
      // has to track its own trigger floor plus the hysteresis buffer
      // (see UPSET_CLEAR_HYSTERESIS_BUFFER above) rather than also being
      // a flat 70 -- otherwise a very high peak makes the dynamic trigger
      // floor exceed 70, and the alert could clear while still below its
      // own trigger line.
      //   - If the side that reclaims is the SAME side that was already
      //     armed, that team already proved it could reach the arm
      //     threshold earlier in this exact stretch -- surviving a scare
      //     and climbing back doesn't erase that, so it stays armed with
      //     its peak intact, only the scare itself (watch) clears. It
      //     does NOT need to re-earn arming by climbing all the way back.
      //   - If the side that reclaims is the OTHER side (the one that was
      //     threatening), that's a genuine changeover -- a different team
      //     is now in charge, so the old arm status no longer applies and
      //     that team must earn its own by reaching the arm threshold
      //     itself.
      if (watch) {
        const favoriteReclaimFloor = Math.max(UPSET_CLEAR, triggerFloor + UPSET_CLEAR_HYSTERESIS_BUFFER);
        const favoritePct = armed === 'home' ? hp : 100 - hp;
        const favoriteReclaimed = favoritePct >= favoriteReclaimFloor;
        const challengerReclaimed = (100 - favoritePct) >= UPSET_CLEAR;
        if (favoriteReclaimed || challengerReclaimed) {
          const reclaimingSide = favoriteReclaimed ? armed : (armed === 'home' ? 'away' : 'home');
          watch = false; upsetSide = null;
          if (reclaimingSide !== armed) {
            armed = null; peak = null; currentEpisode = null;
          }
        }
      }
    }
    if (onStep) onStep(watch, upsetSide);
  }

  return { armed, peak, watch, upsetSide, episodes };
}

// Convenience wrapper for card rendering: given a matchup's rows and the
// resolved home/away team objects, returns null if no live alert should
// show, or { favorite, upsetTeam, favoritePeak, currentUpsetPct } if it
// should. Per spec, the alert is cleared the moment the game ends, even
// if the raw state machine would still say "watching" -- a completed
// game's drama is over regardless of how close the final score was.
function getLiveUpsetInfo(rows, home, away, allDone) {
  if (allDone) return null;
  const homeRows = rows.filter((r) => r.is_home).sort((a, b) => new Date(a.ts) - new Date(b.ts));
  if (homeRows.length < 2) return null;
  const { watch, armed, peak, upsetSide } = walkUpsetState(homeRows.map((r) => r.win_prob));
  if (!watch) return null;
  const favorite = armed === 'home' ? home : away;
  const upsetTeam = upsetSide === 'home' ? home : away;
  const currentUpsetPct = upsetSide === 'home' ? homeRows[homeRows.length - 1].win_prob : 100 - homeRows[homeRows.length - 1].win_prob;
  return { favorite, upsetTeam, favoritePeak: peak, currentUpsetPct };
}

// For ESPN view's hover-over-history feature (see preferences.html): a
// map from each of a team's own snapshot timestamps to whether Upset
// Watch was active as of THAT specific historical point, not just
// whatever the state happens to be right now. Built by replaying the
// same state machine via walkUpsetState's onStep callback rather than
// duplicating its logic, so this can never drift out of sync with the
// live behavior.
// Returns a sorted array of { ts, watch } entries, one per home poll, in
// chronological order -- looked up via nearestByTs (same fuzzy matching
// used everywhere else in this file for cross-referencing home/away data
// onto a shared timestamp axis), NOT an exact-match lookup. This matters:
// the chart's x-axis is built from the UNION of home and away poll
// timestamps, so a hovered chart point's own .ts can come from either
// side and may not exactly equal any home row's timestamp even when it's
// only milliseconds off. An earlier exact-match version of this (a Map
// keyed by home ts) would silently miss on every point whose ts happened
// to originate from an away poll, which -- since home/away polls
// interleave -- meant the hover badge flickered on/off at nearly every
// adjacent point instead of holding steady across a real stretch.
function getUpsetWatchHistory(rows) {
  const homeRows = rows.filter((r) => r.is_home).sort((a, b) => new Date(a.ts) - new Date(b.ts));
  const history = [];
  let i = 0;
  walkUpsetState(homeRows.map((r) => r.win_prob), (watchNow, upsetSideNow) => {
    history.push({ ts: homeRows[i].ts, watch: watchNow, upsetSide: upsetSideNow });
    i++;
  });
  return history;
}

// Colors the alert (both the card's border pulse and, by inheritance,
// the badge's default text/glow) after the specific team that might pull
// off the upset, rather than a fixed generic color -- reusing the
// existing colorWithAlpha helper (see THEME/COLOR section) for the two
// glow-intensity variants. Set as CSS custom properties scoped to just
// this card element, so different matchups on the same page each show
// their own team's color without needing separate CSS classes per team.
// Called from every view's render/update function whenever upsetInfo
// exists; when it doesn't, leaving the previous values in place is
// harmless since the .upset-watch/.upset-watch-badge classes that read
// them won't be applied to an inactive card anyway.
function applyUpsetColor(card, hexColor) {
  card.style.setProperty('--upset', hexColor);
  card.style.setProperty('--upset-glow-a', colorWithAlpha(hexColor, 0.35));
  card.style.setProperty('--upset-glow-b', colorWithAlpha(hexColor, 0.85));
}

// ============================== LEADER BAR ==============================
// An ambient gradient wash behind the page's top section (see index.html
// for the actual positioning/z-index -- it sits behind #wrap, confined
// to roughly the top quarter of the viewport, fading to transparent),
// colored after whichever team currently has the most points in the
// selected week -- live and in-progress, unlike the Weekly Recap below
// which only shows once everything is Final. Works across every matchup
// currently loaded, not just one, since "the week's leader" is a
// league-wide comparison.

function computeWeekLeader(byMatchup, teamInfo) {
  let best = null;
  for (const rows of Object.values(byMatchup)) {
    for (const isHome of [true, false]) {
      const row = latestRow(rows, isHome);
      if (!row) continue;
      const team = teamInfo[row.team_id];
      if (!team) continue;
      if (!best || row.actual_score > best.score) {
        best = { team, teamId: row.team_id, score: row.actual_score };
      }
    }
  }
  return best;
}

// Writes the current week's leader into the leader bar, crossfading
// between the two stacked layers (see index.html's CSS) whenever the
// leader actually changes -- including a change caused by switching to a
// different week's data entirely, since that's handled the same way:
// whatever the new leader turns out to be just becomes "the new color,"
// with no special-casing needed for why it changed.
function updateLeaderBar(byMatchup, teamInfo) {
  const bar = document.getElementById('leaderGradient');
  const layerA = document.getElementById('leaderGradientLayerA');
  const layerB = document.getElementById('leaderGradientLayerB');
  if (!bar || !layerA || !layerB) return;

  const leader = computeWeekLeader(byMatchup, teamInfo);
  if (!leader) {
    // No data yet for this week -- hide both layers rather than show a
    // leftover color from whatever was previously selected.
    layerA.classList.remove('visible');
    layerB.classList.remove('visible');
    leaderBarCurrentTeamId = null;
    leaderBarActiveLayer = null;
    return;
  }

  const teamId = leader.teamId;
  if (teamId === leaderBarCurrentTeamId) return; // same leader -- nothing to transition

  // A soft ambient wash, not a solid fill -- semi-transparent at the top,
  // fading to fully transparent by the bottom of the band, so it reads
  // as a gentle tint behind the header rather than a colored block.
  const gradient = `linear-gradient(to bottom, ${colorWithAlpha(leader.team.color, 0.35)}, transparent)`;
  const nextLayer = leaderBarActiveLayer === 'A' ? layerB : layerA;
  const prevLayer = leaderBarActiveLayer === 'A' ? layerA : layerB;

  nextLayer.style.background = gradient;
  nextLayer.classList.add('visible');
  prevLayer.classList.remove('visible');

  leaderBarCurrentTeamId = teamId;
  leaderBarActiveLayer = leaderBarActiveLayer === 'A' ? 'B' : 'A';
}

// ============================== BYE WEEK DETECTION ==============================
// A team with no matchup scheduled this week would otherwise just never
// appear anywhere on the page, with nothing distinguishing that from the
// poller having failed for them specifically -- this makes the
// distinction explicit. teamInfo always contains every team in the
// league regardless of whether they have a matchup this week (see
// fetchMatchupData, which fetches the teams table independently of
// snapshots), so comparing it against who actually shows up in
// byMatchup's rows is enough to find the gap, no extra fetch needed.
function computeByeTeams(byMatchup, teamInfo) {
  // If there's no data at all yet (poller hasn't run this week), don't
  // guess -- that's "no data yet," not "everyone is on a bye." Only once
  // SOME matchups have real rows does a team's total absence become a
  // meaningful signal rather than just "hasn't been polled yet."
  if (!Object.keys(byMatchup).length) return [];

  const teamsWithMatchup = new Set();
  for (const rows of Object.values(byMatchup)) {
    for (const row of rows) teamsWithMatchup.add(row.team_id);
  }

  const byeTeams = [];
  for (const [teamId, team] of Object.entries(teamInfo)) {
    if (!teamsWithMatchup.has(teamId)) byeTeams.push(team);
  }
  return byeTeams;
}

function renderByeWeekNote(byMatchup, teamInfo) {
  const note = document.getElementById('byeWeekNote');
  if (!note) return;
  const byeTeams = computeByeTeams(byMatchup, teamInfo);
  if (!byeTeams.length) {
    note.hidden = true;
    return;
  }
  const names = byeTeams.map((t) => t.name).join(', ');
  note.textContent = byeTeams.length === 1
    ? `\ud83d\udecc ${names} is on a bye this week -- no matchup scheduled.`
    : `\ud83d\udecc ${names} are on a bye this week -- no matchups scheduled.`;
  note.hidden = false;
}

// ============================== WEEKLY RECAP ==============================
// Shows once every matchup in the current week is Final -- final scores,
// the closest game by final margin, and the biggest upset (see the Upset
// Watch section above).

function computeWeeklyRecap(byMatchup, teamInfo) {
  const matchupIds = Object.keys(byMatchup);
  if (!matchupIds.length) return null;

  const summaries = [];
  let closestGame = null;
  let biggestBlowout = null;
  let biggestUpset = null;
  let highScore = null;
  let lowScore = null;
  let biggestOverperformer = null;
  let biggestUnderperformer = null;
  let highestScoringMatchup = null;
  let lowestScoringMatchup = null;
  let totalPointsScored = 0; // league-wide, always computable -- used as a
  // fallback highlight for the closing slot when no Upset Watch episode
  // happened anywhere this week, so an uneventful week still fills the
  // grid instead of just showing one fewer card.

  for (const matchupId of matchupIds) {
    const rows = byMatchup[matchupId];
    const homeRow = rows.find((r) => r.is_home);
    const awayRow = rows.find((r) => !r.is_home);
    if (!homeRow || !awayRow) return null;

    const homeLatest = latestRow(rows, true);
    const awayLatest = latestRow(rows, false);
    // Every matchup must be genuinely Final before showing anything -- a
    // partial recap (some games still live) would be misleading.
    if (!homeLatest?.all_starters_done || !awayLatest?.all_starters_done) return null;

    const home = teamInfo[homeRow.team_id] || { name: 'Home', color: '#888', emoji: '' , logoUrl: '' };
    const away = teamInfo[awayRow.team_id] || { name: 'Away', color: '#888', emoji: '' , logoUrl: '' };
    const homeScore = homeLatest.actual_score;
    const awayScore = awayLatest.actual_score;
    const margin = Math.abs(homeScore - awayScore);
    const isTie = homeScore === awayScore;
    const winner = isTie ? null : homeScore > awayScore ? home : away;
    const loser = isTie ? null : winner === home ? away : home;

    summaries.push({
      isTie,
      home,
      away,
      winner,
      loser,
      winnerScore: Math.max(homeScore, awayScore),
      loserScore: Math.min(homeScore, awayScore),
      margin,
    });

    // Combined-points framing, a different lens from the individual
    // high/low score above -- a matchup where BOTH teams went off (or
    // both had a rough week) is its own notable story, distinct from
    // either team's own individual number.
    const combined = homeScore + awayScore;
    totalPointsScored += combined;
    if (!highestScoringMatchup || combined > highestScoringMatchup.combined) {
      highestScoringMatchup = { home, away, homeScore, awayScore, combined };
    }
    if (!lowestScoringMatchup || combined < lowestScoringMatchup.combined) {
      lowestScoringMatchup = { home, away, homeScore, awayScore, combined };
    }

    if (!closestGame || margin < closestGame.margin) {
      closestGame = { isTie, home, away, winner, loser, margin };
    }
    // A tie has margin 0, which can never exceed a prior blowout's
    // margin, so ties naturally never win "biggest blowout" without
    // needing an explicit exclusion.
    if (!isTie && (!biggestBlowout || margin > biggestBlowout.margin)) {
      biggestBlowout = { home, away, winner, loser, margin };
    }

    const homeRowsSorted = rows.filter((r) => r.is_home).sort((a, b) => new Date(a.ts) - new Date(b.ts));
    const awayRowsSorted = rows.filter((r) => !r.is_home).sort((a, b) => new Date(a.ts) - new Date(b.ts));

    // High/low score of the week, and biggest boom/bust against each
    // team's OWN earliest recorded projection (effectively their pregame
    // number, since polling starts before kickoff) -- a different lens
    // than the live win-probability stuff above: this is purely about
    // "who scored the most/least" and "whose final score aged best or
    // worst against what the model expected before anyone had played."
    for (const [team, finalScore, sortedRows] of [[home, homeScore, homeRowsSorted], [away, awayScore, awayRowsSorted]]) {
      if (!highScore || finalScore > highScore.score) highScore = { team, score: finalScore };
      if (!lowScore || finalScore < lowScore.score) lowScore = { team, score: finalScore };

      const pregameRow = sortedRows[0];
      if (pregameRow && pregameRow.expected_score != null) {
        const delta = finalScore - pregameRow.expected_score;
        if (!biggestOverperformer || delta > biggestOverperformer.delta) {
          biggestOverperformer = { team, delta, pregame: pregameRow.expected_score, final: finalScore };
        }
        if (!biggestUnderperformer || delta < biggestUnderperformer.delta) {
          biggestUnderperformer = { team, delta, pregame: pregameRow.expected_score, final: finalScore };
        }
      }
    }

    // Upset watch, scanned across this matchup's FULL history (not just
    // whatever's currently live) -- picks whichever triggered episode
    // reached the most extreme favorite peak, since that's the single
    // most dramatic "this looked all but over" moment of the game. Then
    // checked against the real final winner (already computed above) to
    // tell an actual completed upset apart from a threat the favorite
    // ultimately survived.
    const { episodes } = walkUpsetState(homeRowsSorted.map((r) => r.win_prob));
    if (episodes.length) {
      const topEpisode = episodes.reduce((best, e) => (!best || e.peakFavoritePct > best.peakFavoritePct ? e : best), null);
      const favoriteTeam = topEpisode.favoriteSide === 'home' ? home : away;
      const upsetTeam = topEpisode.upsetSide === 'home' ? home : away;
      const upsetHappened = !isTie && winner === upsetTeam;
      if (!biggestUpset || topEpisode.peakFavoritePct > biggestUpset.favoritePeak) {
        biggestUpset = {
          favorite: favoriteTeam,
          upsetTeam,
          favoritePeak: topEpisode.peakFavoritePct,
          upsetHappened,
          isTie, // the game this episode belongs to ended in a tie -- neither
                 // "defeated" nor "held on" is accurate then, so the render
                 // step needs a third, tie-specific message
          backAndForth: episodes.length > 1,
        };
      }
    }
  }

  return { summaries, closestGame, biggestBlowout, biggestUpset, highScore, lowScore, biggestOverperformer, biggestUnderperformer, highestScoringMatchup, lowestScoringMatchup, totalPointsScored };
}

function renderRecapBanner(byMatchup, teamInfo) {
  const banner = document.getElementById('recapBanner');
  if (!banner) return;
  const recap = computeWeeklyRecap(byMatchup, teamInfo);
  if (!recap) {
    banner.hidden = true;
    return;
  }

  const scoreLines = recap.summaries
    .map((s) =>
      s.isTie
        ? `<div class="recap-score-line"><b style="color:${s.home.color}">${s.home.name}</b> tied ${s.away.name} ` +
          `<span class="recap-margin">${s.winnerScore.toFixed(1)} - ${s.loserScore.toFixed(1)}</span></div>`
        : `<div class="recap-score-line"><b style="color:${s.winner.color}">${s.winner.name}</b> def. ${s.loser.name} ` +
          `<span class="recap-margin">${s.winnerScore.toFixed(1)} - ${s.loserScore.toFixed(1)}</span></div>`
    )
    .join('');

  // Each highlight is a small self-contained card: an icon+label up top,
  // then the concrete value/story below. Built as an array and filtered
  // rather than concatenated strings, so a highlight that has nothing to
  // say (e.g. no upset all week) just doesn't produce a card instead of
  // leaving a stray empty one in the grid.
  const highlights = [];

  if (recap.closestGame) {
    const g = recap.closestGame;
    highlights.push(`
      <div class="recap-card">
        <div class="recap-card-label">\ud83c\udfaf Closest Game</div>
        ${g.isTie
          ? `<div class="recap-card-value">${g.home.name} &amp; ${g.away.name} tied exactly</div>`
          : `<div class="recap-card-value"><b style="color:${g.winner.color}">${g.winner.name}</b> over ${g.loser.name}</div><div class="recap-card-sub">by ${g.margin.toFixed(1)}</div>`}
      </div>`);
  }

  if (recap.biggestBlowout) {
    const g = recap.biggestBlowout;
    highlights.push(`
      <div class="recap-card">
        <div class="recap-card-label">\ud83d\udca5 Biggest Blowout</div>
        <div class="recap-card-value"><b style="color:${g.winner.color}">${g.winner.name}</b> over ${g.loser.name}</div>
        <div class="recap-card-sub">by ${g.margin.toFixed(1)}</div>
      </div>`);
  }

  if (recap.highScore) {
    highlights.push(`
      <div class="recap-card">
        <div class="recap-card-label">\ud83d\udcc8 Highest Score</div>
        <div class="recap-card-value" style="color:${recap.highScore.team.color}"><b>${recap.highScore.team.name}</b></div>
        <div class="recap-card-sub">${recap.highScore.score.toFixed(1)} points</div>
      </div>`);
  }

  if (recap.lowScore) {
    highlights.push(`
      <div class="recap-card">
        <div class="recap-card-label">\ud83d\udcc9 Lowest Score</div>
        <div class="recap-card-value" style="color:${recap.lowScore.team.color}"><b>${recap.lowScore.team.name}</b></div>
        <div class="recap-card-sub">${recap.lowScore.score.toFixed(1)} points</div>
      </div>`);
  }

  if (recap.highestScoringMatchup) {
    const m = recap.highestScoringMatchup;
    highlights.push(`
      <div class="recap-card">
        <div class="recap-card-label">\ud83c\udfc8 Highest-Scoring Matchup</div>
        <div class="recap-card-value"><b style="color:${m.home.color}">${m.home.name}</b> vs ${m.away.name}</div>
        <div class="recap-card-sub">combined for ${m.combined.toFixed(1)} points</div>
      </div>`);
  }

  if (recap.lowestScoringMatchup) {
    const m = recap.lowestScoringMatchup;
    highlights.push(`
      <div class="recap-card">
        <div class="recap-card-label">\ud83d\udee1\ufe0f Lowest-Scoring Matchup</div>
        <div class="recap-card-value"><b style="color:${m.home.color}">${m.home.name}</b> vs ${m.away.name}</div>
        <div class="recap-card-sub">combined for just ${m.combined.toFixed(1)} points</div>
      </div>`);
  }

  if (recap.biggestOverperformer && recap.biggestOverperformer.delta > 0.5) {
    const o = recap.biggestOverperformer;
    highlights.push(`
      <div class="recap-card">
        <div class="recap-card-label">\ud83d\ude80 Biggest Overperformer</div>
        <div class="recap-card-value" style="color:${o.team.color}"><b>${o.team.name}</b></div>
        <div class="recap-card-sub">beat their pregame projection by ${o.delta.toFixed(1)} (${o.pregame.toFixed(0)} \u2192 ${o.final.toFixed(0)})</div>
      </div>`);
  }

  if (recap.biggestUnderperformer && recap.biggestUnderperformer.delta < -0.5) {
    const u = recap.biggestUnderperformer;
    highlights.push(`
      <div class="recap-card">
        <div class="recap-card-label">\ud83d\ude2c Biggest Underperformer</div>
        <div class="recap-card-value" style="color:${u.team.color}"><b>${u.team.name}</b></div>
        <div class="recap-card-sub">fell short of their pregame projection by ${Math.abs(u.delta).toFixed(1)} (${u.pregame.toFixed(0)} \u2192 ${u.final.toFixed(0)})</div>
      </div>`);
  }

  if (recap.biggestUpset) {
    const u = recap.biggestUpset;
    const value = u.isTie
      ? `<b>${u.upsetTeam.name}</b> pushed <b>${u.favorite.name}</b> to a tie`
      : u.upsetHappened
        ? `<b style="color:${u.upsetTeam.color}">${u.upsetTeam.name}</b> defeated ${u.favorite.name}`
        : `<b>${u.upsetTeam.name}</b> pushed <b>${u.favorite.name}</b>, who held on`;
    const sub = u.isTie
      ? `after ${u.favorite.name} peaked at ${Math.round(u.favoritePeak)}%`
      : u.upsetHappened
        ? `after ${u.favorite.name} reached a ${Math.round(u.favoritePeak)}% win probability${u.backAndForth ? ', in a game that swung more than once' : ''}`
        : `${u.favorite.name} peaked at ${Math.round(u.favoritePeak)}% before the scare`;
    highlights.push(`
      <div class="recap-card recap-card-featured">
        <div class="recap-card-label">\ud83d\udea8 ${u.isTie ? 'Near-Upset' : u.upsetHappened ? 'Biggest Upset' : 'Upset Threat'}</div>
        <div class="recap-card-value">${value}</div>
        <div class="recap-card-sub">${sub}</div>
      </div>`);
  } else {
    // No Upset Watch episode happened anywhere this week -- rather than
    // just showing one fewer card, this closing slot falls back to a
    // different, always-computable stat so a quiet week still fills out
    // the grid.
    highlights.push(`
      <div class="recap-card recap-card-featured">
        <div class="recap-card-label">\ud83d\udcca Total Points Scored</div>
        <div class="recap-card-value"><b>${recap.totalPointsScored.toFixed(1)}</b> combined across the league</div>
        <div class="recap-card-sub">No Upset Watch alerts this week -- a quiet one.</div>
      </div>`);
  }

  banner.innerHTML = `
    <div class="recap-title">Week Recap</div>
    <div class="recap-scores">${scoreLines}</div>
    <div class="recap-highlights">${highlights.join('')}</div>
  `;
  banner.hidden = false;
}

// Pure computation, shared by both the initial render and in-place
// refreshes. x = point INDEX, not elapsed real time -- the same technique
// stock charts use to avoid showing a giant blank gap every weekend: every
// real data point gets equal visual spacing regardless of how much actual
// time passed before it. Each point also carries both teams' actual/expected
// scores at that moment (nearest-matched by timestamp), for the tooltip.
//
// Built from the UNION of both sides' timestamps, not just home's. A team
// can stop producing new rows entirely once ALL of its own values are
// simultaneously frozen -- its own actual/expected score already locked in
// (no players left), AND its win_prob pinned to an exact, unchanging
// constant by the near-certain-win guard once the other team can no longer
// catch up. With nothing left that could change, the database's
// change-detection correctly stops inserting new rows for that side -- but
// the OTHER team's game can still be live, producing fresh rows for
// several more minutes. Walking only homeRows would make the whole chart
// stall at whatever moment home went fully static, even while away kept
// recording real, fresh data. Walking the union keeps the chart advancing
// as long as EITHER side still has something new to show.
function computeChartPoints(homeRows, awayRows) {
  const allTimestamps = Array.from(new Set([...homeRows.map((r) => r.ts), ...awayRows.map((r) => r.ts)])).sort(
    (a, b) => new Date(a) - new Date(b)
  );

  const rawPoints = allTimestamps
    .map((ts, i) => {
      const homeRow = nearestByTs(homeRows, ts);
      const awayRow = nearestByTs(awayRows, ts);
      return {
        x: i,
        y: homeRow?.win_prob,
        ts,
        homeActual: homeRow?.actual_score,
        homeExpected: homeRow?.expected_score,
        awayActual: awayRow?.actual_score,
        awayExpected: awayRow?.expected_score,
      };
    })
    .filter((p) => p.y !== undefined); // safety: skip if somehow neither side has data yet
  const points = withCrossings(rawPoints);

  // The real data's x-range -- used to pin the x-axis min/max explicitly
  // (see renderLineChartCard) instead of letting Chart.js auto-calculate a
  // "nice" rounded range, which can leave a visible gap after the last real
  // point on a matchup with fewer polls than others, making charts with
  // different amounts of history look inconsistently sized next to each
  // other even though they're all meant to fill the same width edge-to-edge.
  const maxX = rawPoints.length ? rawPoints[rawPoints.length - 1].x : 0;

  return { points, rawPoints, maxX };
}

function midY(segCtx) { return (segCtx.p0.parsed.y + segCtx.p1.parsed.y) / 2; }

// Builds the two vertical fill gradients used under the win-probability
// line: for the home side, fully saturated at the very top of the chart
// (100%) fading down to nearly transparent at the 50% line; for away,
// the mirror image anchored at the bottom (0%). This replaces an earlier
// version that picked a single FLAT alpha per line segment based on how
// far that segment's value was from 50 -- which produced a blocky,
// stepped look tied to the line's shape. A true canvas gradient instead
// anchors its fade to fixed positions on the Y-AXIS itself, independent
// of the line's value at any given x, so the fill looks like a smooth,
// continuous wash regardless of how the line moves -- and it's still
// naturally "cropped" to only the leading side, since Chart.js only ever
// paints this fill between the line and the 50-value baseline in the
// first place (see the `fill: { target: { value: 50 } }` dataset option
// wherever this is used).
//
// Cached on the chart instance and only rebuilt when the chart area or
// colors actually change (resize, theme swap), rather than recreated on
// every one of Chart.js's many per-segment callback invocations.
function getBandGradients(chart, homeColor, awayColor) {
  const area = chart.chartArea;
  if (!area) return null;
  const midPixelY = chart.scales.y.getPixelForValue(50);
  const cacheKey = `${area.top}|${area.bottom}|${midPixelY}|${homeColor}|${awayColor}`;
  if (chart._bandGradientCache && chart._bandGradientCache.key === cacheKey) {
    return chart._bandGradientCache;
  }
  const ctx = chart.ctx;
  const homeGradient = ctx.createLinearGradient(0, area.top, 0, midPixelY);
  homeGradient.addColorStop(0, colorWithAlpha(homeColor, 0.34));
  homeGradient.addColorStop(1, colorWithAlpha(homeColor, 0.02));
  const awayGradient = ctx.createLinearGradient(0, midPixelY, 0, area.bottom);
  awayGradient.addColorStop(0, colorWithAlpha(awayColor, 0.02));
  awayGradient.addColorStop(1, colorWithAlpha(awayColor, 0.34));
  const cache = { key: cacheKey, home: homeGradient, away: awayGradient };
  chart._bandGradientCache = cache;
  return cache;
}

// Builds a vertical canvas gradient for a chart segment's win-probability
// fill -- fully colored at that team's own 100% (the top of the chart
// for home, the bottom for away, since the shared y-axis is always
// home's own percentage), fading to fully transparent by the 50% line.
// Replaces the old approach (a flat color whose ALPHA scaled with each
// segment's distance from 50), which could look mottled or banded on a
// choppy line -- lots of small segments, each independently landing on
// a slightly different alpha, rather than one smooth continuous fade.
// Computed fresh from the chart's current y-scale pixel mapping every
// time a segment is drawn: CanvasGradient objects are cheap to create,
// and the scale's pixel layout isn't actually known until Chart.js is
// mid-render anyway, so there's no earlier point this could be
// precomputed once and cached.
function segmentFillGradient(segmentCtx, homeColor, awayColor) {
  const chart = segmentCtx.chart;
  const yScale = chart.scales.y;
  const above = midY(segmentCtx) >= 50;
  const color = above ? homeColor : awayColor;
  const yEdge = yScale.getPixelForValue(above ? 100 : 0);
  const yMid = yScale.getPixelForValue(50);
  const gradient = chart.ctx.createLinearGradient(0, yEdge, 0, yMid);
  gradient.addColorStop(0, colorWithAlpha(color, 0.38));
  gradient.addColorStop(1, colorWithAlpha(color, 0));
  return gradient;
}

function latestPct(rows) {
  const homeRow = rows.filter((r) => r.is_home).sort((a, b) => new Date(b.ts) - new Date(a.ts))[0];
  return homeRow ? homeRow.win_prob : 50;
}

function latestRow(rows, isHome) {
  return rows.filter((r) => r.is_home === isHome).sort((a, b) => new Date(b.ts) - new Date(a.ts))[0];
}

// ============================== KICKOFF COUNTDOWN ==============================
// Shows a countdown to the CURRENT week's first kickoff, disappears once
// that kickoff has happened, then reappears counting down to the NEXT
// week's first kickoff once every matchup in the current week is Final.
//
// The frontend has never had access to real NFL kickoff times -- that
// data only ever existed inside the poller's own logic (see
// poller/lib/espnClient.js's fetchNflGameStatusMap), computed in memory
// and never persisted to Supabase. Rather than change the poller, this
// calls ESPN's PUBLIC scoreboard endpoint directly from the browser --
// the same one the poller itself uses, and the exact same "earliest
// kickoff across every event that week" computation, so a Wednesday
// opener or any other unusual scheduling is handled identically to how
// the poller's own plotting-window gate handles it. This endpoint needs
// no league cookies (unlike the private fantasy API), but if it ever
// blocks cross-origin browser requests, every failure path below just
// hides the countdown rather than surfacing an error -- this is a
// nice-to-have, not core functionality.
const NFL_SCOREBOARD_URL = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';
const weekStartCache = {}; // `${year}-${week}` -> Date | null

async function fetchWeekStart(year, week) {
  const cacheKey = `${year}-${week}`;
  if (cacheKey in weekStartCache) return weekStartCache[cacheKey];
  try {
    const res = await fetch(`${NFL_SCOREBOARD_URL}?year=${year}&week=${week}&seasontype=2`);
    if (!res.ok) throw new Error(`ESPN scoreboard ${res.status}`);
    const data = await res.json();
    let weekStart = null;
    for (const event of data.events || []) {
      if (!event.date) continue;
      const eventDate = new Date(event.date);
      if (!isNaN(eventDate) && (!weekStart || eventDate < weekStart)) weekStart = eventDate;
    }
    weekStartCache[cacheKey] = weekStart;
    return weekStart;
  } catch (err) {
    console.warn('Could not fetch NFL schedule for kickoff countdown:', err.message);
    weekStartCache[cacheKey] = null;
    return null;
  }
}

function formatCountdown(msRemaining) {
  if (msRemaining <= 0) return null;
  const totalSeconds = Math.floor(msRemaining / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`; // final minute -- just the seconds, no redundant "0m" prefix
}

// Same completion check the weekly recap and bye-week note already use --
// every matchup's both sides must have all_starters_done, or an empty
// week (no data at all, e.g. still waiting for the plotting window to
// open) counts as "not done" so the countdown correctly targets the
// current week rather than jumping ahead to the next one.
function isWeekFullyDone(byMatchup) {
  const matchupIds = Object.keys(byMatchup);
  if (!matchupIds.length) return false;
  return matchupIds.every((id) => {
    const rows = byMatchup[id];
    const homeLatest = latestRow(rows, true);
    const awayLatest = latestRow(rows, false);
    return !!(homeLatest?.all_starters_done && awayLatest?.all_starters_done);
  });
}

let kickoffCountdownTarget = null; // Date | null
let kickoffCountdownLabel = '';

const KICKOFF_IMMINENT_MS = 60 * 60 * 1000; // 1 hour -- matches #kickoffCountdown.imminent in index.html
const KICKOFF_FINAL_MINUTE_MS = 60 * 1000; // 1 minute -- matches #kickoffCountdown.final-minute in index.html

function tickKickoffCountdown() {
  const el = document.getElementById('kickoffCountdown');
  if (!el) return;
  if (!kickoffCountdownTarget) {
    el.hidden = true;
    el.classList.remove('imminent', 'final-minute');
    return;
  }
  const remaining = kickoffCountdownTarget.getTime() - Date.now();
  const formatted = formatCountdown(remaining);
  if (!formatted) {
    // Kickoff has arrived (or passed) since this was last checked -- hide
    // immediately rather than show a stale "0m 0s" or a negative countdown.
    kickoffCountdownTarget = null;
    el.hidden = true;
    el.classList.remove('imminent', 'final-minute');
    return;
  }
  el.innerHTML = `<span class="kickoff-label">${kickoffCountdownLabel}</span>${formatted}`;
  // Starts pulsing in the final hour, then gets a bigger, faster pulse in
  // the final minute specifically (see .imminent / .final-minute in
  // index.html) -- CSS handles the actual visuals, including the
  // reduced-motion override, so this is just responsible for toggling
  // the classes at the right moments.
  el.classList.toggle('imminent', remaining <= KICKOFF_IMMINENT_MS);
  el.classList.toggle('final-minute', remaining <= KICKOFF_FINAL_MINUTE_MS);
  el.hidden = false;
}

// Only meaningful when looking at the CURRENT/latest year+week -- browsing
// an older week via the dropdowns shouldn't show a countdown to some
// kickoff that (relative to "now") may already be long past. selectedIndex
// 0 is always the most recent option in both dropdowns, since they're
// populated in descending order (see loadYearsWeeks).
async function updateKickoffCountdown(byMatchup, year, week) {
  if (yearSelect.selectedIndex !== 0 || weekSelect.selectedIndex !== 0) {
    kickoffCountdownTarget = null;
    tickKickoffCountdown();
    return;
  }

  const weekDone = isWeekFullyDone(byMatchup);
  const targetWeek = weekDone ? week + 1 : week;
  const weekStart = await fetchWeekStart(year, targetWeek);

  if (!weekStart || Date.now() >= weekStart.getTime()) {
    kickoffCountdownTarget = null;
    tickKickoffCountdown();
    return;
  }

  kickoffCountdownTarget = weekStart;
  kickoffCountdownLabel = `Week ${targetWeek} kicks off in`;
  tickKickoffCountdown();
}

// Plain-language "why is this the number" sentence, built entirely from
// aggregate data already on the page (each team's current actual/expected
// score and win_prob) -- no per-player roster data is fetched by the
// frontend, so this deliberately stays at the team level rather than trying
// to name specific players. When the "Full detail" tooltip preference is
// set (see preferences.html), a few extra lines of concrete numbers get
// appended below the sentence -- reusing that existing preference rather
// than adding a new one, since it's already exactly about "how much
// numeric detail do you want to see."
function explainMatchup(rows, home, away, allDone) {
  const homeRow = latestRow(rows, true);
  const awayRow = latestRow(rows, false);
  if (!homeRow || !awayRow) return 'Not enough data yet to explain this matchup.';

  let sentence;
  if (allDone) {
    if (homeRow.actual_score === awayRow.actual_score) {
      sentence = 'Final: this one ended in an exact tie.';
    } else {
      const homeWon = homeRow.actual_score > awayRow.actual_score;
      const winner = homeWon ? home : away, loser = homeWon ? away : home;
      const margin = Math.abs(homeRow.actual_score - awayRow.actual_score).toFixed(1);
      sentence = `Final: ${winner.name} beat ${loser.name} by ${margin} points.`;
    }
  } else {
    const homePct = homeRow.win_prob;
    const homeFavored = homePct >= 50;
    const favored = homeFavored ? home : away;
    const underdog = homeFavored ? away : home;
    const favoredPct = Math.round(homeFavored ? homePct : 100 - homePct);

    if (favoredPct < 55) {
      sentence = `Toss-up right now -- ${home.name} and ${away.name} are projected within a few points of each other.`;
    } else {
      const actualMargin = Math.abs(homeRow.actual_score - awayRow.actual_score);
      const favoredRow = homeFavored ? homeRow : awayRow;
      const underdogRow = homeFavored ? awayRow : homeRow;
      const favoredIsAhead = favoredRow.actual_score >= underdogRow.actual_score;
      const favoredRemaining = Math.max(favoredRow.expected_score - favoredRow.actual_score, 0);
      const underdogRemaining = Math.max(underdogRow.expected_score - underdogRow.actual_score, 0);
      const favoredMoreLockedIn = favoredRemaining <= underdogRemaining;

      if (actualMargin < 0.5) {
        sentence = `${home.name} and ${away.name} are even on the scoreboard right now, but ${favored.name} is favored with ${favoredMoreLockedIn ? 'fewer points left on the table' : 'a stronger projection the rest of the way'}.`;
      } else if (favoredIsAhead && favoredMoreLockedIn) {
        sentence = `${favored.name} leads by ${actualMargin.toFixed(1)} and has more points already locked in, leaving ${underdog.name} less room to catch up.`;
      } else if (favoredIsAhead && !favoredMoreLockedIn) {
        sentence = `${favored.name} leads by ${actualMargin.toFixed(1)} right now, and still has more projected points left to add too.`;
      } else if (!favoredIsAhead && favoredMoreLockedIn) {
        sentence = `${underdog.name} leads by ${actualMargin.toFixed(1)} right now, but ${favored.name} has fewer points left on the table and is favored to finish ahead.`;
      } else {
        sentence = `${underdog.name} leads by ${actualMargin.toFixed(1)} right now, but ${favored.name} is favored with more projected points still to come.`;
      }
    }
  }

  return sentence;
}

// 15-minute-window win_prob delta for one team's own sorted rows -- only
// used to add a "Momentum" line to the Full-detail why-blurb above.
// Positive delta = home gained ground; negative = away did.
function computeRecentMomentum(sortedHomeRows) {
  if (sortedHomeRows.length < 2) return null;
  const latest = sortedHomeRows[sortedHomeRows.length - 1];
  const targetTs = new Date(new Date(latest.ts).getTime() - 15 * 60 * 1000).toISOString();
  const past = nearestByTs(sortedHomeRows, targetTs);
  if (!past || past === latest) return null;
  const delta = latest.win_prob - past.win_prob;
  if (Math.abs(delta) < 3) return null; // too small to be worth mentioning
  return { delta };
}

function wireWhyButton(card) {
  const btn = card.querySelector('.why-btn');
  const blurb = card.querySelector('.why-blurb');
  if (!btn || !blurb) return;
  btn.addEventListener('click', () => { blurb.hidden = !blurb.hidden; });
}

// ============================== TIMELINE + POSTCARD VIEWS ==============================
// Both render the exact same win-probability line chart -- Postcard is just
// the compact, gridded version. Kept as one shared implementation so they
// can never visually drift out of sync with each other.

// Shared by both Timeline (full size) and Postcard (compact grid) --
// they're the exact same win-probability line chart, just sized and
// labeled differently. `compact` hides axis ticks/labels to keep the grid
// tile clean, but keeps the 50% reference line since that's meaningful
// (marks the crossing point), not just decoration.
function renderLineChartCard(rows, home, away, allDone, compact) {
  const card = document.createElement('div');
  card.className = compact ? 'postcard' : 'matchup-card';
  const titleClass = compact ? 'postcard-title' : 'matchup-title';
  const chartBoxClass = compact ? 'postcard-chartBox' : 'chartBox';
  const isLive = !allDone && isRecentlyActive(rows);
  const upsetInfo = getLiveUpsetInfo(rows, home, away, allDone);
  if (upsetInfo) { card.classList.add('upset-watch'); applyUpsetColor(card, upsetInfo.upsetTeam.color); }
  card.innerHTML = `
    <div class="upset-watch-badge${upsetInfo ? ' visible pulsing' : ''}">\ud83d\udea8 UPSET WATCH</div>
    <div class="${titleClass}">
      <span><b style="color:${home.color}">${home.name}</b> vs <b style="color:${away.color}">${away.name}</b>
        <button class="why-btn" type="button" title="Why is this the number?">\u24d8</button>
      </span>
      <span class="${isLive ? 'live' : ''}">${allDone ? 'Final' : '\u25CF Live'}</span>
    </div>
    <div class="why-blurb" hidden>${explainMatchup(rows, home, away, allDone)}</div>
    <div class="${chartBoxClass}"><canvas></canvas></div>
  `;
  wireWhyButton(card);

  const homeRows = rows.filter((s) => s.is_home).sort((a, b) => new Date(a.ts) - new Date(b.ts));
  const awayRows = rows.filter((s) => !s.is_home).sort((a, b) => new Date(a.ts) - new Date(b.ts));
  if (!homeRows.length) return { card, entry: null };

  const { points, rawPoints, maxX } = computeChartPoints(homeRows, awayRows);
  // Confidence band never applies to Postcard (compact) -- only Timeline.
  const showBandHere = showConfidenceBand && !compact;
  const mainIdx = showBandHere ? 2 : 0;
  const state = { mainIdx };
  const canvas = card.querySelector('canvas');

  const lineDatasets = [];
  if (showBandHere) {
    const band = computeConfidenceBand(rawPoints);
    const upperIdx = lineDatasets.length;
    lineDatasets.push({
      data: band.upper,
      parsing: false, borderWidth: 0, pointRadius: 0, tension: 0.15, fill: false,
    });
    lineDatasets.push({
      data: band.lower,
      parsing: false, borderWidth: 0, pointRadius: 0, tension: 0.15,
      fill: { target: upperIdx },
      backgroundColor: themeVar('rgba(120,120,120,0.14)', 'rgba(210,210,210,0.12)'),
    });
  }

  const chart = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: {
      datasets: [...lineDatasets, {
        data: points,
        parsing: false,
        borderWidth: compact ? 1.5 : 2,
        pointRadius: 0,
        tension: 0.15,
        fill: { target: { value: 50 } },
        segment: {
          borderColor: (c) => (midY(c) >= 50 ? home.color : away.color),
          backgroundColor: (c) => {
            const gradients = getBandGradients(c.chart, home.color, away.color);
            if (!gradients) return 'transparent';
            return midY(c) >= 50 ? gradients.home : gradients.away;
          },
        },
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          // Excludes the confidence band's two datasets (when present)
          // from the tooltip entirely -- without this, hovering would
          // show three lines (upper bound, lower bound, actual line)
          // instead of just the one meaningful value.
          filter: (tooltipItem) => tooltipItem.datasetIndex === mainIdx,
          callbacks: {
            label: (item) => {
              const above = item.parsed.y >= 50;
              const team = above ? home.name : away.name;
              const pct = above ? item.parsed.y : 100 - item.parsed.y;
              return `${team}: ${Math.round(pct)}%`;
            },
          },
        },
      },
      scales: {
        y: {
          min: 0, max: 100,
          grid: {
            color: (c) => (c.tick.value === 50 ? themeVar('#999', '#888') : themeVar('rgba(0,0,0,0.06)', 'rgba(255,255,255,0.08)')),
            lineWidth: (c) => (c.tick.value === 50 ? 1.5 : 1),
          },
          ticks: compact ? { display: false } : { callback: (v) => (v === 0 || v === 50 || v === 100 ? v : ''), color: themeVar('#555', '#aaa') },
        },
        x: {
          type: 'linear',
          // Explicit min/max instead of letting Chart.js auto-calculate a
          // "nice" rounded range -- otherwise a matchup with fewer polls so
          // far can end up with visible blank space after its last real
          // point, making charts with different amounts of history look
          // inconsistently sized rather than all filling their full width.
          min: 0,
          max: maxX,
          grid: { display: !compact, color: themeVar('rgba(0,0,0,0.06)', 'rgba(255,255,255,0.08)') },
          // No x-axis labels -- the old day-of-week text (e.g. "Sun") was
          // tied to a since-replaced model and no longer means anything
          // useful here. Grid lines are unaffected, controlled separately
          // by the grid.display setting just above.
          ticks: { display: false },
        },
      },
    },
  });
  chart._state = state;

  return { card, entry: { mode: compact ? 'postcard' : 'timeline', chart, titleClass } };
}

function updateLineChartCard(entry, rows, home, away, allDone) {
  const homeRows = rows.filter((s) => s.is_home).sort((a, b) => new Date(a.ts) - new Date(b.ts));
  const awayRows = rows.filter((s) => !s.is_home).sort((a, b) => new Date(a.ts) - new Date(b.ts));
  if (!homeRows.length || !entry.chart) return;

  const { points, rawPoints, maxX } = computeChartPoints(homeRows, awayRows);
  const mainIdx = entry.chart._state.mainIdx;
  entry.chart.data.datasets[mainIdx].data = points;
  if (mainIdx > 0) {
    // This card has the confidence band (Timeline only, never Postcard --
    // mainIdx is 0 there since showBandHere was false at render time).
    const band = computeConfidenceBand(rawPoints);
    entry.chart.data.datasets[0].data = band.upper;
    entry.chart.data.datasets[1].data = band.lower;
  }
  entry.chart.options.scales.x.max = maxX; // keep the pinned axis in sync as new points arrive
  entry.chart.update('none');

  const badge = entry.chart.canvas.closest('.matchup-card, .postcard')?.querySelector(`.${entry.titleClass} span:last-child`);
  if (badge) {
    badge.textContent = allDone ? 'Final' : '\u25CF Live';
    badge.className = (!allDone && isRecentlyActive(rows)) ? 'live' : '';
  }

  const blurb = entry.chart.canvas.closest('.matchup-card, .postcard')?.querySelector('.why-blurb');
  if (blurb) blurb.textContent = explainMatchup(rows, home, away, allDone);

  const card = entry.chart.canvas.closest('.matchup-card, .postcard');
  const upsetInfo = getLiveUpsetInfo(rows, home, away, allDone);
  if (card) {
    card.classList.toggle('upset-watch', !!upsetInfo);
    if (upsetInfo) applyUpsetColor(card, upsetInfo.upsetTeam.color);
    const upsetBadge = card.querySelector('.upset-watch-badge');
    if (upsetBadge) {
      upsetBadge.classList.toggle('visible', !!upsetInfo);
      upsetBadge.classList.toggle('pulsing', !!upsetInfo);
    }
  }
}

function renderTimelineCard(rows, home, away, allDone) {
  return renderLineChartCard(rows, home, away, allDone, false);
}
function renderPostcardCard(rows, home, away, allDone) {
  return renderLineChartCard(rows, home, away, allDone, true);
}
const updateTimelineCard = updateLineChartCard;
const updatePostcardCard = updateLineChartCard;

// ============================== NEEDLE VIEW ==============================
// A semicircle gauge, styled after election-night "needle" charts: bands

// from VERY LIKELY through TOSSUP, with a needle pointing at the current
// win probability. Uses each matchup's own team colors rather than a fixed
// blue/red scheme, so it stays consistent with the rest of the site.

const NEEDLE_BANDS = [
  { min: 0, max: 20, label: 'VERY LIKELY' },
  { min: 20, max: 35, label: 'LIKELY' },
  { min: 35, max: 45, label: 'LEANING' },
  { min: 45, max: 55, label: 'TOSSUP' },
  { min: 55, max: 65, label: 'LEANING' },
  { min: 65, max: 80, label: 'LIKELY' },
  { min: 80, max: 100, label: 'VERY LIKELY' },
];
const NEEDLE_CX = 120, NEEDLE_CY = 120, NEEDLE_R_OUTER = 110, NEEDLE_R_INNER = 78, NEEDLE_R_LABEL = 94;

function pctToAngle(pct) { return 180 - (pct / 100) * 180; }
function polarToXY(cx, cy, r, angleDeg) {
  const rad = (angleDeg * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy - r * Math.sin(rad) };
}
function describeBandPath(angleStart, angleEnd) {
  const p1 = polarToXY(NEEDLE_CX, NEEDLE_CY, NEEDLE_R_OUTER, angleStart);
  const p2 = polarToXY(NEEDLE_CX, NEEDLE_CY, NEEDLE_R_OUTER, angleEnd);
  const p3 = polarToXY(NEEDLE_CX, NEEDLE_CY, NEEDLE_R_INNER, angleEnd);
  const p4 = polarToXY(NEEDLE_CX, NEEDLE_CY, NEEDLE_R_INNER, angleStart);
  return `M ${p1.x.toFixed(2)} ${p1.y.toFixed(2)} A ${NEEDLE_R_OUTER} ${NEEDLE_R_OUTER} 0 0 1 ${p2.x.toFixed(2)} ${p2.y.toFixed(2)} ` +
    `L ${p3.x.toFixed(2)} ${p3.y.toFixed(2)} A ${NEEDLE_R_INNER} ${NEEDLE_R_INNER} 0 0 0 ${p4.x.toFixed(2)} ${p4.y.toFixed(2)} Z`;
}

// ============================== FORECASTING CONTENT ==============================
// The Needle view's content beyond the gauge itself: a projected final
// score range for each team, how many points the trailing team needs
// beyond their own projection to take the lead, and a rough estimate of
// when the game will likely be decided. All computed from data already
// on the page -- see the FORECASTING MATH section above for how the
// underlying stddev gets recovered from the stored win_prob.
const FORECAST_CI_Z = 1.2816; // ~80% confidence interval -- wide enough to be useful, not so wide it feels meaningless

// Rough "when will this be decided" estimate: tracks how far win_prob has
// drifted from 50 (in either direction) over a recent window, and
// extrapolates forward to when that distance would reach 45 (i.e. roughly
// 95%/5%). A lead change or a stalled game naturally suppresses this
// (the distance-from-50 stops growing, or shrinks), rather than needing
// special-case handling -- it just falls out of using distance-from-50
// as the tracked quantity instead of "whoever's currently favored."
function computeTimeUntilDecided(rows) {
  const homeRows = rows.filter((r) => r.is_home).sort((a, b) => new Date(a.ts) - new Date(b.ts));
  if (homeRows.length < 3) return null;

  const latest = homeRows[homeRows.length - 1];
  const targetTs = new Date(new Date(latest.ts).getTime() - 30 * 60 * 1000).toISOString();
  const past = nearestByTs(homeRows, targetTs);
  if (!past || past === latest) return null;

  const elapsedMin = (new Date(latest.ts) - new Date(past.ts)) / 60000;
  if (elapsedMin < 5) return null; // too little elapsed time for a meaningful rate

  const latestDistance = Math.abs(latest.win_prob - 50);
  const pastDistance = Math.abs(past.win_prob - 50);
  const ratePerMin = (latestDistance - pastDistance) / elapsedMin;
  if (ratePerMin <= 0.05) return null; // not trending toward decided

  const distanceRemaining = 45 - latestDistance; // 50+/-45 = 95%/5%
  if (distanceRemaining <= 0) return null; // already basically decided

  const minutesToDecided = distanceRemaining / ratePerMin;
  if (minutesToDecided < 0 || minutesToDecided > 180) return null; // too uncertain to state

  return minutesToDecided < 60
    ? `Roughly ${Math.round(minutesToDecided)} more minutes at the current pace`
    : `Roughly ${(minutesToDecided / 60).toFixed(1)} more hours at the current pace`;
}

// Describes MODEL CERTAINTY (how much the projection could still move),
// not how close the game currently looks -- those are different axes
// that can genuinely diverge. A game can show a decisive 92% early on
// while still having high stddev (most players haven't finished, so
// that number could move a lot); calling that a "toss-up" would be
// wrong, since the CURRENT read isn't close at all -- it's just not
// locked in yet.
function confidenceLabel(stddev) {
  if (stddev <= 10) return { text: 'High confidence', color: '#4fbd82' };
  if (stddev <= 16) return { text: 'Moderate confidence', color: 'var(--warn)' };
  return { text: 'Wide open \u2014 plenty left to play', color: 'var(--muted)' };
}

// Compares the projection's confidence-interval margin at the FIRST
// recorded snapshot against the latest one -- shows how much more
// certain the model has become as the game has progressed, not just
// what the current range is.
function computeConfidenceNarrowing(rows) {
  const homeSorted = rows.filter((r) => r.is_home).sort((a, b) => new Date(a.ts) - new Date(b.ts));
  const awaySorted = rows.filter((r) => !r.is_home).sort((a, b) => new Date(a.ts) - new Date(b.ts));
  if (homeSorted.length < 3) return null;
  const first = homeSorted[0], firstAway = awaySorted[0];
  const latest = homeSorted[homeSorted.length - 1], latestAway = awaySorted[awaySorted.length - 1];
  const marginFirst = FORECAST_CI_Z * impliedStddev(first.expected_score, firstAway.expected_score, first.win_prob);
  const marginLatest = FORECAST_CI_Z * impliedStddev(latest.expected_score, latestAway.expected_score, latest.win_prob);
  if (marginLatest >= marginFirst - 2) return null; // hasn't meaningfully narrowed yet
  return { marginFirst, marginLatest };
}

// Each team's OWN peak percentage this game -- expressed on a mirrored
// 100-50-100 scale (see buildSwingBar) rather than a single 0-100 range,
// since a raw "34%-81%" range doesn't say which team either number
// belongs to. homePeak is home's best moment; awayPeak is away's best
// moment (100 minus home's worst moment, converted into away's terms).
function computeProbabilitySwing(rows) {
  const homeSorted = rows.filter((r) => r.is_home).sort((a, b) => new Date(a.ts) - new Date(b.ts));
  if (homeSorted.length < 2) return null;
  const values = homeSorted.map((r) => r.win_prob);
  const homePeak = Math.max(...values);
  const awayPeak = 100 - Math.min(...values);
  if (homePeak + awayPeak - 100 < 15) return null; // not a meaningful swing
  return { homePeak, awayPeak, current: values[values.length - 1] };
}
// Renders the swing as a diverging bar centered on 50 -- away's color
// extends left toward its own peak, home's color extends right toward
// its own peak, mirroring "100 at both ends, 50 in the middle, color
// tells you which side" -- distance from center means "how far this
// team got," color says which team, since the number alone can't.
function buildSwingBar(swing, home, away) {
  const homePeakPos = swing.homePeak;
  const awayPeakPos = 100 - swing.awayPeak;
  const currentColor = swing.current >= 50 ? home.color : away.color;
  // Clamped to 0: if one team led the ENTIRE game, the other team's own
  // "peak" is still a losing percentage (below 50) -- without this
  // clamp, that side's width computes negative (invalid CSS), since the
  // bar assumes each side's peak falls on its own half. When a team
  // never actually crossed 50%, their portion of the bar simply doesn't
  // render, rather than showing a broken negative-width sliver.
  const awayWidth = Math.max(0, 50 - awayPeakPos);
  const homeWidth = Math.max(0, homePeakPos - 50);
  return `
    <div class="fc-swing-bar">
      <div class="fc-swing-range" style="left:${awayPeakPos}%; width:${awayWidth}%; background:${colorWithAlpha(away.color, 0.55)}"></div>
      <div class="fc-swing-range" style="left:50%; width:${homeWidth}%; background:${colorWithAlpha(home.color, 0.55)}"></div>
      <div class="fc-swing-marker" style="left:${swing.current}%; background:${currentColor}"></div>
    </div>
    <div class="fc-swing-labels">
      <span style="color:${away.color}">100</span>
      <span>50</span>
      <span style="color:${home.color}">100</span>
    </div>
  `;
}

// Lead-ownership timeline for the volatility visual -- tracks average
// intensity (distance from 50%, same convention the chart fill and
// gauge bands use) per segment, not just which side was ahead, so a
// barely-ahead stretch renders faint and a blowout stretch renders
// fully saturated rather than both looking like the same flat color.
function computeLeadChangeSegments(rows) {
  const homeSorted = rows.filter((r) => r.is_home).sort((a, b) => new Date(a.ts) - new Date(b.ts));
  if (!homeSorted.length) return null;
  const segments = [];
  let side = null, startIdx = 0, intensitySum = 0;
  const pushSegment = (endIdx) => {
    const count = endIdx - startIdx;
    segments.push({ side, count, avgIntensity: intensitySum / count });
    intensitySum = 0;
  };
  homeSorted.forEach((r, i) => {
    const newSide = r.win_prob >= 50 ? 'home' : 'away';
    if (side === null) side = newSide;
    else if (newSide !== side) { pushSegment(i); startIdx = i; side = newSide; }
    intensitySum += intensity(r.win_prob);
  });
  pushSegment(homeSorted.length);
  return { segments, changes: segments.length - 1, total: homeSorted.length };
}

// How close the currently-armed favorite is to actually triggering an
// Upset Watch alert -- reuses the REAL walkUpsetState thresholds rather
// than approximating them. Only surfaces once genuinely close (55%+ of
// the way from arm to trigger), not the instant something arms, and
// never alongside an ALREADY-triggered alert (watch===true), which gets
// its own separate badge/border treatment elsewhere on this same card.
// Distance is always measured against UPSET_ARM_TRIGGER_GAP (a constant
// 25 points), regardless of how high the actual peak was -- a team that
// peaked at 99% and a team that peaked at 85% are each exactly as close
// to their OWN trigger once they've each fallen 25 points from their own
// peak, even though their current percentages differ.
function computeUpsetProximity(rows) {
  const homeSorted = rows.filter((r) => r.is_home).sort((a, b) => new Date(a.ts) - new Date(b.ts));
  if (homeSorted.length < 2) return null;
  const { armed, watch, peak } = walkUpsetState(homeSorted.map((r) => r.win_prob));
  if (!armed || watch || peak === null) return null;
  const currentHomePct = homeSorted[homeSorted.length - 1].win_prob;
  const currentFavoritePct = armed === 'home' ? currentHomePct : 100 - currentHomePct;
  const triggerFloor = peak - UPSET_ARM_TRIGGER_GAP;
  const proximityPct = Math.max(0, Math.min(100, ((peak - currentFavoritePct) / UPSET_ARM_TRIGGER_GAP) * 100));
  if (proximityPct < 55) return null;
  return { favoriteSide: armed, currentFavoritePct, proximityPct, peakPct: peak, triggerPct: triggerFloor };
}

function buildForecastSection(rows, home, away, allDone) {
  const homeRow = latestRow(rows, true);
  const awayRow = latestRow(rows, false);
  if (!homeRow || !awayRow) return '';

  const homeRowsSorted = rows.filter((r) => r.is_home).sort((a, b) => new Date(a.ts) - new Date(b.ts));

  // Upset Watch note -- the same tie-aware three-way distinction (actual
  // upset / tie / favorite held on) the weekly recap and "why" blurb use
  // elsewhere, scanned across this matchup's full history regardless of
  // live/Final state.
  function buildUpsetNote() {
    const { episodes } = walkUpsetState(homeRowsSorted.map((r) => r.win_prob));
    if (!episodes.length) return '';
    const topEpisode = episodes.reduce((best, e) => (!best || e.peakFavoritePct > best.peakFavoritePct ? e : best), null);
    const favoriteTeam = topEpisode.favoriteSide === 'home' ? home : away;
    const upsetTeam = topEpisode.upsetSide === 'home' ? home : away;
    let note;
    if (allDone) {
      const isTie = homeRow.actual_score === awayRow.actual_score;
      const winner = isTie ? null : (homeRow.actual_score > awayRow.actual_score ? home : away);
      if (isTie) {
        note = `This game ended in a tie after ${favoriteTeam.name} peaked at ${Math.round(topEpisode.peakFavoritePct)}% -- ${upsetTeam.name} pushed it all the way there.`;
      } else if (winner === upsetTeam) {
        note = `This was an Upset Watch game: ${upsetTeam.name} came back after ${favoriteTeam.name} peaked at ${Math.round(topEpisode.peakFavoritePct)}%.`;
      } else {
        note = `Upset Watch triggered mid-game (${favoriteTeam.name} peaked at ${Math.round(topEpisode.peakFavoritePct)}%), but ${favoriteTeam.name} held on.`;
      }
    } else {
      note = `This game has seen an Upset Watch alert, after ${favoriteTeam.name} peaked at ${Math.round(topEpisode.peakFavoritePct)}% win probability.`;
    }
    return `<div class="fc-full-tile"><div class="fc-tile-label">Upset Watch</div><div class="fc-tile-note">${note}</div></div>`;
  }

  if (allDone) {
    return `<div class="forecast-section">
      <div class="fc-tile-grid">
        <div class="fc-tile" style="flex-basis:100%">
          <div class="fc-tile-label">Final</div>
          <div class="fc-tile-row"><span style="color:${home.color}">${home.name}</span><b>${homeRow.actual_score.toFixed(1)}</b></div>
          <div class="fc-tile-row"><span style="color:${away.color}">${away.name}</span><b>${awayRow.actual_score.toFixed(1)}</b></div>
        </div>
      </div>
      ${buildUpsetNote()}
    </div>`;
  }

  const stddev = impliedStddev(homeRow.expected_score, awayRow.expected_score, homeRow.win_prob);
  const margin = FORECAST_CI_Z * stddev;

  // A side that's individually done (even if the matchup overall isn't,
  // since the other side can still be live) has zero remaining
  // uncertainty of its own -- show its actual score as fixed rather than
  // a fake range around a number that isn't going to move.
  const rangeFor = (row) => {
    if (row.all_starters_done) return `${row.actual_score.toFixed(0)} <span class="fc-tile-range">(locked in)</span>`;
    const low = Math.max(row.actual_score, row.expected_score - margin);
    const high = row.expected_score + margin;
    return `${row.expected_score.toFixed(0)} <span class="fc-tile-range">(${low.toFixed(0)}-${high.toFixed(0)})</span>`;
  };

  const homeFavored = homeRow.win_prob >= 50;
  const favored = homeFavored ? home : away;
  const trailing = homeFavored ? away : home;
  const pointsNeeded = Math.abs(homeRow.expected_score - awayRow.expected_score);

  const decidedEstimate = computeTimeUntilDecided(rows);
  const momentum = computeRecentMomentum(homeRowsSorted);
  const narrowing = computeConfidenceNarrowing(rows);
  const swing = computeProbabilitySwing(rows);
  const leadChanges = computeLeadChangeSegments(rows);
  const proximity = computeUpsetProximity(rows);

  const gridTiles = [
    `<div class="fc-tile">
      <div class="fc-tile-label">Projected Final Score</div>
      <div class="fc-tile-row"><span style="color:${home.color}">${home.name}</span><b>${rangeFor(homeRow)}</b></div>
      <div class="fc-tile-row"><span style="color:${away.color}">${away.name}</span><b>${rangeFor(awayRow)}</b></div>
    </div>`,
    `<div class="fc-tile">
      <div class="fc-tile-label">Points Needed</div>
      <div class="fc-tile-note">${trailing.name} needs about ${pointsNeeded.toFixed(1)} more points than currently projected to take the lead over ${favored.name}.</div>
    </div>`,
  ];
  if (momentum) {
    gridTiles.push(`<div class="fc-tile">
      <div class="fc-tile-label">Momentum</div>
      <div class="fc-tile-note">${(momentum.delta > 0 ? home : away).name} +${Math.abs(momentum.delta).toFixed(1)}% win probability in the last ~15 min.</div>
    </div>`);
  }
  if (narrowing) {
    gridTiles.push(`<div class="fc-tile">
      <div class="fc-tile-label">Confidence Narrowing</div>
      <div class="fc-tile-note">\u00b1${narrowing.marginFirst.toFixed(0)} pregame &rarr; <b>\u00b1${narrowing.marginLatest.toFixed(0)} now</b></div>
    </div>`);
  }

  let volatilityHtml = '';
  if (leadChanges) {
    const segHtml = leadChanges.segments.map((s) => {
      const color = s.side === 'home' ? home.color : away.color;
      const alpha = 0.15 + s.avgIntensity * 0.65;
      return `<div class="seg" style="width:${(s.count / leadChanges.total * 100).toFixed(1)}%; background:${colorWithAlpha(color, alpha)}"></div>`;
    }).join('');
    let cum = 0;
    const flipHtml = leadChanges.segments.slice(0, -1).map((s) => { cum += s.count / leadChanges.total * 100; return `<div class="flip" style="left:${cum.toFixed(1)}%"></div>`; }).join('');
    volatilityHtml = `<div class="fc-full-tile">
      <div class="fc-tile-label">Volatility</div>
      <div class="fc-timeline">${segHtml}${flipHtml}</div>
      <div class="fc-timeline-caption">${leadChanges.changes} lead change${leadChanges.changes === 1 ? '' : 's'}${leadChanges.changes >= 3 ? ' \u2014 this one has gone back and forth all game.' : leadChanges.changes === 0 ? ' \u2014 one team has led wire to wire.' : '.'}</div>
    </div>`;
  }

  let swingHtml = '';
  if (swing) {
    swingHtml = `<div class="fc-full-tile">
      <div class="fc-tile-label">Probability Swing</div>
      ${buildSwingBar(swing, home, away)}
      <div class="fc-timeline-caption"><span style="color:${home.color}">${home.name}</span> peaked at ${swing.homePeak.toFixed(0)}%, <span style="color:${away.color}">${away.name}</span> peaked at ${swing.awayPeak.toFixed(0)}%.</div>
    </div>`;
  }

  let primedHtml = '';
  if (proximity) {
    const favTeam = proximity.favoriteSide === 'home' ? home : away;
    const upsetTeam = proximity.favoriteSide === 'home' ? away : home;
    primedHtml = `<div class="fc-primed">
      <div class="fc-primed-label">\u26a0 One Push From Upset Watch</div>
      <div class="fc-tile-note"><b>${upsetTeam.name}</b> is closing in on triggering an alert against <b>${favTeam.name}</b>.</div>
      <div class="fc-meter"><div class="fc-meter-fill" style="width:${proximity.proximityPct.toFixed(0)}%"></div><div class="fc-meter-marker" style="left:${proximity.proximityPct.toFixed(0)}%"></div></div>
      <div class="fc-meter-labels"><span>Peaked at ${proximity.peakPct.toFixed(0)}%</span><span>Triggers at ${proximity.triggerPct.toFixed(0)}%</span></div>
    </div>`;
  }

  const decidedHtml = decidedEstimate
    ? `<div class="fc-full-tile"><div class="fc-tile-label">Time Until Likely Decided</div><div class="fc-tile-note">${decidedEstimate} (rough estimate).</div></div>`
    : '';

  return `
    <div class="forecast-section">
      <div class="fc-tile-grid">${gridTiles.join('')}</div>
      ${volatilityHtml}
      ${swingHtml}
      ${primedHtml}
      ${decidedHtml}
      ${buildUpsetNote()}
    </div>
  `;
}

function needleVerdict(homePct, home, away) {
  const side = homePct >= 50 ? home : away;
  const pct = homePct >= 50 ? homePct : 100 - homePct;
  if (pct >= 95) return { text: `${side.name} wins`, color: side.color };
  if (pct >= 80) return { text: `Very likely ${side.name}`, color: side.color };
  if (pct >= 65) return { text: `Likely ${side.name}`, color: side.color };
  if (pct >= 55) return { text: `Leaning ${side.name}`, color: side.color };
  return { text: 'Toss-up', color: themeVar('#666', '#aaa') };
}

function buildNeedleSvg(home, away) {
  // Bands are colored by side: bands with max <= 50 are "away" side
  // (shaded with away's color), bands with min >= 50 are "home" side.
  const bandStroke = themeVar('#fff', '#1c1f24');
  const labelFill = themeVar('#555', '#aaa');
  const pointerColor = themeVar('#333', '#e8e8e8');

  const bandPaths = NEEDLE_BANDS.map((band) => {
    const isHomeSide = band.min >= 50;
    const rgb = isHomeSide ? home.color : away.color;
    // Distance-from-center drives shade intensity, same convention as the
    // timeline view's fill.
    const mid = (band.min + band.max) / 2;
    const alpha = 0.08 + intensity(mid) * 0.55;
    const d = describeBandPath(pctToAngle(band.min), pctToAngle(band.max));
    const labelAngle = pctToAngle(mid);
    const labelPos = polarToXY(NEEDLE_CX, NEEDLE_CY, NEEDLE_R_LABEL, labelAngle);
    return `
      <path d="${d}" fill="${colorWithAlpha(rgb, alpha)}" stroke="${bandStroke}" stroke-width="1"></path>
      <text x="${labelPos.x.toFixed(2)}" y="${labelPos.y.toFixed(2)}" font-size="8" fill="${labelFill}" text-anchor="middle">${band.label}</text>
    `;
  }).join('');

  return `
    <svg viewBox="0 0 240 150" class="needle-svg">
      ${bandPaths}
      <line class="needle-pointer" x1="${NEEDLE_CX}" y1="${NEEDLE_CY}" x2="${NEEDLE_CX}" y2="${NEEDLE_CY - NEEDLE_R_OUTER + 4}"
            stroke="${pointerColor}" stroke-width="3" stroke-linecap="round"
            style="transform-origin: ${NEEDLE_CX}px ${NEEDLE_CY}px;"></line>
      <circle cx="${NEEDLE_CX}" cy="${NEEDLE_CY}" r="6" fill="${pointerColor}"></circle>
    </svg>
  `;
}

function needleRotationDeg(homePct) {
  // The pointer is drawn pointing straight up (toward 50%) by default, so
  // the CSS rotation needed is the difference between that and the real
  // angle for this percentage.
  return 90 - pctToAngle(homePct);
}

function renderNeedleCard(rows, home, away, allDone) {
  const homePct = latestPct(rows);
  const verdict = needleVerdict(homePct, home, away);
  const isLive = !allDone && isRecentlyActive(rows);
  const upsetInfo = getLiveUpsetInfo(rows, home, away, allDone);
  const homeRow = latestRow(rows, true);
  const awayRow = latestRow(rows, false);
  const conf = (!allDone && homeRow && awayRow)
    ? confidenceLabel(impliedStddev(homeRow.expected_score, awayRow.expected_score, homeRow.win_prob))
    : null;

  const card = document.createElement('div');
  card.className = 'needle-card' + (upsetInfo ? ' upset-watch' : '');
  if (upsetInfo) applyUpsetColor(card, upsetInfo.upsetTeam.color);
  card.innerHTML = `
    <div class="upset-watch-badge${upsetInfo ? ' visible pulsing' : ''}">\ud83d\udea8 UPSET WATCH</div>
    <div class="postcard-status ${isLive ? 'live' : ''}">${allDone ? 'Final' : '\u25CF Live'}</div>
    <div class="fc-top-row">
      <div class="fc-gauge-col">
        <div class="needle-gauge">${buildNeedleSvg(home, away)}</div>
        <div class="needle-verdict" style="color:${verdict.color}">${verdict.text}</div>
        <div class="fc-confidence-chip" style="color:${conf ? conf.color : ''}" ${conf ? '' : 'hidden'}>${conf ? conf.text : ''}</div>
      </div>
      <div class="fc-info-col">
        <div class="fc-team-row">
          <span class="fc-team-name" style="color:${home.color}">${home.name}</span>
          <span class="fc-team-dash" style="color:${home.color}"></span>
          <span class="delta-badge"></span>
          <span class="fc-team-pct" style="color:${home.color}">${Math.round(homePct)}%</span>
        </div>
        <div class="fc-team-row">
          <span class="fc-team-name" style="color:${away.color}">${away.name}</span>
          <span class="fc-team-dash" style="color:${away.color}"></span>
          <span class="delta-badge"></span>
          <span class="fc-team-pct" style="color:${away.color}">${Math.round(100 - homePct)}%</span>
        </div>
      </div>
    </div>
    <div class="needle-sub">
      <button class="why-btn" type="button" title="Why is this the number?">\u24d8</button>
    </div>
    <div class="why-blurb" hidden>${explainMatchup(rows, home, away, allDone)}</div>
    ${buildForecastSection(rows, home, away, allDone)}
  `;
  wireWhyButton(card);

  const needle = card.querySelector('.needle-pointer');
  if (needle) needle.style.transform = `rotate(${needleRotationDeg(homePct)}deg)`;

  // prevHomePct seeds the delta-popup comparison on the FIRST background
  // update after this card is created -- see updateNeedleCard, which reads
  // and then overwrites this every refresh.
  return { card, entry: { mode: 'needle', el: card, prevHomePct: homePct } };
}

function updateNeedleCard(entry, rows, home, away, allDone) {
  const homePct = latestPct(rows);
  const prevHomePct = entry.prevHomePct;
  entry.prevHomePct = homePct;
  const verdict = needleVerdict(homePct, home, away);
  const card = entry.el;

  card.querySelector('.postcard-status').textContent = allDone ? 'Final' : '\u25CF Live';
  card.querySelector('.postcard-status').className = `postcard-status ${(!allDone && isRecentlyActive(rows)) ? 'live' : ''}`;
  const verdictEl = card.querySelector('.needle-verdict');
  verdictEl.textContent = verdict.text;
  verdictEl.style.color = verdict.color;
  const needle = card.querySelector('.needle-pointer');
  if (needle) needle.style.transform = `rotate(${needleRotationDeg(homePct)}deg)`;

  const homeRow = latestRow(rows, true);
  const awayRow = latestRow(rows, false);
  const confEl = card.querySelector('.fc-confidence-chip');
  if (confEl) {
    if (!allDone && homeRow && awayRow) {
      const conf = confidenceLabel(impliedStddev(homeRow.expected_score, awayRow.expected_score, homeRow.win_prob));
      confEl.textContent = conf.text;
      confEl.style.color = conf.color;
      confEl.hidden = false;
    } else {
      confEl.hidden = true;
    }
  }

  const teamPcts = card.querySelectorAll('.fc-team-pct');
  if (teamPcts[0]) teamPcts[0].textContent = `${Math.round(homePct)}%`;
  if (teamPcts[1]) teamPcts[1].textContent = `${Math.round(100 - homePct)}%`;

  const deltaBadges = card.querySelectorAll('.delta-badge');
  if (deltaBadges.length === 2) {
    const homeDelta = prevHomePct == null ? 0 : homePct - prevHomePct;
    const gainColor = homeDelta >= 0 ? home.color : away.color;
    scheduleDeltaBadge(deltaBadges[0], prevHomePct, homePct, gainColor);
    scheduleDeltaBadge(deltaBadges[1], prevHomePct == null ? null : (100 - prevHomePct), 100 - homePct, gainColor);
  }

  const upsetInfo = getLiveUpsetInfo(rows, home, away, allDone);
  card.classList.toggle('upset-watch', !!upsetInfo);
  if (upsetInfo) applyUpsetColor(card, upsetInfo.upsetTeam.color);
  const upsetBadge = card.querySelector('.upset-watch-badge');
  if (upsetBadge) {
    upsetBadge.classList.toggle('visible', !!upsetInfo);
    upsetBadge.classList.toggle('pulsing', !!upsetInfo);
  }

  const blurb = card.querySelector('.why-blurb');
  if (blurb) blurb.textContent = explainMatchup(rows, home, away, allDone);

  const oldForecast = card.querySelector('.forecast-section');
  const newForecastHtml = buildForecastSection(rows, home, away, allDone);
  if (oldForecast && newForecastHtml) oldForecast.outerHTML = newForecastHtml;
}

// ============================== SHARED LOADING ==============================

// ============================== ESPN VIEW ==============================
// Styled after ESPN's win-probability widget: a dotted line with a filled
// area, each team's emoji/name/current percentage shown statically above
// and below the chart (so nothing needs to be read via hover), and a
// persistent vertical marker + dot pinned at the latest point instead of an
// interactive tooltip.

// Sets the top/bottom percentage labels directly via the DOM (not through
// Chart.js) -- used both for the normal "current value" display and for
// showing the hovered point's value while the mouse is over the chart.
// Animates a percentage label from its current displayed value to a new
// one instead of snapping instantly. Cancels any animation already running
// on that element first (tracked via a property on the element itself), so
// rapid updates -- e.g. moving the mouse quickly across the chart -- always
// smoothly retarget toward the latest value instead of fighting a
// previous, still-running animation.
function animateEspnPct(el, newValue) {
  if (!el) return;
  if (el._animFrame) cancelAnimationFrame(el._animFrame);

  const startValue = el._animCurrent ?? (parseFloat(el.textContent) || newValue);
  if (Math.abs(startValue - newValue) < 0.5) {
    el.textContent = `${Math.round(newValue)}%`;
    el._animCurrent = newValue;
    return;
  }

  const duration = 350;
  const start = performance.now();

  function step(now) {
    const t = Math.min((now - start) / duration, 1);
    const eased = 1 - Math.pow(1 - t, 3); // ease-out cubic -- fast start, gentle settle
    const current = startValue + (newValue - startValue) * eased;
    el.textContent = `${Math.round(current)}%`;
    el._animCurrent = current;
    if (t < 1) {
      el._animFrame = requestAnimationFrame(step);
    } else {
      el.textContent = `${Math.round(newValue)}%`; // land exactly on the true value
      el._animCurrent = newValue;
      el._animFrame = null;
    }
  }
  el._animFrame = requestAnimationFrame(step);
}

function setEspnPctInstant(el, value) {
  if (!el) return;
  if (el._animFrame) cancelAnimationFrame(el._animFrame);
  el._animFrame = null;
  el.textContent = `${Math.round(value)}%`;
  el._animCurrent = value;
}

// Shows a small "+X.X%"/"-X.X%" badge next to a team's percentage about
// 500ms after a real poll moves it -- the same delayed, colored,
// auto-fading callout pattern used for election-night vote-margin swings.
// `prevPct`/`newPct` are on the SAME 0-100 scale the caller already uses
// for that element (home's own pct, not always homePct), so the sign of
// `delta` always means "this side's number went up/down," and `color` is
// picked by the caller (always the side that GAINED, so a team's own drop
// and the opponent's mirrored gain render as the same color, matching a
// single vote-margin swing being one color for both candidates).
//
// Guarded on the showDeltaPopups preference so an off toggle means this
// function is never even scheduling a timeout, not just hiding a badge
// that's still popping in the background. `prevPct == null` covers a
// card's first-ever update (nothing to compare against yet -- render
// functions never call this). Deltas under 0.05 are treated as noise from
// rounding, not a real change worth announcing.
function scheduleDeltaBadge(badgeEl, prevPct, newPct, color) {
  if (!showDeltaPopups || !badgeEl) return;
  if (prevPct == null || newPct == null) return;
  const delta = newPct - prevPct;
  if (Math.abs(delta) < 0.05) return;

  if (badgeEl._deltaTimeout) clearTimeout(badgeEl._deltaTimeout);
  badgeEl.classList.remove('show');

  badgeEl._deltaTimeout = setTimeout(() => {
    const sign = delta > 0 ? '+' : '−';
    badgeEl.textContent = `${sign}${Math.abs(delta).toFixed(1)}%`;
    badgeEl.style.background = color;
    badgeEl.classList.remove('show');
    void badgeEl.offsetWidth; // restart the animation even if one's already mid-flight
    badgeEl.classList.add('show');
    badgeEl._deltaTimeout = null;
  }, 500);
}

// animate=true (the default) is for real live data arriving -- the 30s
// background refresh -- where a count-up reads as "something happened."
// animate=false is for hover: while scrubbing across history, the number
// should match the mouse position immediately, not lag behind an
// animation, since it's you moving, not new data arriving.
function setEspnPctLabels(canvas, homePct, { animate = true } = {}) {
  const card = canvas.closest('.espn-card');
  if (!card) return;
  const pcts = card.querySelectorAll('.espn-pct');
  if (animate) {
    animateEspnPct(pcts[0], homePct);
    animateEspnPct(pcts[1], 100 - homePct);
  } else {
    setEspnPctInstant(pcts[0], homePct);
    setEspnPctInstant(pcts[1], 100 - homePct);
  }
}

// Sets the ESPN card's upset badge text and independently controls its
// visibility and pulsing -- used both for the live current-state display
// and for the hover-over-history feature, which shows the plain text
// with no pulse regardless of how dramatic the historical moment was.
// `color`, if given, overrides the badge's own text color via inline
// style -- used specifically when hovering a historical point that
// belonged to a DIFFERENT episode than whatever's currently live (a
// back-and-forth game can have different teams threaten at different
// times), without touching the shared --upset custom property the card's
// border reads, which must keep reflecting the CURRENT live team
// regardless of what's hovered. Passing no color clears any override,
// letting the badge fall back to inheriting the card's own --upset.
function setUpsetBadgeState(canvas, { text, visible, pulsing, color }) {
  const badge = canvas.closest('.espn-card')?.querySelector('.upset-watch-badge');
  if (!badge) return;
  badge.textContent = text;
  badge.classList.toggle('visible', visible);
  badge.classList.toggle('pulsing', pulsing);
  if (color) badge.style.color = color;
  else badge.style.removeProperty('color');
}

// Logo if uploaded, else the older emoji field, else nothing -- lets
// teams that haven't uploaded a logo yet keep showing whatever emoji
// they already had set, rather than every team going blank the instant
// this feature shipped. object-fit:cover (see .team-icon-img CSS) keeps
// a non-square source image from looking squished, matching how the
// upload flow already center-crops to square before it's ever stored.
function renderTeamIcon(team) {
  if (team.logoUrl) return `<img class="team-icon-img" src="${team.logoUrl}" alt="">`;
  if (team.emoji) return team.emoji;
  return '';
}

function renderEspnCard(rows, home, away, allDone) {
  const homePct = latestPct(rows);
  const isLive = !allDone && isRecentlyActive(rows);
  const upsetInfo = getLiveUpsetInfo(rows, home, away, allDone);
  const card = document.createElement('div');
  card.className = 'espn-card' + (upsetInfo ? ' upset-watch' : '');
  if (upsetInfo) applyUpsetColor(card, upsetInfo.upsetTeam.color);
  card.innerHTML = `
    <div class="upset-watch-badge${upsetInfo ? ' visible pulsing' : ''}">\ud83d\udea8 UPSET WATCH</div>
    <div class="espn-header">
      <button class="why-btn" type="button" title="Why is this the number?">\u24d8</button>
      <div class="why-blurb" hidden>${explainMatchup(rows, home, away, allDone)}</div>
      <span class="postcard-status ${isLive ? 'live' : ''}">${allDone ? 'Final' : '\u25CF Live'}</span>
    </div>
    <div class="espn-row espn-row-top">
      <span class="espn-emoji">${renderTeamIcon(home)}</span>
      <span class="espn-name" style="color:${home.color}">${home.name}</span>
      <span class="espn-dash" style="background:${home.color}"></span>
      <span class="delta-badge"></span>
      <span class="espn-pct" style="color:${home.color}">${Math.round(homePct)}%</span>
    </div>
    <div class="espn-chartBox"><canvas></canvas></div>
    <div class="espn-row espn-row-bottom">
      <span class="espn-emoji">${renderTeamIcon(away)}</span>
      <span class="espn-name" style="color:${away.color}">${away.name}</span>
      <span class="espn-dash" style="background:${away.color}"></span>
      <span class="delta-badge"></span>
      <span class="espn-pct" style="color:${away.color}">${Math.round(100 - homePct)}%</span>
    </div>
  `;
  wireWhyButton(card);

  const homeRows = rows.filter((s) => s.is_home).sort((a, b) => new Date(a.ts) - new Date(b.ts));
  const awayRows = rows.filter((s) => !s.is_home).sort((a, b) => new Date(a.ts) - new Date(b.ts));
  if (!homeRows.length) return { card, entry: null };

  const { points, rawPoints, maxX } = computeChartPoints(homeRows, awayRows);
  // mainIdx tracks where the "real" datasets (main line, hover guide,
  // hover dot) actually start -- 0 normally, or 2 when the confidence
  // band's two datasets are inserted ahead of them so the band renders
  // BEHIND the line. Every place below that references datasets by
  // index uses this instead of a hardcoded 0/1/2, so the hover code and
  // the update function stay correct regardless of whether the band is
  // present -- getting this wrong would silently point the hover marker
  // or the pct-label lookup at the wrong dataset.
  const mainIdx = showConfidenceBand ? 2 : 0;
  // currentHomePct is kept in sync on every refresh (see updateEspnCard) so
  // that moving the mouse away always snaps back to the real live value,
  // never a stale one captured back when this chart was first created.
  // upsetHistory and currentUpsetInfo are similarly kept fresh so a
  // hover always reflects the latest data, not whatever existed when this
  // card was first created.
  const state = {
    currentHomePct: homePct,
    upsetHistory: getUpsetWatchHistory(rows),
    currentUpsetInfo: upsetInfo,
    mainIdx,
  };
  const canvas = card.querySelector('canvas');

  const datasets = [];
  if (showConfidenceBand) {
    const band = computeConfidenceBand(rawPoints);
    const upperIdx = datasets.length;
    datasets.push({
      data: band.upper,
      parsing: false, borderWidth: 0, pointRadius: 0, tension: 0.15, fill: false,
    });
    datasets.push({
      data: band.lower,
      parsing: false, borderWidth: 0, pointRadius: 0, tension: 0.15,
      fill: { target: upperIdx },
      backgroundColor: themeVar('rgba(120,120,120,0.14)', 'rgba(210,210,210,0.12)'),
    });
  }

  const chart = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: {
      datasets: [
        ...datasets,
        {
          data: points,
          parsing: false,
          borderWidth: 2,
          pointRadius: 0,
          tension: 0.15,
          fill: { target: { value: 50 } },
          segment: {
            borderColor: (c) => (midY(c) >= 50 ? home.color : away.color),
            backgroundColor: (c) => {
              const gradients = getBandGradients(c.chart, home.color, away.color);
              if (!gradients) return 'transparent';
              return midY(c) >= 50 ? gradients.home : gradients.away;
            },
          },
        },
        {
          // Vertical guide line -- hidden until hovered (see the mousemove
          // listener below), not shown persistently.
          data: [],
          hidden: true,
          parsing: false,
          borderWidth: 1.5,
          borderColor: themeVar('#222', '#ddd'),
          pointRadius: 0,
          fill: false,
          tension: 0,
          // Tells Chart.js not to reserve extra padding to keep this
          // dataset's own rendering from being clipped -- without this,
          // the FIRST time this dataset actually contains a point (i.e.
          // the first hover), Chart.js recalculates the plot area to
          // protect it from edge-clipping and keeps that recalculated,
          // very slightly smaller plot area from then on -- exactly the
          // "chart shrinks once on first hover, then stays that size"
          // symptom. Since this line always runs from y:0 to y:100 inside
          // the existing scale bounds, it never needed that protection.
          clip: false,
        },
        {
          // The dot, drawn last so it sits on top of both the line and the
          // vertical guide. Also hidden until hovered. Same clip:false
          // reasoning as the line above -- this is the dataset most likely
          // to trigger that one-time padding recalculation, since it has a
          // real pixel radius (7px + a 2px border) that Chart.js would
          // otherwise reserve edge padding to avoid clipping.
          data: [],
          hidden: true,
          parsing: false,
          showLine: false,
          pointRadius: 7,
          pointBackgroundColor: themeVar('#111', '#eee'),
          pointBorderColor: themeVar('#fff', '#111'),
          pointBorderWidth: 2,
          clip: false,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      // Debounces Chart.js's own container-resize detection -- a second
      // layer of protection against jitter alongside the mousemove
      // throttling above, in case anything else nearby ever triggers a
      // rapid string of resize checks during hover.
      resizeDelay: 100,
      // Fixed, explicit padding -- without this, Chart.js auto-calculates
      // padding based on what's actually rendered, to keep points near the
      // plot edges (like the hover dot, which has real pixel radius) from
      // being clipped. The FIRST time that dot dataset renders with real
      // data, Chart.js recalculates that padding once and keeps it from
      // then on, even after the dataset goes back to hidden -- which is
      // exactly the "shrinks once on first hover, then stays that way
      // until the chart is recreated" symptom. Locking padding to a fixed
      // value up front means it can never depend on which datasets happen
      // to be visible at any given moment.
      // Confirmed via the debug overlay: chartArea.right shrinks by
      // exactly 5px the first time the hover dot renders (left never
      // moves), while the canvas/container's actual pixel size never
      // changes at all -- this is Chart.js reserving extra right-side
      // padding to avoid clipping the dot's point radius, a SEPARATE
      // mechanism from the `clip` dataset option (which only controls
      // visual clipping at draw time, not whether this padding gets
      // reserved in the first place). Setting a fixed right padding
      // comfortably larger than that ~5px means Chart.js's own
      // calculation is always smaller than this value and never gets to
      // add anything on top of it -- the chart area becomes genuinely
      // constant regardless of hover state.
      layout: { padding: { top: 10, right: 16, bottom: 0, left: 4 } },
      // Chart.js's own tooltip/hover system is turned off entirely --
      // hovering is handled manually below via native mouse events on the
      // canvas, which gives full control over exactly what shows (the
      // marker line/dot and the DOM percentage labels) without fighting
      // Chart.js's interaction modes across three differently-sized
      // datasets.
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
      events: [],
      scales: {
        y: {
          min: 0, max: 100,
          grid: {
            color: (c) => (c.tick.value === 50 ? themeVar('#999', '#888') : themeVar('rgba(0,0,0,0.06)', 'rgba(255,255,255,0.08)')),
            lineWidth: (c) => (c.tick.value === 50 ? 1.5 : 1),
          },
          ticks: {
            // Mirrored scale: 100 (this team's color) at the top, 50
            // (neutral, unchanged) in the middle, 100 (the OTHER team's
            // color) at the bottom -- not a literal 0. Distance from
            // center always means "how decisive," and since the number
            // alone can't say which team's 100 it is, color is what
            // differentiates the two sides, matching the same convention
            // used in the Forecasting view's Probability Swing bar.
            callback: (v) => (v === 0 ? 100 : (v === 50 || v === 100 ? v : '')),
            color: (c) => {
              if (c.tick.value === 100) return home.color;
              if (c.tick.value === 0) return away.color;
              return themeVar('#555', '#aaa');
            },
          },
        },
        x: {
          type: 'linear',
          min: 0,
          max: maxX,
          grid: { color: themeVar('rgba(0,0,0,0.06)', 'rgba(255,255,255,0.08)') },
          // No x-axis labels -- the old day-of-week text (e.g. "Sun") was
          // tied to a since-replaced model and no longer means anything
          // useful here. Grid lines are unaffected.
          ticks: { display: false },
        },
      },
    },
  });
  chart._state = state;

  // Manual hover handling: find the nearest real data point to the mouse's
  // x position, show the marker line + dot there, and show that point's
  // percentages in the top/bottom labels. Reads datasets[0].data fresh each
  // time (not a closed-over `points` variable) so this keeps working
  // correctly after a background refresh replaces the chart's data.
  //
  // Only calls chart.update() when the hovered point actually CHANGES,
  // rather than on every mousemove event (which fires dozens of times per
  // second even for tiny mouse movements within the same nearest-point
  // region). Each call to update() gives Chart.js's responsive-resize
  // logic a chance to re-measure the container, and enough redundant calls
  // in quick succession was producing a visible pixel-level jitter in the
  // canvas -- this removes almost all of those redundant calls at the
  // source rather than trying to patch around Chart.js's resize behavior.
  let lastHoverX = null;
  canvas.addEventListener('mousemove', (evt) => {
    const rect = canvas.getBoundingClientRect();
    const mouseX = evt.clientX - rect.left;
    const xValue = chart.scales.x.getValueForPixel(mouseX);
    if (xValue == null) return;
    const currentPoints = chart.data.datasets[mainIdx].data;
    if (!currentPoints.length) return;

    let nearest = currentPoints[0];
    let minDist = Infinity;
    for (const p of currentPoints) {
      const d = Math.abs(p.x - xValue);
      if (d < minDist) { minDist = d; nearest = p; }
    }

    if (nearest.x === lastHoverX) return; // same point as last event -- nothing to redraw
    lastHoverX = nearest.x;

    chart.data.datasets[mainIdx + 1].data = [{ x: nearest.x, y: 0 }, { x: nearest.x, y: 100 }];
    chart.data.datasets[mainIdx + 1].hidden = false;
    chart.data.datasets[mainIdx + 2].data = [nearest];
    chart.data.datasets[mainIdx + 2].hidden = false;
    chart.update('none');
    setEspnPctLabels(canvas, nearest.y, { animate: false });

    // Historical upset-watch hover (gated on the preference, defaulting
    // on). Looked up via nearestByTs, not an exact match -- see
    // getUpsetWatchHistory's comment for why exact matching flickered.
    // Never pulses here regardless of the case below -- only the CARD's
    // own border glow (untouched by any of this, see updateEspnCard)
    // reflects the live state with motion; hovering only ever changes
    // static text.
    //   - The hovered point WAS during an episode -> say so.
    //   - It wasn't, but the game IS currently under a live alert
    //     elsewhere on the timeline (the border is still pulsing right
    //     now, entirely independent of whatever's hovered) -> keep the
    //     badge visible and say so, rather than going blank next to a
    //     border that's still visibly glowing -- a blank badge next to a
    //     pulsing border reads as broken, not informative.
    //   - Neither -> nothing to show.
    if (showUpsetHistory && chart._state.upsetHistory.length) {
      const nearestEntry = nearestByTs(chart._state.upsetHistory, nearest.ts);
      const wasActive = nearestEntry ? nearestEntry.watch : false;
      const isCurrentlyLive = !!chart._state.currentUpsetInfo;
      if (wasActive) {
        // Colored after THIS specific historical episode's underdog,
        // which can differ from whoever's currently live in a
        // back-and-forth game -- e.g. home might have been the threat
        // earlier, away the threat now.
        const historicalColor = nearestEntry.upsetSide === 'home' ? home.color : away.color;
        setUpsetBadgeState(canvas, { text: '\ud83d\udea8 Upset Watch was active here', visible: true, pulsing: false, color: historicalColor });
      } else if (isCurrentlyLive) {
        // No color override here -- falls back to inheriting the card's
        // own --upset, which already reflects the current live team.
        setUpsetBadgeState(canvas, { text: '\ud83d\udea8 UPSET WATCH', visible: true, pulsing: false });
      } else {
        setUpsetBadgeState(canvas, { text: '\ud83d\udea8 UPSET WATCH', visible: false, pulsing: false });
      }
    }
  });

  canvas.addEventListener('mouseleave', () => {
    lastHoverX = null;
    chart.data.datasets[mainIdx + 1].hidden = true;
    chart.data.datasets[mainIdx + 2].hidden = true;
    chart.update('none');
    setEspnPctLabels(canvas, chart._state.currentHomePct, { animate: false });
    // Revert the badge to whatever the CURRENT live state actually is
    // (kept fresh on every refresh -- see updateEspnCard), not whatever
    // text the hover happened to leave behind.
    if (showUpsetHistory) {
      const info = chart._state.currentUpsetInfo;
      setUpsetBadgeState(canvas, { text: '\ud83d\udea8 UPSET WATCH', visible: !!info, pulsing: !!info });
    }
  });

  return { card, entry: { mode: 'espn', chart } };
}

function updateEspnCard(entry, rows, home, away, allDone) {
  const homeRows = rows.filter((s) => s.is_home).sort((a, b) => new Date(a.ts) - new Date(b.ts));
  const awayRows = rows.filter((s) => !s.is_home).sort((a, b) => new Date(a.ts) - new Date(b.ts));
  if (!homeRows.length || !entry.chart) return;

  const chart = entry.chart;
  const { points, rawPoints, maxX } = computeChartPoints(homeRows, awayRows);
  const mainIdx = chart._state.mainIdx;
  chart.data.datasets[mainIdx].data = points;
  if (showConfidenceBand) {
    const band = computeConfidenceBand(rawPoints);
    chart.data.datasets[0].data = band.upper;
    chart.data.datasets[1].data = band.lower;
  }
  const prevHomePct = chart._state.currentHomePct;
  const newHomePct = latestPct(rows);
  chart._state.currentHomePct = newHomePct;
  chart.options.scales.x.max = maxX;
  chart.update('none');

  // Only refresh the visible labels if the marker isn't currently being
  // shown via hover -- otherwise a background refresh would yank the
  // numbers out from under someone mid-hover. The delta popup follows the
  // same guard: hovering is you scrubbing history, not a new poll arriving,
  // so it shouldn't trigger a "the number changed" callout.
  const isHovering = chart.data.datasets[mainIdx + 1].hidden === false;
  if (!isHovering) {
    setEspnPctLabels(chart.canvas, chart._state.currentHomePct);

    const badges = chart.canvas.closest('.espn-card')?.querySelectorAll('.delta-badge');
    if (badges && badges.length === 2) {
      const homeDelta = newHomePct - prevHomePct;
      const gainColor = homeDelta >= 0 ? home.color : away.color;
      scheduleDeltaBadge(badges[0], prevHomePct, newHomePct, gainColor);
      scheduleDeltaBadge(badges[1], prevHomePct == null ? null : (100 - prevHomePct), 100 - newHomePct, gainColor);
    }
  }

  const badge = chart.canvas.closest('.espn-card')?.querySelector('.postcard-status');
  if (badge) {
    badge.textContent = allDone ? 'Final' : '\u25CF Live';
    badge.className = `postcard-status ${(!allDone && isRecentlyActive(rows)) ? 'live' : ''}`;
  }

  const blurb = chart.canvas.closest('.espn-card')?.querySelector('.why-blurb');
  if (blurb) blurb.textContent = explainMatchup(rows, home, away, allDone);

  const card = chart.canvas.closest('.espn-card');
  const upsetInfo = getLiveUpsetInfo(rows, home, away, allDone);
  chart._state.upsetHistory = getUpsetWatchHistory(rows);
  chart._state.currentUpsetInfo = upsetInfo;
  if (card) {
    card.classList.toggle('upset-watch', !!upsetInfo);
    if (upsetInfo) applyUpsetColor(card, upsetInfo.upsetTeam.color);
    // Same hovering guard as the pct labels above -- a background refresh
    // shouldn't yank a historical hover state out from under someone.
    if (!isHovering) {
      setUpsetBadgeState(chart.canvas, { text: '\ud83d\udea8 UPSET WATCH', visible: !!upsetInfo, pulsing: !!upsetInfo });
    }
  }
}

const VIEW_RENDERERS = {
  timeline: { render: renderTimelineCard, update: updateTimelineCard },
  postcard: { render: renderPostcardCard, update: updatePostcardCard },
  needle: { render: renderNeedleCard, update: updateNeedleCard },
  espn: { render: renderEspnCard, update: updateEspnCard },
};

function destroyEntry(entry) {
  if (entry?.chart) entry.chart.destroy();
}

// preserveCharts=true (used by the 30s auto-refresh timer) updates existing
// cards in place and never touches the DOM structure or scroll position.
// preserveCharts=false (used on initial load, view mode switches, or
// whenever the league/year/week selection changes) does a full rebuild.
async function loadMatchups({ preserveCharts = false } = {}) {
  const leagueId = leagueSelect.value;
  const year = Number(yearSelect.value);
  const week = Number(weekSelect.value);
  if (!leagueId || !year || !week) return;

  if (!preserveCharts) statusEl.textContent = 'Loading...';

  let byMatchup, teamInfo;
  try {
    ({ byMatchup, teamInfo } = await fetchMatchupData(leagueId, year, week));
  } catch (err) {
    if (!preserveCharts) statusEl.textContent = 'Error loading data: ' + err.message;
    return; // don't wipe an existing view over a transient refresh error
  }

  renderRecapBanner(byMatchup, teamInfo);
  updateLeaderBar(byMatchup, teamInfo);
  renderByeWeekNote(byMatchup, teamInfo);
  updateKickoffCountdown(byMatchup, year, week); // fire-and-forget -- doesn't block matchup rendering

  const { render, update } = VIEW_RENDERERS[viewMode];

  if (Object.keys(byMatchup).length === 0) {
    if (!preserveCharts) {
      matchupsEl.innerHTML = '';
      Object.values(charts).forEach(destroyEntry);
      for (const key of Object.keys(charts)) delete charts[key];
      statusEl.textContent = 'No data yet for this week -- the poller may not have run yet.';
    }
    return;
  }

  if (!preserveCharts || Object.keys(charts).length === 0) {
    matchupsEl.innerHTML = '';
    // Only touch the view-mode class specifically -- a full className
    // overwrite here would also wipe out the .view-fading class that
    // setViewMode adds during a transition, breaking the fade-in half of
    // the cross-fade before it ever gets a chance to play.
    matchupsEl.classList.remove('view-timeline', 'view-postcard', 'view-needle', 'view-espn');
    matchupsEl.classList.add(`view-${viewMode}`);
    Object.values(charts).forEach(destroyEntry);
    for (const key of Object.keys(charts)) delete charts[key];

    statusEl.textContent = '';

    for (const [matchupId, rows] of Object.entries(byMatchup)) {
      const homeRow = rows.find((r) => r.is_home);
      const awayRow = rows.find((r) => !r.is_home);
      if (!homeRow || !awayRow) continue;

      const home = teamInfo[homeRow.team_id] || { name: 'Home', color: '#1a3fa0', emoji: '' , logoUrl: '' };
      const away = teamInfo[awayRow.team_id] || { name: 'Away', color: '#c0392b', emoji: '' , logoUrl: '' };
      const allDone = !!(latestRow(rows, true)?.all_starters_done && latestRow(rows, false)?.all_starters_done);

      const { card, entry } = render(rows, home, away, allDone);
      matchupsEl.appendChild(card);
      if (entry) charts[matchupId] = entry;
    }
    return;
  }

  // Incremental update: same matchup set as before (true on every routine
  // 30s refresh) -- update each existing card in place.
  statusEl.textContent = '';
  for (const [matchupId, rows] of Object.entries(byMatchup)) {
    const homeRow = rows.find((r) => r.is_home);
    const awayRow = rows.find((r) => !r.is_home);
    if (!homeRow || !awayRow) continue;

    const entry = charts[matchupId];
    if (!entry || entry.mode !== viewMode) {
      return loadMatchups({ preserveCharts: false }); // matchup set or mode changed -- fall back once
    }

    const home = teamInfo[homeRow.team_id] || { name: 'Home', color: '#1a3fa0', emoji: '' , logoUrl: '' };
    const away = teamInfo[awayRow.team_id] || { name: 'Away', color: '#c0392b', emoji: '' , logoUrl: '' };
    const allDone = !!(latestRow(rows, true)?.all_starters_done && latestRow(rows, false)?.all_starters_done);
    update(entry, rows, home, away, allDone);
  }
}

function setViewMode(mode) {
  if (mode === viewMode) return;
  viewButtons.forEach((btn) => btn.classList.toggle('active', btn.dataset.view === mode));

  // Cross-fade instead of an instant hard cut: fade the current cards out,
  // swap the DOM once fully transparent (invisible either way, so the swap
  // itself is never seen), then fade the new view's cards back in.
  const FADE_MS = 180;
  matchupsEl.classList.add('view-fading');
  setTimeout(async () => {
    viewMode = mode;
    localStorage.setItem('winProbViewMode', mode);
    await loadMatchups({ preserveCharts: false });
    // Force a reflow before removing the class -- otherwise the browser can
    // coalesce the "add" and "remove" into a single frame and skip the
    // fade-in transition entirely, since nothing would have visibly
    // changed in between from its perspective.
    void matchupsEl.offsetWidth;
    matchupsEl.classList.remove('view-fading');
  }, FADE_MS);
}

// ============================== DEBUG OVERLAY ==============================
// Visit the site with ?debug=1 appended to the URL to show a live-updating
// panel of the exact measurements most likely to explain the "ESPN chart
// shrinks a couple pixels on hover" issue: viewport/scrollbar width, the
// canvas's own rendered size, Chart.js's internal chartArea boundaries, and
// the surrounding container sizes. Watch which number actually changes the
// moment you hover, rather than guessing at Chart.js internals blindly.
// Completely inert (adds nothing to the page, costs nothing) without the
// URL parameter, so it's safe to leave deployed.
function setupDebugOverlay() {
  if (!new URLSearchParams(location.search).has('debug')) return;

  const panel = document.createElement('div');
  panel.id = 'debugPanel';
  panel.style.cssText =
    'position:fixed; bottom:10px; right:10px; background:rgba(0,0,0,0.88); color:#7dffb0; ' +
    'font-family:ui-monospace,monospace; font-size:11px; padding:10px 12px; border-radius:8px; ' +
    'z-index:99999; max-width:380px; white-space:pre; line-height:1.5; pointer-events:none;';
  document.body.appendChild(panel);

  function logDebug() {
    const lines = [];
    const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;
    lines.push(`viewport: ${window.innerWidth} x ${window.innerHeight}`);
    lines.push(`docEl.clientWidth: ${document.documentElement.clientWidth}`);
    lines.push(`scrollbar width (innerWidth - clientWidth): ${scrollbarWidth}`);
    lines.push(`documentElement scrollHeight: ${document.documentElement.scrollHeight}`);
    lines.push(`has vertical scroll: ${document.documentElement.scrollHeight > document.documentElement.clientHeight}`);
    lines.push('');

    const canvas = document.querySelector('.espn-card canvas');
    if (!canvas) {
      lines.push('(no ESPN chart on screen)');
      panel.textContent = lines.join('\n');
      return;
    }

    const canvasRect = canvas.getBoundingClientRect();
    lines.push(`canvas rect: ${canvasRect.width.toFixed(2)} x ${canvasRect.height.toFixed(2)} @ left=${canvasRect.left.toFixed(2)}`);
    lines.push(`canvas internal px (canvas.width/height): ${canvas.width} x ${canvas.height}`);

    const box = canvas.closest('.espn-chartBox');
    if (box) {
      const r = box.getBoundingClientRect();
      lines.push(`.espn-chartBox rect: ${r.width.toFixed(2)} x ${r.height.toFixed(2)} @ left=${r.left.toFixed(2)}`);
    }
    const card = canvas.closest('.espn-card');
    if (card) {
      const r = card.getBoundingClientRect();
      lines.push(`.espn-card rect: ${r.width.toFixed(2)} @ left=${r.left.toFixed(2)} right=${r.right.toFixed(2)}`);
    }

    const chartInstance = typeof Chart !== 'undefined' && Chart.getChart ? Chart.getChart(canvas) : null;
    if (chartInstance) {
      const ca = chartInstance.chartArea;
      lines.push(`chartArea: left=${ca.left.toFixed(2)} right=${ca.right.toFixed(2)} width=${(ca.right - ca.left).toFixed(2)}`);
      lines.push(`chart.width/height (Chart.js's own): ${chartInstance.width} x ${chartInstance.height}`);
    } else {
      lines.push('(could not find Chart.js instance for this canvas)');
    }

    panel.textContent = lines.join('\n');
  }

  logDebug();
  setInterval(logDebug, 300);
  document.addEventListener('mousemove', logDebug, { passive: true });
}

async function init() {
  setupDebugOverlay();

  if (themeToggle) {
    themeToggle.textContent = theme === 'dark' ? '\u2600\ufe0f Light' : '\ud83c\udf19 Dark';
    themeToggle.addEventListener('click', () => setTheme(theme === 'dark' ? 'light' : 'dark'));
  }

  viewButtons.forEach((btn) => {
    // Timeline/Postcard stay entirely out of the switcher (not just
    // unclickable) when the legacy-views preference is off -- no click
    // handler needed for a button nobody can see.
    if (!showLegacyViews && (btn.dataset.view === 'timeline' || btn.dataset.view === 'postcard')) {
      btn.hidden = true;
      return;
    }
    btn.classList.toggle('active', btn.dataset.view === viewMode);
    btn.addEventListener('click', () => setViewMode(btn.dataset.view));
  });

  await loadLeagues();
  leagueSelect.onchange = async () => {
    await loadYearsWeeks(leagueSelect.value);
    await loadMatchups();
    checkYearInReviewAvailability(leagueSelect.value);
  };
  weekSelect.onchange = loadMatchups;
  if (leagueSelect.value) {
    await loadYearsWeeks(leagueSelect.value);
    await loadMatchups();
    checkYearInReviewAvailability(leagueSelect.value);
  }

  // Auto-refresh every 30s -- cheap read-only query, fine even if the
  // underlying poller only writes every ~5 min. Updates existing cards in
  // place instead of rebuilding the DOM, so this can't disturb scroll
  // position. Checks for a newly-arrived week first (see
  // checkForLatestWeekAdvance) -- if that already performed a full
  // reload, skip the redundant preserveCharts refresh on this same tick.
  refreshTimer = setInterval(async () => {
    const advanced = await checkForLatestWeekAdvance();
    if (!advanced) loadMatchups({ preserveCharts: true });
  }, 30000);
  setInterval(tickKickoffCountdown, 1000); // display-only tick, no network -- see updateKickoffCountdown for when the target itself gets (re)computed
}

init();
