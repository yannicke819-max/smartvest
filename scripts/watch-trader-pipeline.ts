/**
 * Watch script — poll toutes les 30s jusqu'à voir
 * un scanner_proposal ou trader_decision actionnable post-fix.
 *
 * Exit conditions :
 *   - 1 scanner_proposal créé pour b0000001 après fix DB
 *   - OR 1 trader_decision avec action_kind != 'hold'
 *   - OR 1 paper_trade ouvert aujourd'hui
 *   - OR 15 min écoulées (timeout)
 */
import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';

const env = fs.readFileSync('.env', 'utf8').split('\n').reduce((acc, l) => {
  const m = l.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/); if (m) acc[m[1]] = m[2]; return acc;
}, {} as Record<string, string>);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!);

const FIX_TIME = '2026-06-03T06:43:00Z'; // approx moment du UPDATE persist+pathEff
const TRADER_PF = 'b0000001-0000-0000-0000-000000000001';

async function check(): Promise<boolean> {
  const { data: props } = await sb.from('scanner_proposals')
    .select('symbol, status, created_at, score, change_pct, direction')
    .eq('portfolio_id', TRADER_PF)
    .gte('created_at', FIX_TIME)
    .order('created_at', { ascending: false }).limit(20);

  const { data: traderActions } = await sb.from('trader_agent_decisions')
    .select('decided_at, target_symbol, action_kind, action_applied, gemini_provider, confidence, apply_error')
    .gte('decided_at', FIX_TIME)
    .neq('action_kind', 'hold')
    .order('decided_at', { ascending: false }).limit(10);

  const todayUtc = new Date(); todayUtc.setUTCHours(0,0,0,0);
  const { data: paperToday } = await sb.from('paper_trades')
    .select('symbol, opened_at, status, setup_kind, pnl_pct, size_usd, portfolio_id')
    .gte('opened_at', todayUtc.toISOString())
    .order('opened_at', { ascending: false }).limit(20);

  const { data: posToday } = await sb.from('lisa_positions')
    .select('symbol, entry_timestamp, status, portfolio_id, side, unrealized_pnl_usd')
    .gte('entry_timestamp', todayUtc.toISOString())
    .order('entry_timestamp', { ascending: false }).limit(20);

  const now = new Date().toISOString();
  console.log(`\n[${now.slice(11,19)}] check:`);
  console.log(`  scanner_proposals post-fix: ${props?.length ?? 0}`);
  if (props && props.length > 0) {
    for (const p of props.slice(0, 5)) {
      console.log(`    ${p.created_at.slice(11,19)} ${p.symbol} ${p.direction} score=${p.score} status=${p.status}`);
    }
  }
  console.log(`  trader_decisions actionnables: ${traderActions?.length ?? 0}`);
  if (traderActions && traderActions.length > 0) {
    for (const t of traderActions.slice(0, 5)) {
      console.log(`    ${t.decided_at?.slice(11,19)} ${t.target_symbol} ${t.action_kind} applied=${t.action_applied} prov=${t.gemini_provider} conv=${t.confidence}`);
    }
  }
  console.log(`  paper_trades today: ${paperToday?.length ?? 0}`);
  if (paperToday && paperToday.length > 0) {
    for (const p of paperToday.slice(0, 5)) {
      console.log(`    ${p.opened_at?.slice(11,19)} ${p.symbol} pf=${p.portfolio_id?.slice(0,8)} size=$${p.size_usd}`);
    }
  }
  console.log(`  lisa_positions today: ${posToday?.length ?? 0}`);
  if (posToday && posToday.length > 0) {
    for (const p of posToday.slice(0, 5)) {
      console.log(`    ${p.entry_timestamp?.slice(11,19)} ${p.symbol} pf=${p.portfolio_id?.slice(0,8)} ${p.side} ${p.status} pnl=$${p.unrealized_pnl_usd}`);
    }
  }

  // Exit if any of the targets reached
  const hasProposal = (props?.length ?? 0) > 0;
  const hasAction = (traderActions?.length ?? 0) > 0;
  const hasPaper = (paperToday?.length ?? 0) > 0;
  const hasPosition = (posToday?.length ?? 0) > 0;
  return hasProposal || hasAction || hasPaper || hasPosition;
}

async function main() {
  console.log(`Watch start ${new Date().toISOString()} — TRADER pipeline post-fix`);
  const deadline = Date.now() + 15 * 60_000;
  while (Date.now() < deadline) {
    const found = await check();
    if (found) {
      console.log('\n=== EXIT — signaux détectés ===');
      return;
    }
    await new Promise(r => setTimeout(r, 30_000));
  }
  console.log('\n=== TIMEOUT 15min — pas de signal pipeline détecté ===');
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
