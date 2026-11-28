-- News Desk player data. Run once in the Supabase SQL editor. Safe to re-run.
--
-- lineups:        the latest per-player summary for each team, each week
--                 (written by the poller every run, one row per team).
-- player_events:  what changed between polls -- touchdowns, turnovers,
--                 yardage milestones, big days, duds -- read by docs/desk.html.
--
-- Both are readable with the public key (no secrets in them) and writable only
-- by the poller's service_role key.

create table if not exists public.lineups (
  league_id  uuid    not null references public.leagues(id) on delete cascade,
  year       integer not null,
  week       integer not null,
  team_id    uuid    not null references public.teams(id) on delete cascade,
  players    jsonb   not null,
  updated_at timestamptz not null default now(),
  primary key (league_id, year, week, team_id)
);

create table if not exists public.player_events (
  id          bigserial primary key,
  league_id   uuid    not null references public.leagues(id) on delete cascade,
  year        integer not null,
  week        integer not null,
  team_id     uuid    not null references public.teams(id) on delete cascade,
  ts          timestamptz not null default now(),
  player_id   bigint,
  player_name text,
  position    text,
  pro_team    text,
  kind        text    not null,
  points      numeric,
  delta       numeric,
  detail      jsonb   not null default '{}'::jsonb
);

create index if not exists idx_player_events_lookup on public.player_events (league_id, year, week, ts);

alter table public.lineups enable row level security;
alter table public.player_events enable row level security;

drop policy if exists "public read lineups" on public.lineups;
create policy "public read lineups" on public.lineups for select using (true);
drop policy if exists "public read player_events" on public.player_events;
create policy "public read player_events" on public.player_events for select using (true);

revoke insert, update, delete on public.lineups, public.player_events from anon, authenticated;
grant select on public.lineups, public.player_events to anon, authenticated;
