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

loadLeagues();
