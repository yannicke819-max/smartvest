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

export interface BinanceFlowStats {
  symbol: string;
  /** % variation OI sur 24h (positif = positionnement croissant). */
  oiChange24hPct: number | null;
  /** Top trader account ratio (long/short). > 1 = comptes longs majoritaires. */
  topTraderLongShortAccountRatio: number | null;
  /** Top trader position ratio (long/short). > 1 = positions long majoritaires.
   *  Ratio "position" pondère par taille — plus institutionnel que "account". */
  topTraderLongShortPositionRatio: number | null;
  /** Long/short ratio agrégé tous traders (retail+pro). */
  globalLongShortAccountRatio: number | null;
  asOf: number;
}

@Injectable()
export class BinanceMarketService {
  private readonly logger = new Logger(BinanceMarketService.name);
  // 31/05/2026 — api.binance.com renvoie HTTP 451 (geo-block) depuis Fly Paris (cdg).
  // data-api.binance.vision est le CDN public officiel pour le market data spot (mêmes
  // routes /api/v3/{ticker,klines,price}, pas d'auth, pas geo-restreint). Constat
  // 30-31/05 : 18/20 alts ajoutées par PR #504 (NEAR/ATOM/UNI/ICP/APT/XLM/FIL/...)
  // skip silencieusement via api.binance.com → null → continue. Sur data-api elles
  // répondent toutes. Override possible via env BINANCE_BASE_URL si besoin.
  private readonly BASE_URL = process.env.BINANCE_BASE_URL ?? 'https://data-api.binance.vision';
  private readonly FAPI_URL = process.env.BINANCE_FAPI_URL ?? 'https://fapi.binance.com';
  private klinesCache = new Map<string, { data: BinanceCandle[]; asOf: number }>();
  // Bug #A (13/05/2026) — Cache séparé pour getKlinesRange. TTL 1h car un range
  // historique fermé [startTime, endTime] est immutable, pas besoin de refresh
  // fréquent comme le legacy klinesCache (TTL 2min, fenêtre glissante last-N).
  private klinesRangeCache = new Map<string, { data: BinanceCandle[]; asOf: number }>();
  private readonly KLINES_RANGE_TTL_MS = 60 * 60 * 1000;
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
      'DOT': 'DOTUSDT', 'AVAX': 'AVAXUSDT',
      // Bug #G2 (13/05/2026) — MATIC → POL (Polygon rebrand sept 2024).
      // MATICUSDT figé sur Binance post-rebrand. Alias 'MATIC' redirige vers
      // POLUSDT pour back-compat (Lisa proposals legacy text). Mirror du pattern
      // BTC/ETH (alias short + ticker complet + variantes EODHD).
      'MATIC': 'POLUSDT', 'POL': 'POLUSDT', 'POLUSDT': 'POLUSDT',
      'LINK': 'LINKUSDT', 'ATOM': 'ATOMUSDT', 'UNI': 'UNIUSDT',
      'LTC': 'LTCUSDT',
    };
    if (map[s]) return map[s];
    // Déjà un ticker binance USDT
    if (s.endsWith('USDT')) return s;
    return null;
  }

  /**
   * Prix spot pour plusieurs symboles en UN seul appel (weight ≈ 2 pour ≤20
   * symboles) — pour l'échantillonnage fin micro-momentum. Pas de cache (on veut
   * la valeur fraîche à chaque tick). Retourne une Map symbol→price.
   */
  async getSpotPrices(binanceSymbols: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (binanceSymbols.length === 0) return out;
    try {
      const param = encodeURIComponent(JSON.stringify(binanceSymbols));
      const url = `${this.BASE_URL}/api/v3/ticker/price?symbols=${param}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) {
        this.logger.debug(`Binance spot prices HTTP ${res.status}`);
        return out;
      }
      const data = await res.json() as Array<{ symbol?: string; price?: string }>;
      if (!Array.isArray(data)) return out;
      for (const d of data) {
        const p = Number(d.price);
        if (d.symbol && Number.isFinite(p) && p > 0) out.set(d.symbol, p);
      }
      return out;
    } catch (e) {
      this.logger.debug(`Binance spot prices failed: ${String(e).slice(0, 80)}`);
      return out;
    }
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

  /**
   * Bug #A (13/05/2026) — Fetch klines avec fenêtre [startTime, endTime] explicite.
   *
   * Différence avec getKlines (limit-based, dernières N candles) : supporte les
   * fenêtres historiques arbitraires nécessaires au shadow simulator
   * (gainers-user-shadow.service.ts) qui rejoue des signaux capturés plusieurs
   * heures dans le passé.
   *
   * Binance API native : /api/v3/klines?symbol=X&interval=Y&startTime=A&endTime=B
   * accepte startTime/endTime en epoch millisecondes. Limit max 1000 (≥ tous les
   * use cases prévus : 70min @ 5m = 14 candles, 24h @ 5m = 288 candles).
   *
   * Cache distinct du klinesCache : key inclut start/end ms, TTL 1h.
   */
  async getKlinesRange(
    binanceSymbol: string,
    interval: '1m' | '5m' | '15m' | '1h' | '4h' | '1d',
    startTimeMs: number,
    endTimeMs: number,
  ): Promise<BinanceCandle[] | null> {
    const cacheKey = `${binanceSymbol}::${interval}::${startTimeMs}::${endTimeMs}`;
    const cached = this.klinesRangeCache.get(cacheKey);
    if (cached && Date.now() - cached.asOf < this.KLINES_RANGE_TTL_MS) return cached.data;

    try {
      const url = `${this.BASE_URL}/api/v3/klines?symbol=${binanceSymbol}` +
        `&interval=${interval}&startTime=${startTimeMs}&endTime=${endTimeMs}&limit=1000`;
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) {
        this.logger.debug(`Binance klines range HTTP ${res.status} for ${binanceSymbol}`);
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
      this.klinesRangeCache.set(cacheKey, { data: candles, asOf: Date.now() });
      return candles;
    } catch (e) {
      this.logger.warn(`Binance klines range failed ${binanceSymbol}: ${String(e).slice(0, 80)}`);
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

  private flowCache = new Map<string, { data: BinanceFlowStats; asOf: number }>();

  /**
   * Récupère les ratios de positionnement (open interest 24h delta + top
   * trader long/short) depuis l'API Binance Futures Data — endpoints publics
   * gratuits. Cache 5 min (ces ratios ne bougent pas en intraday rapide).
   *
   * Signaux :
   *   - oiChange24hPct > +20% : positionnement nouveau fort (confirmation
   *     trend si prix monte, attention divergence si stagne)
   *   - topTraderPositionRatio > 2.0 ou < 0.5 : pros très one-sided →
   *     soit confirmation, soit setup squeeze contraire
   *   - global vs top trader divergence : retail dans un sens, pros dans
   *     l'autre = signal contrarian classique
   */
  async getFlowStats(binanceSymbol: string): Promise<BinanceFlowStats | null> {
    const cached = this.flowCache.get(binanceSymbol);
    if (cached && Date.now() - cached.asOf < 5 * 60_000) return cached.data;

    try {
      // Endpoints "futures/data" — accessibles sans auth, rate limit 1000/5min
      // Période 1h, 1 point pour valeurs courantes. limit=2 pour OI delta 24h
      // (on prend les 2 dernières heures, mais Binance fournit aussi limit=
      // /openInterestHist?period=1h pour 30 derniers points = 30h).
      const [oiHist, topAccount, topPosition, globalAccount] = await Promise.all([
        // OI history horaire — on prend les 24 derniers points pour delta 24h
        fetch(
          `${this.FAPI_URL}/futures/data/openInterestHist?symbol=${binanceSymbol}&period=1h&limit=24`,
          { signal: AbortSignal.timeout(5000) },
        ),
        fetch(
          `${this.FAPI_URL}/futures/data/topLongShortAccountRatio?symbol=${binanceSymbol}&period=1h&limit=1`,
          { signal: AbortSignal.timeout(5000) },
        ),
        fetch(
          `${this.FAPI_URL}/futures/data/topLongShortPositionRatio?symbol=${binanceSymbol}&period=1h&limit=1`,
          { signal: AbortSignal.timeout(5000) },
        ),
        fetch(
          `${this.FAPI_URL}/futures/data/globalLongShortAccountRatio?symbol=${binanceSymbol}&period=1h&limit=1`,
          { signal: AbortSignal.timeout(5000) },
        ),
      ]);

      let oiChange24hPct: number | null = null;
      if (oiHist.ok) {
        const arr = (await oiHist.json()) as Array<Record<string, unknown>>;
        if (arr.length >= 2) {
          const oldest = Number(arr[0]?.sumOpenInterestValue ?? 0);
          const newest = Number(arr[arr.length - 1]?.sumOpenInterestValue ?? 0);
          if (oldest > 0) {
            oiChange24hPct = ((newest - oldest) / oldest) * 100;
          }
        }
      }

      const parseRatio = async (
        res: Response,
      ): Promise<number | null> => {
        if (!res.ok) return null;
        const arr = (await res.json()) as Array<Record<string, unknown>>;
        if (arr.length === 0) return null;
        const v = Number(arr[0]?.longShortRatio ?? 0);
        return Number.isFinite(v) && v > 0 ? v : null;
      };

      const stats: BinanceFlowStats = {
        symbol: binanceSymbol,
        oiChange24hPct,
        topTraderLongShortAccountRatio: await parseRatio(topAccount),
        topTraderLongShortPositionRatio: await parseRatio(topPosition),
        globalLongShortAccountRatio: await parseRatio(globalAccount),
        asOf: Date.now(),
      };
      this.flowCache.set(binanceSymbol, { data: stats, asOf: Date.now() });
      return stats;
    } catch (e) {
      this.logger.debug(
        `Binance flow stats failed ${binanceSymbol}: ${String(e).slice(0, 80)}`,
      );
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

    const [ticker, klines, futures, flow] = await Promise.all([
      this.getTicker24h(bs),
      this.getKlines(bs, '5m', 20),
      this.getFutureStats(bs),
      this.getFlowStats(bs),
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

    if (flow) {
      // OI delta 24h = positionnement net qui croît/décroit
      if (flow.oiChange24hPct != null) {
        const oiTag = flow.oiChange24hPct > 20
          ? ' 🔴 OI SURGE'
          : flow.oiChange24hPct < -20
            ? ' 🟢 OI UNWIND'
            : '';
        parts.push(`OI Δ24h=${flow.oiChange24hPct >= 0 ? '+' : ''}${flow.oiChange24hPct.toFixed(1)}%${oiTag}`);
      }
      // Top trader position ratio = signal pros vs retail
      if (flow.topTraderLongShortPositionRatio != null) {
        const r = flow.topTraderLongShortPositionRatio;
        const tag = r > 2.0
          ? ' (pros très long)'
          : r < 0.5
            ? ' (pros très short)'
            : '';
        parts.push(`top trader L/S=${r.toFixed(2)}${tag}`);
      }
      // Divergence retail vs pro = signal contrarian classique
      if (
        flow.globalLongShortAccountRatio != null &&
        flow.topTraderLongShortPositionRatio != null
      ) {
        const retail = flow.globalLongShortAccountRatio;
        const pro = flow.topTraderLongShortPositionRatio;
        const retailLong = retail > 1.2;
        const proLong = pro > 1.2;
        if (retailLong && !proLong && pro < 0.8) {
          parts.push(' ⚠️ DIVERGENCE: retail long, pros short');
        } else if (!retailLong && retail < 0.8 && proLong) {
          parts.push(' ⚠️ DIVERGENCE: retail short, pros long');
        }
      }
    }

    return parts.length > 0 ? parts.join(' · ') : null;
  }
}
