const { url, anonKey } = window.SUPABASE_CONFIG;
const supabase = window.supabase.createClient(url, anonKey);

const leagueSelect = document.getElementById('leagueSelect');
const teamList = document.getElementById('teamList');
const savedNote = document.getElementById('savedNote');
let saveTimeout;

async function loadLeagues() {
  const { data, error } = await supabase.from('leagues').select('id, name').order('name');
  if (error) return;
  leagueSelect.innerHTML = data.map((l) => `<option value="${l.id}">${l.name}</option>`).join('');
  leagueSelect.onchange = loadTeams;
  if (data.length) loadTeams();
}

async function loadTeams() {
  const leagueId = leagueSelect.value;
  const { data, error } = await supabase
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
    const save = () => saveTeamSettings(teamId, colorInput.value, nameInput.value);
    colorInput.addEventListener('input', save);
    nameInput.addEventListener('input', save);
  });
}

async function saveTeamSettings(teamId, color, displayName) {
  const { error } = await supabase
    .from('team_settings')
    .upsert({ team_id: teamId, color, display_name: displayName }, { onConflict: 'team_id' });

  savedNote.textContent = error ? 'Failed to save: ' + error.message : 'Saved \u2713';
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => (savedNote.textContent = ''), 1800);
}

loadLeagues();
