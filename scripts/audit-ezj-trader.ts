import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';

const env = fs.readFileSync('.env', 'utf8').split('\n').reduce((acc, l) => {
  const m = l.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/); if (m) acc[m[1]] = m[2]; return acc;
}, {} as Record<string, string>);

const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!);
const T = 'b0000001-0000-0000-0000-000000000001';
const since2h = new Date(Date.now() - 2 * 3600_000).toISOString();
const since3h = new Date(Date.now() - 3 * 3600_000).toISOString();

(async () => {
  // 1. EZJ specifically — text search in summary
  const { data: ezj }: any = await sb.from('lisa_decision_log')
    .select('timestamp, kind, summary, payload')
    .eq('portfolio_id', T).gte('timestamp', since2h)
    .ilike('summary', '%EZJ%').order('timestamp', { ascending: false }).limit(20);
  console.log(`=== EZJ.LSE last 2h: ${ezj?.length ?? 0} entries ===`);
  for (const r of ezj ?? []) {
    console.log(`${r.timestamp.slice(11, 19)} ${String(r.kind).padEnd(28)} ${String(r.summary).slice(0, 130)}`);
  }

  // 2. position_open_failed details
  const { data: pof }: any = await sb.from('lisa_decision_log')
    .select('timestamp, summary, payload')
    .eq('portfolio_id', T).eq('kind', 'position_open_failed')
    .gte('timestamp', since3h).order('timestamp', { ascending: false }).limit(15);
  console.log(`\n=== position_open_failed last 3h: ${pof?.length ?? 0} ===`);
  for (const r of pof ?? []) {
    const pl: any = r.payload;
    console.log(`${r.timestamp.slice(11, 19)} sym=${pl?.symbol ?? '?'} reason=${String(pl?.reason ?? pl?.error ?? r.summary).slice(0, 160)}`);
  }

  // 3. EZJ in scanner_proposals
  const { data: prop }: any = await sb.from('scanner_proposals')
    .select('created_at, symbol, status, score, trader_decision_reason, reviewed_by_trader_at, payload')
    .eq('portfolio_id', T).eq('symbol', 'EZJ.LSE')
    .order('created_at', { ascending: false }).limit(5);
  console.log(`\n=== scanner_proposals EZJ.LSE: ${prop?.length ?? 0} ===`);
  for (const r of prop ?? []) {
    console.log(`${r.created_at.slice(11, 19)} status=${r.status} score=${r.score} reviewed=${r.reviewed_by_trader_at?.slice(11, 19) ?? '-'} reason=${String(r.trader_decision_reason ?? '').slice(0, 100)}`);
  }

  // 4. EZJ in lisa_positions (any status)
  const { data: pos }: any = await sb.from('lisa_positions')
    .select('id, status, opened_at, closed_at, close_reason, entry_price, current_price, asset_class')
    .eq('portfolio_id', T).eq('symbol', 'EZJ.LSE')
    .order('opened_at', { ascending: false }).limit(5);
  console.log(`\n=== lisa_positions EZJ.LSE: ${pos?.length ?? 0} ===`);
  for (const r of pos ?? []) {
    console.log(`  id=${r.id?.slice(0,8)} status=${r.status} opened=${r.opened_at?.slice(11,19) ?? '-'} closed=${r.closed_at?.slice(11,19) ?? '-'} reason=${r.close_reason ?? '-'} entry=${r.entry_price} px=${r.current_price}`);
  }

  // 5. trader_agent_decisions for EZJ
  const { data: td }: any = await sb.from('trader_agent_decisions')
    .select('decided_at, action_kind, target_symbol, gemini_provider, thesis')
    .eq('target_symbol', 'EZJ.LSE').gte('decided_at', since3h)
    .order('decided_at', { ascending: false }).limit(5);
  console.log(`\n=== trader_agent_decisions EZJ.LSE: ${td?.length ?? 0} ===`);
  for (const r of td ?? []) {
    console.log(`${r.decided_at.slice(11, 19)} ${r.action_kind} prov=${r.gemini_provider} thesis="${String(r.thesis ?? '').slice(0, 100)}"`);
  }
})();
