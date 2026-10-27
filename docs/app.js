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
// What If view (schedule-swap hypothetical) -- which two teams are
// currently picked, and the one Chart.js instance it keeps (separate from
// `charts`, which is keyed per-matchup and doesn't apply here: this view
// has exactly one chart on screen at a time, for a pairing that isn't a
// real matchup). Persisted across 30s refreshes and week/league switches
// (re-validated against that week's actual team list each render) so
// picking a pairing doesn't get reset out from under someone mid-browse.
let whatIfTeamAId = null;
let whatIfTeamBId = null;
let whatIfChartInstance = null;
// Forecast view's Power Score projection (see computePowerProjection) --
// teamId -> { baseline, projected }, recomputed once per loadMatchups()
// call whenever viewMode is 'needle' and read directly by
// renderNeedleCard/updateNeedleCard via buildFcPowerRow, same convention
// as currentSeasonalTheme/showConfidenceBand (module state read straight
// from a render function rather than threaded through VIEW_RENDERERS'
// fixed (rows, home, away, allDone) signature).
let powerProjectionByTeam = null;
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
// Separate cache key for championship week's win-probability-split mode
// (see updateLeaderBar) -- a rounded home win% rather than a team id, so
// it can't collide with leaderBarCurrentTeamId's own cache, and each mode
// invalidates the other's cache on entry/exit so switching between them
// (or just leaving/entering championship week) always repaints once.
let leaderBarChampHomePct = null;
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
// Tiny IndexedDB key-value store for data that can never change again
// (finished weeks) -- localStorage is far too small for a week of polls.
// Every call fails soft: no IndexedDB (private window etc.) just means no
// caching, never an error.
const IDB_NAME = 'winProbCache', IDB_STORE = 'kv';
function idbOpen() {
  return new Promise((resolve, reject) => {
    try {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    } catch (e) { reject(e); }
  });
}
async function idbGet(key) {
  try {
    const db = await idbOpen();
    return await new Promise((resolve) => {
      const r = db.transaction(IDB_STORE).objectStore(IDB_STORE).get(key);
      r.onsuccess = () => resolve(r.result ?? null);
      r.onerror = () => resolve(null);
    });
  } catch { return null; }
}
async function idbSet(key, value) {
  try {
    const db = await idbOpen();
    await new Promise((resolve) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(value, key);
      tx.oncomplete = resolve; tx.onerror = resolve; tx.onabort = resolve;
    });
  } catch { /* no caching -- fine */ }
}
// A week/season counts as "settled" once every game is final AND nothing
// new has been recorded for 48 hours (so late ESPN stat corrections still
// get picked up before it's frozen into the cache).
const SETTLED_AFTER_MS = 48 * 60 * 60 * 1000;
function rowsAreSettled(rows) {
  if (!rows || !rows.length) return false;
  const latest = new Map();
  let maxTs = 0;
  for (const r of rows) {
    const k = `${r.year}|${r.week}|${r.matchup_id}|${r.team_id}`;
    const t = new Date(r.ts).getTime();
    if (t > maxTs) maxTs = t;
    const e = latest.get(k);
    if (!e || t > e.t) latest.set(k, { t, done: r.all_starters_done });
  }
  for (const e of latest.values()) if (!e.done) return false;
  return Date.now() - maxTs > SETTLED_AFTER_MS;
}

