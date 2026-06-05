import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
async function main() {
  // 04/06 16:27 — proche cette heure : qui a un trade close
  for (const pf of ['b0000001-0000-0000-0000-000000000001','a0000001-0000-0000-0000-000000000001']) {
    console.log(`\n=== ${pf.slice(0,12)}... ===`);
    const { data } = await sb.from('lisa_positions')
      .select('symbol, entry_timestamp, exit_timestamp, status, realized_pnl_usd')
      .eq('portfolio_id', pf)
      .neq('status','open')
      .gte('exit_timestamp','2026-06-04T16:00:00Z')
      .lte('exit_timestamp','2026-06-04T17:00:00Z')
      .order('exit_timestamp', { ascending: true });
    console.log(`Closes 04/06 16:00-17:00 : ${data?.length ?? 0}`);
    for (const p of data ?? []) console.log(`  ${p.exit_timestamp.slice(11,19)} ${p.symbol.padEnd(14)} pnl=$${p.realized_pnl_usd}`);
    
    // Closes APRES 04/06 17:00 jusqu'à maintenant
    const { data: after } = await sb.from('lisa_positions')
      .select('symbol, exit_timestamp, realized_pnl_usd')
      .eq('portfolio_id', pf).neq('status','open')
      .gt('exit_timestamp','2026-06-04T17:00:00Z')
      .order('exit_timestamp', { ascending: true });
    console.log(`Closes APRES 04/06 17:00 : ${after?.length ?? 0}`);
    if (after && after.length > 0) {
      console.log(`  premier après = ${after[0].exit_timestamp.slice(0,16)}  ${after[0].symbol}  pnl=$${after[0].realized_pnl_usd}`);
      console.log(`  dernier = ${after[after.length-1].exit_timestamp.slice(0,16)}  ${after[after.length-1].symbol}`);
    }
  }
}
main().catch(console.error);
