import { Injectable, Logger } from '@nestjs/common';

/**
 * BinanceMarketService — accès REST à Binance Public API pour enrichir
 * le briefing crypto avec :
 *  - klines 5m (bougies historiques, équivalent EODHD intraday pour crypto)
 *  - ticker 24h (volume, high/low, % change = signal de régime crypto)
 *
 * API publique sans clé, rate limit 1200 weight/min (~20 req/s) largement
 * suffisant pour notre usage.
 *
 * Endpoints :
 *   GET /api/v3/klines?symbol=BTCUSDT&interval=5m&limit=20
 *   GET /api/v3/ticker/24hr?symbol=BTCUSDT
 *
 * Cache 2 min (klines) / 1 min (24h).
 */

export interface BinanceCandle {
  openTime: number;  // unix ms
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
  trades: number;
}

export interface BinanceTicker24h {
  symbol: string;
  priceChange: number;
  priceChangePct: number;
  weightedAvgPrice: number;
  lastPrice: number;
  volume: number;       // base asset
  quoteVolume: number;  // quote asset (USDT)
  high: number;
  low: number;
  openTime: number;
  closeTime: number;
  count: number;        // number of trades
}

export interface BinanceFutureStats {
  symbol: string;
  fundingRate: number;       // taux actuel (8h period, ex: 0.0001 = 0.01%)
  fundingRatePct: number;    // en pourcentage
  fundingAnnualizedPct: number; // annualisé (× 3 × 365)
  nextFundingTime: number;   // unix ms
  openInterestUsd: number;   // OI × mark price (USD)
  asOf: number;
}

@Injectable()
export class BinanceMarketService {
  private readonly logger = new Logger(BinanceMarketService.name);
  private readonly BASE_URL = 'https://api.binance.com';
  private readonly FAPI_URL = 'https://fapi.binance.com';
  private klinesCache = new Map<string, { data: BinanceCandle[]; asOf: number }>();
  private tickerCache = new Map<string, { data: BinanceTicker24h; asOf: number }>();
  private futuresCache = new Map<string, { data: BinanceFutureStats; asOf: number }>();

  /**
   * Convertit un symbole SmartVest en symbole Binance. Retourne null si
   * le symbole n'est pas mappable (ex : actions US → null).
   */
  toBinanceSymbol(symbol: string): string | null {
    const s = symbol.toUpperCase();
    const map: Record<string, string> = {
      'BTC': 'BTCUSDT', 'BTCUSDT': 'BTCUSDT', 'BTC-USD': 'BTCUSDT', 'BTC-SPOT': 'BTCUSDT',
      'ETH': 'ETHUSDT', 'ETHUSDT': 'ETHUSDT', 'ETH-USD': 'ETHUSDT', 'ETH-SPOT': 'ETHUSDT',
      'SOL': 'SOLUSDT', 'SOLUSDT': 'SOLUSDT',
      'BNB': 'BNBUSDT', 'BNBUSDT': 'BNBUSDT',
      'XRP': 'XRPUSDT', 'XRPUSDT': 'XRPUSDT',
      'ADA': 'ADAUSDT', 'ADAUSDT': 'ADAUSDT',
      'DOGE': 'DOGEUSDT', 'DOGEUSDT': 'DOGEUSDT',
      'DOT': 'DOTUSDT', 'AVAX': 'AVAXUSDT', 'MATIC': 'MATICUSDT',
      'LINK': 'LINKUSDT', 'ATOM': 'ATOMUSDT', 'UNI': 'UNIUSDT',
      'LTC': 'LTCUSDT',
    };
    if (map[s]) return map[s];
    // Déjà un ticker binance USDT
    if (s.endsWith('USDT')) return s;
    return null;
  }

