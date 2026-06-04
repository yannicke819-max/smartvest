/**
 * Diagnostic du cron oversold-mistral-exit (toutes les 15min).
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const NAMES: Record<string, string> = {
  'b0000001-0000-0000-0000-000000000001': 'TRADER',
  'a0000001-0000-0000-0000-000000000001': 'HIGH',
  'a0000002-0000-0000-0000-000000000002': 'MIDDLE',
  'a0000003-0000-0000-0000-000000000003': 'SMALL',
};
const label = (id: string) => NAMES[id] ?? id.slice(0, 8);

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(' OVERSOLD-MISTRAL-EXIT — DIAGNOSTIC CRON (15min UTC)');
  console.log('═══════════════════════════════════════════════════════════════\n');

  // [1] Positions ouvertes
  const { data: openPos } = await sb
    .from('lisa_positions')
    .select('id, portfolio_id, symbol, direction, entry_price, entry_timestamp, asset_class, venue_fee_detail')
    .eq('status', 'open')
    .filter('venue_fee_detail->>source', 'eq', 'scanner_oversold')
    .order('entry_timestamp', { ascending: false });

  console.log(`[1] POSITIONS OUVERTES source=scanner_oversold : ${openPos?.length ?? 0}`);
  if (openPos?.length) {
    const byPf = new Map<string, number>();
    for (const p of openPos) byPf.set(p.portfolio_id, (byPf.get(p.portfolio_id) ?? 0) + 1);
    for (const [pf, n] of byPf) console.log(`    ${label(pf).padEnd(8)} → ${n} pos`);
  }

  // [2] Décisions cron Mistral
  const { data: decisions, count: decCount } = await sb
    .from('lisa_decision_log')
    .select('id, created_at, portfolio_id, summary, payload', { count: 'exact' })
    .eq('kind', 'oversold_mistral_gain_pick')
    .order('created_at', { ascending: false })
    .limit(10);

  console.log(`\n[2] DÉCISIONS oversold_mistral_gain_pick (total) : ${decCount ?? 0}`);
  for (const d of decisions ?? []) {
    const p = (d.payload as Record<string, unknown> | null) ?? {};
    const t = new Date(d.created_at as string).toISOString().replace('T', ' ').slice(0, 16);
    console.log(`    ${t}  ${String(p.symbol).padEnd(10)}  conf=${p.mistral_confidence}  rationale=${p.mistral_rationale}`);
  }

  // [3] Total rows position_close_decisions
  const { count: pcdTotal } = await sb
    .from('position_close_decisions')
    .select('id', { count: 'exact', head: true });

  console.log(`\n[3] position_close_decisions — TOTAL ROWS : ${pcdTotal ?? 0}`);

  if ((pcdTotal ?? 0) > 0) {
    const { data: byCloser } = await sb
      .from('position_close_decisions')
      .select('closer_type')
      .limit(500);
    const counts = new Map<string, number>();
    for (const r of byCloser ?? []) counts.set(r.closer_type as string, (counts.get(r.closer_type as string) ?? 0) + 1);
    for (const [c, n] of counts) console.log(`    closer_type=${c.padEnd(15)} → ${n}`);
  }

  // [4] Closes user_manual aujourd'hui (decision_log) — pour comparer
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  const { data: manualCloses, count: mcCount } = await sb
    .from('lisa_decision_log')
    .select('id, created_at, portfolio_id, summary, payload', { count: 'exact' })
    .eq('kind', 'position_closed_manual')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(50);

  console.log(`\n[4] CLOSES MANUELS 24h (lisa_decision_log kind=position_closed_manual) : ${mcCount ?? 0}`);
  for (const m of (manualCloses ?? []).slice(0, 5)) {
    const t = new Date(m.created_at as string).toISOString().replace('T', ' ').slice(0, 16);
    console.log(`    ${t}  pf=${label(m.portfolio_id as string)}  ${m.summary}`);
  }

  // [5] Total positions fermées scanner_oversold aujourd'hui
  const { data: closedOversold, count: coCount } = await sb
    .from('lisa_positions')
    .select('symbol, exit_timestamp, realized_pnl_usd, close_reason, venue_fee_detail', { count: 'exact' })
    .eq('status', 'closed')
    .filter('venue_fee_detail->>source', 'eq', 'scanner_oversold')
    .gte('exit_timestamp', since)
    .order('exit_timestamp', { ascending: false });

  console.log(`\n[5] POSITIONS scanner_oversold FERMÉES 24h : ${coCount ?? 0}`);
  let totalPnl = 0;
  for (const p of (closedOversold ?? []).slice(0, 20)) {
    const pnl = Number(p.realized_pnl_usd ?? 0);
    totalPnl += pnl;
    const t = new Date(p.exit_timestamp as string).toISOString().replace('T', ' ').slice(0, 16);
    console.log(`    ${t}  ${String(p.symbol).padEnd(10)}  pnl=${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}$  reason=${p.close_reason}`);
  }
  console.log(`    Σ realized pnl 24h = ${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)} $`);

  // [6] Labellisation +60min — verdict du labeler counterfactuel
  const { data: labels } = await sb
    .from('position_close_decisions')
    .select('label_outcome_60min')
    .not('label_outcome_60min', 'is', null);
  console.log(`\n[6] LABELS counterfactuels +60min posés : ${labels?.length ?? 0}`);
  if (labels?.length) {
    const counts = new Map<string, number>();
    for (const l of labels) counts.set(String(l.label_outcome_60min), (counts.get(String(l.label_outcome_60min)) ?? 0) + 1);
    for (const [k, v] of counts) console.log(`    ${k} → ${v}`);
  }

  // [7] Cohérence : closes_24h vs captures_24h
  const { count: captures24h } = await sb
    .from('position_close_decisions')
    .select('id', { count: 'exact', head: true })
    .gte('captured_at', since);
  console.log(`\n[7] COHÉRENCE — closes_oversold_24h=${coCount ?? 0} vs captures_24h=${captures24h ?? 0}`);
  if ((coCount ?? 0) > 0 && (captures24h ?? 0) === 0) {
    console.log('    ⚠ Closes exécutés MAIS captureClose() n\'écrit RIEN → bug fire-and-forget silencieux');
    console.log('    Hypothèses : 1) CLOSE_DECISION_CAPTURE_ENABLED=false  2) doCapture throw silencieux (DEBUG only)  3) table 0189 pas créée');
  }

  console.log('\n═══════════════════════════════════════════════════════════════\n');
}

main().catch(e => { console.error(e); process.exit(1); });
