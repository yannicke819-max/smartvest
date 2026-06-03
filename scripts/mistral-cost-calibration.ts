/**
 * (A) Calibration coût Mistral — compare somme `cost_usd` track côté SmartVest
 * vs facture Mistral console réelle, sort le facteur de correction par model.
 *
 * Sources :
 *   1. gemini_ab_decisions : mistral_cost_usd (medium) + mistral_large_cost_usd
 *      → TRADER decisions (b0000001)
 *   2. llm_ab_shadow_decisions : shadows[].cost_usd + applied_cost_usd
 *      → 4 sites périphériques (scanner_postmortem, strategy_coach,
 *        daily_brief, risk_monitor)
 *
 * Période : derniers 7 jours (configurable via --days=N).
 *
 * Output :
 *   - Total $ par model + nombre de calls
 *   - Médiane $ par call
 *   - Hypothèse facture réelle (à comparer avec Mistral console)
 *   - Facteur de correction à appliquer aux prix
 */
import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';

const env = fs.readFileSync('.env', 'utf8').split('\n').reduce((acc, l) => {
  const m = l.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/); if (m) acc[m[1]] = m[2]; return acc;
}, {} as Record<string, string>);

const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!);
const daysArg = process.argv.find((a) => a.startsWith('--days='))?.slice('--days='.length);
const DAYS = daysArg ? Number(daysArg) : 3;  // depuis 1er juin par défaut
const since = new Date(Date.now() - DAYS * 86400_000).toISOString();

interface ModelStats {
  calls: number;
  totalUsd: number;
  totalLatencyMs: number;
  minUsd: number;
  maxUsd: number;
  costs: number[];
}

function emptyStats(): ModelStats {
  return { calls: 0, totalUsd: 0, totalLatencyMs: 0, minUsd: Infinity, maxUsd: 0, costs: [] };
}

function track(stats: Record<string, ModelStats>, model: string, costUsd: number | null, latencyMs: number | null): void {
  if (!model || costUsd == null) return;
  const s = stats[model] ?? emptyStats();
  s.calls++;
  s.totalUsd += costUsd;
  if (latencyMs != null) s.totalLatencyMs += latencyMs;
  s.minUsd = Math.min(s.minUsd, costUsd);
  s.maxUsd = Math.max(s.maxUsd, costUsd);
  s.costs.push(costUsd);
  stats[model] = s;
}

function median(arr: number[]): number {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const m = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
}

(async () => {
  console.log(`\n========== MISTRAL COST CALIBRATION — last ${DAYS}d (since ${since.slice(0, 10)}) ==========\n`);
  const stats: Record<string, ModelStats> = {};

  // 1. TRADER table (gemini_ab_decisions) — 2 columns Mistral (pagination 1000)
  const traderRows: any[] = [];
  let pageFrom = 0;
  while (true) {
    const { data: chunk }: any = await sb.from('gemini_ab_decisions')
      .select('mistral_cost_usd, mistral_latency_ms, mistral_provider, mistral_large_cost_usd, mistral_large_latency_ms, mistral_large_provider, pro_cost_usd, pro_latency_ms, pro_provider, flash_cost_usd, flash_latency_ms, flash_provider')
      .gte('decided_at', since)
      .order('decided_at', { ascending: true })
      .range(pageFrom, pageFrom + 999);
    if (!chunk || chunk.length === 0) break;
    traderRows.push(...chunk);
    if (chunk.length < 1000) break;
    pageFrom += 1000;
  }
  console.log(`gemini_ab_decisions rows: ${traderRows.length} (TRADER b0000001)`);
  for (const r of traderRows ?? []) {
    track(stats, r.mistral_provider ?? 'mistral-medium', r.mistral_cost_usd, r.mistral_latency_ms);
    track(stats, r.mistral_large_provider ?? 'mistral-large', r.mistral_large_cost_usd, r.mistral_large_latency_ms);
    track(stats, r.pro_provider ?? 'gemini-pro', r.pro_cost_usd, r.pro_latency_ms);
    track(stats, r.flash_provider ?? 'gemini-flash', r.flash_cost_usd, r.flash_latency_ms);
  }

  // 2. 4 sites périphériques (llm_ab_shadow_decisions) — pagination
  const shadowRows: any[] = [];
  pageFrom = 0;
  while (true) {
    const { data: chunk }: any = await sb.from('llm_ab_shadow_decisions')
      .select('call_site, applied_provider, applied_cost_usd, applied_latency_ms, shadows')
      .gte('decided_at', since)
      .order('decided_at', { ascending: true })
      .range(pageFrom, pageFrom + 999);
    if (!chunk || chunk.length === 0) break;
    shadowRows.push(...chunk);
    if (chunk.length < 1000) break;
    pageFrom += 1000;
  }
  console.log(`llm_ab_shadow_decisions rows: ${shadowRows.length} (4 sites périphériques)`);
  const siteStats: Record<string, number> = {};
  for (const r of shadowRows ?? []) {
    siteStats[r.call_site] = (siteStats[r.call_site] ?? 0) + 1;
    track(stats, r.applied_provider, r.applied_cost_usd, r.applied_latency_ms);
    for (const sh of (r.shadows ?? []) as any[]) {
      track(stats, sh.provider, sh.cost_usd, sh.latency_ms);
    }
  }
  console.log('  par call_site:', siteStats);

  console.log('\n--- BREAKDOWN PAR MODEL ---');
  const models = Object.keys(stats).sort();
  console.log('model'.padEnd(28) + 'calls'.padStart(6) + 'totalUsd'.padStart(12) + 'median$'.padStart(12) + 'max$'.padStart(12) + 'avgLat'.padStart(10));
  for (const m of models) {
    const s = stats[m];
    console.log(
      m.padEnd(28) +
      String(s.calls).padStart(6) +
      ('$' + s.totalUsd.toFixed(4)).padStart(12) +
      ('$' + median(s.costs).toFixed(6)).padStart(12) +
      ('$' + s.maxUsd.toFixed(6)).padStart(12) +
      ((s.totalLatencyMs / Math.max(1, s.calls)).toFixed(0) + 'ms').padStart(10)
    );
  }

  // Mistral models only — calibration
  console.log('\n--- MISTRAL CALIBRATION (à comparer avec invoice console.mistral.ai) ---');
  const mistralKeys = models.filter((m) => m.startsWith('mistral'));
  let mistralTotal = 0;
  for (const m of mistralKeys) {
    mistralTotal += stats[m].totalUsd;
    console.log(`  ${m.padEnd(28)} → SmartVest claim : $${stats[m].totalUsd.toFixed(4)} (${stats[m].calls} calls)`);
  }
  console.log(`  TOTAL Mistral SmartVest ${DAYS}d : $${mistralTotal.toFixed(4)}`);
  console.log(`  ↑ comparer avec Mistral console "Utilisation API" sur même fenêtre (EUR × 1.08 ≈ USD).`);

  console.log('\n--- FACTEUR DE CORRECTION ---');
  console.log(`Si Mistral facture (USD) = X, alors notre overstate factor = ($${mistralTotal.toFixed(4)}) / X`);
  console.log(`Exemple : si console = $2.08 → facteur = ${(mistralTotal / 2.08).toFixed(2)}× (UI overstate)`);
  console.log(`Exemple : si console = $1.50 → facteur = ${(mistralTotal / 1.50).toFixed(2)}×`);
  console.log('\n========== END ==========\n');
})();
