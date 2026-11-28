// desk-data.js -- everything the News Desk (desk.html) knows about the world.
//
// Loads every league, keeps the current week fresh (scores, win %, player
// lineups and player events written by the poller, the real NFL scoreboard),
// and turns each refresh into "events": lead changes, upsets, finals, big
// swings, touchdowns... which desk.js puts on air. Read-only, public key only.
(function () {
  'use strict';
  const { url, anonKey } = window.SUPABASE_CONFIG;
  const sb = window.supabase.createClient(url, anonKey);
  const NFL_SB = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';
  const REG_SEASON_END_BASE = 17;
  const PAGE = 1000;

  async function fetchAll(build) {
    const out = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await build(from, from + PAGE - 1);
      if (error) throw error;
      out.push(...(data || []));
      if (!data || data.length < PAGE) return out;
    }
  }
  const optional = async (p) => { try { const r = await p; return r.error ? null : r.data; } catch (e) { return null; } };

  // ------------------------------------------------------------------ state
  const leagues = []; // see loadLeague()
  const listeners = [];
  const emit = (ev) => listeners.forEach((fn) => fn(ev));

  function studioFor(name) { return /family/i.test(name || '') ? 'casual' : 'pro'; }

  async function init() {
    const { data, error } = await sb.from('leagues').select('id, slug, name, playoff_spots').order('name');
    if (error) throw error;
    for (const l of data || []) {
      leagues.push({
        id: l.id, slug: l.slug, name: l.name, studio: studioFor(l.name),
        playoffSpots: Number(l.playoff_spots) || 6,
        teams: {}, year: null, week: null, regEnd: 14,
        summary: [], schedule: [], matchups: [], series: new Map(), lastTs: null,
        lineups: new Map(), events: [], lastEventId: 0, lineupsOk: true,
        standings: [], odds: new Map(), seen: new Map(), firstLoad: true,
      });
    }
    await Promise.all(leagues.map(loadLeague));
    return leagues;
  }

  async function loadLeague(L) {
    const [teams, latest] = await Promise.all([
      sb.from('teams').select('id, espn_team_name, team_settings(color, display_name, emoji, logo_url)').eq('league_id', L.id),
      sb.from('snapshot_summary').select('year, week').eq('league_id', L.id).order('year', { ascending: false }).order('week', { ascending: false }).limit(1),
    ]);
    if (teams.error) throw teams.error;
    for (const t of teams.data || []) {
      const s = t.team_settings || {};
      L.teams[t.id] = { id: t.id, name: s.display_name || t.espn_team_name, color: s.color || '#3b6ef5', emoji: s.emoji || '', logoUrl: s.logo_url || '' };
    }
    const row = latest.data && latest.data[0];
    if (!row) return;
    L.year = row.year; L.week = row.week;
    const size = Math.pow(2, Math.ceil(Math.log2(Math.max(2, L.playoffSpots))));
    L.regEnd = REG_SEASON_END_BASE - Math.round(Math.log2(size));
    const [summary, schedule] = await Promise.all([
      fetchAll((a, b) => sb.from('snapshot_summary').select('year, week, matchup_id, team_id, is_home, actual_score, expected_score, win_prob, all_starters_done, ts, pregame_win_prob, pregame_expected_score').eq('league_id', L.id).eq('year', L.year).order('week').range(a, b)),
      optional(sb.from('schedule').select('week, home_team_id, away_team_id').eq('league_id', L.id).eq('year', L.year)),
    ]);
    L.summary = summary; L.schedule = schedule || [];
    // ESPN's saved schedule only covers the regular season, so its last week is
    // the real cutoff (leagues differ); fall back to the bracket-size default.
    const lastSched = L.schedule.reduce((mx, s) => Math.max(mx, s.week), 0);
    if (lastSched >= L.week) L.regEnd = lastSched;
    await refreshLeague(L);
  }

  // ------------------------------------------------------------------ refresh
  async function refreshLeague(L) {
    if (!L.year) return;
    const { year, week } = L;
    const rows = await fetchAll((a, b) => {
      let q = sb.from('snapshots').select('id, matchup_id, team_id, is_home, ts, actual_score, expected_score, win_prob, all_starters_done')
        .eq('league_id', L.id).eq('year', year).eq('week', week);
      if (L.lastTs) q = q.gte('ts', L.lastTs);
      return q.order('ts').order('id').range(a, b);
    });
    for (const r of rows) {
      const key = r.matchup_id + '|' + r.team_id;
      if (!L.series.has(key)) L.series.set(key, []);
      const arr = L.series.get(key);
      if (!arr.length || arr[arr.length - 1].id !== r.id) {
        if (arr.some((x) => x.id === r.id)) continue;
        arr.push(r);
      }
      if (!L.lastTs || r.ts > L.lastTs) L.lastTs = r.ts;
    }
    // A brand-new week started (the poller wrote its first rows): move to it.
    const { data: newer } = await sb.from('snapshot_summary').select('week').eq('league_id', L.id).eq('year', year).gt('week', week).limit(1);
    if (newer && newer.length) { L.week = newer[0].week; L.series.clear(); L.lastTs = null; L.lineups.clear(); L.events = []; L.lastEventId = 0; L.seen.clear(); L.firstLoad = true; return refreshLeague(L); }

    buildMatchups(L);
    await Promise.all([refreshPlayers(L), refreshSummaryForStandings(L)]);
    computeStandings(L);
    detect(L);
    L.firstLoad = false;
  }

  async function refreshSummaryForStandings(L) {
    // Earlier weeks only change on a stat correction: refresh them now and then.
    if (L._sumAt && Date.now() - L._sumAt < 10 * 60 * 1000) return;
    L._sumAt = Date.now();
    const s = await optional(sb.from('snapshot_summary').select('year, week, matchup_id, team_id, is_home, actual_score, expected_score, win_prob, all_starters_done, ts, pregame_win_prob, pregame_expected_score').eq('league_id', L.id).eq('year', L.year).lt('week', L.week).range(0, 4999));
    if (s) L.summary = s.concat(L.summary.filter((r) => r.week >= L.week));
  }

  function last(arr) { return arr && arr.length ? arr[arr.length - 1] : null; }

  function buildMatchups(L) {
    const byMatchup = new Map();
    for (const [key, arr] of L.series) {
      const mid = Number(key.split('|')[0]);
      if (!byMatchup.has(mid)) byMatchup.set(mid, []);
      byMatchup.get(mid).push(arr);
    }
    const pre = new Map();
    for (const r of L.summary) if (r.week === L.week) pre.set(r.team_id, r);
    const out = [];
    for (const [mid, sides] of byMatchup) {
      if (sides.length !== 2) continue;
      let [h, a] = sides;
      if (!h[0].is_home) [h, a] = [a, h];
      const hl = last(h), al = last(a);
      // Joint win-% series: the home side's win % at every moment either side changed.
      const pts = [];
      let i = 0, j = 0, hp = null, ap = null;
      while (i < h.length || j < a.length) {
        const takeH = j >= a.length || (i < h.length && h[i].ts <= a[j].ts);
        if (takeH) hp = h[i++]; else ap = a[j++];
        const cur = takeH ? hp : ap;
        const wp = cur.is_home ? Number(cur.win_prob) : 100 - Number(cur.win_prob);
        pts.push({ t: Date.parse(cur.ts), wp, hs: hp ? Number(hp.actual_score) : 0, as: ap ? Number(ap.actual_score) : 0 });
      }
      const ph = pre.get(hl.team_id);
      out.push({
        id: mid, home: hl.team_id, away: al.team_id,
        hs: Number(hl.actual_score), as: Number(al.actual_score),
        hx: Number(hl.expected_score), ax: Number(al.expected_score),
        wp: Number(hl.win_prob), // home win %
        pre: ph && ph.pregame_win_prob != null ? Number(ph.pregame_win_prob) : (pts[0] ? pts[0].wp : 50),
        done: !!(hl.all_starters_done && al.all_starters_done),
        updated: Math.max(Date.parse(hl.ts), Date.parse(al.ts)),
        series: pts,
      });
    }
    out.sort((x, y) => x.id - y.id);
    L.matchups = out;
  }

  async function refreshPlayers(L) {
    if (!L.lineupsOk) return;
    const [lu, ev] = await Promise.all([
      sb.from('lineups').select('team_id, players, updated_at').eq('league_id', L.id).eq('year', L.year).eq('week', L.week),
      sb.from('player_events').select('id, team_id, ts, player_id, player_name, position, pro_team, kind, points, delta, detail').eq('league_id', L.id).eq('year', L.year).eq('week', L.week).gt('id', L.lastEventId).order('id').limit(500),
    ]);
    if (lu.error || ev.error) {
      const e = lu.error || ev.error;
      if (e.code === 'PGRST205' || e.code === '42P01') L.lineupsOk = false; // migration 002 not run yet
      return;
    }
    for (const r of lu.data || []) L.lineups.set(r.team_id, r.players || []);
    for (const e of ev.data || []) { L.events.push(e); L.lastEventId = Math.max(L.lastEventId, e.id); L._newPlayerEvents = (L._newPlayerEvents || []).concat(e); }
  }

  // ------------------------------------------------------------------ standings + odds
  function computeStandings(L) {
    const latest = new Map();
    for (const r of L.summary) {
      if (r.week >= L.week || r.week > L.regEnd) continue;
      const k = r.week + '|' + r.matchup_id + '|' + r.team_id;
      const ex = latest.get(k);
      if (!ex || r.ts > ex.ts) latest.set(k, r);
    }
    const rec = new Map(Object.keys(L.teams).map((id) => [id, { id, w: 0, l: 0, t: 0, pf: 0, pa: 0, games: [] }]));
    const groups = new Map();
    for (const r of latest.values()) { const k = r.week + '|' + r.matchup_id; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
    for (const g of groups.values()) {
      if (g.length !== 2 || !g[0].all_starters_done || !g[1].all_starters_done) continue;
      const [a, b] = g, A = rec.get(a.team_id), B = rec.get(b.team_id);
      if (!A || !B) continue;
      const sa = Number(a.actual_score), sbb = Number(b.actual_score);
      A.pf += sa; A.pa += sbb; B.pf += sbb; B.pa += sa; A.games.push(sa); B.games.push(sbb);
      if (sa > sbb) { A.w++; B.l++; } else if (sbb > sa) { B.w++; A.l++; } else { A.t++; B.t++; }
    }
    const order = (arr) => arr.sort((x, y) => (y.w + y.t / 2) - (x.w + x.t / 2) || y.pf - x.pf);
    const base = order([...rec.values()]);
    // "If it ended right now": this week's current leaders get the win.
    const now = [...rec.values()].map((r) => ({ ...r }));
    const byId = new Map(now.map((r) => [r.id, r]));
    const inSeason = L.week <= L.regEnd;
    if (inSeason) for (const m of L.matchups) {
      const H = byId.get(m.home), A = byId.get(m.away); if (!H || !A) continue;
      H.pf += m.hs; A.pf += m.as;
      if (m.wp >= 50) { H.w++; A.l++; } else { A.w++; H.l++; }
    }
    order(now);
    const baseRank = new Map(base.map((r, i) => [r.id, i + 1]));
    L.standings = now.map((r, i) => ({ ...r, rank: i + 1, was: baseRank.get(r.id), inPlayoffs: i < L.playoffSpots }));
    L.inSeason = inSeason;
    L.odds = inSeason ? simulateOdds(L, rec) : new Map();
  }

  // Playoff odds: this week from the live win %, the rest of the regular
  // season from each team's scoring so far. Run twice -- with the live
  // numbers, and with kickoff (pregame) numbers -- so the desk can say whose
  // odds moved today.
  function simulateOdds(L, rec) {
    const ids = Object.keys(L.teams); if (!ids.length) return new Map();
    const mean = new Map(ids.map((id) => { const r = rec.get(id); const g = r && r.games.length ? r.games : [110]; return [id, g.reduce((s, x) => s + x, 0) / g.length]; }));
    const future = L.schedule.filter((s) => s.week > L.week && s.week <= L.regEnd);
    const N = 1500, P = L.playoffSpots;
    const run = (usePregame) => {
      const made = new Map(ids.map((id) => [id, 0]));
      let seed = 12345 + L.week;
      const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
      const gauss = () => Math.sqrt(-2 * Math.log(rnd() || 1e-9)) * Math.cos(2 * Math.PI * rnd());
      for (let n = 0; n < N; n++) {
        const w = new Map(ids.map((id) => [id, (rec.get(id) || { w: 0 }).w + (rec.get(id) || { t: 0 }).t / 2]));
        const pf = new Map(ids.map((id) => [id, (rec.get(id) || { pf: 0 }).pf]));
        for (const m of L.matchups) {
          const p = (usePregame ? m.pre : m.wp) / 100;
          const homeWins = rnd() < p;
          w.set(homeWins ? m.home : m.away, w.get(homeWins ? m.home : m.away) + 1);
          pf.set(m.home, pf.get(m.home) + m.hx); pf.set(m.away, pf.get(m.away) + m.ax);
        }
        for (const s of future) {
          const a = mean.get(s.home_team_id) + gauss() * 22, b = mean.get(s.away_team_id) + gauss() * 22;
          if (!w.has(s.home_team_id) || !w.has(s.away_team_id)) continue;
          w.set(a >= b ? s.home_team_id : s.away_team_id, w.get(a >= b ? s.home_team_id : s.away_team_id) + 1);
          pf.set(s.home_team_id, pf.get(s.home_team_id) + a); pf.set(s.away_team_id, pf.get(s.away_team_id) + b);
        }
        const ranked = ids.slice().sort((x, y) => w.get(y) - w.get(x) || pf.get(y) - pf.get(x));
        for (let i = 0; i < P && i < ranked.length; i++) made.set(ranked[i], made.get(ranked[i]) + 1);
      }
      return new Map(ids.map((id) => [id, made.get(id) / N]));
    };
    const live = run(false), pre = run(true);
    return new Map(ids.map((id) => [id, { now: live.get(id), pre: pre.get(id) }]));
  }

  // ------------------------------------------------------------------ event detection
  // Compares this refresh with what the desk had already seen. On the very
  // first load nothing is "breaking": recent things go into the rundown quietly.
  function detect(L) {
    const quiet = L.firstLoad;
    const out = [];
    const T = (id) => L.teams[id] || { name: 'Unknown', color: '#888' };
    for (const m of L.matchups) {
      const prev = L.seen.get(m.id);
      const lead = m.wp >= 50 ? m.home : m.away, trail = lead === m.home ? m.away : m.home;
      const leadPct = Math.round(Math.max(m.wp, 100 - m.wp));
      const favPre = m.pre >= 50 ? m.home : m.away;
      const dogPre = favPre === m.home ? m.away : m.home;
      const dogPrePct = Math.round(Math.min(m.pre, 100 - m.pre));
      const base = { league: L, matchup: m, team: T(lead), opp: T(trail), pct: leadPct };
      const sc = (id) => (id === m.home ? m.hs : m.as);
      if (!prev) {
        // First time we see this game: whatever is already true is old news.
        // Mark it as seen (so it never "breaks" later) and put it in the rundown quietly.
        const flags = new Set();
        if (m.done) { const upset = lead === dogPre && dogPrePct <= 40; out.push({ ...base, kind: upset ? 'final_upset' : 'final', priority: 1, score: sc(lead).toFixed(1), oppScore: sc(trail).toFixed(1), margin: Math.abs(m.hs - m.as).toFixed(1), prePct: dogPrePct, old: true, ts: m.updated }); }
        else {
          if (lead === dogPre && dogPrePct <= 35 && leadPct >= 65) { flags.add('upset'); out.push({ ...base, kind: 'upset_watch', priority: 2, prePct: dogPrePct, old: true, ts: m.updated }); }
          if (lead === favPre && Math.round(Math.max(m.pre, 100 - m.pre)) >= 70 && leadPct <= 55) { flags.add('scare'); }
          if (leadPct >= 97) { flags.add('lock'); out.push({ ...base, kind: 'lock', priority: 1, old: true, ts: m.updated }); }
          if (leadPct <= 60 && Math.max(m.hx - m.hs, 0) + Math.max(m.ax - m.as, 0) < 25) flags.add('nail');
          for (const [id, s] of [[m.home, m.hs], [m.away, m.as]]) for (const mark of [100, 125, 150, 175]) if (s >= mark) flags.add(id + mark);
        }
        L.seen.set(m.id, { wp: m.wp, done: m.done, hs: m.hs, as: m.as, t: Date.now(), flags });
        continue;
      }
      const flags = prev.flags;
      if (m.done && !prev.done) {
        const upset = lead === dogPre && dogPrePct <= 40;
        out.push({ ...base, kind: upset ? 'final_upset' : (Math.abs(m.hs - m.as) < 5 ? 'final_close' : (Math.abs(m.hs - m.as) > 40 ? 'final_blowout' : 'final')), priority: upset ? 3 : 2,
          score: sc(lead).toFixed(1), oppScore: sc(trail).toFixed(1), margin: Math.abs(m.hs - m.as).toFixed(1), prePct: dogPrePct });
      } else if (!m.done) {
        const crossed = (prev.wp < 45 && m.wp > 55) || (prev.wp > 55 && m.wp < 45);
        if (crossed) out.push({ ...base, kind: 'lead_change', priority: 2, from: Math.round(prev.wp >= 50 ? prev.wp : 100 - prev.wp) });
        const swing = Math.abs(m.wp - prev.wp);
        if (!crossed && swing >= 18) out.push({ ...base, kind: 'big_swing', priority: 2, swing: Math.round(swing), up: m.wp > prev.wp ? T(m.home) : T(m.away), down: m.wp > prev.wp ? T(m.away) : T(m.home) });
        if (lead === dogPre && dogPrePct <= 35 && leadPct >= 65 && !flags.has('upset')) { flags.add('upset'); out.push({ ...base, kind: 'upset_watch', priority: 2, prePct: dogPrePct }); }
        if (lead === favPre && Math.round(Math.max(m.pre, 100 - m.pre)) >= 70 && leadPct <= 55 && !flags.has('scare')) { flags.add('scare'); out.push({ ...base, kind: 'favorite_scare', priority: 1, prePct: Math.round(Math.max(m.pre, 100 - m.pre)) }); }
        if (leadPct >= 97 && !flags.has('lock')) { flags.add('lock'); out.push({ ...base, kind: 'lock', priority: 1 }); }
        const close = leadPct <= 60 && Math.max(m.hx - m.hs, 0) + Math.max(m.ax - m.as, 0) < 25;
        if (close && !flags.has('nail')) { flags.add('nail'); out.push({ ...base, kind: 'nail_biter', priority: 2, gap: Math.abs(m.hs - m.as).toFixed(1) }); }
        for (const [id, s, ps] of [[m.home, m.hs, prev.hs], [m.away, m.as, prev.as]]) {
          for (const mark of [100, 125, 150, 175]) if (ps < mark && s >= mark && !flags.has(id + mark)) { flags.add(id + mark); out.push({ ...base, kind: 'score_mark', priority: 1, team: T(id), opp: T(id === m.home ? m.away : m.home), mark, score: s.toFixed(1) }); }
        }
      }
      L.seen.set(m.id, { wp: m.wp, done: m.done, hs: m.hs, as: m.as, t: Date.now(), flags });
    }
    // Player events from the poller.
    for (const e of L._newPlayerEvents || []) {
      const m = L.matchups.find((x) => x.home === e.team_id || x.away === e.team_id);
      const team = T(e.team_id), opp = m ? T(m.home === e.team_id ? m.away : m.home) : null;
      const wpNow = m ? Math.round(m.home === e.team_id ? m.wp : 100 - m.wp) : null;
      const pri = { pass_td: 2, rush_td: 2, rec_td: 2, dst_score: 2, interception: 1, fumble: 1, big_day: 2, boom_final: 2, dud: 1, bench_boom: 1, big_play: 1, fg_50: 1, stat_correction: 0 }[e.kind];
      out.push({ league: L, kind: 'player_' + e.kind, priority: pri == null ? 1 : pri, team, opp, matchup: m, player: e.player_name, pid: e.player_id, pos: e.position, pro: e.pro_team,
        pts: Number(e.points || 0).toFixed(1), delta: Math.abs(Number(e.delta || 0)).toFixed(1), detail: e.detail || {}, wp: wpNow, ts: Date.parse(e.ts), old: quiet || Date.now() - Date.parse(e.ts) > 20 * 60 * 1000 });
    }
    L._newPlayerEvents = [];
    out.sort((a, b) => (a.ts || 0) - (b.ts || 0));
    for (const ev of out) { ev.ts = ev.ts || Date.now(); if (quiet) ev.old = true; emit(ev); }
  }

  // ------------------------------------------------------------------ NFL scoreboard
  const nfl = { games: [], at: 0, prev: new Map() };
  async function refreshNfl() {
    try {
      const j = await (await fetch(NFL_SB)).json();
      const games = (j.events || []).map((e) => {
        const c = (e.competitions && e.competitions[0]) || {};
        const side = (ha) => { const t = (c.competitors || []).find((x) => x.homeAway === ha) || {}; return { abbr: t.team && t.team.abbreviation, name: t.team && t.team.shortDisplayName, score: Number(t.score || 0), color: t.team && t.team.color ? '#' + t.team.color : '#666', logo: t.team && t.team.logo }; };
        return { id: e.id, date: Date.parse(e.date), state: e.status && e.status.type && e.status.type.state, detail: e.status && e.status.type && e.status.type.shortDetail, period: e.status && e.status.period, home: side('home'), away: side('away'), broadcast: (c.broadcasts && c.broadcasts[0] && c.broadcasts[0].names || [])[0] || '' };
      }).sort((a, b) => a.date - b.date);
      const first = !nfl.at;
      for (const g of games) {
        const p = nfl.prev.get(g.id);
        if (p && !first) {
          if (p.state === 'pre' && g.state === 'in') emit({ kind: 'nfl_kickoff', priority: 0, game: g, ts: Date.now() });
          if (p.state === 'in' && g.state === 'post') emit({ kind: 'nfl_final', priority: 1, game: g, ts: Date.now() });
          if (g.period > 4 && p.period <= 4 && g.state === 'in') emit({ kind: 'nfl_overtime', priority: 1, game: g, ts: Date.now() });
        }
        nfl.prev.set(g.id, { state: g.state, period: g.period });
      }
      nfl.games = games; nfl.at = Date.now();
    } catch (e) { /* keep the last good scoreboard */ }
    return nfl;
  }
  const isNight = () => { const h = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }).format(new Date())) % 24; return h >= 18 || h < 6; };
  const anyLive = () => nfl.games.some((g) => g.state === 'in') || leagues.some((L) => L.matchups.some((m) => !m.done && m.series.length > 1 && Date.now() - m.updated < 30 * 60 * 1000));

  window.DeskData = {
    sb, init, leagues, refreshLeague, refreshNfl, nfl, isNight, anyLive,
    on: (fn) => listeners.push(fn),
    team: (L, id) => L.teams[id] || { name: 'Unknown', color: '#888' },
  };
})();
