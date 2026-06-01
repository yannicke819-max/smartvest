import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  const cutoff = '2026-06-01T00:00:00Z';
  const nullify = (s: any) => (s === '' || s == null ? null : s);
  const eq = (a: any, b: any, c: any, d: any) => nullify(a) === nullify(c) && nullify(b) === nullify(d);

  // 1. TRADER cycles + concordance
  const { data: cycles } = await sb
    .from('gemini_ab_decisions')
    .select('decided_at, pro_action_kind, pro_target_symbol, flash_action_kind, flash_target_symbol, mistral_action_kind, mistral_target_symbol, mistral_large_action_kind, mistral_large_target_symbol')
    .gte('decided_at', cutoff).order('decided_at', { ascending: false });

  let actions=0, holds=0, nF=0, mF=0, nM=0, mM=0, nL=0, mL=0;
  for (const r of cycles ?? []) {
    if (r.pro_action_kind === 'hold' && !nullify(r.pro_target_symbol)) holds++; else actions++;
    if (r.flash_action_kind) { nF++; if (eq(r.pro_action_kind, r.pro_target_symbol, r.flash_action_kind, r.flash_target_symbol)) mF++; }
    if (r.mistral_action_kind) { nM++; if (eq(r.pro_action_kind, r.pro_target_symbol, r.mistral_action_kind, r.mistral_target_symbol)) mM++; }
    if (r.mistral_large_action_kind) { nL++; if (eq(r.pro_action_kind, r.pro_target_symbol, r.mistral_large_action_kind, r.mistral_large_target_symbol)) mL++; }
  }
  console.log(`=== TRADER (depuis 00:00 UTC) — ${cycles?.length ?? 0} cycles ===`);
  console.log(`actions=${actions} holds=${holds}`);
  console.log(`Pro=Flash: ${mF}/${nF} = ${nF?((mF/nF)*100).toFixed(1):'—'}%`);
  console.log(`Pro=Med3.5: ${mM}/${nM} = ${nM?((mM/nM)*100).toFixed(1):'—'}%`);
  console.log(`Pro=Large3: ${mL}/${nL} = ${nL?((mL/nL)*100).toFixed(1):'—'}%`);

  // 2. LLM_AB_SHADOW (les 4 call sites peripheriques)
  const { data: shadows, count } = await sb
    .from('llm_ab_shadow_decisions')
    .select('*', { count: 'exact' })
    .gte('created_at', cutoff)
    .order('created_at', { ascending: false });
  console.log(`\n=== LLM_AB_SHADOW (4 call sites périph) — ${count ?? 0} rows depuis 00:00 UTC ===`);
  if (shadows && shadows.length > 0) {
    const bySite: Record<string, any[]> = {};
    for (const r of shadows) { const s = r.call_site || '?'; (bySite[s] = bySite[s] || []).push(r); }
    for (const [site, rows] of Object.entries(bySite)) {
      console.log(`\n  ${site} (${rows.length} calls):`);
      for (const r of rows.slice(0, 5)) {
        const t = r.created_at?.slice(11,19);
        const shadowsArr = r.shadows ?? [];
        const summary = shadowsArr.map((s: any) => `${s.provider}:${s.concordant ? '✓' : '✗'}`).join(' ');
        console.log(`    ${t}  ${r.applied_provider} → ${summary}`);
      }
    }
    // Concordance globale par provider
    console.log(`\n  Concordance globale shadows (tous sites) :`);
    const conc: Record<string, { n: number; m: number }> = {};
    for (const r of shadows) {
      for (const s of (r.shadows ?? [])) {
        const k = s.provider;
        if (!conc[k]) conc[k] = { n: 0, m: 0 };
        conc[k].n++;
        if (s.concordant) conc[k].m++;
      }
    }
    for (const [k, v] of Object.entries(conc)) console.log(`    ${k}: ${v.m}/${v.n} = ${((v.m/v.n)*100).toFixed(1)}%`);
  } else {
    console.log('Encore vide.');
  }

  // 3. Positions open
  const { data: openPos } = await sb.from('paper_trades').select('opened_at, symbol, side, entry_price, size_usd, portfolio_id').is('exit_timestamp', null);
  console.log(`\n=== POSITIONS OUVERTES = ${openPos?.length ?? 0} ===`);
  for (const p of (openPos ?? [])) {
    console.log(`  ${p.opened_at?.slice(0,16)?.replace('T',' ')}  ${p.symbol} ${p.side} $${p.size_usd}`);
  }

  // 4. Gainers candidates
  const { count: gainersCount } = await sb.from('gainers_user_shadow_signals').select('*', { count: 'exact', head: true }).gte('detected_at', cutoff);
  console.log(`\n=== Gainers candidats détectés = ${gainersCount ?? 0} ===`);
}
main().catch(e => { console.error(e); process.exit(1); });
