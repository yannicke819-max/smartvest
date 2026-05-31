import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  const today = new Date().toISOString().slice(0, 10);
  const { data, error } = await sb
    .from('gemini_ab_decisions')
    .select('decided_at, pro_action_kind, pro_target_symbol, pro_applied, flash_action_kind, flash_target_symbol, mistral_action_kind, mistral_target_symbol, mistral_large_action_kind, mistral_large_target_symbol')
    .gte('decided_at', today + 'T00:00:00Z')
    .order('decided_at', { ascending: false })
    .limit(500);

  if (error) { console.log('ERR', error.message); return; }
  if (!data || data.length === 0) { console.log('Pas de data'); return; }

  const nullify = (s: any) => (s === '' || s == null ? null : s);
  const eq = (a: any, b: any, c: any, d: any) => nullify(a) === nullify(c) && nullify(b) === nullify(d);

  let nFlash = 0, mFlash = 0;
  let nMed = 0, mMed = 0;
  let nLarge = 0, mLarge = 0;

  for (const r of data) {
    if (r.flash_action_kind) { nFlash++; if (eq(r.pro_action_kind, r.pro_target_symbol, r.flash_action_kind, r.flash_target_symbol)) mFlash++; }
    if (r.mistral_action_kind) { nMed++; if (eq(r.pro_action_kind, r.pro_target_symbol, r.mistral_action_kind, r.mistral_target_symbol)) mMed++; }
    if (r.mistral_large_action_kind) { nLarge++; if (eq(r.pro_action_kind, r.pro_target_symbol, r.mistral_large_action_kind, r.mistral_large_target_symbol)) mLarge++; }
  }

  console.log(`=== TODAY ${today} (concordance vs Pro) ===`);
  console.log(`Total Pro decisions = ${data.length}`);
  console.log(`Pro = Flash       : ${mFlash}/${nFlash} = ${nFlash ? ((mFlash/nFlash)*100).toFixed(1) : '—'}%`);
  console.log(`Pro = Medium 3.5  : ${mMed}/${nMed} = ${nMed ? ((mMed/nMed)*100).toFixed(1) : '—'}%`);
  console.log(`Pro = Large 3     : ${mLarge}/${nLarge} = ${nLarge ? ((mLarge/nLarge)*100).toFixed(1) : '—'}%`);

  // Concordance since fix PR #526 (deployed ~14:00 UTC today, approximation)
  const fixCutoff = today + 'T14:00:00Z';
  let nLargePost = 0, mLargePost = 0, nMedPost = 0, mMedPost = 0;
  for (const r of data) {
    if (r.decided_at && r.decided_at >= fixCutoff) {
      if (r.mistral_action_kind) { nMedPost++; if (eq(r.pro_action_kind, r.pro_target_symbol, r.mistral_action_kind, r.mistral_target_symbol)) mMedPost++; }
      if (r.mistral_large_action_kind) { nLargePost++; if (eq(r.pro_action_kind, r.pro_target_symbol, r.mistral_large_action_kind, r.mistral_large_target_symbol)) mLargePost++; }
    }
  }
  console.log(`\n=== POST-FIX PR #526 (since ${fixCutoff.slice(11,16)} UTC) ===`);
  console.log(`Medium 3.5 : ${mMedPost}/${nMedPost} = ${nMedPost ? ((mMedPost/nMedPost)*100).toFixed(1) : '—'}%`);
  console.log(`Large 3    : ${mLargePost}/${nLargePost} = ${nLargePost ? ((mLargePost/nLargePost)*100).toFixed(1) : '—'}%`);

  console.log('\n=== Derniers 10 cycles ===');
  for (const r of data.slice(0, 10)) {
    const t = r.decided_at?.slice(11, 19);
    const pro = `${r.pro_action_kind}/${nullify(r.pro_target_symbol) ?? '-'}`;
    const fl = r.flash_action_kind ? `${r.flash_action_kind}/${nullify(r.flash_target_symbol) ?? '-'}` : '—';
    const md = r.mistral_action_kind ? `${r.mistral_action_kind}/${nullify(r.mistral_target_symbol) ?? '-'}` : '—';
    const lg = r.mistral_large_action_kind ? `${r.mistral_large_action_kind}/${nullify(r.mistral_large_target_symbol) ?? '-'}` : '—';
    console.log(`${t}  Pro=${pro.padEnd(18)}  Flash=${fl.padEnd(18)}  Med=${md.padEnd(18)}  Lg=${lg}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
