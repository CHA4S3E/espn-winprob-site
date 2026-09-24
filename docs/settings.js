const { url, anonKey } = window.SUPABASE_CONFIG;
const sb = window.supabase.createClient(url, anonKey);

const leagueSelect = document.getElementById('leagueSelect');
const teamList = document.getElementById('teamList');
const savedNote = document.getElementById('savedNote');
const lockNote = document.getElementById('lockNote');
const lockText = document.getElementById('lockText');
const unlockBtn = document.getElementById('unlockBtn');
let saveTimeout;

// Every uploaded logo gets resized down to this square size before
// upload, regardless of the source image's own dimensions -- keeps
// storage small and every logo consistently sized everywhere it's
// displayed across the site, rather than depending on whatever size
// someone happened to upload.
const LOGO_SIZE = 200;

// Simple shared-PIN gate -- not real security (anyone can view the JS/config),
// just enough friction to stop a random visitor with the link from casually
// editing team names/colors. Unlock state is remembered for this browser tab
// session only (sessionStorage), so it re-locks on a fresh visit/new tab.
const REQUIRED_PIN = window.SETTINGS_PIN || '1234';
let unlocked = sessionStorage.getItem('settingsUnlocked') === 'true';

function updateLockUI() {
  if (unlocked) {
    lockText.textContent = '🔓 Unlocked -- edits will save';
    unlockBtn.textContent = 'Lock';
  } else {
    lockText.textContent = '🔒 Locked -- enter the PIN to edit';
    unlockBtn.textContent = 'Unlock';
  }
  teamList.querySelectorAll('input').forEach((el) => (el.disabled = !unlocked));
  teamList.querySelectorAll('.logo-upload-btn, .logo-remove-btn').forEach((el) => (el.disabled = !unlocked));
  document.querySelectorAll('#seasonResultsPanel select, #seasonResultsPanel input, #seasonResultsPanel button').forEach((el) => (el.disabled = !unlocked));
  document.querySelectorAll('#legacyTeamList input, #legacyTeamList button, #addLegacyTeamBtn').forEach((el) => (el.disabled = !unlocked));
  document.querySelectorAll('#legacyMatchupForm select, #legacyMatchupForm input, #addLegacyMatchupBtn, #legacyMatchupList button').forEach((el) => (el.disabled = !unlocked));
}

unlockBtn.addEventListener('click', () => {
  if (unlocked) {
    unlocked = false;
    sessionStorage.removeItem('settingsUnlocked');
    updateLockUI();
    return;
  }
  const entered = prompt('Enter the league PIN to edit team colors/names:');
  if (entered === null) return; // cancelled
  if (entered === REQUIRED_PIN) {
    unlocked = true;
    sessionStorage.setItem('settingsUnlocked', 'true');
    updateLockUI();
  } else {
    alert('Incorrect PIN.');
  }
});

async function loadLeagues() {
  const { data, error } = await sb.from('leagues').select('id, name').order('name');
  if (error) return;
  leagueSelect.innerHTML = data.map((l) => `<option value="${l.id}">${l.name}</option>`).join('');
  leagueSelect.onchange = () => { loadTeams(); loadSeasonResultsPanel(); loadLegacySection(); };
  if (data.length) { loadTeams(); loadSeasonResultsPanel(); loadLegacySection(); }
}

