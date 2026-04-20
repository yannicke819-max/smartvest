import Decimal from 'decimal.js';
import { InstrumentQuote } from '../../dto/instrument-quote.dto';
import { PriceBar } from '../../dto/price-bar.dto';
import { ProviderAsset } from '../market-data-provider.interface';
import { EodRealtimeQuote, EodEodBar } from './eod-types';

function safeDecimal(value: number | undefined | null): string | undefined {
  if (value === undefined || value === null || !isFinite(value)) return undefined;
  return new Decimal(value).toFixed(10);
}

export function normalizeEodRealtimeQuote(
  raw: EodRealtimeQuote,
  asset: ProviderAsset,
): InstrumentQuote {
  return {
    assetId: asset.assetId,
    ticker: asset.ticker,
    price: new Decimal(raw.close).toFixed(10),
    currency: asset.currency,
    asOf: new Date(raw.timestamp * 1000).toISOString(),
    provider: 'eodhd',
    marketState: 'unknown',
    previousClose: safeDecimal(raw.previousClose),
    changeAbsolute: safeDecimal(raw.change),
    changePercent: safeDecimal(raw.change_p),
    rawPayload: raw as unknown as Record<string, unknown>,
  };
}

export function normalizeEodBar(raw: EodEodBar, asset: ProviderAsset): PriceBar {
  return {
    assetId: asset.assetId,
    provider: 'eodhd',
    date: raw.date,
    open: safeDecimal(raw.open),
    high: safeDecimal(raw.high),
    low: safeDecimal(raw.low),
    close: new Decimal(raw.close).toFixed(10),
    adjustedClose: safeDecimal(raw.adjusted_close),
    volume: raw.volume,
    currency: asset.currency,
  };
}