  async getKlines(binanceSymbol: string, interval: '1m' | '5m' | '15m' | '1h' | '4h' | '1d' = '5m', limit = 20): Promise<BinanceCandle[] | null> {
    const cacheKey = `${binanceSymbol}::${interval}::${limit}`;
    const cached = this.klinesCache.get(cacheKey);
    if (cached && Date.now() - cached.asOf < 2 * 60_000) return cached.data;

    try {
      const url = `${this.BASE_URL}/api/v3/klines?symbol=${binanceSymbol}&interval=${interval}&limit=${limit}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) {
        this.logger.debug(`Binance klines HTTP ${res.status} for ${binanceSymbol}`);
        return null;
      }
      const data = await res.json() as unknown[];
      if (!Array.isArray(data)) return null;

      const candles: BinanceCandle[] = data.map((row) => {
        const r = row as unknown[];
        return {
          openTime: Number(r[0]),
          open: Number(r[1]),
          high: Number(r[2]),
          low: Number(r[3]),
          close: Number(r[4]),
          volume: Number(r[5]),
          closeTime: Number(r[6]),
          trades: Number(r[8]),
        };
      });
      this.klinesCache.set(cacheKey, { data: candles, asOf: Date.now() });
      return candles;
    } catch (e) {
      this.logger.warn(`Binance klines failed ${binanceSymbol}: ${String(e).slice(0, 80)}`);
      return null;
    }
  }

  async getTicker24h(binanceSymbol: string): Promise<BinanceTicker24h | null> {
    const cached = this.tickerCache.get(binanceSymbol);
    if (cached && Date.now() - cached.asOf < 60_000) return cached.data;

    try {
      const url = `${this.BASE_URL}/api/v3/ticker/24hr?symbol=${binanceSymbol}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return null;
      const d = await res.json() as Record<string, unknown>;

      const ticker: BinanceTicker24h = {
        symbol: String(d.symbol ?? binanceSymbol),
        priceChange: Number(d.priceChange ?? 0),
        priceChangePct: Number(d.priceChangePercent ?? 0),
        weightedAvgPrice: Number(d.weightedAvgPrice ?? 0),
        lastPrice: Number(d.lastPrice ?? 0),
        volume: Number(d.volume ?? 0),
        quoteVolume: Number(d.quoteVolume ?? 0),
        high: Number(d.highPrice ?? 0),
        low: Number(d.lowPrice ?? 0),
        openTime: Number(d.openTime ?? 0),
        closeTime: Number(d.closeTime ?? 0),
        count: Number(d.count ?? 0),
      };
      this.tickerCache.set(binanceSymbol, { data: ticker, asOf: Date.now() });
      return ticker;
    } catch (e) {
      this.logger.warn(`Binance 24h failed ${binanceSymbol}: ${String(e).slice(0, 80)}`);
      return null;
    }
  }

  /**
   * Récupère le funding rate courant et l'open interest pour un perpétuel
   * Binance Futures USD-Margined (fapi).
   *
   * Signal "golden-boy" :
   *   - Funding rate extrême (> +0.05% ou < -0.05% sur 8h) = positionnement
   *     très one-sided → short squeeze / long squeeze imminent
   *   - OI qui grimpe rapidement = positionnement fort (confirmation trend
   *     si prix monte, divergence si prix stagne)
   */
  async getFutureStats(binanceSymbol: string): Promise<BinanceFutureStats | null> {
    const cached = this.futuresCache.get(binanceSymbol);
    if (cached && Date.now() - cached.asOf < 60_000) return cached.data;

    try {
      const [pIdx, oi] = await Promise.all([
        fetch(`${this.FAPI_URL}/fapi/v1/premiumIndex?symbol=${binanceSymbol}`, { signal: AbortSignal.timeout(5000) }),
        fetch(`${this.FAPI_URL}/fapi/v1/openInterest?symbol=${binanceSymbol}`, { signal: AbortSignal.timeout(5000) }),
      ]);
      if (!pIdx.ok || !oi.ok) return null;

      const pData = await pIdx.json() as Record<string, unknown>;
      const oData = await oi.json() as Record<string, unknown>;

      const fundingRate = Number(pData.lastFundingRate ?? 0);
      const markPrice = Number(pData.markPrice ?? 0);
      const oiNative = Number(oData.openInterest ?? 0);

      const stats: BinanceFutureStats = {
        symbol: binanceSymbol,
        fundingRate,
        fundingRatePct: fundingRate * 100,
        fundingAnnualizedPct: fundingRate * 3 * 365 * 100,
        nextFundingTime: Number(pData.nextFundingTime ?? 0),
        openInterestUsd: oiNative * markPrice,
        asOf: Date.now(),
      };
      this.futuresCache.set(binanceSymbol, { data: stats, asOf: Date.now() });
      return stats;
    } catch (e) {
      this.logger.debug(`Binance futures failed ${binanceSymbol}: ${String(e).slice(0, 80)}`);
      return null;
    }
  }

