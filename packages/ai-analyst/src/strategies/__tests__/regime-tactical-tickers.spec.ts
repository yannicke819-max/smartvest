/**
 * P13 — Tests regime→tickers mapping et univers stagflation_hedge.
 */
import {
  REGIME_TICKER_MAP,
  REGIME_MIN_CONVICTION,
  DEFAULT_MIN_CONVICTION,
  STAGFLATION_HEDGE_UNIVERSE,
  CRYPTO_TRADABLE_UNIVERSE,
  getUniverseTickers,
} from '../universes';

// ─── helpers ────────────────────────────────────────────────────────────────

function stripSuffix(ticker: string): string {
  return ticker.replace(/\.(US|CC|PA|DE|L|T|HK)$/, '');
}

// ─── Regime mapping ──────────────────────────────────────────────────────────

describe('REGIME_TICKER_MAP', () => {
  it('returns non-empty list for stagflation', () => {
    const tickers = REGIME_TICKER_MAP['stagflation'];
    expect(Array.isArray(tickers)).toBe(true);
    expect(tickers.length).toBeGreaterThanOrEqual(5);
  });

  it('returns non-empty list for risk_off', () => {
    const tickers = REGIME_TICKER_MAP['risk_off'];
    expect(tickers).toBeDefined();
    expect(tickers.length).toBeGreaterThanOrEqual(3);
  });

  it('stagflation tickers include core gold and energy ETFs', () => {
    const tickers = REGIME_TICKER_MAP['stagflation'];
    expect(tickers).toContain('GLD');
    expect(tickers).toContain('GDX');
    expect(tickers).toContain('XLE');
    expect(tickers).toContain('TLT');
  });

  it('risk_off tickers are flight-to-safety assets', () => {
    const tickers = REGIME_TICKER_MAP['risk_off'];
    expect(tickers).toContain('TLT');
    expect(tickers).toContain('GLD');
    // no growth / high-beta
    expect(tickers).not.toContain('NVDA');
    expect(tickers).not.toContain('QQQ');
  });

  it('risk_on tickers include growth and crypto', () => {
    const tickers = REGIME_TICKER_MAP['risk_on'];
    expect(tickers).toContain('BTC-USD');
    expect(tickers).toContain('ETH-USD');
    expect(tickers).toContain('NVDA');
    // no bonds or defensive ETFs
    expect(tickers).not.toContain('TLT');
    expect(tickers).not.toContain('GLD');
  });

  it('crypto (BTC-USD, ETH-USD) appears only in risk_on, not stagflation', () => {
    expect(REGIME_TICKER_MAP['stagflation']).not.toContain('BTC-USD');
    expect(REGIME_TICKER_MAP['risk_on']).toContain('BTC-USD');
  });

  it('all regime entries are defined and non-empty', () => {
    for (const [, tickers] of Object.entries(REGIME_TICKER_MAP)) {
      expect(Array.isArray(tickers)).toBe(true);
      expect(tickers.length).toBeGreaterThan(0);
      for (const t of tickers) {
        expect(typeof t).toBe('string');
        expect(t.length).toBeGreaterThan(0);
      }
    }
  });
});

// ─── Conviction overrides ────────────────────────────────────────────────────

describe('REGIME_MIN_CONVICTION', () => {
  it('stagflation has lower conviction than default', () => {
    expect(REGIME_MIN_CONVICTION['stagflation']).toBeLessThan(DEFAULT_MIN_CONVICTION);
  });

  it('risk_off has lower conviction than default', () => {
    expect(REGIME_MIN_CONVICTION['risk_off']).toBeLessThan(DEFAULT_MIN_CONVICTION);
  });

  it('stagflation conviction is at least 5 (not too permissive)', () => {
    expect(REGIME_MIN_CONVICTION['stagflation']).toBeGreaterThanOrEqual(5);
  });

  it('default conviction is 8', () => {
    expect(DEFAULT_MIN_CONVICTION).toBe(8);
  });

  it('no override for risk_on (uses default)', () => {
    expect(REGIME_MIN_CONVICTION['risk_on']).toBeUndefined();
  });
});

// ─── STAGFLATION_HEDGE_UNIVERSE ──────────────────────────────────────────────

