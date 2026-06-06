/**
 * DIAGNOSTIC (non committé) — Audit entry_price vs close EODHD du jour d'entrée
 * sur TOUTES les positions oversold US (a0000001).
 *
 * But : prouver qu'aucune position n'ouvre à un prix ABERRANT (hors range réel
 * du marché ce jour-là, comme le craignait l'utilisateur).
 *
 * Méthode : pour chaque position, on compare entry_price à la fenêtre [low, high]
 * des bars EOD EODHD autour du jour d'entrée (J-4..J+1, tolérance ±10%). Un prix
 * dans cette fenêtre = sain (entrée au close EOD OU au prix intraday du jour).
 * Un prix hors fenêtre (ex 10x) = aberrant → flag.
 *
 * Run : set -a; . .env; set +a; npx tsx scripts/diag-us-oversold-entry-audit.ts
 */

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SRK = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const EODHD = process.env.EODHD_API_KEY!;
const PF = 'a0000001-0000-0000-0000-000000000001';

interface Pos {
  symbol: string;
  entry_price: number;
  entry_timestamp: string;
  status: string;
  venue_fee_detail: { source?: string } | null;
}
interface Bar { date: string; open: number; high: number; low: number; close: number }

async function sb(path: string): Promise<any> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SRK, Authorization: `Bearer ${SRK}` },
  });
  if (!res.ok) throw new Error(`SB ${res.status} ${await res.text()}`);
  return res.json();
}

function shiftDate(d: string, days: number): string {
  const dt = new Date(d + 'T00:00:00Z');
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

async function main() {
  const rows: Pos[] = await sb(
    `lisa_positions?portfolio_id=eq.${PF}&select=symbol,entry_price,entry_timestamp,status,venue_fee_detail&order=entry_timestamp.asc`,
  );
  console.log(`Positions US oversold (a0000001) : ${rows.length}`);

  const bySym = new Map<string, Pos[]>();
  for (const r of rows) {
    if (!bySym.has(r.symbol)) bySym.set(r.symbol, []);
    bySym.get(r.symbol)!.push(r);
  }
  console.log(`Symboles distincts : ${bySym.size}`);

  // Fetch EOD bars par symbole couvrant la plage des entrées (+ buffer).
  const barsBySym = new Map<string, Map<string, Bar>>();
  let eodErrors = 0;
  for (const [sym, ps] of bySym) {
    const dates = ps.map((p) => p.entry_timestamp.slice(0, 10)).sort();
    const from = shiftDate(dates[0], -7);
    const to = shiftDate(dates[dates.length - 1], 2);
    const url = `https://eodhd.com/api/eod/${encodeURIComponent(sym)}?api_token=${EODHD}&fmt=json&from=${from}&to=${to}&order=d`;
    try {
      const res = await fetch(url);
      const m = new Map<string, Bar>();
      if (res.ok) {
        const bars = await res.json();
        if (Array.isArray(bars)) for (const b of bars) m.set(b.date, b);
      } else {
        eodErrors++;
      }
      barsBySym.set(sym, m);
    } catch {
      eodErrors++;
      barsBySym.set(sym, new Map());
    }
  }

  let matched = 0;
  let noBar = 0;
  const flagged: Array<Record<string, unknown>> = [];
  const worst: Array<{ symbol: string; pct: number; entry: number; close: number; day: string }> = [];

  for (const r of rows) {
    const day = r.entry_timestamp.slice(0, 10);
    const m = barsBySym.get(r.symbol)!;
    let minLow = Infinity;
    let maxHigh = -Infinity;
    let refClose: number | null = null;
    let used = 0;
    for (let off = -4; off <= 1; off++) {
      const b = m.get(shiftDate(day, off));
      if (b) {
        minLow = Math.min(minLow, b.low);
        maxHigh = Math.max(maxHigh, b.high);
        if (off === 0 || refClose === null) refClose = b.close;
        used++;
      }
    }
    if (used === 0) {
      noBar++;
      continue;
    }
    const e = r.entry_price;
    const inRange = e >= minLow * 0.9 && e <= maxHigh * 1.1;
    const pctVsClose = refClose && refClose > 0 ? (e / refClose - 1) * 100 : NaN;
    if (Number.isFinite(pctVsClose)) {
      worst.push({ symbol: r.symbol, pct: pctVsClose, entry: e, close: refClose!, day });
    }
    if (!inRange) {
      flagged.push({
        symbol: r.symbol,
        status: r.status,
        source: r.venue_fee_detail?.source ?? '?',
        entry: e,
        day,
        winLow: Number(minLow.toFixed(2)),
        winHigh: Number(maxHigh.toFixed(2)),
        close: refClose,
        pctVsClose: Number(pctVsClose.toFixed(1)),
      });
    } else {
      matched++;
    }
  }

  console.log(`\nErreurs fetch EODHD : ${eodErrors} symbole(s)`);
  console.log(`✅ entry_price DANS le range réel du jour : ${matched}/${rows.length}`);
  console.log(`⚪ sans bar EOD (skip, ex weekend/délisté) : ${noBar}`);
  console.log(`🔴 ABERRANTS (hors range ±10%) : ${flagged.length}`);
  for (const f of flagged) console.log('   ', JSON.stringify(f));

  worst.sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct));
  console.log(`\nTop 8 écarts |entry vs close du jour| (sanity, pas forcément un bug) :`);
  for (const w of worst.slice(0, 8)) {
    console.log(`   ${w.symbol.padEnd(10)} ${w.day}  entry=${w.entry}  close=${w.close}  ${w.pct >= 0 ? '+' : ''}${w.pct.toFixed(2)}%`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
