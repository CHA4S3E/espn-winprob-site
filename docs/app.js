const { url, anonKey } = window.SUPABASE_CONFIG;
const sb = window.supabase.createClient(url, anonKey);

const leagueSelect = document.getElementById('leagueSelect');
const yearSelect = document.getElementById('yearSelect');
const weekSelect = document.getElementById('weekSelect');
const statusEl = document.getElementById('status');
const matchupsEl = document.getElementById('matchups');
const viewButtons = document.querySelectorAll('.view-btn');

const charts = {}; // matchupId -> { mode, chart? , el?, needle? } depending on view
let refreshTimer = null;
let viewMode = localStorage.getItem('winProbViewMode') || 'timeline'; // 'timeline' | 'postcard' | 'needle'

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
    sb.from('teams').select('id, espn_team_name, team_settings(color, display_name)').eq('league_id', leagueId),
  ]);
  if (teamErr) throw teamErr;

  const teamInfo = {};
  for (const t of teams || []) {
    const settings = t.team_settings || {};
    teamInfo[t.id] = {
      name: settings.display_name || t.espn_team_name,
      color: settings.color || '#1a3fa0',
    };
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

// Pure computation, shared by both the initial render and in-place
// refreshes. x = point INDEX, not elapsed real time -- the same technique
// stock charts use to avoid showing a giant blank gap every weekend: every
// real data point gets equal visual spacing regardless of how much actual
// time passed before it.
function computeChartPoints(homeRows) {
  const rawPoints = homeRows.map((r, i) => ({ x: i, y: r.win_prob, ts: r.ts }));
  const points = withCrossings(rawPoints);

  const tickEvery = Math.max(Math.floor(rawPoints.length / 5), 1);
  const dayTicks = {};
  rawPoints.forEach((p, i) => { if (i % tickEvery === 0) dayTicks[p.x.toFixed(2)] = dayLabel(p.ts); });

  return { points, dayTicks };
}

function midY(segCtx) { return (segCtx.p0.parsed.y + segCtx.p1.parsed.y) / 2; }

function latestPct(rows) {
  const homeRow = rows.filter((r) => r.is_home).sort((a, b) => new Date(b.ts) - new Date(a.ts))[0];
  return homeRow ? homeRow.win_prob : 50;
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
  card.innerHTML = `
    <div class="${titleClass}">
      <span><b style="color:${home.color}">${home.name}</b> vs <b style="color:${away.color}">${away.name}</b></span>
      <span class="${allDone ? '' : 'live'}">${allDone ? 'Final' : '\u25CF Live'}</span>
    </div>
    <div class="${chartBoxClass}"><canvas></canvas></div>
  `;

  const homeRows = rows.filter((s) => s.is_home).sort((a, b) => new Date(a.ts) - new Date(b.ts));
  if (!homeRows.length) return { card, entry: null };

  const { points, dayTicks } = computeChartPoints(homeRows);
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
          },
        },
      },
      scales: {
        y: {
          min: 0, max: 100,
          grid: { color: (c) => (c.tick.value === 50 ? '#999' : 'rgba(0,0,0,0.06)'), lineWidth: (c) => (c.tick.value === 50 ? 1.5 : 1) },
          ticks: compact ? { display: false } : { callback: (v) => (v === 0 || v === 50 || v === 100 ? v : ''), color: '#555' },
        },
        x: {
          type: 'linear',
          grid: { display: !compact, color: 'rgba(0,0,0,0.06)' },
          ticks: compact ? { display: false } : {
            color: '#555',
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
  if (!homeRows.length || !entry.chart) return;

  const { points, dayTicks } = computeChartPoints(homeRows);
  entry.chart.data.datasets[0].data = points;
  entry.chart._state.dayTicks = dayTicks;
  entry.chart.update('none');

  const badge = entry.chart.canvas.closest('.matchup-card, .postcard')?.querySelector(`.${entry.titleClass} span:last-child`);
  if (badge) {
    badge.textContent = allDone ? 'Final' : '\u25CF Live';
    badge.className = allDone ? '' : 'live';
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
  return { text: 'Toss-up', color: '#666' };
}

function buildNeedleSvg(home, away) {
  // Bands are colored by side: bands with max <= 50 are "away" side
  // (shaded with away's color), bands with min >= 50 are "home" side.
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
      <path d="${d}" fill="${colorWithAlpha(rgb, alpha)}" stroke="#fff" stroke-width="1"></path>
      <text x="${labelPos.x.toFixed(2)}" y="${labelPos.y.toFixed(2)}" font-size="8" fill="#555" text-anchor="middle">${band.label}</text>
    `;
  }).join('');

  return `
    <svg viewBox="0 0 240 150" class="needle-svg">
      ${bandPaths}
      <line class="needle-pointer" x1="${NEEDLE_CX}" y1="${NEEDLE_CY}" x2="${NEEDLE_CX}" y2="${NEEDLE_CY - NEEDLE_R_OUTER + 4}"
            stroke="#333" stroke-width="3" stroke-linecap="round"
            style="transform-origin: ${NEEDLE_CX}px ${NEEDLE_CY}px;"></line>
      <circle cx="${NEEDLE_CX}" cy="${NEEDLE_CY}" r="6" fill="#333"></circle>
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

  const card = document.createElement('div');
  card.className = 'needle-card';
  card.innerHTML = `
    <div class="postcard-status ${allDone ? '' : 'live'}">${allDone ? 'Final' : '\u25CF Live'}</div>
    <div class="needle-gauge">${buildNeedleSvg(home, away)}</div>
    <div class="needle-verdict" style="color:${verdict.color}">${verdict.text}</div>
    <div class="needle-sub">${home.name} vs ${away.name}</div>
  `;

  const needle = card.querySelector('.needle-pointer');
  if (needle) needle.style.transform = `rotate(${needleRotationDeg(homePct)}deg)`;

  return { card, entry: { mode: 'needle', el: card } };
}

function updateNeedleCard(entry, rows, home, away, allDone) {
  const homePct = latestPct(rows);
  const verdict = needleVerdict(homePct, home, away);
  const card = entry.el;

  card.querySelector('.postcard-status').textContent = allDone ? 'Final' : '\u25CF Live';
  card.querySelector('.postcard-status').className = `postcard-status ${allDone ? '' : 'live'}`;
  const verdictEl = card.querySelector('.needle-verdict');
  verdictEl.textContent = verdict.text;
  verdictEl.style.color = verdict.color;
  const needle = card.querySelector('.needle-pointer');
  if (needle) needle.style.transform = `rotate(${needleRotationDeg(homePct)}deg)`;
}

// ============================== SHARED LOADING ==============================

const VIEW_RENDERERS = {
  timeline: { render: renderTimelineCard, update: updateTimelineCard },
  postcard: { render: renderPostcardCard, update: updatePostcardCard },
  needle: { render: renderNeedleCard, update: updateNeedleCard },
};

function destroyEntry(entry) {
  if (entry?.mode === 'timeline' && entry.chart) entry.chart.destroy();
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
    matchupsEl.className = `view-${viewMode}`;
    Object.values(charts).forEach(destroyEntry);
    for (const key of Object.keys(charts)) delete charts[key];

    statusEl.textContent = '';

    for (const [matchupId, rows] of Object.entries(byMatchup)) {
      const homeRow = rows.find((r) => r.is_home);
      const awayRow = rows.find((r) => !r.is_home);
      if (!homeRow || !awayRow) continue;

      const home = teamInfo[homeRow.team_id] || { name: 'Home', color: '#1a3fa0' };
      const away = teamInfo[awayRow.team_id] || { name: 'Away', color: '#c0392b' };
      const allDone = rows.every((r) => r.all_starters_done);

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

    const home = teamInfo[homeRow.team_id] || { name: 'Home', color: '#1a3fa0' };
    const away = teamInfo[awayRow.team_id] || { name: 'Away', color: '#c0392b' };
    const allDone = rows.every((r) => r.all_starters_done);
    update(entry, rows, home, away, allDone);
  }
}

function setViewMode(mode) {
  if (mode === viewMode) return;
  viewMode = mode;
  localStorage.setItem('winProbViewMode', mode);
  viewButtons.forEach((btn) => btn.classList.toggle('active', btn.dataset.view === mode));
  loadMatchups({ preserveCharts: false });
}

async function init() {
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