describe('STAGFLATION_HEDGE_UNIVERSE', () => {
  it('contains at least 30 tickers', () => {
    expect(STAGFLATION_HEDGE_UNIVERSE.length).toBeGreaterThanOrEqual(30);
  });

  it('all tickers use .US suffix (EODHD format)', () => {
    for (const ticker of STAGFLATION_HEDGE_UNIVERSE) {
      expect(ticker.endsWith('.US')).toBe(true);
    }
  });

  it('includes core stagflation regime tickers (without suffix)', () => {
    const base = STAGFLATION_HEDGE_UNIVERSE.map(stripSuffix);
    // All stagflation tickers that are US-listed should be in the universe
    const stagflationTickers = REGIME_TICKER_MAP['stagflation'].filter(
      (t) => !t.includes('-USD'), // exclude crypto notation
    );
    for (const t of stagflationTickers) {
      expect(base).toContain(t);
    }
  });

  it('includes gold ETF (GLD) and silver ETF (SLV)', () => {
    expect(STAGFLATION_HEDGE_UNIVERSE).toContain('GLD.US');
    expect(STAGFLATION_HEDGE_UNIVERSE).toContain('SLV.US');
  });

  it('includes energy sector ETF (XLE) and oil ETF (USO)', () => {
    expect(STAGFLATION_HEDGE_UNIVERSE).toContain('XLE.US');
    expect(STAGFLATION_HEDGE_UNIVERSE).toContain('USO.US');
  });

  it('includes long-duration Treasury ETF (TLT)', () => {
    expect(STAGFLATION_HEDGE_UNIVERSE).toContain('TLT.US');
  });

  it('includes TIPS inflation-protection ETF', () => {
    expect(STAGFLATION_HEDGE_UNIVERSE).toContain('TIPS.US');
  });

  it('has no duplicate tickers', () => {
    const unique = new Set(STAGFLATION_HEDGE_UNIVERSE);
    expect(unique.size).toBe(STAGFLATION_HEDGE_UNIVERSE.length);
  });

  it('getUniverseTickers("stagflation_hedge") returns the same list', () => {
    const result = getUniverseTickers('stagflation_hedge');
    expect(result).toEqual(STAGFLATION_HEDGE_UNIVERSE);
    // should be a copy, not the same reference
    expect(result).not.toBe(STAGFLATION_HEDGE_UNIVERSE);
  });
});

// ─── CRYPTO_TRADABLE_UNIVERSE ─────────────────────────────────────────────────

describe('CRYPTO_TRADABLE_UNIVERSE', () => {
  it('contains BTC, ETH, SOL', () => {
    expect(CRYPTO_TRADABLE_UNIVERSE).toContain('BTC-USD.CC');
    expect(CRYPTO_TRADABLE_UNIVERSE).toContain('ETH-USD.CC');
    expect(CRYPTO_TRADABLE_UNIVERSE).toContain('SOL-USD.CC');
  });

  it('all tickers use .CC suffix (EODHD crypto format)', () => {
    for (const ticker of CRYPTO_TRADABLE_UNIVERSE) {
      expect(ticker.endsWith('.CC')).toBe(true);
    }
  });

  it('getUniverseTickers("crypto_tradable") returns the same list', () => {
    const result = getUniverseTickers('crypto_tradable');
    expect(result).toEqual(CRYPTO_TRADABLE_UNIVERSE);
  });
});

// ─── Cross-validation ─────────────────────────────────────────────────────────

describe('cross-validation regime tickers vs universe', () => {
  it('every stagflation ticker (non-crypto) maps to a universe ticker', () => {
    const universeBase = STAGFLATION_HEDGE_UNIVERSE.map(stripSuffix);
    const stagflationTickers = REGIME_TICKER_MAP['stagflation'].filter(
      (t) => !t.includes('-USD'),
    );
    for (const t of stagflationTickers) {
      expect(universeBase).toContain(t);
    }
  });

  it('risk_off tickers (non-crypto) are covered by stagflation_hedge universe', () => {
    const universeBase = STAGFLATION_HEDGE_UNIVERSE.map(stripSuffix);
    const riskOffNonCrypto = REGIME_TICKER_MAP['risk_off'].filter(
      (t) => !t.includes('-USD'),
    );
    for (const t of riskOffNonCrypto) {
      expect(universeBase).toContain(t);
    }
  });

  it('LISA_REGIME_TACTICAL_TICKERS persona block contains table header', () => {
    // Ensures the persona string is non-empty and well-formed
    const { LISA_REGIME_TACTICAL_TICKERS } = require('../../persona/09-regime-tactical-tickers');
    expect(typeof LISA_REGIME_TACTICAL_TICKERS).toBe('string');
    expect(LISA_REGIME_TACTICAL_TICKERS.length).toBeGreaterThan(500);
    expect(LISA_REGIME_TACTICAL_TICKERS).toContain('stagflation');
    expect(LISA_REGIME_TACTICAL_TICKERS).toContain('FORCED_REGIME_THESIS');
    expect(LISA_REGIME_TACTICAL_TICKERS).toContain('risk_off');
  });

  it('persona block is included in LISA_SYSTEM_PROMPT_CACHEABLE', () => {
    const { LISA_SYSTEM_PROMPT_CACHEABLE } = require('../../persona');
    expect(LISA_SYSTEM_PROMPT_CACHEABLE).toContain('FORCED_REGIME_THESIS');
    expect(LISA_SYSTEM_PROMPT_CACHEABLE).toContain('stagflation');
  });
});
