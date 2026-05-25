/**
 * Audit phase 3 : quota EODHD + screener calls + eodhd_request_log details
 */
import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';

const env = fs.readFileSync('.env', 'utf8').split('\n').reduce((acc, l) => {
  const m = l.match(/^([A-Z_]+)=(.+)$/); if (m) acc[m[1]] = m[2]; return acc;
}, {} as Record<string, string>);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!);

const since1h = new Date(Date.now() - 60 * 60_000).toISOString();
const since6h = new Date(Date.now() - 6 * 60 * 60_000).toISOString();
const today = new Date().toISOString().slice(0, 10);

async function main() {
  const nowUtc = new Date();
  console.log(`\n=== AUDIT PHASE 3 — ${nowUtc.toISOString().slice(0, 19)} UTC ===\n`);

  // 1. Consommation EODHD aujourd'hui (quota journalier)
  console.log('─── 1. QUOTA EODHD AUJOURD\'HUI ───');
  const { data: costs } = await sb
    .from('api_costs_daily')
    .select('provider, model, calls_count, total_cost_usd, day_utc')
    .eq('provider', 'eodhd')
    .eq('day_utc', today);
  if (costs && costs.length > 0) {
    let totalCalls = 0;
    for (const c of costs as any[]) {
      totalCalls += c.calls_count ?? 0;
      console.log(`  ${c.day_utc} ${c.model ?? 'all'} calls=${c.calls_count} cost=$${Number(c.total_cost_usd ?? 0).toFixed(4)}`);
    }
    console.log(`  TOTAL calls aujourd'hui : ${totalCalls} / 100000 (${(totalCalls / 1000).toFixed(1)}%)`);
    if (totalCalls >= 85000) console.log('  ⚠️  QUOTA ≥ 85% → scannerPausedQuota=true → scanner en pause automatique !');
  } else {
    console.log('  (api_costs_daily vide pour EODHD aujourd\'hui)');
  }

  // 2. Appels EODHD 6h par called_by (chercher screener)
  console.log('\n─── 2. EODHD CALLS 6h PAR CALLER (cherche screener) ───');
  const { data: eodhd6h, count: eodhd6hCount } = await sb
    .from('eodhd_request_log')
    .select('called_by, ticker, success, http_status, timestamp', { count: 'exact' })
    .gte('timestamp', since6h)
    .order('timestamp', { ascending: false })
    .limit(2000);
  console.log(`  Total EODHD 6h : ${eodhd6hCount ?? 0}`);
  if (eodhd6h && eodhd6h.length > 0) {
    const byCaller: Record<string, number> = {};
    const screenerCalls: any[] = [];
    for (const c of eodhd6h as any[]) {
      byCaller[c.called_by ?? '?'] = (byCaller[c.called_by ?? '?'] ?? 0) + 1;
      if ((c.ticker ?? '').includes('screener') || (c.called_by ?? '').includes('screener')) {
        screenerCalls.push(c);
      }
    }
    console.log('  Par caller :');
    for (const [k, v] of Object.entries(byCaller).sort((a, b) => (b[1] as number) - (a[1] as number))) {
      console.log(`    ${String(v).padStart(5)}  ${k}`);
    }
    console.log(`\n  Screener calls 6h : ${screenerCalls.length}`);
    for (const c of screenerCalls.slice(0, 10)) {
      console.log(`    ${c.timestamp.slice(11, 19)} ${c.ticker} ${c.called_by} ok=${c.success}`);
    }
    if (screenerCalls.length === 0) {
      console.log('  ⚠️  AUCUN call screener → fetchAllCandidates ne s\'exécute pas (quota pausé, SCANNER_PAUSE, ou cron mort)');
    }
  }

  // 3. Appels EODHD 6h — ticker contenant 'gainers' (ancien format)
  console.log('\n─── 3. EODHD CALLS "gainers_screener_*" 6h ───');
  const { data: gainersCalls } = await sb
    .from('eodhd_request_log')
    .select('called_by, ticker, success, timestamp')
    .gte('timestamp', since6h)
    .like('ticker', 'gainers_screener_%')
    .order('timestamp', { ascending: false })
    .limit(20);
  console.log(`  Appels gainers_screener_* : ${gainersCalls?.length ?? 0}`);
  if (gainersCalls && gainersCalls.length > 0) {
    const lastGainer = (gainersCalls as any[])[0];
    console.log(`  Dernier : ${lastGainer.timestamp.slice(11, 19)} ${lastGainer.ticker}`);
    const byEx: Record<string, number> = {};
    for (const c of gainersCalls as any[]) {
      const ex = c.ticker.replace('gainers_screener_', '');
      byEx[ex] = (byEx[ex] ?? 0) + 1;
    }
    console.log(`  Par exchange : ${JSON.stringify(byEx)}`);
  } else {
    console.log('  ⚠️  AUCUN call screener gainers 6h → scanner muet');
  }

  // 4. Last scanner cycle logs (from gainers_v1_shadow_signals creation timestamps)
  console.log('\n─── 4. FRÉQUENCE SHADOW SIGNALS (proxy cycle scanner) ───');
  const { data: recent } = await sb
    .from('gainers_v1_shadow_signals')
    .select('created_at')
    .gte('created_at', since1h)
    .order('created_at', { ascending: false })
    .limit(500);
  if (recent && recent.length > 0) {
    // Regrouper par minute pour voir la cadence
    const byMin: Record<string, number> = {};
    for (const s of recent as any[]) {
      const min = s.created_at.slice(0, 16);
      byMin[min] = (byMin[min] ?? 0) + 1;
    }
    const sorted = Object.entries(byMin).sort((a, b) => b[0].localeCompare(a[0]));
    console.log('  Dernières 15 minutes avec signaux :');
    for (const [min, cnt] of sorted.slice(0, 15)) {
      console.log(`    ${min}  → ${cnt} signaux`);
    }
  } else {
    console.log('  Aucun shadow signal depuis 1h');
  }

  // 5. eodhd_quota_status si table existe
  console.log('\n─── 5. EODHD_QUOTA_STATUS ───');
  const { data: quota, error: qErr } = await sb
    .from('eodhd_quota_status')
    .select('*')
    .order('recorded_at', { ascending: false })
    .limit(3);
  if (qErr) {
    console.log(`  Table inexistante : ${qErr.message}`);
  } else {
    for (const q of (quota ?? []) as any[]) {
      console.log(`  ${q.recorded_at?.slice(11, 19)} used=${q.used_calls} limit=${q.limit_calls} pct=${q.pct?.toFixed(1)}%`);
    }
  }

  console.log('\n=== FIN AUDIT PHASE 3 ===\n');
}
main().catch((e) => { console.error(e); process.exit(1); });
