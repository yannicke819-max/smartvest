import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
const env = fs.readFileSync('.env', 'utf8').split('\n').reduce((acc, l) => {
  const m = l.match(/^([A-Z_]+)=(.+)$/);
  if (m) acc[m[1]] = m[2];
  return acc;
}, {} as Record<string, string>);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!);

async function getLivePrice(sym: string): Promise<number | null> {
  try {
    const r = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${sym}`);
    if (!r.ok) return null;
    const j = await r.json() as { price: string };
    return Number(j.price);
  } catch { return null; }
}

async function main() {
  const todayStart = new Date(); todayStart.setUTCHours(0, 0, 0, 0);
  const { data, error } = await sb
    .from('paper_trades')
    .select('symbol, status, entry_price, opened_at, stop_loss, take_profit, size_usd')
    .filter('status', 'eq', 'open')
    .gte('opened_at', todayStart.toISOString())
    .order('opened_at', { ascending: true });
  if (error) console.error('QUERY ERROR:', error);

  console.log(`\n=== ${data?.length ?? 0} positions OUVERTES @ ${new Date().toISOString().slice(11, 19)} UTC ===\n`);
  let totalUnreal = 0;
  let totalNotional = 0;
  for (const p of (data ?? [])) {
    const live = await getLivePrice(p.symbol);
    if (live == null) { console.log(`  ${p.symbol} : prix live indispo`); continue; }
    const entry = Number(p.entry_price);
    const size = Number(p.size_usd);
    const qty = size / entry;
    const unrealUsd = (live - entry) * qty;
    const unrealPct = (live - entry) / entry * 100;
    const slDist = ((live - Number(p.stop_loss)) / live) * 100;
    const tpDist = ((Number(p.take_profit) - live) / live) * 100;
    const ageMin = Math.round((Date.now() - new Date(p.opened_at).getTime()) / 60_000);
    const sign = unrealUsd >= 0 ? '+' : '';
    const ent = String(p.opened_at).slice(11, 16);
    console.log(`  ${ent}  ${p.symbol.padEnd(10)} entry=${entry.toFixed(4)} live=${live.toFixed(4)} ${sign}${unrealPct.toFixed(2)}% (${sign}$${unrealUsd.toFixed(2)}) | dist SL ${slDist >= 0 ? '+' : ''}${slDist.toFixed(2)}% / TP ${tpDist.toFixed(2)}% | ${ageMin}min`);
    totalUnreal += unrealUsd;
    totalNotional += size;
  }
  console.log(`\n  Σ unrealized = ${totalUnreal >= 0 ? '+' : ''}${totalUnreal.toFixed(2)} $ sur $${totalNotional.toFixed(0)} déployé (${(totalUnreal / totalNotional * 100).toFixed(2)}%)`);
}
main().catch(e => { console.error(e); process.exit(1); });
