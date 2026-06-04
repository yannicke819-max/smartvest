/**
 * Audit journalier observation A/B — quand on inhibe un filtre du scanner (paper).
 *
 * Méthode : compare une fenêtre TEST (depuis l'inhibition) à une BASELINE
 * historique (N jours juste avant). Mesure tout ce qui compte pour conclure
 * "favorable" / "neutre" / "défavorable" sur l'inhibition d'un filtre.
 *
 * Usage :
 *   # Auto : TEST = 24h, BASELINE = 5j avant
 *   npx tsx scripts/audit-filter-experiment.ts
 *
 *   # Custom : TEST depuis date précise, BASELINE 7j
 *   TEST_SINCE_UTC=2026-06-04T12:00:00Z BASELINE_DAYS=7 npx tsx scripts/audit-filter-experiment.ts
 *
 * Portfolio cible : TRADER b0000001 (override via PORTFOLIO_ID=...)
 */
import { createClient } from '@supabase/supabase-js';

const sb = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const TRADER = process.env.PORTFOLIO_ID || 'b0000001-0000-0000-0000-000000000001';
const now = new Date();
const TEST_SINCE = process.env.TEST_SINCE_UTC
  ? new Date(process.env.TEST_SINCE_UTC)
  : new Date(now.getTime() - 24 * 3600 * 1000);
const BASELINE_DAYS = Number(process.env.BASELINE_DAYS ?? 5);
const BASELINE_END = TEST_SINCE; // baseline finit où le test commence
const BASELINE_START = new Date(BASELINE_END.getTime() - BASELINE_DAYS * 24 * 3600 * 1000);

const TEST_HOURS = (now.getTime() - TEST_SINCE.getTime()) / 3600000;

function pct(n: number | null | undefined, d = 1): string {
  if (n == null || !Number.isFinite(n)) return 'n/a';
  return `${n.toFixed(d)}%`;
}
function fmt(n: number | null | undefined, d = 2): string {
  if (n == null || !Number.isFinite(n)) return 'n/a';
  return n.toFixed(d);
}

interface Stats {
  signalsTotal: number;
  signalsByDecision: Map<string, number>;
  signalsAccept: number;
  opens: number;
  closed: number;
  open: number;
  tp: number;
  sl: number;
  invalidated: number;
  other: number;
  pnlSum: number;
  pnlPctSum: number;
  pnlPositiveCount: number;
  avgHoldMin: number;
  mfePctSum: number;
  mfeN: number;
  peakSumPct: number;
  peakN: number;
  gateTriggers: Map<string, number>;
  verdicts: Map<string, number>;
  giveBacks: number[];
}

function emptyStats(): Stats {
  return {
    signalsTotal: 0, signalsByDecision: new Map(), signalsAccept: 0,
    opens: 0, closed: 0, open: 0, tp: 0, sl: 0, invalidated: 0, other: 0,
    pnlSum: 0, pnlPctSum: 0, pnlPositiveCount: 0, avgHoldMin: 0,
    mfePctSum: 0, mfeN: 0, peakSumPct: 0, peakN: 0,
    gateTriggers: new Map(), verdicts: new Map(), giveBacks: [],
  };
}

