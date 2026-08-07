/**
 * Simulation des règles DUAL (R0 quick-lock + R1 RSI fatigue) + HARD CLOSE
 * vs les closes manuels d'hier.
 *
 *   R0 PRIORITÉ ABSOLUE — Quick-lock scalp :
 *     age_min ≤ 10 ET pnl_pct ≥ 1.5%   → CLOSE
 *
 *   R1 — Lock + signal de fatigue :
 *     pnl_pct ≥ 1.5% ET rsi14 ≥ 60      → CLOSE
 *
 *   HARD_CLOSE — Sortie EOD :
 *     time_utc ≥ 20:30 UTC              → CLOSE
 *
 * Verdict appliqué à la PREMIÈRE règle qui fire chronologiquement.
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const HIGH = 'a0000001-0000-0000-0000-000000000001';

const R0_MAX_AGE_MIN = 10;
const R0_MIN_PNL_PCT = 1.5;
const R1_MIN_PNL_PCT = 1.5;
const R1_RSI = 60;
const HARD_CLOSE_HOUR_UTC = 20.5;

function fmt(n: number | null | undefined, d = 2): string {
  if (n == null || !Number.isFinite(n)) return 'n/a';
  return Number(n).toFixed(d);
}
function pad(s: unknown, n: number) { return String(s ?? '').padEnd(n).slice(0, n); }

async function main() {
  const { data: closes } = await sb
    .from('lisa_positions')
    .select('id, symbol, entry_timestamp, exit_timestamp, realized_pnl_pct, realized_pnl_usd')
    .eq('portfolio_id', HIGH)
    .eq('status', 'closed_user')
    .filter('venue_fee_detail->>source', 'eq', 'scanner_oversold')
    .gte('exit_timestamp', '2026-06-04T00:00:00Z')
    .lt('exit_timestamp', '2026-06-05T00:00:00Z')
    .order('exit_timestamp', { ascending: true });

  if (!closes?.length) return;

  console.log('═══════════════════════════════════════════════════════════════════════════════');
  console.log(' DUAL RULES SIMULATION — R0 quick-lock + R1 fatigue + HARD CLOSE 20:30 UTC');
  console.log(`   R0 : age ≤ ${R0_MAX_AGE_MIN}min ET pnl ≥ ${R0_MIN_PNL_PCT}%`);
  console.log(`   R1 : pnl ≥ ${R1_MIN_PNL_PCT}% ET rsi14 ≥ ${R1_RSI}`);
  console.log(`   HC : time_utc ≥ ${HARD_CLOSE_HOUR_UTC} UTC`);
  console.log('═══════════════════════════════════════════════════════════════════════════════\n');

  console.log(pad('SYM', 10), pad('EXIT', 6), pad('Δt', 9), pad('SIM_PNL', 8), pad('ACT_PNL', 8), pad('RULE', 5), pad('VERDICT', 12), 'NOTE');

  type Verdict = 'EARLIER' | 'MATCH' | 'LATER' | 'NEVER';
  const verdicts = new Map<Verdict, number>();
  const ruleHits = new Map<string, number>();
  let sumSimPnl = 0;
  let sumActPnl = 0;
  let countedClosed = 0;

  for (const c of closes as unknown as Array<{
    id: string; symbol: string;
    entry_timestamp: string; exit_timestamp: string;
    realized_pnl_pct: number | null; realized_pnl_usd: number | null;
  }>) {
    const exitMs = new Date(c.exit_timestamp).getTime();
    const entryMs = new Date(c.entry_timestamp).getTime();

    const { data: snaps } = await sb
      .from('position_indicators_snapshot')
      .select('captured_at, pnl_pct, rsi14, mfe_pct')
      .eq('position_id', c.id)
      .gte('captured_at', c.entry_timestamp)
      .lte('captured_at', c.exit_timestamp)
      .order('captured_at', { ascending: true });

    let firedAt: { ts: string; pnl: number; rsi: number | null; rule: 'R0' | 'R1' | 'HC' } | null = null;

    // Test rules in chronological order on each snapshot
    for (const s of (snaps ?? []) as Array<{ captured_at: string; pnl_pct: number | null; rsi14: number | null }>) {
      const ageMin = (new Date(s.captured_at).getTime() - entryMs) / 60_000;
      const tUtc = new Date(s.captured_at).getUTCHours() + new Date(s.captured_at).getUTCMinutes() / 60;
      const pnl = s.pnl_pct;
      const rsi = s.rsi14;
      if (pnl == null) continue;

      // HARD CLOSE first (overrides all)
      if (tUtc >= HARD_CLOSE_HOUR_UTC) {
        firedAt = { ts: s.captured_at, pnl, rsi, rule: 'HC' };
        break;
      }
      // R0 quick-lock
      if (ageMin <= R0_MAX_AGE_MIN && pnl >= R0_MIN_PNL_PCT) {
        firedAt = { ts: s.captured_at, pnl, rsi, rule: 'R0' };
        break;
      }
      // R1 fatigue
      if (pnl >= R1_MIN_PNL_PCT && rsi != null && rsi >= R1_RSI) {
        firedAt = { ts: s.captured_at, pnl, rsi, rule: 'R1' };
        break;
      }
    }

    if (!firedAt) {
      verdicts.set('NEVER', (verdicts.get('NEVER') ?? 0) + 1);
      console.log(pad(c.symbol, 10), pad(String(c.exit_timestamp).slice(11, 16), 6), pad('—', 9), pad('—', 8), pad(fmt(c.realized_pnl_pct) + '%', 8), pad('—', 5), pad('❌ NEVER', 12), 'aucune règle');
      continue;
    }

    const firedMs = new Date(firedAt.ts).getTime();
    const deltaMin = Math.round((firedMs - exitMs) / 60_000);
    const actPnl = Number(c.realized_pnl_pct ?? 0);
    sumSimPnl += firedAt.pnl;
    sumActPnl += actPnl;
    countedClosed++;

    let verdict: Verdict;
    if (deltaMin <= -4) verdict = 'EARLIER';
    else if (deltaMin >= 4) verdict = 'LATER';
    else verdict = 'MATCH';
    verdicts.set(verdict, (verdicts.get(verdict) ?? 0) + 1);
    ruleHits.set(firedAt.rule, (ruleHits.get(firedAt.rule) ?? 0) + 1);

    const icon = verdict === 'EARLIER' ? '🟢' : verdict === 'MATCH' ? '✅' : '🔴';
    const dtStr = deltaMin === 0 ? '=' : (deltaMin > 0 ? `+${deltaMin}m` : `${deltaMin}m`);

    console.log(
      pad(c.symbol, 10),
      pad(String(c.exit_timestamp).slice(11, 16), 6),
      pad(dtStr, 9),
      pad(fmt(firedAt.pnl) + '%', 8),
      pad(fmt(actPnl) + '%', 8),
      pad(firedAt.rule, 5),
      pad(`${icon} ${verdict}`, 12),
      `rsi=${fmt(firedAt.rsi, 0)} Δpnl=${fmt(firedAt.pnl - actPnl)}pts`
    );
  }

  console.log('\n═══════════════════════════════════════════════════════════════════════════════');
  console.log(' SYNTHÈSE');
  console.log('═══════════════════════════════════════════════════════════════════════════════');
  console.log(`  N closes : ${closes.length}`);
  for (const [v, n] of [...verdicts].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${pad(v, 10)} : ${n} (${((n / closes.length) * 100).toFixed(0)}%)`);
  }
  console.log(`\n  Rules fired :`);
  for (const [r, n] of [...ruleHits].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${r} : ${n} closes`);
  }
  if (countedClosed > 0) {
    console.log(`\n  Σ PnL simulé (règle)    : ${sumSimPnl.toFixed(2)}% cumulé sur ${countedClosed} positions`);
    console.log(`  Σ PnL réel (humain)     : ${sumActPnl.toFixed(2)}% cumulé`);
    console.log(`  Avg PnL simulé          : ${(sumSimPnl / countedClosed).toFixed(2)}%`);
    console.log(`  Avg PnL réel            : ${(sumActPnl / countedClosed).toFixed(2)}%`);
    console.log(`  Δ PnL cumulé            : ${(sumSimPnl - sumActPnl).toFixed(2)} pts`);
    console.log(`     (négatif = manque à gagner, positif = mieux que toi)`);
  }
  const never = verdicts.get('NEVER') ?? 0;
  if (never > 0) {
    console.log(`\n  ⚠ ${never} NEVER : positions où Mistral aurait HOLD → fallback J+10 / -15%`);
  }

  console.log('\n═══════════════════════════════════════════════════════════════════════════════\n');
}

main().catch(e => { console.error(e); process.exit(1); });
