import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
const env = fs.readFileSync('.env', 'utf8').split('\n').reduce((acc, l) => {
  const m = l.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/); if (m) acc[m[1]] = m[2]; return acc;
}, {} as Record<string, string>);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!);
(async () => {
  console.log('Wait 15min then audit...');
  await new Promise(r => setTimeout(r, 15 * 60_000));
  const since = new Date(Date.now() - 15 * 60_000).toISOString();
  const TRADER = 'b0000001-0000-0000-0000-000000000001';
  // 1. Trader decisions
  const { data: td } = await sb.from('trader_agent_decisions')
    .select('decided_at, action_kind, target_symbol, thesis, gemini_provider, input_news_summary')
    .gte('decided_at', since).order('decided_at', {ascending:false}).limit(10);
  console.log(`\n=== TRADER decisions 15min: ${td?.length} ===`);
  let actionable = 0;
  for (const r of td ?? [] as any[]) {
    const nl = Array.isArray(r.input_news_summary) ? r.input_news_summary.length : 0;
    if (r.action_kind !== 'hold' && r.action_kind !== null) actionable++;
    if (r.gemini_provider) console.log(`  ${r.decided_at?.slice(11,19)} ${r.action_kind} sym=${r.target_symbol ?? '-'} news=${nl} thesis="${String(r.thesis ?? '').slice(0,200)}"`);
  }
  console.log(`Actionnables (≠ hold): ${actionable}`);
  // 2. Proposals TRADER
  const { data: pr } = await sb.from('scanner_proposals')
    .select('symbol, status, created_at, trader_decision_reason').eq('portfolio_id', TRADER)
    .gte('created_at', since).limit(15);
  console.log(`\nproposals TRADER 15min: ${pr?.length}`);
  if (pr) for (const p of pr) console.log(`  ${p.created_at.slice(11,19)} ${p.symbol} ${p.status} ${(p.trader_decision_reason ?? '').slice(0,60)}`);
  // 3. Positions
  const today = new Date(); today.setUTCHours(0,0,0,0);
  const { data: pos } = await sb.from('lisa_positions')
    .select('portfolio_id, status, realized_pnl_usd').gte('entry_timestamp', today.toISOString()).limit(50);
  if (pos) {
    const byPf: Record<string, {open:number; closed:number; pnl:number}> = {};
    for (const p of pos) {
      const k = p.portfolio_id?.slice(0,8) ?? '?';
      if (!byPf[k]) byPf[k] = {open:0, closed:0, pnl:0};
      if (p.status === 'open') byPf[k].open++;
      else { byPf[k].closed++; byPf[k].pnl += Number(p.realized_pnl_usd ?? 0); }
    }
    console.log('\nPositions today:');
    for (const [k,v] of Object.entries(byPf)) console.log(`  pf=${k} open=${v.open} closed=${v.closed} pnl=$${v.pnl.toFixed(2)}`);
  }
  // 4. Signals 15min decisions breakdown
  const { data: sigs } = await sb.from('gainers_user_shadow_signals')
    .select('decision').gte('created_at', since).limit(5000);
  if (sigs) {
    const byD: Record<string,number> = {};
    for (const s of sigs) byD[s.decision ?? '?'] = (byD[s.decision ?? '?'] ?? 0) + 1;
    console.log(`\nScanner signals 15min (${sigs.length}):`);
    for (const [k,v] of Object.entries(byD).sort((a,b)=>b[1]-a[1])) console.log(`  ${k} ${v}`);
  }
  process.exit(0);
})();
