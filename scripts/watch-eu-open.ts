import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
const env = fs.readFileSync('.env', 'utf8').split('\n').reduce((acc, l) => {
  const m = l.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/); if (m) acc[m[1]] = m[2]; return acc;
}, {} as Record<string, string>);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!);
const TRADER_PF = 'b0000001-0000-0000-0000-000000000001';
const startTs = new Date().toISOString();

async function check(): Promise<boolean> {
  const todayUtc = new Date(); todayUtc.setUTCHours(0,0,0,0);
  const { data: sigs } = await sb.from('gainers_user_shadow_signals')
    .select('decision').gte('created_at', startTs).limit(2000);
  const { data: props } = await sb.from('scanner_proposals')
    .select('symbol, status, created_at, direction, score')
    .eq('portfolio_id', TRADER_PF).gte('created_at', startTs).limit(20);
  const { data: paper } = await sb.from('paper_trades')
    .select('symbol, opened_at, portfolio_id, size_usd, status')
    .gte('opened_at', todayUtc.toISOString()).limit(20);
  const { data: pos } = await sb.from('lisa_positions')
    .select('symbol, entry_timestamp, status, portfolio_id, entry_notional_usd')
    .gte('entry_timestamp', todayUtc.toISOString()).limit(20);
  const { data: failed } = await sb.from('lisa_decision_log')
    .select('timestamp, kind, portfolio_id, summary')
    .gte('timestamp', startTs)
    .in('kind', ['position_open_failed', 'position_opened']).limit(30);

  const now = new Date().toISOString();
  const byDec: Record<string, number> = {};
  for (const s of sigs ?? []) byDec[s.decision ?? '?'] = (byDec[s.decision ?? '?'] ?? 0) + 1;
  console.log(`\n[${now.slice(11,19)}]`);
  console.log(`  signals: total=${sigs?.length ?? 0} → ${Object.entries(byDec).map(([k,v])=>`${k}=${v}`).join(' ')}`);
  console.log(`  proposals TRADER: ${props?.length ?? 0}`);
  if (props && props.length > 0) for (const p of props.slice(0,3)) console.log(`    ${p.created_at.slice(11,19)} ${p.symbol} ${p.direction} score=${p.score} ${p.status}`);
  console.log(`  paper_trades today: ${paper?.length ?? 0}`);
  console.log(`  lisa_positions today: ${pos?.length ?? 0}`);
  if (pos && pos.length > 0) for (const p of pos.slice(0,3)) console.log(`    ${p.entry_timestamp?.slice(11,19)} ${p.symbol} pf=${p.portfolio_id?.slice(0,8)} $${p.entry_notional_usd}`);
  console.log(`  open events: ${failed?.length ?? 0}`);
  if (failed && failed.length > 0) for (const f of failed.slice(0,3)) console.log(`    ${f.timestamp.slice(11,19)} [${f.kind}] pf=${f.portfolio_id?.slice(0,8)} ${f.summary?.slice(0,80)}`);

  return (paper?.length ?? 0) > 0 || (pos?.length ?? 0) > 0 || (props?.length ?? 0) >= 3;
}

(async () => {
  console.log(`Watch EU-open start ${startTs}`);
  const deadline = Date.now() + 15 * 60_000;
  while (Date.now() < deadline) {
    if (await check()) { console.log('\n=== EXIT — signal détecté ==='); process.exit(0); }
    await new Promise(r => setTimeout(r, 30_000));
  }
  console.log('\n=== TIMEOUT 15min ===');
  process.exit(0);
})();
