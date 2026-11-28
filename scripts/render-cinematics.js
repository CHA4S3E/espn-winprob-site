// Records the News Desk's set cinematics: for every team, three short H.264
// clips rendered once from the 3D emblem scene, saved in docs/cinematics/
// (served by GitHub Pages with the rest of the site -- nothing is uploaded
// to Supabase), plus docs/cinematics/manifest.json. The desk plays these
// instead of rendering 3D live, so every device (phones included) gets the
// same full-quality look.
//
//   closeup   -- a glide across the team's emblem (used for each team's shot
//                in a matchup bumper)
//   wide      -- the stage with the team's emblem on BOTH sides; the desk
//                shows team A's left half next to team B's right half (the
//                camera moves straight down the middle, so the halves meet
//                cleanly where the two walls join)
//   champion  -- gold rim: macro sweep, low hero angle, wide
//
// Usage (needs Playwright's Chromium and ffmpeg):
//   node scripts/render-cinematics.js            only teams whose logo changed
//   node scripts/render-cinematics.js --all      everything
//   node scripts/render-cinematics.js --team=aebd2919
const fs = require('fs');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const DOCS = path.join(ROOT, 'docs');
const OUT = path.join(DOCS, 'cinematics');
const SIZE = [1280, 720], FPS = 24;
const CLIPS = { closeup: 2600, wide: 3800, champion: 6000 };
const ALL = process.argv.includes('--all');
const ONLY = (process.argv.find((a) => a.startsWith('--team=')) || '').slice(7);

function serve(dir) {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.png': 'image/png' };
  const server = http.createServer((req, res) => {
    const p = path.join(dir, decodeURIComponent(req.url.split('?')[0]));
    if (!p.startsWith(dir) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': types[path.extname(p)] || 'application/octet-stream' });
    fs.createReadStream(p).pipe(res);
  });
  return new Promise((r) => server.listen(0, () => r(server)));
}

const PAGE = `<!doctype html><meta charset="utf-8">
<script type="importmap">{ "imports": { "three": "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js", "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/" } }</script>
<style>html,body{margin:0;background:#000} #host{position:relative;width:${SIZE[0]}px;height:${SIZE[1]}px} .logo3d-canvas{position:absolute;inset:0;width:100%!important;height:100%!important}</style>
<div id="host"></div>
<script src="config.js"></script><script src="wp-chart.js"></script><script src="desk-logo3d.js"></script>`;

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const manifestPath = path.join(OUT, 'manifest.json');
  const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : { teams: {} };
  const pagePath = path.join(DOCS, '.cine-render.html');
  fs.writeFileSync(pagePath, PAGE);
  const server = await serve(DOCS);
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'cine-'));
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  try {
    const page = await browser.newPage({ viewport: { width: SIZE[0], height: SIZE[1] } });
    page.on('pageerror', (e) => console.warn('page error:', e.message));
    await page.goto(`http://localhost:${server.address().port}/.cine-render.html?3d=full&3dsize=${SIZE[0]}x${SIZE[1]}`);
    await page.waitForFunction(() => window.Logo3D && window.WPChart);
    // Teams from the public read-only API, with the same dark-background team colors the desk uses.
    const teams = await page.evaluate(async () => {
      const { url, anonKey } = window.SUPABASE_CONFIG, H = { apikey: anonKey, Authorization: 'Bearer ' + anonKey };
      const rows = await (await fetch(`${url}/rest/v1/teams?select=id,league_id,espn_team_name,team_settings(display_name,color,emoji,logo_url)`, { headers: H })).json();
      const byLeague = {};
      for (const t of rows) { const s = Array.isArray(t.team_settings) ? t.team_settings[0] || {} : t.team_settings || {}; (byLeague[t.league_id] = byLeague[t.league_id] || []).push({ id: t.id, name: s.display_name || t.espn_team_name, color: s.color || '#1a3fa0', emoji: s.emoji || '', logoUrl: s.logo_url || '' }); }
      const out = [];
      for (const list of Object.values(byLeague)) { const pal = WPChart.leaguePalette(list, true); for (const t of list) out.push(Object.assign({}, t, { color: pal[t.id] || t.color })); }
      return out;
    });
    await page.exposeFunction('saveFrame', (dir, i, dataUrl) => fs.writeFileSync(path.join(dir, String(i).padStart(4, '0') + '.jpg'), Buffer.from(dataUrl.split(',')[1], 'base64')));
    await page.evaluate(() => Logo3D.warm());
    for (const t of teams) {
      const id8 = t.id.slice(0, 8), stamp = (/[?&]t=(\d+)/.exec(t.logoUrl) || [])[1] || t.logoUrl || t.emoji;
      const have = manifest.teams[t.id];
      if (ONLY && id8 !== ONLY) continue;
      if (!ALL && !ONLY && have && have.stamp === stamp && have.color === t.color && Object.keys(CLIPS).every((k) => have[k] && fs.existsSync(path.join(DOCS, have[k])))) continue;
      console.log(`rendering ${t.name} (${id8})`);
      const entry = { name: t.name, stamp, color: t.color };
      for (const [kind, ms] of Object.entries(CLIPS)) {
        const dir = fs.mkdtempSync(path.join(tmp, kind + '-'));
        const t0 = Date.now();
        await page.evaluate(async ({ t, kind, ms, fps, dir }) => {
          const host = document.getElementById('host');
          await Logo3D.play(host, { mode: kind, teams: [t], ms, record: { fps, onFrame: (cv, i) => window.saveFrame(dir, i, cv.toDataURL('image/jpeg', 0.93)) } });
        }, { t, kind, ms, fps: FPS, dir });
        const file = `cinematics/${id8}-${kind}.mp4`;
        execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', path.join(dir, '%04d.jpg'), '-c:v', 'libx264', '-preset', 'slow', '-crf', '23', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', path.join(DOCS, file)]);
        fs.rmSync(dir, { recursive: true, force: true });
        entry[kind] = file;
        console.log(`  ${kind}: ${((Date.now() - t0) / 1000).toFixed(0)}s, ${(fs.statSync(path.join(DOCS, file)).size / 1e6).toFixed(2)} MB`);
      }
      manifest.teams[t.id] = entry;
      manifest.size = SIZE; manifest.fps = FPS; manifest.ms = CLIPS;
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 1));
    }
  } finally {
    await browser.close(); server.close(); fs.rmSync(pagePath, { force: true }); fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log('done:', Object.keys(manifest.teams).length, 'teams in the manifest');
})().catch((e) => { console.error(e); process.exit(1); });
