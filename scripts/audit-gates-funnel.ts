/**
 * FUNNEL des 15 gates du scanner gainers — où le pipeline rétrécit-il le plus ?
 *
 * Chaque ligne de gainers_user_shadow_signals = 1 candidat avec décision finale.
 * Le scanner kill chaque candidat à la PREMIÈRE gate qui rejette donc :
 *   nb killed at Gate N = nb rejected with reject_<gate_N>
 *
 * Funnel reconstruit dans l'ORDRE EXACT du code top-gainers-scanner.service.ts :
 *
 *   npx tsx scripts/audit-gates-funnel.ts
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

// Ordre exact d'évaluation dans top-gainers-scanner.service.ts (vérif par grep "recordShadowDecision")
const GATE_ORDER: Array<{ n: number; key: string; label: string; env?: string }> = [
  { n: 1, key: 'reject_signal_stale', label: 'Signal stale (>max_age)', env: 'GAINERS_MAX_SIGNAL_AGE_SEC' },
  { n: 2, key: 'reject_volatile_regime', label: 'Volatile regime (ATR%)', env: 'GAINERS_MAX_ATR_RATIO_PCT' },
  { n: 3, key: 'reject_stagflation_hedge_guard', label: 'Stagflation hedge ticker' },
  { n: 4, key: 'reject_overextended', label: 'Overextended (changePct ≥ max)', env: 'GAINERS_MAX_CHANGE_PCT_LONG_<CLASS>' },
  { n: 5, key: 'reject_dead_zone', label: 'Dead zone (heures inactives)' },
  { n: 6, key: 'reject_hour_blacklisted', label: 'Hour blacklisted (per-class)', env: 'GAINERS_HOUR_BLACKLIST_<CLASS>_UTC' },
  { n: 7, key: 'reject_hour_not_whitelisted', label: 'Hour not whitelisted' },
  { n: 8, key: 'reject_market_closed', label: 'Market closed (session)' },
  { n: 9, key: 'reject_cooldown', label: 'Cooldown (post-trade)' },
  { n: 10, key: 'reject_post_sl_cooldown', label: 'Post-SL cooldown', env: 'GAINERS_POST_SL_COOLDOWN_MIN' },
  { n: 11, key: 'reject_reentry_downtrend', label: 'Re-entry downtrend' },
  { n: 12, key: 'reject_liquidity', label: 'Liquidity (dollar volume)' },
  { n: 13, key: 'reject_earnings_imminent', label: 'Earnings imminent', env: 'GAINERS_EARNINGS_FILTER_DAYS' },
  { n: 14, key: 'reject_post_news_fresh_strong_pos', label: 'News fresh strong pos' },
  { n: 15, key: 'reject_opening_buffer', label: 'Opening buffer (early in session)' },
  { n: 16, key: 'reject_persistence', label: 'Persistence < min', env: 'gainers_min_persistence_score' },
  { n: 17, key: 'reject_other', label: 'Other (catch-all)' },
];

function pad(s: unknown, n: number) { return String(s ?? '').padEnd(n).slice(0, n); }

async function main() {
  const since = new Date(Date.now() - 72 * 3600_000).toISOString();

  console.log('═══════════════════════════════════════════════════════════════════════════════');
  console.log(' FUNNEL 15+ GATES SCANNER GAINERS — 72h US/EU/Crypto');
  console.log('═══════════════════════════════════════════════════════════════════════════════\n');

  // Pour chaque asset class : compter par decision
  const classes = ['us_equity_large', 'us_equity_small_mid', 'eu_equity', 'crypto_major', 'crypto_alt'];
  const allCounts: Map<string, Map<string, number>> = new Map();

  for (const cls of classes) {
    const { data } = await sb
      .from('gainers_user_shadow_signals')
      .select('decision')
      .eq('asset_class', cls)
      .gte('created_at', since)
      .limit(10000);
    const counts = new Map<string, number>();
    for (const r of data ?? []) {
      const d = String(r.decision);
      counts.set(d, (counts.get(d) ?? 0) + 1);
    }
    allCounts.set(cls, counts);
  }

  // Funnel par asset class
  for (const cls of classes) {
    const counts = allCounts.get(cls)!;
    const total = [...counts.values()].reduce((s, n) => s + n, 0);
    if (total === 0) continue;
    const accept = counts.get('accept') ?? 0;

    console.log(`\n┌─ ${cls.toUpperCase()} ─ Total candidats évalués 72h : ${total}`);
    console.log(`│  ${pad('Gate#', 6)} ${pad('Reject reason', 38)} ${pad('Killed', 8)} ${pad('% du total', 10)} ${pad('Surviving', 10)}  Env tunable`);
    console.log(`│  ${'─'.repeat(95)}`);

    let surviving = total;
    for (const g of GATE_ORDER) {
      const killed = counts.get(g.key) ?? 0;
      const pctTotal = total > 0 ? ((killed / total) * 100).toFixed(1) + '%' : '–';
      surviving -= killed;
      const env = g.env ?? '—';
      const indicator = killed > 0 ? (killed > 20 ? '🔴' : killed > 5 ? '🟡' : '🟢') : '⚪';
      console.log(`│  ${pad(`G${g.n}`, 6)} ${pad(`${indicator} ${g.label}`, 38)} ${pad(killed, 8)} ${pad(pctTotal, 10)} ${pad(surviving, 10)}  ${env}`);
    }
    console.log(`│  ${pad('END', 6)} ${pad('✅ ACCEPT (passe toutes gates)', 38)} ${pad(accept, 8)} ${pad(((accept / total) * 100).toFixed(1) + '%', 10)}`);
    console.log(`│`);
    console.log(`│  TOP 3 gates qui tuent le plus :`);
    const sortedByKill = GATE_ORDER
      .map(g => ({ ...g, killed: counts.get(g.key) ?? 0 }))
      .filter(g => g.killed > 0)
      .sort((a, b) => b.killed - a.killed)
      .slice(0, 3);
    for (const g of sortedByKill) {
      const env = g.env ? ` (env: ${g.env})` : '';
      console.log(`│    G${g.n} ${g.label} : ${g.killed} kills${env}`);
    }
    console.log(`└─`);
  }

  console.log('\n═══════════════════════════════════════════════════════════════════════════════\n');
}

main().catch(e => { console.error(e); process.exit(1); });
