import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const TRADER = 'b0000001-0000-0000-0000-000000000001';

function pad(s: unknown, n: number) { return String(s ?? '').padEnd(n).slice(0, n); }

async function main() {
  console.log('═══════════════════════════════════════════════════════════════════════════════');
  console.log(' AUDIT US BLOCKERS — TRADER après désactivation Asia+EU + secret SML=25 LRG=20');
  console.log('═══════════════════════════════════════════════════════════════════════════════\n');

  // 1. Full TRADER config DB
  const { data: cfg } = await sb.from('lisa_session_configs').select('*').eq('portfolio_id', TRADER).single();
  console.log('[1] CONFIG DB pertinentes pour US :');
  const keys = [
    'strategy_mode', 'autopilot_enabled', 'kill_switch_active', 'capital_usd', 'daily_cost_budget_usd',
    'gainers_universe_us', 'gainers_universe_eu', 'gainers_universe_asia', 'gainers_universe_crypto',
    'gainers_min_persistence_score', 'gainers_min_path_efficiency',
    'gainers_max_open_positions', 'gainers_max_per_cycle', 'gainers_position_pct',
    'gainers_cooldown_minutes', 'gainers_post_sl_cooldown_min',
    'gainers_default_tp_pct', 'gainers_default_sl_pct',
    'gainers_session_filter_enabled', 'gainers_force_close_before_close_enabled',
    'gainers_p_win_gate_enabled', 'gainers_min_p_win',
    'gainers_capital_rotation_enabled', 'gainers_high_grading_enabled',
    'gainers_hour_blacklist_US_UTC', 'gainers_min_path_efficiency_EU',
  ];
  for (const k of keys) {
    const v = (cfg as Record<string, unknown>)?.[k];
    console.log(`  ${pad(k, 50)} = ${JSON.stringify(v)}`);
  }

  // 2. US funnel last 24h
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  const usClasses = ['us_equity_large', 'us_equity_small_mid'];
  console.log('\n[2] FUNNEL US 24h (avant impact secret car le secret vient juste d\'être setté) :');
  for (const cls of usClasses) {
    const { data } = await sb.from('gainers_user_shadow_signals')
      .select('decision')
      .eq('asset_class', cls)
      .gte('created_at', since).limit(2000);
    const counts = new Map<string, number>();
    for (const r of data ?? []) counts.set(r.decision as string, (counts.get(r.decision as string) ?? 0) + 1);
    const total = [...counts.values()].reduce((s, n) => s + n, 0);
    console.log(`\n  ${cls} 24h : total=${total}`);
    for (const [d, n] of [...counts].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${pad(d, 35)} → ${pad(n, 4)} (${total > 0 ? ((n/total)*100).toFixed(0) : 0}%)`);
    }
  }

  // 3. Currently open positions TRADER
  const { data: open } = await sb.from('lisa_positions')
    .select('symbol, entry_timestamp, entry_price, take_profit_price, stop_loss_price, asset_class, source, venue_fee_detail')
    .eq('portfolio_id', TRADER).eq('status', 'open');
  console.log(`\n[3] TRADER positions ouvertes : ${open?.length}`);
  for (const p of open ?? []) {
    const src = String((p.venue_fee_detail as Record<string, unknown> | null)?.source ?? p.source ?? '?');
    const age = Math.round((Date.now() - new Date(String(p.entry_timestamp)).getTime()) / 60_000);
    console.log(`  ${p.symbol} (${p.asset_class}) entry=$${p.entry_price} TP=$${p.take_profit_price} SL=$${p.stop_loss_price} age=${age}min src=${src}`);
  }

  // 4. Anomalies last 6h
  const since6h = new Date(Date.now() - 6 * 3600_000).toISOString();
  const { data: anom } = await sb.from('lisa_decision_log')
    .select('timestamp, kind, summary')
    .eq('portfolio_id', TRADER)
    .in('kind', ['position_open_failed', 'autopilot_paused', 'kill_switch_triggered'])
    .gte('timestamp', since6h).order('timestamp', { ascending: false }).limit(20);
  console.log(`\n[4] ANOMALIES TRADER 6h : ${anom?.length}`);
  for (const a of (anom ?? []).slice(0, 8)) {
    console.log(`  ${String(a.timestamp).slice(0,16)} ${pad(a.kind, 25)} ${String(a.summary).slice(0, 70)}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
