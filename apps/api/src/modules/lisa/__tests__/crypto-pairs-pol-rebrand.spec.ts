/**
 * Bug #G2 (13/05/2026) — Tests rebrand MATIC → POL dans le pool crypto scanner.
 *
 * Diagnostic : MATICUSDT figé à change_pct=-0.289% sur 91 captures consécutives
 * top_gainers_log (12-13/05/2026). Volume Binance gelé depuis rebrand officiel
 * Polygon (sept 2024). Occupait 1 slot/10 du pool sans signal exploitable.
 *
 * Couvre :
 *   - CRYPTO_PAIRS contient POLUSDT (remplaçant)
 *   - CRYPTO_PAIRS ne contient plus MATICUSDT (mort)
 *   - Cardinality du pool préservée (toujours 10 paires)
 *   - toBinanceSymbol mapping POL/POLUSDT/MATIC tous → 'POLUSDT'
 */
import { CRYPTO_PAIRS } from '../services/top-gainers-scanner.service';
import { BinanceMarketService } from '../services/binance-market.service';

describe('Bug #G2 — CRYPTO_PAIRS rebrand MATIC → POL', () => {
  it('contains POLUSDT (remplaçant post-rebrand)', () => {
    expect(CRYPTO_PAIRS).toContain('POLUSDT');
  });

  it('does NOT contain MATICUSDT (ticker mort post-rebrand)', () => {
    expect(CRYPTO_PAIRS).not.toContain('MATICUSDT');
  });

  it('preserves pool cardinality (10 paires)', () => {
    expect(CRYPTO_PAIRS).toHaveLength(10);
  });

  it('preserves all other pairs unchanged', () => {
    const expected = [
      'BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT',
      'ADAUSDT', 'AVAXUSDT', 'DOTUSDT', 'LINKUSDT', 'POLUSDT',
    ];
    expect([...CRYPTO_PAIRS].sort()).toEqual([...expected].sort());
  });
});

describe('Bug #G2 — BinanceMarketService.toBinanceSymbol POL aliases', () => {
  const svc = new BinanceMarketService();

  it('POLUSDT → POLUSDT (explicit mapping)', () => {
    expect(svc.toBinanceSymbol('POLUSDT')).toBe('POLUSDT');
  });

  it('POL → POLUSDT (short form, mirror MATIC pattern)', () => {
    expect(svc.toBinanceSymbol('POL')).toBe('POLUSDT');
  });

  it('MATIC → POLUSDT (alias migration legacy text)', () => {
    expect(svc.toBinanceSymbol('MATIC')).toBe('POLUSDT');
  });

  it('lowercase pol → POLUSDT (toUpperCase normalization)', () => {
    expect(svc.toBinanceSymbol('pol')).toBe('POLUSDT');
  });

  it('MATICUSDT → MATICUSDT (passthrough endsWith USDT preserved for legacy DB rows)', () => {
    // Si une row historique contient MATICUSDT, toBinanceSymbol la passe encore.
    // Bug #A simulator l'appellera sur Binance qui retournera 0 candles (ticker
    // dead) → outcome no_data 'empty_response'. Comportement gracieux, pas crash.
    expect(svc.toBinanceSymbol('MATICUSDT')).toBe('MATICUSDT');
  });
});