async function gatherStats(label: string, since: Date, until: Date): Promise<Stats> {
  const s = emptyStats();
  const sinceIso = since.toISOString();
  const untilIso = until.toISOString();

  // 1) Shadow signals (decisions = breakdown des rejets)
  let from = 0; const PAGE = 1000;
  for (;;) {
    const { data, error } = await sb.from('gainers_user_shadow_signals')
      .select('decision').eq('portfolio_id', TRADER)
      .gte('created_at', sinceIso).lte('created_at', untilIso)
      .range(from, from + PAGE - 1);
    if (error) { console.warn(`[${label}] shadow err:`, error.message); break; }
    if (!data || data.length === 0) break;
    for (const r of data) {
      s.signalsTotal++;
      s.signalsByDecision.set(r.decision, (s.signalsByDecision.get(r.decision) ?? 0) + 1);
      if (r.decision === 'accept') s.signalsAccept++;
    }
    if (data.length < PAGE) break;
    from += PAGE; if (from > 30000) break;
  }

  // 2) Positions ouvertes pendant cette fenêtre
  const { data: opens } = await sb.from('lisa_positions')
    .select('symbol, status, entry_price, entry_timestamp, exit_price, exit_timestamp, exit_reason, realized_pnl_usd, realized_pnl_pct, peak_pre_exit, asset_class')
    .eq('portfolio_id', TRADER)
    .gte('entry_timestamp', sinceIso).lte('entry_timestamp', untilIso);
  s.opens = opens?.length ?? 0;
  let holdSum = 0;
  for (const p of opens ?? []) {
    if (p.status === 'open') s.open++;
    else {
      s.closed++;
      if (p.exit_reason?.toLowerCase().includes('stop')) s.sl++;
      else if (p.exit_reason?.toLowerCase().includes('target') || p.exit_reason?.toLowerCase().includes('tp')) s.tp++;
      else if (p.status === 'closed_invalidated') s.invalidated++;
      else s.other++;
      s.pnlSum += Number(p.realized_pnl_usd ?? 0);
      s.pnlPctSum += Number(p.realized_pnl_pct ?? 0);
      if ((p.realized_pnl_usd ?? 0) > 0) s.pnlPositiveCount++;
      if (p.exit_timestamp) {
        holdSum += (new Date(p.exit_timestamp).getTime() - new Date(p.entry_timestamp).getTime()) / 60000;
      }
      // Peak-to-entry % (proxy MFE simple)
      const peak = Number(p.peak_pre_exit ?? 0);
      const entry = Number(p.entry_price ?? 0);
      if (peak > 0 && entry > 0) {
        s.peakSumPct += ((peak - entry) / entry) * 100;
        s.peakN++;
      }
    }
  }
  if (s.closed > 0) s.avgHoldMin = holdSum / s.closed;

  // 3) Gate triggers (decision_log scanner_candidate_skip + position_open_failed)
  const { data: gates } = await sb.from('lisa_decision_log')
    .select('payload, kind, summary')
    .eq('portfolio_id', TRADER)
    .in('kind', ['scanner_candidate_skip', 'position_open_failed'])
    .gte('timestamp', sinceIso).lte('timestamp', untilIso);
  for (const r of gates ?? []) {
    const payload = (r.payload ?? {}) as Record<string, unknown>;
    let g = String(payload.gate ?? payload.error_class ?? 'unknown');
    // Aussi détecter via summary pour rétrocompat
    const sum = String(r.summary ?? '');
    for (const tag of ['CLIMAX_RUN', 'VERTICAL_PUMP', 'CHOP_LONG_TF', 'TOP_TICK_GUARD']) {
      if (sum.includes(tag) && g === 'unknown') g = tag;
    }
    s.gateTriggers.set(g, (s.gateTriggers.get(g) ?? 0) + 1);
  }

  // 4) Close decisions + counterfactual verdicts (position_close_decisions)
  const { data: closeDecs } = await sb.from('position_close_decisions')
    .select('verdict, give_back_from_mfe, mfe_pct, mae_pct, raw_payload')
    .eq('portfolio_id', TRADER)
    .gte('closed_at', sinceIso).lte('closed_at', untilIso);
  for (const c of closeDecs ?? []) {
    const v = c.verdict ?? 'pending';
    s.verdicts.set(v, (s.verdicts.get(v) ?? 0) + 1);
    if (c.give_back_from_mfe != null && (c.mfe_pct ?? 0) > 0) s.giveBacks.push(Number(c.give_back_from_mfe));
    if (c.mfe_pct != null) { s.mfePctSum += Number(c.mfe_pct); s.mfeN++; }
  }

  return s;
}

function ratePer24h(value: number, fenêtreHours: number): number {
  return fenêtreHours > 0 ? value * (24 / fenêtreHours) : 0;
}

