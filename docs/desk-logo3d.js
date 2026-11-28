// desk-logo3d.js -- 3D metallic team-logo cinematics for the News Desk.
//
// Each team's logo becomes a sculpted emblem, the way TV graphics packages do
// it: every color region of the logo is raised with rounded edges (a relief
// generated from the logo image itself), finished as glossy enamel, and set
// into a single polished chrome rim that follows the outline. Logos on a
// solid square background become a rounded chrome-rimmed badge.
//
// The set stays quiet so the emblem is the star: two angled walls in each
// team's color with faint facets and a softly glowing plus-sign grid, a soft
// top-left glow, and a dark glossy floor that reflects it all.
//
//   Logo3D.warm()              -> builds the renderer and stage ahead of time (call when idle)
//   Logo3D.prepare(teams)      -> traces and builds those teams' emblems ahead of time
//   await Logo3D.play(hostEl, { mode: 'single' | 'versus' | 'champion', teams: [{ id, name, color, logoUrl, emoji }], ms })
//   Logo3D.supported()         -> false where WebGL isn't available (callers keep the flat look)
//
// Everything heavy (loading Three.js, building the renderer, compiling
// shaders, tracing logos) happens once, in small pieces while the page is
// idle, and is reused. Nothing renders except during a cinematic.
(function () {
  'use strict';
  let libs = null;
  async function loadLibs() {
    if (libs) return libs;
    const [THREE, { RoomEnvironment }, { EffectComposer }, { RenderPass }, { UnrealBloomPass }, { OutputPass }] = await Promise.all([
      import('three'),
      import('three/addons/environments/RoomEnvironment.js'),
      import('three/addons/postprocessing/EffectComposer.js'),
      import('three/addons/postprocessing/RenderPass.js'),
      import('three/addons/postprocessing/UnrealBloomPass.js'),
      import('three/addons/postprocessing/OutputPass.js'),
    ]);
    libs = { THREE, RoomEnvironment, EffectComposer, RenderPass, UnrealBloomPass, OutputPass };
    return libs;
  }
  let canGL = null;
  function supported() {
    if (tierName === 'off') return false;
    if (canGL !== null) return canGL;
    try { const c = document.createElement('canvas'); canGL = !!(c.getContext('webgl2') || c.getContext('webgl')); } catch (e) { canGL = false; }
    return canGL;
  }
  // ---------------------------------------------------------------- quality tiers
  // full: TVs and computers (unchanged look). lite: phones and low-memory
  // devices -- about a quarter of the pixels (the browser scales the canvas
  // up), no bloom buffers (the glow and plus grid are drawn as light, so
  // they still glow), lighter metal materials, half-size logo textures, and
  // only the logos about to be shown are kept (at most 4). off: flat logos.
  //
  // Crash safety: a phone browser kills a tab that uses too much graphics
  // memory and reloads it. A flag is saved while the 3D is building or
  // playing and cleared on a normal exit (pagehide); if the page starts with
  // the flag still set, the last attempt died, so it drops a tier (full ->
  // lite -> off) and remembers that on this device. A lost WebGL context or
  // a cinematic running too slowly also drop a tier.
  // ?3d=full|lite|off in the URL forces one (and isn't remembered).
  const TIERS = {
    full: { W: 1920, H: 1080, aa: true, bloom: true, physical: true, tex: 512, bevel: 4, curve: 6, keep: Infinity, preloadAll: true },
    lite: { W: 1024, H: 576, aa: false, bloom: false, physical: false, tex: 256, bevel: 2, curve: 4, keep: 4, preloadAll: false },
  };
  const STORE = 'winProbDesk3D';
  const readStore = () => { try { return JSON.parse(localStorage.getItem(STORE) || '{}') || {}; } catch (e) { return {}; } };
  const writeStore = (o) => { try { localStorage.setItem(STORE, JSON.stringify(o)); } catch (e) { /* private mode */ } };
  const forced = (() => { const q = new URLSearchParams(location.search).get('3d'); return q === 'full' || q === 'lite' || q === 'off' ? q : null; })();
  const lower = (t) => (t === 'full' ? 'lite' : 'off');
  let tierName = (() => {
    if (forced) return forced;
    const st = readStore();
    if (st.busy) { st.tier = lower(st.tier || defaultTier()); st.busy = false; writeStore(st); console.warn('3D logos: the last attempt did not finish, using', st.tier); }
    return st.tier || defaultTier();
  })();
  function defaultTier() {
    const phone = (window.matchMedia && matchMedia('(pointer: coarse)').matches) || /iPhone|iPad|iPod|Android|Mobile/i.test(navigator.userAgent || '');
    const lowMem = navigator.deviceMemory && navigator.deviceMemory <= 4;
    return phone || lowMem ? 'lite' : 'full';
  }
  function setBusy(on) { if (forced) return; const st = readStore(); st.tier = tierName; st.busy = on; writeStore(st); }
  function downgrade(why) {
    if (forced || tierName === 'off') return;
    tierName = lower(tierName);
    const st = readStore(); st.tier = tierName; st.busy = false; writeStore(st);
    console.warn('3D logos:', why, '-> now', tierName);
  }
  addEventListener('pagehide', () => { const st = readStore(); if (st.busy) { st.busy = false; writeStore(st); } });
  const T = () => TIERS[tierName] || TIERS.lite;

  // Wait for a quiet moment so building things never interrupts an animation.
  const idle = () => new Promise((r) => (window.requestIdleCallback ? requestIdleCallback(() => r(), { timeout: 1500 }) : setTimeout(r, 60)));

  // ---------------------------------------------------------------- logo -> outline
  const N = 192; // trace resolution
  function loadImage(src) {
    return new Promise((res) => { if (!src) return res(null); const im = new Image(); im.crossOrigin = 'anonymous'; im.onload = () => res(im); im.onerror = () => res(null); im.src = src; setTimeout(() => res(null), 7000); });
  }
  async function logoCanvas(team) {
    const cv = document.createElement('canvas'); cv.width = cv.height = 512;
    const x = cv.getContext('2d');
    const img = await loadImage(team.logoUrl);
    if (img) { const k = Math.min(480 / img.width, 480 / img.height), w = img.width * k, h = img.height * k; x.drawImage(img, (512 - w) / 2, (512 - h) / 2, w, h); }
    else if (team.emoji) { x.font = '400px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(team.emoji, 256, 280); }
    else { // initials badge
      x.fillStyle = team.color || '#3355aa'; x.beginPath(); x.arc(256, 256, 230, 0, 7); x.fill();
      x.fillStyle = '#fff'; x.font = '800 200px Inter, sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
      x.fillText(String(team.name || '?').split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase(), 256, 266);
    }
    return cv;
  }
  // Binary mask at N x N from alpha; if the logo has no transparent border (a square photo/badge) use a rounded square.
  function mask(cv) {
    const s = document.createElement('canvas'); s.width = s.height = N; const x = s.getContext('2d', { willReadFrequently: true });
    x.drawImage(cv, 0, 0, N, N);
    const d = x.getImageData(0, 0, N, N).data, m = new Uint8Array(N * N);
    let opaqueEdge = 0, edge = 0;
    for (let i = 0; i < N * N; i++) {
      m[i] = d[i * 4 + 3] > 60 ? 1 : 0;
      const px = i % N, py = (i / N) | 0;
      if (px < 6 || py < 6 || px > N - 7 || py > N - 7) { edge++; if (m[i]) opaqueEdge++; }
    }
    if (opaqueEdge / edge > 0.6) return { m: null, square: true };
    // Close tiny gaps so the outline is one solid piece: dilate twice.
    let cur = m;
    for (let k = 0; k < 2; k++) {
      const nx = new Uint8Array(N * N);
      for (let y = 1; y < N - 1; y++) for (let x2 = 1; x2 < N - 1; x2++) { const i = y * N + x2; nx[i] = cur[i] | cur[i - 1] | cur[i + 1] | cur[i - N] | cur[i + N]; }
      cur = nx;
    }
    return { m: cur, square: false };
  }
  function dilate(m, k) {
    let cur = m;
    for (let r = 0; r < k; r++) {
      const nx = new Uint8Array(N * N);
      for (let y = 1; y < N - 1; y++) for (let x = 1; x < N - 1; x++) { const i = y * N + x; nx[i] = cur[i] | cur[i - 1] | cur[i + 1] | cur[i - N] | cur[i + N] | cur[i - N - 1] | cur[i - N + 1] | cur[i + N - 1] | cur[i + N + 1]; }
      cur = nx;
    }
    return cur;
  }
  // Relief: every color region of the logo becomes a raised, rounded piece.
  // Region borders (a clear color change, or the logo's edge) are found, a
  // distance-from-border is computed (two-pass chamfer), and height rises
  // over a short bevel and flattens on top -- then turned into a normal map
  // so the lighting rolls over each shape and dips into the grooves between.
  function reliefNormal(cv, S) {
    const c = document.createElement('canvas'); c.width = c.height = S; const x = c.getContext('2d', { willReadFrequently: true });
    // A slight blur first, so fine drawing detail (fur, shading) doesn't
    // turn into dozens of little bumps -- only real color areas get raised.
    if ('filter' in x) x.filter = `blur(${(S / 512 * 1.4).toFixed(2)}px)`;
    x.drawImage(cv, 0, 0, S, S);
    x.filter = 'none';
    const img = x.getImageData(0, 0, S, S), d = img.data, n = S * S, INF = 1e6, dist = new Float32Array(n);
    const diff = (i, j) => Math.abs(d[i * 4] - d[j * 4]) + Math.abs(d[i * 4 + 1] - d[j * 4 + 1]) + Math.abs(d[i * 4 + 2] - d[j * 4 + 2]);
    for (let y = 0; y < S; y++) for (let xx = 0; xx < S; xx++) {
      const i = y * S + xx;
      if (d[i * 4 + 3] < 128) { dist[i] = 0; continue; }
      let edge = xx === 0 || y === 0 || xx === S - 1 || y === S - 1;
      if (!edge) for (const j of [i - 1, i + 1, i - S, i + S]) if (d[j * 4 + 3] < 128 || diff(i, j) > 70) { edge = true; break; }
      dist[i] = edge ? 0 : INF;
    }
    const D = Math.SQRT2;
    for (let y = 0; y < S; y++) for (let xx = 0; xx < S; xx++) { const i = y * S + xx; let v = dist[i]; if (!v) continue;
      if (xx > 0) v = Math.min(v, dist[i - 1] + 1); if (y > 0) { v = Math.min(v, dist[i - S] + 1); if (xx > 0) v = Math.min(v, dist[i - S - 1] + D); if (xx < S - 1) v = Math.min(v, dist[i - S + 1] + D); } dist[i] = v; }
    for (let y = S - 1; y >= 0; y--) for (let xx = S - 1; xx >= 0; xx--) { const i = y * S + xx; let v = dist[i]; if (!v) continue;
      if (xx < S - 1) v = Math.min(v, dist[i + 1] + 1); if (y < S - 1) { v = Math.min(v, dist[i + S] + 1); if (xx < S - 1) v = Math.min(v, dist[i + S + 1] + D); if (xx > 0) v = Math.min(v, dist[i + S - 1] + D); } dist[i] = v; }
    const R = Math.max(3, S * 0.014), h = new Float32Array(n);
    for (let i = 0; i < n; i++) { const t = Math.min(1, dist[i] / R); h[i] = 1 - (1 - t) * (1 - t); }
    const out = x.createImageData(S, S), o = out.data, str = R * 0.9;
    for (let y = 0; y < S; y++) for (let xx = 0; xx < S; xx++) {
      const i = y * S + xx;
      const dx = (h[xx < S - 1 ? i + 1 : i] - h[xx > 0 ? i - 1 : i]) / 2, dy = (h[y < S - 1 ? i + S : i] - h[y > 0 ? i - S : i]) / 2;
      let nx = -dx * str, ny = dy * str, nz = 1; const l = Math.hypot(nx, ny, nz); nx /= l; ny /= l; nz /= l;
      o[i * 4] = (nx * 0.5 + 0.5) * 255; o[i * 4 + 1] = (ny * 0.5 + 0.5) * 255; o[i * 4 + 2] = (nz * 0.5 + 0.5) * 255; o[i * 4 + 3] = 255;
    }
    x.putImageData(out, 0, 0);
    return c;
  }
  // Largest outer contour (Moore-neighbour trace), simplified (Ramer-Douglas-Peucker).
  function contour(m) {
    const at = (x, y) => (x >= 0 && y >= 0 && x < N && y < N ? m[y * N + x] : 0);
    const seen = new Uint8Array(N * N); let best = null;
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      if (!at(x, y) || at(x - 1, y)) continue; const key = y * N + x; if (seen[key]) continue;
      const pts = []; let cx = x, cy = y, dir = 0; const DX = [1, 1, 0, -1, -1, -1, 0, 1], DY = [0, 1, 1, 1, 0, -1, -1, -1];
      for (let step = 0; step < N * N * 2; step++) {
        pts.push([cx, cy]); seen[cy * N + cx] = 1;
        let found = false;
        for (let k = 0; k < 8; k++) { const d = (dir + 6 + k) % 8, nx = cx + DX[d], ny = cy + DY[d]; if (at(nx, ny)) { cx = nx; cy = ny; dir = d; found = true; break; } }
        if (!found || (cx === x && cy === y && pts.length > 2)) break;
      }
      if (!best || pts.length > best.length) best = pts;
    }
    if (!best || best.length < 12) return null;
    const rdp = (pts, eps) => {
      if (pts.length < 3) return pts;
      const [a, b] = [pts[0], pts[pts.length - 1]]; let idx = 0, dmax = 0;
      for (let i = 1; i < pts.length - 1; i++) { const p = pts[i]; const num = Math.abs((b[1] - a[1]) * p[0] - (b[0] - a[0]) * p[1] + b[0] * a[1] - b[1] * a[0]); const den = Math.hypot(b[1] - a[1], b[0] - a[0]) || 1; const dd = num / den; if (dd > dmax) { dmax = dd; idx = i; } }
      if (dmax > eps) { const l = rdp(pts.slice(0, idx + 1), eps), r = rdp(pts.slice(idx), eps); return l.slice(0, -1).concat(r); }
      return [a, b];
    };
    let out = rdp(best, 1.1);
    // Round off the pixel steps (Chaikin corner cutting, twice) so edges read as smooth curves.
    for (let it = 0; it < 2; it++) {
      const sm = [];
      for (let i = 0; i < out.length; i++) { const a = out[i], b = out[(i + 1) % out.length]; sm.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25], [a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]); }
      out = sm;
    }
    return out;
  }

  // ---------------------------------------------------------------- engine (built once)
  let E = null, warming = null;
  // Shared materials: brushed chrome (soft highlights, not mirror-bright), gold for the champion.
  // Lite uses the standard (no clear-coat) material: much cheaper shaders on a
  // phone, and with the studio reflections it still reads as polished metal.
  const metalMat = (THREE, o) => (T().physical ? new THREE.MeshPhysicalMaterial(Object.assign({ clearcoat: 0.35, clearcoatRoughness: 0.25 }, o)) : new THREE.MeshStandardMaterial(Object.assign({}, o, { roughness: Math.max(0.24, o.roughness - 0.06) })));
  function makeMaterials(THREE) {
    return {
      chrome: metalMat(THREE, { color: 0xe8edf5, metalness: 1, roughness: 0.3, envMapIntensity: 1.1 }),
      gold: metalMat(THREE, { color: 0xd9a843, metalness: 1, roughness: 0.3, envMapIntensity: 0.8 }),
    };
  }
  // Glossy enamel: the logo's own colors, with the relief's normal map so
  // highlights follow every raised shape (the clear coat follows it too).
  const faceMat = (THREE, tex, nrm) => (T().physical
    ? new THREE.MeshPhysicalMaterial({ map: tex, normalMap: nrm, metalness: 0.3, roughness: 0.32, clearcoat: 0.8, clearcoatRoughness: 0.12, clearcoatNormalMap: nrm, envMapIntensity: 0.85, transparent: true, alphaTest: 0.05 })
    : new THREE.MeshStandardMaterial({ map: tex, normalMap: nrm, metalness: 0.3, roughness: 0.3, envMapIntensity: 0.85, transparent: true, alphaTest: 0.05 }));

  // Wall art (grayscale, tinted by the wall material): faint triangular
  // facets lit from the top left. A second texture holds a grid of small plus
  // signs that glow softly (the emissive map), fading out toward the middle.
  function wallTextures(THREE) {
    const W = 1024, H = 640;
    const a = document.createElement('canvas'); a.width = W; a.height = H; const x = a.getContext('2d');
    const g = x.createLinearGradient(0, 0, W, H); g.addColorStop(0, '#d8d8d8'); g.addColorStop(0.5, '#8c8c8c'); g.addColorStop(1, '#4a4a4a'); x.fillStyle = g; x.fillRect(0, 0, W, H);
    let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const side = 110, hgt = side * 0.866;
    for (let row = -1; row * hgt < H + hgt; row++) for (let col = -1; col * side < W + side; col++) {
      const x0 = col * side + (row % 2 ? side / 2 : 0), y0 = row * hgt;
      for (const up of [true, false]) {
        x.beginPath();
        if (up) { x.moveTo(x0, y0 + hgt); x.lineTo(x0 + side / 2, y0); x.lineTo(x0 + side, y0 + hgt); }
        else { x.moveTo(x0 + side / 2, y0); x.lineTo(x0 + side * 1.5, y0); x.lineTo(x0 + side, y0 + hgt); }
        x.closePath();
        const v = rnd(); x.fillStyle = v > 0.5 ? `rgba(255,255,255,${(v - 0.5) * 0.12})` : `rgba(0,0,0,${(0.5 - v) * 0.16})`; x.fill();
        x.strokeStyle = 'rgba(255,255,255,.045)'; x.lineWidth = 1.5; x.stroke();
      }
    }
    const b = document.createElement('canvas'); b.width = W; b.height = H; const y = b.getContext('2d');
    y.fillStyle = '#000'; y.fillRect(0, 0, W, H);
    y.lineCap = 'round'; y.shadowColor = '#fff'; y.shadowBlur = 6;
    for (let gx = 60; gx < W * 0.42; gx += 84) for (let gy = 60; gy < H - 40; gy += 84) {
      const fade = Math.pow(Math.max(0, 1 - gx / (W * 0.42)), 1.3) * (0.45 + 0.55 * (1 - gy / H));
      if (fade < 0.06) continue;
      y.strokeStyle = `rgba(255,255,255,${fade.toFixed(2)})`; y.lineWidth = 2.2;
      y.beginPath(); y.moveTo(gx - 8, gy); y.lineTo(gx + 8, gy); y.moveTo(gx, gy - 8); y.lineTo(gx, gy + 8); y.stroke();
    }
    const t1 = new THREE.CanvasTexture(a), t2 = new THREE.CanvasTexture(b);
    t1.colorSpace = THREE.SRGBColorSpace; t2.colorSpace = THREE.SRGBColorSpace; t1.anisotropy = t2.anisotropy = 4;
    return { facets: t1, pluses: t2 };
  }
  function glowTexture(THREE) {
    const cv = document.createElement('canvas'); cv.width = cv.height = 128; const x = cv.getContext('2d');
    const g = x.createRadialGradient(64, 64, 0, 64, 64, 64); g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.3, 'rgba(200,220,255,.45)'); g.addColorStop(1, 'rgba(160,190,255,0)'); x.fillStyle = g; x.fillRect(0, 0, 128, 128);
    const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; return t;
  }

  function buildStage(L3, mats) {
    const { THREE } = L3;
    const FLOOR = -1.15;
    const stage = new THREE.Group(); // the walls (reflected in the floor)
    const tx = wallTextures(THREE);
    const walls = [];
    const wallGeo = new THREE.PlaneGeometry(7.2, 4.4);
    for (const side of [-1, 1]) {
      const th = side < 0 ? 0.62 : -0.62; // the two walls form a V, meeting at the back
      const holder = new THREE.Group(); holder.position.set(side * 2.75, FLOOR + 2.2, -2.7); holder.rotation.y = th;
      const mat = new THREE.MeshStandardMaterial({ map: tx.facets, emissiveMap: tx.pluses, color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.75, roughness: 0.6, metalness: 0.1 });
      if (side > 0) { mat.map = tx.facets.clone(); mat.map.repeat.x = -1; mat.map.wrapS = THREE.RepeatWrapping; mat.emissiveMap = tx.pluses.clone(); mat.emissiveMap.repeat.x = -1; mat.emissiveMap.wrapS = THREE.RepeatWrapping; mat.map.needsUpdate = mat.emissiveMap.needsUpdate = true; } // mirrored: plus grids on the outer edges
      const wall = new THREE.Mesh(wallGeo, mat); holder.add(wall); walls.push(wall);
      stage.add(holder);
    }

    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x030714, 0.045);
    { const bg = document.createElement('canvas'); bg.width = 2; bg.height = 256; const bx = bg.getContext('2d'); const gr = bx.createLinearGradient(0, 0, 0, 256); gr.addColorStop(0, '#1a2c5c'); gr.addColorStop(0.5, '#08112a'); gr.addColorStop(1, '#02040c'); bx.fillStyle = gr; bx.fillRect(0, 0, 2, 256); const bt = new THREE.CanvasTexture(bg); bt.colorSpace = THREE.SRGBColorSpace; scene.background = bt; }
    scene.add(stage);
    const emblems = new THREE.Group(); scene.add(emblems);
    // The floor reflection: a mirrored copy of the walls under a glossy, partly see-through floor.
    const mirror = new THREE.Group(); mirror.scale.y = -1; mirror.position.y = 2 * FLOOR; scene.add(mirror);
    mirror.add(stage.clone());
    const mirrorEmblems = new THREE.Group(); mirror.add(mirrorEmblems);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), new THREE.MeshStandardMaterial({ color: 0x03050c, metalness: 0.5, roughness: 0.3, transparent: true, opacity: 0.86, envMapIntensity: 0.35 }));
    floor.rotation.x = -Math.PI / 2; floor.position.y = FLOOR; scene.add(floor);
    const grid = new THREE.GridHelper(60, 90, 0x2b56b8, 0x14306e); grid.material.transparent = true; grid.material.opacity = 0.1; grid.material.depthWrite = false; grid.position.y = FLOOR + 0.004; scene.add(grid);
    // A soft glow up in the top left, where the key light comes from.
    const flare = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(THREE), color: 0xcfe0ff, transparent: true, opacity: 0.45, blending: THREE.AdditiveBlending, depthWrite: false }));
    flare.scale.set(6, 6, 1); flare.position.set(-3.6, FLOOR + 4.8, -4.2); scene.add(flare);
    // Lights: a soft key from the top left that drifts a little, team-colored fills.
    const key = new THREE.SpotLight(0xffffff, 6, 30, 0.6, 0.95); key.position.set(-5, 5, 6); scene.add(key, key.target);
    const fills = [-1, 1].map((sd) => { const l = new THREE.PointLight(0xffffff, 6, 9); l.position.set(sd * 2.6, 1.0, 1.4); scene.add(l); return l; });
    // A soft wash on the walls so their color reads, from up front.
    const wash = new THREE.DirectionalLight(0xdfe8ff, 1.1); wash.position.set(0, 3, 8); scene.add(wash);
    scene.add(new THREE.HemisphereLight(0x8090c0, 0x0a0a14, 0.8));
    return { scene, stage, emblems, mirrorEmblems, walls, flare, key, fills };
  }

  async function warm() {
    if (E) return E;
    if (warming) return warming;
    warming = (async () => {
      if (!supported()) return null;
      const L3 = await loadLibs();
      const { THREE, RoomEnvironment, EffectComposer, RenderPass, UnrealBloomPass, OutputPass } = L3;
      await idle();
      const Q = T(), W = Q.W, H = Q.H;
      setBusy(true);
      const renderer = new THREE.WebGLRenderer({ antialias: Q.aa, alpha: false, powerPreference: Q.bloom ? 'high-performance' : 'default' });
      renderer.setPixelRatio(1); renderer.setSize(W, H, false);
      renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 0.85; renderer.outputColorSpace = THREE.SRGBColorSpace;
      const cv = renderer.domElement; cv.className = 'logo3d-canvas';
      cv.addEventListener('webglcontextlost', (ev) => { ev.preventDefault(); E = null; warming = null; cache.clear(); downgrade('graphics context lost'); });
      await idle();
      const pmrem = new THREE.PMREMGenerator(renderer);
      const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture; pmrem.dispose();
      await idle();
      const mats = makeMaterials(THREE);
      const S = buildStage(L3, mats); S.scene.environment = env;
      const camera = new THREE.PerspectiveCamera(36, W / H, 0.1, 100); camera.position.set(0, 1, 8); camera.lookAt(0, 0.3, -0.5);
      // Full: render -> bloom -> output. Lite: straight to the screen (no
      // extra full-size buffers); a brighter flare makes up for the glow.
      let composer = null, bloom = null;
      if (Q.bloom) {
        composer = new EffectComposer(renderer);
        composer.addPass(new RenderPass(S.scene, camera));
        bloom = new UnrealBloomPass(new THREE.Vector2(W, H), 0.2, 0.35, 0.96); composer.addPass(bloom);
        composer.addPass(new OutputPass());
      } else { S.flare.material.opacity = 0.6; }
      const draw = composer ? () => composer.render() : () => renderer.render(S.scene, camera);
      // Compile every shader now (a stand-in emblem carries the emblem materials).
      const dummyTex = new THREE.CanvasTexture(document.createElement('canvas'));
      const box = new THREE.BoxGeometry(0.01, 0.01, 0.01);
      const stand = [mats.chrome, mats.gold, faceMat(THREE, dummyTex, dummyTex)].map((m) => new THREE.Mesh(box, m));
      S.emblems.add(...stand);
      await idle();
      if (renderer.compileAsync) await renderer.compileAsync(S.scene, camera); else renderer.compile(S.scene, camera);
      await idle();
      draw(); // first frame also sets up the glow passes
      S.emblems.remove(...stand);
      E = { L3, renderer, composer, draw, camera, bloom, mats, cv, ...S };
      setBusy(false);
      return E;
    })().catch((e) => { console.warn('3D logos unavailable', e); warming = null; setBusy(false); return null; });
    return warming;
  }

  // ---------------------------------------------------------------- emblems (cached per team)
  const cache = new Map();
  const keyOf = (t, gold) => [t.id || t.name, t.logoUrl || t.emoji || '', t.color || '', gold ? 'g' : ''].join('|');
  async function emblem(team, gold) {
    const k = keyOf(team, gold);
    if (cache.has(k)) { const p = cache.get(k); cache.delete(k); cache.set(k, p); return p; }
    const p = (async () => {
      const { THREE } = E.L3;
      const cv = await logoCanvas(team);
      await idle();
      const mk = mask(cv);
      const pts = mk.square ? null : contour(mk.m);
      const rimPts = mk.square ? null : contour(dilate(mk.m, 7)); // the chrome rim: the outline grown evenly
      await idle();
      const toShape = (p, grow) => {
        const sh = new THREE.Shape();
        if (p) p.forEach(([x, y], i) => { const u = x / N, v = 1 - y / N; if (i) sh.lineTo(u, v); else sh.moveTo(u, v); });
        else { const a = -grow, b = 1 + grow, r = 0.12 + grow; sh.moveTo(a + r, a); sh.lineTo(b - r, a); sh.quadraticCurveTo(b, a, b, a + r); sh.lineTo(b, b - r); sh.quadraticCurveTo(b, b, b - r, b); sh.lineTo(a + r, b); sh.quadraticCurveTo(a, b, a, b - r); sh.lineTo(a, a + r); sh.quadraticCurveTo(a, a, a + r, a); }
        return sh;
      };
      const faceShape = toShape(pts, 0), rimShape = toShape(rimPts || (pts ? null : null), rimPts ? 0 : 0.035);
      const size = T().tex;
      let texCv = cv;
      if (size < cv.width) { texCv = document.createElement('canvas'); texCv.width = texCv.height = size; texCv.getContext('2d').drawImage(cv, 0, 0, size, size); }
      const tex = new THREE.CanvasTexture(texCv); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = T().bloom ? 4 : 1;
      const nrm = new THREE.CanvasTexture(reliefNormal(cv, size)); nrm.anisotropy = tex.anisotropy; // linear data, not a color
      await idle();
      const metal = gold ? E.mats.gold : E.mats.chrome;
      const seg = { bevelSegments: T().bevel, curveSegments: T().curve };
      const geo = new THREE.ExtrudeGeometry(faceShape, Object.assign({ depth: 0.06, bevelEnabled: true, bevelThickness: 0.012, bevelSize: 0.006 }, seg));
      const geo2 = new THREE.ExtrudeGeometry(rimShape, Object.assign({ depth: 0.12, bevelEnabled: true, bevelThickness: 0.035, bevelSize: 0.022 }, seg, { bevelSegments: T().bevel + 1 }));
      // Same centering for both (the rim grows evenly, so its box shares the face's center).
      geo2.computeBoundingBox(); const c0 = new THREE.Vector3(); geo2.boundingBox.getCenter(c0);
      geo.translate(-c0.x, -c0.y, 0); geo2.translate(-c0.x, -c0.y, -0.1);
      // The enamel face sits just proud of the rim, the rim's chrome shows as an even border.
      const front = new THREE.Mesh(geo, [faceMat(THREE, tex, nrm), metal]);
      const rim = new THREE.Mesh(geo2, metal);
      const g = new THREE.Group(); g.add(rim, front);
      // Free this emblem's own GPU memory (the shared metal stays).
      g.userData.dispose = () => { geo.dispose(); geo2.dispose(); tex.dispose(); nrm.dispose(); front.material[0].dispose(); };
      if (E.renderer.initTexture) E.renderer.initTexture(tex); // upload now, not on the first frame
      return g;
    })();
    cache.delete(k); cache.set(k, p); // most recently used last
    p.catch(() => cache.delete(k));
    trimCache();
    return p;
  }
  // Lite keeps only the last few emblems; older ones are freed.
  function trimCache() {
    const keep = T().keep;
    if (cache.size <= keep) return;
    for (const [k, p] of cache) {
      if (cache.size <= keep) break;
      cache.delete(k);
      p.then((g) => { if (!g.parent && g.userData.dispose) g.userData.dispose(); }).catch(() => {});
    }
  }
  // Build emblems for these teams in the background (one at a time, when idle).
  async function prepare(teams, gold) {
    if (!(await warm())) return false;
    for (const t of teams || []) if (t) { try { await emblem(t, gold); } catch (e) { /* skip */ } await idle(); }
    return true;
  }

  // ---------------------------------------------------------------- play
  let playing = false;
  async function play(host, opts) {
    if (!supported() || playing) return false;
    const e = await warm(); if (!e) return false;
    const { THREE } = e.L3;
    const mode = opts.mode || 'single', teams = (opts.teams || []).filter(Boolean), ms = opts.ms || 8000;
    const gold = mode === 'champion';
    const list = mode === 'versus' ? teams.slice(0, 2) : teams.slice(0, 1);
    const groups = [];
    for (const t of list) groups.push(await emblem(t, gold));
    playing = true;
    setBusy(true);
    // Team colors on the set.
    const col = (i) => new THREE.Color(gold ? '#e0a93a' : ((list[i] || list[0] || {}).color || '#2f6bff'));
    const cL = col(0), cR = mode === 'versus' ? col(1) : gold ? new THREE.Color((list[0] || {}).color || '#e0a93a') : col(0);
    // Walls: the team color deepened toward navy; the plus grid glows a light tint of it.
    const navy = new THREE.Color('#0b1430'), white = new THREE.Color('#ffffff');
    [[e.walls[0], cL], [e.walls[1], cR]].forEach(([w, c]) => { w.material.color.copy(c).lerp(navy, 0.2); w.material.emissive.copy(c).lerp(white, 0.6); });
    e.fills[0].color.copy(cL).lerp(white, 0.4); e.fills[1].color.copy(cR).lerp(white, 0.4);
    // Place the emblems (and their reflections).
    e.emblems.clear(); e.mirrorEmblems.clear();
    if (mode === 'versus' && groups.length === 2) {
      groups[0].position.set(-1.95, 0.3, 1.0); groups[0].scale.setScalar(2.0);
      groups[1].position.set(1.95, 0.3, 1.0); groups[1].scale.setScalar(2.0);
    } else if (groups[0]) { groups[0].position.set(0, 0.45, 1.0); groups[0].scale.setScalar(2.5); }
    groups.forEach((g) => g.rotation.set(0, 0, 0));
    e.emblems.add(...groups); // (the set is reflected in the floor; the floating emblems aren't, which reads cleaner)

    const { camera, cv } = e;
    cv.style.opacity = 0; host.appendChild(cv);
    const t0 = performance.now();
    let frames = 0, last = 0, slow = 0; // frame-time watch: too slow -> lite next time
    const ease = (u) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);
    await new Promise((resolve) => {
      const frame = (now) => {
        const el = Math.max(0, now - t0), u = Math.min(1, el / ms), k = ease(u), s = el / 1000;
        // Camera: a slow push-in from low and wide, drifting across the set.
        const ang = -0.22 + k * 0.44, dist = 10.2 - k * 2.0;
        camera.position.set(Math.sin(ang) * dist, 0.7 + 0.7 * (1 - k), Math.cos(ang) * dist); camera.lookAt(0, 0.55, -1.2);
        groups.forEach((g, i) => {
          const base = mode === 'versus' ? (i ? -0.32 : 0.32) : -0.45 + k * 0.9;
          g.rotation.y = base + Math.sin(s * 0.7 + i * 2) * 0.06; g.rotation.x = -0.05 + Math.sin(s * 0.5 + i) * 0.03;
          g.position.y = (mode === 'versus' ? 0.3 : 0.45) + 0.05 * Math.sin(s * 1.1 + i);
        });
        e.key.position.set(-6 + k * 5, 5, 6); // the highlight drifts slowly across the chrome
        e.flare.material.opacity = (T().bloom ? 0.42 : 0.55) + 0.06 * Math.sin(s * 1.3);
        const fade = Math.min(1, el / 500, (ms - el) / 600); cv.style.opacity = Math.max(0, fade);
        e.draw();
        if (last && ++frames > 10) { if (now - last > 45) slow++; }
        last = now;
        if (opts.onFrame) opts.onFrame(u, cv); // test hook (read the canvas right after rendering)
        if (u < 1) requestAnimationFrame(frame); else resolve();
      };
      requestAnimationFrame(frame);
    });
    cv.remove();
    e.emblems.clear(); e.mirrorEmblems.clear();
    playing = false;
    setBusy(false);
    trimCache();
    // Mostly under ~22 fps on this device: use the lighter version next time.
    if (tierName === 'full' && frames > 40 && slow / frames > 0.5) downgrade('running slowly');
    return true;
  }

  window.Logo3D = { play, supported, warm, prepare, tier: () => tierName, preloadAll: () => T().preloadAll };
})();
