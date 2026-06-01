import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  const cutoff = '2026-06-01T00:00:00Z'; // Nikkei open

  // 1. Cycles Pro depuis Asia open
  const { data: cycles } = await sb
    .from('gemini_ab_decisions')
    .select('decided_at, portfolio_id, pro_action_kind, pro_target_symbol, pro_applied, flash_action_kind, flash_target_symbol, mistral_action_kind, mistral_target_symbol, mistral_large_action_kind, mistral_large_target_symbol')
    .gte('decided_at', cutoff)
    .order('decided_at', { ascending: false });

  const PORT = {
    '58439d86-3f20-4a60-82a4-307f3f252bc2': 'MAIN/TRADER',
    'a0000001-0000-0000-0000-000000000001': 'HIGH',
    'a0000002-0000-0000-0000-000000000002': 'MIDDLE',
    'a0000003-0000-0000-0000-000000000003': 'SMALL',
  } as const;

  console.log(`=== CYCLES TRADER DEPUIS NIKKEI OPEN (${cutoff.slice(11,16)} UTC) ===`);
  console.log(`Total = ${cycles?.length ?? 0} cycles\n`);

  const nullify = (s: any) => (s === '' || s == null ? null : s);
  const eq = (a: any, b: any, c: any, d: any) => nullify(a) === nullify(c) && nullify(b) === nullify(d);

  let actions = 0, holds = 0;
  let nFlash = 0, mFlash = 0;
  let nMed = 0, mMed = 0;
  let nLarge = 0, mLarge = 0;
  let divergences: any[] = [];

  for (const r of cycles ?? []) {
    if (r.pro_action_kind === 'hold' && !nullify(r.pro_target_symbol)) holds++;
    else actions++;

    if (r.flash_action_kind) { nFlash++; if (eq(r.pro_action_kind, r.pro_target_symbol, r.flash_action_kind, r.flash_target_symbol)) mFlash++; else divergences.push({ ...r, who: 'Flash' }); }
    if (r.mistral_action_kind) { nMed++; if (eq(r.pro_action_kind, r.pro_target_symbol, r.mistral_action_kind, r.mistral_target_symbol)) mMed++; else divergences.push({ ...r, who: 'Med' }); }
    if (r.mistral_large_action_kind) { nLarge++; if (eq(r.pro_action_kind, r.pro_target_symbol, r.mistral_large_action_kind, r.mistral_large_target_symbol)) mLarge++; else divergences.push({ ...r, who: 'Lg' }); }
  }

  console.log(`Pro → actions=${actions}  holds=${holds}`);
  console.log(`Pro = Flash       : ${mFlash}/${nFlash} = ${nFlash ? ((mFlash/nFlash)*100).toFixed(1) : '—'}%`);
  console.log(`Pro = Medium 3.5  : ${mMed}/${nMed} = ${nMed ? ((mMed/nMed)*100).toFixed(1) : '—'}%`);
  console.log(`Pro = Large 3     : ${mLarge}/${nLarge} = ${nLarge ? ((mLarge/nLarge)*100).toFixed(1) : '—'}%`);

  // 2. Candidats détectés (scanner gainers)
  const { data: gainers, count: gainersCount } = await sb
    .from('gainers_user_shadow_signals')
    .select('detected_at, symbol, change_pct, gate_status, market', { count: 'exact' })
    .gte('detected_at', cutoff)
    .order('detected_at', { ascending: false })
    .limit(20);

  console.log(`\n=== GAINERS CANDIDATS DETECTÉS DEPUIS NIKKEI OPEN ===`);
  console.log(`Total = ${gainersCount ?? 0} candidats sur ${(cycles?.length ?? 0)} cycles\n`);

  if (gainers && gainers.length > 0) {
    const byStatus: Record<string, number> = {};
    for (const g of gainers) byStatus[g.gate_status || 'unknown'] = (byStatus[g.gate_status || 'unknown'] || 0) + 1;
    console.log('Status breakdown (échantillon 20 derniers) :');
    for (const [k, v] of Object.entries(byStatus)) console.log(`  ${k}: ${v}`);
    console.log('\n10 derniers candidats :');
    for (const g of gainers.slice(0, 10)) {
      console.log(`  ${g.detected_at?.slice(11,19)}  ${g.symbol?.padEnd(14)} ${g.market?.padEnd(8)} ${(g.change_pct || 0).toFixed(2)}%  ${g.gate_status}`);
    }
  } else {
    console.log('Aucun candidat — c\'est le creux Asia (volumes faibles 1ère heure).');
  }

  // 3. Divergences live (intéressantes pour comparer Pro vs Mistral)
  if (divergences.length > 0) {
    console.log(`\n=== ${divergences.length} DIVERGENCES Pro vs shadow depuis Asia open ===`);
    for (const d of divergences.slice(0, 15)) {
      const t = d.decided_at?.slice(11, 19);
      const pro = `${d.pro_action_kind}/${nullify(d.pro_target_symbol) ?? '-'}`;
      let sh = '';
      if (d.who === 'Flash') sh = `${d.flash_action_kind}/${nullify(d.flash_target_symbol) ?? '-'}`;
      if (d.who === 'Med') sh = `${d.mistral_action_kind}/${nullify(d.mistral_target_symbol) ?? '-'}`;
      if (d.who === 'Lg') sh = `${d.mistral_large_action_kind}/${nullify(d.mistral_large_target_symbol) ?? '-'}`;
      console.log(`  ${t}  Pro=${pro.padEnd(18)}  vs ${d.who.padEnd(5)}=${sh}`);
    }
  } else {
    console.log('\n=== Aucune divergence Pro vs shadow ce démarrage Asia ===');
  }

  // 4. Position ouvertes maintenant
  const { data: openPos } = await sb
    .from('paper_trades')
    .select('opened_at, symbol, side, entry_price, size_usd, portfolio_id')
    .is('exit_timestamp', null)
    .order('opened_at', { ascending: false });

  console.log(`\n=== POSITIONS OUVERTES (tous portfolios) = ${openPos?.length ?? 0} ===`);
  for (const p of (openPos ?? [])) {
    const port = PORT[p.portfolio_id as keyof typeof PORT] || p.portfolio_id?.slice(0,8);
    console.log(`  ${p.opened_at?.slice(0,16)?.replace('T',' ')}  ${port.padEnd(12)} ${p.symbol?.padEnd(14)} ${p.side?.padEnd(5)} $${p.size_usd} entry=${p.entry_price}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
