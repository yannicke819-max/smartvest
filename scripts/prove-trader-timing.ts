/**
 * Prouve (ou réfute) si TRADER est entré au bon moment sur ses 2 positions
 * ouvertes aujourd'hui (EZJ.LSE 11:06 et RPI.LSE 11:54).
 *
 * Méthode :
 *   1. Position : entry_price, entry_timestamp, TP, SL, taille
 *   2. Live price actuel via EODHD intraday 5m (LSE)
 *   3. Candles 5m T-30min → T+30min autour de l'entrée → peak, trough, path
 *   4. Verdict :
 *      - PnL actuel vs entry
 *      - MFE intra-session (best favorable since entry)
 *      - MAE intra-session (worst adverse since entry)
 *      - Entry vs T-15min low : a-t-on entré au peak local OU avec marge ?
 *      - Distance TP / distance SL
 */
import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';

const env = fs.readFileSync('.env', 'utf8').split('\n').reduce((acc, l) => {
  const m = l.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/); if (m) acc[m[1]] = m[2]; return acc;
}, {} as Record<string, string>);

const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!);
const TRADER = 'b0000001-0000-0000-0000-000000000001';
const EODHD_KEY = env.EODHD_API_KEY;

async function fetchEodhdIntraday(symbol: string, interval = '5m', range = 24 * 3600): Promise<any[]> {
  // EODHD intraday endpoint
  const url = `https://eodhd.com/api/intraday/${symbol}?api_token=${EODHD_KEY}&interval=${interval}&from=${Math.floor((Date.now() - range * 1000) / 1000)}&to=${Math.floor(Date.now() / 1000)}&fmt=json`;
  try {
    const r = await fetch(url);
    if (!r.ok) { console.log(`  EODHD ${symbol} HTTP ${r.status}`); return []; }
    return await r.json() as any[];
  } catch (e) { console.log(`  EODHD ${symbol} err: ${String(e).slice(0, 80)}`); return []; }
}

