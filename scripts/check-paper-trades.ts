import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
const env = fs.readFileSync('.env', 'utf8').split('\n').reduce((acc, l) => {
  const m = l.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/); if (m) acc[m[1]] = m[2]; return acc;
}, {} as Record<string, string>);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!);
const PID = 'b0000001-0000-0000-0000-000000000001';
(async () => {
  const { data: open } = await sb.from('paper_trades')
    .select('id, symbol, direction, status, entry_timestamp')
    .eq('portfolio_id', PID)
    .eq('status', 'open')
    .order('entry_timestamp', { ascending: false });
  console.log(`paper_trades OPEN: ${open?.length ?? 0}`);
  if (open) for (const p of open as any[]) console.log(`  ${p.symbol.padEnd(12)} ${p.direction.padEnd(6)} entry=${p.entry_timestamp}`);
})();
