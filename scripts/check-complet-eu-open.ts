import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
const env = fs.readFileSync('.env', 'utf8').split('\n').reduce((acc, l) => {
  const m = l.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/); if (m) acc[m[1]] = m[2]; return acc;
}, {} as Record<string, string>);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!);
const TD = '1304e11cb4f648b196e9b6b2182705ab';
const PID = '58439d86-3f20-4a60-82a4-307f3f252bc2';

(async () => {
  const now = new Date();
  console.log(`\n========== CHECK COMPLET — ${now.toISOString().slice(0,19)}Z ==========\n`);

  // ===== 1. PROD STATE =====
  const v = await fetch('https://smartvest.fly.dev/version').then(r => r.json()).catch(() => null);
  console.log('1. PROD');
  console.log(`   git_sha=${(v as any)?.git_sha?.slice(0,8) ?? '?'}  build=${(v as any)?.build_time ?? '?'}`);

  // ===== 2. CONFIG =====
  const { data: cfg } = await sb.from('lisa_session_configs').select('*').eq('portfolio_id', PID).single();
  if (cfg) {
    console.log('\n2. CONFIG');
    console.log(`   strategy_mode=${(cfg as any).strategy_mode}  autopilot=${(cfg as any).autopilot_enabled}  kill_switch=${(cfg as any).kill_switch_active}  paused_reason=${(cfg as any).autopilot_paused_reason}`);
    console.log(`   profile=${(cfg as any).profile}  capital_usd=${(cfg as any).capital_usd}  daily_budget=${(cfg as any).daily_cost_budget_usd}`);
    console.log(`   maxOpenPositions=${(cfg as any).max_open_positions ?? '?'}  cycle_minutes=${(cfg as any).autopilot_cycle_minutes ?? '?'}`);
  }

  // ===== 3. STATE positions =====
  const { data: open } = await sb.from('lisa_positions')
    .select('symbol, direction, asset_class, entry_price, entry_notional_usd, entry_timestamp')
    .eq('portfolio_id', PID).eq('status', 'open');
  console.log(`\n3. OPEN POSITIONS: ${open?.length ?? 0}`);
  if (open && open.length) {
    let total = 0;
    for (const p of open as any[]) {
      const ageMin = Math.floor((Date.now() - new Date(p.entry_timestamp).getTime()) / 60000);
      console.log(`   ${p.symbol.padEnd(12)} ${p.direction.padEnd(6)} ${(p.asset_class ?? '?').padEnd(20)} entry=${p.entry_price} notional=$${p.entry_notional_usd} age=${ageMin}min`);
      total += Number(p.entry_notional_usd);
    }
    console.log(`   TOTAL EXPOSURE: $${total.toFixed(2)}`);
  }

  // ===== 4. RECENT ACTIVITY 5min =====
  const since5 = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const { data: log5 } = await sb.from('lisa_decision_log')
    .select('kind, summary, created_at')
    .eq('portfolio_id', PID).gte('created_at', since5)
    .order('created_at', { ascending: false }).limit(100);
  const kinds: Record<string, number> = {};
  if (log5) for (const e of log5 as any[]) kinds[e.kind] = (kinds[e.kind] ?? 0) + 1;
  console.log(`\n4. DECISION_LOG last 5min (${log5?.length ?? 0} events)`);
  for (const [k, n] of Object.entries(kinds).sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(`   ${k.padEnd(40)} ${n}`);

  // ===== 5. SHADOW SIGNALS (gainers funnel) last 30min =====
  const since30 = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const { data: shadow } = await sb.from('gainers_user_shadow_signals')
    .select('symbol, asset_class, market, decision, decision_reason, created_at')
    .eq('portfolio_id', PID).gte('created_at', since30)
    .order('created_at', { ascending: false }).limit(200);
  console.log(`\n5. SHADOW SIGNALS last 30min (${shadow?.length ?? 0})`);
  if (shadow) {
    const byMarket: Record<string, { accept: number; reject: number; reasons: Record<string, number> }> = {};
    for (const s of shadow as any[]) {
      const m = s.market ?? 'unknown';
      byMarket[m] ??= { accept: 0, reject: 0, reasons: {} };
      if (s.decision === 'accept') byMarket[m].accept++;
      else { byMarket[m].reject++; byMarket[m].reasons[s.decision_reason ?? 'unk'] = (byMarket[m].reasons[s.decision_reason ?? 'unk'] ?? 0) + 1; }
    }
    for (const [m, v] of Object.entries(byMarket).sort((a, b) => (b[1].accept + b[1].reject) - (a[1].accept + a[1].reject))) {
      console.log(`   ${m.padEnd(18)} accept=${v.accept}  reject=${v.reject}`);
      for (const [r, n] of Object.entries(v.reasons).sort((a, b) => b[1] - a[1]).slice(0, 4)) console.log(`     - ${r.padEnd(36)} ${n}`);
    }
  }

  // ===== 6. EU TD LIVE PROBE =====
  console.log(`\n6. EU TD LIVE PROBE`);
  const probes = [
    { td: 'BMW:XETR', class: 'EU' }, { td: 'AIR:EURONEXT', class: 'EU' },
    { td: 'SIE:XETR', class: 'EU' }, { td: 'BARC:LSE', class: 'EU' },
    { td: 'HSBA:LSE', class: 'EU' }, { td: 'SAN:EURONEXT', class: 'EU' },
    { td: 'LVMH:EURONEXT', class: 'EU' },
  ];
  for (const p of probes) {
    try {
      const r = await fetch(`https://api.twelvedata.com/quote?symbol=${encodeURIComponent(p.td)}&apikey=${TD}`);
      const j: any = await r.json();
      if (j.code) { console.log(`   ${p.td.padEnd(16)} ERR ${j.message?.slice(0,40)}`); continue; }
      const tsSec = j.timestamp ? Number(j.timestamp) : 0;
      const age = tsSec ? Math.floor(Date.now()/1000 - tsSec) : -1;
      const ageStr = age < 60 ? `${age}s` : age < 3600 ? `${(age/60).toFixed(1)}m` : `${(age/3600).toFixed(1)}h`;
      const ch = j.percent_change ? Number(j.percent_change).toFixed(2) : '?';
      console.log(`   ${p.td.padEnd(16)} close=${String(j.close).padStart(10)} chg=${ch.padStart(7)}% age=${ageStr.padStart(6)} open=${j.is_market_open}`);
    } catch (e: any) { console.log(`   ${p.td}: ${e.message}`); }
  }

  // ===== 7. LAST CYCLE =====
  const { data: lastCycle } = await sb.from('lisa_mechanical_cycle_summary')
    .select('*').eq('portfolio_id', PID)
    .order('created_at', { ascending: false }).limit(3);
  console.log(`\n7. LAST 3 MECHANICAL CYCLES`);
  if (lastCycle) for (const c of lastCycle as any[]) {
    console.log(`   ${c.created_at?.slice(11,19)}  step3=${c.step3_skip_reason ?? 'ran'}  opens=${c.opens_count ?? 0}  closes=${c.closes_count ?? 0}`);
  }
})();
