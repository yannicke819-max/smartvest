/**
 * Audit "occasions manquées depuis minuit UTC".
 */
import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
const env = fs.readFileSync('.env', 'utf8').split('\n').reduce((acc, l) => {
  const m = l.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/); if (m) acc[m[1]] = m[2]; return acc;
}, {} as Record<string, string>);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!);

const todayUtc = new Date();
todayUtc.setUTCHours(0, 0, 0, 0);
const since = todayUtc.toISOString();

async function main() {
  console.log(`\n=== AUDIT OCCASIONS MANQUEES DEPUIS ${since} ===\n`);

  // Totaux
  const { count: total } = await sb.from('gainers_v1_shadow_signals')
    .select('*', { count: 'exact', head: true })
    .gte('created_at', since);
  const { count: accept } = await sb.from('gainers_v1_shadow_signals')
    .select('*', { count: 'exact', head: true })
    .eq('decision', 'ACCEPT')
    .gte('created_at', since);
  const { count: opens } = await sb.from('lisa_positions')
    .select('*', { count: 'exact', head: true })
    .gte('entry_timestamp', since);

  console.log(`Signaux totaux depuis 00:00 UTC : ${total}`);
  console.log(`Signaux ACCEPT depuis 00:00 UTC : ${accept}`);
  console.log(`Positions ouvertes depuis 00:00 UTC : ${opens}`);
  console.log(`Ratio conversion ACCEPT→open : ${(((opens ?? 0) / Math.max(accept ?? 1, 1)) * 100).toFixed(3)}%`);
  console.log(`Occasions perdues (estimées) : ${(accept ?? 0) - (opens ?? 0)}\n`);

  // Top 30 ACCEPT par composite_score
  const { data: tops } = await sb.from('gainers_v1_shadow_signals')
    .select('symbol, exchange, asset_class, composite_score, entry_price, entry_path_eff, setup_type, session, created_at, simulated_pnl_pct, simulated_exit_reason')
    .eq('decision', 'ACCEPT')
    .gte('created_at', since)
    .order('composite_score', { ascending: false })
    .limit(30);

  const { data: positions } = await sb.from('lisa_positions')
    .select('symbol, entry_timestamp, status, realized_pnl_usd, close_reason')
    .gte('entry_timestamp', since);
  const openedSymbols = new Set((positions ?? []).map((p: any) => p.symbol));

  console.log(`─── TOP 30 ACCEPT (par composite_score) ───`);
  console.log('Symbol            Ex    Score   PathEff  Setup            Heure UTC  Simu pnl  Statut');
  console.log('─────────────────────────────────────────────────────────────────────────────────────');
  for (const a of (tops ?? []) as any[]) {
    const opened = openedSymbols.has(a.symbol);
    const flag = opened ? '✅ ouv' : '❌ MISS';
    const simu = a.simulated_pnl_pct != null
      ? `${(Number(a.simulated_pnl_pct) * 100).toFixed(2)}%`.padStart(8)
      : '   n/a  ';
    const reason = a.simulated_exit_reason ?? '';
    console.log(
      `${(a.symbol ?? '?').padEnd(16)} ${(a.exchange ?? '?').padEnd(5)} ` +
      `${Number(a.composite_score ?? 0).toFixed(3)}  ${String(a.entry_path_eff ?? '?').padStart(6)} ` +
      `${(a.setup_type ?? '?').padEnd(15)}  ${a.created_at.slice(11, 16)}    ${simu}  ${flag} ${reason}`,
    );
  }

  // PnL cumulé simulé sur les ACCEPT manqués
  console.log(`\n─── SIMULATION : PNL CUMULE SI ON AVAIT OUVERT TOUT ───`);
  const { data: simAll } = await sb.from('gainers_v1_shadow_signals')
    .select('symbol, exchange, composite_score, simulated_pnl_pct, simulated_exit_reason')
    .eq('decision', 'ACCEPT')
    .gte('created_at', since)
    .not('simulated_pnl_pct', 'is', null)
    .limit(20000);
  if (simAll && simAll.length > 0) {
    let cumPct = 0;
    let wins = 0; let losses = 0;
    const reasonCount: Record<string, number> = {};
    for (const r of simAll as any[]) {
      const pct = Number(r.simulated_pnl_pct);
      cumPct += pct;
      if (pct > 0) wins++; else losses++;
      const reason = r.simulated_exit_reason ?? 'unknown';
      reasonCount[reason] = (reasonCount[reason] ?? 0) + 1;
    }
    const n = simAll.length;
    console.log(`  Trades simulés (avec PnL résolu) : ${n}`);
    console.log(`  PnL cumulé (somme des % résolus) : ${(cumPct * 100).toFixed(2)}%`);
    console.log(`  PnL moyen par trade              : ${(cumPct / n * 100).toFixed(3)}%`);
    console.log(`  Win rate                          : ${((wins / n) * 100).toFixed(1)}% (${wins}/${n})`);
    console.log(`  Exit reasons :`);
    for (const [r, c] of Object.entries(reasonCount).sort((a, b) => (b[1] as number) - (a[1] as number))) {
      console.log(`    ${String(c).padStart(5)}  ${r}`);
    }
    // Capital simulé : si on avait fait $394 par trade
    const capitalPerTrade = 394;
    const cumDollar = simAll.reduce((s: number, r: any) => s + capitalPerTrade * Number(r.simulated_pnl_pct), 0);
    console.log(`  À $${capitalPerTrade}/trade : gain cumulé simulé = $${cumDollar.toFixed(2)}`);
  } else {
    console.log('  Aucun trade simulé résolu.');
  }

  // ACCEPT par exchange
  console.log(`\n─── ACCEPT PAR EXCHANGE DEPUIS 00:00 UTC ───`);
  const { data: byEx } = await sb.from('gainers_v1_shadow_signals')
    .select('exchange')
    .eq('decision', 'ACCEPT')
    .gte('created_at', since)
    .limit(60000);
  const counts: Record<string, number> = {};
  for (const r of (byEx ?? []) as any[]) counts[r.exchange ?? '?'] = (counts[r.exchange ?? '?'] ?? 0) + 1;
  for (const [ex, n] of Object.entries(counts).sort((a, b) => (b[1] as number) - (a[1] as number))) {
    console.log(`  ${ex.padEnd(10)} ${String(n).padStart(7)}`);
  }

  // Reject reasons (pour comprendre ce qui filtre)
  console.log(`\n─── TOP REJECT_REASON DEPUIS 00:00 UTC ───`);
  const { data: byReason } = await sb.from('gainers_v1_shadow_signals')
    .select('reject_reason')
    .eq('decision', 'REJECT')
    .gte('created_at', since)
    .limit(60000);
  const rc: Record<string, number> = {};
  for (const r of (byReason ?? []) as any[]) rc[r.reject_reason ?? '?'] = (rc[r.reject_reason ?? '?'] ?? 0) + 1;
  for (const [r, n] of Object.entries(rc).sort((a, b) => (b[1] as number) - (a[1] as number)).slice(0, 15)) {
    console.log(`  ${String(n).padStart(7)}  ${r}`);
  }

  // Positions de la journée
  console.log(`\n─── POSITIONS OUVERTES AUJOURD'HUI ───`);
  for (const p of (positions ?? []) as any[]) {
    console.log(`  ${p.entry_timestamp.slice(11, 19)} ${p.symbol.padEnd(15)} ${p.status.padEnd(20)} pnl=${p.realized_pnl_usd ?? 'n/a'} reason=${p.close_reason ?? '?'}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
