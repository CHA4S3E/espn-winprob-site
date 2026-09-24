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

// Logo if uploaded, else the older emoji field, else nothing -- same
// fallback order as the main matchup page and standings.
function renderTeamIcon(team) {
  if (!team) return '';
  if (team.logoUrl) return `<img class="team-icon-img" src="${team.logoUrl}" alt="">`;
  if (team.emoji) return team.emoji;
  return '';
}
function teamNameHtml(team) {
  if (!team) return 'Unknown';
  return `${renderTeamIcon(team)}<span style="color:${team.color}">${team.name}</span>`;
}

const leagueSelect = document.getElementById('leagueSelect');
const yearSelect = document.getElementById('yearSelect');
const loadingState = document.getElementById('loadingState');
const emptyState = document.getElementById('emptyState');
const content = document.getElementById('content');

async function loadLeagues() {
  const { data, error } = await sb.from('leagues').select('id, name').order('name');
  if (error) { showEmpty('Could not load leagues -- check the console.'); console.error(error); return; }
  if (!data.length) { showEmpty('No leagues found.'); return; }
  leagueSelect.innerHTML = data.map((l) => `<option value="${l.id}">${l.name}</option>`).join('');
  leagueSelect.onchange = () => loadYearsForLeague(leagueSelect.value);
  await loadYearsForLeague(data[0].id);
}

async function loadYearsForLeague(leagueId) {
  const { data, error } = await sb.from('snapshots').select('year').eq('league_id', leagueId);
  if (error) { showEmpty('Could not load season data -- check the console.'); console.error(error); return; }
  const years = [...new Set((data || []).map((r) => r.year))].sort((a, b) => b - a);
  if (!years.length) { showEmpty('No completed seasons yet for this league.'); return; }
  yearSelect.innerHTML = years.map((y) => `<option value="${y}">${y}</option>`).join('');
  yearSelect.onchange = () => loadYear(leagueId, Number(yearSelect.value));
  await loadYear(leagueId, years[0]);
}

function showEmpty(message) {
  loadingState.style.display = 'none';
  content.style.display = 'none';
  emptyState.style.display = 'block';
  emptyState.textContent = message;
}

async function loadYear(leagueId, year) {
  loadingState.style.display = 'block';
  content.style.display = 'none';
  emptyState.style.display = 'none';

  const [{ data: teams, error: teamsError }, allSnapshotRows, { data: seasonResults }, { data: league }] = await Promise.all([
    sb.from('teams').select('id, espn_team_name, team_settings(color, display_name, emoji, logo_url)').eq('league_id', leagueId),
    fetchAllRows((from, to) =>
      sb.from('snapshots')
        .select('year, week, matchup_id, team_id, is_home, actual_score, expected_score, win_prob, all_starters_done, ts')
        .eq('league_id', leagueId).eq('year', year).order('ts').range(from, to)
    ),
    sb.from('season_results').select('place, team_id').eq('league_id', leagueId).eq('year', year),
    sb.from('leagues').select('playoff_spots').eq('id', leagueId).single(),
  ]);
  if (teamsError) { showEmpty('Could not load team info -- check the console.'); console.error(teamsError); return; }

  const teamInfo = {};
  for (const t of teams) {
    const settings = t.team_settings || {};
    teamInfo[t.id] = {
      name: settings.display_name || t.espn_team_name,
      color: settings.color || '#888888',
      emoji: settings.emoji || '',
      logoUrl: settings.logo_url || '',
    };
  }

  if (!allSnapshotRows.length) { showEmpty(`No data yet for ${year} -- check back once games have been played.`); return; }

  const finalRows = buildFinalRows(allSnapshotRows);
  const matchupTimeSeries = buildMatchupTimeSeries(allSnapshotRows);
  const standings = computeStandings(finalRows, teamInfo);

  if (!standings.length) { showEmpty(`No completed matchups yet for ${year}.`); return; }

  const maxWeek = Math.max(...allSnapshotRows.map((r) => r.week));

  renderEverything({
    year, teamInfo, standings, finalRows, matchupTimeSeries, maxWeek,
    podiumResults: seasonResults || [], playoffSpots: league ? league.playoff_spots : null,
  });

  loadingState.style.display = 'none';
  content.style.display = 'block';
}

function initials(name) { return name.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase(); }

function renderLogoBanner(teamInfo) {
  const teams = Object.values(teamInfo);
  if (!teams.length) return;
  const chipHtml = (t) => t.logoUrl
    ? `<div class="logo-chip" style="background:${t.color}"><img src="${t.logoUrl}" alt=""></div>`
    : `<div class="logo-chip" style="background:${t.color}">${initials(t.name)}</div>`;
  // Split teams across 3 rows round-robin, duplicated within each row so
  // the CSS loop (translateX 0 to -50%) has no visible seam.
  const rows = [[], [], []];
  teams.forEach((t, i) => rows[i % 3].push(t));
  rows.forEach((rowTeams, i) => {
    const el = document.getElementById(`logoRow${i + 1}`);
    if (!rowTeams.length) { el.innerHTML = ''; return; }
    const html = rowTeams.map(chipHtml).join('');
    el.innerHTML = html + html;
  });
}

function renderPodium(standings, teamInfo, podiumResults) {
  const placeClass = { 1: 'gold', 2: 'silver', 3: 'bronze' };
  const placeTrophy = { 1: '🥇', 2: '🥈', 3: '🥉' };
  const byPlace = {};
  for (const r of podiumResults) byPlace[r.place] = r.team_id;

  document.getElementById('podium').innerHTML = [2, 1, 3].map((place) => {
    const teamId = byPlace[place];
    const team = teamId ? teamInfo[teamId] : null;
    const standingsEntry = teamId ? standings.find((s) => s.teamId === teamId) : null;
    const record = standingsEntry ? `${standingsEntry.wins}-${standingsEntry.losses}${standingsEntry.ties ? '-' + standingsEntry.ties : ''}` : '';
    return `
      <div class="podium-slot ${placeClass[place]}">
        <div class="podium-team-name">${team ? teamNameHtml(team) : '<span class="podium-unset">?</span>'}</div>
        <div class="podium-record">${record}</div>
        <div class="podium-block"><span class="podium-trophy">${team ? placeTrophy[place] : '?'}</span></div>
      </div>
    `;
  }).join('');
}

