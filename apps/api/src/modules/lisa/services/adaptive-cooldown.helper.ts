/**
 * Adaptive cooldown per symbol — pure helper, no I/O.
 *
 * Calcule un cooldown post-SL personnalisé par symbole basé sur le pattern
 * historique : sur les 30 derniers jours, après chaque SL sur un symbole,
 * quelle est la probabilité qu'une réentrée dans les 60min finisse aussi en SL ?
 *
 * Logique :
 *   re_loss_rate > 0.70 → symbole "death-trap" → cooldown 180 min
 *   re_loss_rate 0.50-0.70 → cooldown 120 min
 *   re_loss_rate ≤ 0.50 → cooldown standard (base, default 60 min)
 *   Sample insuffisant (<3 SL ou <2 réentrées) → base
 */

export interface SymbolTrade {
  symbol: string;
  entry_at: string;       // ISO timestamp
  exit_at: string | null; // ISO timestamp, null si encore open
  status: string;         // 'closed_stop' | 'closed_target' | 'open' | ...
  pnl_usd: number | null;
}

export interface AdaptiveCooldownConfig {
  baseCooldownMin: number;   // default 60
  highCooldownMin: number;   // default 120 (mid-risk symbols)
  trapCooldownMin: number;   // default 180 (death-trap symbols)
  reentryWindowMin: number;  // default 60 (fenêtre considérée comme "réentrée rapide")
  reentryLossRateMid: number;   // default 0.50
  reentryLossRateHigh: number;  // default 0.70
  minSls: number;            // sample minimum (default 3)
  minReentries: number;      // sample minimum réentrées (default 2)
}

export const DEFAULT_ADAPTIVE_COOLDOWN: AdaptiveCooldownConfig = {
  baseCooldownMin: 60,
  highCooldownMin: 120,
  trapCooldownMin: 180,
  reentryWindowMin: 60,
  reentryLossRateMid: 0.50,
  reentryLossRateHigh: 0.70,
  minSls: 3,
  minReentries: 2,
};

export interface SymbolCooldownVerdict {
  symbol: string;
  cooldownMin: number;
  reason: string;
  nSls: number;
  nReentries: number;
  reentryLossRate: number | null;
}

/**
 * Calcule le cooldown adaptatif pour un symbole donné depuis son historique.
 * trades doit être trié chronologiquement (asc).
 */
export function computeSymbolCooldown(
  symbol: string,
  trades: SymbolTrade[],
  cfg: AdaptiveCooldownConfig = DEFAULT_ADAPTIVE_COOLDOWN,
): SymbolCooldownVerdict {
  // 1. Identifie les SLs (closed_stop)
  const sls = trades.filter((t) => t.status === 'closed_stop' && t.exit_at != null);
  if (sls.length < cfg.minSls) {
    return {
      symbol,
      cooldownMin: cfg.baseCooldownMin,
      reason: `insufficient_sls (${sls.length}/${cfg.minSls})`,
      nSls: sls.length,
      nReentries: 0,
      reentryLossRate: null,
    };
  }

  // 2. Pour chaque SL, cherche le prochain trade ouvert dans la fenêtre
  let nReentries = 0;
  let nReentryLosses = 0;
  const windowMs = cfg.reentryWindowMin * 60_000;

  for (const sl of sls) {
    const slExitMs = new Date(sl.exit_at!).getTime();
    // Cherche le prochain entry sur ce symbole dans la fenêtre
    const nextEntry = trades.find((t) => {
      const entryMs = new Date(t.entry_at).getTime();
      return entryMs > slExitMs && entryMs <= slExitMs + windowMs;
    });
    if (!nextEntry) continue;
    nReentries++;
    // Si la réentrée s'est aussi terminée en SL (ou perte), count loss
    if (nextEntry.status === 'closed_stop' || (nextEntry.pnl_usd != null && nextEntry.pnl_usd < 0)) {
      nReentryLosses++;
    }
  }

  if (nReentries < cfg.minReentries) {
    return {
      symbol,
      cooldownMin: cfg.baseCooldownMin,
      reason: `insufficient_reentries (${nReentries}/${cfg.minReentries})`,
      nSls: sls.length,
      nReentries,
      reentryLossRate: null,
    };
  }

  const reentryLossRate = nReentryLosses / nReentries;
  let cooldownMin = cfg.baseCooldownMin;
  let reason: string;
  if (reentryLossRate > cfg.reentryLossRateHigh) {
    cooldownMin = cfg.trapCooldownMin;
    reason = `death_trap_re_loss_${reentryLossRate.toFixed(2)}_above_${cfg.reentryLossRateHigh.toFixed(2)}`;
  } else if (reentryLossRate > cfg.reentryLossRateMid) {
    cooldownMin = cfg.highCooldownMin;
    reason = `mid_risk_re_loss_${reentryLossRate.toFixed(2)}_above_${cfg.reentryLossRateMid.toFixed(2)}`;
  } else {
    reason = `safe_re_loss_${reentryLossRate.toFixed(2)}_below_${cfg.reentryLossRateMid.toFixed(2)}`;
  }

  return {
    symbol,
    cooldownMin,
    reason,
    nSls: sls.length,
    nReentries,
    reentryLossRate,
  };
}

