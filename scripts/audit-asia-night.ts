/**
 * Audit Asia night session — à lancer au réveil pour mesurer :
 * 1. Volume signals / accept / reject par gate
 * 2. Opens réels + PnL net + durée hold
 * 3. Casualties opening auctions (00-02 UTC, post-suppression hour blacklist)
 * 4. Comptage trigger des 4 gates anti-OKLO (CLIMAX_RUN, VERTICAL_PUMP, TOP_TICK_GUARD, CHOP_LONG_TF)
 * 5. Comparatif vs même fenêtre J-7
 *
 * Usage :
 *   set -a && . .env && set +a && npx tsx scripts/audit-asia-night.ts
 *
 * Fenêtre par défaut : 22:00 UTC J-1 → maintenant. Override via env:
 *   AUDIT_SINCE_UTC=2026-06-03T22:00:00Z AUDIT_UNTIL_UTC=2026-06-04T07:00:00Z npx tsx scripts/audit-asia-night.ts
 */
import { createClient } from '@supabase/supabase-js';

const sb = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);
const TRADER = 'b0000001-0000-0000-0000-000000000001';

// Fenêtre par défaut : 22:00 UTC J-1 → now
const now = new Date();
const defaultSince = new Date(now.getTime() - 14 * 60 * 60 * 1000); // 14h en arrière (22h UTC si réveil 12h CEST)
const SINCE = process.env.AUDIT_SINCE_UTC ?? defaultSince.toISOString();
const UNTIL = process.env.AUDIT_UNTIL_UTC ?? now.toISOString();
const WEEK_AGO_SINCE = new Date(new Date(SINCE).getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
const WEEK_AGO_UNTIL = new Date(new Date(UNTIL).getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();

function fmt(n: number | null | undefined, digits = 2): string {
  if (n == null || !Number.isFinite(n)) return 'n/a';
  return Number(n).toFixed(digits);
}
function pct(n: number | null | undefined): string {
  return n == null ? 'n/a' : `${fmt(n)}%`;
}
function bar(n: number, max: number, width = 30): string {
  const len = max > 0 ? Math.round((n / max) * width) : 0;
  return '█'.repeat(len).padEnd(width, ' ');
}

interface ShadowRow { decision: string; reason_code: string | null; symbol: string; change_pct: number | null; created_at: string; asset_class?: string; }
interface PositionRow {
  symbol: string; asset_class: string; status: string;
  entry_price: number; entry_timestamp: string;
  exit_price: number | null; exit_timestamp: string | null;
  exit_reason: string | null; realized_pnl_usd: number | null; realized_pnl_pct: number | null;
  peak_pre_exit: number | null;
}
interface DecisionLogRow { kind: string; summary: string; timestamp: string; payload: Record<string, unknown> | null; }

async function fetchShadowSignals(since: string, until: string): Promise<ShadowRow[]> {
  const { data } = await sb.from('gainers_user_shadow_signals')
    .select('decision, reason_code, symbol, change_pct, created_at, asset_class')
    .eq('portfolio_id', TRADER)
    .eq('asset_class', 'asia_equity')
    .gte('created_at', since).lte('created_at', until)
    .order('created_at', { ascending: true });
  return (data ?? []) as ShadowRow[];
}

async function fetchPositions(since: string, until: string): Promise<PositionRow[]> {
  const { data } = await sb.from('lisa_positions')
    .select('symbol, asset_class, status, entry_price, entry_timestamp, exit_price, exit_timestamp, exit_reason, realized_pnl_usd, realized_pnl_pct, peak_pre_exit')
    .eq('portfolio_id', TRADER)
    .eq('asset_class', 'asia_equity')
    .gte('entry_timestamp', since).lte('entry_timestamp', until)
    .order('entry_timestamp', { ascending: true });
  return (data ?? []) as PositionRow[];
}

async function fetchAntiOklogGateTriggers(since: string, until: string): Promise<DecisionLogRow[]> {
  const { data } = await sb.from('lisa_decision_log')
    .select('kind, summary, timestamp, payload')
    .eq('portfolio_id', TRADER)
    .gte('timestamp', since).lte('timestamp', until)
    .or('summary.ilike.%CLIMAX_RUN%,summary.ilike.%VERTICAL_PUMP%,summary.ilike.%TOP_TICK_GUARD%,summary.ilike.%CHOP_LONG_TF%,summary.ilike.%BLOW_OFF_RULE%')
    .order('timestamp', { ascending: true });
  return (data ?? []) as DecisionLogRow[];
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════════════════════════');
  console.log(`  AUDIT ASIA NIGHT — TRADER (b0000001)`);
  console.log(`  Fenêtre : ${SINCE} → ${UNTIL}`);
  console.log(`  Comparatif J-7 : ${WEEK_AGO_SINCE} → ${WEEK_AGO_UNTIL}`);
  console.log('═══════════════════════════════════════════════════════════════════════════════\n');

  // === 1. Shadow signals breakdown ===
  const sigs = await fetchShadowSignals(SINCE, UNTIL);
  const sigsWeek = await fetchShadowSignals(WEEK_AGO_SINCE, WEEK_AGO_UNTIL);

  const decisionCounts = new Map<string, number>();
  for (const s of sigs) decisionCounts.set(s.decision, (decisionCounts.get(s.decision) ?? 0) + 1);
  const sortedDecisions = [...decisionCounts.entries()].sort((a, b) => b[1] - a[1]);
  const total = sigs.length;
  const maxN = sortedDecisions[0]?.[1] ?? 1;
  const accepts = decisionCounts.get('accept') ?? 0;

  console.log('━━━ 1. SHADOW SIGNALS ASIA ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`Total signals fenêtre  : ${total}`);
  console.log(`Total signals J-7      : ${sigsWeek.length}  (delta ${sigs.length - sigsWeek.length > 0 ? '+' : ''}${sigs.length - sigsWeek.length})`);
  console.log(`Accept rate            : ${pct(total > 0 ? (accepts / total) * 100 : 0)}\n`);

  console.log('Breakdown par decision (descendant) :');
  for (const [d, n] of sortedDecisions) {
    const pctOf = total > 0 ? (n / total) * 100 : 0;
    console.log(`  ${d.padEnd(35)} ${String(n).padStart(4)} (${pctOf.toFixed(1).padStart(5)}%) ${bar(n, maxN)}`);
  }

  // === 2. Opens + PnL ===
  const opens = await fetchPositions(SINCE, UNTIL);
  const opensWeek = await fetchPositions(WEEK_AGO_SINCE, WEEK_AGO_UNTIL);

  console.log('\n━━━ 2. ASIA OPENS (TRADER) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`Opens fenêtre : ${opens.length}  (J-7 : ${opensWeek.length})`);

  if (opens.length === 0) {
    console.log('  → AUCUNE OPEN ce soir. Cause probable :');
    console.log('    - signals=0 (marché Asia non actif ou tickers filtrés cap)');
    console.log('    - tous les accepts sont à finir leur cycle TRADER LLM');
    console.log('    - cron mechanical pas encore passé sur les opens');
  } else {
    const closed = opens.filter(p => p.status !== 'open');
    const open = opens.filter(p => p.status === 'open');
    const winsClosed = closed.filter(p => (p.realized_pnl_usd ?? 0) > 0);
    const slClosed = closed.filter(p => p.exit_reason?.toLowerCase().includes('stop') ?? false);
    const tpClosed = closed.filter(p => p.exit_reason?.toLowerCase().includes('target') || p.exit_reason?.toLowerCase().includes('tp'));
    const invalClosed = closed.filter(p => p.status === 'closed_invalidated');
    const totalPnlUsd = closed.reduce((s, p) => s + Number(p.realized_pnl_usd ?? 0), 0);
    const avgHoldMin = closed.length > 0
      ? closed.reduce((s, p) => s + (p.exit_timestamp ? (new Date(p.exit_timestamp).getTime() - new Date(p.entry_timestamp).getTime()) / 60000 : 0), 0) / closed.length
      : 0;
    const wrPct = closed.length > 0 ? (winsClosed.length / closed.length) * 100 : 0;

    console.log(`  Closed     : ${closed.length}  (TP: ${tpClosed.length}, SL: ${slClosed.length}, Invalidated: ${invalClosed.length})`);
    console.log(`  Open MTM   : ${open.length}`);
    console.log(`  Win rate   : ${pct(wrPct)}`);
    console.log(`  Sum PnL    : $${fmt(totalPnlUsd, 2)}`);
    console.log(`  Avg hold   : ${fmt(avgHoldMin, 1)} min`);

    // Casualties opening auctions 00-02 UTC
    const openingTrades = opens.filter(p => {
      const h = new Date(p.entry_timestamp).getUTCHours();
      return h >= 0 && h < 2;
    });
    const openingClosed = openingTrades.filter(p => p.status !== 'open');
    const openingSL = openingClosed.filter(p => p.exit_reason?.toLowerCase().includes('stop'));
    console.log(`\n  Opening auctions 00-02 UTC : ${openingTrades.length} opens`);
    console.log(`    → closed_stop          : ${openingSL.length} (${openingClosed.length > 0 ? ((openingSL.length / openingClosed.length) * 100).toFixed(0) : 0}% des closed)`);
    console.log(`    → PnL fenêtre auction  : $${fmt(openingClosed.reduce((s, p) => s + Number(p.realized_pnl_usd ?? 0), 0), 2)}`);
    if (openingSL.length >= 3) {
      console.log(`    ⚠️  ALERTE : ${openingSL.length} SL d'affilée en opening auction = revoir hour blacklist (re-add 0,1 ?)`);
    }

    console.log(`\n  Top 10 trades détaillés (par entry time) :`);
    for (const p of opens.slice(0, 10)) {
      const holdMin = p.exit_timestamp ? (new Date(p.exit_timestamp).getTime() - new Date(p.entry_timestamp).getTime()) / 60000 : null;
      const pnlStr = p.realized_pnl_pct != null ? `${p.realized_pnl_pct.toFixed(2)}%` : 'open';
      console.log(`    ${p.entry_timestamp.slice(11, 16)}Z ${p.symbol.padEnd(15)} ${p.status.padEnd(20)} ${pnlStr.padStart(8)} ${holdMin != null ? fmt(holdMin, 1) + 'min' : ''}`);
    }
  }

  // === 3. Trigger count anti-OKLO gates ===
  const gateLogs = await fetchAntiOklogGateTriggers(SINCE, UNTIL);
  console.log('\n━━━ 3. ANTI-OKLO GATES TRIGGERS ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const gateCounts = {
    CLIMAX_RUN: 0,
    VERTICAL_PUMP: 0,
    TOP_TICK_GUARD: 0,
    CHOP_LONG_TF: 0,
    BLOW_OFF_RULE: 0,
  };
  for (const r of gateLogs) {
    for (const g of Object.keys(gateCounts) as (keyof typeof gateCounts)[]) {
      if (r.summary.includes(g)) gateCounts[g] += 1;
    }
  }
  for (const [g, n] of Object.entries(gateCounts)) {
    console.log(`  ${g.padEnd(20)} ${String(n).padStart(4)}  ${bar(n, Math.max(...Object.values(gateCounts), 1))}`);
  }

  if (gateLogs.length > 0) {
    console.log(`\n  Échantillon 10 derniers triggers :`);
    for (const r of gateLogs.slice(-10)) {
      console.log(`    ${r.timestamp.slice(11, 16)}Z ${r.summary.slice(0, 110)}`);
    }
  } else {
    console.log('  → 0 triggers ce soir. Soit :');
    console.log('    - peu de candidats verticaux (marché calme)');
    console.log('    - tous les opens passent les gates (= bonne sélection)');
    console.log('    - aucun cycle scanner n\'a tourné (vérifier autopilot_enabled)');
  }

  // === 4. Net verdict ===
  console.log('\n━━━ 4. VERDICT NUIT ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  const flow = sigs.length;
  const acceptRate = flow > 0 ? (accepts / flow) * 100 : 0;
  const openings = opens.filter(p => new Date(p.entry_timestamp).getUTCHours() < 2).length;
  const opensSL = opens.filter(p => p.exit_reason?.toLowerCase().includes('stop')).length;
  const pnlUsd = opens.filter(p => p.status !== 'open').reduce((s, p) => s + Number(p.realized_pnl_usd ?? 0), 0);

  const verdict: string[] = [];
  if (flow === 0) verdict.push('⚠️  AUCUN signal — vérifier scanner + universe_asia + market_cap floor');
  else if (flow < 30) verdict.push('⚠️  Flow faible (<30 signals) — marché Asia calme OU filtres trop stricts');
  else verdict.push(`✓ Flow normal : ${flow} signals Asia capturés`);
  if (acceptRate < 1 && flow > 30) verdict.push('⚠️  Accept rate <1% — gates trop stricts ou conditions marché unfavorables');
  if (acceptRate > 15) verdict.push('⚠️  Accept rate >15% — gates trop permissifs, vérifier la sélection');
  if (openings >= 3 && opensSL / Math.max(opens.length, 1) > 0.6) verdict.push('🔴 Cascade SL opening auctions — REMETTRE GAINERS_HOUR_BLACKLIST_ASIA_UTC=0,1');
  if (pnlUsd < -50) verdict.push(`🔴 PnL net Asia <-$50 (${fmt(pnlUsd)}$) — investigation requise`);
  else if (pnlUsd > 50) verdict.push(`🟢 PnL net Asia >+$50 (${fmt(pnlUsd)}$) — bonne nuit`);
  if (gateCounts.CLIMAX_RUN + gateCounts.VERTICAL_PUMP + gateCounts.TOP_TICK_GUARD + gateCounts.CHOP_LONG_TF === 0 && flow > 30) {
    verdict.push('⚠️  0 trigger des 4 gates anti-OKLO sur 30+ signals — vérifier déploiement (sha doit être ≥ 7bf08ce)');
  }
  for (const v of verdict) console.log(`  ${v}`);

  console.log('\n═══════════════════════════════════════════════════════════════════════════════');
}

main().catch((e) => {
  console.error('Audit failed:', e);
  process.exit(1);
});
