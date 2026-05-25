/**
 * Backtest rétroactif du Debate Gate sur les rows historiques
 * `gainers_user_shadow_signals` (Thu/Fri/lookback configurable).
 *
 * Pour chaque row 'accept' historique :
 *   - On reconstruit les scores (persistenceScore, pathEff, changePct)
 *   - On évalue via DebateGateService.evaluateCandidate (logique idem prod)
 *   - On note ce que le gate AURAIT décidé (allow / block + verdict + reason)
 *
 * Permet de calibrer les seuils SANS attendre 24h de prod et SANS risquer
 * de bloquer 100% des candidats.
 *
 * Usage :
 *   pnpm tsx scripts/backtest-debate-gate.ts                  # last 4 days
 *   pnpm tsx scripts/backtest-debate-gate.ts --days 7         # last 7 days
 *   pnpm tsx scripts/backtest-debate-gate.ts --from 2026-05-21 --to 2026-05-23
 *   pnpm tsx scripts/backtest-debate-gate.ts --only-accept    # only 'accept' rows
 */

import { createClient } from '@supabase/supabase-js';
import {
  buildSignal,
  resolveDebate,
  type DebateInput,
  type TradingDecision,
} from '@smartvest/ai-analyst';

const args = process.argv.slice(2);
function arg(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  if (idx >= 0 && args[idx + 1]) return args[idx + 1];
  return undefined;
}
const hasFlag = (name: string) => args.includes(`--${name}`);

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('ERROR: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required.');
  process.exit(1);
}

const days = Number(arg('days') ?? 4);
const fromIso = arg('from');
const toIso = arg('to');
const onlyAccept = hasFlag('only-accept');

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

interface ShadowRow {
  symbol: string;
  decision: string;
  change_pct_1m: number | null;
  score: number | null;
  path_eff: number | null;
  persistence_score: number | null;
  persistence_count: string | null;
  is_asia: boolean;
  created_at: string;
}

// Reproduit la logique de DebateGateService.buildAgentInputs + resolveDebate
function evaluateRow(row: ShadowRow, now: number): {
  finalDecision: TradingDecision;
  consensus: number;
  agentCount: number;
  veto: boolean;
  rationale: string;
  agentsBucket: Record<string, TradingDecision>;
} {
  const inputs: DebateInput[] = [];
  const agentsBucket: Record<string, TradingDecision> = {};

  // Persistence agent
  const ps = row.persistence_score ?? 0;
  let persistenceDec: TradingDecision;
  if (ps >= 0.67) persistenceDec = 'BUY';
  else if (ps >= 0.5) persistenceDec = 'HOLD';
  else persistenceDec = 'WAIT';
  agentsBucket['persistence'] = persistenceDec;
  inputs.push({
    agentId: 'persistence',
    signal: buildSignal(persistenceDec, `ps=${ps.toFixed(2)}`, 'persistence', 'INTRADAY_5M', {
      confidence: ps,
      emittedAt: now,
    }),
  });

  // Path quality agent (if present)
  if (typeof row.path_eff === 'number') {
    const pe = row.path_eff;
    let pathDec: TradingDecision;
    if (pe >= 0.7) pathDec = 'BUY';
    else if (pe >= 0.4) pathDec = 'HOLD';
    else pathDec = 'CHASE_THE_TOP';
    agentsBucket['path_quality'] = pathDec;
    inputs.push({
      agentId: 'path_quality',
      signal: buildSignal(pathDec, `pe=${pe.toFixed(2)}`, 'path_quality', 'INTRADAY_5M', {
        confidence: pe,
        emittedAt: now,
      }),
    });
  }

  // Momentum agent
  const cp = row.change_pct_1m ?? 0;
  let momentumDec: TradingDecision;
  if (cp < 0) momentumDec = 'WAIT';
  else if (cp > 15) momentumDec = 'CHASE_THE_TOP';
  else if (cp >= 2) momentumDec = 'BUY';
  else momentumDec = 'HOLD';
  agentsBucket['momentum'] = momentumDec;
  const momConf = Math.abs(cp) >= 5 && Math.abs(cp) <= 15 ? 0.8 : Math.abs(cp) >= 2 && Math.abs(cp) < 5 ? 0.65 : 0.4;
  inputs.push({
    agentId: 'momentum',
    signal: buildSignal(momentumDec, `cp=${cp.toFixed(2)}%`, 'momentum', 'INTRADAY_5M', {
      confidence: momConf,
      emittedAt: now,
    }),
  });

  const verdict = resolveDebate(inputs, now);
  return {
    finalDecision: verdict.decision,
    consensus: verdict.consensusRatio,
    agentCount: inputs.length,
    veto: verdict.vetoTriggered,
    rationale: verdict.rationale,
    agentsBucket,
  };
}

