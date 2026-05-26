/**
 * Verify EU + Asia hour blacklists against recent live data (7d and 30d).
 *
 * Source : lisa_positions (paper trading), closed long positions for
 * asset_class in {eu_equity, asia_equity}, grouped by HOUR(entry_timestamp UTC).
 *
 * Outputs : per-hour n, win_rate, avg_pnl_pct, sum_pnl_usd, stop_rate.
 *
 * Compared to current Fly secrets :
 *   - GAINERS_HOUR_BLACKLIST_ASIA_UTC = "0,1"  (per CLAUDE.md)
 *   - GAINERS_HOUR_BLACKLIST_EU_UTC = (env-only, "calibré"). Override via
 *     PROD_EU_BLACKLIST=... when running this script.
 *
 * Reblock criteria : WR < 40 AND stop_rate > 55 AND sum_usd < -200 → keep blocked.
 * Candidate add : not blocked but WR < 40 AND sum_usd < -100 (n>=5).
 */
import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';

const env = fs.readFileSync('.env', 'utf8').split('\n').reduce((acc, l) => {
  const m = l.match(/^([A-Z_]+)=(.+)$/);
  if (m) acc[m[1]] = m[2];
  return acc;
}, {} as Record<string, string>);

const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!);

function parseHours(csv: string): Set<number> {
  return new Set(
    csv
      .split(',')
      .map((s) => Number.parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n) && n >= 0 && n <= 23),
  );
}

const CURRENT_BLACKLIST = {
  eu_equity: parseHours(process.env.PROD_EU_BLACKLIST ?? env.GAINERS_HOUR_BLACKLIST_EU_UTC ?? ''),
  asia_equity: parseHours(process.env.PROD_ASIA_BLACKLIST ?? env.GAINERS_HOUR_BLACKLIST_ASIA_UTC ?? '0,1'),
};

type Row = {
  id: string;
  asset_class: string | null;
  direction: string | null;
  entry_timestamp: string;
  realized_pnl_pct: number | null;
  realized_pnl_usd: number | null;
  status: string;
  exit_reason: string | null;
};

