/**
 * Counterfactual rétroactif sur les 203 reject_opening_buffer 7j.
 *
 * Méthode sans EODHD API (local) :
 * Pour chaque rejet, on regarde si le MÊME symbole apparaît dans shadow_signals
 * APRÈS le rejet (cycles ultérieurs, ≤ 90min après) avec un changePct supérieur.
 * Si oui → la pépite a continué de monter (le rejet a coûté).
 * Si jamais réapparu OU changePct plus bas → le rejet était correct (a faded).
 *
 * Approximation : on n'a pas le prix exact à entry+60min, mais le système
 * scanne en continu donc on a une trace évolutive du même ticker.
 */
import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';

const env = fs.readFileSync('.env', 'utf8').split('\n').reduce((acc, l) => {
  const m = l.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/); if (m) acc[m[1]] = m[2]; return acc;
}, {} as Record<string, string>);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!);

const since = new Date(Date.now() - 7 * 24 * 60 * 60_000).toISOString();

async function main() {
  console.log(`\n=== COUNTERFACTUAL reject_opening_buffer 7j ===\n`);

  // 1. Récupère tous les rejets uniques (symbol, first_rejected_at)
  const { data: rejects, error } = await sb.from('gainers_user_shadow_signals')
    .select('symbol, asset_class, created_at, change_pct_1m')
    .gte('created_at', since)
    .eq('decision', 'reject_opening_buffer')
    .order('created_at', { ascending: true })
    .limit(10000);

  if (error) { console.error(error); process.exit(1); }
  if (!rejects || rejects.length === 0) { console.log('Aucun rejet 7j'); return; }

  // Dédoublonne par (symbol, day) — garde le premier rejet de la journée par ticker
  const uniqueByDay = new Map<string, typeof rejects[0]>();
  for (const r of rejects) {
    const day = r.created_at.slice(0, 10);
    const key = `${r.symbol}|${day}`;
    if (!uniqueByDay.has(key)) uniqueByDay.set(key, r);
  }
  console.log(`Total rejets bruts: ${rejects.length}`);
  console.log(`Rejets uniques (symbol × day): ${uniqueByDay.size}\n`);

  // 2. Pour chaque rejet unique, cherche les ré-apparitions ≤ 90min après
  let regretCount = 0;
  let neutralCount = 0;
  let fadedCount = 0;
  let noFollowupCount = 0;
  const regretSamples: string[] = [];

  for (const [key, r] of uniqueByDay) {
    const t0 = new Date(r.created_at).getTime();
    const tEnd = new Date(t0 + 90 * 60_000).toISOString();
    const change0 = Number(r.change_pct_1m ?? 0);

    const { data: followups } = await sb.from('gainers_user_shadow_signals')
      .select('decision, change_pct_1m, created_at')
      .eq('symbol', r.symbol)
      .gt('created_at', r.created_at)
      .lte('created_at', tEnd)
      .order('created_at', { ascending: true })
      .limit(50);

    if (!followups || followups.length === 0) {
      noFollowupCount++;
      continue;
    }

    const maxChange = Math.max(...followups.map(f => Number(f.change_pct_1m ?? 0)));
    const minChange = Math.min(...followups.map(f => Number(f.change_pct_1m ?? 0)));

    // Critères :
    // - REGRET : maxChange ≥ change0 + 1.5% (TP_HIT proxy, on aurait gagné +1.5%)
    // - FADE : minChange ≤ change0 - 1.5% (SL_HIT proxy)
    // - NEUTRAL : entre les deux
    if (maxChange >= change0 + 1.5) {
      regretCount++;
      if (regretSamples.length < 15) {
        regretSamples.push(`  ${r.symbol.padEnd(15)} entry@${change0.toFixed(2)}% → max@${maxChange.toFixed(2)}% (+${(maxChange-change0).toFixed(2)}%) ${r.created_at.slice(11,16)} (${r.asset_class})`);
      }
    } else if (minChange <= change0 - 1.5) {
      fadedCount++;
    } else {
      neutralCount++;
    }
  }

  const total = uniqueByDay.size;
  const measured = total - noFollowupCount;
  console.log(`Évaluables (avec follow-up): ${measured}/${total}`);
  console.log(`Sans follow-up (pas de cycle ultérieur ≤90min): ${noFollowupCount}`);
  console.log('');
  console.log(`✅ REGRET (gagnant loupé, +≥1.5%): ${regretCount} (${(100*regretCount/measured).toFixed(1)}% des évaluables)`);
  console.log(`⚪ NEUTRAL (entre -1.5% et +1.5%): ${neutralCount} (${(100*neutralCount/measured).toFixed(1)}%)`);
  console.log(`❌ FADED (perdant évité, -≥1.5%): ${fadedCount} (${(100*fadedCount/measured).toFixed(1)}%)`);
  console.log('');
  console.log('Échantillons REGRET (pépites loupées) :');
  for (const s of regretSamples) console.log(s);

  // 3. Verdict
  console.log('\n=== VERDICT ===');
  const regretRate = regretCount / measured;
  if (regretRate > 0.30) {
    console.log(`❌ Buffer TROP STRICT : ${(100*regretRate).toFixed(1)}% des rejets sont des pépites (>30% threshold)`);
    console.log('   → Recommandation : réduire encore le buffer ou désactiver entièrement');
  } else if (regretRate > 0.15) {
    console.log(`⚠️  Buffer borderline : ${(100*regretRate).toFixed(1)}% de regret (15-30%)`);
    console.log('   → Recommandation : monitor 7j post-fix avant nouvel ajustement');
  } else {
    console.log(`✅ Buffer JUSTIFIÉ : ${(100*regretRate).toFixed(1)}% de regret seulement (<15%)`);
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
