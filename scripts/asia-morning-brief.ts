/**
 * Morning brief Asia — résume ce qui s'est passé pendant la session asiatique
 * (00:00-08:00 UTC = 02:00-10:00 Paris).
 *
 * Usage matin :
 *   npx tsx scripts/asia-morning-brief.ts
 *
 * Sortie attendue : status par portfolio + breakdown horaire + alertes
 * éventuelles (SL en cascade, exchange toxique récurrent, etc.).
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const PORTFOLIOS = {
  TRADER: 'b0000001-0000-0000-0000-000000000001',
  HIGH: 'a0000001-0000-0000-0000-000000000001',
  MIDDLE: 'a0000002-0000-0000-0000-000000000002',
  SMALL: 'a0000003-0000-0000-0000-000000000003',
};

async function main() {
  // Asia session = 00:00-08:00 UTC TODAY
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const sessionStart = today.toISOString();
  const sessionEnd = new Date(today.getTime() + 8 * 3600_000).toISOString();

  console.log(`\n🌏 ASIA MORNING BRIEF — ${today.toISOString().slice(0, 10)}`);
  console.log(`Session UTC: ${sessionStart} → ${sessionEnd}`);
  console.log(`Local Paris: 02:00 → 10:00\n`);
  console.log('═'.repeat(70));

  // 1. Asia trades opened during session (any status)
  const { data: opens } = await sb
    .from('paper_trades')
    .select('symbol, portfolio_id, asset_class, opened_at, closed_at, status, pnl_usd, pnl_pct, hold_duration_seconds, setup_kind, regime_at_entry')
    .in('portfolio_id', Object.values(PORTFOLIOS))
    .eq('asset_class', 'asia_equity')
    .gte('opened_at', sessionStart)
    .lte('opened_at', sessionEnd)
    .order('opened_at', { ascending: true });

  const trades = opens ?? [];
  if (trades.length === 0) {
    console.log('🟢 Aucun trade Asia ouvert cette nuit. Soit le scanner a holdé tout le temps,');
    console.log('   soit aucun candidat n\'a passé les gates. Rien à signaler.\n');
    return;
  }

  // 2. Status agrégé
  const total = trades.length;
  const closed = trades.filter((t) => t.status !== 'open');
  const stillOpen = trades.filter((t) => t.status === 'open');
  const totalPnl = closed.reduce((s, t) => s + Number(t.pnl_usd ?? 0), 0);
  const wins = closed.filter((t) => Number(t.pnl_usd ?? 0) > 0).length;
  const winRate = closed.length > 0 ? (wins / closed.length) * 100 : 0;

  console.log(`\n📊 RÉSUMÉ`);
  console.log(`  Trades ouverts pendant Asia : ${total}`);
  console.log(`  Fermés                       : ${closed.length}`);
  console.log(`  Toujours ouverts             : ${stillOpen.length}`);
  console.log(`  PnL cumulé closed            : $${totalPnl.toFixed(2)}`);
  console.log(`  Win rate                     : ${winRate.toFixed(0)}%`);

  // 3. Alertes
  console.log(`\n🚨 ALERTES`);
  const alerts: string[] = [];

  // Loss > -$100 cumulated
  if (totalPnl < -100) {
    alerts.push(`PnL Asia cumulé < -$100 (${totalPnl.toFixed(2)}) — pattern toxique possible`);
  }

  // Consecutive SL hits
  const closedSorted = [...closed].sort((a, b) => new Date(a.closed_at!).getTime() - new Date(b.closed_at!).getTime());
  let maxConsecLoss = 0, cur = 0;
  for (const t of closedSorted) {
    if (Number(t.pnl_usd ?? 0) < 0) { cur++; maxConsecLoss = Math.max(maxConsecLoss, cur); }
    else cur = 0;
  }
  if (maxConsecLoss >= 3) {
    alerts.push(`${maxConsecLoss} SL/closes consécutifs en perte (Three-Loss Rule violée)`);
  }

  // Single trade > -$50
  const bigLosers = closed.filter((t) => Number(t.pnl_usd ?? 0) < -50);
  if (bigLosers.length > 0) {
    alerts.push(`${bigLosers.length} trade(s) avec perte > -$50 (catastrophic single)`);
  }

  // Shenzhen (SHE) = blacklist suggérée
  const sheTrades = trades.filter((t) => t.symbol.endsWith('.SHE'));
  if (sheTrades.length > 0) {
    const shePnl = sheTrades.reduce((s, t) => s + Number(t.pnl_usd ?? 0), 0);
    alerts.push(`${sheTrades.length} trade(s) Shenzhen (.SHE) — historique 0% WR → vérifier`);
  }

  if (alerts.length === 0) {
    console.log('  ✅ Aucune alerte (PnL OK, pas de cascade SL, pas de big loser)');
  } else {
    for (const a of alerts) console.log(`  🔴 ${a}`);
  }

  // 4. Breakdown par portfolio
  console.log(`\n📁 PAR PORTFOLIO`);
  for (const [name, id] of Object.entries(PORTFOLIOS)) {
    const portTrades = closed.filter((t) => t.portfolio_id === id);
    if (portTrades.length === 0) {
      console.log(`  ${name.padEnd(7)} 0 trades`);
      continue;
    }
    const pnl = portTrades.reduce((s, t) => s + Number(t.pnl_usd ?? 0), 0);
    const w = portTrades.filter((t) => Number(t.pnl_usd ?? 0) > 0).length;
    console.log(`  ${name.padEnd(7)} ${portTrades.length} trades, WR ${(w / portTrades.length * 100).toFixed(0)}%, pnl $${pnl.toFixed(2)}`);
  }

  // 5. Breakdown par exchange
  console.log(`\n🏛️  PAR EXCHANGE`);
  const byEx: Record<string, { n: number; w: number; pnl: number }> = {};
  for (const t of closed) {
    const ex = t.symbol.split('.')[1] ?? 'UNK';
    if (!byEx[ex]) byEx[ex] = { n: 0, w: 0, pnl: 0 };
    byEx[ex].n++;
    byEx[ex].pnl += Number(t.pnl_usd ?? 0);
    if (Number(t.pnl_usd ?? 0) > 0) byEx[ex].w++;
  }
  for (const [k, s] of Object.entries(byEx).sort((a, b) => a[1].pnl - b[1].pnl)) {
    const ind = k === 'SHE' ? ' 🔴' : k === 'KQ' ? ' 🟢' : '';
    console.log(`  ${k.padEnd(6)} n=${s.n} WR=${(s.w / s.n * 100).toFixed(0)}% pnl=$${s.pnl.toFixed(2)}${ind}`);
  }

  // 6. Breakdown par heure
  console.log(`\n⏰ PAR HEURE UTC OPENING`);
  const byHour: Record<number, { n: number; w: number; pnl: number }> = {};
  for (const t of closed) {
    const h = new Date(t.opened_at).getUTCHours();
    if (!byHour[h]) byHour[h] = { n: 0, w: 0, pnl: 0 };
    byHour[h].n++;
    byHour[h].pnl += Number(t.pnl_usd ?? 0);
    if (Number(t.pnl_usd ?? 0) > 0) byHour[h].w++;
  }
  for (let h = 0; h < 9; h++) {
    const s = byHour[h];
    if (!s) continue;
    console.log(`  ${String(h).padStart(2, '0')}h n=${s.n} WR=${(s.w / s.n * 100).toFixed(0)}% pnl=$${s.pnl.toFixed(2)}`);
  }

  // 7. Setup taxonomy (si peuplée par PR #578)
  const withSetup = trades.filter((t) => t.setup_kind !== null);
  if (withSetup.length > 0) {
    console.log(`\n🏷️  SETUP TAXONOMY (PR #578) — ${withSetup.length} trades classifiés`);
    const bySetup: Record<string, { n: number; pnl: number }> = {};
    for (const t of withSetup) {
      const k = `${t.setup_kind}/${t.regime_at_entry}`;
      if (!bySetup[k]) bySetup[k] = { n: 0, pnl: 0 };
      bySetup[k].n++;
      bySetup[k].pnl += Number(t.pnl_usd ?? 0);
    }
    for (const [k, s] of Object.entries(bySetup).sort((a, b) => a[1].pnl - b[1].pnl)) {
      console.log(`  ${k.padEnd(40)} n=${s.n} pnl=$${s.pnl.toFixed(2)}`);
    }
  } else {
    console.log(`\n🏷️  SETUP TAXONOMY : 0 trades classifiés (colonnes setup_kind/regime NULL)`);
  }

  // 8. Open positions à monitor
  if (stillOpen.length > 0) {
    console.log(`\n⏳ POSITIONS TOUJOURS OUVERTES — à vérifier`);
    for (const t of stillOpen) {
      console.log(`  ${t.symbol.padEnd(14)} ouvert ${t.opened_at} (portfolio=${Object.entries(PORTFOLIOS).find(([_, v]) => v === t.portfolio_id)?.[0]})`);
    }
  }

  console.log('\n═'.repeat(70));
  console.log(`📋 Recommandation : si alertes 🔴 dans la section ALERTES → considérer`);
  console.log(`   - Désactiver autopilot temporairement (POST /lisa/mode portfolio)`);
  console.log(`   - Étendre GAINERS_HOUR_BLACKLIST_ASIA_UTC (en cas pattern horaire)`);
  console.log(`   - Désactiver exchange toxique récurrent (cf. analyse 30d)\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
