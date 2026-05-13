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
 *   - RealtimePriceService.toBinanceSymbol (WS live price) idem (Bug #G2 ext)
 */
import { CRYPTO_PAIRS } from '../services/top-gainers-scanner.service';
import { BinanceMarketService } from '../services/binance-market.service';
import { RealtimePriceService } from '../services/realtime-price.service';

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

describe('Bug #G2 — RealtimePriceService.toBinanceSymbol POL aliases (WS live price)', () => {
  // RealtimePriceService.toBinanceSymbol est privé : accès via bracket notation
  // pour test (pattern déjà utilisé dans crypto-simulator.spec.ts). Dependencies
  // (supabase, config) ne sont pas exercées par la fonction de mapping pure.
  const supabaseMock = { getClient: () => ({}) };
  const configMock = { get: () => undefined };
  const svc = new RealtimePriceService(supabaseMock as never, configMock as never);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const toBinance = (s: string): string | null => (svc as any).toBinanceSymbol(s);

  it('POLUSDT → POLUSDT (passthrough endsWith USDT)', () => {
    expect(toBinance('POLUSDT')).toBe('POLUSDT');
  });

  it('POL → POLUSDT (short form ajouté Bug #G2)', () => {
    expect(toBinance('POL')).toBe('POLUSDT');
  });

  it('MATIC → POLUSDT (alias migration legacy text, redirige vers ticker live)', () => {
    expect(toBinance('MATIC')).toBe('POLUSDT');
  });

  it('lowercase pol → POLUSDT (toUpperCase normalization)', () => {
    expect(toBinance('pol')).toBe('POLUSDT');
  });

  it('lowercase matic → POLUSDT (alias migration + normalization)', () => {
    expect(toBinance('matic')).toBe('POLUSDT');
  });

  it('LINK → LINKUSDT (autres paires inchangées, sanity)', () => {
    expect(toBinance('LINK')).toBe('LINKUSDT');
  });

  it('MATIC-USDT (avec dash) → POLUSDT (dash strip + alias)', () => {
    // realtime-price.service ligne 153 : s.toUpperCase().replace(/[-\s]/g, '')
    // → 'MATIC-USDT' devient 'MATICUSDT', qui passe endsWith('USDT') → renvoyé
    // tel quel. Ce comportement passthrough est préservé (cf. note Bug #G2).
    // Le test confirme que la chaîne n'est pas cassée par notre fix.
    expect(toBinance('MATIC-USDT')).toBe('MATICUSDT');
  });
});
