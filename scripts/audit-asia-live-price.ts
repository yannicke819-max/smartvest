/**
 * Audit prix live Asia — diagnostique pourquoi aucune position ne s'ouvre.
 *
 * Hypothèse : getLivePrice() retourne fallback_unknown pour les tickers KO/KQ/SHG/SHE
 * → openTopGainerPosition() return null → 0 opens malgré shadow ACCEPT signals.
 *
 * Run: pnpm tsx scripts/audit-asia-live-price.ts
 */
import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';

const env = fs.readFileSync('.env', 'utf8').split('\n').reduce((acc, l) => {
  const m = l.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/); if (m) acc[m[1]] = m[2]; return acc;
}, {} as Record<string, string>);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!);

const since6h = new Date(Date.now() - 6 * 3600_000).toISOString();
const since24h = new Date(Date.now() - 24 * 3600_000).toISOString();
const since3d = new Date(Date.now() - 3 * 86_400_000).toISOString();

async function main() {
  const now = new Date();
  console.log(`\n=== AUDIT PRIX LIVE ASIA — ${now.toISOString().slice(0, 19)} UTC ===\n`);

  // 1. TwelveData calls pour tickers KRX/SSE/SZSE (= KO/KQ/SHG/SHE)
  console.log('─── 1. TWELVEDATA CALLS POUR KRX/SSE/SZSE (6h) ───');
  const { data: tdCalls } = await sb.from('twelve_data_request_log')
    .select('symbol, endpoint, success, status_code, error_message, created_at, called_by')
    .gte('created_at', since6h)
    .or('symbol.like.%:KRX,symbol.like.%:SSE,symbol.like.%:SZSE')
    .order('created_at', { ascending: false })
    .limit(30);
  console.log(`  Appels TD KRX/SSE/SZSE 6h : ${tdCalls?.length ?? 0}`);
  if (tdCalls && tdCalls.length > 0) {
    const byResult: Record<string, number> = {};
    for (const c of tdCalls as any[]) {
      const key = c.success ? 'ok' : `fail:${c.error_message?.slice(0, 40) ?? c.status_code}`;
      byResult[key] = (byResult[key] ?? 0) + 1;
    }
    console.log('  Résultats :', JSON.stringify(byResult));
    // Détail des 5 derniers
    for (const c of (tdCalls as any[]).slice(0, 5)) {
      console.log(`    ${c.created_at?.slice(11, 19)} ${c.symbol?.padEnd(20)} [${c.endpoint}] ok=${c.success} status=${c.status_code ?? '-'} err=${c.error_message?.slice(0, 50) ?? '-'} by=${c.called_by}`);
    }
  } else {
    console.log('  ⚠️  AUCUN appel TD pour KRX/SSE/SZSE — TwelveData n\'est pas appelé ou les tickers ne matchent pas');
  }

  // 2. TwelveData calls endpoint=quote spécifiquement (prix live)
  console.log('\n─── 2. TWELVEDATA QUOTE CALLS (live_price) 6h ───');
  const { data: tdQuote } = await sb.from('twelve_data_request_log')
    .select('symbol, success, status_code, error_message, created_at, called_by')
    .gte('created_at', since6h)
    .eq('endpoint', 'quote')
    .order('created_at', { ascending: false })
    .limit(20);
  console.log(`  Appels TD quote 6h : ${tdQuote?.length ?? 0}`);
  const tdQuoteByEx: Record<string, { ok: number; fail: number }> = {};
  for (const c of (tdQuote ?? []) as any[]) {
    const sym: string = c.symbol ?? '';
    const ex = sym.includes(':') ? sym.split(':').pop() ?? '?' : '?';
    if (!tdQuoteByEx[ex]) tdQuoteByEx[ex] = { ok: 0, fail: 0 };
    if (c.success) tdQuoteByEx[ex].ok++; else tdQuoteByEx[ex].fail++;
  }
  for (const [ex, s] of Object.entries(tdQuoteByEx)) {
    console.log(`    ${ex.padEnd(8)} ok=${s.ok} fail=${s.fail}`);
  }
  if (!tdQuote || tdQuote.length === 0) {
    console.log('  ⚠️  Pas de calls quote → TwelveData ne reçoit pas de demandes de prix live');
  }

  // 3. EODHD real-time calls pour tickers KO/KQ/SHG/SHE (6h)
  console.log('\n─── 3. EODHD REAL-TIME CALLS TICKERS ASIA (6h) ───');
  const { data: eodhdAsia } = await sb.from('eodhd_request_log')
    .select('ticker, success, http_status, response_size_bytes, timestamp, called_by')
    .gte('timestamp', since6h)
    .eq('called_by', 'live_price')
    .or('ticker.like.%.KO,ticker.like.%.KQ,ticker.like.%.SHG,ticker.like.%.SHE')
    .order('timestamp', { ascending: false })
    .limit(20);
  console.log(`  Appels EODHD live_price Korea/China 6h : ${eodhdAsia?.length ?? 0}`);
  if (eodhdAsia && eodhdAsia.length > 0) {
    const byResult: Record<string, number> = {};
    for (const c of eodhdAsia as any[]) {
      const key = c.success ? 'ok' : `fail:${c.http_status}`;
      byResult[key] = (byResult[key] ?? 0) + 1;
    }
    console.log('  Résultats :', JSON.stringify(byResult));
    for (const c of (eodhdAsia as any[]).slice(0, 5)) {
      console.log(`    ${c.timestamp?.slice(11, 19)} ${c.ticker?.padEnd(20)} ok=${c.success} http=${c.http_status} size=${c.response_size_bytes ?? '?'}b`);
    }
  } else {
    console.log('  ⚠️  Aucun appel EODHD live_price pour tickers coréens/chinois');
  }

  // 4. Decision log — scanner gainers Asia (24h) pour voir ce qui est loggé
  console.log('\n─── 4. DECISION LOG SCANNER GAINERS (24h) — kinds Asia ───');
  const { data: dlGainers } = await sb.from('lisa_decision_log')
    .select('kind, summary, created_at')
    .gte('created_at', since24h)
    .in('kind', ['gainers_scan_started', 'gainers_scan_completed', 'gainers_open', 'gainers_skip', 'gainers_force_close'])
    .order('created_at', { ascending: false })
    .limit(30);
  const kindCounts: Record<string, number> = {};
  for (const d of (dlGainers ?? []) as any[]) kindCounts[d.kind] = (kindCounts[d.kind] ?? 0) + 1;
  console.log('  Counts 24h :', JSON.stringify(kindCounts));
  // Derniers gainers_open (si existant)
  const opens = (dlGainers ?? [] as any[]).filter((d: any) => d.kind === 'gainers_open');
  if (opens.length > 0) {
    console.log('  Derniers gainers_open :');
    for (const d of opens.slice(0, 3) as any[]) {
      console.log(`    ${d.created_at?.slice(11, 19)} ${d.summary?.slice(0, 100)}`);
    }
  } else {
    console.log('  ⚠️  0 gainers_open en 24h — aucune position ouverte depuis hier');
  }

  // 5. TwelveData credit tracker — quota journalier
  console.log('\n─── 5. TWELVEDATA QUOTA JOURNALIER ───');
  const today = now.toISOString().slice(0, 10);
  const { data: tdQuota } = await sb.from('twelve_data_request_log')
    .select('endpoint, success')
    .gte('created_at', `${today}T00:00:00Z`)
    .limit(5000);
  const totalTdCalls = tdQuota?.length ?? 0;
  console.log(`  Calls TD aujourd'hui : ${totalTdCalls}`);
  if (totalTdCalls > 0) {
    const byEp: Record<string, number> = {};
    for (const c of tdQuota as any[]) {
      byEp[c.endpoint ?? '?'] = (byEp[c.endpoint ?? '?'] ?? 0) + 1;
    }
    for (const [ep, n] of Object.entries(byEp).sort((a, b) => (b[1] as number) - (a[1] as number))) {
      console.log(`    ${String(n).padStart(5)}  ${ep}`);
    }
  }

  // 6. Shadow signals ACCEPT vs positions ouvertes (3j) — correlation
  console.log('\n─── 6. SHADOW ACCEPT vs OPENS ASIA (3j) ───');
  const { data: shadowAccept } = await sb.from('gainers_v1_shadow_signals')
    .select('symbol, exchange, created_at, score')
    .eq('decision', 'ACCEPT')
    .gte('created_at', since3d)
    .or('exchange.eq.KO,exchange.eq.KQ,exchange.eq.SHG,exchange.eq.SHE')
    .order('created_at', { ascending: false })
    .limit(5);
  console.log(`  Shadow ACCEPT Asia 3j : ${shadowAccept?.length ?? 0}`);
  for (const s of (shadowAccept ?? []) as any[]) {
    const ageH = Math.round((Date.now() - new Date(s.created_at).getTime()) / 3_600_000);
    console.log(`    ${s.created_at.slice(11, 19)} ${s.symbol?.padEnd(15)} [${s.exchange}] score=${s.score ?? '?'} (il y a ${ageH}h)`);
  }

  const { data: asiaPos } = await sb.from('lisa_positions')
    .select('symbol, entry_timestamp, status')
    .gte('entry_timestamp', since3d)
    .or('symbol.like.%.KO,symbol.like.%.KQ,symbol.like.%.SHG,symbol.like.%.SHE')
    .order('entry_timestamp', { ascending: false })
    .limit(5);
  console.log(`  Positions ouvertes Asia 3j : ${asiaPos?.length ?? 0}`);
  if (!asiaPos || asiaPos.length === 0) {
    console.log('  ⚠️  Aucune position Asia ouverte depuis 3 jours — confirme le drought');
  }

  // 7. EODHD real-time calls all called_by=live_price (6h) — pour voir si le chemin est actif
  console.log('\n─── 7. EODHD REAL-TIME CALLS (live_price) TOUTES BOURSES 6h ───');
  const { count: totalLivePrice } = await sb.from('eodhd_request_log')
    .select('*', { count: 'exact', head: true })
    .gte('timestamp', since6h)
    .eq('called_by', 'live_price');
  console.log(`  Total EODHD live_price calls 6h : ${totalLivePrice ?? 0}`);

  console.log('\n=== FIN AUDIT PRIX LIVE ASIA ===\n');
}
main().catch(e => { console.error(e); process.exit(1); });