async function loadTeams() {
  const leagueId = leagueSelect.value;
  const { data, error } = await sb
    .from('teams')
    .select('id, espn_team_name, team_settings(color, display_name, emoji, logo_url)')
    .eq('league_id', leagueId)
    .order('espn_team_name');

  if (error) { teamList.textContent = 'Error: ' + error.message; return; }

  teamList.innerHTML = data.map((t) => {
    const settings = t.team_settings || {};
    const color = settings.color || '#1a3fa0';
    const name = settings.display_name || t.espn_team_name;
    const emoji = settings.emoji || '';
    const logoUrl = settings.logo_url || '';
    return `
      <div class="team-row" data-team-id="${t.id}">
        <input type="color" value="${color}" class="color-input" />
        <div class="logo-cell">
          <button type="button" class="logo-upload-btn" title="Upload a logo">
            <img class="logo-preview" src="${logoUrl}" style="display:${logoUrl ? 'block' : 'none'}" />
            <span class="logo-fallback" style="display:${logoUrl ? 'none' : 'flex'}">${emoji || '+'}</span>
          </button>
          <button type="button" class="logo-remove-btn" title="Remove logo" style="display:${logoUrl ? 'inline-block' : 'none'}">&times;</button>
          <input type="file" accept="image/*" class="logo-file-input" hidden />
        </div>
        <input type="text" value="${name}" class="name-input" />
        <span class="espn-name">ESPN: ${t.espn_team_name}</span>
      </div>
    `;
  }).join('');

  teamList.querySelectorAll('.team-row').forEach((row) => {
    const teamId = row.dataset.teamId;
    const colorInput = row.querySelector('.color-input');
    const nameInput = row.querySelector('.name-input');
    const save = () => {
      if (!unlocked) return; // extra guard even if disabled attr is bypassed
      saveTeamSettings(teamId, colorInput.value, nameInput.value);
    };
    colorInput.addEventListener('input', save);
    nameInput.addEventListener('input', save);

    const uploadBtn = row.querySelector('.logo-upload-btn');
    const removeBtn = row.querySelector('.logo-remove-btn');
    const fileInput = row.querySelector('.logo-file-input');
    const previewImg = row.querySelector('.logo-preview');
    const fallbackSpan = row.querySelector('.logo-fallback');

    uploadBtn.addEventListener('click', () => { if (unlocked) fileInput.click(); });
    fileInput.addEventListener('change', () => {
      if (fileInput.files[0]) handleLogoUpload(fileInput.files[0], teamId, previewImg, fallbackSpan, removeBtn);
    });
    removeBtn.addEventListener('click', async () => {
      if (!unlocked) return;
      previewImg.style.display = 'none';
      previewImg.src = '';
      fallbackSpan.style.display = 'flex';
      removeBtn.style.display = 'none';
      await saveLogoUrl(teamId, null);
    });
  });

  updateLockUI(); // apply current lock state to the freshly rendered inputs
}

// Center-crops the source image to a square (using the shorter of its two
// dimensions), then scales that square into a fixed-size canvas -- so a
// wide banner-shaped upload and a small square icon both end up the same
// consistent size and shape, rather than displaying at wildly different
// proportions depending on what someone happened to upload.
function resizeImageToSquare(img, size) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const minDim = Math.min(img.width, img.height);
  const sx = (img.width - minDim) / 2;
  const sy = (img.height - minDim) / 2;
  ctx.drawImage(img, sx, sy, minDim, minDim, 0, 0, size, size);
  return canvas;
}

async function handleLogoUpload(file, teamId, previewImg, fallbackSpan, removeBtn) {
  if (!file.type.startsWith('image/')) {
    alert('Please choose an image file.');
    return;
  }
  const objectUrl = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    URL.revokeObjectURL(objectUrl);
    const canvas = resizeImageToSquare(img, LOGO_SIZE);
    canvas.toBlob(async (blob) => {
      if (!blob) { alert('Could not process that image.'); return; }
      const path = `${teamId}.png`;
      const { error: uploadError } = await sb.storage
        .from('team-logos')
        .upload(path, blob, { upsert: true, contentType: 'image/png' });
      if (uploadError) {
        alert('Upload failed: ' + uploadError.message + ' -- make sure the "team-logos" storage bucket exists and is public.');
        return;
      }
      const { data: publicUrlData } = sb.storage.from('team-logos').getPublicUrl(path);
      // Cache-bust with a timestamp -- the storage PATH is stable (named
      // by team id), so re-uploading a new logo for the same team reuses
      // the exact same URL. Without something that changes per upload,
      // browsers (and any CDN in front of storage) could keep serving the
      // OLD cached image indefinitely at that same URL.
      const bustedUrl = `${publicUrlData.publicUrl}?t=${Date.now()}`;
      previewImg.src = bustedUrl;
      previewImg.style.display = 'block';
      fallbackSpan.style.display = 'none';
      removeBtn.style.display = 'inline-block';
      await saveLogoUrl(teamId, bustedUrl);
    }, 'image/png');
  };
  img.onerror = () => {
    URL.revokeObjectURL(objectUrl);
    alert('Could not load that image -- try a different file.');
  };
  img.src = objectUrl;
}

