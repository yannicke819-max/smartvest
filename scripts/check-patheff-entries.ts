import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
const env = fs.readFileSync('.env', 'utf8').split('\n').reduce((acc, l) => {
  const m = l.match(/^([A-Z_]+)=(.+)$/);
  if (m) acc[m[1]] = m[2];
  return acc;
}, {} as Record<string, string>);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  const todayStart = new Date(); todayStart.setUTCHours(0, 0, 0, 0);
  const { data } = await sb
    .from('gainers_user_shadow_signals')
    .select('symbol, path_eff, persistence_score, persistence_count, change_pct_1m, cfg_min_path_eff, created_at')
    .gte('created_at', todayStart.toISOString())
    .eq('decision', 'accept')
    .in('symbol', ['SOLUSDT', 'ETHUSDT', 'XRPUSDT', 'BNBUSDT', 'BTCUSDT'])
    .order('created_at', { ascending: true });

  console.log(`\n=== pathEff @ open des 5 positions du jour ===\n`);
  for (const r of (data ?? [])) {
    const at = r.created_at.slice(11, 16);
    console.log(`  ${at}  ${r.symbol.padEnd(10)} pathEff=${Number(r.path_eff).toFixed(3)}  persist=${r.persistence_count} (${Number(r.persistence_score).toFixed(2)})  ch1m=+${Number(r.change_pct_1m).toFixed(2)}%  [cfg min=${Number(r.cfg_min_path_eff).toFixed(2)}]`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
