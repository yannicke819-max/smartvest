import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
const env = fs.readFileSync('.env', 'utf8').split('\n').reduce((acc, l) => {
  const m = l.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/); if (m) acc[m[1]] = m[2]; return acc;
}, {} as Record<string, string>);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!);
const PID = '58439d86-3f20-4a60-82a4-307f3f252bc2';
(async () => {
  const { data: open } = await sb.from('lisa_positions').select('id, symbol, direction, status').eq('portfolio_id', PID).eq('status', 'open');
  console.log(`OPEN remaining: ${open?.length ?? 0}`);
  const { count: closedToday } = await sb.from('lisa_positions').select('id', { count: 'exact', head: true }).eq('portfolio_id', PID).eq('status', 'closed_invalidated').gte('exit_timestamp', new Date(Date.now() - 5*60*1000).toISOString());
  console.log(`closed_invalidated last 5min: ${closedToday}`);
  const { data: paperOpen } = await sb.from('paper_trades').select('id, symbol').eq('portfolio_id', PID).eq('status', 'open');
  console.log(`paper_trades OPEN remaining: ${paperOpen?.length ?? 0}`);
  if (paperOpen && paperOpen.length) for (const p of paperOpen as any[]) console.log(`  - ${p.symbol}`);
})();
