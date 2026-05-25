import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';

const env = fs.readFileSync('.env', 'utf8').split('\n').reduce((acc, l) => {
  const m = l.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/); if (m) acc[m[1]] = m[2]; return acc;
}, {} as Record<string, string>);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!);

const PORTFOLIO_ID = '58439d86-3f20-4a60-82a4-307f3f252bc2';
const NEW_CAP = 14;

(async () => {
  // 1. Read current state
  const { data: before } = await sb.from('lisa_session_configs')
    .select('portfolio_id, capital_usd, risk_constraints')
    .eq('portfolio_id', PORTFOLIO_ID).single();
  console.log('BEFORE:', JSON.stringify((before as any)?.risk_constraints, null, 2));

  // 2. Update via JSON merge
  const currentRc = (before as any)?.risk_constraints ?? {};
  const newRc = { ...currentRc, maxOpenPositions: NEW_CAP };
  const { error } = await sb.from('lisa_session_configs')
    .update({ risk_constraints: newRc, updated_at: new Date().toISOString() })
    .eq('portfolio_id', PORTFOLIO_ID);
  if (error) { console.error('UPDATE failed:', error); process.exit(1); }

  // 3. Verify
  const { data: after } = await sb.from('lisa_session_configs')
    .select('risk_constraints').eq('portfolio_id', PORTFOLIO_ID).single();
  console.log('\nAFTER:', JSON.stringify((after as any)?.risk_constraints, null, 2));
  console.log(`\n✅ maxOpenPositions ${currentRc.maxOpenPositions} → ${NEW_CAP}`);
})();
