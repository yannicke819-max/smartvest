import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
const env = fs.readFileSync('.env', 'utf8').split('\n').reduce((acc, l) => {
  const m = l.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/); if (m) acc[m[1]] = m[2]; return acc;
}, {} as Record<string, string>);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!);
const PID = '58439d86-3f20-4a60-82a4-307f3f252bc2';
(async () => {
  const { data: before } = await sb.from('lisa_session_configs')
    .select('gainers_max_open_positions, risk_constraints').eq('portfolio_id', PID).single();
  console.log('BEFORE:');
  console.log('  gainers_max_open_positions (REAL cap scanner):', (before as any)?.gainers_max_open_positions);
  console.log('  risk_constraints.maxOpenPositions (général):', (before as any)?.risk_constraints?.maxOpenPositions);

  const { error } = await sb.from('lisa_session_configs')
    .update({ gainers_max_open_positions: 14, updated_at: new Date().toISOString() })
    .eq('portfolio_id', PID);
  if (error) { console.error('FAIL:', error); process.exit(1); }

  const { data: after } = await sb.from('lisa_session_configs')
    .select('gainers_max_open_positions').eq('portfolio_id', PID).single();
  console.log('\nAFTER:');
  console.log('  gainers_max_open_positions:', (after as any)?.gainers_max_open_positions);
  console.log(`\n✅ Cap scanner ${(before as any)?.gainers_max_open_positions} → 14`);
})();
