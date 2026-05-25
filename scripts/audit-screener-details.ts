import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
const env = fs.readFileSync('.env', 'utf8').split('\n').reduce((acc, l) => {
  const m = l.match(/^([A-Z_]+)=(.+)$/); if (m) acc[m[1]] = m[2]; return acc;
}, {} as Record<string, string>);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!);
const since6h = new Date(Date.now() - 6 * 3600_000).toISOString();

async function main() {
  // 1. Screener calls 6h sans limite
  const { data, count } = await sb.from('eodhd_request_log')
    .select('ticker, success, http_status, timestamp', { count: 'exact' })
    .gte('timestamp', since6h).like('ticker', 'gainers_screener_%')
    .order('timestamp', { ascending: false }).limit(500);
  console.log(`\n=== Screener calls 6h : ${count} total ===`);
  const byEx: Record<string, { ok: number; fail: number; last: string }> = {};
  for (const c of (data ?? []) as any[]) {
    const ex = c.ticker.replace('gainers_screener_', '');
    if (!byEx[ex]) byEx[ex] = { ok: 0, fail: 0, last: '' };
    if (c.success) byEx[ex].ok++; else byEx[ex].fail++;
    if (!byEx[ex].last) byEx[ex].last = c.timestamp.slice(11, 19);
  }
  for (const [ex, s] of Object.entries(byEx).sort((a, b) => (b[1].ok + b[1].fail) - (a[1].ok + a[1].fail))) {
    console.log(`  ${ex.padEnd(6)} ok=${s.ok} fail=${s.fail} last=${s.last}`);
  }

  // 2. Shadow signals 6h par exchange
  const { data: sh } = await sb.from('gainers_v1_shadow_signals')
    .select('exchange, decision').gte('created_at', since6h).limit(5000);
  console.log(`\n=== Shadow signals 6h par exchange/decision ===`);
  const bySh: Record<string, Record<string, number>> = {};
  for (const s of (sh ?? []) as any[]) {
    const ex = s.exchange ?? '?';
    if (!bySh[ex]) bySh[ex] = {};
    bySh[ex][s.decision] = (bySh[ex][s.decision] ?? 0) + 1;
  }
  for (const [ex, dec] of Object.entries(bySh).sort((a, b) => {
    const ta = Object.values(a[1]).reduce((x, y) => x + y, 0);
    const tb = Object.values(b[1]).reduce((x, y) => x + y, 0);
    return tb - ta;
  })) {
    console.log(`  ${ex.padEnd(6)} ${JSON.stringify(dec)}`);
  }

  // 3. Derniers appels screener KO (voir si retournent 0 résultats)
  console.log('\n=== Derniers appels screener KO (http_status + success) ===');
  const { data: koC } = await sb.from('eodhd_request_log')
    .select('ticker, success, http_status, timestamp, response_size_bytes')
    .gte('timestamp', since6h).eq('ticker', 'gainers_screener_KO')
    .order('timestamp', { ascending: false }).limit(10);
  for (const c of (koC ?? []) as any[]) {
    console.log(`  ${c.timestamp.slice(11, 19)} ok=${c.success} http=${c.http_status} size=${c.response_size_bytes ?? '?'}b`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
