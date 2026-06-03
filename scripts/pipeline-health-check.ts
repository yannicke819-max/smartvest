/**
 * Audit complet pipeline SmartVest — 03/06/2026 matin.
 *
 * Vérifie 8 dimensions :
 *  1. Scanner cycles last 1h (combien, par portfolio)
 *  2. scanner_proposals lifecycle (pending/chosen/rejected/superseded)
 *  3. TRADER decisions last 24h (Mistral vs Gemini, conviction, accept/reject)
 *  4. SkepticAgent verdicts last 24h (rules triggered, would-veto count)
 *  5. Setup taxonomy classifier — paper_trades avec setup_kind set last 7j
 *  6. Lessons générées last 24h (par kind)
 *  7. Lesson auto-apply last 24h (combien appliquées en DB)
 *  8. paper_trades closed last 24h (WR, sumPnl)
 */
import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';

const env = fs.readFileSync('.env', 'utf8').split('\n').reduce((acc, l) => {
  const m = l.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/); if (m) acc[m[1]] = m[2]; return acc;
}, {} as Record<string, string>);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!);

const since1h = new Date(Date.now() - 1 * 60 * 60_000).toISOString();
const since24h = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
const since7d = new Date(Date.now() - 7 * 24 * 60 * 60_000).toISOString();