const PAGE_SIZE = 1000;
async function fetchAllRows(buildQuery) {
  // First page alone (most queries fit in it), then further pages fetched
  // in parallel batches rather than one round trip at a time.
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

// ============================== CHAMPIONSHIP WEEK ==============================
// Week 17 gets a dedicated hype treatment: a spotlight-sweep hero banner
// before kickoff (see .championship-stage in index.html), and matchups
// reordered by playoff stakes -- championship game first, then each
// placement game down the bracket -- instead of whatever order snapshots
// happened to arrive in.
//
// ESPN's API doesn't label a matchup as "the championship" or "the 3rd
// place game" -- there's a real bracket behind it, but nothing this app
// has access to records which teams are actually paired for which
// placement. Instead this infers tier from regular-season strength: teams
// are ranked by win/loss record (points-for as tiebreaker) using every
// FINAL matchup strictly before championship week, then week 17's
// matchups are sorted by their two teams' combined rank -- the pairing of
// the two best-ranked teams is treated as the championship, the
// next-best pairing as the 3rd place game, and so on. This is a
// heuristic, not a real bracket lookup: if a lower seed upsets its way
// into the final over a higher seed who got knocked into a placement
// game instead, this can mislabel which game is actually which. Good
// enough for a hype banner; not a substitute for real seeding data if
// that's ever recorded.
const CHAMPIONSHIP_WEEK = YEAR_IN_REVIEW_WEEK;
// Defaults OFF -- forces the championship-week treatment (hero banner +
// tier-ordered/ribboned cards) on regardless of which week is actually
// selected, purely so the look can be previewed on demand rather than
// waiting for an actual Week 17 Sunday morning. Real pregame/live
// detection still applies underneath -- this only removes the "is it
// really week 17" gate, the same way winProbYearInReviewEarly only
// removes the "has week 17 actually finished" gate.
let debugChampionshipWeek = localStorage.getItem('winProbDebugChampionshipWeek') === 'true'; // set on preferences.html
const championshipStageEl = document.getElementById('championshipStage');

// Forces the Power Picks pregame view on for whichever week is selected,
// even if it's already live -- a pure client-side rendering override (see
// preferences.html). The poller's own plottingOpen gate and every row it
// writes are entirely unaffected by this: real polling keeps running in
// the background exactly as if this were off, so toggling it never risks
// or loses any real data, and switching it back off just re-renders
// whatever the real pregame/live state actually is.
let debugForcePowerPicks = localStorage.getItem('winProbDebugForcePowerPicks') === 'true'; // set on preferences.html

function ordinalLabel(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// Ranks every team by regular-season record using every FINAL matchup
// strictly before championship week. Returns a Map of team_id -> 0-based
// rank (0 = best record). A team with zero completed games before
// championship week (shouldn't normally happen, but a sparse/incomplete
// import could produce one) falls back to a rank far outside the real
// range in computePlayoffTiers below, rather than colliding with rank 0.
function rankTeamsBeforeChampionshipWeek(seasonRows) {
  const latestByKey = new Map();
  for (const r of seasonRows) {
    if (r.week >= CHAMPIONSHIP_WEEK) continue;
    const key = `${r.week}|${r.matchup_id}|${r.team_id}`;
    const existing = latestByKey.get(key);
    if (!existing || new Date(r.ts) > new Date(existing.ts)) latestByKey.set(key, r);
  }
  const matchupGroups = new Map();
  for (const r of latestByKey.values()) {
    const mKey = `${r.week}|${r.matchup_id}`;
    if (!matchupGroups.has(mKey)) matchupGroups.set(mKey, []);
    matchupGroups.get(mKey).push(r);
  }
  const records = new Map();
  const getRecord = (teamId) => {
    if (!records.has(teamId)) records.set(teamId, { wins: 0, losses: 0, ties: 0, pointsFor: 0 });
    return records.get(teamId);
  };
  for (const sides of matchupGroups.values()) {
    if (sides.length !== 2) continue;
    const [a, b] = sides;
    if (!a.all_starters_done || !b.all_starters_done) continue;
    const recA = getRecord(a.team_id), recB = getRecord(b.team_id);
    recA.pointsFor += a.actual_score; recB.pointsFor += b.actual_score;
    if (a.actual_score > b.actual_score) { recA.wins++; recB.losses++; }
    else if (b.actual_score > a.actual_score) { recB.wins++; recA.losses++; }
    else { recA.ties++; recB.ties++; }
  }
  const standings = [...records.entries()].map(([teamId, rec]) => {
    const played = rec.wins + rec.losses + rec.ties;
    return { teamId, winPct: played ? (rec.wins + rec.ties * 0.5) / played : 0, pointsFor: rec.pointsFor };
  });
  standings.sort((x, y) => y.winPct - x.winPct || y.pointsFor - x.pointsFor);
  const rankByTeam = new Map();
  standings.forEach((s, i) => rankByTeam.set(s.teamId, i));
  return rankByTeam;
}

// Given this week's byMatchup and the full season's rows (for ranking),
// returns { order, tierByMatchup }. `order` is this week's matchup_id
// keys sorted by playoff stakes (strongest combined rank first).
// `tierByMatchup` maps each matchup_id to { label, tier } (tier 0 =
// championship, 1 = 3rd place, 2+ = generic placement games) for the
// ribbon badge on each card.
function computePlayoffTiers(byMatchup, seasonRows) {
  const rankByTeam = rankTeamsBeforeChampionshipWeek(seasonRows);
  const matchupIds = Object.keys(byMatchup);
  const scored = matchupIds.map((mId) => {
    const rows = byMatchup[mId];
    const homeRow = rows.find((r) => r.is_home);
    const awayRow = rows.find((r) => !r.is_home);
    // 999 is an out-of-range fallback for a team with no rankable
    // regular-season record -- see rankTeamsBeforeChampionshipWeek.
    const rankA = homeRow ? (rankByTeam.has(homeRow.team_id) ? rankByTeam.get(homeRow.team_id) : 999) : 999;
    const rankB = awayRow ? (rankByTeam.has(awayRow.team_id) ? rankByTeam.get(awayRow.team_id) : 999) : 999;
    return { mId, combinedRank: rankA + rankB };
  });
  scored.sort((x, y) => x.combinedRank - y.combinedRank);

  const tierByMatchup = {};
  scored.forEach((s, i) => {
    let label;
    if (i === 0) label = '🏆 Championship';
    else if (i === 1) label = '🥉 3rd Place Game';
    else label = `${ordinalLabel(i * 2 + 1)} Place Game`;
    tierByMatchup[s.mId] = { label, tier: i };
  });
  return { order: scored.map((s) => s.mId), tierByMatchup };
}

// Caches the ranking source data per league+year -- it only depends on
// regular-season results, which are locked in by the time championship
// week starts, so there's no reason to re-fetch every 30s refresh. Only
// invalidated by actually switching league or year.
let championshipTierCache = { key: null, rows: null };

async function getPlayoffTiers(leagueId, year, byMatchup) {
  const cacheKey = `${leagueId}|${year}`;
  if (championshipTierCache.key !== cacheKey) {
    let rows;
    try {
      rows = await fetchAllRows((from, to) =>
        sb.from('snapshot_summary')
          .select('week, matchup_id, team_id, actual_score, all_starters_done, ts')
          .eq('league_id', leagueId).eq('year', year).lt('week', CHAMPIONSHIP_WEEK).eq('all_starters_done', true)
          .range(from, to)
      );
    } catch {
      rows = [];
    }
    championshipTierCache = { key: cacheKey, rows };
  }
  return computePlayoffTiers(byMatchup, championshipTierCache.rows || []);
}

// Fills in one side of the hero banner's team flank (logo/icon + name),
// or hides it entirely when there's no resolvable team (e.g. the debug
// toggle forcing the banner on over a week with no computable
// championship matchup). Shared by both home/away so the two sides can
// never drift out of sync in markup or behavior.
function renderHypeTeam(prefix, team) {
  const wrap = document.getElementById(`hypeTeam${prefix}`);
  const iconEl = document.getElementById(`hypeTeam${prefix}Icon`);
  const nameEl = document.getElementById(`hypeTeam${prefix}Name`);
  if (!wrap || !iconEl || !nameEl) return;
  if (!team) {
    wrap.hidden = true;
    return;
  }
  wrap.hidden = false;
  iconEl.innerHTML = renderTeamIcon(team);
  nameEl.textContent = team.name;
}

// Big broadcast-style Days/Hrs/Min countdown readout (the banner's new
// centerpiece, replacing the old one-line "Kickoff in 2d 14h 37m" text).
// Shares formatCountdown's underlying math but needs the parts
// separately rather than a single pre-joined string, since each unit is
// its own glowing digit block. The days block (and its separator) hide
// themselves once there's less than a day left, rather than sitting
// there showing a dead "00" for the entire final day.
function renderHypeCountdownBig(msRemaining) {
  const digitsEl = document.getElementById('hypeCountdown');
  const fallbackEl = document.getElementById('hypeCountdownFallback');
  if (!digitsEl || !fallbackEl) return false;
  const formatted = formatCountdown(msRemaining);
  if (!formatted) return false;
  const totalSeconds = Math.floor(msRemaining / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  digitsEl.hidden = false;
  fallbackEl.hidden = true;
  const daysEl = document.getElementById('hcbDays');
  const hoursEl = document.getElementById('hcbHours');
  const minutesEl = document.getElementById('hcbMinutes');
  if (daysEl) daysEl.textContent = String(days).padStart(2, '0');
  if (hoursEl) hoursEl.textContent = String(hours).padStart(2, '0');
  if (minutesEl) minutesEl.textContent = String(minutes).padStart(2, '0');
  const daysBlock = document.getElementById('hcbDaysBlock');
  const daysSep = document.getElementById('hcbDaysSep');
  if (daysBlock) daysBlock.hidden = days <= 0;
  if (daysSep) daysSep.hidden = days <= 0;
  return true;
}

// Shows/hides the Week 17 hero banner and switches it between pregame
// (spotlight sweep + big countdown) and live (spotlights faded out, see
// CSS) based on whether any score has actually come in yet for this
// week -- not on wall-clock time, so it stays correct even if an NFL
// game gets delayed or moved. `championshipTeams` (from loadMatchups,
// via getPlayoffTiers) carries the actual two teams playing in it --
// drives the team flanks, the live score line, and the
// --champ-color-a/-b custom properties that recolor the starburst, the
// in-banner beams, AND the site-wide spotlights (set on <html> so both
// pick them up through normal CSS custom-property inheritance, rather
// than needing two separate JS writes).
function updateChampionshipStage(active, byMatchup, championshipTeams) {
  document.documentElement.setAttribute('data-championship-active', active ? 'true' : 'false');
  if (!active) {
    document.documentElement.style.removeProperty('--champ-color-a');
    document.documentElement.style.removeProperty('--champ-color-b');
  }
  if (!championshipStageEl) return;
  championshipStageEl.hidden = !active;
  if (!active) return;

  if (championshipTeams) {
    document.documentElement.style.setProperty('--champ-color-a', championshipTeams.home.color);
    document.documentElement.style.setProperty('--champ-color-b', championshipTeams.away.color);
  } else {
    document.documentElement.style.removeProperty('--champ-color-a');
    document.documentElement.style.removeProperty('--champ-color-b');
  }
  renderHypeTeam('Home', championshipTeams ? championshipTeams.home : null);
  renderHypeTeam('Away', championshipTeams ? championshipTeams.away : null);

  const champRows = championshipTeams ? byMatchup[championshipTeams.matchupId] : null;
  const hasStarted = Object.values(byMatchup).some((rows) => rows.some((r) => Number(r.actual_score) > 0));
  championshipStageEl.setAttribute('data-mode', hasStarted ? 'live' : 'pregame');

  const hypeCountdownEl = document.getElementById('hypeCountdown');
  const hypeCountdownFallbackEl = document.getElementById('hypeCountdownFallback');
  const hypeLiveNoteEl = document.getElementById('hypeLiveNote');
  const homeScoreEl = document.getElementById('hypeTeamHomeScore');
  const awayScoreEl = document.getElementById('hypeTeamAwayScore');

  if (hasStarted) {
    if (hypeCountdownEl) hypeCountdownEl.hidden = true;
    if (hypeCountdownFallbackEl) hypeCountdownFallbackEl.hidden = true;
    if (hypeLiveNoteEl) hypeLiveNoteEl.hidden = false;
    // Live score sits right under each team's name/logo -- the banner's
    // own small piece of "more representation," so the matchup it's
    // hyping is never just a generic title once it's actually underway.
    if (champRows) {
      const homeRow = champRows.find((r) => r.is_home);
      const awayRow = champRows.find((r) => !r.is_home);
      if (homeScoreEl) { homeScoreEl.hidden = !homeRow; if (homeRow) homeScoreEl.textContent = Number(homeRow.actual_score || 0).toFixed(1); }
      if (awayScoreEl) { awayScoreEl.hidden = !awayRow; if (awayRow) awayScoreEl.textContent = Number(awayRow.actual_score || 0).toFixed(1); }
    }
    return;
  }

  if (homeScoreEl) homeScoreEl.hidden = true;
  if (awayScoreEl) awayScoreEl.hidden = true;
  if (hypeLiveNoteEl) hypeLiveNoteEl.hidden = true;
  if (!hypeCountdownEl || !hypeCountdownFallbackEl) return;
  if (kickoffCountdownTarget) {
    const shown = renderHypeCountdownBig(kickoffCountdownTarget.getTime() - Date.now());
    if (!shown) {
      hypeCountdownEl.hidden = true;
      hypeCountdownFallbackEl.hidden = true;
    }
  } else {
    // No resolved kickoff time (e.g. browsing an older week, or the debug
    // toggle forcing this on outside a real week 17) -- generic copy
    // instead of a wrong or stale number.
    hypeCountdownEl.hidden = true;
    hypeCountdownFallbackEl.hidden = false;
    hypeCountdownFallbackEl.textContent = 'Before kickoff';
  }
}

// Sets/clears the tier ribbon on a rendered card (ESPN and Needle views
// only -- see VIEW_RENDERERS wiring in loadMatchups). Both card templates
// include a `.tier-ribbon` element up front, hidden by default, exactly
// like `.delta-badge` is always present but only populated when relevant.
function applyTierRibbon(card, tierData) {
  const ribbon = card.querySelector('.tier-ribbon');
  card.classList.remove('tier-champ', 'tier-third', 'tier-other');
  if (!ribbon) return;
  if (!tierData) { ribbon.hidden = true; return; }
  ribbon.hidden = false;
  ribbon.textContent = tierData.label;
  if (tierData.tier === 0) card.classList.add('tier-champ');
  else if (tierData.tier === 1) card.classList.add('tier-third');
  else card.classList.add('tier-other');
}

// ============================== SEASONAL THEMES ==============================
// Thanksgiving and Christmas week get a decorative treatment: falling
// leaves/snow across the whole page (#seasonalParticleCanvas), pumpkins +
// a leaf garland or a team-colored string-light garland on ESPN/Needle
// cards, and a one-line hint inside the kickoff countdown in the days
// leading up to the week.
//
// "Which week is it" is answered from the REAL NFL schedule (the same
// ESPN scoreboard endpoint fetchWeekStart already uses), never a
// hardcoded week number -- Thanksgiving is always the 4th Thursday of
// November and Christmas is always Dec 25, but which fantasy WEEK NUMBER
// contains that date shifts from season to season depending on how the
// Thursday-start weeks fall that year. A fixed "week === 12" would be
// wrong some seasons.
let debugThanksgivingWeek = localStorage.getItem('winProbDebugThanksgivingWeek') === 'true'; // set on preferences.html
let debugChristmasWeek = localStorage.getItem('winProbDebugChristmasWeek') === 'true'; // set on preferences.html
let debugHalloweenWeek = localStorage.getItem('winProbDebugHalloweenWeek') === 'true'; // set on preferences.html
let debugColdSnapPreWeek = localStorage.getItem('winProbDebugColdSnapPreWeek') === 'true'; // set on preferences.html
let debugColdSnapPostWeek = localStorage.getItem('winProbDebugColdSnapPostWeek') === 'true'; // set on preferences.html
let currentSeasonalTheme = 'none'; // 'none' | 'thanksgiving' | 'christmas' | 'halloween' | 'coldsnap-pre' | 'coldsnap-post' -- the CURRENTLY SELECTED week's theme, set once per loadMatchups call, read by the card render/update functions
let kcHintFestive = false; // true when the hinted 'christmas' week is really Christmas moved a week early for Championship Week -- hint reads "Festive week is ahead!"
let kcHintTheme = 'none'; // 'none' | 'thanksgiving' | 'christmas' | 'halloween' | 'coldsnap-pre' | 'coldsnap-post' -- the theme of the week the kickoff countdown is counting down TO (see updateKickoffCountdown), independent of currentSeasonalTheme

// Renders a JS Date as its US-Eastern calendar date (YYYY-MM-DD) -- NFL
// scheduling's own home timezone. Needed because a Thursday-NIGHT game's
// UTC timestamp can already read as the following day in UTC (an 8:20pm
// ET kickoff is 00:20-01:20 UTC), which would otherwise misclassify a
// Thanksgiving Thursday-night game as landing on Friday.
function usEasternDateKey(date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

// 4th Thursday of November, as a YYYY-MM-DD key -- the actual US
// Thanksgiving date for a given year, computed directly rather than
// looked up in a maintained table, so this stays correct for any season.
function thanksgivingDateKey(year) {
  const d = new Date(Date.UTC(year, 10, 1)); // November 1st
  let thursdays = 0;
  while (thursdays < 4) {
    if (d.getUTCDay() === 4) thursdays++;
    if (thursdays < 4) d.setUTCDate(d.getUTCDate() + 1);
  }
  return `${year}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function christmasDateKey(year) {
  return `${year}-12-25`;
}

function halloweenDateKey(year) {
  return `${year}-10-31`;
}

// A broader version of fetchWeekStart's cache -- that one only keeps the
// EARLIEST event date for a (year, week); this keeps every event's date,
// since Thanksgiving/Christmas detection needs to check whether ANY game
// that week lands on the target date, not just the first one.
let weekEventDatesCache = {};

async function fetchWeekEventDates(year, week) {
  const cacheKey = `${year}-${week}`;
  if (cacheKey in weekEventDatesCache) return weekEventDatesCache[cacheKey];
  try {
    const res = await fetch(`${NFL_SCOREBOARD_URL}?year=${year}&week=${week}&seasontype=2`);
    if (!res.ok) throw new Error(`ESPN scoreboard ${res.status}`);
    const data = await res.json();
    const dates = (data.events || [])
      .map((e) => (e.date ? new Date(e.date) : null))
      .filter((d) => d && !isNaN(d));
    weekEventDatesCache[cacheKey] = dates;
    return dates;
  } catch (err) {
    console.warn('Could not fetch NFL schedule for seasonal theme check:', err.message);
    weekEventDatesCache[cacheKey] = null;
    return null;
  }
}

// True if ANY game in this (year, week) actually falls on the given
// US-Eastern calendar date -- the real ground truth for "is this the
// Thanksgiving/Christmas week," independent of week numbering. Works for
// past seasons too (the same ESPN endpoint, just with an older year/week),
// which is what makes browsing an archived Week 12 still show the theme.
async function weekContainsDateKey(year, week, dateKey) {
  const dates = await fetchWeekEventDates(year, week);
  if (!dates || !dates.length) return false;
  return dates.some((d) => usEasternDateKey(d) === dateKey);
}

async function weekIsThanksgiving(year, week) {
  return weekContainsDateKey(year, week, thanksgivingDateKey(year));
}
// Raw calendar answer: does Dec 25 land in this week, regardless of anything else.
async function weekHasChristmasDate(year, week) {
  return weekContainsDateKey(year, week, christmasDateKey(year));
}
// True in the seasons where the real Christmas week IS Championship Week.
// Championship Week always takes priority over a holiday theme, so in that
// case Christmas (and Cold Snap with it) slides one week EARLIER instead of
// disappearing -- see weekIsChristmas / the Cold Snap helpers below.
async function christmasIsShifted(year) {
  return weekHasChristmasDate(year, CHAMPIONSHIP_WEEK);
}
// "Is this the week that gets the Christmas treatment." Normally the week
// containing Dec 25. When that's Championship Week, the championship look
// wins and Christmas moves to the week before it.
async function weekIsChristmas(year, week) {
  if (week === CHAMPIONSHIP_WEEK) return false;
  if (week === CHAMPIONSHIP_WEEK - 1 && await christmasIsShifted(year)) return true;
  return weekHasChristmasDate(year, week);
}

// Halloween is NOT reliably an actual NFL game day the way Thanksgiving and
// Christmas are (both of those always have a game scheduled ON the day
// itself) -- most seasons nothing is played on Oct 31 at all. So it can't
// use weekContainsDateKey's "did a game happen on this exact date" check;
// instead this asks a more general question: does Halloween's calendar
// date fall WITHIN this week's span, from this week's first kickoff up to
// (but not including) next week's first kickoff. Anchored at noon UTC on
// the target date, which safely lands on the same US-Eastern calendar day
// for every continental US timezone without needing its own DST handling.
async function weekSpansDateKey(year, week, dateKey) {
  const start = await fetchWeekStart(year, week);
  if (!start) return false;
  const nextStart = await fetchWeekStart(year, week + 1);
  const target = new Date(`${dateKey}T12:00:00Z`);
  if (isNaN(target)) return false;
  if (target < start) return false;
  if (nextStart && target >= nextStart) return false;
  return true;
}

async function weekIsHalloween(year, week) {
  return weekSpansDateKey(year, week, halloweenDateKey(year));
}

// Cold Snap: the week immediately before and the week immediately after
// Christmas week specifically -- NOT just "any week in winter." Defined
// relative to weekIsChristmas itself (± one week number) rather than an
// independent date calculation, so it automatically inherits Christmas's
// own real-schedule lookup and can't drift out of sync with it season to
// season. Christmas week itself keeps its existing full treatment
// unchanged -- these are the two quieter weeks bracketing it.
async function weekIsColdSnapPre(year, week) {
  return weekIsChristmas(year, week + 1);
}
async function weekIsColdSnapPost(year, week) {
  // No "after" week when Christmas was pushed back to make room for
  // Championship Week -- the week after the shifted Christmas IS
  // Championship Week, which keeps its own look.
  if (await christmasIsShifted(year)) return false;
  return weekIsChristmas(year, week - 1);
}

// The real (non-debug) answer -- used for the kickoff countdown's hint,
// which should always reflect the actual schedule regardless of whether
// a debug toggle is forcing the full look on for a different week.
async function realSeasonalTheme(year, week) {
  try {
    // Championship Week outranks every holiday theme that lands on it
    // (Christmas, if it was the one colliding, has already moved a week
    // earlier -- see weekIsChristmas).
    if (week === CHAMPIONSHIP_WEEK) return 'none';
    if (await weekIsHalloween(year, week)) return 'halloween';
    if (await weekIsThanksgiving(year, week)) return 'thanksgiving';
    if (await weekIsChristmas(year, week)) return 'christmas';
    if (await weekIsColdSnapPre(year, week)) return 'coldsnap-pre';
    if (await weekIsColdSnapPost(year, week)) return 'coldsnap-post';
  } catch {
    // best-effort -- fall through to 'none' rather than throwing
  }
  return 'none';
}

// The debug-overridable answer -- used for the currently selected week's
// full decor treatment. Thanksgiving wins over Christmas, which wins over
// Halloween, which wins over either Cold Snap phase, if more than one
// debug toggle is somehow on at once (see the preferences.html copy).
async function determineSeasonalTheme(year, week) {
  if (debugThanksgivingWeek) return 'thanksgiving';
  if (debugChristmasWeek) return 'christmas';
  if (debugHalloweenWeek) return 'halloween';
  if (debugColdSnapPreWeek) return 'coldsnap-pre';
  if (debugColdSnapPostWeek) return 'coldsnap-post';
  return realSeasonalTheme(year, week);
}

// Shown instead of the 'christmas' hint when Christmas was moved a week early
// to make room for Championship Week (it isn't literally Christmas week).
const SEASONAL_HINT_COPY_FESTIVE = '🔔 Something is on its way…';
const SEASONAL_HINT_COPY_WARN_XMAS = '🔔 Listen closely…';
const SEASONAL_HINT_COPY_WARN = '⚠️ Brace for impact…';
const SEASONAL_HINT_COPY = {
  // The three comet holidays are deliberately vague -- the comet and the
  // countdown carry the surprise (see SEASONAL_HINT_COPY_WARN for the last hour).
  thanksgiving: '☄️ Something is on its way…',
  christmas: '🔔 Something is on its way…',
  halloween: '☄️ Something is on its way…',
  'coldsnap-pre': '🥶 Cold Snap week is settling in',
  'coldsnap-post': '✨ The magic doesn’t end here',
};

// Cold Snap has two distinct theme tokens (coldsnap-pre/coldsnap-post)
// because the kickoff-countdown hint text genuinely differs between them,
// but the visual treatment (particles, card decor, countdown tint) is
// identical on either side of Christmas. Anywhere a CSS class or a
// particle-count table is keyed by theme, both tokens normalize to the
// same 'coldsnap' bucket through this helper, rather than duplicating
// every CSS rule and lookup entry twice for a difference that's text-only.
function seasonalCssTheme(theme) {
  return theme === 'coldsnap-pre' || theme === 'coldsnap-post' ? 'coldsnap' : theme;
}

function prefersReducedMotion() {
  return document.documentElement.getAttribute('data-reduce-motion') === 'true'
    || (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}

const SEASONAL_LEAF_COLORS = ['#c65d1e', '#d98324', '#8a3b12', '#e0a940', '#9c4a1a', '#b8461f'];
function seasonalRand(min, max) { return min + Math.random() * (max - min); }
function seasonalPick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

// Bats fly on a completely different model than leaves/snow -- rather than
// falling, each one patrols left<->right across a fixed altitude band
// (roughly the top half of the field), reversing direction once it's fully
// offscreen on either side, with a slow vertical bob layered on top so it
// reads as flight rather than a straight horizontal slide.
function makeSeasonalBat(width, height, initial, sizeScale) {
  const scale = sizeScale == null ? 1 : sizeScale;
  const dirX = seasonalPick([-1, 1]);
  return {
    isBat: true,
    x: initial ? seasonalRand(0, width) : (dirX === 1 ? -30 * scale : width + 30 * scale),
    y: seasonalRand(height * 0.06, height * 0.55),
    dirX,
    speed: seasonalRand(1.1, 2.3) * scale,
    size: seasonalRand(24, 34) * scale,
    bobSpeed: seasonalRand(0.6, 1.3),
    bobPhase: seasonalRand(0, Math.PI * 2),
    flapPhase: seasonalRand(0, Math.PI * 2),
    opacity: seasonalRand(0.82, 1),
  };
}

// width/height/sizeScale let one generator serve both the full-page field
// (large canvas, full-size particles) and the field confined to the
// kickoff countdown box (tiny canvas, particles scaled down to fit).
// Ice crystal -- a thin 6-spoke crystal rather than a filled glowing dot,
// so Cold Snap reads as distinctly "frost" rather than "more snow" even
// though it falls the same way. Pale icy blue-white, slower and sparser
// than Christmas's snow, with a slow twinkle (opacity breathing via
// twinklePhase, applied at draw time) instead of a steady glow. Reuses
// the same generic fall/sway/rotate physics as snow/leaves in
// stepSeasonalParticle -- only size/speed/opacity feel and the draw
// routine are different, so no special-case stepping (unlike bats) is
// needed.
function makeSeasonalIceCrystal(width, height, initial, sizeScale) {
  const scale = sizeScale == null ? 1 : sizeScale;
  return {
    x: seasonalRand(0, width),
    y: initial ? seasonalRand(0, height) : seasonalRand(-40, -10),
    size: seasonalRand(5, 10) * scale,
    speedY: seasonalRand(0.25, 0.6) * scale,
    speedX: seasonalRand(-0.15, 0.15) * scale,
    swayAmp: seasonalRand(10, 28) * scale,
    swaySpeed: seasonalRand(0.2, 0.5),
    swayPhase: seasonalRand(0, Math.PI * 2),
    rotation: seasonalRand(0, 360),
    rotSpeed: seasonalRand(-0.3, 0.3),
    twinklePhase: seasonalRand(0, Math.PI * 2),
    twinkleSpeed: seasonalRand(0.4, 0.9),
    baseOpacity: seasonalRand(0.35, 0.7),
  };
}

function makeSeasonalParticle(theme, width, height, initial, sizeScale) {
  const scale = sizeScale == null ? 1 : sizeScale;
  const isLeaf = theme === 'thanksgiving';
  if (theme === 'halloween') return makeSeasonalBat(width, height, initial, sizeScale);
  if (seasonalCssTheme(theme) === 'coldsnap') return makeSeasonalIceCrystal(width, height, initial, sizeScale);
  return {
    x: seasonalRand(0, width),
    y: initial ? seasonalRand(0, height) : seasonalRand(-40, -10),
    size: (isLeaf ? seasonalRand(9, 16) : seasonalRand(2.5, 5.5)) * scale,
    speedY: (isLeaf ? seasonalRand(0.5, 1.1) : seasonalRand(0.7, 1.7)) * scale,
    speedX: seasonalRand(-0.2, 0.2) * scale,
    swayAmp: seasonalRand(15, 40) * scale,
    swaySpeed: seasonalRand(0.4, 1.0),
    swayPhase: seasonalRand(0, Math.PI * 2),
    rotation: seasonalRand(0, 360),
    rotSpeed: seasonalRand(-1.2, 1.2),
    color: isLeaf ? SEASONAL_LEAF_COLORS[Math.floor(Math.random() * SEASONAL_LEAF_COLORS.length)] : '#ffffff',
    opacity: isLeaf ? seasonalRand(0.75, 1) : seasonalRand(0.45, 0.95),
  };
}

function stepSeasonalBat(p, t, width, height) {
  p.x += p.dirX * p.speed;
  p.y += Math.sin(t * 0.001 * p.bobSpeed + p.bobPhase) * 0.4;
  // Reverses once fully offscreen on either side (rather than teleporting
  // back to respawn), with a wide margin so the turn happens out of view --
  // reads as flying back the other way, never a visible snap.
  const margin = p.size * 2;
  if (p.x < -margin) { p.dirX = 1; p.x = -margin; }
  else if (p.x > width + margin) { p.dirX = -1; p.x = width + margin; }
}

function stepSeasonalParticle(p, theme, t, width, height, sizeScale) {
  if (p.isBat) {
    stepSeasonalBat(p, t, width, height);
    return;
  }
  p.y += p.speedY;
  p.x += p.speedX + Math.sin(t * 0.001 * p.swaySpeed + p.swayPhase) * (p.swayAmp * 0.01);
  p.rotation += p.rotSpeed;
  if (p.y > height + 30) Object.assign(p, makeSeasonalParticle(theme, width, height, false, sizeScale));
}

function drawSeasonalLeaf(targetCtx, p) {
  targetCtx.save();
  targetCtx.translate(p.x, p.y);
  targetCtx.rotate((p.rotation * Math.PI) / 180);
  targetCtx.globalAlpha = p.opacity;
  targetCtx.fillStyle = p.color;
  targetCtx.beginPath();
  const s = p.size;
  targetCtx.moveTo(0, -s);
  targetCtx.bezierCurveTo(s * 0.8, -s * 0.4, s * 0.6, s * 0.6, 0, s);
  targetCtx.bezierCurveTo(-s * 0.6, s * 0.6, -s * 0.8, -s * 0.4, 0, -s);
  targetCtx.fill();
  targetCtx.strokeStyle = 'rgba(0,0,0,0.25)';
  targetCtx.lineWidth = 0.6;
  targetCtx.beginPath();
  targetCtx.moveTo(0, -s * 0.85);
  targetCtx.lineTo(0, s * 0.85);
  targetCtx.stroke();
  targetCtx.restore();
}

// Snowflakes read the CURRENT theme at draw time (not baked into the
// particle at creation) so toggling light/dark mid-flurry repaints every
// flake immediately, rather than waiting for it to fall offscreen and
// respawn. White reads as "falling snow" on the dark background, but
// disappears into a white/light page, so light mode swaps in the site's
// own --accent blue (#1a3fa0) instead -- same color family as the rest of
// the light-mode UI, just visible against a light background.
const SEASONAL_SNOW_COLOR_DARK = '#ffffff';
const SEASONAL_SNOW_COLOR_LIGHT = '#1a3fa0';
function drawSeasonalSnow(targetCtx, p) {
  const isLight = theme === 'light';
  targetCtx.save();
  targetCtx.globalAlpha = p.opacity;
  targetCtx.fillStyle = isLight ? SEASONAL_SNOW_COLOR_LIGHT : SEASONAL_SNOW_COLOR_DARK;
  targetCtx.shadowColor = isLight ? 'rgba(26, 63, 160, 0.45)' : 'rgba(255,255,255,0.8)';
  targetCtx.shadowBlur = 4;
  targetCtx.beginPath();
  targetCtx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
  targetCtx.fill();
  targetCtx.restore();
}

// Bat silhouette: two wing lobes around a small body, wing-span breathing
// with flapPhase so it reads as flapping in flight. Faces the direction
// it's actually flying (mirrored via dirX) rather than a fixed orientation,
// with a soft violet glow + a light rim stroke so it stays legible against
// the page instead of reading as a flat black blob (same reasoning as the
// light-mode snow color swap above -- readability first).
function drawSeasonalBat(targetCtx, p, t) {
  const isLight = theme === 'light';
  targetCtx.save();
  targetCtx.translate(p.x, p.y);
  targetCtx.scale(p.dirX, 1);
  targetCtx.globalAlpha = p.opacity;
  // Same reasoning as the light-mode snow color swap: a dark bat silhouette
  // disappears against a light page, so light mode goes darker/more
  // saturated on the fill and glow rather than the lighter lavender that
  // reads fine on the dark theme.
  targetCtx.shadowColor = isLight ? 'rgba(91, 42, 134, 0.4)' : 'rgba(190, 150, 255, 0.55)';
  targetCtx.shadowBlur = 10;
  targetCtx.fillStyle = isLight ? '#241f33' : '#4a3d66';
  targetCtx.strokeStyle = isLight ? 'rgba(91, 42, 134, 0.55)' : 'rgba(214, 190, 255, 0.6)';
  targetCtx.lineWidth = 1;
  const s = p.size;
  const flap = 0.5 + 0.5 * Math.sin(t * 0.008 + p.flapPhase); // 0..1
  const wingW = s * (0.85 + flap * 0.55);
  targetCtx.beginPath();
  targetCtx.moveTo(0, 0);
  targetCtx.quadraticCurveTo(-wingW * 0.5, -s * 0.65, -wingW, 0);
  targetCtx.quadraticCurveTo(-wingW * 0.55, s * 0.18, -wingW * 0.3, -s * 0.05);
  targetCtx.quadraticCurveTo(-s * 0.15, s * 0.12, 0, 0);
  targetCtx.quadraticCurveTo(s * 0.15, s * 0.12, wingW * 0.3, -s * 0.05);
  targetCtx.quadraticCurveTo(wingW * 0.55, s * 0.18, wingW, 0);
  targetCtx.quadraticCurveTo(wingW * 0.5, -s * 0.65, 0, 0);
  targetCtx.fill();
  targetCtx.stroke();
  targetCtx.restore();
}

// Twinkle (opacity breathing) rather than a steady glow, and a pale
// icy-blue stroke that swaps slightly for light/dark mode same as the
// snow color swap above -- readability first, same reasoning.
function drawSeasonalIceCrystal(targetCtx, p, t) {
  const isLight = theme === 'light';
  const twinkle = 0.65 + 0.35 * Math.sin(t * 0.001 * p.twinkleSpeed + p.twinklePhase);
  targetCtx.save();
  targetCtx.translate(p.x, p.y);
  targetCtx.rotate((p.rotation * Math.PI) / 180);
  targetCtx.globalAlpha = p.baseOpacity * twinkle;
  targetCtx.strokeStyle = isLight ? '#5b9bd5' : '#bfe0ff';
  targetCtx.lineWidth = Math.max(0.8, p.size * 0.1);
  targetCtx.lineCap = 'round';
  const s = p.size;
  for (let i = 0; i < 3; i++) {
    targetCtx.save();
    targetCtx.rotate((Math.PI / 3) * i);
    targetCtx.beginPath();
    targetCtx.moveTo(0, -s);
    targetCtx.lineTo(0, s);
    targetCtx.stroke();
    // small side branches near each tip, like a simplified snowflake
    targetCtx.beginPath();
    targetCtx.moveTo(0, -s); targetCtx.lineTo(s * 0.3, -s * 0.65);
    targetCtx.moveTo(0, -s); targetCtx.lineTo(-s * 0.3, -s * 0.65);
    targetCtx.moveTo(0, s); targetCtx.lineTo(s * 0.3, s * 0.65);
    targetCtx.moveTo(0, s); targetCtx.lineTo(-s * 0.3, s * 0.65);
    targetCtx.stroke();
    targetCtx.restore();
  }
  targetCtx.restore();
}

function drawSeasonalParticle(targetCtx, theme, p, t) {
  if (theme === 'thanksgiving') drawSeasonalLeaf(targetCtx, p);
  else if (theme === 'halloween') drawSeasonalBat(targetCtx, p, t);
  else if (seasonalCssTheme(theme) === 'coldsnap') drawSeasonalIceCrystal(targetCtx, p, t);
  else drawSeasonalSnow(targetCtx, p);
}

// ---- Full-page particle field ----
const seasonalCanvas = document.getElementById('seasonalParticleCanvas');
const seasonalCtx = seasonalCanvas ? seasonalCanvas.getContext('2d') : null;
let seasonalParticles = [];

function resizeSeasonalCanvas() {
  if (!seasonalCanvas) return;
  seasonalCanvas.width = window.innerWidth;
  seasonalCanvas.height = window.innerHeight;
}
window.addEventListener('resize', resizeSeasonalCanvas);
resizeSeasonalCanvas();

const SEASONAL_PARTICLE_COUNTS = { thanksgiving: 45, christmas: 90, halloween: 22, coldsnap: 28, none: 0 };
const SEASONAL_KC_PARTICLE_COUNTS = { thanksgiving: 10, christmas: 16, halloween: 6, coldsnap: 8, none: 0 };

function seedSeasonalParticles() {
  if (!seasonalCanvas) return;
  const count = SEASONAL_PARTICLE_COUNTS[seasonalCssTheme(currentSeasonalTheme)] || 0;
  seasonalParticles = [];
  for (let i = 0; i < count; i++) {
    seasonalParticles.push(makeSeasonalParticle(currentSeasonalTheme, seasonalCanvas.width, seasonalCanvas.height, true, 1));
  }
}

function seasonalTick(t) {
  if (seasonalCtx) {
    seasonalCtx.clearRect(0, 0, seasonalCanvas.width, seasonalCanvas.height);
    if (currentSeasonalTheme !== 'none' && !prefersReducedMotion()) {
      for (const p of seasonalParticles) {
        stepSeasonalParticle(p, currentSeasonalTheme, t, seasonalCanvas.width, seasonalCanvas.height, 1);
        drawSeasonalParticle(seasonalCtx, currentSeasonalTheme, p, t);
      }
    }
  }
  requestAnimationFrame(seasonalTick);
}
requestAnimationFrame(seasonalTick);

// ---- Kickoff-countdown-box particle field (the pregame "hint") ----
const kcCanvas = document.getElementById('kickoffCountdownParticles');
const kcCtx = kcCanvas ? kcCanvas.getContext('2d') : null;
let kcParticles = [];

function resizeKcCanvas() {
  if (!kcCanvas) return false;
  const box = document.getElementById('kickoffCountdown');
  if (!box || box.hidden) return false;
  // clientWidth/Height = the padding box the canvas is stretched over (inset:0),
  // and unlike getBoundingClientRect it ignores the box's pulse transform.
  const w = box.clientWidth, h = box.clientHeight;
  if (w <= 0 || h <= 0) return false;
  kcCanvas.width = w; kcCanvas.height = h;
  return true;
}
window.addEventListener('resize', () => { kcSeedKey = ''; });

let kcSeedKey = '';
// Seeds only when the theme or the box size actually changed, so periodic
// refreshes / returning to the tab never reshuffle the bats.
function seedKcParticles() {
  if (!kcCanvas) return;
  const box = document.getElementById('kickoffCountdown');
  if (!box || box.hidden || box.clientWidth <= 0 || box.clientHeight <= 0) return;
  const key = kcHintTheme + '|' + box.clientWidth + 'x' + box.clientHeight;
  if (key === kcSeedKey && kcParticles.length) return;
  if (!resizeKcCanvas()) return;
  kcSeedKey = key;
  const count = SEASONAL_KC_PARTICLE_COUNTS[seasonalCssTheme(kcHintTheme)] || 0;
  kcParticles = [];
  for (let i = 0; i < count; i++) {
    kcParticles.push(makeSeasonalParticle(kcHintTheme, kcCanvas.width, kcCanvas.height, true, 0.5));
  }
}

function kcTick(t) {
  if (kcCtx) {
    // Self-heal: seed once the box has a real size (no-op if nothing changed).
    if (kcHintTheme !== 'none') seedKcParticles();
    kcCtx.clearRect(0, 0, kcCanvas.width, kcCanvas.height);
    if (kcHintTheme !== 'none' && !prefersReducedMotion()) {
      for (const p of kcParticles) {
        stepSeasonalParticle(p, kcHintTheme, t, kcCanvas.width, kcCanvas.height, 0.5);
        drawSeasonalParticle(kcCtx, kcHintTheme, p, t);
      }
    }
  }
  requestAnimationFrame(kcTick);
}
requestAnimationFrame(kcTick);

// ---- Countdown meteors: small holiday-colored fireballs streaking across the
// whole screen while the kickoff countdown is showing. One every ~8-16s more
// than a day out; inside the final 24h the gap shrinks steadily (and keeps
// shrinking) until kickoff, ending in a proper shower.
const cmCanvas = document.getElementById('cdMeteorCanvas');
const cmCtx = cmCanvas ? cmCanvas.getContext('2d') : null;
let cmList = [];
let cmNext = 0;
const CM_COLORS = { halloween: '255,154,60', thanksgiving: '224,136,58', christmas: '79,212,147', 'coldsnap-pre': '150,205,255', 'coldsnap-post': '150,205,255', none: '255,170,90' };
function resizeCmCanvas() { if (cmCanvas) { cmCanvas.width = window.innerWidth; cmCanvas.height = window.innerHeight; } }
window.addEventListener('resize', resizeCmCanvas); resizeCmCanvas();

function cmInterval(remainingMs) {
  const H24 = 24 * 3600 * 1000;
  const jitter = 0.6 + Math.random() * 0.8;
  if (remainingMs > H24) return (8000 + Math.random() * 8000);
  const p = 1 - Math.max(0, remainingMs) / H24;          // 0 at 24h out -> 1 at kickoff
  return (11000 * Math.pow(1 - p, 1.8) + 700) * jitter;   // ~11s -> ~0.7s
}
function cmSpawn(rgb, W, H) {
  // Same heading as the holiday comet: its tail trails up-left, so it is
  // travelling toward the lower-right at ~14 degrees. Meteors enter from the
  // left / top-left edge and cross the page along that same line.
  const sp = 8 + Math.random() * 7, ang = 0.245 + (Math.random() - 0.5) * 0.1;
  const tail = 70 + Math.random() * 110;
  cmList.push({ x: -tail - Math.random() * W * 0.45, y: Math.random() * H * 0.7 - 20,
    vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp, r: 1.8 + Math.random() * 2.6, tail, rgb, sparks: [] });
}
const snowList = [];
function cmBlizzardLevel(remainingMs) {          // 0 (calm flurries) -> 1 (whiteout), smooth over the last ~3 days
  const p = Math.min(Math.max(1 - remainingMs / (72 * 3600 * 1000), 0), 1);
  return Math.pow(p, 1.5);
}
function cmSnowTick() {
  const W = cmCanvas.width, H = cmCanvas.height;
  const remaining = kickoffCountdownTarget.getTime() - Date.now();
  const b = cmBlizzardLevel(remaining);
  document.documentElement.style.setProperty('--blizz', b.toFixed(3));
  const want = Math.round(14 + b * 560);
  while (snowList.length < want) snowList.push({ x: Math.random() * (W + 200) - 100, y: Math.random() * H, r: 0.8 + Math.random() * 2.2, z: 0.5 + Math.random() * 1.0, ph: Math.random() * 6.28 });
  if (snowList.length > want) snowList.length = want;
  const vy0 = 0.9 + b * 9, wind = 0.25 + b * 11;
  cmCtx.fillStyle = cmCtx.strokeStyle = '#fff';
  for (const f of snowList) {
    const vy = vy0 * f.z, vx = wind * f.z + Math.sin(f.ph + performance.now() / 1200) * (0.4 + b * 0.8);
    f.x += vx; f.y += vy;
    if (f.y > H + 10) { f.y = -10; f.x = Math.random() * (W + 200) - 100; }
    if (f.x > W + 30) { f.x = -30; f.y = Math.random() * H; }
    cmCtx.globalAlpha = Math.min(0.9, 0.35 + f.z * 0.4);
    if (b > 0.25) { cmCtx.lineWidth = f.r * 0.9; cmCtx.beginPath(); cmCtx.moveTo(f.x, f.y); cmCtx.lineTo(f.x - vx * (1 + b * 2.2), f.y - vy * (1 + b * 2.2)); cmCtx.stroke(); }
    else { cmCtx.beginPath(); cmCtx.arc(f.x, f.y, f.r, 0, Math.PI * 2); cmCtx.fill(); }
  }
  cmCtx.globalAlpha = 1;
}
function cmTick(t) {
  if (cmCtx) {
    cmCtx.clearRect(0, 0, cmCanvas.width, cmCanvas.height);
    const hasTarget = !!kickoffCountdownTarget && !cometSuppressed;
    const okMotion = !prefersReducedMotion() && !document.hidden;
    const snowMode = hasTarget && kcHintTheme === 'christmas';
    const meteorMode = hasTarget && (kcHintTheme === 'halloween' || kcHintTheme === 'thanksgiving');
    cmCanvas.style.zIndex = snowMode ? '3' : '0';
    if (!snowMode) { document.documentElement.style.setProperty('--blizz', '0'); snowList.length = 0; }
    if (snowMode && okMotion) cmSnowTick();
    if (meteorMode && okMotion) {
      const now = performance.now(), remaining = kickoffCountdownTarget.getTime() - Date.now();
      if (remaining > 0 && now >= cmNext) {
        const rgb = CM_COLORS[kcHintTheme] || CM_COLORS.none;
        if (cmList.length < 16) cmSpawn(rgb, cmCanvas.width, cmCanvas.height);
        if (remaining < 3600 * 1000 && Math.random() < 0.35 && cmList.length < 16) cmSpawn(rgb, cmCanvas.width, cmCanvas.height); // last hour: occasional doubles
        cmNext = now + cmInterval(remaining);
      }
    } else if (!meteorMode) cmList.length = 0;
    cmCtx.globalCompositeOperation = 'lighter';
    for (let i = cmList.length - 1; i >= 0; i--) {
      const m = cmList[i];
      m.x += m.vx; m.y += m.vy;
      if (Math.random() < 0.5) m.sparks.push({ x: m.x, y: m.y, vx: -m.vx * 0.1 + (Math.random() - 0.5) * 1.2, vy: -m.vy * 0.1 + (Math.random() - 0.5) * 1.2 + 0.2, life: 1 });
      const len = Math.hypot(m.vx, m.vy), ux = m.vx / len, uy = m.vy / len, tx = m.x - ux * m.tail, ty = m.y - uy * m.tail;
      const g = cmCtx.createLinearGradient(m.x, m.y, tx, ty);
      g.addColorStop(0, `rgba(255,248,230,0.95)`); g.addColorStop(0.15, `rgba(${m.rgb},0.7)`); g.addColorStop(1, `rgba(${m.rgb},0)`);
      cmCtx.strokeStyle = g; cmCtx.lineCap = 'round';
      cmCtx.lineWidth = m.r * 2.2; cmCtx.globalAlpha = 0.55; cmCtx.beginPath(); cmCtx.moveTo(m.x, m.y); cmCtx.lineTo(tx, ty); cmCtx.stroke();
      cmCtx.lineWidth = m.r * 0.9; cmCtx.globalAlpha = 1; cmCtx.beginPath(); cmCtx.moveTo(m.x, m.y); cmCtx.lineTo(tx, ty); cmCtx.stroke();
      const hg = cmCtx.createRadialGradient(m.x, m.y, 0, m.x, m.y, m.r * 5);
      hg.addColorStop(0, 'rgba(255,255,255,0.95)'); hg.addColorStop(0.3, `rgba(${m.rgb},0.6)`); hg.addColorStop(1, `rgba(${m.rgb},0)`);
      cmCtx.fillStyle = hg; cmCtx.beginPath(); cmCtx.arc(m.x, m.y, m.r * 5, 0, Math.PI * 2); cmCtx.fill();
      for (let k = m.sparks.length - 1; k >= 0; k--) {
        const s = m.sparks[k]; s.x += s.vx; s.y += s.vy; s.life -= 0.04;
        if (s.life <= 0) { m.sparks.splice(k, 1); continue; }
        cmCtx.fillStyle = `rgba(${m.rgb},${s.life * 0.8})`; cmCtx.beginPath(); cmCtx.arc(s.x, s.y, 0.9, 0, Math.PI * 2); cmCtx.fill();
      }
      if (m.y > cmCanvas.height + m.tail || m.x > cmCanvas.width + m.tail + 100) cmList.splice(i, 1);
    }
    cmCtx.globalCompositeOperation = 'source-over'; cmCtx.globalAlpha = 1;
  }
  requestAnimationFrame(cmTick);
}
requestAnimationFrame(cmTick);

// ============================== NIGHT-GAME SKY ==============================
// A night sky that only exists during PRIMETIME games -- Thursday / Sunday /
// Monday night, whenever an in-progress game kicked off at 6pm Eastern or
// later (see isPrimetimeNow). There is deliberately no afternoon / "calm"
// version: the sky being absent the rest of the week is what makes it feel
// special when it shows up. Everything below is part of that one look:
//   - stars (dark mode only) that drift very slightly on scroll
//   - a moon showing the REAL lunar phase, anchored to the top of the page
//   - a stadium-light haze along the bottom edge (see index.html's CSS)
//   - rare random shooting stars (dark mode, normal weeks only)
//   - a brighter, glowing shooting star in the team's color whenever a
//     team TAKES the lead in a live matchup (both themes)
// The person's light/dark choice is never changed -- dark gets the night
// sky, light gets only a dusk-tinted haze (stars can't show on white).
//
// Separate from the HOLIDAY COMET below, which is a once-a-week signpost
// and shows whether or not it's a primetime night.
let debugNightSky = localStorage.getItem('winProbDebugNightSky') === 'true'; // set on preferences.html
let debugComet = localStorage.getItem('winProbDebugComet') || 'none'; // set on preferences.html
let skyActive = false;
let skyHideAt = 0; // keeps drawing briefly after deactivation so the CSS fade-out isn't cut short by an empty canvas

const skyCanvas = document.getElementById('skyCanvas');
const skyCtx = skyCanvas ? skyCanvas.getContext('2d') : null;
let skyStars = [];
let skyLeads = [];
let skyShooting = null;
let lastSkyShoot = performance.now();
const SKY_STAR_COUNT = 85;
const SKY_RANDOM_SHOOT_EVERY_MS = 28000;

function resizeSkyCanvas() {
  if (!skyCanvas) return;
  skyCanvas.width = window.innerWidth;
  skyCanvas.height = window.innerHeight;
  seedSkyStars();
}

function seedSkyStars() {
  if (!skyCanvas) return;
  skyStars = [];
  for (let i = 0; i < SKY_STAR_COUNT; i++) {
    skyStars.push({
      x: seasonalRand(0, skyCanvas.width),
      // Denser toward the top, thinning toward the horizon.
      y: Math.pow(Math.random(), 1.6) * skyCanvas.height,
      r: seasonalRand(0.5, 1.5), base: seasonalRand(0.3, 0.9),
      phase: seasonalRand(0, Math.PI * 2), speed: seasonalRand(0.4, 1.2),
      big: Math.random() < 0.08,
      // Scroll-parallax depth: far stars barely move, near ones a little
      // more. Max shift is ~8% of the scroll distance -- slight, never dizzying.
      depth: seasonalRand(0.3, 1.6),
    });
  }
}
window.addEventListener('resize', resizeSkyCanvas);
resizeSkyCanvas();

// ---- "Is it a primetime game window right now?" ----
// From the real NFL schedule (fetchWeekEventDates, the same lookup the
// seasonal themes use), classified in US-Eastern like everything else on
// this site -- not the viewer's own clock. A game counts as in progress
// from kickoff until ~3.5 hours later.
const SKY_PRIMETIME_START_HOUR_ET = 18;
const SKY_GAME_WINDOW_MS = 3.5 * 60 * 60 * 1000;
const skyEasternHourFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', hourCycle: 'h23' });
async function isPrimetimeNow(year, week) {
  const dates = await fetchWeekEventDates(year, week);
  if (!dates || !dates.length) return false;
  const now = Date.now();
  return dates.some((d) => {
    const hour = Number(skyEasternHourFmt.format(d));
    return hour >= SKY_PRIMETIME_START_HOUR_ET && now >= d.getTime() && now < d.getTime() + SKY_GAME_WINDOW_MS;
  });
}

// ---- Real moon phase (computed from the date) ----
const SKY_SYNODIC_DAYS = 29.530588853;
function moonPhaseFor(date) {
  const knownNewMoon = Date.UTC(2000, 0, 6, 18, 14);
  const days = (date.getTime() - knownNewMoon) / 86400000;
  return (((days / SKY_SYNODIC_DAYS) % 1) + 1) % 1; // 0 = new, 0.5 = full
}
function drawSkyMoon() {
  const mc = document.getElementById('moonCanvas');
  const moonEl = document.getElementById('moon');
  if (!mc || !moonEl) return;
  const c = mc.getContext('2d');
  const p = moonPhaseFor(new Date());
  const R = 30, cx = 32, cy = 32;
  c.clearRect(0, 0, 64, 64);
  // Unlit side keeps a faint earthshine so the dark part is still barely visible.
  c.fillStyle = '#2b3043'; // opaque on purpose -- a translucent disc lets stars show through the moon
  c.beginPath(); c.arc(cx, cy, R, 0, Math.PI * 2); c.fill();
  const k = Math.cos(2 * Math.PI * p); // 1 at new ... -1 at full
  c.save();
  c.translate(cx, cy);
  if (p >= 0.5) c.scale(-1, 1); // waning = lit on the left, so mirror
  const lit = c.createRadialGradient(-6, -6, 2, 0, 0, R);
  lit.addColorStop(0, '#fdfdf6'); lit.addColorStop(0.6, '#e6e8ee'); lit.addColorStop(1, '#c4c9d6');
  c.fillStyle = lit;
  c.beginPath();
  c.arc(0, 0, R, -Math.PI / 2, Math.PI / 2, false); // lit limb
  c.ellipse(0, 0, Math.max(0.01, R * Math.abs(k)), R, 0, Math.PI / 2, -Math.PI / 2, k > 0); // terminator
  c.closePath(); c.fill();
  c.restore();
  const illum = (1 - Math.cos(2 * Math.PI * p)) / 2;
  moonEl.style.setProperty('--moon-glow', (0.15 + 0.85 * illum).toFixed(2)); // fuller moon, stronger halo
}
drawSkyMoon();

// ---- Lead-change shooting star: brighter, glowier, in the team's color ----
// The home team (left side of the matchup) crosses left-to-right, the away
// team right-to-left, echoing which side of the win-probability graph each
// lives on. Drawn additively on dark, normally on light.
function makeSkyLead(W, H, color, dir) {
  const speed = seasonalRand(9, 12);
  return {
    x: dir === 1 ? -40 : W + 40, y: seasonalRand(H * 0.08, H * 0.38),
    vx: dir * speed, vy: seasonalRand(2.0, 3.2), life: 0, max: Math.ceil((W + 120) / speed), color,
  };
}
function skyRgba(hex, a) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((ch) => ch + ch).join('') : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
function drawSkyLead(c, s) {
  const dark = theme === 'dark';
  const tailX = s.x - s.vx * 12, tailY = s.y - s.vy * 12;
  const fade = Math.min(1, (s.max - s.life) / 14);
  c.save();
  c.globalCompositeOperation = dark ? 'lighter' : 'source-over';
  c.lineCap = 'round';
  let g = c.createLinearGradient(s.x, s.y, tailX, tailY); // soft wide underlay = the glow
  g.addColorStop(0, skyRgba(s.color, 0.35 * fade)); g.addColorStop(1, skyRgba(s.color, 0));
  c.strokeStyle = g; c.lineWidth = 12;
  c.beginPath(); c.moveTo(s.x, s.y); c.lineTo(tailX, tailY); c.stroke();
  g = c.createLinearGradient(s.x, s.y, tailX, tailY); // bright core trail
  g.addColorStop(0, skyRgba(s.color, 0.95 * fade)); g.addColorStop(1, skyRgba(s.color, 0));
  c.strokeStyle = g; c.lineWidth = 3.2;
  c.beginPath(); c.moveTo(s.x, s.y); c.lineTo(tailX, tailY); c.stroke();
  const hg = c.createRadialGradient(s.x, s.y, 0, s.x, s.y, 20); // glowing head
  hg.addColorStop(0, `rgba(255,255,255,${0.95 * fade})`);
  hg.addColorStop(0.25, skyRgba(s.color, 0.8 * fade));
  hg.addColorStop(1, skyRgba(s.color, 0));
  c.fillStyle = hg;
  c.beginPath(); c.arc(s.x, s.y, 20, 0, Math.PI * 2); c.fill();
  c.restore();
}
// Only fires while the night sky is actually up (primetime, or the debug
// toggle) -- never in the afternoon, same "shooting stars are a night
// thing" rule as the random ones. Also callable from the console to preview:
// fireSkyLeadStar('#3a67df', 1).
function fireSkyLeadStar(color, dir) {
  if (!skyCanvas || !skyActive || prefersReducedMotion()) return;
  skyLeads.push(makeSkyLead(skyCanvas.width, skyCanvas.height, color, dir));
}
window.fireSkyLeadStar = fireSkyLeadStar;

// Watches each matchup's win-probability LEADER between polls and fires a
// lead-change star when it flips. The first time a given league/year/week
// is seen it only records who's ahead (no star -- nothing "changed" yet),
// and finished matchups never fire. Several flips in one poll are staggered
// half a second apart so they read as separate moments.
let leadSideByMatchup = {};
let leadTrackKey = null;
function trackLeadChanges(leagueId, year, week, byMatchup, teamInfo) {
  // Tabbed-out polls are skipped on purpose: leadSideByMatchup keeps the
  // side from the last time you were looking, so the refresh fired by the
  // visibilitychange handler below compares against that and the star plays
  // when you come back (net change only -- A->B->A while away fires nothing).
  if (document.hidden) return;
  const key = `${leagueId}|${year}|${week}`;
  const fresh = key !== leadTrackKey;
  if (fresh) { leadTrackKey = key; leadSideByMatchup = {}; }
  let delay = 0;
  for (const [matchupId, rows] of Object.entries(byMatchup)) {
    const homeRow = latestRow(rows, true);
    const awayRow = latestRow(rows, false);
    if (!homeRow || !awayRow) continue;
    const allDone = !!(homeRow.all_starters_done && awayRow.all_starters_done);
    const pct = latestPct(rows);
    const side = pct > 50 ? 'home' : pct < 50 ? 'away' : null; // an exact 50 isn't a lead for anyone
    const prev = leadSideByMatchup[matchupId];
    if (side) leadSideByMatchup[matchupId] = side;
    if (!fresh && !allDone && side && prev && prev !== side) {
      const team = teamInfo[(side === 'home' ? homeRow : awayRow).team_id];
      if (team) {
        const dir = side === 'home' ? 1 : -1;
        setTimeout(() => fireSkyLeadStar(team.color, dir), delay);
        delay += 500;
      }
    }
  }
}

function skyTick(t) {
  if (skyCtx) {
    skyCtx.clearRect(0, 0, skyCanvas.width, skyCanvas.height);
    const now = performance.now();
    if (skyActive || now < skyHideAt || skyLeads.length) {
      const dark = theme === 'dark';
      const reduced = prefersReducedMotion();
      const seasonal = seasonalCssTheme(currentSeasonalTheme);
      const championship = document.documentElement.getAttribute('data-championship-active') === 'true';
      if (dark && seasonal !== 'coldsnap') { // Cold Snap's ice crystals ARE the sky that week -- no stars competing
        // Dimmed behind Thanksgiving leaves / Christmas snow / Halloween bats;
        // cut to roughly a third during Championship Week so the spotlights lead.
        const dim = (seasonal === 'thanksgiving' || seasonal === 'christmas' || seasonal === 'halloween') ? 0.4 : 1;
        const visibleCount = championship ? Math.ceil(skyStars.length / 3) : skyStars.length;
        const scrollY = reduced ? 0 : window.scrollY;
        const H = skyCanvas.height;
        for (let i = 0; i < visibleCount; i++) {
          const s = skyStars[i];
          const tw = reduced ? 1 : 0.65 + 0.35 * Math.sin(t * 0.001 * s.speed + s.phase);
          const yy = (((s.y - scrollY * 0.05 * s.depth) % H) + H) % H; // slight drift, wrapped so the field never empties
          skyCtx.globalAlpha = Math.min(1, s.base * tw * dim);
          skyCtx.fillStyle = '#ffffff';
          if (s.big) { skyCtx.shadowColor = '#bcd0ff'; skyCtx.shadowBlur = 6; }
          skyCtx.beginPath(); skyCtx.arc(s.x, yy, s.big ? s.r * 1.5 : s.r, 0, Math.PI * 2); skyCtx.fill();
          skyCtx.shadowBlur = 0;
        }
        skyCtx.globalAlpha = 1;
      }
      // Rare random shooting star: dark mode, primetime, and only in a
      // plain week -- a streak crossing falling leaves/snow/bats is noise.
      if (skyActive && dark && !reduced && seasonal === 'none' && now - lastSkyShoot > SKY_RANDOM_SHOOT_EVERY_MS) {
        lastSkyShoot = now;
        skyShooting = { x: seasonalRand(skyCanvas.width * 0.2, skyCanvas.width * 0.9), y: seasonalRand(0, skyCanvas.height * 0.3), vx: -seasonalRand(7, 10), vy: seasonalRand(3.5, 5), life: 0, max: 55 };
      }
      if (skyShooting) {
        skyShooting.x += skyShooting.vx; skyShooting.y += skyShooting.vy; skyShooting.life++;
        const a = 1 - skyShooting.life / skyShooting.max;
        const g = skyCtx.createLinearGradient(skyShooting.x, skyShooting.y, skyShooting.x - skyShooting.vx * 7, skyShooting.y - skyShooting.vy * 7);
        g.addColorStop(0, `rgba(255,255,255,${a})`); g.addColorStop(1, 'rgba(255,255,255,0)');
        skyCtx.strokeStyle = g; skyCtx.lineWidth = 1.6; skyCtx.lineCap = 'round';
        skyCtx.beginPath(); skyCtx.moveTo(skyShooting.x, skyShooting.y); skyCtx.lineTo(skyShooting.x - skyShooting.vx * 7, skyShooting.y - skyShooting.vy * 7); skyCtx.stroke();
        if (skyShooting.life >= skyShooting.max) skyShooting = null;
      }
      for (const s of skyLeads) { s.x += s.vx; s.y += s.vy; s.life++; drawSkyLead(skyCtx, s); }
      skyLeads = skyLeads.filter((s) => s.life < s.max);
    }
  }
  requestAnimationFrame(skyTick);
}
requestAnimationFrame(skyTick);

// ---- Holiday comet: a small, STILL comet with the upcoming event's symbol ----
// Shown only in the week BEFORE the event, parked near the top of the page
// (a plain absolutely-positioned element, so it scrolls away with the page
// like the moon). There's no Cold Snap comet on purpose: the Cold Snap
// "before Christmas" week is itself the week where Christmas is next week,
// so the Christmas comet already covers it.
const SKY_COMETS = {
  halloween:    { emoji: '\u{1F383}', color: '#ff9a3c', label: 'Halloween is next week' },
  thanksgiving: { emoji: '\u{1F983}', color: '#e0883a', label: 'Thanksgiving is next week' },
  christmas:    { emoji: '\u{1F98C}\u{1F98C}\u{1F6F7}', color: '#4fd493', label: 'Something is coming…', sleigh: true },
};
// The comet APPROACHES over the week. Early on (Tuesday, when only Power
// Picks are showing) it's a faint short dash of the event's color, far off
// toward the corner; as the week goes it grows, brightens and slides closer,
// and over the weekend the event's emoji fades in as the head. Progress runs
// from two days before the week's first kickoff (about when Power Picks
// appear) to five days after it (about when the next week takes over).
const COMET_LEAD_MS = 2 * 86400000;
const COMET_SPAN_MS = 5.7 * 86400000; // reaches 1 at about Sunday's 1pm games
const COMET_SYMBOL_FROM = 0.45; // emoji starts fading in (about Friday morning)
const COMET_SYMBOL_FULL = 0.8;  // emoji fully shown (about Saturday night)
// Impact: from Sunday evening (when the comet has fully arrived) through the
// end of Monday night it swells toward the page -- huge, bright, about to hit.
// 0 = normal arrived comet, 1 = full impact; it then holds until the next week takes over.
const COMET_IMPACT_FROM_MS = 3.7 * 86400000; // after the week's first kickoff (= progress 1)
const COMET_IMPACT_SPAN_MS = 0.5 * 86400000; // ~Sunday 8pm -> Monday night's last whistle
let debugCometProgress = localStorage.getItem('winProbDebugCometProgress') || 'auto'; // set on preferences.html
async function cometImpact(year, week) {
  if (/^i\d+$/.test(debugCometProgress)) return Math.min(Math.max(Number(debugCometProgress.slice(1)) / 100, 0), 1);
  if (debugCometProgress !== 'auto' || debugComet !== 'none') return 0;
  const start = await fetchWeekStart(year, week);
  if (!start) return 0;
  const i = (Date.now() - (start.getTime() + COMET_IMPACT_FROM_MS)) / COMET_IMPACT_SPAN_MS;
  return Math.min(Math.max(i, 0), 1);
}
async function cometProgress(year, week) {
  if (/^i\d+$/.test(debugCometProgress)) return 1;
  if (debugCometProgress !== 'auto') {
    const forced = Number(debugCometProgress);
    if (Number.isFinite(forced)) return Math.min(Math.max(forced / 100, 0), 1);
  }
  if (debugComet !== 'none') return 1; // forcing a comet with no progress choice shows it fully arrived
  const start = await fetchWeekStart(year, week);
  if (!start) return 1; // schedule unavailable -> the old fully-visible comet
  const p = (Date.now() - (start.getTime() - COMET_LEAD_MS)) / COMET_SPAN_MS;
  return Math.min(Math.max(p, 0), 1);
}
async function cometForWeek(year, week) {
  let base = null;
  if (debugComet !== 'none') {
    base = SKY_COMETS[debugComet] || null;
  } else if (yearSelect.selectedIndex === 0 && weekSelect.selectedIndex === 0) {
    // Only meaningful on the latest week -- same convention as the kickoff countdown.
    if (week + 1 !== CHAMPIONSHIP_WEEK) base = SKY_COMETS[await realSeasonalTheme(year, week + 1)] || null; // real schedule, never debug-overridden
  }
  if (!base) return null;
  return { ...base, progress: await cometProgress(year, week), impact: await cometImpact(year, week) };
}
function renderComet(comet) {
  const el = document.getElementById('comet');
  if (!el) return;
  if (cometSuppressed) comet = null;
  if (comet) {
    const p = comet.progress ?? 1;
    const sym = Math.min(Math.max((p - COMET_SYMBOL_FROM) / (COMET_SYMBOL_FULL - COMET_SYMBOL_FROM), 0), 1);
    el.style.setProperty('--comet-color', comet.color);
    document.documentElement.style.setProperty('--comet-color', comet.color);
    el.style.setProperty('--comet-p', p.toFixed(3));
    el.style.setProperty('--comet-sym', sym.toFixed(3));
    const imp = comet.impact || 0;
    el.style.setProperty('--comet-i', imp.toFixed(3));
    el.classList.toggle('impact', imp > 0.55);
    const symEl = document.getElementById('cometSymbol');
    if (symEl) symEl.textContent = comet.emoji;
    el.classList.toggle('sleigh', !!comet.sleigh);
    // Don't give the event away in the tooltip until the emoji is visible.
    el.title = sym > 0 ? comet.label : '';
  }
  el.classList.toggle('on', !!comet);
}

// Called from loadMatchups on every poll. Cheap: the schedule lookups are
// cached, and everything visible is driven by one attribute + a couple of
// element toggles.
async function updateSky(year, week) {
  let active = debugNightSky;
  if (!active && yearSelect.selectedIndex === 0 && weekSelect.selectedIndex === 0) {
    try { active = await isPrimetimeNow(year, week); } catch { active = false; }
  }
  if (skyActive && !active) skyHideAt = performance.now() + 1500;
  skyActive = active;
  document.documentElement.setAttribute('data-night-sky', active ? 'true' : 'false');
  drawSkyMoon();
  try { renderComet(await cometForWeek(year, week)); } catch { renderComet(null); }
}

// ---- Card decor: pumpkins/leaf garland (Thanksgiving) or string lights
// (Christmas), on ESPN and Needle cards only (same scope as the delta
// popup and tier ribbon). Shared wire-drawing logic for both the
// Christmas light strand and the Thanksgiving leaf garland -- an SVG path
// scalloped into N droops via quadratic beziers between evenly spaced
// anchor points, with a decoration (a bulb div or a leaf emoji) placed at
// the bottom of each droop.
function buildSeasonalGarland(container, count, decorate) {
  container.innerHTML = '';
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', '0 0 400 30');
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.classList.add('seasonal-garland-wire');
  const path = document.createElementNS(svgNS, 'path');
  const anchorY = 4, dipY = 22;
  const segW = 400 / count;
  let d = `M0,${anchorY}`;
  const positions = [];
  for (let i = 0; i < count; i++) {
    const x0 = i * segW, xMid = x0 + segW / 2, x1 = x0 + segW;
    d += ` Q${xMid},${dipY} ${x1},${anchorY}`;
    positions.push({ x: xMid, y: dipY - 2 });
  }
  path.setAttribute('d', d);
  svg.appendChild(path);
  container.appendChild(svg);
  positions.forEach((p, i) => decorate(container, p, i));
}

function buildSeasonalLights(container, colorA, colorB) {
  buildSeasonalGarland(container, 8, (el, p, i) => {
    const bulb = document.createElement('div');
    bulb.className = 'seasonal-bulb';
    bulb.style.left = (p.x / 400 * 100) + '%';
    bulb.style.top = (p.y / 30 * 100) + '%';
    bulb.style.setProperty('--bulb-color', i % 2 === 0 ? colorA : colorB);
    bulb.style.animationDelay = (i * 0.18) + 's';
    el.appendChild(bulb);
  });
}

// Fixed repeating cycle (i % length) rather than a random pick per leaf --
// same convention as the bulbs alternating colorA/colorB by i % 2. A
// random pick would reshuffle which leaf sits where every time the
// garland gets rebuilt (theme switch, week change), which reads as
// glitchy rather than like a real, consistently-hung decoration.
const SEASONAL_LEAF_EMOJIS = ['🍁', '🍂', '🍃'];
function buildSeasonalLeafGarland(container) {
  buildSeasonalGarland(container, 7, (el, p, i) => {
    const leaf = document.createElement('div');
    leaf.className = 'seasonal-leaf';
    leaf.textContent = SEASONAL_LEAF_EMOJIS[i % SEASONAL_LEAF_EMOJIS.length];
    leaf.style.left = (p.x / 400 * 100) + '%';
    leaf.style.top = (p.y / 30 * 100) + '%';
    leaf.style.animationDelay = (i * 0.3) + 's';
    el.appendChild(leaf);
  });
}

// Halloween's version of the same strand -- a pale cobweb wire (tinted via
// .seasonal-halloween .seasonal-garland-wire path in index.html) with a
// single spider hanging from each droop instead of a bulb or a leaf.
function buildSeasonalCobweb(container) {
  buildSeasonalGarland(container, 6, (el, p, i) => {
    const spider = document.createElement('div');
    spider.className = 'seasonal-spider';
    spider.textContent = '🕷️';
    spider.style.left = (p.x / 400 * 100) + '%';
    spider.style.top = (p.y / 30 * 100) + '%';
    spider.style.animationDelay = (i * 0.35) + 's';
    el.appendChild(spider);
  });
}

// Builds/rebuilds a card's seasonal decor from scratch -- called only when
// a card is first rendered or the theme/week changes (see loadMatchups).
// Upset Watch must NEVER call this: an upset firing doesn't redraw the
// whole card, it only flips a color/animation state on markup that
// already exists (see applySeasonalUpsetState below) -- exactly how the
// real .upset-watch class and pulsing badge already work elsewhere in
// this file. Rebuilding the garland on every upset check would re-roll
// bulb stagger timing and reset the leaf-sway animation, which reads as a
// flicker/restart for a completely unrelated reason.
// Festive page banner (Halloween / Thanksgiving / Christmas weeks only).
const FEST_BANNERS = {
  halloween: { emoji: '\u{1F383}', title: 'Happy Halloween!', sub: 'Spooky season is in full swing' },
  thanksgiving: { emoji: '\u{1F983}', title: 'Happy Thanksgiving!', sub: 'Time to feast on some wins' },
  christmas: { emoji: '\u{1F384}', title: 'Merry Christmas!', sub: 'Wishing you a week of nice-list scores' },
};
function renderFestBanner(theme, week) {
  const el = document.getElementById('festBanner');
  if (!el) return;
  const b = FEST_BANNERS[theme];
  if (!b) { el.hidden = true; return; }
  el.querySelector('.fest-emoji').textContent = b.emoji;
  el.querySelector('.fest-title').textContent = b.title;
  el.querySelector('.fest-sub').textContent = `Week ${week} \u00B7 ${b.sub}`;
  el.hidden = false;
}


// ---- Seasonal intro: the meteor strike --------------------------------------
// The first time the page is opened in a Halloween / Thanksgiving / Christmas
// week, a short cinematic plays: the comet that has been approaching all week
// slams into the page, and the page transforms into the holiday. Afterwards the
// meteor sits at the bottom of the page -- click it to watch the strike again.
// While it plays, html.fest-pre hides every holiday visual (the theme attribute
// is held back too); the impact flash removes it, so the transformation is what
// you see happen.
const FEST_METEOR = {
  halloween:    { color: '#ff9a3c', rgb: '255,154,60' },
  thanksgiving: { color: '#e0883a', rgb: '224,136,58' },
  christmas:    { color: '#4fd493', rgb: '79,212,147' },
};
let festCineRun = 0;
let festCinePlaying = false;
let festCineFinish = null; // set while a cinematic is running: jumps to the end state
const debugFestCine = () => localStorage.getItem('winProbDebugFestCine') === 'true'; // set on preferences.html

function festApplyTheme(theme, quiet) {
  const root = document.documentElement;
  root.classList.remove('fest-pre');
  if (theme && theme !== 'none') root.setAttribute('data-seasonal-theme', theme);
  if (!quiet) { root.classList.add('fest-reveal'); setTimeout(() => root.classList.remove('fest-reveal'), 1800); }
}

// Should this load play the intro? Only on the latest week of the latest year,
// once per device per holiday week, and never with reduced motion.
function festCineDue(theme, year, week, leagueId) {
  if (!FEST_METEOR[theme]) return false;
  if (prefersReducedMotion()) return false;
  if (!(yearSelect.selectedIndex === 0 && weekSelect.selectedIndex === 0)) return false;
  if (debugFestCine()) return true;
  const key = `winProbFestCineSeen:v1:${year}:${week}:${theme}`;
  try { if (localStorage.getItem(key) === '1') return false; localStorage.setItem(key, '1'); } catch { return false; }
  return true;
}

function renderFestMeteor(theme) {
  const el = document.getElementById('festMeteor');
  if (!el) return;
  const m = FEST_METEOR[theme];
  const latest = yearSelect.selectedIndex === 0 && weekSelect.selectedIndex === 0;
  if (!m || !latest) { el.hidden = true; return; }
  el.style.setProperty('--fm-color', m.color);
  el.classList.toggle('sleigh', theme === 'christmas');
  const lab = el.querySelector('.fm-label'); if (lab) lab.textContent = theme === 'christmas' ? 'Replay the arrival' : 'Replay the impact';
  el.hidden = false;
}

function playFestCine(theme, { replay = false, fromBlack = false } = {}) {
  const ov = document.getElementById('festCine');
  const m = FEST_METEOR[theme];
  if (!ov || !m) { festApplyTheme(theme, true); return; }
  if (theme === 'christmas') return playChristmasCine({ replay, fromBlack });
  if (festCinePlaying && festCineFinish) festCineFinish();
  const id = ++festCineRun;
  festCinePlaying = true;
  const root = document.documentElement, body = document.body;
  if (replay) { root.classList.add('fest-pre'); root.removeAttribute('data-seasonal-theme'); }
  const canvas = ov.querySelector('canvas'), ctx = canvas.getContext('2d');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const W = window.innerWidth, H = window.innerHeight;
  canvas.width = W * dpr; canvas.height = H * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const flash = ov.querySelector('.flash'), titleEl = ov.querySelector('.fc-title'), dim = ov.querySelector('.fc-dim');
  const b = FEST_BANNERS[theme] || { emoji: '', title: '', sub: '' };
  titleEl.querySelector('.fc-emoji').textContent = b.emoji;
  titleEl.querySelector('.fc-text').textContent = b.title;
  titleEl.querySelector('.fc-sub').textContent = b.sub;
  titleEl.classList.remove('show'); flash.classList.remove('go');
  dim.style.display = ''; dim.style.setProperty('--hr', '-300px');
  ov.classList.add('on'); ov.classList.remove('out');
  if (fromBlack) { dim.style.transition = 'none'; ov.classList.add('dark'); setTimeout(() => { dim.style.transition = ''; }, 100); }
  else requestAnimationFrame(() => ov.classList.add('dark'));
  body.classList.add('fest-rumble'); body.style.setProperty('--rb', '0');

  // Timeline (simulated ms): prelude -> flight -> impact (slow motion around it) -> shockwave wipe -> title.
  const FLY0 = 1200, T_FLY = 2000, T_IMP = FLY0 + T_FLY;
  const S = { x: -0.06 * W, y: -0.08 * H }, P = { x: W * 0.5, y: H * 0.6 };
  const fl = Math.hypot(P.x - S.x, P.y - S.y), dir = { x: (P.x - S.x) / fl, y: (P.y - S.y) / fl }, perp = { x: -dir.y, y: dir.x };
  const maxR = Math.hypot(Math.max(P.x, W - P.x), Math.max(P.y, H - P.y)) + 120;
  const rnd = Math.random, clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const stars = Array.from({ length: 140 }, () => ({ x: rnd() * W, y: rnd() * H, r: 0.4 + rnd() * 1.5, ph: rnd() * 6.28, sp: 0.8 + rnd() * 2.2 }));
  const coreShape = Array.from({ length: 12 }, (_, k) => ({ a: (k / 12) * Math.PI * 2, k: 0.76 + rnd() * 0.32 }));
  const plasma = [], smoke = [], sparks = [], shards = [], dust = [], rings = [], cracks = [];
  let st = 0, last = performance.now(), impacted = false, realImpact = 0, titleOn = false, ended = false, shownTheme = false;
  const posAt = (p) => { const q = Math.pow(clamp(p, 0, 1), 2.1); return { x: S.x + (P.x - S.x) * q, y: S.y + (P.y - S.y) * q, q }; };

  function makeCrack(x, y, ang, len, w, d0) {
    const pts = [{ x, y, d: d0 }]; let cx = x, cy = y, a = ang, d = d0;
    while (d - d0 < len) {
      const step = 26 + rnd() * 40; a += (rnd() - 0.5) * 0.7;
      cx += Math.cos(a) * step; cy += Math.sin(a) * step; d += step; pts.push({ x: cx, y: cy, d });
      if (w > 1 && rnd() < 0.18) makeCrack(cx, cy, a + (rnd() < 0.5 ? -1 : 1) * (0.5 + rnd() * 0.6), len * 0.4 * rnd() + 60, w * 0.6, d);
    }
    cracks.push({ pts, w });
  }

  function finish() {
    if (ended) return; ended = true;
    if (root.classList.contains('fest-pre')) festApplyTheme(theme, shownTheme);
    body.classList.remove('fest-rumble'); body.style.removeProperty('--rb');
    ov.classList.add('out'); ov.classList.remove('dark');
    setTimeout(() => { if (id === festCineRun) { ov.classList.remove('on', 'out'); ctx.clearRect(0, 0, W, H); dim.style.display = ''; } }, 700);
    festCinePlaying = false; festCineFinish = null;
    if (window.__kickCine) { window.__kickCine = false; if (window.__kickClearAfter) { cometSuppressed = false; document.body.classList.remove('kick-zero'); } }
    document.removeEventListener('keydown', onKey);
  }
  function onKey(e) { if (e.key === 'Escape') finish(); }
  festCineFinish = finish;
  document.addEventListener('keydown', onKey);
  ov.querySelector('.fc-skip').onclick = finish;

  function glowDot(x, y, rad, c0, c1) { const g = ctx.createRadialGradient(x, y, 0, x, y, rad); g.addColorStop(0, c0); g.addColorStop(1, c1); ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, rad, 0, Math.PI * 2); ctx.fill(); }

  function impact(now) {
    impacted = true; realImpact = now;
    body.classList.remove('fest-rumble');
    flash.classList.remove('go'); void flash.offsetWidth; flash.classList.add('go');
    body.classList.add('fest-shake'); setTimeout(() => body.classList.remove('fest-shake'), 1500);
    for (let k = 0; k < 3; k++) rings.push({ v: 0.9 + k * 0.28, a: 0.95 - k * 0.2, w: 7 - k * 2, delay: k * 140 });
    for (let k = 0; k < 15; k++) makeCrack(P.x, P.y, (k / 15) * Math.PI * 2 + (rnd() - 0.5) * 0.35, Math.max(W, H) * (0.45 + rnd() * 0.5), 3, 0);
    for (let k = 0; k < 46; k++) { const ang = rnd() * Math.PI * 2, sp = 0.05 + rnd() * 0.2; dust.push({ x: P.x + (rnd() - 0.5) * 80, y: P.y + (rnd() - 0.5) * 20, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp * 0.5 - 0.06 - rnd() * 0.05, r: 30 + rnd() * 60, life: 1, g: rnd() * 0.4 }); }
    for (let k = 0; k < 34; k++) { const ang = -Math.PI / 2 + (rnd() - 0.5) * 2.6, sp = 0.35 + rnd() * 0.95; shards.push({ x: P.x, y: P.y, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp - 0.3, rot: rnd() * 6, vr: (rnd() - 0.5) * 0.02, s: 4 + rnd() * 11, life: 1 }); }
    for (let k = 0; k < 110; k++) { const ang = rnd() * Math.PI * 2, sp = 0.15 + rnd() * 0.9; sparks.push({ x: P.x, y: P.y, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp - 0.35, life: 1, r: 1 + rnd() * 3, hot: rnd() < 0.35 }); }
    // The holiday look is applied here, hidden behind the dark layer; the wipe reveals it.
    festApplyTheme(theme, true); shownTheme = true;
  }

  function frame(now) {
    if (id !== festCineRun || ended) return;
    const dt = Math.max(0, Math.min(50, now - last)); last = now;
    let scale = 1;
    if (!impacted) { const p = (st - FLY0) / T_FLY; if (p > 0.86) scale = 1 - 0.82 * clamp((p - 0.86) / 0.1, 0, 1); }
    else scale = clamp(0.18 + (now - realImpact) / 1700 * 0.82, 0.18, 1);
    const sdt = dt * scale; st += sdt;
    ctx.clearRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'source-over';
    const since = st - T_IMP;

    if (!impacted) body.style.setProperty('--rb', (clamp(st / T_IMP, 0, 1) * 2.6).toFixed(2));

    // stars + a growing distant glow top-left: the page "notices" something coming
    const starA = clamp(st / 900, 0, 1) * (impacted ? clamp(1 - since / 500, 0, 1) : 1);
    if (starA > 0) for (const s of stars) { ctx.globalAlpha = starA * (0.45 + 0.55 * Math.sin(st / 1000 * s.sp + s.ph) ** 2); ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2); ctx.fill(); }
    ctx.globalAlpha = 1;
    if (!impacted) { const gp = clamp(st / T_IMP, 0, 1); glowDot(0, 0, 60 + 340 * gp, `rgba(${m.rgb},${0.18 + 0.4 * gp})`, `rgba(${m.rgb},0)`); }

    if (!impacted && st >= FLY0) {
      const p = clamp((st - FLY0) / T_FLY, 0, 1), pos = posAt(p), r = 7 + 58 * pos.q;
      // plasma + smoke tail, emitted at the head, drifting back and spreading
      const n = Math.max(1, Math.round(sdt / 16 * (4 + 8 * pos.q)));
      for (let k = 0; k < n; k++) {
        const sp = 0.05 + rnd() * 0.18, sideways = (rnd() - 0.5) * 0.12 * (0.5 + pos.q * 2);
        plasma.push({ x: pos.x - dir.x * r * 0.2, y: pos.y - dir.y * r * 0.2, vx: -dir.x * sp + perp.x * sideways, vy: -dir.y * sp + perp.y * sideways, life: 1, max: 520 + rnd() * 520, s: r * (0.35 + rnd() * 0.6) });
        if (rnd() < 0.5) smoke.push({ x: pos.x - dir.x * r, y: pos.y - dir.y * r, vx: -dir.x * 0.03 + (rnd() - 0.5) * 0.04, vy: -dir.y * 0.03 + (rnd() - 0.5) * 0.04 - 0.01, life: 1, max: 1100 + rnd() * 700, s: r * (0.5 + rnd() * 0.7) });
        if (rnd() < 0.4) sparks.push({ x: pos.x, y: pos.y, vx: -dir.x * (0.08 + rnd() * 0.3) + (rnd() - 0.5) * 0.25, vy: -dir.y * (0.08 + rnd() * 0.3) + (rnd() - 0.5) * 0.25 + 0.05, life: 1, r: 0.8 + rnd() * 2.2, hot: rnd() < 0.5 });
      }
      // draw smoke (dark, soft), then plasma (additive)
      for (const q of smoke) { q.x += q.vx * sdt; q.y += q.vy * sdt; q.life -= sdt / q.max; }
      for (let k = smoke.length - 1; k >= 0; k--) if (smoke[k].life <= 0) smoke.splice(k, 1);
      for (const q of smoke) glowDot(q.x, q.y, q.s * (1.2 - q.life * 0.5), `rgba(30,22,26,${0.22 * q.life})`, 'rgba(30,22,26,0)');
      ctx.globalCompositeOperation = 'lighter';
      for (const q of plasma) { q.x += q.vx * sdt; q.y += q.vy * sdt; q.life -= sdt / q.max; }
      for (let k = plasma.length - 1; k >= 0; k--) if (plasma[k].life <= 0) plasma.splice(k, 1);
      for (const q of plasma) {
        const l = q.life, rad = q.s * (0.55 + (1 - l) * 0.9);
        const c0 = l > 0.62 ? `rgba(255,244,214,${0.5 * l})` : `rgba(${m.rgb},${0.55 * l})`;
        glowDot(q.x, q.y, rad, c0, `rgba(${m.rgb},0)`);
      }
      // holiday-colored aura + white-hot leading edge
      glowDot(pos.x, pos.y, r * 5, `rgba(${m.rgb},0.2)`, `rgba(${m.rgb},0)`);
      glowDot(pos.x, pos.y, r * 2.4, `rgba(${m.rgb},0.55)`, `rgba(${m.rgb},0)`);
      ctx.globalCompositeOperation = 'source-over';
      // rocky core: irregular, tumbling, dark, lit by its own fire
      ctx.save(); ctx.translate(pos.x, pos.y); ctx.rotate(st * 0.0022);
      ctx.beginPath();
      coreShape.forEach((c, k) => { const x = Math.cos(c.a) * r * c.k, y = Math.sin(c.a) * r * c.k; k ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
      ctx.closePath();
      const cg = ctx.createRadialGradient(r * 0.3, r * 0.3, r * 0.1, 0, 0, r * 1.05); cg.addColorStop(0, '#4a4350'); cg.addColorStop(0.6, '#1d1a22'); cg.addColorStop(1, '#09080b');
      ctx.fillStyle = cg; ctx.fill();
      ctx.lineWidth = Math.max(2, r * 0.09); ctx.strokeStyle = `rgba(${m.rgb},0.9)`; ctx.shadowColor = m.color; ctx.shadowBlur = r * 0.8; ctx.stroke();
      ctx.restore();
      ctx.globalCompositeOperation = 'lighter';
      glowDot(pos.x + dir.x * r * 0.55, pos.y + dir.y * r * 0.55, r * 1.05, 'rgba(255,255,255,0.9)', 'rgba(255,255,255,0)');
      ctx.globalCompositeOperation = 'source-over';
      // the holiday's symbol blazes out of the rock as it nears
      const symA = clamp((p - 0.4) / 0.35, 0, 1);
      if (symA > 0) {
        ctx.save(); ctx.globalAlpha = symA; ctx.shadowColor = m.color; ctx.shadowBlur = r * 0.9;
        ctx.font = `${Math.round(r * 1.5)}px serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(b.emoji, pos.x, pos.y + r * 0.06); ctx.restore();
      }
    } else if (!impacted) {
      // prelude: a few early streaks in the dark
    }

    if (!impacted && st >= T_IMP) impact(now);

    if (impacted) {
      // cracks spreading across the page
      const L = since * 1.15, fade = 1 - clamp((since - 2000) / 1100, 0, 1);
      if (fade > 0) {
        ctx.save(); ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.globalAlpha = fade;
        for (const pass of [0, 1]) {
          ctx.strokeStyle = pass ? 'rgba(255,255,255,0.95)' : `rgba(${m.rgb},0.9)`; ctx.shadowColor = pass ? 'transparent' : m.color; ctx.shadowBlur = pass ? 0 : 16;
          for (const c of cracks) {
            ctx.lineWidth = pass ? Math.max(0.8, c.w * 0.4) : c.w * 1.6;
            ctx.beginPath(); let started = false;
            for (const pt of c.pts) { if (pt.d > L) { break; } started ? ctx.lineTo(pt.x, pt.y) : (ctx.moveTo(pt.x, pt.y), started = true); }
            ctx.stroke();
          }
        }
        ctx.restore();
      }
      // dust cloud
      for (const q of dust) { q.x += q.vx * sdt; q.y += q.vy * sdt; q.vx *= 0.995; q.r += sdt * 0.03; q.life -= sdt / 2600; }
      for (const q of dust) if (q.life > 0) glowDot(q.x, q.y, q.r, `rgba(${70 + q.g * 40 | 0},${58 + q.g * 25 | 0},${54},${0.34 * q.life})`, 'rgba(60,50,48,0)');
      // shockwave rings
      for (const rg of rings) {
        const s = since - rg.delay / 1; if (s < 0) continue;
        const rr = rg.v * s, al = clamp(rg.a - s / 1900, 0, 1);
        if (al > 0) { ctx.strokeStyle = `rgba(${m.rgb},${al})`; ctx.lineWidth = rg.w; ctx.beginPath(); ctx.arc(P.x, P.y, rr, 0, Math.PI * 2); ctx.stroke(); }
      }
      // crater glow
      const ga = clamp(0.75 - since / 2400, 0, 1);
      if (ga > 0) glowDot(P.x, P.y, 260, `rgba(${m.rgb},${ga})`, `rgba(${m.rgb},0)`);
      // rock shards + sparks
      for (const d of shards) { d.vy += 0.0016 * sdt; d.x += d.vx * sdt; d.y += d.vy * sdt; d.rot += d.vr * sdt; d.life -= sdt / 1800; }
      for (const d of shards) if (d.life > 0) { ctx.save(); ctx.translate(d.x, d.y); ctx.rotate(d.rot); ctx.globalAlpha = clamp(d.life * 1.4, 0, 1); ctx.fillStyle = '#17141b'; ctx.strokeStyle = `rgba(${m.rgb},0.8)`; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.moveTo(-d.s, d.s * 0.6); ctx.lineTo(d.s * 0.2, -d.s); ctx.lineTo(d.s, d.s * 0.7); ctx.closePath(); ctx.fill(); ctx.stroke(); ctx.restore(); }
      ctx.globalAlpha = 1;
    }
    // sparks (before and after impact)
    for (const s of sparks) { s.vy += 0.0009 * sdt; s.x += s.vx * sdt; s.y += s.vy * sdt; s.life -= sdt / (impacted ? 1500 : 650); }
    for (let k = sparks.length - 1; k >= 0; k--) if (sparks[k].life <= 0) sparks.splice(k, 1);
    ctx.globalCompositeOperation = 'lighter';
    for (const s of sparks) { ctx.fillStyle = s.hot ? `rgba(255,245,220,${s.life})` : `rgba(${m.rgb},${s.life})`; ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2); ctx.fill(); }
    ctx.globalCompositeOperation = 'source-over';

    if (impacted) {
      // shockwave WIPE: the dark layer opens outward from the impact, revealing the holiday page
      const e = clamp((since - 250) / 1900, 0, 1), eased = 1 - Math.pow(1 - e, 3), hr = eased * maxR;
      dim.style.setProperty('--hx', P.x + 'px'); dim.style.setProperty('--hy', P.y + 'px'); dim.style.setProperty('--hr', hr.toFixed(1) + 'px');
      if (e > 0 && e < 1) { // glowing wavefront
        ctx.save(); ctx.globalCompositeOperation = 'lighter';
        ctx.strokeStyle = `rgba(${m.rgb},${0.55 * (1 - e * 0.6)})`; ctx.lineWidth = 16; ctx.shadowColor = m.color; ctx.shadowBlur = 40;
        ctx.beginPath(); ctx.arc(P.x, P.y, hr + 36, 0, Math.PI * 2); ctx.stroke();
        ctx.strokeStyle = `rgba(255,255,255,${0.5 * (1 - e)})`; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(P.x, P.y, hr + 34, 0, Math.PI * 2); ctx.stroke();
        ctx.restore();
      }
      if (e >= 1) dim.style.display = 'none';
      if (!titleOn && since > 1000) { titleOn = true; titleEl.classList.add('show'); }
      if (titleOn && since > 3000) titleEl.classList.remove('show');
    }
    if (impacted && since >= 3700) { finish(); return; }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

// Christmas: no meteor. A blizzard builds to a whiteout, then Santa's sleigh bursts
// through, trailing glitter, and the festive look spreads out behind it.
function playChristmasCine({ replay = false, fromBlack = false } = {}) {
  const theme = 'christmas';
  const ov = document.getElementById('festCine');
  if (festCinePlaying && festCineFinish) festCineFinish();
  const id = ++festCineRun;
  festCinePlaying = true;
  const root = document.documentElement;
  if (replay) { root.classList.add('fest-pre'); root.removeAttribute('data-seasonal-theme'); }
  const canvas = ov.querySelector('canvas'), ctx = canvas.getContext('2d');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const W = window.innerWidth, H = window.innerHeight;
  canvas.width = W * dpr; canvas.height = H * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const flash = ov.querySelector('.flash'), titleEl = ov.querySelector('.fc-title'), dim = ov.querySelector('.fc-dim');
  const b = FEST_BANNERS[theme];
  titleEl.querySelector('.fc-emoji').textContent = b.emoji;
  titleEl.querySelector('.fc-text').textContent = b.title;
  titleEl.querySelector('.fc-sub').textContent = b.sub;
  titleEl.classList.remove('show'); flash.classList.remove('go');
  dim.style.display = ''; dim.style.setProperty('--hr', '-300px');
  dim.style.background = 'radial-gradient(ellipse at 50% 40%, rgba(70,100,150,.92), rgba(8,16,36,.97) 75%)';
  ov.classList.add('on'); ov.classList.remove('out');
  if (fromBlack) { dim.style.transition = 'none'; ov.classList.add('dark'); setTimeout(() => { dim.style.transition = ''; }, 100); }
  else requestAnimationFrame(() => ov.classList.add('dark'));

  const T0 = 2900, FLY = 2300, TW = T0 + 900, T_TITLE = TW + 900, T_END = TW + 3900;
  const rnd = Math.random, clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const flakes = Array.from({ length: 520 }, () => ({ x: rnd() * W, y: rnd() * H, r: 0.8 + rnd() * 2.6, z: 0.4 + rnd() * 1.1 }));
  const trail = [], glitter = [];
  const COLORS = ['255,211,107', '255,90,95', '91,227,154', '255,255,255'];
  const P = { x: W * 0.5, y: H * 0.5 };
  const maxR = Math.hypot(Math.max(P.x, W - P.x), Math.max(P.y, H - P.y)) + 120;
  let st = 0, last = performance.now(), ended = false, applied = false, titleOn = false;
  const bliz = (t) => t < T0 + 1000 ? clamp(t / 2400, 0, 1) : clamp(1 - (t - (T0 + 1000)) / 2200, 0.12, 1);
  const flyPos = (u) => ({ x: W * (-0.2 + 1.4 * u), y: H * (0.78 - 0.5 * Math.sin(Math.PI * u) * (0.9) - 0.04 * u) });

  function finish() {
    if (ended) return; ended = true;
    if (root.classList.contains('fest-pre')) festApplyTheme(theme, applied);
    ov.classList.add('out'); ov.classList.remove('dark');
    setTimeout(() => { if (id === festCineRun) { ov.classList.remove('on', 'out'); ctx.clearRect(0, 0, W, H); dim.style.display = ''; dim.style.background = ''; } }, 700);
    festCinePlaying = false; festCineFinish = null;
    if (window.__kickCine) { window.__kickCine = false; if (window.__kickClearAfter) { cometSuppressed = false; document.body.classList.remove('kick-zero'); } }
    document.removeEventListener('keydown', onKey);
  }
  function onKey(e) { if (e.key === 'Escape') finish(); }
  festCineFinish = finish;
  document.addEventListener('keydown', onKey);
  ov.querySelector('.fc-skip').onclick = finish;

  function frame(now) {
    if (id !== festCineRun || ended) return;
    const dt = Math.max(0, Math.min(50, now - last)); last = now; st += dt;
    ctx.clearRect(0, 0, W, H);
    const B = bliz(st);
    // whiteout haze
    ctx.fillStyle = `rgba(228,240,255,${0.62 * B * B})`; ctx.fillRect(0, 0, W, H);
    // blizzard
    ctx.strokeStyle = ctx.fillStyle = '#fff';
    const vy0 = 1.4 + B * 11, wind = 0.5 + B * 15;
    for (const f of flakes) {
      const vx = wind * f.z, vy = vy0 * f.z;
      f.x += vx * dt / 16; f.y += vy * dt / 16;
      if (f.y > H + 10) { f.y = -10; f.x = rnd() * (W + 300) - 150; }
      if (f.x > W + 30) { f.x = -30; f.y = rnd() * H; }
      ctx.globalAlpha = clamp(0.3 + f.z * 0.45, 0, 0.95);
      ctx.lineWidth = f.r; ctx.beginPath(); ctx.moveTo(f.x, f.y); ctx.lineTo(f.x - vx * (1 + B * 2.6), f.y - vy * (1 + B * 2.6)); ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // distant warm glow in the whiteout, just before the sleigh appears
    if (st > T0 - 1000 && st < T0 + 400) { const a = clamp((st - (T0 - 1000)) / 900, 0, 1) * clamp(1 - (st - T0) / 400, 0, 1); const g = ctx.createRadialGradient(0, H * 0.78, 0, 0, H * 0.78, 360); g.addColorStop(0, `rgba(255,211,107,${0.55 * a})`); g.addColorStop(1, 'rgba(255,211,107,0)'); ctx.fillStyle = g; ctx.fillRect(0, 0, W, H); }

    // sleigh
    const u = clamp((st - T0) / FLY, 0, 1);
    if (st >= T0 && u < 1) {
      const pos = flyPos(u), nx = flyPos(Math.min(1, u + 0.01)), ang = Math.atan2(nx.y - pos.y, nx.x - pos.x);
      const size = 96 + 90 * Math.sin(Math.PI * u);
      trail.push({ x: pos.x - Math.cos(ang) * size * 0.9, y: pos.y - Math.sin(ang) * size * 0.9 + size * 0.1, t: st });
      for (let k = 0; k < 4; k++) glitter.push({ x: pos.x - Math.cos(ang) * size * (0.6 + rnd()), y: pos.y + (rnd() - 0.2) * size * 0.5, vx: -2 + rnd() * 1, vy: 0.4 + rnd() * 1.4, life: 1, c: COLORS[(rnd() * COLORS.length) | 0], r: 1 + rnd() * 2.6 });
      ctx.globalCompositeOperation = 'lighter';
      // ribbon
      for (let k = 1; k < trail.length; k++) { const q = trail[k], p0 = trail[k - 1], age = clamp(1 - (st - q.t) / 1400, 0, 1); if (age <= 0) continue; ctx.strokeStyle = `rgba(255,211,107,${0.7 * age})`; ctx.lineWidth = 2 + 16 * age; ctx.lineCap = 'round'; ctx.beginPath(); ctx.moveTo(p0.x, p0.y); ctx.lineTo(q.x, q.y); ctx.stroke(); ctx.strokeStyle = `rgba(255,255,255,${0.5 * age})`; ctx.lineWidth = 1.5 + 3 * age; ctx.stroke(); }
      const gg = ctx.createRadialGradient(pos.x, pos.y, 0, pos.x, pos.y, size * 2.4); gg.addColorStop(0, 'rgba(255,225,150,.6)'); gg.addColorStop(1, 'rgba(255,200,100,0)'); ctx.fillStyle = gg; ctx.beginPath(); ctx.arc(pos.x, pos.y, size * 2.4, 0, Math.PI * 2); ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
      ctx.save(); ctx.translate(pos.x, pos.y); ctx.rotate(ang); ctx.scale(-1, 1);
      ctx.font = `${Math.round(size)}px serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.shadowColor = 'rgba(255,211,107,.95)'; ctx.shadowBlur = size * 0.35;
      ctx.fillText('\u{1F98C}\u{1F98C}\u{1F6F7}', 0, 0); ctx.restore();
    }
    // glitter
    ctx.globalCompositeOperation = 'lighter';
    for (let k = glitter.length - 1; k >= 0; k--) { const g = glitter[k]; g.x += g.vx; g.y += g.vy; g.life -= dt / 1300; if (g.life <= 0) { glitter.splice(k, 1); continue; } ctx.fillStyle = `rgba(${g.c},${g.life})`; ctx.beginPath(); ctx.arc(g.x, g.y, g.r * (0.5 + g.life), 0, Math.PI * 2); ctx.fill(); }
    ctx.globalCompositeOperation = 'source-over';

    // transformation: the festive page spreads outward behind the sleigh
    if (st >= TW) {
      if (!applied) { festApplyTheme(theme, true); applied = true; flash.classList.remove('go'); void flash.offsetWidth; flash.classList.add('go'); }
      const e = clamp((st - TW) / 2100, 0, 1), eased = 1 - Math.pow(1 - e, 3), hr = eased * maxR;
      dim.style.setProperty('--hx', P.x + 'px'); dim.style.setProperty('--hy', P.y + 'px'); dim.style.setProperty('--hr', hr.toFixed(1) + 'px');
      if (e > 0 && e < 1) { ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.strokeStyle = `rgba(255,225,150,${0.5 * (1 - e * 0.6)})`; ctx.lineWidth = 14; ctx.shadowColor = '#ffd36b'; ctx.shadowBlur = 36; ctx.beginPath(); ctx.arc(P.x, P.y, hr + 34, 0, Math.PI * 2); ctx.stroke(); ctx.restore(); }
      if (e >= 1) dim.style.display = 'none';
      if (!titleOn && st > T_TITLE) { titleOn = true; titleEl.classList.add('show'); }
      if (titleOn && st > T_END - 900) titleEl.classList.remove('show');
    }
    if (st >= T_END) { finish(); return; }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

document.addEventListener('click', (e) => { if (e.target.closest && e.target.closest('#festMeteor')) playFestCine(currentSeasonalTheme, { replay: true }); });

// Bigger corner decorations, added ON TOP of the existing garland and the
// pumpkin/ghost corners (those are untouched): bottom corners for every
// holiday, plus top corners for Christmas (which had none).
const FEST_CORNERS = {
  halloween: { bl: '\u{1F987}', br: '\u{1F383}' },
  thanksgiving: { bl: '\u{1F33D}', br: '\u{1F967}' },
  christmas: { tl: '\u{1F384}', tr: '\u{1F385}', bl: '\u{1F381}', br: '\u26C4' },
};

function decorateSeasonalCard(card, theme, home, away) {
  card.querySelectorAll('.fest-corner').forEach((n) => n.remove());
  const corners = FEST_CORNERS[theme];
  if (corners) {
    for (const [pos, emoji] of Object.entries(corners)) {
      const c = document.createElement('div');
      c.className = `fest-corner ${pos}`;
      c.textContent = emoji;
      card.appendChild(c);
    }
  }
  card.classList.remove('seasonal-thanksgiving', 'seasonal-christmas', 'seasonal-halloween', 'seasonal-coldsnap', 'upset-active');
  const garland = card.querySelector('.seasonal-garland');
  if (garland) { garland.innerHTML = ''; garland.classList.remove('upset-lights', 'upset-leaves', 'upset-spiders'); }
  if (theme === 'none' || !garland) return;

  if (theme === 'thanksgiving') {
    card.classList.add('seasonal-thanksgiving');
    buildSeasonalLeafGarland(garland);
  } else if (theme === 'christmas') {
    card.classList.add('seasonal-christmas');
    buildSeasonalLights(garland, home.color, away.color);
  } else if (theme === 'halloween') {
    card.classList.add('seasonal-halloween');
    buildSeasonalCobweb(garland);
  } else if (theme === 'coldsnap-pre' || theme === 'coldsnap-post') {
    // Deliberately no garland content -- Cold Snap is the quiet in-between,
    // not another full holiday treatment (see index.html's CSS comment).
    // The frost-edge + tint look is driven purely by the seasonal-coldsnap
    // class in CSS, and there's no Upset Watch tie-in for the same reason.
    card.classList.add('seasonal-coldsnap');
  }
}

// Toggles the upset-alert look on EXISTING markup only -- the SAME live
// upset state already computed for the card's own badge/border
// (getLiveUpsetInfo), not a separate detector. Every themed week now has
// an Upset Watch tie-in (Christmas bulbs, Thanksgiving leaves, Halloween
// spiders), all sharing the same alert color/cadence so it reads as one
// alert system rather than a different meaning per holiday. No-ops when
// there's no seasonal theme at all.
function applySeasonalUpsetState(card, theme, upsetActive) {
  const garland = card.querySelector('.seasonal-garland');
  if (!garland) return;
  // The real card's own .upset-watch class + border already handles the
  // whole-card alert look (see applyUpsetColor) -- this only needs to
  // touch the garland itself, whichever decoration it's currently showing.
  if (theme === 'christmas') garland.classList.toggle('upset-lights', upsetActive);
  else if (theme === 'thanksgiving') garland.classList.toggle('upset-leaves', upsetActive);
  else if (theme === 'halloween') garland.classList.toggle('upset-spiders', upsetActive);
}

// Checks whether week 17 of the LATEST year (yearSelect.value, already
// sorted descending by loadYearsWeeks) has gone fully final for the
// currently-selected league, and shows/hides the top-of-page button
// accordingly. The early-access preference bypasses this check entirely
// when enabled, regardless of what week the season is actually on.
async function checkYearInReviewAvailability(leagueId) {
  if (!yearInReviewLink) return;
  const latestYear = Number(yearSelect.value);
  if (!leagueId || !latestYear) { yearInReviewLink.hidden = true; return; }
  const { data, error } = await sb
    .from('snapshot_summary')
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
      // snapshot_summary: one row per matchup-team, not every poll ever recorded.
      sb.from('snapshot_summary').select('year, week').eq('league_id', leagueId).order('year').order('week').range(from, to)
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

  // Just the single newest (year, week) -- one tiny row -- instead of
  // downloading the league's whole poll history every 30 seconds.
  let latest;
  try {
    const res = await sb.from('snapshot_summary').select('year, week').eq('league_id', leagueId)
      .order('year', { ascending: false }).order('week', { ascending: false }).limit(1);
    if (res.error) throw res.error;
    latest = (res.data || [])[0];
  } catch {
    return false; // transient error -- try again next cycle
  }
  if (!latest) return false;

  const latestYear = latest.year;
  const latestWeek = latest.week;

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

// Session caches so revisiting a tab/week is instant and a routine refresh
// only downloads rows newer than what's already held.
// Only the columns the page reads (instead of '*', which also dragged along
// bookkeeping columns like lineup_fingerprint on every row of every poll).
const WEEK_SNAPSHOT_COLUMNS = 'id, league_id, year, week, matchup_id, team_id, is_home, ts, actual_score, expected_score, win_prob, all_starters_done';
// True when every matchup on screen is final -- the auto-refresh then backs
// off to IDLE_REFRESH_MS instead of the normal 30s.
let weekIsIdle = false;
const IDLE_REFRESH_MS = 5 * 60 * 1000;
let weekRowsCache = { key: null, rows: [], ids: new Set(), lastTs: null };
const teamsCache = {}; // leagueId -> { at, data }
const TEAMS_TTL_MS = 5 * 60 * 1000;

async function fetchWeekSnapshotsInner(leagueId, year, week) {
  const key = `${leagueId}|${year}|${week}`;
  const c = weekRowsCache;
  if (c.key !== key) {
    // A finished, settled week never changes -- serve it from this
    // browser's saved copy instead of downloading it again.
    const idbKey = `week:v1:${key}`;
    const saved = await idbGet(idbKey);
    if (saved && saved.rows && saved.rows.length) {
      weekRowsCache = { key, rows: saved.rows, ids: new Set(saved.rows.map((r) => r.id)), lastTs: saved.rows[saved.rows.length - 1].ts };
      return weekRowsCache.rows;
    }
    const rows = await fetchAllRows((from, to) =>
      sb.from('snapshots').select(WEEK_SNAPSHOT_COLUMNS).eq('league_id', leagueId).eq('year', year).eq('week', week).order('ts').order('id').range(from, to)
    );
    weekRowsCache = { key, rows, ids: new Set(rows.map((r) => r.id)), lastTs: rows.length ? rows[rows.length - 1].ts : null };
    if (rowsAreSettled(rows)) idbSet(idbKey, { rows, savedAt: Date.now() });
    return weekRowsCache.rows;
  }
  // Same week as last time: only rows at/after the newest ts we hold
  // (>= so equal-ts rows aren't missed; ids dedupe the overlap).
  if (!c.lastTs) {
    const rows = await fetchAllRows((from, to) =>
      sb.from('snapshots').select(WEEK_SNAPSHOT_COLUMNS).eq('league_id', leagueId).eq('year', year).eq('week', week).order('ts').order('id').range(from, to)
    );
    weekRowsCache = { key, rows, ids: new Set(rows.map((r) => r.id)), lastTs: rows.length ? rows[rows.length - 1].ts : null };
    return weekRowsCache.rows;
  }
  const fresh = await fetchAllRows((from, to) =>
    sb.from('snapshots').select(WEEK_SNAPSHOT_COLUMNS).eq('league_id', leagueId).eq('year', year).eq('week', week).gte('ts', c.lastTs).order('ts').order('id').range(from, to)
  );
  const added = [];
  for (const r of fresh) {
    if (r.id != null && c.ids.has(r.id)) continue;
    if (r.id != null) c.ids.add(r.id);
    added.push(r);
  }
  if (added.length) {
    c.rows = c.rows.concat(added);
    c.lastTs = c.rows[c.rows.length - 1].ts;
  }
  return c.rows;
}

// Lineup changes (migration 023's lineup_changes view): the moments a team's
// starting lineup changed. Only fetched when a week's data contains a big
// win-probability jump that nothing yet explains, then kept for the session,
// so ordinary refreshes make no extra request. If the view doesn't exist yet,
// lineupViewOk flips off and Upset Watch uses its older idle-time guess.
let lineupViewOk = true;
const lineupChangeCache = {}; // `${league}|${year}|${week}` -> { coveredMs, byMatchup: Map(matchup_id -> sorted ms[]) }
async function ensureLineupChanges(leagueId, year, week, rows) {
  if (!lineupViewOk || !rows || !rows.length) return;
  const key = `${leagueId}|${year}|${week}`;
  const entry = lineupChangeCache[key];
  const homeByMatchup = new Map();
  let newestMs = 0;
  for (const r of rows) {
    const t = new Date(r.ts).getTime();
    if (t > newestMs) newestMs = t;
    if (!r.is_home) continue;
    if (!homeByMatchup.has(r.matchup_id)) homeByMatchup.set(r.matchup_id, []);
    homeByMatchup.get(r.matchup_id).push(r);
  }
  let needFetch = false;
  for (const list of homeByMatchup.values()) {
    list.sort((a, b) => new Date(a.ts) - new Date(b.ts));
    for (let i = 1; i < list.length && !needFetch; i++) {
      if (Math.abs(list[i].win_prob - list[i - 1].win_prob) < UPSET_JUMP_MIN) continue;
      if (!entry || new Date(list[i].ts).getTime() > entry.coveredMs) needFetch = true;
    }
    if (needFetch) break;
  }
  if (!needFetch) return;
  const { data, error } = await sb.from('lineup_changes').select('matchup_id, team_id, ts').eq('league_id', leagueId).eq('year', year).eq('week', week);
  if (error) {
    // Missing view (migration 023 not run yet) -> stop asking; anything else is retried next refresh.
    if (error.code === '42P01' || error.code === 'PGRST205' || /lineup_changes/i.test(error.message || '')) lineupViewOk = false;
    return;
  }
  const byMatchup = new Map();
  for (const c of data || []) {
    if (!byMatchup.has(c.matchup_id)) byMatchup.set(c.matchup_id, []);
    byMatchup.get(c.matchup_id).push(new Date(c.ts).getTime());
  }
  for (const list of byMatchup.values()) list.sort((a, b) => a - b);
  lineupChangeCache[key] = { coveredMs: newestMs, byMatchup };
}

async function fetchWeekSnapshots(leagueId, year, week) {
  const rows = await fetchWeekSnapshotsInner(leagueId, year, week);
  await ensureLineupChanges(leagueId, year, week, rows);
  return rows;
}

// The lineup-change moments (ms) for one matchup's rows, or null when that
// information isn't available (view missing / not fetched for this week).
function lineupChangeTimes(rows) {
  const r0 = rows && rows[0];
  if (!r0 || !lineupViewOk) return null;
  const e = lineupChangeCache[`${r0.league_id}|${r0.year}|${r0.week}`];
  return e ? (e.byMatchup.get(r0.matchup_id) || []) : null;
}

async function fetchTeamsCached(leagueId) {
  const hit = teamsCache[leagueId];
  if (hit && Date.now() - hit.at < TEAMS_TTL_MS) return { data: hit.data, error: null };
  const res = await sb.from('teams').select('id, espn_team_name, team_settings(color, display_name, emoji, logo_url)').eq('league_id', leagueId);
  if (!res.error) teamsCache[leagueId] = { at: Date.now(), data: res.data };
  return res;
}

async function fetchMatchupData(leagueId, year, week) {
  const [snaps, { data: teams, error: teamErr }] = await Promise.all([
    fetchWeekSnapshots(leagueId, year, week),
    fetchTeamsCached(leagueId),
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

// A big win-probability jump that comes from a LINEUP CHANGE (a kicker with no
// team replaced, an empty slot filled, either team) isn't a collapse in play:
// the number was only wrong or incomplete before. Without this, such a jump
// looks like a favorite collapsing from its old peak and can leave Upset
// Watch on for the rest of the game, since the "new" favorite never climbs
// back to 70%. Returns one boolean per home row (same order) marking jumps
// that line up with a recorded lineup change by EITHER team; Upset Watch then
// forgets any favorite status built before the swap and starts fresh.
// A jump with no lineup change (a star hurt mid-game, say) is a real event and
// is left alone.
const UPSET_JUMP_MIN = 15; // minimum one-step win-probability change to consider
const UPSET_LINEUP_SLACK_MS = 90 * 1000; // home/away rows can differ by a few seconds
// Fallback only, when the lineup_changes view isn't available: treat a jump
// with no score change after 45+ quiet minutes as a lineup fix.
const UPSET_JUMP_IDLE_MS = 45 * 60 * 1000;
function upsetResetFlags(rows, homeRows) {
  const lineupTimes = lineupChangeTimes(rows);
  const away = lineupTimes ? null : rows.filter((r) => !r.is_home).sort((a, b) => new Date(a.ts) - new Date(b.ts));
  const moved = (x, y) => Math.abs(Number(x) - Number(y)) >= 0.5;
  let lastScoreChange = -Infinity; // nothing has scored yet (fallback only)
  return homeRows.map((r, i) => {
    if (i === 0) return false;
    const prev = homeRows[i - 1];
    const t = new Date(r.ts).getTime();
    if (lineupTimes) {
      if (Math.abs(r.win_prob - prev.win_prob) < UPSET_JUMP_MIN) return false;
      const lo = new Date(prev.ts).getTime(), hi = t + UPSET_LINEUP_SLACK_MS;
      return lineupTimes.some((c) => c > lo && c <= hi);
    }
    const a0 = nearestByTs(away, prev.ts), a1 = nearestByTs(away, r.ts);
    if (moved(r.actual_score, prev.actual_score) || (a0 && a1 && moved(a1.actual_score, a0.actual_score))) {
      lastScoreChange = t;
      return false;
    }
    if (Math.abs(r.win_prob - prev.win_prob) < UPSET_JUMP_MIN) return false;
    return t - lastScoreChange >= UPSET_JUMP_IDLE_MS;
  });
}

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
function walkUpsetState(sortedHomeWinProbs, onStep, resets) {
  let armed = null; // 'home' | 'away' | null
  let peak = null; // the armed side's peak favorite % reached
  let watch = false;
  let upsetSide = null; // the side currently threatening the upset, while watch is true
  let currentEpisode = null;
  const episodes = [];

  for (let idx = 0; idx < sortedHomeWinProbs.length; idx++) {
    const hp = sortedHomeWinProbs[idx];
    // A lineup-driven jump (see upsetResetFlags) isn't a collapse in play, so
    // forget any arming/watch built on the old baseline and start fresh from
    // this value. Episodes already recorded are kept.
    if (resets && resets[idx]) { armed = null; peak = null; watch = false; upsetSide = null; currentEpisode = null; }
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
  const { watch, armed, peak, upsetSide } = walkUpsetState(homeRows.map((r) => r.win_prob), undefined, upsetResetFlags(rows, homeRows));
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
  }, upsetResetFlags(rows, homeRows));
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
//
// During championship week specifically, this stops tracking "whoever
// has the most points this week" across the whole league and instead
// shows a horizontal split of the two CHAMPIONSHIP teams' own colors,
// sized by their live win probability -- a team favored 70/30 fills 70%
// of the bar's width with its own color, so the very top of the page
// reads as a live odds bar for the game that matters most that week.
function updateLeaderBar(byMatchup, teamInfo, championshipWeekActive, championshipTeams) {
  const bar = document.getElementById('leaderGradient');
  const layerA = document.getElementById('leaderGradientLayerA');
  const layerB = document.getElementById('leaderGradientLayerB');
  if (!bar || !layerA || !layerB) return;

  if (championshipWeekActive && championshipTeams) {
    const champRows = byMatchup[championshipTeams.matchupId];
    // latestPct itself defaults to 50 when there's no home row to read,
    // but it assumes an array -- guard against champRows being missing
    // entirely too, so a stale matchupId just shows an even 50/50 split
    // rather than erroring out.
    const homePct = Math.round(champRows ? latestPct(champRows) : 50);
    if (homePct !== leaderBarChampHomePct) {
      const homeColor = colorWithAlpha(championshipTeams.home.color, 0.35);
      const awayColor = colorWithAlpha(championshipTeams.away.color, 0.35);
      const gradient = `linear-gradient(to right, ${homeColor} 0%, ${homeColor} ${homePct}%, ${awayColor} ${homePct}%, ${awayColor} 100%)`;
      const nextLayer = leaderBarActiveLayer === 'A' ? layerB : layerA;
      const prevLayer = leaderBarActiveLayer === 'A' ? layerA : layerB;
      nextLayer.style.background = gradient;
      // The non-championship gradient below fades to transparent on its
      // OWN (a straight top-to-bottom color->transparent stop) -- here the
      // gradient runs horizontally instead (to carry the win-prob split),
      // so the same vertical fade has to come from a mask instead.
      nextLayer.style.maskImage = 'linear-gradient(to bottom, black, transparent)';
      nextLayer.style.webkitMaskImage = 'linear-gradient(to bottom, black, transparent)';
      nextLayer.classList.add('visible');
      prevLayer.classList.remove('visible');
      leaderBarChampHomePct = homePct;
      leaderBarCurrentTeamId = null; // invalidate the OTHER mode's cache, so leaving championship week always repaints once
      leaderBarActiveLayer = leaderBarActiveLayer === 'A' ? 'B' : 'A';
    }
    return;
  }
  leaderBarChampHomePct = null; // invalidate THIS mode's cache, so entering championship week always repaints once

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
  // Clear any mask left over from championship week's horizontal-split
  // gradient above -- this mode's gradient already fades to transparent
  // on its own, no mask needed.
  nextLayer.style.maskImage = '';
  nextLayer.style.webkitMaskImage = '';
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
    const { episodes } = walkUpsetState(homeRowsSorted.map((r) => r.win_prob), undefined, upsetResetFlags(rows, homeRowsSorted));
    if (episodes.length) {
      // Which episode represents this game: if the challenger actually won,
      // use the biggest episode whose challenger is that winner (the upset
      // that really happened), not just the biggest-peak one -- a game can
      // have an earlier, bigger scare by the other side. Otherwise fall
      // back to the biggest peak overall.
      const pickBest = (list) => list.reduce((best, e) => (!best || e.peakFavoritePct > best.peakFavoritePct ? e : best), null);
      const winningSide = isTie ? null : (winner === home ? 'home' : 'away');
      const completed = winningSide ? episodes.filter((e) => e.upsetSide === winningSide) : [];
      const topEpisode = completed.length ? pickBest(completed) : pickBest(episodes);
      const favoriteTeam = topEpisode.favoriteSide === 'home' ? home : away;
      const upsetTeam = topEpisode.upsetSide === 'home' ? home : away;
      const upsetHappened = !isTie && winner === upsetTeam;
      // Across the league, an upset that actually happened always outranks
      // a threat that was survived (then a tie), regardless of peak -- else
      // a bigger survived scare in another matchup would show up labelled
      // "Upset Threat" even though a real upset occurred this week. Peak
      // only breaks ties within the same rank.
      const rank = upsetHappened ? 2 : isTie ? 1 : 0;
      if (!biggestUpset || rank > biggestUpset.rank || (rank === biggestUpset.rank && topEpisode.peakFavoritePct > biggestUpset.favoritePeak)) {
        biggestUpset = {
          rank,
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

// Holiday-week names for every Week Recap stat. Used only when the selected
// week's theme is Halloween, Thanksgiving or Christmas, so ordinary weeks (and
// Cold Snap / Championship Week) keep the regular names, and browsing an old
// holiday week shows that week's holiday names.
const RECAP_FEST = {
  halloween: {
    title: '\u{1F383} Halloween Week Recap', closest: '\u{1F578}\uFE0F Closest Call', blowout: '\u26B0\uFE0F Buried Alive',
    high: '\u{1F383} Great Pumpkin', low: '\u{1FAA6} Dead on Arrival', hiMatch: '\u{1F9EA} Bubbling Cauldron', loMatch: '\u{1F3DA}\uFE0F Haunted House',
    over: '\u{1F36C} Treat of the Week', under: '\u{1F480} Trick of the Week', nearUpset: '\u{1F631} Close Encounter',
    upsetHappened: '\u{1F9DB} Rise From the Grave', threat: '\u{1F47B} Biggest Scare', total: '\u{1F987} Candy Haul',
  },
  thanksgiving: {
    title: '\u{1F983} Thanksgiving Week Recap', closest: '\u{1F967} Last Slice', blowout: '\u{1F37D}\uFE0F Clean Plate',
    high: '\u{1F967} Biggest Slice', low: '\u{1F983} Turkey of the Week', hiMatch: '\u{1F37D}\uFE0F The Whole Spread', loMatch: '\u{1F963} Thin Gravy',
    over: '\u{1F33D} Cornucopia', under: '\u{1F525} Overcooked', nearUpset: '\u{1F342} Close Call at the Table',
    upsetHappened: '\u{1FA91} Table Flip', threat: '\u{1F341} Gravy Scare', total: '\u{1F37D}\uFE0F Total Feast',
  },
  christmas: {
    title: '\u{1F384} Christmas Week Recap', closest: '\u26C4 Snow Day', blowout: '\u{1F328}\uFE0F Blizzard',
    high: '\u{1F31F} Star on Top', low: '\u{1FAA8} Lump of Coal', hiMatch: '\u{1F381} Gift Exchange', loMatch: '\u{1F9CA} Frozen Over',
    over: '\u{1F385} Nice List', under: '\u{1F608} Naughty List', nearUpset: '\u{1F514} Almost a Miracle',
    upsetHappened: '\u{1F381} Santa\u2019s Surprise', threat: '\u2744\uFE0F Winter Scare', total: '\u{1F384} Total Haul',
  },
};

function renderRecapBanner(byMatchup, teamInfo, theme) {
  const fest = RECAP_FEST[theme] || null;
  const L = (key, dflt) => (fest && fest[key]) || dflt;
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
        <div class="recap-card-label">${L('closest', '\ud83c\udfaf Closest Game')}</div>
        ${g.isTie
          ? `<div class="recap-card-value">${g.home.name} &amp; ${g.away.name} tied exactly</div>`
          : `<div class="recap-card-value"><b style="color:${g.winner.color}">${g.winner.name}</b> over ${g.loser.name}</div><div class="recap-card-sub">by ${g.margin.toFixed(1)}</div>`}
      </div>`);
  }

  if (recap.biggestBlowout) {
    const g = recap.biggestBlowout;
    highlights.push(`
      <div class="recap-card">
        <div class="recap-card-label">${L('blowout', '\ud83d\udca5 Biggest Blowout')}</div>
        <div class="recap-card-value"><b style="color:${g.winner.color}">${g.winner.name}</b> over ${g.loser.name}</div>
        <div class="recap-card-sub">by ${g.margin.toFixed(1)}</div>
      </div>`);
  }

  if (recap.highScore) {
    highlights.push(`
      <div class="recap-card">
        <div class="recap-card-label">${L('high', '\ud83d\udcc8 Highest Score')}</div>
        <div class="recap-card-value" style="color:${recap.highScore.team.color}"><b>${recap.highScore.team.name}</b></div>
        <div class="recap-card-sub">${recap.highScore.score.toFixed(1)} points</div>
      </div>`);
  }

  if (recap.lowScore) {
    highlights.push(`
      <div class="recap-card">
        <div class="recap-card-label">${L('low', '\ud83d\udcc9 Lowest Score')}</div>
        <div class="recap-card-value" style="color:${recap.lowScore.team.color}"><b>${recap.lowScore.team.name}</b></div>
        <div class="recap-card-sub">${recap.lowScore.score.toFixed(1)} points</div>
      </div>`);
  }

  if (recap.highestScoringMatchup) {
    const m = recap.highestScoringMatchup;
    highlights.push(`
      <div class="recap-card">
        <div class="recap-card-label">${L('hiMatch', '\ud83c\udfc8 Highest-Scoring Matchup')}</div>
        <div class="recap-card-value"><b style="color:${m.home.color}">${m.home.name}</b> vs ${m.away.name}</div>
        <div class="recap-card-sub">combined for ${m.combined.toFixed(1)} points</div>
      </div>`);
  }

  if (recap.lowestScoringMatchup) {
    const m = recap.lowestScoringMatchup;
    highlights.push(`
      <div class="recap-card">
        <div class="recap-card-label">${L('loMatch', '\ud83d\udee1\ufe0f Lowest-Scoring Matchup')}</div>
        <div class="recap-card-value"><b style="color:${m.home.color}">${m.home.name}</b> vs ${m.away.name}</div>
        <div class="recap-card-sub">combined for just ${m.combined.toFixed(1)} points</div>
      </div>`);
  }

  if (recap.biggestOverperformer && recap.biggestOverperformer.delta > 0.5) {
    const o = recap.biggestOverperformer;
    highlights.push(`
      <div class="recap-card">
        <div class="recap-card-label">${L('over', '\ud83d\ude80 Biggest Overperformer')}</div>
        <div class="recap-card-value" style="color:${o.team.color}"><b>${o.team.name}</b></div>
        <div class="recap-card-sub">beat their pregame projection by ${o.delta.toFixed(1)} (${o.pregame.toFixed(0)} \u2192 ${o.final.toFixed(0)})</div>
      </div>`);
  }

  if (recap.biggestUnderperformer && recap.biggestUnderperformer.delta < -0.5) {
    const u = recap.biggestUnderperformer;
    highlights.push(`
      <div class="recap-card">
        <div class="recap-card-label">${L('under', '\ud83d\ude2c Biggest Underperformer')}</div>
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
        <div class="recap-card-label">${u.isTie ? L('nearUpset', '\ud83d\udea8 Near-Upset') : u.upsetHappened ? L('upsetHappened', '\ud83d\udea8 Biggest Upset') : L('threat', '\ud83d\udea8 Upset Threat')}</div>
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
        <div class="recap-card-label">${L('total', '\ud83d\udcca Total Points Scored')}</div>
        <div class="recap-card-value"><b>${recap.totalPointsScored.toFixed(1)}</b> combined across the league</div>
        <div class="recap-card-sub">No Upset Watch alerts this week -- a quiet one.</div>
      </div>`);
  }

  banner.innerHTML = `
    <div class="recap-title">${L('title', 'Week Recap')}</div>
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

// "About to impact" build-up: while a kickoff countdown is showing and a holiday
// comet is up, the comet swells, its halo and a screen-edge glow pulse faster,
// and the page starts to tremble as kickoff nears (0 ~2.5 days out -> 1 at kickoff).
const DOOM_SPAN_MS = 64 * 3600 * 1000;
const WARN_MS = 60 * 60 * 1000;          // red/amber alarm stage
const WARN_URGENT_MS = 10 * 60 * 1000;   // faster pulse
let cometSuppressed = false;             // set at kickoff so the build-up comet is gone during the impact cinematic
let kickoffCountdownYear = null, kickoffCountdownWeek = null;
function applyWarn(on, urgent, heartbeat) {
  const root = document.documentElement;
  if (kcHintTheme === 'christmas') root.dataset.warnTheme = 'christmas'; else delete root.dataset.warnTheme;
  const v = on ? (heartbeat ? 'hb' : urgent ? 'urgent' : 'on') : '';
  if ((root.dataset.warn || '') !== v) { if (v) root.dataset.warn = v; else delete root.dataset.warn; }
}
// Kickoff reached on a holiday countdown: fade to black, drop the comet, then play the cinematic.
function startKickoffImpact(theme, year, week) {
  if (prefersReducedMotion() || document.hidden || festCinePlaying || !FEST_METEOR[theme]) return;
  try { localStorage.setItem(`winProbFestCineSeen:v1:${year}:${week}:${theme}`, '1'); } catch {}
  const root = document.documentElement, k = document.getElementById('kickBlack');
  cometSuppressed = true;
  setTimeout(() => { cometSuppressed = false; document.body.classList.remove('kick-zero'); }, 10 * 60 * 1000);
  applyWarn(false);
  if (k) k.classList.add('show');
  setTimeout(() => {
    document.body.classList.add('kick-zero'); document.body.classList.remove('doom-rumble');
    root.classList.add('fest-pre'); root.removeAttribute('data-seasonal-theme');
    window.__kickCine = true; window.__kickClearAfter = false;
    playFestCine(theme, { fromBlack: true });
    setTimeout(() => k && k.classList.remove('show'), 300);
  }, 750);
}
function setDoom(d) {
  const root = document.documentElement;
  const comet = document.getElementById('comet');
  if (!comet || !comet.classList.contains('on') || cometSuppressed) d = 0;
  d = Math.min(Math.max(d, 0), 1);
  const v = d.toFixed(3);
  if (root.dataset.doom !== v) { root.dataset.doom = v; root.style.setProperty('--comet-d', v); }
  document.body.classList.toggle('doom-rumble', d > 0.45 && !prefersReducedMotion() && kcHintTheme !== 'christmas');
  document.body.style.setProperty('--dr', (d * 1.5).toFixed(2));
}
function tickKickoffCountdown() {
  const el = document.getElementById('kickoffCountdown');
  if (!el) return;
  setDoom(kickoffCountdownTarget ? 1 - (kickoffCountdownTarget.getTime() - Date.now()) / DOOM_SPAN_MS : 0);
  const rem0 = kickoffCountdownTarget ? kickoffCountdownTarget.getTime() - Date.now() : Infinity;
  const holidayCd = !!FEST_METEOR[kcHintTheme] && !cometSuppressed;
  const warn = holidayCd && rem0 > 0 && rem0 <= WARN_MS;
  applyWarn(warn, rem0 <= WARN_URGENT_MS, rem0 <= 60000);
  if (!kickoffCountdownTarget) {
    el.hidden = true;
    el.classList.remove('imminent', 'final-minute', 'seasonal-thanksgiving', 'seasonal-christmas', 'seasonal-halloween', 'seasonal-coldsnap');
    return;
  }
  const remaining = kickoffCountdownTarget.getTime() - Date.now();
  const formatted = formatCountdown(remaining);
  if (!formatted) {
    // Kickoff has arrived (or passed) since this was last checked -- hide
    // immediately rather than show a stale "0m 0s" or a negative countdown.
    const wasTheme = kcHintTheme, wasYear = kickoffCountdownYear, wasWeek = kickoffCountdownWeek;
    const fresh = kickoffCountdownTarget && Date.now() - kickoffCountdownTarget.getTime() < 15000; // just now, not a stale tab
    kickoffCountdownTarget = null;
    kcHintTheme = 'none'; // stops the mini particle field too, not just the label
    if (fresh && FEST_METEOR[wasTheme] && wasYear != null) startKickoffImpact(wasTheme, wasYear, wasWeek);
    el.hidden = true;
    el.classList.remove('imminent', 'final-minute', 'seasonal-thanksgiving', 'seasonal-christmas', 'seasonal-halloween', 'seasonal-coldsnap');
    return;
  }
  // Sets the label/time child elements' text directly rather than
  // overwriting this element's whole innerHTML (the old approach) --
  // that used to tear down and recreate everything inside #kickoffCountdown
  // every single second, which would have destroyed the seasonal particle
  // canvas 60 times a minute along with it. See the restructured markup
  // in index.html.
  const labelEl = document.getElementById('kickoffCountdownLabelEl');
  const timeEl = document.getElementById('kickoffCountdownTimeEl');
  if (labelEl) labelEl.textContent = warn ? (kcHintTheme === 'christmas' ? '🔔 SLEIGH BELLS RINGING · ARRIVAL IMMINENT' : '⚠ WARNING · IMPACT IMMINENT') : kickoffCountdownLabel;
  el.classList.toggle('kc-warn', warn);
  el.classList.toggle('kc-warn-xmas', warn && kcHintTheme === 'christmas');
  if (timeEl) timeEl.textContent = formatted;
  // Starts pulsing in the final hour, then gets a bigger, faster pulse in
  // the final minute specifically (see .imminent / .final-minute in
  // index.html) -- CSS handles the actual visuals, including the
  // reduced-motion override, so this is just responsible for toggling
  // the classes at the right moments.
  el.classList.toggle('imminent', remaining <= KICKOFF_IMMINENT_MS);
  el.classList.toggle('final-minute', remaining <= KICKOFF_FINAL_MINUTE_MS);
  el.hidden = false;

  // Piggybacks on this same 1s tick to refresh the championship hero
  // banner's own big countdown digits, rather than running a second timer
  // for what's fundamentally the same clock. Only touches it while the
  // stage is actually in pregame mode -- once live, updateChampionshipStage
  // hides the digits/fallback itself and there's nothing to tick.
  const hypeCountdownEl = document.getElementById('hypeCountdown');
  const hypeCountdownFallbackEl = document.getElementById('hypeCountdownFallback');
  if (hypeCountdownEl && hypeCountdownFallbackEl && (!hypeCountdownEl.hidden || !hypeCountdownFallbackEl.hidden)) {
    renderHypeCountdownBig(remaining);
  }

  // Seasonal hint -- kcHintTheme is set by updateKickoffCountdown based on
  // whether the week THIS countdown counts down to is itself a
  // Thanksgiving/Christmas week (see realSeasonalTheme). Purely cosmetic
  // (tint + one-line hint text); the actual particle preview inside this
  // box is driven by its own independent kcTick loop reading the same
  // kcHintTheme variable, not by this function.
  el.classList.remove('seasonal-thanksgiving', 'seasonal-christmas', 'seasonal-halloween', 'seasonal-coldsnap');
  const seasonalHintEl = document.getElementById('kickoffSeasonalHint');
  if (kcHintTheme === 'none') {
    if (seasonalHintEl) seasonalHintEl.hidden = true;
  } else {
    // seasonalCssTheme normalizes coldsnap-pre/coldsnap-post to the same
    // 'seasonal-coldsnap' class -- only the hint TEXT below differs by
    // phase, the box tint is identical either side of Christmas.
    el.classList.add(`seasonal-${seasonalCssTheme(kcHintTheme)}`);
    if (seasonalHintEl) {
      seasonalHintEl.hidden = false;
      seasonalHintEl.textContent = warn ? (kcHintTheme === 'christmas' ? SEASONAL_HINT_COPY_WARN_XMAS : SEASONAL_HINT_COPY_WARN) : ((kcHintTheme === 'christmas' && kcHintFestive) ? SEASONAL_HINT_COPY_FESTIVE : (SEASONAL_HINT_COPY[kcHintTheme] || ''));
    }
  }
}

// Only meaningful when looking at the CURRENT/latest year+week -- browsing
// an older week via the dropdowns shouldn't show a countdown to some
// kickoff that (relative to "now") may already be long past. selectedIndex
// 0 is always the most recent option in both dropdowns, since they're
// populated in descending order (see loadYearsWeeks).
async function updateKickoffCountdown(byMatchup, year, week) {
  if (yearSelect.selectedIndex !== 0 || weekSelect.selectedIndex !== 0) {
    kickoffCountdownTarget = null;
    kcHintTheme = 'none';
    tickKickoffCountdown();
    return;
  }

  const weekDone = isWeekFullyDone(byMatchup);
  const targetWeek = weekDone ? week + 1 : week;
  const weekStart = await fetchWeekStart(year, targetWeek);

  if (!weekStart || Date.now() >= weekStart.getTime()) {
    kickoffCountdownTarget = null;
    kcHintTheme = 'none';
    tickKickoffCountdown();
    return;
  }

  kickoffCountdownTarget = weekStart;
  kickoffCountdownLabel = `Week ${targetWeek} kicks off in`;
  kickoffCountdownYear = year; kickoffCountdownWeek = targetWeek;

  // Is the week THIS countdown is counting down to itself a Thanksgiving/
  // Christmas week? Deliberately uses realSeasonalTheme (no debug
  // override) -- forcing a theme on via the debug toggles already shows
  // the FULL effect on whatever week is currently selected, so a "hint"
  // about it here would be redundant at best, confusing at worst.
  try {
    kcHintTheme = await realSeasonalTheme(year, targetWeek);
    kcHintFestive = kcHintTheme === 'christmas' && await christmasIsShifted(year);
  } catch {
    kcHintTheme = 'none';
    kcHintFestive = false;
  }
  tickKickoffCountdown(); // unhides the box first so it has a real size to measure
  seedKcParticles();
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
  const { armed, watch, peak } = walkUpsetState(homeSorted.map((r) => r.win_prob), undefined, upsetResetFlags(rows, homeSorted));
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
    const { episodes } = walkUpsetState(homeRowsSorted.map((r) => r.win_prob), undefined, upsetResetFlags(rows, homeRowsSorted));
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
    <div class="pumpkin-corner left">\ud83c\udf83</div>
    <div class="pumpkin-corner right">\ud83c\udf83</div>
    <div class="ghost-corner left">\ud83d\udc7b</div>
    <div class="ghost-corner right">\ud83d\udc7b</div>
    <div class="seasonal-garland"></div>
    <div class="tier-ribbon" hidden></div>
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
        ${buildFcPowerRow(homeRow?.team_id)}
        <div class="fc-team-row">
          <span class="fc-team-name" style="color:${away.color}">${away.name}</span>
          <span class="fc-team-dash" style="color:${away.color}"></span>
          <span class="delta-badge"></span>
          <span class="fc-team-pct" style="color:${away.color}">${Math.round(100 - homePct)}%</span>
        </div>
        ${buildFcPowerRow(awayRow?.team_id)}
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

  decorateSeasonalCard(card, currentSeasonalTheme, home, away);
  applySeasonalUpsetState(card, currentSeasonalTheme, !!upsetInfo);

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

  // buildFcPowerRow always returns a '.fc-power-row' element (hidden when
  // there's nothing to show), so outerHTML-replacing it in place never
  // loses the slot for next time, the same reason that function's own
  // comment gives.
  const powerRows = card.querySelectorAll('.fc-power-row');
  if (powerRows[0]) powerRows[0].outerHTML = buildFcPowerRow(homeRow?.team_id);
  if (powerRows[1]) powerRows[1].outerHTML = buildFcPowerRow(awayRow?.team_id);

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
  applySeasonalUpsetState(card, currentSeasonalTheme, !!upsetInfo);

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

  // Brief glow in the team's own color while the number rolls.
  el.classList.remove('pct-tick');
  void el.offsetWidth; // restart the animation if one is already running
  el.classList.add('pct-tick');

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

// ---- ESPN view effects ----
// Live "head": a dot pinned to the newest point on the chart line, in the
// color of whichever team is leading, with a soft ripple. It glides to each
// new point and pings once when a poll adds one. A plain DOM element over the
// canvas (positioned from the chart's own scales), so the animation runs on
// CSS and costs nothing between updates. Only shown while the game is live.
function positionEspnHead(chart) {
  if (!chart || !chart.canvas || !chart._state) return;
  const box = chart.canvas.closest('.espn-chartBox');
  if (!box) return;
  let el = box.querySelector('.espn-head');
  if (!el) {
    el = document.createElement('span');
    el.className = 'espn-head';
    box.appendChild(el);
  }
  const pts = chart.data.datasets[chart._state.mainIdx].data;
  const last = pts[pts.length - 1];
  const sx = chart.scales && chart.scales.x, sy = chart.scales && chart.scales.y;
  if (!last || !sx || !sy || !chart._state.live) { el.classList.remove('on'); return; }
  el.style.left = `${sx.getPixelForValue(last.x)}px`;
  el.style.top = `${sy.getPixelForValue(last.y)}px`;
  el.style.setProperty('--head', last.y >= 50 ? chart._state.homeColor : chart._state.awayColor);
  const key = String(last.x);
  if (el._lastX !== undefined && el._lastX !== key) {
    el.classList.remove('ping');
    void el.offsetWidth;
    el.classList.add('ping');
  }
  el._lastX = key;
  el.classList.add('on');
}

// Lead change: when the favorite flips, the new leader's row sweeps with its
// team color and its percentage pops, and the chart's live dot sends out a
// bigger double ripple. `side` is 'home' or 'away' (the NEW leader).
function flashLeadChange(card, chart, side, color) {
  const row = card.querySelector(side === 'home' ? '.espn-row-top' : '.espn-row-bottom');
  if (row) {
    row.style.setProperty('--flip', color);
    row.style.setProperty('--flip-glow', colorWithAlpha(color, 0.3));
    row.classList.remove('lead-flip');
    void row.offsetWidth;
    row.classList.add('lead-flip');
    clearTimeout(row._flipT);
    row._flipT = setTimeout(() => row.classList.remove('lead-flip'), 1800);
  }
  const head = card.querySelector('.espn-head');
  if (head) {
    head.classList.remove('flip');
    void head.offsetWidth;
    head.classList.add('flip');
    clearTimeout(head._flipT);
    head._flipT = setTimeout(() => head.classList.remove('flip'), 2400);
  }
}

function renderEspnCard(rows, home, away, allDone) {
  const homePct = latestPct(rows);
  const isLive = !allDone && isRecentlyActive(rows);
  const upsetInfo = getLiveUpsetInfo(rows, home, away, allDone);
  const card = document.createElement('div');
  card.className = 'espn-card' + (upsetInfo ? ' upset-watch' : '');
  if (upsetInfo) applyUpsetColor(card, upsetInfo.upsetTeam.color);
  card.innerHTML = `
    <div class="pumpkin-corner left">\ud83c\udf83</div>
    <div class="pumpkin-corner right">\ud83c\udf83</div>
    <div class="ghost-corner left">\ud83d\udc7b</div>
    <div class="ghost-corner right">\ud83d\udc7b</div>
    <div class="seasonal-garland"></div>
    <div class="tier-ribbon" hidden></div>
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
    homeColor: home.color,
    awayColor: away.color,
    live: isLive,
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
      onResize: (c) => positionEspnHead(c),
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
  requestAnimationFrame(() => positionEspnHead(chart));

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

  decorateSeasonalCard(card, currentSeasonalTheme, home, away);
  applySeasonalUpsetState(card, currentSeasonalTheme, !!upsetInfo);

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
  chart._state.homeColor = home.color;
  chart._state.awayColor = away.color;
  chart._state.live = !allDone && isRecentlyActive(rows);
  positionEspnHead(chart);

  // Only refresh the visible labels if the marker isn't currently being
  // shown via hover -- otherwise a background refresh would yank the
  // numbers out from under someone mid-hover. The delta popup follows the
  // same guard: hovering is you scrubbing history, not a new poll arriving,
  // so it shouldn't trigger a "the number changed" callout.
  const isHovering = chart.data.datasets[mainIdx + 1].hidden === false;
  if (!isHovering) {
    setEspnPctLabels(chart.canvas, chart._state.currentHomePct);

    // Lead change (live games only): the favorite flipped since the last poll.
    const sideOf = (p) => (p == null ? null : p > 50 ? 'home' : p < 50 ? 'away' : null);
    const prevSide = sideOf(prevHomePct), newSide = sideOf(newHomePct);
    if (!allDone && prevSide && newSide && prevSide !== newSide) {
      const flipCard = chart.canvas.closest('.espn-card');
      if (flipCard) flashLeadChange(flipCard, chart, newSide, newSide === 'home' ? home.color : away.color);
    }

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
    applySeasonalUpsetState(card, currentSeasonalTheme, !!upsetInfo);
  }
}

const VIEW_RENDERERS = {
  timeline: { render: renderTimelineCard, update: updateTimelineCard },
  postcard: { render: renderPostcardCard, update: updatePostcardCard },
  needle: { render: renderNeedleCard, update: updateNeedleCard },
  espn: { render: renderEspnCard, update: updateEspnCard },
};

// ============================== POWER PICKS ==============================
// A pregame prediction view that takes over #matchups for the ~24 hours
// between when the poller starts writing a week's real pairings (see
// poll.js's plottingOpen gate) and that week's actual first kickoff. Real
// matchups exist by then, but nothing has been played yet (actual_score
// sits at 0, all_starters_done is false for every row) -- so the normal
// live-graph views, which all assume a score is trending somewhere, have
// nothing meaningful to plot. Predictions instead come from the same
// Power Rating v2 model the Standings page uses (projection/actual blend,
// recency weighting, shrinkage, 15% resume, uncertainty, normalCdf) -- ported here rather than shared, same
// cross-file-duplication convention standings.js/year-in-review.js already
// follow; see standings.js for the fully-commented original.

const powerPicksHistoryCache = {}; // `${leagueId}-${year}` -> snapshot rows, reused across polls this session
async function fetchPowerPicksHistory(leagueId, year) {
  const cacheKey = `${leagueId}-${year}`;
  const hit = powerPicksHistoryCache[cacheKey];
  if (hit && Date.now() - hit.at < 5 * 60 * 1000) return hit.rows;
  if (hit && hit.pending) return hit.pending;
  // snapshot_summary = one row per matchup-team (latest state + pregame
  // columns) instead of every 1-5 minute poll -- a few hundred rows rather
  // than tens of thousands for a full season.
  const pending = fetchAllRows((from, to) =>
    sb.from('snapshot_summary')
      .select('year, week, matchup_id, team_id, actual_score, expected_score, win_prob, all_starters_done, ts, pregame_win_prob, pregame_expected_score')
      .eq('league_id', leagueId).eq('year', year).order('ts').range(from, to)
  ).then((rows) => {
    powerPicksHistoryCache[cacheKey] = { at: Date.now(), rows };
    return rows;
  }).catch((err) => { delete powerPicksHistoryCache[cacheKey]; throw err; });
  powerPicksHistoryCache[cacheKey] = { at: 0, rows: null, pending };
  return pending;
}

// Earliest recorded win_prob per (week, matchup_id, team_id) -- the
// closest thing to "what the model thought before this game" available,
// since nothing marks a specific poll as pregame. Ported verbatim from
// standings.js's extractPregameWinProb.
function extractPregameWinProb(rows) {
  const earliest = new Map();
  for (const r of rows) {
    if (r.pregame_win_prob != null) {
      // snapshot_summary already carries the earliest win_prob per game.
      earliest.set(`${r.year}|${r.week}|${r.matchup_id}|${r.team_id}`, { ts: '', win_prob: r.pregame_win_prob });
      continue;
    }
    if (r.win_prob == null) continue;
    const key = `${r.year}|${r.week}|${r.matchup_id}|${r.team_id}`;
    const existing = earliest.get(key);
    if (!existing || new Date(r.ts) < new Date(existing.ts)) earliest.set(key, r);
  }
  const result = new Map();
  for (const [key, r] of earliest) result.set(key, r.win_prob);
  return result;
}

// Ported from standings.js's computePowerRatings -- Power Rating v2 (see the
// long comment on that function in standings.js for what it does and why).
// Reuses this file's own normalCdf/erf (defined near the top) rather than
// duplicating those too.
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

// Head-to-head win probability for this one matchup, from the two teams'
// Power Ratings rather than this week's projections alone -- a team whose
// projections happen to be high this week but has been getting outplayed
// relative to the model all season shouldn't look like a lock. Combines
// both teams' independent uncertainty (stdErr) the same way two
// independent normal estimates combine: variances add.
function powerPickWinProbability(ratingA, ratingB) {
  // Power Rating v2's rating is "points per game better than the average
  // team", so a single game's margin is that gap plus a LOT of week-to-week
  // scoring noise (each team's weekly score has stddev ~21, so the margin
  // has ~21*sqrt(2)). The two ratings' own estimation uncertainty (stdErr)
  // adds on top. The previous version only used the estimation part, which
  // made a modest rating gap read like a near-lock.
  const POWER_GAME_SD = 21;
  const combinedVar = 2 * POWER_GAME_SD ** 2 + ratingA.stdErr ** 2 + ratingB.stdErr ** 2;
  const z = (ratingA.rating - ratingB.rating) / Math.sqrt(combinedVar);
  return 100 * normalCdf(z);
}

// ============================== FORECAST POWER PROJECTION ==============================
// Shows each team's Power Score moving from its PRE-GAME value (through
// last week) to a live PROJECTED value for this week, right on the
// Forecast card -- same question Power Picks answers before kickoff, kept
// updating once games are actually live.
//
// computePowerRatings only ever counts a matchup once BOTH sides are
// all_starters_done -- that's correct for the real cached Power Rankings
// (standings.js, year-in-review.js, poll.js's cache), which should never
// show a number that isn't fully earned yet. This is deliberately
// different: it feeds the SAME function a synthetic "finished" version of
// THIS week's still-in-progress matchups, using each team's current live
// expected_score as a stand-in for its final actual_score -- same idea as
// the What If view's hypothetical pairing, just applied to the real
// schedule instead of a swapped one. Never written anywhere; purely a
// client-side projection that naturally sharpens into the real number as
// expected_score itself converges toward actual_score over the course of
// the week.
function renderPowerDelta(delta) {
  if (Math.abs(delta) < 0.05) return '<span class="power-delta power-delta-flat">±0.0</span>';
  const sign = delta > 0 ? '+' : '−'; // true minus sign, matching standings.js's own convention
  const cls = delta > 0 ? 'power-delta-up' : 'power-delta-down';
  return `<span class="power-delta ${cls}">${sign}${Math.abs(delta).toFixed(1)}</span>`;
}

async function computePowerProjection(leagueId, year, week, byMatchup, teamInfo) {
  const history = await fetchPowerPicksHistory(leagueId, year);
  const teamIds = Object.keys(teamInfo);
  const pregameMap = extractPregameWinProb(history);

  const baseline = computePowerRatings(history, teamIds, pregameMap, week - 1);

  // One synthetic row per side per real matchup THIS week -- a later ts
  // than anything real (so computePowerRatings' own latest-by-ts dedupe
  // always prefers it over that team's real, still-in-progress row for
  // this exact week) and all_starters_done forced true (so it's counted
  // as a finished game for the regression at all). pregameMap is left
  // untouched -- it's built from the real history, which already has each
  // team's real pregame win_prob recorded from when this week's plotting
  // window opened, same number the real Power Rankings would eventually
  // use once this week actually finishes.
  const pregameExpByKey = new Map();
  for (const r of history) {
    if (r.pregame_expected_score != null) pregameExpByKey.set(`${r.year}|${r.week}|${r.matchup_id}|${r.team_id}`, r.pregame_expected_score);
  }
  const projectedRows = history.slice();
  const bumpedTs = new Date(Date.now() + 1000).toISOString();
  for (const rows of Object.values(byMatchup)) {
    const homeRow = latestRow(rows, true);
    const awayRow = latestRow(rows, false);
    if (!homeRow || !awayRow) continue;
    for (const row of [homeRow, awayRow]) {
      projectedRows.push({
        year, week, matchup_id: row.matchup_id, team_id: row.team_id,
        actual_score: row.expected_score, expected_score: row.expected_score,
        pregame_expected_score: pregameExpByKey.get(`${year}|${week}|${row.matchup_id}|${row.team_id}`) ?? null, all_starters_done: true, ts: bumpedTs,
      });
    }
  }

  const projected = computePowerRatings(projectedRows, teamIds, pregameMap, week);

  const result = new Map();
  for (const id of teamIds) result.set(id, { baseline: baseline.get(id), projected: projected.get(id) });
  return result;
}

// Always returns a '.fc-power-row' element (hidden when there's nothing to
// show yet) rather than sometimes omitting it -- updateNeedleCard replaces
// this element's outerHTML in place on every refresh, and needs a stable
// element to find there every time, not one that disappears the first
// time projection data isn't ready yet.
function buildFcPowerRow(teamId) {
  const entry = teamId != null ? powerProjectionByTeam?.get(teamId) : null;
  const projected = entry?.projected;
  if (!projected || !projected.gamesPlayed) return '<div class="fc-power-row" hidden></div>';

  const baseline = entry.baseline;
  const hasBaseline = !!(baseline && baseline.gamesPlayed);
  const deltaHtml = hasBaseline
    ? renderPowerDelta(projected.score - baseline.score)
    : '<span class="power-delta power-delta-new">New</span>';
  const fromHtml = hasBaseline ? `${baseline.score.toFixed(1)} → ` : '';
  return `
    <div class="fc-power-row">
      <span class="fc-power-label">Power Score</span>
      <span class="fc-power-value">${fromHtml}${projected.score.toFixed(1)}</span>
      ${deltaHtml}
    </div>
  `;
}

async function renderPowerPicksView(leagueId, year, week, byMatchup, teamInfo, { forcedPreview = false } = {}) {
  matchupsEl.classList.remove('view-timeline', 'view-postcard', 'view-needle', 'view-espn', 'view-whatif');
  matchupsEl.classList.add('view-power-picks');
  Object.values(charts).forEach(destroyEntry);
  for (const key of Object.keys(charts)) delete charts[key];
  statusEl.textContent = '';

  let ratings = null;
  try {
    const history = await fetchPowerPicksHistory(leagueId, year);
    // Team ids are uuids (see teams.id in the schema) -- Number(uuid) is
    // always NaN, which silently collapsed every team into one bogus key
    // here and made computePowerRatings' lookups miss for every real team.
    // havePicks below just degrades quietly when ratings don't resolve,
    // which is almost certainly why this went unnoticed: Power Picks still
    // rendered (projections only, no prediction), never errored.
    const teamIds = Object.keys(teamInfo);
    const pregameMap = extractPregameWinProb(history);
    ratings = computePowerRatings(history, teamIds, pregameMap, week - 1);
  } catch (err) {
    console.warn('Power Picks: could not compute Power Ratings, falling back to projections only:', err.message);
  }

  matchupsEl.innerHTML = '';
  const banner = document.createElement('div');
  banner.className = 'power-picks-banner';
  banner.innerHTML = forcedPreview
    ? `<div class="pp-title">🔮 Power Picks -- Week ${week} <span class="pp-preview-tag">preview</span></div>` +
      `<div class="pp-sub">Forced on via Preferences -- real polling is still running behind this in the background, untouched. Turn the toggle off to see the live view again.</div>`
    : `<div class="pp-title">🔮 Power Picks -- Week ${week}</div>` +
      `<div class="pp-sub">Predictions before kickoff, from the site's Power Rankings model -- live graphs take over once games start.</div>`;
  matchupsEl.appendChild(banner);

  for (const [matchupId, rows] of Object.entries(byMatchup)) {
    const homeRow = rows.find((r) => r.is_home);
    const awayRow = rows.find((r) => !r.is_home);
    if (!homeRow || !awayRow) continue;

    const home = teamInfo[homeRow.team_id] || { name: 'Home', color: '#1a3fa0', emoji: '', logoUrl: '' };
    const away = teamInfo[awayRow.team_id] || { name: 'Away', color: '#c0392b', emoji: '', logoUrl: '' };

    const homeRating = ratings?.get(homeRow.team_id);
    const awayRating = ratings?.get(awayRow.team_id);
    const havePicks = !!(homeRating && awayRating);
    const homePickPct = havePicks ? powerPickWinProbability(homeRating, awayRating) : null;
    const favorsHome = homePickPct != null && homePickPct >= 50;

    const card = document.createElement('div');
    card.className = 'power-picks-card';
    card.style.setProperty('--home-color', favorsHome ? home.color : away.color);
    card.innerHTML = `
      <div class="pp-row">
        <span class="pp-icon">${renderTeamIcon(home)}</span>
        <span class="pp-name" style="color:${home.color}">${home.name}</span>
        <span class="pp-score">${homeRow.expected_score != null ? Number(homeRow.expected_score).toFixed(1) + ' proj' : ''}</span>
        ${havePicks ? `<span class="pp-pick" style="color:${home.color}">${Math.round(homePickPct)}%</span>` : ''}
      </div>
      <div class="pp-vs">vs</div>
      <div class="pp-row">
        <span class="pp-icon">${renderTeamIcon(away)}</span>
        <span class="pp-name" style="color:${away.color}">${away.name}</span>
        <span class="pp-score">${awayRow.expected_score != null ? Number(awayRow.expected_score).toFixed(1) + ' proj' : ''}</span>
        ${havePicks ? `<span class="pp-pick" style="color:${away.color}">${Math.round(100 - homePickPct)}%</span>` : ''}
      </div>
      ${havePicks
        ? `<div class="pp-footer">Power Pick: <b style="color:${favorsHome ? home.color : away.color}">${favorsHome ? home.name : away.name}</b></div>`
        : ''}
    `;
    matchupsEl.appendChild(card);
  }
}

// ============================== WHAT IF ==============================
// Lets someone pick any two teams from this week (not just real
// opponents) and see a win-probability line as if they'd played each
// other instead -- built entirely from data already fetched for this
// week (byMatchup), no new query. Each team's own actual/expected score
// at every poll is independent of who they actually played, so the only
// new work is re-pairing them and re-running the SAME win-probability
// model the poller uses, with each team's own derived "done" state
// (below) standing in for the stored all_starters_done flag, which is a
// MATCHUP-level flag (true only once both REAL sides are done) and so
// can't be reused for a hypothetical pairing.

const WHATIF_DEFAULT_STDDEV = 21; // matches poll.js / winProb.js's DEFAULT_STDDEV
const WHATIF_MIN_STDDEV = 1.5; // matches winProb.js's MIN_STDDEV

// A team's own expected_score converges to EXACTLY equal its actual_score
// once every one of its starters' real games has finished (see
// playerExpected in winProb.js) -- the same quirk that was behind the
// Year-in-Review overperformer/underperformer bug. Here it's the fix
// itself: since the stored all_starters_done flag can't tell us whether
// THIS specific team (as opposed to its real opponent) is done, this
// equality is the only signal available to derive that per-team.
function whatIfTeamDone(row) {
  return Math.abs(row.actual_score - row.expected_score) < 0.05;
}

// Points-based half of the poller's own computeDynamicStddev (see
// winProb.js) -- the only half reconstructable here. The other half (how
// much real game-clock each roster had left at a given moment) needs each
// player's own remaining-time fraction, which isn't persisted anywhere;
// only the final per-team expected/actual totals are. Practical effect:
// this runs very slightly more cautious than the live model would in the
// closing minutes of a close game, and is effectively identical everywhere
// else -- never worth blocking the feature over.
function whatIfDynamicStddev(expectedA, actualA, expectedB, actualB) {
  const totalProjectedBoth = expectedA + expectedB;
  if (totalProjectedBoth <= 0) return WHATIF_MIN_STDDEV;
  const remainingProjectedBoth = Math.max(expectedA - actualA, 0) + Math.max(expectedB - actualB, 0);
  const ratio = Math.max(Math.min(remainingProjectedBoth / totalProjectedBoth, 1), 0);
  return Math.max(WHATIF_DEFAULT_STDDEV * Math.sqrt(ratio), WHATIF_MIN_STDDEV);
}

// Ported from winProb.js's matchupWinProbability -- same "a finished
// blowout is a known fact, not a random variable" and "one side locked in
// and already behind can't be caught" handling, just fed each team's own
// derived done-state instead of the stored matchup-level flag.
function whatIfWinProbability({ expectedA, expectedB, actualA, actualB, aDone, bDone }) {
  if (aDone && bDone) {
    if (actualA > actualB) return 100;
    if (actualA < actualB) return 0;
    return 50;
  }
  if (aDone && !bDone && actualA < actualB) return 1;
  if (bDone && !aDone && actualB < actualA) return 99;
  const stddev = whatIfDynamicStddev(expectedA, actualA, expectedB, actualB);
  const z = (expectedA - expectedB) / (stddev * Math.SQRT2);
  return Math.max(0, Math.min(100, normalCdf(z) * 100));
}

// Mirrors computeChartPoints exactly (same nearestByTs + withCrossings
// pipeline already used to line up two real teams' independently-timed
// polls) -- just computing a hypothetical win_prob at each point instead
// of reading the stored one.
function computeHypotheticalPoints(rowsA, rowsB) {
  if (!rowsA?.length || !rowsB?.length) return { points: [], rawPoints: [], maxX: 0 };

  const allTimestamps = Array.from(new Set([...rowsA.map((r) => r.ts), ...rowsB.map((r) => r.ts)])).sort(
    (x, y) => new Date(x) - new Date(y)
  );

  const rawPoints = allTimestamps
    .map((ts, i) => {
      const a = nearestByTs(rowsA, ts);
      const b = nearestByTs(rowsB, ts);
      if (!a || !b) return null;
      const aDone = whatIfTeamDone(a);
      const bDone = whatIfTeamDone(b);
      const y = whatIfWinProbability({
        expectedA: a.expected_score, expectedB: b.expected_score,
        actualA: a.actual_score, actualB: b.actual_score,
        aDone, bDone,
      });
      return { x: i, y, ts, aActual: a.actual_score, bActual: b.actual_score, aDone, bDone };
    })
    .filter(Boolean);

  const points = withCrossings(rawPoints);
  const maxX = rawPoints.length ? rawPoints[rawPoints.length - 1].x : 0;
  return { points, rawPoints, maxX };
}

function buildWhatIfShell() {
  return `
    <div class="whatif-card" id="whatIfShell">
      <div class="whatif-title">🔀 What If</div>
      <div class="whatif-sub">Pick any two teams from this week and see how the win-probability line would've moved if they'd played each other instead -- in the same ESPN-style card, including where a hypothetical Upset Watch would've fired.</div>
      <div class="whatif-picker">
        <select id="whatIfTeamASelect"></select>
        <span class="whatif-vs">vs</span>
        <select id="whatIfTeamBSelect"></select>
      </div>
      <div id="whatIfCardSlot"></div>
      <div class="whatif-scoreline" id="whatIfScoreLine"></div>
      <div class="whatif-note">Each team's own score is real and unaffected by this -- only who they're matched up against is hypothetical. Uses the same win-probability and Upset Watch models as the live site; see the comment near whatIfDynamicStddev for the one small approximation it makes.</div>
    </div>
  `;
}

// Same state machine the real ESPN card's live Upset Watch badge uses
// (see walkUpsetState) -- it only ever needs a plain chronological
// win_prob sequence from one side's perspective, which is exactly what
// this view's own hypothetical rawPoints already are. The 'home'/'away'
// labels walkUpsetState returns just mean "team A's role"/"team B's
// role" in that shared state machine here, not any real designation.
function getWhatIfLiveUpsetInfo(rawPoints, a, b, bothDone) {
  if (bothDone || rawPoints.length < 2) return null;
  const { watch, armed, peak, upsetSide } = walkUpsetState(rawPoints.map((p) => p.y));
  if (!watch) return null;
  return {
    favorite: armed === 'home' ? a.info : b.info,
    upsetTeam: upsetSide === 'home' ? a.info : b.info,
    favoritePeak: peak,
  };
}

// Mirrors getUpsetWatchHistory, replaying the same state machine over the
// hypothetical sequence instead of a real team's stored win_prob -- used
// by the hover handler below to say "Upset Watch would've been active
// here" at the right points along the line.
function getWhatIfUpsetHistory(rawPoints) {
  const history = [];
  let i = 0;
  walkUpsetState(rawPoints.map((p) => p.y), (watchNow, upsetSideNow) => {
    history.push({ ts: rawPoints[i].ts, watch: watchNow, upsetSide: upsetSideNow });
    i++;
  });
  return history;
}

function renderWhatIfScoreLine(rawPoints, a, b) {
  const el = document.getElementById('whatIfScoreLine');
  if (!el) return;
  if (!rawPoints.length) { el.textContent = ''; return; }
  const latest = rawPoints[rawPoints.length - 1];
  el.innerHTML = `Real scores: <b style="color:${a.info.color}">${a.info.name} ${latest.aActual.toFixed(1)}</b> &ndash; <b style="color:${b.info.color}">${latest.bActual.toFixed(1)} ${b.info.name}</b>`;
}

// Builds the actual hypothetical-matchup card -- deliberately built from
// the SAME '.espn-card' markup/CSS and the SAME hover/pct-label/upset-
// badge/seasonal-decor helpers the real ESPN view uses (setEspnPctLabels,
// setUpsetBadgeState, renderTeamIcon, applyUpsetColor, decorateSeasonalCard,
// applySeasonalUpsetState), rather than a parallel implementation -- so
// this reads as a genuine sibling of that view instead of a different-
// looking tool bolted on next to it, and a future tweak to the ESPN
// card's look/interaction doesn't need a separate matching edit here.
// One deliberate simplification vs. the real card: this always does a
// full rebuild (destroy + recreate the chart) rather than updating in
// place, so the little "+X.X%" delta-badge animation the real card shows
// on each refresh doesn't fire here -- not worth the extra incremental-
// update machinery for a view people dip into occasionally rather than
// leave open and watch continuously.
function renderWhatIfEspnCard(rawPoints, points, maxX, a, b, bothDone) {
  const isLive = !bothDone && isRecentlyActive(rawPoints);
  const upsetInfo = getWhatIfLiveUpsetInfo(rawPoints, a, b, bothDone);
  const latestY = rawPoints[rawPoints.length - 1].y;

  const card = document.createElement('div');
  card.className = 'espn-card' + (upsetInfo ? ' upset-watch' : '');
  if (upsetInfo) applyUpsetColor(card, upsetInfo.upsetTeam.color);
  card.innerHTML = `
    <div class="pumpkin-corner left">🎃</div>
    <div class="pumpkin-corner right">🎃</div>
    <div class="ghost-corner left">👻</div>
    <div class="ghost-corner right">👻</div>
    <div class="seasonal-garland"></div>
    <div class="upset-watch-badge${upsetInfo ? ' visible pulsing' : ''}">🚨 UPSET WATCH</div>
    <div class="espn-header">
      <button class="why-btn" type="button" title="Why is this the number?">ⓘ</button>
      <div class="why-blurb" hidden>This recombines ${a.info.name}'s and ${b.info.name}'s own real weekly performances into a hypothetical head-to-head, using the exact same win-probability model as the live site -- just re-paired against each other instead of their real opponents. Each team's own score is untouched; only who they're facing is hypothetical.</div>
      <span class="postcard-status ${isLive ? 'live' : ''}">${bothDone ? 'Final' : '● Live'}</span>
    </div>
    <div class="espn-row espn-row-top">
      <span class="espn-emoji">${renderTeamIcon(a.info)}</span>
      <span class="espn-name" style="color:${a.info.color}">${a.info.name}</span>
      <span class="espn-dash" style="background:${a.info.color}"></span>
      <span class="delta-badge"></span>
      <span class="espn-pct" style="color:${a.info.color}">${Math.round(latestY)}%</span>
    </div>
    <div class="espn-chartBox"><canvas></canvas></div>
    <div class="espn-row espn-row-bottom">
      <span class="espn-emoji">${renderTeamIcon(b.info)}</span>
      <span class="espn-name" style="color:${b.info.color}">${b.info.name}</span>
      <span class="espn-dash" style="background:${b.info.color}"></span>
      <span class="delta-badge"></span>
      <span class="espn-pct" style="color:${b.info.color}">${Math.round(100 - latestY)}%</span>
    </div>
  `;
  wireWhyButton(card);

  const canvas = card.querySelector('canvas');
  const state = {
    currentHomePct: latestY,
    upsetHistory: getWhatIfUpsetHistory(rawPoints),
    currentUpsetInfo: upsetInfo,
  };

  whatIfChartInstance = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: {
      datasets: [
        {
          data: points,
          parsing: false,
          borderWidth: 2,
          pointRadius: 0,
          tension: 0.15,
          fill: { target: { value: 50 } },
          segment: {
            borderColor: (c) => (midY(c) >= 50 ? a.info.color : b.info.color),
            backgroundColor: (c) => {
              const gradients = getBandGradients(c.chart, a.info.color, b.info.color);
              if (!gradients) return 'transparent';
              return midY(c) >= 50 ? gradients.home : gradients.away;
            },
          },
        },
        {
          // Vertical hover guide -- hidden until hovered, same convention
          // as the real ESPN card (see renderEspnCard).
          data: [], hidden: true, parsing: false, borderWidth: 1.5,
          borderColor: themeVar('#222', '#ddd'), pointRadius: 0, fill: false, tension: 0, clip: false,
        },
        {
          // The hover dot, drawn last so it sits on top.
          data: [], hidden: true, parsing: false, showLine: false, pointRadius: 7,
          pointBackgroundColor: themeVar('#111', '#eee'), pointBorderColor: themeVar('#fff', '#111'),
          pointBorderWidth: 2, clip: false,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      resizeDelay: 100,
      layout: { padding: { top: 10, right: 16, bottom: 0, left: 4 } },
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
            callback: (v) => (v === 0 ? 100 : (v === 50 || v === 100 ? v : '')),
            color: (c) => {
              if (c.tick.value === 100) return a.info.color;
              if (c.tick.value === 0) return b.info.color;
              return themeVar('#555', '#aaa');
            },
          },
        },
        x: {
          type: 'linear', min: 0, max: maxX,
          grid: { color: themeVar('rgba(0,0,0,0.06)', 'rgba(255,255,255,0.08)') },
          ticks: { display: false },
        },
      },
    },
  });
  whatIfChartInstance._state = state;

  let lastHoverX = null;
  canvas.addEventListener('mousemove', (evt) => {
    const rect = canvas.getBoundingClientRect();
    const mouseX = evt.clientX - rect.left;
    const xValue = whatIfChartInstance.scales.x.getValueForPixel(mouseX);
    if (xValue == null) return;
    const currentPoints = whatIfChartInstance.data.datasets[0].data;
    if (!currentPoints.length) return;

    let nearest = currentPoints[0];
    let minDist = Infinity;
    for (const p of currentPoints) {
      const d = Math.abs(p.x - xValue);
      if (d < minDist) { minDist = d; nearest = p; }
    }
    if (nearest.x === lastHoverX) return;
    lastHoverX = nearest.x;

    whatIfChartInstance.data.datasets[1].data = [{ x: nearest.x, y: 0 }, { x: nearest.x, y: 100 }];
    whatIfChartInstance.data.datasets[1].hidden = false;
    whatIfChartInstance.data.datasets[2].data = [nearest];
    whatIfChartInstance.data.datasets[2].hidden = false;
    whatIfChartInstance.update('none');
    setEspnPctLabels(canvas, nearest.y, { animate: false });

    if (showUpsetHistory && whatIfChartInstance._state.upsetHistory.length) {
      const nearestEntry = nearestByTs(whatIfChartInstance._state.upsetHistory, nearest.ts);
      const wasActive = nearestEntry ? nearestEntry.watch : false;
      const isCurrentlyLive = !!whatIfChartInstance._state.currentUpsetInfo;
      if (wasActive) {
        const historicalColor = nearestEntry.upsetSide === 'home' ? a.info.color : b.info.color;
        setUpsetBadgeState(canvas, { text: '🚨 Upset Watch would’ve been active here', visible: true, pulsing: false, color: historicalColor });
      } else if (isCurrentlyLive) {
        setUpsetBadgeState(canvas, { text: '🚨 UPSET WATCH', visible: true, pulsing: false });
      } else {
        setUpsetBadgeState(canvas, { text: '🚨 UPSET WATCH', visible: false, pulsing: false });
      }
    }
  });

  canvas.addEventListener('mouseleave', () => {
    lastHoverX = null;
    whatIfChartInstance.data.datasets[1].hidden = true;
    whatIfChartInstance.data.datasets[2].hidden = true;
    whatIfChartInstance.update('none');
    setEspnPctLabels(canvas, whatIfChartInstance._state.currentHomePct, { animate: false });
    if (showUpsetHistory) {
      const info = whatIfChartInstance._state.currentUpsetInfo;
      setUpsetBadgeState(canvas, { text: '🚨 UPSET WATCH', visible: !!info, pulsing: !!info });
    }
  });

  decorateSeasonalCard(card, currentSeasonalTheme, a.info, b.info);
  applySeasonalUpsetState(card, currentSeasonalTheme, !!upsetInfo);

  return card;
}

