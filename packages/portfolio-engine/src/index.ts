export * from './risk-profile-scorer';

import type { RiskProfileId } from '@smartvest/domain';

export interface AllocationTarget {
  assetClass: 'equity' | 'etf' | 'bond' | 'cash' | 'crypto' | 'commodity';
  targetWeight: number;
  minWeight: number;
  maxWeight: number;
}

export const DEFAULT_TEMPLATES: Record<RiskProfileId, AllocationTarget[]> = {
  prudent: [
    { assetClass: 'bond', targetWeight: 0.6, minWeight: 0.5, maxWeight: 0.7 },
    { assetClass: 'etf', targetWeight: 0.2, minWeight: 0.1, maxWeight: 0.3 },
    { assetClass: 'cash', targetWeight: 0.2, minWeight: 0.1, maxWeight: 0.3 },
  ],
  equilibre: [
    { assetClass: 'etf', targetWeight: 0.5, minWeight: 0.4, maxWeight: 0.6 },
    { assetClass: 'bond', targetWeight: 0.35, minWeight: 0.25, maxWeight: 0.45 },
    { assetClass: 'cash', targetWeight: 0.15, minWeight: 0.05, maxWeight: 0.25 },
  ],
  dynamique: [
    { assetClass: 'etf', targetWeight: 0.7, minWeight: 0.6, maxWeight: 0.8 },
    { assetClass: 'bond', targetWeight: 0.2, minWeight: 0.1, maxWeight: 0.3 },
    { assetClass: 'cash', targetWeight: 0.1, minWeight: 0, maxWeight: 0.2 },
  ],
  offensif: [
    { assetClass: 'equity', targetWeight: 0.6, minWeight: 0.5, maxWeight: 0.7 },
    { assetClass: 'etf', targetWeight: 0.25, minWeight: 0.15, maxWeight: 0.35 },
    { assetClass: 'crypto', targetWeight: 0.1, minWeight: 0, maxWeight: 0.2 },
    { assetClass: 'cash', targetWeight: 0.05, minWeight: 0, maxWeight: 0.15 },
  ],
  sur_mesure: [],
};

export interface DriftReport {
  assetClass: AllocationTarget['assetClass'];
  current: number;
  target: number;
  drift: number;
  needsRebalance: boolean;
}

export function computeDrift(
  template: AllocationTarget[],
  current: Record<string, number>,
  thresholdPct = 5,
): DriftReport[] {
  return template.map((t) => {
    const cur = current[t.assetClass] ?? 0;
    const drift = (cur - t.targetWeight) * 100;
    return {
      assetClass: t.assetClass,
      current: cur,
      target: t.targetWeight,
      drift,
      needsRebalance: Math.abs(drift) > thresholdPct,
    };
  });
}
