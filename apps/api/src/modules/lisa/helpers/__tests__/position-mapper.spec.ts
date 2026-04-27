/**
 * Tests pour position.mapper.ts — fix incident 27/04/2026.
 *
 * Vérifie que :
 *  - tous les champs snake_case du row Supabase reçoivent un alias camelCase
 *  - les champs nullable (stop_loss_price, take_profit_price, ...) deviennent
 *    `null` (pas `undefined`) en camelCase pour qu'un check `?.toString()`
 *    fonctionne sans crash
 *  - les champs originaux snake_case sont préservés (pour les call sites
 *    qui lisent encore via `as Record<>['field']`)
 *  - reproduction du scénario crash BTC : un row réaliste passe le
 *    `pos.assetClass.toLowerCase()` sans throw
 */
import { mapPositionRow, mapPositionRows } from '../position.mapper';

describe('mapPositionRow', () => {
  const btcRow = {
    id: 'pos-btc-uuid',
    portfolio_id: 'p-uuid',
    user_id: 'u-uuid',
    proposal_id: 'prop-uuid',
    thesis_id: 'th-uuid',
    symbol: 'BTC',
    asset_class: 'crypto_bitcoin',
    direction: 'long',
    venue: 'Binance',
    quantity: '0.0286',
    entry_price: '76875.69',
    entry_timestamp: '2026-04-27T17:38:00Z',
    entry_notional_usd: '2200.00',
    status: 'open',
    stop_loss_price: '73031.90',
    take_profit_price: '78797.58',
    horizon_target_date: '2026-05-04',
    estimated_entry_cost_usd: '4.40',
    autonomy_rules: [],
    conviction_score: 7,
    created_at: '2026-04-27T17:38:00Z',
    updated_at: '2026-04-27T17:38:00Z',
  };

  it('aliases asset_class → assetClass', () => {
    const mapped = mapPositionRow(btcRow);
    expect(mapped.assetClass).toBe('crypto_bitcoin');
    expect(mapped.asset_class).toBe('crypto_bitcoin'); // snake_case preserved
  });

  it('aliases entry_price → entryPrice', () => {
    const mapped = mapPositionRow(btcRow);
    expect(mapped.entryPrice).toBe('76875.69');
    expect(mapped.entry_price).toBe('76875.69');
  });

  it('aliases entry_notional_usd → entryNotionalUsd', () => {
    const mapped = mapPositionRow(btcRow);
    expect(mapped.entryNotionalUsd).toBe('2200.00');
  });

  it('aliases stop_loss_price → stopLossPrice (set value)', () => {
    const mapped = mapPositionRow(btcRow);
    expect(mapped.stopLossPrice).toBe('73031.90');
  });

  it('aliases take_profit_price → takeProfitPrice (set value)', () => {
    const mapped = mapPositionRow(btcRow);
    expect(mapped.takeProfitPrice).toBe('78797.58');
  });

  it('returns null (NOT undefined) when stop_loss_price is null in DB', () => {
    const noStop = { ...btcRow, stop_loss_price: null };
    const mapped = mapPositionRow(noStop);
    expect(mapped.stopLossPrice).toBeNull();
    expect(mapped.stopLossPrice).not.toBeUndefined();
  });

  it('returns null (NOT undefined) when take_profit_price is null in DB', () => {
    // Repro du bug du 27/04 : BTC + RTX en prod avaient TP=NULL
    const noTp = { ...btcRow, take_profit_price: null };
    const mapped = mapPositionRow(noTp);
    expect(mapped.takeProfitPrice).toBeNull();
  });

  it('preserves all original snake_case fields (no destructive overwrite)', () => {
    const mapped = mapPositionRow(btcRow);
    // Tous les champs originaux du row doivent être présents
    for (const key of Object.keys(btcRow)) {
      expect(mapped).toHaveProperty(key);
    }
  });

  it('repro crash BTC : pos.assetClass.toLowerCase() ne crashe PAS sur row mappé', () => {
    // C'est le bug ligne 1886 mechanical-trading.service.ts. Avant le mapper,
    // pos.assetClass était undefined → .toLowerCase() throw TypeError.
    const mapped = mapPositionRow(btcRow);
    expect(() => mapped.assetClass.toLowerCase()).not.toThrow();
    expect(mapped.assetClass.toLowerCase()).toBe('crypto_bitcoin');
    expect(mapped.assetClass.toLowerCase().includes('crypto')).toBe(true);
  });

  it('repro silent stop skip : pos.stopLossPrice + takeProfitPrice présents sur row valide', () => {
    // C'est le bug ligne 1446 mechanical-trading.service.ts.
    // Avant : `if (!pos.stopLossPrice && !pos.takeProfitPrice) return;`
    // → toujours true → return early → stops jamais évalués.
    const mapped = mapPositionRow(btcRow);
    const skipsStopCheck = !mapped.stopLossPrice && !mapped.takeProfitPrice;
    expect(skipsStopCheck).toBe(false); // checkStopTarget ne doit PAS skip
  });
});

describe('mapPositionRows', () => {
  it('handles empty array', () => {
    expect(mapPositionRows([])).toEqual([]);
  });

  it('handles null input', () => {
    expect(mapPositionRows(null)).toEqual([]);
  });

  it('handles undefined input', () => {
    expect(mapPositionRows(undefined)).toEqual([]);
  });

  it('maps multiple rows preserving order', () => {
    const rows = [
      { id: 'a', symbol: 'BTC', asset_class: 'crypto_bitcoin', entry_price: '1', stop_loss_price: '0.9', take_profit_price: null, entry_notional_usd: '100', entry_timestamp: '2026-04-27T17:38:00Z', horizon_target_date: null },
      { id: 'b', symbol: 'RTX', asset_class: 'equity_us_large', entry_price: '172.92', stop_loss_price: '166.00', take_profit_price: null, entry_notional_usd: '2500', entry_timestamp: '2026-04-27T19:14:00Z', horizon_target_date: null },
    ];
    const mapped = mapPositionRows(rows);
    expect(mapped).toHaveLength(2);
    expect(mapped[0].symbol).toBe('BTC');
    expect(mapped[0].assetClass).toBe('crypto_bitcoin');
    expect(mapped[1].symbol).toBe('RTX');
    expect(mapped[1].stopLossPrice).toBe('166.00');
    expect(mapped[1].takeProfitPrice).toBeNull(); // bug obs en prod 27/04
  });
});
