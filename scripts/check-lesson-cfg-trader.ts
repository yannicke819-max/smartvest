import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  const PORT: Record<string, string> = {
    'b0000001-0000-0000-0000-000000000001': 'TRADER',
    'a0000001-0000-0000-0000-000000000001': 'HIGH',
    'a0000002-0000-0000-0000-000000000002': 'MIDDLE',
    'a0000003-0000-0000-0000-000000000003': 'SMALL',
  };

  const { data } = await sb.from('lisa_session_configs')
    .select('portfolio_id, gainers_trailing_stop_breakeven_min_drawdown_pct, gainers_choppy_exit_after_min, gainers_choppy_min_monotonicity, gainers_let_run_if_monotonic_threshold, gainers_let_run_max_drawdown_pct, gainers_trailing_tp_multiplier_monotonic, gainers_trailing_min_age_minutes_asia, news_shock_close_max_age_minutes_lse, news_shock_close_sentiment_threshold_lse')
    .in('portfolio_id', Object.keys(PORT));
  console.log('═══ Lesson-driven config columns par portfolio ═══\n');
  console.log('Col                                            | TRADER | HIGH | MIDDLE | SMALL');
  console.log('-----------------------------------------------|--------|------|--------|------');
  if (!data) return;
  const byPid: Record<string, any> = {};
  for (const c of data) byPid[c.portfolio_id] = c;
  const order = ['b0000001-0000-0000-0000-000000000001', 'a0000001-0000-0000-0000-000000000001', 'a0000002-0000-0000-0000-000000000002', 'a0000003-0000-0000-0000-000000000003'];
  const keys = ['gainers_trailing_stop_breakeven_min_drawdown_pct', 'gainers_choppy_exit_after_min', 'gainers_choppy_min_monotonicity', 'gainers_let_run_if_monotonic_threshold', 'gainers_let_run_max_drawdown_pct', 'gainers_trailing_tp_multiplier_monotonic', 'gainers_trailing_min_age_minutes_asia', 'news_shock_close_max_age_minutes_lse', 'news_shock_close_sentiment_threshold_lse'];
  for (const k of keys) {
    const vals = order.map(pid => byPid[pid]?.[k]);
    const fmt = (v: any) => v === null || v === undefined ? 'null' : String(v);
    console.log(`${k.padEnd(46)} | ${fmt(vals[0]).padStart(6)} | ${fmt(vals[1]).padStart(4)} | ${fmt(vals[2]).padStart(6)} | ${fmt(vals[3])}`);
  }

  // Aussi : lessons appliquées historique
  console.log('\n═══ Lessons appliquées par auto-apply (audit log si dispo) ═══');
  const { data: applied } = await sb.from('scanner_lessons').select('id, macro_condition, lesson_kind, scope, applied, applied_at, proposed_config_change').eq('applied', true).order('applied_at', { ascending: false, nullsFirst: false }).limit(15);
  for (const l of applied ?? []) {
    console.log(`  ${l.applied_at?.slice(0,16)?.replace('T',' ')} ${l.id?.slice(0,8)} [${l.lesson_kind}] scope=${l.scope} ${l.macro_condition}`);
    if (l.proposed_config_change) console.log(`    change: ${JSON.stringify(l.proposed_config_change).slice(0,160)}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
