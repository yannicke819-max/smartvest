/**
 * PR A — Gate horaire LONG.
 *
 * Data mining 23/05/2026 (n=7000 signaux 15j) :
 *   - LONG mean par heure UTC : H8=-0.60% / H19=-1.01% / H22=-0.93% / H0-5≈-0.5%
 *   - LONG mean H13-17 (US active) : neutre à +0.27% (sweet spot)
 *   - Pertes évitées estimées ~$2 200/15j si gate bien calibré
 *
 * Logique pure extraite pour testabilité indépendante du scanner monolithique.
 */

interface Cand { symbol: string; assetClass: string; }

function shouldRejectByHourGate(
  cand: Cand,
  hourUtc: number,
  env: {
    whitelist?: string;
    blacklist?: string;
    cryptoGated?: boolean;
  },
): { rejected: boolean; reason?: 'whitelist' | 'blacklist' } {
  const whitelistRaw = (env.whitelist ?? '').trim();
  const blacklistRaw = (env.blacklist ?? '').trim();
  const cryptoGated = env.cryptoGated ?? false;
  const isCrypto = cand.assetClass === 'crypto_major' || cand.assetClass === 'crypto_alt';

  // Aucune config = pas de gate (back-compat)
  if (whitelistRaw.length === 0 && blacklistRaw.length === 0) return { rejected: false };

  // Crypto exempt par défaut
  if (isCrypto && !cryptoGated) return { rejected: false };

  const parseList = (s: string): Set<number> => {
    if (s.length === 0) return new Set();
    return new Set(
      s.split(',').map((x) => x.trim()).filter((x) => x.length > 0)
        .map((x) => Number(x)).filter((n) => Number.isFinite(n) && n >= 0 && n <= 23),
    );
  };
  const whitelist = parseList(whitelistRaw);
  const blacklist = parseList(blacklistRaw);

  // Whitelist prend précédence
  if (whitelist.size > 0) {
    return whitelist.has(hourUtc) ? { rejected: false } : { rejected: true, reason: 'whitelist' };
  }
  if (blacklist.size > 0 && blacklist.has(hourUtc)) {
    return { rejected: true, reason: 'blacklist' };
  }
  return { rejected: false };
}

describe('PR A — gate horaire LONG (reject_hour_blacklisted / reject_hour_not_whitelisted)', () => {
  const us = { symbol: 'AAP.US', assetClass: 'us_equity_small_mid' };
  const usLarge = { symbol: 'TSLA.US', assetClass: 'us_equity_large' };
  const eu = { symbol: 'BARC.LSE', assetClass: 'eu_equity' };
  const asia = { symbol: '005930.KO', assetClass: 'asia_equity' };
  const cryptoMajor = { symbol: 'BTCUSDT', assetClass: 'crypto_major' };
  const cryptoAlt = { symbol: 'POLUSDT', assetClass: 'crypto_alt' };

  describe('back-compat — aucune config = aucun gate', () => {
    it('toutes heures passent quand whitelist + blacklist vides', () => {
      for (const h of [0, 8, 13, 19, 23]) {
        expect(shouldRejectByHourGate(us, h, {}).rejected).toBe(false);
      }
    });
  });

  describe('whitelist (recommandée — sweet spot LONG)', () => {
    const env = { whitelist: '13,14,15,16,17' };
    it('H13-H17 passent', () => {
      for (const h of [13, 14, 15, 16, 17]) {
        expect(shouldRejectByHourGate(us, h, env).rejected).toBe(false);
      }
    });
    it('H0-H12 + H18-H23 rejetés (reason=whitelist)', () => {
      for (const h of [0, 1, 5, 8, 12, 18, 19, 22, 23]) {
        const r = shouldRejectByHourGate(us, h, env);
        expect(r.rejected).toBe(true);
        expect(r.reason).toBe('whitelist');
      }
    });
  });

  describe('blacklist (alternative — bloquer juste les pires)', () => {
    const env = { blacklist: '8,19,22,23,0,1,2,3,4' };
    it('heures blacklistées rejetées (reason=blacklist)', () => {
      for (const h of [0, 1, 2, 3, 4, 8, 19, 22, 23]) {
        const r = shouldRejectByHourGate(us, h, env);
        expect(r.rejected).toBe(true);
        expect(r.reason).toBe('blacklist');
      }
    });
    it('autres heures passent', () => {
      for (const h of [5, 6, 7, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 20, 21]) {
        expect(shouldRejectByHourGate(us, h, env).rejected).toBe(false);
      }
    });
  });

  describe('whitelist prend précédence sur blacklist', () => {
    const env = { whitelist: '13,14,15', blacklist: '13' };
    it('H13 dans whitelist → passe (blacklist ignorée)', () => {
      expect(shouldRejectByHourGate(us, 13, env).rejected).toBe(false);
    });
    it('H10 hors whitelist → rejeté (reason=whitelist)', () => {
      expect(shouldRejectByHourGate(us, 10, env).reason).toBe('whitelist');
    });
  });

  describe('crypto exempt par défaut (24/7)', () => {
    const env = { blacklist: '8,19,22' };
    it('crypto_major passe à toute heure', () => {
      for (const h of [0, 8, 19, 22]) {
        expect(shouldRejectByHourGate(cryptoMajor, h, env).rejected).toBe(false);
      }
    });
    it('crypto_alt passe à toute heure', () => {
      expect(shouldRejectByHourGate(cryptoAlt, 22, env).rejected).toBe(false);
    });
    it('equity reste gaté', () => {
      expect(shouldRejectByHourGate(us, 22, env).rejected).toBe(true);
      expect(shouldRejectByHourGate(eu, 8, env).rejected).toBe(true);
      expect(shouldRejectByHourGate(asia, 19, env).rejected).toBe(true);
      expect(shouldRejectByHourGate(usLarge, 22, env).rejected).toBe(true);
    });
  });

  describe('crypto gaté si flag explicit', () => {
    const env = { blacklist: '8,19,22', cryptoGated: true };
    it('crypto_major rejeté sur heures blacklistées', () => {
      expect(shouldRejectByHourGate(cryptoMajor, 22, env).rejected).toBe(true);
    });
  });

  describe('tolérance parsing entrées malformées', () => {
    it('ignore tokens non-numériques + valeurs hors [0,23]', () => {
      const env = { whitelist: '13, x, 14, 99, -1, 15.7, 15 ' };
      expect(shouldRejectByHourGate(us, 13, env).rejected).toBe(false);
      expect(shouldRejectByHourGate(us, 14, env).rejected).toBe(false);
      expect(shouldRejectByHourGate(us, 15, env).rejected).toBe(false);
      // 99 / -1 / 'x' ignorés → 12 hors whitelist → rejeté
      expect(shouldRejectByHourGate(us, 12, env).rejected).toBe(true);
    });
  });
});
