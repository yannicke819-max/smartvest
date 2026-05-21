import { dollarVolumeUsd, passesLiquidityFloor } from '../gainers-liquidity.helper';

describe('gainers-liquidity.helper', () => {
  describe('dollarVolumeUsd', () => {
    it('utilise avgVol50d en priorité (× close)', () => {
      // RR.LSE 1205 pence × 2M titres ≈ $2.4M
      expect(dollarVolumeUsd(1205, 2_000_000, 500)).toBe(1205 * 2_000_000);
    });

    it('fallback sur volume jour si avgVol50d absent/0', () => {
      expect(dollarVolumeUsd(100, 0, 5_000)).toBe(500_000);
      expect(dollarVolumeUsd(100, undefined, 5_000)).toBe(500_000);
    });

    it('retourne 0 si aucun volume ou close <= 0', () => {
      expect(dollarVolumeUsd(100, 0, 0)).toBe(0);
      expect(dollarVolumeUsd(0, 2_000_000, 0)).toBe(0);
    });
  });

  describe('passesLiquidityFloor', () => {
    it('penny-stock illiquide (sous le plancher) → bloqué', () => {
      // MTL.LSE 14.25 pence × 30k titres = $427k < $1M
      expect(passesLiquidityFloor(427_000, 1_000_000)).toBe(false);
    });

    it('nom liquide (au-dessus du plancher) → passe', () => {
      expect(passesLiquidityFloor(2_400_000, 1_000_000)).toBe(true);
    });

    it('pile au plancher → passe (>=)', () => {
      expect(passesLiquidityFloor(1_000_000, 1_000_000)).toBe(true);
    });

    it('gate désactivé (min <= 0) → passe toujours', () => {
      expect(passesLiquidityFloor(1, 0)).toBe(true);
      expect(passesLiquidityFloor(0, 0)).toBe(true);
    });

    it('volume indispo (dollarVol=0) → fail-open (passe)', () => {
      expect(passesLiquidityFloor(0, 1_000_000)).toBe(true);
    });
  });
});
