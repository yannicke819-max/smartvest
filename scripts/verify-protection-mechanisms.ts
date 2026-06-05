import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  console.log(`\n═══ Vérification mécanismes protection — ${new Date().toISOString().slice(11,19)} UTC ═══\n`);

  // 1. Migration 0193 — colonnes extended_*
  const { error: migErr } = await sb.from('lisa_positions').select('extended_deadline_at, extended_entered_at').limit(1);
  console.log(`1️⃣  Migration 0193 (colonnes extended_*) : ${migErr ? '❌ FAIL : ' + migErr.message : '✅ OK'}`);

  // 2. DANGER_ZONE_LLM — preuve d'activité (decision_log)
  const since24h = new Date(Date.now() - 24 * 3600_000).toISOString();
  const { data: dz } = await sb.from('lisa_decision_log')
    .select('timestamp, kind, summary')
    .in('kind', ['danger_zone_triggered', 'danger_zone_decision_applied'])
    .gte('timestamp', since24h)
    .order('timestamp', { ascending: false })
    .limit(10);
  const dzCount = dz?.length ?? 0;
  console.log(`\n2️⃣  DANGER_ZONE_LLM (PR #614)`);
  if (dzCount > 0) {
    console.log(`   ✅ ACTIF — ${dzCount} events 24h. MECHANICAL_DANGER_ZONE_ENABLED=true en prod.`);
    for (const e of dz!.slice(0, 5)) console.log(`     ${e.timestamp.slice(11,19)} ${e.kind} : ${(e.summary ?? '').slice(0, 80)}`);
  } else {
    console.log(`   ⚠️  Aucun event 24h — secret MECHANICAL_DANGER_ZONE_ENABLED probablement NOT set`);
  }

  // 3. OVERSOLD_EXTENDED — events ou config
  const { data: ext } = await sb.from('lisa_decision_log')
    .select('timestamp, kind, summary')
    .in('kind', ['oversold_extended_entered', 'oversold_extended_closed'])
    .gte('timestamp', since24h)
    .order('timestamp', { ascending: false })
    .limit(10);
  console.log(`\n3️⃣  OVERSOLD_EXTENDED (PR #615+#616)`);
  if ((ext?.length ?? 0) > 0) {
    console.log(`   ✅ A déjà tourné — ${ext!.length} events 24h`);
    for (const e of ext!.slice(0, 5)) console.log(`     ${e.timestamp.slice(11,19)} ${e.kind} : ${(e.summary ?? '').slice(0, 80)}`);
  } else {
    console.log(`   ⚠️  Aucun event 24h — soit secret OVERSOLD_FORCE_CLOSE_ENABLED NOT set,`);
    console.log(`       soit le cron 20:45 UTC n'a pas encore tourné aujourd'hui (NYSE pas fermée).`);
  }

  // 4. Positions oversold actuellement EXTENDED
  const { data: extPos } = await sb.from('lisa_positions')
    .select('symbol, entry_price, extended_deadline_at, extended_entered_at, manual_control')
    .eq('status', 'open')
    .not('extended_deadline_at', 'is', null);
  console.log(`\n4️⃣  Positions actuellement en mode OVERSOLD_EXTENDED : ${extPos?.length ?? 0}`);
  for (const p of extPos ?? []) {
    console.log(`     ${p.symbol.padEnd(14)} entry=$${p.entry_price} deadline=${p.extended_deadline_at?.slice(0,10)} manual=${p.manual_control}`);
  }

  // 5. Positions actuellement avec manual_control=true (par DANGER_ZONE ou user)
  const { data: manPos } = await sb.from('lisa_positions')
    .select('symbol, portfolio_id, entry_price, status, manual_control')
    .eq('status', 'open')
    .eq('manual_control', true);
  console.log(`\n5️⃣  Positions actuellement en MANU (manual_control=true) : ${manPos?.length ?? 0}`);
  for (const p of manPos ?? []) {
    console.log(`     ${p.symbol.padEnd(14)} portfolio=${p.portfolio_id?.slice(0,12)}... entry=$${p.entry_price}`);
  }

  // 6. Check Fly version pour voir si PR #617 deploy
  console.log(`\n6️⃣  Fly deploy status (version endpoint) :`);
  try {
    const res = await fetch('https://smartvest.fly.dev/version', { signal: AbortSignal.timeout(5000) });
    const json: any = await res.json();
    console.log(`     git_sha=${json.git_sha} build_time=${json.build_time}`);
  } catch (e) {
    console.log(`     err: ${String(e).slice(0, 80)}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