async function saveLogoUrl(teamId, logoUrl) {
  const { error } = await sb
    .from('team_settings')
    .upsert({ team_id: teamId, logo_url: logoUrl }, { onConflict: 'team_id' });
  savedNote.textContent = error ? 'Failed to save: ' + error.message : 'Saved \u2713';
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => (savedNote.textContent = ''), 1800);
}

async function saveTeamSettings(teamId, color, displayName) {
  const { error } = await sb
    .from('team_settings')
    .upsert({ team_id: teamId, color, display_name: displayName }, { onConflict: 'team_id' });

  savedNote.textContent = error ? 'Failed to save: ' + error.message : 'Saved \u2713';
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => (savedNote.textContent = ''), 1800);
}

// ============================================================
// Season Results panel -- podium + playoff spots, for Year in Review.
// This has no per-keystroke autosave like the team rows above; it's
// meant to be filled in once, deliberately, after the season ends.
// ============================================================
async function loadSeasonResultsPanel() {
  const leagueId = leagueSelect.value;

  // Merge years from both snapshots AND legacy_matchups -- a legacy-only
  // year like 2024 has zero snapshot rows but still needs standings set.
  const [{ data: snapYears }, { data: legacyYears }] = await Promise.all([
    sb.from('snapshots').select('year').eq('league_id', leagueId),
    sb.from('legacy_matchups').select('year').eq('league_id', leagueId),
  ]);
  const distinctYears = [...new Set([...(snapYears || []), ...(legacyYears || [])].map((r) => r.year))].sort((a, b) => b - a);
  const yearSelect = document.getElementById('resultsYearSelect');
  yearSelect.innerHTML = distinctYears.map((y) => `<option value="${y}">${y}</option>`).join('');

  yearSelect.onchange = loadSeasonResultsForYear;
  if (distinctYears.length) await loadSeasonResultsForYear();
  updateLockUI();
}

// Only the teams that ACTUALLY PLAYED in the given year -- not every team
// ever entered for the league -- since a league's roster changes year to
// year and showing teams that didn't exist yet (or had already left)
// would just invite mistakes. Checks real snapshots first (a normal,
// tracked year); if there are none, falls back to legacy_matchups, whose
// two sides can each be either a live or a defunct team.
async function getParticipantsForYear(leagueId, year) {
  const { data: snapRows } = await sb.from('snapshots').select('team_id').eq('league_id', leagueId).eq('year', year).limit(1);
  if (snapRows && snapRows.length) {
    const { data: allSnapRows } = await sb.from('snapshots').select('team_id').eq('league_id', leagueId).eq('year', year);
    const teamIds = [...new Set((allSnapRows || []).map((r) => r.team_id))];
    const { data: teams } = await sb.from('teams').select('id, espn_team_name, team_settings(display_name)').in('id', teamIds);
    return (teams || []).map((t) => ({ id: t.id, name: (t.team_settings && t.team_settings.display_name) || t.espn_team_name, source: 'live' }));
  }

  const { data: legacyRows } = await sb.from('legacy_matchups')
    .select('home_legacy_team_id, away_legacy_team_id, home_live_team_id, away_live_team_id')
    .eq('league_id', leagueId).eq('year', year);
  const legacyIds = new Set(), liveIds = new Set();
  (legacyRows || []).forEach((r) => {
    if (r.home_legacy_team_id) legacyIds.add(r.home_legacy_team_id);
    if (r.away_legacy_team_id) legacyIds.add(r.away_legacy_team_id);
    if (r.home_live_team_id) liveIds.add(r.home_live_team_id);
    if (r.away_live_team_id) liveIds.add(r.away_live_team_id);
  });
  const [{ data: legacyTeams }, { data: liveTeams }] = await Promise.all([
    legacyIds.size ? sb.from('legacy_teams').select('id, name').in('id', [...legacyIds]) : Promise.resolve({ data: [] }),
    liveIds.size ? sb.from('teams').select('id, espn_team_name, team_settings(display_name)').in('id', [...liveIds]) : Promise.resolve({ data: [] }),
  ]);
  const fromLegacy = (legacyTeams || []).map((t) => ({ id: t.id, name: t.name, source: 'legacy' }));
  const fromLive = (liveTeams || []).map((t) => ({ id: t.id, name: (t.team_settings && t.team_settings.display_name) || t.espn_team_name, source: 'live' }));
  return [...fromLegacy, ...fromLive];
}

