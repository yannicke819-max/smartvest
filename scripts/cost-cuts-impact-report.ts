// scripts/cost-cuts-impact-report.ts
//
// Compare les métriques clés AVANT vs APRÈS le merge des PRs cost-cuts du 31/05.
// À exécuter dans 3-7 jours pour valider l'impact qualitatif.
//
// Usage :
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... pnpm tsx scripts/cost-cuts-impact-report.ts
//
// Options :
//   --cutoff=2026-05-31T05:00:00Z  (date du merge PR #505, default = depuis ENV ou hardcoded)
//   --days-before=7  (window avant le cutoff)
//   --days-after=7   (window après le cutoff)
//
// Métriques produites :
//   1. Volume décisions TRADER : total, skip_empty, hold, open
//   2. Outcomes positions ouvertes (TRADER + Shadows) : win rate, avg PnL, sum PnL
//   3. A/B Pro vs Flash : concordance %, divergences avec outcomes
//   4. Coût Gemini interne (sous-déclaré mais comparable avant/après)
//   5. Signal d'alerte : flags si dégradation observée

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('ERR: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY required');
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

// PR #505 mergée 31/05 ~04:55 UTC
const DEFAULT_CUTOFF = '2026-05-31T05:00:00Z';

function parseArgs(): { cutoff: string; daysBefore: number; daysAfter: number } {
  const args = process.argv.slice(2);
  let cutoff = DEFAULT_CUTOFF;
  let daysBefore = 7;
  let daysAfter = 7;
  for (const arg of args) {
    if (arg.startsWith('--cutoff=')) cutoff = arg.slice('--cutoff='.length);
    if (arg.startsWith('--days-before=')) daysBefore = Number.parseInt(arg.slice('--days-before='.length), 10);
    if (arg.startsWith('--days-after=')) daysAfter = Number.parseInt(arg.slice('--days-after='.length), 10);
  }
  return { cutoff, daysBefore, daysAfter };
}

const TRADER_PID = 'b0000001-0000-0000-0000-000000000001';
const SHADOW_PIDS = {
  HIGH: 'a0000001-0000-0000-0000-000000000001',
  MIDDLE: 'a0000002-0000-0000-0000-000000000002',
  SMALL: 'a0000003-0000-0000-0000-000000000003',
};
const ALL_PIDS = [TRADER_PID, ...Object.values(SHADOW_PIDS)];

function pad(s: string | number, n: number): string {
  return String(s).padEnd(n);
}

function pct(numer: number, denom: number): string {
  if (denom === 0) return '—';
  return `${((numer / denom) * 100).toFixed(1)}%`;
}

async function metricTraderDecisions(beforeIso: string, cutoffIso: string, afterIso: string) {
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log(' 1. VOLUME DÉCISIONS TRADER (cycles actifs vs vides)');
  console.log('═══════════════════════════════════════════════════════════════');

  for (const [label, startIso, endIso] of [
    ['AVANT', beforeIso, cutoffIso],
    ['APRÈS', cutoffIso, afterIso],
  ] as const) {
    const { data, error } = await sb
      .from('trader_agent_decisions')
      .select('action_kind, confidence, thesis')
      .gte('decided_at', startIso)
      .lte('decided_at', endIso)
      .eq('portfolio_id', TRADER_PID);
    if (error) {
      console.log(`  ${label}: erreur ${error.message}`);
      continue;
    }
    const rows = data ?? [];
    const skipped = rows.filter((r) => (r.thesis ?? '').includes('SKIP_LLM_EMPTY_CONTEXT')).length;
    const cycleTicks = rows.filter((r) => (r.thesis ?? '').includes('CYCLE_TICK')).length;
    const realDecisions = rows.filter((r) => (r.confidence ?? 0) > 0).length;
    const holds = rows.filter((r) => r.action_kind === 'hold' && (r.confidence ?? 0) > 0).length;
    const opens = rows.filter((r) => r.action_kind === 'open_directional' && (r.confidence ?? 0) > 0).length;
    const avgConf = realDecisions > 0
      ? rows.reduce((s, r) => s + (Number(r.confidence) || 0), 0) / realDecisions
      : 0;
    console.log(`  ${pad(label, 6)}  total=${pad(rows.length, 6)}  real=${pad(realDecisions, 4)}  hold=${pad(holds, 4)}  open=${pad(opens, 3)}  skip_empty=${pad(skipped, 4)}  cycle_tick=${pad(cycleTicks, 5)}  avg_conf=${avgConf.toFixed(2)}`);
  }
}