function renderPeoplesChampion(champion, teamInfo, standings) {
  const el = document.getElementById('peoplesChampionAward');
  if (!champion) { el.innerHTML = ''; return; }
  const team = teamInfo[champion.teamId];
  el.innerHTML = `
    <div class="award-card" style="--accent-color:#e0b23d">
      <div class="award-label">👑 The People's Champion</div>
      <div class="award-headline">${teamNameHtml(team)}</div>
      <div class="award-detail">Scored more total points than anyone in the league this season (${champion.totalPoints.toFixed(1)}) -- but finished ${ordinal(champion.actualRank)}, not 1st. Standings are win-loss, not points. This is who actually had the best team.</div>
    </div>
  `;
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function drawRaceChart(raceData, teamInfo, maxWeek) {
  const svg = document.getElementById('raceSvg');
  const teamIds = Object.keys(raceData);
  if (!teamIds.length) { svg.innerHTML = ''; document.getElementById('raceLegend').innerHTML = ''; return; }
  const numTeams = teamIds.length;
  const W = 800, H = 280, padL = 24, padR = 10, padT = 10, padB = 24;
  const x = (week) => padL + ((week - 1) / Math.max(1, maxWeek - 1)) * (W - padL - padR);
  const y = (rank) => padT + ((rank - 1) / Math.max(1, numTeams - 1)) * (H - padT - padB);

  let svgHtml = '';
  for (let r = 1; r <= numTeams; r++) {
    svgHtml += `<line x1="${padL}" y1="${y(r)}" x2="${W - padR}" y2="${y(r)}" stroke="rgba(255,255,255,0.06)" stroke-width="1"/>`;
    svgHtml += `<text x="4" y="${y(r) + 4}" font-size="10" fill="#8a8f98">${r}</text>`;
  }
  for (const teamId of teamIds) {
    const team = teamInfo[teamId];
    if (!team || !raceData[teamId].length) continue;
    const points = raceData[teamId].map((p) => `${x(p.week).toFixed(1)},${y(p.rank).toFixed(1)}`).join(' ');
    svgHtml += `<polyline points="${points}" fill="none" stroke="${team.color}" stroke-width="2.5" opacity="0.9"/>`;
  }
  svg.innerHTML = svgHtml;

  document.getElementById('raceLegend').innerHTML = teamIds.filter((id) => teamInfo[id]).map((id) => {
    const t = teamInfo[id];
    return `<div class="race-legend-item"><span class="race-legend-swatch" style="background:${t.color}"></span>${renderTeamIcon(t)}${t.name}</div>`;
  }).join('');
}

// Crops the win_prob graph to the window where the upset actually
// happened -- a few polls before the peak through a few polls after the
// trigger -- rather than the whole game, so the moment is legible
// without needing to read a multi-hour axis.
function buildUpsetCropChart(homeWinProbs, episode) {
  const favoritePcts = homeWinProbs.map((v) => (episode.favoriteSide === 'home' ? v : 100 - v));
  const peakIdx = favoritePcts.indexOf(episode.peakFavoritePct);
  const triggerFloor = episode.peakFavoritePct - 25;
  let triggerIdx = favoritePcts.findIndex((v, i) => i > peakIdx && v < triggerFloor);
  if (triggerIdx === -1) triggerIdx = favoritePcts.length - 1;

  const startIdx = Math.max(0, peakIdx - 2);
  const endIdx = Math.min(homeWinProbs.length - 1, triggerIdx + 3);
  const croppedHome = homeWinProbs.slice(startIdx, endIdx + 1);
  const localPeakIdx = peakIdx - startIdx;
  const localTriggerIdx = triggerIdx - startIdx;

  const W = 500, H = 120, padL = 28, padR = 10, padT = 14, padB = 20;
  const xPos = (i) => padL + (croppedHome.length > 1 ? (i / (croppedHome.length - 1)) * (W - padL - padR) : (W - padL - padR) / 2);
  const yPos = (v) => padT + ((100 - v) / 100) * (H - padT - padB);

  const favoriteColor = episode.favoriteSide === 'home' ? episode.homeColor : episode.awayColor;
  const upsetColor = episode.upsetSide === 'home' ? episode.homeColor : episode.awayColor;

  const path = croppedHome.map((v, i) => `${xPos(i).toFixed(1)},${yPos(v).toFixed(1)}`).join(' ');
  let html = `
    <line x1="${padL}" y1="${yPos(50)}" x2="${W - padR}" y2="${yPos(50)}" stroke="rgba(255,255,255,0.15)" stroke-width="1" stroke-dasharray="3,3"/>
    <polyline points="${path}" fill="none" stroke="${favoriteColor}" stroke-width="2.5"/>
  `;
  if (localPeakIdx >= 0 && localPeakIdx < croppedHome.length) {
    html += `
      <circle cx="${xPos(localPeakIdx)}" cy="${yPos(croppedHome[localPeakIdx])}" r="4" fill="${favoriteColor}"/>
      <text x="${xPos(localPeakIdx)}" y="${yPos(croppedHome[localPeakIdx]) - 10}" font-size="10" fill="${favoriteColor}" text-anchor="middle">Peak ${episode.peakFavoritePct.toFixed(0)}%</text>
    `;
  }
  if (localTriggerIdx >= 0 && localTriggerIdx < croppedHome.length && localTriggerIdx !== localPeakIdx) {
    const triggerFavoritePct = episode.favoriteSide === 'home' ? croppedHome[localTriggerIdx] : 100 - croppedHome[localTriggerIdx];
    html += `
      <circle cx="${xPos(localTriggerIdx)}" cy="${yPos(croppedHome[localTriggerIdx])}" r="4" fill="#ff8a3d"/>
      <text x="${xPos(localTriggerIdx)}" y="${yPos(croppedHome[localTriggerIdx]) + 16}" font-size="10" fill="#ff8a3d" text-anchor="middle">Triggered ${triggerFavoritePct.toFixed(0)}%</text>
    `;
  }
  const finalIdx = croppedHome.length - 1;
  html += `<circle cx="${xPos(finalIdx)}" cy="${yPos(croppedHome[finalIdx])}" r="4" fill="${upsetColor}"/>`;
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:120px;overflow:visible">${html}</svg>`;
}

// ============================================================
// computeStandings -- reused verbatim from standings.js
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
    recA.resultsByWeek.push({ week: a.week, result: resultA, opponentId: b.team_id, ownScore: a.actual_score, oppScore: b.actual_score });
    recB.resultsByWeek.push({ week: b.week, result: resultB, opponentId: a.team_id, ownScore: b.actual_score, oppScore: a.actual_score });
  }
  const standings = [];
  for (const [teamId, rec] of records) {
    const gamesPlayed = rec.wins + rec.losses + rec.ties;
    const winPct = gamesPlayed ? (rec.wins + rec.ties * 0.5) / gamesPlayed : 0;
    rec.resultsByWeek.sort((x, y) => x.week - y.week);
    standings.push({ teamId, wins: rec.wins, losses: rec.losses, ties: rec.ties, winPct, pointsFor: rec.pointsFor, pointsAgainst: rec.pointsAgainst, resultsByWeek: rec.resultsByWeek });
  }
  standings.sort((x, y) => y.winPct - x.winPct || y.pointsFor - x.pointsFor);
  return standings;
}


