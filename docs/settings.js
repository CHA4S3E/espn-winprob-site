const { url, anonKey } = window.SUPABASE_CONFIG;
const sb = window.supabase.createClient(url, anonKey);

const leagueSelect = document.getElementById('leagueSelect');
const teamList = document.getElementById('teamList');
const savedNote = document.getElementById('savedNote');
const lockNote = document.getElementById('lockNote');
const lockText = document.getElementById('lockText');
const unlockBtn = document.getElementById('unlockBtn');
let saveTimeout;

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
  leagueSelect.onchange = loadTeams;
  if (data.length) loadTeams();
}

async function loadTeams() {
  const leagueId = leagueSelect.value;
  const { data, error } = await sb
    .from('teams')
    .select('id, espn_team_name, team_settings(color, display_name)')
    .eq('league_id', leagueId)
    .order('espn_team_name');

  if (error) { teamList.textContent = 'Error: ' + error.message; return; }

  teamList.innerHTML = data.map((t) => {
    const settings = t.team_settings || {};
    const color = settings.color || '#1a3fa0';
    const name = settings.display_name || t.espn_team_name;
    return `
      <div class="team-row" data-team-id="${t.id}">
        <input type="color" value="${color}" class="color-input" />
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
  });

  updateLockUI(); // apply current lock state to the freshly rendered inputs
}

async function saveTeamSettings(teamId, color, displayName) {
  const { error } = await sb
    .from('team_settings')
    .upsert({ team_id: teamId, color, display_name: displayName }, { onConflict: 'team_id' });

  savedNote.textContent = error ? 'Failed to save: ' + error.message : 'Saved \u2713';
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => (savedNote.textContent = ''), 1800);
}

loadLeagues();