async function metricPositionOutcomes(beforeIso: string, cutoffIso: string, afterIso: string) {
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log(' 2. OUTCOMES POSITIONS (toutes portfolios)');
  console.log('═══════════════════════════════════════════════════════════════');

  for (const [label, startIso, endIso] of [
    ['AVANT', beforeIso, cutoffIso],
    ['APRÈS', cutoffIso, afterIso],
  ] as const) {
    const { data, error } = await sb
      .from('lisa_positions')
      .select('symbol, realized_pnl_usd, exit_reason, exit_timestamp, portfolio_id')
      .gte('exit_timestamp', startIso)
      .lte('exit_timestamp', endIso)
      .in('portfolio_id', ALL_PIDS);
    if (error) {
      console.log(`  ${label}: erreur ${error.message}`);
      continue;
    }
    const closed = data ?? [];
    const wins = closed.filter((c) => Number(c.realized_pnl_usd ?? 0) > 0).length;
    const losses = closed.filter((c) => Number(c.realized_pnl_usd ?? 0) < 0).length;
    const sumPnl = closed.reduce((s, c) => s + Number(c.realized_pnl_usd ?? 0), 0);
    const avgPnl = closed.length > 0 ? sumPnl / closed.length : 0;
    console.log(`  ${pad(label, 6)}  closes=${pad(closed.length, 4)}  win_rate=${pct(wins, closed.length)}  wins=${wins}  losses=${losses}  sum_pnl=$${sumPnl.toFixed(2)}  avg=$${avgPnl.toFixed(2)}`);
    // breakdown par exit_reason
    const reasons = new Map<string, number>();
    for (const c of closed) reasons.set(c.exit_reason ?? 'unknown', (reasons.get(c.exit_reason ?? 'unknown') ?? 0) + 1);
    if (reasons.size > 0) {
      const sorted = [...reasons.entries()].sort((a, b) => b[1] - a[1]);
      console.log(`         exit_reasons: ${sorted.map(([k, v]) => `${k}=${v}`).join(', ')}`);
    }
  }
}

async function metricInternalCost(beforeIso: string, cutoffIso: string, afterIso: string) {
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log(' 3. COÛT GEMINI INTERNE (tracking sous-déclaré mais comparable)');
  console.log('═══════════════════════════════════════════════════════════════');

  for (const [label, startIso, endIso] of [
    ['AVANT', beforeIso, cutoffIso],
    ['APRÈS', cutoffIso, afterIso],
  ] as const) {
    const startDate = startIso.slice(0, 10);
    const endDate = endIso.slice(0, 10);
    const { data, error } = await sb
      .from('api_costs_daily')
      .select('date, total_usd, by_model')
      .gte('date', startDate)
      .lte('date', endDate)
      .order('date', { ascending: true });
    if (error) {
      console.log(`  ${label}: erreur ${error.message}`);
      continue;
    }
    const rows = data ?? [];
    let geminiTotal = 0;
    let claudeTotal = 0;
    for (const r of rows) {
      const byModel = (r.by_model as Record<string, number> | null) ?? {};
      for (const [m, cost] of Object.entries(byModel)) {
        if (m.toLowerCase().includes('gemini')) geminiTotal += Number(cost) || 0;
        else if (m.toLowerCase().includes('claude')) claudeTotal += Number(cost) || 0;
      }
    }
    const days = rows.length;
    const avgPerDay = days > 0 ? geminiTotal / days : 0;
    console.log(`  ${pad(label, 6)}  days=${pad(days, 3)}  gemini_total=$${geminiTotal.toFixed(2)}  claude_total=$${claudeTotal.toFixed(2)}  gemini_avg/day=$${avgPerDay.toFixed(3)}`);
  }
  console.log('  ℹ Le tracking interne sous-déclare 5-50× la facturation Google réelle.');
  console.log('    Vérifier https://aistudio.google.com/usage pour les vrais chiffres.');
}

