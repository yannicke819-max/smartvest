/**
 * Audit TRADER (b0000001) instantané — pour debug session 03/06.
 * État proposals, trader_agent_decisions, positions ouvertes, PnL session.
 */
import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';

const env = fs.readFileSync('.env', 'utf8').split('\n').reduce((acc, l) => {
  const m = l.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/); if (m) acc[m[1]] = m[2]; return acc;
}, {} as Record<string, string>);

const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!);
const TRADER = 'b0000001-0000-0000-0000-000000000001';
const since60 = new Date(Date.now() - 60 * 60_000).toISOString();
const since24h = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
const sinceDay = new Date(); sinceDay.setUTCHours(0, 0, 0, 0);

(async () => {
  console.log(`\n========== AUDIT TRADER b0000001 — ${new Date().toISOString()} ==========\n`);

  // 1. Session config (gates actuels)
  const { data: cfg }: any = await sb.from('lisa_session_configs')
    .select('strategy_mode, autopilot_enabled, kill_switch_active, gainers_min_persistence_score, gainers_min_path_efficiency, autopilot_paused_reason, capital_usd, daily_cost_budget_usd')
    .eq('portfolio_id', TRADER).maybeSingle();
  console.log('--- CONFIG ---');
  console.log(JSON.stringify(cfg, null, 2));

  // 2. Proposals 60min
  const { data: props }: any = await sb.from('scanner_proposals')
    .select('symbol, status, score, created_at, trader_decision_reason, reviewed_by_trader_at')
    .eq('portfolio_id', TRADER).gte('created_at', since60)
    .order('created_at', { ascending: false });
  console.log(`\n--- PROPOSALS 60min: ${props?.length ?? 0} ---`);
  const stats: Record<string, number> = {};
  for (const p of props ?? []) stats[p.status] = (stats[p.status] ?? 0) + 1;
  console.log('status counts:', stats);
  for (const p of (props ?? []).slice(0, 10)) {
    console.log(`  ${p.created_at?.slice(11,19)} ${p.symbol.padEnd(12)} ${p.status.padEnd(20)} score=${p.score?.toFixed?.(2) ?? '-'} ${String(p.trader_decision_reason ?? '').slice(0, 70)}`);
  }

  // 3. Trader decisions 60min
  const { data: td }: any = await sb.from('trader_agent_decisions')
    .select('decided_at, action_kind, target_symbol, thesis, gemini_provider, input_news_summary')
    .gte('decided_at', since60).order('decided_at', { ascending: false }).limit(20);
  console.log(`\n--- TRADER DECISIONS 60min: ${td?.length ?? 0} ---`);
  let actionable = 0;
  const actionStats: Record<string, number> = {};
  for (const r of td ?? []) {
    actionStats[r.action_kind ?? 'null'] = (actionStats[r.action_kind ?? 'null'] ?? 0) + 1;
    if (r.action_kind && r.action_kind !== 'hold') actionable++;
  }
  console.log('action counts:', actionStats, `(actionable ≠ hold: ${actionable})`);
  for (const r of (td ?? []).slice(0, 8)) {
    const nl = Array.isArray(r.input_news_summary) ? r.input_news_summary.length : 0;
    console.log(`  ${r.decided_at?.slice(11,19)} ${(r.action_kind ?? '-').padEnd(8)} ${(r.target_symbol ?? '-').padEnd(12)} prov=${r.gemini_provider ?? '-'} news=${nl} "${String(r.thesis ?? '').slice(0, 120)}"`);
  }

  // 4. Open positions
  const { data: pos }: any = await sb.from('lisa_positions')
    .select('symbol, status, entry_price, take_profit_price, stop_loss_price, entry_timestamp, asset_class')
    .eq('portfolio_id', TRADER).eq('status', 'open')
    .order('entry_timestamp', { ascending: false });
  console.log(`\n--- OPEN POSITIONS: ${pos?.length ?? 0} ---`);
  for (const p of pos ?? []) {
    console.log(`  ${(p.symbol ?? '?').padEnd(14)} ${String(p.asset_class).padEnd(12)} entry=$${p.entry_price} TP=$${p.take_profit_price} SL=$${p.stop_loss_price} opened=${p.entry_timestamp?.slice(11,19)}`);
  }

  // 5. Closed today (PnL session)
  const { data: closed }: any = await sb.from('lisa_positions')
    .select('symbol, status, realized_pnl_usd, exit_timestamp, exit_reason')
    .eq('portfolio_id', TRADER).neq('status', 'open')
    .gte('exit_timestamp', sinceDay.toISOString())
    .order('exit_timestamp', { ascending: false });
  console.log(`\n--- CLOSED TODAY: ${closed?.length ?? 0} ---`);
  let totalRealized = 0;
  const reasonStats: Record<string, number> = {};
  for (const c of closed ?? []) {
    totalRealized += Number(c.realized_pnl_usd ?? 0);
    reasonStats[c.exit_reason ?? '-'] = (reasonStats[c.exit_reason ?? '-'] ?? 0) + 1;
  }
  console.log('reason counts:', reasonStats);
  console.log(`Total realized PnL today: $${totalRealized.toFixed(2)}`);
  for (const c of (closed ?? []).slice(0, 5)) {
    console.log(`  ${c.exit_timestamp?.slice(11,19)} ${(c.symbol ?? '?').padEnd(14)} ${(c.exit_reason ?? '-').padEnd(20)} pnl=$${Number(c.realized_pnl_usd ?? 0).toFixed(2)}`);
  }

  // 6. Decision log kinds counts 24h (verifie pipeline alive)
  const { data: dl }: any = await sb.from('lisa_decision_log')
    .select('kind').eq('portfolio_id', TRADER).gte('timestamp', since24h);
  const kindStats: Record<string, number> = {};
  for (const d of dl ?? []) kindStats[d.kind] = (kindStats[d.kind] ?? 0) + 1;
  console.log(`\n--- DECISION_LOG 24h: ${dl?.length ?? 0} (top 15 kinds) ---`);
  const sortedKinds = Object.entries(kindStats).sort((a, b) => b[1] - a[1]).slice(0, 15);
  for (const [k, n] of sortedKinds) console.log(`  ${String(n).padStart(4)}  ${k}`);

  console.log('\n========== END AUDIT ==========\n');
})();
