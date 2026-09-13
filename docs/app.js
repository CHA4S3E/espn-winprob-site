const { url, anonKey } = window.SUPABASE_CONFIG;
const sb = window.supabase.createClient(url, anonKey);

const leagueSelect = document.getElementById('leagueSelect');
const yearSelect = document.getElementById('yearSelect');
const weekSelect = document.getElementById('weekSelect');
const statusEl = document.getElementById('status');
const matchupsEl = document.getElementById('matchups');

const charts = {}; // matchupId -> Chart instance
let refreshTimer = null;

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

// Insert an exact y=50 point at every crossing so the line pivots color
// precisely at the true crossing instead of jumping between sides.
// Skips any pair involving a null point (the gap-break markers from
// insertGapBreaks) -- JS coerces null to 0 in arithmetic, so without this
// guard the crossing math below would misfire around every gap and insert
// a bogus connecting point exactly where a break was supposed to be.
function withCrossings(points) {
  const out = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (i > 0) {
      const prev = points[i - 1];
      if (prev.y !== null && p.y !== null) {
        const crosses = (prev.y - 50) * (p.y - 50) < 0;
        if (crosses) {
          const t = (50 - prev.y) / (p.y - prev.y);
          out.push({ x: prev.x + t * (p.x - prev.x), y: 50 });
        }
      }
    }
    out.push(p);
  }
  return out;
}

function intensity(y) {
  return Math.min(Math.abs(y - 50) / 50, 1);
}

function dayLabel(ts) {
  return new Date(ts).toLocaleDateString(undefined, { weekday: 'short' });
}

function renderMatchupChart(canvas, snapshotsForMatchup, homeSettings, awaySettings) {
  const homeRows = snapshotsForMatchup.filter((s) => s.is_home).sort((a, b) => new Date(a.ts) - new Date(b.ts));
  if (!homeRows.length) return null;

  // x = point INDEX, not elapsed real time. This is the same technique
  // stock charts use to avoid showing a giant blank gap every weekend --
  // every real data point gets equal visual spacing regardless of how much
  // actual time passed before it, so a 3-day gap between Thursday's game
  // and Sunday's takes up the same tiny sliver of width as a normal 1-min
  // gap between live polls, instead of squeezing the two games' worth of
  // real movement into narrow slivers at opposite edges of the chart.
  const rawPoints = homeRows.map((r, i) => ({
    x: i,
    y: r.win_prob,
    ts: r.ts,
  }));
  const points = withCrossings(insertGapBreaks(rawPoints));

  const tickEvery = Math.max(Math.floor(rawPoints.length / 5), 1);
  const dayTicks = {};
  rawPoints.forEach((p, i) => { if (i % tickEvery === 0) dayTicks[p.x.toFixed(2)] = dayLabel(p.ts); });

  return new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: {
      datasets: [{
        data: points,
        parsing: false,
        borderWidth: 2,
        pointRadius: 0,
        tension: 0.15,
        fill: { target: { value: 50 } },
        segment: {
          borderColor: (c) => (midY(c) >= 50 ? homeSettings.color : awaySettings.color),
          backgroundColor: (c) => {
            const above = midY(c) >= 50;
            const rgb = above ? homeSettings.color : awaySettings.color;
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
              const team = above ? homeSettings.name : awaySettings.name;
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
          ticks: { callback: (v) => (v === 0 || v === 50 || v === 100 ? v : ''), color: '#555' },
        },
        x: {
          type: 'linear',
          grid: { color: 'rgba(0,0,0,0.06)' },
          ticks: {
            color: '#555',
            callback: (v) => dayTicks[Number(v).toFixed(2)] ?? '',
            autoSkip: false,
            maxRotation: 0,
          },
        },
      },
    },
  });
}
function midY(segCtx) { return (segCtx.p0.parsed.y + segCtx.p1.parsed.y) / 2; }

