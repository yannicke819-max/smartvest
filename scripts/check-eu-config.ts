import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const TRADER = 'b0000001-0000-0000-0000-000000000001';
async function main() {
  // Drill into EU dead_zone + other (unique symbols + heures)
  const since = new Date(Date.now() - 72*3600_000).toISOString();
  const { data } = await sb.from('gainers_user_shadow_signals')
    .select('decision, symbol, created_at')
    .eq('asset_class', 'eu_equity')
    .in('decision', ['reject_dead_zone', 'reject_other'])
    .gte('created_at', since)
    .limit(2000);

  const groups = new Map<string, { hours: Map<number, number>; symbols: Set<string> }>();
  for (const r of data ?? []) {
    const d = String(r.decision);
    if (!groups.has(d)) groups.set(d, { hours: new Map(), symbols: new Set() });
    const g = groups.get(d)!;
    g.symbols.add(String(r.symbol));
    const h = new Date(r.created_at as string).getUTCHours();
    g.hours.set(h, (g.hours.get(h) ?? 0) + 1);
  }
  for (const [d, g] of groups) {
    console.log(`\n${d} : ${g.symbols.size} symboles uniques, distribution par heure UTC :`);
    for (const [h, n] of [...g.hours].sort((a, b) => a[0] - b[0])) console.log(`  ${String(h).padStart(2, '0')}h UTC → ${n}`);
    console.log(`  Top 5 symboles : ${[...g.symbols].slice(0, 5).join(', ')}`);
  }

  // Check EU hour blacklist config
  const { data: cfg, error } = await sb.from('lisa_session_configs')
    .select('*')
    .eq('portfolio_id', TRADER).single();
  if (error) { console.log('Cfg error:', error); return; }
  console.log('\nTRADER hour blacklists / EU :');
  console.log(`  gainers_hour_blacklist_EU_UTC : ${cfg.gainers_hour_blacklist_EU_UTC}`);
  console.log(`  gainers_min_path_efficiency_EU : ${cfg.gainers_min_path_efficiency_EU}`);
  console.log(`  gainers_min_persistence_score : ${cfg.gainers_min_persistence_score}`);
  console.log(`  gainers_min_path_efficiency : ${cfg.gainers_min_path_efficiency}`);
  console.log(`  gainers_asset_class_filter_eu_equity : ${cfg.gainers_asset_class_filter_eu_equity}`);
  console.log(`  gainers_min_change_pct_eu_equity : ${cfg.gainers_min_change_pct_eu_equity}`);
}
main().catch(e => console.error(e));
