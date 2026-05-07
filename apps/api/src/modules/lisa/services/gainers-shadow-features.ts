/**
 * PR #281 — Pure helper : convertit une row de `gainers_user_shadow_signals`
 * (avec `sim_results.baseline_60m`) en TradeOutcome pour le training pWin.
 *
 * Extracted as pure function pour testabilité (PersistenceProbabilityService.
 * fetchShadowTrainingData est private + branché sur Supabase, donc lourd à
 * mocker. Cette fonction reçoit la row déjà désérialisée).
 *
 * Lopez de Prado (Advances in Financial ML, ch.4) : pour étendre un sample
 * de paper_trades avec des données simulées, utiliser une feature
 * `is_simulated` + interaction terms `is_sim_x_<gate>` permet au modèle
 * d'apprendre où le biais simulator s'applique, plutôt qu'imposer un poids
 * uniforme via hardcoded `shadow_weight=0.5`.
 */

export const SIM_FEATURE_NAMES = [
  'is_simulated',
  'is_sim_x_reject_path_eff',
  'is_sim_x_reject_persistence',
  'is_sim_x_reject_cooldown',
  'is_sim_x_reject_no_tf_data',
] as const;

export interface ShadowRowForTraining {
  decision: string;
  persistence_count: string | null;
  persistence_score: number | null;
  path_eff: number | null;
  change_pct_1m: number | null;
  sim_results: {
    baseline_60m?: {
      outcome?: string;
      pnl_pct?: number | null;
    };
  } | null;
}

export interface ShadowTrainingExample {
  persistenceCount: string;
  outcomeLabel: 0 | 1;
  pnlPct: number;
  features: Record<string, number>;
}

/**
 * Convertit une row shadow en TradeOutcome de training.
 *
 * Returns `null` si la row n'est pas exploitable (sim non terminée,
 * NO_DATA, decision='accept', baseline_60m absent).
 *
 * @param featureNames - liste complète des features attendues par le model
 *                       (REAL + SIM). On initialise toutes à 0 puis on set
 *                       celles qu'on connait.
 */
export function shadowRowToTrainingExample(
  row: ShadowRowForTraining,
  featureNames: readonly string[],
): ShadowTrainingExample | null {
  // accept rows = doublonnent paper_trades (vrais opens) → exclure
  if (row.decision === 'accept') return null;

  const sim = row.sim_results;
  if (!sim || !sim.baseline_60m) return null;
  const baseline = sim.baseline_60m;
  const pnlPctRaw = baseline.pnl_pct;
  if (typeof pnlPctRaw !== 'number' || !Number.isFinite(pnlPctRaw)) return null;
  if (baseline.outcome === 'NO_DATA' || baseline.outcome == null) return null;

  const persCount = String(row.persistence_count ?? '0/6');
  const persScore = Number(row.persistence_score ?? 0);
  const pathEff = Number(row.path_eff ?? 0);
  const changePct = Number(row.change_pct_1m ?? 0);

  const features: Record<string, number> = {};
  for (const f of featureNames) features[f] = 0;

  // Real features : best-effort depuis le snapshot scanner
  // (volRatio/rsi/closeToHigh non capturés au shadow — on laisse 0/50).
  const m = persCount.match(/^(\d+)\/(\d+)$/);
  if (m) {
    const num = parseInt(m[1], 10);
    const den = parseInt(m[2], 10);
    if (den > 0) features.persistenceCount = num / den;
  } else if (Number.isFinite(persScore)) {
    features.persistenceCount = persScore;
  }
  features.changePct = changePct;
  features.rsi = 50;            // neutral default — pas calculé live au shadow
  features.closeToHigh = 0;
  features.volRatio = 0;
  // pathEff stocké en colonne dédiée mais pas dans FEATURE_NAMES réels
  // (le scanner ne le passe pas en feature au moment du predict). Si on
  // l'ajoute plus tard à REAL_FEATURE_NAMES, la valeur est ici prête.
  if (featureNames.includes('pathEff')) {
    features.pathEff = pathEff;
  }

  // Sim features : is_simulated=1 + one-hot interaction par gate
  features.is_simulated = 1;
  switch (row.decision) {
    case 'reject_path_eff':
      features.is_sim_x_reject_path_eff = 1;
      break;
    case 'reject_persistence':
      features.is_sim_x_reject_persistence = 1;
      break;
    case 'reject_cooldown':
    case 'reject_post_sl_cooldown':
      features.is_sim_x_reject_cooldown = 1;
      break;
    case 'reject_no_tf_data':
      features.is_sim_x_reject_no_tf_data = 1;
      break;
    // reject_p_win, reject_budget_cap, reject_other → only is_simulated set,
    // pas d'interaction term (signal noisy ou rare, model verra is_simulated=1
    // sans gate-specific information).
  }

  return {
    persistenceCount: persCount,
    outcomeLabel: pnlPctRaw > 0 ? 1 : 0,
    pnlPct: pnlPctRaw * 100, // sim_pnl_pct est fraction (0.02), pnlPct pipeline est %
    features,
  };
}
