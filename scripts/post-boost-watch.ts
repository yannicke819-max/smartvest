import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const SINCE = new Date().toISOString();
const names: Record<string,string> = {'b0000001-0000-0000-0000-000000000001':'TRADER','a0000001-0000-0000-0000-000000000001':'HIGH','a0000002-0000-0000-0000-000000000002':'MIDDLE','a0000003-0000-0000-0000-000000000003':'SMALL'};

async function main() {
  console.log(`Watching shadow signals since ${SINCE}\n`);
  const start = Date.now();
  let lastReportAt = 0;
  while (true) {
    const { data: signals, count } = await sb.from('gainers_user_shadow_signals')
      .select('decision, symbol, persistence_score, cfg_min_persistence, cfg_asia_boost, portfolio_id, change_pct_1m, created_at', { count: 'exact' })
      .gte('created_at', SINCE).limit(500);
    if (signals && signals.length > 5 && Date.now() - lastReportAt > 60_000) {
      lastReportAt = Date.now();
      console.log(`[T+${((Date.now()-start)/1000).toFixed(0)}s] Total signals : ${count}`);
      // Stats par portfolio
      const byPort: Record<string, Record<string, number>> = {};
      for (const s of signals) {
        const p = names[s.portfolio_id ?? ''] ?? '?';
        if (!byPort[p]) byPort[p] = {};
        byPort[p][s.decision ?? '?'] = (byPort[p][s.decision ?? '?'] ?? 0) + 1;
      }
      console.log('  Par portfolio × decision :');
      for (const [p, m] of Object.entries(byPort)) {
        const detail = Object.entries(m).sort((a,b) => b[1]-a[1]).map(([k,v]) => `${k}=${v}`).join(' ');
        console.log(`    ${p.padEnd(8)} ${detail}`);
      }
      // Accept events specifiquement
      const accepts = signals.filter(s => s.decision === 'accept');
      if (accepts.length > 0) {
        console.log(`\n  🟢 ACCEPTS (${accepts.length}) :`);
        for (const a of accepts.slice(0, 10)) console.log(`    ${a.created_at?.slice(11,19)} [${names[a.portfolio_id ?? '']}] ${a.symbol} ch=${a.change_pct_1m}% pers=${a.persistence_score}`);
      }
    }
    if (Date.now() - start > 12 * 60_000) { console.log('\nTIMEOUT 12min'); return; }
    await new Promise(r => setTimeout(r, 45_000));
  }
}
main();
