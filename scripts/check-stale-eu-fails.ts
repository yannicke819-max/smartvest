import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  const TRADER = 'b0000001-0000-0000-0000-000000000001';
  const since24h = new Date(Date.now() - 24 * 3600_000).toISOString();
  const { data } = await sb
    .from('lisa_decision_log')
    .select('timestamp, payload')
    .eq('portfolio_id', TRADER)
    .eq('kind', 'position_open_failed')
    .gte('timestamp', since24h)
    .order('timestamp', { ascending: false });
  console.log(`StaleOrFallback EU 24h timestamps + payloads:\n`);
  let euStaleCount = 0;
  for (const f of data ?? []) {
    const p = f.payload as any;
    if (p?.asset_class !== 'eu_equity') continue;
    if (p?.error_class !== 'StaleOrFallbackSource') continue;
    euStaleCount++;
    console.log(`  ${f.timestamp.slice(0,19)} ${p?.symbol?.padEnd(14)} source=${p?.source} stage=${p?.stage} price=${p?.price}`);
  }
  console.log(`\nTotal EU StaleOrFallback : ${euStaleCount}`);
  console.log(`\nMost recent : ${data?.find(f => (f.payload as any)?.error_class === 'StaleOrFallbackSource' && (f.payload as any)?.asset_class === 'eu_equity')?.timestamp ?? 'n/a'}`);

  // TopTickDriftGuard EU
  console.log(`\n\nTopTickDriftGuard EU 24h:\n`);
  let driftCount = 0;
  for (const f of data ?? []) {
    const p = f.payload as any;
    if (p?.asset_class !== 'eu_equity') continue;
    if (p?.error_class !== 'TopTickDriftGuard') continue;
    driftCount++;
    console.log(`  ${f.timestamp.slice(0,19)} ${p?.symbol?.padEnd(14)} drift=${Number(p?.drift_pct ?? 0).toFixed(2)}% cand_close=$${p?.cand_close} live=$${p?.live_price}`);
  }
  console.log(`\nTotal EU TopTickDrift : ${driftCount}`);
}
main().catch(e => { console.error(e); process.exit(1); });
