import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const PORT: Record<string, string> = {
  '58439d86-3f20-4a60-82a4-307f3f252bc2': 'MAIN/TRADER',
  'a0000001-0000-0000-0000-000000000001': 'HIGH',
  'a0000002-0000-0000-0000-000000000002': 'MIDDLE',
  'a0000003-0000-0000-0000-000000000003': 'SMALL',
};

async function main() {
  const windowStart = '2026-06-01T02:20:00Z';
  const windowEnd = '2026-06-01T02:35:00Z';

  // 1. lisa_session_configs — compare conviction thresholds & cooldowns par portfolio
  console.log('═══ 1. Config par portfolio (les 4) ═══');
  const { data: cfgs } = await sb.from('lisa_session_configs').select('portfolio_id, strategy_mode, autopilot_enabled, kill_switch_active, autopilot_paused_reason, gainers_default_sl_pct, gainers_default_tp_pct, gainers_min_persistence_score, gainers_min_path_efficiency, gainers_cycle_minutes, max_open_positions, max_exposure_per_asset_class_pct, ticker_cooldown_min, capital_usd, profile');
  for (const c of (cfgs ?? []).filter(c => PORT[c.portfolio_id as string])) {
    const p = PORT[c.portfolio_id as string];
    console.log(`\n${p}:`);
    console.log(`  mode=${c.strategy_mode}  autopilot=${c.autopilot_enabled}  ks=${c.kill_switch_active}  paused=${c.autopilot_paused_reason ?? 'no'}`);
    console.log(`  capital=$${c.capital_usd}  profile=${c.profile}`);
    console.log(`  SL=${c.gainers_default_sl_pct}%  TP=${c.gainers_default_tp_pct}%  cycle=${c.gainers_cycle_minutes}min`);
    console.log(`  max_open=${c.max_open_positions}  cap_per_class=${c.max_exposure_per_asset_class_pct}%  cooldown=${c.ticker_cooldown_min}min`);
    console.log(`  min_persistence=${c.gainers_min_persistence_score}  min_path_eff=${c.gainers_min_path_efficiency}`);
  }

  // 2. Décisions Pro 02:20-02:35 par portfolio (depuis gemini_ab_decisions)
  console.log('\n\n═══ 2. Décisions Pro 02:20-02:35 UTC par portfolio ═══');
  const { data: cycles } = await sb
    .from('gemini_ab_decisions')
    .select('decided_at, portfolio_id, pro_action_kind, pro_target_symbol, pro_confidence, pro_thesis, pro_applied, pro_apply_error, candidates_count')
    .gte('decided_at', windowStart)
    .lte('decided_at', windowEnd)
    .order('decided_at', { ascending: true });
  for (const r of cycles ?? []) {
    const p = PORT[r.portfolio_id as string] ?? (r.portfolio_id as string)?.slice(0,8);
    console.log(`${r.decided_at?.slice(11,19)}  ${p.padEnd(13)} → ${r.pro_action_kind}/${r.pro_target_symbol ?? '-'}  conf=${r.pro_confidence ?? '-'}  candidates=${r.candidates_count ?? '-'}  applied=${r.pro_applied}  err=${r.pro_apply_error ?? '-'}`);
  }

  // 3. lisa_decision_log dans cette fenêtre — kinds = opportunity rejected, etc
  console.log('\n\n═══ 3. lisa_decision_log 02:20-02:35 UTC ═══');
  const { data: logs } = await sb
    .from('lisa_decision_log')
    .select('created_at, portfolio_id, kind, payload')
    .gte('created_at', windowStart)
    .lte('created_at', windowEnd)
    .order('created_at', { ascending: true });
  for (const l of logs ?? []) {
    const p = PORT[l.portfolio_id as string] ?? (l.portfolio_id as string)?.slice(0,8);
    const payloadStr = JSON.stringify(l.payload).slice(0, 150);
    console.log(`  ${l.created_at?.slice(11,19)}  ${p.padEnd(13)} ${l.kind?.padEnd(40)} ${payloadStr}`);
  }

  // 4. Y'a-t-il un cooldown actif sur TRADER ?
  console.log('\n\n═══ 4. Cooldown TRADER actuel ═══');
  const { data: traderCfg } = await sb.from('lisa_session_configs').select('*').eq('portfolio_id', '58439d86-3f20-4a60-82a4-307f3f252bc2').single();
  console.log(`TRADER full config:`);
  if (traderCfg) {
    const relevantKeys = Object.keys(traderCfg).filter(k => k.includes('cooldown') || k.includes('min_') || k.includes('conviction') || k.includes('persistence') || k.includes('path') || k.includes('blacklist') || k.includes('suffix'));
    for (const k of relevantKeys) console.log(`  ${k}: ${traderCfg[k]}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
