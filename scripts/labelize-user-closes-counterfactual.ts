/**
 * COUNTERFACTUAL LABELER — t'as fermé trop tôt ou bien ?
 *
 * Pour chaque close manual 04/06, fetch les candles 5m EODHD APRÈS le close
 * et calcule :
 *   - max_price_60min      : pic atteint dans les 60 min après close
 *   - max_extra_pnl_pct    : surplus PnL atteignable si on avait hold
 *   - price_at_close_session (21:00 UTC) : valeur en fin de séance
 *   - extra_eod_pnl_pct    : surplus PnL si on avait hold jusqu'au close US
 *
 * Verdict :
 *   - 🟢 GOOD   : extra_pnl ≤ 0.3% (timing parfait, peu/pas d'upside raté)
 *   - 🟡 OK     : 0.3% < extra_pnl ≤ 1.0% (acceptable)
 *   - 🔴 EARLY  : extra_pnl > 1.0% (tu as fermé trop tôt, le rebond continuait)
 *
 *   npx tsx scripts/labelize-user-closes-counterfactual.ts
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const HIGH = 'a0000001-0000-0000-0000-000000000001';

const EODHD_API_KEY = process.env.EODHD_API_KEY;

interface IntradayBar {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

function pad(s: unknown, n: number) { return String(s ?? '').padEnd(n).slice(0, n); }
function fmt(n: number | null | undefined, d = 2): string {
  if (n == null || !Number.isFinite(n)) return 'n/a';
  return Number(n).toFixed(d);
}

async function fetchIntradayBars(symbol: string, fromTs: number, toTs: number): Promise<IntradayBar[]> {
  // EODHD intraday endpoint : /api/intraday/{symbol}?interval=5m&from={unix}&to={unix}
  const url = `https://eodhd.com/api/intraday/${encodeURIComponent(symbol)}?interval=5m&from=${fromTs}&to=${toTs}&api_token=${EODHD_API_KEY}&fmt=json`;
  try {
    const res = await fetch(url);
    if (!res.ok) return [];
    const json = (await res.json()) as Array<{ timestamp: number; open: number; high: number; low: number; close: number }>;
    if (!Array.isArray(json)) return [];
    return json.filter(b =>
      Number.isFinite(b.timestamp) && Number.isFinite(b.high) && Number.isFinite(b.low) && Number.isFinite(b.close)
    );
  } catch {
    return [];
  }
}

async function main() {
  const { data: closes } = await sb
    .from('lisa_positions')
    .select('id, symbol, entry_timestamp, exit_timestamp, entry_price, exit_price, realized_pnl_pct')
    .eq('portfolio_id', HIGH)
    .eq('status', 'closed_user')
    .filter('venue_fee_detail->>source', 'eq', 'scanner_oversold')
    .gte('exit_timestamp', '2026-06-04T00:00:00Z')
    .lt('exit_timestamp', '2026-06-05T00:00:00Z')
    .order('exit_timestamp', { ascending: true });

  if (!closes?.length) { console.log('Aucun close trouvé'); return; }

  console.log('═══════════════════════════════════════════════════════════════════════════════');
  console.log(' COUNTERFACTUAL LABELER — As-tu fermé TROP TÔT le 04/06 ?');
  console.log('   GOOD ≤ 0.3% extra   |   OK 0.3-1.0%   |   EARLY > 1.0%');
  console.log('═══════════════════════════════════════════════════════════════════════════════\n');
  console.log(pad('SYM', 10), pad('EXIT', 6), pad('EXIT$', 8), pad('MAX_60m', 8), pad('PEAK_T+', 8), pad('Δ_60m', 8), pad('Δ_EOD', 8), pad('LABEL', 10));

  const labels = new Map<string, number>();
  let sumExtra60 = 0;
  let sumExtraEod = 0;
  let analyzed = 0;
  const details: Array<{ sym: string; label: string; extra60: number; extraEod: number }> = [];

  for (const c of closes as unknown as Array<{
    id: string; symbol: string;
    entry_timestamp: string; exit_timestamp: string;
    entry_price: string; exit_price: string;
    realized_pnl_pct: number | null;
  }>) {
    const exitTs = Math.floor(new Date(c.exit_timestamp).getTime() / 1000);
    const exitPrice = parseFloat(c.exit_price);
    const entryPrice = parseFloat(c.entry_price);
    const fromTs = exitTs;
    const toTs = exitTs + 8 * 3600; // 8h après close (assez pour couvrir jusqu'au close US 21:00 UTC)

    const bars = await fetchIntradayBars(c.symbol, fromTs, toTs);
    if (bars.length === 0) {
      console.log(pad(c.symbol, 10), pad(String(c.exit_timestamp).slice(11, 16), 6), pad(fmt(exitPrice), 8), pad('—', 8), pad('—', 8), pad('—', 8), pad('—', 8), pad('NO_DATA', 10));
      continue;
    }

    // Bars dans les 60 min après close
    const bars60 = bars.filter(b => b.timestamp > exitTs && b.timestamp <= exitTs + 3600);
    const maxIn60 = bars60.length > 0 ? Math.max(...bars60.map(b => b.high)) : exitPrice;
    const peakBar = bars60.find(b => b.high === maxIn60);
    const peakDelay = peakBar ? Math.round((peakBar.timestamp - exitTs) / 60) : 0;

    // Bars jusqu'à 21:00 UTC du jour de close (= EOD US 04/06 21:00 UTC)
    const exitDate = new Date(c.exit_timestamp);
    const eodTs = Math.floor(Date.UTC(exitDate.getUTCFullYear(), exitDate.getUTCMonth(), exitDate.getUTCDate(), 21, 0) / 1000);
    const barsEod = bars.filter(b => b.timestamp > exitTs && b.timestamp <= eodTs);
    const maxToEod = barsEod.length > 0 ? Math.max(...barsEod.map(b => b.high)) : exitPrice;

    // Extra PnL en % du notionnel d'entrée (cohérent avec realized_pnl_pct)
    const extra60Pct = ((maxIn60 - exitPrice) / entryPrice) * 100;
    const extraEodPct = ((maxToEod - exitPrice) / entryPrice) * 100;

    sumExtra60 += extra60Pct;
    sumExtraEod += extraEodPct;
    analyzed++;

    let label: 'GOOD' | 'OK' | 'EARLY';
    if (extra60Pct <= 0.3) label = 'GOOD';
    else if (extra60Pct <= 1.0) label = 'OK';
    else label = 'EARLY';

    const icon = label === 'GOOD' ? '🟢' : label === 'OK' ? '🟡' : '🔴';
    labels.set(label, (labels.get(label) ?? 0) + 1);
    details.push({ sym: c.symbol, label, extra60: extra60Pct, extraEod: extraEodPct });

    console.log(
      pad(c.symbol, 10),
      pad(String(c.exit_timestamp).slice(11, 16), 6),
      pad(fmt(exitPrice), 8),
      pad(fmt(maxIn60), 8),
      pad(`+${peakDelay}m`, 8),
      pad(`${fmt(extra60Pct)}%`, 8),
      pad(`${fmt(extraEodPct)}%`, 8),
      pad(`${icon} ${label}`, 10)
    );
  }

  console.log('\n═══════════════════════════════════════════════════════════════════════════════');
  console.log(' SYNTHÈSE');
  console.log('═══════════════════════════════════════════════════════════════════════════════');
  console.log(`  N closes analysés : ${analyzed}/${closes.length}`);
  for (const [l, n] of [...labels].sort((a, b) => b[1] - a[1])) {
    const pct = ((n / analyzed) * 100).toFixed(0);
    console.log(`  ${pad(l, 8)} : ${n} (${pct}%)`);
  }
  if (analyzed > 0) {
    console.log(`\n  Σ extra PnL 60min  : +${sumExtra60.toFixed(2)} pts cumulé (potentiel raté)`);
    console.log(`  Σ extra PnL EOD    : +${sumExtraEod.toFixed(2)} pts cumulé`);
    console.log(`  Avg extra 60min    : +${(sumExtra60 / analyzed).toFixed(2)} pts/trade`);
    console.log(`  Avg extra EOD      : +${(sumExtraEod / analyzed).toFixed(2)} pts/trade`);
    const earlyDetails = details.filter(d => d.label === 'EARLY').sort((a, b) => b.extra60 - a.extra60);
    if (earlyDetails.length > 0) {
      console.log(`\n  TOP 5 closes EARLY (tu as fermé trop tôt) :`);
      for (const d of earlyDetails.slice(0, 5)) {
        console.log(`    ${d.sym.padEnd(10)} : tu as raté +${d.extra60.toFixed(2)}pts dans les 60min après ton close`);
      }
    }
  }

  console.log('\n═══════════════════════════════════════════════════════════════════════════════\n');
}

main().catch(e => { console.error(e); process.exit(1); });
