import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
const env = fs.readFileSync('.env', 'utf8').split('\n').reduce((acc, l) => { const m = l.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/); if (m) acc[m[1]] = m[2]; return acc; }, {} as Record<string, string>);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!);
(async () => {
  const { data: last, error: e1 } = await sb.from('lisa_decision_log').select('portfolio_id, kind, summary, created_at').order('created_at', { ascending: false }).limit(20);
  console.log('Last 20 decision_log (ALL):', e1?.message ?? '');
  if (last) for (const e of last as any[]) console.log(`  ${e.created_at?.slice(0,19)} pid=${e.portfolio_id?.slice(0,8)} ${e.kind.padEnd(35)}`);

  const { data: shadow, error: e2 } = await sb.from('gainers_user_shadow_signals').select('portfolio_id, symbol, market, decision, created_at').order('created_at', { ascending: false }).limit(10);
  console.log('\nLast 10 shadow signals (ALL):', e2?.message ?? '');
  if (shadow) for (const s of shadow as any[]) console.log(`  ${s.created_at?.slice(0,19)} pid=${s.portfolio_id?.slice(0,8)} ${(s.market ?? '?').padEnd(20)} ${s.symbol?.padEnd(12)} ${s.decision}`);

  // Verify portfolio
  const { data: ports } = await sb.from('portfolios').select('id, name').limit(5);
  console.log('\nPortfolios:');
  if (ports) for (const p of ports as any[]) console.log(`  ${p.id} ${p.name}`);
})();
