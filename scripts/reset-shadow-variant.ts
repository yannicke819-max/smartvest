/**
 * Reset des colonnes variant_* du shadow A/B (manuel, dry-run par défaut).
 *
 * Contexte (21/05/2026) : avant le fix time-window, simulateVariant calculait
 * la grille d'exits sur les N dernières candles (N≈âge du signal → ~6 min pour
 * un signal frais). Un TP de 20% ne pouvait jamais se déclencher sur 6 candles
 * → grille = pur artefact. Les lignes déjà résolues (variant_exit_at / no_entry)
 * sont donc invalides et figées (écritures terminales).
 *
 * Ce script remet à NULL toutes les colonnes variant_* des signaux ACCEPT
 * déjà tranchés et créés dans la fenêtre de rétention intraday EODHD (5 j par
 * défaut, sinon le re-fetch fenêtré échouera). Le cron runVariantInner les
 * re-sélectionne (variant_exit_at IS NULL AND variant_no_entry IS NULL) et les
 * re-simule avec la fenêtre correcte → grille enfin valide. Idempotent.
 *
 * Usage :
 *   pnpm tsx scripts/reset-shadow-variant.ts                 # dry-run (aucun write)
 *   pnpm tsx scripts/reset-shadow-variant.ts --apply         # exécute le reset
 *   pnpm tsx scripts/reset-shadow-variant.ts --days 5        # fenêtre rétention (défaut 5)
 *
 * Variables d'env requises :
 *   SUPABASE_URL (ou NEXT_PUBLIC_SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY
 */

import { createClient } from '@supabase/supabase-js';

interface Args {
  apply: boolean;
  days: number;
}

function parseArgs(argv: string[]): Args {
  const di = argv.indexOf('--days');
  const days = di >= 0 && argv[di + 1] ? Number(argv[di + 1]) : 5;
  return { apply: argv.includes('--apply'), days };
}

const VARIANT_RESET = {
  variant_entry_price: null,
  variant_entry_offset_min: null,
  variant_no_entry: null,
  variant_exit_price: null,
  variant_exit_at: null,
  variant_exit_reason: null,
  variant_pnl_pct: null,
  variant_slippage_pct: null,
  variant_params: null,
  variant_exit_grid: null,
};

async function main(args: Args): Promise<void> {
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error('ERROR: SUPABASE_URL (ou NEXT_PUBLIC_SUPABASE_URL) et SUPABASE_SERVICE_ROLE_KEY requis.');
    process.exit(1);
  }
  const supabase = createClient(url, key, { auth: { persistSession: false } });

  const floor = new Date(Date.now() - args.days * 86_400_000).toISOString();
  console.log(`[reset-shadow-variant] mode=${args.apply ? 'APPLY' : 'DRY-RUN'} days=${args.days} floor=${floor}`);

  // Rows ACCEPT déjà tranchés (résolus OU no_entry) dans la fenêtre de rétention.
  const matchFilter = (q: ReturnType<typeof supabase.from>) =>
    q
      .eq('decision', 'ACCEPT')
      .gte('created_at', floor)
      .or('variant_exit_at.not.is.null,variant_no_entry.not.is.null');

  const { count, error: cntErr } = await matchFilter(
    supabase.from('gainers_v1_shadow_signals').select('id', { count: 'exact', head: true }),
  );
  if (cntErr) {
    console.error('SELECT count failed:', cntErr.message);
    process.exit(1);
  }
  console.log(`${count ?? 0} signaux variant à réinitialiser (ACCEPT, tranchés, créés ≥ ${floor})`);

  if (!args.apply) {
    console.log('DRY-RUN : aucun write. Relancer avec --apply pour exécuter.');
    return;
  }
  if (!count) {
    console.log('Rien à réinitialiser.');
    return;
  }

  const { error: upErr } = await matchFilter(
    supabase.from('gainers_v1_shadow_signals').update(VARIANT_RESET),
  );
  if (upErr) {
    console.error('UPDATE failed:', upErr.message);
    process.exit(1);
  }
  console.log(`OK : ${count} signaux réinitialisés. Le cron runVariantInner les re-simulera (fenêtre time-window).`);
}

main(parseArgs(process.argv.slice(2))).catch((e) => {
  console.error(e);
  process.exit(1);
});
