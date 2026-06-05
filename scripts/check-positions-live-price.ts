import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  const TRADER = 'b0000001-0000-0000-0000-000000000001';
  const { data: positions } = await sb
    .from('lisa_positions')
    .select('*')
    .eq('portfolio_id', TRADER)
    .eq('status', 'open');
  console.log(`Positions ouvertes TRADER : ${positions?.length ?? 0}\n`);
  for (const p of positions ?? []) {
    console.log(`═══ ${p.symbol} ═══`);
    const cols = Object.keys(p).filter(k => /price|pnl|current|last|live|update|peak/i.test(k));
    for (const c of cols) {
      console.log(`  ${c.padEnd(35)}: ${JSON.stringify(p[c])}`);
    }
    console.log();
  }

  // Live EODHD
  for (const sym of ['CMCX.LSE', 'SAVE.LSE']) {
    const url = `https://eodhd.com/api/real-time/${sym}?api_token=${process.env.EODHD_API_KEY ?? '69e6325aa2c162.98850425'}&fmt=json`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      const json = await res.json();
      console.log(`Live EODHD ${sym}: close=${json.close} change_p=${json.change_p}% ts=${new Date(json.timestamp*1000).toISOString().slice(11,19)} UTC`);
    } catch (e) {
      console.log(`Live EODHD ${sym}: err`);
    }
  }
}
main().catch(e => { console.error(e); process.exit(1); });
