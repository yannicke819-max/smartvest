/**
 * Bug #R10 — Tests TickerBlacklistService (statique + auto-blacklist).
 *
 * Couverture :
 *   - 9 tickers statiques `.NSE` filtrés quand env enabled (default)
 *   - Ticker inconnu non blacklisté
 *   - 3 strikes 404 en 24h → auto-blacklist
 *   - TTL expiré → unblacklist
 *   - Env disabled → static non bloqué
 *   - Bounds env (NaN, négatif, oversize → defaults)
 */

import { ConfigService } from '@nestjs/config';
import { TickerBlacklistService } from '../ticker-blacklist.service';

function makeService(env: Record<string, string> = {}): TickerBlacklistService {
  const cfg = {
    get: (key: string) => env[key],
  } as unknown as ConfigService;
  return new TickerBlacklistService(cfg);
}

describe('TickerBlacklistService', () => {
  describe('static blacklist (DEAD_NSE_TICKERS)', () => {
    it.each([
      'BHEL.NSE', 'CESC.NSE', 'GHCL.NSE', 'HEG.NSE', 'IGPL.NSE',
      'NESCO.NSE', 'NITCO.NSE', 'NOCIL.NSE', 'SOTL.NSE',
    ])('%s is blacklisted by default', (ticker) => {
      const svc = makeService();
      expect(svc.isBlacklisted(ticker)).toBe(true);
    });

    it('AAPL is not blacklisted', () => {
      const svc = makeService();
      expect(svc.isBlacklisted('AAPL')).toBe(false);
    });

    it('static disabled via env → NSE tickers NOT blacklisted', () => {
      const svc = makeService({ GAINERS_NSE_BLACKLIST_ENABLED: 'false' });
      expect(svc.isBlacklisted('BHEL.NSE')).toBe(false);
    });

    it('static explicit true → blacklisted', () => {
      const svc = makeService({ GAINERS_NSE_BLACKLIST_ENABLED: 'true' });
      expect(svc.isBlacklisted('BHEL.NSE')).toBe(true);
    });

    it('lookup is case-insensitive', () => {
      const svc = makeService();
      expect(svc.isBlacklisted('bhel.nse')).toBe(true);
      expect(svc.isBlacklisted('BhEl.NsE')).toBe(true);
    });
  });

  describe('PR #337 — asia empty-response + saigneur', () => {
    it('blackliste 222420.KQ par défaut (saigneur -$3582/30j)', () => {
      const svc = makeService();
      expect(svc.isBlacklisted('222420.KQ')).toBe(true);
    });

    it('blackliste 000500.KO par défaut (empty response permanent)', () => {
      const svc = makeService();
      expect(svc.isBlacklisted('000500.KO')).toBe(true);
    });

    it.each([
      '000500.KO', '003550.KO', '005070.KO', '005300.KO', '016360.KO',
      '093370.KO', '039830.KQ', '045390.KQ', '047770.KQ', '059120.KQ',
      '088800.KQ', '094360.KQ', '200710.KQ', '222420.KQ',
    ])('blackliste %s (case-insensitive)', (ticker) => {
      const svc = makeService();
      expect(svc.isBlacklisted(ticker)).toBe(true);
      expect(svc.isBlacklisted(ticker.toLowerCase())).toBe(true);
    });

    it('NE blackliste PAS 002900.KO (seul .KO rentable +$177/30j)', () => {
      const svc = makeService();
      expect(svc.isBlacklisted('002900.KO')).toBe(false);
    });

    it('NE blackliste PAS 005930.KO (Samsung, contrôle)', () => {
      const svc = makeService();
      expect(svc.isBlacklisted('005930.KO')).toBe(false);
    });

    it('respecte le flag GAINERS_NSE_BLACKLIST_ENABLED=false (rollback global asia + NSE)', () => {
      const svc = makeService({ GAINERS_NSE_BLACKLIST_ENABLED: 'false' });
      expect(svc.isBlacklisted('222420.KQ')).toBe(false);
      expect(svc.isBlacklisted('BHEL.NSE')).toBe(false);
      expect(svc.isBlacklisted('000500.KO')).toBe(false);
    });
  });

  describe('auto-blacklist on strikes', () => {
    it('3 strikes 404 in 24h → blacklisted', () => {
      const svc = makeService();
      const t = 'XYZ.NSE';
      svc.recordStrike(t);
      expect(svc.isBlacklisted(t)).toBe(false);
      svc.recordStrike(t);
      expect(svc.isBlacklisted(t)).toBe(false);
      svc.recordStrike(t);
      expect(svc.isBlacklisted(t)).toBe(true);
    });

    it('configurable threshold via env (5 strikes)', () => {
      const svc = makeService({ GAINERS_AUTO_BLACKLIST_404_STRIKES: '5' });
      const t = 'XYZ.LSE';
      for (let i = 0; i < 4; i++) svc.recordStrike(t);
      expect(svc.isBlacklisted(t)).toBe(false);
      svc.recordStrike(t);
      expect(svc.isBlacklisted(t)).toBe(true);
    });

    it('TTL expiry → unblacklist (24h default)', () => {
      const svc = makeService();
      const t = 'XYZ.NSE';
      const t0 = 1_700_000_000_000;
      svc.recordStrike(t, 'HTTP_404', t0);
      svc.recordStrike(t, 'HTTP_404', t0 + 1000);
      svc.recordStrike(t, 'HTTP_404', t0 + 2000);
      expect(svc.isBlacklisted(t, t0 + 3000)).toBe(true);
      // 23h plus tard → toujours blacklisté
      expect(svc.isBlacklisted(t, t0 + 23 * 3600 * 1000)).toBe(true);
      // 25h plus tard → TTL expiré
      expect(svc.isBlacklisted(t, t0 + 25 * 3600 * 1000)).toBe(false);
    });

    it('TTL configurable via env (1h)', () => {
      const svc = makeService({
        GAINERS_AUTO_BLACKLIST_TTL_HOURS: '1',
      });
      const t = 'ABC.LSE';
      const t0 = 1_700_000_000_000;
      svc.recordStrike(t, 'HTTP_404', t0);
      svc.recordStrike(t, 'HTTP_404', t0 + 1000);
      svc.recordStrike(t, 'HTTP_404', t0 + 2000);
      expect(svc.isBlacklisted(t, t0 + 30 * 60 * 1000)).toBe(true);
      expect(svc.isBlacklisted(t, t0 + 2 * 3600 * 1000)).toBe(false);
    });

    it('strikes outside 24h window are purged', () => {
      const svc = makeService();
      const t = 'OLD.LSE';
      const t0 = 1_700_000_000_000;
      // 2 strikes anciens (>24h)
      svc.recordStrike(t, 'HTTP_404', t0);
      svc.recordStrike(t, 'HTTP_404', t0 + 1000);
      // 1 strike récent → total dans fenêtre = 1, pas blacklisté
      const tNow = t0 + 25 * 3600 * 1000;
      svc.recordStrike(t, 'HTTP_404', tNow);
      expect(svc.strikeCount(t, tNow)).toBe(1);
      expect(svc.isBlacklisted(t, tNow)).toBe(false);
    });

    it('static ticker also tracked dynamically but irrelevant (already blacklisted)', () => {
      const svc = makeService();
      svc.recordStrike('BHEL.NSE');
      expect(svc.isBlacklisted('BHEL.NSE')).toBe(true);
    });
  });

  describe('bounds validation', () => {
    it('invalid GAINERS_AUTO_BLACKLIST_404_STRIKES → fallback 3', () => {
      const svc = makeService({ GAINERS_AUTO_BLACKLIST_404_STRIKES: 'abc' });
      expect(svc.getStats().strikesThreshold).toBe(3);
    });

    it('negative GAINERS_AUTO_BLACKLIST_404_STRIKES → fallback 3', () => {
      const svc = makeService({ GAINERS_AUTO_BLACKLIST_404_STRIKES: '-1' });
      expect(svc.getStats().strikesThreshold).toBe(3);
    });

    it('oversize GAINERS_AUTO_BLACKLIST_404_STRIKES → capped 100', () => {
      const svc = makeService({ GAINERS_AUTO_BLACKLIST_404_STRIKES: '99999' });
      expect(svc.getStats().strikesThreshold).toBe(100);
    });

    it('invalid GAINERS_AUTO_BLACKLIST_TTL_HOURS → fallback 24', () => {
      const svc = makeService({ GAINERS_AUTO_BLACKLIST_TTL_HOURS: 'abc' });
      expect(svc.getStats().ttlHours).toBe(24);
    });

    it('negative GAINERS_AUTO_BLACKLIST_TTL_HOURS → fallback 24', () => {
      const svc = makeService({ GAINERS_AUTO_BLACKLIST_TTL_HOURS: '-5' });
      expect(svc.getStats().ttlHours).toBe(24);
    });

    it('oversize GAINERS_AUTO_BLACKLIST_TTL_HOURS → capped 2 weeks', () => {
      const svc = makeService({ GAINERS_AUTO_BLACKLIST_TTL_HOURS: '100000' });
      expect(svc.getStats().ttlHours).toBe(24 * 14);
    });
  });

  describe('getStats', () => {
    it('reports static + dynamic counts', () => {
      const svc = makeService();
      const t0 = Date.now();
      const stats = svc.getStats();
      expect(stats.staticEnabled).toBe(true);
      expect(stats.staticSize).toBe(63); // PR #337 (23) + PR #355 (31) + PR #363 (9)
      expect(stats.dynamicCount).toBe(0);

      // Add a dynamic blacklist
      svc.recordStrike('XYZ.LSE', 'HTTP_404', t0);
      svc.recordStrike('XYZ.LSE', 'HTTP_404', t0 + 1);
      svc.recordStrike('XYZ.LSE', 'HTTP_404', t0 + 2);
      expect(svc.getStats().dynamicCount).toBe(1);
    });
  });

  describe('clear()', () => {
    it('purges all dynamic records', () => {
      const svc = makeService();
      svc.recordStrike('A.LSE');
      svc.recordStrike('A.LSE');
      svc.recordStrike('A.LSE');
      expect(svc.isBlacklisted('A.LSE')).toBe(true);
      svc.clear();
      expect(svc.isBlacklisted('A.LSE')).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // PR #355 — recordStrike supporte HTTP_200_EMPTY (fix R10 silent)
  //
  // Avant : recordStrike fire uniquement sur HTTP 404 strict côté
  // eodhd-intraday.service.ts:329. Les tickers asia/EU qui retournent
  // 200 + body vide (~80% des cas réels) ne déclenchaient jamais le
  // compteur. Désormais l'empty-response 200 fire aussi via reason
  // 'HTTP_200_EMPTY'.
  // ─────────────────────────────────────────────────────────────────────
  describe('PR #355 — recordStrike sur HTTP_200_EMPTY', () => {
    it('3 strikes HTTP_200_EMPTY → ticker blacklisté', () => {
      const svc = makeService();
      const t0 = Date.now();
      svc.recordStrike('FOO.KQ', 'HTTP_200_EMPTY', t0);
      svc.recordStrike('FOO.KQ', 'HTTP_200_EMPTY', t0 + 1);
      svc.recordStrike('FOO.KQ', 'HTTP_200_EMPTY', t0 + 2);
      expect(svc.isBlacklisted('FOO.KQ', t0 + 3)).toBe(true);
    });

    it('mix HTTP_404 + HTTP_200_EMPTY compte ensemble', () => {
      const svc = makeService();
      const t0 = Date.now();
      svc.recordStrike('BAR.KO', 'HTTP_404', t0);
      svc.recordStrike('BAR.KO', 'HTTP_200_EMPTY', t0 + 1);
      svc.recordStrike('BAR.KO', 'HTTP_404', t0 + 2);
      expect(svc.isBlacklisted('BAR.KO', t0 + 3)).toBe(true);
    });
  });
});
