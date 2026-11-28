// desk.js -- runs the News Desk broadcast (desk.html).
//
// Two studios share one channel: Branford ("pro": polished network look) and
// the Family League ("casual": laid-back), each with a day and a night look.
// Each studio runs a rotation of segments (spotlight game, scoreboard,
// players, standings impact, NFL, rundown) and then throws it over to the
// other studio. Breaking news (lead changes, upsets, finals, touchdowns...)
// cuts in from either studio -- if it's the other league's story, the show
// hands off first. Data: desk-data.js. Words: desk-lines.js. Music: desk-music.js.
(function () {
  'use strict';
  const D = window.DeskData, Lines = window.DeskLines, M = window.DeskMusic;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const params = new URLSearchParams(location.search);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const REFRESH_MS = 30000;

  let leagues = [], cur = null, lock = 'auto';
  let segPlan = [], segIdx = 0, segTimer = null, segStarted = 0, segDur = 0, currentSeg = null, spotlightTurn = 0;
  let busy = false, lastBreakingAt = 0, mode = 'studio', whipTurn = 0, cdTimer = 0;
  const breakingQ = [], alertQ = [];
  const rundown = new Map(); // league id -> [{head, body, ts, priority}]
  const tickerHeads = [];

  // ------------------------------------------------------------------ helpers
  const shortName = (L) => (L ? L.name.replace(/\s*league\s*$/i, '').trim() : '');
  const night = () => (params.get('look') === 'night' ? true : params.get('look') === 'day' ? false : D.isNight()); // ?look=day|night to preview
  const voice = (L) => (L ? L.studio : (cur ? cur.studio : 'pro'));
  // Team colors, adjusted so they stay readable on the current look: very dark
  // colors are lifted on the night sets, very light ones deepened on the day sets.
  const isDark = () => document.documentElement.dataset.daypart === 'night';
  const vis = (hex) => WPChart.teamColor(hex, isDark());
  const T = (L, id) => { const t = D.team(L, id); return Object.assign({}, t, { color: vis(t.color) }); };
  const fmt = (x) => Number(x || 0).toFixed(1);
  const nameSize = (s) => (String(s).length > 22 ? 34 : String(s).length > 16 ? 40 : 50);
  function icon(t) {
    if (t.logoUrl) return `<span class="ic"><img src="${esc(t.logoUrl)}" alt=""></span>`;
    if (t.emoji) return `<span class="ic">${esc(t.emoji)}</span>`;
    const ini = String(t.name || '?').split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
    return `<span class="ic ini" style="background:${esc(t.color)}">${esc(ini)}</span>`;
  }
  // ESPN headshots by player id (D/ST ids are negative: use the NFL team logo instead).
  function headshot(id, tm, cls) {
    if (id == null && !tm) return '';
    const src = Number(id) < 0 || id == null ? (tm ? `https://a.espncdn.com/i/teamlogos/nfl/500/${String(tm).toLowerCase()}.png` : '') : `https://a.espncdn.com/i/headshots/nfl/players/full/${id}.png`;
    return src ? `<img class="${cls || 'hs'}" src="${src}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">` : '';
  }
  const ago = (ts) => { const s = Math.max(0, (Date.now() - ts) / 1000); return s < 60 ? 'just now' : s < 3600 ? Math.round(s / 60) + 'm ago' : Math.round(s / 3600) + 'h ago'; };
  const leftToPlay = (L, teamId) => { const p = L.lineups.get(teamId); return p ? p.filter((x) => !x.bench && (x.g === 'pre' || x.g === 'in')).length : null; };

  // ------------------------------------------------------------------ scaling
  // The layout is 1920x1080; it's scaled to fit the window, and the TV itself
  // grows to fill whatever is left over (wider or taller screens), so there are
  // never bars at the edges.
  function fit() {
    const s = Math.min(innerWidth / 1920, innerHeight / 1080);
    const w = innerWidth / s, h = innerHeight / s;
    const tv = $('tv'), fr = $('frame');
    tv.style.width = w + 'px'; tv.style.height = h + 'px'; tv.style.transform = `scale(${s})`;
    fr.style.left = (w - 1920) / 2 + 'px'; fr.style.top = (h - 1080) / 2 + 'px';
    if (window.DeskFx && DeskFx.resize) DeskFx.resize(w, h);
  }

  // ------------------------------------------------------------------ studio
  function showName(L) {
    const n = night();
    return L.studio === 'pro' ? (n ? 'Primetime' : 'Live') : (n ? 'Couch Crew' : 'Front Porch');
  }
  function applyStudio(L) {
    cur = L;
    const root = document.documentElement;
    root.dataset.studio = L.studio; root.dataset.daypart = night() ? 'night' : 'day';
    $('brandMark').textContent = shortName(L).toUpperCase();
    const tag = window.DeskFx ? DeskFx.holidayTag(L.studio) : '';
    const mn = modeName(L.studio);
    $('brandShow').textContent = shortName(L) + ' ' + (mn || showName(L)) + (tag ? ' \u00b7 ' + tag : '');
    $('tickerLabel').textContent = L.studio === 'pro' ? 'SCORES' : 'THE SCOOP';
    $('anchorTag').innerHTML = L.studio === 'pro' ? 'The<br>Desk' : 'Couch<br>Talk';
    M.setStyle(L.studio, night() ? 'night' : 'day');
    renderTop(); renderSide();
  }
  function renderTop() {
    if (!cur) return;
    const live = cur.matchups.filter((m) => !m.done).length;
    $('brandSub').textContent = `Week ${cur.week || '–'} · ${cur.year || ''}` + (live ? ` · ${live} matchup${live === 1 ? '' : 's'} live` : ' · all games final');
    $('live').classList.toggle('off', !D.anyLive());
    $('live').querySelector('span').textContent = D.anyLive() ? 'LIVE' : (night() ? 'TONIGHT' : 'STUDIO');
    const np = M.running && M.nowPlaying();
    $('np').textContent = np ? `♪ ${np.style} · ${np.key} · ${np.tempo} bpm` : '';
  }
  function tickClock() {
    $('clock').textContent = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const dp = night() ? 'night' : 'day';
    if (cur && document.documentElement.dataset.daypart !== dp) applyStudio(cur);
  }

  // ------------------------------------------------------------------ side column
  function renderSide() {
    if (!cur) return;
    const list = (rundown.get(cur.id) || []).slice(0, 5);
    $('rundownSub').textContent = shortName(cur);
    $('rundownList').innerHTML = list.length ? list.map((r, i) => `<div class="rd p${r.priority}${r.fresh && i === 0 ? ' new' : ''}"><i class="dot"></i><div><b>${esc(r.head)}</b><span>${esc(r.body)}</span></div><time>${ago(r.ts)}</time></div>`).join('')
      : `<div class="rd"><i class="dot"></i><div><b>${voice(cur) === 'pro' ? 'QUIET ON THE WIRE' : 'NOTHING YET'}</b><span>${voice(cur) === 'pro' ? 'Headlines appear here as games move.' : 'We’ll holler when something happens.'}</span></div><time></time></div>`;
    list.forEach((r) => { r.fresh = false; });
    const other = leagues.find((L) => L !== cur && L.matchups.length);
    $('otherStudio').hidden = !other;
    if (other) {
      $('otherTitle').innerHTML = `Across the hall <small>${esc(other.name)}</small>`;
      const ms = other.matchups.slice().sort((a, b) => Math.abs(a.wp - 50) - Math.abs(b.wp - 50)).slice(0, 3);
      $('otherBody').innerHTML = ms.map((m) => {
        const h = T(other, m.home), a = T(other, m.away);
        return `<div style="display:grid;grid-template-columns:1fr auto 1fr;gap:10px;align-items:center;font:700 19px var(--font-head)">
          <span style="color:${esc(h.color)};overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(h.name)} ${fmt(m.hs)}</span>
          <span style="font:600 13px var(--font-body);color:var(--muted)">${m.done ? 'FINAL' : Math.round(m.wp) + '%'}</span>
          <span style="text-align:right;color:${esc(a.color)};overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${fmt(m.as)} ${esc(a.name)}</span></div>
          <div class="wpbar" style="height:8px"><i style="width:${m.wp}%;background:${esc(h.color)}"></i><i style="width:${100 - m.wp}%;background:${esc(a.color)}"></i></div>`;
      }).join('');
    }
  }

  // ------------------------------------------------------------------ anchor line
  let typeTimer = null;
  function say(text) {
    clearInterval(typeTimer);
    const el = $('anchorText'); let i = 0;
    const full = String(text || '');
    el.innerHTML = '<span></span><i class="cur"></i>';
    const span = el.firstChild;
    typeTimer = setInterval(() => {
      i += Math.max(1, Math.round(full.length / 70));
      span.textContent = full.slice(0, i);
      if (i >= full.length) { clearInterval(typeTimer); }
    }, 28);
  }

  // ------------------------------------------------------------------ segments
  function drama(m) { return (50 - Math.abs(m.wp - 50)) + (m.done ? -40 : 0) + Math.min(30, (m.series.length > 2 ? Math.abs(m.series[m.series.length - 1].wp - m.series[Math.max(0, m.series.length - 6)].wp) : 0)); }

  const SEGMENTS = {
    spotlight(L, forced) {
      const ms = L.matchups.slice().sort((a, b) => drama(b) - drama(a));
      if (!ms.length) return null;
      const m = forced || ms[spotlightTurn++ % Math.min(ms.length, 2)];
      const h = T(L, m.home), a = T(L, m.away);
      const leadH = m.wp >= 50, P = Math.round(Math.max(m.wp, 100 - m.wp));
      const playersOn = (id) => {
        const p = L.lineups.get(id); if (!p) return '';
        const on = p.filter((x) => !x.bench && x.g === 'in').sort((x, y) => y.pts - x.pts).slice(0, 3);
        const left = p.filter((x) => !x.bench && x.g === 'pre').length;
        return on.map((x) => `<div class="pl"><span>${headshot(x.id, x.tm, 'hs-sm')}<span class="live">LIVE</span>${esc(x.n)}<em>${esc(x.pos)} · ${esc(x.tm || '')}</em></span><b>${fmt(x.pts)}</b></div>`).join('') +
          `<div class="pl" style="background:transparent;color:var(--muted)"><span>${left} still to play</span><span>${on.length} on the field</span></div>`;
      };
      const hasPlayers = L.lineups.size > 0;
      const html = `
        <div class="big-vs">
          <div class="tm-big" style="--c:${esc(h.color)}">${icon(h)}<div style="min-width:0"><div class="nm" style="font-size:${nameSize(h.name)}px">${esc(h.name)}</div><div class="sc">${fmt(m.hs)}</div><div class="px">Projected ${fmt(m.hx)}</div></div></div>
          <div class="mid-wp"><div class="p" style="color:${esc(leadH ? h.color : a.color)}">${P}%</div><div class="l">${m.done ? 'Final' : 'Win probability'}</div></div>
          <div class="tm-big r" style="--c:${esc(a.color)}">${icon(a)}<div style="min-width:0"><div class="nm" style="font-size:${nameSize(a.name)}px">${esc(a.name)}</div><div class="sc">${fmt(m.as)}</div><div class="px">Projected ${fmt(m.ax)}</div></div></div>
        </div>
        ${(() => { const hh = h2h(L, m.home, m.away); return hh ? `<div class="h2h">${esc(hh)}</div>` : ''; })()}
        <canvas class="chart" id="spotChart" style="height:${hasPlayers ? 190 : 310}px;margin-top:14px"></canvas>
        ${hasPlayers ? `<div class="onfield"><div><h4>${esc(h.name)}</h4>${playersOn(m.home)}</div><div><h4 style="text-align:right">${esc(a.name)}</h4>${playersOn(m.away)}</div></div>` : ''}`;
      const ldr = leadH ? h : a, trl = leadH ? a : h;
      const gap = Math.abs(m.hs - m.as).toFixed(1);
      const lines = voice(L) === 'pro' ? [
        `${ldr.name} ${m.done ? 'won it' : 'lead the way'} against ${trl.name} — ${P}% ${m.done ? '' : 'to win'}, a ${gap}-point margin on the board.`,
        `Our featured game: ${h.name} ${fmt(m.hs)}, ${a.name} ${fmt(m.as)}. The model likes ${ldr.name} at ${P}%.`,
        `Started at ${Math.round(m.pre >= 50 ? m.pre : 100 - m.pre)}% for ${m.pre >= 50 ? h.name : a.name}. Right now it’s ${ldr.name}, ${P}%.`,
        `${gap} points separate ${h.name} and ${a.name}. Projections: ${fmt(m.hx)} to ${fmt(m.ax)}.`,
      ] : [
        `${ldr.name} are ${m.done ? 'the winners' : 'up'} on ${trl.name}! ${P}% ${m.done ? 'final' : 'and feeling good'}.`,
        `${h.name} ${fmt(m.hs)}, ${a.name} ${fmt(m.as)}. ${m.done ? 'All done!' : 'Still anybody’s game? Kinda.'}`,
        `This one started ${Math.round(m.pre >= 50 ? m.pre : 100 - m.pre)}% ${m.pre >= 50 ? h.name : a.name}. Now it’s ${ldr.name} at ${P}%. Drama!`,
        `Only ${gap} points between ${h.name} and ${a.name}. Somebody pass the chips.`,
      ];
      return { key: 'spotlight', title: Lines.segmentTitle('spotlight', voice(L)), html, dur: 20000, line: lines[Math.floor(Math.random() * lines.length)],
        after() { drawChart($('spotChart'), m, h, a); } };
    },
    scoreboard(L) {
      if (!L.matchups.length) return null;
      const html = `<div class="grid-sb">${L.matchups.map((m) => {
        const h = T(L, m.home), a = T(L, m.away), hl = leftToPlay(L, m.home), al = leftToPlay(L, m.away);
        const st = m.done ? '<span class="st-final">FINAL</span>' : '<span class="st-live">LIVE</span>';
        const left = hl != null ? `${hl + al} players left` : `${Math.round(Math.max(m.wp, 100 - m.wp))}% ${m.wp >= 50 ? esc(h.name) : esc(a.name)}`;
        return `<div class="sb">
          <div class="row ${m.hs >= m.as ? 'lead' : ''}" style="--c:${esc(h.color)}">${icon(h)}<span class="n">${esc(h.name)}</span><span class="s">${fmt(m.hs)}</span></div>
          <div class="row ${m.as > m.hs ? 'lead' : ''}" style="--c:${esc(a.color)}">${icon(a)}<span class="n">${esc(a.name)}</span><span class="s">${fmt(m.as)}</span></div>
          <div class="wpbar" style="height:10px;margin-top:10px"><i style="width:${m.wp}%;background:${esc(h.color)}"></i><i style="width:${100 - m.wp}%;background:${esc(a.color)}"></i></div>
          <div class="meta">${st}<span>${left}</span></div></div>`;
      }).join('')}</div>`;
      const live = L.matchups.filter((m) => !m.done);
      const top = L.matchups.reduce((b, m) => Math.max(b, m.hs, m.as), 0);
      const topTeam = L.matchups.map((m) => (m.hs >= m.as ? [m.home, m.hs] : [m.away, m.as])).sort((x, y) => y[1] - x[1])[0];
      const lines = voice(L) === 'pro'
        ? [`${live.length} matchups still live in ${L.name}. Top score so far: ${T(L, topTeam[0]).name}, ${fmt(top)}.`, `Around ${L.name}: ${L.matchups.length - live.length} final, ${live.length} in progress.`, `The high-water mark this week belongs to ${T(L, topTeam[0]).name} at ${fmt(top)}.`]
        : [`Here’s everybody! ${T(L, topTeam[0]).name} have the high score with ${fmt(top)}.`, `${live.length} games still going, ${L.matchups.length - live.length} all wrapped up.`, `Check the board — who’s gonna be texting the group chat tonight?`];
      return { key: 'scoreboard', title: Lines.segmentTitle('scoreboard', voice(L), { L: L.name }), html, dur: 16000, line: lines[Math.floor(Math.random() * lines.length)] };
    },
    standings(L) {
      if (!L.standings.length) return null;
      const rows = L.standings.slice(0, 12);
      const odds = L.odds;
      const html = `<table class="st"><thead><tr><th>#</th><th>Team</th><th class="num">Record</th><th class="num">Move</th><th class="num">PF</th>${L.inSeason ? '<th class="num">Playoff odds</th><th class="num">Today</th>' : ''}</tr></thead><tbody>${rows.map((r, i) => {
        const t = T(L, r.id), mv = r.was - r.rank, o = odds.get(r.id);
        const dd = o ? Math.round((o.now - o.pre) * 100) : 0;
        return `<tr class="${i === L.playoffSpots ? 'cut' : ''}"><td>${r.rank}</td><td><span style="color:${esc(t.color)};font-weight:800">${icon(t)} ${esc(t.name)}</span></td><td class="num">${r.w}-${r.l}${r.t ? '-' + r.t : ''}</td>
          <td class="num ${mv > 0 ? 'mv-up' : mv < 0 ? 'mv-dn' : ''}">${mv > 0 ? '▲' + mv : mv < 0 ? '▼' + -mv : '–'}</td><td class="num">${Math.round(r.pf)}</td>
          ${L.inSeason ? `<td class="num">${o ? Math.round(o.now * 100) + '%' : '–'}</td><td class="num ${dd > 0 ? 'mv-up' : dd < 0 ? 'mv-dn' : ''}">${dd > 0 ? '+' + dd : dd < 0 ? dd : '–'}</td>` : ''}</tr>`;
      }).join('')}</tbody></table>`;
      const movers = [...odds.entries()].map(([id, o]) => [id, o.now - o.pre]).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
      const mv = movers[0];
      const line = mv && Math.abs(mv[1]) >= 0.03
        ? (voice(L) === 'pro' ? `Biggest mover today: ${T(L, mv[0]).name}, playoff odds ${mv[1] > 0 ? 'up' : 'down'} ${Math.round(Math.abs(mv[1]) * 100)} points since kickoff.` : `${T(L, mv[0]).name}’s playoff chances went ${mv[1] > 0 ? 'UP' : 'down'} ${Math.round(Math.abs(mv[1]) * 100)}% today. ${mv[1] > 0 ? 'Woo!' : 'Yikes.'}`)
        : (voice(L) === 'pro' ? `If the season ended right now, the top ${L.playoffSpots} make the dance. The dashed line is the cut.` : `Top ${L.playoffSpots} make the playoffs. Everybody below the dashed line: hustle!`);
      return { key: 'standings', title: Lines.segmentTitle('standings', voice(L)), html, dur: 18000, line };
    },
    players(L) {
      if (!L.lineups.size) return null;
      const all = [];
      for (const [tid, ps] of L.lineups) for (const p of ps) all.push({ ...p, team: T(L, tid) });
      const starters = all.filter((p) => !p.bench);
      const top = starters.slice().sort((a, b) => b.pts - a.pts).slice(0, 5);
      const dud = starters.filter((p) => p.g === 'post' && p.proj >= 8).sort((a, b) => a.pts / a.proj - b.pts / b.proj)[0];
      const bench = all.filter((p) => p.bench).sort((a, b) => b.pts - a.pts)[0];
      const onField = starters.filter((p) => p.g === 'in').length, toPlay = starters.filter((p) => p.g === 'pre').length;
      const html = `<div class="players-top"><div>${top.map((p, i) => `<div class="prow"><div class="rk">${i + 1}</div>${headshot(p.id, p.tm, 'hs-md')}<div><b>${esc(p.n)}</b><span>${esc(p.pos)} · ${esc(p.tm || '')} · <span style="color:${esc(p.team.color)}">${esc(p.team.name)}</span>${p.g === 'in' ? ' · <b style="display:inline;color:var(--hot);font-size:14px">LIVE</b>' : ''}</span></div><div class="pts">${fmt(p.pts)}</div></div>`).join('')}</div>
        <div>
          ${dud ? `<div class="callout"><small>${voice(L) === 'pro' ? 'Biggest letdown' : 'Took the day off'}</small><b>${headshot(dud.id, dud.tm, 'hs-sm')}${esc(dud.n)}</b><span>${fmt(dud.pts)} pts (projected ${fmt(dud.proj)}) · ${esc(dud.team.name)}</span></div>` : ''}
          ${bench && bench.pts >= 8 ? `<div class="callout"><small>${voice(L) === 'pro' ? 'Left on the bench' : 'Bench regret'}</small><b>${headshot(bench.id, bench.tm, 'hs-sm')}${esc(bench.n)}</b><span>${fmt(bench.pts)} pts on ${esc(bench.team.name)}’s bench</span></div>` : ''}
          <div class="callout"><small>${voice(L) === 'pro' ? 'On the field' : 'Playing right now'}</small><b>${onField} live · ${toPlay} to play</b><span>across ${esc(L.name)}</span></div>
        </div></div>`;
      const p = top[0];
      const line = p ? (voice(L) === 'pro' ? `${p.n} leads all of ${L.name} with ${fmt(p.pts)} points for ${p.team.name}.` : `${p.n} is the star of the day: ${fmt(p.pts)} points for ${p.team.name}!`) : '';
      return { key: 'players', title: Lines.segmentTitle('players', voice(L)), html, dur: 17000, line };
    },
    nfl(L) {
      const g = D.nfl.games; if (!g.length) return null;
      const starters = new Map();
      for (const LL of leagues) for (const ps of LL.lineups.values()) for (const p of ps) if (!p.bench && p.tm) starters.set(p.tm, (starters.get(p.tm) || 0) + 1);
      const order = { in: 0, pre: 1, post: 2 };
      const show = g.slice().sort((a, b) => order[a.state] - order[b.state] || a.date - b.date).slice(0, 9);
      const html = `<div class="nflg">${show.map((x) => {
        const n = (starters.get(x.home.abbr) || 0) + (starters.get(x.away.abbr) || 0);
        return `<div class="ng ${x.state === 'in' ? 'live' : ''}">
          <div class="r">${x.away.logo ? `<img src="${esc(x.away.logo)}" alt="">` : ''}<span class="n">${esc(x.away.abbr)}</span><span class="s">${x.state === 'pre' ? '' : x.away.score}</span></div>
          <div class="r">${x.home.logo ? `<img src="${esc(x.home.logo)}" alt="">` : ''}<span class="n">${esc(x.home.abbr)}</span><span class="s">${x.state === 'pre' ? '' : x.home.score}</span></div>
          <div class="d"><b>${esc(x.state === 'pre' ? new Date(x.date).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : x.detail)}</b><span>${n ? n + ' fantasy starter' + (n === 1 ? '' : 's') : esc(x.broadcast)}</span></div></div>`;
      }).join('')}</div>`;
      const live = g.filter((x) => x.state === 'in').length;
      const line = live ? (voice(L) === 'pro' ? `${live} NFL game${live === 1 ? '' : 's'} in progress. Every snap moves the numbers.` : `${live} real game${live === 1 ? '' : 's'} on right now. Go team(s)!`)
        : (voice(L) === 'pro' ? 'No NFL games live at the moment. Here’s the slate.' : 'No real football on right now. Here’s what’s coming up!');
      return { key: 'nfl', title: Lines.segmentTitle('nfl', voice(L)), html, dur: 15000, line };
    },
    whip(L) {
      const live = L.matchups.filter((m) => !m.done).sort((a, b) => drama(b) - drama(a));
      if (!live.length) return null;
      const seg = SEGMENTS.spotlight(L, live[whipTurn++ % live.length]);
      seg.key = 'whip'; seg.title = Lines.segmentTitle('whip', voice(L)); seg.dur = 11000;
      return seg;
    },
    countdown(L) {
      const next = D.nfl.games.filter((g) => g.state === 'pre').sort((a, b) => a.date - b.date)[0];
      if (!next) return null;
      const slate = D.nfl.games.filter((g) => g.state === 'pre' && g.date - next.date < 60 * 60 * 1000);
      const starters = new Map();
      for (const ps of L.lineups.values()) for (const p of ps) if (!p.bench && p.tm) starters.set(p.tm, (starters.get(p.tm) || 0) + 1);
      const inWindow = slate.reduce((n, g) => n + (starters.get(g.home.abbr) || 0) + (starters.get(g.away.abbr) || 0), 0);
      const html = `<div class="cd-wrap"><div class="cd-k">${voice(L) === 'pro' ? 'Next kickoff' : 'Kickoff in'}</div><div class="cd-big" id="cdBig">--:--:--</div>
        <div class="cd-sub">${esc(new Date(next.date).toLocaleString([], { weekday: 'long', hour: 'numeric', minute: '2-digit' }))} · ${slate.length} game${slate.length === 1 ? '' : 's'}${inWindow ? ` · ${inWindow} ${esc(L.name)} starter${inWindow === 1 ? '' : 's'} playing` : ''}</div>
        <div class="cd-games">${slate.slice(0, 8).map((g) => `<span>${g.away.logo ? `<img src="${esc(g.away.logo)}" alt="">` : ''}${esc(g.away.abbr)} @ ${esc(g.home.abbr)}${g.home.logo ? `<img src="${esc(g.home.logo)}" alt="">` : ''}</span>`).join('')}</div></div>`;
      const line = voice(L) === 'pro' ? `We’re counting down to kickoff. ${slate.length} games in the first window.` : `Almost game time! Grab your snacks — ${slate.length} games coming up.`;
      return { key: 'countdown', title: Lines.segmentTitle('countdown', voice(L)), html, dur: 14000, line,
        after() { const tick = () => { const el = $('cdBig'); if (!el) return clearInterval(cdTimer); const ms = Math.max(0, next.date - Date.now()), h = Math.floor(ms / 3600000), mm = Math.floor(ms / 60000) % 60, ss = Math.floor(ms / 1000) % 60; el.textContent = (h ? h + ':' : '') + String(mm).padStart(2, '0') + ':' + String(ss).padStart(2, '0'); }; clearInterval(cdTimer); cdTimer = setInterval(tick, 1000); tick(); } };
    },
    preview(L) {
      if (!L.matchups.length) return null;
      const html = `<div class="grid-sb">${L.matchups.map((m) => {
        const h = T(L, m.home), a = T(L, m.away), favH = m.pre >= 50;
        return `<div class="sb">
          <div class="row ${favH ? 'lead' : ''}" style="--c:${esc(h.color)}">${icon(h)}<span class="n">${esc(h.name)}</span><span class="s">${fmt(m.hx)}</span></div>
          <div class="row ${!favH ? 'lead' : ''}" style="--c:${esc(a.color)}">${icon(a)}<span class="n">${esc(a.name)}</span><span class="s">${fmt(m.ax)}</span></div>
          <div class="wpbar" style="height:10px;margin-top:10px"><i style="width:${m.pre}%;background:${esc(h.color)}"></i><i style="width:${100 - m.pre}%;background:${esc(a.color)}"></i></div>
          <div class="meta"><span>Projected</span><span>${Math.round(Math.max(m.pre, 100 - m.pre))}% ${esc(favH ? h.name : a.name)}</span></div></div>`;
      }).join('')}</div>`;
      const tight = L.matchups.slice().sort((x, y) => Math.abs(x.pre - 50) - Math.abs(y.pre - 50))[0];
      const line = voice(L) === 'pro' ? `The closest matchup on paper: ${T(L, tight.home).name} and ${T(L, tight.away).name}, nearly a coin flip.` : `Keep an eye on ${T(L, tight.home).name} vs ${T(L, tight.away).name}. That one’s a toss-up!`;
      return { key: 'preview', title: Lines.segmentTitle('preview', voice(L)), html, dur: 16000, line };
    },
    picks(L) {
      if (!L.matchups.length) return null;
      const pk = L.matchups.map((m) => ({ m, fav: m.pre >= 50 ? m.home : m.away, dog: m.pre >= 50 ? m.away : m.home, p: Math.max(m.pre, 100 - m.pre) }));
      const lock = pk.slice().sort((a, b) => b.p - a.p)[0], upset = pk.filter((x) => x.p < 62).sort((a, b) => a.p - b.p)[0];
      const card = (k, x, dogPick) => { const t = T(L, dogPick ? x.dog : x.fav), o = T(L, dogPick ? x.fav : x.dog); return `<div class="pick-big" style="--c:${esc(t.color)}"><small>${esc(k)}</small><div class="pb-row">${icon(t)}<b>${esc(t.name)}</b></div><span>over ${esc(o.name)} · ${Math.round(dogPick ? 100 - x.p : x.p)}% per the model</span></div>`; };
      const html = `<div class="picks"><div class="picks-top">${card(voice(L) === 'pro' ? 'Lock of the week' : 'Sure thing', lock)}${upset ? card(voice(L) === 'pro' ? 'Upset special' : 'Feeling spicy', upset, true) : ''}</div>
        <div class="picks-list">${pk.map((x) => { const t = T(L, x.fav); return `<div class="pl"><span>${icon(t)} <b style="color:${esc(t.color)}">${esc(t.name)}</b><em>over ${esc(T(L, x.dog).name)}</em></span><b>${Math.round(x.p)}%</b></div>`; }).join('')}</div></div>`;
      const line = voice(L) === 'pro' ? `Our lock: ${T(L, lock.fav).name}. ${upset ? `Upset special: ${T(L, upset.dog).name}.` : ''}` : `We’re riding with ${T(L, lock.fav).name}. ${upset ? `And don’t sleep on ${T(L, upset.dog).name}!` : ''}`;
      return { key: 'picks', title: Lines.segmentTitle('picks', voice(L)), html, dur: 16000, line };
    },
    scenarios(L) {
      const open = L.matchups.filter((m) => !m.done && m.wp > 2 && m.wp < 98).sort((a, b) => Math.abs(a.wp - 50) - Math.abs(b.wp - 50)).slice(0, 2);
      if (!open.length) return null;
      const left = (id) => (L.lineups.get(id) || []).filter((p) => !p.bench && (p.g === 'pre' || p.g === 'in')).map((p) => ({ ...p, rem: p.g === 'in' ? Math.max(0, p.proj - p.pts) : p.proj }));
      const bar = (p) => `<div class="sc-p">${headshot(p.id, p.tm, 'hs-sm')}<span class="sc-n">${p.g === 'in' ? '<span class="live">LIVE</span>' : ''}${esc(p.n)} <em>${esc(p.pos)} · ${esc(p.tm || '')}</em></span><span class="sc-bar"><i style="width:${Math.min(100, p.proj ? p.pts / p.proj * 100 : 0)}%"></i></span><b>${fmt(p.pts)} <em>/ ${fmt(p.proj)}</em></b></div>`;
      let line = '';
      const html = open.map((m, k) => {
        const trailH = m.hs < m.as, tr = trailH ? m.home : m.away, ld = trailH ? m.away : m.home;
        const tT = T(L, tr), lT = T(L, ld), trS = trailH ? m.hs : m.as, ldS = trailH ? m.as : m.hs;
        const tl = left(tr), ll = left(ld), lHave = ll.reduce((s2, p) => s2 + p.rem, 0), tHave = tl.reduce((s2, p) => s2 + p.rem, 0);
        const need = Math.max(0, ldS + lHave - trS);
        if (!k) line = tl.length === 1
          ? `${tT.name} need ${fmt(need)} from ${tl[0].n}${ll.length ? `, and ${lT.name} still have ${ll.map((p) => p.n).join(' and ')}` : ''}. He’s projected for ${fmt(tl[0].rem)} more.`
          : `${tT.name} trail by ${fmt(ldS - trS)} with ${tl.length} player${tl.length === 1 ? '' : 's'} left; ${lT.name} have ${ll.length}. Projected: ${fmt(tHave)} to ${fmt(lHave)}.`;
        return `<div class="scn"><div class="scn-h"><span style="color:${esc(tT.color)}">${icon(tT)} ${esc(tT.name)} <b>${fmt(trS)}</b></span><span class="scn-need">needs ${fmt(need)}</span><span style="color:${esc(lT.color)}"><b>${fmt(ldS)}</b> ${esc(lT.name)} ${icon(lT)}</span></div>
          <div class="scn-cols"><div>${tl.map(bar).join('') || '<div class="pl">Nobody left to play</div>'}</div><div>${ll.map(bar).join('') || '<div class="pl">Nobody left to play</div>'}</div></div></div>`;
      }).join('');
      if (!L.lineups.size) return null;
      return { key: 'scenarios', title: Lines.segmentTitle('scenarios', voice(L)), html, dur: 18000, line };
    },
    clinch(L) {
      const rows = L.standings.filter((r) => L.odds.get(r.id) && L.odds.get(r.id).status);
      if (!rows.length) return null;
      const LABEL = { clinched: ['Clinched', 'ok'], clinch_with_win: ['Clinches with a win', 'go'], win_or_out: ['Must win', 'warn'], alive: ['Alive', 'mid'], eliminated: ['Eliminated', 'out'] };
      const html = `<div class="cl-grid">${rows.map((r) => {
        const o = L.odds.get(r.id), t = T(L, r.id), [lab, cls] = LABEL[o.status] || ['', 'mid'];
        return `<div class="cl ${cls}"><span class="cl-t">${icon(t)} <b style="color:${esc(t.color)}">${esc(t.name)}</b> <em>${r.w}-${r.l}</em></span><span class="cl-s">${esc(lab)}</span><span class="cl-o">${o.status === 'alive' || o.status === 'clinch_with_win' || o.status === 'win_or_out' ? Math.round(o.now * 100) + '%' : ''}</span></div>`;
      }).join('')}</div>`;
      const cw = rows.filter((r) => L.odds.get(r.id).status === 'clinch_with_win').map((r) => T(L, r.id).name);
      const mw = rows.filter((r) => L.odds.get(r.id).status === 'win_or_out').map((r) => T(L, r.id).name);
      const line = cw.length ? `${cw.join(' and ')} clinch${cw.length === 1 ? 'es' : ''} a playoff spot with a win.` : mw.length ? `${mw.join(' and ')}: win or go home.` : (voice(L) === 'pro' ? 'Here’s the playoff picture.' : 'Who’s in and who’s out!');
      return { key: 'clinch', title: Lines.segmentTitle('clinch', voice(L)), html, dur: 16000, line };
    },
    news(L) {
      const inj = [];
      for (const [tid, ps] of L.lineups) for (const p of ps) if (!p.bench && p.inj) inj.push({ ...p, team: T(L, tid) });
      const items = (D.news.items || []).filter((it) => it.hits.some((h) => h.L === L)).slice(0, 4);
      if (!inj.length && !items.length) return null;
      const SEV = { OUT: 3, INJURY_RESERVE: 3, SUSPENSION: 3, DOUBTFUL: 2, QUESTIONABLE: 1 };
      inj.sort((a, b) => (SEV[b.inj] || 0) - (SEV[a.inj] || 0));
      const html = `<div class="news-cols"><div><h4>${voice(L) === 'pro' ? 'Injury report · starters' : 'Who’s hurt (starters)'}</h4>${inj.slice(0, 8).map((p) => `<div class="pl">${headshot(p.id, p.tm, 'hs-sm')}<span>${esc(p.n)}<em>${esc(p.pos)} · <span style="color:${esc(p.team.color)}">${esc(p.team.name)}</span></em></span><b class="inj inj-${esc(String(p.inj).toLowerCase())}">${esc(String(p.inj).replace('_', ' '))}</b></div>`).join('') || '<div class="pl">All starters healthy</div>'}</div>
        <div><h4>${voice(L) === 'pro' ? 'Latest news' : 'The latest'}</h4>${items.map((it) => `<div class="news-it">${headshot(it.pid, it.pro, 'hs-sm')}<div><b>${esc(it.head)}</b><span>${esc(it.hits.filter((h) => h.L === L).map((h) => T(L, h.teamId).name + (h.starter ? '' : ' (bench)')).join(', '))} · ${ago(it.ts)}</span></div></div>`).join('') || '<div class="pl">No news on your players</div>'}</div></div>`;
      const top = inj[0];
      const line = top ? (voice(L) === 'pro' ? `${top.n} is listed ${String(top.inj).toLowerCase().replace('_', ' ')} for ${top.team.name}.` : `Heads up, ${top.team.name}: ${top.n} is ${String(top.inj).toLowerCase().replace('_', ' ')}.`) : items[0].head;
      return { key: 'news', title: Lines.segmentTitle('news', voice(L)), html, dur: 16000, line };
    },
    transactions(L) {
      const tx = (L.txns || []).slice(0, 7);
      if (!tx.length) return null;
      const html = `<div class="tx-list">${tx.map((t) => { const d = txnText(L, t); return `<div class="tx"><span class="tx-k tx-${esc(t.kind)}">${t.kind === 'trade' ? '⇄' : '+'}</span>${d.hs}<div><b>${esc(d.text)}</b><span>${esc(t.kind === 'trade' ? 'Trade' : t.kind === 'waiver' ? 'Waiver claim' : 'Free agent')} · ${ago(Date.parse(t.ts))}</span></div></div>`; }).join('')}</div>`;
      return { key: 'transactions', title: Lines.segmentTitle('transactions', voice(L)), html, dur: 15000, line: txnText(L, tx[0]).text };
    },
    leaders(L) {
      const st = leadersFor(L); if (!st) return null;
      const card = (k, id, big, sub) => { if (!id) return ''; const t = T(L, id); return `<div class="ld" style="--c:${esc(t.color)}"><small>${esc(k)}</small><div class="pb-row">${icon(t)}<b>${esc(t.name)}</b></div><div class="ld-big">${esc(big)}</div><span>${esc(sub)}</span></div>`; };
      const pro = voice(L) === 'pro';
      const html = `<div class="ld-grid">
        ${card(pro ? 'Luckiest team' : 'Horseshoe award', st.lucky.id, '+' + st.lucky.luck.toFixed(1) + ' W', `${st.lucky.w}-${st.lucky.l} record, ${st.lucky.apw}-${st.lucky.apl} all-play`)}
        ${card(pro ? 'Unluckiest team' : 'Snakebit', st.unlucky.id, st.unlucky.luck.toFixed(1) + ' W', `${st.unlucky.w}-${st.unlucky.l} record, ${st.unlucky.apw}-${st.unlucky.apl} all-play`)}
        ${card(pro ? 'Best all-play record' : 'Would beat everybody', st.allPlay.id, `${st.allPlay.apw}-${st.allPlay.apl}`, 'vs every team, every week')}
        ${card(pro ? 'Most points against' : 'Everyone shows up vs them', st.pa.id, Math.round(st.pa.pa) + ' PA', 'toughest schedule so far')}
        ${card(pro ? 'Most consistent' : 'Steady Eddie', st.steady.id, '±' + st.steady.sd.toFixed(1), `averaging ${st.steady.avg.toFixed(1)}`)}
        ${card(pro ? 'Boom or bust' : 'Rollercoaster', st.boom.id, '±' + st.boom.sd.toFixed(1), `from ${st.boom.min.toFixed(1)} to ${st.boom.max.toFixed(1)}`)}
      </div>`;
      const line = pro ? `${T(L, st.lucky.id).name} have won ${st.lucky.luck.toFixed(1)} more games than their scoring suggests. ${T(L, st.unlucky.id).name}: the unluckiest team in ${L.name}.` : `${T(L, st.lucky.id).name} are the luckiest team around. ${T(L, st.unlucky.id).name}? Not so much.`;
      return { key: 'leaders', title: Lines.segmentTitle('leaders', voice(L)), html, dur: 17000, line };
    },
    need(L) {
      const live = L.matchups.filter((m) => !m.done && m.wp > 4 && m.wp < 96).sort((a, b) => Math.abs(a.wp - 50) - Math.abs(b.wp - 50)).slice(0, 2);
      if (!live.length) return null;
      const block = (m) => {
        const trailHome = m.wp < 50, tr = trailHome ? m.home : m.away, ld = trailHome ? m.away : m.home;
        const tT = T(L, tr), lT = T(L, ld);
        const trS = trailHome ? m.hs : m.as, trX = trailHome ? m.hx : m.ax, ldX = trailHome ? m.ax : m.hx, ldS = trailHome ? m.as : m.hs;
        const need = Math.max(0, ldX - trS), have = Math.max(0, trX - trS), pct = Math.round(Math.min(m.wp, 100 - m.wp));
        const ps = (L.lineups.get(tr) || []).filter((p) => !p.bench && (p.g === 'pre' || p.g === 'in')).map((p) => ({ ...p, left: p.g === 'in' ? Math.max(0, p.proj - p.pts) : p.proj })).sort((a, b) => b.left - a.left).slice(0, 4);
        return { tr, tT, lT, need, have, pct, ldS, trS, html: `<div class="need">
          <div class="need-head"><span style="color:${esc(tT.color)}">${icon(tT)} ${esc(tT.name)}</span><span class="need-pct">${pct}%</span></div>
          <div class="need-nums"><div><b>${fmt(need)}</b><small>points needed to catch ${esc(lT.name)}</small></div><div><b>${fmt(have)}</b><small>projected from who\u2019s left</small></div></div>
          <div class="wpbar" style="height:12px"><i style="width:${Math.min(100, have / Math.max(need, 0.1) * 100)}%;background:${esc(tT.color)}"></i></div>
          ${ps.length ? `<div class="need-left">${ps.map((p) => `<div class="pl"><span>${headshot(p.id, p.tm, 'hs-sm')}${p.g === 'in' ? '<span class="live">LIVE</span>' : ''}${esc(p.n)}<em>${esc(p.pos)} \u00b7 ${esc(p.tm || '')}</em></span><b>~${fmt(p.left)}</b></div>`).join('')}</div>` : ''}
        </div>` };
      };
      const bs = live.map(block);
      const b = bs[0];
      const line = voice(L) === 'pro'
        ? `${b.tT.name} need ${fmt(b.need)} more points to catch ${b.lT.name}. The projections say ${fmt(b.have)} \u2014 ${b.have >= b.need ? 'it\u2019s doable' : 'they\u2019ll need someone to outplay their projection'}.`
        : `${b.tT.name} need ${fmt(b.need)} points. They\u2019re projected for ${fmt(b.have)}. ${b.have >= b.need ? 'Ooh, it could happen!' : 'Somebody\u2019s gotta show up big!'}`;
      return { key: 'need', title: Lines.segmentTitle('need', voice(L)), html: `<div class="need-grid">${bs.map((x) => x.html).join('')}</div>`, dur: 17000, line };
    },
    records(L) {
      const book = window.DeskRecords && DeskRecords.book(L);
      if (!book || !book.records.length) return null;
      const html = `<table class="st rec"><thead><tr><th>Record</th><th class="num">Mark</th><th>Holder</th><th>When</th></tr></thead><tbody>${book.records.map((r) => {
        const t = L.teams[r.team]; const col = t ? vis(t.color) : 'var(--fg)';
        return `<tr><td><b>${esc(r.label)}</b></td><td class="num"><b>${esc(r.text)}</b></td><td><span style="color:${esc(col)};font-weight:800">${esc(r.who)}</span><br><small style="color:var(--muted)">${esc(r.note)}</small></td><td><small>${esc(r.when)}</small></td></tr>`;
      }).join('')}</tbody></table><div class="rec-foot">${book.games.length} games on record since ${book.games[0].year}</div>`;
      const r = book.records[Math.floor(Math.random() * book.records.length)];
      const line = voice(L) === 'pro' ? `From the ${L.name} record book: ${r.label.toLowerCase()}, ${r.text}, ${r.who}, ${r.when}.` : `Fun fact! ${r.label}: ${r.who}, ${r.text}. That was ${r.when}.`;
      return { key: 'records', title: Lines.segmentTitle('records', voice(L)), html, dur: 16000, line };
    },
    recap(L) {
      if (!window.RecapVideo || !L.recapWeek) return null;
      return { key: 'recap', title: Lines.segmentTitle('recap', voice(L)), html: `<canvas class="recap-cv" id="recapCv" width="1920" height="1080"></canvas><button class="recap-dl" id="recapDl" type="button">\u2b07 Download video</button>`,
        dur: 1000 * 75, line: voice(L) === 'pro' ? `Let\u2019s look back at week ${L.recapWeek.week} in ${L.name}.` : `Previously, on the ${L.name}\u2026 week ${L.recapWeek.week}!`,
        after() { playRecap(L); } };
    },
    rundown(L) {
      const list = (rundown.get(L.id) || []).slice(0, 6);
      if (list.length < 2) return null;
      const html = list.map((r) => `<div class="callout" style="margin-bottom:12px"><small>${ago(r.ts)}</small><b>${esc(r.head)}</b><span>${esc(r.body)}</span></div>`).join('');
      return { key: 'rundown', title: Lines.segmentTitle('rundown', voice(L)), html, dur: 16000, line: list[0].line || list[0].body };
    },
  };

  function drawChart(cv, m, h, a) {
    if (!cv) return;
    const W = cv.clientWidth, H = cv.clientHeight, dpr = 2;
    cv.width = W * dpr; cv.height = H * dpr;
    const x = cv.getContext('2d'); x.scale(dpr, dpr);
    const vals = m.series.length > 1 ? m.series.map((p) => p.wp) : [m.pre, m.wp];
    WPChart.draw(x, { x: 0, y: 0, w: W, h: H }, vals, h.color, a.color, { dark: isDark(), lineWidth: 3.5, font: 15 });
  }

  // All-time head-to-head from the record book's game list (past seasons + this one).
  function h2h(L, a, b) {
    const book = window.DeskRecords && DeskRecords.book(L); if (!book) return '';
    const gs = book.games.filter((g) => (g.a === a && g.b === b) || (g.a === b && g.b === a));
    if (!gs.length) return voice(L) === 'pro' ? 'First meeting on record' : 'First time these two have met!';
    let wa = 0, wb = 0; for (const g of gs) { const sa = g.a === a ? g.sa : g.sb, sb2 = g.a === a ? g.sb : g.sa; if (sa > sb2) wa++; else if (sb2 > sa) wb++; }
    const last = gs[gs.length - 1], la = last.a === a ? last.sa : last.sb, lb = last.a === a ? last.sb : last.sa;
    const nA = T(L, a).name, nB = T(L, b).name;
    const lead = wa === wb ? `All-time series tied ${wa}-${wb}` : `All-time: ${wa > wb ? nA : nB} lead ${Math.max(wa, wb)}-${Math.min(wa, wb)}`;
    return `${lead} · Last met Wk ${last.week}, ${last.year}: ${la >= lb ? nA : nB} by ${Math.abs(la - lb).toFixed(1)}`;
  }
  function txnText(L, t) {
    const nm = (it) => it.name || 'a player';
    const team = t.team_id ? T(L, t.team_id).name : 'A team';
    if (t.kind === 'trade') {
      const out = t.items.filter((i) => i.from_team_id === t.team_id), inn = t.items.filter((i) => i.to_team_id === t.team_id);
      const other = (t.items.find((i) => i.from_team_id && i.from_team_id !== t.team_id) || t.items.find((i) => i.to_team_id && i.to_team_id !== t.team_id) || {});
      const partner = T(L, other.from_team_id !== t.team_id ? other.from_team_id : other.to_team_id).name;
      return { text: `${team} trade ${out.map(nm).join(', ') || '—'} to ${partner} for ${inn.map(nm).join(', ') || '—'}`, partner, out, inn, team, hs: headshot((inn[0] || out[0] || {}).player_id, (inn[0] || out[0] || {}).pro, 'hs-md') };
    }
    const adds = t.items.filter((i) => i.type === 'ADD'), drops = t.items.filter((i) => i.type === 'DROP');
    const a0 = adds[0] || drops[0] || {};
    const text = adds.length ? `${team} add ${adds.map((i) => `${nm(i)}${i.pos ? ` (${i.pos}${i.pro ? ', ' + i.pro : ''})` : ''}`).join(', ')}${drops.length ? `, drop ${drops.map(nm).join(', ')}` : ''}` : `${team} drop ${drops.map(nm).join(', ')}`;
    return { text, adds, drops, team, hs: headshot(a0.player_id, a0.pro, 'hs-md') };
  }
  // Luck (wins vs all-play), all-play record, points against, consistency -- from finished weeks.
  function leadersFor(L) {
    const latest = new Map();
    for (const r of L.summary) { if (!r.all_starters_done) continue; const k = r.week + '|' + r.matchup_id + '|' + r.team_id; const ex = latest.get(k); if (!ex || r.ts > ex.ts) latest.set(k, r); }
    const byWeek = new Map(), pairs = new Map();
    for (const r of latest.values()) {
      if (!byWeek.has(r.week)) byWeek.set(r.week, []); byWeek.get(r.week).push(r);
      const k = r.week + '|' + r.matchup_id; if (!pairs.has(k)) pairs.set(k, []); pairs.get(k).push(r);
    }
    const S2 = new Map(Object.keys(L.teams).map((id) => [id, { id, w: 0, l: 0, apw: 0, apl: 0, pa: 0, scores: [] }]));
    for (const g of pairs.values()) { if (g.length !== 2) continue; const [a, b] = g; const A = S2.get(a.team_id), B = S2.get(b.team_id); if (!A || !B) continue;
      const sa = Number(a.actual_score), sb2 = Number(b.actual_score); A.pa += sb2; B.pa += sa; if (sa > sb2) { A.w++; B.l++; } else if (sb2 > sa) { B.w++; A.l++; } }
    for (const rows of byWeek.values()) for (const r of rows) { const X = S2.get(r.team_id); if (!X) continue; const s3 = Number(r.actual_score); X.scores.push(s3); for (const o of rows) if (o !== r) { if (s3 > Number(o.actual_score)) X.apw++; else if (s3 < Number(o.actual_score)) X.apl++; } }
    const list = [...S2.values()].filter((x) => x.scores.length >= 3);
    if (list.length < 3) return null;
    for (const x of list) {
      const n = x.scores.length, games = x.w + x.l; x.avg = x.scores.reduce((a2, b2) => a2 + b2, 0) / n;
      x.sd = Math.sqrt(x.scores.reduce((a2, v) => a2 + (v - x.avg) ** 2, 0) / n); x.min = Math.min(...x.scores); x.max = Math.max(...x.scores);
      x.luck = x.w - games * (x.apw / Math.max(1, x.apw + x.apl));
    }
    const by = (f) => list.slice().sort((a2, b2) => f(b2) - f(a2))[0];
    return { lucky: by((x) => x.luck), unlucky: by((x) => -x.luck), allPlay: by((x) => x.apw / Math.max(1, x.apw + x.apl)), pa: by((x) => x.pa), steady: by((x) => -x.sd), boom: by((x) => x.sd) };
  }

  // ---- show modes: the channel changes format through the NFL week
  function computeMode() {
    const forced = params.get('mode'); if (forced) return forced;
    const g = D.nfl.games, live = g.filter((x) => x.state === 'in').length, pre = g.filter((x) => x.state === 'pre'), post = g.filter((x) => x.state === 'post').length;
    const undecided = leagues.some((L) => L.matchups.some((m) => !m.done && m.wp > 2 && m.wp < 98));
    const allFinal = leagues.length && leagues.every((L) => L.matchups.length && L.matchups.every((m) => m.done));
    if (live >= 3) return 'whip';
    if (undecided && post >= 4 && live + pre.length <= 2 && live + pre.length > 0) return 'showdown';
    if (allFinal) return 'awards';
    const next = pre.map((x) => x.date).sort((a, b) => a - b)[0];
    if (!live && next && next - Date.now() < 8 * 3600 * 1000) return 'pregame';
    return 'studio';
  }
  function modeName(studio) {
    const pro = studio !== 'casual', mon = new Date().getDay() === 1;
    return { pregame: pro ? 'Pregame Show' : 'Pregame Hangout', whip: pro ? 'Whip-Around' : 'Speed Round', showdown: pro ? (mon ? 'Monday Night Showdown' : 'Primetime Showdown') : (mon ? 'Monday Night Nail-Biter' : 'Nail-Biter Night'), awards: pro ? 'Awards Show' : 'Awards Night' }[mode] || '';
  }
  function checkMode(announce) {
    const m = computeMode();
    if (m === mode) return;
    mode = m;
    if (cur) applyStudio(cur);
    segPlan = planFor(cur); segIdx = 0;
    if (announce && modeName(cur.studio)) { M.sting('handoff'); say((cur.studio === 'pro' ? 'Welcome to the ' : 'It’s time for the ') + modeName(cur.studio) + '!'); }
  }

  function planFor(L) {
    const live = L.matchups.some((m) => !m.done);
    const PLANS = {
      pregame: ['countdown', 'preview', 'picks', 'news', 'clinch', 'standings', 'transactions', 'leaders', 'records'],
      whip: ['whip', 'scoreboard', 'whip', 'need', 'whip', 'players', 'whip', 'news'],
      showdown: ['scenarios', 'spotlight', 'scenarios', 'need', 'clinch', 'scoreboard', 'news'],
      awards: ['recap', 'standings', 'clinch', 'leaders', 'records', 'transactions', 'rundown', 'news'],
    };
    const plan = PLANS[mode] || (live ? ['spotlight', 'scoreboard', 'need', 'players', 'news', 'spotlight', 'standings', 'clinch', 'records', 'transactions', 'nfl', 'rundown'] : ['recap', 'scoreboard', 'standings', 'clinch', 'leaders', 'records', 'transactions', 'news', 'players', 'spotlight', 'rundown', 'nfl']);
    return plan.filter((k) => (k === 'recap' ? !!(window.RecapVideo && L.recapWeek) : SEGMENTS[k](L) !== null));
  }

  function stopRecap() { if (recapPlayer) { recapPlayer.stop(); recapPlayer = null; } }
  function showSegment(seg, animate) {
    if (seg.key !== 'recap' || animate) stopRecap();
    currentSeg = seg;
    $('segLabel').textContent = seg.title;
    const body = $('segBody');
    body.innerHTML = seg.html;
    if (animate) { body.classList.remove('seg-in'); void body.offsetWidth; body.classList.add('seg-in'); say(seg.line); }
    if (seg.after) requestAnimationFrame(seg.after);
  }

  async function nextSegment() {
    clearTimeout(segTimer);
    if (busy) { segTimer = setTimeout(nextSegment, 1500); return; }
    if (segIdx >= segPlan.length) {
      // Block finished: a commercial break now and then, then throw it over to the other studio.
      if (Math.random() < 0.6) await commercialBreak();
      const other = lock === 'auto' ? leagues.find((L) => L !== cur && L.year) : null;
      if (other) await handoff(other);
      segPlan = planFor(cur); segIdx = 0;
      if (!segPlan.length) { showSegment({ title: 'Studio', html: `<div class="empty-seg">No games this week yet.</div>`, line: 'Stand by.' }, true); segTimer = setTimeout(nextSegment, 20000); return; }
    }
    const key = segPlan[segIdx++];
    const seg = SEGMENTS[key](cur);
    if (!seg) return nextSegment();
    showSegment(seg, true);
    segStarted = Date.now(); segDur = seg.dur;
    segTimer = setTimeout(nextSegment, seg.dur);
  }

  // ------------------------------------------------------------------ commercial break
  async function commercialBreak() {
    if (busy) return;
    busy = true;
    const L = cur, st = L.standings || [];
    const worst = st.length ? st[st.length - 1].id : null, best = st.length ? st[0].id : null;
    const ids = Object.keys(L.teams);
    const pick = () => ids[Math.floor(Math.random() * ids.length)];
    let star = 'Josh Allen';
    for (const ps of L.lineups.values()) for (const p of ps) if (!p.bench && p.pts > 15 && Math.random() < 0.3) star = p.n;
    const ad = Lines.commercial(L.studio, { A: T(L, worst || pick()).name, B: T(L, best || pick()).name, L: L.name, P: star });
    const prevSeg = currentSeg;
    stopRecap();
    $('segLabel').textContent = L.studio === 'pro' ? 'A word from our sponsors' : 'Commercial break!';
    const body = $('segBody');
    body.innerHTML = `<div class="ad"><div class="ad-k">${L.studio === 'pro' ? 'Paid programming' : 'And now a word from\u2026'}</div><div class="ad-brand">${esc(ad.brand)}</div><div class="ad-tag">${esc(ad.tag)}</div><div class="ad-body">${esc(ad.body)}</div><div class="ad-fine">${esc(ad.fine)}</div></div>`;
    body.classList.remove('seg-in'); void body.offsetWidth; body.classList.add('seg-in');
    M.sting('jingle');
    say(ad.brand + ' \u2014 ' + ad.tag);
    await sleep(12000);
    currentSeg = prevSeg;
    busy = false;
  }

  // ------------------------------------------------------------------ instant replay
  // Slow-motion replay of the win-% chart for the stretch that just mattered.
  async function playReplay(L, m) {
    if (!m || !m.series || m.series.length < 3) return;
    const h = T(L, m.home), a = T(L, m.away);
    const all = m.series, end = all[all.length - 1].t;
    let pts = all.filter((p) => p.t >= end - 3 * 3600 * 1000);
    if (pts.length < 3) pts = all.slice(-Math.min(all.length, 40));
    const wrap = document.createElement('div'); wrap.id = 'replay';
    wrap.innerHTML = `<div class="rp-bug">\u25b6 REPLAY</div><div class="rp-teams"><span style="color:${esc(h.color)}">${esc(h.name)} <b id="rpHs">0.0</b></span><span id="rpPct"></span><span style="color:${esc(a.color)}"><b id="rpAs">0.0</b> ${esc(a.name)}</span></div><canvas id="rpCv"></canvas>`;
    $('stage').appendChild(wrap);
    M.sting('replay');
    const cv = wrap.querySelector('canvas'), W = 1150, H = 470, dpr = 2;
    cv.width = W * dpr; cv.height = H * dpr; cv.style.width = W + 'px'; cv.style.height = H + 'px';
    const x = cv.getContext('2d'); x.scale(dpr, dpr);
    const vals = pts.map((p) => p.wp);
    const DUR = 7500, start = performance.now();
    await new Promise((resolve) => {
      const f = (now) => {
        const u = Math.min(1, (now - start) / DUR), e = u < 0.6 ? u / 0.6 * 0.75 : 0.75 + (u - 0.6) / 0.4 * 0.25; // the last stretch in slow motion
        x.clearRect(0, 0, W, H);
        WPChart.draw(x, { x: 0, y: 0, w: W, h: H }, vals, h.color, a.color, { dark: isDark(), lineWidth: 4.5, font: 16, progress: e });
        const p = pts[Math.min(pts.length - 1, Math.round(e * (pts.length - 1)))];
        wrap.querySelector('#rpHs').textContent = fmt(p.hs); wrap.querySelector('#rpAs').textContent = fmt(p.as);
        wrap.querySelector('#rpPct').textContent = Math.round(Math.max(p.wp, 100 - p.wp)) + '% ' + (p.wp >= 50 ? h.name : a.name);
        if (u < 1) requestAnimationFrame(f); else resolve();
      };
      requestAnimationFrame(f);
    });
    await sleep(1200);
    wrap.classList.add('out'); await sleep(500); wrap.remove();
  }

  // ------------------------------------------------------------------ weekly recap video
  let recapPlayer = null;
  async function playRecap(L) {
    const cv = $('recapCv'); if (!cv || !window.RecapVideo) return;
    try {
      const show = await RecapVideo.build(D.sb, { leagueId: L.id, name: L.name, studio: L.studio, year: L.recapWeek.year, week: L.recapWeek.week, teams: L.teams });
      if (!show || $('recapCv') !== cv) return;
      if (recapPlayer) recapPlayer.stop();
      recapPlayer = RecapVideo.play(cv, show, { onLine: (t) => say(t) });
      const dl = $('recapDl');
      if (dl) dl.onclick = async () => { dl.disabled = true; dl.textContent = 'Recording\u2026 (plays once)'; try { await RecapVideo.download(show); dl.textContent = '\u2b07 Downloaded'; } catch (e) { dl.textContent = 'Couldn\u2019t record here'; } };
      clearTimeout(segTimer); segTimer = setTimeout(nextSegment, show.duration + 1500);
    } catch (e) { console.warn('recap unavailable', e); }
  }

  // ------------------------------------------------------------------ handoff
  async function handoff(toL) {
    if (!toL || toL === cur) return;
    busy = true;
    const line = Lines.handoff(cur.studio, { L2: toL.name });
    say(line);
    await sleep(1400);
    const wipe = $('wipe');
    wipe.style.setProperty('--wipe-bg', toL.studio === 'pro' ? 'linear-gradient(90deg,#0a2a6b,#0a4bd6)' : 'linear-gradient(90deg,#3f8f4e,#f2b544)');
    wipe.querySelector('.w1').textContent = shortName(toL) + ' ' + showName(toL);
    wipe.querySelector('.w2').textContent = toL.studio === 'pro' ? 'Live from the studio' : 'Pull up a chair';
    wipe.classList.remove('go'); void wipe.offsetWidth; wipe.classList.add('go');
    M.sting('handoff');
    await sleep(1200);
    applyStudio(toL);
    segPlan = planFor(toL); segIdx = 0;
    await sleep(1400);
    busy = false;
  }

  // ------------------------------------------------------------------ events
  function varsFor(ev) {
    const L = ev.league;
    const v = { L: L ? L.name : '', T: ev.team && ev.team.name, O: ev.opp && ev.opp.name, P: ev.pct != null ? ev.pct : ev.wp, S: ev.score, OS: ev.oppScore, M: ev.margin,
      PRE: ev.prePct, SW: ev.swing, MARK: ev.mark || (ev.detail && ev.detail.mark), PL: ev.player, POS: ev.pos, PRO: ev.pro, PTS: ev.pts, D: ev.delta, GAP: ev.gap,
      Y: ev.detail && ev.detail.yards, PROJ: ev.detail && ev.detail.proj != null ? Number(ev.detail.proj).toFixed(1) : '' };
    if (v.P != null) v.OPCT = 100 - Number(v.P);
    if (ev.kind === 'big_swing') { v.T = ev.up.name; v.O = ev.down.name; }
    if (ev.kind === 'player_injury') v.S2 = String((ev.detail && ev.detail.status) || 'questionable').replace('_', ' ').toLowerCase();
    if (ev.txn) {
      const d = txnText(L, ev.txn), nm = (i) => i.name || 'a player';
      v.T = d.team;
      if (ev.txn.kind === 'trade') { v.T2 = d.partner; v.A = d.out.map(nm).join(' and ') || 'a player'; v.GET = d.inn.map(nm).join(' and ') || 'a player'; }
      else { v.A = (d.adds || []).map(nm).join(' and ') || 'a player'; v.DROPTXT = (d.drops || []).length ? (voice(L) === 'pro' ? ', releasing ' : ' and dropped ') + d.drops.map(nm).join(' and ') : ''; }
      const i0 = (ev.txn.items || [])[0] || {}; ev.pid = i0.player_id; ev.pro = i0.pro;
    }
    if (ev.record) { const r = ev.record; v.REC = r.label.toLowerCase(); v.OLD = r.text; v.WHO = r.who; v.WHEN = r.when; v.V = r.key === 'streak' ? ev.value : Number(ev.value).toFixed(1); }
    if (ev.game) { const g = ev.game; v.G = g.state === 'post' || g.state === 'in' ? `${g.away.abbr} ${g.away.score}, ${g.home.abbr} ${g.home.score}` : `${g.away.name} at ${g.home.name}`; }
    return v;
  }
  function stingFor(kind) {
    if (/upset/.test(kind)) return 'upset';
    if (/^final/.test(kind)) return 'final';
    if (kind === 'clinched') return 'record';
    if (kind === 'eliminated' || kind === 'player_injury') return 'bad';
    if (/^txn/.test(kind)) return 'alert';
    if (/^record/.test(kind)) return 'record';
    if (/_td$|dst_score|big_day|boom_final|big_play/.test(kind)) return 'td';
    if (/interception|fumble|dud|bench_boom|scare/.test(kind)) return 'bad';
    if (kind === 'lead_change' || kind === 'big_swing') return 'lead';
    return 'breaking';
  }

  function onEvent(ev) {
    const L = ev.league;
    const w = ev.kind === 'news'
      ? { head: (voice(L) === 'pro' ? 'NEWS: ' : '') + ev.newsItem.head.toUpperCase().slice(0, 70), body: ev.newsItem.desc || ev.newsItem.head, line: ev.newsItem.desc || ev.newsItem.head }
      : Lines.write(ev.kind, voice(L), varsFor(ev));
    if (ev.kind === 'news') { ev.pid = ev.newsItem.pid; ev.pro = ev.newsItem.pro; }
    if (!w) return;
    const item = { head: w.head, body: w.body, line: w.line, ts: ev.ts || Date.now(), priority: ev.priority, fresh: !ev.old };
    const targets = L ? [L] : leagues;
    for (const t of targets) { const arr = rundown.get(t.id) || []; arr.unshift(item); rundown.set(t.id, arr.slice(0, 30)); }
    if (!ev.old) { tickerHeads.unshift((L ? shortName(L).toUpperCase() + ': ' : '') + w.head); tickerHeads.length = Math.min(tickerHeads.length, 12); }
    if (ev.old) { renderSide(); return; }
    if (lock !== 'auto' && L && L.id !== lock) return;
    if (ev.priority >= 2) breakingQ.push({ ev, w }); else if (ev.priority === 1) alertQ.push({ ev, w });
    renderSide();
  }

  async function playBreaking({ ev, w }) {
    busy = true;
    stopRecap();
    const L = ev.league;
    if (L && L !== cur && lock === 'auto') { busy = false; await handoff(L); busy = true; }
    const el = $('breaking'), m = ev.matchup;
    const tCol = (ev.team && ev.team.color) || '#e11d2e';
    el.style.setProperty('--bt', tCol);
    el.querySelector('.kick').textContent = /^final/.test(ev.kind) ? (voice(L) === 'pro' ? 'FINAL' : 'IT’S OVER') : /upset/.test(ev.kind) ? 'UPSET ALERT' : ev.kind === 'record_broken' ? (voice(L) === 'pro' ? 'HISTORY' : 'NEW RECORD') : ev.kind === 'clinched' ? 'CLINCHED' : ev.kind === 'eliminated' ? 'ELIMINATED' : ev.kind === 'txn_trade' ? 'TRADE ALERT' : ev.kind === 'player_injury' ? 'INJURY UPDATE' : ev.kind === 'record_watch' ? 'RECORD WATCH' : /^player_/.test(ev.kind) ? (voice(L) === 'pro' ? 'SCORING PLAY' : 'BIG PLAY') : (voice(L) === 'pro' ? 'BREAKING' : 'BIG NEWS');
    el.querySelector('.hd').textContent = w.head;
    el.querySelector('.bd').textContent = w.body;
    const old = el.querySelector('.bk-hs'); if (old) old.remove();
    if (ev.pid != null || /^player_/.test(ev.kind)) { const hs = headshot(ev.pid, ev.pro, 'bk-hs'); if (hs) el.querySelector('.kick').insertAdjacentHTML('afterend', hs); }
    const teams = el.querySelector('.teams'), meter = el.querySelector('.meter');
    if (m && L) {
      const h = T(L, m.home), a = T(L, m.away);
      teams.innerHTML = `<span style="color:${esc(h.color)}">${icon(h)} ${esc(h.name)} ${fmt(m.hs)}</span><span style="opacity:.6">vs</span><span style="color:${esc(a.color)}">${fmt(m.as)} ${esc(a.name)} ${icon(a)}</span>`;
      meter.innerHTML = `<i style="width:50%;background:${esc(h.color)}"></i><i style="width:50%;background:${esc(a.color)}"></i>`;
      meter.hidden = false;
      setTimeout(() => { const [i1, i2] = meter.children; i1.style.width = m.wp + '%'; i2.style.width = (100 - m.wp) + '%'; }, 700);
    } else { teams.innerHTML = ''; meter.hidden = true; }
    el.classList.remove('out'); el.classList.add('show');
    M.sting(stingFor(ev.kind));
    say(w.line);
    await sleep(9000);
    el.classList.add('out');
    await sleep(650);
    el.classList.remove('show', 'out');
    if (m && L && /lead_change|big_swing|upset|final_close|nail_biter|record_broken/.test(ev.kind)) await playReplay(L, L.matchups.find((x) => x.id === m.id) || m);
    lastBreakingAt = Date.now();
    busy = false;
    if (currentSeg) { const again = SEGMENTS[currentSeg.key] && SEGMENTS[currentSeg.key](cur); if (again) showSegment(again, true); }
  }
  async function playAlert({ ev, w }) {
    busy = true;
    const el = $('alert'), L = ev.league;
    el.querySelector('.tag').textContent = L ? shortName(L).toUpperCase() : 'NFL';
    el.querySelector('.txt b').textContent = w.head;
    el.querySelector('.txt span').textContent = w.body;
    const ic = el.querySelector('.ic'); if (ic) ic.remove();
    if (ev.pid != null || /^player_/.test(ev.kind)) el.insertAdjacentHTML('beforeend', `<span class="ic">${headshot(ev.pid, ev.pro, 'hs-al')}</span>`);
    el.classList.add('show');
    M.sting(/^player_/.test(ev.kind) ? stingFor(ev.kind) : 'alert');
    await sleep(6500);
    el.classList.remove('show');
    await sleep(500);
    busy = false;
  }
  async function pump() {
    if (busy) return;
    if (breakingQ.length > 3) { while (breakingQ.length > 2) alertQ.unshift(breakingQ.shift()); } // too much at once: older ones become alerts
    if (breakingQ.length && Date.now() - lastBreakingAt > 15000) return playBreaking(breakingQ.shift());
    if (alertQ.length) { if (alertQ.length > 6) alertQ.splice(0, alertQ.length - 6); return playAlert(alertQ.shift()); }
  }

  // ------------------------------------------------------------------ ticker
  let tickX = 0, tickW = 0, lastFrame = 0;
  function tickerItems() {
    const out = [];
    for (const L of leagues) {
      for (const m of L.matchups) {
        const h = T(L, m.home), a = T(L, m.away), lead = m.wp >= 50 ? h : a;
        out.push(`<span class="tk"><span class="lg">${esc(shortName(L).toUpperCase())}</span><span class="${m.hs >= m.as ? 'w' : ''}">${esc(h.name)} ${fmt(m.hs)}</span>–<span class="${m.as > m.hs ? 'w' : ''}">${fmt(m.as)} ${esc(a.name)}</span>${m.done ? '<span class="pct">FINAL</span>' : `<span class="pct">${esc(lead.name)} ${Math.round(Math.max(m.wp, 100 - m.wp))}%</span>`}</span>`);
      }
    }
    for (const h of tickerHeads.slice(0, 6)) out.push(`<span class="tk"><span class="hl">${esc(h)}</span></span>`);
    for (const g of D.nfl.games.filter((x) => x.state === 'in')) out.push(`<span class="tk"><span class="lg">NFL</span>${esc(g.away.abbr)} ${g.away.score} – ${g.home.score} ${esc(g.home.abbr)} <span class="pct">${esc(g.detail)}</span></span>`);
    return out.length ? out.join('') : '<span class="tk">Stand by for scores</span>';
  }
  function rebuildTicker() {
    const run = $('tickerRun'), html = tickerItems();
    run.innerHTML = html + html;
    tickW = run.scrollWidth / 2;
  }
  function tickerFrame(ts) {
    const dt = lastFrame ? Math.min(0.1, (ts - lastFrame) / 1000) : 0; lastFrame = ts;
    tickX -= dt * 120;
    if (tickW && -tickX >= tickW) { tickX += tickW; rebuildTicker(); }
    $('tickerRun').style.transform = `translateX(${tickX}px)`;
    requestAnimationFrame(tickerFrame);
  }

  // ------------------------------------------------------------------ demo
  const DEMO_KINDS = ['lead_change', 'player_rush_td', 'record_watch', 'upset_watch', 'player_rec_td', 'big_swing', 'player_dud', 'nail_biter', 'final_upset', 'player_big_day', 'final_close', 'player_interception', 'player_bench_boom'];
  let demoI = 0;
  function demoEvent() {
    const L = leagues.filter((x) => x.matchups.length)[demoI % Math.max(1, leagues.filter((x) => x.matchups.length).length)] || cur;
    const kind = DEMO_KINDS[demoI++ % DEMO_KINDS.length];
    const m = L.matchups[Math.floor(Math.random() * L.matchups.length)];
    if (!m) return;
    const tm = T(L, m.home), op = T(L, m.away);
    const names = [['Josh Allen', 3918298, 'BUF'], ['Bijan Robinson', 4430807, 'ATL'], ['Ja\u2019Marr Chase', 4362628, 'CIN'], ['CeeDee Lamb', 4241389, 'DAL'], ['Saquon Barkley', 3929630, 'PHI'], ['Travis Kelce', 15847, 'KC'], ['Amon-Ra St. Brown', 4374302, 'DET'], ['Puka Nacua', 4426515, 'LAR']];
    const pl = names[demoI % names.length];
    D.__emit({ league: L, kind, priority: /^player_(dud|interception|bench)/.test(kind) ? 1 : 2, matchup: m, team: tm, opp: op, pct: 68, wp: 68, score: fmt(m.hs), oppScore: fmt(m.as), margin: Math.abs(m.hs - m.as).toFixed(1),
      record: kind === 'record_watch' ? { key: 'high', label: 'Highest score', text: '187.4', who: 'The Oscar Dynasty', when: 'Wk 9, 2025' } : undefined, value: 191.2,
      prePct: 27, swing: 24, gap: '2.4', player: pl[0], pid: pl[1], pos: 'RB', pro: pl[2], pts: '24.6', delta: '6.0', detail: { proj: 16.5, yards: 112, mark: 100 }, ts: Date.now() });
  }

  // ------------------------------------------------------------------ boot
  let recordsReady = false;
  function checkRecords(quiet) {
    if (!window.DeskRecords) return;
    for (const L of leagues) for (const r of DeskRecords.check(L)) {
      onEvent({ league: L, kind: r.kind, priority: r.priority, matchup: r.matchup, team: D.team(L, r.teamId), opp: D.team(L, r.oppId), record: r.record, value: r.value, ts: Date.now(), old: !!quiet });
    }
  }
  async function refreshAll() {
    let ok = true;
    await Promise.all([D.refreshNfl(), ...leagues.map((L) => D.refreshLeague(L).catch((e) => { ok = false; console.warn('refresh failed', L.slug, e); }))]);
    if (window.DeskFx) DeskFx.refreshResult(ok);
    D.refreshNews().catch(() => {});
    checkMode(true);
    if (recordsReady) checkRecords(false);
    renderTop(); renderSide();
    if (currentSeg && !busy && currentSeg.key !== 'recap' && SEGMENTS[currentSeg.key]) { const s = SEGMENTS[currentSeg.key](cur); if (s) { s.title = currentSeg.title; s.line = currentSeg.line; showSegment(s, false); } }
  }

  // The most recent week where every game is final -> the recap show's week.
  async function findRecapWeek(L) {
    const done = new Map();
    for (const r of L.summary) { const k = r.week; if (!done.has(k)) done.set(k, true); if (!r.all_starters_done) done.set(k, false); }
    const weeks = [...done.entries()].filter(([, ok]) => ok).map(([w]) => w).sort((a, b) => b - a);
    if (weeks.length) L.recapWeek = { year: L.year, week: weeks[0] };
  }

  async function boot() {
    fit(); addEventListener('resize', fit);
    let hideUi = 0;
    addEventListener('mousemove', () => { document.body.classList.add('ui'); clearTimeout(hideUi); hideUi = setTimeout(() => document.body.classList.remove('ui'), 2500); });
    D.on(onEvent);
    D.__emit = onEvent;
    window.DeskShow = { segment: (k) => { const seg = SEGMENTS[k] && SEGMENTS[k](cur); if (seg) showSegment(seg, true); return !!seg; }, demo: () => demoEvent(), commercial: () => commercialBreak(), replay: (i) => playReplay(cur, cur.matchups[i || 0]), get cur() { return cur; } }; // for testing
    try {
      leagues = (await D.init()).filter((L) => L.year);
      await D.refreshNfl();
    } catch (e) {
      $('loading').textContent = 'Couldn’t reach the data. Retrying in 30 seconds…';
      setTimeout(() => location.reload(), 30000);
      return;
    }
    if (!leagues.length) { $('loading').textContent = 'No league data yet.'; return; }
    for (const L of leagues) $('studioLock').insertAdjacentHTML('beforeend', `<option value="${esc(L.id)}">${esc(L.name)} only</option>`);
    const want = params.get('studio');
    const pinned = want && leagues.find((L) => L.slug === want || L.id === want);
    if (pinned) { lock = pinned.id; $('studioLock').value = pinned.id; }
    // Start in the studio with the most going on.
    const busiest = pinned || leagues.slice().sort((a, b) => b.matchups.filter((m) => !m.done).length - a.matchups.filter((m) => !m.done).length)[0];
    mode = computeMode();
    D.refreshNews().catch(() => {});
    applyStudio(busiest);
    $('loading').remove();
    // Record book + last finished week (for the recap show), in the background.
    if (window.DeskRecords) Promise.all(leagues.map((L) => DeskRecords.load(D.sb, L).catch(() => null))).then(() => { checkRecords(true); recordsReady = true; });
    for (const L of leagues) findRecapWeek(L);
    if (window.DeskFx) { DeskFx.onOnline = refreshAll; DeskFx.onHoliday = () => cur && applyStudio(cur); }
    rebuildTicker(); requestAnimationFrame(tickerFrame);
    segPlan = planFor(cur); segIdx = 0; nextSegment();
    setInterval(tickClock, 1000); tickClock();
    setInterval(pump, 1000);
    setInterval(refreshAll, REFRESH_MS);
    setInterval(() => { renderTop(); renderSide(); }, 15000);

    // Sound: browsers need one click first.
    const gate = $('soundGate');
    if (params.get('sound') !== 'off') gate.hidden = false;
    const startSound = () => { M.start(); M.setStyle(cur.studio, night() ? 'night' : 'day'); gate.hidden = true; $('btnSound').textContent = '🔊 Sound'; if (window.DeskFx) DeskFx.wake(); renderTop(); };
    gate.onclick = startSound;
    $('btnSound').onclick = () => { if (M.running) { M.stop(); $('btnSound').textContent = '🔇 Sound'; } else startSound(); };
    $('vol').oninput = (e) => M.setVolume(e.target.value / 100);
    $('studioLock').onchange = async (e) => { lock = e.target.value; if (lock !== 'auto') { const L = leagues.find((x) => x.id === lock); if (L && L !== cur) await handoff(L); } };
    $('btnDemo').onclick = demoEvent;
    $('btnFull').onclick = () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()).catch(() => {});
    if (params.get('demo')) setInterval(demoEvent, Number(params.get('demo')) * 1000 || 45000);
    addEventListener('keydown', (e) => { if (e.key === 'd') demoEvent(); if (e.key === 'f') $('btnFull').click(); if (e.key === 'm') $('btnSound').click(); });
  }
  boot();
})();
