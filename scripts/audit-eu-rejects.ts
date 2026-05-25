/**
 * Audit EU rejects depuis 06:00 UTC aujourd'hui — confirme/infirme l'hypothèse
 * que GAINERS_HOUR_BLACKLIST_EU_UTC=8,9 + GAINERS_MAX_CHANGE_PCT_LONG_EU=15
 * bloquent l'open EU.
 *
 * Source : gainers_user_shadow_signals (recordShadowDecision côté scanner).
 */
import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';

const env = fs.readFileSync('.env', 'utf8').split('\n').reduce((acc, l) => {
  const m = l.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/); if (m) acc[m[1]] = m[2]; return acc;
}, {} as Record<string, string>);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!);

const todayUtc = new Date();
todayUtc.setUTCHours(6, 0, 0, 0); // depuis 06:00 UTC = pré-open EU
const since = todayUtc.toISOString();

async function main() {
  const now = new Date();
  console.log(`\n=== AUDIT EU REJECTS — ${now.toISOString().slice(0,19)} UTC ===`);
  console.log(`Fenêtre : depuis ${since} (= 06:00 UTC aujourd'hui)\n`);

  // 1. Tous les signaux EU depuis 06:00 UTC (asset_class = 'eu_equity')
  const { data: all, error: errAll } = await sb.from('gainers_user_shadow_signals')
    .select('symbol, asset_class, decision, created_at, change_pct_1m, score, path_eff')
    .gte('created_at', since)
    .eq('asset_class', 'eu_equity')
    .order('created_at', { ascending: false })
    .limit(5000);

  if (errAll) {
    console.error('Erreur DB :', errAll);
    process.exit(1);
  }

  if (!all || all.length === 0) {
    console.log('⚠️  AUCUN signal eu_equity depuis 06:00 UTC.');
    console.log('  → Soit le scanner n\'a pas tourné EU encore, soit pipeline EU cassé en amont.');
    console.log('  → Check Fly logs : grep "[top-gainers].*eu_equity" / "[top-gainers].*\\.(PA|XETRA|L)\\."');
    return;
  }

  console.log(`Total signaux eu_equity : ${all.length}`);

  // 2. Breakdown decision
  const byDecision: Record<string, number> = {};
  for (const s of all as any[]) {
    byDecision[s.decision ?? '?'] = (byDecision[s.decision ?? '?'] ?? 0) + 1;
  }
  console.log('\n─── Breakdown decision (top 20) ───');
  const sorted = Object.entries(byDecision).sort((a,b)=>(b[1] as number)-(a[1] as number));
  for (const [d, n] of sorted.slice(0, 20)) {
    const pct = ((n as number) / all.length * 100).toFixed(1);
    console.log(`  ${String(n).padStart(6)}  ${pct.padStart(5)}%  ${d}`);
  }

  // 3. Hypothèse — heures concernées
  console.log(`\n─── HYPOTHÈSE — heures concernées ───`);
  const hourBlacklisted = (all as any[]).filter(s => s.decision === 'reject_hour_blacklisted');
  const overextended = (all as any[]).filter(s => s.decision === 'reject_overextended');
  const accepts = (all as any[]).filter(s => s.decision === 'accept');
  console.log(`reject_hour_blacklisted : ${hourBlacklisted.length}`);
  console.log(`reject_overextended     : ${overextended.length}`);
  console.log(`accept                  : ${accepts.length}`);

  if (hourBlacklisted.length > 0) {
    const byHour: Record<number, number> = {};
    for (const r of hourBlacklisted) {
      const h = new Date(r.created_at).getUTCHours();
      byHour[h] = (byHour[h] ?? 0) + 1;
    }
    console.log('\n  Histogramme reject_hour_blacklisted par heure UTC :');
    for (const h of Object.keys(byHour).map(Number).sort((a,b)=>a-b)) {
      const bar = '█'.repeat(Math.min(60, Math.ceil(byHour[h] / 2)));
      console.log(`    ${String(h).padStart(2)}h UTC  ${String(byHour[h]).padStart(5)}  ${bar}`);
    }
  }

  if (overextended.length > 0) {
    const pcts = overextended.map(r => Number(r.change_pct_1m) * 100).filter(x => Number.isFinite(x));
    pcts.sort((a,b)=>a-b);
    const p25 = pcts[Math.floor(pcts.length * 0.25)] ?? 0;
    const p50 = pcts[Math.floor(pcts.length * 0.50)] ?? 0;
    const p75 = pcts[Math.floor(pcts.length * 0.75)] ?? 0;
    const p95 = pcts[Math.floor(pcts.length * 0.95)] ?? 0;
    console.log('\n  Distribution change_pct_1m sur reject_overextended (cap actuel 15%) :');
    console.log(`    p25=${p25.toFixed(2)}%  p50=${p50.toFixed(2)}%  p75=${p75.toFixed(2)}%  p95=${p95.toFixed(2)}%`);
    console.log(`    min=${pcts[0]?.toFixed(2)}%  max=${pcts[pcts.length-1]?.toFixed(2)}%`);
    console.log(`    si on relâche à 25% : ${pcts.filter(p => p < 25).length} / ${pcts.length} candidats passeraient`);
    console.log(`    si on relâche à 30% : ${pcts.filter(p => p < 30).length} / ${pcts.length} candidats passeraient`);
  }

  // 4. ACCEPT EU restants (les rares qui passent)
  console.log(`\n─── ACCEPT EU : ${accepts.length} ───`);
  if (accepts.length > 0) {
    for (const a of accepts.slice(0, 15)) {
      const ts = a.created_at.slice(11, 16);
      const ch = (Number(a.change_pct_1m) * 100).toFixed(2);
      console.log(`  ${ts} UTC  ${(a.symbol ?? '?').padEnd(16)} ch1m=${ch}%  score=${Number(a.score ?? 0).toFixed(3)}  pathEff=${Number(a.path_eff ?? 0).toFixed(2)}`);
    }
  } else {
    console.log('  ⚠️  ZERO ACCEPT EU — confirme blocage total');
  }

  // 5. Verdict
  console.log('\n─── VERDICT ───');
  const total = all.length;
  const acceptPct = (accepts.length / total * 100).toFixed(1);
  const hourBlPct = (hourBlacklisted.length / total * 100).toFixed(1);
  const overPct = (overextended.length / total * 100).toFixed(1);
  console.log(`  EU accept rate     : ${acceptPct}%`);
  console.log(`  EU hour_blacklist  : ${hourBlPct}%`);
  console.log(`  EU overextended    : ${overPct}%`);
  console.log(`  EU somme h_bl+over : ${((hourBlacklisted.length + overextended.length) / total * 100).toFixed(1)}%`);
  if ((hourBlacklisted.length + overextended.length) / total > 0.5) {
    console.log('\n  🔴 CONFIRMÉ : >50% des décisions EU = hour-blacklist + overextended.');
    console.log('  RECO : assouplir GAINERS_HOUR_BLACKLIST_EU_UTC (vide) + GAINERS_MAX_CHANGE_PCT_LONG_EU=25');
  } else if (accepts.length === 0) {
    console.log('\n  🔴 ZERO ACCEPT mais raison principale ailleurs :');
    console.log('  Top reject reason :', sorted[0]);
  } else {
    console.log('\n  🟢 ACCEPT > 0 — pipeline EU fonctionne (au moins en partie).');
  }
}
main().catch(e => { console.error(e); process.exit(1); });
