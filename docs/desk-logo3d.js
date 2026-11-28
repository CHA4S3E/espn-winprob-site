// desk-logo3d.js -- 3D metallic team-logo cinematics for the News Desk.
//
// Each team's logo is traced (its transparent pixels give the outline) and
// extruded into a solid emblem: the logo art is the glossy front face, the
// edges and a slightly larger back plate are polished chrome. Logos on a solid
// square background become a rounded chrome badge; emoji logos work too. The
// emblem sits over a dark grid floor with glowing light lines, with studio
// reflections, a soft glow (bloom) and slow camera moves.
//
//   await Logo3D.play(hostEl, { mode: 'single' | 'versus' | 'champion', teams: [{ name, color, logoUrl, emoji }], ms })
//   Logo3D.supported()  -> false where WebGL isn't available (callers keep the flat look)
//
// Three.js loads on first use (cdn.jsdelivr.net, via the import map in
// desk.html) and nothing renders except during a cinematic.
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
  function supported() {
    try { const c = document.createElement('canvas'); return !!(c.getContext('webgl2') || c.getContext('webgl')); } catch (e) { return false; }
  }

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
    const s = document.createElement('canvas'); s.width = s.height = N; const x = s.getContext('2d');
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
  // Largest outer contour by marching squares, simplified (Ramer-Douglas-Peucker).
  function contour(m) {
    const at = (x, y) => (x >= 0 && y >= 0 && x < N && y < N ? m[y * N + x] : 0);
    const seen = new Set(); let best = null;
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      if (!at(x, y) || at(x - 1, y)) continue; const key = y * N + x; if (seen.has(key)) continue;
      // Moore-neighbour boundary trace from this left-edge pixel.
      const pts = []; let cx = x, cy = y, dir = 0; const DX = [1, 1, 0, -1, -1, -1, 0, 1], DY = [0, 1, 1, 1, 0, -1, -1, -1];
      for (let step = 0; step < N * N * 2; step++) {
        pts.push([cx, cy]); seen.add(cy * N + cx);
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
    return rdp(best, 0.9);
  }

  // ---------------------------------------------------------------- emblem mesh
  async function emblem(L3, team, opts) {
    const { THREE } = L3;
    const cv = await logoCanvas(team), mk = mask(cv);
    const shape = new THREE.Shape();
    const pts = mk.square ? null : contour(mk.m);
    if (pts) { pts.forEach(([x, y], i) => { const u = x / N, v = 1 - y / N; if (i) shape.lineTo(u, v); else shape.moveTo(u, v); }); }
    else { const r = 0.12; shape.moveTo(r, 0); shape.lineTo(1 - r, 0); shape.quadraticCurveTo(1, 0, 1, r); shape.lineTo(1, 1 - r); shape.quadraticCurveTo(1, 1, 1 - r, 1); shape.lineTo(r, 1); shape.quadraticCurveTo(0, 1, 0, 1 - r); shape.lineTo(0, r); shape.quadraticCurveTo(0, 0, r, 0); }
    const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
    const gold = opts.gold;
    const chrome = new THREE.MeshPhysicalMaterial({ color: gold ? 0xe8b84a : 0xdfe6f2, metalness: 1, roughness: 0.16, clearcoat: 1, clearcoatRoughness: 0.08 });
    const face = new THREE.MeshPhysicalMaterial({ map: tex, metalness: 0.35, roughness: 0.28, clearcoat: 1, clearcoatRoughness: 0.05, transparent: true, alphaTest: 0.05 });
    const geo = new THREE.ExtrudeGeometry(shape, { depth: 0.2, bevelEnabled: true, bevelThickness: 0.04, bevelSize: 0.022, bevelSegments: 6, curveSegments: 6 });
    geo.center();
    const front = new THREE.Mesh(geo, [face, chrome]);
    // Back plate: the same outline, a bit larger and deeper, all chrome (the layered look).
    const geo2 = new THREE.ExtrudeGeometry(shape, { depth: 0.14, bevelEnabled: true, bevelThickness: 0.04, bevelSize: 0.035, bevelSegments: 6, curveSegments: 6 });
    geo2.center();
    const back = new THREE.Mesh(geo2, chrome); back.scale.set(1.08, 1.08, 1); back.position.z = -0.17;
    // Thin colored glass layer between them, tinted with the team color.
    const glass = new THREE.Mesh(geo2, new THREE.MeshPhysicalMaterial({ color: new THREE.Color(team.color || '#3a6cff'), metalness: 0.2, roughness: 0.1, transmission: 0.6, thickness: 0.2, clearcoat: 1 }));
    glass.scale.set(1.04, 1.04, 0.7); glass.position.z = -0.07;
    const g = new THREE.Group(); g.add(back, glass, front);
    g.userData.dispose = () => { [geo, geo2].forEach((x) => x.dispose()); [chrome, face].forEach((x) => x.dispose()); tex.dispose(); };
    return g;
  }

  // ---------------------------------------------------------------- scene
  async function play(host, opts) {
    if (!supported()) return false;
    let L3;
    try { L3 = await loadLibs(); } catch (e) { console.warn('3D logos unavailable', e); return false; }
    const { THREE, RoomEnvironment, EffectComposer, RenderPass, UnrealBloomPass, OutputPass } = L3;
    const mode = opts.mode || 'single', teams = opts.teams || [], ms = opts.ms || 6000;
    const W = host.clientWidth || 1920, H = host.clientHeight || 1080;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(1.5, window.devicePixelRatio || 1)); renderer.setSize(W, H);
    renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 0.95; renderer.outputColorSpace = THREE.SRGBColorSpace;
    const cv = renderer.domElement; cv.className = 'logo3d-canvas'; host.appendChild(cv);
    const scene = new THREE.Scene();
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.fog = new THREE.FogExp2(0x030a1f, 0.045);
    { const bg = document.createElement('canvas'); bg.width = 2; bg.height = 256; const bx = bg.getContext('2d'); const gr = bx.createLinearGradient(0, 0, 0, 256); gr.addColorStop(0, '#0b1d4a'); gr.addColorStop(0.55, '#040b22'); gr.addColorStop(1, '#01030a'); bx.fillStyle = gr; bx.fillRect(0, 0, 2, 256); const bt = new THREE.CanvasTexture(bg); bt.colorSpace = THREE.SRGBColorSpace; scene.background = bt; }
    const accent = new THREE.Color(mode === 'champion' ? '#ffcf5a' : (teams[0] && teams[0].color) || '#2f6bff');
    const blue = new THREE.Color('#2f6bff');
    // Floor grid + glowing light lines
    const grid = new THREE.GridHelper(80, 120, 0x3a6fd8, 0x1a3a85); grid.material.transparent = true; grid.material.opacity = 0.7; grid.position.y = -1.15; scene.add(grid);
    const dots = new THREE.Points(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(Array.from({ length: 1200 * 3 }, (_, i) => (i % 3 === 1 ? -1.14 : (Math.random() - 0.5) * 30)), 3)), new THREE.PointsMaterial({ color: 0x8fb4ff, size: 0.03, transparent: true, opacity: 0.8 }));
    scene.add(dots);
    const lines = [];
    for (let i = 0; i < 9; i++) {
      const c = i % 3 === 0 ? new THREE.Color('#ffffff') : i % 2 ? accent : blue;
      const bar = new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.012, 40), new THREE.MeshBasicMaterial({ color: c }));
      bar.position.set(-6 + i * 1.6 + (Math.random() - 0.5), -1.13, -8); bar.rotation.y = 0.35 + (Math.random() - 0.5) * 0.08; scene.add(bar); lines.push(bar);
    }
    // Emblems
    const groups = [];
    if (mode === 'versus' && teams.length >= 2) {
      const [a, b] = await Promise.all([emblem(L3, teams[0], {}), emblem(L3, teams[1], {})]);
      a.position.set(-1.25, 0, 0); b.position.set(1.25, 0, 0); a.rotation.y = 0.45; b.rotation.y = -0.45; a.scale.setScalar(1.55); b.scale.setScalar(1.55);
      scene.add(a, b); groups.push(a, b);
    } else if (teams[0]) {
      const e = await emblem(L3, teams[0], { gold: mode === 'champion' }); e.scale.setScalar(2.2); scene.add(e); groups.push(e);
    }
    // Lights: a key light that sweeps across (moving highlights on the chrome) + team-colored rim.
    const key = new THREE.SpotLight(0xffffff, 32, 30, 0.5, 0.7); key.position.set(-4, 4, 5); scene.add(key, key.target);
    const rim = new THREE.PointLight(accent, 25, 12); rim.position.set(3, 1.5, -2.5); scene.add(rim);
    scene.add(new THREE.AmbientLight(0x223355, 0.6));
    const camera = new THREE.PerspectiveCamera(32, W / H, 0.1, 100);
    const composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    composer.addPass(new UnrealBloomPass(new THREE.Vector2(W, H), 0.38, 0.45, 0.9));
    composer.addPass(new OutputPass());

    const t0 = performance.now();
    const ease = (u) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);
    await new Promise((resolve) => {
      const frame = (now) => {
        const u = Math.min(1, (now - t0) / ms), e = ease(u);
        // Camera: a slow push-in and orbit from a low angle (like the reference).
        const ang = -0.55 + e * 0.75, dist = 7.2 - e * 2.2;
        camera.position.set(Math.sin(ang) * dist, 1.9 + 1.0 * (1 - e), Math.cos(ang) * dist); camera.lookAt(0, -0.25, 0);
        groups.forEach((g, i) => { g.rotation.x = -0.32 + Math.sin(now / 2400 + i) * 0.03; if (mode !== 'versus') g.rotation.y = -0.5 + e * 0.9; g.position.y = 0.06 * Math.sin(now / 900 + i); });
        key.position.set(-5 + e * 10, 4, 5); // the highlight glides across the chrome
        lines.forEach((b, i) => { b.position.z = -8 + ((now / 1000 * (1.6 + i * 0.2)) % 16) - 8; });
        const fade = Math.min(1, (now - t0) / 500, (ms - (now - t0)) / 600); cv.style.opacity = Math.max(0, fade);
        composer.render();
        if (opts.onFrame) opts.onFrame(u, cv); // test hook (read the canvas right after rendering)
        if (u < 1) requestAnimationFrame(frame); else resolve();
      };
      requestAnimationFrame(frame);
    });
    groups.forEach((g) => g.userData.dispose && g.userData.dispose());
    pmrem.dispose(); composer.dispose && composer.dispose(); renderer.dispose(); cv.remove();
    return true;
  }

  window.Logo3D = { play, supported };
})();
