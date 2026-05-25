import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
const env = fs.readFileSync('.env', 'utf8').split('\n').reduce((acc, l) => {
  const m = l.match(/^([A-Z_]+)=(.+)$/); if (m) acc[m[1]] = m[2]; return acc;
}, {} as Record<string, string>);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  const nowUtc = new Date();
  console.log(`\n=== AUDIT GATE LIVE — ${nowUtc.toISOString().slice(0,19)} UTC ===\n`);

  // 1. Config complète du portfolio gainers
  console.log('─── 1. CONFIG COMPLÈTE PORTFOLIO GAINERS ───');
  const { data: cfg } = await sb.from('lisa_session_configs')
    .select('*').eq('strategy_mode', 'gainers').limit(1);
  const c = (cfg as any[])?.[0];
  if (c) {
    const relevant = {
      capital_usd: c.capital_usd,
      gainers_position_pct: c.gainers_position_pct,
      gainers_cash_reserve_pct: c.gainers_cash_reserve_pct,
      gainers_max_open_positions: c.gainers_max_open_positions,
      gainers_max_per_cycle: c.gainers_max_per_cycle,
      gainers_cooldown_minutes: c.gainers_cooldown_minutes,
      gainers_post_sl_cooldown_min: c.gainers_post_sl_cooldown_min,
      gainers_min_persistence_score: c.gainers_min_persistence_score,
      gainers_min_path_efficiency: c.gainers_min_path_efficiency,
      gainers_session_filter_enabled: c.gainers_session_filter_enabled,
      gainers_force_close_before_close_enabled: c.gainers_force_close_before_close_enabled,
      gainers_force_close_offset_min: c.gainers_force_close_offset_min,
      gainers_asia_strictness_boost: c.gainers_asia_strictness_boost,
      gainers_universe_asia: c.gainers_universe_asia,
      gainers_p_win_gate_enabled: c.gainers_p_win_gate_enabled,
      gainers_min_p_win: c.gainers_min_p_win,
      gainers_capital_rotation_enabled: c.gainers_capital_rotation_enabled,
      gainers_high_grading_enabled: c.gainers_high_grading_enabled,
      gainers_rotation_min_score: c.gainers_rotation_min_score,
      gainers_top_pool_size: c.gainers_top_pool_size,
      autopilot_paused_reason: c.autopilot_paused_reason,
      daily_cost_budget_usd: c.daily_cost_budget_usd,
    };
    for (const [k, v] of Object.entries(relevant)) {
      console.log(`  ${k.padEnd(45)} = ${v ?? 'null'}`);
    }
  }

  // 2. Portfolio snapshot (capital réel)
  console.log('\n─── 2. DERNIER PORTFOLIO SNAPSHOT ───');
  const { data: snap } = await sb.from('lisa_portfolio_snapshots')
    .select('cash_usd, total_equity_usd, timestamp').order('timestamp', { ascending: false }).limit(1);
  for (const s of (snap ?? []) as any[]) {
    console.log(`  ${s.timestamp?.slice(0,19)} cash=$${s.cash_usd} equity=$${s.total_equity_usd}`);
  }

  // 3. Post-SL cooldown : dernières positions Asia fermées
  const since7d = new Date(Date.now() - 7 * 86_400_000).toISOString();
  console.log('\n─── 3. DERNIÈRES POSITIONS ASIA FERMÉES (7j) ───');
  const { data: closedAsia } = await sb.from('lisa_positions')
    .select('symbol, entry_timestamp, closed_at, status, realized_pnl_usd, close_reason')
    .or('symbol.like.%.KO,symbol.like.%.KQ,symbol.like.%.SHG,symbol.like.%.SHE,symbol.like.%.HK,symbol.like.%.T')
    .gte('entry_timestamp', since7d)
    .order('closed_at', { ascending: false }).limit(10);
  for (const p of (closedAsia ?? []) as any[]) {
    const ageMin = p.closed_at ? Math.round((Date.now() - new Date(p.closed_at).getTime()) / 60_000) : null;
    console.log(`  ${p.closed_at?.slice(11,19) ?? '?'} ${p.symbol.padEnd(15)} ${p.status.padEnd(25)} pnl=${p.realized_pnl_usd} (il y a ${ageMin}min) reason=${p.close_reason ?? '?'}`);
  }

  // 4. Adaptive cooldown service state (décisions log cooldown)
  console.log('\n─── 4. COOLDOWN ENTRIES DÉCISION LOG (7j, kinds=cooldown) ───');
  const { data: cooldownLog } = await sb.from('lisa_decision_log')
    .select('kind, summary, created_at')
    .gte('created_at', since7d)
    .or('kind.like.%cooldown%,kind.like.%post_sl%,kind.like.%skip%,summary.ilike.%cooldown%')
    .order('created_at', { ascending: false }).limit(10);
  console.log(`  Entrées cooldown/skip 7j : ${cooldownLog?.length ?? 0}`);
  for (const d of (cooldownLog ?? []) as any[]) {
    console.log(`  ${d.created_at?.slice(11,19)} [${d.kind}] ${(d.summary ?? '').slice(0, 100)}`);
  }

  // 5. Candidats shadow ACCEPT récents — les vrais scores (5h)
  const since5h = new Date(Date.now() - 5 * 3600_000).toISOString();
  console.log('\n─── 5. CANDIDATS SHADOW ACCEPT ASIA (5h) — scores ───');
  const { data: acceptAsia } = await sb.from('gainers_v1_shadow_signals')
    .select('symbol, exchange, created_at, path_efficiency, persistence_score, change_pct, score')
    .eq('decision', 'ACCEPT')
    .or('exchange.eq.KO,exchange.eq.KQ,exchange.eq.SHG,exchange.eq.SHE')
    .gte('created_at', since5h)
    .order('created_at', { ascending: false }).limit(10);
  for (const s of (acceptAsia ?? []) as any[]) {
    const ageMin = Math.round((Date.now() - new Date(s.created_at).getTime()) / 60_000);
    console.log(`  ${s.created_at.slice(11,19)} ${s.symbol.padEnd(15)} [${s.exchange}] score=${s.score ?? '?'} change=${s.change_pct?.toFixed(2)}% pathEff=${s.path_efficiency} persist=${s.persistence_score} (il y a ${ageMin}min)`);
  }

  // 6. Vérifier si le scanner live (gainers mode) a bien le flag universe_asia actif
  console.log('\n─── 6. RÉSUMÉ DIAGNOSIS ───');
  const nowMin = nowUtc.getUTCHours() * 60 + nowUtc.getUTCMinutes();
  const asiaCloseMin = 8 * 60;
  const minsToClose = asiaCloseMin - nowMin;
  const forceCloseOffset = c?.gainers_force_close_offset_min ?? 60;
  const approaching = minsToClose <= forceCloseOffset;
  console.log(`  Heure UTC : ${nowUtc.toISOString().slice(11,16)}`);
  console.log(`  Minutes avant fermeture Asia (8h UTC) : ${minsToClose} min`);
  console.log(`  forceCloseOffsetMin : ${forceCloseOffset} min`);
  console.log(`  asiaApproachingClose : ${approaching ? '⚠️  OUI → candidats Asia BLOQUÉS' : 'non'}`);
  console.log(`  universeAsia : ${c?.gainers_universe_asia ?? 'null (défaut true)'}`);
  console.log(`  gainers_session_filter_enabled : ${c?.gainers_session_filter_enabled ?? 'null'}`);
  console.log(`  capital_usd : $${c?.capital_usd}`);
  console.log(`  position_pct : ${c?.gainers_position_pct}% → taille=${c?.capital_usd && c?.gainers_position_pct ? (c.capital_usd * c.gainers_position_pct / 100).toFixed(0) : '?'}$`);
}
main().catch(e => { console.error(e); process.exit(1); });
