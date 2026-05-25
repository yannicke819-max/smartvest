import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const sb = createClient(url, key);

async function main() {
  const { data: portfolios, error } = await sb
    .from('portfolios')
    .select('id, name, created_at')
    .order('created_at', { ascending: false });
  if (error) { console.error(error); process.exit(1); }

  console.log(`\n=== ${portfolios?.length ?? 0} portfolios ===\n`);

  const { data: configs } = await sb
    .from('lisa_session_configs')
    .select('portfolio_id, strategy_mode, autopilot_enabled, kill_switch_active, autopilot_paused_reason, capital_usd, profile, capital_discipline_mode')
    .in('portfolio_id', (portfolios ?? []).map((p) => p.id));

  const cfgByPid = new Map((configs ?? []).map((c) => [c.portfolio_id, c]));

  for (const p of portfolios ?? []) {
    const c = cfgByPid.get(p.id);
    console.log(`✓  ${(p.name ?? '(unnamed)').padEnd(35)} (${p.id.slice(0, 8)})`);
    if (!c) {
      console.log(`    ⚠️  NO lisa_session_config row`);
      continue;
    }
    console.log(`    strategy_mode      = ${c.strategy_mode ?? '(null)'}`);
    console.log(`    autopilot_enabled  = ${c.autopilot_enabled}`);
    console.log(`    autopilot_paused   = ${c.autopilot_paused_reason ?? '(no)'}`);
    console.log(`    kill_switch_active = ${c.kill_switch_active}`);
    console.log(`    capital_usd        = ${c.capital_usd}`);
    console.log(`    profile            = ${c.profile}`);
    console.log(`    discipline_mode    = ${c.capital_discipline_mode}`);
    console.log('');
  }

  // Scanner predicate : strategy_mode='gainers' AND autopilot_enabled=true
  const active = (configs ?? []).filter((c) =>
    c.strategy_mode === 'gainers' && c.autopilot_enabled === true,
  );
  console.log(`=== Scanner predicate match (strategy_mode='gainers' AND autopilot=true) : ${active.length} ===`);
  for (const a of active) console.log(`  ✓ ${a.portfolio_id}`);

  // Env fallback
  console.log(`\n=== Env fallback ===`);
  console.log(`STRATEGY_MODE = ${process.env.STRATEGY_MODE ?? '(unset)'}`);
}

main();
