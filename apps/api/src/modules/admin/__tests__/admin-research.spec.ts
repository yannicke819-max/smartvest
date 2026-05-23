import { AdminResearchController } from '../admin-research.controller';

describe('AdminResearchController helpers', () => {
  describe('scoreBand', () => {
    it('null → "null"', () => expect(AdminResearchController.scoreBand(null)).toBe('null'));
    it('< 40 → "1_lt_40"', () => expect(AdminResearchController.scoreBand(35)).toBe('1_lt_40'));
    it('45 → "2_40_50"', () => expect(AdminResearchController.scoreBand(45)).toBe('2_40_50'));
    it('55 → "3_50_60"', () => expect(AdminResearchController.scoreBand(55)).toBe('3_50_60'));
    it('65 → "4_60_70"', () => expect(AdminResearchController.scoreBand(65)).toBe('4_60_70'));
    it('75 → "5_70_80"', () => expect(AdminResearchController.scoreBand(75)).toBe('5_70_80'));
    it('85 → "6_80+"', () => expect(AdminResearchController.scoreBand(85)).toBe('6_80+'));
  });

  describe('subBand', () => {
    it('null → "null"', () => expect(AdminResearchController.subBand(null)).toBe('null'));
    it('0.2 → low', () => expect(AdminResearchController.subBand(0.2)).toBe('1_low_lt_0.3'));
    it('0.5 → mid', () => expect(AdminResearchController.subBand(0.5)).toBe('2_mid_0.3-0.6'));
    it('0.8 → high', () => expect(AdminResearchController.subBand(0.8)).toBe('3_high_gte_0.6'));
  });

  describe('statsByBand', () => {
    const trades = [
      { realized_pnl_usd: 10, realized_pnl_pct: 1, asset_class: 'us_equity_large' },
      { realized_pnl_usd: -5, realized_pnl_pct: -0.5, asset_class: 'us_equity_large' },
      { realized_pnl_usd: 20, realized_pnl_pct: 2, asset_class: 'asia_equity' },
      { realized_pnl_usd: -3, realized_pnl_pct: -0.3, asset_class: 'asia_equity' },
      { realized_pnl_usd: 5, realized_pnl_pct: 0.5, asset_class: 'asia_equity' },
    ];

    it('aggrège correctement par asset_class', () => {
      const result = AdminResearchController.statsByBand(trades as never, (t) => (t as unknown as { asset_class: string }).asset_class);
      const asia = result.find((r) => r.band === 'asia_equity')!;
      expect(asia.n).toBe(3);
      expect(asia.wr_pct).toBe(67); // 2 winners / 3 = 66.67
      expect(asia.sum_usd).toBe(22);
      const us = result.find((r) => r.band === 'us_equity_large')!;
      expect(us.n).toBe(2);
      expect(us.wr_pct).toBe(50);
    });

    it('tri desc par n', () => {
      const result = AdminResearchController.statsByBand(trades as never, (t) => (t as unknown as { asset_class: string }).asset_class);
      expect(result[0].band).toBe('asia_equity'); // n=3 first
      expect(result[1].band).toBe('us_equity_large'); // n=2
    });
  });
});
