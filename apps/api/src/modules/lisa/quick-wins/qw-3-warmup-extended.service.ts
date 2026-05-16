import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * QW#3 — Warmup SL asymétrique par classe (s'applique sur FERMETURE, pas entrée).
 *
 * Data SQL 30j (asymétrie) :
 *   asia_equity        : étendre 15→30min coûte -$19/30j (perdrait +$127 TP > -$147 SL)
 *   us_equity_large    : étendre = +$114/30j favorable
 *   us_equity_small_mid: étendre = +$44/30j favorable
 *   eu_equity          : étendre = +$99/30j favorable
 *   crypto_major       : étendre = +$5/30j favorable
 *
 * Décision : asia=15min (statu quo), toutes autres=30min.
 *
 * Service stateless — fournit la fenêtre warmup en minutes pour une classe.
 * Le caller (mechanical-trading.checkStopTarget) compare `(now - entry_at) < warmupMin`
 * et la perte non-catastrophique pour décider de bloquer la fermeture SL.
 */

const ENV_BY_CLASS: Record<string, string> = {
  asia_equity: 'QW3_WARMUP_MIN_ASIA',
  eu_equity: 'QW3_WARMUP_MIN_EU',
  us_equity_large: 'QW3_WARMUP_MIN_US_LARGE',
  us_equity_small_mid: 'QW3_WARMUP_MIN_US_SM',
  crypto_major: 'QW3_WARMUP_MIN_CRYPTO',
};

const DEFAULT_BY_CLASS: Record<string, number> = {
  asia_equity: 15,
  eu_equity: 30,
  us_equity_large: 30,
  us_equity_small_mid: 30,
  crypto_major: 30,
};

@Injectable()
export class Qw3WarmupExtendedService {
  private readonly warmupByClass = new Map<string, number>();

  constructor(private readonly config: ConfigService) {
    for (const [cls, envKey] of Object.entries(ENV_BY_CLASS)) {
      const raw = this.config.get<string>(envKey);
      const parsed = raw != null ? Number.parseInt(raw, 10) : NaN;
      const value = Number.isFinite(parsed) ? parsed : DEFAULT_BY_CLASS[cls];
      this.warmupByClass.set(cls, value);
    }
  }

  /** Fenêtre warmup (minutes) pour une classe. Default 15 si classe inconnue. */
  getWarmupMin(assetClass: string): number {
    return this.warmupByClass.get(assetClass) ?? 15;
  }

  /**
   * Décide si la fermeture SL doit être bloquée par warmup.
   *
   * @param assetClass   classe de l'actif
   * @param ageMin       âge de la position en minutes
   * @param realizedPnlPct  P&L réalisé en pourcentage (-3 % = -0.03)
   * @returns true si fermeture doit être bloquée (position garde open)
   */
  shouldBlockSlClose(assetClass: string, ageMin: number, realizedPnlPct: number): boolean {
    const warmupMin = this.getWarmupMin(assetClass);
    if (ageMin >= warmupMin) return false;
    // Garde-fou catastrophique : ne pas bloquer si la perte est très sévère.
    // Aligné avec le pattern evaluateWarmup existant.
    if (realizedPnlPct <= -0.03) return false;
    return true;
  }
}