async function renderWhatIfView(byMatchup, teamInfo) {
  updateChampionshipStage(false, {}); // not relevant to this view, same as Power Picks
  // Every other view clears this once it actually has something to show
  // (see renderPowerPicksView, and the normal full-rebuild branch below) --
  // this one never did, so "Loading..." stuck on screen forever the whole
  // time anyone was looking at a What If pairing.
  statusEl.textContent = '';

  // Entering from a DIFFERENT view: tear down whatever that view left
  // behind (its own Chart.js instances in `charts`, its view-* class) --
  // mirrors the cleanup the normal full-rebuild branch in loadMatchups
  // does, since this view bypasses that branch entirely. Staying in this
  // view across a routine 30s refresh or a week switch skips all of this,
  // so the select boxes update in place instead of flashing.
  const enteringFresh = !matchupsEl.classList.contains('view-whatif');
  if (enteringFresh) {
    matchupsEl.classList.remove('view-timeline', 'view-postcard', 'view-needle', 'view-espn', 'view-power-picks', 'view-whatif');
    matchupsEl.classList.add('view-whatif');
    Object.values(charts).forEach(destroyEntry);
    for (const key of Object.keys(charts)) delete charts[key];
    matchupsEl.innerHTML = '';
  }

  // Flatten byMatchup (keyed by matchup_id -> both real teams' FULL weekly
  // time series) into a per-team lookup -- every team's own rows exist
  // somewhere in there already, this just re-indexes them by team_id
  // instead of matchup_id so any two can be paired up regardless of who
  // they actually played.
  const rowsByTeam = {};
  for (const rows of Object.values(byMatchup)) {
    for (const r of rows) (rowsByTeam[r.team_id] ??= []).push(r);
  }
  for (const id of Object.keys(rowsByTeam)) rowsByTeam[id].sort((x, y) => new Date(x.ts) - new Date(y.ts));

  const teamIds = Object.keys(rowsByTeam).filter((id) => teamInfo[id] && rowsByTeam[id].length);
  teamIds.sort((x, y) => (teamInfo[x].name || '').localeCompare(teamInfo[y].name || ''));

  if (teamIds.length < 2) {
    matchupsEl.innerHTML = '<div class="whatif-empty">Not enough teams with data yet this week.</div>';
    return;
  }

  // Keeps whatever was already picked, as long as both teams are still
  // around this week (switching weeks/leagues, or a bye, can invalidate a
  // previous pick) -- defaults to the first two teams otherwise so the
  // view never opens empty.
  if (!whatIfTeamAId || !teamIds.includes(whatIfTeamAId)) whatIfTeamAId = teamIds[0];
  if (!whatIfTeamBId || !teamIds.includes(whatIfTeamBId) || whatIfTeamBId === whatIfTeamAId) {
    whatIfTeamBId = teamIds.find((id) => id !== whatIfTeamAId) || teamIds[1];
  }

  if (!document.getElementById('whatIfShell')) {
    matchupsEl.innerHTML = buildWhatIfShell();
    const selA = document.getElementById('whatIfTeamASelect');
    const selB = document.getElementById('whatIfTeamBSelect');
    selA.addEventListener('change', () => {
      whatIfTeamAId = selA.value;
      if (whatIfTeamBId === whatIfTeamAId) whatIfTeamBId = teamIds.find((id) => id !== whatIfTeamAId);
      renderWhatIfView(byMatchup, teamInfo);
    });
    selB.addEventListener('change', () => {
      whatIfTeamBId = selB.value;
      if (whatIfTeamAId === whatIfTeamBId) whatIfTeamAId = teamIds.find((id) => id !== whatIfTeamBId);
      renderWhatIfView(byMatchup, teamInfo);
    });
  }

  const selA = document.getElementById('whatIfTeamASelect');
  const selB = document.getElementById('whatIfTeamBSelect');
  const optionsHtml = teamIds.map((id) => `<option value="${id}">${teamInfo[id].name}</option>`).join('');
  selA.innerHTML = optionsHtml;
  selB.innerHTML = optionsHtml;
  selA.value = whatIfTeamAId;
  selB.value = whatIfTeamBId;

  const a = { id: whatIfTeamAId, info: teamInfo[whatIfTeamAId] };
  const b = { id: whatIfTeamBId, info: teamInfo[whatIfTeamBId] };

  const { points, rawPoints, maxX } = computeHypotheticalPoints(rowsByTeam[a.id], rowsByTeam[b.id]);

  if (whatIfChartInstance) { whatIfChartInstance.destroy(); whatIfChartInstance = null; }
  const slot = document.getElementById('whatIfCardSlot');
  slot.innerHTML = '';
  if (!rawPoints.length) {
    slot.innerHTML = '<div class="whatif-empty">Not enough overlapping data yet to compare these two.</div>';
  } else {
    const latest = rawPoints[rawPoints.length - 1];
    const bothDone = !!(latest.aDone && latest.bDone);
    slot.appendChild(renderWhatIfEspnCard(rawPoints, points, maxX, a, b, bothDone));
  }
  renderWhatIfScoreLine(rawPoints, a, b);
}

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

  // The theme is looked up here (cached, and awaited again below) so the
  // recap's holiday names are right on the very first render of a week.
  const recapTheme = await determineSeasonalTheme(year, week);
  renderRecapBanner(byMatchup, teamInfo, recapTheme);

  {
    const ids = Object.keys(byMatchup);
    weekIsIdle = ids.length > 0 && ids.every((id) => {
      const rows = byMatchup[id];
      const h = latestRow(rows, true), a = latestRow(rows, false);
      return !!(h && a && h.all_starters_done && a.all_starters_done);
    });
  }

  // Computed here (rather than further down, where this used to live)
  // because updateLeaderBar, right below, needs it too now -- during
  // championship week the leader bar switches from "whoever has the most
  // points this week" to a win-probability split between the two
  // championship teams specifically. Tier 0 from computePlayoffTiers is
  // ALWAYS the championship matchup itself. No longer gated to full
  // rebuilds only (it used to be, back when only the ribbons/banner
  // needed it) -- the leader bar and the hero banner's live score both
  // need this fresh on every poll, and getPlayoffTiers is cheap on every
  // call after the first real fetch (its own season-rows cache, keyed by
  // league+year, is what was actually expensive, not the sort itself).
  const championshipWeekActive = debugChampionshipWeek || week === CHAMPIONSHIP_WEEK;
  let tierInfo = null;
  if (championshipWeekActive) {
    try {
      tierInfo = await getPlayoffTiers(leagueId, year, byMatchup);
    } catch {
      tierInfo = null; // best-effort -- falls back to natural matchup order below
    }
  }

  // Championship-game team identity -- drives the leader bar's win-prob
  // split, the hero banner's team flanks (logo/name either side of the
  // countdown) and live score, the --champ-color-a/-b custom properties
  // that recolor the starburst/beams/site-wide spotlights, and (further
  // below) the card order + ribbons.
  let championshipTeams = null;
  if (tierInfo && tierInfo.order[0]) {
    const champMatchupId = tierInfo.order[0];
    const champRows = byMatchup[champMatchupId];
    const homeRow = champRows && champRows.find((r) => r.is_home);
    const awayRow = champRows && champRows.find((r) => !r.is_home);
    if (homeRow && awayRow) {
      championshipTeams = {
        matchupId: champMatchupId,
        home: teamInfo[homeRow.team_id] || { name: 'Home', color: '#f4c430', emoji: '', logoUrl: '' },
        away: teamInfo[awayRow.team_id] || { name: 'Away', color: '#e0574a', emoji: '', logoUrl: '' },
      };
    }
  }

  updateLeaderBar(byMatchup, teamInfo, championshipWeekActive, championshipTeams);
  renderByeWeekNote(byMatchup, teamInfo);
  updateKickoffCountdown(byMatchup, year, week); // fire-and-forget -- doesn't block matchup rendering
  trackLeadChanges(leagueId, year, week, byMatchup, teamInfo);
  updateSky(year, week); // fire-and-forget, same as the countdown above

  // Only reseeds the full-page particle field when the theme actually
  // CHANGES (a league/week/league switch, or a debug toggle flipping) --
  // never on every routine 30s poll, which would otherwise teleport every
  // leaf/snowflake to a new random position and read as a stutter rather
  // than smooth continuous fall.
  const seasonalTheme = await determineSeasonalTheme(year, week);
  if (seasonalTheme !== currentSeasonalTheme) {
    currentSeasonalTheme = seasonalTheme;
    seedSeasonalParticles();
    // Lets pure-CSS full-page decor (the Halloween fog layer -- see
    // #seasonalFog in index.html) react to the theme without its own JS
    // driver, the same way the particle canvas reacts to this same
    // variable every frame. Harmless to set on every theme, even ones with
    // no CSS hooked up to it yet.
    if (window.__kickCine) window.__kickClearAfter = true; // the kickoff cinematic is mid-play: let it finish, clear the comet hold afterwards
    else { cometSuppressed = false; document.body.classList.remove('kick-zero'); }
    if (festCinePlaying && festCineFinish && !window.__kickCine) festCineFinish(); // week/league switched mid-cinematic
    if (window.__kickCine && festCinePlaying) {
      // The kickoff cinematic is already playing and will reveal the holiday look itself.
    } else if (festCineDue(currentSeasonalTheme, year, week, leagueId)) {
      // Hold the holiday look back; the meteor's impact reveals it.
      document.documentElement.classList.add('fest-pre');
      document.documentElement.removeAttribute('data-seasonal-theme');
      playFestCine(currentSeasonalTheme);
    } else {
      document.documentElement.classList.remove('fest-pre');
      document.documentElement.setAttribute('data-seasonal-theme', currentSeasonalTheme);
    }
  }
  renderFestBanner(currentSeasonalTheme, week);
  renderFestMeteor(currentSeasonalTheme);

  if (Object.keys(byMatchup).length === 0) {
    updateChampionshipStage(false, {});
    const viewToggleEl = document.getElementById('viewToggle');
    if (viewToggleEl) viewToggleEl.hidden = false;
    if (!preserveCharts) {
      matchupsEl.innerHTML = '';
      matchupsEl.classList.remove('view-power-picks');
      Object.values(charts).forEach(destroyEntry);
      for (const key of Object.keys(charts)) delete charts[key];
      statusEl.textContent = 'No data yet for this week -- the poller may not have run yet.';
    }
    return;
  }

  // Power Picks: real pairings exist (the poller writes them starting 24h
  // before kickoff -- see poll.js), but if that week's first game hasn't
  // actually kicked off yet, nothing here has a real score to plot. Takes
  // over the whole matchups area with pregame predictions instead of the
  // normal graph views, and reverts to them automatically the moment this
  // same check comes back false on a later poll (once games start).
  const powerPicksWeekStart = await fetchWeekStart(year, week);
  const reallyPregame = !!powerPicksWeekStart && Date.now() < powerPicksWeekStart.getTime();
  const isPowerPicksWeek = debugForcePowerPicks || reallyPregame;
  const viewToggleEl = document.getElementById('viewToggle');
  if (viewToggleEl) viewToggleEl.hidden = isPowerPicksWeek;
  if (isPowerPicksWeek) {
    updateChampionshipStage(false, {});
    // debugForcePowerPicks can force this view on over a week that's
    // ALREADY live -- purely a display swap (see the flag's own comment
    // above): the real poll behind the scenes, and everything it writes,
    // keeps going exactly as normal the whole time, so this never risks
    // losing or corrupting any live data. Only the label below changes to
    // make that clear while it's happening.
    await renderPowerPicksView(leagueId, year, week, byMatchup, teamInfo, { forcedPreview: debugForcePowerPicks && !reallyPregame });
    return;
  }

  // What If doesn't fit the per-matchup VIEW_RENDERERS model below (one
  // card per REAL matchup) -- it's a single interactive card for a
  // hypothetical pairing, same reason Power Picks above takes over the
  // whole area rather than going through that path.
  if (viewMode === 'whatif') {
    await renderWhatIfView(byMatchup, teamInfo);
    return;
  }

  // Only looked up once we know we're rendering one of the per-matchup
  // card views below -- VIEW_RENDERERS has no entry for 'whatif' (or for
  // Power Picks, handled above), so this has to come after both of those
  // early returns rather than at the top of the function.
  const { render, update } = VIEW_RENDERERS[viewMode];

  // tierInfo/championshipTeams are now computed up near the top of this
  // function (right after fetchMatchupData) -- see the comment there --
  // since the leader bar needed them too and that runs long before this
  // point. Just reused here for the hero banner.
  updateChampionshipStage(championshipWeekActive, byMatchup, championshipTeams);

  // Unlike tierInfo above, this recomputes on EVERY call (including a
  // routine 30s refresh), not just a full rebuild -- the whole point is
  // that it tracks each team's live expected_score as the week plays out,
  // same as the win-probability numbers it sits next to on the card.
  if (viewMode === 'needle') {
    // Never blocks the cards: the season data is cached after the first
    // fetch (instant afterwards). On a cold start the cards draw right away
    // and the Power Score rows fill in as soon as the data lands.
    const warm = !!powerPicksHistoryCache[`${leagueId}-${year}`]?.rows;
    const compute = computePowerProjection(leagueId, year, week, byMatchup, teamInfo);
    if (warm) {
      try { powerProjectionByTeam = await compute; }
      catch (err) { console.warn('Forecast: could not compute Power Score projection (non-fatal):', err.message); }
    } else {
      compute.then((res) => {
        powerProjectionByTeam = res;
        if (viewMode === 'needle' && Object.keys(charts).length) loadMatchups({ preserveCharts: true });
      }).catch((err) => console.warn('Forecast: could not compute Power Score projection (non-fatal):', err.message));
    }
  } else {
    powerProjectionByTeam = null;
  }

  if (!preserveCharts || Object.keys(charts).length === 0) {
    matchupsEl.innerHTML = '';
    // Only touch the view-mode class specifically -- a full className
    // overwrite here would also wipe out the .view-fading class that
    // setViewMode adds during a transition, breaking the fade-in half of
    // the cross-fade before it ever gets a chance to play.
    matchupsEl.classList.remove('view-timeline', 'view-postcard', 'view-needle', 'view-espn', 'view-power-picks', 'view-whatif');
    matchupsEl.classList.add(`view-${viewMode}`);
    Object.values(charts).forEach(destroyEntry);
    for (const key of Object.keys(charts)) delete charts[key];

    statusEl.textContent = '';

    // Championship-tier order when available (falls back to whatever
    // order byMatchup's keys already came in for every other week, or if
    // the tier query failed) -- filtered against byMatchup's own keys so
    // a stale cached order can never reference a matchup that isn't
    // actually part of this week.
    const matchupOrder = tierInfo
      ? tierInfo.order.filter((id) => byMatchup[id])
      : Object.keys(byMatchup);

    for (const matchupId of matchupOrder) {
      const rows = byMatchup[matchupId];
      const homeRow = rows.find((r) => r.is_home);
      const awayRow = rows.find((r) => !r.is_home);
      if (!homeRow || !awayRow) continue;

      const home = teamInfo[homeRow.team_id] || { name: 'Home', color: '#1a3fa0', emoji: '' , logoUrl: '' };
      const away = teamInfo[awayRow.team_id] || { name: 'Away', color: '#c0392b', emoji: '' , logoUrl: '' };
      const allDone = !!(latestRow(rows, true)?.all_starters_done && latestRow(rows, false)?.all_starters_done);

      const { card, entry } = render(rows, home, away, allDone);
      // Ribbon markup only exists on the ESPN and Needle templates
      // (applyTierRibbon no-ops safely if .tier-ribbon isn't present).
      if (tierInfo) applyTierRibbon(card, tierInfo.tierByMatchup[matchupId]);
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
  // Pauses while the tab is hidden (the visibilitychange handler below
  // refreshes the moment you come back), and slows to every 5 minutes when
  // every game on screen is already final -- nothing is changing then.
  let lastRefreshAt = Date.now();
  refreshTimer = setInterval(async () => {
    if (document.hidden) return;
    if (weekIsIdle && Date.now() - lastRefreshAt < IDLE_REFRESH_MS - 1000) return;
    lastRefreshAt = Date.now();
    const advanced = await checkForLatestWeekAdvance();
    if (!advanced) loadMatchups({ preserveCharts: true });
  }, 30000);
  // Returning to the tab: background timers are throttled, so refresh now
  // instead of waiting up to 30s -- any lead that changed while away then
  // fires its star (see trackLeadChanges).
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) { lastRefreshAt = Date.now(); loadMatchups({ preserveCharts: true }); }
  });
  setInterval(tickKickoffCountdown, 1000); // display-only tick, no network -- see updateKickoffCountdown for when the target itself gets (re)computed
}

init();