async function loadSeasonResultsForYear() {
  const leagueId = leagueSelect.value;
  const year = Number(document.getElementById('resultsYearSelect').value);

  const { data: league } = await sb.from('leagues').select('playoff_spots').eq('id', leagueId).single();
  document.getElementById('playoffSpotsInput').value = league && league.playoff_spots != null ? league.playoff_spots : '';

  const [participants, { data: results }] = await Promise.all([
    getParticipantsForYear(leagueId, year),
    sb.from('season_results').select('place, legacy_team_id, live_team_id').eq('league_id', leagueId).eq('year', year),
  ]);
  participants.sort((a, b) => a.name.localeCompare(b.name));

  const placeByTeamId = {};
  (results || []).forEach((r) => { placeByTeamId[r.legacy_team_id || r.live_team_id] = r.place; });

  const listEl = document.getElementById('finalStandingsList');
  listEl.innerHTML = participants.map((t) => `
    <div class="final-standing-row" data-team-id="${t.id}" data-source="${t.source}">
      <input type="number" min="1" max="${participants.length}" value="${placeByTeamId[t.id] != null ? placeByTeamId[t.id] : ''}" placeholder="--">
      <span class="team-label">${t.name}</span>
      <span class="team-source-tag">${t.source === 'legacy' ? 'historical' : 'active'}</span>
    </div>
  `).join('') || '<div class="sub">No teams found for this year.</div>';

  updateLockUI();
}

document.getElementById('saveSeasonResultsBtn').addEventListener('click', async () => {
  if (!unlocked) return;
  const leagueId = leagueSelect.value;
  const year = Number(document.getElementById('resultsYearSelect').value);
  const playoffSpotsRaw = document.getElementById('playoffSpotsInput').value;
  const playoffSpots = playoffSpotsRaw === '' ? null : Number(playoffSpotsRaw);

  const rows = [...document.querySelectorAll('.final-standing-row')]
    .map((row) => ({
      teamId: row.dataset.teamId, source: row.dataset.source,
      place: row.querySelector('input[type="number"]').value,
    }))
    .filter((r) => r.place !== '');

  // Guards against the UPSERT silently overwriting one team's placement
  // with another's if two rows accidentally share the same number --
  // upsert has no way to detect or warn about that on its own.
  const placeCounts = {};
  rows.forEach((r) => { placeCounts[r.place] = (placeCounts[r.place] || 0) + 1; });
  const duplicates = Object.entries(placeCounts).filter(([, count]) => count > 1).map(([place]) => place);
  if (duplicates.length) {
    alert(`More than one team is set to place ${duplicates.join(', ')} -- fix that before saving, since only one would actually be kept.`);
    return;
  }

  const podiumRows = rows.map((r) => ({
    league_id: leagueId, year, place: Number(r.place),
    legacy_team_id: r.source === 'legacy' ? r.teamId : null,
    live_team_id: r.source === 'live' ? r.teamId : null,
  }));

  const results = await Promise.all([
    sb.from('leagues').update({ playoff_spots: playoffSpots }).eq('id', leagueId),
    podiumRows.length
      ? sb.from('season_results').upsert(podiumRows, { onConflict: 'league_id,year,place' })
      : Promise.resolve({ error: null }),
  ]);
  const error = results.find((r) => r.error)?.error;

  savedNote.textContent = error ? 'Failed to save: ' + error.message : 'Saved \u2713';
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => (savedNote.textContent = ''), 1800);
});

