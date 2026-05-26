import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL || '', process.env.SUPABASE_SERVICE_ROLE_KEY || '');

async function main() {
  const since = '2026-05-25T17:00:00Z';
  // All events all portfolios 12h
  const { data: events, count } = await sb.from('lisa_decision_log')
    .select('kind, portfolio_id, timestamp', { count: 'exact' })
    .gte('timestamp', since)
    .order('timestamp', { ascending: false })
    .limit(2000);
  console.log('Total events all portfolios 12h:', count);
  const byKind: Record<string, number> = {};
  for (const e of events ?? []) byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
  for (const [k, n] of Object.entries(byKind).sort((a, b) => b[1] - a[1]).slice(0, 30)) {
    console.log('  ' + k.padEnd(45), n);
  }

  console.log('\nGate-related kinds search via ILIKE:');
  const patterns = ['%debate%', '%conviction%', '%momentum%', '%stale%', '%supertrend%', '%open_failed%', '%macro%', '%sanity%', '%sl_atr%', '%liquidity%', '%buffer%', '%cap%', '%twelvedata%', '%scanner%', '%skip%', '%accept%'];
  for (const p of patterns) {
    const { count } = await sb.from('lisa_decision_log').select('*', { count: 'exact', head: true }).gte('timestamp', since).ilike('kind', p);
    if (count && count > 0) console.log(`  ${p}: ${count}`);
  }

  // paper_trades created last 12h ?
  console.log('\npaper_trades activity 12h:');
  const { count: ptAll } = await sb.from('paper_trades').select('*', { count: 'exact', head: true }).gte('created_at', since);
  const { count: ptOpen } = await sb.from('paper_trades').select('*', { count: 'exact', head: true }).gte('created_at', since).eq('status', 'open');
  const { count: ptClosed } = await sb.from('paper_trades').select('*', { count: 'exact', head: true }).gte('created_at', since).eq('status', 'closed');
  const { count: ptCancelled } = await sb.from('paper_trades').select('*', { count: 'exact', head: true }).gte('created_at', since).eq('status', 'cancelled');
  console.log(`  Total created: ${ptAll}  | open=${ptOpen}  closed=${ptClosed}  cancelled=${ptCancelled}`);

  // lisa_positions activity
  console.log('\nlisa_positions activity 12h:');
  const { count: lpAll } = await sb.from('lisa_positions').select('*', { count: 'exact', head: true }).gte('opened_at', since);
  console.log(`  Total opened since ${since}: ${lpAll}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
