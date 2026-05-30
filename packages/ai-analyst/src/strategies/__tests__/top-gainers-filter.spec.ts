/**
 * P5-PIVOT-TOP-GAINERS — Tests pure filter logic.
 */
import {
  evaluateTopGainerCandidate,
  selectTopGainers,
  detectAssetClass,
  TopGainerCandidate,
} from '../top-gainers-filter';

const baseUSEquity: TopGainerCandidate = {
  symbol: 'NVDA',
  exchange: 'US',
  close: 500,
  high: 510,
  changePct: 7,
  volume: 50_000_000,
  avgVol50d: 30_000_000,
  marketCap: 1_500_000_000_000,
};

describe('detectAssetClass', () => {
  it('detects US equity large cap (MC>10B)', () => {
    expect(detectAssetClass('NVDA', 'US', 1_500_000_000_000)).toBe('us_equity_large');
  });
  it('detects US equity small/mid (MC<10B)', () => {
    expect(detectAssetClass('PLTR', 'US', 50_000_000_000)).toBe('us_equity_large');
    expect(detectAssetClass('RKLB', 'US', 5_000_000_000)).toBe('us_equity_small_mid');
  });
  it('detects EU equity (LSE/XETRA/PA)', () => {
    expect(detectAssetClass('VOD.L', 'LSE')).toBe('eu_equity');
    expect(detectAssetClass('SAP.DE', 'XETRA')).toBe('eu_equity');
    expect(detectAssetClass('LVMH.PA', 'PA')).toBe('eu_equity');
  });
  it('detects Asia equity (TSE/HK/AU)', () => {
    expect(detectAssetClass('7203.T', 'TSE')).toBe('asia_equity');
    expect(detectAssetClass('0700.HK', 'HK')).toBe('asia_equity');
  });
  it('detects crypto major (BTC/ETH/BNB/SOL)', () => {
    expect(detectAssetClass('BTCUSDT', 'BINANCE')).toBe('crypto_major');
    expect(detectAssetClass('ETHUSDT', 'BINANCE')).toBe('crypto_major');
  });
  it('detects crypto alt', () => {
    expect(detectAssetClass('DOGEUSDT', 'BINANCE')).toBe('crypto_alt');
    expect(detectAssetClass('SHIBUSDT', 'BINANCE')).toBe('crypto_alt');
  });
  it('detects FX major (EURUSD)', () => {
    expect(detectAssetClass('EURUSD', 'FOREX')).toBe('fx_major');
    expect(detectAssetClass('USDJPY', 'FOREX')).toBe('fx_major');
  });
  it('detects FX cross', () => {
    expect(detectAssetClass('EURJPY', 'FOREX')).toBe('fx_cross');
    expect(detectAssetClass('USDTRY', 'FOREX')).toBe('fx_cross');
  });
  it('detects commodity via COMM exchange or .COMM suffix', () => {
    expect(detectAssetClass('CL.F', 'COMM')).toBe('commodity');
    expect(detectAssetClass('GC.F', 'COMM')).toBe('commodity');
    expect(detectAssetClass('BRENT.COMM', '')).toBe('commodity');
  });
  it('FIX 29/05 — Frankfurt .F is eu_equity, NOT commodity', () => {
    // Bug : l'ancien regex /^[A-Z]{2,3}\.F$/ classait tous les Frankfurt en
    // commodity. .F = Frankfurt exchange (BMW.F), pas commodity future.
    expect(detectAssetClass('RAC.F', 'F')).toBe('eu_equity');
    expect(detectAssetClass('HTD.F', 'F')).toBe('eu_equity');
    expect(detectAssetClass('JPX.F', '')).toBe('eu_equity'); // suffix only
    expect(detectAssetClass('BMW.XETRA', 'XETRA')).toBe('eu_equity');
  });
});

describe('evaluateTopGainerCandidate — US equity', () => {
  it('passes when all criteria met (NVDA +7%)', () => {
    const r = evaluateTopGainerCandidate(baseUSEquity);
    expect(r.passes).toBe(true);
    expect(r.score).toBeGreaterThan(0);
    expect(r.assetClass).toBe('us_equity_large');
  });

  it('rejects on changePct < 5% for small/mid', () => {
    const r = evaluateTopGainerCandidate({
      ...baseUSEquity,
      symbol: 'RKLB',
      marketCap: 5_000_000_000,
      changePct: 4,
    });
    expect(r.passes).toBe(false);
    expect(r.reasons[0]).toMatch(/changePct/);
  });

  it('accepts 3% for large cap (NVDA at +3.5%)', () => {
    const r = evaluateTopGainerCandidate({ ...baseUSEquity, changePct: 3.5 });
    expect(r.passes).toBe(true);
    expect(r.assetClass).toBe('us_equity_large');
  });

  it('rejects on penny stock price < $5', () => {
    const r = evaluateTopGainerCandidate({ ...baseUSEquity, close: 3, high: 3.5 });
    expect(r.passes).toBe(false);
    expect(r.reasons.some((rs) => rs.startsWith('price='))).toBe(true);
  });

  it('rejects on small market cap (<100M for small/mid)', () => {
    const r = evaluateTopGainerCandidate({
      ...baseUSEquity,
      symbol: 'TINY',
      marketCap: 50_000_000,
    });
    expect(r.passes).toBe(false);
    expect(r.reasons.some((rs) => rs.startsWith('mcap='))).toBe(true);
  });

  it('rejects on low volume ratio (vol < 1.5x avg)', () => {
    const r = evaluateTopGainerCandidate({
      ...baseUSEquity,
      volume: 30_000_000,
      avgVol50d: 30_000_000,
    });
    expect(r.passes).toBe(false);
    expect(r.reasons.some((rs) => rs.startsWith('volRatio='))).toBe(true);
  });

  it('rejects gap-and-fade (close < 80% of high)', () => {
    const r = evaluateTopGainerCandidate({
      ...baseUSEquity,
      close: 400,
      high: 510,  // close/high = 78%
    });
    expect(r.passes).toBe(false);
    expect(r.reasons.some((rs) => rs.startsWith('closeToHigh='))).toBe(true);
  });
});

