import {
  parseHoursCsv,
  parsePerClassHourBlacklist,
  shouldSkipByPerClassHourGate,
  parseTickerSizeMultCsv,
  getTickerSizeMultiplier,
} from '../data-driven-gates.helper';

describe('parseHoursCsv', () => {
  it('vide → Set vide', () => {
    expect(parseHoursCsv('').size).toBe(0);
    expect(parseHoursCsv(undefined).size).toBe(0);
    expect(parseHoursCsv('   ').size).toBe(0);
  });

  it('CSV simple "0,1,2" → Set{0,1,2}', () => {
    const s = parseHoursCsv('0,1,2');
    expect([...s].sort()).toEqual([0, 1, 2]);
  });

  it('tolère espaces et duplicates', () => {
    const s = parseHoursCsv(' 0 , 1, 1, 2 , 0 ');
    expect([...s].sort()).toEqual([0, 1, 2]);
  });

  it('rejette heures hors [0,23]', () => {
    const s = parseHoursCsv('0,24,-1,99,17');
    expect([...s].sort()).toEqual([0, 17]);
  });

  it('rejette tokens non-numériques', () => {
    const s = parseHoursCsv('0,abc,1.5,17');
    // "1.5" matche pas la regex \d+, donc rejeté
    expect([...s].sort()).toEqual([0, 17]);
  });
});

describe('parsePerClassHourBlacklist', () => {
  it('env vide → toutes classes Set vide', () => {
    const cfg = parsePerClassHourBlacklist({});
    expect(cfg.asia_equity.size).toBe(0);
    expect(cfg.us_equity_large.size).toBe(0);
    expect(cfg.us_equity_small_mid.size).toBe(0);
    expect(cfg.eu_equity.size).toBe(0);
    expect(cfg.crypto_major.size).toBe(0);
  });

  it('US env → applique aux 2 classes us_equity_*', () => {
    const cfg = parsePerClassHourBlacklist({ GAINERS_HOUR_BLACKLIST_US_UTC: '17,18' });
    expect([...cfg.us_equity_large].sort()).toEqual([17, 18]);
    expect([...cfg.us_equity_small_mid].sort()).toEqual([17, 18]);
    expect(cfg.asia_equity.size).toBe(0);
  });

  it('Crypto env → applique aux 2 classes crypto_*', () => {
    const cfg = parsePerClassHourBlacklist({ GAINERS_HOUR_BLACKLIST_CRYPTO_UTC: '3,4' });
    expect([...cfg.crypto_major].sort()).toEqual([3, 4]);
    expect([...cfg.crypto_alt].sort()).toEqual([3, 4]);
  });

  it('asia uniquement (recommandation audit)', () => {
    const cfg = parsePerClassHourBlacklist({ GAINERS_HOUR_BLACKLIST_ASIA_UTC: '0,1,2' });
    expect([...cfg.asia_equity].sort()).toEqual([0, 1, 2]);
    expect(cfg.us_equity_large.size).toBe(0);
    expect(cfg.eu_equity.size).toBe(0);
  });
});

describe('shouldSkipByPerClassHourGate', () => {
  const cfg = parsePerClassHourBlacklist({
    GAINERS_HOUR_BLACKLIST_ASIA_UTC: '0,1,2',
    GAINERS_HOUR_BLACKLIST_US_UTC: '17,18',
  });

  it('asia_equity @ H00 → skip', () => {
    expect(shouldSkipByPerClassHourGate('asia_equity', 0, cfg)).toBe(true);
    expect(shouldSkipByPerClassHourGate('asia_equity', 2, cfg)).toBe(true);
  });

  it('asia_equity @ H06 → PASSE', () => {
    expect(shouldSkipByPerClassHourGate('asia_equity', 6, cfg)).toBe(false);
  });

  it('us_equity_large @ H17 → skip', () => {
    expect(shouldSkipByPerClassHourGate('us_equity_large', 17, cfg)).toBe(true);
  });

  it('us_equity_small_mid @ H18 → skip (même config US)', () => {
    expect(shouldSkipByPerClassHourGate('us_equity_small_mid', 18, cfg)).toBe(true);
  });

  it('us_equity_large @ H00 → PASSE (asia blacklist ne s applique pas à US)', () => {
    expect(shouldSkipByPerClassHourGate('us_equity_large', 0, cfg)).toBe(false);
  });

  it('eu_equity @ H00 → PASSE (eu non configuré)', () => {
    expect(shouldSkipByPerClassHourGate('eu_equity', 0, cfg)).toBe(false);
  });

  it('asset_class inconnu → PASSE (fail-safe)', () => {
    expect(shouldSkipByPerClassHourGate('unknown_class', 0, cfg)).toBe(false);
  });
});

describe('parseTickerSizeMultCsv', () => {
  it('vide → map vide', () => {
    expect(parseTickerSizeMultCsv('').multipliers.size).toBe(0);
    expect(parseTickerSizeMultCsv(undefined).multipliers.size).toBe(0);
  });

  it('format simple', () => {
    const c = parseTickerSizeMultCsv('AAPL.US:1.5,GOOGL.US:1.2');
    expect(c.multipliers.get('AAPL.US')).toBe(1.5);
    expect(c.multipliers.get('GOOGL.US')).toBe(1.2);
  });

  it('uppercase normalize', () => {
    const c = parseTickerSizeMultCsv('aapl.us:1.5');
    expect(c.multipliers.get('AAPL.US')).toBe(1.5);
  });

  it('clamp mult < 0.1 et > 3.0', () => {
    const c = parseTickerSizeMultCsv('TICK1:0.05,TICK2:5.0,TICK3:1.5');
    expect(c.multipliers.has('TICK1')).toBe(false);
    expect(c.multipliers.has('TICK2')).toBe(false);
    expect(c.multipliers.get('TICK3')).toBe(1.5);
  });

  it('rejette format invalide silencieusement', () => {
    const c = parseTickerSizeMultCsv('TICK1,TICK2:abc,TICK3:1.5');
    expect(c.multipliers.size).toBe(1);
    expect(c.multipliers.get('TICK3')).toBe(1.5);
  });

  it('arrondi 2 décimales', () => {
    const c = parseTickerSizeMultCsv('TICK:1.234');
    expect(c.multipliers.get('TICK')).toBe(1.23);
  });
});

describe('getTickerSizeMultiplier', () => {
  const cfg = parseTickerSizeMultCsv('067170.KQ:1.5,AMS.SW:1.5,LAMR.US:1.3');

  it('match → mult', () => {
    expect(getTickerSizeMultiplier('067170.KQ', cfg)).toBe(1.5);
    expect(getTickerSizeMultiplier('AMS.SW', cfg)).toBe(1.5);
    expect(getTickerSizeMultiplier('LAMR.US', cfg)).toBe(1.3);
  });

  it('case-insensitive', () => {
    expect(getTickerSizeMultiplier('ams.sw', cfg)).toBe(1.5);
    expect(getTickerSizeMultiplier('Lamr.Us', cfg)).toBe(1.3);
  });

  it('non-match → 1.0 (no-op default)', () => {
    expect(getTickerSizeMultiplier('AAPL.US', cfg)).toBe(1.0);
    expect(getTickerSizeMultiplier('UNKNOWN', cfg)).toBe(1.0);
  });
});
