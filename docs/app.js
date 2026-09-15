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
        out.push({ x: prev.x + t * (p.x - prev.x), y: 50 });
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

// ============================== BIGGEST SWING BANNER ==============================
// Finds, across every matchup CURRENTLY LOADED (i.e. whichever league/week
// is selected -- switching leagues naturally shows that league's own
// swing, never a mix of both), whichever team gained the most win
// probability over the last SWING_WINDOW_MS. If a matchup has less history
// than the window, it gracefully compares against its earliest available
// point instead of hiding entirely.
const SWING_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const MIN_SWING_TO_SHOW = 8; // percentage points -- below this, hide the banner rather than show noise

function computeBiggestSwing(byMatchup, teamInfo) {
  let best = null;
  for (const rows of Object.values(byMatchup)) {
    const homeRow = rows.find((r) => r.is_home);
    const awayRow = rows.find((r) => !r.is_home);
    if (!homeRow || !awayRow) continue;

    // Skip matchups that have gone stale (same freshness check that gates
    // the "Live" badge -- see isRecentlyActive). Without this, a matchup
    // that finished last night keeps comparing its same two final points
    // forever, since nothing about its "latest" row ever changes once the
    // game is over -- surfacing last night's swing indefinitely instead of
    // disappearing once it's no longer actually happening.
    if (!isRecentlyActive(rows)) continue;

    const homeRows = rows.filter((r) => r.is_home).sort((a, b) => new Date(a.ts) - new Date(b.ts));
    if (homeRows.length < 2) continue;

    const latest = homeRows[homeRows.length - 1];
    const targetTs = new Date(new Date(latest.ts).getTime() - SWING_WINDOW_MS).toISOString();
    const past = nearestByTs(homeRows, targetTs);
    if (!past || past === latest) continue;

    const delta = latest.win_prob - past.win_prob; // positive = home gained ground
    if (!best || Math.abs(delta) > Math.abs(best.delta)) {
      const home = teamInfo[homeRow.team_id] || { name: 'Home' };
      const away = teamInfo[awayRow.team_id] || { name: 'Away' };
      best = { delta, gainer: delta > 0 ? home : away };
    }
  }
  return best;
}

function renderSwingBanner(byMatchup, teamInfo) {
  const banner = document.getElementById('swingBanner');
  if (!banner) return;
  const swing = computeBiggestSwing(byMatchup, teamInfo);
  if (!swing || Math.abs(swing.delta) < MIN_SWING_TO_SHOW) {
    banner.hidden = true;
    return;
  }
  const pts = Math.abs(swing.delta).toFixed(1);
  banner.textContent = `\ud83d\udd25 Biggest swing right now: ${swing.gainer.name} +${pts}% (last ~15 min)`;
  banner.hidden = false;
}

// ============================== WEEKLY RECAP ==============================
// Shows once every matchup in the current week is Final -- final scores,
// the week's single biggest swing (using the same 15-min-window logic as
// the live swing banner, just scanned across the whole week's history
// rather than only the latest point), and the closest game by final margin.

function biggestSwingInHistory(homeRows) {
  let best = null;
  for (const row of homeRows) {
    const targetTs = new Date(new Date(row.ts).getTime() - SWING_WINDOW_MS).toISOString();
    const past = nearestByTs(homeRows, targetTs);
    if (!past || past === row) continue;
    const delta = row.win_prob - past.win_prob;
    if (!best || Math.abs(delta) > Math.abs(best.delta)) best = { delta };
  }
  return best;
}

