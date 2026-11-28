// Recalibrate stored win probabilities with the current model
// (lib/winProb.js calibratedWinProbability).
//
//   node tools/recalibrate-history.js            dry run: prints what would change
//   node tools/recalibrate-history.js --apply    writes it (needs migration 004)
//
// Needs SUPABASE_URL and SUPABASE_SERVICE_KEY (the poller's own secrets). The
// GitHub Actions workflow "Recalibrate win-probability history" runs it.
//
// How each stored row is converted. The snapshots keep each team's expected
// and actual score and the old win %, but not the spread the old model used
// at that moment. That spread is recovered from the old win % itself
// (win% = Phi(gap / (spread * sqrt 2))). Where it can't be (an even game, or
// the old model already at its extremes) the last recovered spread earlier
// in the same game is carried forward, which can only make the new number a
// little more cautious, never more extreme. Then:
//   * finished games (both sides done) keep 0 / 50 / 100;
//   * the old flat 99% / 1% "finished team can't catch up" values go through
//     the new rule for that case;
//   * everything else goes through calibratedWinProbability.
// Rows written after the calibrated poller went live are skipped (they
// already use it); the original values are kept in win_prob_raw, so
// running this twice gives the same result and revert_calibrated_win_probs()
// in the database undoes it.
const { execSync } = require('child_process');
const { createClient } = require('@supabase/supabase-js');
const W = require('../lib/winProb');

const APPLY = process.argv.includes('--apply');
let supabase = null;

// When the calibrated model reached main (the first main-line commit that has
// it). Rows from then on are already calibrated.
function calibratedSince() {
  const arg = process.argv.find((a) => a.startsWith('--before='));
  if (arg) return new Date(arg.slice(9));
  try {
    const commits = execSync('git log --first-parent --reverse --format="%H %cI" HEAD', { encoding: 'utf8' }).trim().split('\n');
    for (const line of commits) {
      const [hash, when] = line.split(' ');
      try { execSync(`git grep -q calibratedWinProbability ${hash} -- poller/lib/winProb.js`, { stdio: 'ignore' }); return new Date(when); } catch (e) { /* not in this commit */ }
    }
  } catch (e) { /* no git history: treat everything as old */ }
  return new Date();
}

function legacyFromCalibrated(hE, aE, hA, aA, cal) {
  if (Math.abs(hE - hA) < 0.01 && hA < aA && Math.abs(aE - aA) >= 0.01) return 1; // home finished and behind
  if (Math.abs(aE - aA) < 0.01 && aA < hA && Math.abs(hE - hA) >= 0.01) return 99;
  const f = (s) => W.calibratedWinProbability({ homeExpected: hE, awayExpected: aE, homeActual: hA, awayActual: aA, stddev: s }) - cal;
  let lo = W.MIN_STDDEV, hi = W.DEFAULT_STDDEV, s;
  if (f(lo) * f(hi) > 0) s = Math.abs(f(lo)) < Math.abs(f(hi)) ? lo : hi;
  else { for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (f(lo) * f(m) <= 0) hi = m; else lo = m; } s = (lo + hi) / 2; }
  return W.winProbability(hE, aE, s);
}

function invNormal(p) { let lo = -9, hi = 9; for (let i = 0; i < 80; i++) { const m = (lo + hi) / 2; if (W.normalCdf(m) < p) lo = m; else hi = m; } return (lo + hi) / 2; }

async function fetchAll() {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from('snapshots')
      .select('id, league_id, year, week, matchup_id, team_id, is_home, ts, actual_score, expected_score, win_prob, win_prob_raw, all_starters_done')
      .order('id').range(from, from + 999);
    if (error) throw error;
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}

