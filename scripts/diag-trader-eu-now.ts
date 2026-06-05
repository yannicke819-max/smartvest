import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  const TRADER = 'b0000001-0000-0000-0000-000000000001';
  const since30 = new Date(Date.now() - 30 * 60_000).toISOString();
  const since60 = new Date(Date.now() - 60 * 60_000).toISOString();

  console.log(`\n═══ Now: ${new Date().toISOString().slice(11,19)} UTC ═══\n`);

  // 1. Univers config
  const { data: cfg } = await sb
    .from('lisa_session_configs')
    .select('gainers_universe_us, gainers_universe_eu, gainers_universe_asia, gainers_universe_crypto, strategy_mode, autopilot_enabled, kill_switch_active')
    .eq('portfolio_id', TRADER)
    .single();
  console.log('TRADER cfg :', JSON.stringify(cfg));

  // 2. Shadow signals 30min toutes classes
  const { data: shadow } = await sb
    .from('gainers_user_shadow_signals')
    .select('asset_class, decision, created_at, symbol')
    .gte('created_at', since30)
    .order('created_at', { ascending: false });
  console.log(`\nShadow signals 30min: ${shadow?.length ?? 0}`);
  const byClass = new Map<string, Map<string, number>>();
  for (const s of shadow ?? []) {
    if (!byClass.has(s.asset_class)) byClass.set(s.asset_class, new Map());
    const m = byClass.get(s.asset_class)!;
    m.set(s.decision, (m.get(s.decision) ?? 0) + 1);
  }
  for (const [cls, m] of byClass) {
    const total = [...m.values()].reduce((a,b)=>a+b, 0);
    const accept = m.get('accept') ?? 0;
    const top = [...m].filter(([k]) => k !== 'accept').sort((a,b)=>b[1]-a[1]).slice(0,3);
    console.log(`  ${cls.padEnd(22)} total=${total.toString().padStart(3)} accept=${accept.toString().padStart(3)} top: ${top.map(([k,v]) => `${k}:${v}`).join(', ')}`);
  }
  console.log(`Latest 3 shadow signals:`);
  for (const s of (shadow ?? []).slice(0, 3)) {
    console.log(`  ${s.created_at.slice(11,19)} ${s.symbol.padEnd(14)} ${s.asset_class.padEnd(22)} ${s.decision}`);
  }

  // 3. Tous les kinds TRADER 30min
  const { data: kinds } = await sb
    .from('lisa_decision_log')
    .select('kind, timestamp')
    .eq('portfolio_id', TRADER)
    .gte('timestamp', since30)
    .order('timestamp', { ascending: false });
  console.log(`\nDecision_log TRADER 30min: ${kinds?.length ?? 0}`);
  const kindCounts = new Map<string, number>();
  for (const k of kinds ?? []) kindCounts.set(k.kind, (kindCounts.get(k.kind) ?? 0) + 1);
  for (const [k, n] of [...kindCounts].sort((a,b)=>b[1]-a[1])) {
    console.log(`  ${n.toString().padStart(3)} × ${k}`);
  }
  if (kinds?.length) {
    console.log(`  Latest: ${kinds[0].timestamp.slice(11,19)} ${kinds[0].kind}`);
  }

  // 4. Positions ouvertes ALL portfolios 60min (au cas où le monitor manque qqch)
  const { data: pos } = await sb
    .from('lisa_positions')
    .select('portfolio_id, symbol, venue, status, entry_timestamp, entry_price, entry_notional_usd')
    .gte('entry_timestamp', since60)
    .order('entry_timestamp', { ascending: false });
  console.log(`\nPositions ALL portfolios 60min: ${pos?.length ?? 0}`);
  for (const p of pos ?? []) {
    const isTrader = p.portfolio_id === TRADER ? '🎯TRADER' : 'other';
    console.log(`  ${isTrader} ${p.entry_timestamp.slice(11,19)} ${p.symbol.padEnd(14)} venue=${p.venue ?? '?'} status=${p.status} entry=$${Number(p.entry_price ?? 0).toFixed(2)} notional=$${Number(p.entry_notional_usd ?? 0).toFixed(0)}`);
  }

  // 5. Recent Fly deploy version (via version endpoint si possible — sinon git_sha dans decision_log)
  console.log(`\nLatest 5 decision_log kinds TRADER (full timestamps):`);
  for (const k of (kinds ?? []).slice(0, 5)) {
    console.log(`  ${k.timestamp}  ${k.kind}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
