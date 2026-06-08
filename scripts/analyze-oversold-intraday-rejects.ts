/**
 * Analyse des rejets du scan intraday oversold (mission "gate qui rate les pépites").
 * Reconstruit les candidats bande (-5/-12% Friday) de stoxx600, puis mesure leur
 * rebond depuis le creux d'entrée (close vendredi) → combien ont rebondi ≥1,5%
 * (= faux négatifs que le scan intraday a rejetés).
 *
 * Usage : npx tsx scripts/analyze-oversold-intraday-rejects.ts
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const EODHD = process.env.EODHD_API_KEY!;
const ENTRY_DAY = '2026-06-05'; // vendredi : le drop + le creux que le scan a utilisés

async function mapPool<T, R>(items: T[], fn: (x: T) => Promise<R>, conc = 15): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: conc }, async () => {
      while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx]); }
    }),
  );
  return out;
}

async function fridayDrop(sym: string): Promise<{ drop: number; close: number } | null> {
  const url = `https://eodhd.com/api/eod/${encodeURIComponent(sym)}?api_token=${EODHD}&fmt=json&from=2026-05-26&to=${ENTRY_DAY}&order=a&period=d`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const b = (await r.json()) as Array<{ date: string; close: number }>;
    if (!Array.isArray(b) || b.length < 2) return null;
    const last = b[b.length - 1], prev = b[b.length - 2];
    if (last.date !== ENTRY_DAY || !(prev.close > 0) || !(last.close > 0)) return null;
    return { drop: ((last.close - prev.close) / prev.close) * 100, close: last.close };
  } catch { return null; }
}

async function realtimeBulk(symbols: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  // EODHD real-time bulk : par paquets de 20 (1er en path, reste en ?s=)
  for (let k = 0; k < symbols.length; k += 20) {
    const chunk = symbols.slice(k, k + 20);
    const [first, ...rest] = chunk;
    const s = rest.length ? `&s=${rest.join(',')}` : '';
    const url = `https://eodhd.com/api/real-time/${encodeURIComponent(first)}?api_token=${EODHD}&fmt=json${s}`;
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) continue;
      let j = await r.json();
      if (!Array.isArray(j)) j = [j];
      for (const q of j as Array<{ code?: string; close?: number }>) {
        if (q.code && Number.isFinite(Number(q.close))) out.set(q.code, Number(q.close));
      }
    } catch { /* skip */ }
  }
  return out;
}

async function main() {
  const { data } = await sb.from('watchlist_universe').select('tickers').eq('name', 'stoxx600').maybeSingle();
  const tickers: string[] = (data?.tickers as string[]) ?? [];
  console.log(`\n🔍 REJETS INTRADAY OVERSOLD — stoxx600 (${tickers.length} tickers) · drop & creux = ${ENTRY_DAY}\n`);

  console.log('Étape 1 — drops + creux Friday (518 fetches)…');
  const dr = await mapPool(tickers, fridayDrop, 18);
  const cands = tickers
    .map((s, i) => ({ sym: s, ...(dr[i] ?? { drop: NaN, close: NaN }) }))
    .filter((c) => Number.isFinite(c.drop) && c.drop <= -5 && c.drop >= -12)
    .sort((a, b) => a.drop - b.drop);
  console.log(`→ ${cands.length} candidats dans la bande [-12%, -5%]\n`);

  console.log('Étape 2 — prix live (rebond depuis le creux)…');
  const live = await realtimeBulk(cands.map((c) => c.sym));

  console.log('─'.repeat(80));
  console.log('Symbole'.padEnd(14) + 'DropVen'.padEnd(9) + 'CreuxVen'.padEnd(11) + 'Live'.padEnd(11) + 'Rebond'.padEnd(10) + 'Verdict');
  console.log('─'.repeat(80));
  let fn = 0, measured = 0;
  for (const c of cands) {
    const cur = live.get(c.sym);
    if (cur == null) { console.log(c.sym.padEnd(14) + `${c.drop.toFixed(1)}%`.padEnd(9) + 'live indispo'); continue; }
    measured++;
    const reb = ((cur - c.close) / c.close) * 100;
    const isFN = reb >= 1.5;
    if (isFN) fn++;
    console.log(
      c.sym.padEnd(14) + `${c.drop.toFixed(1)}%`.padEnd(9) + String(c.close).padEnd(11) +
      String(cur).padEnd(11) + `${reb >= 0 ? '+' : ''}${reb.toFixed(2)}%`.padEnd(10) +
      (isFN ? '🔴 REBOND ≥1,5% (raté ?)' : reb >= 0.5 ? '🟡 léger rebond' : '🟢 rejet justifié'),
    );
  }
  console.log('─'.repeat(80));
  const pct = measured ? (fn / measured) * 100 : 0;
  console.log(`\nVERDICT : ${fn}/${measured} candidats rebondis ≥1,5% depuis le creux (${pct.toFixed(0)}% de "ratés").`);
  console.log(pct > 30
    ? '⚠️ > 30% → le filtre intraday rate peut-être de vrais rebonds (à creuser sur fenêtre + longue).'
    : '✅ < 30% → le filtre rejette majoritairement à raison.');
  console.log('\nNB : "rebond depuis le creux" ≠ exactement le critère scanner (rebond intraday from low),');
  console.log('    mais bon proxy. Les 7 déjà détenus sont dans la liste (le daily les a pris vendredi).\n');
}

main().catch((e) => { console.error('failed:', e); process.exit(1); });