async function metricAbProVsFlash() {
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log(' 4. A/B PRO vs FLASH (PR #508 — collecte continue)');
  console.log('═══════════════════════════════════════════════════════════════');

  const { data, error } = await sb
    .from('gemini_ab_decisions')
    .select('concordance_full, concordance_action_kind, concordance_target_symbol, confidence_delta, pro_cost_usd, flash_cost_usd, flash_call_error, pro_action_kind, flash_action_kind, decided_at');
  if (error) {
    console.log(`  erreur ${error.message}`);
    return;
  }
  const rows = data ?? [];
  if (rows.length === 0) {
    console.log('  Aucune donnée A/B collectée pour l\'instant. Attendre quelques cycles TRADER.');
    return;
  }

  const total = rows.length;
  const flashParsed = rows.filter((r) => r.flash_call_error === null).length;
  const concordFull = rows.filter((r) => r.concordance_full === true).length;
  const concordAction = rows.filter((r) => r.concordance_action_kind === true).length;
  const sumProCost = rows.reduce((s, r) => s + (Number(r.pro_cost_usd) || 0), 0);
  const sumFlashCost = rows.reduce((s, r) => s + (Number(r.flash_cost_usd) || 0), 0);
  const avgConfDelta = rows
    .filter((r) => r.confidence_delta !== null)
    .reduce((s, r, _, arr) => s + (Number(r.confidence_delta) || 0) / arr.length, 0);

  console.log(`  Cycles A/B : ${total}  (Flash parsed OK : ${flashParsed}, ${pct(flashParsed, total)})`);
  console.log(`  Concordance full      : ${concordFull} / ${total} (${pct(concordFull, total)})`);
  console.log(`  Concordance action    : ${concordAction} / ${total} (${pct(concordAction, total)})`);
  console.log(`  Confidence delta moy  : ${avgConfDelta.toFixed(3)}  (Pro - Flash, positif = Pro plus confiant)`);
  console.log(`  Coût total Pro        : $${sumProCost.toFixed(4)}`);
  console.log(`  Coût total Flash      : $${sumFlashCost.toFixed(4)}`);
  console.log(`  Ratio Pro / Flash     : ${sumFlashCost > 0 ? (sumProCost / sumFlashCost).toFixed(1) + '×' : '—'}`);

  // Divergences action_kind
  const divergent = rows.filter((r) => r.concordance_action_kind === false);
  if (divergent.length > 0) {
    console.log(`\n  Divergences action_kind (échantillon top 5) :`);
    for (const d of divergent.slice(0, 5)) {
      console.log(`    ${d.decided_at?.slice(11, 19)}  Pro=${d.pro_action_kind}  Flash=${d.flash_action_kind}`);
    }
  }

  // Verdict
  console.log('\n  Recommandation :');
  if (total < 100) {
    console.log(`    ⏳ Échantillon trop petit (${total} cycles). Attendre 7 jours minimum (~2000 cycles).`);
  } else {
    const concordPct = concordFull / total;
    if (concordPct >= 0.90) {
      console.log(`    ✅ Concordance ${pct(concordFull, total)} ≥ 90% — migration TRADER vers Flash recommandée (économie ~$14/j).`);
    } else if (concordPct >= 0.75) {
      console.log(`    🟡 Concordance ${pct(concordFull, total)} ∈ [75%, 90%[ — étude des divergences nécessaire (qui a raison ?).`);
    } else {
      console.log(`    🔴 Concordance ${pct(concordFull, total)} < 75% — garder Pro, Flash sous-performe.`);
    }
  }
}

