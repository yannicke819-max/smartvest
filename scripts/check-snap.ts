import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
async function main() {
  // dump 1 row pour voir colonnes
  const { data: one } = await sb.from('lisa_portfolio_snapshots').select('*').limit(1);
  console.log('cols:', Object.keys(one?.[0] ?? {}));
  
  const tsCol = Object.keys(one?.[0] ?? {}).find(k => k.includes('_at') || k.includes('timestamp') || k.includes('date')) ?? 'created_at';
  console.log('using ts col:', tsCol);
  
  const { data } = await sb.from('lisa_portfolio_snapshots').select('*').order(tsCol, { ascending: false }).limit(10);
  console.log(`\nDerniers 10 snapshots (all PF):`);
  for (const r of data ?? []) console.log(`  ${r[tsCol]}  pf=${(r.portfolio_id ?? '').slice(0,12)}...  eq=$${r.equity_usd ?? r.total_value_usd ?? r.value}`);
  
  for (const pf of ['b0000001-0000-0000-0000-000000000001','a0000001-0000-0000-0000-000000000001','a0000002-0000-0000-0000-000000000002','a0000003-0000-0000-0000-000000000003']) {
    const { data: last } = await sb.from('lisa_portfolio_snapshots').select('*').eq('portfolio_id', pf).order(tsCol, { ascending: false }).limit(1);
    console.log(`PF ${pf.slice(0,12)}... dernier: ${last?.[0]?.[tsCol] ?? 'aucun'}`);
  }
}
main();
