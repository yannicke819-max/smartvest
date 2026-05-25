/**
 * Vérifie l'activité réelle de Gemini Risk Manager + OpenPositionRiskMonitor.
 */
import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
const env = fs.readFileSync('.env', 'utf8').split('\n').reduce((acc, l) => {
  const m = l.match(/^([A-Z_]+)=(.+)$/); if (m) acc[m[1]] = m[2]; return acc;
}, {} as Record<string, string>);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  console.log(`\n=== Activité Gemini / Risk Monitor — 24h (depuis ${since.slice(11,19)} UTC il y a 24h) ===\n`);

  // 1. risk_monitor_action entries (notre service)
  const { data: rm } = await sb
    .from('lisa_decision_log')
    .select('kind, summary, payload, created_at')
    .eq('kind', 'risk_monitor_action')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(50);

  console.log(`--- risk_monitor_action (OpenPositionRiskMonitor) : ${rm?.length ?? 0} entries ---`);
  if (rm && rm.length > 0) {
    for (const r of rm.slice(0, 10)) {
      const at = r.created_at.slice(11, 19);
      const v = r.payload?.verdict ?? '?';
      console.log(`  ${at}  ${v.padEnd(15)} ${r.summary?.slice(0, 90) ?? ''}`);
    }
  } else {
    console.log(`  ❌ AUCUNE action — soit pas de positions ouvertes, soit RISK_MONITOR_ENABLED non set`);
  }

  // 2. Cherche traces du legacy GeminiRiskManagerService
  console.log(`\n--- Autres kinds avec "gemini" ou "risk" : ---`);
  const { data: other } = await sb
    .from('lisa_decision_log')
    .select('kind, count')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(2000);
  if (other) {
    const counts = new Map<string, number>();
    for (const r of other as Array<{ kind: string }>) {
      if (r.kind?.includes('gemini') || r.kind?.includes('risk') || r.kind?.includes('llm')) {
        counts.set(r.kind, (counts.get(r.kind) ?? 0) + 1);
      }
    }
    if (counts.size === 0) console.log(`  Aucun kind 'gemini*' / 'risk*' / 'llm*' dans le decision_log 24h`);
    else for (const [k, c] of counts) console.log(`  ${k}: ${c}`);
  }

  // 3. Cherche table gemini_risk_evaluations si elle existe
  console.log(`\n--- Recherche table gemini_risk_evaluations / risk_evaluations : ---`);
  for (const tbl of ['gemini_risk_evaluations', 'risk_evaluations', 'gemini_risk_log']) {
    const r = await sb.from(tbl).select('*', { count: 'exact', head: true });
    if (!r.error) console.log(`  ${tbl} : ${r.count} rows total`);
  }

  // 4. Positions actuellement ouvertes
  const { data: opens } = await sb
    .from('lisa_positions')
    .select('id, symbol, entry_timestamp, status')
    .eq('status', 'open');
  console.log(`\n--- Positions ouvertes : ${opens?.length ?? 0} ---`);
  for (const o of (opens ?? []) as Array<{ symbol: string; entry_timestamp: string }>) {
    const age = Math.round((Date.now() - new Date(o.entry_timestamp).getTime()) / 60_000);
    console.log(`  ${o.symbol} (age ${age} min, opened ${o.entry_timestamp.slice(11, 19)} UTC)`);
  }

  // 5. Vérifier API cost tracking pour LLM (preuve d'appels)
  const today = new Date().toISOString().slice(0, 10);
  const { data: costs } = await sb
    .from('api_costs_daily')
    .select('provider, model, calls_count, total_cost_usd, day_utc')
    .eq('day_utc', today)
    .order('total_cost_usd', { ascending: false });
  console.log(`\n--- API costs aujourd'hui (provider/model) : ---`);
  if (costs && costs.length > 0) {
    for (const c of costs as Array<{ provider: string; model: string; calls_count: number; total_cost_usd: number }>) {
      console.log(`  ${(c.provider || '?').padEnd(20)} ${(c.model || '?').padEnd(30)} calls=${c.calls_count}  cost=$${Number(c.total_cost_usd).toFixed(4)}`);
    }
  } else {
    console.log(`  (table api_costs_daily vide ou inexistante pour aujourd'hui)`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
