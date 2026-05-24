import {
  parsePerClassPathEffOverrides,
  resolveEffectivePathEffFloor,
  describeOverrides,
} from '../gainers-path-eff-per-class.helper';

describe('parsePerClassPathEffOverrides', () => {
  it('env vide → tous undefined (back-compat)', () => {
    const o = parsePerClassPathEffOverrides({});
    expect(o.us).toBeUndefined();
    expect(o.eu).toBeUndefined();
    expect(o.crypto).toBeUndefined();
  });

  it('parse valeurs valides', () => {
    const o = parsePerClassPathEffOverrides({
      GAINERS_MIN_PATH_EFFICIENCY_US: '0.40',
      GAINERS_MIN_PATH_EFFICIENCY_EU: '0.35',
      GAINERS_MIN_PATH_EFFICIENCY_CRYPTO: '0.50',
    });
    expect(o.us).toBe(0.4);
    expect(o.eu).toBe(0.35);
    expect(o.crypto).toBe(0.5);
  });

  it('valeur hors [0,1] → ignorée (undefined)', () => {
    const o = parsePerClassPathEffOverrides({
      GAINERS_MIN_PATH_EFFICIENCY_US: '1.5',
      GAINERS_MIN_PATH_EFFICIENCY_EU: '-0.1',
    });
    expect(o.us).toBeUndefined();
    expect(o.eu).toBeUndefined();
  });

  it('NaN → ignorée', () => {
    const o = parsePerClassPathEffOverrides({
      GAINERS_MIN_PATH_EFFICIENCY_US: 'abc',
    });
    expect(o.us).toBeUndefined();
  });

  it('string vide → ignorée', () => {
    const o = parsePerClassPathEffOverrides({ GAINERS_MIN_PATH_EFFICIENCY_US: '' });
    expect(o.us).toBeUndefined();
  });

  it('limites acceptées : 0 et 1', () => {
    const o = parsePerClassPathEffOverrides({
      GAINERS_MIN_PATH_EFFICIENCY_US: '0',
      GAINERS_MIN_PATH_EFFICIENCY_EU: '1',
    });
    expect(o.us).toBe(0);
    expect(o.eu).toBe(1);
  });
});

describe('resolveEffectivePathEffFloor', () => {
  const noOverrides = {};
  const overrides = { us: 0.4, eu: 0.35, crypto: 0.5 };

  it('baseFloor null → null (gate désactivé)', () => {
    expect(resolveEffectivePathEffFloor(null, 'us_equity_large', overrides, 0.1)).toBeNull();
  });

  it('asia → baseFloor + boost, JAMAIS d\'override per-class', () => {
    expect(resolveEffectivePathEffFloor(0.5, 'asia_equity', overrides, 0.1)).toBeCloseTo(0.6);
    expect(resolveEffectivePathEffFloor(0.5, 'asia_equity', noOverrides, 0.1)).toBeCloseTo(0.6);
  });

  it('asia boost clampé à 1', () => {
    expect(resolveEffectivePathEffFloor(0.95, 'asia_equity', noOverrides, 0.20)).toBe(1);
  });

  it('us_equity_large → override us si défini', () => {
    expect(resolveEffectivePathEffFloor(0.5, 'us_equity_large', overrides, 0.1)).toBe(0.4);
    expect(resolveEffectivePathEffFloor(0.5, 'us_equity_small_mid', overrides, 0.1)).toBe(0.4);
  });

  it('eu_equity → override eu si défini', () => {
    expect(resolveEffectivePathEffFloor(0.5, 'eu_equity', overrides, 0.1)).toBe(0.35);
  });

  it('crypto_major / crypto_alt → override crypto', () => {
    expect(resolveEffectivePathEffFloor(0.5, 'crypto_major', overrides, 0.1)).toBe(0.5);
    expect(resolveEffectivePathEffFloor(0.5, 'crypto_alt', overrides, 0.1)).toBe(0.5);
  });

  it('back-compat : aucun override → baseFloor préservé', () => {
    expect(resolveEffectivePathEffFloor(0.5, 'us_equity_large', noOverrides, 0.1)).toBe(0.5);
    expect(resolveEffectivePathEffFloor(0.5, 'eu_equity', noOverrides, 0.1)).toBe(0.5);
    expect(resolveEffectivePathEffFloor(0.5, 'crypto_major', noOverrides, 0.1)).toBe(0.5);
  });

  it('asset_class null/unknown → baseFloor', () => {
    expect(resolveEffectivePathEffFloor(0.5, null, overrides, 0.1)).toBe(0.5);
    expect(resolveEffectivePathEffFloor(0.5, undefined, overrides, 0.1)).toBe(0.5);
    expect(resolveEffectivePathEffFloor(0.5, 'unknown_class', overrides, 0.1)).toBe(0.5);
  });

  it('partial override : seul us défini, eu/crypto fallback baseFloor', () => {
    const partial = { us: 0.4 };
    expect(resolveEffectivePathEffFloor(0.5, 'us_equity_large', partial, 0.1)).toBe(0.4);
    expect(resolveEffectivePathEffFloor(0.5, 'eu_equity', partial, 0.1)).toBe(0.5);
    expect(resolveEffectivePathEffFloor(0.5, 'crypto_major', partial, 0.1)).toBe(0.5);
  });
});

describe('describeOverrides', () => {
  it('vide → null (rien à logger)', () => {
    expect(describeOverrides({})).toBeNull();
  });

  it('1 override → string descriptive', () => {
    expect(describeOverrides({ us: 0.4 })).toBe('us=0.4');
  });

  it('multiples → join space', () => {
    expect(describeOverrides({ us: 0.4, eu: 0.35, crypto: 0.5 })).toBe('us=0.4 eu=0.35 crypto=0.5');
  });
});
