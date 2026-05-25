/**
 * Audit complet activité features 24-48h.
 */
import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
const env = fs.readFileSync('.env', 'utf8').split('\n').reduce((acc, l) => {
  const m = l.match(/^([A-Z_]+)=(.+)$/); if (m) acc[m[1]] = m[2]; return acc;
}, {} as Record<string, string>);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  const since = new Date(Date.now() - 48 * 3600_000).toISOString();
  console.log(`\n=== AUDIT 48h depuis ${since.slice(0,16)} ===\n`);

  // 1. GEMINI NEWS — eodhd_news + daily_catalyst_brief
  console.log('--- 1. GEMINI NEWS ---');
  for (const t of ['eodhd_news', 'eodhd_news_persisted', 'eodhd_news_items']) {
    const r = await sb.from(t).select('*', { count: 'exact', head: true });
    if (!r.error) console.log(`  ${t}: ${r.count} rows total`);
  }
  // Count news ingested 48h via news.created_at or persisted_at
  for (const col of ['persisted_at', 'created_at', 'fetched_at']) {
    const r = await sb.from('eodhd_news').select('id', { count: 'exact', head: true }).gte(col, since);
    if (!r.error) { console.log(`  eodhd_news 48h (via ${col}): ${r.count} rows`); break; }
  }
  const briefs = await sb.from('lisa_decision_log').select('summary,timestamp').eq('kind', 'daily_catalyst_brief').gte('timestamp', since).order('timestamp', { ascending: false }).limit(5);
  console.log(`  daily_catalyst_brief (Gemini) 48h: ${briefs.data?.length ?? 0} entries`);
  for (const b of (briefs.data ?? [])) console.log(`    ${b.timestamp.slice(0,16)} — ${(b.summary ?? '').slice(0, 80)}`);

  // 2. M1 REVERSE MOMENTUM — chercher positions SHORT
  console.log('\n--- 2. MIRACLE #1 REVERSE MOMENTUM ---');
  const shortPos = await sb.from('lisa_positions').select('symbol,direction,entry_timestamp,realized_pnl_usd,status', { count: 'exact' }).eq('direction', 'short').gte('entry_timestamp', since).limit(20);
  console.log(`  Positions SHORT 48h: ${shortPos.count ?? 0}`);
  for (const p of (shortPos.data ?? []) as Array<{ symbol: string; entry_timestamp: string; realized_pnl_usd: number | null; status: string }>) {
    console.log(`    ${p.entry_timestamp.slice(0,16)} ${p.symbol.padEnd(10)} ${p.status} pnl=${p.realized_pnl_usd ?? '?'}`);
  }

  // 3. M2 MICRO GATE — log entries via decision_log not really tracked, but via paper_trades persistence
  console.log('\n--- 3. MIRACLE #2 MICRO-MOMENTUM GATE ---');
  console.log('  (gate filtre silencieusement les opens, pas de table dédiée)');
  console.log('  → vérification possible uniquement via logs Fly [micro-momentum-gate] SKIP');

  // 4. M3 EARLY EXIT GUARD — chercher closes avec rationale 'early-exit-guard FADE'
  console.log('\n--- 4. MIRACLE #3 EARLY EXIT GUARD ---');
  const earlyExits = await sb.from('lisa_decision_log').select('summary,payload,timestamp').or('summary.ilike.%EARLY_EXIT%,payload->>verdict.eq.EARLY_EXIT_FADE').gte('timestamp', since).order('timestamp', { ascending: false }).limit(20);
  console.log(`  Early-exit triggers 48h: ${earlyExits.data?.length ?? 0}`);
  for (const e of (earlyExits.data ?? [])) console.log(`    ${e.timestamp.slice(0,16)} — ${e.summary?.slice(0, 80)}`);

  // 5. M4 FEATURE AB TUNING — chercher entries FEATURE_AB
  console.log('\n--- 5. MIRACLE #4 FEATURE AB TUNING ---');
  const ab = await sb.from('feature_ab_snapshot').select('snapshot_date,pnl_usd,n_opens,n_closes,rm_actions_count,ee_fades_count').order('snapshot_date', { ascending: false }).limit(7);
  console.log(`  feature_ab_snapshot (7 derniers jours): ${ab.data?.length ?? 0}`);
  for (const s of (ab.data ?? []) as Array<{ snapshot_date: string; pnl_usd: number; n_opens: number; n_closes: number; rm_actions_count: number; ee_fades_count: number }>) {
    console.log(`    ${s.snapshot_date}: pnl=$${s.pnl_usd ?? 0} opens=${s.n_opens} closes=${s.n_closes} rm=${s.rm_actions_count} ee=${s.ee_fades_count}`);
  }
  const abAnalyze = await sb.from('lisa_decision_log').select('summary,timestamp').like('summary', '[FEATURE_AB]%').gte('timestamp', since).order('timestamp', { ascending: false }).limit(5);
  console.log(`  FEATURE_AB decision_log entries 48h: ${abAnalyze.data?.length ?? 0}`);
  for (const e of (abAnalyze.data ?? [])) console.log(`    ${e.timestamp.slice(0,16)} — ${e.summary?.slice(0, 100)}`);

  // 6. Per-class changePct + hour gate (PR #420 #421)
  console.log('\n--- 6. PER-CLASS THRESHOLDS (PR #420/#421) ---');
  console.log('  (filtres silencieux — vérifiable uniquement via logs Fly :');
  console.log('  [top-gainers] X.KO sur-étendu (changePct=20% ≥ 30%) [per-class asia_equity] → ce log indique fonctionnement)');
  console.log('  [per-class-hour-gate] ENABLED — boot log confirmant config');

  // 7. Lisa Daily Retrospective (Feature #3 du soir précédent)
  console.log('\n--- 7. DAILY RETROSPECTIVE (Feature #3 d\'avant-hier) ---');
  const retros = await sb.from('lisa_daily_retrospective').select('retrospective_date,sentiment,narrative,llm_cost_usd').order('retrospective_date', { ascending: false }).limit(5);
  console.log(`  lisa_daily_retrospective: ${retros.data?.length ?? 0}`);
  for (const r of (retros.data ?? []) as Array<{ retrospective_date: string; sentiment: string; narrative: string; llm_cost_usd: number }>) {
    console.log(`    ${r.retrospective_date} [${r.sentiment}] cost=$${r.llm_cost_usd ?? '?'} — ${(r.narrative ?? '').slice(0, 100)}...`);
  }

  // 8. Correlation guard, conviction sizing (Features #1, #2 d'avant-hier) — silent filters
  console.log('\n--- 8. CORRELATION GUARD / CONVICTION SIZING ---');
  console.log('  (gates silencieux. Vérification via les logs Fly [correlation-guard] REJECTED / [conviction-sizing])');
}
main().catch((e) => { console.error(e); process.exit(1); });
