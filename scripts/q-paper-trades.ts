import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL || '', process.env.SUPABASE_SERVICE_ROLE_KEY || '');
async function main() {
  const { data, count } = await sb
    .from('paper_trades')
    .select('portfolio_id, status', { count: 'exact' })
    .eq('status', 'open');
  console.log('TOTAL open across all portfolios:', count);
  const byPid: Record<string, number> = {};
  for (const r of data ?? []) byPid[r.portfolio_id] = (byPid[r.portfolio_id] ?? 0) + 1;
  for (const [pid, n] of Object.entries(byPid)) console.log(`  ${pid} : ${n}`);

  const { data: all, count: allCount } = await sb.from('paper_trades').select('status', { count: 'exact' });
  console.log('\nTotal rows:', allCount);
  const byStatus: Record<string, number> = {};
  for (const r of all ?? []) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  console.log('Status distribution :');
  for (const [s, n] of Object.entries(byStatus)) console.log(`  ${s ?? '(null)'} : ${n}`);
}
main();
