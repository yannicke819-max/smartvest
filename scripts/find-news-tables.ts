import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
const env = fs.readFileSync('.env', 'utf8').split('\n').reduce((acc, l) => {
  const m = l.match(/^([A-Z_]+)=(.+)$/);
  if (m) acc[m[1]] = m[2];
  return acc;
}, {} as Record<string, string>);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  // Try all candidates
  const tables = [
    'news_events', 'news_articles', 'eodhd_news_items', 'lisa_news',
    'lisa_decision_log', 'gainers_persistence_log', 'top_gainers_log',
    'macro_snapshots', 'lisa_market_snapshots', 'mechanical_directives'
  ];
  for (const tbl of tables) {
    const { data, error, count } = await sb.from(tbl).select('*', { count: 'exact', head: true });
    if (error) { console.log(`  ${tbl} : ${error.message.slice(0, 80)}`); continue; }
    console.log(`  ${tbl} : ${count ?? 0} rows`);
  }
  // Now sample lisa_decision_log entries during the window
  console.log(`\n--- lisa_decision_log entries 08:00-14:30 UTC kind LIKE %news% or %macro% or %catalyst% ---`);
  const { data } = await sb
    .from('lisa_decision_log')
    .select('kind, payload, created_at')
    .gte('created_at', '2026-05-24T08:00:00Z')
    .lte('created_at', '2026-05-24T14:30:00Z')
    .or('kind.ilike.%news%,kind.ilike.%macro%,kind.ilike.%catalyst%,kind.ilike.%shock%,kind.ilike.%veto%')
    .limit(30)
    .order('created_at', { ascending: true });
  for (const r of (data ?? [])) {
    console.log(`  ${r.created_at.slice(11, 19)}  ${r.kind}  ${JSON.stringify(r.payload).slice(0, 150)}`);
  }

  // Daily catalyst brief?
  const { data: brief } = await sb.from('lisa_decision_log').select('kind, payload, created_at').eq('kind', 'daily_catalyst_brief').gte('created_at', '2026-05-24T00:00:00Z').limit(3);
  console.log(`\n--- daily_catalyst_brief today : ${brief?.length ?? 0} ---`);
  for (const r of (brief ?? [])) console.log(`  ${r.created_at.slice(11, 19)}  ${JSON.stringify(r.payload).slice(0, 500)}`);
}
main().catch(e => { console.error(e); process.exit(1); });