(async () => {
  console.log(`\n========== TRADER ENTRY TIMING AUDIT — ${new Date().toISOString()} ==========\n`);

  const { data: positions }: any = await sb.from('lisa_positions')
    .select('id, symbol, entry_price, entry_timestamp, take_profit_price, stop_loss_price, direction, asset_class')
    .eq('portfolio_id', TRADER).eq('status', 'open')
    .order('entry_timestamp', { ascending: true });

  console.log(`Open positions: ${positions?.length ?? 0}\n`);

  for (const p of positions ?? []) {
    const entryPrice = Number(p.entry_price);
    const tp = Number(p.take_profit_price);
    const sl = Number(p.stop_loss_price);
    const entryTs = new Date(p.entry_timestamp).getTime();
    const ageMin = (Date.now() - entryTs) / 60_000;

    console.log(`━━━ ${p.symbol} (${p.direction}) ━━━`);
    console.log(`  Entry  : $${entryPrice.toFixed(4)} @ ${p.entry_timestamp.slice(11, 19)} UTC (il y a ${ageMin.toFixed(1)}min)`);
    console.log(`  TP     : $${tp.toFixed(4)} (+${(((tp - entryPrice) / entryPrice) * 100).toFixed(2)}%)`);
    console.log(`  SL     : $${sl.toFixed(4)} (${(((sl - entryPrice) / entryPrice) * 100).toFixed(2)}%)`);

    // Fetch candles 5m last 6h
    const candles = await fetchEodhdIntraday(p.symbol, '5m', 6 * 3600);
    if (!candles.length) {
      console.log(`  ⚠️  Pas de candles disponibles\n`);
      continue;
    }

    // Latest price
    const latest = candles[candles.length - 1];
    const livePrice = Number(latest.close);
    const pnlPct = ((livePrice - entryPrice) / entryPrice) * 100;
    console.log(`  Live   : $${livePrice.toFixed(4)} (${latest.datetime ?? new Date(latest.timestamp * 1000).toISOString().slice(11, 19)}) → PnL ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%`);

    // Pre-entry 30min (peak/trough avant entrée)
    const preEntry = candles.filter((c: any) => new Date(c.datetime ?? c.timestamp * 1000).getTime() < entryTs && new Date(c.datetime ?? c.timestamp * 1000).getTime() >= entryTs - 30 * 60_000);
    if (preEntry.length) {
      const preHigh = Math.max(...preEntry.map((c: any) => Number(c.high)));
      const preLow = Math.min(...preEntry.map((c: any) => Number(c.low)));
      const peakDistance = ((entryPrice - preHigh) / preHigh) * 100;
      const lowDistance = ((entryPrice - preLow) / preLow) * 100;
      console.log(`  T-30min : high=$${preHigh.toFixed(4)} low=$${preLow.toFixed(4)}`);
      console.log(`    → entry vs T-30 high : ${peakDistance >= 0 ? '+' : ''}${peakDistance.toFixed(2)}% ${peakDistance > 0.5 ? '⚠️  AU-DESSUS du peak récent (FOMO entry ?)' : peakDistance < -1 ? '✅ pullback engagé' : '➖ proche du peak'}`);
      console.log(`    → entry vs T-30 low  : +${lowDistance.toFixed(2)}% (extension depuis le low récent)`);
    }

    // Post-entry MFE/MAE
    const postEntry = candles.filter((c: any) => new Date(c.datetime ?? c.timestamp * 1000).getTime() >= entryTs);
    if (postEntry.length) {
      const mfeHigh = Math.max(...postEntry.map((c: any) => Number(c.high)));
      const maeLow = Math.min(...postEntry.map((c: any) => Number(c.low)));
      const mfePct = ((mfeHigh - entryPrice) / entryPrice) * 100;
      const maePct = ((maeLow - entryPrice) / entryPrice) * 100;
      const tpPct = ((tp - entryPrice) / entryPrice) * 100;
      const slPct = ((sl - entryPrice) / entryPrice) * 100;
      console.log(`  Post-entry (${postEntry.length} candles 5m) :`);
      console.log(`    MFE    : +${mfePct.toFixed(2)}% (best favorable) ${mfePct >= tpPct ? '→ TP DÉJÀ TOUCHÉ' : mfePct >= tpPct * 0.5 ? '→ mi-chemin TP' : ''}`);
      console.log(`    MAE    : ${maePct.toFixed(2)}% (worst adverse) ${maePct <= slPct ? '→ SL DÉJÀ TOUCHÉ' : maePct <= slPct * 0.5 ? '→ mi-chemin SL' : ''}`);
      console.log(`    MAE/R  : ${(Math.abs(maePct) / Math.abs(slPct)).toFixed(2)} (sain < 0.5, stress > 1.0)`);
    }

    // Last 5 candles 5m
    console.log(`  Path 5 derniers 5m :`);
    for (const c of candles.slice(-5)) {
      const ts = c.datetime ?? new Date(c.timestamp * 1000).toISOString().slice(11, 19);
      const cl = Number(c.close);
      const pct = ((cl - entryPrice) / entryPrice) * 100;
      console.log(`    ${ts} O=${Number(c.open).toFixed(2)} H=${Number(c.high).toFixed(2)} L=${Number(c.low).toFixed(2)} C=${cl.toFixed(2)} (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}% vs entry)`);
    }
    console.log('');
  }

  console.log('========== VERDICT ==========\n');
  console.log('Interpretation :');
  console.log('  ✅ BON timing si : entry au pullback OU MAE/R < 0.5 OU MFE > 50% TP');
  console.log('  ⚠️  MAUVAIS timing si : entry > 0.5% au-dessus du peak T-30min ET MAE/R > 1.0');
  console.log('  ➖ NEUTRE : à mi-chemin');
})();
