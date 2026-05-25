import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL || '', process.env.SUPABASE_SERVICE_ROLE_KEY || '');
const PID = '58439d86-3f20-4a60-82a4-307f3f252bc2';

async function main() {
  const since = new Date(Date.now() - 4 * 3600_000).toISOString();
  // lisa_positions opened in last 4h
  const { data: lp } = await sb
    .from('lisa_positions').select('id, symbol, opened_at, status, closed_at')
    .eq('portfolio_id', PID)
    .gte('opened_at', since)
    .order('opened_at', { ascending: false });
  console.log(`lisa_positions opened in 4h: ${lp?.length ?? 0}`);
  for (const r of lp ?? []) console.log(`  ${r.opened_at}  ${r.symbol.padEnd(15)} status=${r.status} closed=${r.closed_at ?? '-'}`);

  // decision_log for debate gate / scanner around TLO.TO
  const { data: log } = await sb
    .from('lisa_decision_log')
    .select('timestamp, kind, summary')
    .eq('portfolio_id', PID)
    .gte('timestamp', since)
    .ilike('summary', '%TLO%')
    .order('timestamp', { ascending: false })
    .limit(20);
  console.log(`\ndecision_log mentions TLO (4h): ${log?.length ?? 0}`);
  for (const r of log ?? []) console.log(`  ${r.timestamp}  ${r.kind.padEnd(28)}  ${r.summary?.slice(0, 80)}`);

  // Any cycle skip reasons last 4h
  const { data: skips } = await sb
    .from('lisa_decision_log')
    .select('timestamp, kind, summary')
    .eq('portfolio_id', PID)
    .gte('timestamp', since)
    .in('kind', ['autopilot_cycle_completed', 'autopilot_paused', 'no_open_attempt', 'budget_cap_reached', 'position_cap_reached'])
    .order('timestamp', { ascending: false })
    .limit(10);
  console.log(`\nrecent cycle events: ${skips?.length ?? 0}`);
  for (const r of skips ?? []) console.log(`  ${r.timestamp}  ${r.kind.padEnd(28)}  ${r.summary?.slice(0, 80)}`);

  // Total open paper_trades vs lisa_positions
  const { count: ptOpen } = await sb.from('paper_trades').select('*', { count: 'exact', head: true }).eq('status', 'open').eq('portfolio_id', PID);
  const { count: lpOpen } = await sb.from('lisa_positions').select('*', { count: 'exact', head: true }).eq('status', 'open').eq('portfolio_id', PID);
  console.log(`\npaper_trades open : ${ptOpen}`);
  console.log(`lisa_positions open : ${lpOpen}`);
}
main();