describe('evaluateTopGainerCandidate — Crypto', () => {
  it('crypto major BTC passes at +3% (lower threshold)', () => {
    const r = evaluateTopGainerCandidate({
      symbol: 'BTCUSDT',
      exchange: 'BINANCE',
      close: 50000,
      high: 51000,
      changePct: 3.5,
      volume: 100_000_000,
      avgVol50d: 0,
      marketCap: 1_000_000_000_000,
    });
    expect(r.passes).toBe(true);
    expect(r.assetClass).toBe('crypto_major');
  });

  it('crypto alt requires +8% (DOGE +5% rejected)', () => {
    const r = evaluateTopGainerCandidate({
      symbol: 'DOGEUSDT',
      exchange: 'BINANCE',
      close: 0.15,
      high: 0.16,
      changePct: 5,
      volume: 50_000_000,
      avgVol50d: 0,
      marketCap: 20_000_000_000,
    });
    expect(r.passes).toBe(false);
    expect(r.reasons[0]).toMatch(/changePct/);
  });

  it('crypto alt accepted at +8.5%', () => {
    const r = evaluateTopGainerCandidate({
      symbol: 'DOGEUSDT',
      exchange: 'BINANCE',
      close: 0.15,
      high: 0.155,
      changePct: 8.5,
      volume: 50_000_000,
      avgVol50d: 0,
      marketCap: 20_000_000_000,
    });
    expect(r.passes).toBe(true);
  });
});

describe('evaluateTopGainerCandidate — FX', () => {
  it('FX major EURUSD passes at +0.6%', () => {
    const r = evaluateTopGainerCandidate({
      symbol: 'EURUSD',
      exchange: 'FOREX',
      close: 1.0850,
      high: 1.0855,
      changePct: 0.6,
      volume: 0,
      avgVol50d: 0,
      marketCap: 0,
    });
    expect(r.passes).toBe(true);
    expect(r.assetClass).toBe('fx_major');
  });

  it('FX cross USDTRY requires +1.5%', () => {
    const r = evaluateTopGainerCandidate({
      symbol: 'USDTRY',
      exchange: 'FOREX',
      close: 35,
      high: 35.1,
      changePct: 1.0,
      volume: 0,
      avgVol50d: 0,
      marketCap: 0,
    });
    expect(r.passes).toBe(false);
  });
});

describe('selectTopGainers — cross-asset ranking', () => {
  it('returns top N across asset classes by score', () => {
    const candidates: TopGainerCandidate[] = [
      { ...baseUSEquity, symbol: 'NVDA', changePct: 4 },
      { ...baseUSEquity, symbol: 'TSLA', changePct: 8 },
      {
        symbol: 'BTCUSDT', exchange: 'BINANCE', close: 50000, high: 50500,
        changePct: 6, volume: 100_000_000, avgVol50d: 0, marketCap: 1_000_000_000_000,
      },
      {
        symbol: 'EURUSD', exchange: 'FOREX', close: 1.085, high: 1.086,
        changePct: 0.7, volume: 0, avgVol50d: 0, marketCap: 0,
      },
    ];
    const top = selectTopGainers(candidates, 3);
    expect(top.length).toBeGreaterThanOrEqual(2);
    // Best score must be first
    expect(top[0].score).toBeGreaterThanOrEqual(top[top.length - 1].score);
    // No symbol with rejected criteria
    expect(top.every((t) => t.symbol !== 'NVDA' || t.changePct >= 3)).toBe(true);
  });

  it('returns [] when all candidates fail filters', () => {
    const flat = [{ ...baseUSEquity, changePct: 1 }];
    expect(selectTopGainers(flat, 3)).toEqual([]);
  });

  it('rejects invalid data (high < close)', () => {
    const r = evaluateTopGainerCandidate({ ...baseUSEquity, high: 400, close: 500 });
    expect(r.passes).toBe(false);
    expect(r.reasons[0]).toBe('invalid_data');
  });

  it('rejects NaN / negative prices', () => {
    expect(evaluateTopGainerCandidate({ ...baseUSEquity, close: NaN }).passes).toBe(false);
    expect(evaluateTopGainerCandidate({ ...baseUSEquity, close: -10 }).passes).toBe(false);
  });
});
