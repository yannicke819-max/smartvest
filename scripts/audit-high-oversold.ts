/**
 * Audit complet HIGH oversold — état config, positions, PnL, activité LLM,
 * boucle d'apprentissage, anomalies récentes.
 *
 *   npx tsx scripts/audit-high-oversold.ts
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const HIGH = 'a0000001-0000-0000-0000-000000000001';

function fmtT(v: unknown, len = 16) {
  return String(v ?? '').replace('T', ' ').slice(0, len);
}
function fmtUsd(n: number | string | null | undefined): string {
  const v = Number(n ?? 0);
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}`;
}
function pad(s: unknown, n: number) { return String(s ?? '').padEnd(n).slice(0, n); }

async function main() {
  const now = new Date();
  const today00 = `${now.toISOString().slice(0,10)}T00:00:00Z`;
  const since24h = new Date(Date.now() - 24*3600_000).toISOString();
  const since7d = new Date(Date.now() - 7*86400_000).toISOString();

  console.log('═══════════════════════════════════════════════════════════════════════════════');
  console.log(` AUDIT COMPLET — HIGH oversold  @  ${now.toISOString().slice(0,19)}Z`);
  console.log('═══════════════════════════════════════════════════════════════════════════════\n');

  // ─── 1. Config session ────────────────────────────────────────────────────
  const { data: cfg } = await sb
    .from('lisa_session_configs')
    .select('*')
    .eq('portfolio_id', HIGH)
    .single();
  console.log('[1] SESSION CONFIG');
  console.log(`    strategy_mode       : ${cfg?.strategy_mode}`);
  console.log(`    autopilot_enabled   : ${cfg?.autopilot_enabled}`);
  console.log(`    kill_switch_active  : ${cfg?.kill_switch_active}`);
  console.log(`    paused_reason       : ${cfg?.autopilot_paused_reason ?? '(none)'}`);
  console.log(`    capital_usd         : $${cfg?.capital_usd}`);
  console.log(`    profile             : ${cfg?.profile}`);
  console.log(`    daily_cost_budget   : $${cfg?.daily_cost_budget_usd ?? '(none)'}`);

  // ─── 2. Positions ouvertes ────────────────────────────────────────────────
  const { data: open, count: openCount } = await sb
    .from('lisa_positions')
    .select('id, symbol, direction, entry_price, entry_timestamp, take_profit_price, stop_loss_price, size_usd, venue_fee_detail, asset_class', { count: 'exact' })
    .eq('portfolio_id', HIGH)
    .eq('status', 'open')
    .order('entry_timestamp', { ascending: false });

  const oversoldOpen = (open ?? []).filter(p => (p.venue_fee_detail as Record<string, unknown> | null)?.source === 'scanner_oversold');
  const otherOpen = (open ?? []).filter(p => (p.venue_fee_detail as Record<string, unknown> | null)?.source !== 'scanner_oversold');

  console.log(`\n[2] POSITIONS OUVERTES : ${openCount ?? 0}`);
  console.log(`    scanner_oversold (cible Mistral 15min) : ${oversoldOpen.length}`);
  console.log(`    autres sources                          : ${otherOpen.length}`);

  if (oversoldOpen.length) {
    console.log('\n    Détail scanner_oversold (entry / TP / SL / size) :');
    console.log(`    ${pad('SYM', 12)} ${pad('ENTRY', 10)} ${pad('TP', 10)} ${pad('SL', 10)} ${pad('SIZE_USD', 10)} ${pad('AGE_MIN', 7)} OPENED`);
    for (const p of oversoldOpen) {
      const ageMin = Math.round((Date.now() - new Date(String(p.entry_timestamp)).getTime()) / 60_000);
      console.log(`    ${pad(p.symbol, 12)} ${pad(Number(p.entry_price).toFixed(2), 10)} ${pad(p.take_profit_price ? Number(p.take_profit_price).toFixed(2) : '-', 10)} ${pad(p.stop_loss_price ? Number(p.stop_loss_price).toFixed(2) : '-', 10)} ${pad(p.size_usd ? Number(p.size_usd).toFixed(0) : '-', 10)} ${pad(ageMin, 7)} ${fmtT(p.entry_timestamp)}`);
    }
  }

  // ─── 3. Positions fermées 24h ──────────────────────────────────────────────
  const { data: closed, count: closedCount } = await sb
    .from('lisa_positions')
    .select('symbol, exit_timestamp, entry_timestamp, entry_price, exit_price, realized_pnl_usd, realized_pnl_pct, close_reason, close_rationale, venue_fee_detail, asset_class', { count: 'exact' })
    .eq('portfolio_id', HIGH)
    .eq('status', 'closed')
    .gte('exit_timestamp', since24h)
    .order('exit_timestamp', { ascending: false });

  const oversoldClosed = (closed ?? []).filter(p => (p.venue_fee_detail as Record<string, unknown> | null)?.source === 'scanner_oversold');

  let sumPnl = 0;
  let winners = 0;
  let losers = 0;
  const byReason = new Map<string, { n: number; pnl: number }>();
  for (const p of oversoldClosed) {
    const pnl = Number(p.realized_pnl_usd ?? 0);
    sumPnl += pnl;
    if (pnl > 0) winners++; else if (pnl < 0) losers++;
    const r = String(p.close_reason ?? '?');
    const acc = byReason.get(r) ?? { n: 0, pnl: 0 };
    acc.n++; acc.pnl += pnl;
    byReason.set(r, acc);
  }

  console.log(`\n[3] POSITIONS FERMÉES scanner_oversold 24h : ${oversoldClosed.length}`);
  console.log(`    Σ PnL réalisé    : $${fmtUsd(sumPnl)}`);
  console.log(`    Win rate          : ${winners}W / ${losers}L (${oversoldClosed.length > 0 ? ((winners / (winners + losers || 1)) * 100).toFixed(0) : 0}%)`);
  console.log(`    Par close_reason :`);
  for (const [r, { n, pnl }] of [...byReason].sort((a, b) => Math.abs(b[1].pnl) - Math.abs(a[1].pnl))) {
    console.log(`      ${pad(r, 22)} → n=${pad(n, 3)} Σ=$${fmtUsd(pnl)}`);
  }
  if (oversoldClosed.length) {
    console.log('\n    20 plus récents :');
    console.log(`    ${pad('CLOSED', 16)} ${pad('SYM', 12)} ${pad('PnL$', 10)} ${pad('PnL%', 8)} ${pad('REASON', 22)} RATIONALE`);
    for (const p of oversoldClosed.slice(0, 20)) {
      console.log(`    ${fmtT(p.exit_timestamp)} ${pad(p.symbol, 12)} ${pad(fmtUsd(p.realized_pnl_usd), 10)} ${pad(`${Number(p.realized_pnl_pct ?? 0).toFixed(2)}%`, 8)} ${pad(p.close_reason, 22)} ${String(p.close_rationale ?? '').slice(0, 80)}`);
    }
  }

  // ─── 4. Activité decision_log 6h ──────────────────────────────────────────
  const since6h = new Date(Date.now() - 6*3600_000).toISOString();
  const { data: events } = await sb
    .from('lisa_decision_log')
    .select('timestamp, kind, summary')
    .eq('portfolio_id', HIGH)
    .gte('timestamp', since6h)
    .order('timestamp', { ascending: false })
    .limit(500);

  const kindCounts = new Map<string, number>();
  for (const e of events ?? []) kindCounts.set(e.kind as string, (kindCounts.get(e.kind as string) ?? 0) + 1);
  console.log(`\n[4] decision_log HIGH 6h (${events?.length ?? 0} lignes)`);
  for (const [k, n] of [...kindCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${pad(k, 50)} → ${n}`);
  }

  // ─── 5. Cron Mistral oversold-mistral-exit (decisions) ─────────────────────
  const { count: mistralAllTime } = await sb
    .from('lisa_decision_log')
    .select('id', { count: 'exact', head: true })
    .eq('portfolio_id', HIGH)
    .eq('kind', 'oversold_mistral_gain_pick');

  const { data: mistralDecs } = await sb
    .from('lisa_decision_log')
    .select('timestamp, summary, payload')
    .eq('portfolio_id', HIGH)
    .eq('kind', 'oversold_mistral_gain_pick')
    .order('timestamp', { ascending: false })
    .limit(10);

  console.log(`\n[5] CRON Mistral oversold-mistral-exit (15min) — décisions CLOSE écrites`);
  console.log(`    Total all-time : ${mistralAllTime ?? 0}`);
  if (mistralDecs?.length) {
    for (const d of mistralDecs) {
      const p = (d.payload as Record<string, unknown> | null) ?? {};
      console.log(`    ${fmtT(d.timestamp)}  ${String(p.symbol).padEnd(10)} conf=${p.mistral_confidence} ${p.mistral_rationale}`);
    }
  } else {
    console.log('    (aucune décision CLOSE — Mistral en HOLD systématique pour le moment)');
  }

  // ─── 6. Cron scanner 21:15 UTC ─────────────────────────────────────────────
  const { data: scans } = await sb
    .from('lisa_decision_log')
    .select('timestamp, kind, summary')
    .eq('portfolio_id', HIGH)
    .in('kind', ['oversold_scan_completed', 'oversold_scan_no_candidates'])
    .gte('timestamp', since7d)
    .order('timestamp', { ascending: false })
    .limit(10);

  console.log(`\n[6] CRON Scanner oversold-daily-scan (21:15 UTC) — scans 7j : ${scans?.length ?? 0}`);
  for (const s of scans ?? []) {
    console.log(`    ${fmtT(s.timestamp)}  ${pad(s.kind, 35)} ${String(s.summary ?? '').slice(0, 80)}`);
  }

  // ─── 7. Boucle d'apprentissage ─────────────────────────────────────────────
  const { count: pcdCount } = await sb
    .from('position_close_decisions')
    .select('id', { count: 'exact', head: true })
    .eq('portfolio_id', HIGH);
  const { data: pcdLabels } = await sb
    .from('position_close_decisions')
    .select('label_outcome_60min')
    .eq('portfolio_id', HIGH);
  const labelCounts = new Map<string, number>();
  for (const r of pcdLabels ?? []) labelCounts.set(String(r.label_outcome_60min ?? 'null'), (labelCounts.get(String(r.label_outcome_60min ?? 'null')) ?? 0) + 1);
  console.log(`\n[7] BOUCLE D'APPRENTISSAGE`);
  console.log(`    position_close_decisions all-time : ${pcdCount ?? 0}`);
  console.log(`    Labels counterfactuels +60min :`);
  for (const [k, n] of labelCounts) console.log(`      ${pad(k, 12)} → ${n}`);
  const labeled = (pcdLabels ?? []).filter(r => r.label_outcome_60min !== null).length;
  console.log(`    Politique apprise injectée à Mistral : ${labeled >= 20 ? '✅ ACTIVE' : `❌ COLD START (${labeled}/20 closes labellisés)`}`);

  // ─── 8. Snapshots indicateurs (input du cron Mistral) ──────────────────────
  const { count: snapCount } = await sb
    .from('position_indicators_snapshot')
    .select('position_id', { count: 'exact', head: true })
    .gte('captured_at', since24h);
  console.log(`\n[8] position_indicators_snapshot 24h (input cron Mistral) : ${snapCount ?? 0}`);

  // ─── 9. Anomalies récentes ─────────────────────────────────────────────────
  const { data: errors } = await sb
    .from('lisa_decision_log')
    .select('timestamp, kind, summary')
    .eq('portfolio_id', HIGH)
    .gte('timestamp', since24h)
    .or('kind.eq.position_open_failed,kind.eq.risk_manager_thesis_broken,kind.eq.autopilot_paused')
    .order('timestamp', { ascending: false })
    .limit(10);
  console.log(`\n[9] ANOMALIES 24h : ${errors?.length ?? 0}`);
  for (const e of errors ?? []) {
    console.log(`    ${fmtT(e.timestamp)}  ${pad(e.kind, 30)} ${String(e.summary ?? '').slice(0, 60)}`);
  }

  console.log('\n═══════════════════════════════════════════════════════════════════════════════\n');
}

main().catch(e => { console.error(e); process.exit(1); });
