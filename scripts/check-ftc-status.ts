import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  const TRADER = 'b0000001-0000-0000-0000-000000000001';
  console.log(`\n═══ FTC.LSE status — ${new Date().toISOString().slice(11,19)} UTC ═══\n`);

  // 1. Position complète
  const { data: pos } = await sb
    .from('lisa_positions')
    .select('*')
    .eq('portfolio_id', TRADER)
    .eq('symbol', 'FTC.LSE')
    .eq('status', 'open')
    .single();
  if (!pos) { console.log('❌ FTC.LSE non trouvée open'); return; }
  console.log('Position FTC.LSE :');
  console.log(`  entry_price=$${pos.entry_price}`);
  console.log(`  entry_timestamp=${pos.entry_timestamp}`);
  console.log(`  stop_loss_price=$${pos.stop_loss_price}`);
  console.log(`  take_profit_price=$${pos.take_profit_price}`);
  console.log(`  entry_notional_usd=$${pos.entry_notional_usd}`);
  console.log(`  quantity=${pos.quantity}`);
  console.log(`  peak_pre_exit=${pos.peak_pre_exit ?? 'null'}`);
  console.log(`  venue=${pos.venue}`);
  console.log(`  source=${pos.source}`);
  console.log(`  updated_at=${pos.updated_at}`);

  // 2. RiskMonitor events sur FTC.LSE
  const since = new Date(Date.now() - 60 * 60_000).toISOString();
  const { data: risk } = await sb
    .from('lisa_decision_log')
    .select('timestamp, kind, summary, payload')
    .gte('timestamp', since)
    .or('summary.like.%FTC.LSE%,payload->>symbol.eq.FTC.LSE')
    .order('timestamp', { ascending: false })
    .limit(15);
  console.log(`\nEvents FTC.LSE 60min: ${risk?.length ?? 0}`);
  for (const r of risk ?? []) {
    console.log(`  ${r.timestamp.slice(11,19)} ${r.kind.padEnd(28)} ${(r.summary ?? '').slice(0, 80)}`);
  }

  // 3. Live price via EODHD
  console.log(`\nFetch live price FTC.LSE via EODHD intraday 5m...`);
  const url = `https://eodhd.com/api/intraday/FTC.LSE?interval=5m&api_token=${process.env.EODHD_API_KEY ?? '69e6325aa2c162.98850425'}&fmt=json`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (res.ok) {
      const json = await res.json() as Array<{ timestamp: number; close: number; high: number; datetime: string }>;
      if (Array.isArray(json) && json.length > 0) {
        const last3 = json.slice(-3);
        console.log('Last 3 5m bars :');
        for (const b of last3) {
          console.log(`  ${b.datetime ?? new Date(b.timestamp*1000).toISOString().slice(11,19)} close=$${b.close} high=$${b.high}`);
        }
        const last = json[json.length - 1];
        const entryP = Number(pos.entry_price);
        const pnlPct = ((last.close - entryP) / entryP) * 100;
        console.log(`\n  ★ Last close: $${last.close} vs entry $${entryP} → PnL = ${pnlPct.toFixed(2)}%`);
      }
    } else {
      console.log(`  HTTP ${res.status}`);
    }
  } catch (e) {
    console.log(`  fetch err: ${String(e).slice(0,150)}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
