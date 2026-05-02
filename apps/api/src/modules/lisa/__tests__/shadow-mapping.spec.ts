/**
 * PR6.6.3 — Unit tests pour shadow-mapping.helper.
 *
 * Verifie :
 *   - Crypto vol24hUsd : pas de × close (volume Binance déjà USDT)
 *   - Equity vol24hUsd : × close (volume EODHD = nb shares)
 *   - asset_class detection upstream (PR6.6.2 fallback) reste OK
 */

import { mapTopGainerToCandidateRaw } from '../services/shadow-mapping.helper';

describe('mapTopGainerToCandidateRaw — PR6.6.3 vol24hUsd correctness', () => {
  it('crypto: vol24hUsd = volume (no × close)', () => {
    const raw = mapTopGainerToCandidateRaw({
      symbol: 'BTCUSDT',
      exchange: 'BINANCE',
      assetClass: 'crypto_major',
      close: 60_000,
      high: 61_000,
      changePct: 2.5,
      volume: 20_000_000_000, // $20B quoteVolume Binance (already USD)
      avgVol50d: 25_000_000_000,
      marketCap: 1_300_000_000_000,
    });
    expect(raw.market).toBe('crypto');
    expect(raw.vol24hUsd).toBe(20_000_000_000); // not × close
    expect(raw.medianDailyVolUsd20d).toBe(25_000_000_000);
    expect(raw.marketCapUsd).toBe(1_300_000_000_000);
  });

  it('equity: vol24hUsd = volume × close (volume = nb shares)', () => {
    const raw = mapTopGainerToCandidateRaw({
      symbol: 'AAPL',
      exchange: 'US',
      assetClass: 'us_equity_large',
      close: 200,
      high: 205,
      changePct: 3,
      volume: 50_000_000, // 50M shares
      avgVol50d: 60_000_000,
      marketCap: 3_000_000_000_000,
    });
    expect(raw.market).toBe('equity');
    expect(raw.vol24hUsd).toBe(50_000_000 * 200); // 10B USD
    expect(raw.medianDailyVolUsd20d).toBe(60_000_000 * 200);
  });

  it('crypto without legacyAssetClass: detectAssetClass fallback recognizes BTCUSDT', () => {
    const raw = mapTopGainerToCandidateRaw({
      symbol: 'BTCUSDT',
      exchange: 'BINANCE',
      // assetClass undefined — simule raw candidate from fetchBinanceGainers pre-PR6.6.2
      close: 60_000,
      high: 61_000,
      changePct: 2.5,
      volume: 20_000_000_000,
      avgVol50d: 0,
      marketCap: 1_300_000_000_000,
    } as any);
    expect(raw.market).toBe('crypto'); // PR6.6.2 fallback works
    expect(raw.vol24hUsd).toBe(20_000_000_000); // PR6.6.3 correct formula
  });

  it('crypto with low volume (ADA-like) does not get artificially inflated', () => {
    const raw = mapTopGainerToCandidateRaw({
      symbol: 'ADAUSDT',
      exchange: 'BINANCE',
      assetClass: 'crypto_major',
      close: 0.4,
      high: 0.42,
      changePct: 5,
      volume: 200_000_000, // $200M quoteVolume
      avgVol50d: 200_000_000,
      marketCap: 15_000_000_000,
    });
    expect(raw.vol24hUsd).toBe(200_000_000); // not 200M × 0.4 = 80M
    // Pre-fix: 80M < 50M crypto floor → fail liquidity. Post-fix: 200M > 50M → pass.
  });
});
