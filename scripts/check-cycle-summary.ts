import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL || '', process.env.SUPABASE_SERVICE_ROLE_KEY || '');
const PID = 'b0000001-0000-0000-0000-000000000001';

async function main() {
  const since = '2026-05-25T17:00:00Z';

  // lisa_mechanical_cycle_summary
  console.log('=== lisa_mechanical_cycle_summary 12h ===');
  const { data: cycles, count } = await sb.from('lisa_mechanical_cycle_summary')
    .select('*', { count: 'exact' })
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(5);
  console.log('Total:', count);
  for (const c of cycles ?? []) {
    console.log(JSON.stringify(c, null, 2).slice(0, 500));
    console.log('---');
  }

  // Tables proche du scanner
  console.log('\n=== top_gainers_log 12h ===');
  const { data: tgl, count: tglCount } = await sb.from('top_gainers_log')
    .select('*', { count: 'exact' })
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(3);
  console.log('Total:', tglCount);
  for (const t of tgl ?? []) console.log(JSON.stringify(t, null, 2).slice(0, 400));

  // Check qw_decision_log
  console.log('\n=== qw_decision_log 12h ===');
  const { data: qw, count: qwCount } = await sb.from('qw_decision_log')
    .select('*', { count: 'exact' })
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(10);
  console.log('Total:', qwCount);
  if (qw && qw.length > 0) {
    const byDecision: Record<string, number> = {};
    for (const q of qw) byDecision[q.decision] = (byDecision[q.decision] ?? 0) + 1;
    console.log('By decision:', byDecision);
    console.log('Sample:');
    for (const q of qw.slice(0, 5)) {
      console.log(`  ${q.created_at}  ${q.qw_id}  ${q.symbol}  ${q.decision}  ${q.reason}`);
    }
  }

  // Asset class of accepts
  console.log('\n=== Accept shadows 12h par classe ===');
  const { data: accepts } = await sb.from('gainers_user_shadow_signals')
    .select('symbol, asset_class, entry_price, change_pct_1m, path_eff, persistence_score, created_at')
    .eq('portfolio_id', PID)
    .eq('decision', 'accept')
    .gte('created_at', since)
    .order('created_at', { ascending: false });
  if (accepts) {
    console.log(`Total accepts: ${accepts.length}`);
    const byClass: Record<string, number> = {};
    for (const a of accepts) byClass[a.asset_class] = (byClass[a.asset_class] ?? 0) + 1;
    console.log('By class:', byClass);
    // Premier de chaque classe
    const seen = new Set<string>();
    for (const a of accepts) {
      if (!seen.has(a.asset_class)) {
        seen.add(a.asset_class);
        console.log(`  ${a.asset_class.padEnd(20)} ex: ${a.symbol}  change1m=${a.change_pct_1m} pathEff=${a.path_eff} entry=${a.entry_price}`);
      }
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