function recalibrate(rows, cutoff) {
  const games = new Map();
  for (const r of rows) { const k = [r.league_id, r.year, r.week, r.matchup_id].join('|'); if (!games.has(k)) games.set(k, []); games.get(k).push(r); }
  const updates = [], rawUpdates = [], stats = { rawFilled: 0, moments: 0, rows: 0, skippedNew: 0, finals: 0, locks: 0, recovered: 0, carried: 0, noOpponentYet: 0 };
  const oldOf = (r) => Number(r.win_prob_raw != null ? r.win_prob_raw : r.win_prob);
  for (const rs of games.values()) {
    // The poller only writes a team's row when its numbers change, so at any
    // moment the other team's state is its latest row so far (the same
    // pairing the site's charts use).
    const byTs = new Map();
    for (const r of rs) { if (!byTs.has(r.ts)) byTs.set(r.ts, []); byTs.get(r.ts).push(r); }
    let home = null, away = null, sigma = W.DEFAULT_STDDEV;
    for (const ts of [...byTs.keys()].sort()) {
      const now = byTs.get(ts);
      for (const r of now) { if (r.is_home) home = r; else away = r; }
      stats.moments++;
      if (!home || !away) { stats.noOpponentYet += now.length; continue; }
      const isNew = (r) => new Date(ts) >= cutoff && r.win_prob_raw == null;
      const fresh = now.filter((r) => !isNew(r));
      stats.skippedNew += now.length - fresh.length;
      // Rows already written by the calibrated poller but before it saved the
      // original number: work the original out from the calibrated one (find
      // the spread that gives the stored value, then apply the old formula),
      // so the "legacy win %" preference has it too.
      if (fresh.length < now.length && !(home.all_starters_done && away.all_starters_done)) {
        const hE0 = Number(home.expected_score), aE0 = Number(away.expected_score), hA0 = Number(home.actual_score), aA0 = Number(away.actual_score);
        const ref0 = now.find((r) => r.is_home) || now[0];
        const cal = ref0.is_home ? Number(ref0.win_prob) : 100 - Number(ref0.win_prob);
        const raw = legacyFromCalibrated(hE0, aE0, hA0, aA0, cal);
        for (const r of now.filter(isNew)) { stats.rawFilled++; rawUpdates.push({ id: r.id, raw: r.is_home ? raw : 100 - raw }); }
      }
      // the old home win % at this moment, from a row written now (its own stored value)
      const ref = now.find((r) => r.is_home) || now[0];
      const oldHome = ref.is_home ? oldOf(ref) : 100 - oldOf(ref);
      const hE = Number(home.expected_score), aE = Number(away.expected_score), hA = Number(home.actual_score), aA = Number(away.actual_score);
      if (home.all_starters_done && away.all_starters_done) { stats.finals += now.length; continue; }
      let wp;
      const homeLocked = Math.abs(hE - hA) < 0.01, awayLocked = Math.abs(aE - aA) < 0.01;
      if (oldHome === 99 && awayLocked && aA < hA) { stats.locks++; wp = W.matchupWinProbability({ homeExpected: hE, awayExpected: aE, homeActual: hA, awayActual: aA, allDone: false, homeAllDone: false, awayAllDone: true, stddev: Math.min(sigma, 4) }); }
      else if (oldHome === 1 && homeLocked && hA < aA) { stats.locks++; wp = W.matchupWinProbability({ homeExpected: hE, awayExpected: aE, homeActual: hA, awayActual: aA, allDone: false, homeAllDone: true, awayAllDone: false, stddev: Math.min(sigma, 4) }); }
      else {
        const gap = hE - aE;
        let s = null;
        if (oldHome > 0.5 && oldHome < 99.5 && Math.abs(gap) > 0.3) { const z = invNormal(oldHome / 100); if (Math.abs(z) > 0.02) s = gap / (Math.SQRT2 * z); }
        if (s && s >= W.MIN_STDDEV * 0.95 && s <= W.DEFAULT_STDDEV * 1.05) { sigma = Math.min(s, W.DEFAULT_STDDEV); stats.recovered++; } else stats.carried++;
        wp = W.calibratedWinProbability({ homeExpected: hE, awayExpected: aE, homeActual: hA, awayActual: aA, stddev: sigma });
      }
      for (const r of fresh) {
        stats.rows++;
        updates.push({ id: r.id, wp: r.is_home ? wp : 100 - wp, old: oldOf(r), ts, home: r.is_home ? home : away, away: r.is_home ? away : home, mirror: !r.is_home });
      }
    }
  }
  return { updates, rawUpdates, stats };
}

