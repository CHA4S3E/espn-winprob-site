-- ESPN Fantasy Win Probability Tracker -- Supabase schema
-- Run this once in the Supabase SQL editor for your project.

create extension if not exists "pgcrypto";

-- One row per fantasy league you track (supports multiple leagues)
create table if not exists leagues (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,          -- short id used in the URL, e.g. "league1"
  name text not null,
  espn_league_id bigint not null,
  espn_s2 text not null,              -- private league auth cookie
  swid text not null,                 -- private league auth cookie
  created_at timestamptz not null default now()
);

-- One row per fantasy team per league (stable across weeks/seasons)
create table if not exists teams (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null references leagues(id) on delete cascade,
  espn_team_id integer not null,
  espn_team_name text not null,       -- name as ESPN reports it (may change)
  unique (league_id, espn_team_id)
);

-- User-customized display settings per team -- set once, reused every week
create table if not exists team_settings (
  team_id uuid primary key references teams(id) on delete cascade,
  color text not null default '#1a3fa0',
  display_name text,                  -- overrides espn_team_name if set
  updated_at timestamptz not null default now()
);

-- One row per team per poll, per matchup -- the time-series data the chart reads
create table if not exists snapshots (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null references leagues(id) on delete cascade,
  year integer not null,
  week integer not null,
  matchup_id integer not null,        -- ESPN's matchup id within that week
  team_id uuid not null references teams(id) on delete cascade,
  is_home boolean not null,
  ts timestamptz not null default now(),
  actual_score numeric not null,
  expected_score numeric not null,    -- locked-in + remaining model output
  win_prob numeric not null,          -- 0-100, this team's win probability
  all_starters_done boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists idx_snapshots_lookup
  on snapshots (league_id, year, week, matchup_id, ts);

create index if not exists idx_teams_league on teams (league_id);

-- Row Level Security: this app has no user accounts, so we allow the anon
-- key to read everything and write only to team_settings (for the color/name
-- picker). Snapshots and league credentials are written only by the poller,
-- which uses the service_role key and bypasses RLS entirely.
alter table leagues enable row level security;
alter table teams enable row level security;
alter table team_settings enable row level security;
alter table snapshots enable row level security;

-- Public read access (no credentials exposed -- espn_s2/swid columns are
-- simply never selected by the frontend's queries)
create policy "public read leagues" on leagues for select using (true);
create policy "public read teams" on teams for select using (true);
create policy "public read team_settings" on team_settings for select using (true);
create policy "public read snapshots" on snapshots for select using (true);

-- Anyone with the site link can set a team's color/name (fine for a
-- small private-league tool with no login; tighten later if needed)
create policy "public upsert team_settings" on team_settings
  for insert with check (true);
create policy "public update team_settings" on team_settings
  for update using (true);