// ============================================================
// People's Champion: highest cumulative points, regardless of rank.
// Returns null if the points leader IS the actual #1 (no mismatch story
// to tell), rather than showing a redundant "champion out-scored
// everyone" card that just restates the podium.
// ============================================================
function computePeoplesChampion(standings) {
  if (!standings.length) return null;
  const byPoints = [...standings].sort((a, b) => b.pointsFor - a.pointsFor);
  const pointsLeader = byPoints[0];
  const actualLeader = standings[0];
  if (pointsLeader.teamId === actualLeader.teamId) return null;
  return { teamId: pointsLeader.teamId, totalPoints: pointsLeader.pointsFor, actualRank: standings.findIndex(s => s.teamId === pointsLeader.teamId) + 1 };
}

// ============================================================
// Closest game / biggest blowout of the whole season, from the same
// resultsByWeek data standings already tracks. Each result appears
// twice (once per side), so results are deduped by (week, sorted
// team-pair) before finding the extremes.
// ============================================================
function findClosestAndBiggestBlowout(standings) {
  const seen = new Set();
  const games = [];
  for (const s of standings) {
    for (const r of s.resultsByWeek) {
      const pairKey = [s.teamId, r.opponentId].sort().join('|') + '|' + r.week;
      if (seen.has(pairKey)) continue;
      seen.add(pairKey);
      games.push({ week: r.week, teamA: s.teamId, teamB: r.opponentId, scoreA: r.ownScore, scoreB: r.oppScore, margin: Math.abs(r.ownScore - r.oppScore) });
    }
  }
  if (!games.length) return { closest: null, blowout: null };
  const sorted = [...games].sort((a, b) => a.margin - b.margin);
  return { closest: sorted[0], blowout: sorted[sorted.length - 1] };
}

// ============================================================
// Best / worst single-week score, across every team-week.
// ============================================================
function findBestWorstWeek(standings) {
  let best = null, worst = null;
  for (const s of standings) {
    for (const r of s.resultsByWeek) {
      if (!best || r.ownScore > best.score) best = { teamId: s.teamId, week: r.week, score: r.ownScore };
      if (!worst || r.ownScore < worst.score) worst = { teamId: s.teamId, week: r.week, score: r.ownScore };
    }
  }
  return { best, worst };
}

// ============================================================
// Best/worst average margin: avgWinMargin - avgLossMargin, highest is
// "wins big, loses rare/small", lowest is "wins small, loses huge".
// ============================================================
function computeAvgMargins(standings) {
  const results = standings.map((s) => {
    const winMargins = s.resultsByWeek.filter(r => r.result === 'W').map(r => r.ownScore - r.oppScore);
    const lossMargins = s.resultsByWeek.filter(r => r.result === 'L').map(r => r.ownScore - r.oppScore); // negative
    const avgWinMargin = winMargins.length ? winMargins.reduce((a, b) => a + b, 0) / winMargins.length : 0;
    const avgLossMargin = lossMargins.length ? lossMargins.reduce((a, b) => a + b, 0) / lossMargins.length : 0;
    return { teamId: s.teamId, avgWinMargin, avgLossMargin, combined: avgWinMargin + avgLossMargin };
  }).filter(r => standings.find(s => s.teamId === r.teamId).resultsByWeek.length > 0);
  if (!results.length) return { winsBig: null, winsSmallLosesHuge: null };
  const sorted = [...results].sort((a, b) => b.combined - a.combined);
  return { winsBig: sorted[0], winsSmallLosesHuge: sorted[sorted.length - 1] };
}

// ============================================================
// Consistency: population standard deviation of each team's weekly
// scores. Lowest = Mr. Consistent, highest = Boom or Bust. Teams with
// fewer than 2 games played are excluded -- stddev of one number is
// meaningless.
// ============================================================
function computeConsistency(standings) {
  const results = standings.map((s) => {
    const scores = s.resultsByWeek.map(r => r.ownScore);
    if (scores.length < 2) return null;
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
    const variance = scores.reduce((sum, v) => sum + (v - mean) ** 2, 0) / scores.length;
    return { teamId: s.teamId, stddev: Math.sqrt(variance), min: Math.min(...scores), max: Math.max(...scores) };
  }).filter(Boolean);
  if (!results.length) return { mostConsistent: null, boomOrBust: null };
  const sorted = [...results].sort((a, b) => a.stddev - b.stddev);
  return { mostConsistent: sorted[0], boomOrBust: sorted[sorted.length - 1] };
}

