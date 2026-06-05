import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
async function main() {
  const syms = ['RDW.US','FTC.LSE','HYLN.US','TLYS.US','NEM.XETRA'];
  console.log('=== 5 dernières closes TRADER ===\n');
  for (const s of syms) {
    const { data } = await sb.from('lisa_positions').select('*').eq('symbol', s).eq('portfolio_id','b0000001-0000-0000-0000-000000000001').neq('status','open').order('exit_timestamp',{ascending:false}).limit(1);
    const p = data?.[0];
    if (!p) { console.log(`${s}: aucune close trouvée`); continue; }
    console.log(`${s.padEnd(14)} ${p.exit_timestamp?.slice(11,19)} status=${p.status} reason=${(p.exit_reason ?? '').slice(0,80)}`);
    
    // decision_log autour de cet exit
    const before = new Date(new Date(p.exit_timestamp).getTime() - 90_000).toISOString();
    const after  = new Date(new Date(p.exit_timestamp).getTime() + 30_000).toISOString();
    const { data: logs } = await sb.from('lisa_decision_log').select('timestamp, kind, summary, payload').eq('portfolio_id','b0000001-0000-0000-0000-000000000001').gte('timestamp', before).lte('timestamp', after).order('timestamp', { ascending: true });
    for (const l of logs ?? []) {
      const sumOrSym = (l.summary ?? '').slice(0,100);
      const hasSym = JSON.stringify(l.payload ?? {}).includes(s);
      if (hasSym || sumOrSym.includes(s) || ['position_closed','reactive_exit','fade_close','mistral_exit','danger_zone'].some(k=>l.kind.includes(k))) {
        console.log(`   ${l.timestamp.slice(11,19)} [${l.kind}] ${sumOrSym}`);
      }
    }
    console.log();
  }
}
main().catch(console.error);
