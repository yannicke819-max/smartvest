/**
 * Monitor post-deploy PR #463 (EU staleness bump 900s → 1800s).
 * Watches:
 *  1. EU opens / rejects (lisa_decision_log + lisa_positions)
 *  2. News flow (eodhd_news / decision_log kinds news_*)
 *  3. Gemini Risk Manager (risk_monitor_action verdicts)
 */
import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';

const env = fs.readFileSync('.env', 'utf8').split('\n').reduce((acc, l) => {
  const m = l.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/); if (m) acc[m[1]] = m[2]; return acc;
}, {} as Record<string, string>);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!);
const PID = '58439d86-3f20-4a60-82a4-307f3f252bc2';

const EU_SUFFIX_RE = /\.PA|\.DE|\.LSE|\.SW|\.AS|\.MI|\.XETR|\.MC|\.L$|\.BR/i;

function looksEU(s: string) { return EU_SUFFIX_RE.test(s); }

async function snapshot() {
  const now = new Date().toISOString().slice(11, 19);
  const since = new Date(Date.now() - 5 * 60_000).toISOString();
  console.log(`\n========== ${now} UTC ==========`);

  // 1. Decision_log last 5min — groupé par kind
  const { data: log } = await sb.from('lisa_decision_log')
    .select('kind, summary, payload, created_at')
    .eq('portfolio_id', PID)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(300);
  const events = (log ?? []) as Array<{ kind: string; summary: string; payload: any; created_at: string }>;

  // 2. EU events
  const euEvents = events.filter(e => looksEU((e.summary ?? '') + JSON.stringify(e.payload ?? {})));
  const euAccepts = euEvents.filter(e => /accept|opened|position_opened|trade_opened/i.test(e.kind));
  const euRejects = euEvents.filter(e => /reject|skip|stale/i.test(e.kind));
  console.log(`\n[EU 5min] total=${euEvents.length}  accepts=${euAccepts.length}  rejects=${euRejects.length}`);
  if (euAccepts.length) {
    console.log('  ✅ ACCEPTS:');
    euAccepts.slice(0, 5).forEach(e => console.log(`    ${e.created_at.slice(11,19)} ${e.kind} — ${e.summary?.slice(0,80) ?? ''}`));
  }
  if (euRejects.length) {
    console.log('  ⚠️  Rejects (5 plus récents):');
    euRejects.slice(0, 5).forEach(e => {
      const reason = e.payload?.reason ?? e.payload?.skip_reason ?? e.kind;
      console.log(`    ${e.created_at.slice(11,19)} ${reason} — ${e.summary?.slice(0,70) ?? ''}`);
    });
  }

  // 3. Stale reasons breakdown (any class)
  const staleEvents = events.filter(e => /stale/i.test(e.kind) || /stale/i.test(e.payload?.reason ?? ''));
  if (staleEvents.length) {
    const byClass: Record<string, number> = {};
    staleEvents.forEach(e => {
      const cls = e.payload?.asset_class ?? e.payload?.market ?? 'unknown';
      byClass[cls] = (byClass[cls] ?? 0) + 1;
    });
    console.log(`\n[Stale rejects 5min] ${staleEvents.length} total`);
    Object.entries(byClass).sort((a,b) => b[1]-a[1]).forEach(([c,n]) => console.log(`    ${c.padEnd(20)} ${n}`));
  }

  // 4. News flow
  const newsKinds = events.filter(e => /news|brief|narrative/i.test(e.kind));
  if (newsKinds.length) {
    const by: Record<string, number> = {};
    newsKinds.forEach(e => { by[e.kind] = (by[e.kind] ?? 0) + 1; });
    console.log(`\n[News 5min] ${newsKinds.length} events`);
    Object.entries(by).sort((a,b) => b[1]-a[1]).forEach(([k,n]) => console.log(`    ${k.padEnd(40)} ${n}`));
  }
  // News table (last 5min globally — pas scopé portfolio)
  const { data: news } = await sb.from('eodhd_news')
    .select('symbol, title, sentiment, published_at')
    .gte('published_at', since)
    .order('published_at', { ascending: false })
    .limit(8);
  if (news && news.length) {
    console.log(`  📰 EODHD news (${news.length} dernières):`);
    (news as any[]).forEach(n => {
      const sent = n.sentiment != null ? n.sentiment.toFixed(2) : '?';
      console.log(`    ${n.published_at.slice(11,19)} ${String(n.symbol ?? '?').padEnd(12)} sent=${sent} ${n.title?.slice(0,70) ?? ''}`);
    });
  }

  // 5. Gemini Risk Manager — verdicts
  const rmEvents = events.filter(e => e.kind === 'risk_monitor_action');
  if (rmEvents.length) {
    const verdicts: Record<string, number> = {};
    rmEvents.forEach(e => {
      const v = e.payload?.verdict ?? 'unknown';
      verdicts[v] = (verdicts[v] ?? 0) + 1;
    });
    console.log(`\n[Gemini Risk Manager 5min] ${rmEvents.length} actions`);
    Object.entries(verdicts).sort((a,b) => b[1]-a[1]).forEach(([v,n]) => console.log(`    ${v.padEnd(15)} ${n}`));
    console.log('  Détails (3 derniers):');
    rmEvents.slice(0,3).forEach(e => {
      console.log(`    ${e.created_at.slice(11,19)} ${(e.payload?.verdict ?? '?').padEnd(12)} ${e.summary?.slice(0,90) ?? ''}`);
    });
  } else {
    console.log(`\n[Gemini Risk Manager 5min] 0 actions (pas de positions ouvertes ?)`);
  }

  // 6. Opportunity Scout / Daily Brief Gemini
  const geminiOther = events.filter(e => /gemini|opportunity_scout|daily_brief/i.test(e.kind));
  if (geminiOther.length) {
    const by: Record<string, number> = {};
    geminiOther.forEach(e => { by[e.kind] = (by[e.kind] ?? 0) + 1; });
    console.log(`\n[Gemini autres 5min] ${geminiOther.length}`);
    Object.entries(by).forEach(([k,n]) => console.log(`    ${k}: ${n}`));
  }

  // 7. Open positions
  const { data: open } = await sb.from('lisa_positions')
    .select('symbol, direction, asset_class, entry_price, entry_notional_usd, entry_timestamp')
    .eq('portfolio_id', PID).eq('status', 'open');
  const openArr = (open ?? []) as any[];
  const openEU = openArr.filter(p => looksEU(p.symbol) || /eu/i.test(p.asset_class ?? ''));
  console.log(`\n[OPEN] total=${openArr.length}  EU=${openEU.length}`);
  openArr.slice(0,8).forEach(p => {
    const ageMin = Math.floor((Date.now() - new Date(p.entry_timestamp).getTime()) / 60000);
    console.log(`    ${p.symbol.padEnd(14)} ${p.direction.padEnd(5)} ${(p.asset_class ?? '?').padEnd(18)} entry=${p.entry_price} notional=$${p.entry_notional_usd} age=${ageMin}min`);
  });
}

(async () => {
  const cycles = Number(process.env.CYCLES ?? 12);  // 12 × 60s = 12min default
  const intervalMs = Number(process.env.INTERVAL_MS ?? 60_000);
  console.log(`Monitor post-deploy PR #463 — ${cycles} cycles × ${intervalMs/1000}s`);
  for (let i = 0; i < cycles; i++) {
    try { await snapshot(); } catch (e: any) { console.error(`snapshot error: ${e.message}`); }
    if (i < cycles - 1) await new Promise(r => setTimeout(r, intervalMs));
  }
  console.log(`\nMonitor terminé après ${cycles} cycles.`);
})();
