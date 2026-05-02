/**
 * ADR-007 PR #207a — TargetDerivationService tests.
 */

import { TargetDerivationService } from '../target-modes/target-derivation.service';
import { TargetMode } from '../target-modes/types';

describe('TargetDerivationService', () => {
  const svc = new TargetDerivationService();

  describe('compounding conversions', () => {
    it('annualToMonthly: 12% annuel ≈ 0.949% mensuel', () => {
      // (1.12)^(1/12) - 1 = 0.00949...
      expect(svc.annualToMonthly(0.12)).toBeCloseTo(0.00949, 4);
    });

    it('annualToDaily: 12% annuel ≈ 0.0449% daily', () => {
      // (1.12)^(1/252) - 1 = 0.000449...
      expect(svc.annualToDaily(0.12)).toBeCloseTo(0.000449, 5);
    });

    it('monthlyToDaily: 5% mensuel ≈ 0.232% daily (21j)', () => {
      // (1.05)^(1/21) - 1 = 0.002326...
      expect(svc.monthlyToDaily(0.05)).toBeCloseTo(0.002326, 5);
    });

    it('round-trip daily → monthly → daily (consistent)', () => {
      const daily = 0.001;
      const monthly = svc.dailyToMonthly(daily);
      const dailyBack = svc.monthlyToDaily(monthly);
      expect(dailyBack).toBeCloseTo(daily, 8);
    });

    it('round-trip daily → annual → daily', () => {
      const daily = 0.0005;
      const annual = svc.dailyToAnnual(daily);
      const dailyBack = svc.annualToDaily(annual);
      expect(dailyBack).toBeCloseTo(daily, 8);
    });

    it('annual 30% → monthly ~2.21%', () => {
      expect(svc.annualToMonthly(0.30)).toBeCloseTo(0.02212, 4);
    });

    it('annual 100% → daily ~0.275%', () => {
      // (2)^(1/252) - 1 = 0.002754...
      expect(svc.annualToDaily(1.0)).toBeCloseTo(0.002754, 5);
    });
  });

  describe('derive() — ABSOLUTE_USD mode', () => {
    it('targetValue $100, equity $10000 → daily 1%', () => {
      const r = svc.derive(
        { mode: TargetMode.ABSOLUTE_USD, targetValue: 100 },
        10_000,
      );
      expect(r.daily.usd).toBe(100);
      expect(r.daily.pct).toBe(0.01);
      expect(r.monthly.usd).toBeCloseTo(10_000 * (Math.pow(1.01, 21) - 1), 1);
    });

    it('returns null pcts if equity = 0', () => {
      const r = svc.derive({ mode: TargetMode.ABSOLUTE_USD, targetValue: 100 }, 0);
      expect(r.daily.pct).toBeNull();
      expect(r.daily.usd).toBeNull();
    });
  });

  describe('derive() — PCT_OF_EQUITY mode', () => {
    it('targetValue 0.5%, equity $10000 → daily $50', () => {
      const r = svc.derive(
        { mode: TargetMode.PCT_OF_EQUITY, targetValue: 0.005 },
        10_000,
      );
      expect(r.daily.pct).toBe(0.005);
      expect(r.daily.usd).toBe(50);
    });
  });

  describe('derive() — MONTHLY_COMPOUND mode', () => {
    it('5% mensuel → daily ~0.232%, annual ~79.6%', () => {
      const r = svc.derive(
        { mode: TargetMode.MONTHLY_COMPOUND, monthlyTargetPct: 0.05 },
        10_000,
      );
      expect(r.monthly.pct).toBe(0.05);
      expect(r.daily.pct).toBeCloseTo(0.002326, 5);
      // annual ≈ (1.05)^12 - 1 = 0.7959...
      expect(r.annual.pct).toBeCloseTo(0.7959, 3);
      expect(r.daily.usd).toBeCloseTo(23.26, 1);
    });
  });

  describe('derive() — ANNUAL_COMPOUND mode', () => {
    it('30% annuel → daily ~0.104%, monthly ~2.21%', () => {
      const r = svc.derive(
        { mode: TargetMode.ANNUAL_COMPOUND, annualTargetPct: 0.30 },
        10_000,
      );
      expect(r.annual.pct).toBe(0.30);
      expect(r.monthly.pct).toBeCloseTo(0.02212, 4);
      expect(r.daily.pct).toBeCloseTo(0.001041, 5);
      expect(r.daily.usd).toBeCloseTo(10.41, 1);
    });
  });

  describe('computeDerivedDailyPct()', () => {
    it('returns null for ABSOLUTE_USD (depends on equity)', () => {
      expect(
        svc.computeDerivedDailyPct({ mode: TargetMode.ABSOLUTE_USD, targetValue: 100 }),
      ).toBeNull();
    });

    it('returns target_value for PCT_OF_EQUITY', () => {
      expect(
        svc.computeDerivedDailyPct({ mode: TargetMode.PCT_OF_EQUITY, targetValue: 0.005 }),
      ).toBe(0.005);
    });

    it('returns derived daily for MONTHLY_COMPOUND', () => {
      const result = svc.computeDerivedDailyPct({
        mode: TargetMode.MONTHLY_COMPOUND,
        monthlyTargetPct: 0.05,
      });
      expect(result).toBeCloseTo(0.002326, 5);
    });

    it('returns derived daily for ANNUAL_COMPOUND', () => {
      const result = svc.computeDerivedDailyPct({
        mode: TargetMode.ANNUAL_COMPOUND,
        annualTargetPct: 0.30,
      });
      expect(result).toBeCloseTo(0.001041, 5);
    });
  });
});
