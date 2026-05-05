/**
 * PR Hardcodes-fix — tests que le scanner Gainers respecte la config
 * lisa_session_configs (gainers_max_open_positions, gainers_max_per_cycle,
 * gainers_position_pct, gainers_cash_reserve_pct, capital_simulation,
 * gainers_cooldown_minutes).
 *
 * Tests logiques purs : on simule la résolution des params dérivés de
 * cfgRow + les bornes (clamp, fallback).
 */

interface CfgRow {
  capital_simulation?: number | string | null;
  gainers_max_open_positions?: number | null;
  gainers_max_per_cycle?: number | null;
  gainers_position_pct?: number | string | null;
  gainers_cash_reserve_pct?: number | string | null;
  gainers_cooldown_minutes?: number | null;
}

const FALLBACK = {
  capital: 10000,
  maxOpen: 5,
  maxPerCycle: 3,
  positionPct: 20,
  cashReservePct: 10,
  cooldownMin: 30,
};

function resolveConfig(cfgRow: CfgRow | null | undefined) {
  const capitalUsd = cfgRow?.capital_simulation != null
    ? Math.max(100, Number(cfgRow.capital_simulation))
    : FALLBACK.capital;
  const maxOpen = cfgRow?.gainers_max_open_positions != null
    ? Math.max(1, Math.min(20, Number(cfgRow.gainers_max_open_positions)))
    : FALLBACK.maxOpen;
  const maxPerCycle = cfgRow?.gainers_max_per_cycle != null
    ? Math.max(1, Math.min(10, Number(cfgRow.gainers_max_per_cycle)))
    : FALLBACK.maxPerCycle;
  const positionPct = cfgRow?.gainers_position_pct != null
    ? Math.max(1, Math.min(100, Number(cfgRow.gainers_position_pct)))
    : FALLBACK.positionPct;
  const cashReservePct = cfgRow?.gainers_cash_reserve_pct != null
    ? Math.max(0, Math.min(50, Number(cfgRow.gainers_cash_reserve_pct)))
    : FALLBACK.cashReservePct;
  const cooldownMinutes = cfgRow?.gainers_cooldown_minutes != null
    ? Math.max(0, Math.min(240, Number(cfgRow.gainers_cooldown_minutes)))
    : FALLBACK.cooldownMin;
  const positionNotionalUsd = capitalUsd * (positionPct / 100);

  return {
    capitalUsd,
    maxOpen,
    maxPerCycle,
    positionPct,
    cashReservePct,
    cooldownMinutes,
    positionNotionalUsd,
  };
}

describe('TopGainersScannerService — scanPortfolio config-driven', () => {
  describe('Capital + sizing', () => {
    it('applique config UI : $50k capital × 25% = $12.5k notional', () => {
      const c = resolveConfig({ capital_simulation: 50000, gainers_position_pct: 25 });
      expect(c.capitalUsd).toBe(50000);
      expect(c.positionPct).toBe(25);
      expect(c.positionNotionalUsd).toBe(12500);
    });

    it('fallback $10k quand capital_simulation null', () => {
      const c = resolveConfig({ capital_simulation: null });
      expect(c.capitalUsd).toBe(10000);
      expect(c.positionNotionalUsd).toBe(2000); // 20% × $10k
    });

    it('clamp capital min $100 (anti zero division)', () => {
      const c = resolveConfig({ capital_simulation: 50 });
      expect(c.capitalUsd).toBe(100);
    });

    it('positionPct clampé [1, 100]', () => {
      expect(resolveConfig({ gainers_position_pct: 0 }).positionPct).toBe(1);
      expect(resolveConfig({ gainers_position_pct: 150 }).positionPct).toBe(100);
      expect(resolveConfig({ gainers_position_pct: 50 }).positionPct).toBe(50);
    });
  });

  describe('Capacity (maxOpen × maxPerCycle)', () => {
    it('respecte cfg.gainers_max_open_positions=8 (UI)', () => {
      const c = resolveConfig({ gainers_max_open_positions: 8 });
      expect(c.maxOpen).toBe(8);
    });

    it('clamp maxOpen [1, 20]', () => {
      expect(resolveConfig({ gainers_max_open_positions: 0 }).maxOpen).toBe(1);
      expect(resolveConfig({ gainers_max_open_positions: 50 }).maxOpen).toBe(20);
    });

    it('cfg.gainers_max_per_cycle = 3 → 3 ouvertures/cycle (vs 1 hardcoded avant)', () => {
      const c = resolveConfig({ gainers_max_per_cycle: 3 });
      expect(c.maxPerCycle).toBe(3);
    });

    it('clamp maxPerCycle [1, 10]', () => {
      expect(resolveConfig({ gainers_max_per_cycle: 0 }).maxPerCycle).toBe(1);
      expect(resolveConfig({ gainers_max_per_cycle: 100 }).maxPerCycle).toBe(10);
    });
  });

  describe('Cash reserve & cooldown', () => {
    it('cash_reserve_pct configurable [0, 50]', () => {
      expect(resolveConfig({ gainers_cash_reserve_pct: 0 }).cashReservePct).toBe(0);
      expect(resolveConfig({ gainers_cash_reserve_pct: 25 }).cashReservePct).toBe(25);
      expect(resolveConfig({ gainers_cash_reserve_pct: 100 }).cashReservePct).toBe(50);
    });

    it('cooldown configurable [0, 240] min', () => {
      expect(resolveConfig({ gainers_cooldown_minutes: 0 }).cooldownMinutes).toBe(0);
      expect(resolveConfig({ gainers_cooldown_minutes: 60 }).cooldownMinutes).toBe(60);
      expect(resolveConfig({ gainers_cooldown_minutes: 999 }).cooldownMinutes).toBe(240);
    });

    it('fallback cooldown = 30 min (legacy)', () => {
      expect(resolveConfig(null).cooldownMinutes).toBe(30);
    });
  });

  describe('Scenarios complets', () => {
    it('config Sniper UI (capital $10k, max 5 pos, 20% notional, cooldown 30) = sane defaults', () => {
      const c = resolveConfig({
        capital_simulation: 10000,
        gainers_max_open_positions: 5,
        gainers_max_per_cycle: 3,
        gainers_position_pct: 20,
        gainers_cash_reserve_pct: 10,
        gainers_cooldown_minutes: 30,
      });
      expect(c.capitalUsd).toBe(10000);
      expect(c.maxOpen).toBe(5);
      expect(c.maxPerCycle).toBe(3);
      expect(c.positionNotionalUsd).toBe(2000); // 5 × $2k = $10k worst case (au-dessus capital, fees-aware guard arbitre)
      expect(c.cashReservePct).toBe(10);
      expect(c.cooldownMinutes).toBe(30);
    });

    it('config Aggressive UI (capital $50k, max 8 pos, 25% notional) = scaling correct', () => {
      const c = resolveConfig({
        capital_simulation: 50000,
        gainers_max_open_positions: 8,
        gainers_position_pct: 25,
      });
      expect(c.maxOpen).toBe(8);
      expect(c.positionNotionalUsd).toBe(12500); // 25% × $50k
    });

    it('row sans config gainers_* (legacy pre-0115) = tous fallbacks', () => {
      const c = resolveConfig({});
      expect(c.capitalUsd).toBe(10000);
      expect(c.maxOpen).toBe(5);
      expect(c.maxPerCycle).toBe(3);
      expect(c.positionPct).toBe(20);
      expect(c.cashReservePct).toBe(10);
      expect(c.cooldownMinutes).toBe(30);
    });
  });
});
