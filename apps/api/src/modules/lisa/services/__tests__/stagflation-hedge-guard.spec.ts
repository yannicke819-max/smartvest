import {
  parseStagflationHedgeGuardConfig,
  shouldSkipStagflationHedge,
  DEFAULT_STAGFLATION_HEDGE_LIST,
} from '../stagflation-hedge-guard.helper';

describe('stagflation-hedge-guard', () => {
  describe('parseStagflationHedgeGuardConfig', () => {
    it('default OFF (back-compat) — env vide → enabled=false', () => {
      const cfg = parseStagflationHedgeGuardConfig({});
      expect(cfg.enabled).toBe(false);
      expect(cfg.tickers.size).toBe(DEFAULT_STAGFLATION_HEDGE_LIST.length);
    });

    it('ENABLED=true → enabled=true avec liste par défaut', () => {
      const cfg = parseStagflationHedgeGuardConfig({ STAGFLATION_HEDGE_GUARD_ENABLED: 'true' });
      expect(cfg.enabled).toBe(true);
      expect(cfg.tickers.has('GDX.US')).toBe(true);
      expect(cfg.tickers.has('SLV.US')).toBe(true);
      expect(cfg.tickers.has('URA.US')).toBe(false); // URA pas dans liste par défaut
    });

    it('ENABLED=false explicite → enabled=false', () => {
      const cfg = parseStagflationHedgeGuardConfig({ STAGFLATION_HEDGE_GUARD_ENABLED: 'false' });
      expect(cfg.enabled).toBe(false);
    });

    it('case-insensitive sur la valeur ENABLED', () => {
      expect(parseStagflationHedgeGuardConfig({ STAGFLATION_HEDGE_GUARD_ENABLED: 'TRUE' }).enabled).toBe(true);
      expect(parseStagflationHedgeGuardConfig({ STAGFLATION_HEDGE_GUARD_ENABLED: 'True' }).enabled).toBe(true);
    });

    it('TICKERS override CSV remplace la liste par défaut', () => {
      const cfg = parseStagflationHedgeGuardConfig({
        STAGFLATION_HEDGE_GUARD_ENABLED: 'true',
        STAGFLATION_HEDGE_GUARD_TICKERS: 'URA.US,PPLT.US,CPER.US',
      });
      expect(cfg.tickers.size).toBe(3);
      expect(cfg.tickers.has('URA.US')).toBe(true);
      expect(cfg.tickers.has('GDX.US')).toBe(false); // sortie de l'override
    });

    it('TICKERS CSV avec espaces/casse mixte normalisé en uppercase', () => {
      const cfg = parseStagflationHedgeGuardConfig({
        STAGFLATION_HEDGE_GUARD_ENABLED: 'true',
        STAGFLATION_HEDGE_GUARD_TICKERS: ' gdx.us , slv.us , GOLD.us ',
      });
      expect(cfg.tickers.has('GDX.US')).toBe(true);
      expect(cfg.tickers.has('SLV.US')).toBe(true);
      expect(cfg.tickers.has('GOLD.US')).toBe(true);
    });

    it('TICKERS CSV vide ou whitespace → fallback liste par défaut', () => {
      const cfg = parseStagflationHedgeGuardConfig({
        STAGFLATION_HEDGE_GUARD_ENABLED: 'true',
        STAGFLATION_HEDGE_GUARD_TICKERS: '',
      });
      // chaîne vide → fallback default
      expect(cfg.tickers.size).toBe(DEFAULT_STAGFLATION_HEDGE_LIST.length);
    });
  });

  describe('shouldSkipStagflationHedge', () => {
    it('OFF → toujours false (no-op)', () => {
      const cfg = parseStagflationHedgeGuardConfig({});
      expect(shouldSkipStagflationHedge('GDX.US', cfg)).toBe(false);
      expect(shouldSkipStagflationHedge('AAPL.US', cfg)).toBe(false);
    });

    it('ON + ticker IN liste → true (skip)', () => {
      const cfg = parseStagflationHedgeGuardConfig({ STAGFLATION_HEDGE_GUARD_ENABLED: 'true' });
      expect(shouldSkipStagflationHedge('GDX.US', cfg)).toBe(true);
      expect(shouldSkipStagflationHedge('SLV.US', cfg)).toBe(true);
      expect(shouldSkipStagflationHedge('XLE.US', cfg)).toBe(true);
      expect(shouldSkipStagflationHedge('TLT.US', cfg)).toBe(true);
    });

    it('ON + ticker NOT IN liste → false (passe)', () => {
      const cfg = parseStagflationHedgeGuardConfig({ STAGFLATION_HEDGE_GUARD_ENABLED: 'true' });
      expect(shouldSkipStagflationHedge('AAPL.US', cfg)).toBe(false);
      expect(shouldSkipStagflationHedge('NVDA.US', cfg)).toBe(false);
      expect(shouldSkipStagflationHedge('BTCUSDT', cfg)).toBe(false);
    });

    it('case-insensitive sur le symbol input', () => {
      const cfg = parseStagflationHedgeGuardConfig({ STAGFLATION_HEDGE_GUARD_ENABLED: 'true' });
      expect(shouldSkipStagflationHedge('gdx.us', cfg)).toBe(true);
      expect(shouldSkipStagflationHedge('Gdx.Us', cfg)).toBe(true);
    });
  });
});
