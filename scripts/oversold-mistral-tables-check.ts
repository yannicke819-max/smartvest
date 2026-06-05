/**
 * Vérif exhaustive Supabase pour le cron oversold-mistral-exit (15min).
 * FIX : decision_log utilise `timestamp` pas `created_at`.
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  const sinceEnableSecret = '2026-06-04T17:55:00Z';
  const sinceMerge586 = '2026-06-04T19:15:00Z';

  console.log('═══════════════════════════════════════════════════════════════');
  console.log(` Maintenant : ${new Date().toISOString().slice(0,19)}Z`);
  console.log(` Secret set : ${sinceEnableSecret}`);
  console.log(` PR #586 squash merge : ${sinceMerge586}`);
  console.log('═══════════════════════════════════════════════════════════════\n');

  // [A] Mistral cron decisions
  const { count: mistralAllTime } = await sb
    .from('lisa_decision_log')
    .select('id', { count: 'exact', head: true })
    .eq('kind', 'oversold_mistral_gain_pick');
  console.log(`[A] lisa_decision_log kind='oversold_mistral_gain_pick' all-time : ${mistralAllTime ?? 0}`);

  // [B] Tous kinds depuis secret set
  const { data: kindsAfter } = await sb
    .from('lisa_decision_log')
    .select('kind')
    .gte('timestamp', sinceEnableSecret)
    .limit(5000);
  const ck = new Map<string, number>();
  for (const r of kindsAfter ?? []) ck.set(r.kind as string, (ck.get(r.kind as string) ?? 0) + 1);
  console.log(`\n[B] kinds decision_log depuis secret set (${kindsAfter?.length ?? 0} rows) :`);
  const oversoldKinds = [...ck.entries()].filter(([k]) => /oversold|mistral/i.test(k));
  if (oversoldKinds.length === 0) console.log('    Aucun kind oversold/mistral');
  for (const [k, n] of oversoldKinds) console.log(`    ${k.padEnd(50)} → ${n}`);

  // [C] TOP 15 kinds
  const sortedKinds = [...ck.entries()].sort((a, b) => b[1] - a[1]);
  console.log(`\n[C] TOP 15 kinds depuis secret set :`);
  for (const [k, n] of sortedKinds.slice(0, 15)) console.log(`    ${k.padEnd(50)} → ${n}`);

  // [D] HIGH closes today
  const HIGH = 'a0000001-0000-0000-0000-000000000001';
  const { data: highClosesToday, count: highCount } = await sb
    .from('lisa_positions')
    .select('symbol, exit_timestamp, close_reason, realized_pnl_usd, close_rationale, venue_fee_detail', { count: 'exact' })
    .eq('portfolio_id', HIGH)
    .eq('status', 'closed')
    .gte('exit_timestamp', '2026-06-04T00:00:00Z')
    .order('exit_timestamp', { ascending: false })
    .limit(50);
  let sumPnl = 0;
  for (const p of highClosesToday ?? []) sumPnl += Number(p.realized_pnl_usd ?? 0);
  console.log(`\n[D] HIGH closes 04/06 (TOUTES sources confondues) : ${highCount ?? 0}, Σ PnL = $${sumPnl.toFixed(2)}`);
  console.log('    8 plus récents :');
  for (const p of (highClosesToday ?? []).slice(0, 8)) {
    const t = String(p.exit_timestamp).slice(0, 19).replace('T', ' ');
    const src = (p.venue_fee_detail as Record<string, unknown> | null)?.source ?? '(null)';
    const rat = String(p.close_rationale ?? '').slice(0, 50);
    console.log(`    ${t}  ${String(p.symbol).padEnd(10)}  $${Number(p.realized_pnl_usd ?? 0).toFixed(2).padStart(8)}  src=${src}  ${p.close_reason}  ${rat}`);
  }

  // [E] HIGH closes 04/06 avec source contenant 'oversold'
  const oversoldClosedToday = (highClosesToday ?? []).filter(p => {
    const src = (p.venue_fee_detail as Record<string, unknown> | null)?.source;
    return typeof src === 'string' && src.includes('oversold');
  });
  console.log(`\n[E] HIGH closes 04/06 avec source='scanner_oversold' : ${oversoldClosedToday.length}`);

  // [F] Captures position_close_decisions
  const { count: pcdAllTime } = await sb
    .from('position_close_decisions')
    .select('id', { count: 'exact', head: true });
  const { count: pcdAfterEnable } = await sb
    .from('position_close_decisions')
    .select('id', { count: 'exact', head: true })
    .gte('captured_at', sinceEnableSecret);
  const { count: pcdAfterMerge } = await sb
    .from('position_close_decisions')
    .select('id', { count: 'exact', head: true })
    .gte('captured_at', sinceMerge586);
  console.log(`\n[F] position_close_decisions all-time=${pcdAllTime}, depuis secret=${pcdAfterEnable}, depuis merge=${pcdAfterMerge}`);

  // [G] position_indicators_snapshot (input du cron Mistral)
  const { count: snapAfterEnable } = await sb
    .from('position_indicators_snapshot')
    .select('position_id', { count: 'exact', head: true })
    .gte('captured_at', sinceEnableSecret);
  console.log(`\n[G] position_indicators_snapshot écrits depuis secret set : ${snapAfterEnable ?? 0}`);

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log(' VERDICT');
  console.log('═══════════════════════════════════════════════════════════════');
  if ((mistralAllTime ?? 0) === 0 && (pcdAfterEnable ?? 0) === 0 && (pcdAfterMerge ?? 0) === 0) {
    console.log(' ❌ ZÉRO trace du cron oversold-mistral-exit dans la base.');
    if ((snapAfterEnable ?? 0) > 0) {
      console.log('    BON SIGNE : position_indicators_snapshot tourne (input OK)');
      console.log('    MAUVAIS : aucune écriture par le cron Mistral lui-même.');
      console.log('    → soit binary prod pré-ac2d7af → le merge #586 va corriger');
      console.log('    → soit env appliquée mais HOLD systématique (silence normal)');
    }
  } else {
    console.log(` ✅ ${mistralAllTime} décisions Mistral / ${pcdAfterEnable} captures`);
  }
  console.log('═══════════════════════════════════════════════════════════════\n');
}

main().catch(e => { console.error(e); process.exit(1); });