function computeWeeklyRecap(byMatchup, teamInfo) {
  const matchupIds = Object.keys(byMatchup);
  if (!matchupIds.length) return null;

  const summaries = [];
  let biggestSwing = null;
  let closestGame = null;

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
    const swing = biggestSwingInHistory(homeRows);
    if (swing && (!biggestSwing || Math.abs(swing.delta) > Math.abs(biggestSwing.delta))) {
      biggestSwing = { delta: swing.delta, gainer: swing.delta > 0 ? home : away };
    }
  }

  return { summaries, biggestSwing, closestGame };
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

  const swingLine = recap.biggestSwing
    ? `<div class="recap-highlight">\ud83d\udd25 Biggest swing: <b style="color:${recap.biggestSwing.gainer.color}">${recap.biggestSwing.gainer.name}</b> +${Math.abs(recap.biggestSwing.delta).toFixed(1)}% win probability in a single stretch</div>`
    : '';
  const closestLine = recap.closestGame
    ? recap.closestGame.isTie
      ? `<div class="recap-highlight">\ud83c\udfaf Closest game: <b>${recap.closestGame.home.name}</b> and ${recap.closestGame.away.name} tied exactly</div>`
      : `<div class="recap-highlight">\ud83c\udfaf Closest game: <b>${recap.closestGame.winner.name}</b> over ${recap.closestGame.loser.name} by ${recap.closestGame.margin.toFixed(1)}</div>`
    : '';

  banner.innerHTML = `
    <div class="recap-title">Week Recap</div>
    <div class="recap-scores">${scoreLines}</div>
    ${swingLine}
    ${closestLine}
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
  card.innerHTML = `
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

  const card = document.createElement('div');
  card.className = 'needle-card';
  card.innerHTML = `
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

function renderEspnCard(rows, home, away, allDone) {
  const homePct = latestPct(rows);
  const isLive = !allDone && isRecentlyActive(rows);
  const card = document.createElement('div');
  card.className = 'espn-card';
  card.innerHTML = `
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
  const state = { dayTicks, currentHomePct: homePct };
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
          data: [],
          hidden: true,
          parsing: false,
          borderWidth: 1.5,
          borderColor: themeVar('#222', '#ddd'),
          pointRadius: 0,
          fill: false,
          tension: 0,
          clip: false,
        },
        {
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

    if (nearest.x === lastHoverX) return;
    lastHoverX = nearest.x;

    chart.data.datasets[1].data = [{ x: nearest.x, y: 0 }, { x: nearest.x, y: 100 }];
    chart.data.datasets[1].hidden = false;
    chart.data.datasets[2].data = [nearest];
    chart.data.datasets[2].hidden = false;
    chart.update('none');
    setEspnPctLabels(canvas, nearest.y, { animate: false });
  });

  canvas.addEventListener('mouseleave', () => {
    lastHoverX = null;
    chart.data.datasets[1].hidden = true;
    chart.data.datasets[2].hidden = true;
    chart.update('none');
    setEspnPctLabels(canvas, chart._state.currentHomePct, { animate: false });
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

// Small placeholder cards with a shimmering gradient, shown in place of
// real cards while the initial fetch is in flight -- filling the actual
// card area (not just a small status line) so the page doesn't sit on a
// single line of "Loading..." text for what can be a couple of seconds on
// a slow connection.
function renderSkeletonCards() {
  matchupsEl.innerHTML = '';
  const count = 3;
  for (let i = 0; i < count; i++) {
    const el = document.createElement('div');
    el.className = 'skeleton-card';
    el.innerHTML = `
      <div class="skeleton-line skeleton-w-40"></div>
      <div class="skeleton-block"></div>
      <div class="skeleton-line skeleton-w-60"></div>
    `;
    matchupsEl.appendChild(el);
  }
}

function renderEmptyState(message) {
  matchupsEl.innerHTML = `
    <div class="empty-state">
      <div class="empty-state-icon">\ud83c\udfc8</div>
      <div class="empty-state-title">No data yet</div>
      <div class="empty-state-sub">${message}</div>
    </div>
  `;
}

async function loadMatchups({ preserveCharts = false } = {}) {
  const leagueId = leagueSelect.value;
  const year = Number(yearSelect.value);
  const week = Number(weekSelect.value);
  if (!leagueId || !year || !week) return;

  if (!preserveCharts) { statusEl.textContent = ''; renderSkeletonCards(); }

  let byMatchup, teamInfo;
  try {
    ({ byMatchup, teamInfo } = await fetchMatchupData(leagueId, year, week));
  } catch (err) {
    if (!preserveCharts) statusEl.textContent = 'Error loading data: ' + err.message;
    return;
  }

  renderSwingBanner(byMatchup, teamInfo);
  renderRecapBanner(byMatchup, teamInfo);

  const { render, update } = VIEW_RENDERERS[viewMode];

  if (Object.keys(byMatchup).length === 0) {
    if (!preserveCharts) {
      Object.values(charts).forEach(destroyEntry);
      for (const key of Object.keys(charts)) delete charts[key];
      statusEl.textContent = '';
      renderEmptyState('The poller may not have run yet for this week.');
    }
    return;
  }

  if (!preserveCharts || Object.keys(charts).length === 0) {
    matchupsEl.innerHTML = '';
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

  statusEl.textContent = '';
  for (const [matchupId, rows] of Object.entries(byMatchup)) {
    const homeRow = rows.find((r) => r.is_home);
    const awayRow = rows.find((r) => !r.is_home);
    if (!homeRow || !awayRow) continue;

    const entry = charts[matchupId];
    if (!entry || entry.mode !== viewMode) {
      return loadMatchups({ preserveCharts: false });
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

  const FADE_MS = 180;
  matchupsEl.classList.add('view-fading');
  setTimeout(async () => {
    viewMode = mode;
    localStorage.setItem('winProbViewMode', mode);
    await loadMatchups({ preserveCharts: false });
    void matchupsEl.offsetWidth;
    matchupsEl.classList.remove('view-fading');
  }, FADE_MS);
}

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

  refreshTimer = setInterval(() => loadMatchups({ preserveCharts: true }), 30000);
}
