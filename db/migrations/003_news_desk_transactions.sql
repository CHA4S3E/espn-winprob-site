-- News Desk transaction wire. Run once in the Supabase SQL editor. Safe to re-run.
--
-- One row per executed ESPN transaction (waiver claim, free-agent pickup,
-- drop, trade), written by the poller. items holds each player moved:
-- [{ player_id, type: ADD|DROP|TRADE, from_team_id, to_team_id, name, pos, pro }]
-- Readable with the public key (nothing secret in it), writable only by the
-- poller's service_role key.

create table if not exists public.transactions (
  id         bigserial primary key,
  league_id  uuid    not null references public.leagues(id) on delete cascade,
  year       integer not null,
  week       integer not null,
  espn_id    text    not null,
  ts         timestamptz not null,
  kind       text    not null,          -- waiver | free_agent | trade
  team_id    uuid references public.teams(id) on delete set null,
  items      jsonb   not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  unique (league_id, espn_id)
);

create index if not exists idx_transactions_recent on public.transactions (league_id, ts desc);

alter table public.transactions enable row level security;
drop policy if exists "public read transactions" on public.transactions;
create policy "public read transactions" on public.transactions for select using (true);

revoke insert, update, delete on public.transactions from anon, authenticated;
grant select on public.transactions to anon, authenticated;
