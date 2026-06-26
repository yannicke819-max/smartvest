/**
 * Analyse "imitation learning" — extrait les signatures techniques de tes
 * fermetures manuelles oversold du 04/06 pour générer un prompt-block que
 * Mistral peut digérer (remplace la calibration data hardcoded du SYSTEM_PROMPT).
 *
 *   npx tsx scripts/analyze-user-closes-for-mistral.ts
 *
 * Pour chaque close `closed_user` source=`scanner_oversold` du 04/06 :
 *   1. Charge le snapshot indicators le plus proche de exit_timestamp (tolerance ±5min)
 *   2. Extrait : pnl_pct, mfe_pct, mae_pct, give_back, rsi14, bb_pct_b, hold_min
 *   3. Calcule minutes_since_nyse_open
 *   4. Cluster par signature (R1 BB-haut / R2 RSI-surachat / R3 give-back / autres)
 *   5. Stats agrégées + 5-10 exemples canoniques par cluster
 *   6. Génère un bloc Markdown ready-to-paste dans SYSTEM_PROMPT
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const HIGH = 'a0000001-0000-0000-0000-000000000001';

interface CloseRow {
  id: string;
  symbol: string;
  entry_price: string;
  exit_price: string;
  entry_timestamp: string;
  exit_timestamp: string;
  realized_pnl_pct: number | null;
  realized_pnl_usd: number | null;
  status: string;
}

interface Snapshot {
  captured_at: string;
  mfe_pct: number | null;
  mae_pct: number | null;
  rsi14: number | null;
  bb_pct_b: number | null;
  macd_hist: number | null;
  atr14_pct: number | null;
  roc5: number | null;
  path_efficiency: number | null;
  persistence_score: number | null;
}

interface Enriched extends CloseRow {
  holdMin: number;
  minutesSinceNyseOpen: number;
  snap: Snapshot | null;
  giveBack: number | null;
  mfeAtClose: number | null;
}

function fmt(n: number | null | undefined, dec = 2): string {
  if (n == null || !Number.isFinite(n)) return 'n/a';
  return Number(n).toFixed(dec);
}

async function main() {
  // 1. Load 36 closes user_manual on HIGH yesterday (04/06 UTC)
  const { data: closes } = await sb
    .from('lisa_positions')
    .select('id, symbol, entry_price, exit_price, entry_timestamp, exit_timestamp, realized_pnl_pct, realized_pnl_usd, status')
    .eq('portfolio_id', HIGH)
    .eq('status', 'closed_user')
    .filter('venue_fee_detail->>source', 'eq', 'scanner_oversold')
    .gte('exit_timestamp', '2026-06-04T00:00:00Z')
    .lt('exit_timestamp', '2026-06-05T00:00:00Z')
    .order('exit_timestamp', { ascending: true });

  if (!closes || closes.length === 0) {
    console.log('Aucun close trouvé');
    return;
  }
  console.log(`Loaded ${closes.length} closes user_manual scanner_oversold 04/06 UTC\n`);

  // 2. Enrich each close with closest snapshot before exit
  const enriched: Enriched[] = [];
  for (const c of closes as unknown as CloseRow[]) {
    const exitMs = new Date(c.exit_timestamp).getTime();
    const fromMs = exitMs - 10 * 60_000; // window 10min before exit

    const { data: snaps } = await sb
      .from('position_indicators_snapshot')
      .select('captured_at, mfe_pct, mae_pct, rsi14, bb_pct_b, macd_hist, atr14_pct, roc5, path_efficiency, persistence_score')
      .eq('position_id', c.id)
      .gte('captured_at', new Date(fromMs).toISOString())
      .lt('captured_at', c.exit_timestamp)
      .order('captured_at', { ascending: false })
      .limit(1);

    const snap = (snaps?.[0] as Snapshot | undefined) ?? null;
    const holdMin = Math.round((exitMs - new Date(c.entry_timestamp).getTime()) / 60_000);
    const exitDate = new Date(c.exit_timestamp);
    const nyseOpen = new Date(Date.UTC(exitDate.getUTCFullYear(), exitDate.getUTCMonth(), exitDate.getUTCDate(), 14, 30));
    const minutesSinceNyseOpen = Math.round((exitDate.getTime() - nyseOpen.getTime()) / 60_000);

    const mfeAtClose = snap?.mfe_pct ?? null;
    const giveBack = mfeAtClose != null && c.realized_pnl_pct != null ? mfeAtClose - c.realized_pnl_pct : null;

    enriched.push({ ...c, holdMin, minutesSinceNyseOpen, snap, giveBack, mfeAtClose });
  }

  // 3. Aggregate stats
  const totalPnl = enriched.reduce((s, e) => s + Number(e.realized_pnl_usd ?? 0), 0);
  const avgPnlPct = enriched.reduce((s, e) => s + Number(e.realized_pnl_pct ?? 0), 0) / enriched.length;
  const avgMfe = enriched.filter(e => e.mfeAtClose != null).reduce((s, e) => s + (e.mfeAtClose ?? 0), 0) / Math.max(1, enriched.filter(e => e.mfeAtClose != null).length);
  const avgGiveBack = enriched.filter(e => e.giveBack != null).reduce((s, e) => s + (e.giveBack ?? 0), 0) / Math.max(1, enriched.filter(e => e.giveBack != null).length);
  const avgHold = enriched.reduce((s, e) => s + e.holdMin, 0) / enriched.length;
  const wins = enriched.filter(e => Number(e.realized_pnl_pct ?? 0) > 0).length;
  const wr = (wins / enriched.length) * 100;
  const snapCoverage = enriched.filter(e => e.snap != null).length;

  console.log('═══════════════════════════════════════════════════════════════════════════════');
  console.log(' AGGREGATE STATS — 04/06 closes user_manual scanner_oversold (HIGH)');
  console.log('═══════════════════════════════════════════════════════════════════════════════');
  console.log(`  N closes                      : ${enriched.length}`);
  console.log(`  Σ PnL réalisé                 : $${totalPnl.toFixed(2)}`);
  console.log(`  Avg PnL %                     : ${fmt(avgPnlPct)}%`);
  console.log(`  Avg MFE at close              : ${fmt(avgMfe)}%`);
  console.log(`  Avg give_back (MFE - PnL)     : ${fmt(avgGiveBack)}%`);
  console.log(`  Avg hold duration             : ${avgHold.toFixed(0)} min`);
  console.log(`  Win rate                      : ${wr.toFixed(0)}% (${wins}/${enriched.length})`);
  console.log(`  Snapshot coverage             : ${snapCoverage}/${enriched.length}`);

  // 4. Cluster by signature (basée sur snap si disponible, fallback hold/pnl)
  const clusters = {
    'R1 BB-top + low give-back': [] as Enriched[],
    'R2 RSI surachat + MFE solide': [] as Enriched[],
    'R3 give-back > 1% défensif': [] as Enriched[],
    'R4 Hold > 8h (swing patient)': [] as Enriched[],
    'R5 Hold < 1h scalp opportuniste': [] as Enriched[],
    'Autres': [] as Enriched[],
  };

  for (const e of enriched) {
    const bb = e.snap?.bb_pct_b ?? null;
    const rsi = e.snap?.rsi14 ?? null;
    const mfe = e.mfeAtClose;
    const gb = e.giveBack;

    if (bb != null && bb >= 0.90 && gb != null && gb < 0.5) {
      clusters['R1 BB-top + low give-back'].push(e);
    } else if (rsi != null && rsi >= 65 && mfe != null && mfe >= 2.5) {
      clusters['R2 RSI surachat + MFE solide'].push(e);
    } else if (gb != null && gb >= 1.0) {
      clusters['R3 give-back > 1% défensif'].push(e);
    } else if (e.holdMin >= 480) {
      clusters['R4 Hold > 8h (swing patient)'].push(e);
    } else if (e.holdMin <= 60) {
      clusters['R5 Hold < 1h scalp opportuniste'].push(e);
    } else {
      clusters['Autres'].push(e);
    }
  }

  console.log('\n═══════════════════════════════════════════════════════════════════════════════');
  console.log(' CLUSTERS (signatures dominantes)');
  console.log('═══════════════════════════════════════════════════════════════════════════════');
  for (const [name, rows] of Object.entries(clusters)) {
    if (rows.length === 0) continue;
    const cPnl = rows.reduce((s, r) => s + Number(r.realized_pnl_usd ?? 0), 0);
    const cAvgPct = rows.reduce((s, r) => s + Number(r.realized_pnl_pct ?? 0), 0) / rows.length;
    const cAvgMfe = rows.filter(r => r.mfeAtClose != null).reduce((s, r) => s + (r.mfeAtClose ?? 0), 0) / Math.max(1, rows.filter(r => r.mfeAtClose != null).length);
    const cAvgGb = rows.filter(r => r.giveBack != null).reduce((s, r) => s + (r.giveBack ?? 0), 0) / Math.max(1, rows.filter(r => r.giveBack != null).length);
    const cAvgHold = rows.reduce((s, r) => s + r.holdMin, 0) / rows.length;
    console.log(`\n[${name}]  n=${rows.length}, Σ pnl=$${cPnl.toFixed(2)}`);
    console.log(`  avg pnl=${fmt(cAvgPct)}%  avg mfe=${fmt(cAvgMfe)}%  avg gb=${fmt(cAvgGb)}%  avg hold=${cAvgHold.toFixed(0)}min`);
    console.log(`  exemples canoniques :`);
    for (const r of rows.slice(0, 5)) {
      const t = String(r.exit_timestamp).slice(11, 16);
      console.log(`    ${t} ${r.symbol.padEnd(10)} pnl=${fmt(r.realized_pnl_pct)}% mfe=${fmt(r.mfeAtClose)}% gb=${fmt(r.giveBack)}% bb=${fmt(r.snap?.bb_pct_b)} rsi=${fmt(r.snap?.rsi14)} hold=${r.holdMin}min`);
    }
  }

  // 5. Output prompt-ready block
  console.log('\n═══════════════════════════════════════════════════════════════════════════════');
  console.log(' BLOC SYSTEM_PROMPT REGÉNÉRÉ (à coller en remplacement de la calibration)');
  console.log('═══════════════════════════════════════════════════════════════════════════════\n');

  const promptBlock = generatePromptBlock(enriched, clusters, totalPnl, wr);
  console.log(promptBlock);

  console.log('\n═══════════════════════════════════════════════════════════════════════════════\n');
}

function generatePromptBlock(
  enriched: Enriched[],
  clusters: Record<string, Enriched[]>,
  totalPnl: number,
  wr: number,
): string {
  const lines: string[] = [];

  lines.push(`CALIBRATION DATA-DRIVEN (analyse ${enriched.length} closes HIGH 04/06/2026, $${totalPnl.toFixed(2)} réalisé, ${wr.toFixed(0)}% WR) :`);
  lines.push('');
  lines.push("L'humain a fermé manuellement TOUTES ces positions (= ground truth imitation learning).");
  lines.push("Reproduis cette discipline en t'inspirant des signatures observées :");
  lines.push('');

  // Pick top 8 canonical examples across clusters
  lines.push('★ SIGNATURES OBSERVÉES (extraits canoniques, à reproduire) :');
  let count = 0;
  for (const [name, rows] of Object.entries(clusters)) {
    if (rows.length === 0) continue;
    const sorted = [...rows].sort((a, b) => Number(b.realized_pnl_pct ?? 0) - Number(a.realized_pnl_pct ?? 0));
    for (const r of sorted.slice(0, 2)) {
      if (count >= 10) break;
      count++;
      const bits: string[] = [];
      if (r.snap?.bb_pct_b != null) bits.push(`BB%b=${fmt(r.snap.bb_pct_b)}`);
      if (r.snap?.rsi14 != null) bits.push(`RSI=${fmt(r.snap.rsi14, 0)}`);
      if (r.giveBack != null) bits.push(`gb=${fmt(r.giveBack)}`);
      if (r.mfeAtClose != null) bits.push(`mfe=${fmt(r.mfeAtClose)}%`);
      bits.push(`pnl=${fmt(r.realized_pnl_pct)}%`);
      bits.push(`hold=${r.holdMin}min`);
      lines.push(`  - ${r.symbol.padEnd(10)} : ${bits.join(' · ')}`);
    }
  }

  lines.push('');
  lines.push('★★ PATTERNS AGRÉGÉS (statistiques par cluster) :');
  for (const [name, rows] of Object.entries(clusters)) {
    if (rows.length === 0) continue;
    const cAvgPct = rows.reduce((s, r) => s + Number(r.realized_pnl_pct ?? 0), 0) / rows.length;
    const cAvgMfe = rows.filter(r => r.mfeAtClose != null).reduce((s, r) => s + (r.mfeAtClose ?? 0), 0) / Math.max(1, rows.filter(r => r.mfeAtClose != null).length);
    const cAvgGb = rows.filter(r => r.giveBack != null).reduce((s, r) => s + (r.giveBack ?? 0), 0) / Math.max(1, rows.filter(r => r.giveBack != null).length);
    const cAvgHold = rows.reduce((s, r) => s + r.holdMin, 0) / rows.length;
    lines.push(`  • ${name} : n=${rows.length}, avg pnl=${fmt(cAvgPct)}%, avg mfe=${fmt(cAvgMfe)}%, avg gb=${fmt(cAvgGb)}%, avg hold=${cAvgHold.toFixed(0)}min`);
  }

  lines.push('');
  lines.push("★ TIMING WINDOWS observées (heure de close UTC) :");
  const hourBuckets = new Map<number, { n: number; pnl: number }>();
  for (const e of enriched) {
    const h = new Date(e.exit_timestamp).getUTCHours();
    const b = hourBuckets.get(h) ?? { n: 0, pnl: 0 };
    b.n++;
    b.pnl += Number(e.realized_pnl_usd ?? 0);
    hourBuckets.set(h, b);
  }
  for (const [h, b] of [...hourBuckets].sort((a, b) => a[0] - b[0])) {
    lines.push(`  ${String(h).padStart(2, '0')}:xx UTC : ${b.n} closes, Σ $${b.pnl.toFixed(2)}`);
  }

  return lines.join('\n');
}

main().catch(e => { console.error(e); process.exit(1); });
