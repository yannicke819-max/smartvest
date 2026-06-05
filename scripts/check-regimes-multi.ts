import 'dotenv/config';
const EODHD = '69e6325aa2c162.98850425';

async function eod(sym: string, from: string, to: string) {
  const r = await fetch(`https://eodhd.com/api/eod/${sym}?from=${from}&to=${to}&api_token=${EODHD}&fmt=json`);
  if (!r.ok) return null;
  return await r.json() as any[];
}
async function realtime(sym: string) {
  const r = await fetch(`https://eodhd.com/api/real-time/${sym}?api_token=${EODHD}&fmt=json`);
  if (!r.ok) return null;
  return await r.json() as any;
}

function r5d(sorted: any[]): number | null {
  if (sorted.length < 6) return null;
  const last = sorted[sorted.length-1];
  const fb = sorted[sorted.length-6];
  return ((last.close / fb.close) - 1) * 100;
}

async function main() {
  console.log('=== Régimes macro par zone — état 05/06/2026 intraday ===\n');
  
  // US (référence)
  const spy = await eod('SPY.US','2026-05-25','2026-06-05'); 
  const spyRt = await realtime('SPY.US');
  const vix = await eod('VIX.INDX','2026-05-25','2026-06-05');
  const vixRt = await realtime('VIX.INDX');
  console.log('🇺🇸 US:');
  console.log(`   SPY close 04/06 = ${spy?.[spy.length-1]?.close}  intraday now = ${spyRt?.close} (Δ ${spyRt?.change_p}%)`);
  console.log(`   SPY 5d return EOD 04/06 = ${r5d(spy ?? [])?.toFixed(2)}%`);
  console.log(`   VIX close 04/06 = ${vix?.[vix.length-1]?.close}  intraday now = ${vixRt?.close} (Δ ${vixRt?.change_p}%)`);

  // EU - Euro Stoxx 50 + V2X
  const sx5e = await eod('SX5E.INDX','2026-05-25','2026-06-05');
  const sx5eRt = await realtime('SX5E.INDX');
  const v2x = await eod('V2TX.INDX','2026-05-25','2026-06-05');
  const v2xRt = await realtime('V2TX.INDX');
  console.log('\n🇪🇺 EU:');
  console.log(`   SX5E close 04/06 = ${sx5e?.[sx5e.length-1]?.close}  intraday now = ${sx5eRt?.close} (Δ ${sx5eRt?.change_p}%)`);
  console.log(`   SX5E 5d return EOD 04/06 = ${r5d(sx5e ?? [])?.toFixed(2)}%`);
  console.log(`   V2TX (vol EU) close = ${v2x?.[v2x?.length-1]?.close}  intraday now = ${v2xRt?.close} (Δ ${v2xRt?.change_p}%)`);
  
  // Asia - Nikkei + Hang Seng
  const n225 = await eod('N225.INDX','2026-05-25','2026-06-05');
  const n225Rt = await realtime('N225.INDX');
  const hsi = await eod('HSI.INDX','2026-05-25','2026-06-05');
  const hsiRt = await realtime('HSI.INDX');
  console.log('\n🇯🇵 Asia:');
  console.log(`   Nikkei close 04/06 = ${n225?.[n225.length-1]?.close}  intraday = ${n225Rt?.close} (Δ ${n225Rt?.change_p}%)`);
  console.log(`   Nikkei 5d return EOD 04/06 = ${r5d(n225 ?? [])?.toFixed(2)}%`);
  console.log(`   HSI close 04/06 = ${hsi?.[hsi.length-1]?.close}  intraday = ${hsiRt?.close} (Δ ${hsiRt?.change_p}%)`);
  console.log(`   HSI 5d return EOD 04/06 = ${r5d(hsi ?? [])?.toFixed(2)}%`);
  
  // Crypto
  const btc = await eod('BTC-USD.CC','2026-05-25','2026-06-05');
  const btcRt = await realtime('BTC-USD.CC');
  console.log('\n💎 Crypto:');
  console.log(`   BTC close 04/06 = ${btc?.[btc.length-1]?.close}  intraday = ${btcRt?.close} (Δ ${btcRt?.change_p}%)`);
  console.log(`   BTC 5d return EOD 04/06 = ${r5d(btc ?? [])?.toFixed(2)}%`);
  
  // Verdict — appliqué aux seuils data-driven actuels (VIX>17, ΔVIX>10%, SPY 5d<-1%)
  console.log('\n=== VERDICT par zone (seuils US-style appliqués au proxy local) ===');
}
main().catch(console.error);