async function metricAlertSignals(afterIso: string) {
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log(' 5. SIGNAUX D\'ALERTE (post-cuts)');
  console.log('═══════════════════════════════════════════════════════════════');

  const alerts: string[] = [];

  // Alerte #1 : Win rate < 40% sur >10 trades
  const { data: closes } = await sb
    .from('lisa_positions')
    .select('realized_pnl_usd')
    .gte('exit_timestamp', afterIso)
    .in('portfolio_id', ALL_PIDS);
  const closesArr = closes ?? [];
  if (closesArr.length >= 10) {
    const wr = closesArr.filter((c) => Number(c.realized_pnl_usd ?? 0) > 0).length / closesArr.length;
    if (wr < 0.4) {
      alerts.push(`🔴 Win rate ${(wr * 100).toFixed(1)}% < 40% sur ${closesArr.length} trades (cible : ≥ 50%)`);
    } else {
      console.log(`  ✅ Win rate ${(wr * 100).toFixed(1)}% sur ${closesArr.length} trades`);
    }
  } else {
    console.log(`  ℹ Trop peu de trades fermés (${closesArr.length}) pour évaluer win rate`);
  }

  // Alerte #2 : TRADER 0 trade en weekday (Lun-Ven 14:30-21:00 UTC = US open)
  const now = new Date();
  const dayOfWeek = now.getUTCDay();
  if (dayOfWeek >= 1 && dayOfWeek <= 5) {
    const { count } = await sb
      .from('lisa_positions')
      .select('id', { count: 'exact', head: true })
      .gte('entry_timestamp', afterIso)
      .eq('portfolio_id', TRADER_PID);
    if ((count ?? 0) === 0) {
      const hoursElapsed = (Date.now() - new Date(afterIso).getTime()) / (1000 * 3600);
      if (hoursElapsed > 24) {
        alerts.push(`🔴 TRADER 0 trade en ${hoursElapsed.toFixed(0)}h weekday — soupçon de blocage par les cuts`);
      }
    }
  }

  // Alerte #3 : Pic Gemini cost
  const today = new Date().toISOString().slice(0, 10);
  const { data: todayCost } = await sb
    .from('api_costs_daily')
    .select('total_usd, by_model')
    .eq('date', today)
    .maybeSingle();
  if (todayCost) {
    const byModel = (todayCost.by_model as Record<string, number> | null) ?? {};
    const geminiToday = Object.entries(byModel)
      .filter(([m]) => m.toLowerCase().includes('gemini'))
      .reduce((s, [, c]) => s + (Number(c) || 0), 0);
    if (geminiToday >= 20) {
      alerts.push(`🟡 Coût Gemini today $${geminiToday.toFixed(2)} ≥ $20 — proche du cap $30/j`);
    } else {
      console.log(`  ✅ Coût Gemini today $${geminiToday.toFixed(2)} / cap $30`);
    }
  }

  if (alerts.length > 0) {
    console.log('\n  ALERTES :');
    for (const a of alerts) console.log(`    ${a}`);
  } else {
    console.log('\n  ✅ Aucune alerte critique détectée.');
  }
}

(async () => {
  const { cutoff, daysBefore, daysAfter } = parseArgs();
  const cutoffMs = new Date(cutoff).getTime();
  const beforeIso = new Date(cutoffMs - daysBefore * 86_400_000).toISOString();
  const afterIso = new Date(cutoffMs + daysAfter * 86_400_000).toISOString();

  console.log('╔═══════════════════════════════════════════════════════════════');
  console.log(`║ COST-CUTS IMPACT REPORT`);
  console.log(`║ Cutoff (PR mergées) : ${cutoff}`);
  console.log(`║ Fenêtre AVANT : ${beforeIso} → ${cutoff} (${daysBefore} jours)`);
  console.log(`║ Fenêtre APRÈS : ${cutoff} → ${afterIso} (${daysAfter} jours)`);
  console.log(`║ Now            : ${new Date().toISOString()}`);
  console.log('╚═══════════════════════════════════════════════════════════════');

  await metricTraderDecisions(beforeIso, cutoff, afterIso);
  await metricPositionOutcomes(beforeIso, cutoff, afterIso);
  await metricInternalCost(beforeIso, cutoff, afterIso);
  await metricAbProVsFlash();
  await metricAlertSignals(cutoff);

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log(' COMPLÉMENTS À VÉRIFIER MANUELLEMENT');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  - Facturation Google AI Studio : https://aistudio.google.com/usage');
  console.log('    (le tracking interne sous-déclare 5-50× le coût réel)');
  console.log('  - Fly logs : surveiller "kill-switch" / "BUDGET_EXCEEDED" / "grounding"');
  console.log('  - UI panel /lisa : badge coût quotidien + bouton "Relancer"');
  console.log('');
})().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
