/**
 * Verify hour-edge — CRYPTO (24/7) + GLOBAL LONG (all classes).
 *
 * Objectif :
 *   - CRYPTO : pas de session-filter, donc chaque heure compte. Trouve les
 *     heures UTC où crypto_major + crypto_alt long sont structurellement -EV.
 *   - GLOBAL LONG : équivalent du gate `GAINERS_LONG_HOUR_BLACKLIST_UTC`.
 *     Stats par heure toutes classes confondues, direction='long'.
 *
 * Sortie : tableau par heure UTC avec n / WR / mean_pnl% / sum_$ / stop_rate,
 * + recommandations (heures à ajouter/retirer des blacklists actuelles).
 *
 * Fenêtres : 7j et 30j, indépendantes.
 */
import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';

const envFile = fs.readFileSync('.env', 'utf8').split('\n').reduce((acc, l) => {
  const m = l.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m) acc[m[1]] = m[2].replace(/^["']|["']$/g, '');
  return acc;
}, {} as Record<string, string>);

const SB_URL = envFile.NEXT_PUBLIC_SUPABASE_URL || envFile.SUPABASE_URL;
const SB_KEY = envFile.SUPABASE_SERVICE_ROLE_KEY;
if (!SB_URL || !SB_KEY) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env');
  process.exit(1);
}
const sb = createClient(SB_URL, SB_KEY);

type Row = {
  id: string;
  symbol: string;
  asset_class: string;
  direction: string;
  status: string;
  entry_timestamp: string;
  realized_pnl_usd: number | null;
  realized_pnl_pct: number | null;
};

const CRYPTO_CLASSES = new Set(['crypto_major', 'crypto_alt']);

