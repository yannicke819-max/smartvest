/**
 * P8-BR — Backfill script (manuel, dry-run par défaut).
 *
 * Convertit les rows pré-P8-BR où l'autopilot a été désactivé silencieusement
 * par BudgetExceededError (incident 27-28/04) :
 *   - autopilot_enabled = false
 *   - dernier lisa_decision_log.kind = 'autopilot_disabled' avec rationale
 *     citant daily_api_budget_exceeded
 *
 * → vers le nouveau modèle :
 *   - autopilot_enabled = true (rétabli)
 *   - autopilot_paused_reason = 'BUDGET_EXCEEDED'
 *
 * Le cron auto-resume du LisaAutopilotService prendra le relais au prochain
 * cycle (rollover UTC ou bump budget). Idempotent.
 *
 * Usage :
 *   pnpm tsx scripts/backfill-autopilot-paused-reason.ts            # dry-run (aucun write)
 *   pnpm tsx scripts/backfill-autopilot-paused-reason.ts --apply    # exécute les UPDATE
 *
 * Variables d'env requises :
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { createClient } from '@supabase/supabase-js';

interface Args {
  apply: boolean;
}

function parseArgs(argv: string[]): Args {
  return { apply: argv.includes('--apply') };
}

async function main(args: Args): Promise<void> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error('ERROR: SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY requis.');
    process.exit(1);
  }
  const supabase = createClient(url, key, { auth: { persistSession: false } });

  console.log(`[backfill-paused-reason] mode=${args.apply ? 'APPLY' : 'DRY-RUN'}`);

  // 1. Liste des configs avec autopilot_enabled=false
  const { data: configs, error: cfgErr } = await supabase
    .from('lisa_session_configs')
    .select('portfolio_id, user_id, autopilot_enabled, autopilot_paused_reason, daily_cost_budget_usd')
    .eq('autopilot_enabled', false);
  if (cfgErr) {
    console.error('SELECT configs failed:', cfgErr.message);
    process.exit(1);
  }
  if (!configs || configs.length === 0) {
    console.log('Aucune config autopilot_enabled=false trouvée. Rien à backfiller.');
    return;
  }
  console.log(`${configs.length} configs autopilot_enabled=false candidates`);

  let backfilled = 0;
  let skipped = 0;

  for (const cfg of configs) {
    const portfolioId = cfg.portfolio_id as string;

    // Si déjà paused_reason set → skip
    if (cfg.autopilot_paused_reason) {
      console.log(`  ${portfolioId.slice(0, 8)}... already paused (${cfg.autopilot_paused_reason}) — skip`);
      skipped++;
      continue;
    }

    // 2. Cherche le dernier autopilot_disabled avec rationale budget
    const { data: lastLog } = await supabase
      .from('lisa_decision_log')
      .select('kind, rationale, payload, created_at')
      .eq('portfolio_id', portfolioId)
      .eq('kind', 'autopilot_disabled')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!lastLog) {
      console.log(`  ${portfolioId.slice(0, 8)}... no autopilot_disabled log — skip (manual disable)`);
      skipped++;
      continue;
    }

    const rationale = String(lastLog.rationale ?? '');
    const payload = (lastLog.payload as Record<string, unknown>) ?? {};
    const isBudget =
      /budget/i.test(rationale) ||
      payload.reason === 'daily_api_budget_exceeded';

    if (!isBudget) {
      console.log(`  ${portfolioId.slice(0, 8)}... last disable not budget-related — skip`);
      skipped++;
      continue;
    }

    console.log(
      `  ${portfolioId.slice(0, 8)}... CANDIDATE — last budget-disable @${lastLog.created_at}`,
    );

    if (args.apply) {
      const { error: updErr } = await supabase
        .from('lisa_session_configs')
        .update({
          autopilot_enabled: true,
          autopilot_paused_reason: 'BUDGET_EXCEEDED',
        })
        .eq('portfolio_id', portfolioId);
      if (updErr) {
        console.error(`    UPDATE failed: ${updErr.message}`);
        continue;
      }
      console.log(`    ✅ enabled=true + paused_reason=BUDGET_EXCEEDED`);
      backfilled++;
    } else {
      console.log(`    [DRY-RUN] would: UPDATE enabled=true + paused_reason=BUDGET_EXCEEDED`);
      backfilled++;
    }
  }

  console.log(`\nDone. backfilled=${backfilled} skipped=${skipped} (mode=${args.apply ? 'APPLY' : 'DRY-RUN'})`);
}

main(parseArgs(process.argv)).catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