module.exports = { recalibrate };

if (require.main === module) (async () => {
  supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
  const cutoff = calibratedSince();
  console.log(`Rows from ${cutoff.toISOString()} on already use the calibrated model and are left alone.`);
  const rows = await fetchAll();
  console.log(`Read ${rows.length} snapshot rows.`);
  if (!rows.length || !('win_prob_raw' in rows[0])) throw new Error('snapshots.win_prob_raw is missing: run db/migrations/004_recalibrate_win_prob.sql first');
  const { updates, rawUpdates, stats } = recalibrate(rows, cutoff);
  console.log('Matchup moments:', stats);
  const changed = updates.filter((u) => Math.abs(u.wp - u.old) > 0.05);
  console.log(`${changed.length} rows would change (of ${updates.length} recalculated).`);
  const bands = [[50, 70], [70, 90], [90, 97], [97, 99.5], [99.5, 100.01]];
  const homeSide = updates.filter((u) => !u.mirror).map((u) => ({ o: Math.max(u.old, 100 - u.old), n: u.old >= 50 ? u.wp : 100 - u.wp }));
  for (const [lo, hi] of bands) { const b = homeSide.filter((x) => x.o >= lo && x.o < hi); if (b.length) console.log(`  old ${lo}-${hi}%: ${b.length} moments, now average ${(b.reduce((a, x) => a + x.n, 0) / b.length).toFixed(1)}% (was ${(b.reduce((a, x) => a + x.o, 0) / b.length).toFixed(1)}%)`); }
  const biggest = updates.filter((u) => !u.mirror).sort((a, b) => Math.abs(b.wp - b.old) - Math.abs(a.wp - a.old)).slice(0, 8);
  for (const u of biggest) console.log(`  e.g. wk${u.home.week} ${u.ts.slice(0, 16)} score ${Number(u.home.actual_score).toFixed(1)}-${Number(u.away.actual_score).toFixed(1)} expected ${Number(u.home.expected_score).toFixed(1)}-${Number(u.away.expected_score).toFixed(1)}: ${u.old.toFixed(1)}% -> ${u.wp.toFixed(1)}%`);
  if (!APPLY) { console.log('\nDry run only. Run again with "apply" to write these.'); return; }

  let done = 0;
  for (let i = 0; i < updates.length; i += 1000) {
    const batch = updates.slice(i, i + 1000).map((u) => ({ id: u.id, wp: Math.round(u.wp * 1e8) / 1e8 }));
    const { data, error } = await supabase.rpc('apply_calibrated_win_probs', { p_rows: batch });
    if (error) throw error;
    done += data || 0;
    if ((i / 1000) % 10 === 0) console.log(`  written ${done}`);
  }
  console.log(`Wrote ${done} rows.`);
  let rawDone = 0;
  for (let i = 0; i < rawUpdates.length; i += 1000) {
    const { data, error } = await supabase.rpc('set_raw_win_probs', { p_rows: rawUpdates.slice(i, i + 1000).map((u) => ({ id: u.id, wp: Math.round(u.raw * 1e8) / 1e8 })) });
    if (error) throw error;
    rawDone += data || 0;
  }
  if (rawUpdates.length) console.log(`Saved the original (legacy) win % on ${rawDone} newer rows.`);
  const { data: msg, error: e2 } = await supabase.rpc('sync_snapshot_summary_win_probs', { p_revert: false });
  if (e2) throw e2;
  console.log('Summary:', msg);
})().catch((e) => { console.error(e.message || e); process.exit(1); });