// ============================================================
// Nail-biter count: games decided by under a threshold, per team.
// ============================================================
function computeNailBiters(standings, threshold = 5) {
  const counts = standings.map((s) => ({
    teamId: s.teamId,
    count: s.resultsByWeek.filter(r => Math.abs(r.ownScore - r.oppScore) < threshold).length,
  }));
  if (!counts.length) return null;
  return [...counts].sort((a, b) => b.count - a.count)[0];
}

// ============================================================
// Toughest / luckiest schedule: each team's average OPPONENT score,
// compared to the league-wide average score across all games.
// ============================================================
function computeScheduleLuck(standings) {
  const allScores = standings.flatMap(s => s.resultsByWeek.map(r => r.ownScore));
  if (!allScores.length) return { toughest: null, luckiest: null, leagueAvg: 0 };
  const leagueAvg = allScores.reduce((a, b) => a + b, 0) / allScores.length;
  const results = standings.map((s) => {
    const oppScores = s.resultsByWeek.map(r => r.oppScore);
    if (!oppScores.length) return null;
    const avgOpp = oppScores.reduce((a, b) => a + b, 0) / oppScores.length;
    return { teamId: s.teamId, avgOpponentScore: avgOpp, deltaFromLeagueAvg: avgOpp - leagueAvg };
  }).filter(Boolean);
  if (!results.length) return { toughest: null, luckiest: null, leagueAvg };
  const sorted = [...results].sort((a, b) => b.deltaFromLeagueAvg - a.deltaFromLeagueAvg);
  return { toughest: sorted[0], luckiest: sorted[sorted.length - 1], leagueAvg };
}

// ============================================================
// All-play record: each team's score that week compared against EVERY
// other team's score that same week, not just their actual opponent.
// ============================================================
function computeAllPlayRecords(standings) {
  const weekScores = new Map(); // week -> [{teamId, score}]
  for (const s of standings) {
    for (const r of s.resultsByWeek) {
      if (!weekScores.has(r.week)) weekScores.set(r.week, []);
      weekScores.get(r.week).push({ teamId: s.teamId, score: r.ownScore });
    }
  }
  const allPlayWins = new Map(), allPlayLosses = new Map();
  for (const entries of weekScores.values()) {
    for (const entry of entries) {
      let w = 0, l = 0;
      for (const other of entries) {
        if (other.teamId === entry.teamId) continue;
        if (entry.score > other.score) w++; else if (entry.score < other.score) l++;
      }
      allPlayWins.set(entry.teamId, (allPlayWins.get(entry.teamId) || 0) + w);
      allPlayLosses.set(entry.teamId, (allPlayLosses.get(entry.teamId) || 0) + l);
    }
  }
  return standings.map((s) => ({
    teamId: s.teamId,
    actualWins: s.wins, actualLosses: s.losses,
    allPlayWins: allPlayWins.get(s.teamId) || 0, allPlayLosses: allPlayLosses.get(s.teamId) || 0,
  }));
}

// ============================================================
// Longest win/lose streak per team, then the max across the league.
// ============================================================
function computeLongestStreaks(standings) {
  let longestWin = null, longestLoss = null;
  for (const s of standings) {
    let curType = null, curLen = 0, curStartWeek = null;
    let bestWin = { len: 0 }, bestLoss = { len: 0 };
    for (const r of s.resultsByWeek) {
      if (r.result === curType) { curLen++; }
      else { curType = r.result; curLen = 1; curStartWeek = r.week; }
      if (curType === 'W' && curLen > bestWin.len) bestWin = { len: curLen, endWeek: r.week, startWeek: curStartWeek };
      if (curType === 'L' && curLen > bestLoss.len) bestLoss = { len: curLen, endWeek: r.week, startWeek: curStartWeek };
    }
    if (bestWin.len > 0 && (!longestWin || bestWin.len > longestWin.len)) longestWin = { teamId: s.teamId, ...bestWin };
    if (bestLoss.len > 0 && (!longestLoss || bestLoss.len > longestLoss.len)) longestLoss = { teamId: s.teamId, ...bestLoss };
  }
  return { longestWin, longestLoss };
}


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
// ============================================================
// Functions below need the FULL win_prob time series per matchup (every
// poll, not just the final all_starters_done=true row), structured as:
//   matchupTimeSeries = [{ year, week, matchupId, homeTeamId, awayTeamId,
//                           homeWinProbs: [ordered by ts], winnerTeamId }]
// ============================================================

// Biggest upset of the whole season: run the real, deployed
// walkUpsetState on every matchup, take the episode with the single
// highest peakFavoritePct across all of them.
function findBiggestUpsetOfSeason(matchupTimeSeries) {
  let best = null;
  for (const m of matchupTimeSeries) {
    if (m.homeWinProbs.length < 2) continue;
    const { episodes } = walkUpsetState(m.homeWinProbs);
    for (const ep of episodes) {
      if (!best || ep.peakFavoritePct > best.episode.peakFavoritePct) {
        best = { episode: ep, matchup: m };
      }
    }
  }
  return best;
}

// Grinder (longest time spent behind before winning) and never-trailed
// count, per team.
function computeGrinderAndNeverTrailed(matchupTimeSeries) {
  let grinder = null;
  const neverTrailedCounts = new Map();
  for (const m of matchupTimeSeries) {
    if (!m.winnerTeamId || !m.homeWinProbs.length) continue;
    const winnerIsHome = m.winnerTeamId === m.homeTeamId;
    const winnerPcts = winnerIsHome ? m.homeWinProbs : m.homeWinProbs.map(v => 100 - v);
    const trailingPolls = winnerPcts.filter(v => v < 50).length;
    if (trailingPolls > 0) {
      if (!grinder || trailingPolls > grinder.trailingPolls) {
        grinder = { teamId: m.winnerTeamId, trailingPolls, totalPolls: winnerPcts.length, matchup: m };
      }
    }
    // Never trailed: check BOTH sides of the matchup, not just the winner
    // -- a team can go the whole game never below 50% and still be
    // relevant to this stat regardless of whether the loser also had a
    // moment above 50% at the very start.
    const homeNeverTrailed = m.homeWinProbs.every(v => v >= 50);
    const awayNeverTrailed = m.homeWinProbs.every(v => (100 - v) >= 50);
    if (homeNeverTrailed) neverTrailedCounts.set(m.homeTeamId, (neverTrailedCounts.get(m.homeTeamId) || 0) + 1);
    if (awayNeverTrailed) neverTrailedCounts.set(m.awayTeamId, (neverTrailedCounts.get(m.awayTeamId) || 0) + 1);
  }
  let mostNeverTrailed = null;
  for (const [teamId, count] of neverTrailedCounts) {
    if (!mostNeverTrailed || count > mostNeverTrailed.count) mostNeverTrailed = { teamId, count };
  }
  return { grinder, mostNeverTrailed };
}

