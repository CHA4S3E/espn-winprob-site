# Fantasy Win Probability Tracker

A free, always-on tracker for ESPN fantasy football win probability, across
multiple private leagues, with archived weeks/seasons and per-team saved
colors. No server to keep running -- polling happens on a schedule via
GitHub Actions, data lives in Supabase, and the site itself is a static page.

**Cost: $0/month** (see the tradeoffs section below).

## How it works

```
GitHub Actions (cron, every 5 min)
        |
        v
  poller/poll.js  --  pulls ESPN fantasy + NFL scoreboard data,
        |              computes win probability, writes to Supabase
        v
   Supabase (Postgres)  --  leagues, teams, team_settings, snapshots
        |
        v
   public/*.html  --  static site, reads Supabase directly via anon key,
                       renders the win-probability chart
```

## 1. Create a Supabase project

1. Go to https://supabase.com, create a free project.
2. In the SQL editor, run everything in `db/schema.sql`.
3. Under Project Settings -> API, copy:
   - Project URL
   - `anon` public key (safe for client-side use)
   - `service_role` key (SECRET -- server/CI only, never in the frontend)

## 2. Add your leagues

You need each league's `espn_s2` and `SWID` cookies (private leagues only):

1. Log into fantasy.espn.com in Chrome, open your league.
2. DevTools -> Application tab -> Cookies -> `https://fantasy.espn.com`.
3. Copy the values of `espn_s2` and `SWID` (keep the curly braces on SWID).
4. Your league ID is the number in the URL, e.g. `.../leagueId=123456...` -> `123456`.

Run locally (needs Node 18+):

```bash
cd poller
npm install
export SUPABASE_URL="https://YOUR-PROJECT-REF.supabase.co"
export SUPABASE_SERVICE_KEY="your-service-role-key"
node addLeague.js league1 "My League Name" 123456 <espn_s2> <SWID>
node addLeague.js league2 "Other League Name" 654321 <espn_s2> <SWID>
```

This writes straight to Supabase -- credentials never touch git.

## 3. Set up the GitHub Actions poller

1. Push this repo to GitHub (public or private both work).
2. Repo Settings -> Secrets and variables -> Actions -> New repository secret:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_KEY`
3. That's it -- `.github/workflows/poll.yml` runs every 5 minutes automatically.
   You can also trigger a run manually from the Actions tab (`workflow_dispatch`)
   to test immediately instead of waiting for the next scheduled tick.

## 4. Configure and deploy the frontend

1. Edit `public/config.js` with your Supabase Project URL and `anon` key.
2. Deploy the `public/` folder as a static site -- GitHub Pages, Netlify, or
   Vercel's static hosting all work and don't sleep. Easiest for a GitHub
   repo: enable GitHub Pages pointed at the `public/` folder (or `/docs` if
   you rename it) in repo Settings -> Pages.
3. Open the site, pick a league/year/week, and the first matchups will show
   up as soon as the poller has run at least once for that week.
4. Visit `settings.html` to set each team's color and display name -- saved
   once per team, reused automatically on every week's chart from then on.

## Notes & tradeoffs (read before game day)

- **Polling interval**: every 5 minutes, GitHub Actions' shortest supported
  cron interval. Runs can lag further (10-15+ min) during high platform load,
  which tends to coincide with Sunday 1pm kickoffs. Fine for a smooth
  win-probability curve; not built for second-by-second swings.
- **Supabase free tier pauses after 7 days with zero database activity.**
  Your own poller writing every 5 minutes during the season keeps it awake
  automatically. Off-season, it may pause -- unpausing takes about 30
  seconds on first visit, no data is lost.
- **A matchup is "done"** once every starter on both rosters has a real NFL
  game marked final -- there's no ambiguous "estimate" phase, every charted
  point is a real polled value.
- **Chart model**: per-player locked-in (game over -> actual only) vs.
  in-progress (max of actual/projection), summed per team, fed into a normal
  approximation with variance that shrinks as fewer starters remain live.
  See `poller/lib/winProb.js` -- fully unit-tested (`node lib/winProb.test.js`)
  including the corrected `normalCdf` sign behavior.
- **Scaling up later**: if 5-minute polling ever feels too coarse, move only
  `poller/poll.js` to an always-on host (Railway, Render, a small VPS) running
  its own `setInterval` loop instead of GitHub Actions cron -- no other code
  changes needed, since it already reads/writes the same Supabase tables.
