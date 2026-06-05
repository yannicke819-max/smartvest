import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  const TRADER = 'b0000001-0000-0000-0000-000000000001';
  const since = new Date(Date.now() - 60 * 60_000).toISOString();
  console.log(`\n═══ Now: ${new Date().toISOString().slice(11,19)} UTC ═══\n`);

  // 1. scanner_proposals 60min
  const { data: proposals, error: err1 } = await sb
    .from('scanner_proposals')
    .select('symbol, asset_class, direction, score, change_pct, notional_usd_suggested, created_at, expires_at')
    .eq('portfolio_id', TRADER)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(20);
  if (err1) console.log('scanner_proposals err:', err1.message);
  console.log(`scanner_proposals 60min: ${proposals?.length ?? 0}`);
  for (const p of proposals?.slice(0, 10) ?? []) {
    console.log(`  ${p.created_at.slice(11,19)} ${p.symbol.padEnd(14)} ${p.asset_class.padEnd(20)} ${p.direction} score=${p.score} change=${Number(p.change_pct ?? 0).toFixed(2)}% notional=$${Number(p.notional_usd_suggested ?? 0).toFixed(0)}`);
  }

  // 2. trader_agent_decisions 60min
  const { data: decisions, error: err2 } = await sb
    .from('trader_agent_decisions')
    .select('*')
    .eq('portfolio_id', TRADER)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(10);
  if (err2) console.log('\ntrader_agent_decisions err:', err2.message);
  else {
    console.log(`\ntrader_agent_decisions 60min: ${decisions?.length ?? 0}`);
    for (const d of decisions?.slice(0, 5) ?? []) {
      console.log(`  ${d.created_at?.slice(11,19)} cols: ${Object.keys(d).slice(0,8).join(', ')}`);
      console.log(`    sample: ${JSON.stringify(d).slice(0, 300)}`);
    }
  }

  // 3. Check TRADER_ARBITRATION_ENABLED — via /admin/config-dump si possible (besoin ADMIN_TOKEN)
  console.log('\n═══ Indices supplémentaires ═══');
  // Check si scanner_proposals existe et est utilisée
  const { count } = await sb
    .from('scanner_proposals')
    .select('*', { count: 'exact', head: true })
    .eq('portfolio_id', TRADER);
  console.log(`Total scanner_proposals TRADER all time: ${count ?? 0}`);
}
main().catch(e => { console.error(e); process.exit(1); });
