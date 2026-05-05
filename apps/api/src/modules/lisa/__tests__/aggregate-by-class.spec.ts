/**
 * PR Breakdown fix — Tests pour aggregateByClass avec fallback exchange.
 *
 * Bug rapporté user 05/05/2026 14:30 UTC :
 * Compteurs UI affichaient 1000 scannés mais breakdown "₿ 50" seulement.
 * Cause : `gainers_v1_shadow_signals.asset_class` stocke 'equity' (générique)
 * pour beaucoup de tickers. Mon premier `aggregateByClass` testait uniquement
 * `startsWith('us_equity'/'eu_equity'/...)` → 950 rows tombaient en 'other'.
 *
 * Fix : fallback sur `exchange` quand asset_class est générique.
 */

// Réplique inline d'aggregateByClass (testé en isolation, pas via NestJS)
const US_EXCHANGES = new Set(['US', 'NYSE', 'NASDAQ', 'BATS', 'OTCQB', 'OTCMKTS', 'OTC', 'NMFQS']);
const EU_EXCHANGES = new Set(['LSE', 'XETRA', 'PA', 'AS', 'AMS', 'MC', 'BME', 'MI', 'SW', 'BR']);
const ASIA_EXCHANGES = new Set(['KO', 'KQ', 'KS', 'KE', 'T', 'TSE', 'HK', 'NSE', 'BSE', 'SHG', 'SHE', 'SS', 'SZ', 'AU', 'AX', 'TO']);
const CRYPTO_EXCHANGES = new Set(['BINANCE', 'CC', 'COINBASE']);

function aggregateByClass(rows: Array<{ asset_class: string | null; exchange?: string | null }>): {
  us: number; eu: number; asia: number; crypto: number; other: number;
} {
  const out = { us: 0, eu: 0, asia: 0, crypto: 0, other: 0 };
  for (const r of rows) {
    const ac = String(r.asset_class ?? '').toLowerCase();
    const ex = String(r.exchange ?? '').toUpperCase();
    if (ac.startsWith('us_equity')) { out.us++; continue; }
    if (ac.startsWith('eu_equity')) { out.eu++; continue; }
    if (ac.startsWith('asia_equity')) { out.asia++; continue; }
    if (ac.startsWith('crypto')) { out.crypto++; continue; }
    if (CRYPTO_EXCHANGES.has(ex)) { out.crypto++; continue; }
    if (US_EXCHANGES.has(ex)) { out.us++; continue; }
    if (EU_EXCHANGES.has(ex)) { out.eu++; continue; }
    if (ASIA_EXCHANGES.has(ex)) { out.asia++; continue; }
    out.other++;
  }
  return out;
}

describe('aggregateByClass (PR breakdown fix)', () => {
  describe('asset_class préfixé (cas idéal)', () => {
    it('us_equity_large → us', () => {
      expect(aggregateByClass([{ asset_class: 'us_equity_large' }])).toEqual({
        us: 1, eu: 0, asia: 0, crypto: 0, other: 0,
      });
    });

    it('eu_equity → eu', () => {
      expect(aggregateByClass([{ asset_class: 'eu_equity' }])).toEqual({
        us: 0, eu: 1, asia: 0, crypto: 0, other: 0,
      });
    });

    it('asia_equity → asia', () => {
      expect(aggregateByClass([{ asset_class: 'asia_equity' }])).toEqual({
        us: 0, eu: 0, asia: 1, crypto: 0, other: 0,
      });
    });

    it('crypto_major / crypto_alt → crypto', () => {
      expect(aggregateByClass([
        { asset_class: 'crypto_major' },
        { asset_class: 'crypto_alt' },
      ])).toEqual({ us: 0, eu: 0, asia: 0, crypto: 2, other: 0 });
    });
  });

  describe('asset_class générique "equity" — fallback exchange', () => {
    it('equity + US → us', () => {
      expect(aggregateByClass([{ asset_class: 'equity', exchange: 'US' }])).toEqual({
        us: 1, eu: 0, asia: 0, crypto: 0, other: 0,
      });
    });

    it('equity + AS (Amsterdam) → eu', () => {
      expect(aggregateByClass([{ asset_class: 'equity', exchange: 'AS' }])).toEqual({
        us: 0, eu: 1, asia: 0, crypto: 0, other: 0,
      });
    });

    it('equity + KO (Korea) → asia', () => {
      expect(aggregateByClass([{ asset_class: 'equity', exchange: 'KO' }])).toEqual({
        us: 0, eu: 0, asia: 1, crypto: 0, other: 0,
      });
    });

    it('equity + SHG (Shanghai) → asia', () => {
      expect(aggregateByClass([{ asset_class: 'equity', exchange: 'SHG' }])).toEqual({
        us: 0, eu: 0, asia: 1, crypto: 0, other: 0,
      });
    });

    it('crypto + BINANCE → crypto', () => {
      expect(aggregateByClass([{ asset_class: 'crypto', exchange: 'BINANCE' }])).toEqual({
        us: 0, eu: 0, asia: 0, crypto: 1, other: 0,
      });
    });
  });

  describe('Bug reproduit user 14:30 UTC (1000 scannés, 50 crypto)', () => {
    it('mix realistic equity (US/EU/Asia) + crypto sans préfixes', () => {
      const rows = [
        ...Array(400).fill(null).map(() => ({ asset_class: 'equity', exchange: 'US' })),
        ...Array(200).fill(null).map(() => ({ asset_class: 'equity', exchange: 'AS' })),
        ...Array(150).fill(null).map(() => ({ asset_class: 'equity', exchange: 'LSE' })),
        ...Array(100).fill(null).map(() => ({ asset_class: 'equity', exchange: 'KO' })),
        ...Array(100).fill(null).map(() => ({ asset_class: 'equity', exchange: 'SHG' })),
        ...Array(50).fill(null).map(() => ({ asset_class: 'crypto', exchange: 'BINANCE' })),
      ];
      const result = aggregateByClass(rows);
      expect(result.us).toBe(400);
      expect(result.eu).toBe(350); // 200 AS + 150 LSE
      expect(result.asia).toBe(200); // 100 KO + 100 SHG
      expect(result.crypto).toBe(50);
      expect(result.other).toBe(0);
      expect(result.us + result.eu + result.asia + result.crypto + result.other).toBe(1000);
    });
  });

  describe('edge cases', () => {
    it('asset_class null + exchange null → other', () => {
      expect(aggregateByClass([{ asset_class: null }])).toEqual({
        us: 0, eu: 0, asia: 0, crypto: 0, other: 1,
      });
    });

    it('asset_class equity + exchange unknown → other', () => {
      expect(aggregateByClass([{ asset_class: 'equity', exchange: 'WAT' }])).toEqual({
        us: 0, eu: 0, asia: 0, crypto: 0, other: 1,
      });
    });

    it('priorité asset_class préfixé sur exchange (data integrity)', () => {
      // Si asset_class='us_equity_large' mais exchange='KO' (incohérent),
      // on fait confiance à asset_class (plus précis).
      expect(aggregateByClass([{ asset_class: 'us_equity_large', exchange: 'KO' }])).toEqual({
        us: 1, eu: 0, asia: 0, crypto: 0, other: 0,
      });
    });

    it('exchange case-insensitive (lowercase normalisé)', () => {
      expect(aggregateByClass([{ asset_class: 'equity', exchange: 'us' }])).toEqual({
        us: 1, eu: 0, asia: 0, crypto: 0, other: 0,
      });
    });
  });
});