async function fetchClosed(sinceDays: number): Promise<Row[]> {
  const since = new Date(Date.now() - sinceDays * 86400_000).toISOString();
  // Paginate to bypass 1000-row default cap
  const all: Row[] = [];
  let offset = 0;
  const page = 1000;
  for (;;) {
    const { data, error } = await sb
      .from('lisa_positions')
      .select('id, symbol, asset_class, direction, status, entry_timestamp, realized_pnl_usd, realized_pnl_pct')
      .neq('status', 'open')
      .gte('entry_timestamp', since)
      .order('entry_timestamp', { ascending: false })
      .range(offset, offset + page - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    all.push(...(data as Row[]));
    if (data.length < page) break;
    offset += page;
  }
  return all;
}

type Bucket = {
  n: number;
  wins: number;
  sumUsd: number;
  sumPct: number;
  stops: number;
};

function emptyBuckets(): Bucket[] {
  return Array.from({ length: 24 }, () => ({ n: 0, wins: 0, sumUsd: 0, sumPct: 0, stops: 0 }));
}

function accumulate(rows: Row[]): Bucket[] {
  const buckets = emptyBuckets();
  for (const r of rows) {
    if (r.direction !== 'long') continue;
    if (r.realized_pnl_usd == null || !r.entry_timestamp) continue;
    const h = Number.parseInt(r.entry_timestamp.slice(11, 13), 10);
    if (!Number.isFinite(h) || h < 0 || h > 23) continue;
    const b = buckets[h];
    b.n += 1;
    if (Number(r.realized_pnl_usd) > 0) b.wins += 1;
    b.sumUsd += Number(r.realized_pnl_usd);
    b.sumPct += Number(r.realized_pnl_pct ?? 0);
    if (r.status === 'closed_stop') b.stops += 1;
  }
  return buckets;
}

function printTable(label: string, buckets: Bucket[], totalN: number): void {
  console.log(`\n=== ${label} — n=${totalN} long trades ===`);
  console.log('UTC | n   | WR%  | mean_pnl% | sum_$       | stop_rate%');
  console.log('----+-----+------+-----------+-------------+----------');
  for (let h = 0; h < 24; h++) {
    const b = buckets[h];
    if (b.n === 0) {
      console.log(`${String(h).padStart(2, '0')}h | ${String(b.n).padStart(3)} |   -  |     -     |       -     |    -`);
      continue;
    }
    const wr = (b.wins * 100) / b.n;
    const meanPct = b.sumPct / b.n;
    const stopRate = (b.stops * 100) / b.n;
    const flag = b.n >= 10 && (b.sumUsd <= -100 || wr < 35)
      ? ' KO'
      : b.n >= 10 && wr >= 50 && b.sumUsd > 0
      ? ' OK'
      : '';
    console.log(
      `${String(h).padStart(2, '0')}h | ${String(b.n).padStart(3)} | ${wr.toFixed(0).padStart(3)}% | ${(meanPct >= 0 ? '+' : '')}${meanPct.toFixed(2)}%   | ${(b.sumUsd >= 0 ? '+' : '')}$${b.sumUsd.toFixed(2).padStart(8)} |  ${stopRate.toFixed(0).padStart(2)}%${flag}`,
    );
  }
}

function recommend(label: string, buckets: Bucket[], minN = 10): { ko: number[]; ok: number[]; weakNeg: number[] } {
  const ko: number[] = [];
  const ok: number[] = [];
  const weakNeg: number[] = [];
  for (let h = 0; h < 24; h++) {
    const b = buckets[h];
    if (b.n < minN) continue;
    const wr = (b.wins * 100) / b.n;
    if (b.sumUsd <= -100 || wr < 35) ko.push(h);
    else if (wr >= 50 && b.sumUsd > 0) ok.push(h);
    else if (b.sumUsd < 0 && wr < 45) weakNeg.push(h);
  }
  console.log(`\n[${label}] heures -EV (sumUsd<=-$100 OR WR<35%, n>=${minN}) : ${ko.length ? ko.join(',') : 'aucune'}`);
  console.log(`[${label}] heures +EV (WR>=50% AND sumUsd>0, n>=${minN}) : ${ok.length ? ok.join(',') : 'aucune'}`);
  console.log(`[${label}] heures faibles (sumUsd<0 AND WR<45%, n>=${minN}, mais pas KO) : ${weakNeg.length ? weakNeg.join(',') : 'aucune'}`);
  return { ko, ok, weakNeg };
}

async function main() {
  const now = new Date();
  console.log(`Now (UTC) : ${now.toISOString()}`);
  console.log(`Fetching closed long positions from lisa_positions ...`);

  for (const days of [7, 30]) {
    const rows = await fetchClosed(days);
    const longRows = rows.filter((r) => r.direction === 'long' && r.realized_pnl_usd != null);
    console.log(`\n##################################################`);
    console.log(`# Window : ${days}d | rows fetched: ${rows.length} | long closed with pnl: ${longRows.length}`);
    console.log(`##################################################`);

    // CRYPTO only
    const cryptoRows = longRows.filter((r) => CRYPTO_CLASSES.has(r.asset_class));
    const cryptoBuckets = accumulate(cryptoRows);
    printTable(`CRYPTO (major + alt) ${days}d`, cryptoBuckets, cryptoRows.length);
    recommend(`CRYPTO ${days}d`, cryptoBuckets, days === 7 ? 5 : 10);

    // GLOBAL LONG (all classes)
    const globalBuckets = accumulate(longRows);
    printTable(`GLOBAL LONG (all classes) ${days}d`, globalBuckets, longRows.length);
    recommend(`GLOBAL ${days}d`, globalBuckets, 10);

    // Per-class context (informational)
    const byClass = new Map<string, Row[]>();
    for (const r of longRows) {
      const arr = byClass.get(r.asset_class) ?? [];
      arr.push(r);
      byClass.set(r.asset_class, arr);
    }
    console.log(`\n[${days}d] Per-class counts:`);
    for (const [cls, arr] of [...byClass.entries()].sort((a, b) => b[1].length - a[1].length)) {
      const sumUsd = arr.reduce((s, r) => s + Number(r.realized_pnl_usd ?? 0), 0);
      const wins = arr.filter((r) => Number(r.realized_pnl_usd) > 0).length;
      const wr = arr.length > 0 ? (wins * 100) / arr.length : 0;
      console.log(`  ${cls.padEnd(22)} n=${String(arr.length).padStart(4)}  WR=${wr.toFixed(0).padStart(3)}%  sum=${sumUsd >= 0 ? '+' : ''}$${sumUsd.toFixed(2)}`);
    }
  }

  console.log(`\n--- Reference blacklists (CLAUDE.md / known) ---`);
  console.log(`GAINERS_LONG_HOUR_BLACKLIST_UTC (global)  : 8,19,22,23,0,1,2,3,4 (from data-mining 23/05, n=7000 signaux)`);
  console.log(`GAINERS_HOUR_BLACKLIST_US_UTC             : 17,18 (post-lunch chop)`);
  console.log(`GAINERS_HOUR_BLACKLIST_ASIA_UTC           : 0,1 (opening auction)`);
  console.log(`GAINERS_HOUR_BLACKLIST_CRYPTO_UTC         : (NOT SET — crypto exempt par défaut)`);
  console.log(`Crypto bypass : isCryptoCandHourGate → skip global gate sauf si GAINERS_LONG_HOUR_GATE_CRYPTO=true`);
}

main().catch((e) => { console.error(e); process.exit(1); });
