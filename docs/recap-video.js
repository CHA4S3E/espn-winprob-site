// recap-video.js -- the weekly recap as a video.
//
// Builds a ~1 minute highlight show for one finished week and draws it on a
// 1920x1080 canvas: title card, every final score, game of the week (with its
// win-probability chart drawn live), upset of the week, top score and biggest
// blowout, player of the week (when the poller has saved lineups), the
// standings after the week, and a sign-off. Two looks: "pro" (Branford) and
// "casual" (Family League).
//
//   const show = await RecapVideo.build(sb, { leagueId, name, studio, year, week, teams })
//   const p = RecapVideo.play(canvas, show, { onLine })   // onLine(text) per scene (for a voice-over)
//   p.stop()
//   await RecapVideo.download(show)                       // records it to an .mp4/.webm file (real time)
//   RecapVideo.openModal(sb, opts)                        // full-screen player with a Download button
(function () {
  'use strict';
  const W = 1920, H = 1080;

  // ---------------------------------------------------------------- data
  async function fetchAll(build) {
    const out = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await build(from, from + 999);
      if (error) throw error;
      out.push(...(data || []));
      if (!data || data.length < 1000) return out;
    }
  }
  function loadImage(src) {
    return new Promise((res) => {
      if (!src) return res(null);
      const img = new Image(); img.crossOrigin = 'anonymous';
      img.onload = () => res(img); img.onerror = () => res(null); img.src = src;
      setTimeout(() => res(null), 6000);
    });
  }

  async function build(sb, o) {
    const teams = {};
    if (o.teams && Object.keys(o.teams).length) Object.assign(teams, o.teams);
    else {
      const { data } = await sb.from('teams').select('id, espn_team_name, team_settings(color, display_name, emoji, logo_url)').eq('league_id', o.leagueId);
      for (const t of data || []) { const s = t.team_settings || {}; teams[t.id] = { id: t.id, name: s.display_name || t.espn_team_name, color: s.color || '#1a3fa0', emoji: s.emoji || '', logoUrl: s.logo_url || '' }; }
    }
    const summary = await fetchAll((a, b) => sb.from('snapshot_summary').select('week, matchup_id, team_id, is_home, actual_score, all_starters_done, ts, pregame_win_prob, pregame_expected_score').eq('league_id', o.leagueId).eq('year', o.year).lte('week', o.week).range(a, b));
    const latest = new Map();
    for (const r of summary) { const k = r.week + '|' + r.matchup_id + '|' + r.team_id; const ex = latest.get(k); if (!ex || r.ts > ex.ts) latest.set(k, r); }
    const games = new Map();
    for (const r of latest.values()) { const k = r.week + '|' + r.matchup_id; if (!games.has(k)) games.set(k, []); games.get(k).push(r); }
    const finals = [];
    const record = new Map(Object.keys(teams).map((id) => [id, { id, w: 0, l: 0, t: 0, pf: 0, prevW: 0, prevL: 0, prevPf: 0 }]));
    for (const [k, g] of games) {
      if (g.length !== 2 || !g[0].all_starters_done || !g[1].all_starters_done) continue;
      const [h, a] = g[0].is_home ? g : [g[1], g[0]];
      const wk = Number(k.split('|')[0]);
      const hs = Number(h.actual_score), as = Number(a.actual_score);
      for (const [x, sc, os] of [[h.team_id, hs, as], [a.team_id, as, hs]]) {
        const R = record.get(x); if (!R) continue;
        const win = sc > os ? 1 : 0, loss = sc < os ? 1 : 0;
        R.w += win; R.l += loss; R.t += sc === os ? 1 : 0; R.pf += sc;
        if (wk < o.week) { R.prevW += win; R.prevL += loss; R.prevPf += sc; }
      }
      if (wk === o.week) finals.push({ id: h.matchup_id, home: h.team_id, away: a.team_id, hs, as, pre: h.pregame_win_prob != null ? Number(h.pregame_win_prob) : 50,
        hPreX: h.pregame_expected_score != null ? Number(h.pregame_expected_score) : null, aPreX: a.pregame_expected_score != null ? Number(a.pregame_expected_score) : null });
    }
    if (!finals.length) return null;
    // Every game's win-% history (home side), evenly spaced by update like the real charts.
    const rows = await fetchAll((a, b) => sb.from('snapshots').select('matchup_id, is_home, ts, win_prob').eq('league_id', o.leagueId).eq('year', o.year).eq('week', o.week).eq('is_home', true).order('ts').range(a, b)).catch(() => []);
    const seriesBy = new Map();
    for (const r of rows) { if (!seriesBy.has(r.matchup_id)) seriesBy.set(r.matchup_id, []); seriesBy.get(r.matchup_id).push(Number(r.win_prob)); }
    for (const m of finals) m.series = seriesBy.get(m.id) || [m.pre, m.hs >= m.as ? 100 : 0];
    const winner = (m) => (m.hs >= m.as ? m.home : m.away), loser = (m) => (m.hs >= m.as ? m.away : m.home);
    const margin = (m) => Math.abs(m.hs - m.as);
    const by = (arr, f) => arr.slice().sort((x, y) => f(y) - f(x))[0];
    // The same superlatives as the Matchups page's recap card.
    const teamScores = finals.flatMap((m) => [{ id: m.home, s: m.hs, px: m.hPreX, m }, { id: m.away, s: m.as, px: m.aPreX, m }]);
    const withProj = teamScores.filter((x) => x.px != null);
    // Upset: the winner's lowest in-game win %; a pregame underdog that won counts most.
    const upsetPick = finals.map((m) => { const wHome = m.hs >= m.as; const low = Math.min(...m.series.map((v) => (wHome ? v : 100 - v))); const pre = wHome ? m.pre : 100 - m.pre; return { m, low, pre }; })
      .filter((x) => x.low <= 35 || x.pre <= 40).sort((a, b) => Math.min(a.low, a.pre) - Math.min(b.low, b.pre))[0] || null;
    const sup = {
      closest: by(finals, (m) => -margin(m)),
      blowout: by(finals, margin),
      high: by(teamScores, (x) => x.s),
      low: by(teamScores, (x) => -x.s),
      hiMatch: by(finals, (m) => m.hs + m.as),
      loMatch: by(finals, (m) => -(m.hs + m.as)),
      over: withProj.length ? by(withProj, (x) => x.s - x.px) : null,
      under: withProj.length ? by(withProj, (x) => x.px - x.s) : null,
      upset: upsetPick,
      total: finals.reduce((s, m) => s + m.hs + m.as, 0),
    };
    let potw = null, bench = null;
    try {
      const { data, error } = await sb.from('lineups').select('team_id, players').eq('league_id', o.leagueId).eq('year', o.year).eq('week', o.week);
      if (!error && data && data.length) {
        const all = data.flatMap((r) => (r.players || []).map((p) => ({ ...p, team: r.team_id })));
        potw = all.filter((p) => !p.bench).sort((a, b) => b.pts - a.pts)[0] || null;
        bench = all.filter((p) => p.bench).sort((a, b) => b.pts - a.pts)[0] || null;
        if (bench && bench.pts < 12) bench = null;
      }
    } catch (e) { /* lineups table not there yet */ }
    const order = (arr, w, l, pf) => arr.sort((x, y) => (y[w] - y[l]) - (x[w] - x[l]) || y[pf] - x[pf]);
    const prevRank = new Map(order([...record.values()], 'prevW', 'prevL', 'prevPf').map((r, i) => [r.id, i + 1]));
    const standings = order([...record.values()], 'w', 'l', 'pf').map((r, i) => ({ ...r, rank: i + 1, move: prevRank.get(r.id) - (i + 1) }));
    const imgs = {};
    await Promise.all(Object.values(teams).map(async (t) => { imgs[t.id] = await loadImage(t.logoUrl); }));
    if (potw) imgs.potw = await loadImage(Number(potw.id) < 0 ? `https://a.espncdn.com/i/teamlogos/nfl/500/${String(potw.tm || '').toLowerCase()}.png` : `https://a.espncdn.com/i/headshots/nfl/players/full/${potw.id}.png`);
    const show = { o, teams, finals, sup, potw, bench, standings, imgs, winner, loser, margin };
    show.scenes = scenes(show);
    show.duration = show.scenes.reduce((s, x) => s + x.dur, 0);
    return show;
  }

  // ---------------------------------------------------------------- look
  function palette(studio) {
    return studio === 'casual'
      ? { bg1: '#fbf3e2', bg2: '#f3dfb8', fg: '#3a2a17', muted: '#8a7254', accent: '#3f8f4e', accent2: '#f29a2e', panel: 'rgba(255,251,240,.92)', head: "800 {S}px 'Baloo 2', 'Nunito', system-ui, sans-serif", body: "700 {S}px 'Nunito', system-ui, sans-serif", italic: false }
      : { bg1: '#081433', bg2: '#030817', fg: '#eaf1ff', muted: '#8ea3c9', accent: '#3d8bff', accent2: '#36e0ff', panel: 'rgba(10,22,52,.85)', head: "italic 800 {S}px 'Barlow Condensed', 'Arial Narrow', sans-serif", body: "600 {S}px 'Inter', system-ui, sans-serif", italic: true };
  }
  const F = (tpl, size) => tpl.replace('{S}', size);
  const ease = (u) => 1 - Math.pow(1 - Math.min(1, Math.max(0, u)), 3);
  const fmt = (x) => Number(x || 0).toFixed(1);
  const readable = (hex, dark) => (window.WPChart ? WPChart.teamColor(hex, dark) : hex);

  function bg(x, P, t) {
    const g = x.createRadialGradient(W * 0.3, -200, 100, W * 0.5, H * 0.4, 1500);
    g.addColorStop(0, P.bg1); g.addColorStop(1, P.bg2);
    x.fillStyle = g; x.fillRect(0, 0, W, H);
    x.save(); x.globalAlpha = 0.07; x.strokeStyle = P.accent; x.lineWidth = 2;
    for (let i = -10; i < 30; i++) { const xx = ((i * 120 + t * 0.04) % (W + 400)) - 200; x.beginPath(); x.moveTo(xx, 0); x.lineTo(xx - 300, H); x.stroke(); }
    x.restore();
  }
  function bar(x, P, label, u) {
    const w = 120 + 26 * label.length;
    x.save(); x.translate(-w * (1 - ease(u * 3)), 0);
    const g = x.createLinearGradient(0, 0, w, 0); g.addColorStop(0, P.accent); g.addColorStop(1, P.accent2);
    x.fillStyle = g; x.beginPath(); x.moveTo(0, 60); x.lineTo(w, 60); x.lineTo(w - (P.italic ? 24 : 0), 140); x.lineTo(0, 140); x.fill();
    x.fillStyle = '#fff'; x.font = F(P.head, 52); x.textBaseline = 'middle'; x.fillText(label.toUpperCase(), 60, 101);
    x.restore();
  }
  // Team logo (or emoji) drawn as-is, fit inside a 2r box -- no circle behind it.
  // Only a team with neither gets a small colored initials badge.
  function teamBadge(x, show, id, cx, cy, r) {
    const t = show.teams[id] || {}, img = show.imgs[id];
    x.save(); x.textAlign = 'center'; x.textBaseline = 'middle';
    if (img) { const k = Math.min((r * 2) / img.width, (r * 2) / img.height); const w = img.width * k, h = img.height * k; x.drawImage(img, cx - w / 2, cy - h / 2, w, h); }
    else if (t.emoji) { x.font = `${Math.round(r * 1.7)}px sans-serif`; x.fillText(t.emoji, cx, cy + r * 0.08); }
    else {
      x.beginPath(); x.arc(cx, cy, r, 0, 7); x.fillStyle = t.color || '#888'; x.fill();
      x.fillStyle = '#fff'; x.font = `800 ${Math.round(r * 0.8)}px sans-serif`; x.fillText(String(t.name || '?').split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase(), cx, cy + 2);
    }
    x.restore();
  }
  function fitText(x, text, maxW, tpl, size) {
    let s = size; x.font = F(tpl, s);
    while (x.measureText(text).width > maxW && s > 18) { s -= 2; x.font = F(tpl, s); }
    return s;
  }

  // ---------------------------------------------------------------- scenes
  // ~35-40 seconds: title, finals, game of the week, two quick pages of
  // superlatives, player of the week (when lineups exist), standings, sign-off.
  function scenes(S) {
    const o = S.o, P = palette(o.studio), pro = o.studio !== 'casual', dark = pro;
    const N = (id) => (S.teams[id] || {}).name || 'Unknown';
    const pal = window.WPChart && WPChart.leaguePalette ? WPChart.leaguePalette(Object.values(S.teams), dark) : {}; // same colors as the site
    const C = (id) => pal[id] || readable((S.teams[id] || {}).color, dark);
    const list = [];
    const scene = (dur, line, draw) => list.push({ dur, line, draw });

    // 1. Title
    scene(3000, pro ? `${o.name}, week ${o.week}.` : `Week ${o.week}, here we go!`, (x, t, u) => {
      bg(x, P, t);
      x.save(); x.textAlign = 'center'; x.textBaseline = 'alphabetic';
      x.globalAlpha = ease(u * 4); x.fillStyle = P.muted; x.font = F(P.body, 40); x.fillText(`${o.name.toUpperCase()} · ${o.year}`, W / 2, 390);
      x.globalAlpha = 1; x.fillStyle = P.fg; const sc = 1 + (1 - ease(u * 3)) * 0.5;
      x.translate(W / 2, 560); x.scale(sc, sc); x.font = F(P.head, 200); x.fillText(`WEEK ${o.week}`, 0, 0); x.restore();
      x.save(); x.textAlign = 'center'; x.globalAlpha = ease((u - 0.25) * 4); x.fillStyle = P.accent; x.font = F(P.head, 96); x.fillText(pro ? 'THE RECAP' : 'The Recap!', W / 2, 690); x.restore();
      x.fillStyle = P.accent2; x.fillRect(W / 2 - 300 * ease(u * 3), 730, 600 * ease(u * 3), 8);
    });

    // 2. Finals (all at once, quick stagger)
    const fs = S.finals.slice(0, 8);
    scene(5200, pro ? 'Final scores.' : 'Here’s how everybody did.', (x, t, u, ms) => {
      bg(x, P, t); bar(x, P, pro ? 'Final scores' : 'All the scores', u);
      const cols = fs.length > 4 ? 2 : 1, rowsN = Math.ceil(fs.length / cols), cw = cols === 2 ? 850 : 1300, ch = Math.min(190, 800 / rowsN);
      fs.forEach((m, i) => {
        const appear = ease((ms - 250 - i * 180) / 400); if (appear <= 0) return;
        const col = i % cols, row = Math.floor(i / cols), x0 = (W - cols * cw - (cols - 1) * 40) / 2 + col * (cw + 40), y0 = 200 + row * (ch + 20);
        x.save(); x.globalAlpha = appear; x.translate((1 - appear) * 80, 0);
        x.fillStyle = P.panel; x.beginPath(); x.roundRect(x0, y0, cw, ch, 18); x.fill();
        const w = S.winner(m), l = S.loser(m);
        [[w, Math.max(m.hs, m.as), true], [l, Math.min(m.hs, m.as), false]].forEach(([id, sc, win], k) => {
          const yy = y0 + ch * (k ? 0.72 : 0.32);
          teamBadge(x, S, id, x0 + 50, yy, ch * 0.17);
          x.fillStyle = win ? C(id) : P.muted; fitText(x, N(id), cw - 320, P.head, Math.round(ch * 0.27)); x.textBaseline = 'middle'; x.textAlign = 'left'; x.fillText(N(id), x0 + 90, yy);
          x.fillStyle = win ? P.fg : P.muted; x.font = F(P.head, Math.round(ch * 0.3)); x.textAlign = 'right'; x.fillText(fmt(sc), x0 + cw - 30, yy);
        });
        x.restore();
      });
    });

    // 3. Game of the week: the closest game, with its real-style chart drawing in
    const g = S.sup.closest, gw = S.winner(g), gl = S.loser(g);
    scene(6500, pro ? `Game of the week: ${N(gw)} by ${S.margin(g).toFixed(1)} over ${N(gl)}.` : `Closest game: ${N(gw)} beat ${N(gl)} by just ${S.margin(g).toFixed(1)}!`, (x, t, u, ms) => {
      bg(x, P, t); bar(x, P, pro ? 'Game of the week' : 'Closest game', u);
      [[g.home, g.hs, 120], [g.away, g.as, W - 120]].forEach(([id, sc, cx], k) => {
        teamBadge(x, S, id, cx + (k ? -60 : 60), 250, 56);
        x.textAlign = k ? 'right' : 'left'; x.textBaseline = 'middle'; x.fillStyle = C(id); fitText(x, N(id), 700, P.head, 60); x.fillText(N(id), cx + (k ? -136 : 136), 232);
        x.fillStyle = P.fg; x.font = F(P.head, 96); x.fillText(fmt(sc * ease((ms - 200) / 1800)), cx + (k ? -136 : 136), 312);
      });
      WPChart.draw(x, { x: 100, y: 400, w: W - 200, h: 590 }, g.series, C(g.home), C(g.away), { dark, lineWidth: 6, font: 26, progress: ease((ms - 500) / 5000) });
    });

    // 4-5. Superlatives, four cards per page (same set as the recap card)
    const cards = [];
    const sp = S.sup;
    if (sp.blowout && S.margin(sp.blowout) > 0) cards.push({ k: pro ? 'Biggest blowout' : 'Biggest beatdown', team: S.winner(sp.blowout), big: '+' + S.margin(sp.blowout).toFixed(1), sub: `over ${N(S.loser(sp.blowout))}` });
    if (sp.upset) { const m = sp.upset.m, w = S.winner(m); cards.push({ k: sp.upset.pre <= 40 ? (pro ? 'Biggest upset' : 'Upset!') : (pro ? 'Biggest comeback' : 'Comeback kids'), team: w, big: Math.round(Math.min(sp.upset.low, sp.upset.pre)) + '%', sub: `${sp.upset.pre <= 40 ? 'at kickoff' : 'at their lowest'} — beat ${N(S.loser(m))}` }); }
    if (sp.high) cards.push({ k: pro ? 'Highest score' : 'Top score', team: sp.high.id, big: fmt(sp.high.s), sub: 'points' });
    if (sp.low) cards.push({ k: pro ? 'Lowest score' : 'Rough week', team: sp.low.id, big: fmt(sp.low.s), sub: 'points' });
    if (sp.over && sp.over.s - sp.over.px > 0) cards.push({ k: pro ? 'Biggest overperformer' : 'Overachiever', team: sp.over.id, big: '+' + (sp.over.s - sp.over.px).toFixed(1), sub: `vs ${fmt(sp.over.px)} projected` });
    if (sp.under && sp.under.px - sp.under.s > 0) cards.push({ k: pro ? 'Biggest underperformer' : 'Underachiever', team: sp.under.id, big: '−' + (sp.under.px - sp.under.s).toFixed(1), sub: `vs ${fmt(sp.under.px)} projected` });
    if (sp.hiMatch) cards.push({ k: pro ? 'Highest-scoring matchup' : 'Shootout', team: S.winner(sp.hiMatch), team2: S.loser(sp.hiMatch), big: fmt(sp.hiMatch.hs + sp.hiMatch.as), sub: 'combined' });
    if (sp.loMatch && sp.loMatch !== sp.hiMatch) cards.push({ k: pro ? 'Lowest-scoring matchup' : 'Snoozer', team: S.winner(sp.loMatch), team2: S.loser(sp.loMatch), big: fmt(sp.loMatch.hs + sp.loMatch.as), sub: 'combined' });
    const pages = [cards.slice(0, 4), cards.slice(4, 8)].filter((p) => p.length);
    pages.forEach((page, pi) => {
      const first = page[0];
      scene(5600, pi === 0 ? (pro ? `The superlatives. ${first.k}: ${N(first.team)}.` : `Awards time! ${first.k}: ${N(first.team)}.`) : (pro ? `More from week ${o.week}.` : 'And there’s more!'), (x, t, u, ms) => {
        bg(x, P, t); bar(x, P, pi === 0 ? (pro ? 'Superlatives' : 'The awards') : (pro ? 'Superlatives, cont.' : 'More awards'), u);
        const cw = 820, chh = 380;
        page.forEach((c, i) => {
          const a = ease((ms - 200 - i * 350) / 450); if (a <= 0) return;
          const x0 = W / 2 - cw - 20 + (i % 2) * (cw + 40), y0 = 190 + Math.floor(i / 2) * (chh + 30);
          x.save(); x.globalAlpha = a; x.translate(0, (1 - a) * 40);
          x.fillStyle = P.panel; x.beginPath(); x.roundRect(x0, y0, cw, chh, 22); x.fill();
          x.fillStyle = C(c.team); x.fillRect(x0, y0, 12, chh);
          x.textAlign = 'left'; x.textBaseline = 'alphabetic';
          x.fillStyle = P.muted; x.font = F(P.body, 28); x.fillText(c.k.toUpperCase(), x0 + 50, y0 + 62);
          teamBadge(x, S, c.team, x0 + 95, y0 + 140, 42);
          x.fillStyle = C(c.team); fitText(x, N(c.team), cw - 200, P.head, 54); x.textBaseline = 'middle'; x.fillText(N(c.team), x0 + 155, y0 + 140);
          if (c.team2) { x.fillStyle = P.muted; fitText(x, '& ' + N(c.team2), cw - 200, P.body, 30); x.fillText('& ' + N(c.team2), x0 + 155, y0 + 188); }
          x.textBaseline = 'alphabetic'; x.fillStyle = P.fg; x.font = F(P.head, 120); x.fillText(c.big, x0 + 50, y0 + chh - 50);
          const bw = x.measureText(c.big).width;
          x.fillStyle = P.muted; x.font = F(P.body, 28); x.fillText(c.sub, x0 + 70 + bw, y0 + chh - 58);
          x.restore();
        });
      });
    });

    // 6. Player of the week (+ bench of shame), when the poller saved lineups
    if (S.potw) {
      const p = S.potw;
      scene(4800, pro ? `Player of the week: ${p.n}, ${fmt(p.pts)} for ${N(p.team)}.` : `MVP of the week: ${p.n}! ${fmt(p.pts)} points!`, (x, t, u, ms) => {
        bg(x, P, t); bar(x, P, pro ? 'Player of the week' : 'MVP of the week', u);
        const img = S.imgs.potw;
        if (img) { x.save(); x.globalAlpha = ease((ms - 150) / 500); x.drawImage(img, 180, 250, 720, 720 * (img.height / img.width || 0.73)); x.restore(); }
        x.textAlign = 'left'; x.textBaseline = 'alphabetic'; x.fillStyle = P.fg; fitText(x, p.n, 860, P.head, 116); x.fillText(p.n, 960, 470);
        x.fillStyle = P.muted; x.font = F(P.body, 38); x.fillText(`${p.pos} · ${p.tm || ''} · ${N(p.team)}`, 960, 540);
        x.fillStyle = C(p.team); x.font = F(P.head, 210); x.fillText(fmt(p.pts * ease((ms - 300) / 1500)), 960, 780);
        if (S.bench) { x.globalAlpha = ease((ms - 2200) / 400); x.fillStyle = P.muted; x.font = F(P.body, 32); x.fillText(`${pro ? 'Bench of shame' : 'Oops'}: ${S.bench.n}, ${fmt(S.bench.pts)} on ${N(S.bench.team)}’s bench`, 960, 890); x.globalAlpha = 1; }
      });
    }

    // 7. Standings
    const st = S.standings.slice(0, 12);
    scene(5600, pro ? `The standings after week ${o.week}.` : 'And the standings!', (x, t, u, ms) => {
      bg(x, P, t); bar(x, P, pro ? 'Standings' : 'The standings', u);
      const rowH = Math.min(68, 820 / st.length);
      st.forEach((r, i) => {
        const a = ease((ms - 150 - i * 70) / 350); if (a <= 0) return;
        const y = 190 + i * rowH;
        x.save(); x.globalAlpha = a; x.translate((1 - a) * -60, 0);
        if (i % 2 === 0) { x.fillStyle = P.panel; x.fillRect(220, y, W - 440, rowH - 6); }
        x.textBaseline = 'middle'; x.textAlign = 'left'; x.fillStyle = P.muted; x.font = F(P.head, rowH * 0.55); x.fillText(String(r.rank), 250, y + rowH / 2);
        teamBadge(x, S, r.id, 340, y + rowH / 2 - 3, rowH * 0.34);
        x.fillStyle = C(r.id); fitText(x, N(r.id), 900, P.head, Math.round(rowH * 0.55)); x.fillText(N(r.id), 390, y + rowH / 2);
        x.textAlign = 'right'; x.fillStyle = P.fg; x.font = F(P.head, rowH * 0.55); x.fillText(`${r.w}-${r.l}${r.t ? '-' + r.t : ''}`, W - 520, y + rowH / 2);
        x.fillStyle = r.move > 0 ? '#27d07c' : r.move < 0 ? '#ff4757' : P.muted; x.fillText(r.move > 0 ? '▲' + r.move : r.move < 0 ? '▼' + -r.move : '–', W - 380, y + rowH / 2);
        x.fillStyle = P.muted; x.font = F(P.body, rowH * 0.36); x.fillText(Math.round(r.pf) + ' PF', W - 250, y + rowH / 2);
        x.restore();
      });
    });

    // 8. Sign-off
    scene(2600, pro ? 'That’s the week.' : 'That’s the week, family!', (x, t, u) => {
      bg(x, P, t);
      x.textAlign = 'center'; x.textBaseline = 'middle'; x.globalAlpha = ease(u * 4);
      x.fillStyle = P.fg; x.font = F(P.head, 150); x.fillText(pro ? "THAT'S THE WEEK" : "That's the week!", W / 2, 470);
      x.fillStyle = P.accent; x.font = F(P.body, 46); x.fillText(`${o.name} · ${fmt(S.sup.total)} points scored`, W / 2, 610);
      x.globalAlpha = 1;
    });
    return list;
  }

  // ---------------------------------------------------------------- playback
  function renderAt(x, show, ms) {
    let acc = 0;
    for (let i = 0; i < show.scenes.length; i++) {
      const sc = show.scenes[i];
      if (ms < acc + sc.dur || i === show.scenes.length - 1) {
        const local = Math.min(sc.dur, ms - acc);
        x.save(); sc.draw(x, ms, local / sc.dur, local); x.restore();
        // quick fade between scenes
        const edge = Math.min(local, sc.dur - local);
        if (edge < 250) { x.fillStyle = `rgba(0,0,0,${(1 - edge / 250) * 0.9})`; x.fillRect(0, 0, W, H); }
        return i;
      }
      acc += sc.dur;
    }
    return -1;
  }

  function play(canvas, show, opts) {
    opts = opts || {};
    const x = canvas.getContext('2d');
    canvas.width = W; canvas.height = H;
    const start = performance.now();
    let raf = 0, lastScene = -1, stopped = false;
    const f = (now) => {
      if (stopped) return;
      const ms = now - start;
      const i = renderAt(x, show, Math.min(ms, show.duration));
      if (i !== lastScene) { lastScene = i; if (opts.onLine && show.scenes[i]) opts.onLine(show.scenes[i].line); }
      if (ms < show.duration) raf = requestAnimationFrame(f); else if (opts.onEnd) opts.onEnd();
    };
    raf = requestAnimationFrame(f);
    return { stop() { stopped = true; cancelAnimationFrame(raf); } };
  }

  // Records the show (real time) with the desk's music when available.
  async function download(show, opts) {
    opts = opts || {};
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const stream = cv.captureStream(30);
    let musicStarted = false;
    if (!window.DeskMusic) await new Promise((res) => { const s = document.createElement('script'); s.src = 'desk-music.js?v=5'; s.onload = res; s.onerror = res; document.head.appendChild(s); });
    if (window.DeskMusic) {
      if (!DeskMusic.running) { DeskMusic.setStyle(show.o.studio, 'night'); DeskMusic.start(); musicStarted = true; }
      try { for (const tr of DeskMusic.tap().getAudioTracks()) stream.addTrack(tr); } catch (e) { /* no audio */ }
    }
    // Real MP4 (H.264, plays everywhere incl. iPhone) when the browser can make it; otherwise WebM.
    const types = ['video/mp4;codecs=avc1.42E01F,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
    const mime = types.find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t));
    if (!mime) throw new Error('This browser can’t record video');
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 6e6 });
    const chunks = []; rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    const done = new Promise((res) => { rec.onstop = res; });
    rec.start(1000);
    const p = play(cv, show, { onLine: opts.onLine });
    if (window.DeskMusic && DeskMusic.running) DeskMusic.sting('breaking');
    await new Promise((res) => setTimeout(res, show.duration + 600));
    p.stop(); rec.stop(); await done;
    if (musicStarted) DeskMusic.stop();
    const blob = new Blob(chunks, { type: mime.split(';')[0] });
    const ext = mime.startsWith('video/mp4') ? 'mp4' : 'webm';
    const name = `${show.o.name.replace(/[^\w]+/g, '-')}-week-${show.o.week}-recap.${ext}`;
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
    return { blob, name };
  }

  // A full-screen player for pages other than the desk (the Matchups recap card).
  async function openModal(sb, opts) {
    let el = document.getElementById('rvModal');
    if (!el) {
      el = document.createElement('div'); el.id = 'rvModal';
      el.innerHTML = '<style>#rvModal{position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.92);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:16px}#rvModal canvas{width:min(96vw,calc(86vh*16/9));aspect-ratio:16/9;border-radius:12px;background:#000}#rvModal .b{display:flex;gap:10px;flex-wrap:wrap;justify-content:center}#rvModal button{font:700 15px system-ui,sans-serif;padding:10px 18px;border-radius:999px;border:1px solid rgba(255,255,255,.3);background:rgba(255,255,255,.12);color:#fff;cursor:pointer}#rvModal .s{color:#bbb;font:500 13px system-ui,sans-serif}</style><canvas></canvas><div class="b"><button data-a="replay" type="button">↻ Replay</button><button data-a="dl" type="button">⬇ Download video</button><button data-a="close" type="button">✕ Close</button></div><div class="s"></div>';
      document.body.appendChild(el);
    }
    el.style.display = 'flex';
    if (!document.getElementById('rvFonts')) {
      const l = document.createElement('link'); l.id = 'rvFonts'; l.rel = 'stylesheet';
      l.href = 'https://fonts.googleapis.com/css2?family=Barlow+Condensed:ital,wght@0,700;1,800&family=Inter:wght@600&family=Baloo+2:wght@800&family=Nunito:wght@700&display=swap';
      document.head.appendChild(l);
    }
    try { await Promise.race([Promise.all(["italic 800 40px 'Barlow Condensed'", "800 40px 'Baloo 2'", "700 20px Nunito", "600 20px Inter"].map((f) => document.fonts.load(f))), new Promise((r) => setTimeout(r, 2500))]); } catch (e) { /* fallback fonts */ }
    const cv = el.querySelector('canvas'), status = el.querySelector('.s');
    status.textContent = 'Building the recap…';
    const show = await build(sb, opts);
    if (!show) { status.textContent = 'No finished games for that week yet.'; return; }
    status.textContent = '';
    let p = play(cv, show);
    el.querySelector('[data-a=replay]').onclick = () => { p.stop(); p = play(cv, show); };
    el.querySelector('[data-a=close]').onclick = () => { p.stop(); el.style.display = 'none'; };
    const dl = el.querySelector('[data-a=dl]');
    dl.disabled = false; dl.textContent = '⬇ Download video';
    dl.onclick = async () => {
      dl.disabled = true; dl.textContent = 'Recording…'; status.textContent = `Recording in real time (about ${Math.round(show.duration / 1000)} seconds). Keep this tab open.`;
      try { const r = await download(show); status.textContent = `Saved ${r.name}`; dl.textContent = '⬇ Download again'; }
      catch (e) { status.textContent = 'This browser can’t record video. Try Chrome or Edge.'; dl.textContent = '⬇ Download video'; }
      dl.disabled = false;
    };
  }

  window.RecapVideo = { build, play, download, openModal, _renderAt: renderAt };
})();
