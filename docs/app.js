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
let viewMode = localStorage.getItem('winProbViewMode') || 'espn'; // 'timeline' | 'postcard' | 'needle' | 'espn'
// Respects the OS's prefers-color-scheme on a first visit (no saved
// preference yet) -- once someone manually toggles via themeToggle, that
// explicit choice is saved and takes over from then on regardless of what
// the system setting does.
function systemPrefersDark() {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches;
}
let theme = localStorage.getItem('winProbTheme') || (systemPrefersDark() ? 'dark' : 'light'); // 'light' | 'dark'
let tooltipDetail = localStorage.getItem('winProbTooltipDetail') || 'condensed'; // 'condensed' | 'full' -- set on preferences.html
// Defaults on (only off if explicitly set to 'false') -- shows, on hover
// in ESPN view, whether Upset Watch was active at that historical point.
let showUpsetHistory = localStorage.getItem('winProbShowUpsetHistory') !== 'false'; // set on preferences.html
document.documentElement.setAttribute('data-theme', theme);

// ============================== THEME / COLOR ADJUSTMENT ==============================

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

function colorWithAlpha(hex, alpha) {
  const h = hex.replace('#', '');
  const bigint = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  const r = (bigint >> 16) & 255, g = (bigint >> 8) & 255, b = bigint & 255;
  return `rgba(${r},${g},${b},${alpha})`;
}

function intensity(y) {
  return Math.min(Math.abs(y - 50) / 50, 1);
}

function dayLabel(ts) {
  return new Date(ts).toLocaleDateString(undefined, { weekday: 'short' });
}

