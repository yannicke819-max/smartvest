import { Injectable } from '@nestjs/common';
import { ValuationService } from '../valuation/valuation.service';
import Decimal from 'decimal.js';

Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_EVEN });

export type AlertSeverity = 'info' | 'warning' | 'critical';
export type AlertRule =
  | 'missing_quote'
  | 'high_concentration'
  | 'crypto_overweight'
  | 'allocation_drift'
  | 'large_daily_move';

export interface PortfolioAlert {
  ruleId: AlertRule;
  severity: AlertSeverity;
  title: string;
  description: string;
  affectedTicker?: string;
  value?: string;
  threshold?: string;
  detectedAt: string;
}

const CONCENTRATION_THRESHOLD = 0.35; // single position >35% of portfolio
const CRYPTO_THRESHOLD = 0.20;        // crypto >20%
const DRIFT_THRESHOLD = 0.15;         // class drifted >15 percentage points
const LARGE_MOVE_THRESHOLD = 0.05;    // daily move >5%

const PRUDENT_TARGETS: Record<string, number> = { bond: 0.60, etf: 0.25, cash: 0.10, equity: 0.05 };
const EQUILIBRE_TARGETS: Record<string, number> = { etf: 0.50, bond: 0.30, equity: 0.15, cash: 0.05 };
const DYNAMIQUE_TARGETS: Record<string, number> = { etf: 0.60, equity: 0.25, bond: 0.10, cash: 0.05 };
const OFFENSIF_TARGETS: Record<string, number> = { etf: 0.55, equity: 0.35, crypto: 0.07, cash: 0.03 };

const TARGET_BY_PROFILE: Record<string, Record<string, number>> = {
  prudent: PRUDENT_TARGETS,
  equilibre: EQUILIBRE_TARGETS,
  dynamique: DYNAMIQUE_TARGETS,
  offensif: OFFENSIF_TARGETS,
  sur_mesure: EQUILIBRE_TARGETS,
};

@Injectable()
export class AlertsService {
  constructor(private readonly valuation: ValuationService) {}

  async getAlerts(portfolioId: string, riskProfile = 'equilibre'): Promise<PortfolioAlert[]> {
    const val = await this.valuation.getPortfolioValuation(portfolioId);
    const alerts: PortfolioAlert[] = [];
    const now = new Date().toISOString();

    if (val.positions.length === 0) return alerts;

    const totalValue = new Decimal(val.totalMarketValue);

    // Rule: missing_quote — position with no current price data
    for (const pos of val.positions) {
      if (!pos.currentPrice) {
        alerts.push({
          ruleId: 'missing_quote',
          severity: 'warning',
          title: `Cours manquant — ${pos.ticker}`,
          description: `Aucune cotation disponible pour ${pos.ticker}. La valorisation est estimée au coût d'achat.`,
          affectedTicker: pos.ticker,
          detectedAt: now,
        });
      }
    }

    // Rule: high_concentration — single position >35%
    for (const pos of val.positions) {
      if (!totalValue.isZero()) {
        const weight = new Decimal(pos.marketValue).div(totalValue);
        if (weight.gt(CONCENTRATION_THRESHOLD)) {
          alerts.push({
            ruleId: 'high_concentration',
            severity: weight.gt(0.5) ? 'critical' : 'warning',
            title: `Concentration élevée — ${pos.ticker}`,
            description: `${pos.ticker} représente ${weight.mul(100).toFixed(1)}% de votre portefeuille. Une diversification est recommandée.`,
            affectedTicker: pos.ticker,
            value: weight.mul(100).toFixed(1),
            threshold: String(CONCENTRATION_THRESHOLD * 100),
            detectedAt: now,
          });
        }
      }
    }

    // Rule: crypto_overweight
    const cryptoValue = val.positions
      .filter((p) => p.assetClass === 'crypto')
      .reduce((s, p) => s.plus(new Decimal(p.marketValue)), new Decimal(0));

    if (!totalValue.isZero() && cryptoValue.div(totalValue).gt(CRYPTO_THRESHOLD)) {
      const cryptoWeight = cryptoValue.div(totalValue);
      alerts.push({
        ruleId: 'crypto_overweight',
        severity: 'warning',
        title: 'Surexposition crypto',
        description: `Les actifs crypto représentent ${cryptoWeight.mul(100).toFixed(1)}% du portefeuille, au-dessus du seuil de ${CRYPTO_THRESHOLD * 100}%.`,
        value: cryptoWeight.mul(100).toFixed(1),
        threshold: String(CRYPTO_THRESHOLD * 100),
        detectedAt: now,
      });
    }

    // Rule: allocation_drift
    const targets = TARGET_BY_PROFILE[riskProfile] ?? TARGET_BY_PROFILE['equilibre'];
    const currentByClass: Record<string, Decimal> = {};
    for (const pos of val.positions) {
      currentByClass[pos.assetClass] = (currentByClass[pos.assetClass] ?? new Decimal(0)).plus(
        new Decimal(pos.marketValue),
      );
    }

    for (const [cls, target] of Object.entries(targets)) {
      const current = totalValue.isZero()
        ? new Decimal(0)
        : (currentByClass[cls] ?? new Decimal(0)).div(totalValue);
      const drift = current.minus(target).abs();
      if (drift.gt(DRIFT_THRESHOLD)) {
        alerts.push({
          ruleId: 'allocation_drift',
          severity: 'info',
          title: `Dérive d'allocation — ${cls}`,
          description: `La classe ${cls} est à ${current.mul(100).toFixed(1)}% (cible: ${(target * 100).toFixed(1)}%). Dérive: ${drift.mul(100).toFixed(1)} points.`,
          value: current.mul(100).toFixed(1),
          threshold: String((target * 100).toFixed(1)),
          detectedAt: now,
        });
      }
    }

    // Rule: large_daily_move
    for (const pos of val.positions) {
      if (pos.changePercent) {
        const changePct = new Decimal(pos.changePercent).abs();
        if (changePct.gt(LARGE_MOVE_THRESHOLD * 100)) {
          const isNegative = new Decimal(pos.changePercent).lt(0);
          alerts.push({
            ruleId: 'large_daily_move',
            severity: isNegative ? 'warning' : 'info',
            title: `Mouvement journalier — ${pos.ticker}`,
            description: `${pos.ticker} a ${isNegative ? 'baissé' : 'progressé'} de ${changePct.toFixed(2)}% aujourd'hui.`,
            affectedTicker: pos.ticker,
            value: pos.changePercent,
            threshold: String(LARGE_MOVE_THRESHOLD * 100),
            detectedAt: now,
          });
        }
      }
    }

    // Sort: critical > warning > info, then by detected time
    const severityOrder: Record<AlertSeverity, number> = { critical: 0, warning: 1, info: 2 };
    return alerts.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);
  }
}