// Upset Watch season leaderboard: most times armed (favorite in an
// episode), most comebacks actually completed (was the upsetSide in an
// episode AND went on to win the game).
function computeUpsetWatchLeaderboard(matchupTimeSeries) {
  const armedCounts = new Map(), comebackCounts = new Map();
  for (const m of matchupTimeSeries) {
    if (m.homeWinProbs.length < 2) continue;
    const { episodes } = walkUpsetState(m.homeWinProbs);
    for (const ep of episodes) {
      const favoriteTeamId = ep.favoriteSide === 'home' ? m.homeTeamId : m.awayTeamId;
      const upsetTeamId = ep.upsetSide === 'home' ? m.homeTeamId : m.awayTeamId;
      armedCounts.set(favoriteTeamId, (armedCounts.get(favoriteTeamId) || 0) + 1);
      if (m.winnerTeamId === upsetTeamId) {
        comebackCounts.set(upsetTeamId, (comebackCounts.get(upsetTeamId) || 0) + 1);
      }
    }
  }
  let mostArmed = null, mostComebacks = null;
  for (const [teamId, count] of armedCounts) if (!mostArmed || count > mostArmed.count) mostArmed = { teamId, count };
  for (const [teamId, count] of comebackCounts) if (!mostComebacks || count > mostComebacks.count) mostComebacks = { teamId, count };
  return { mostArmed, mostComebacks };
}


// ============================================================
// Projection stats -- needs (team, week, actual_score, expected_score)
// rows for every FINAL matchup. Single-week extremes, plus each team's
// own season-long average gap, then the extremes of THAT.
// ============================================================
function computeProjectionStats(finalRows) {
  let bestWeek = null, worstWeek = null;
  const byTeam = new Map();
  for (const r of finalRows) {
    const diff = r.actual_score - r.expected_score;
    if (!bestWeek || diff > bestWeek.diff) bestWeek = { teamId: r.team_id, week: r.week, actual: r.actual_score, expected: r.expected_score, diff };
    if (!worstWeek || diff < worstWeek.diff) worstWeek = { teamId: r.team_id, week: r.week, actual: r.actual_score, expected: r.expected_score, diff };
    if (!byTeam.has(r.team_id)) byTeam.set(r.team_id, []);
    byTeam.get(r.team_id).push(diff);
  }
  let bestAvg = null, worstAvg = null;
  for (const [teamId, diffs] of byTeam) {
    const avg = diffs.reduce((a, b) => a + b, 0) / diffs.length;
    if (!bestAvg || avg > bestAvg.avgDiff) bestAvg = { teamId, avgDiff: avg, weeksCounted: diffs.length };
    if (!worstAvg || avg < worstAvg.avgDiff) worstAvg = { teamId, avgDiff: avg, weeksCounted: diffs.length };
  }
  return { bestWeek, worstWeek, bestAvg, worstAvg };
}

// ============================================================
// Season race data: each team's RANK (1 = best) at the end of every
// week, by re-running computeStandings with an increasing throughWeek
// cutoff. A team with no games yet that week (bye, or season hasn't
// reached them) simply won't appear in that week's standings snapshot
// -- callers should treat a missing entry as "not yet ranked" rather
// than assuming a specific rank.
// ============================================================
function computeSeasonRaceData(rows, teamInfoMap, maxWeek) {
  const raceData = {}; // teamId -> [{week, rank}]
  for (let week = 1; week <= maxWeek; week++) {
    const standings = computeStandings(rows, teamInfoMap, week);
    standings.forEach((s, i) => {
      if (!raceData[s.teamId]) raceData[s.teamId] = [];
      raceData[s.teamId].push({ week, rank: i + 1 });
    });
  }
  return raceData;
}


// ============================================================
// Data shaping: from raw, unfiltered snapshot rows (every poll, not just
// finals) to the two shapes the stat functions above actually need.
// ============================================================

// Latest snapshot per (year, week, matchup_id, team_id), filtered to
// only the ones that actually went final -- what computeStandings,
// computeProjectionStats, and everything score-based needs.
function buildFinalRows(allRows) {
  const latestByKey = new Map();
  for (const r of allRows) {
    const key = `${r.year}|${r.week}|${r.matchup_id}|${r.team_id}`;
    const existing = latestByKey.get(key);
    if (!existing || new Date(r.ts) > new Date(existing.ts)) latestByKey.set(key, r);
  }
  return [...latestByKey.values()].filter((r) => r.all_starters_done);
}

