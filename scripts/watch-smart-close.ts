/**
 * Watch decision_log for [SMART_CLOSE_LOCK_PROFIT] events (PR #464).
 * Also surfaces [FORCE_CLOSE_BEFORE_CLOSE] at the hard cutoff for context.
 */
import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';

const env = fs.readFileSync('.env', 'utf8').split('\n').reduce((a: any, l) => {
  const m = l.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/); if (m) a[m[1]] = m[2]; return a;
}, {} as Record<string, string>);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!);
const PID = '58439d86-3f20-4a60-82a4-307f3f252bc2';

const seen = new Set<string>();

async function tick(i: number) {
  const now = new Date().toISOString().slice(11, 19);
  const since = new Date(Date.now() - 5 * 60_000).toISOString();

  const { data } = await sb.from('lisa_decision_log')
    .select('id, kind, summary, payload, timestamp')
    .eq('portfolio_id', PID).eq('kind', 'position_closed')
    .gte('timestamp', since)
    .order('timestamp', { ascending: true });

  const fresh = (data ?? []).filter((e: any) => !seen.has(e.id));
  for (const e of fresh as any[]) {
    seen.add(e.id);
    const tag = e.payload?.tag === 'SMART_CLOSE_LOCK_PROFIT'
      ? '🟢 SMART_CLOSE'
      : (e.summary ?? '').includes('FORCE_CLOSE_BEFORE_CLOSE') ? '🔴 FORCE_CLOSE' : '⚪ position_closed';
    const sym = e.payload?.symbol ?? '?';
    const dir = e.payload?.direction ?? '?';
    const pnl = e.payload?.pnl_pct != null ? `${Number(e.payload.pnl_pct).toFixed(2)}%` : '?';
    const minToClose = e.payload?.minutes_to_close ?? '?';
    console.log(`${tag} ${e.timestamp.slice(11, 19)} ${sym.padEnd(12)} ${dir.padEnd(5)} pnl=${pnl} (T-${minToClose}min)`);
  }

  // Periodic heartbeat: count smart-close & open positions every 5 cycles
  if (i % 5 === 0) {
    const { data: open } = await sb.from('lisa_positions')
      .select('symbol').eq('portfolio_id', PID).eq('status', 'open');
    const smartCount = [...seen].length; // approximation
    console.log(`[${now}] open=${open?.length ?? 0}  events_captured=${seen.size}`);
  }
}

(async () => {
  // Baseline = existing position_closed events today (don't re-report)
  const sinceBaseline = new Date(Date.now() - 12 * 3600_000).toISOString();
  const { data: baseline } = await sb.from('lisa_decision_log')
    .select('id').eq('portfolio_id', PID).eq('kind', 'position_closed')
    .gte('timestamp', sinceBaseline);
  for (const e of (baseline ?? []) as any[]) seen.add(e.id);
  console.log(`Baseline: ${seen.size} position_closed events already captured.`);
  console.log(`Watching for [SMART_CLOSE_LOCK_PROFIT] + [FORCE_CLOSE_BEFORE_CLOSE] (poll 30s)...\n`);

  const maxCycles = Number(process.env.MAX_CYCLES ?? 180); // 180 × 30s = 90min (couvre 14:30 → 16:00 UTC)
  for (let i = 0; i < maxCycles; i++) {
    try { await tick(i); } catch (e: any) { console.error(`tick err: ${e.message}`); }
    await new Promise(r => setTimeout(r, 30_000));
  }
  console.log(`\nWatcher terminé après ${maxCycles} cycles.`);
})();
