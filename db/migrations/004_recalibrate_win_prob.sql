-- 004: recalibrate stored win probabilities (backfill support)
--
-- Run this once in the Supabase SQL editor, then start the
-- "Recalibrate win-probability history" workflow from GitHub Actions
-- (first as a dry run, then with "apply" checked).
--
-- What it adds:
--   * snapshots.win_prob_raw: the original (uncalibrated) win_prob, saved the
--     first time a row is recalibrated, so the change can always be undone
--     and the model can be refit from the raw numbers later.
--   * apply_calibrated_win_probs(rows): batch update used by the workflow.
--   * sync_snapshot_summary_win_probs(revert): brings snapshot_summary in line
--     afterwards. It checks what snapshot_summary is first: a plain view needs
--     nothing, a materialized view is refreshed, a table gets its win_prob and
--     pregame_win_prob copied over from the matching snapshot rows.
--   * revert_calibrated_win_probs(): puts every original value back.
--
-- None of these are callable from the public website key.

alter table public.snapshots add column if not exists win_prob_raw double precision;

-- rows: [{ "id": "<snapshot uuid>", "wp": 63.2 }, ...]
create or replace function public.apply_calibrated_win_probs(p_rows jsonb)
returns integer
language plpgsql
as $$
declare n integer;
begin
  update public.snapshots s
     set win_prob_raw = coalesce(s.win_prob_raw, s.win_prob),
         win_prob = (r->>'wp')::double precision
    from jsonb_array_elements(p_rows) r
   where s.id = (r->>'id')::uuid;
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function public.sync_snapshot_summary_win_probs(p_revert boolean default false)
returns text
language plpgsql
as $$
declare k "char";
begin
  select c.relkind into k
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'snapshot_summary';
  if k is null then return 'no snapshot_summary found'; end if;
  if k = 'v' then return 'snapshot_summary is a view: already up to date'; end if;
  if k = 'm' then
    execute 'refresh materialized view public.snapshot_summary';
    return 'snapshot_summary materialized view refreshed';
  end if;

  -- A plain table of copies: latest win_prob is a copy of the snapshot row
  -- with the same timestamp; pregame_win_prob is a copy of the team's
  -- earliest snapshot that week.
  execute $q$
    update public.snapshot_summary ss
       set win_prob = s.win_prob
      from public.snapshots s
     where s.league_id = ss.league_id and s.year = ss.year and s.week = ss.week
       and s.matchup_id = ss.matchup_id and s.team_id = ss.team_id and s.ts = ss.ts
       and s.win_prob is distinct from ss.win_prob
  $q$;
  execute format($q$
    with first_rows as (
      select distinct on (league_id, year, week, matchup_id, team_id)
             league_id, year, week, matchup_id, team_id, win_prob, win_prob_raw
        from public.snapshots
       order by league_id, year, week, matchup_id, team_id, ts
    )
    update public.snapshot_summary ss
       set pregame_win_prob = case when %1$L then f.win_prob_raw else f.win_prob end
      from first_rows f
     where f.league_id = ss.league_id and f.year = ss.year and f.week = ss.week
       and f.matchup_id = ss.matchup_id and f.team_id = ss.team_id
       and f.win_prob_raw is not null
       and ss.pregame_win_prob = case when %1$L then f.win_prob else f.win_prob_raw end
  $q$, p_revert);
  return 'snapshot_summary table updated';
end $$;

create or replace function public.revert_calibrated_win_probs()
returns text
language plpgsql
as $$
declare n integer; msg text;
begin
  msg := public.sync_snapshot_summary_win_probs(true); -- match pregame copies while both values still exist
  update public.snapshots set win_prob = win_prob_raw where win_prob_raw is not null and win_prob is distinct from win_prob_raw;
  get diagnostics n = row_count;
  perform public.sync_snapshot_summary_win_probs(false); -- copy the restored latest values
  return n || ' snapshots restored; ' || msg;
end $$;

revoke all on function public.apply_calibrated_win_probs(jsonb) from public, anon, authenticated;
revoke all on function public.sync_snapshot_summary_win_probs(boolean) from public, anon, authenticated;
revoke all on function public.revert_calibrated_win_probs() from public, anon, authenticated;
