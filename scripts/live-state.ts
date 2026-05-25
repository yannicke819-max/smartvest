import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL || '', process.env.SUPABASE_SERVICE_ROLE_KEY || '');

async function main() {
  const since = new Date(Date.now() - 4 * 3600_000).toISOString();
  const { data: shadow, count } = await sb
    .from('gainers_user_shadow_signals')
    .select('decision', { count: 'exact', head: false })
    .gte('created_at', since);
  const byDecision: Record<string, number> = {};
  for (const r of shadow ?? []) byDecision[r.decision] = (byDecision[r.decision] ?? 0) + 1;
  console.log(`SHADOW SIGNALS (4h) : ${count}`);
  for (const [d, n] of Object.entries(byDecision).sort((a, b) => b[1] - a[1])) console.log(`  ${d.padEnd(25)} ${n}`);

  const { data: lastAccept } = await sb
    .from('gainers_user_shadow_signals').select('symbol, created_at')
    .eq('decision', 'accept').order('created_at', { ascending: false }).limit(3);
  console.log('Last 3 accepts:');
  for (const r of lastAccept ?? []) console.log(`  ${r.created_at}  ${r.symbol}`);

  const { count: openCount } = await sb.from('paper_trades').select('*', { count: 'exact', head: true }).eq('status', 'open');
  console.log(`\nPaper_trades OPEN now : ${openCount}`);

  const { data: recentOpens } = await sb
    .from('paper_trades').select('symbol, opened_at, asset_class')
    .eq('status', 'open').order('opened_at', { ascending: false }).limit(5);
  console.log('Last 5 opens:');
  for (const r of recentOpens ?? []) console.log(`  ${r.opened_at}  ${r.symbol} (${r.asset_class})`);
}
main();
