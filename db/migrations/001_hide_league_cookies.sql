-- Hide the ESPN login cookies from the public site key.
--
-- schema.sql gives the public ("anon") key read access to every column of
-- `leagues`, including espn_s2 and swid. The anon key is in docs/config.js, so
-- anyone who opens the site can read those cookies straight from the API. This
-- limits the public key to the columns the site actually uses. The poller uses
-- the service_role key and is not affected.
--
-- Run once in the Supabase SQL editor. Safe to re-run.

revoke select, insert, update, delete on table public.leagues from anon, authenticated;

grant select (id, slug, name, espn_league_id, created_at, playoff_spots, reseed_weeks)
  on table public.leagues to anon, authenticated;

-- Settings page: playoff spots / reseed weeks only.
grant update (playoff_spots, reseed_weeks) on table public.leagues to anon, authenticated;
