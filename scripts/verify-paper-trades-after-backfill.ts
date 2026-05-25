import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL || '', process.env.SUPABASE_SERVICE_ROLE_KEY || '');
async function main() {
  const { data: all, count } = await sb.from('paper_trades').select('status', { count: 'exact' });
  console.log('Total rows:', count);
  const byStatus: Record<string, number> = {};
  for (const r of all ?? []) byStatus[r.status ?? '(null)'] = (byStatus[r.status ?? '(null)'] ?? 0) + 1;
  for (const [s, n] of Object.entries(byStatus).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${s.padEnd(20)} ${n}`);
  }
}
main();
