import {
  parseMaxChangePerClassConfig,
  resolveMaxChangePct,
  describeOverrides,
  DEFAULT_MAX_CHANGE_PER_CLASS,
} from '../max-change-per-class.helper';

describe('parseMaxChangePerClassConfig', () => {
  it('env vide → tous null', () => {
    const c = parseMaxChangePerClassConfig({});
    expect(c.asia).toBeNull();
    expect(c.eu).toBeNull();
    expect(c.us_large).toBeNull();
    expect(c.us_small_mid).toBeNull();
    expect(c.crypto).toBeNull();
  });
  it('parse valeurs valides', () => {
    const c = parseMaxChangePerClassConfig({
      GAINERS_MAX_CHANGE_PCT_LONG_ASIA: '30',
      GAINERS_MAX_CHANGE_PCT_LONG_EU: '15',
      GAINERS_MAX_CHANGE_PCT_LONG_US_LARGE: '15',
      GAINERS_MAX_CHANGE_PCT_LONG_US_SMALL_MID: '10',
      GAINERS_MAX_CHANGE_PCT_LONG_CRYPTO: '12',
    });
    expect(c.asia).toBe(30);
    expect(c.eu).toBe(15);
    expect(c.us_large).toBe(15);
    expect(c.us_small_mid).toBe(10);
    expect(c.crypto).toBe(12);
  });
  it('valeurs hors range → null', () => {
    const c = parseMaxChangePerClassConfig({
      GAINERS_MAX_CHANGE_PCT_LONG_ASIA: '200',  // > 100
      GAINERS_MAX_CHANGE_PCT_LONG_EU: '0',       // = 0 not >0
      GAINERS_MAX_CHANGE_PCT_LONG_US_LARGE: '-5',
    });
    expect(c.asia).toBeNull();
    expect(c.eu).toBeNull();
    expect(c.us_large).toBeNull();
  });
  it('NaN → null', () => {
    expect(parseMaxChangePerClassConfig({ GAINERS_MAX_CHANGE_PCT_LONG_ASIA: 'abc' }).asia).toBeNull();
  });
  it('strings vides → null', () => {
    expect(parseMaxChangePerClassConfig({ GAINERS_MAX_CHANGE_PCT_LONG_ASIA: '' }).asia).toBeNull();
  });
});

describe('resolveMaxChangePct', () => {
  const noOverrides = DEFAULT_MAX_CHANGE_PER_CLASS;
  const customOverrides = {
    asia: 30, eu: 15, us_large: 15, us_small_mid: 10, crypto: 12,
  };

  it('aucun override → fallback global', () => {
    expect(resolveMaxChangePct('asia_equity', noOverrides, 10)).toBe(10);
    expect(resolveMaxChangePct('eu_equity', noOverrides, 10)).toBe(10);
  });

  it('fallback 0 (filtre OFF) → 0 quel que soit la classe', () => {
    expect(resolveMaxChangePct('asia_equity', noOverrides, 0)).toBe(0);
    expect(resolveMaxChangePct('crypto_major', noOverrides, 0)).toBe(0);
  });

  it('asia_equity → seuil asia si override', () => {
    expect(resolveMaxChangePct('asia_equity', customOverrides, 10)).toBe(30);
  });

  it('eu_equity → seuil eu si override', () => {
    expect(resolveMaxChangePct('eu_equity', customOverrides, 10)).toBe(15);
  });

  it('us_equity_large → seuil us_large', () => {
    expect(resolveMaxChangePct('us_equity_large', customOverrides, 10)).toBe(15);
  });

  it('us_equity_small_mid → seuil us_small_mid', () => {
    expect(resolveMaxChangePct('us_equity_small_mid', customOverrides, 10)).toBe(10);
  });

  it('crypto_major/crypto_alt → seuil crypto', () => {
    expect(resolveMaxChangePct('crypto_major', customOverrides, 10)).toBe(12);
    expect(resolveMaxChangePct('crypto_alt', customOverrides, 10)).toBe(12);
  });

  it('asset_class unknown/null → fallback', () => {
    expect(resolveMaxChangePct(null, customOverrides, 10)).toBe(10);
    expect(resolveMaxChangePct(undefined, customOverrides, 10)).toBe(10);
    expect(resolveMaxChangePct('xyz_unknown', customOverrides, 10)).toBe(10);
  });

  it('partial override : seule asia définie, autres fallback', () => {
    const partial = { asia: 30, eu: null, us_large: null, us_small_mid: null, crypto: null };
    expect(resolveMaxChangePct('asia_equity', partial, 10)).toBe(30);
    expect(resolveMaxChangePct('eu_equity', partial, 10)).toBe(10);
    expect(resolveMaxChangePct('us_equity_large', partial, 10)).toBe(10);
  });

  it('cas réel 25/05 nuit Asia : seuil 30 → laisse passer 25 % (au lieu de skip à 10 %)', () => {
    // Reproduit l'exemple des logs : 001820.KO ch=29.9% bloqué actuellement
    const cfg = { asia: 30, eu: null, us_large: null, us_small_mid: null, crypto: null };
    const seuil = resolveMaxChangePct('asia_equity', cfg, 10);
    expect(seuil).toBe(30);
    // 29.9 < 30 → passe le filtre
    expect(29.9 >= seuil).toBe(false);
  });
});

describe('describeOverrides', () => {
  it('aucun override → null', () => {
    expect(describeOverrides(DEFAULT_MAX_CHANGE_PER_CLASS)).toBeNull();
  });
  it('1 override → string descriptive', () => {
    expect(describeOverrides({ asia: 30, eu: null, us_large: null, us_small_mid: null, crypto: null })).toBe('asia=30');
  });
  it('multiples → join space', () => {
    const c = { asia: 30, eu: 15, us_large: 15, us_small_mid: 10, crypto: 12 };
    expect(describeOverrides(c)).toBe('asia=30 eu=15 us_large=15 us_small_mid=10 crypto=12');
  });
});
