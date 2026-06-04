import {
  parseOverpumpPerClassConfig,
  resolveOverpumpThreshold,
  describeOverpumpOverrides,
  DEFAULT_OVERPUMP_PER_CLASS,
} from '../overpump-per-class.helper';

describe('parseOverpumpPerClassConfig', () => {
  it('env vide → defaults sensés (pas null)', () => {
    const c = parseOverpumpPerClassConfig({});
    expect(c.asia).toBe(30);
    expect(c.eu).toBe(30);
    expect(c.us_large).toBe(30);
    expect(c.us_small_mid).toBe(25);
    expect(c.crypto).toBe(30);
  });
  it('parse valeurs valides', () => {
    const c = parseOverpumpPerClassConfig({
      GAINERS_OVERPUMP_THRESHOLD_PCT_ASIA: '25',
      GAINERS_OVERPUMP_THRESHOLD_PCT_EU: '18',
      GAINERS_OVERPUMP_THRESHOLD_PCT_US_LARGE: '12',
      GAINERS_OVERPUMP_THRESHOLD_PCT_US_SMALL_MID: '10',
      GAINERS_OVERPUMP_THRESHOLD_PCT_CRYPTO: '40',
    });
    expect(c.asia).toBe(25);
    expect(c.eu).toBe(18);
    expect(c.us_large).toBe(12);
    expect(c.us_small_mid).toBe(10);
    expect(c.crypto).toBe(40);
  });
  it('valeurs invalides → fallback default', () => {
    const c = parseOverpumpPerClassConfig({
      GAINERS_OVERPUMP_THRESHOLD_PCT_ASIA: '200',  // > 100
      GAINERS_OVERPUMP_THRESHOLD_PCT_EU: '0',
      GAINERS_OVERPUMP_THRESHOLD_PCT_US_LARGE: '-5',
      GAINERS_OVERPUMP_THRESHOLD_PCT_US_SMALL_MID: 'abc',
      GAINERS_OVERPUMP_THRESHOLD_PCT_CRYPTO: '',
    });
    expect(c.asia).toBe(30);
    expect(c.eu).toBe(30);
    expect(c.us_large).toBe(30);
    expect(c.us_small_mid).toBe(25);
    expect(c.crypto).toBe(30);
  });
});

describe('resolveOverpumpThreshold', () => {
  it('asia_equity → 30 par default', () => {
    expect(resolveOverpumpThreshold('asia_equity', DEFAULT_OVERPUMP_PER_CLASS, 0)).toBe(30);
  });
  it('eu_equity → 30 par default', () => {
    expect(resolveOverpumpThreshold('eu_equity', DEFAULT_OVERPUMP_PER_CLASS, 0)).toBe(30);
  });
  it('us_equity_large → 30', () => {
    expect(resolveOverpumpThreshold('us_equity_large', DEFAULT_OVERPUMP_PER_CLASS, 0)).toBe(30);
  });
  it('us_equity_small_mid → 25', () => {
    expect(resolveOverpumpThreshold('us_equity_small_mid', DEFAULT_OVERPUMP_PER_CLASS, 0)).toBe(25);
  });
  it('crypto_major / crypto_alt → 30', () => {
    expect(resolveOverpumpThreshold('crypto_major', DEFAULT_OVERPUMP_PER_CLASS, 0)).toBe(30);
    expect(resolveOverpumpThreshold('crypto_alt', DEFAULT_OVERPUMP_PER_CLASS, 0)).toBe(30);
  });
  it('class inconnue → conservative us_large (30)', () => {
    expect(resolveOverpumpThreshold('xyz', DEFAULT_OVERPUMP_PER_CLASS, 0)).toBe(30);
    expect(resolveOverpumpThreshold(null, DEFAULT_OVERPUMP_PER_CLASS, 0)).toBe(30); // null → defaults asia branch
  });
  it('globalOverride > 0 ET < per-class → globalOverride (kill switch resserrement)', () => {
    expect(resolveOverpumpThreshold('asia_equity', DEFAULT_OVERPUMP_PER_CLASS, 12)).toBe(12);
    expect(resolveOverpumpThreshold('crypto_major', DEFAULT_OVERPUMP_PER_CLASS, 12)).toBe(12);
  });
  it('globalOverride > 0 ET >= per-class → per-class (override ne resserre rien)', () => {
    expect(resolveOverpumpThreshold('eu_equity', DEFAULT_OVERPUMP_PER_CLASS, 35)).toBe(30);
  });
  it('cas réel 03/06 Asia open : 082800.KQ +29.82% passe (seuil 30)', () => {
    const seuil = resolveOverpumpThreshold('asia_equity', DEFAULT_OVERPUMP_PER_CLASS, 0);
    expect(29.82 > seuil).toBe(false);
  });
});

describe('describeOverpumpOverrides', () => {
  it('descriptif lisible', () => {
    expect(describeOverpumpOverrides(DEFAULT_OVERPUMP_PER_CLASS))
      .toBe('asia=30 eu=30 us_large=30 us_small_mid=25 crypto=30');
  });
});
