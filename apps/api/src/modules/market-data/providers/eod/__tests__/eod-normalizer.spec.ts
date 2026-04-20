import { normalizeEodRealtimeQuote, normalizeEodBar } from '../eod-normalizer';
import type { EodRealtimeQuote, EodEodBar } from '../eod-types';
import type { ProviderAsset } from '../../market-data-provider.interface';

const asset: ProviderAsset = {
  assetId: 'abc-123',
  ticker: 'AAPL',
  providerTicker: 'AAPL.US',
  currency: 'USD',
};

const rawQuote: EodRealtimeQuote = {
  code: 'AAPL.US',
  timestamp: 1700000000,
  gmtoffset: 0,
  open: 182.5,
  high: 184.0,
  low: 181.0,
  close: 183.25,
  volume: 55000000,
  previousClose: 181.0,
  change: 2.25,
  change_p: 1.2431,
};

describe('normalizeEodRealtimeQuote', () => {
  it('maps price to close with 10 decimal precision', () => {
    const q = normalizeEodRealtimeQuote(rawQuote, asset);
    expect(q.price).toBe('183.2500000000');
  });

  it('sets assetId and ticker from ProviderAsset', () => {
    const q = normalizeEodRealtimeQuote(rawQuote, asset);
    expect(q.assetId).toBe('abc-123');
    expect(q.ticker).toBe('AAPL');
  });

  it('converts unix timestamp to ISO string', () => {
    const q = normalizeEodRealtimeQuote(rawQuote, asset);
    expect(q.asOf).toBe(new Date(1700000000 * 1000).toISOString());
  });

  it('includes previousClose and changePercent as strings', () => {
    const q = normalizeEodRealtimeQuote(rawQuote, asset);
    expect(q.previousClose).toBe('181.0000000000');
    expect(q.changePercent).toBe('1.2431000000');
  });

  it('sets provider to eodhd', () => {
    const q = normalizeEodRealtimeQuote(rawQuote, asset);
    expect(q.provider).toBe('eodhd');
  });

  it('preserves rawPayload', () => {
    const q = normalizeEodRealtimeQuote(rawQuote, asset);
    expect(q.rawPayload).toBeDefined();
    expect((q.rawPayload as Record<string, unknown>)['code']).toBe('AAPL.US');
  });
});

describe('normalizeEodBar', () => {
  const rawBar: EodEodBar = {
    date: '2024-01-15',
    open: 182.0,
    high: 185.5,
    low: 180.0,
    close: 184.0,
    adjusted_close: 184.0,
    volume: 60000000,
  };

  it('maps OHLCV fields', () => {
    const bar = normalizeEodBar(rawBar, asset);
    expect(bar.date).toBe('2024-01-15');
    expect(bar.close).toBe('184.0000000000');
    expect(bar.open).toBe('182.0000000000');
    expect(bar.high).toBe('185.5000000000');
    expect(bar.low).toBe('180.0000000000');
  });

  it('sets provider to eodhd', () => {
    const bar = normalizeEodBar(rawBar, asset);
    expect(bar.provider).toBe('eodhd');
    expect(bar.assetId).toBe('abc-123');
  });

  it('maps adjusted_close', () => {
    const bar = normalizeEodBar(rawBar, asset);
    expect(bar.adjustedClose).toBe('184.0000000000');
  });

  it('handles undefined optional fields gracefully', () => {
    const bar = normalizeEodBar(
      { ...rawBar, open: undefined as unknown as number },
      asset,
    );
    expect(bar.open).toBeUndefined();
  });
});