// Inserts a null-valued point in the middle of any unusually large time gap
// between two real data points. Chart.js draws no line through/around a
// null point, so this makes the chart show a genuine break (no line) during
// a stretch where nobody on the team was in an active game, rather than
// drawing one straight segment across the whole gap -- which would
// visually look like continuous flat activity that never happened. The
// line simply resumes once real data starts coming in again.
const GAP_THRESHOLD_MINUTES = 20;
function insertGapBreaks(rawPoints) {
  const out = [];
  for (let i = 0; i < rawPoints.length; i++) {
    if (i > 0) {
      const prev = rawPoints[i - 1];
      const cur = rawPoints[i];
      const gapMinutes = (new Date(cur.ts).getTime() - new Date(prev.ts).getTime()) / 60000;
      if (gapMinutes > GAP_THRESHOLD_MINUTES) {
        out.push({ x: (prev.x + cur.x) / 2, y: null });
      }
    }
    out.push(rawPoints[i]);
  }
  return out;
}

async function loadMatchups() {
  const leagueId = leagueSelect.value;
  const year = Number(yearSelect.value);
  const week = Number(weekSelect.value);
  if (!leagueId || !year || !week) return;

  statusEl.textContent = 'Loading...';
  matchupsEl.innerHTML = '';
  Object.values(charts).forEach((c) => c.destroy());

  let snaps, teams;
  try {
    [snaps, { data: teams }] = await Promise.all([
      fetchAllRows((from, to) =>
        sb.from('snapshots')
          .select('*')
          .eq('league_id', leagueId)
          .eq('year', year)
          .eq('week', week)
          .order('ts')
          .range(from, to)
      ),
      sb.from('teams').select('id, espn_team_name, team_settings(color, display_name)').eq('league_id', leagueId),
    ]);
  } catch (err) {
    statusEl.textContent = 'Error loading data: ' + err.message;
    return;
  }

  if (!snaps.length) {
    statusEl.textContent = 'No data yet for this week -- the poller may not have run yet.';
    return;
  }

  const teamInfo = {};
  for (const t of teams || []) {
    const settings = t.team_settings || {};
    teamInfo[t.id] = {
      name: settings.display_name || t.espn_team_name,
      color: settings.color || '#1a3fa0',
    };
  }

  const byMatchup = {};
  for (const s of snaps) {
    (byMatchup[s.matchup_id] ||= []).push(s);
  }

  statusEl.textContent = '';

  for (const [matchupId, rows] of Object.entries(byMatchup)) {
    const homeRow = rows.find((r) => r.is_home);
    const awayRow = rows.find((r) => !r.is_home);
    if (!homeRow || !awayRow) continue;

    const home = teamInfo[homeRow.team_id] || { name: 'Home', color: '#1a3fa0' };
    const away = teamInfo[awayRow.team_id] || { name: 'Away', color: '#c0392b' };
    const allDone = rows.every((r) => r.all_starters_done);

    const card = document.createElement('div');
    card.className = 'matchup-card';
    card.innerHTML = `
      <div class="matchup-title">
        <span><b style="color:${home.color}">${home.name}</b> vs <b style="color:${away.color}">${away.name}</b></span>
        <span class="${allDone ? '' : 'live'}">${allDone ? 'Final' : '\u25CF Live'}</span>
      </div>
      <div class="chartBox"><canvas></canvas></div>
    `;
    matchupsEl.appendChild(card);
    const canvas = card.querySelector('canvas');
    charts[matchupId] = renderMatchupChart(canvas, rows, home, away);
  }
}

async function init() {
  await loadLeagues();
  leagueSelect.onchange = async () => { await loadYearsWeeks(leagueSelect.value); await loadMatchups(); };
  weekSelect.onchange = loadMatchups;
  if (leagueSelect.value) {
    await loadYearsWeeks(leagueSelect.value);
    await loadMatchups();
  }

  // Auto-refresh every 30s -- cheap read-only query, fine even if the
  // underlying poller only writes every ~5 min.
  refreshTimer = setInterval(loadMatchups, 30000);
}

init();
