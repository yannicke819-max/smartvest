import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  const TRADER = 'b0000001-0000-0000-0000-000000000001';
  const since = new Date(Date.now() - 60 * 60_000).toISOString();

  const { data } = await sb
    .from('trader_agent_decisions')
    .select('decided_at, action_kind, action_applied, target_symbol, confidence, direction, notional_usd, applied_position_id, apply_error, mistral_latency_ms, mistral_cost_usd, mistral_large_latency_ms, thesis')
    .eq('portfolio_id', TRADER)
    .gte('decided_at', since)
    .order('decided_at', { ascending: false })
    .limit(20);
  console.log(`\ntrader_agent_decisions TRADER 60min: ${data?.length ?? 0}\n`);
  for (const d of data ?? []) {
    const applied = d.action_applied ? '✅' : '❌';
    const sym = d.target_symbol ?? '—';
    const thesisShort = (d.thesis ?? '').slice(0, 100);
    console.log(`${d.decided_at?.slice(11,19)} ${applied} action=${d.action_kind?.padEnd(10)} sym=${sym.padEnd(14)} conf=${d.confidence ?? '—'} dir=${d.direction ?? '—'} notional=$${Number(d.notional_usd ?? 0).toFixed(0)}`);
    if (d.apply_error) console.log(`    ⚠ apply_error: ${d.apply_error.slice(0, 200)}`);
    if (thesisShort) console.log(`    thesis: ${thesisShort}`);
  }

  // Aussi count action_kind on 24h
  const since24h = new Date(Date.now() - 24 * 3600_000).toISOString();
  const { data: all24 } = await sb
    .from('trader_agent_decisions')
    .select('action_kind, action_applied')
    .eq('portfolio_id', TRADER)
    .gte('decided_at', since24h);
  const counts = new Map<string, number>();
  let applied = 0;
  for (const r of all24 ?? []) {
    const key = `${r.action_kind}_${r.action_applied ? 'applied' : 'rejected'}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (r.action_applied) applied++;
  }
  console.log(`\n═══ 24h trader_agent_decisions ═══`);
  console.log(`Total: ${all24?.length ?? 0}, Applied: ${applied}`);
  for (const [k, n] of [...counts].sort((a,b)=>b[1]-a[1])) {
    console.log(`  ${k}: ${n}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
