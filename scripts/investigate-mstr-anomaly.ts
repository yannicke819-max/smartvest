/**
 * Investigation MSTR.US — 8 alertes risk_manager_thesis_broken sur position
 * en profit (closed +$15.26 à 13:51).
 *
 *   npx tsx scripts/investigate-mstr-anomaly.ts
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const HIGH = 'a0000001-0000-0000-0000-000000000001';

function fmtT(v: unknown) { return String(v ?? '').replace('T', ' ').slice(0, 19); }
function pad(s: unknown, n: number) { return String(s ?? '').padEnd(n).slice(0, n); }

async function main() {
  console.log('═══════════════════════════════════════════════════════════════════════════════');
  console.log(' INVESTIGATION MSTR.US — risk_manager_thesis_broken sur position en profit');
  console.log('═══════════════════════════════════════════════════════════════════════════════\n');

  // 1. Find MSTR positions hier
  const { data: positions } = await sb
    .from('lisa_positions')
    .select('id, symbol, entry_timestamp, exit_timestamp, entry_price, exit_price, realized_pnl_usd, realized_pnl_pct, status, peak_pre_exit, source')
    .eq('portfolio_id', HIGH)
    .eq('symbol', 'MSTR.US')
    .gte('entry_timestamp', '2026-06-04T00:00:00Z')
    .order('entry_timestamp', { ascending: false });

  console.log(`[1] MSTR.US positions HIGH 04/06 : ${positions?.length ?? 0}`);
  for (const p of positions ?? []) {
    console.log(`    pos=${String(p.id).slice(0,8)}  entry=${fmtT(p.entry_timestamp)} @ $${Number(p.entry_price).toFixed(2)}`);
    console.log(`                            exit =${fmtT(p.exit_timestamp)} @ $${Number(p.exit_price ?? 0).toFixed(2)}  pnl=$${p.realized_pnl_usd}  (${Number(p.realized_pnl_pct ?? 0).toFixed(2)}%)`);
    console.log(`                            status=${p.status}  peak_pre_exit=${p.peak_pre_exit}  src=${p.source}`);
  }

  // 2. Find all 8 risk_manager_thesis_broken events for MSTR
  const { data: alerts } = await sb
    .from('lisa_decision_log')
    .select('timestamp, kind, summary, rationale, payload')
    .eq('portfolio_id', HIGH)
    .in('kind', ['risk_manager_thesis_broken', 'risk_manager_assessment_persisted'])
    .gte('timestamp', '2026-06-04T00:00:00Z')
    .lt('timestamp', '2026-06-05T00:00:00Z')
    .order('timestamp', { ascending: true });

  const mstrAlerts = (alerts ?? []).filter(a => {
    const sym = ((a.payload as Record<string, unknown> | null)?.symbol as string | undefined) ?? a.summary ?? '';
    return String(sym).includes('MSTR');
  });

  console.log(`\n[2] Alertes MSTR.US dans lisa_decision_log : ${mstrAlerts.length}`);
  for (const a of mstrAlerts) {
    const p = (a.payload as Record<string, unknown> | null) ?? {};
    console.log(`\n    ${fmtT(a.timestamp)}  kind=${a.kind}`);
    console.log(`    summary  : ${a.summary}`);
    if (p.verdict || p.confidence || p.reason) {
      console.log(`    verdict  : ${p.verdict} conf=${p.confidence}`);
      console.log(`    reason   : ${p.reason}`);
    }
    if (p.mode) console.log(`    mode     : ${p.mode}`);
    if (p.autoClosed !== undefined) console.log(`    autoClose: ${p.autoClosed}`);
    if (p.pnl_pct !== undefined) console.log(`    pnl_pct  : ${p.pnl_pct}`);
  }

  // 3. Check si auto-close a tiré (mode=auto_v2)
  const autoCloses = mstrAlerts.filter(a => ((a.payload as Record<string, unknown> | null)?.mode === 'auto_v2_closed' || (a.payload as Record<string, unknown> | null)?.autoClosed === true));
  console.log(`\n[3] Auto-closes Gemini sur MSTR : ${autoCloses.length}`);
  console.log(`    → ${autoCloses.length > 0 ? '⚠ Le RiskManager A fermé MSTR auto malgré le profit' : '✅ Aucun auto-close — c\'est toi (user_manual) qui as fermé'}`);

  // 4. Indicateurs snapshot autour des alertes
  if (positions?.[0]) {
    const posId = positions[0].id;
    const { data: snaps } = await sb
      .from('position_indicators_snapshot')
      .select('captured_at, mfe_pct, mae_pct, unrealized_pnl_pct')
      .eq('position_id', posId)
      .gte('captured_at', '2026-06-04T10:00:00Z')
      .lt('captured_at', '2026-06-04T14:00:00Z')
      .order('captured_at', { ascending: true });
    console.log(`\n[4] Snapshots MSTR position ${String(posId).slice(0,8)} entre 10:00-14:00 UTC : ${snaps?.length ?? 0}`);
    for (const s of (snaps ?? []).slice(0, 20)) {
      console.log(`    ${fmtT(s.captured_at)}  mfe=${s.mfe_pct ?? 'null'}%  mae=${s.mae_pct ?? 'null'}%  unreal=${s.unrealized_pnl_pct ?? 'null'}%`);
    }
  }

  console.log('\n═══════════════════════════════════════════════════════════════════════════════\n');
}

main().catch(e => { console.error(e); process.exit(1); });