loadLeagues();

// ============================================================
// Historical / Defunct Teams + Historical Matchup Results -- for
// 2024/2025 seasons that predate the win-probability tracker and have no
// relationship to ESPN's current team list at all. Both sections load
// together whenever the league selection changes.
// ============================================================
async function loadLegacySection() {
  await loadLegacyTeams();
  await loadLegacyMatchupList();
}

async function loadLegacyTeams() {
  const leagueId = leagueSelect.value;
  const { data, error } = await sb.from('legacy_teams').select('id, name, color, logo_url, emoji').eq('league_id', leagueId).order('name');
  const listEl = document.getElementById('legacyTeamList');
  if (error) { listEl.textContent = 'Error: ' + error.message; return; }

  listEl.innerHTML = (data || []).map((t) => `
    <div class="legacy-team-row" data-legacy-team-id="${t.id}">
      <input type="color" value="${t.color || '#888888'}" class="legacy-color-input" />
      <div class="logo-cell">
        <button type="button" class="logo-upload-btn" title="Upload a logo">
          <img class="logo-preview" src="${t.logo_url || ''}" style="display:${t.logo_url ? 'block' : 'none'}" />
          <span class="logo-fallback" style="display:${t.logo_url ? 'none' : 'flex'}">${t.emoji || '+'}</span>
        </button>
        <button type="button" class="logo-remove-btn" title="Remove logo" style="display:${t.logo_url ? 'inline-block' : 'none'}">&times;</button>
        <input type="file" accept="image/*" class="legacy-logo-file-input" hidden />
      </div>
      <input type="text" value="${t.name}" class="legacy-name-input" />
      <button type="button" class="legacy-remove-btn">Remove team</button>
    </div>
  `).join('');

  listEl.querySelectorAll('.legacy-team-row').forEach((row) => {
    const legacyTeamId = row.dataset.legacyTeamId;
    const colorInput = row.querySelector('.legacy-color-input');
    const nameInput = row.querySelector('.legacy-name-input');
    const save = () => {
      if (!unlocked) return;
      saveLegacyTeamFields(legacyTeamId, { color: colorInput.value, name: nameInput.value });
    };
    colorInput.addEventListener('input', save);
    nameInput.addEventListener('input', save);

    const uploadBtn = row.querySelector('.logo-upload-btn');
    const removeLogoBtn = row.querySelector('.logo-remove-btn');
    const fileInput = row.querySelector('.legacy-logo-file-input');
    const previewImg = row.querySelector('.logo-preview');
    const fallbackSpan = row.querySelector('.logo-fallback');
    uploadBtn.addEventListener('click', () => { if (unlocked) fileInput.click(); });
    fileInput.addEventListener('change', () => {
      if (fileInput.files[0]) handleLegacyLogoUpload(fileInput.files[0], legacyTeamId, previewImg, fallbackSpan, removeLogoBtn);
    });
    removeLogoBtn.addEventListener('click', async () => {
      if (!unlocked) return;
      previewImg.style.display = 'none'; previewImg.src = '';
      fallbackSpan.style.display = 'flex'; removeLogoBtn.style.display = 'none';
      await saveLegacyTeamFields(legacyTeamId, { logo_url: null });
    });

    row.querySelector('.legacy-remove-btn').addEventListener('click', async () => {
      if (!unlocked) return;
      if (!confirm(`Remove "${nameInput.value}"? This can't be undone, and any historical matchup results using this team will break.`)) return;
      await sb.from('legacy_teams').delete().eq('id', legacyTeamId);
      loadLegacyTeams();
      loadLegacyMatchupForm();
    });
  });

  updateLockUI();
  loadLegacyMatchupForm();
}

