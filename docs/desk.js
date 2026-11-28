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
  let busy = false, lastBreakingAt = 0;
  const breakingQ = [], alertQ = [];
  const rundown = new Map(); // league id -> [{head, body, ts, priority}]
  const tickerHeads = [];

  // ------------------------------------------------------------------ helpers
  const shortName = (L) => (L ? L.name.replace(/\s*league\s*$/i, '').trim() : '');
  const night = () => (params.get('look') === 'night' ? true : params.get('look') === 'day' ? false : D.isNight()); // ?look=day|night to preview
  const voice = (L) => (L ? L.studio : (cur ? cur.studio : 'pro'));
  // Team colors, adjusted so they stay readable on the current look: very dark
  // colors are lifted on the night sets, very light ones deepened on the day sets.
  function vis(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim()); if (!m) return '#7f8fa6';
    const n = parseInt(m[1], 16); let r = n >> 16, g = (n >> 8) & 255, b = n & 255;
    const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255, dark = document.documentElement.dataset.daypart === 'night';
    const mix = (k, to) => { r = Math.round(r + (to - r) * k); g = Math.round(g + (to - g) * k); b = Math.round(b + (to - b) * k); };
    if (dark && lum < 0.42) mix((0.42 - lum) / (1 - lum) + 0.18, 255);
    if (!dark && lum > 0.62) mix((lum - 0.62) / lum + 0.2, 0);
    return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
  }
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
  function fit() {
    const s = Math.min(innerWidth / 1920, innerHeight / 1080);
    $('tv').style.transform = `scale(${s}) translate(-50%, -50%)`;
    $('tv').style.transformOrigin = '0 0';
    $('tv').style.left = '50%'; $('tv').style.top = '50%';
    $('tv').style.transform = `translate(-50%, -50%) scale(${s})`;
    $('tv').style.transformOrigin = 'center center';
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
    $('brandShow').textContent = shortName(L) + ' ' + showName(L) + (tag ? ' \u00b7 ' + tag : '');
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
    spotlight(L) {
      const ms = L.matchups.slice().sort((a, b) => drama(b) - drama(a));
      if (!ms.length) return null;
      const m = ms[spotlightTurn++ % Math.min(ms.length, 2)];
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
        <canvas class="chart" id="spotChart" style="height:${hasPlayers ? 200 : 330}px;margin-top:22px"></canvas>
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
    const pts = m.series.length > 1 ? m.series : [{ t: 0, wp: m.pre }, { t: 1, wp: m.wp }];
    const t0 = pts[0].t, t1 = pts[pts.length - 1].t || t0 + 1;
    const X = (t) => 8 + (t - t0) / ((t1 - t0) || 1) * (W - 16), Y = (wp) => 8 + (1 - wp / 100) * (H - 16), y50 = Y(50);
    const css = getComputedStyle(document.documentElement);
    x.strokeStyle = css.getPropertyValue('--line'); x.setLineDash([6, 6]); x.beginPath(); x.moveTo(0, y50); x.lineTo(W, y50); x.stroke(); x.setLineDash([]);
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i - 1], q = pts[i], col = (p.wp + q.wp) / 2 >= 50 ? h.color : a.color;
      x.fillStyle = col + '33'; x.beginPath(); x.moveTo(X(p.t), y50); x.lineTo(X(p.t), Y(p.wp)); x.lineTo(X(q.t), Y(p.wp)); x.lineTo(X(q.t), y50); x.fill();
      x.strokeStyle = col; x.lineWidth = 4; x.lineJoin = 'round'; x.beginPath(); x.moveTo(X(p.t), Y(p.wp)); x.lineTo(X(q.t), Y(p.wp)); x.lineTo(X(q.t), Y(q.wp)); x.stroke();
    }
    const lp = pts[pts.length - 1];
    x.fillStyle = lp.wp >= 50 ? h.color : a.color; x.beginPath(); x.arc(X(lp.t), Y(lp.wp), 8, 0, 7); x.fill();
    x.font = '700 15px Inter, sans-serif'; x.fillStyle = css.getPropertyValue('--muted');
    x.fillText(h.name + ' ↑', 12, 24); x.fillText(a.name + ' ↓', 12, H - 14);
  }

  function planFor(L) {
    const live = L.matchups.some((m) => !m.done);
    const plan = live ? ['spotlight', 'scoreboard', 'need', 'players', 'spotlight', 'standings', 'records', 'nfl', 'rundown'] : ['recap', 'scoreboard', 'standings', 'records', 'players', 'spotlight', 'rundown', 'nfl'];
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
    const t0 = pts[0].t, t1 = pts[pts.length - 1].t || t0 + 1, X = (t) => 10 + (t - t0) / ((t1 - t0) || 1) * (W - 20), Y = (wp) => 10 + (1 - wp / 100) * (H - 20);
    const css = getComputedStyle(document.documentElement);
    const DUR = 7500, start = performance.now();
    await new Promise((resolve) => {
      const f = (now) => {
        const u = Math.min(1, (now - start) / DUR), e = u < 0.6 ? u / 0.6 * 0.75 : 0.75 + (u - 0.6) / 0.4 * 0.25; // the last quarter of time in slow motion
        const tc = t0 + (t1 - t0) * e;
        x.clearRect(0, 0, W, H);
        x.strokeStyle = css.getPropertyValue('--line'); x.setLineDash([6, 6]); x.beginPath(); x.moveTo(0, Y(50)); x.lineTo(W, Y(50)); x.stroke(); x.setLineDash([]);
        let last = pts[0];
        for (let i = 1; i < pts.length && pts[i - 1].t <= tc; i++) {
          const p = pts[i - 1], q = pts[i].t <= tc ? pts[i] : { t: tc, wp: p.wp, hs: p.hs, as: p.as };
          const col = (p.wp + q.wp) / 2 >= 50 ? h.color : a.color;
          x.strokeStyle = col; x.lineWidth = 5; x.lineJoin = 'round'; x.beginPath(); x.moveTo(X(p.t), Y(p.wp)); x.lineTo(X(q.t), Y(p.wp)); x.lineTo(X(q.t), Y(q.wp)); x.stroke();
          last = q;
        }
        const glow = 10 + 6 * Math.sin(now / 90);
        x.fillStyle = last.wp >= 50 ? h.color : a.color; x.shadowColor = x.fillStyle; x.shadowBlur = glow * 2; x.beginPath(); x.arc(X(last.t), Y(last.wp), 10, 0, 7); x.fill(); x.shadowBlur = 0;
        wrap.querySelector('#rpHs').textContent = fmt(last.hs); wrap.querySelector('#rpAs').textContent = fmt(last.as);
        wrap.querySelector('#rpPct').textContent = Math.round(Math.max(last.wp, 100 - last.wp)) + '% ' + (last.wp >= 50 ? h.name : a.name);
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
    if (ev.record) { const r = ev.record; v.REC = r.label.toLowerCase(); v.OLD = r.text; v.WHO = r.who; v.WHEN = r.when; v.V = r.key === 'streak' ? ev.value : Number(ev.value).toFixed(1); }
    if (ev.game) { const g = ev.game; v.G = g.state === 'post' || g.state === 'in' ? `${g.away.abbr} ${g.away.score}, ${g.home.abbr} ${g.home.score}` : `${g.away.name} at ${g.home.name}`; }
    return v;
  }
  function stingFor(kind) {
    if (/upset/.test(kind)) return 'upset';
    if (/^final/.test(kind)) return 'final';
    if (/^record/.test(kind)) return 'record';
    if (/_td$|dst_score|big_day|boom_final|big_play/.test(kind)) return 'td';
    if (/interception|fumble|dud|bench_boom|scare/.test(kind)) return 'bad';
    if (kind === 'lead_change' || kind === 'big_swing') return 'lead';
    return 'breaking';
  }

  function onEvent(ev) {
    const L = ev.league;
    const w = Lines.write(ev.kind, voice(L), varsFor(ev));
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
    el.querySelector('.kick').textContent = /^final/.test(ev.kind) ? (voice(L) === 'pro' ? 'FINAL' : 'IT’S OVER') : /upset/.test(ev.kind) ? 'UPSET ALERT' : ev.kind === 'record_broken' ? (voice(L) === 'pro' ? 'HISTORY' : 'NEW RECORD') : ev.kind === 'record_watch' ? 'RECORD WATCH' : /^player_/.test(ev.kind) ? (voice(L) === 'pro' ? 'SCORING PLAY' : 'BIG PLAY') : (voice(L) === 'pro' ? 'BREAKING' : 'BIG NEWS');
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
