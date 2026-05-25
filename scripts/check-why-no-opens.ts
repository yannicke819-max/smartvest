/**
 * Audit "shadow signal ACCEPT mais pas d'open réel" — diagnostic des blockers
 * en aval du scanner.
 *
 * Question : depuis 06:00 UTC, X signaux ACCEPT (gainers_user_shadow_signals)
 * mais seulement Y positions ouvertes (lisa_positions). Où sont passés les Z autres ?
 *
 * Checks :
 *   1. Quelles symbols ACCEPT n'ont PAS de position ouverte correspondante ?
 *   2. Y a-t-il déjà une position ouverte sur le même symbol (déduplication) ?
 *   3. Le cap max_open_positions des portfolios est-il atteint ?
 *   4. Y a-t-il des decision_log 'position_open_failed' ou 'position_skipped_*' ?
 *   5. Cooldown actif (recent SL même symbol) ?
 *   6. Capital insuffisant ?
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
  console.log(`\n=== AUDIT "ACCEPT mais pas d'open" — ${new Date().toISOString().slice(0,19)} UTC ===`);
  console.log(`Fenêtre : depuis ${since}\n`);

  // 1. Tous les shadow signals ACCEPT du jour
  const { data: accepts, error: errA } = await sb
    .from('gainers_user_shadow_signals')
    .select('symbol, asset_class, decision, created_at, portfolio_id, change_pct_1m, score, path_eff')
    .eq('decision', 'accept')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(500);

  if (errA) { console.error('Erreur DB shadow_signals :', errA); process.exit(1); }

  if (!accepts || accepts.length === 0) {
    console.log('⚠️  AUCUN signal ACCEPT depuis 00:00 UTC.');
    return;
  }

  // Dédup par (portfolio, symbol) — on garde le 1er ACCEPT chronologique
  const uniqueAccepts = new Map<string, any>();
  for (const a of accepts as any[]) {
    const key = `${a.portfolio_id}::${a.symbol}`;
    if (!uniqueAccepts.has(key)) uniqueAccepts.set(key, a);
  }
  console.log(`Signaux ACCEPT total : ${accepts.length} (uniques par portfolio+symbol : ${uniqueAccepts.size})\n`);

  // 2. Positions ouvertes (depuis aujourd'hui)
  const { data: positions } = await sb.from('lisa_positions')
    .select('symbol, portfolio_id, status, entry_timestamp, direction')
    .gte('entry_timestamp', since)
    .order('entry_timestamp', { ascending: false });

  const openedKeys = new Set<string>();
  for (const p of (positions ?? []) as any[]) {
    openedKeys.add(`${p.portfolio_id}::${p.symbol}`);
  }

  // 3. Quels ACCEPT n'ont PAS produit de position ?
  const orphanAccepts: any[] = [];
  for (const [key, a] of uniqueAccepts) {
    if (!openedKeys.has(key)) orphanAccepts.push(a);
  }

  console.log(`─── ACCEPT sans position correspondante (${orphanAccepts.length} / ${uniqueAccepts.size}) ───`);
  for (const a of orphanAccepts.slice(0, 20)) {
    const t = a.created_at.slice(11, 16);
    const ch = (Number(a.change_pct_1m ?? 0) * 100).toFixed(1);
    console.log(`  ${t} UTC  ${a.symbol.padEnd(16)} ${a.asset_class.padEnd(15)} ch=${ch}% score=${Number(a.score ?? 0).toFixed(3)} pathEff=${Number(a.path_eff ?? 0).toFixed(2)}`);
  }
  if (orphanAccepts.length > 20) console.log(`  ... (+${orphanAccepts.length - 20} autres)`);

  // 4. position_open_failed dans decision_log
  const { data: failed } = await sb.from('lisa_decision_log')
    .select('timestamp, summary, payload')
    .eq('kind', 'position_open_failed')
    .gte('timestamp', since)
    .order('timestamp', { ascending: false })
    .limit(50);
  console.log(`\n─── position_open_failed depuis 00:00 UTC : ${failed?.length ?? 0} ───`);
  for (const f of (failed ?? []).slice(0, 10) as any[]) {
    const t = f.timestamp.slice(11, 16);
    const sym = f.payload?.symbol ?? '?';
    const err = (f.payload?.error_message ?? '?').slice(0, 80);
    console.log(`  ${t} UTC  ${sym.padEnd(16)} err=${err}`);
  }

  // 5. position_skipped_* dans decision_log
  const { data: skipped } = await sb.from('lisa_decision_log')
    .select('kind, timestamp, summary, payload')
    .in('kind', ['position_skipped_duplicate_symbol', 'position_skipped_insufficient_cash', 'position_skipped_fallback_price', 'proposal_capped_by_max_positions'])
    .gte('timestamp', since)
    .order('timestamp', { ascending: false })
    .limit(50);
  console.log(`\n─── position_skipped_* + capped_by_max depuis 00:00 UTC : ${skipped?.length ?? 0} ───`);
  const skippedCounts: Record<string, number> = {};
  for (const s of (skipped ?? []) as any[]) {
    skippedCounts[s.kind] = (skippedCounts[s.kind] ?? 0) + 1;
  }
  for (const [k, n] of Object.entries(skippedCounts).sort((a,b) => (b[1] as number) - (a[1] as number))) {
    console.log(`  ${String(n).padStart(4)}  ${k}`);
  }
  if (skipped && skipped.length > 0) {
    console.log('\n  Échantillon récent (5 dernières) :');
    for (const s of (skipped as any[]).slice(0, 5)) {
      const t = s.timestamp.slice(11, 16);
      console.log(`    ${t} UTC  ${s.kind.padEnd(40)} ${(s.summary ?? '').slice(0, 80)}`);
    }
  }

  // 6. État des portfolios autopilot
  console.log(`\n─── État portfolios autopilot ───`);
  const { data: configs, error: ecfg } = await sb.from('lisa_session_configs')
    .select('portfolio_id, capital_usd, risk_constraints, autopilot_enabled, kill_switch_active, autopilot_paused_reason, strategy_mode, profile');
  if (ecfg) console.log('  Erreur :', ecfg.message);
  if (configs) {
    for (const c of configs as any[]) {
      const { count: openOnPortfolio } = await sb.from('lisa_positions')
        .select('*', { count: 'exact', head: true })
        .eq('portfolio_id', c.portfolio_id)
        .eq('status', 'open');
      const cap = Number(c.risk_constraints?.maxOpenPositions ?? c.risk_constraints?.max_open_positions ?? 0);
      const used = openOnPortfolio ?? 0;
      const usedPct = cap > 0 ? (used / cap * 100).toFixed(0) : '?';
      const status = c.kill_switch_active ? '🔴 KILL' :
                     c.autopilot_paused_reason ? `🟡 PAUSED(${c.autopilot_paused_reason})` :
                     c.autopilot_enabled ? '🟢 ACTIVE' : '⚫ OFF';
      const capStatus = (cap > 0 && used >= cap) ? ` ⚠️  CAP ATTEINT` : '';
      console.log(`  ${(c.portfolio_id ?? '?').slice(0, 8)}  capital=$${Number(c.capital_usd ?? 0).toFixed(0)}  profile=${c.profile}  mode=${c.strategy_mode ?? '?'}  ${status}  positions ${used}/${cap || '?'} (${usedPct}%)${capStatus}`);
      // Print full risk_constraints for visibility
      console.log(`     risk_constraints = ${JSON.stringify(c.risk_constraints ?? {})}`);
    }
  }

  // 7. Cooldown actif (positions fermées récemment sur les symbols orphelins)
  const orphanSymbols = new Set(orphanAccepts.map(a => a.symbol));
  if (orphanSymbols.size > 0) {
    const since3h = new Date(Date.now() - 3 * 3600_000).toISOString();
    const { data: recentCloses } = await sb.from('lisa_positions')
      .select('symbol, status, exit_timestamp, close_reason, exit_reason')
      .in('symbol', [...orphanSymbols].slice(0, 30))
      .neq('status', 'open')
      .gte('exit_timestamp', since3h)
      .order('exit_timestamp', { ascending: false });
    console.log(`\n─── Closes récents (3h) sur orphan symbols : ${recentCloses?.length ?? 0} ───`);
    for (const c of (recentCloses ?? []).slice(0, 10) as any[]) {
      const t = c.exit_timestamp.slice(11, 16);
      console.log(`  ${t} UTC  ${c.symbol.padEnd(16)} ${c.status} reason=${c.close_reason ?? c.exit_reason ?? '?'}`);
    }
  }

  // 8. Conclusion
  console.log(`\n─── DIAGNOSTIC ───`);
  const acceptCount = uniqueAccepts.size;
  const orphanCount = orphanAccepts.length;
  const orphanPct = (orphanCount / acceptCount * 100).toFixed(0);
  console.log(`  ${acceptCount} ACCEPT uniques → ${acceptCount - orphanCount} positions ouvertes (${orphanPct}% des ACCEPT non traduits)`);

  const totalSkipped = Object.values(skippedCounts).reduce((s, n) => s + n, 0);
  const totalFailed = failed?.length ?? 0;
  if (totalSkipped + totalFailed >= orphanCount * 0.5) {
    console.log(`  🔴 ${totalSkipped} skipped + ${totalFailed} failed expliquent l'écart`);
    const topSkip = Object.entries(skippedCounts).sort((a,b) => (b[1] as number) - (a[1] as number))[0];
    if (topSkip) console.log(`  Top raison skip : ${topSkip[0]} (${topSkip[1]} hits)`);
  } else {
    console.log(`  🟡 Seulement ${totalSkipped} skipped + ${totalFailed} failed loggués vs ${orphanCount} orphans`);
    console.log(`     → blocker probablement SILENCIEUX (pré-INSERT, non audité)`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