async function main() {
  console.log(`\n=== AUDIT PIPELINE — ${new Date().toISOString()} ===\n`);

  // 1. Scanner cycles last 1h (via shadow_signals comme proxy)
  console.log('## 1. Scanner activity last 1h');
  const { data: scans1h } = await sb.from('gainers_user_shadow_signals')
    .select('asset_class, decision', { count: 'exact' })
    .gte('created_at', since1h)
    .limit(50000);
  if (scans1h) {
    const byClass: Record<string, number> = {};
    const byDecision: Record<string, number> = {};
    for (const r of scans1h) {
      byClass[r.asset_class ?? '?'] = (byClass[r.asset_class ?? '?'] ?? 0) + 1;
      byDecision[r.decision ?? '?'] = (byDecision[r.decision ?? '?'] ?? 0) + 1;
    }
    console.log(`  Total signals: ${scans1h.length}`);
    console.log('  Par class:', Object.entries(byClass).map(([k,v])=>`${k}=${v}`).join(' '));
    console.log('  Decisions:');
    for (const [k, v] of Object.entries(byDecision).sort((a,b)=>b[1]-a[1])) {
      console.log(`    ${k.padEnd(35)} ${v}`);
    }
  }

  // 2. scanner_proposals lifecycle
  console.log('\n## 2. scanner_proposals lifecycle last 24h');
  const { data: props } = await sb.from('scanner_proposals')
    .select('status, portfolio_id')
    .gte('created_at', since24h)
    .limit(5000);
  if (props) {
    const byStatus: Record<string, number> = {};
    for (const r of props) byStatus[r.status ?? '?'] = (byStatus[r.status ?? '?'] ?? 0) + 1;
    console.log(`  Total: ${props.length}`);
    for (const [k, v] of Object.entries(byStatus).sort((a,b)=>b[1]-a[1])) {
      console.log(`    ${k.padEnd(20)} ${v}`);
    }
  } else {
    console.log('  (table scanner_proposals introuvable ou vide)');
  }

  // 3. TRADER decisions
  console.log('\n## 3. TRADER decisions last 24h');
  const tables = ['trader_agent_decisions', 'live_trader_decisions'];
  for (const t of tables) {
    const { data, error } = await sb.from(t)
      .select('*', { count: 'exact', head: true })
      .gte('created_at', since24h);
    if (!error) {
      console.log(`  Table ${t}: count=via_select_below`);
    }
  }
  const { data: traderDecisions } = await sb.from('trader_agent_decisions')
    .select('decision, llm_provider, conviction, applied, rejection_reason')
    .gte('created_at', since24h)
    .limit(2000);
  if (traderDecisions) {
    console.log(`  trader_agent_decisions: ${traderDecisions.length}`);
    const byDec: Record<string, number> = {};
    const byProv: Record<string, number> = {};
    let applied = 0;
    for (const r of traderDecisions) {
      byDec[r.decision ?? '?'] = (byDec[r.decision ?? '?'] ?? 0) + 1;
      byProv[r.llm_provider ?? '?'] = (byProv[r.llm_provider ?? '?'] ?? 0) + 1;
      if (r.applied) applied++;
    }
    console.log(`    appliquées: ${applied}/${traderDecisions.length}`);
    console.log(`    par decision:`, Object.entries(byDec).map(([k,v])=>`${k}=${v}`).join(' '));
    console.log(`    par provider:`, Object.entries(byProv).map(([k,v])=>`${k}=${v}`).join(' '));
  }

  // 4. SkepticAgent verdicts
  console.log('\n## 4. SkepticAgent verdicts last 24h');
  const { data: skeptic } = await sb.from('lisa_decision_log')
    .select('kind, payload')
    .gte('timestamp', since24h)
    .eq('kind', 'skeptic_verdict')
    .limit(2000);
  if (skeptic) {
    console.log(`  Total verdicts: ${skeptic.length}`);
    let vetoCount = 0;
    const byRule: Record<string, number> = {};
    for (const r of skeptic) {
      const p = r.payload as any;
      if (p?.verdict === 'veto') vetoCount++;
      const rule = p?.triggered_rule ?? p?.rule ?? 'unknown';
      byRule[rule] = (byRule[rule] ?? 0) + 1;
    }
    console.log(`  Veto count: ${vetoCount} / ${skeptic.length} (${(100*vetoCount/Math.max(1,skeptic.length)).toFixed(1)}%)`);
    console.log(`  Par règle:`, Object.entries(byRule).slice(0, 10).map(([k,v])=>`${k}=${v}`).join(' '));
  }

  // 5. Setup taxonomy
  console.log('\n## 5. Setup taxonomy classifier (paper_trades last 7d)');
  const { data: trades } = await sb.from('paper_trades')
    .select('setup_kind, regime_at_entry, classifier_version, status, pnl_pct, opened_at')
    .gte('opened_at', since7d)
    .limit(5000);
  if (trades) {
    console.log(`  Total paper_trades 7d: ${trades.length}`);
    const withSetup = trades.filter(t => t.setup_kind);
    console.log(`  Avec setup_kind: ${withSetup.length} (${(100*withSetup.length/Math.max(1,trades.length)).toFixed(1)}%)`);
    if (withSetup.length > 0) {
      const bySetup: Record<string, { n: number; wins: number }> = {};
      for (const t of withSetup) {
        const k = t.setup_kind ?? '?';
        if (!bySetup[k]) bySetup[k] = { n: 0, wins: 0 };
        bySetup[k].n++;
        if (t.status === 'closed' && Number(t.pnl_pct ?? 0) > 0) bySetup[k].wins++;
      }
      console.log('  Par setup_kind:');
      for (const [k, v] of Object.entries(bySetup).sort((a,b)=>b[1].n-a[1].n)) {
        const wr = v.n > 0 ? `${(100*v.wins/v.n).toFixed(0)}%` : 'n/a';
        console.log(`    ${k.padEnd(20)} n=${v.n} WR=${wr}`);
      }
    }
  }

  // 6. Lessons générées
  console.log('\n## 6. Lessons générées last 24h');
  const { data: lessons } = await sb.from('scanner_lessons')
    .select('lesson_kind, confidence, sample_size, status, source')
    .gte('created_at', since24h)
    .limit(2000);
  if (lessons) {
    console.log(`  Total lessons 24h: ${lessons.length}`);
    const byKind: Record<string, number> = {};
    const byStatus: Record<string, number> = {};
    for (const l of lessons) {
      byKind[l.lesson_kind ?? '?'] = (byKind[l.lesson_kind ?? '?'] ?? 0) + 1;
      byStatus[l.status ?? '?'] = (byStatus[l.status ?? '?'] ?? 0) + 1;
    }
    console.log(`  Par kind:`, Object.entries(byKind).slice(0, 10).map(([k,v])=>`${k}=${v}`).join(' '));
    console.log(`  Par status:`, Object.entries(byStatus).map(([k,v])=>`${k}=${v}`).join(' '));
  }

  // 7. Lesson auto-apply
  console.log('\n## 7. Lesson auto-apply last 24h');
  const { data: applied } = await sb.from('lisa_decision_log')
    .select('kind, payload, timestamp')
    .gte('timestamp', since24h)
    .like('kind', '%lesson_auto%')
    .limit(200);
  if (applied) {
    console.log(`  Events lesson_auto_*: ${applied.length}`);
    const byKind: Record<string, number> = {};
    for (const r of applied) byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
    for (const [k, v] of Object.entries(byKind)) console.log(`    ${k.padEnd(40)} ${v}`);
  }

  // 8. paper_trades performance last 24h
  console.log('\n## 8. paper_trades closed last 24h — WR + sumPnl');
  const { data: closed } = await sb.from('paper_trades')
    .select('symbol, status, pnl_usd, pnl_pct, portfolio_id')
    .gte('opened_at', since24h)
    .neq('status', 'open')
    .limit(2000);
  if (closed) {
    const winners = closed.filter(t => Number(t.pnl_pct ?? 0) > 0);
    const sumUsd = closed.reduce((s, t) => s + Number(t.pnl_usd ?? 0), 0);
    const sumPct = closed.reduce((s, t) => s + Number(t.pnl_pct ?? 0), 0);
    console.log(`  Total closed: ${closed.length}`);
    console.log(`  Winners: ${winners.length} (WR ${(100*winners.length/Math.max(1,closed.length)).toFixed(1)}%)`);
    console.log(`  Sum PnL USD: $${sumUsd.toFixed(2)}`);
    console.log(`  Sum PnL %: ${sumPct.toFixed(2)}%`);
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
