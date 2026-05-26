import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL || '', process.env.SUPABASE_SERVICE_ROLE_KEY || '');
const PID = '58439d86-3f20-4a60-82a4-307f3f252bc2';
const START = new Date().toISOString();

const seen = new Set<string>();
console.log(`[watcher start] ${START}`);
console.log(`Polling every 30s. Watching: persistence_log, shadow_signals, decision_log, lisa_positions`);

async function tick() {
  const now = new Date().toISOString();

  // 1. persistence_log new ticks
  const { data: gpl } = await sb.from('gainers_persistence_log')
    .select('id, captured_at, summary')
    .gte('captured_at', START)
    .order('captured_at', { ascending: false });
  for (const r of (gpl ?? [])) {
    if (seen.has('gpl_'+r.id)) continue;
    seen.add('gpl_'+r.id);
    const sum = typeof r.summary === 'string' ? r.summary : JSON.stringify(r.summary);
    console.log(`[${now.slice(11,19)}] 🟢 SCANNER_TICK @ ${r.captured_at.slice(11,19)} summary=${sum.slice(0,120)}`);
  }

  // 2. shadow_signals
  const { data: sigs } = await sb.from('gainers_user_shadow_signals')
    .select('*')
    .gte('created_at', START)
    .order('created_at', { ascending: false });
  for (const r of (sigs ?? [])) {
    if (seen.has('sig_'+r.id)) continue;
    seen.add('sig_'+r.id);
    const keys = Object.keys(r);
    const decisionKey = keys.find(k => k.includes('decision') || k.includes('gate'));
    const reasonKey = keys.find(k => k.includes('reason') || k.includes('rejected'));
    console.log(`[${now.slice(11,19)}] 🎯 SHADOW_SIG ${r.symbol ?? r.ticker} ${decisionKey ? r[decisionKey] : ''} ${reasonKey ? r[reasonKey] : ''}`);
  }

  // 3. decision_log
  const { data: dl } = await sb.from('lisa_decision_log')
    .select('id, timestamp, kind, summary')
    .eq('portfolio_id', PID)
    .gte('timestamp', START)
    .order('timestamp', { ascending: false });
  for (const e of (dl ?? [])) {
    if (seen.has('dl_'+e.id)) continue;
    seen.add('dl_'+e.id);
    const tag = e.kind?.includes('position_opened') ? '✅OPEN' :
                e.kind?.includes('position_closed') ? '❌CLOSE' :
                e.kind?.includes('failed') ? '🚫FAIL' :
                e.kind?.includes('risk_monitor') ? '🛡️ RISK' :
                e.kind?.includes('thesis_broken') ? '⚠️ THESIS' : '  EVT';
    console.log(`[${now.slice(11,19)}] ${tag} ${e.timestamp.slice(11,19)} [${e.kind}] ${(e.summary ?? '').slice(0,110)}`);
  }

  // 4. positions
  const { data: pos } = await sb.from('lisa_positions')
    .select('id, symbol, direction, entry_price, status, entry_timestamp, closed_at, realized_pnl_usd, exit_reason')
    .eq('portfolio_id', PID)
    .gte('entry_timestamp', START)
    .order('entry_timestamp', { ascending: false });
  for (const p of (pos ?? [])) {
    if (seen.has('pos_'+p.id+'_'+p.status)) continue;
    seen.add('pos_'+p.id+'_'+p.status);
    if (p.status === 'open') {
      console.log(`[${now.slice(11,19)}] 🟢 POSITION_OPEN ${p.symbol} ${p.direction} entry=${p.entry_price}`);
    } else {
      console.log(`[${now.slice(11,19)}] 🔴 POSITION_CLOSED ${p.symbol} ${p.direction} pnl=$${p.realized_pnl_usd} reason=${p.exit_reason}`);
    }
  }
}

(async () => {
  let i = 0;
  while (true) {
    try { await tick(); } catch (e) { console.error(`[poll err] ${String(e).slice(0,200)}`); }
    i++;
    if (i % 4 === 0) {
      // heartbeat every 2min
      console.log(`[${new Date().toISOString().slice(11,19)}] ⏱  heartbeat (i=${i}, seen=${seen.size}) — toujours en écoute`);
    }
    if (i >= 240) { console.log('[watcher end] 2h max'); break; }
    await new Promise(r => setTimeout(r, 30000));
  }
})();