async function main() {
  const toDate = toIso ? new Date(toIso) : new Date();
  const fromDate = fromIso ? new Date(fromIso) : new Date(toDate.getTime() - days * 86_400_000);
  console.log(`\n📊 Backtest Debate Gate`);
  console.log(`Window : ${fromDate.toISOString()} → ${toDate.toISOString()}`);
  console.log(`Mode   : ${onlyAccept ? 'only "accept" rows' : 'all rows'}\n`);

  let query = supabase
    .from('gainers_user_shadow_signals')
    .select('symbol, decision, change_pct_1m, score, path_eff, persistence_score, persistence_count, is_asia, created_at')
    .gte('created_at', fromDate.toISOString())
    .lte('created_at', toDate.toISOString())
    .limit(10000);

  if (onlyAccept) query = query.eq('decision', 'accept');

  const { data, error } = await query;
  if (error) {
    console.error('Query error:', error.message);
    process.exit(1);
  }
  const rows = (data ?? []) as ShadowRow[];
  console.log(`Fetched ${rows.length} rows.\n`);

  if (rows.length === 0) {
    console.log('No data in window. Did the scanner run on these days ?');
    process.exit(0);
  }

  // Stats globales
  const byLegacy: Record<string, number> = {};
  for (const r of rows) byLegacy[r.decision] = (byLegacy[r.decision] ?? 0) + 1;

  // Re-évaluation via debate gate
  const verdicts: Record<string, number> = {};
  const blockedAccepts: Array<{ row: ShadowRow; eval: ReturnType<typeof evaluateRow> }> = [];
  const passedAccepts: Array<{ row: ShadowRow; eval: ReturnType<typeof evaluateRow> }> = [];

  for (const row of rows) {
    const now = new Date(row.created_at).getTime();
    const ev = evaluateRow(row, now);
    verdicts[ev.finalDecision] = (verdicts[ev.finalDecision] ?? 0) + 1;

    if (row.decision === 'accept') {
      if (ev.finalDecision === 'BUY') passedAccepts.push({ row, eval: ev });
      else blockedAccepts.push({ row, eval: ev });
    }
  }

  // Report
  console.log('═══════════════════════════════════════════════════════════');
  console.log('📋 RÉPARTITION LEGACY DECISIONS (vraies décisions scanner)');
  console.log('═══════════════════════════════════════════════════════════');
  for (const [dec, count] of Object.entries(byLegacy).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${dec.padEnd(25)} ${count.toString().padStart(5)} (${((count / rows.length) * 100).toFixed(1)}%)`);
  }

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('🤖 VERDICTS DEBATE GATE (re-évaluation TOUS les rows)');
  console.log('═══════════════════════════════════════════════════════════');
  for (const [dec, count] of Object.entries(verdicts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${dec.padEnd(25)} ${count.toString().padStart(5)} (${((count / rows.length) * 100).toFixed(1)}%)`);
  }

  const acceptCount = (byLegacy['accept'] ?? 0);
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(`🎯 ANALYSE SUR ${acceptCount} ROWS "accept" (vrais trades)`);
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  Auraient été acceptés par le gate : ${passedAccepts.length} (${((passedAccepts.length / Math.max(1, acceptCount)) * 100).toFixed(1)}%)`);
  console.log(`  Auraient été BLOQUÉS par le gate  : ${blockedAccepts.length} (${((blockedAccepts.length / Math.max(1, acceptCount)) * 100).toFixed(1)}%)`);

  if (blockedAccepts.length > 0) {
    console.log('\n  Top raisons de blocage :');
    const reasons: Record<string, number> = {};
    for (const b of blockedAccepts) {
      reasons[b.eval.finalDecision] = (reasons[b.eval.finalDecision] ?? 0) + 1;
    }
    for (const [r, count] of Object.entries(reasons).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${r.padEnd(20)} ${count.toString().padStart(5)}`);
    }

    console.log('\n  Échantillon (10 premiers blocked-accepts) :');
    for (const b of blockedAccepts.slice(0, 10)) {
      const r = b.row;
      const e = b.eval;
      const agents = Object.entries(e.agentsBucket).map(([k, v]) => `${k}=${v}`).join(', ');
      console.log(`    ${r.symbol.padEnd(15)} cp=${(r.change_pct_1m ?? 0).toFixed(1)}% ps=${(r.persistence_score ?? 0).toFixed(2)} pe=${(r.path_eff ?? 0).toFixed(2)} → ${e.finalDecision} (cons=${(e.consensus * 100).toFixed(0)}%) [${agents}]`);
    }
  }

  // Verdict global
  const blockRatio = blockedAccepts.length / Math.max(1, acceptCount);
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('💡 VERDICT CALIBRATION');
  console.log('═══════════════════════════════════════════════════════════');
  if (blockRatio < 0.10) {
    console.log(`  ✅ blockRatio ${(blockRatio * 100).toFixed(0)}% : gate TROP LAXISTE, ne sert presque à rien`);
    console.log(`     → Resserrer les seuils (persistence 0.75, momentum strict)`);
  } else if (blockRatio > 0.60) {
    console.log(`  ⚠️  blockRatio ${(blockRatio * 100).toFixed(0)}% : gate TROP STRICT, étrangle le scanner`);
    console.log(`     → Relâcher (consensus 0.4, persistence 0.55) ou KEEP=false`);
  } else {
    console.log(`  ✅ blockRatio ${(blockRatio * 100).toFixed(0)}% : cible 20-40% — calibration RAISONNABLE`);
    console.log(`     → Activer DEBATE_GATE_ENABLED=true en confiance`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
