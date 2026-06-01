/**
 * Snapshot post-event macro. Compare les decisions TRADER (Pro vs Flash vs
 * Mistral Medium vs Large) sur les cycles ±15 min après un event critique.
 *
 * Usage : npx tsx scripts/snap-post-event.ts <event_time_utc> <event_name>
 * Exemple : npx tsx scripts/snap-post-event.ts 2026-06-01T09:00:00Z "EU CPI"
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  const eventUtc = process.argv[2] ?? new Date().toISOString();
  const eventName = process.argv[3] ?? 'unknown event';
  const windowStart = new Date(new Date(eventUtc).getTime() - 5 * 60_000).toISOString();
  const windowEnd = new Date(new Date(eventUtc).getTime() + 30 * 60_000).toISOString();

  console.log(`═══ SNAP POST-EVENT : ${eventName} @ ${eventUtc.slice(11,16)} UTC ═══`);
  console.log(`Window : ${windowStart.slice(11,16)} → ${windowEnd.slice(11,16)} UTC\n`);

  const nullify = (s: any) => (s === '' || s == null ? null : s);

  // TRADER cycles dans la fenêtre
  const { data: cycles } = await sb
    .from('gemini_ab_decisions')
    .select('decided_at, pro_action_kind, pro_target_symbol, pro_confidence, pro_thesis, flash_action_kind, flash_target_symbol, mistral_action_kind, mistral_target_symbol, mistral_large_action_kind, mistral_large_target_symbol, pro_applied, candidates_count')
    .gte('decided_at', windowStart)
    .lte('decided_at', windowEnd)
    .order('decided_at', { ascending: true });

  console.log(`TRADER cycles dans la fenêtre : ${cycles?.length ?? 0}\n`);

  for (const r of cycles ?? []) {
    const t = r.decided_at?.slice(11, 19);
    const pro = `${r.pro_action_kind}/${nullify(r.pro_target_symbol) ?? '-'}`;
    const fl = r.flash_action_kind ? `${r.flash_action_kind}/${nullify(r.flash_target_symbol) ?? '-'}` : '—';
    const md = r.mistral_action_kind ? `${r.mistral_action_kind}/${nullify(r.mistral_target_symbol) ?? '-'}` : '—';
    const lg = r.mistral_large_action_kind ? `${r.mistral_large_action_kind}/${nullify(r.mistral_large_target_symbol) ?? '-'}` : '—';

    // Mark divergences
    const allSame = pro === fl && pro === md && pro === lg;
    const marker = allSame ? '  ' : '⚡';
    console.log(`${marker} ${t}  Pro=${pro.padEnd(22)} Flash=${fl.padEnd(22)} Med=${md.padEnd(22)} Lg=${lg}`);

    if (!allSame && r.pro_thesis) {
      console.log(`     Pro thesis: ${(r.pro_thesis as string).slice(0, 150)}`);
    }
  }

  // Positions ouvertes/fermées dans la fenêtre
  const { data: opens } = await sb
    .from('lisa_positions')
    .select('symbol, entry_price, entry_notional_usd, portfolio_id, entry_timestamp, status, exit_timestamp, exit_price, realized_pnl_usd, exit_reason')
    .gte('entry_timestamp', windowStart)
    .lte('entry_timestamp', windowEnd);
  if (opens && opens.length > 0) {
    console.log(`\n📈 POSITIONS OUVERTES DANS LA FENÊTRE (${opens.length}):`);
    for (const p of opens) {
      const port = (p.portfolio_id as string)?.slice(0,8);
      console.log(`  ${p.entry_timestamp?.slice(11,16)} ${port} ${p.symbol} entry=$${p.entry_price} notional=$${p.entry_notional_usd}  status=${p.status} ${p.realized_pnl_usd ? `pnl=$${p.realized_pnl_usd}` : ''}`);
    }
  }
}
main().catch(e => { console.error(e); process.exit(1); });
