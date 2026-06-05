import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  const { data: rows } = await sb
    .from('llm_ab_shadow_decisions')
    .select('applied_provider, applied_cost_usd, applied_latency_ms, applied_parse_ok, shadows, concordance_summary, call_site, outcome_label, outcome_pnl_pct')
    .gte('created_at', since)
    .limit(2000);
  console.log(`Total decisions 24h: ${rows?.length ?? 0}\n`);

  // Sample
  if (rows?.[0]) {
    console.log('═══ Sample row ═══');
    console.log('applied:', rows[0].applied_provider, '| parse_ok:', rows[0].applied_parse_ok, '| cost:', rows[0].applied_cost_usd, '| latency:', rows[0].applied_latency_ms);
    console.log('shadows:', JSON.stringify(rows[0].shadows, null, 2).slice(0, 500));
    console.log('concordance_summary:', JSON.stringify(rows[0].concordance_summary).slice(0, 300));
    console.log('call_site:', rows[0].call_site);
    console.log('outcome:', rows[0].outcome_label, 'pnl_pct:', rows[0].outcome_pnl_pct);
    console.log();
  }

  // Aggregate
  const providerStats = new Map<string, { count: number; cost: number; latency: number; parse_ok: number }>();
  const shadowConcordance = new Map<string, { count: number; concordant: number; cost: number; latency: number }>();
  const callSites = new Map<string, number>();

  for (const r of rows ?? []) {
    // Applied stats
    const appPro = r.applied_provider ?? 'unknown';
    const ps = providerStats.get(appPro) ?? { count: 0, cost: 0, latency: 0, parse_ok: 0 };
    ps.count++;
    ps.cost += r.applied_cost_usd ?? 0;
    ps.latency += r.applied_latency_ms ?? 0;
    if (r.applied_parse_ok) ps.parse_ok++;
    providerStats.set(appPro, ps);

    callSites.set(r.call_site ?? 'unknown', (callSites.get(r.call_site ?? 'unknown') ?? 0) + 1);

    // Shadows + concordance
    const shadows = r.shadows as Array<{ provider: string; cost_usd?: number; latency_ms?: number; decision?: any; parse_ok?: boolean }> | null;
    const conc = r.concordance_summary as Record<string, boolean> | null;
    if (Array.isArray(shadows)) {
      for (const sh of shadows) {
        const sc = shadowConcordance.get(sh.provider) ?? { count: 0, concordant: 0, cost: 0, latency: 0 };
        sc.count++;
        sc.cost += sh.cost_usd ?? 0;
        sc.latency += sh.latency_ms ?? 0;
        if (conc && conc[sh.provider] === true) sc.concordant++;
        shadowConcordance.set(sh.provider, sc);
      }
    }
  }

  console.log('─── APPLIED Provider stats 24h ───');
  for (const [p, s] of [...providerStats].sort((a, b) => b[1].count - a[1].count)) {
    const avgLat = s.count > 0 ? (s.latency / s.count).toFixed(0) : '—';
    const parsePct = s.count > 0 ? ((s.parse_ok / s.count) * 100).toFixed(0) : '—';
    console.log(`  ${p.padEnd(20)} calls=${s.count.toString().padStart(4)} parse_ok=${parsePct}% avgLat=${avgLat}ms totalCost=$${s.cost.toFixed(3)}`);
  }

  console.log('\n─── SHADOWS Concordance vs Applied 24h ───');
  for (const [p, s] of [...shadowConcordance].sort((a, b) => b[1].count - a[1].count)) {
    const concPct = s.count > 0 ? ((s.concordant / s.count) * 100).toFixed(1) : '—';
    const avgLat = s.count > 0 ? (s.latency / s.count).toFixed(0) : '—';
    console.log(`  ${p.padEnd(20)} shadow_calls=${s.count.toString().padStart(4)} concordance=${concPct}% avgLat=${avgLat}ms totalCost=$${s.cost.toFixed(3)}`);
  }

  console.log('\n─── Call sites ───');
  for (const [c, n] of [...callSites].sort((a, b) => b[1] - a[1]).slice(0, 5)) {
    console.log(`  ${c}: ${n}`);
  }

  // Outcomes (positions résolues)
  const resolved = rows?.filter(r => r.outcome_label && r.outcome_pnl_pct !== null) ?? [];
  console.log(`\n─── Outcomes ${resolved.length} positions resolved 24h ───`);
  if (resolved.length > 0) {
    const wins = resolved.filter(r => (r.outcome_pnl_pct ?? 0) > 0).length;
    console.log(`  Win rate: ${(wins/resolved.length*100).toFixed(1)}%  Avg PnL: ${(resolved.reduce((a,b) => a + (b.outcome_pnl_pct ?? 0), 0) / resolved.length).toFixed(2)}%`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
