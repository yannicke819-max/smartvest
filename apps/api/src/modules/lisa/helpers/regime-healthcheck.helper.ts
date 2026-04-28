/**
 * P2-A — Healthcheck des inputs macro qui alimentent la classification régime.
 *
 * Si ≥ 2 indicateurs sur {vix, dxy, us10y, us2y, realized1hPct} sont null
 * (cascade complètement échouée + cache last-known >24h périmé) ou en
 * `dataQuality.fallback` (valeur hardcoded de dernier recours), Lisa
 * raisonne sur une photo majoritairement statique → le verdict
 * HORS_TRAJECTOIRE qui en sort n'est pas fiable.
 *
 * Pure function, testable sans I/O. Le caller décide quoi faire du verdict
 * (log WARN structuré, métrique, alerte Sentry…).
 *
 * Note : `realized1hPct` ici remplace `spx_vol_realized` du backlog —
 * notre seul réalisé disponible est BTC 1m via Binance klines (cf.
 * computeRealizedVolPct). Mêmes propriétés (cross-asset, intraday) côté
 * détection VOL_SPIKE, donc équivalent fonctionnel pour le healthcheck.
 */

export interface RegimeHealthInputs {
  vix: number | null;
  dxy: number | null;
  us10y: number | null;
  us2y: number | null;
  realized1hPct: number | null;
}

export interface RegimeHealthDataQuality {
  /** Indicateurs tombés au fallback hardcoded (toutes sources échouées
   *  + last-known cache >24h périmé). */
  fallback: string[];
}

export interface RegimeHealthVerdict {
  healthy: boolean;
  /** Liste « name=cause » des indicateurs en panne. Empty si healthy. */
  degraded: string[];
  /** True dès que `degraded.length >= 2` — déclenche le WARN. */
  shouldWarn: boolean;
}

const TRACKED = ['vix', 'dxy', 'us10y', 'us2y', 'realized1hPct'] as const;

export function assertRegimeInputsHealthy(
  inputs: RegimeHealthInputs,
  dataQuality: RegimeHealthDataQuality,
): RegimeHealthVerdict {
  const degraded: string[] = [];

  for (const key of TRACKED) {
    const value = inputs[key];
    const isNull = value === null || !Number.isFinite(value);
    // `realized1hPct` n'est pas tracké dans dataQuality (calculé en local
    // depuis Binance klines, pas via fetchCascade). Pour les autres on
    // considère fallback = stale > 24h.
    const isFallback =
      key !== 'realized1hPct' && dataQuality.fallback.includes(key);

    if (isNull) {
      degraded.push(`${key}=null`);
    } else if (isFallback) {
      degraded.push(`${key}=fallback>24h`);
    }
  }

  return {
    healthy: degraded.length === 0,
    degraded,
    shouldWarn: degraded.length >= 2,
  };
}
