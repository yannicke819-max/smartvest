import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  const tables = ['paper_trades', 'lisa_positions', 'gainers_user_shadow_signals', 'lisa_decision_log'];
  for (const t of tables) {
    const { count: total } = await sb.from(t).select('*', { count: 'exact', head: true });
    const { count: c30d } = await sb.from(t).select('*', { count: 'exact', head: true }).gte(t === 'paper_trades' ? 'opened_at' : (t === 'lisa_positions' ? 'entry_timestamp' : (t === 'lisa_decision_log' ? 'created_at' : 'detected_at')), new Date(Date.now() - 30*24*3600e3).toISOString());
    const { count: c14d } = await sb.from(t).select('*', { count: 'exact', head: true }).gte(t === 'paper_trades' ? 'opened_at' : (t === 'lisa_positions' ? 'entry_timestamp' : (t === 'lisa_decision_log' ? 'created_at' : 'detected_at')), new Date(Date.now() - 14*24*3600e3).toISOString());
    console.log(`${t.padEnd(35)} total=${total} | 30d=${c30d} | 14d=${c14d}`);
  }
  console.log();

  // Closed positions all-time per portfolio (lisa_positions)
  const { data: lp } = await sb.from('lisa_positions').select('portfolio_id, status').neq('status', 'open');
  const PORT: Record<string, string> = {
    '58439d86-3f20-4a60-82a4-307f3f252bc2': 'MAIN/TRADER',
    'a0000001-0000-0000-0000-000000000001': 'HIGH',
    'a0000002-0000-0000-0000-000000000002': 'MIDDLE',
    'a0000003-0000-0000-0000-000000000003': 'SMALL',
  };
  const closedByP: Record<string, number> = {};
  for (const r of lp ?? []) {
    const p = PORT[r.portfolio_id as string] || (r.portfolio_id as string)?.slice(0,8) || 'unk';
    closedByP[p] = (closedByP[p] || 0) + 1;
  }
  console.log('Lisa_positions closed all-time par portfolio :');
  for (const [k, v] of Object.entries(closedByP).sort((a,b) => b[1] - a[1])) console.log(`  ${k}: ${v}`);
}
main().catch(e => { console.error(e); process.exit(1); });
