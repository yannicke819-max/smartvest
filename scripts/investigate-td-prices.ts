import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
const env = fs.readFileSync('.env', 'utf8').split('\n').reduce((acc, l) => {
  const m = l.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/); if (m) acc[m[1]] = m[2]; return acc;
}, {} as Record<string, string>);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!);
const PID = 'b0000001-0000-0000-0000-000000000001';

(async () => {
  // 1. Decision log last 6h - all kinds
  const since6 = new Date(Date.now() - 6 * 3600 * 1000).toISOString();
  const { data: log6 } = await sb.from('lisa_decision_log')
    .select('kind, summary, payload, created_at')
    .eq('portfolio_id', PID)
    .gte('created_at', since6)
    .order('created_at', { ascending: false })
    .limit(500);
  const kinds: Record<string, number> = {};
  if (log6) for (const e of log6 as any[]) kinds[e.kind] = (kinds[e.kind] ?? 0) + 1;
  console.log('=== Last 6h kinds:');
  for (const [k, n] of Object.entries(kinds).sort((a, b) => b[1] - a[1]).slice(0, 30)) console.log(`  ${k.padEnd(45)} ${n}`);

  // 2. Find payload examples for ticker live price source
  console.log('\n=== Payloads with explicit live_price/source/age:');
  let shown = 0;
  if (log6) for (const e of log6 as any[]) {
    const p = e.payload ?? {};
    if ((p.live_price_source || p.source || p.live_price || p.age_sec) && shown < 12) {
      const sym = p.symbol ?? p.ticker ?? '?';
      console.log(`  ${e.created_at.slice(11,19)} ${e.kind.padEnd(35)} sym=${sym} src=${p.live_price_source ?? p.source} price=${p.live_price} age=${p.age_sec ?? p.ageSec}`);
      shown++;
    }
  }

  // 3. Look at the 009190.KO long closed_stop event specifically
  console.log('\n=== 009190.KO long closed_stop investigation:');
  const { data: ko9190 } = await sb.from('lisa_positions')
    .select('*')
    .eq('portfolio_id', PID)
    .eq('symbol', '009190.KO')
    .eq('direction', 'long')
    .order('exit_timestamp', { ascending: false })
    .limit(2);
  if (ko9190) for (const p of ko9190 as any[]) {
    console.log(`  id=${p.id}`);
    console.log(`  status=${p.status} entry=${p.entry_price} exit=${p.exit_price} stop=${p.stop_loss_price} tp=${p.take_profit_price}`);
    console.log(`  entry_at=${p.entry_timestamp} exit_at=${p.exit_timestamp}`);
    console.log(`  exit_reason=${p.exit_reason}`);
    console.log(`  last_known=${p.last_known_price} last_known_at=${p.last_known_price_at}`);
  }

  // 4. Look for the actual close event in decision_log
  const { data: closeEvt } = await sb.from('lisa_decision_log')
    .select('kind, summary, payload, created_at')
    .eq('portfolio_id', PID)
    .ilike('summary', '%009190%')
    .order('created_at', { ascending: false })
    .limit(10);
  console.log('\n=== 009190.KO related events:');
  if (closeEvt) for (const e of closeEvt as any[]) {
    console.log(`  ${e.created_at.slice(11,19)} ${e.kind}`);
    console.log(`    ${e.summary?.slice(0, 200)}`);
    if (e.payload) console.log(`    payload: ${JSON.stringify(e.payload).slice(0, 250)}`);
  }
})();
