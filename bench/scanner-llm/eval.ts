import fs from 'fs';
import path from 'path';
import type { RunResult, BenchMetrics } from './types.ts';
import type { BenchPrompt } from './types.ts';

const BENCH_DIR = path.resolve(process.cwd(), 'bench/scanner-llm');
const DIR = path.join(BENCH_DIR, 'results');
const DATASET_PATH = path.join(BENCH_DIR, 'dataset.json');

function loadResults(): RunResult[] {
  if (!fs.existsSync(DIR)) return [];
  return fs.readdirSync(DIR)
    .filter((f) => f.startsWith('results-') && f.endsWith('.jsonl'))
    .flatMap((f) =>
      fs.readFileSync(path.join(DIR, f), 'utf8')
        .split('\n').filter(Boolean)
        .map((l) => JSON.parse(l) as RunResult),
    );
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function computeMetrics(results: RunResult[], dataset: BenchPrompt[]): BenchMetrics {
  const byPrompt = new Map(dataset.map((d) => [d.id, d]));
  const provider = results[0].provider;
  const model = results[0].model;

  let precSum = 0, recSum = 0, acSum = 0, acTotal = 0, jsonCount = 0, schemaCount = 0;

  for (const r of results) {
    const d = byPrompt.get(r.promptId);
    if (!d) continue;
    const expected = new Set(d.expected_output.tickers.map((t) => t.symbol));
    const parsed = r.parsedTickers ?? [];

    const matched = parsed.filter((t) => expected.has(t.symbol)).length;
    precSum += parsed.length > 0 ? matched / parsed.length : 0;
    recSum += expected.size > 0 ? matched / expected.size : 0;

    for (const t of parsed) {
      const gt = d.ground_truth_assetClass[t.symbol];
      if (gt !== undefined) { acTotal++; if (t.assetClass === gt) acSum++; }
    }

    if (r.ok) jsonCount++;
    const schemaOk = r.ok && parsed.every((t) => t.symbol && t.score != null && t.reason && t.assetClass);
    if (schemaOk) schemaCount++;
  }

  const n = results.length;
  const latencies = results.map((r) => r.latencyMs).sort((a, b) => a - b);

  return {
    provider, model, n,
    precision: precSum / n,
    recall: recSum / n,
    assetClassAccuracy: acTotal > 0 ? acSum / acTotal : 0,
    jsonStrictRate: jsonCount / n,
    avgCostUsd: results.reduce((s, r) => s + r.costUsd, 0) / n,
    totalCostUsd: results.reduce((s, r) => s + r.costUsd, 0),
    p50LatencyMs: percentile(latencies, 50),
    p95LatencyMs: percentile(latencies, 95),
    compositeScore: 0, // filled after normalisation
  };
}

function addComposite(all: BenchMetrics[]): void {
  const minCost = Math.min(...all.map((m) => m.avgCostUsd)) || 1e-9;
  const minLat = Math.min(...all.map((m) => m.p50LatencyMs)) || 1;
  for (const m of all) {
    const quality = ((m.precision + m.recall) / 2 + m.assetClassAccuracy) / 2;
    const costInv = minCost / (m.avgCostUsd || 1e-9);
    const latInv = minLat / (m.p50LatencyMs || 1);
    m.compositeScore = 0.4 * quality + 0.3 * costInv + 0.2 * latInv + 0.1 * m.jsonStrictRate;
  }
}

function fmt(n: number, dec = 2) { return n.toFixed(dec); }
function pct(n: number) { return `${(n * 100).toFixed(1)}%`; }

function generateReport(all: BenchMetrics[]): string {
  const sorted = [...all].sort((a, b) => b.compositeScore - a.compositeScore);
  const byCost = [...all].sort((a, b) => a.avgCostUsd - b.avgCostUsd);

  const header = `# P16 Bench — LLM EU Providers — Scanner Gainers\n_Generated: ${new Date().toISOString()}_\n`;

  const cols = ['Provider', 'Precision', 'Recall', 'AssetClass Acc', 'JSON Valid', 'p50 ms', 'Cost/prompt $', 'Composite ▼'];
  const sep = cols.map(() => '---').join(' | ');
  const rows = sorted.map((m) =>
    [m.provider, pct(m.precision), pct(m.recall), pct(m.assetClassAccuracy),
     pct(m.jsonStrictRate), fmt(m.p50LatencyMs, 0), fmt(m.avgCostUsd, 5), fmt(m.compositeScore)]
      .join(' | '),
  );
  const table = `## Résultats\n\n| ${cols.join(' | ')} |\n| ${sep} |\n${rows.map((r) => `| ${r} |`).join('\n')}\n`;

  const topCost = byCost.slice(0, 2).map((m) => `- **${m.provider}** — $${fmt(m.avgCostUsd, 5)}/prompt`).join('\n');
  const champion = sorted[0];

  const routing = `## Recommandation routing SmartVest

| Cas d'usage | Provider recommandé | Raison |
|---|---|---|
| Scanner gainers temps réel (latence critique) | ${all.sort((a,b)=>a.p50LatencyMs-b.p50LatencyMs)[0].provider} | p50 le plus bas |
| Thesis generation (qualité max) | ${sorted[0].provider} | composite score #1 |
| News screening (coût × volume) | ${byCost[0].provider} | coût/prompt minimal |
| Fallback EU souverain RGPD strict | scaleway ou codestral | datacenter FR certifié |
`;

  return [
    header, table,
    `## Champion absolute cost (Top 2)\n${topCost}\n`,
    `## Champion best value (composite)\n**${champion.provider}** — score ${fmt(champion.compositeScore)} (qualité ${pct((champion.precision+champion.recall)/2)}, coût $${fmt(champion.avgCostUsd,5)}/prompt)\n`,
    routing,
  ].join('\n');
}

(() => {
  const dataset = JSON.parse(fs.readFileSync(DATASET_PATH, 'utf8')) as BenchPrompt[];
  const allResults = loadResults();

  if (allResults.length === 0) {
    console.error('No results found in results/. Run npm run bench:scanner-eu first.');
    process.exit(1);
  }

  const byProvider = allResults.reduce((acc, r) => {
    if (!acc.has(r.provider)) acc.set(r.provider, []);
    acc.get(r.provider)!.push(r);
    return acc;
  }, new Map<string, RunResult[]>());
  const metrics: BenchMetrics[] = [];
  for (const [, results] of byProvider) metrics.push(computeMetrics(results, dataset));
  addComposite(metrics);

  const report = generateReport(metrics);
  const reportPath = path.join(BENCH_DIR, 'REPORT.md');
  fs.writeFileSync(reportPath, report);
  console.log(`REPORT.md written → ${reportPath}`);
  console.table(metrics.map((m) => ({ provider: m.provider, composite: fmt(m.compositeScore), precision: pct(m.precision), cost: fmt(m.totalCostUsd, 4) })));
})();
