/**
 * Charge les données historiques OHLCV depuis EODHD pour un univers de
 * tickers et une fenêtre temporelle.
 *
 * EODHD endpoint : /api/eod/{TICKER}?from=YYYY-MM-DD&to=YYYY-MM-DD&fmt=json
 * Retourne un array de { date, open, high, low, close, volume, adjusted_close }
 *
 * Comportement en cas d'échec :
 *  - Ticker introuvable / 404 → ticker exclu, warning loggé
 *  - Réseau / timeout → idem, on continue avec les autres
 *  - Aucune data dans la fenêtre → idem
 *
 * On ne fait JAMAIS de fallback à des données fictives — il vaut mieux
 * exclure un ticker que tester sur du bruit.
 */

import type { Candle, TickerHistory } from './types';

export interface DataReplayOptions {
  fromDate: string;
  toDate: string;
  apiKey: string;
}

/** Mapping ticker → asset class. Pour le backtest minimal on couvre les ETFs
 *  et cryptos liquides — extensible si besoin. */
export const DEFAULT_UNIVERSE: ReadonlyArray<{ symbol: string; eodhdTicker: string; assetClass: string }> = [
  // Actions large-cap US
  { symbol: 'SPY', eodhdTicker: 'SPY.US', assetClass: 'equity_us_large' },
  { symbol: 'QQQ', eodhdTicker: 'QQQ.US', assetClass: 'equity_us_large' },
  { symbol: 'IWM', eodhdTicker: 'IWM.US', assetClass: 'equity_us_small' },
  { symbol: 'DIA', eodhdTicker: 'DIA.US', assetClass: 'equity_us_large' },

  // Métaux précieux
  { symbol: 'GLD', eodhdTicker: 'GLD.US', assetClass: 'commodities_metals_precious' },
  { symbol: 'SLV', eodhdTicker: 'SLV.US', assetClass: 'commodities_metals_precious' },
  { symbol: 'IAU', eodhdTicker: 'IAU.US', assetClass: 'commodities_metals_precious' },

  // Énergie
  { symbol: 'USO', eodhdTicker: 'USO.US', assetClass: 'commodities_energy' },
  { symbol: 'BNO', eodhdTicker: 'BNO.US', assetClass: 'commodities_energy' },

  // Volatilité
  { symbol: 'VXX', eodhdTicker: 'VXX.US', assetClass: 'derivatives_vol' },

  // Bonds
  { symbol: 'TLT', eodhdTicker: 'TLT.US', assetClass: 'govt_bonds_us' },
  { symbol: 'IEF', eodhdTicker: 'IEF.US', assetClass: 'govt_bonds_us' },
  { symbol: 'HYG', eodhdTicker: 'HYG.US', assetClass: 'credit_hy' },

  // FX (via ETF proxy)
  { symbol: 'UUP', eodhdTicker: 'UUP.US', assetClass: 'fx_g10' },
  { symbol: 'FXE', eodhdTicker: 'FXE.US', assetClass: 'fx_g10' },
  { symbol: 'FXY', eodhdTicker: 'FXY.US', assetClass: 'fx_g10' },

  // EM
  { symbol: 'EEM', eodhdTicker: 'EEM.US', assetClass: 'equity_em' },

  // Crypto (ETF spot)
  { symbol: 'IBIT', eodhdTicker: 'IBIT.US', assetClass: 'crypto_bitcoin' },
];

/**
 * Charge les bougies journalières pour un ticker.
 * Retourne null si EODHD échoue (ticker introuvable, réseau, etc.).
 */
async function fetchTickerHistory(
  symbol: string,
  eodhdTicker: string,
  assetClass: string,
  fromDate: string,
  toDate: string,
  apiKey: string,
): Promise<TickerHistory | null> {
  const url = `https://eodhd.com/api/eod/${encodeURIComponent(eodhdTicker)}?from=${fromDate}&to=${toDate}&api_token=${apiKey}&fmt=json`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    const raw = (await res.json()) as Array<Record<string, unknown>>;
    if (!Array.isArray(raw) || raw.length === 0) return null;

    const candles: Candle[] = [];
    for (const row of raw) {
      const date = String(row['date'] ?? '');
      const open = Number(row['open']);
      const high = Number(row['high']);
      const low = Number(row['low']);
      const close = Number(row['adjusted_close'] ?? row['close']);
      const volume = Number(row['volume'] ?? 0);
      if (!date || !Number.isFinite(close) || close <= 0) continue;
      candles.push({ date, open, high, low, close, volume });
    }
    if (candles.length === 0) return null;
    // Tri ascendant par date pour garantir le replay chronologique
    candles.sort((a, b) => a.date.localeCompare(b.date));
    return { symbol, assetClass, candles };
  } catch {
    return null;
  }
}

/**
 * Charge l'univers complet en parallèle. Tolère les échecs partiels —
 * retourne uniquement les tickers réussis avec une liste de warnings.
 */
export async function loadUniverseHistory(
  options: DataReplayOptions,
  universe: ReadonlyArray<{ symbol: string; eodhdTicker: string; assetClass: string }>,
): Promise<{ histories: TickerHistory[]; warnings: string[] }> {
  const histories: TickerHistory[] = [];
  const warnings: string[] = [];

  const results = await Promise.allSettled(
    universe.map((u) =>
      fetchTickerHistory(u.symbol, u.eodhdTicker, u.assetClass, options.fromDate, options.toDate, options.apiKey),
    ),
  );

  results.forEach((r, i) => {
    const u = universe[i];
    if (r.status === 'fulfilled' && r.value != null) {
      histories.push(r.value);
    } else {
      warnings.push(`Ticker ${u.symbol} (${u.eodhdTicker}) exclu : pas de données dans la fenêtre.`);
    }
  });

  return { histories, warnings };
}

/**
 * Construit la liste ordonnée des dates de trading présentes dans au moins
 * un ticker. Permet d'itérer chronologiquement même si certains tickers
 * ont des trous (jours fériés différents par marché, IPO récente, etc.).
 */
export function extractTradingDates(histories: TickerHistory[]): string[] {
  const set = new Set<string>();
  for (const h of histories) {
    for (const c of h.candles) set.add(c.date);
  }
  return [...set].sort();
}

/**
 * Helper rapide : récupère la bougie d'un ticker à une date précise.
 * O(log n) après tri préalable.
 */
export function candleAt(history: TickerHistory, date: string): Candle | null {
  // Recherche dichotomique
  let lo = 0;
  let hi = history.candles.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const c = history.candles[mid];
    if (c.date === date) return c;
    if (c.date < date) lo = mid + 1;
    else hi = mid - 1;
  }
  return null;
}
