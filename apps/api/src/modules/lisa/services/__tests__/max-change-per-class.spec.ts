import {
  parseMaxChangePerClassConfig,
  resolveMaxChangePct,
  describeOverrides,
  DEFAULT_MAX_CHANGE_PER_CLASS,
} from '../max-change-per-class.helper';

// 03/06/2026 — défauts per-class SENSÉS (asia 30, eu 15, us_large 15,
// us_small_mid 10, crypto 30) remplacent les anciens null. Une classe sans
// secret Fly n'hérite plus du global qui l'écrasait (bug asia capé à ~12).

describe('parseMaxChangePerClassConfig', () => {
  it('env vide → défauts sensés per-class (plus de null)', () => {
    const c = parseMaxChangePerClassConfig({});
    expect(c.asia).toBe(30);
    expect(c.eu).toBe(30);
    expect(c.us_large).toBe(30);
    expect(c.us_small_mid).toBe(25);
    expect(c.crypto).toBe(30);
  });
  it('secret Fly RELÂCHE au-dessus du plancher (prime si plus permissif)', () => {
    const c = parseMaxChangePerClassConfig({
      GAINERS_MAX_CHANGE_PCT_LONG_ASIA: '40',
      GAINERS_MAX_CHANGE_PCT_LONG_EU: '35',
      GAINERS_MAX_CHANGE_PCT_LONG_US_LARGE: '40',
      GAINERS_MAX_CHANGE_PCT_LONG_US_SMALL_MID: '30',
      GAINERS_MAX_CHANGE_PCT_LONG_CRYPTO: '50',
    });
    expect(c.asia).toBe(40);
    expect(c.eu).toBe(35);
    expect(c.us_large).toBe(40);
    expect(c.us_small_mid).toBe(30);
    expect(c.crypto).toBe(50);
  });
  it('secret Fly sous le plancher → floored au défaut (vannes ouvertes garanties)', () => {
    const c = parseMaxChangePerClassConfig({
      GAINERS_MAX_CHANGE_PCT_LONG_EU: '15',         // vieux secret resserré
      GAINERS_MAX_CHANGE_PCT_LONG_US_SMALL_MID: '10',
    });
    expect(c.eu).toBe(30);          // floored
    expect(c.us_small_mid).toBe(25); // floored
  });
  it('valeurs hors range → défaut per-class', () => {
    const c = parseMaxChangePerClassConfig({
      GAINERS_MAX_CHANGE_PCT_LONG_ASIA: '200',  // > 100
      GAINERS_MAX_CHANGE_PCT_LONG_EU: '0',       // = 0 not >0
      GAINERS_MAX_CHANGE_PCT_LONG_US_LARGE: '-5',
    });
    expect(c.asia).toBe(30);
    expect(c.eu).toBe(30);
    expect(c.us_large).toBe(30);
  });
  it('NaN → défaut per-class', () => {
    expect(parseMaxChangePerClassConfig({ GAINERS_MAX_CHANGE_PCT_LONG_ASIA: 'abc' }).asia).toBe(30);
  });
  it('strings vides → défaut per-class', () => {
    expect(parseMaxChangePerClassConfig({ GAINERS_MAX_CHANGE_PCT_LONG_ASIA: '' }).asia).toBe(30);
  });
});

describe('resolveMaxChangePct', () => {
  const defaults = DEFAULT_MAX_CHANGE_PER_CLASS;
  const customOverrides = {
    asia: 25, eu: 14, us_large: 16, us_small_mid: 8, crypto: 12,
  };

  it('défauts per-class → JAMAIS le global (fix anti-écrasement)', () => {
    // Le global (10) ne doit PLUS écraser asia/crypto : ils ont leurs défauts.
    expect(resolveMaxChangePct('asia_equity', defaults, 10)).toBe(30);
    expect(resolveMaxChangePct('crypto_major', defaults, 10)).toBe(30);
    expect(resolveMaxChangePct('eu_equity', defaults, 10)).toBe(30);
    expect(resolveMaxChangePct('us_equity_small_mid', defaults, 10)).toBe(25);
  });

  it('asia_equity → seuil asia override', () => {
    expect(resolveMaxChangePct('asia_equity', customOverrides, 10)).toBe(25);
  });

  it('eu_equity → seuil eu override', () => {
    expect(resolveMaxChangePct('eu_equity', customOverrides, 10)).toBe(14);
  });

  it('us_equity_large → seuil us_large', () => {
    expect(resolveMaxChangePct('us_equity_large', customOverrides, 10)).toBe(16);
  });

  it('us_equity_small_mid → seuil us_small_mid', () => {
    expect(resolveMaxChangePct('us_equity_small_mid', customOverrides, 10)).toBe(8);
  });

  it('crypto_major/crypto_alt → seuil crypto', () => {
    expect(resolveMaxChangePct('crypto_major', customOverrides, 10)).toBe(12);
    expect(resolveMaxChangePct('crypto_alt', customOverrides, 10)).toBe(12);
  });

  it('asset_class unknown/null → fallback global', () => {
    expect(resolveMaxChangePct(null, customOverrides, 10)).toBe(10);
    expect(resolveMaxChangePct(undefined, customOverrides, 10)).toBe(10);
    expect(resolveMaxChangePct('xyz_unknown', customOverrides, 10)).toBe(10);
  });

  it('cas réel Asia : seuil 30 → laisse passer 25-29% (au lieu de skip à 10-12%)', () => {
    const seuil = resolveMaxChangePct('asia_equity', defaults, 10);
    expect(seuil).toBe(30);
    expect(29.9 >= seuil).toBe(false); // 29.9% passe
  });
});

describe('describeOverrides', () => {
  it('défauts → string descriptive (tous non-null désormais)', () => {
    expect(describeOverrides(DEFAULT_MAX_CHANGE_PER_CLASS)).toBe('asia=30 eu=30 us_large=30 us_small_mid=25 crypto=30');
  });
  it('1 valeur seule → string descriptive', () => {
    expect(describeOverrides({ asia: 30, eu: null, us_large: null, us_small_mid: null, crypto: null })).toBe('asia=30');
  });
  it('multiples → join space', () => {
    const c = { asia: 25, eu: 14, us_large: 16, us_small_mid: 8, crypto: 12 };
    expect(describeOverrides(c)).toBe('asia=25 eu=14 us_large=16 us_small_mid=8 crypto=12');
  });
});
