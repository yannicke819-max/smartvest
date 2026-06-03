/**
 * Pipeline TRADER health check complet — 03/06 13:20 UTC.
 *
 * Sections :
 *   1. Config TRADER (mode, autopilot, gates, kill-switch)
 *   2. Decisions Mistral derniers 60min (action breakdown + samples)
 *   3. News digestion : combien d'items reçus, integrés au prompt
 *   4. Lessons : lessons actives, citées par Mistral, archivées
 *   5. Auto-apply : last applied lessons / propositions
 *   6. Scanner_proposals : flow upstream, status counts
 *   7. Position état + PnL today
 *   8. Health flags : risk-monitor, mechanical_cron, hash chain
 */
import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
const env = fs.readFileSync('.env', 'utf8').split('\n').reduce((acc, l) => {
  const m = l.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/); if (m) acc[m[1]] = m[2]; return acc;
}, {} as Record<string, string>);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!);
const TRADER = 'b0000001-0000-0000-0000-000000000001';

(async () => {
  const now = new Date();
  const since60 = new Date(now.getTime() - 60 * 60_000).toISOString();
  const sinceDay = new Date(); sinceDay.setUTCHours(0, 0, 0, 0);
  console.log(`\n========== TRADER PIPELINE HEALTH CHECK — ${now.toISOString()} ==========\n`);

  // 1. CONFIG
  const { data: cfg }: any = await sb.from('lisa_session_configs')
    .select('strategy_mode, autopilot_enabled, kill_switch_active, autopilot_paused_reason, capital_usd, daily_cost_budget_usd, gainers_min_persistence_score, gainers_min_path_efficiency, autopilot_cycle_minutes, gainers_cycle_minutes')
    .eq('portfolio_id', TRADER).maybeSingle();
  console.log('=== 1. CONFIG TRADER ===');
  console.log(JSON.stringify(cfg, null, 2));

  // 2. DECISIONS 60min
  const { data: dec }: any = await sb.from('trader_agent_decisions')
    .select('decided_at, action_kind, target_symbol, gemini_provider, confidence, thesis')
    .gte('decided_at', since60).order('decided_at', { ascending: false });
  const actStats: Record<string, number> = {};
  const provStats: Record<string, number> = {};
  for (const d of dec ?? []) {
    actStats[d.action_kind ?? 'null'] = (actStats[d.action_kind ?? 'null'] ?? 0) + 1;
    if (d.gemini_provider) provStats[d.gemini_provider] = (provStats[d.gemini_provider] ?? 0) + 1;
  }
  console.log(`\n=== 2. DECISIONS 60min : ${dec?.length} ===`);
  console.log('actions:', actStats);
  console.log('providers (vrais appels LLM):', provStats);
  const actionable = (dec ?? []).filter((d: any) => d.action_kind && d.action_kind !== 'hold');
  console.log(`\nActionable (≠hold) : ${actionable.length}`);
  for (const a of actionable.slice(0, 5)) {
    console.log(`  ${a.decided_at.slice(11, 19)} ${a.action_kind} ${a.target_symbol ?? '-'} conf=${a.confidence} prov=${a.gemini_provider}`);
    console.log(`    "${String(a.thesis ?? '').slice(0, 160)}"`);
  }

  // 3. NEWS DIGESTION (via decision_log + dernier sample)
  const sample = (dec ?? []).find((d: any) => d.gemini_provider);
  console.log(`\n=== 3. NEWS DIGESTION ===`);
  if (sample) {
    const { data: full }: any = await sb.from('trader_agent_decisions')
      .select('input_news_summary, input_memory_lessons, input_macro, input_candidates')
      .eq('decided_at', sample.decided_at).limit(1).maybeSingle();
    const newsLen = Array.isArray(full?.input_news_summary) ? full.input_news_summary.length : 0;
    const lessonsLen = Array.isArray(full?.input_memory_lessons) ? full.input_memory_lessons.length : 0;
    const candidatesLen = Array.isArray(full?.input_candidates) ? full.input_candidates.length : 0;
    console.log(`  Sample cycle ${sample.decided_at.slice(11, 19)} : news=${newsLen} items, lessons=${lessonsLen}, candidates=${candidatesLen}, macro=${full?.input_macro ? 'set' : 'null'}`);
    if (Array.isArray(full?.input_news_summary) && full.input_news_summary.length > 0) {
      console.log(`  → 3 premières news :`);
      for (const n of full.input_news_summary.slice(0, 3)) {
        console.log(`    "${String(n.title ?? n.headline ?? n).slice(0, 100)}" sentiment=${n.sentiment ?? n.sentiment_polarity ?? '-'}`);
      }
    } else {
      console.log(`  ⚠️  AUCUNE news dans le prompt sample`);
    }
  }

  // 4. LESSONS
  console.log(`\n=== 4. LESSONS ===`);
  const { data: lessActive }: any = await sb.from('scanner_lessons')
    .select('id, lesson_kind, sample_size, confidence', { count: 'exact', head: false })
    .eq('is_active', true);
  console.log(`  Total actives : ${lessActive?.length ?? 0}`);
  const { data: lessLatest }: any = await sb.from('scanner_lessons')
    .select('id, lesson_kind, created_at, sample_size, confidence, lesson_text')
    .eq('is_active', true).order('created_at', { ascending: false }).limit(3);
  console.log(`  3 plus récentes :`);
  for (const l of lessLatest ?? []) {
    console.log(`    ${String(l.created_at).slice(0, 19)} ${l.lesson_kind} n=${l.sample_size} conf=${l.confidence}`);
    console.log(`      ${String(l.lesson_text ?? '').slice(0, 150)}`);
  }

  // 5. AUTO-APPLY
  console.log(`\n=== 5. LESSON AUTO-APPLY (last 24h) ===`);
  const { data: aaLog }: any = await sb.from('lisa_decision_log')
    .select('timestamp, kind, summary')
    .eq('portfolio_id', TRADER)
    .or('kind.eq.lesson_applied,kind.eq.lesson_auto_applied,kind.eq.coach_proposal,kind.eq.lesson_needs_manual_review')
    .gte('timestamp', new Date(now.getTime() - 24 * 3600_000).toISOString())
    .order('timestamp', { ascending: false }).limit(10);
  const aaStats: Record<string, number> = {};
  for (const r of aaLog ?? []) aaStats[r.kind] = (aaStats[r.kind] ?? 0) + 1;
  console.log('  counts par kind:', aaStats);
  console.log('  3 dernières :');
  for (const r of (aaLog ?? []).slice(0, 3)) {
    console.log(`    ${r.timestamp.slice(11, 19)} ${r.kind} ${String(r.summary).slice(0, 120)}`);
  }

  // 6. SCANNER PROPOSALS
  console.log(`\n=== 6. SCANNER_PROPOSALS today ===`);
  const { data: props }: any = await sb.from('scanner_proposals')
    .select('symbol, status, score, created_at, trader_decision_reason').eq('portfolio_id', TRADER)
    .gte('created_at', sinceDay.toISOString()).order('created_at', { ascending: false });
  const propStats: Record<string, number> = {};
  for (const p of props ?? []) propStats[p.status] = (propStats[p.status] ?? 0) + 1;
  console.log(`  ${props?.length ?? 0} proposals : ${JSON.stringify(propStats)}`);
  console.log(`  5 plus récentes :`);
  for (const p of (props ?? []).slice(0, 5)) {
    console.log(`    ${p.created_at.slice(11, 19)} ${p.symbol.padEnd(14)} ${p.status.padEnd(15)} score=${p.score} ${String(p.trader_decision_reason ?? '').slice(0, 80)}`);
  }

  // 7. POSITIONS
  console.log(`\n=== 7. POSITIONS ===`);
  const { data: open }: any = await sb.from('lisa_positions')
    .select('symbol, entry_price, take_profit_price, stop_loss_price, entry_timestamp, asset_class')
    .eq('portfolio_id', TRADER).eq('status', 'open');
  console.log(`  Open : ${open?.length ?? 0}`);
  for (const p of open ?? []) {
    console.log(`    ${p.symbol} entry=$${p.entry_price} TP=$${p.take_profit_price} SL=$${p.stop_loss_price} opened=${p.entry_timestamp?.slice(11, 19)}`);
  }
  const { data: closed }: any = await sb.from('lisa_positions')
    .select('symbol, entry_price, exit_price, exit_timestamp, exit_reason, realized_pnl_usd, realized_pnl_pct')
    .eq('portfolio_id', TRADER).neq('status', 'open')
    .gte('exit_timestamp', sinceDay.toISOString()).order('exit_timestamp', { ascending: false });
  let totalPnl = 0;
  for (const c of closed ?? []) totalPnl += Number(c.realized_pnl_usd ?? 0);
  console.log(`  Closed today : ${closed?.length ?? 0}, total realized = $${totalPnl.toFixed(2)}`);
  for (const c of (closed ?? []).slice(0, 5)) {
    console.log(`    ${c.exit_timestamp?.slice(11, 19)} ${c.symbol} ${c.exit_reason} pnl=$${Number(c.realized_pnl_usd ?? 0).toFixed(2)} (${c.realized_pnl_pct}%)`);
  }

  // 8. HEALTH FLAGS — risk-monitor, mechanical, hash chain
  console.log(`\n=== 8. HEALTH FLAGS ===`);
  const { data: dlKinds }: any = await sb.from('lisa_decision_log')
    .select('kind').eq('portfolio_id', TRADER).gte('timestamp', since60);
  const dlStats: Record<string, number> = {};
  for (const r of dlKinds ?? []) dlStats[r.kind] = (dlStats[r.kind] ?? 0) + 1;
  const interesting = Object.entries(dlStats).sort((a, b) => b[1] - a[1]).slice(0, 12);
  console.log('  decision_log kinds 60min:');
  for (const [k, n] of interesting) console.log(`    ${String(n).padStart(3)} ${k}`);

  // Hash chain check
  console.log(`\n  Hash chain TRADER 24h : (re-vérification)`);
  const { data: hc }: any = await sb.from('lisa_decision_log')
    .select('hash_chain_current, hash_chain_prev', { count: 'exact', head: false })
    .eq('portfolio_id', TRADER).gte('timestamp', new Date(now.getTime() - 24 * 3600_000).toISOString())
    .limit(5);
  console.log(`    sample 5 dernières lignes : ${hc?.length ? '✓ chain présent' : '⚠️ vide'}`);

  console.log(`\n========== FIN AUDIT ==========\n`);
})();
