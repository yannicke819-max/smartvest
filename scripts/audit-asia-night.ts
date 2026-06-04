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

interface ShadowRow { decision: string; symbol: string; change_pct_1m: number | null; created_at: string; asset_class?: string; }
interface PositionRow {
  symbol: string; asset_class: string; status: string;
  entry_price: number; entry_timestamp: string;
  exit_price: number | null; exit_timestamp: string | null;
  exit_reason: string | null; realized_pnl_usd: number | null; realized_pnl_pct: number | null;
  peak_pre_exit: number | null;
}
interface DecisionLogRow { kind: string; summary: string; timestamp: string; payload: Record<string, unknown> | null; }
interface SnapshotRow { position_id: string; symbol: string; live_price: number | null; pnl_pct: number | null; mfe_pct: number | null; mae_pct: number | null; mae_r_ratio: number | null; rsi14: number | null; adx14: number | null; bb_pct_b: number | null; captured_at: string; }
interface CloseDecisionRow { symbol: string; asset_class: string; closer_type: string; pnl_pct: number | null; mfe_pct: number | null; mae_pct: number | null; give_back_from_mfe: number | null; verdict: string | null; raw_payload: Record<string, unknown> | null; closed_at: string; max_favorable_after_60m_pct: number | null; }

async function fetchShadowSignals(since: string, until: string): Promise<ShadowRow[]> {
  const { data, error } = await sb.from('gainers_user_shadow_signals')
    .select('decision, symbol, change_pct_1m, created_at, asset_class')
    .eq('portfolio_id', TRADER)
    .eq('asset_class', 'asia_equity')
    .gte('created_at', since).lte('created_at', until)
    .order('created_at', { ascending: true });
  if (error) console.error('  ⚠ shadow signals fetch err:', error.message);
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

  // === 4. Tracker snapshots (Asia positions ouvertes pendant la nuit) ===
  console.log('\n━━━ 4. TRACKER SNAPSHOTS (position_indicators_snapshot) ━━━━━━━━━━━━━━━━━━━━━');
  const { data: snapshots } = await sb.from('position_indicators_snapshot')
    .select('position_id, symbol, live_price, pnl_pct, mfe_pct, mae_pct, mae_r_ratio, rsi14, adx14, bb_pct_b, captured_at')
    .eq('portfolio_id', TRADER)
    .gte('captured_at', SINCE).lte('captured_at', UNTIL)
    .order('captured_at', { ascending: false }).limit(500) as { data: SnapshotRow[] | null };

  if (!snapshots || snapshots.length === 0) {
    console.log('  → 0 snapshot Asia capturé pendant la fenêtre.');
    console.log('    Causes possibles :');
    console.log('    - 0 position Asia ouverte → cron tracker n\'a rien à snapshot (normal)');
    console.log('    - POSITION_TRACKER_ENABLED=false en prod → service inerte (vérifier Fly secrets)');
    console.log('    - EODHD/Binance fetch candles échouent en boucle');
  } else {
    const byPosition = new Map<string, SnapshotRow[]>();
    for (const s of snapshots) {
      if (!byPosition.has(s.position_id)) byPosition.set(s.position_id, []);
      byPosition.get(s.position_id)!.push(s);
    }
    console.log(`  Snapshots fenêtre : ${snapshots.length} sur ${byPosition.size} position(s) distincte(s)`);
    console.log(`  Cycle moyen / position : ${(snapshots.length / Math.max(byPosition.size, 1)).toFixed(1)} snapshots`);
    console.log('\n  Évolution par position (1ère/médiane/dernière snapshot) :');
    for (const [posId, snaps] of byPosition) {
      const ordered = snaps.slice().sort((a, b) => new Date(a.captured_at).getTime() - new Date(b.captured_at).getTime());
      const first = ordered[0];
      const last = ordered[ordered.length - 1];
      const mid = ordered[Math.floor(ordered.length / 2)];
      const sym = first.symbol.padEnd(15);
      console.log(`    ${sym} (n=${ordered.length})`);
      console.log(`      first : px=${fmt(first.live_price, 4)} pnl=${pct(first.pnl_pct)} mfe=${pct(first.mfe_pct)} mae=${pct(first.mae_pct)} mae_R=${fmt(first.mae_r_ratio, 2)}`);
      console.log(`      mid   : px=${fmt(mid.live_price, 4)} pnl=${pct(mid.pnl_pct)} mfe=${pct(mid.mfe_pct)} rsi=${fmt(mid.rsi14, 1)} adx=${fmt(mid.adx14, 1)} bb%=${fmt(mid.bb_pct_b, 2)}`);
      console.log(`      last  : px=${fmt(last.live_price, 4)} pnl=${pct(last.pnl_pct)} mfe=${pct(last.mfe_pct)} mae=${pct(last.mae_pct)} mae_R=${fmt(last.mae_r_ratio, 2)}`);
    }
  }

  // === 5. Close decisions verdict (counterfactual labeling) ===
  console.log('\n━━━ 5. CLOSE DECISIONS (counterfactual labeling) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  const { data: closeDecs } = await sb.from('position_close_decisions')
    .select('symbol, asset_class, closer_type, pnl_pct, mfe_pct, mae_pct, give_back_from_mfe, verdict, raw_payload, closed_at, max_favorable_after_60m_pct')
    .eq('portfolio_id', TRADER)
    .eq('asset_class', 'asia_equity')
    .gte('closed_at', SINCE).lte('closed_at', UNTIL)
    .order('closed_at', { ascending: false }).limit(50) as { data: CloseDecisionRow[] | null };

  if (!closeDecs || closeDecs.length === 0) {
    console.log('  → 0 close Asia capturé. Cohérent avec 0 closed dans section 2.');
  } else {
    const verdictCounts = new Map<string, number>();
    const labelReasonCounts = new Map<string, number>();
    for (const c of closeDecs) {
      const v = c.verdict ?? 'pending';
      verdictCounts.set(v, (verdictCounts.get(v) ?? 0) + 1);
      const reason = (c.raw_payload?.label_reason as string | undefined) ?? 'none';
      labelReasonCounts.set(reason, (labelReasonCounts.get(reason) ?? 0) + 1);
    }
    console.log(`  Total closes Asia : ${closeDecs.length}`);
    console.log('\n  Verdict breakdown :');
    for (const [v, n] of [...verdictCounts.entries()].sort((a, b) => b[1] - a[1])) {
      const pctOf = (n / closeDecs.length) * 100;
      console.log(`    ${v.padEnd(10)} ${String(n).padStart(3)} (${pctOf.toFixed(0).padStart(3)}%)`);
    }

    console.log('\n  Label_reason breakdown (raw_payload) :');
    for (const [r, n] of [...labelReasonCounts.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${r.padEnd(25)} ${String(n).padStart(3)}`);
    }

    // Stats give_back (sur closes avec MFE > 0)
    const withGiveBack = closeDecs.filter(c => c.give_back_from_mfe != null && c.mfe_pct != null && c.mfe_pct > 0);
    if (withGiveBack.length > 0) {
      const giveBacks = withGiveBack.map(c => c.give_back_from_mfe!).sort((a, b) => a - b);
      const median = giveBacks[Math.floor(giveBacks.length / 2)];
      const avg = giveBacks.reduce((s, n) => s + n, 0) / giveBacks.length;
      const max = giveBacks[giveBacks.length - 1];
      console.log(`\n  Give-back from MFE (n=${withGiveBack.length} closes avec MFE>0) :`);
      console.log(`    median=${fmt(median, 2)}pt · avg=${fmt(avg, 2)}pt · max=${fmt(max, 2)}pt`);
      console.log(`    → seuil trailing recommandé (par exit-policy) : ~${fmt(Math.min(median * 1.5, 1.5), 2)}pt`);
    }

    // EARLY signaling : combien d'exits sortis trop tôt ?
    const earlyCount = verdictCounts.get('EARLY') ?? 0;
    const goodCount = verdictCounts.get('GOOD') ?? 0;
    if (earlyCount + goodCount > 0) {
      const earlyRate = (earlyCount / (earlyCount + goodCount)) * 100;
      console.log(`\n  EARLY rate (vs GOOD+EARLY) : ${earlyRate.toFixed(0)}%`);
      if (earlyRate > 50) console.log('    ⚠️  TRADER sort trop tôt — review trailing rule + TP discipline');
    }
  }

  // === 6. Net verdict ===
  console.log('\n━━━ 6. VERDICT NUIT ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
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
