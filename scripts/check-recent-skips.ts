import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  const TRADER = 'b0000001-0000-0000-0000-000000000001';
  const since = new Date(Date.now() - 30 * 60_000).toISOString();

  // All recent scanner_candidate_skip + position_open_failed with full payload
  const { data } = await sb
    .from('lisa_decision_log')
    .select('timestamp, kind, payload')
    .eq('portfolio_id', TRADER)
    .in('kind', ['scanner_candidate_skip', 'position_open_failed', 'skeptic_verdict'])
    .gte('timestamp', since)
    .order('timestamp', { ascending: false })
    .limit(20);
  console.log(`Recent TRADER skip/fail events (30min) : ${data?.length ?? 0}\n`);
  for (const e of data ?? []) {
    const p = e.payload as any;
    console.log(`${e.timestamp.slice(11,19)} ${e.kind}`);
    console.log(`  payload: ${JSON.stringify(p).slice(0, 300)}`);
    console.log('');
  }

  // Aussi : récents shadow signals SEULEMENT EU et US (les actifs pour TRADER)
  console.log('═══ Shadow signals EU + US 30min ═══\n');
  const { data: shadow } = await sb
    .from('gainers_user_shadow_signals')
    .select('created_at, symbol, asset_class, decision, entry_price')
    .in('asset_class', ['eu_equity', 'us_equity_large', 'us_equity_small_mid', 'crypto_major', 'crypto_alt'])
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(20);
  for (const s of shadow ?? []) {
    console.log(`${s.created_at.slice(11,19)} ${s.symbol.padEnd(14)} ${s.asset_class.padEnd(22)} ${s.decision.padEnd(28)} entry=$${Number(s.entry_price ?? 0).toFixed(2)}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
