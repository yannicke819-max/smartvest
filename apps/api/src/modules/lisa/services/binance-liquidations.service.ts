import { Injectable, Logger } from '@nestjs/common';

/**
 * BinanceLiquidationsService — détection de waves de liquidations sur
 * Binance Futures. Signal golden-boy majeur :
 *
 *   liquidation wave long $42M en 1h → shorts piégés dès le bounce
 *   → mean reversion très probable (pattern Druckenmiller "puke low")
 *
 * Endpoint public : GET /fapi/v1/allForceOrders (derniers 7 jours)
 * Paramètre : symbol + limit 1000 max
 * Rate limit : 5 req/min par IP — on cache 2min.
 *
 * Détection de wave :
 *  - Somme notional liquidations BUY (= shorts liquidés) et SELL (= longs liquidés)
 *    sur fenêtre 1h et 24h
 *  - Flag "LONG_SQUEEZE" si BUY notional 1h > 20M$ ET > 3× moyenne 24h
 *  - Flag "LONG_PUKE"    si SELL notional 1h > 20M$ ET > 3× moyenne 24h
 *    (cascade de longs liquidés = capitulation possible)
 *
 * Gratuit, aucune clé API requise.
 */

export interface LiquidationSnapshot {
  symbol: string;
  asOf: number;
  buyNotionalUsd1h: number;     // shorts liquidés (= pression à la hausse)
  sellNotionalUsd1h: number;    // longs liquidés  (= pression à la baisse)
  buyNotionalUsd24h: number;
  sellNotionalUsd24h: number;
  wavePattern: 'LONG_SQUEEZE' | 'LONG_PUKE' | 'SHORT_PUKE' | 'NONE';
  waveDetail: string;
}

@Injectable()
export class BinanceLiquidationsService {
  private readonly logger = new Logger(BinanceLiquidationsService.name);
  private cache = new Map<string, { snap: LiquidationSnapshot; asOf: number }>();
  private readonly CACHE_MS = 2 * 60 * 1000;
  private readonly WAVE_THRESHOLD_USD = 20_000_000;

  async getSnapshot(symbol: string): Promise<LiquidationSnapshot | null> {
    const cached = this.cache.get(symbol);
    if (cached && Date.now() - cached.asOf < this.CACHE_MS) return cached.snap;

    const binanceSymbol = this.toBinanceSymbol(symbol);
    if (!binanceSymbol) return null;

    try {
      const url = `https://fapi.binance.com/fapi/v1/allForceOrders?symbol=${binanceSymbol}&limit=1000`;
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) {
        this.logger.warn(`Binance liquidations ${binanceSymbol}: HTTP ${res.status}`);
        return null;
      }
      const data = await res.json() as Array<Record<string, unknown>>;
      if (!Array.isArray(data) || data.length === 0) {
        const empty = this.emptySnapshot(symbol);
        this.cache.set(symbol, { snap: empty, asOf: Date.now() });
        return empty;
      }

      const now = Date.now();
      const h1 = now - 60 * 60 * 1000;
      const h24 = now - 24 * 60 * 60 * 1000;

      let buy1h = 0, sell1h = 0, buy24h = 0, sell24h = 0;
      for (const row of data) {
        const time = Number(row.time ?? 0);
        if (!isFinite(time) || time < h24) continue;
        const side = String(row.side ?? '').toUpperCase();
        const origQty = Number(row.origQty ?? 0);
        const price = Number(row.averagePrice ?? row.price ?? 0);
        if (!isFinite(origQty) || !isFinite(price)) continue;
        const notional = origQty * price;
        if (!isFinite(notional)) continue;

        if (side === 'BUY') {
          buy24h += notional;
          if (time >= h1) buy1h += notional;
        } else if (side === 'SELL') {
          sell24h += notional;
          if (time >= h1) sell1h += notional;
        }
      }

      // Détection de wave — on compare 1h vs moyenne horaire 24h.
      const buyHourlyAvg = buy24h / 24;
      const sellHourlyAvg = sell24h / 24;
      let wavePattern: LiquidationSnapshot['wavePattern'] = 'NONE';
      let waveDetail = '';

      if (sell1h >= this.WAVE_THRESHOLD_USD && sell1h > 3 * sellHourlyAvg) {
        wavePattern = 'LONG_PUKE';
        waveDetail = `${(sell1h / 1e6).toFixed(1)}M$ longs liquidés 1h (${(sell1h / Math.max(sellHourlyAvg, 1)).toFixed(1)}× avg) — capitulation possible, watch bounce`;
      } else if (buy1h >= this.WAVE_THRESHOLD_USD && buy1h > 3 * buyHourlyAvg) {
        wavePattern = 'LONG_SQUEEZE';
        waveDetail = `${(buy1h / 1e6).toFixed(1)}M$ shorts liquidés 1h (${(buy1h / Math.max(buyHourlyAvg, 1)).toFixed(1)}× avg) — squeeze en cours, prudence chasing`;
      }

      const snap: LiquidationSnapshot = {
        symbol,
        asOf: Date.now(),
        buyNotionalUsd1h: buy1h,
        sellNotionalUsd1h: sell1h,
        buyNotionalUsd24h: buy24h,
        sellNotionalUsd24h: sell24h,
        wavePattern,
        waveDetail,
      };
      this.cache.set(symbol, { snap, asOf: Date.now() });
      return snap;
    } catch (e) {
      this.logger.warn(`Binance liquidations ${symbol} failed: ${String(e).slice(0, 80)}`);
      return null;
    }
  }

  private emptySnapshot(symbol: string): LiquidationSnapshot {
    return {
      symbol,
      asOf: Date.now(),
      buyNotionalUsd1h: 0,
      sellNotionalUsd1h: 0,
      buyNotionalUsd24h: 0,
      sellNotionalUsd24h: 0,
      wavePattern: 'NONE',
      waveDetail: '',
    };
  }

  private toBinanceSymbol(symbol: string): string | null {
    const s = symbol.toUpperCase().replace(/[-_/]/g, '');
    if (s === 'BTC' || s === 'BITCOIN' || s === 'BTCUSD') return 'BTCUSDT';
    if (s === 'ETH' || s === 'ETHEREUM' || s === 'ETHUSD') return 'ETHUSDT';
    if (s === 'SOL' || s === 'SOLUSD') return 'SOLUSDT';
    if (s.endsWith('USDT') || s.endsWith('USD')) {
      return s.endsWith('USD') ? s.replace(/USD$/, 'USDT') : s;
    }
    return null;
  }

  /** Résumé texte pour le briefing Lisa. */
  summarize(snap: LiquidationSnapshot | null): string {
    if (!snap) return '';
    const sellM = snap.sellNotionalUsd1h / 1e6;
    const buyM = snap.buyNotionalUsd1h / 1e6;
    if (snap.wavePattern === 'LONG_PUKE') {
      return `${snap.symbol} 🔴 LONG PUKE · ${snap.waveDetail}`;
    }
    if (snap.wavePattern === 'LONG_SQUEEZE') {
      return `${snap.symbol} 🟢 LONG SQUEEZE · ${snap.waveDetail}`;
    }
    if (sellM < 1 && buyM < 1) return ''; // silencieux si rien de notable
    return `${snap.symbol}: longs liq=${sellM.toFixed(1)}M$/1h · shorts liq=${buyM.toFixed(1)}M$/1h (baseline)`;
  }
}
