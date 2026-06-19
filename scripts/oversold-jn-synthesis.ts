/**
 * oversold-jn-synthesis.ts — Synthèse "meilleur jour pour vendre" (trajectoire J+N).
 *
 * Pour chaque close oversold dont la trajectoire est mûrie (price_j1 non null),
 * calcule le P&L qu'on aurait eu en TENANT jusqu'à J+1 / J+3 / J+6 / J+10 :
 *     pnl_jN = (price_jN / entry_price - 1) × 100
 * puis agrège moyenne / médiane / % gagnants par jour, et la distribution du
 * "jour du pic" (argmax sur les jours mûris de chaque ligne). Segmenté US / EU.
 *
 * Source : table `position_close_decisions` (labeler progressif J+1/J+3/J+6/J+10).
 *
 * USAGE : npx tsx scripts/oversold-jn-synthesis.ts
 *
 * BASELINE 18/06/2026 (J+10 PAS encore mûri) — à comparer après le 19/06 :
 *   US (n=19) : J+1 +4.5%·74%  J+3 +9.8%·89%  J+6 +8.5%·75%  → pic J+3 (53%)
 *   EU (n=31) : J+1 +0.0%·58%  J+3 -1.3%·52%  J+6 -1.8%·59%  → aucun edge net
 * QUESTION OUVERTE : quand J+10 se peuple (~19-22/06), le pic US se déplace-t-il
 * vers J+6/J+10 (ça continue de grimper) ou reste-t-il à J+3 (ça redonne après) ?
 * Si J+10 ≥ J+3 sur l'US de façon stable → envisager d'allonger l'horizon de
 * sortie US (TP J+3→J+N OU trailing 2-3j) au lieu du lock sec +1.5%. EU : statu quo.
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const sb = createClient(
  (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);
const US = 'a0000001-0000-0000-0000-000000000001';
const EU = 'c0000001-0000-0000-0000-000000000001';
const DAYS = [1, 3, 6, 10] as const;

function pnlAt(r: Record<string, unknown>, d: number): number | null {
  const px = r[`price_j${d}`];
  const e = Number(r.entry_price);
  return px != null && e > 0 ? (Number(px) / e - 1) * 100 : null;
}

function agg(subset: Record<string, unknown>[], label: string): void {
  if (!subset.length) {
    console.log(`\n=== ${label}: vide ===`);
    return;
  }
  console.log(`\n=== ${label} (n=${subset.length}) ===`);
  for (const d of DAYS) {
    const vals = subset.map((r) => pnlAt(r, d)).filter((v): v is number => v != null);
    if (!vals.length) {
      console.log(`  J+${d}: (pas encore mûri)`);
      continue;
    }
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    const s = [...vals].sort((a, b) => a - b);
    const med = s[Math.floor(s.length / 2)];
    const winPct = (vals.filter((v) => v > 0).length / vals.length) * 100;
    console.log(
      `  J+${d}: moy ${avg >= 0 ? '+' : ''}${avg.toFixed(1)}%  méd ${med >= 0 ? '+' : ''}${med.toFixed(1)}%  ` +
        `%gagnants ${winPct.toFixed(0)}%  (n=${vals.length})`,
    );
  }
  const bd: Record<number, number> = { 1: 0, 3: 0, 6: 0, 10: 0 };
  for (const r of subset) {
    let best = -1;
    let bv = -1e9;
    for (const d of DAYS) {
      const v = pnlAt(r, d);
      if (v != null && v > bv) {
        bv = v;
        best = d;
      }
    }
    if (best > 0) bd[best]++;
  }
  const tot = Object.values(bd).reduce((a, b) => a + b, 0);
  console.log(
    '  🏆 jour du pic (argmax):',
    Object.entries(bd)
      .map(([d, n]) => `J+${d}=${n}(${tot ? ((n / tot) * 100).toFixed(0) : 0}%)`)
      .join(' '),
  );
}

(async () => {
  const { data: rows } = await sb
    .from('position_close_decisions')
    .select('symbol,portfolio_id,entry_price,pnl_pct,price_j1,price_j3,price_j6,price_j10,closed_at')
    .not('price_j1', 'is', null)
    .order('closed_at', { ascending: false })
    .limit(500);
  if (!rows?.length) {
    console.log('Aucune ligne avec trajectoire J+1 mûrie.');
    return;
  }
  const j10 = rows.filter((r) => r.price_j10 != null).length;
  console.log(`Trajectoires mûries: ${rows.length} (dont ${j10} avec J+10 peuplé)`);
  agg(rows, 'GLOBAL');
  agg(rows.filter((r) => r.portfolio_id === US), 'US');
  agg(rows.filter((r) => r.portfolio_id === EU), 'EU');
})().catch((e) => {
  console.error('ERR', String(e).slice(0, 250));
  process.exit(1);
});
