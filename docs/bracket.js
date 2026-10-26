// bracket.js -- the projected / live playoff bracket at the top of Outlook,
// plus the "round update" cinematic.
//
// Loaded after outlook.js and uses its globals (state, allRows, teamInfo,
// simulateOutlook, strengthAsOf, computeStandings, fillMissingTeams,
// seedOrder, placeGames, fetchAllRows, sb, normalCdf ...). outlook.js calls
// window.renderBracket(cur, W, animate) at the end of every render().
//
// Two modes:
//   * PROJECTION (regular season still going as of the selected week): every
//     slot shows the team most likely to land there and its odds, from the
//     same simulated seasons as the table below.
//   * LIVE (the regular season is over as of the selected week): the field is
//     real. Finished rounds show real results, the round being played shows
//     its real matchups, and later slots stay empty -- nothing is projected.
//
// The bracket scales to the league: 2^R teams-sized bracket (4, 8, 16 ...),
// with byes dropped into round 2, any number of rounds, two sides converging
// on the champion in the middle.
(function () {
  const SW = 156, SH = 44, GAPX = 40, PAD = 18, PITCH = 54, TOP = 44;
  const BELOW_H = 210;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  let built = false;
  let geo = null;
  let view = null;
  let runId = 0;
  let autoDone = new Set();
  let lastBuildKey = '';
  let K = 0; // last finished round of the current view

  const reduceMotion = () =>
    document.documentElement.hasAttribute('data-reduce-motion') ||
    (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  // ---------------------------------------------------------------- geometry
  function roundCount() { return Math.max(1, Math.round(Math.log2(state.size))); }
  function buildGeometry() {
    const R = roundCount(), size = state.size;
    const cols = R === 1 ? 1 : 2 * (R - 1) + 1;
    const stageW = PAD * 2 + cols * SW + (cols - 1) * GAPX;
    const S = R === 1 ? 0 : (size / 4) * 2 * PITCH;
    const midY = Math.max(190, TOP + S / 2);
    const ystart = midY - S / 2;
    const H = Math.max(330, ystart + S + 26);
    const g = { R, size, cols, stageW, S, midY, ystart, H };
    const slotY = (r, q, side) => {
      if (r === 1) return ystart + (2 * q + (side === 'b' ? 1 : 0)) * PITCH;
      const fq = 2 * q + (side === 'b' ? 1 : 0);
      return center(r - 1, fq) - SH / 2;
    };
    const center = (r, q) => (slotY(r, q, 'a') + slotY(r, q, 'b')) / 2 + SH / 2;
    g.pos = (r, p, side) => {
      if (r === R) return { x: (stageW - SW) / 2, y: side === 'a' ? midY - 48 : midY + 4, left: null };
      const nR = size / Math.pow(2, r), half = nR / 2;
      const left = p < half, q = left ? p : p - half;
      const x = left ? PAD + (r - 1) * (SW + GAPX) : stageW - PAD - SW - (r - 1) * (SW + GAPX);
      return { x, y: slotY(r, q, side), left };
    };
    g.nGames = (r) => size / Math.pow(2, r);
    // Structural target of game (r,p): the slot it feeds.
    g.target = (r, p) => {
      if (r >= R) return null;
      const half = g.nGames(r) / 2;
      if (r + 1 === R) return `${R}|0|${p < half ? 'a' : 'b'}`;
      return `${r + 1}|${Math.floor(p / 2)}|${p % 2 === 0 ? 'a' : 'b'}`;
    };
    g.isByePos = (p) => seedOrder(size / 2)[p] <= state.byes; // round-1 positions with no game
    g.roundName = (r) => {
      const d = R - r;
      if (d === 0) return 'Championship';
      if (r === 1 && state.byes > 0 && R >= 3) return 'Wild Card';
      if (d === 1) return 'Semifinals';
      if (d === 2) return 'Quarterfinals';
      return `Round ${r}`;
    };
    return g;
  }

  // ---------------------------------------------------------------- views
  // A view: { mode, slots: Map(key -> {team,mode,pct,score,out,bye,seed}), lines: Map,
  //           F, champion, odds:[[team,p]], note, rounds:[{r,week,games:[...]}], teamSlot:[..] }
  function projView(cur, W) {
    const g = geo, slots = new Map(), lines = new Map();
    // One coherent projected bracket: give each seed its most likely team (no
    // team twice), then advance the stronger team in every game. Percentages are
    // that team's own odds of holding the seed / reaching that round.
    const P = state.playoffSpots, size = g.size, byes = state.byes;
    const cand = [];
    for (let i = 0; i < P; i++) { const m = cur.seedCounts && cur.seedCounts.get(i); if (m) for (const [t, n] of m) cand.push([n, i, t]); }
    cand.sort((x, y) => y[0] - x[0]);
    const seedTeam = new Array(P).fill(null), seedPct = new Array(P).fill(0), usedT = new Set();
    for (const [n, i, t] of cand) { if (seedTeam[i] || usedT.has(t)) continue; seedTeam[i] = t; seedPct[i] = n / cur.numSims; usedT.add(t); }
    const rest = state.teamIds.filter((t) => !usedT.has(t)).sort((x, y) => cur.get(y).playoffs - cur.get(x).playoffs);
    for (let i = 0; i < P; i++) if (!seedTeam[i]) { seedTeam[i] = rest.shift(); seedPct[i] = 0; }
    const seedIdx = (t) => seedTeam.indexOf(t);
    const reach = (t, r) => (r === g.R ? cur.get(t).final : r === g.R - 1 ? cur.get(t).semis : cur.get(t).playoffs);
    const put = (r, pos, side, t, pct) => slots.set(`${r}|${pos}|${side}`, { team: t, mode: 'proj', pct: Math.round(pct * 100) });
    // Fixed bracket: seeds sit in their standard spots and winners move straight
    // along the lines, so what you see is one believable path.
    const occ = treeInit(seedTeam);
    for (let r = 1; r <= g.R; r++) for (let p = 0; p < g.nGames(r); p++) {
      const a = occ.get(`${r}|${p}|a`), b = occ.get(`${r}|${p}|b`);
      if (a && b && r < g.R) occ.set(g.target(r, p), cur.get(a).mu >= cur.get(b).mu ? a : b);
    }
    for (const [key, t] of occ) {
      const r = Number(key.split('|')[0]);
      put(r, Number(key.split('|')[1]), key.split('|')[2], t, r === 1 ? seedPct[seedIdx(t)] : reach(t, r));
    }
    for (let r = 1; r <= g.R; r++) for (let p = 0; p < g.nGames(r); p++) {
      if (r === 1 && g.isByePos(p)) continue;
      for (const side of ['a', 'b']) { const k = `${r}|${p}|${side}`; if (!slots.has(k)) slots.set(k, { team: null, mode: 'empty' }); }
    }
    addStructureLines(slots, lines);
    const odds = state.teamIds.map((id) => [id, cur.get(id).title]).sort((a, b) => b[1] - a[1]).slice(0, Math.max(2, Math.min(8, state.playoffSpots))).filter((x) => x[1] >= 0.005);
    return {
      mode: 'proj', slots, lines, F: 0, champion: null, odds, rounds: [], teamSlot: [],
      note: `${W < state.regEnd ? 'Regular season' : 'Final regular-season picture'} · most likely team for each spot, from ${cur.numSims.toLocaleString()} simulated seasons`,
    };
  }

  function addStructureLines(slots, lines) {
    const g = geo;
    for (let r = 1; r < g.R; r++) for (let p = 0; p < g.nGames(r); p++) {
      if (r === 1 && g.isByePos(p)) continue;
      const to = g.target(r, p);
      for (const side of ['a', 'b']) {
        const from = `${r}|${p}|${side}`;
        lines.set(`${from}>${to}`, { from, to, on: false });
      }
    }
  }

  // Seeds into the fixed bracket: round-1 games for seeds without a bye, bye
  // seeds straight into their round-2 slot.
  function treeInit(seeds) {
    const g = geo, size = g.size, byes = state.byes, ord1 = seedOrder(size / 2);
    const occ = new Map();
    seeds.forEach((t, i) => {
      if (!t) return;
      const n = i + 1, rank = n <= size / 2 ? n : size + 1 - n, pos = Math.max(0, ord1.indexOf(rank));
      if (n > byes || g.R < 2) occ.set(`1|${pos}|${n <= size / 2 ? 'a' : 'b'}`, t);
      else occ.set(g.target(1, pos), t);
    });
    return occ;
  }

  function realView(W) {
    const g = geo, size = state.size, R = g.R, P = state.playoffSpots, byes = state.byes, regEnd = state.regEnd;
    const st = fillMissingTeams(computeStandings(allRows, teamInfo, regEnd), state.teamIds, teamInfo);
    const seeds = st.slice(0, P).map((s) => s.teamId);
    const seedMap = new Map(seeds.map((t, i) => [t, i]));
    const seedIdx = (t) => seedMap.get(t);
    const latest = new Map();
    for (const r of allRows) {
      const k = `${r.week}|${r.team_id}`;
      const ex = latest.get(k);
      if (!ex || new Date(r.ts) > new Date(ex.ts)) latest.set(k, r);
    }
    const info = (week, x, y) => {
      if (week > W) return null;
      const rx = latest.get(`${week}|${x}`), ry = latest.get(`${week}|${y}`);
      if (!rx || !ry || rx.matchup_id !== ry.matchup_id) return null;
      return { matchupId: rx.matchup_id, sa: rx.actual_score, sb: ry.actual_score, final: !!(rx.all_starters_done && ry.all_starters_done), aHome: !!rx.is_home };
    };
    const byeTeams = seeds.slice(0, byes);
    const occ = treeInit(seeds);
    const slots = new Map(), lines = new Map();
    addStructureLines(slots, lines);
    const rounds = [], gameAt = new Map();
    let F = 0, prevComplete = true, firstIncomplete = null, pairsForIncomplete = null;

    for (let r = 1; r <= R; r++) {
      const week = regEnd + r;
      // The real week's matchups can differ from the fixed bracket (leagues that
      // reseed): once the previous round is done, trust the real pairings.
      if (prevComplete && r >= 2) {
        const here = [...occ].filter(([k]) => k.startsWith(r + '|')).map(([, t]) => t);
        const pset = new Set(here);
        const avail = (state.pairingsByWeek.get(week) || []).filter(([x, y]) => pset.has(x) && pset.has(y));
        const treePairs = [];
        for (let p = 0; p < g.nGames(r); p++) { const a = occ.get(`${r}|${p}|a`), b = occ.get(`${r}|${p}|b`); if (a && b) treePairs.push([a, b]); }
        const same = avail.length === treePairs.length && avail.every(([x, y]) => treePairs.some(([a, b]) => (a === x && b === y) || (a === y && b === x)));
        if (avail.length * 2 === here.length && !same) {
          for (const k of [...occ.keys()]) if (k.startsWith(r + '|')) occ.delete(k);
          for (const pg of placeGames(avail, seedIdx, r, size)) { occ.set(`${r}|${pg.pos}|a`, pg.a); occ.set(`${r}|${pg.pos}|b`, pg.b); }
        }
      }
      const games = [];
      for (let p = 0; p < g.nGames(r); p++) {
        const a = occ.get(`${r}|${p}|a`), b = occ.get(`${r}|${p}|b`);
        if (!a || !b) continue;
        const inf = info(week, a, b);
        let winner = null;
        if (inf && inf.final) winner = inf.sa > inf.sb ? a : inf.sb > inf.sa ? b : (seedIdx(a) <= seedIdx(b) ? a : b);
        const game = { r, week, pos: p, a, b, winner, sa: inf ? inf.sa : null, sb: inf ? inf.sb : null, final: !!(inf && inf.final), matchupId: inf ? inf.matchupId : null, aHome: inf ? inf.aHome : true, started: !!(inf && (inf.sa > 0 || inf.sb > 0)) };
        games.push(game); gameAt.set(`${r}|${p}`, game);
        if (winner && r < R) occ.set(g.target(r, p), winner);
      }
      const expected = r === 1 ? (P - byes) / 2 : g.nGames(r);
      rounds.push({ r, week, games });
      const complete = games.length === expected && games.every((x) => x.winner);
      if (complete) F = r;
      else if (prevComplete) { prevComplete = false; firstIncomplete = r; pairsForIncomplete = games.map((x) => [x.a, x.b]); }
    }
    // Slots from the fixed bracket.
    const teamSlot = [null];
    for (let r = 1; r <= R; r++) teamSlot[r] = new Map();
    for (const [key, t] of occ) {
      const [rs, ps, side] = key.split('|'), r = Number(rs), p = Number(ps);
      const game = gameAt.get(`${r}|${p}`);
      let score = null, out = false;
      if (game) {
        score = game.started ? (side === 'a' ? game.sa : game.sb) : null;
        out = !!(game.winner && game.winner !== t);
      }
      slots.set(key, { team: t, mode: 'locked', seed: seedIdx(t) + 1, score, out, bye: r === 2 && byeTeams.includes(t) && !(game && game.final) });
      teamSlot[r].set(t, key);
    }
    for (let r = 1; r <= R; r++) for (let p = 0; p < g.nGames(r); p++) {
      if (r === 1 && g.isByePos(p)) continue;
      for (const side of ['a', 'b']) { const k = `${r}|${p}|${side}`; if (!slots.has(k)) slots.set(k, { team: null, mode: 'empty' }); }
    }
    // Lit lines: a winner's move along the bracket.
    for (const game of gameAt.values()) {
      if (!game.winner || game.r >= R) continue;
      const from = teamSlot[game.r].get(game.winner), to = g.target(game.r, game.pos);
      const lk = `${from}>${to}`;
      if (lines.has(lk)) lines.get(lk).on = true; else lines.set(lk, { from, to, on: true });
    }
    let champion = null, odds = [];
    const last = gameAt.get(`${R}|0`);
    if (last && last.winner) champion = last.winner;
    if (champion) odds = [[champion, 1]];
    else odds = remainingOdds(seeds, seedIdx, byeTeams, firstIncomplete || 1, pairsForIncomplete, rounds, W);
    const rn = F >= 1 ? g.roundName(F) : null;
    const note = champion ? `Champion crowned · ${esc(g.roundName(R))} final`
      : F === 0 ? `Playoff field is set · ${esc(g.roundName(1))} up next`
      : `${esc(rn)} final · ${esc(g.roundName(F + 1))} next`;
    return { mode: 'real', slots, lines, F, champion, odds, rounds, teamSlot, note, seeds };
  }

  // Title odds for the teams still alive, simulated from the real state.
  function remainingOdds(seeds, seedIdx, byeTeams, r0, pairs, rounds, W) {
    const wk = Math.max(1, Math.min(W, state.cw));
    const { mu, ratings } = strengthAsOf(wk);
    const se = new Map(state.teamIds.map((id) => [id, (ratings.get(id) && ratings.get(id).stdErr) || 0]));
    const fixed = new Map();
    const cur = rounds[r0 - 1];
    if (cur) for (const x of cur.games) if (x.winner) fixed.set(`${x.a}|${x.b}`, x.winner);
    const count = new Map();
    const N = 1500;
    const draw = () => Math.sqrt(-2 * Math.log(Math.random() || 1e-9)) * Math.cos(2 * Math.PI * Math.random());
    for (let n = 0; n < N; n++) {
      const m = new Map(state.teamIds.map((id) => [id, mu.get(id) + draw() * se.get(id)]));
      const ko = (a, b) => ((m.get(a) + draw() * SCORE_SD) >= (m.get(b) + draw() * SCORE_SD) ? a : b);
      let ws = (pairs || []).map(([x, y]) => fixed.get(`${x}|${y}`) || fixed.get(`${y}|${x}`) || ko(x, y));
      let alive = ws.concat(r0 === 1 ? byeTeams : []).sort((x, y) => seedIdx(x) - seedIdx(y));
      while (alive.length > 1) {
        const nx = [];
        for (let i = 0, j = alive.length - 1; i < j; i++, j--) nx.push(ko(alive[i], alive[j]));
        alive = nx.sort((x, y) => seedIdx(x) - seedIdx(y));
      }
      if (alive[0]) count.set(alive[0], (count.get(alive[0]) || 0) + 1);
    }
    return [...count].map(([t, c]) => [t, c / N]).sort((a, b) => b[1] - a[1]);
  }

  // ---------------------------------------------------------------- DOM
  function teamIcon(t) {
    const ti = teamInfo[t] || {};
    if (ti.logoUrl) return `<img class="bk-limg" src="${esc(ti.logoUrl)}" alt="">`;
    return esc(ti.emoji || (ti.name || '?').charAt(0));
  }
  function teamName(t) { return (teamInfo[t] && teamInfo[t].name) || 'Unknown'; }
  function teamColor(t) { return (teamInfo[t] && teamInfo[t].color) || '#888'; }

  function build() {
    const host = $('bracketHero');
    host.innerHTML = `
      <div class="bk-head">
        <div><div class="bk-title">Playoff Bracket</div><div class="bk-note" id="bkNote"></div></div>
        <div class="bk-actions"><span class="bk-badge" id="bkBadge"></span><button class="bk-play" id="bkReplay" type="button" hidden>▶ Watch the update</button></div>
      </div>
      <div class="bk-scaler" id="bkScaler"><div class="bk-sizer" id="bkSizer"><div class="bk-stage" id="bkStage">
        <div class="bk-camwrap" id="bkCamwrap"><div class="bk-cam" id="bkCam">
          <svg class="bk-lines" id="bkLines"></svg><div id="bkLabels"></div>
          <div class="bk-trophy" id="bkTrophy"><div class="bk-tag">Champion</div><div class="bk-cup">🏆</div><div class="bk-champ" id="bkChamp"></div></div>
          <div id="bkSlots"></div><div class="bk-token" id="bkToken"></div>
        </div></div>
        <div class="bk-below" id="bkBelow">
          <div class="bk-cine" id="bkCine">
            <div class="bk-gline">
              <div class="bk-gteam"><span class="bk-lg" id="bkALg"></span><div><div class="bk-gn" id="bkANm"></div><div class="bk-gs" id="bkASd"></div></div></div>
              <div class="bk-pcs"><span id="bkAPc"></span><span id="bkBPc"></span></div>
              <div class="bk-gteam r"><span class="bk-lg" id="bkBLg"></span><div><div class="bk-gn" id="bkBNm"></div><div class="bk-gs" id="bkBSd"></div></div></div>
            </div>
            <div class="bk-race"><div class="fl" id="bkFl"></div><div class="fr" id="bkFr"></div><div class="mid"></div><div class="knob" id="bkKnob"></div><div class="bk-flash" id="bkFlash"></div></div>
            <svg class="bk-mini" id="bkMini" viewBox="0 0 600 78" preserveAspectRatio="none"></svg>
            <div class="bk-days" id="bkDays"></div>
            <div class="bk-fin" id="bkFin"></div>
          </div>
        </div>
        <div class="bk-lbx t"></div><div class="bk-lbx b"></div>
        <div class="bk-tcard" id="bkTcard"><div class="k" id="bkTk"></div><div class="t" id="bkTt"></div><div class="s" id="bkTs"></div></div>
        <button class="bk-skip" id="bkSkip" type="button">Skip ›</button>
      </div></div></div>
      <div class="bk-odds" id="bkOdds"></div>`;
    $('bkReplay').addEventListener('click', () => { if (view && view.F >= 1) cinematic(view.F, true); });
    $('bkSkip').addEventListener('click', () => { runId++; endCinema(); });
    window.addEventListener('resize', fit);
    built = true;
  }

  function layoutDom() {
    const g = geo;
    const stage = $('bkStage');
    const stageH = g.H + 10 + BELOW_H;
    stage.style.width = g.stageW + 'px'; stage.style.height = stageH + 'px';
    $('bkCamwrap').style.cssText = `width:${g.stageW}px;height:${g.H + 5}px`;
    $('bkCam').style.cssText = `width:${g.stageW}px;height:${g.H}px`;
    const svg = $('bkLines'); svg.setAttribute('viewBox', `0 0 ${g.stageW} ${g.H}`); svg.style.cssText = `width:${g.stageW}px;height:${g.H}px`;
    $('bkBelow').style.cssText = `top:${g.H + 10}px;width:${g.stageW}px;height:${BELOW_H}px`;
    $('bkScaler').dataset.centered = '';
    // slots
    let html = '';
    for (let r = 1; r <= g.R; r++) for (let p = 0; p < g.nGames(r); p++) {
      if (r === 1 && g.isByePos(p)) continue;
      for (const side of ['a', 'b']) {
        const ps = g.pos(r, p, side);
        html += `<div class="bk-slot empty" data-k="${r}|${p}|${side}" style="left:${ps.x}px;top:${ps.y}px"><span class="seed"></span><span class="logo"></span><span class="nm">TBD</span><span class="pc"></span></div>`;
      }
    }
    $('bkSlots').innerHTML = html;
    // column labels
    let lab = '';
    const label = (r, x) => `<div class="bk-rlabel" style="left:${x}px">${esc(g.roundName(r))}<small data-wk="${r}"></small></div>`;
    for (let r = 1; r < g.R; r++) {
      lab += label(r, g.pos(r, 0, 'a').x);
      lab += label(r, g.pos(r, g.nGames(r) - 1, 'a').x);
    }
    lab += label(g.R, (g.stageW - SW) / 2);
    $('bkLabels').innerHTML = lab;
    $('bkTrophy').style.cssText = `left:${(g.stageW - 200) / 2}px;top:${g.R === 1 ? 20 : 40}px`;
    fit();
  }

  let cinemaOn = false;
  function fit() {
    if (!geo) return;
    const scaler = $('bkScaler'), g = geo;
    const avail = scaler.clientWidth || g.stageW;
    const s = Math.max(0.62, Math.min(1, avail / g.stageW));
    const stageH = g.H + 10 + BELOW_H;
    const shownH = cinemaOn ? stageH : g.H + 10;
    $('bkStage').style.transform = `scale(${s})`;
    $('bkSizer').style.cssText = `width:${g.stageW * s}px;height:${shownH * s}px;transition:height .5s ease`;
    const wide = g.stageW * s > avail + 1;
    scaler.style.overflowX = wide && !cinemaOn ? 'auto' : 'hidden';
    scaler.style.overflowY = 'hidden';
    if (wide && !scaler.dataset.centered) { scaler.scrollLeft = (g.stageW * s - avail) / 2; scaler.dataset.centered = '1'; }
    scaler.dataset.scale = s;
    const vw = Math.min(g.stageW, avail / s);
    $('bkCine').style.width = vw + 'px';
    $('bkTcard').style.width = vw + 'px';
    $('bkSkip').style.right = (g.stageW - vw + 14) + 'px';
  }

  function drawLines() {
    const g = geo;
    const pathFor = (fromKey, toKey) => {
      const [fr, fp, fs] = fromKey.split('|'), [tr, tp, ts] = toKey.split('|');
      const f = g.pos(Number(fr), Number(fp), fs), t = g.pos(Number(tr), Number(tp), ts);
      const fromLeft = f.left === null ? true : f.left;
      const sx = fromLeft ? f.x + SW : f.x, sy = f.y + SH / 2;
      const tx = fromLeft ? t.x : t.x + SW, ty = t.y + SH / 2;
      const mx = (sx + tx) / 2;
      return { pts: [[sx, sy], [mx, sy], [mx, ty], [tx, ty]] };
    };
    let html = '';
    for (const [k, l] of view.lines) {
      const { pts } = pathFor(l.from, l.to);
      html += `<path data-p="${k}" class="${l.on ? 'on' : ''}" d="M${pts.map((q) => q.join(',')).join(' L')}"/>`;
    }
    $('bkLines').innerHTML = html;
    $('bkLines')._pathFor = pathFor;
  }

  function slotEl(key) { return document.querySelector(`.bk-slot[data-k="${key}"]`); }
  function paintSlot(key, s) {
    const el = slotEl(key); if (!el) return;
    el.className = 'bk-slot';
    if (!s || !s.team) { el.classList.add('empty'); el.style.removeProperty('--tc'); el.querySelector('.seed').textContent = ''; el.querySelector('.logo').innerHTML = ''; el.querySelector('.nm').textContent = 'TBD'; el.querySelector('.pc').textContent = ''; return; }
    el.classList.add(s.mode === 'proj' ? 'proj' : 'locked');
    if (s.out) el.classList.add('out');
    if (s.bye) el.classList.add('hasbye');
    el.style.setProperty('--tc', teamColor(s.team));
    el.querySelector('.seed').textContent = s.mode === 'locked' && s.seed ? s.seed : '';
    el.querySelector('.logo').innerHTML = teamIcon(s.team);
    el.querySelector('.nm').textContent = teamName(s.team);
    el.querySelector('.pc').textContent = s.mode === 'proj' ? s.pct + '%' : (s.score != null ? s.score.toFixed(1) : (s.bye ? 'BYE' : ''));
  }

  function applyView(v) {
    view = v;
    for (const el of document.querySelectorAll('.bk-slot')) paintSlot(el.dataset.k, v.slots.get(el.dataset.k));
    drawLines();
    // week labels
    for (const sm of document.querySelectorAll('#bkLabels small[data-wk]')) {
      const r = Number(sm.dataset.wk);
      sm.textContent = 'Wk ' + (state.regEnd + r);
    }
    const champ = v.champion;
    $('bkTrophy').classList.toggle('crowned', !!champ);
    $('bkChamp').textContent = champ ? (teamInfo[champ].emoji || '') + ' ' + teamName(champ) : '';
    $('bkChamp').style.color = champ ? teamColor(champ) : '';
    $('bkNote').textContent = ''; $('bkNote').innerHTML = v.note;
    $('bkBadge').textContent = v.mode === 'proj' ? 'PROJECTED' : champ ? 'FINAL' : 'LIVE BRACKET';
    $('bkReplay').hidden = !(v.mode === 'real' && v.F >= 1);
    renderOdds(v);
  }

  function renderOdds(v) {
    const rows = v.odds || [];
    $('bkOdds').innerHTML = `<h4>${v.champion ? 'Champion' : v.mode === 'real' ? 'Title odds · teams still alive' : 'Title odds'}</h4>` +
      rows.map(([t, p]) => `<div class="bk-orow"><span class="n"><span class="ic">${teamIcon(t)}</span>${esc(teamName(t))}</span><span class="bar"><i style="background:${teamColor(t)}" data-w="${Math.round(p * 100)}"></i></span><span class="p">${p >= 0.995 ? '100%' : p < 0.005 ? '<1%' : Math.round(p * 100) + '%'}</span></div>`).join('');
    requestAnimationFrame(() => requestAnimationFrame(() => document.querySelectorAll('#bkOdds .bar i').forEach((i) => { i.style.width = i.dataset.w + '%'; })));
  }

  // ---------------------------------------------------------------- entry point
  window.renderBracket = function (cur, W, animate) {
    const host = $('bracketHero');
    if (!host) return;
    if (state.size < 2 || state.playoffSpots < 2) { host.hidden = true; return; }
    host.hidden = false;
    runId++; // a re-render (slider, league change) interrupts any running cinematic
    const key = `${state.leagueId}|${state.size}|${state.byes}|${state.regEnd}`;
    if (!built) build();
    if (key !== lastBuildKey) { geo = buildGeometry(); layoutDom(); lastBuildKey = key; }
    endCinema(true);
    const real = W >= state.regEnd && state.cw >= state.regEnd;
    const v = real ? realView(W) : projView(cur, W);
    applyView(v);
    camera(0, 0, 1, true, true);
    fit();
    // Auto-play once per device the first time a finished round is seen.
    if (real && W === state.cw && v.F >= 1 && !reduceMotion()) {
      const seenKey = `winProbBracketSeen:v1:${state.leagueId}:${state.year}:${v.F}`;
      let seen = false;
      try { seen = localStorage.getItem(seenKey) === '1'; } catch { /* ignore */ }
      if (!seen && !autoDone.has(seenKey)) {
        autoDone.add(seenKey);
        try { localStorage.setItem(seenKey, '1'); } catch { /* ignore */ }
        cinematic(v.F, false);
      }
    }
  };

  // ---------------------------------------------------------------- cinematic
  const sleep = (ms, id) => new Promise((res, rej) => setTimeout(() => (id === runId ? res() : rej('skip')), ms * (reduceMotion() ? 0.5 : 1)));
  function tween(ms, fn, id) {
    ms = ms * (reduceMotion() ? 0.5 : 1);
    return new Promise((res, rej) => {
      const t0 = performance.now();
      (function f(now) { if (id !== runId) return rej('skip'); const t = Math.min(1, (now - t0) / ms); fn(t); t < 1 ? requestAnimationFrame(f) : res(); })(t0);
    });
  }
  function vwUnits() { const sc = Number($('bkScaler').dataset.scale) || 1; return Math.min(geo.stageW, ($('bkScaler').clientWidth || geo.stageW) / sc); }
  function camera(x, y, s, instant, home) {
    const cam = $('bkCam');
    cam.classList.toggle('nomo', !!instant || reduceMotion());
    if (home) { cam.style.transform = 'none'; return; }
    cam.style.transform = `translate(${vwUnits() / 2 - x * s}px,${geo.H / 2 - y * s}px) scale(${s})`;
  }
  function endCinema(quiet) {
    $('bkStage').classList.remove('cinema'); cinemaOn = false;
    $('bkCam').classList.remove('dim');
    $('bkCine').classList.remove('show'); $('bkOdds').classList.remove('hide'); $('bkTcard').classList.remove('show');
    $('bkToken').style.display = 'none';
    document.querySelectorAll('.bk-slot').forEach((s) => s.classList.remove('focus', 'pop'));
    const sc = $('bkScaler'); sc.style.pointerEvents = '';
    if (!quiet && view && geo) { camera(0, 0, 1, true, true); fit(); applyView(currentRealView || view); }
    $('bkReplay').disabled = false;
  }
  let currentRealView = null;

  async function loadTimeline(week, games) {
    const ids = games.map((x) => x.matchupId).filter((x) => x != null);
    const out = new Map();
    if (!ids.length) return out;
    const ck = `winProbBracketTL:v1:${state.leagueId}:${state.year}:${week}`;
    try { const c = JSON.parse(localStorage.getItem(ck) || 'null'); if (c && ids.every((i) => c[i])) { for (const i of ids) out.set(i, c[i]); return out; } } catch { /* ignore */ }
    try {
      const rows = await fetchAllRows((from, to) => sb.from('snapshots').select('ts,matchup_id,win_prob')
        .eq('league_id', state.leagueId).eq('year', state.year).eq('week', week).eq('is_home', true).in('matchup_id', ids)
        .order('ts').range(from, to));
      const by = new Map();
      for (const r of rows) { if (r.win_prob == null) continue; if (!by.has(r.matchup_id)) by.set(r.matchup_id, []); by.get(r.matchup_id).push([new Date(r.ts).getTime(), Number(r.win_prob)]); }
      const cache = {};
      for (const [id, pts] of by) {
        const step = Math.max(1, Math.floor(pts.length / 110));
        const ds = pts.filter((_, i) => i % step === 0 || i === pts.length - 1);
        out.set(id, ds); cache[id] = ds;
      }
      if (ids.every((i) => cache[i]) && games.every((x) => x.final)) { try { localStorage.setItem(ck, JSON.stringify(cache)); } catch { /* ignore */ } }
    } catch (e) { console.warn('bracket timeline unavailable:', e.message || e); }
    return out;
  }
  const wpAt = (pts, t) => { // pts: [[tFrac, p]]
    for (let i = 1; i < pts.length; i++) if (t <= pts[i][0]) { const [t0, v0] = pts[i - 1], [t1, v1] = pts[i]; return v0 + (v1 - v0) * ((t - t0) / (t1 - t0 || 1)); }
    return pts[pts.length - 1][1];
  };

  async function cinematic(k, manual) {
    if (!view || view.mode !== 'real' || k < 1) return;
    const id = ++runId;
    $('bkReplay').disabled = true;
    const afterW = state.regEnd + k;
    const before = realView(state.regEnd + k - 1), after = realView(afterW);
    currentRealView = after;
    const rd = after.rounds[k - 1];
    if (!rd) { endCinema(); return; }
    try {
      const tl = await loadTimeline(rd.week, rd.games);
      if (id !== runId) return;
      const sc = $('bkScaler'); sc.scrollLeft = 0; cinemaOn = true; fit();
      applyView(before);
      camera(0, 0, 1, true, true);
      $('bkStage').classList.add('cinema');
      $('bkTk').textContent = 'WEEK ' + rd.week; $('bkTt').textContent = geo.roundName(k);
      $('bkTs').textContent = k === geo.R ? 'The title was on the line' : 'Here’s how the bracket moved';
      $('bkTcard').classList.add('show'); await sleep(2000, id); $('bkTcard').classList.remove('show'); await sleep(450, id);
      const games = rd.games.slice().sort((x, y) => x.pos - y.pos);
      for (const gm of games) await playGame(gm, k, tl.get(gm.matchupId), after, id);
      camera(geo.stageW / 2, geo.H / 2, 1.15); await sleep(900, id);
      applyView(after); camera(0, 0, 1, false, true); await sleep(900, id);
    } catch (e) { if (e !== 'skip') console.error(e); }
    finally { if (id === runId) { endCinema(); applyView(after); } }
  }

  function normPts(pts, aHome, final, winnerIsA) {
    if (!pts || pts.length < 2) return [[0, 50], [1, winnerIsA ? 100 : 0]];
    const t0 = pts[0][0], t1 = pts[pts.length - 1][0] || t0 + 1;
    const out = pts.map(([t, p]) => [(t - t0) / (t1 - t0 || 1), aHome ? p : 100 - p]);
    return out;
  }

  async function playGame(gm, k, pts, after, id) {
    const g = geo;
    const A = gm.a, B = gm.b;
    const sa = slotEl(`${k}|${gm.pos}|a`), sb = slotEl(`${k}|${gm.pos}|b`);
    const pa = g.pos(k, gm.pos, 'a'), pb = g.pos(k, gm.pos, 'b');
    const cx = (pa.x + pb.x) / 2 + SW / 2, cy = (pa.y + pb.y) / 2 + SH / 2;
    $('bkCam').classList.add('dim'); sa.classList.add('focus'); sb.classList.add('focus');
    camera(cx, cy, k === g.R ? 1.35 : 1.5);
    const colA = teamColor(A), colB = teamColor(B);
    const seedOf = (t) => (after.seeds ? after.seeds.indexOf(t) + 1 : 0);
    $('bkALg').innerHTML = teamIcon(A); $('bkBLg').innerHTML = teamIcon(B);
    $('bkANm').textContent = teamName(A); $('bkBNm').textContent = teamName(B);
    $('bkASd').textContent = 'Seed ' + seedOf(A); $('bkBSd').textContent = 'Seed ' + seedOf(B);
    $('bkFin').classList.remove('show');
    $('bkFl').style.background = colA; $('bkFr').style.background = colB;
    $('bkAPc').style.color = colA; $('bkBPc').style.color = colB;
    $('bkMini').innerHTML = ''; $('bkOdds').classList.add('hide'); $('bkCine').classList.add('show');
    const winnerIsA = gm.winner === A;
    const wp = normPts(pts, gm.aHome, gm.final, winnerIsA);
    // weekday ticks from the real timestamps
    const days = $('bkDays');
    if (pts && pts.length > 1) {
      const t0 = pts[0][0], t1 = pts[pts.length - 1][0];
      days.innerHTML = [0, .25, .5, .75, 1].map((f) => `<span>${new Date(t0 + (t1 - t0) * f).toLocaleDateString(undefined, { weekday: 'short' }).toUpperCase()}</span>`).join('');
    } else days.innerHTML = '';
    await sleep(750, id);
    const mini = $('bkMini'), NS = 'http://www.w3.org/2000/svg';
    mini.innerHTML = '<line x1="0" x2="600" y1="39" y2="39" stroke="currentColor" stroke-opacity=".35" stroke-dasharray="4 4" vector-effect="non-scaling-stroke"/>';
    let lastX = null, lastY = null, lead = null;
    const yOf = (p) => 39 - (p - 50) * 0.72;
    await tween(4000, (t) => {
      const p = wpAt(wp, t);
      const l = lead === null ? (p >= 50 ? 'a' : 'b') : (lead === 'a' ? (p < 46 ? 'b' : 'a') : (p > 54 ? 'a' : 'b'));
      $('bkFl').style.width = p + '%'; $('bkFr').style.width = (100 - p) + '%'; $('bkKnob').style.left = p + '%';
      $('bkAPc').textContent = Math.round(p) + '%'; $('bkBPc').textContent = Math.round(100 - p) + '%';
      const x = t * 600, y = yOf(p);
      if (lastX !== null) {
        const ln = document.createElementNS(NS, 'line');
        ln.setAttribute('x1', lastX); ln.setAttribute('y1', lastY); ln.setAttribute('x2', x); ln.setAttribute('y2', y);
        ln.setAttribute('stroke', l === 'a' ? colA : colB); ln.setAttribute('stroke-width', '3'); ln.setAttribute('stroke-linecap', 'round'); ln.setAttribute('vector-effect', 'non-scaling-stroke');
        mini.appendChild(ln);
      }
      lastX = x; lastY = y;
      if (lead && l !== lead && t > 0.05 && t < 0.97) flash('LEAD CHANGE', false);
      lead = l;
    }, id);
    const winT = gm.winner, loseT = winT === A ? B : A;
    const pre = wp[0][1]; // slot-a team's starting win probability
    const upset = (winnerIsA ? pre : 100 - pre) < 40;
    const wScore = winT === A ? gm.sa : gm.sb, lScore = winT === A ? gm.sb : gm.sa;
    $('bkFin').textContent = `FINAL · ${teamName(winT)} ${wScore != null ? Number(wScore).toFixed(1) : ''} – ${lScore != null ? Number(lScore).toFixed(1) : ''}`;
    $('bkFin').classList.add('show');
    $('bkAPc').textContent = (winnerIsA ? 100 : 0) + '%'; $('bkBPc').textContent = (winnerIsA ? 0 : 100) + '%';
    $('bkFl').style.width = (winnerIsA ? 100 : 0) + '%'; $('bkFr').style.width = (winnerIsA ? 0 : 100) + '%'; $('bkKnob').style.left = (winnerIsA ? 100 : 0) + '%';
    if (upset) flash('⚡ UPSET', true);
    await sleep(upset ? 1500 : 1000, id);
    const winSlot = winnerIsA ? 'a' : 'b';
    slotEl(`${k}|${gm.pos}|${winnerIsA ? 'b' : 'a'}`).classList.add('out');
    sa.classList.remove('focus'); sb.classList.remove('focus');
    const fromKey = `${k}|${gm.pos}|${winSlot}`;
    if (k < g.R) {
      const toKey = after.teamSlot[k + 1] && after.teamSlot[k + 1].get(winT) || g.target(k, gm.pos);
      const pathEl = document.querySelector(`#bkLines path[data-p="${fromKey}>${toKey}"]`);
      const { pts: pp } = $('bkLines')._pathFor(fromKey, toKey);
      if (pathEl) pathEl.classList.add('glow');
      const tok = $('bkToken'); tok.innerHTML = teamIcon(winT); tok.style.display = 'flex'; tok.style.borderColor = teamColor(winT); tok.style.boxShadow = `0 0 16px ${teamColor(winT)}`;
      const segs = []; let tot = 0;
      for (let i = 1; i < pp.length; i++) { const d = Math.hypot(pp[i][0] - pp[i - 1][0], pp[i][1] - pp[i - 1][1]); segs.push(d); tot += d; }
      await tween(900, (t) => {
        let d = t * tot, i = 0;
        while (i < segs.length - 1 && d > segs[i]) { d -= segs[i]; i++; }
        const f = segs[i] ? d / segs[i] : 0;
        tok.style.left = (pp[i][0] + (pp[i + 1][0] - pp[i][0]) * f - 17) + 'px'; tok.style.top = (pp[i][1] + (pp[i + 1][1] - pp[i][1]) * f - 17) + 'px';
      }, id);
      tok.style.display = 'none';
      if (pathEl) { pathEl.classList.remove('glow'); pathEl.classList.add('on'); }
      const s2 = after.slots.get(toKey);
      paintSlot(toKey, s2 ? Object.assign({}, s2, { score: null }) : { team: winT, mode: 'locked', seed: seedOf(winT) });
      const el = slotEl(toKey); if (el) { el.classList.add('pop', 'focus'); await sleep(500, id); el.classList.remove('focus', 'pop'); }
    } else {
      camera(g.stageW / 2, 90, 1.6);
      $('bkTrophy').classList.add('crowned'); $('bkChamp').textContent = (teamInfo[winT].emoji || '') + ' ' + teamName(winT); $('bkChamp').style.color = teamColor(winT);
      await sleep(1800, id);
    }
    $('bkCine').classList.remove('show'); $('bkCam').classList.remove('dim');
    await sleep(350, id);
  }
  function flash(text, up) {
    const f = $('bkFlash'); f.textContent = text; f.classList.toggle('up', !!up);
    f.classList.remove('go'); void f.offsetWidth; f.classList.add('go');
  }
// outlook.js may have rendered before this script loaded (cached data) -- catch up.
  if (window.__lastRender) window.renderBracket(...window.__lastRender);
})();
