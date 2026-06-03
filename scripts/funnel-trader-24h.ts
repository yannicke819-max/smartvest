/**
 * Funnel complet TRADER 24h — identifie OÙ on perd les candidats.
 *
 * Étapes mesurées :
 *   1. Scanner candidates produced (top_gainers cycles complete)
 *   2. After OVERPUMP / dead_zones / path_eff / persistence / Skeptic / LLM gate
 *   3. Reached TRADER as scanner_proposal (status=pending)
 *   4. TRADER decision : open_directional / hold / refuse
 *   5. Open success vs position_open_failed
 *   6. Final outcomes (still open / closed TP / closed SL)
 *
 * Cible : dire avec certitude "le gate X rejette N% des candidats viables"
 */
import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';

const env = fs.readFileSync('.env', 'utf8').split('\n').reduce((acc, l) => {
  const m = l.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/); if (m) acc[m[1]] = m[2]; return acc;
}, {} as Record<string, string>);

const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!);
const TRADER = 'b0000001-0000-0000-0000-000000000001';
const since = new Date(Date.now() - 24 * 3600_000).toISOString();
const sinceDay = new Date(); sinceDay.setUTCHours(0, 0, 0, 0);

async function paginate<T = any>(table: string, builder: (q: any) => any): Promise<T[]> {
  const all: T[] = [];
  let from = 0;
  while (true) {
    const { data } = await builder(sb.from(table)).range(from, from + 999);
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < 1000) break;
    from += 1000;
  }
  return all;
}

