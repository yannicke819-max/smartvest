import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
async function main() {
  // Trouver le snapshot le plus proche de 04/06 16:27 pour les 4 portfolios
  for (const pf of ['b0000001-0000-0000-0000-000000000001','a0000001-0000-0000-0000-000000000001']) {
    console.log(`\n=== ${pf.slice(0,12)} snapshots autour 04/06 16:27 ===`);
    const { data } = await sb.from('lisa_portfolio_snapshots')
      .select('timestamp, total_value_usd, open_positions_count')
      .eq('portfolio_id', pf)
      .gte('timestamp','2026-06-04T16:00:00Z')
      .lte('timestamp','2026-06-04T17:00:00Z')
      .order('timestamp', { ascending: true });
    console.log(`Snapshots 04/06 16:00-17:00 = ${data?.length ?? 0}`);
    for (const s of data ?? []) console.log(`  ${s.timestamp.slice(11,19)} val=$${s.total_value_usd}`);
    
    // GAP : checker qu'il y en a après 04/06 16:30 jusqu'à maintenant
    const { data: after } = await sb.from('lisa_portfolio_snapshots')
      .select('timestamp')
      .eq('portfolio_id', pf)
      .gte('timestamp','2026-06-04T16:30:00Z')
      .lt('timestamp','2026-06-05T00:00:00Z')
      .order('timestamp', { ascending: true });
    console.log(`Snapshots entre 04/06 16:30 et minuit = ${after?.length ?? 0}`);
    if (after && after.length > 0) {
      console.log(`  premier après 16:30 = ${after[0].timestamp}`);
      console.log(`  dernier avant 24:00 = ${after[after.length-1].timestamp}`);
    }
  }
}
main().catch(console.error);
