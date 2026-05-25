/**
 * Backfill miroir paper_trades depuis lisa_positions.
 *
 * Pour chaque row paper_trades.status='open' :
 *   - Lookup la ligne lisa_positions correspondante (via scanner_position_id)
 *   - Si lisa_positions.status commence par 'closed' (target/stop/invalidated/
 *     kill/expired), on propage la fermeture sur paper_trades :
 *       status         = 'closed'
 *       closed_at      = lisa.exit_timestamp
 *       exit_price     = lisa.exit_price
 *       pnl_usd        = lisa.realized_pnl_usd
 *       pnl_pct        = lisa.realized_pnl_pct
 *       hold_duration  = closed_at - opened_at
 *       outcome_label  = 1 if pnl > 0 else 0
 *
 * Dry-run par défaut. Passe --apply pour vraiment écrire.
 *
 * Usage :
 *   pnpm tsx scripts/backfill-paper-trades-mirror.ts             # dry-run
 *   pnpm tsx scripts/backfill-paper-trades-mirror.ts --apply     # commit DB
 */

import { createClient } from '@supabase/supabase-js';

const apply = process.argv.includes('--apply');
const sb = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || '',
);

interface PaperTrade {
  id: string;
  scanner_position_id: string | null;
  symbol: string;
  portfolio_id: string;
  opened_at: string;
}

interface LisaPosition {
  id: string;
  status: string;
  exit_price: string | null;
  exit_timestamp: string | null;
  realized_pnl_usd: string | null;
  realized_pnl_pct: number | null;
}

async function main() {
  console.log(`\n=== paper_trades miroir backfill ${apply ? '(APPLY)' : '(dry-run)'} ===\n`);

  // 1. Fetch all paper_trades.open
  const { data: openPt, error: ptErr } = await sb
    .from('paper_trades')
    .select('id, scanner_position_id, symbol, portfolio_id, opened_at')
    .eq('status', 'open');
  if (ptErr) { console.error(ptErr); process.exit(1); }
  const trades = (openPt ?? []) as PaperTrade[];
  console.log(`Open paper_trades : ${trades.length}`);

  if (trades.length === 0) {
    console.log('Nothing to do. Exiting.');
    return;
  }

  // 2. Group by scanner_position_id (some may be null = no link, skip)
  const withLink = trades.filter((t) => t.scanner_position_id);
  const withoutLink = trades.filter((t) => !t.scanner_position_id);
  console.log(`  with scanner_position_id    : ${withLink.length}`);
  console.log(`  without (null) — skipped    : ${withoutLink.length}`);

  if (withoutLink.length > 0) {
    console.log(`\n  ⚠️ ${withoutLink.length} paper_trades sans scanner_position_id — skip backfill (manual review):`);
    for (const t of withoutLink.slice(0, 5)) {
      console.log(`    ${t.symbol.padEnd(15)} opened=${t.opened_at.slice(0, 16)}`);
    }
  }

  // 3. Fetch matching lisa_positions
  const lisaIds = withLink.map((t) => t.scanner_position_id!);
  const { data: lisaRows, error: lpErr } = await sb
    .from('lisa_positions')
    .select('id, status, exit_price, exit_timestamp, realized_pnl_usd, realized_pnl_pct')
    .in('id', lisaIds);
  if (lpErr) { console.error(lpErr); process.exit(1); }
  const lisaById = new Map((lisaRows ?? []).map((l) => [l.id, l as LisaPosition]));
  console.log(`\nMatching lisa_positions   : ${lisaById.size}`);

  // 4. Classify
  const closedReady: Array<{ pt: PaperTrade; lp: LisaPosition }> = [];
  const stillOpen: PaperTrade[] = [];
  const lisaMissing: PaperTrade[] = [];

  for (const t of withLink) {
    const lp = lisaById.get(t.scanner_position_id!);
    if (!lp) { lisaMissing.push(t); continue; }
    if (lp.status === 'open') { stillOpen.push(t); continue; }
    if (lp.status.startsWith('closed')) closedReady.push({ pt: t, lp });
  }

  console.log(`  → closed in lisa, ready to mirror : ${closedReady.length}`);
  console.log(`  → still open in lisa (legitimate) : ${stillOpen.length}`);
  console.log(`  → lisa row missing (orphan PT)    : ${lisaMissing.length}`);

  // 5. Stats lisa status distribution among closedReady
  const byStatus: Record<string, number> = {};
  for (const c of closedReady) byStatus[c.lp.status] = (byStatus[c.lp.status] ?? 0) + 1;
  console.log(`\n  Distribution des status lisa (closedReady) :`);
  for (const [s, n] of Object.entries(byStatus).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${s.padEnd(25)} ${n}`);
  }

  if (closedReady.length === 0 && lisaMissing.length === 0) {
    console.log('\nNo rows to backfill. Exiting.');
    return;
  }

  // 6a. Apply mirror update on closedReady
  console.log(`\n${apply ? '🚀 APPLYING' : '🔍 DRY-RUN'} mirror update on ${closedReady.length} rows (lisa closed → propagate)...`);
  let okMirror = 0;
  let failMirror = 0;
  for (const { pt, lp } of closedReady) {
    const exitTs = lp.exit_timestamp ?? new Date().toISOString();
    const openedTs = new Date(pt.opened_at).getTime();
    const closedTs = new Date(exitTs).getTime();
    const holdSec = Math.max(0, Math.floor((closedTs - openedTs) / 1000));
    const pnlPct = Number(lp.realized_pnl_pct ?? 0);
    const outcomeLabel = pnlPct > 0 ? 1 : 0;

    if (!apply) { okMirror++; continue; }

    const { error } = await sb
      .from('paper_trades')
      .update({
        status: 'closed',
        closed_at: exitTs,
        exit_price: lp.exit_price,
        pnl_usd: lp.realized_pnl_usd,
        pnl_pct: pnlPct,
        hold_duration_seconds: holdSec,
        outcome_label: outcomeLabel,
        updated_at: new Date().toISOString(),
      })
      .eq('id', pt.id)
      .eq('status', 'open');
    if (error) {
      console.log(`  ❌ ${pt.symbol} (${pt.id.slice(0, 8)}) — ${error.message}`);
      failMirror++;
    } else okMirror++;
  }

  // 6b. Apply cancellation on orphans (lisa_position missing)
  // resetSimulation efface lisa_positions mais pas paper_trades (cf. CLAUDE.md).
  // On marque cancelled pour ne plus polluer le dataset ML.
  console.log(`\n${apply ? '🚀 APPLYING' : '🔍 DRY-RUN'} cancellation on ${lisaMissing.length} orphans (lisa_position missing — likely cleared by resetSimulation)...`);
  let okCancel = 0;
  let failCancel = 0;
  for (const pt of lisaMissing) {
    if (!apply) { okCancel++; continue; }
    const { error } = await sb
      .from('paper_trades')
      .update({
        status: 'cancelled',
        closed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', pt.id)
      .eq('status', 'open');
    if (error) {
      console.log(`  ❌ ${pt.symbol} (${pt.id.slice(0, 8)}) — ${error.message}`);
      failCancel++;
    } else okCancel++;
  }

  console.log(`\n=== Summary ===`);
  console.log(`  Mirror updates   ${apply ? '(done)' : '(would do)'} : ${okMirror}` + (failMirror ? ` (${failMirror} failed)` : ''));
  console.log(`  Cancellations    ${apply ? '(done)' : '(would do)'} : ${okCancel}` + (failCancel ? ` (${failCancel} failed)` : ''));
  if (!apply) console.log(`\n  Run with --apply to commit changes.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