async function fetchClosed(sinceIso: string): Promise<Row[]> {
  const all: Row[] = [];
  let from = 0;
  const pageSize = 1000;
  for (;;) {
    const { data, error } = await sb
      .from('lisa_positions')
      .select('id, asset_class, direction, entry_timestamp, realized_pnl_pct, realized_pnl_usd, status, exit_reason')
      .in('asset_class', ['eu_equity', 'asia_equity'])
      .neq('status', 'open')
      .gte('entry_timestamp', sinceIso)
      .order('entry_timestamp', { ascending: false })
      .range(from, from + pageSize - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    all.push(...(data as Row[]));
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

type Bucket = { n: number; wins: number; stops: number; sumUsd: number; sumPct: number };
const emptyBucket = (): Bucket => ({ n: 0, wins: 0, stops: 0, sumUsd: 0, sumPct: 0 });

function classify(rows: Row[], cls: string, hours: number[]): Map<number, Bucket> {
  const m = new Map<number, Bucket>();
  for (const h of hours) m.set(h, emptyBucket());
  for (const r of rows) {
    if (r.asset_class !== cls) continue;
    if ((r.direction ?? 'long') !== 'long') continue;
    if (!r.entry_timestamp) continue;
    const hr = Number.parseInt(r.entry_timestamp.slice(11, 13), 10);
    if (!Number.isFinite(hr)) continue;
    const b = m.get(hr);
    if (!b) continue;
    const usd = Number(r.realized_pnl_usd ?? 0);
    const pct = Number(r.realized_pnl_pct ?? 0);
    b.n += 1;
    b.sumUsd += usd;
    b.sumPct += pct;
    if (usd > 0) b.wins += 1;
    const reason = r.exit_reason ?? r.status;
    if (reason === 'closed_stop') b.stops += 1;
  }
  return m;
}

function fmtRow(h: number, b: Bucket, blocked: boolean): string {
  const head = `${String(h).padStart(2)}h`;
  const tag = blocked ? ' BLOCK' : '';
  if (b.n === 0) {
    return `${head} | n=  0 |    — |       — |        — |    — |${tag}`;
  }
  const wr = (b.wins * 100) / b.n;
  const sr = (b.stops * 100) / b.n;
  const avg = b.sumPct / b.n;
  const flag = b.sumUsd <= -200 && wr < 40 && sr > 55
    ? ' TOXIC'
    : b.sumUsd <= -100 && wr < 40
    ? ' losing'
    : b.sumUsd >= 50 && wr >= 50
    ? ' good'
    : '';
  return (
    `${head} | n=${String(b.n).padStart(3)} | WR=${wr.toFixed(0).padStart(3)}% | avg=${(avg >= 0 ? '+' : '')}${avg.toFixed(2)}% | sum=${b.sumUsd >= 0 ? '+' : ''}$${b.sumUsd.toFixed(0)} | SR=${sr.toFixed(0).padStart(3)}% |${tag}${flag}`
  );
}

function evalBucket(b: Bucket): 'TOXIC' | 'LOSING' | 'NEUTRAL' | 'GOOD' {
  if (b.n < 3) return 'NEUTRAL';
  const wr = (b.wins * 100) / b.n;
  const sr = (b.stops * 100) / b.n;
  if (b.sumUsd <= -200 && wr < 40 && sr > 55) return 'TOXIC';
  if (b.sumUsd <= -100 && wr < 40) return 'LOSING';
  if (b.sumUsd >= 50 && wr >= 50) return 'GOOD';
  return 'NEUTRAL';
}

function reportClass(rows: Row[], cls: 'eu_equity' | 'asia_equity', hours: number[], windowLabel: string) {
  const buckets = classify(rows, cls, hours);
  const blacklist = CURRENT_BLACKLIST[cls];
  console.log(`\n=== ${cls.toUpperCase()} — ${windowLabel} — long only — UTC ${hours[0]}h..${hours[hours.length-1]}h ===`);
  console.log(`Current blacklist UTC: {${[...blacklist].sort((a, b) => a - b).join(',') || 'empty'}}`);
  console.log('Hour | n     | WR    | avg pnl%   | sum pnl$   | SR    | flags');
  const removeCandidates: number[] = [];
  const addCandidates: number[] = [];
  let totalN = 0;
  let totalUsd = 0;
  for (const h of hours) {
    const b = buckets.get(h)!;
    const blocked = blacklist.has(h);
    console.log(fmtRow(h, b, blocked));
    totalN += b.n;
    totalUsd += b.sumUsd;
    const verdict = evalBucket(b);
    if (blocked && b.n >= 5 && verdict !== 'TOXIC' && verdict !== 'LOSING') removeCandidates.push(h);
    if (!blocked && (verdict === 'TOXIC' || verdict === 'LOSING')) addCandidates.push(h);
  }
  console.log(`TOTAL ${cls} ${windowLabel} → n=${totalN}, sum_pnl=$${totalUsd.toFixed(0)}`);
  if (removeCandidates.length > 0) console.log(`→ REMOVE candidates (blocked but data does NOT justify): ${removeCandidates.join(',')}`);
  if (addCandidates.length > 0) console.log(`→ ADD candidates (not blocked, toxic in data): ${addCandidates.join(',')}`);
  if (removeCandidates.length === 0 && addCandidates.length === 0) console.log('→ blacklist coherent with data on this window');
  return { totalN, totalUsd, removeCandidates, addCandidates };
}

async function main() {
  const now = Date.now();
  const d7 = new Date(now - 7 * 86400_000).toISOString();
  const d30 = new Date(now - 30 * 86400_000).toISOString();

  console.log(`\n>>> Fetching lisa_positions closed since 30d for eu_equity + asia_equity, long only <<<`);
  console.log(`30d cutoff: ${d30}  |  7d cutoff: ${d7}`);
  const rows30 = await fetchClosed(d30);
  const rows7 = rows30.filter((r) => r.entry_timestamp >= d7);
  console.log(`Loaded: 30d=${rows30.length} rows, 7d=${rows7.length} rows`);

  const euHours = Array.from({ length: 10 }, (_, i) => i + 7);   // 07..16 UTC
  const asiaHours = Array.from({ length: 9 }, (_, i) => i);      // 00..08 UTC

  const eu7 = reportClass(rows7, 'eu_equity', euHours, '7d');
  const eu30 = reportClass(rows30, 'eu_equity', euHours, '30d');
  const as7 = reportClass(rows7, 'asia_equity', asiaHours, '7d');
  const as30 = reportClass(rows30, 'asia_equity', asiaHours, '30d');

  console.log('\n========== SYNTHESE ==========');
  const minSampleEU = 30;
  const minSampleAS = 20;

  if (eu30.totalN < minSampleEU) {
    console.log(`EU — sample 30d (n=${eu30.totalN}) trop faible (<${minSampleEU}) pour conclure.`);
  } else {
    console.log(`EU — sample 30d n=${eu30.totalN}, sumPnL=$${eu30.totalUsd.toFixed(0)}`);
    console.log(`     blacklist actuel UTC {${[...CURRENT_BLACKLIST.eu_equity].sort().join(',') || 'empty'}}`);
    console.log(`     remove (30d): ${eu30.removeCandidates.join(',') || '—'} | add (30d): ${eu30.addCandidates.join(',') || '—'}`);
    console.log(`     remove (7d) : ${eu7.removeCandidates.join(',') || '—'} | add (7d) : ${eu7.addCandidates.join(',') || '—'}`);
  }
  if (as30.totalN < minSampleAS) {
    console.log(`ASIA — sample 30d (n=${as30.totalN}) trop faible (<${minSampleAS}) pour conclure.`);
  } else {
    console.log(`ASIA — sample 30d n=${as30.totalN}, sumPnL=$${as30.totalUsd.toFixed(0)}`);
    console.log(`     blacklist actuel UTC {${[...CURRENT_BLACKLIST.asia_equity].sort().join(',') || 'empty'}}`);
    console.log(`     remove (30d): ${as30.removeCandidates.join(',') || '—'} | add (30d): ${as30.addCandidates.join(',') || '—'}`);
    console.log(`     remove (7d) : ${as7.removeCandidates.join(',') || '—'} | add (7d) : ${as7.addCandidates.join(',') || '—'}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
