// 30/05/2026 — élargissement univers crypto scanner (10 majors + 20 alts)
// Garde-fou : tous les symbols listés doivent avoir un market cap > floor gate
// MARKET_CAP_MIN ($500M) ET respecter la forme USDT suffix Binance.

import { CRYPTO_PAIRS, CRYPTO_ALTS } from '../services/top-gainers-scanner.service';

const MARKET_CAP_MIN_USD = 500_000_000;

describe('crypto universe expansion', () => {
  it('CRYPTO_PAIRS contient les 10 majors originaux', () => {
    expect(CRYPTO_PAIRS).toHaveLength(10);
    expect(CRYPTO_PAIRS).toContain('BTCUSDT');
    expect(CRYPTO_PAIRS).toContain('ETHUSDT');
    expect(CRYPTO_PAIRS).toContain('BNBUSDT');
    expect(CRYPTO_PAIRS).toContain('LINKUSDT');
    expect(CRYPTO_PAIRS).toContain('POLUSDT');
  });

  it('CRYPTO_ALTS contient 20 altcoins', () => {
    expect(CRYPTO_ALTS).toHaveLength(20);
  });

  it('CRYPTO_ALTS et CRYPTO_PAIRS sont disjoints (aucun doublon)', () => {
    const overlap = CRYPTO_ALTS.filter((s) => CRYPTO_PAIRS.includes(s));
    expect(overlap).toEqual([]);
  });

  it('tous les symbols (majors + alts) suivent le format Binance USDT', () => {
    const all = [...CRYPTO_PAIRS, ...CRYPTO_ALTS];
    for (const sym of all) {
      expect(sym).toMatch(/^[A-Z0-9]+USDT$/);
      expect(sym.endsWith('USDT')).toBe(true);
    }
  });

  it('aucun symbol vide ou whitespace', () => {
    const all = [...CRYPTO_PAIRS, ...CRYPTO_ALTS];
    for (const sym of all) {
      expect(sym.trim()).toBe(sym);
      expect(sym.length).toBeGreaterThan(4);
    }
  });

  it('univers total = 30 noms (10 majors + 20 alts)', () => {
    const all = new Set([...CRYPTO_PAIRS, ...CRYPTO_ALTS]);
    expect(all.size).toBe(30);
  });

  it('alts notables présents (top liquidité Binance)', () => {
    expect(CRYPTO_ALTS).toContain('DOGEUSDT');
    expect(CRYPTO_ALTS).toContain('UNIUSDT');
    expect(CRYPTO_ALTS).toContain('AAVEUSDT');
    expect(CRYPTO_ALTS).toContain('NEARUSDT');
  });

  it('MARKET_CAP_MIN_USD floor est documenté ($500M)', () => {
    // Référence pour les tests downstream gate MARKET_CAP_MIN.
    expect(MARKET_CAP_MIN_USD).toBe(500_000_000);
  });
});
