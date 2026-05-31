import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const PORTFOLIOS = [
  { id: 'b0000001-0000-0000-0000-000000000001', name: 'TRADER', capital: 10000 },
  { id: 'a0000001-0000-0000-0000-000000000001', name: 'HIGH', capital: 10500 },
  { id: 'a0000002-0000-0000-0000-000000000002', name: 'MIDDLE', capital: 10500 },
  { id: 'a0000003-0000-0000-0000-000000000003', name: 'SMALL', capital: 10500 },
];

async function main() {
  const today = new Date().toISOString().slice(0, 10);
  const todayStart = today + 'T00:00:00Z';
  const since7d = new Date(Date.now() - 7 * 24 * 3600_000).toISOString();

  console.log('═══════════════════════════════════════════════════════════════════════');
  console.log(' POINT COMPLET 4 SCANNERS — ' + new Date().toISOString().slice(0, 16) + 'Z');
  console.log('═══════════════════════════════════════════════════════════════════════');
  console.log();

  // Today
  console.log('📊 TODAY (' + today + ')');
  console.log('─────────────────────────────────────────────────────────────────────');
  console.log('Portfolio  Cap      Open  Closed  Win/Loss   WR%      Net $');
  console.log('─────────────────────────────────────────────────────────────────────');
  let totalNet = 0;
  for (const p of PORTFOLIOS) {
    const { data: open } = await sb.from('lisa_positions').select('id').eq('portfolio_id', p.id).eq('status', 'open');
    const { data: closed } = await sb
      .from('lisa_positions')
      .select('symbol,asset_class,realized_pnl_usd,entry_notional_usd')
      .eq('portfolio_id', p.id)
      .neq('status', 'open')
      .gte('entry_timestamp', todayStart);
    const cClosed = closed?.length ?? 0;
    let wins = 0, losses = 0, gross = 0, fees = 0;
    (closed ?? []).forEach((t: { realized_pnl_usd?: number | string; entry_notional_usd?: number | string; asset_class?: string }) => {
      const pnl = Number(t.realized_pnl_usd ?? 0);
      gross += pnl;
      if (pnl > 0) wins++;
      else if (pnl < 0) losses++;
      const notional = Number(t.entry_notional_usd ?? 0);
      const cls = t.asset_class ?? 'unknown';
      const feePct = cls.startsWith('crypto') ? 0.2 : cls.includes('us_') ? 0.05 : 0.2;
      fees += (notional * feePct) / 100;
    });
    const net = gross - fees;
    totalNet += net;
    const wr = cClosed > 0 ? ((wins / cClosed) * 100).toFixed(0) + '%' : 'n/a';
    console.log(
      `${p.name.padEnd(9)} $${p.capital.toString().padEnd(7)} ${String(open?.length ?? 0).padStart(4)} ${String(cClosed).padStart(7)} ${(wins + '/' + losses).padStart(8)}  ${wr.padStart(5)}  $${net.toFixed(2).padStart(7)}`,
    );
  }
  console.log('─────────────────────────────────────────────────────────────────────');
  console.log(`TOTAL today net = $${totalNet.toFixed(2)} (target jour TRADER $400, ratio ${((totalNet / 400) * 100).toFixed(1)}%)`);
  console.log();

  // 7 days
  console.log('📊 7 DERNIERS JOURS');
  console.log('─────────────────────────────────────────────────────────────────────');
  console.log('Portfolio  Closed  Win/Loss   WR%     Net $    Best                Worst');
  console.log('─────────────────────────────────────────────────────────────────────');
  for (const p of PORTFOLIOS) {
    const { data: closed } = await sb
      .from('lisa_positions')
      .select('symbol,realized_pnl_usd,exit_reason')
      .eq('portfolio_id', p.id)
      .neq('status', 'open')
      .gte('entry_timestamp', since7d)
      .order('realized_pnl_usd', { ascending: false });
    const cClosed = closed?.length ?? 0;
    let wins = 0, losses = 0, gross = 0;
    (closed ?? []).forEach((t: { realized_pnl_usd?: number | string }) => {
      const pnl = Number(t.realized_pnl_usd ?? 0);
      gross += pnl;
      if (pnl > 0) wins++;
      else if (pnl < 0) losses++;
    });
    const wr = cClosed > 0 ? ((wins / cClosed) * 100).toFixed(0) + '%' : 'n/a';
    const best = closed?.[0];
    const worst = closed?.[(closed?.length ?? 1) - 1];
    const bestStr = best ? `${(best as { symbol: string }).symbol}+$${Number((best as { realized_pnl_usd?: number }).realized_pnl_usd ?? 0).toFixed(2)}` : '-';
    const worstStr = worst && worst !== best ? `${(worst as { symbol: string }).symbol}$${Number((worst as { realized_pnl_usd?: number }).realized_pnl_usd ?? 0).toFixed(2)}` : '-';
    console.log(`${p.name.padEnd(9)} ${String(cClosed).padStart(6)} ${(wins + '/' + losses).padStart(8)}   ${wr.padStart(5)}   $${gross.toFixed(2).padStart(7)} ${bestStr.padEnd(20)} ${worstStr}`);
  }
  console.log();

  // All-time
  console.log('📊 ALL-TIME (depuis création portfolio)');
  console.log('─────────────────────────────────────────────────────────────────────');
  console.log('Portfolio  Closed  Win/Loss   WR%     Net $    $/trade');
  console.log('─────────────────────────────────────────────────────────────────────');
  for (const p of PORTFOLIOS) {
    const { data: closed } = await sb.from('lisa_positions').select('realized_pnl_usd').eq('portfolio_id', p.id).neq('status', 'open');
    const cClosed = closed?.length ?? 0;
    let wins = 0, losses = 0, gross = 0;
    (closed ?? []).forEach((t: { realized_pnl_usd?: number | string }) => {
      const pnl = Number(t.realized_pnl_usd ?? 0);
      gross += pnl;
      if (pnl > 0) wins++;
      else if (pnl < 0) losses++;
    });
    const wr = cClosed > 0 ? ((wins / cClosed) * 100).toFixed(0) + '%' : 'n/a';
    const avg = cClosed > 0 ? (gross / cClosed).toFixed(2) : 'n/a';
    console.log(`${p.name.padEnd(9)} ${String(cClosed).padStart(6)} ${(wins + '/' + losses).padStart(8)}   ${wr.padStart(5)}   $${gross.toFixed(2).padStart(7)} $${avg}`);
  }
  console.log();

  // Open positions live
  console.log('🔓 POSITIONS OUVERTES MAINTENANT');
  console.log('─────────────────────────────────────────────────────────────────────');
  let any = false;
  for (const p of PORTFOLIOS) {
    const { data: open } = await sb
      .from('lisa_positions')
      .select('symbol,asset_class,direction,entry_price,entry_timestamp,entry_notional_usd,stop_loss_price,take_profit_price')
      .eq('portfolio_id', p.id)
      .eq('status', 'open')
      .order('entry_timestamp', { ascending: false });
    if (open?.length) {
      any = true;
      console.log(`${p.name} (${open.length} ouverte${open.length > 1 ? 's' : ''}) :`);
      open.forEach((pos: { symbol: string; direction: string; entry_price: number; entry_notional_usd: number; entry_timestamp: string; stop_loss_price?: number | null; take_profit_price?: number | null }) => {
        const age = Math.round((Date.now() - new Date(pos.entry_timestamp).getTime()) / 60_000);
        console.log(
          `  ${pos.symbol.padEnd(15)} ${pos.direction} $${Number(pos.entry_price).toFixed(4)} notional=$${pos.entry_notional_usd} age=${age}min SL=$${pos.stop_loss_price ? Number(pos.stop_loss_price).toFixed(4) : 'n/a'} TP=$${pos.take_profit_price ? Number(pos.take_profit_price).toFixed(4) : 'n/a'}`,
        );
      });
    }
  }
  if (!any) console.log('Aucune position ouverte sur les 4 portfolios.');
  console.log();

  // Asset class breakdown 7d
  console.log('📊 BREAKDOWN PAR ASSET CLASS (7d)');
  console.log('─────────────────────────────────────────────────────────────────────');
  for (const p of PORTFOLIOS) {
    const { data: closed } = await sb
      .from('lisa_positions')
      .select('asset_class,realized_pnl_usd')
      .eq('portfolio_id', p.id)
      .neq('status', 'open')
      .gte('entry_timestamp', since7d);
    const byClass: Record<string, { n: number; pnl: number }> = {};
    (closed ?? []).forEach((t: { asset_class?: string; realized_pnl_usd?: number | string }) => {
      const c = t.asset_class ?? 'unknown';
      byClass[c] = byClass[c] ?? { n: 0, pnl: 0 };
      byClass[c].n++;
      byClass[c].pnl += Number(t.realized_pnl_usd ?? 0);
    });
    const summary = Object.entries(byClass).map(([k, v]) => `${k}: ${v.n} trades $${v.pnl.toFixed(2)}`).join(' | ');
    console.log(`${p.name.padEnd(9)} ${summary || 'aucun trade'}`);
  }
  console.log();

  // Concordance Pro vs Mistral
  console.log('🤖 CONCORDANCE Pro vs Mistral (depuis activation Mistral today)');
  console.log('─────────────────────────────────────────────────────────────────────');
  const { data: ab } = await sb
    .from('gemini_ab_decisions')
    .select('concordance_full,concordance_pro_vs_mistral_full,concordance_pro_vs_mistral_large_full,mistral_large_action_kind')
    .not('mistral_provider', 'is', null)
    .limit(50000);
  const total = ab?.length ?? 0;
  let proEqFlash = 0, proEqMedium = 0, proEqLarge = 0, largeCalls = 0;
  (ab ?? []).forEach((r: { concordance_full?: boolean | null; concordance_pro_vs_mistral_full?: boolean | null; concordance_pro_vs_mistral_large_full?: boolean | null; mistral_large_action_kind?: string | null }) => {
    if (r.concordance_full === true) proEqFlash++;
    if (r.concordance_pro_vs_mistral_full === true) proEqMedium++;
    if (r.concordance_pro_vs_mistral_large_full === true) proEqLarge++;
    if (r.mistral_large_action_kind !== null && r.mistral_large_action_kind !== undefined) largeCalls++;
  });
  console.log(`Total cycles Mistral actif : ${total}`);
  console.log(`Pro = Flash             : ${proEqFlash}/${total} = ${total > 0 ? ((proEqFlash / total) * 100).toFixed(1) : 'n/a'}%`);
  console.log(`Pro = Mistral Medium    : ${proEqMedium}/${total} = ${total > 0 ? ((proEqMedium / total) * 100).toFixed(1) : 'n/a'}%`);
  console.log(`Pro = Mistral Large     : ${proEqLarge}/${largeCalls} = ${largeCalls > 0 ? ((proEqLarge / largeCalls) * 100).toFixed(1) : 'n/a'}% (n=${largeCalls})`);
}

main().catch(e => { console.error(e); process.exit(1); });