/**
 * Batch : compute cooldowns pour TOUS les symboles d'un dataset.
 * Retourne une Map<symbol, verdict>.
 */
export function computeAllSymbolCooldowns(
  allTrades: SymbolTrade[],
  cfg: AdaptiveCooldownConfig = DEFAULT_ADAPTIVE_COOLDOWN,
): Map<string, SymbolCooldownVerdict> {
  const bySymbol = new Map<string, SymbolTrade[]>();
  for (const t of allTrades) {
    const arr = bySymbol.get(t.symbol) ?? [];
    arr.push(t);
    bySymbol.set(t.symbol, arr);
  }
  const out = new Map<string, SymbolCooldownVerdict>();
  for (const [sym, trades] of bySymbol.entries()) {
    // Trie chronologiquement
    const sorted = [...trades].sort((a, b) => new Date(a.entry_at).getTime() - new Date(b.entry_at).getTime());
    out.set(sym, computeSymbolCooldown(sym, sorted, cfg));
  }
  return out;
}

/**
 * Parse env config.
 */
export function parseAdaptiveCooldownConfig(env: {
  ADAPTIVE_COOLDOWN_ENABLED?: string | undefined;
  ADAPTIVE_COOLDOWN_BASE_MIN?: string | undefined;
  ADAPTIVE_COOLDOWN_HIGH_MIN?: string | undefined;
  ADAPTIVE_COOLDOWN_TRAP_MIN?: string | undefined;
  ADAPTIVE_COOLDOWN_REENTRY_WINDOW_MIN?: string | undefined;
  ADAPTIVE_COOLDOWN_RELOSS_MID?: string | undefined;
  ADAPTIVE_COOLDOWN_RELOSS_HIGH?: string | undefined;
}): { enabled: boolean; cfg: AdaptiveCooldownConfig } {
  const enabled = (env.ADAPTIVE_COOLDOWN_ENABLED ?? 'false').toLowerCase() === 'true';
  const parseInt01 = (raw: string | undefined, def: number, min: number, max: number): number => {
    const n = Number.parseInt(raw ?? '', 10);
    return Number.isFinite(n) && n >= min && n <= max ? n : def;
  };
  const parseFloat01 = (raw: string | undefined, def: number, min: number, max: number): number => {
    const n = Number.parseFloat(raw ?? '');
    return Number.isFinite(n) && n >= min && n <= max ? n : def;
  };
  return {
    enabled,
    cfg: {
      baseCooldownMin: parseInt01(env.ADAPTIVE_COOLDOWN_BASE_MIN, 60, 0, 1440),
      highCooldownMin: parseInt01(env.ADAPTIVE_COOLDOWN_HIGH_MIN, 120, 0, 1440),
      trapCooldownMin: parseInt01(env.ADAPTIVE_COOLDOWN_TRAP_MIN, 180, 0, 1440),
      reentryWindowMin: parseInt01(env.ADAPTIVE_COOLDOWN_REENTRY_WINDOW_MIN, 60, 5, 480),
      reentryLossRateMid: parseFloat01(env.ADAPTIVE_COOLDOWN_RELOSS_MID, 0.50, 0, 1),
      reentryLossRateHigh: parseFloat01(env.ADAPTIVE_COOLDOWN_RELOSS_HIGH, 0.70, 0, 1),
      minSls: 3,
      minReentries: 2,
    },
  };
}
