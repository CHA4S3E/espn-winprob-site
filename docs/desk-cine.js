// desk-cine.js -- the News Desk's set cinematics: short clips rendered ahead
// of time for every team (scripts/render-cinematics.js, saved in
// cinematics/ next to this file) and played back as ordinary video. Every
// device gets the same full-quality look with no 3D work at all.
//
//   Cine.load()                         reads cinematics/manifest.json
//   Cine.has(mode, teams)               clips exist and match each team's current logo
//   Cine.preload(teams)                 starts fetching those teams' clips
//   await Cine.play(host, { mode: 'versus' | 'champion', teams, onShot })
//
// versus: team A's close-up, team B's close-up, then the wide shot -- team A's
// left half beside team B's right half (both clips use the same straight-on
// camera, so they meet cleanly where the two walls join). champion: the gold
// clip. A quick flash on every cut. Callers fall back to live 3D (Logo3D)
// when a team has no clip yet, e.g. right after a new logo upload.
(function () {
  'use strict';
  let manifest = null;
  async function load() {
    try { manifest = await (await fetch('cinematics/manifest.json?v=' + Math.floor(Date.now() / 3.6e6), { cache: 'no-cache' })).json(); } catch (e) { manifest = null; }
    return !!manifest;
  }
  const stampOf = (t) => (/[?&]t=(\d+)/.exec(t.logoUrl || '') || [])[1] || t.logoUrl || t.emoji || '';
  function clip(team, kind) {
    const e = manifest && team && manifest.teams[team.id];
    if (!e || !e[kind] || e.stamp !== stampOf(team)) return null; // missing, or the logo changed since it was rendered
    return e[kind];
  }
  const kindsFor = (mode) => (mode === 'champion' ? ['champion'] : ['closeup', 'wide']);
  function has(mode, teams) { return !!manifest && teams.length && teams.every((t) => kindsFor(mode).every((k) => clip(t, k))); }

  // One <video> per clip, kept around once fetched.
  const vids = new Map();
  function video(src) {
    let v = vids.get(src);
    if (!v) {
      v = document.createElement('video');
      v.muted = true; v.playsInline = true; v.preload = 'auto'; v.setAttribute('playsinline', ''); v.src = src;
      v.className = 'cine-v';
      vids.set(src, v);
      if (vids.size > 12) { const [k, old] = vids.entries().next().value; if (!old.isConnected) { old.removeAttribute('src'); old.load(); vids.delete(k); } }
    }
    return v;
  }
  function ready(v, ms) {
    return new Promise((res) => {
      if (v.readyState >= 3) return res(true);
      const done = (ok) => { v.removeEventListener('canplaythrough', on); clearTimeout(tm); res(ok); };
      const on = () => done(true), tm = setTimeout(() => done(v.readyState >= 2), ms);
      v.addEventListener('canplaythrough', on);
      v.load();
    });
  }
  function preload(teams, mode) { for (const t of teams || []) for (const k of kindsFor(mode || 'versus')) { const c = clip(t, k); if (c) video(c); } }

  async function play(host, opts) {
    const mode = opts.mode === 'champion' ? 'champion' : 'versus', teams = (opts.teams || []).filter(Boolean);
    if (!has(mode, mode === 'versus' ? teams.slice(0, 2) : teams.slice(0, 1))) return false;
    const shots = mode === 'versus'
      ? [{ src: [clip(teams[0], 'closeup')], caption: 0 }, { src: [clip(teams[1], 'closeup')], caption: 1 }, { src: [clip(teams[0], 'wide'), clip(teams[1], 'wide')], split: true, caption: 2 }]
      : Array.from({ length: Math.max(1, Math.round((opts.ms || 6000) / 6000)) }, () => ({ src: [clip(teams[0], 'champion')], caption: 0 })); // a longer finale loops the gold clip
    // Everything must be ready before the first frame shows (no stalls mid-cinematic).
    const all = shots.flatMap((s) => s.src.map(video));
    const ok = await Promise.all(all.map((v) => ready(v, 4000)));
    if (ok.some((x) => !x)) return false;
    const stage = document.createElement('div'); stage.className = 'cine';
    const flash = document.createElement('div'); flash.className = 'cine-flash';
    stage.appendChild(flash); host.appendChild(stage);
    requestAnimationFrame(() => stage.classList.add('on'));
    for (let i = 0; i < shots.length; i++) {
      const s = shots[i], layer = document.createElement('div'); layer.className = 'cine-shot';
      const vs = s.src.map(video);
      if (s.split) { // team A's left half | team B's right half
        vs.forEach((v, k) => { const half = document.createElement('div'); half.className = 'cine-half ' + (k ? 'r' : 'l'); half.appendChild(v); layer.appendChild(half); });
      } else layer.appendChild(vs[0]);
      vs.forEach((v) => { v.currentTime = 0; });
      stage.insertBefore(layer, flash);
      if (opts.onShot) opts.onShot(i, s.caption);
      if (i > 0) { flash.classList.remove('go'); void flash.offsetWidth; flash.classList.add('go'); }
      await Promise.all(vs.map((v) => v.play().catch(() => {})));
      await new Promise((res) => { const v = vs[0]; const end = () => { v.removeEventListener('ended', end); clearTimeout(tm); res(); }; const tm = setTimeout(end, (v.duration || 4) * 1000 + 600); v.addEventListener('ended', end); });
      if (i === shots.length - 1) { stage.classList.remove('on'); await new Promise((r) => setTimeout(r, 450)); }
      [...stage.querySelectorAll('.cine-shot')].forEach((el) => { if (el !== layer || i === shots.length - 1) el.remove(); });
    }
    stage.remove();
    return true;
  }

  window.Cine = { load, has, preload, play, get ready() { return !!manifest; } };
})();