async function fetchMatchupData(leagueId, year, week) {
  const [snaps, { data: teams, error: teamErr }] = await Promise.all([
    fetchAllRows((from, to) =>
      sb.from('snapshots').select('*').eq('league_id', leagueId).eq('year', year).eq('week', week).order('ts').range(from, to)
    ),
    sb.from('teams').select('id, espn_team_name, team_settings(color, display_name, emoji)').eq('league_id', leagueId),
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
    };
  });

  // Deconflict across the WHOLE league's teams at once, not just within one
  // matchup -- Postcard/Needle views show every matchup on screen together,
  // so a collision can happen between teams in completely different games.
  const deconflicted = deconflictColors(rawEntries);

  const teamInfo = {};
  for (const e of rawEntries) {
    teamInfo[e.id] = { name: e.name, color: deconflicted[e.id], emoji: e.emoji };
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
const UPSET_ARM = 90;
const UPSET_TRIGGER_LOW = 65; // home side triggers below this
const UPSET_TRIGGER_HIGH = 100 - UPSET_TRIGGER_LOW; // away side triggers above this (35)
const UPSET_CLEAR = 70; // the upset side reaching this many % clears the watch

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
      if (armed === 'home' && !watch && hp < UPSET_TRIGGER_LOW) {
        watch = true; upsetSide = 'away';
        episodes.push({ ...currentEpisode, upsetSide: 'away' });
      } else if (armed === 'away' && !watch && hp > UPSET_TRIGGER_HIGH) {
        watch = true; upsetSide = 'home';
        episodes.push({ ...currentEpisode, upsetSide: 'home' });
      }
      // Clear uses ONE consistent threshold (UPSET_CLEAR, 70) regardless
      // of which side ends up crossing it -- hp >= 70 means home
      // reclaimed control, hp <= 30 (its mirror) means away did. Which of
      // those two it is matters for what happens to `armed`, though:
      //   - If the side that reclaims is the SAME side that was already
      //     armed, that team already proved it could reach 90+ earlier in
      //     this exact stretch -- surviving a scare and climbing back
      //     doesn't erase that, so it stays armed with its peak intact,
      //     only the scare itself (watch) clears. It does NOT need to
      //     re-earn arming by climbing all the way back to 90.
      //   - If the side that reclaims is the OTHER side (the one that was
      //     threatening), that's a genuine changeover -- a different team
      //     is now in charge, so the old arm status no longer applies and
      //     that team must earn its own by reaching 90/10 itself.
      if (watch) {
        const homeReclaimed = hp >= UPSET_CLEAR;
        const awayReclaimed = hp <= 100 - UPSET_CLEAR;
        if (homeReclaimed || awayReclaimed) {
          const reclaimingSide = homeReclaimed ? 'home' : 'away';
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

// ============================== WEEKLY RECAP ==============================
// Shows once every matchup in the current week is Final -- final scores,
// the closest game by final margin, and the biggest upset (see the Upset
// Watch section above).

function computeWeeklyRecap(byMatchup, teamInfo) {
  const matchupIds = Object.keys(byMatchup);
  if (!matchupIds.length) return null;

  const summaries = [];
  let closestGame = null;
  let biggestUpset = null;

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

    const home = teamInfo[homeRow.team_id] || { name: 'Home', color: '#888', emoji: '' };
    const away = teamInfo[awayRow.team_id] || { name: 'Away', color: '#888', emoji: '' };
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

    if (!closestGame || margin < closestGame.margin) {
      closestGame = { isTie, home, away, winner, loser, margin };
    }

    const homeRows = rows.filter((r) => r.is_home).sort((a, b) => new Date(a.ts) - new Date(b.ts));

    // Upset watch, scanned across this matchup's FULL history (not just
    // whatever's currently live) -- picks whichever triggered episode
    // reached the most extreme favorite peak, since that's the single
    // most dramatic "this looked all but over" moment of the game. Then
    // checked against the real final winner (already computed above) to
    // tell an actual completed upset apart from a threat the favorite
    // ultimately survived.
    const { episodes } = walkUpsetState(homeRows.map((r) => r.win_prob));
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

  return { summaries, closestGame, biggestUpset };
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

  const closestLine = recap.closestGame
    ? recap.closestGame.isTie
      ? `<div class="recap-highlight">\ud83c\udfaf Closest game: <b>${recap.closestGame.home.name}</b> and ${recap.closestGame.away.name} tied exactly</div>`
      : `<div class="recap-highlight">\ud83c\udfaf Closest game: <b>${recap.closestGame.winner.name}</b> over ${recap.closestGame.loser.name} by ${recap.closestGame.margin.toFixed(1)}</div>`
    : '';
  const upsetLine = recap.biggestUpset
    ? recap.biggestUpset.isTie
      ? `<div class="recap-highlight">\ud83e\udd1d Near-upset: <b>${recap.biggestUpset.upsetTeam.name}</b> pushed <b>${recap.biggestUpset.favorite.name}</b> (up to ${Math.round(recap.biggestUpset.favoritePeak)}% at their peak) all the way to a tie</div>`
      : recap.biggestUpset.upsetHappened
        ? `<div class="recap-highlight">\ud83d\udea8 <b>BIGGEST UPSET:</b> <b style="color:${recap.biggestUpset.upsetTeam.color}">${recap.biggestUpset.upsetTeam.name}</b> defeated ${recap.biggestUpset.favorite.name} after ${recap.biggestUpset.favorite.name} reached a ${Math.round(recap.biggestUpset.favoritePeak)}% win probability${recap.biggestUpset.backAndForth ? ', in a game that swung more than once' : ''}</div>`
        : `<div class="recap-highlight">\ud83d\udea8 Upset threat: <b>${recap.biggestUpset.upsetTeam.name}</b> pushed <b>${recap.biggestUpset.favorite.name}</b> (up to ${Math.round(recap.biggestUpset.favoritePeak)}% at their peak) to the brink, but ${recap.biggestUpset.favorite.name} held on</div>`
    : '';

  banner.innerHTML = `
    <div class="recap-title">Week Recap</div>
    <div class="recap-scores">${scoreLines}</div>
    ${closestLine}
    ${upsetLine}
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

  const tickEvery = Math.max(Math.floor(rawPoints.length / 5), 1);
  const dayTicks = {};
  rawPoints.forEach((p, i) => { if (i % tickEvery === 0) dayTicks[p.x.toFixed(2)] = dayLabel(p.ts); });

  // The real data's x-range -- used to pin the x-axis min/max explicitly
  // (see renderLineChartCard) instead of letting Chart.js auto-calculate a
  // "nice" rounded range, which can leave a visible gap after the last real
  // point on a matchup with fewer polls than others, making charts with
  // different amounts of history look inconsistently sized next to each
  // other even though they're all meant to fill the same width edge-to-edge.
  const maxX = rawPoints.length ? rawPoints[rawPoints.length - 1].x : 0;

  return { points, dayTicks, maxX };
}

function midY(segCtx) { return (segCtx.p0.parsed.y + segCtx.p1.parsed.y) / 2; }

function latestPct(rows) {
  const homeRow = rows.filter((r) => r.is_home).sort((a, b) => new Date(b.ts) - new Date(a.ts))[0];
  return homeRow ? homeRow.win_prob : 50;
}

function latestRow(rows, isHome) {
  return rows.filter((r) => r.is_home === isHome).sort((a, b) => new Date(b.ts) - new Date(a.ts))[0];
}

// Plain-language "why is this the number" sentence, built entirely from
// aggregate data already on the page (each team's current actual/expected
// score and win_prob) -- no per-player roster data is fetched by the
// frontend, so this deliberately stays at the team level rather than trying
// to name specific players.
function explainMatchup(rows, home, away, allDone) {
  const homeRow = latestRow(rows, true);
  const awayRow = latestRow(rows, false);
  if (!homeRow || !awayRow) return 'Not enough data yet to explain this matchup.';

  if (allDone) {
    if (homeRow.actual_score === awayRow.actual_score) return 'Final: this one ended in an exact tie.';
    const homeWon = homeRow.actual_score > awayRow.actual_score;
    const winner = homeWon ? home : away, loser = homeWon ? away : home;
    const margin = Math.abs(homeRow.actual_score - awayRow.actual_score).toFixed(1);
    return `Final: ${winner.name} beat ${loser.name} by ${margin} points.`;
  }

  const homePct = homeRow.win_prob;
  const homeFavored = homePct >= 50;
  const favored = homeFavored ? home : away;
  const underdog = homeFavored ? away : home;
  const favoredPct = Math.round(homeFavored ? homePct : 100 - homePct);

  if (favoredPct < 55) {
    return `Toss-up right now -- ${home.name} and ${away.name} are projected within a few points of each other.`;
  }

  const actualMargin = Math.abs(homeRow.actual_score - awayRow.actual_score);
  const favoredRow = homeFavored ? homeRow : awayRow;
  const underdogRow = homeFavored ? awayRow : homeRow;
  const favoredIsAhead = favoredRow.actual_score >= underdogRow.actual_score;
  const favoredRemaining = Math.max(favoredRow.expected_score - favoredRow.actual_score, 0);
  const underdogRemaining = Math.max(underdogRow.expected_score - underdogRow.actual_score, 0);
  const favoredMoreLockedIn = favoredRemaining <= underdogRemaining;

  if (actualMargin < 0.5) {
    return `${home.name} and ${away.name} are even on the scoreboard right now, but ${favored.name} is favored with ${favoredMoreLockedIn ? 'fewer points left on the table' : 'a stronger projection the rest of the way'}.`;
  }
  if (favoredIsAhead && favoredMoreLockedIn) {
    return `${favored.name} leads by ${actualMargin.toFixed(1)} and has more points already locked in, leaving ${underdog.name} less room to catch up.`;
  }
  if (favoredIsAhead && !favoredMoreLockedIn) {
    return `${favored.name} leads by ${actualMargin.toFixed(1)} right now, and still has more projected points left to add too.`;
  }
  if (!favoredIsAhead && favoredMoreLockedIn) {
    return `${underdog.name} leads by ${actualMargin.toFixed(1)} right now, but ${favored.name} has fewer points left on the table and is favored to finish ahead.`;
  }
  return `${underdog.name} leads by ${actualMargin.toFixed(1)} right now, but ${favored.name} is favored with more projected points still to come.`;
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

  const { points, dayTicks, maxX } = computeChartPoints(homeRows, awayRows);
  const state = { dayTicks };
  const canvas = card.querySelector('canvas');

  const chart = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: {
      datasets: [{
        data: points,
        parsing: false,
        borderWidth: compact ? 1.5 : 2,
        pointRadius: 0,
        tension: 0.15,
        fill: { target: { value: 50 } },
        segment: {
          borderColor: (c) => (midY(c) >= 50 ? home.color : away.color),
          backgroundColor: (c) => {
            const above = midY(c) >= 50;
            const rgb = above ? home.color : away.color;
            const alpha = 0.04 + intensity(midY(c)) * 0.32;
            return colorWithAlpha(rgb, alpha);
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
          callbacks: {
            label: (item) => {
              const above = item.parsed.y >= 50;
              const team = above ? home.name : away.name;
              const pct = above ? item.parsed.y : 100 - item.parsed.y;
              return `${team}: ${Math.round(pct)}%`;
            },
            // Underlying model numbers at this point, for the curious --
            // rounded to 1 decimal since the raw stored values are long
            // floats (e.g. 148.73891118999998) that would make for an
            // unreadably long tooltip line otherwise. Only shown when the
            // "Full" tooltip detail preference is set (see preferences.html);
            // condensed (win % only) is the default. Synthetic 50%-crossing
            // points (see withCrossings) don't correspond to a real snapshot,
            // so they have no underlying scores -- skip the extra lines then.
            afterLabel: (item) => {
              if (tooltipDetail !== 'full') return undefined;
              const p = item.raw;
              if (p.homeActual === undefined || p.awayActual === undefined) return undefined;
              return [
                `${home.name}: ${p.homeActual.toFixed(1)} actual / ${p.homeExpected.toFixed(1)} proj`,
                `${away.name}: ${p.awayActual.toFixed(1)} actual / ${p.awayExpected.toFixed(1)} proj`,
              ];
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
          ticks: compact ? { display: false } : {
            color: themeVar('#555', '#aaa'),
            callback: (v) => state.dayTicks[Number(v).toFixed(2)] ?? '',
            autoSkip: false,
            maxRotation: 0,
          },
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

  const { points, dayTicks, maxX } = computeChartPoints(homeRows, awayRows);
  entry.chart.data.datasets[0].data = points;
  entry.chart._state.dayTicks = dayTicks;
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

  const card = document.createElement('div');
  card.className = 'needle-card' + (upsetInfo ? ' upset-watch' : '');
  if (upsetInfo) applyUpsetColor(card, upsetInfo.upsetTeam.color);
  card.innerHTML = `
    <div class="upset-watch-badge${upsetInfo ? ' visible pulsing' : ''}">\ud83d\udea8 UPSET WATCH</div>
    <div class="postcard-status ${isLive ? 'live' : ''}">${allDone ? 'Final' : '\u25CF Live'}</div>
    <div class="needle-gauge">${buildNeedleSvg(home, away)}</div>
    <div class="needle-verdict" style="color:${verdict.color}">${verdict.text}</div>
    <div class="needle-sub">${home.name} vs ${away.name}
      <button class="why-btn" type="button" title="Why is this the number?">\u24d8</button>
    </div>
    <div class="why-blurb" hidden>${explainMatchup(rows, home, away, allDone)}</div>
  `;
  wireWhyButton(card);

  const needle = card.querySelector('.needle-pointer');
  if (needle) needle.style.transform = `rotate(${needleRotationDeg(homePct)}deg)`;

  return { card, entry: { mode: 'needle', el: card } };
}

function updateNeedleCard(entry, rows, home, away, allDone) {
  const homePct = latestPct(rows);
  const verdict = needleVerdict(homePct, home, away);
  const card = entry.el;

  card.querySelector('.postcard-status').textContent = allDone ? 'Final' : '\u25CF Live';
  card.querySelector('.postcard-status').className = `postcard-status ${(!allDone && isRecentlyActive(rows)) ? 'live' : ''}`;
  const verdictEl = card.querySelector('.needle-verdict');
  verdictEl.textContent = verdict.text;
  verdictEl.style.color = verdict.color;
  const needle = card.querySelector('.needle-pointer');
  if (needle) needle.style.transform = `rotate(${needleRotationDeg(homePct)}deg)`;

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
      <span class="espn-emoji">${home.emoji || ''}</span>
      <span class="espn-name" style="color:${home.color}">${home.name}</span>
      <span class="espn-dash" style="background:${home.color}"></span>
      <span class="espn-pct" style="color:${home.color}">${Math.round(homePct)}%</span>
    </div>
    <div class="espn-chartBox"><canvas></canvas></div>
    <div class="espn-row espn-row-bottom">
      <span class="espn-emoji">${away.emoji || ''}</span>
      <span class="espn-name" style="color:${away.color}">${away.name}</span>
      <span class="espn-dash" style="background:${away.color}"></span>
      <span class="espn-pct" style="color:${away.color}">${Math.round(100 - homePct)}%</span>
    </div>
  `;
  wireWhyButton(card);

  const homeRows = rows.filter((s) => s.is_home).sort((a, b) => new Date(a.ts) - new Date(b.ts));
  const awayRows = rows.filter((s) => !s.is_home).sort((a, b) => new Date(a.ts) - new Date(b.ts));
  if (!homeRows.length) return { card, entry: null };

  const { points, dayTicks, maxX } = computeChartPoints(homeRows, awayRows);
  // currentHomePct is kept in sync on every refresh (see updateEspnCard) so
  // that moving the mouse away always snaps back to the real live value,
  // never a stale one captured back when this chart was first created.
  // upsetHistory and currentUpsetInfo are similarly kept fresh so a
  // hover always reflects the latest data, not whatever existed when this
  // card was first created.
  const state = {
    dayTicks,
    currentHomePct: homePct,
    upsetHistory: getUpsetWatchHistory(rows),
    currentUpsetInfo: upsetInfo,
  };
  const canvas = card.querySelector('canvas');

  const chart = new Chart(canvas.getContext('2d'), {
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
            borderColor: (c) => (midY(c) >= 50 ? home.color : away.color),
            backgroundColor: (c) => {
              const above = midY(c) >= 50;
              const rgb = above ? home.color : away.color;
              const alpha = 0.04 + intensity(midY(c)) * 0.32;
              return colorWithAlpha(rgb, alpha);
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
          ticks: { callback: (v) => (v === 0 || v === 50 || v === 100 ? v : ''), color: themeVar('#555', '#aaa') },
        },
        x: {
          type: 'linear',
          min: 0,
          max: maxX,
          grid: { color: themeVar('rgba(0,0,0,0.06)', 'rgba(255,255,255,0.08)') },
          ticks: {
            color: themeVar('#555', '#aaa'),
            callback: (v) => state.dayTicks[Number(v).toFixed(2)] ?? '',
            autoSkip: false,
            maxRotation: 0,
          },
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
    const currentPoints = chart.data.datasets[0].data;
    if (!currentPoints.length) return;

    let nearest = currentPoints[0];
    let minDist = Infinity;
    for (const p of currentPoints) {
      const d = Math.abs(p.x - xValue);
      if (d < minDist) { minDist = d; nearest = p; }
    }

    if (nearest.x === lastHoverX) return; // same point as last event -- nothing to redraw
    lastHoverX = nearest.x;

    chart.data.datasets[1].data = [{ x: nearest.x, y: 0 }, { x: nearest.x, y: 100 }];
    chart.data.datasets[1].hidden = false;
    chart.data.datasets[2].data = [nearest];
    chart.data.datasets[2].hidden = false;
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
    chart.data.datasets[1].hidden = true;
    chart.data.datasets[2].hidden = true;
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
  const { points, dayTicks, maxX } = computeChartPoints(homeRows, awayRows);
  chart.data.datasets[0].data = points;
  chart._state.dayTicks = dayTicks;
  chart._state.currentHomePct = latestPct(rows);
  chart.options.scales.x.max = maxX;
  chart.update('none');

  // Only refresh the visible labels if the marker isn't currently being
  // shown via hover -- otherwise a background refresh would yank the
  // numbers out from under someone mid-hover.
  const isHovering = chart.data.datasets[1].hidden === false;
  if (!isHovering) {
    setEspnPctLabels(chart.canvas, chart._state.currentHomePct);
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

      const home = teamInfo[homeRow.team_id] || { name: 'Home', color: '#1a3fa0', emoji: '' };
      const away = teamInfo[awayRow.team_id] || { name: 'Away', color: '#c0392b', emoji: '' };
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

    const home = teamInfo[homeRow.team_id] || { name: 'Home', color: '#1a3fa0', emoji: '' };
    const away = teamInfo[awayRow.team_id] || { name: 'Away', color: '#c0392b', emoji: '' };
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
    btn.classList.toggle('active', btn.dataset.view === viewMode);
    btn.addEventListener('click', () => setViewMode(btn.dataset.view));
  });

  await loadLeagues();
  leagueSelect.onchange = async () => { await loadYearsWeeks(leagueSelect.value); await loadMatchups(); };
  weekSelect.onchange = loadMatchups;
  if (leagueSelect.value) {
    await loadYearsWeeks(leagueSelect.value);
    await loadMatchups();
  }

  // Auto-refresh every 30s -- cheap read-only query, fine even if the
  // underlying poller only writes every ~5 min. Updates existing cards in
  // place instead of rebuilding the DOM, so this can't disturb scroll
  // position.
  refreshTimer = setInterval(() => loadMatchups({ preserveCharts: true }), 30000);
}

init();
