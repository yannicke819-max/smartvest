/**
 * Diag morning-after — pourquoi 0 position ouverte malgré calibrations relax.
 *
 * Vérifie :
 *   1. Scanner a-t-il tourné toute la nuit ? (decision_log autopilot_cycle_completed)
 *   2. Persistence/path_eff ont-elles pris effet ? (re-lit DB + shadow signals récents)
 *   3. Combien de candidats screener ont remonté Asia/crypto cette nuit ?
 *   4. Funnel rejets nuit : où le pipeline coupe maintenant ?
 *   5. Open positions actuelles
 */
import { createClient } from '@supabase/supabase-js';
const sb = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || '',
);
const PID = 'b0000001-0000-0000-0000-000000000001';

async function main() {
  const lastNight = '2026-05-25T20:00:00Z'; // depuis ~20h UTC = 22h Paris
  const now = new Date().toISOString();
  console.log(`=== Morning-after diag : ${lastNight} → ${now} ===\n`);

  // 1. Config DB actuelle
  console.log('1. CONFIG DB (persistence/path)');
  const { data: cfg } = await sb
    .from('lisa_session_configs')
    .select('strategy_mode, autopilot_enabled, kill_switch_active, gainers_min_persistence_score, gainers_min_path_efficiency, gainers_cycle_minutes, autopilot_paused_reason')
    .eq('portfolio_id', PID).single();
  console.log(`   strategy_mode             = ${cfg?.strategy_mode}`);
  console.log(`   autopilot_enabled         = ${cfg?.autopilot_enabled}`);
  console.log(`   kill_switch_active        = ${cfg?.kill_switch_active}`);
  console.log(`   paused_reason             = ${cfg?.autopilot_paused_reason ?? '(null)'}`);
  console.log(`   gainers_min_persistence   = ${cfg?.gainers_min_persistence_score} (cible 0)`);
  console.log(`   gainers_min_path_eff DB   = ${cfg?.gainers_min_path_efficiency ?? '(null=fallback env)'}`);
  console.log(`   gainers_cycle_minutes     = ${cfg?.gainers_cycle_minutes}`);

  // 2. Cycles scanner nuit
  console.log('\n2. CYCLES SCANNER (autopilot_cycle_completed)');
  const { data: cycles, count: cycleCount } = await sb
    .from('lisa_decision_log')
    .select('timestamp, summary', { count: 'exact' })
    .eq('portfolio_id', PID)
    .eq('kind', 'autopilot_cycle_completed')
    .gte('timestamp', lastNight)
    .order('timestamp', { ascending: false });
  console.log(`   Total cycles depuis ${lastNight} : ${cycleCount ?? 0}`);
  if (cycles && cycles.length > 0) {
    console.log(`   Premier : ${cycles[cycles.length - 1].timestamp}`);
    console.log(`   Dernier : ${cycles[0].timestamp}`);
    console.log(`   Échantillon 3 récents :`);
    for (const c of cycles.slice(0, 3)) {
      console.log(`     ${c.timestamp}  ${(c.summary ?? '').slice(0, 100)}`);
    }
  }

  // 3. Shadow signals nuit par décision
  console.log('\n3. SHADOW SIGNALS NUIT (funnel)');
  const { data: shadows, count: shadowCount } = await sb
    .from('gainers_user_shadow_signals')
    .select('decision, asset_class, symbol, persistence_score, path_eff, created_at', { count: 'exact' })
    .eq('portfolio_id', PID)
    .gte('created_at', lastNight)
    .order('created_at', { ascending: false });
  console.log(`   Total shadow signals : ${shadowCount ?? 0}`);
  if (shadows && shadows.length > 0) {
    const byDecision: Record<string, number> = {};
    for (const s of shadows) byDecision[s.decision] = (byDecision[s.decision] ?? 0) + 1;
    for (const [d, n] of Object.entries(byDecision).sort((a, b) => b[1] - a[1])) {
      console.log(`     ${d.padEnd(28)} ${n}`);
    }
    // Repartition par classe
    const byClass: Record<string, number> = {};
    for (const s of shadows) byClass[s.asset_class] = (byClass[s.asset_class] ?? 0) + 1;
    console.log(`   Par classe :`);
    for (const [c, n] of Object.entries(byClass).sort((a, b) => b[1] - a[1])) {
      console.log(`     ${c.padEnd(22)} ${n}`);
    }
    // Si des accepts, lister
    const accepts = shadows.filter((s) => s.decision === 'accept');
    if (accepts.length > 0) {
      console.log(`   ✅ ${accepts.length} ACCEPT durant la nuit :`);
      for (const a of accepts.slice(0, 10)) {
        console.log(`     ${a.created_at.slice(11, 16)}  ${a.symbol.padEnd(15)}  ${a.asset_class}  persistence=${a.persistence_score} path=${a.path_eff}`);
      }
    }
  }

  // 4. Tous les events decision_log nuit (kinds)
  console.log('\n4. AUTRES EVENTS decision_log NUIT');
  const { data: events } = await sb
    .from('lisa_decision_log')
    .select('kind, timestamp, summary')
    .eq('portfolio_id', PID)
    .gte('timestamp', lastNight)
    .neq('kind', 'autopilot_cycle_completed')
    .order('timestamp', { ascending: false })
    .limit(50);
  if (events) {
    const byKind: Record<string, number> = {};
    for (const e of events) byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
    for (const [k, n] of Object.entries(byKind).sort((a, b) => b[1] - a[1])) {
      console.log(`     ${k.padEnd(40)} ${n}`);
    }
    // Sample interesting
    const interesting = events.filter((e) =>
      e.kind.includes('block') || e.kind.includes('skip') || e.kind.includes('fail') ||
      e.kind.includes('paused') || e.kind.includes('budget') || e.kind.includes('error'),
    ).slice(0, 10);
    if (interesting.length) {
      console.log(`   Sample interessant :`);
      for (const e of interesting) {
        console.log(`     ${e.timestamp}  ${e.kind.padEnd(30)}  ${(e.summary ?? '').slice(0, 70)}`);
      }
    }
  }

  // 5. Open positions
  console.log('\n5. OPEN POSITIONS');
  const { data: lp, count: lpCount } = await sb
    .from('lisa_positions')
    .select('symbol, opened_at, entry_price, status', { count: 'exact' })
    .eq('portfolio_id', PID).eq('status', 'open');
  console.log(`   lisa_positions OPEN : ${lpCount ?? 0}`);
  for (const p of lp ?? []) console.log(`     ${p.symbol}  opened=${p.opened_at}`);

  const { data: pt, count: ptCount } = await sb
    .from('paper_trades')
    .select('symbol, opened_at, entry_price, status', { count: 'exact' })
    .eq('portfolio_id', PID).eq('status', 'open');
  console.log(`   paper_trades OPEN   : ${ptCount ?? 0}`);
  for (const p of pt ?? []) console.log(`     ${p.symbol}  opened=${p.opened_at}`);

  // 6. Positions fermées nuit
  console.log('\n6. POSITIONS FERMÉES NUIT (lisa_positions)');
  const { data: closed, count: closedCount } = await sb
    .from('lisa_positions')
    .select('symbol, opened_at, closed_at, status, realized_pnl_usd, realized_pnl_pct', { count: 'exact' })
    .eq('portfolio_id', PID)
    .gte('closed_at', lastNight)
    .order('closed_at', { ascending: false });
  console.log(`   Closed depuis ${lastNight} : ${closedCount ?? 0}`);
  if (closed) {
    for (const c of closed.slice(0, 10)) {
      console.log(`     ${c.closed_at}  ${c.symbol.padEnd(15)}  status=${c.status}  pnl=$${c.realized_pnl_usd ?? 'n/a'}`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
