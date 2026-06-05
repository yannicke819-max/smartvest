import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  const TRADER = 'b0000001-0000-0000-0000-000000000001';
  // Bug window : PR #611 deploy ~11:39 UTC → hotfix mergé ~13:31 UTC
  const bugStart = '2026-06-05T11:40:00.000Z';
  const bugEnd = '2026-06-05T13:35:00.000Z';

  console.log(`\n═══ Impact bug PR #611 — fenêtre ${bugStart.slice(11,16)} → ${bugEnd.slice(11,16)} UTC ═══\n`);

  // 1. Shadow signals pendant fenêtre
  const { data: shadow } = await sb
    .from('gainers_user_shadow_signals')
    .select('asset_class, decision, symbol, created_at')
    .gte('created_at', bugStart)
    .lt('created_at', bugEnd);
  console.log(`Shadow signals pendant bug : ${shadow?.length ?? 0}`);
  if ((shadow?.length ?? 0) > 0) {
    const byCls = new Map<string, number>();
    for (const s of shadow ?? []) byCls.set(s.asset_class, (byCls.get(s.asset_class) ?? 0) + 1);
    for (const [c, n] of byCls) console.log(`  ${c}: ${n}`);
  }

  // 2. Comparable fenêtre la veille (~même heure)
  const refStart = '2026-06-04T11:40:00.000Z';
  const refEnd = '2026-06-04T13:35:00.000Z';
  const { data: refShadow } = await sb
    .from('gainers_user_shadow_signals')
    .select('asset_class, decision')
    .gte('created_at', refStart)
    .lt('created_at', refEnd);
  console.log(`\nShadow signals 04/06 même fenêtre (ref) : ${refShadow?.length ?? 0}`);
  const refByCls = new Map<string, { accept: number; total: number }>();
  for (const s of refShadow ?? []) {
    const acc = refByCls.get(s.asset_class) ?? { accept: 0, total: 0 };
    acc.total++;
    if (s.decision === 'accept') acc.accept++;
    refByCls.set(s.asset_class, acc);
  }
  for (const [c, s] of refByCls) console.log(`  ${c}: total=${s.total} accept=${s.accept} (${(s.accept/s.total*100).toFixed(0)}%)`);

  // 3. Trader_agent_decisions bypass ouvertures pendant bug
  const { data: bypass } = await sb
    .from('trader_agent_decisions')
    .select('decided_at, target_symbol, action_applied')
    .eq('portfolio_id', TRADER)
    .eq('action_kind', 'open_directional')
    .gte('decided_at', bugStart)
    .lt('decided_at', bugEnd);
  console.log(`\nTRADER bypass open_directional pendant bug : ${bypass?.length ?? 0}`);

  // 4. Aujourd'hui avant bug (sain)
  const todayStart = '2026-06-05T00:00:00.000Z';
  const { data: todaySane } = await sb
    .from('lisa_positions')
    .select('symbol, entry_timestamp')
    .eq('portfolio_id', TRADER)
    .gte('entry_timestamp', todayStart)
    .lt('entry_timestamp', bugStart);
  console.log(`\nPositions ouvertes today AVANT bug (00:00-11:40 UTC) : ${todaySane?.length ?? 0}`);
  for (const p of todaySane ?? []) console.log(`  ${p.entry_timestamp.slice(11,19)} ${p.symbol}`);

  // 5. Trade ratio extrapolation
  const sanePeriodHours = (new Date(bugStart).getTime() - new Date(todayStart).getTime()) / 3600_000;
  const buggedHours = (new Date(bugEnd).getTime() - new Date(bugStart).getTime()) / 3600_000;
  console.log(`\nPériode saine today : ${sanePeriodHours.toFixed(1)}h → ${todaySane?.length ?? 0} positions ouvertes`);
  console.log(`Période bug : ${buggedHours.toFixed(1)}h`);
  if (todaySane && todaySane.length > 0) {
    const rate = todaySane.length / sanePeriodHours;
    const expected = rate * buggedHours;
    console.log(`Taux moyen : ${rate.toFixed(2)} ouvertures/h`);
    console.log(`Ouvertures attendues pendant bug : ~${expected.toFixed(1)}`);
    console.log(`PnL moyen par ouverture (today closed) : ~+$18 (74/4)`);
    console.log(`PnL manqué estimé : ~$${(expected * 18).toFixed(0)}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
