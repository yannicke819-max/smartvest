import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  const TRADER = 'b0000001-0000-0000-0000-000000000001';
  const { data, count } = await sb.from('lisa_portfolio_snapshots').select('timestamp, total_value_usd', { count: 'exact' })
    .eq('portfolio_id', TRADER)
    .gte('timestamp', '2026-05-25T00:00:00Z')
    .order('timestamp', { ascending: true });
  console.log(`Total snapshots TRADER depuis 25/05 : ${count}`);
  // Print first + last + mid
  const arr = data ?? [];
  if (arr.length > 0) {
    console.log(`First : ${arr[0].timestamp} → $${arr[0].total_value_usd}`);
    console.log(`Last  : ${arr[arr.length-1].timestamp} → $${arr[arr.length-1].total_value_usd}`);
    console.log(`Gap entre first et last :`);
    const firstT = new Date(arr[0].timestamp).getTime();
    const lastT = new Date(arr[arr.length-1].timestamp).getTime();
    console.log(`  ${((lastT-firstT)/3600e3).toFixed(1)} heures`);
    
    // Check earliest snapshot date
    console.log(`\nDistribution par date:`);
    const byDate: Record<string, number> = {};
    for (const s of arr) {
      const d = s.timestamp?.slice(0,10);
      byDate[d] = (byDate[d] || 0) + 1;
    }
    for (const [d, n] of Object.entries(byDate)) console.log(`  ${d} : ${n} snapshots`);
  } else {
    console.log('Aucun snapshot trouvé !');
  }
}
main().catch(e => { console.error(e); process.exit(1); });
