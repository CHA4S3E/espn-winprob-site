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

  // Only ever need rows where a matchup actually went final -- this is a
  // small fraction of total polls (most polls during a live game have
  // all_starters_done=false), and filtering here avoids Supabase's
  // default 1000-row cap on unpaginated queries, which an unfiltered
  // query against a full season's worth of ~1-minute polling could
  // realistically exceed, silently truncating the result to an arbitrary
  // subset that might not include any final rows at all.
  const [{ data: teams, error: teamsError }, { data: snapshots, error: snapshotsError }] = await Promise.all([
    sb.from('teams').select('id, espn_team_name, team_settings(color, display_name, emoji)').eq('league_id', leagueId),
    sb.from('snapshots')
      .select('year, week, matchup_id, team_id, actual_score, all_starters_done, ts')
      .eq('league_id', leagueId)
      .eq('all_starters_done', true),
  ]);
  if (teamsError || snapshotsError) { showError('Could not load standings data', teamsError || snapshotsError); return; }
  console.log(`Loaded ${teams.length} teams and ${snapshots.length} final-matchup snapshot rows for this league.`);

  teamInfo = {};
  for (const t of teams) {
    const settings = t.team_settings || {};
    teamInfo[t.id] = {
      name: settings.display_name || t.espn_team_name,
      color: settings.color || '#888888',
      emoji: settings.emoji || '',
    };
  }
  allRows = snapshots;

  const weeks = [...new Set(allRows.map((r) => r.week))].sort((a, b) => a - b);
  weekSelect.innerHTML =
    `<option value="">Full season</option>` +
    weeks.map((w) => `<option value="${w}">Through week ${w}</option>`).join('');

  render();
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
        <div class="col-team"><span class="team-name">${s.team.emoji ? s.team.emoji + ' ' : ''}${s.team.name}</span></div>
        <div class="col-record">${s.wins}-${s.losses}${s.ties ? '-' + s.ties : ''}</div>
        <div class="col-pct">${s.winPct.toFixed(3).replace(/^0/, '')}</div>
        <div class="col-pf">${s.pointsFor.toFixed(1)}</div>
        <div class="col-pa">${s.pointsAgainst.toFixed(1)}</div>
        <div class="col-streak ${streakClass}">${s.streak || '—'}</div>
      </div>
    `;
  }).join('');

  standingsTable.innerHTML = header + rows;
}

leagueSelect.addEventListener('change', () => loadLeagueData(leagueSelect.value));
weekSelect.addEventListener('change', render);

loadLeagues();
