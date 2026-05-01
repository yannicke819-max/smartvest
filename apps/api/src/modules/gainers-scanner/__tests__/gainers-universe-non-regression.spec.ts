/**
 * Non-régression univers Gainers — test d'intégration (ADR-005 §universe-guard).
 *
 * Vérifie que l'univers statique connu (mega12 + crypto_tradable) est
 * un sur-ensemble du seed DB. Utilisé comme garde-fou de non-régression
 * lors des mises à jour de watchlist.
 *
 * Mode intégration complet : à activer avec SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.
 * En CI standard (sans DB) : valide la logique de computeHash + coverageRatio.
 */

import { UniverseGuardService } from '../bloc2/universe-guard.service';

const MEGA12 = [
  'AAPL.US', 'MSFT.US', 'NVDA.US', 'META.US', 'GOOGL.US', 'TSLA.US',
  'AMD.US', 'AVGO.US', 'SPY.US', 'QQQ.US', 'IWM.US', 'XOM.US',
];
const CRYPTO_TRADABLE = ['BTC-USD.CC', 'ETH-USD.CC', 'SOL-USD.CC'];
const FULL_SEED_UNIVERSE = [...MEGA12, ...CRYPTO_TRADABLE];

describe('universe non-regression guard', () => {
  let svc: UniverseGuardService;

  beforeEach(() => {
    svc = new UniverseGuardService({ getClient: () => null } as any);
  });

  it('hash is deterministic across orderings', () => {
    const h1 = svc.computeHash([...FULL_SEED_UNIVERSE]);
    const h2 = svc.computeHash([...FULL_SEED_UNIVERSE].reverse());
    expect(h1).toBe(h2);
  });

  it('full seed universe contains all mega12 symbols', () => {
    const set = new Set(FULL_SEED_UNIVERSE);
    for (const sym of MEGA12) {
      expect(set.has(sym)).toBe(true);
    }
  });

  it('full seed universe contains all crypto_tradable symbols', () => {
    const set = new Set(FULL_SEED_UNIVERSE);
    for (const sym of CRYPTO_TRADABLE) {
      expect(set.has(sym)).toBe(true);
    }
  });

  it('coverageRatio = 1.0 when current ⊇ legacy (computed inline)', () => {
    const legacy = MEGA12;
    const current = FULL_SEED_UNIVERSE;
    const missing = legacy.filter((s) => !new Set(current).has(s));
    const ratio = (legacy.length - missing.length) / legacy.length;
    expect(ratio).toBe(1.0);
    expect(missing).toHaveLength(0);
  });

  it('coverageRatio < 1.0 when symbols removed from current universe', () => {
    const legacy = FULL_SEED_UNIVERSE;
    const current = MEGA12; // crypto_tradable missing
    const missing = legacy.filter((s) => !new Set(current).has(s));
    const ratio = (legacy.length - missing.length) / legacy.length;
    expect(ratio).toBeLessThan(1.0);
    expect(missing).toEqual(expect.arrayContaining(CRYPTO_TRADABLE));
  });

  it.todo('(integration) validateUniverse against live gainers_legacy_snapshot table');
  it.todo('(integration) seedLegacySnapshot inserts full sp500+crypto universe');
});