async function saveLegacyTeamFields(legacyTeamId, fields) {
  const { error } = await sb.from('legacy_teams').update(fields).eq('id', legacyTeamId);
  savedNote.textContent = error ? 'Failed to save: ' + error.message : 'Saved \u2713';
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => (savedNote.textContent = ''), 1800);
}

async function handleLegacyLogoUpload(file, legacyTeamId, previewImg, fallbackSpan, removeBtn) {
  if (!file.type.startsWith('image/')) { alert('Please choose an image file.'); return; }
  const objectUrl = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    URL.revokeObjectURL(objectUrl);
    const canvas = resizeImageToSquare(img, LOGO_SIZE);
    canvas.toBlob(async (blob) => {
      if (!blob) { alert('Could not process that image.'); return; }
      const path = `legacy-${legacyTeamId}.png`;
      const { error: uploadError } = await sb.storage.from('team-logos').upload(path, blob, { upsert: true, contentType: 'image/png' });
      if (uploadError) { alert('Upload failed: ' + uploadError.message); return; }
      const { data: publicUrlData } = sb.storage.from('team-logos').getPublicUrl(path);
      const bustedUrl = `${publicUrlData.publicUrl}?t=${Date.now()}`;
      previewImg.src = bustedUrl; previewImg.style.display = 'block';
      fallbackSpan.style.display = 'none'; removeBtn.style.display = 'inline-block';
      await saveLegacyTeamFields(legacyTeamId, { logo_url: bustedUrl });
    }, 'image/png');
  };
  img.onerror = () => { URL.revokeObjectURL(objectUrl); alert('Could not load that image -- try a different file.'); };
  img.src = objectUrl;
}

document.getElementById('addLegacyTeamBtn').addEventListener('click', async () => {
  if (!unlocked) return;
  const leagueId = leagueSelect.value;
  const { error } = await sb.from('legacy_teams').insert({ league_id: leagueId, name: 'New Team', color: '#888888' });
  if (error) { alert('Could not add team: ' + error.message); return; }
  loadLegacyTeams();
});

async function loadLegacyMatchupForm() {
  const leagueId = leagueSelect.value;
  // Offers BOTH still-active teams and historical/defunct ones -- a
  // legacy-year matchup commonly involves one of each, not just two
  // defunct teams. Each option's value is prefixed with its source
  // ("live:" or "legacy:") so the submit handler knows which column to
  // write the selected id into.
  const [{ data: liveTeams }, { data: legacyTeams }] = await Promise.all([
    sb.from('teams').select('id, espn_team_name, team_settings(display_name)').eq('league_id', leagueId).order('espn_team_name'),
    sb.from('legacy_teams').select('id, name').eq('league_id', leagueId).order('name'),
  ]);
  const liveOptions = (liveTeams || [])
    .map((t) => `<option value="live:${t.id}">${(t.team_settings && t.team_settings.display_name) || t.espn_team_name}</option>`)
    .join('');
  const legacyOptions = (legacyTeams || [])
    .map((t) => `<option value="legacy:${t.id}">${t.name}</option>`)
    .join('');
  const combined = `
    <optgroup label="Active teams">${liveOptions}</optgroup>
    <optgroup label="Historical / defunct teams">${legacyOptions}</optgroup>
  `;
  document.getElementById('legacyHomeTeamSelect').innerHTML = combined;
  document.getElementById('legacyAwayTeamSelect').innerHTML = combined;
}

