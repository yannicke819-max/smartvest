/**
 * Simulation de la règle R1 proposée vs les closes manuels d'hier.
 *
 *   Règle simulée : pnl_pct >= 1.5% ET rsi14 >= 60
 *                   (ou trend_5m_pct <= 0, mais on n'a pas cette donnée
 *                   historiquement, donc on utilise rsi14 uniquement comme
 *                   signal de fatigue testable)
 *
 * Pour chaque position : on cherche le PREMIER snapshot où la règle aurait
 * fired, et on compare au close réel de l'humain. Verdicts :
 *   - 🟢 EARLIER  : Mistral aurait fermé AVANT l'humain (= pourrait laisser de l'upside)
 *   - ✅ MATCH    : Mistral aurait fermé au même moment (±2 snapshots = ±4 min)
 *   - 🔴 LATER    : Mistral aurait fermé APRÈS (= attendrait, give-back possible)
 *   - ❌ NEVER    : la règle n'aurait jamais déclenché → Mistral aurait HOLD
 *                   → fallback filet J+10 / -15%
 *
 *   npx tsx scripts/simulate-mistral-rule-vs-actual.ts
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const HIGH = 'a0000001-0000-0000-0000-000000000001';

const RULE_MIN_PNL_PCT = 1.5;
const RULE_RSI_FATIGUE = 60;

function fmt(n: number | null | undefined, dec = 2): string {
  if (n == null || !Number.isFinite(n)) return 'n/a';
  return Number(n).toFixed(dec);
}
function pad(s: unknown, n: number) { return String(s ?? '').padEnd(n).slice(0, n); }

async function main() {
  const { data: closes } = await sb
    .from('lisa_positions')
    .select('id, symbol, entry_timestamp, exit_timestamp, entry_price, exit_price, realized_pnl_pct, realized_pnl_usd')
    .eq('portfolio_id', HIGH)
    .eq('status', 'closed_user')
    .filter('venue_fee_detail->>source', 'eq', 'scanner_oversold')
    .gte('exit_timestamp', '2026-06-04T00:00:00Z')
    .lt('exit_timestamp', '2026-06-05T00:00:00Z')
    .order('exit_timestamp', { ascending: true });

  if (!closes?.length) {
    console.log('Aucun close trouvé');
    return;
  }

  console.log('═══════════════════════════════════════════════════════════════════════════════');
  console.log(' SIMULATION RÈGLE R1 vs CLOSES MANUELS 04/06');
  console.log(`   Règle : pnl_pct ≥ ${RULE_MIN_PNL_PCT}% ET rsi14 ≥ ${RULE_RSI_FATIGUE}`);
  console.log('═══════════════════════════════════════════════════════════════════════════════\n');
  console.log(pad('SYM', 10), pad('EXIT', 6), pad('Δt', 9), pad('SIM_PNL', 9), pad('ACT_PNL', 9), pad('VERDICT', 12), 'NOTE');

  type Verdict = 'EARLIER' | 'MATCH' | 'LATER' | 'NEVER';
  const verdicts = new Map<Verdict, number>();
  let sumSimPnl = 0;
  let sumActPnl = 0;
  let counted = 0;
  const deltaTimes: number[] = [];

  for (const c of closes as unknown as Array<{
    id: string; symbol: string;
    entry_timestamp: string; exit_timestamp: string;
    entry_price: string; exit_price: string;
    realized_pnl_pct: number | null; realized_pnl_usd: number | null;
  }>) {
    const exitMs = new Date(c.exit_timestamp).getTime();
    const entryMs = new Date(c.entry_timestamp).getTime();

    // Charge TOUS les snapshots de cette position (durant le hold)
    const { data: snaps } = await sb
      .from('position_indicators_snapshot')
      .select('captured_at, pnl_pct, rsi14, mfe_pct')
      .eq('position_id', c.id)
      .gte('captured_at', c.entry_timestamp)
      .lte('captured_at', c.exit_timestamp)
      .order('captured_at', { ascending: true });

    if (!snaps?.length) {
      console.log(pad(c.symbol, 10), pad(String(c.exit_timestamp).slice(11, 16), 6), pad('n/a', 9), pad('n/a', 9), pad(fmt(c.realized_pnl_pct) + '%', 9), pad('NO_SNAP', 12), 'pas de snapshot');
      continue;
    }

    // Find FIRST snapshot where rule fires
    let firedAt: { ts: string; pnl: number; rsi: number } | null = null;
    for (const s of snaps as Array<{ captured_at: string; pnl_pct: number | null; rsi14: number | null; mfe_pct: number | null }>) {
      const pnl = s.pnl_pct;
      const rsi = s.rsi14;
      if (pnl == null || rsi == null) continue;
      if (pnl >= RULE_MIN_PNL_PCT && rsi >= RULE_RSI_FATIGUE) {
        firedAt = { ts: s.captured_at, pnl, rsi };
        break;
      }
    }

    if (!firedAt) {
      verdicts.set('NEVER', (verdicts.get('NEVER') ?? 0) + 1);
      console.log(pad(c.symbol, 10), pad(String(c.exit_timestamp).slice(11, 16), 6), pad('—', 9), pad('—', 9), pad(fmt(c.realized_pnl_pct) + '%', 9), pad('❌ NEVER', 12), 'règle jamais matchée');
      continue;
    }

    const firedMs = new Date(firedAt.ts).getTime();
    const deltaMin = Math.round((firedMs - exitMs) / 60_000);
    deltaTimes.push(deltaMin);
    const actPnl = Number(c.realized_pnl_pct ?? 0);
    sumSimPnl += firedAt.pnl;
    sumActPnl += actPnl;
    counted++;

    let verdict: Verdict;
    if (deltaMin <= -4) verdict = 'EARLIER';
    else if (deltaMin >= 4) verdict = 'LATER';
    else verdict = 'MATCH';
    verdicts.set(verdict, (verdicts.get(verdict) ?? 0) + 1);

    const icon = verdict === 'EARLIER' ? '🟢' : verdict === 'MATCH' ? '✅' : '🔴';
    const dtStr = deltaMin === 0 ? '=' : (deltaMin > 0 ? `+${deltaMin}min` : `${deltaMin}min`);

    console.log(
      pad(c.symbol, 10),
      pad(String(c.exit_timestamp).slice(11, 16), 6),
      pad(dtStr, 9),
      pad(fmt(firedAt.pnl) + '%', 9),
      pad(fmt(actPnl) + '%', 9),
      pad(`${icon} ${verdict}`, 12),
      `rsi=${fmt(firedAt.rsi, 0)} (Δ pnl=${fmt(firedAt.pnl - actPnl)}pts)`
    );
  }

  console.log('\n═══════════════════════════════════════════════════════════════════════════════');
  console.log(' SYNTHÈSE');
  console.log('═══════════════════════════════════════════════════════════════════════════════');
  console.log(`  Total closes analysés : ${closes.length}`);
  for (const [v, n] of verdicts) {
    const pct = ((n / closes.length) * 100).toFixed(0);
    console.log(`  ${pad(v, 10)} : ${n} (${pct}%)`);
  }
  if (counted > 0) {
    console.log(`\n  Σ PnL simulé (règle)    : ${(sumSimPnl).toFixed(2)}% cumulé sur ${counted} positions`);
    console.log(`  Σ PnL réel (humain)     : ${(sumActPnl).toFixed(2)}% cumulé`);
    console.log(`  Avg PnL simulé          : ${(sumSimPnl / counted).toFixed(2)}%`);
    console.log(`  Avg PnL réel            : ${(sumActPnl / counted).toFixed(2)}%`);
    const avgDelta = deltaTimes.reduce((s, d) => s + d, 0) / deltaTimes.length;
    console.log(`  Avg delta time (sim-act): ${avgDelta.toFixed(0)} min`);
    console.log(`     (négatif = Mistral fermerait AVANT toi, positif = APRÈS)`);
  }

  const never = verdicts.get('NEVER') ?? 0;
  if (never > 0) {
    console.log(`\n  ⚠ ${never} closes où la règle n'aurait JAMAIS matché.`);
    console.log(`    Ces positions seraient HOLD → fallback J+10 / -15%`);
    console.log(`    À analyser : faut-il une règle complémentaire ?`);
  }

  console.log('\n═══════════════════════════════════════════════════════════════════════════════\n');
}

main().catch(e => { console.error(e); process.exit(1); });
