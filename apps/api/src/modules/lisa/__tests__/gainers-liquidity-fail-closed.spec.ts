/**
 * Liquidité fail-closed (GAINERS_LIQUIDITY_FAIL_CLOSED).
 *
 * Investigation 22/05 : la divergence prix TD/EODHD (±5% médian) se concentre
 * sur les small-caps EU illiquides — exactement les noms où le volume est
 * indisponible. `passesLiquidityFloor` fail-OPEN sur dollarVol<=0 → ces noms
 * non-mesurables passaient (MKA.LSE tradée puis stoppée). Le mode fail-closed
 * les rejette pour les equities.
 */
import { dollarVolumeUsd, passesLiquidityFloor } from '../services/gainers-liquidity.helper';

// Mirror de la décision du gate (scanPortfolio).
function liquidityDecision(opts: {
  isCrypto: boolean;
  close: number;
  avgVol50d?: number;
  volume?: number;
  minUsd: number;
  failClosed: boolean;
}): 'pass' | 'reject_liquidity' {
  if (opts.isCrypto) return 'pass';
  const dv = dollarVolumeUsd(opts.close, opts.avgVol50d, opts.volume);
  if (opts.failClosed && opts.minUsd > 0 && dv <= 0) return 'reject_liquidity';
  return passesLiquidityFloor(dv, opts.minUsd) ? 'pass' : 'reject_liquidity';
}

describe('Liquidité gainers — fail-closed sur volume indispo', () => {
  it('volume indispo + fail-OPEN (default) → passe (comportement historique = trou)', () => {
    expect(liquidityDecision({ isCrypto: false, close: 49, minUsd: 1e6, failClosed: false })).toBe('pass');
  });

  it('volume indispo + fail-CLOSED → reject_liquidity (trou comblé)', () => {
    expect(liquidityDecision({ isCrypto: false, close: 49, minUsd: 1e6, failClosed: true })).toBe('reject_liquidity');
  });

  it('liquidité mesurable et suffisante → passe (fail-closed ne change rien)', () => {
    // 200$ × 50k = $10M > $1M
    expect(liquidityDecision({ isCrypto: false, close: 200, avgVol50d: 50000, minUsd: 1e6, failClosed: true })).toBe('pass');
  });

  it('liquidité mesurable mais sous le plancher → reject (inchangé)', () => {
    // 2$ × 10k = $20k < $1M
    expect(liquidityDecision({ isCrypto: false, close: 2, avgVol50d: 10000, minUsd: 1e6, failClosed: true })).toBe('reject_liquidity');
  });

  it('crypto → toujours pass (exempt), même fail-closed', () => {
    expect(liquidityDecision({ isCrypto: true, close: 0, minUsd: 1e6, failClosed: true })).toBe('pass');
  });

  it('floor désactivé (minUsd=0) → fail-closed inopérant', () => {
    expect(liquidityDecision({ isCrypto: false, close: 49, minUsd: 0, failClosed: true })).toBe('pass');
  });
});