(async () => {
  console.log(`\n========== TRADER FUNNEL 24h — depuis ${since.slice(11, 19)} UTC ==========\n`);

  // 1. Scanner cycles completed
  const cyclesLog: any[] = await paginate('lisa_decision_log', (q) =>
    q.select('timestamp,kind,summary,payload').eq('portfolio_id', TRADER).gte('timestamp', since).order('timestamp', { ascending: true })
  );
  const kindStats: Record<string, number> = {};
  for (const r of cyclesLog) kindStats[r.kind] = (kindStats[r.kind] ?? 0) + 1;
  console.log('--- DECISION_LOG kinds 24h ---');
  for (const [k, n] of Object.entries(kindStats).sort((a, b) => b[1] - a[1]).slice(0, 20)) {
    console.log(`  ${String(n).padStart(4)} ${k}`);
  }

  // 2. Scanner shadow signals — voir les gates par catégorie
  const shadowSignals: any[] = await paginate('gainers_user_shadow_signals', (q) =>
    q.select('decided_at,symbol,decision,reason,exchange,change_pct').eq('portfolio_id', TRADER).gte('decided_at', since).order('decided_at', { ascending: true })
  );
  console.log(`\n--- SCANNER SHADOW signals TRADER 24h: ${shadowSignals.length} ---`);
  const decStats: Record<string, number> = {};
  const rejReasons: Record<string, number> = {};
  for (const s of shadowSignals) {
    decStats[s.decision] = (decStats[s.decision] ?? 0) + 1;
    if (s.decision !== 'accept' && s.reason) rejReasons[s.reason] = (rejReasons[s.reason] ?? 0) + 1;
  }
  console.log('decisions:', decStats);
  console.log('\nTOP rejection reasons:');
  for (const [r, n] of Object.entries(rejReasons).sort((a, b) => b[1] - a[1]).slice(0, 15)) {
    console.log(`  ${String(n).padStart(4)} ${r.slice(0, 100)}`);
  }

  // 3. Scanner proposals → TRADER
  const proposals: any[] = await paginate('scanner_proposals', (q) =>
    q.select('created_at,symbol,status,score,trader_decision_reason,reviewed_by_trader_at').eq('portfolio_id', TRADER).gte('created_at', since).order('created_at', { ascending: true })
  );
  console.log(`\n--- SCANNER_PROPOSALS pushed TRADER 24h: ${proposals.length} ---`);
  const propStatusStats: Record<string, number> = {};
  for (const p of proposals) propStatusStats[p.status] = (propStatusStats[p.status] ?? 0) + 1;
  console.log('statuses:', propStatusStats);

  // 4. TRADER decisions
  const decisions: any[] = await paginate('trader_agent_decisions', (q) =>
    q.select('decided_at,action_kind,target_symbol,gemini_provider,thesis').gte('decided_at', since).order('decided_at', { ascending: true })
  );
  console.log(`\n--- TRADER_AGENT_DECISIONS 24h: ${decisions.length} ---`);
  const actStats: Record<string, number> = {};
  for (const d of decisions) actStats[d.action_kind ?? 'null'] = (actStats[d.action_kind ?? 'null'] ?? 0) + 1;
  console.log('actions:', actStats);

  // Filtre uniquement actions actionables (non-hold)
  const actionable = decisions.filter((d) => d.action_kind && d.action_kind !== 'hold');
  console.log(`\nActionable decisions (≠ hold): ${actionable.length}`);
  for (const a of actionable.slice(0, 10)) {
    console.log(`  ${a.decided_at.slice(11, 19)} ${a.action_kind} ${a.target_symbol ?? '-'} "${String(a.thesis ?? '').slice(0, 80)}"`);
  }

  // 5. Position open failed reasons
  const failed = cyclesLog.filter((r) => r.kind === 'position_open_failed');
  console.log(`\n--- POSITION_OPEN_FAILED 24h: ${failed.length} ---`);
  const failBySym: Record<string, number> = {};
  const failByReason: Record<string, number> = {};
  for (const f of failed) {
    const pl: any = f.payload;
    failBySym[pl?.symbol ?? '?'] = (failBySym[pl?.symbol ?? '?'] ?? 0) + 1;
    const reason = String(pl?.reason ?? pl?.error ?? f.summary ?? '?').slice(0, 50);
    failByReason[reason] = (failByReason[reason] ?? 0) + 1;
  }
  console.log('par symbol:'); for (const [s, n] of Object.entries(failBySym).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(3)} ${s}`);
  console.log('par reason:'); for (const [r, n] of Object.entries(failByReason).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(3)} ${r}`);

  // 6. Positions ouvertes / closes today
  const allPos: any[] = await paginate('lisa_positions', (q) =>
    q.select('id,symbol,status,entry_timestamp,exit_timestamp,exit_reason,realized_pnl_usd').eq('portfolio_id', TRADER).gte('entry_timestamp', since).order('entry_timestamp', { ascending: true })
  );
  console.log(`\n--- POSITIONS TRADER 24h: ${allPos.length} ---`);
  for (const p of allPos) {
    console.log(`  ${p.entry_timestamp?.slice(11, 19)} ${p.symbol} ${p.status} exit=${p.exit_timestamp?.slice(11, 19) ?? '-'} reason=${p.exit_reason ?? '-'} pnl=${p.realized_pnl_usd ?? '-'}`);
  }

  // 7. Funnel summary
  const rejLLM = cyclesLog.filter((r) => r.kind === 'scanner_proposal_rejected_by_llm').length;
  const skepticBlocks = cyclesLog.filter((r) => r.kind === 'skeptic_verdict' && ((r.payload as any)?.veto === true)).length;
  const skepticTotal = cyclesLog.filter((r) => r.kind === 'skeptic_verdict').length;
  const candidates = shadowSignals.length;
  const accepted = shadowSignals.filter((s) => s.decision === 'accept').length;
  console.log('\n========== FUNNEL SUMMARY ==========');
  console.log(`1. Scanner candidates seen TRADER  : ${candidates}`);
  console.log(`2. Scanner gates passed (→ accept) : ${accepted} (${((accepted/Math.max(1,candidates))*100).toFixed(1)}%)`);
  console.log(`3. Proposals pushed TRADER          : ${proposals.length}`);
  console.log(`4. SkepticAgent verdicts            : ${skepticTotal} (vetos: ${skepticBlocks})`);
  console.log(`5. Mistral LLM rejected proposals   : ${rejLLM}`);
  console.log(`6. Mistral actionable decisions     : ${actionable.length}`);
  console.log(`7. position_open_failed             : ${failed.length}`);
  console.log(`8. lisa_positions opened            : ${allPos.length}`);
  console.log(`9. lisa_positions closed            : ${allPos.filter(p => p.status !== 'open').length}`);
  console.log('=====================================\n');
})();
