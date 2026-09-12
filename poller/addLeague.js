// One-time (or as-needed) CLI to register a league in Supabase.
//
// Usage:
//   node addLeague.js <slug> "<name>" <espnLeagueId> <espn_s2> <SWID>
//
// Where to find espn_s2 / SWID: log into fantasy.espn.com in Chrome, open
// DevTools -> Application -> Cookies -> https://fantasy.espn.com, and copy
// the values of the "espn_s2" and "SWID" cookies (SWID includes the curly
// braces, keep them).

const { createClient } = require('@supabase/supabase-js');

const [, , slug, name, espnLeagueId, espnS2, swid] = process.argv;

if (!slug || !name || !espnLeagueId || !espnS2 || !swid) {
  console.error(
    'Usage: node addLeague.js <slug> "<name>" <espnLeagueId> <espn_s2> <SWID>'
  );
  process.exit(1);
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_KEY env vars first.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

async function main() {
  const { data, error } = await supabase
    .from('leagues')
    .upsert(
      {
        slug,
        name,
        espn_league_id: Number(espnLeagueId),
        espn_s2: espnS2,
        swid,
      },
      { onConflict: 'slug' }
    )
    .select()
    .single();

  if (error) throw error;
  console.log('League saved:', data);
}

main().catch((err) => {
  console.error('Failed to add league:', err.message);
  process.exit(1);
});