document.getElementById('addLegacyMatchupBtn').addEventListener('click', async () => {
  if (!unlocked) return;
  const leagueId = leagueSelect.value;
  const year = Number(document.getElementById('legacyYearInput').value);
  const week = Number(document.getElementById('legacyWeekInput').value);
  const homeSelected = document.getElementById('legacyHomeTeamSelect').value; // "live:<id>" or "legacy:<id>"
  const awaySelected = document.getElementById('legacyAwayTeamSelect').value;
  const homeScore = Number(document.getElementById('legacyHomeScoreInput').value);
  const awayScore = Number(document.getElementById('legacyAwayScoreInput').value);

  if (!year || !week || !homeSelected || !awaySelected || Number.isNaN(homeScore) || Number.isNaN(awayScore)) {
    alert('Fill in year, week, both teams, and both scores.'); return;
  }
  if (homeSelected === awaySelected) { alert('Home and away team must be different.'); return; }

  const [homeSource, homeId] = homeSelected.split(':');
  const [awaySource, awayId] = awaySelected.split(':');
  const payload = {
    league_id: leagueId, year, week, home_score: homeScore, away_score: awayScore,
    home_legacy_team_id: homeSource === 'legacy' ? homeId : null,
    home_live_team_id: homeSource === 'live' ? homeId : null,
    away_legacy_team_id: awaySource === 'legacy' ? awayId : null,
    away_live_team_id: awaySource === 'live' ? awayId : null,
  };

  const { error } = await sb.from('legacy_matchups').insert(payload);
  if (error) { alert('Could not add result: ' + error.message); return; }

  document.getElementById('legacyHomeScoreInput').value = '';
  document.getElementById('legacyAwayScoreInput').value = '';
  loadLegacyMatchupList();
});

async function loadLegacyMatchupList() {
  const leagueId = leagueSelect.value;
  const [{ data: matchups, error }, { data: liveTeams }, { data: legacyTeams }] = await Promise.all([
    sb.from('legacy_matchups')
      .select('id, year, week, home_legacy_team_id, away_legacy_team_id, home_live_team_id, away_live_team_id, home_score, away_score')
      .eq('league_id', leagueId).order('year', { ascending: false }).order('week'),
    sb.from('teams').select('id, espn_team_name, team_settings(display_name)').eq('league_id', leagueId),
    sb.from('legacy_teams').select('id, name').eq('league_id', leagueId),
  ]);
  const listEl = document.getElementById('legacyMatchupList');
  if (error) { listEl.textContent = 'Error: ' + error.message; return; }

  // One combined lookup covering both sources -- a matchup row only ever
  // has ONE of the two id columns set per side, so looking a resolved id
  // up here works regardless of which table it actually came from.
  const nameById = {};
  (liveTeams || []).forEach((t) => (nameById[t.id] = (t.team_settings && t.team_settings.display_name) || t.espn_team_name));
  (legacyTeams || []).forEach((t) => (nameById[t.id] = t.name));

  const grouped = {};
  (matchups || []).forEach((m) => {
    const key = `${m.year} — Week ${m.week}`;
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push({
      id: m.id,
      homeId: m.home_legacy_team_id || m.home_live_team_id,
      awayId: m.away_legacy_team_id || m.away_live_team_id,
      home_score: m.home_score, away_score: m.away_score,
    });
  });

  listEl.innerHTML = Object.entries(grouped).map(([label, rows]) => `
    <div class="legacy-matchup-week-group">${label}</div>
    ${rows.map((m) => `
      <div class="legacy-matchup-row" data-matchup-id="${m.id}">
        <span>${nameById[m.homeId] || '?'} ${m.home_score} &ndash; ${m.away_score} ${nameById[m.awayId] || '?'}</span>
        <button type="button" class="legacy-remove-btn legacy-remove-matchup-btn">Remove</button>
      </div>
    `).join('')}
  `).join('') || '<div class="sub">No historical results entered yet.</div>';

  listEl.querySelectorAll('.legacy-remove-matchup-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!unlocked) return;
      const row = btn.closest('.legacy-matchup-row');
      await sb.from('legacy_matchups').delete().eq('id', row.dataset.matchupId);
      loadLegacyMatchupList();
    });
  });
}