// Full time-ordered home win_prob sequence per matchup, plus the winner
// -- what walkUpsetState-based stats (biggest upset, grinder, never
// trailed, Upset Watch leaderboard) need. Only includes matchups that
// actually finished (so "winner" is well-defined) and have at least 2
// polls (so a state-machine walk is meaningful at all).
function buildMatchupTimeSeries(allRows) {
  const groups = new Map();
  for (const r of allRows) {
    const key = `${r.year}|${r.week}|${r.matchup_id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const series = [];
  for (const [key, groupRows] of groups) {
    const [year, week, matchupId] = key.split('|');
    const homeRows = groupRows.filter((r) => r.is_home).sort((a, b) => new Date(a.ts) - new Date(b.ts));
    const awayRows = groupRows.filter((r) => !r.is_home).sort((a, b) => new Date(a.ts) - new Date(b.ts));
    if (!homeRows.length || !awayRows.length) continue;
    const lastHome = homeRows[homeRows.length - 1], lastAway = awayRows[awayRows.length - 1];
    if (!lastHome.all_starters_done || !lastAway.all_starters_done) continue; // not final, no well-defined winner
    let winnerTeamId = null;
    if (lastHome.actual_score > lastAway.actual_score) winnerTeamId = lastHome.team_id;
    else if (lastAway.actual_score > lastHome.actual_score) winnerTeamId = lastAway.team_id;
    // a tie leaves winnerTeamId null -- correctly excluded from
    // grinder/comeback stats, which require an actual winner
    series.push({
      year: Number(year), week: Number(week), matchupId,
      homeTeamId: lastHome.team_id, awayTeamId: lastAway.team_id,
      homeWinProbs: homeRows.map((r) => r.win_prob),
      winnerTeamId,
    });
  }
  return series;
}

function renderEverything({ year, teamInfo, standings, finalRows, matchupTimeSeries, maxWeek, podiumResults, playoffSpots }) {
  document.getElementById('heroYear').textContent = `${year} Season`;
  renderLogoBanner(teamInfo);
  renderPodium(standings, teamInfo, podiumResults);
  renderPeoplesChampion(computePeoplesChampion(standings), teamInfo, standings);

  const raceData = computeSeasonRaceData(finalRows, teamInfo, maxWeek);
  drawRaceChart(raceData, teamInfo, maxWeek);

  renderDramaAwards(standings, matchupTimeSeries, teamInfo);
  renderNumbersAwards(standings, finalRows, teamInfo);
  renderLuckAwards(standings, teamInfo);
  renderUpsetLeaderboard(matchupTimeSeries, teamInfo);
  renderSoClose(standings, teamInfo, playoffSpots);
}

function renderDramaAwards(standings, matchupTimeSeries, teamInfo) {
  const cards = [];

  const biggestUpset = findBiggestUpsetOfSeason(matchupTimeSeries);
  if (biggestUpset) {
    const { episode, matchup } = biggestUpset;
    const favoriteTeam = teamInfo[episode.favoriteSide === 'home' ? matchup.homeTeamId : matchup.awayTeamId];
    const upsetTeam = teamInfo[episode.upsetSide === 'home' ? matchup.homeTeamId : matchup.awayTeamId];
    const chartEpisode = { ...episode, homeColor: teamInfo[matchup.homeTeamId] ? teamInfo[matchup.homeTeamId].color : '#888', awayColor: teamInfo[matchup.awayTeamId] ? teamInfo[matchup.awayTeamId].color : '#888' };
    cards.push(`
      <div class="award-card" style="--accent-color:#ff8a3d">
        <div class="award-label">⚠️ Biggest Upset</div>
        <div class="award-headline">${teamNameHtml(upsetTeam)} over ${teamNameHtml(favoriteTeam)}</div>
        <div class="award-detail">${favoriteTeam ? favoriteTeam.name : 'The favorite'} peaked at ${episode.peakFavoritePct.toFixed(0)}% win probability in Week ${matchup.week} -- then completely fell apart. Here's the exact window where it happened, not the whole game:</div>
        <div class="upset-chart-wrap">${buildUpsetCropChart(matchup.homeWinProbs, chartEpisode)}</div>
      </div>
    `);
  }

  const cb = findClosestAndBiggestBlowout(standings);
  if (cb.closest || cb.blowout) {
    cards.push(`
      <div class="award-card" style="--accent-color:#e0574a">
        <div class="award-pair">
          ${cb.closest ? `
          <div>
            <div class="award-label">😬 Closest Game</div>
            <div class="award-headline">${teamNameHtml(teamInfo[cb.closest.teamA])} ${cb.closest.scoreA.toFixed(1)} &ndash; ${cb.closest.scoreB.toFixed(1)} ${teamNameHtml(teamInfo[cb.closest.teamB])}</div>
            <div class="award-detail">Week ${cb.closest.week} &middot; decided by ${cb.closest.margin.toFixed(1)} points</div>
          </div>` : ''}
          ${cb.blowout ? `
          <div>
            <div class="award-label">💥 Biggest Blowout</div>
            <div class="award-headline">${teamNameHtml(teamInfo[cb.blowout.teamA])} ${cb.blowout.scoreA.toFixed(1)} &ndash; ${cb.blowout.scoreB.toFixed(1)} ${teamNameHtml(teamInfo[cb.blowout.teamB])}</div>
            <div class="award-detail">Week ${cb.blowout.week} &middot; decided by ${cb.blowout.margin.toFixed(1)} points</div>
          </div>` : ''}
        </div>
      </div>
    `);
  }

  const { grinder, mostNeverTrailed } = computeGrinderAndNeverTrailed(matchupTimeSeries);
  if (grinder || mostNeverTrailed) {
    cards.push(`
      <div class="award-card" style="--accent-color:#4fbd82">
        <div class="award-pair">
          ${grinder ? `
          <div>
            <div class="award-label">🐢 The Grinder</div>
            <div class="award-headline">${teamNameHtml(teamInfo[grinder.teamId])}</div>
            <div class="award-detail">Trailed for ${grinder.trailingPolls} of ${grinder.totalPolls} tracked polls before winning in Week ${grinder.matchup.week} -- the longest come-from-behind win of the season</div>
          </div>` : ''}
          ${mostNeverTrailed ? `
          <div>
            <div class="award-label">🛡️ Never Trailed</div>
            <div class="award-headline">${teamNameHtml(teamInfo[mostNeverTrailed.teamId])}</div>
            <div class="award-detail">Led wire-to-wire in ${mostNeverTrailed.count} game${mostNeverTrailed.count === 1 ? '' : 's'} this season -- never dropped below 50% win probability</div>
          </div>` : ''}
        </div>
      </div>
    `);
  }

  const am = computeAvgMargins(standings);
  if (am.winsBig && am.winsSmallLosesHuge && am.winsBig.teamId !== am.winsSmallLosesHuge.teamId) {
    cards.push(`
      <div class="award-card" style="--accent-color:#4d78d6">
        <div class="award-pair">
          <div>
            <div class="award-label">😎 Wins Big, Loses Rare</div>
            <div class="award-headline">${teamNameHtml(teamInfo[am.winsBig.teamId])}</div>
            <div class="award-detail">Averaged a ${am.winsBig.avgWinMargin >= 0 ? '+' : ''}${am.winsBig.avgWinMargin.toFixed(1)} point margin in wins this season</div>
          </div>
          <div>
            <div class="award-label">😩 Wins Small, Loses Huge</div>
            <div class="award-headline">${teamNameHtml(teamInfo[am.winsSmallLosesHuge.teamId])}</div>
            <div class="award-detail">Averaged ${am.winsSmallLosesHuge.avgWinMargin >= 0 ? '+' : ''}${am.winsSmallLosesHuge.avgWinMargin.toFixed(1)} in wins, but ${am.winsSmallLosesHuge.avgLossMargin.toFixed(1)} in losses</div>
          </div>
        </div>
      </div>
    `);
  }

  document.getElementById('dramaAwards').innerHTML = cards.join('');
  document.getElementById('dramaSection').style.display = cards.length ? '' : 'none';
}

function renderNumbersAwards(standings, finalRows, teamInfo) {
  const cards = [];
  const bw = findBestWorstWeek(standings);
  if (bw.best) cards.push(`<div class="award-card" style="--accent-color:#4fbd82"><div class="award-label">🔥 Best Week</div><div class="award-headline">${teamNameHtml(teamInfo[bw.best.teamId])}</div><div class="award-detail">${bw.best.score.toFixed(1)} points, Week ${bw.best.week}</div></div>`);
  if (bw.worst) cards.push(`<div class="award-card" style="--accent-color:#e0574a"><div class="award-label">🥶 Worst Week</div><div class="award-headline">${teamNameHtml(teamInfo[bw.worst.teamId])}</div><div class="award-detail">${bw.worst.score.toFixed(1)} points, Week ${bw.worst.week}</div></div>`);

  const proj = computeProjectionStats(finalRows);
  if (proj.bestWeek) cards.push(`<div class="award-card" style="--accent-color:#4fbd82"><div class="award-label">📈 Biggest Overperformer</div><div class="award-headline">${teamNameHtml(teamInfo[proj.bestWeek.teamId])}</div><div class="award-detail">+${proj.bestWeek.diff.toFixed(1)} over projection, Week ${proj.bestWeek.week} (${proj.bestWeek.expected.toFixed(1)} projected &rarr; ${proj.bestWeek.actual.toFixed(1)} actual)</div></div>`);
  if (proj.worstWeek) cards.push(`<div class="award-card" style="--accent-color:#e0574a"><div class="award-label">📉 Biggest Underperformer</div><div class="award-headline">${teamNameHtml(teamInfo[proj.worstWeek.teamId])}</div><div class="award-detail">${proj.worstWeek.diff.toFixed(1)} under projection, Week ${proj.worstWeek.week} (${proj.worstWeek.expected.toFixed(1)} projected &rarr; ${proj.worstWeek.actual.toFixed(1)} actual)</div></div>`);

  const cons = computeConsistency(standings);
  if (cons.mostConsistent) cards.push(`<div class="award-card" style="--accent-color:#2ec4c6"><div class="award-label">😌 Mr. Consistent</div><div class="award-headline">${teamNameHtml(teamInfo[cons.mostConsistent.teamId])}</div><div class="award-detail">Every week between ${cons.mostConsistent.min.toFixed(0)} and ${cons.mostConsistent.max.toFixed(0)} points -- the smallest range all season</div></div>`);
  if (cons.boomOrBust) cards.push(`<div class="award-card" style="--accent-color:#d4a72c"><div class="award-label">🎢 Boom or Bust</div><div class="award-headline">${teamNameHtml(teamInfo[cons.boomOrBust.teamId])}</div><div class="award-detail">${cons.boomOrBust.min.toFixed(0)} to ${cons.boomOrBust.max.toFixed(0)} points -- the widest week-to-week swing all season</div></div>`);

  const streaks = computeLongestStreaks(standings);
  if (streaks.longestWin) cards.push(`<div class="award-card" style="--accent-color:#4fbd82"><div class="award-label">🔥 Longest Win Streak</div><div class="award-headline">${teamNameHtml(teamInfo[streaks.longestWin.teamId])}</div><div class="award-detail">${streaks.longestWin.len} straight wins, Weeks ${streaks.longestWin.startWeek} through ${streaks.longestWin.endWeek}</div></div>`);
  if (streaks.longestLoss) cards.push(`<div class="award-card" style="--accent-color:#e0574a"><div class="award-label">❄️ Longest Losing Streak</div><div class="award-headline">${teamNameHtml(teamInfo[streaks.longestLoss.teamId])}</div><div class="award-detail">${streaks.longestLoss.len} straight losses, Weeks ${streaks.longestLoss.startWeek} through ${streaks.longestLoss.endWeek}</div></div>`);

  if (proj.bestAvg) cards.push(`<div class="award-card" style="--accent-color:#4fbd82"><div class="award-label">📊 Best Season-Long vs. Projection</div><div class="award-headline">${teamNameHtml(teamInfo[proj.bestAvg.teamId])}</div><div class="award-detail">Averaged ${proj.bestAvg.avgDiff >= 0 ? '+' : ''}${proj.bestAvg.avgDiff.toFixed(1)} points vs. their own projection across ${proj.bestAvg.weeksCounted} weeks</div></div>`);
  if (proj.worstAvg) cards.push(`<div class="award-card" style="--accent-color:#e0574a"><div class="award-label">📊 Worst Season-Long vs. Projection</div><div class="award-headline">${teamNameHtml(teamInfo[proj.worstAvg.teamId])}</div><div class="award-detail">Averaged ${proj.worstAvg.avgDiff.toFixed(1)} points vs. their own projection across ${proj.worstAvg.weeksCounted} weeks</div></div>`);

  document.getElementById('numbersAwards').innerHTML = cards.join('');
  document.getElementById('numbersSection').style.display = cards.length ? '' : 'none';
}

function allPlayBarHtml(label, wins, losses, color) {
  const total = wins + losses;
  const pct = total ? (wins / total) * 100 : 0;
  return `
    <div class="allplay-bar-track">
      <span style="width:90px">${label}</span>
      <div class="allplay-bar-fill-wrap"><div class="allplay-bar-fill" style="width:${pct}%;background:${color}"></div></div>
      <span style="width:50px;text-align:right">${wins}-${losses}</span>
    </div>
  `;
}

function renderLuckAwards(standings, teamInfo) {
  const cards = [];

  const allPlay = computeAllPlayRecords(standings);
  const unluckiest = [...allPlay].sort((a, b) => (a.actualWins - a.allPlayWins) - (b.actualWins - b.allPlayWins))[0];
  const luckiest = [...allPlay].sort((a, b) => (b.actualWins - b.allPlayWins) - (a.actualWins - a.allPlayWins))[0];
  if (unluckiest && luckiest && unluckiest.teamId !== luckiest.teamId) {
    cards.push(`
      <div class="award-card" style="--accent-color:#e0574a">
        <div class="award-label">🍀 All-Play Record — Actual vs. If You'd Played Everyone Every Week</div>
        <div class="allplay-row">
          <div class="allplay-team">${teamNameHtml(teamInfo[unluckiest.teamId])} <span style="color:var(--muted);font-family:var(--font-body);font-size:11px">— the unluckiest team all season</span></div>
          <div class="allplay-bars">
            ${allPlayBarHtml('Actual', unluckiest.actualWins, unluckiest.actualLosses, teamInfo[unluckiest.teamId] ? teamInfo[unluckiest.teamId].color : '#888')}
            ${allPlayBarHtml('All-play', unluckiest.allPlayWins, unluckiest.allPlayLosses, '#6a8fe0')}
          </div>
        </div>
        <div class="allplay-row">
          <div class="allplay-team">${teamNameHtml(teamInfo[luckiest.teamId])} <span style="color:var(--muted);font-family:var(--font-body);font-size:11px">— the luckiest</span></div>
          <div class="allplay-bars">
            ${allPlayBarHtml('Actual', luckiest.actualWins, luckiest.actualLosses, teamInfo[luckiest.teamId] ? teamInfo[luckiest.teamId].color : '#888')}
            ${allPlayBarHtml('All-play', luckiest.allPlayWins, luckiest.allPlayLosses, '#6a8fe0')}
          </div>
        </div>
      </div>
    `);
  }

  const sl = computeScheduleLuck(standings);
  if (sl.toughest && sl.luckiest && sl.toughest.teamId !== sl.luckiest.teamId) {
    cards.push(`
      <div class="award-card" style="--accent-color:#d65a9e">
        <div class="award-pair">
          <div>
            <div class="award-label">😤 Toughest Schedule</div>
            <div class="award-headline">${teamNameHtml(teamInfo[sl.toughest.teamId])}</div>
            <div class="award-detail">Opponents averaged ${sl.toughest.avgOpponentScore.toFixed(1)} pts/week against them &mdash; league average was ${sl.leagueAvg.toFixed(1)}</div>
          </div>
          <div>
            <div class="award-label">🎯 Luckiest Schedule</div>
            <div class="award-headline">${teamNameHtml(teamInfo[sl.luckiest.teamId])}</div>
            <div class="award-detail">Opponents averaged only ${sl.luckiest.avgOpponentScore.toFixed(1)} pts/week &mdash; well under the league average</div>
          </div>
        </div>
      </div>
    `);
  }

  document.getElementById('luckAwards').innerHTML = cards.join('');
  document.getElementById('luckSection').style.display = cards.length ? '' : 'none';
}

function renderUpsetLeaderboard(matchupTimeSeries, teamInfo) {
  const { mostArmed, mostComebacks } = computeUpsetWatchLeaderboard(matchupTimeSeries);
  const cards = [];
  if (mostArmed) cards.push(`<div class="award-card" style="--accent-color:#ff8a3d"><div class="award-label">🚨 Most Times Armed</div><div class="award-headline">${teamNameHtml(teamInfo[mostArmed.teamId])}</div><div class="award-detail">Reached 85%+ win probability ${mostArmed.count} separate time${mostArmed.count === 1 ? '' : 's'} this season</div></div>`);
  if (mostComebacks) cards.push(`<div class="award-card" style="--accent-color:#b378d1"><div class="award-label">🔄 Most Comebacks Completed</div><div class="award-headline">${teamNameHtml(teamInfo[mostComebacks.teamId])}</div><div class="award-detail">Completed ${mostComebacks.count} separate Upset Watch comeback${mostComebacks.count === 1 ? '' : 's'} this season</div></div>`);
  document.getElementById('upsetLeaderboard').innerHTML = cards.join('');
  document.getElementById('upsetLeaderboardSection').style.display = cards.length ? '' : 'none';
}

function renderSoClose(standings, teamInfo, playoffSpots) {
  const section = document.getElementById('soCloseSection');
  if (!playoffSpots || playoffSpots >= standings.length) { section.style.display = 'none'; return; }
  const team = standings[playoffSpots]; // 0-indexed: standings[playoffSpots] is the FIRST team missing the cutoff
  if (!team) { section.style.display = 'none'; return; }
  section.style.display = '';
  document.getElementById('soCloseAward').innerHTML = `
    <div class="award-card" style="--accent-color:#8a8f98">
      <div class="award-label">😔 So Close</div>
      <div class="award-headline">${teamNameHtml(teamInfo[team.teamId])}</div>
      <div class="award-detail">Finished ${ordinal(playoffSpots + 1)} -- one spot outside the ${playoffSpots}-team playoff cutoff.</div>
    </div>
  `;
}

loadLeagues();
