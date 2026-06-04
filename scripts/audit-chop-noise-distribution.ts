/**
 * Audit distribution interne CHOP_NOISE — quel bucket / quelle cause domine.
 *
 * Lit les decision_log kind=scanner_candidate_skip payload.gate=CHOP_NOISE
 * (instrumentés 04/06) et ventile par bucket, regime, asset_class, bande
 * changePct. But : décider quel SOUS-filtre inhiber sur données réelles.
 *
 * Usage :
 *   npx tsx scripts/audit-chop-noise-distribution.ts
 *   SINCE_UTC=2026-06-04T10:00:00Z npx tsx scripts/audit-chop-noise-distribution.ts
 *   PORTFOLIO_ID=... npx tsx scripts/audit-chop-noise-distribution.ts
 */
import { createClient } from '@supabase/supabase-js';

const sb = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);
const TRADER = process.env.PORTFOLIO_ID || 'b0000001-0000-0000-0000-000000000001';
const SINCE = process.env.SINCE_UTC || new Date(Date.now() - 24 * 3600 * 1000).toISOString();

function bar(n: number, max: number, w = 30): string {
  return '█'.repeat(max > 0 ? Math.round((n / max) * w) : 0);
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log(`  DISTRIBUTION INTERNE CHOP_NOISE — TRADER ${TRADER.slice(0, 8)}`);
  console.log(`  Depuis : ${SINCE}`);
  console.log('═══════════════════════════════════════════════════════════════════');

  let from = 0; const PAGE = 1000;
  const rows: Array<Record<string, unknown>> = [];
  for (;;) {
    const { data, error } = await sb.from('lisa_decision_log')
      .select('payload, timestamp')
      .eq('portfolio_id', TRADER)
      .eq('kind', 'scanner_candidate_skip')
      .gte('timestamp', SINCE)
      .range(from, from + PAGE - 1);
    if (error) { console.error('err:', error.message); break; }
    if (!data || data.length === 0) break;
    for (const r of data) {
      const p = (r.payload ?? {}) as Record<string, unknown>;
      if (p.gate === 'CHOP_NOISE') rows.push(p);
    }
    if (data.length < PAGE) break;
    from += PAGE; if (from > 50000) break;
  }

  console.log(`\nTotal rejets CHOP_NOISE capturés : ${rows.length}`);
  if (rows.length === 0) {
    console.log('\n⚠️  Aucun rejet CHOP_NOISE instrumenté trouvé.');
    console.log('   Causes : (a) deploy pas encore propagé, (b) scanner pas passé,');
    console.log('   (c) SINCE_UTC antérieur à l\'instrumentation (04/06).');
    return;
  }

  // Par bucket
  const byBucket = new Map<string, number>();
  const byRegime = new Map<string, number>();
  const byClass = new Map<string, number>();
  const byChgBand = new Map<string, number>();
  let hasMomentum = 0, noMomentum = 0;
  const risingScores: number[] = [];

  for (const p of rows) {
    const b = String(p.bucket ?? 'none');
    byBucket.set(b, (byBucket.get(b) ?? 0) + 1);
    byRegime.set(String(p.regime_at_entry ?? '?'), (byRegime.get(String(p.regime_at_entry ?? '?')) ?? 0) + 1);
    byClass.set(String(p.asset_class ?? '?'), (byClass.get(String(p.asset_class ?? '?')) ?? 0) + 1);
    const chg = Number(p.change_pct);
    const band = !Number.isFinite(chg) ? 'null' : chg < 5 ? '<5%' : chg < 10 ? '5-10%' : chg < 15 ? '10-15%' : chg < 25 ? '15-25%' : '25%+';
    byChgBand.set(band, (byChgBand.get(band) ?? 0) + 1);
    if (p.has_momentum) hasMomentum++; else noMomentum++;
    if (p.rising_score != null && Number.isFinite(Number(p.rising_score))) risingScores.push(Number(p.rising_score));
  }

  const maxB = Math.max(...byBucket.values());
  console.log('\n━━━ PAR BUCKET (le levier interne décisif) ━━━');
  for (const [b, n] of [...byBucket.entries()].sort((a, b2) => b2[1] - a[1])) {
    const pct = ((n / rows.length) * 100).toFixed(0);
    const flag = b === 'stalled' ? ' ← stalled→CHOP_NOISE (mapping ligne 215)' : (b === 'none' ? ' ← pas de bucket (défaut)' : '');
    console.log(`  ${b.padEnd(20)} ${String(n).padStart(5)} (${pct.padStart(3)}%) ${bar(n, maxB)}${flag}`);
  }

  console.log('\n━━━ momentum présent ? ━━━');
  console.log(`  avec momentum : ${hasMomentum} (${((hasMomentum / rows.length) * 100).toFixed(0)}%)`);
  console.log(`  sans momentum : ${noMomentum} (${((noMomentum / rows.length) * 100).toFixed(0)}%)  ← CHOP_NOISE par défaut faute de features`);
  if (risingScores.length > 0) {
    risingScores.sort((a, b) => a - b);
    const med = risingScores[Math.floor(risingScores.length / 2)];
    console.log(`  risingScore (n=${risingScores.length}) : min=${risingScores[0].toFixed(2)} med=${med.toFixed(2)} max=${risingScores[risingScores.length - 1].toFixed(2)}`);
    console.log(`    (le bucket 'stalled' = risingScore < 0.55 → si médiane proche, confirme que c'est le seuil qui mord)`);
  }

  console.log('\n━━━ PAR asset_class ━━━');
  for (const [c, n] of [...byClass.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${c.padEnd(22)} ${n}`);

  console.log('\n━━━ PAR bande changePct ━━━');
  for (const [b, n] of [...byChgBand.entries()].sort((a, b2) => b2[1] - a[1])) console.log(`  ${b.padEnd(10)} ${n}`);

  console.log('\n━━━ PAR regime_at_entry ━━━');
  for (const [r, n] of [...byRegime.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${r.padEnd(20)} ${n}`);

  // Verdict orienté action
  console.log('\n═══ LECTURE ═══');
  const stalled = byBucket.get('stalled') ?? 0;
  const none = byBucket.get('none') ?? 0;
  const stalledPct = (stalled / rows.length) * 100;
  const nonePct = (none / rows.length) * 100;
  if (stalledPct > 60) {
    console.log(`  → ${stalledPct.toFixed(0)}% des CHOP_NOISE = bucket 'stalled'. Le levier ciblé est CLAIR :`);
    console.log(`    remapper stalled→TREND_PULLBACK (ou STALLED_WATCH) libère ~${stalled} candidats/fenêtre.`);
  } else if (nonePct > 40) {
    console.log(`  → ${nonePct.toFixed(0)}% sans bucket = CHOP_NOISE par défaut (momentum analyzer KO). Le levier`);
    console.log(`    est d'activer/fiabiliser le momentum analyzer, pas de toucher au mapping.`);
  } else {
    console.log(`  → Distribution mixte. stalled=${stalledPct.toFixed(0)}% none=${nonePct.toFixed(0)}%. Voir détail ci-dessus.`);
  }
  console.log('═══════════════════════════════════════════════════════════════════');
}

main().catch((e) => { console.error('Audit failed:', e); process.exit(1); });