function dumpStats(label: string, s: Stats, hours: number) {
  console.log(`\n━━━ ${label} (fenêtre ${hours.toFixed(1)}h) ━━━`);
  console.log(`Signals captés    : ${s.signalsTotal} (≈ ${ratePer24h(s.signalsTotal, hours).toFixed(0)}/24h)`);
  console.log(`  → accept        : ${s.signalsAccept} (${pct((s.signalsAccept / Math.max(s.signalsTotal, 1)) * 100)})`);
  const topRej = [...s.signalsByDecision.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  for (const [d, n] of topRej) {
    if (d === 'accept') continue;
    console.log(`  → ${d.padEnd(26)} ${n}`);
  }
  console.log(`Opens             : ${s.opens} (≈ ${ratePer24h(s.opens, hours).toFixed(1)}/24h)`);
  console.log(`  closed=${s.closed} open=${s.open}  [TP=${s.tp} SL=${s.sl} INV=${s.invalidated} OTHER=${s.other}]`);
  const wr = s.closed > 0 ? (s.pnlPositiveCount / s.closed) * 100 : null;
  console.log(`  WR (pnl>0)      : ${pct(wr)}`);
  console.log(`  Σ PnL USD       : $${fmt(s.pnlSum)}`);
  console.log(`  Σ PnL %         : ${fmt(s.pnlPctSum)}%   avg/trade=${fmt(s.closed > 0 ? s.pnlPctSum / s.closed : null)}%`);
  console.log(`  avg hold        : ${fmt(s.avgHoldMin)} min`);
  console.log(`  avg peak->entry : ${pct(s.peakN > 0 ? s.peakSumPct / s.peakN : null)} (proxy MFE)`);
  if (s.gateTriggers.size > 0) {
    console.log(`Gate triggers (anti-OKLO + autres) :`);
    for (const [g, n] of [...s.gateTriggers.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
      console.log(`  ${g.padEnd(28)} ${n}`);
    }
  }
  if (closeDecs(s)) {
    console.log(`Counterfactual verdicts :`);
    for (const [v, n] of [...s.verdicts.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${v.padEnd(12)} ${n}`);
    }
    if (s.giveBacks.length > 0) {
      const gb = s.giveBacks.slice().sort((a, b) => a - b);
      const median = gb[Math.floor(gb.length / 2)];
      console.log(`  give-back from MFE (n=${gb.length}): median=${fmt(median)}pt`);
    }
  }
}
function closeDecs(s: Stats): boolean { return s.verdicts.size > 0 || s.giveBacks.length > 0; }

function delta(a: number, b: number, asPct = false): string {
  const d = a - b;
  const sign = d > 0 ? '+' : '';
  return asPct ? `${sign}${d.toFixed(1)}%` : `${sign}${d.toFixed(2)}`;
}

function comparePerDay(testStats: Stats, baseStats: Stats, testHours: number, baseHours: number) {
  console.log('\n═══ COMPARAISON TEST vs BASELINE (rates par 24h) ═══');
  const sigT = ratePer24h(testStats.signalsTotal, testHours);
  const sigB = ratePer24h(baseStats.signalsTotal, baseHours);
  console.log(`Signals/24h       : TEST=${sigT.toFixed(0)}  BASE=${sigB.toFixed(0)}  Δ=${delta(sigT, sigB)}`);

  const accT = ratePer24h(testStats.signalsAccept, testHours);
  const accB = ratePer24h(baseStats.signalsAccept, baseHours);
  console.log(`Accepts/24h       : TEST=${accT.toFixed(1)}  BASE=${accB.toFixed(1)}  Δ=${delta(accT, accB)}`);

  const opT = ratePer24h(testStats.opens, testHours);
  const opB = ratePer24h(baseStats.opens, baseHours);
  console.log(`Opens/24h         : TEST=${opT.toFixed(2)}  BASE=${opB.toFixed(2)}  Δ=${delta(opT, opB)}`);

  const wrT = testStats.closed > 0 ? (testStats.pnlPositiveCount / testStats.closed) * 100 : null;
  const wrB = baseStats.closed > 0 ? (baseStats.pnlPositiveCount / baseStats.closed) * 100 : null;
  console.log(`WR closed         : TEST=${pct(wrT, 0)} (n=${testStats.closed})  BASE=${pct(wrB, 0)} (n=${baseStats.closed})`);

  const expT = testStats.closed > 0 ? testStats.pnlPctSum / testStats.closed : null;
  const expB = baseStats.closed > 0 ? baseStats.pnlPctSum / baseStats.closed : null;
  console.log(`Expectancy/trade  : TEST=${pct(expT, 2)}  BASE=${pct(expB, 2)}`);

  const pnlT = ratePer24h(testStats.pnlSum, testHours);
  const pnlB = ratePer24h(baseStats.pnlSum, baseHours);
  console.log(`Σ PnL USD / 24h   : TEST=$${pnlT.toFixed(2)}  BASE=$${pnlB.toFixed(2)}  Δ=$${(pnlT - pnlB).toFixed(2)}/jour`);

  // Verdict automatique
  console.log('\n═══ VERDICT ═══');
  const lines: string[] = [];
  if (testStats.closed < 10) {
    lines.push(`⚠️  N test trop faible (closed=${testStats.closed}) — attendre 24h de plus avant conclusion fiable.`);
  } else {
    if (wrT != null && wrB != null) {
      if (wrT < 35 && wrB >= 35) lines.push(`🔴 WR effondre (${wrT.toFixed(0)}% vs ${wrB.toFixed(0)}%) — défavorable.`);
      else if (wrT > wrB + 5) lines.push(`🟢 WR amélioré (+${(wrT - wrB).toFixed(0)}pt) — favorable.`);
      else lines.push(`🟡 WR stable (${wrT.toFixed(0)}% vs ${wrB.toFixed(0)}%) — neutre.`);
    }
    if (expT != null && expB != null) {
      if (expT < 0 && expT < expB - 0.2) lines.push(`🔴 Expectancy se dégrade (${expT.toFixed(2)}% vs ${expB.toFixed(2)}%).`);
      else if (expT > 0 && expT > expB + 0.1) lines.push(`🟢 Expectancy s'améliore (${expT.toFixed(2)}% vs ${expB.toFixed(2)}%).`);
      else lines.push(`🟡 Expectancy stable (${expT.toFixed(2)}% vs ${expB.toFixed(2)}%).`);
    }
    const pnlDiff = pnlT - pnlB;
    if (pnlDiff < -10) lines.push(`🔴 PnL/jour pire de $${(-pnlDiff).toFixed(0)} → expérience défavorable.`);
    else if (pnlDiff > 10) lines.push(`🟢 PnL/jour meilleur de +$${pnlDiff.toFixed(0)} → expérience favorable.`);
    if (opT > opB * 1.5 && expT != null && expT < 0) {
      lines.push(`🔴 Flux ouvert (${(opT / opB).toFixed(1)}× plus d'opens) MAIS expectancy négatif → tu accélères les pertes.`);
    }
    if (opT > opB * 1.5 && expT != null && expT > 0) {
      lines.push(`🟢 Flux ouvert avec expectancy positif → le filtre inhibé bloquait des trades GAGNANTS.`);
    }
  }
  for (const l of lines) console.log(`  ${l}`);
  if (lines.length === 0) console.log('  (pas de signal fort, continuer l\'observation)');
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════════════════════════');
  console.log(`  AUDIT EXPÉRIENCE INHIBITION FILTRE — TRADER ${TRADER.slice(0, 8)}`);
  console.log(`  TEST     : ${TEST_SINCE.toISOString()} → ${now.toISOString()}  (${TEST_HOURS.toFixed(1)}h)`);
  console.log(`  BASELINE : ${BASELINE_START.toISOString()} → ${BASELINE_END.toISOString()}  (${(BASELINE_DAYS * 24).toFixed(0)}h)`);
  console.log('═══════════════════════════════════════════════════════════════════════════════');

  // Config actuelle (pour vérifier que l'inhibition est bien en place)
  const { data: cfg } = await sb.from('lisa_session_configs')
    .select('gainers_min_persistence_score, gainers_min_path_efficiency, gainers_asia_strictness_boost, gainers_min_change_pct_asia, autopilot_enabled, kill_switch_active')
    .eq('portfolio_id', TRADER).maybeSingle();
  console.log('\nConfig courante :');
  console.log(`  persistence_score=${cfg?.gainers_min_persistence_score}  path_eff=${cfg?.gainers_min_path_efficiency}  asia_boost=${cfg?.gainers_asia_strictness_boost}`);
  console.log(`  autopilot=${cfg?.autopilot_enabled}  kill_switch=${cfg?.kill_switch_active}`);

  const [testStats, baseStats] = await Promise.all([
    gatherStats('TEST', TEST_SINCE, now),
    gatherStats('BASELINE', BASELINE_START, BASELINE_END),
  ]);

  dumpStats('TEST', testStats, TEST_HOURS);
  dumpStats('BASELINE', baseStats, BASELINE_DAYS * 24);
  comparePerDay(testStats, baseStats, TEST_HOURS, BASELINE_DAYS * 24);

  console.log('\n═══════════════════════════════════════════════════════════════════════════════');
}

main().catch((e) => { console.error('Audit failed:', e); process.exit(1); });