  /**
   * Résumé compact 24h + klines 5m pour injection dans le briefing Lisa.
   * Ex : "24h: +4.32% · $58.2B vol · range 87k-92k · intraday 5m: bullish momentum · VOL SURGE"
   */
  async summarize(symbol: string): Promise<string | null> {
    const bs = this.toBinanceSymbol(symbol);
    if (!bs) return null;

    const [ticker, klines, futures] = await Promise.all([
      this.getTicker24h(bs),
      this.getKlines(bs, '5m', 20),
      this.getFutureStats(bs),
    ]);

    const parts: string[] = [];

    if (ticker) {
      const volB = ticker.quoteVolume / 1e9;
      const volStr = volB >= 1 ? `${volB.toFixed(1)}B` : `${(ticker.quoteVolume / 1e6).toFixed(0)}M`;
      parts.push(`24h: ${ticker.priceChangePct >= 0 ? '+' : ''}${ticker.priceChangePct.toFixed(2)}%`);
      parts.push(`vol=$${volStr}`);
      parts.push(`range=${ticker.low.toFixed(2)}-${ticker.high.toFixed(2)}`);
    }

    if (klines && klines.length > 0) {
      const first = klines[0];
      const last = klines[klines.length - 1];
      const changePct = first.open > 0 ? ((last.close - first.open) / first.open) * 100 : 0;
      const bullishCandles = klines.filter((c) => c.close > c.open).length;
      const momentumRead = bullishCandles / klines.length > 0.6
        ? 'bullish momentum'
        : bullishCandles / klines.length < 0.4 ? 'bearish momentum' : 'choppy';
      parts.push(`intraday 5m: ${changePct >= 0 ? '+' : ''}${changePct.toFixed(2)}% · ${momentumRead}`);

      // Volume surge dernière bougie
      const avgVol = klines.reduce((s, k) => s + k.volume, 0) / klines.length;
      if (avgVol > 0 && last.volume > avgVol * 1.5) {
        parts.push('VOL SURGE');
      }
    }

    if (futures) {
      // Tag signal golden-boy : funding extrême (> ±0.05% sur 8h = ±55%/an)
      const fundingTag = futures.fundingRatePct > 0.05
        ? ' 🔴 LONG SQUEEZE RISK'
        : futures.fundingRatePct < -0.05
          ? ' 🟢 SHORT SQUEEZE RISK'
          : '';
      parts.push(
        `funding=${futures.fundingRatePct >= 0 ? '+' : ''}${futures.fundingRatePct.toFixed(4)}%/8h ` +
        `(~${futures.fundingAnnualizedPct >= 0 ? '+' : ''}${futures.fundingAnnualizedPct.toFixed(1)}%/an)${fundingTag}`,
      );
      const oiBn = futures.openInterestUsd / 1e9;
      parts.push(`OI=${oiBn >= 1 ? oiBn.toFixed(2) + 'B' : (futures.openInterestUsd / 1e6).toFixed(0) + 'M'}$`);
    }

    return parts.length > 0 ? parts.join(' · ') : null;
  }
}
