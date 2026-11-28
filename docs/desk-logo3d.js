// desk-logo3d.js -- 3D metallic team-logo cinematics for the News Desk.
//
// Each team's logo is traced (its transparent pixels give the outline) and
// extruded into a solid emblem: the logo art is the front face, the edges and a
// slightly larger back plate are brushed chrome. Logos on a solid square
// background become a rounded chrome badge; emoji logos work too.
//
// The set is a split stage: two angled walls meeting in the middle, each one
// striped in its team's color with marquee bulbs along the top, light rays
// from above, and a glossy floor that reflects it all.
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
  // up), no bloom buffers (the bulbs, rays and flare are additive light, so
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
      chrome: metalMat(THREE, { color: 0xc9d1de, metalness: 1, roughness: 0.32, envMapIntensity: 0.75 }),
      gold: metalMat(THREE, { color: 0xd9a843, metalness: 1, roughness: 0.3, envMapIntensity: 0.8 }),
    };
  }
  const faceMat = (THREE, tex) => (T().physical
    ? new THREE.MeshPhysicalMaterial({ map: tex, metalness: 0.2, roughness: 0.42, clearcoat: 0.3, clearcoatRoughness: 0.2, envMapIntensity: 0.6, transparent: true, alphaTest: 0.05 })
    : new THREE.MeshStandardMaterial({ map: tex, metalness: 0.2, roughness: 0.4, envMapIntensity: 0.6, transparent: true, alphaTest: 0.05 }));
  const glassMat = (THREE, color) => new THREE.MeshStandardMaterial({ color: new THREE.Color(color || '#3a6cff'), emissive: new THREE.Color(color || '#3a6cff'), emissiveIntensity: 0.25, metalness: 0.4, roughness: 0.35, envMapIntensity: 0.6 });

  // Grayscale wall art: diagonal stripes + panel lines. The wall material tints it with the team color.
  function stripeTexture(THREE) {
    const cv = document.createElement('canvas'); cv.width = 512; cv.height = 512; const x = cv.getContext('2d');
    const g = x.createLinearGradient(0, 0, 0, 512); g.addColorStop(0, '#9a9a9a'); g.addColorStop(1, '#4a4a4a'); x.fillStyle = g; x.fillRect(0, 0, 512, 512);
    x.save(); x.translate(256, 256); x.rotate(-0.62); x.translate(-512, -512);
    const bands = [[120, 70, '#ffffff'], [230, 36, '#d8d8d8'], [330, 110, '#2a2a2a'], [520, 64, '#f0f0f0'], [620, 24, '#ffffff'], [700, 120, '#3a3a3a'], [880, 50, '#e6e6e6']];
    for (const [y, h, c] of bands) { x.fillStyle = c; x.globalAlpha = 0.85; x.fillRect(0, y, 1024, h); }
    x.restore(); x.globalAlpha = 1;
    x.strokeStyle = 'rgba(0,0,0,.35)'; x.lineWidth = 3; for (let i = 64; i < 512; i += 128) { x.beginPath(); x.moveTo(i, 0); x.lineTo(i, 512); x.stroke(); }
    x.strokeStyle = 'rgba(255,255,255,.5)'; x.lineWidth = 10; x.strokeRect(5, 5, 502, 502);
    const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t;
  }
  function glowTexture(THREE, kind) {
    const cv = document.createElement('canvas'); cv.width = 128; cv.height = kind === 'ray' ? 512 : 128; const x = cv.getContext('2d');
    if (kind === 'ray') { const g = x.createLinearGradient(0, 0, 0, 512); g.addColorStop(0, 'rgba(255,255,255,.9)'); g.addColorStop(1, 'rgba(255,255,255,0)'); x.fillStyle = g; x.fillRect(0, 0, 128, 512); const h = x.createLinearGradient(0, 0, 128, 0); h.addColorStop(0, 'rgba(0,0,0,1)'); h.addColorStop(0.5, 'rgba(0,0,0,0)'); h.addColorStop(1, 'rgba(0,0,0,1)'); x.globalCompositeOperation = 'destination-out'; x.fillStyle = h; x.fillRect(0, 0, 128, 512); }
    else { const g = x.createRadialGradient(64, 64, 0, 64, 64, 64); g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.25, 'rgba(255,240,210,.55)'); g.addColorStop(1, 'rgba(255,220,180,0)'); x.fillStyle = g; x.fillRect(0, 0, 128, 128); }
    const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; return t;
  }

  function buildStage(L3, mats) {
    const { THREE } = L3;
    const FLOOR = -1.15;
    const stage = new THREE.Group();     // walls, frames, bulbs (reflected in the floor)
    const stripe = stripeTexture(THREE);
    const walls = [];
    const wallGeo = new THREE.PlaneGeometry(6.4, 4.0);
    const frameGeoV = new THREE.BoxGeometry(0.1, 4.1, 0.1), frameGeoH = new THREE.BoxGeometry(6.5, 0.1, 0.1);
    const bulbGeo = new THREE.SphereGeometry(0.045, 10, 8);
    const bulbMats = [new THREE.MeshBasicMaterial({ color: new THREE.Color(1.6, 1.4, 1.0) }), new THREE.MeshBasicMaterial({ color: new THREE.Color(0.6, 0.5, 0.35) })];
    for (const side of [-1, 1]) {
      const th = side < 0 ? 0.62 : -0.62; // the two walls form a V, meeting at the back
      const holder = new THREE.Group(); holder.position.set(side * 2.9, FLOOR + 2.0, -2.6); holder.rotation.y = th;
      const mat = new THREE.MeshStandardMaterial({ map: stripe, emissiveMap: stripe, color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.4, roughness: 0.55, metalness: 0.15 });
      const wall = new THREE.Mesh(wallGeo, mat); holder.add(wall); walls.push(wall);
      for (const fx of [-3.22, 3.22]) { const f = new THREE.Mesh(frameGeoV, mats.chrome); f.position.set(fx, 0, 0.05); holder.add(f); }
      for (const fy of [-2.02, 2.02]) { const f = new THREE.Mesh(frameGeoH, mats.chrome); f.position.set(0, fy, 0.05); holder.add(f); }
      // Two rows of marquee bulbs along the top; every other bulb lights in turn (a chase).
      const n = 13, sets = bulbMats.map((mt) => new THREE.InstancedMesh(bulbGeo, mt, n * 2)), m = new THREE.Matrix4();
      for (let row = 0; row < 2; row++) for (let k = 0; k < n * 2; k++) { m.setPosition(-3.0 + k * 0.233, 1.5 + row * 0.24, 0.1); sets[(k + row) % 2].setMatrixAt(row * n + (k >> 1), m); }
      holder.add(...sets);
      stage.add(holder);
    }
    // Center seam: a glowing pillar where the walls meet.
    const seam = new THREE.Mesh(new THREE.BoxGeometry(0.14, 4.0, 0.14), new THREE.MeshBasicMaterial({ color: new THREE.Color(1.3, 1.25, 1.2) })); seam.position.set(0, FLOOR + 2.0, -4.5); stage.add(seam);

    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x02040c, 0.05);
    { const bg = document.createElement('canvas'); bg.width = 2; bg.height = 256; const bx = bg.getContext('2d'); const gr = bx.createLinearGradient(0, 0, 0, 256); gr.addColorStop(0, '#16244a'); gr.addColorStop(0.5, '#060b1c'); gr.addColorStop(1, '#010208'); bx.fillStyle = gr; bx.fillRect(0, 0, 2, 256); const bt = new THREE.CanvasTexture(bg); bt.colorSpace = THREE.SRGBColorSpace; scene.background = bt; }
    scene.add(stage);
    const emblems = new THREE.Group(); scene.add(emblems);
    // The floor reflection: a mirrored copy of the set under a glossy, partly see-through floor.
    const mirror = new THREE.Group(); mirror.scale.y = -1; mirror.position.y = 2 * FLOOR; scene.add(mirror);
    mirror.add(stage.clone());
    const mirrorEmblems = new THREE.Group(); mirror.add(mirrorEmblems);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), new THREE.MeshStandardMaterial({ color: 0x04060d, metalness: 0.4, roughness: 0.35, transparent: true, opacity: 0.8, envMapIntensity: 0.4 }));
    floor.rotation.x = -Math.PI / 2; floor.position.y = FLOOR; scene.add(floor);
    const grid = new THREE.GridHelper(60, 90, 0x2b56b8, 0x14306e); grid.material.transparent = true; grid.material.opacity = 0.28; grid.material.depthWrite = false; grid.position.y = FLOOR + 0.004; scene.add(grid);
    // Light streaks swirling on the floor (team colors) and rays from above.
    const streaks = [];
    for (let i = 0; i < 6; i++) {
      const s = new THREE.Mesh(new THREE.TorusGeometry(2.2 + i * 0.55, 0.012, 6, 90, 1.1 + (i % 3) * 0.35), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false }));
      s.rotation.x = -Math.PI / 2; s.position.y = FLOOR + 0.01; s.userData = { side: i % 2 ? 1 : -1, sp: 0.12 + i * 0.03, ph: i * 1.3 }; scene.add(s); streaks.push(s);
    }
    const rayTex = glowTexture(THREE, 'ray'), rays = [];
    for (let i = 0; i < 7; i++) {
      const r = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 9), new THREE.MeshBasicMaterial({ map: rayTex, color: new THREE.Color(0.55, 0.5, 0.45), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
      r.geometry.translate(0, -4.5, 0); r.position.set(0, FLOOR + 5.0, -4.3); r.rotation.z = (i - 3) * 0.2; r.userData = { base: (i - 3) * 0.2, ph: i * 0.9 }; scene.add(r); rays.push(r);
    }
    const flare = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(THREE, 'flare'), color: 0xfff2dd, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false })); flare.scale.set(2.6, 2.6, 1); flare.position.set(0, FLOOR + 4.4, -4.4); scene.add(flare);
    // Lights: a soft key light that glides across, team-colored fills on each side.
    const key = new THREE.SpotLight(0xffffff, 12, 30, 0.55, 0.85); key.position.set(-4, 4, 6); scene.add(key, key.target);
    const fills = [-1, 1].map((s) => { const l = new THREE.PointLight(0xffffff, 10, 9); l.position.set(s * 2.4, 1.2, 1.2); scene.add(l); return l; });
    scene.add(new THREE.HemisphereLight(0x5a6c9a, 0x0a0a14, 0.5));
    return { scene, stage, emblems, mirrorEmblems, walls, bulbMats, streaks, rays, flare, key, fills, seam };
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
        bloom = new UnrealBloomPass(new THREE.Vector2(W, H), 0.24, 0.4, 0.92); composer.addPass(bloom);
        composer.addPass(new OutputPass());
      } else { S.flare.scale.set(3.4, 3.4, 1); S.rays.forEach((r) => r.material.color.multiplyScalar(1.25)); }
      const draw = composer ? () => composer.render() : () => renderer.render(S.scene, camera);
      // Compile every shader now (a stand-in emblem carries the emblem materials).
      const dummyTex = new THREE.CanvasTexture(document.createElement('canvas'));
      const box = new THREE.BoxGeometry(0.01, 0.01, 0.01);
      const stand = [mats.chrome, mats.gold, faceMat(THREE, dummyTex), glassMat(THREE, '#3366ff')].map((m) => new THREE.Mesh(box, m));
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
      await idle();
      const shape = new THREE.Shape();
      if (pts) { pts.forEach(([x, y], i) => { const u = x / N, v = 1 - y / N; if (i) shape.lineTo(u, v); else shape.moveTo(u, v); }); }
      else { const r = 0.12; shape.moveTo(r, 0); shape.lineTo(1 - r, 0); shape.quadraticCurveTo(1, 0, 1, r); shape.lineTo(1, 1 - r); shape.quadraticCurveTo(1, 1, 1 - r, 1); shape.lineTo(r, 1); shape.quadraticCurveTo(0, 1, 0, 1 - r); shape.lineTo(0, r); shape.quadraticCurveTo(0, 0, r, 0); }
      let texCv = cv;
      if (T().tex < cv.width) { texCv = document.createElement('canvas'); texCv.width = texCv.height = T().tex; texCv.getContext('2d').drawImage(cv, 0, 0, T().tex, T().tex); }
      const tex = new THREE.CanvasTexture(texCv); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = T().bloom ? 4 : 1;
      const metal = gold ? E.mats.gold : E.mats.chrome;
      const geo = new THREE.ExtrudeGeometry(shape, { depth: 0.2, bevelEnabled: true, bevelThickness: 0.035, bevelSize: 0.02, bevelSegments: T().bevel, curveSegments: T().curve }); geo.center();
      await idle();
      const geo2 = new THREE.ExtrudeGeometry(shape, { depth: 0.14, bevelEnabled: true, bevelThickness: 0.035, bevelSize: 0.032, bevelSegments: T().bevel, curveSegments: T().curve }); geo2.center();
      const front = new THREE.Mesh(geo, [faceMat(THREE, tex), metal]);
      const back = new THREE.Mesh(geo2, metal); back.scale.set(1.08, 1.08, 1); back.position.z = -0.17;
      const glass = new THREE.Mesh(geo2, glassMat(THREE, team.color)); glass.scale.set(1.04, 1.04, 0.7); glass.position.z = -0.07;
      const g = new THREE.Group(); g.add(back, glass, front);
      // Free this emblem's own GPU memory (the shared metal stays).
      g.userData.dispose = () => { geo.dispose(); geo2.dispose(); tex.dispose(); front.material[0].dispose(); glass.material.dispose(); };
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
    e.walls[0].material.color.copy(cL); e.walls[0].material.emissive.copy(cL);
    e.walls[1].material.color.copy(cR); e.walls[1].material.emissive.copy(cR);
    e.fills[0].color.copy(cL); e.fills[1].color.copy(cR);
    e.streaks.forEach((s) => s.material.color.copy(s.userData.side < 0 ? cL : cR));
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
        e.key.position.set(-6 + k * 12, 4, 6);
        e.streaks.forEach((st) => { st.rotation.z = st.userData.ph + s * st.userData.sp * st.userData.side; });
        e.rays.forEach((r) => { r.rotation.z = r.userData.base + Math.sin(s * 0.4 + r.userData.ph) * 0.05; r.material.opacity = 0.55 + 0.3 * Math.sin(s * 0.9 + r.userData.ph); });
        e.flare.material.opacity = 0.8 + 0.2 * Math.sin(s * 2.1);
        const chase = Math.floor(s * 4) % 2; // marquee bulbs chase
        e.bulbMats[chase].color.setRGB(1.6, 1.4, 1.0); e.bulbMats[1 - chase].color.setRGB(0.6, 0.5, 0.35);
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
