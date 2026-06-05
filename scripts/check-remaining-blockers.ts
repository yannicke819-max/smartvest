import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  const TRADER = 'b0000001-0000-0000-0000-000000000001';
  const since = new Date(Date.now() - 60 * 60_000).toISOString();
  console.log(`\n═══ État scanner gainers TRADER — ${new Date().toISOString().slice(11,19)} UTC (60min) ═══\n`);

  // 1. Funnel shadow signals par classe
  const { data: shadow } = await sb
    .from('gainers_user_shadow_signals')
    .select('asset_class, decision')
    .gte('created_at', since);
  const byCls = new Map<string, Map<string, number>>();
  for (const s of shadow ?? []) {
    if (!byCls.has(s.asset_class)) byCls.set(s.asset_class, new Map());
    const m = byCls.get(s.asset_class)!;
    m.set(s.decision, (m.get(s.decision) ?? 0) + 1);
  }
  console.log('SHADOW SIGNALS PAR CLASSE :');
  for (const [cls, m] of byCls) {
    const total = [...m.values()].reduce((a,b)=>a+b, 0);
    const accept = m.get('accept') ?? 0;
    const rejects = [...m].filter(([k]) => k !== 'accept').sort((a,b) => b[1]-a[1]).slice(0, 3);
    console.log(`  ${cls.padEnd(22)} total=${total.toString().padStart(3)} accept=${accept.toString().padStart(3)} (${((accept/total)*100).toFixed(0).padStart(3)}%) top rejects: ${rejects.map(([k,v]) => `${k}:${v}`).join(', ')}`);
  }

  // 2. Tous les scanner_candidate_skip TRADER 60min — quels gates bloquent ?
  console.log(`\nSCANNER_CANDIDATE_SKIP TRADER 60min :`);
  const { data: skips } = await sb
    .from('lisa_decision_log')
    .select('timestamp, payload')
    .eq('portfolio_id', TRADER)
    .eq('kind', 'scanner_candidate_skip')
    .gte('timestamp', since)
    .order('timestamp', { ascending: false });
  const gateCounts = new Map<string, { count: number; symbols: Set<string>; isReal: boolean }>();
  for (const s of skips ?? []) {
    const p = s.payload as any;
    const gate = p?.gate ?? 'unknown';
    const reason = p?.reason ?? p?.verdict ?? '';
    const key = `${gate}_${reason}`.replace(/_$/, '');
    const isReal = !(gate === 'CHOP_NOISE' && p?.verdict === 'blind_pass');
    const acc = gateCounts.get(key) ?? { count: 0, symbols: new Set(), isReal };
    acc.count++;
    if (p?.symbol) acc.symbols.add(p.symbol);
    gateCounts.set(key, acc);
  }
  for (const [k, v] of [...gateCounts].sort((a, b) => b[1].count - a[1].count)) {
    const realFlag = v.isReal ? '🔴' : '⚪';
    console.log(`  ${realFlag} ${k.padEnd(35)} count=${v.count.toString().padStart(3)} symbols: ${[...v.symbols].slice(0,5).join(',')}`);
  }

  // 3. position_open_failed TRADER 60min
  console.log(`\nPOSITION_OPEN_FAILED TRADER 60min :`);
  const { data: failed } = await sb
    .from('lisa_decision_log')
    .select('timestamp, payload')
    .eq('portfolio_id', TRADER)
    .eq('kind', 'position_open_failed')
    .gte('timestamp', since)
    .order('timestamp', { ascending: false });
  const failCounts = new Map<string, { count: number; symbols: Set<string> }>();
  for (const f of failed ?? []) {
    const p = f.payload as any;
    const key = p?.error_class ?? 'unknown';
    const acc = failCounts.get(key) ?? { count: 0, symbols: new Set() };
    acc.count++;
    if (p?.symbol) acc.symbols.add(p.symbol);
    failCounts.set(key, acc);
  }
  for (const [k, v] of [...failCounts].sort((a, b) => b[1].count - a[1].count)) {
    console.log(`  🔴 ${k.padEnd(35)} count=${v.count.toString().padStart(3)} symbols: ${[...v.symbols].slice(0,5).join(',')}`);
  }
  if ((failCounts.size ?? 0) === 0) console.log('  ✅ ZÉRO position_open_failed sur 60min');

  // 4. Bypass log via trader_agent_decisions (open_directional applied)
  console.log(`\nTRADER BYPASS ouvertures 60min :`);
  const { data: opens } = await sb
    .from('trader_agent_decisions')
    .select('decided_at, target_symbol, applied_position_id, thesis')
    .eq('portfolio_id', TRADER)
    .eq('action_kind', 'open_directional')
    .gte('decided_at', since)
    .order('decided_at', { ascending: false });
  console.log(`  Total open_directional 60min: ${opens?.length ?? 0}`);
  for (const o of opens ?? []) {
    const isApplied = !!o.applied_position_id;
    const tag = isApplied ? '✅APPLIED' : '❌rejected';
    const t = (o.thesis ?? '').slice(0, 80);
    console.log(`    ${tag} ${o.decided_at?.slice(11,19)} ${o.target_symbol?.padEnd(14)} ${t}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
