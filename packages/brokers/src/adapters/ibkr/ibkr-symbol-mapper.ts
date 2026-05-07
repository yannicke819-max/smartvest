/**
 * Phase B.1 — Mapping symbol SmartVest → IBKR conid (contract ID).
 *
 * SmartVest utilise des tickers EODHD-style (ex: `AAPL.US`, `BLDP.US`,
 * `089010.KQ`). IBKR utilise un conid numérique opaque.
 *
 * Mapping cache en mémoire (LRU 2000 entries). conid IBKR est stable, on
 * peut cache "pour toujours" pendant la durée de vie du process. Refresh
 * sur restart (acceptable, lookup ~50ms par symbole nouveau).
 *
 * V1 scope :
 *   - resolve(symbol) : EODHD ticker → IbkrConid via secdef/search
 *   - cache hits short-circuit le call HTTP
 *
 * Out of scope (V2) :
 *   - Mapping inverse (IBKR symbol → EODHD ticker pour reconciliation)
 *   - Préchauffage cache au démarrage
 *   - Persistence cross-restart (DB table broker_symbol_map)
 */

import type { IbkrConid } from './ibkr-types';
import type { IbkrClient } from './ibkr-client';

const MAX_CACHE_SIZE = 2000;

export class IbkrSymbolMapper {
  private readonly cache = new Map<string, IbkrConid>();
  private readonly client: IbkrClient;

  constructor(client: IbkrClient) {
    this.client = client;
  }

  /**
   * Convert SmartVest symbol → IbkrConid.
   * Returns null si IBKR ne trouve pas le contract (ticker invalide ou
   * non disponible sur le plan IBKR du user).
   */
  async resolve(symbol: string): Promise<IbkrConid | null> {
    const normalized = this.normalizeSymbol(symbol);

    const cached = this.cache.get(normalized);
    if (cached !== undefined) {
      // LRU touch : delete + set pour le pousser en fin de Map
      this.cache.delete(normalized);
      this.cache.set(normalized, cached);
      return cached;
    }

    const baseSymbol = this.stripExchangeSuffix(normalized);
    const contract = await this.client.searchContract(baseSymbol);
    if (!contract || !contract.conid) return null;

    this.cacheSet(normalized, contract.conid);
    return contract.conid;
  }

  /**
   * Pour les tests + admin : peuple manuellement le cache.
   */
  preload(symbol: string, conid: IbkrConid): void {
    this.cacheSet(this.normalizeSymbol(symbol), conid);
  }

  getCacheSize(): number {
    return this.cache.size;
  }

  private cacheSet(key: string, value: IbkrConid): void {
    if (this.cache.size >= MAX_CACHE_SIZE) {
      // Evict LRU (= first inserted, since Map preserves insertion order)
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) this.cache.delete(firstKey);
    }
    this.cache.set(key, value);
  }

  private normalizeSymbol(symbol: string): string {
    return symbol.trim().toUpperCase();
  }

  /**
   * Convertit `AAPL.US` → `AAPL`, `089010.KQ` → `089010`, `BTC-USD.CC` → `BTC-USD`.
   * IBKR's secdef/search prend juste le ticker base ; le secType (STK/FX/CRYPTO)
   * et l'exchange sont déterminés ensuite dans le contract.
   */
  private stripExchangeSuffix(normalized: string): string {
    const dotIdx = normalized.lastIndexOf('.');
    if (dotIdx <= 0) return normalized;
    return normalized.substring(0, dotIdx);
  }
}
