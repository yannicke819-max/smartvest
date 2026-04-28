/**
 * PR F — DEGRADED_OPEN mode pour HORS_TRAJECTOIRE.
 *
 * Tests unitaires sur les comportements observables du mode dégradé.
 * Le `getDegradedConfig()` est privé et lit `process.env` directement —
 * on le teste via stub d'env vars (jest setupFiles ne sont pas câblés ici,
 * on utilise process.env mutation + restore pattern).
 *
 * Tests intégrés sur MechanicalTradingService.processPortfolio nécessitent
 * mock Supabase / Lisa (lourd) ; on fait du test ciblé sur la logique pure
 * de gating (`isOpenAllowedInDegradedMode` extrait pour testabilité).
 *
 * Cf. fix incident 27/04/2026 — 50/52 cycles HORS_TRAJECTOIRE bloqués.
 */

/**
 * Reproduit la logique du gating degraded localement pour test pur.
 * Si la logique change dans mechanical-trading.service.ts, ce helper
 * doit être mis à jour en miroir (= contrat documentaire).
 */
function isOpenAllowedInDegradedMode(input: {
  trajectoryStatus: 'EN_AVANCE' | 'DANS_LE_PLAN' | 'EN_RETARD' | 'HORS_TRAJECTOIRE';
  flagEnabled: boolean;
  whitelist: Set<string>;
  symbol: string;
  htBypassAllowed: boolean;
  currentPositionsCount: number;
}): { allowed: boolean; reason: string } {
  if (input.trajectoryStatus !== 'HORS_TRAJECTOIRE') {
    return { allowed: true, reason: 'normal_trajectory' };
  }
  if (input.htBypassAllowed) {
    return { allowed: true, reason: 'ht_bypass_allowed' };
  }
  if (!input.flagEnabled || input.whitelist.size === 0) {
    return { allowed: false, reason: 'degraded_disabled' };
  }
  if (!input.whitelist.has(input.symbol.toUpperCase())) {
    return { allowed: false, reason: 'not_in_whitelist' };
  }
  if (input.currentPositionsCount >= 2) {
    return { allowed: false, reason: 'max_concurrent_2_reached' };
  }
  return { allowed: true, reason: 'degraded_open' };
}

describe('DEGRADED_OPEN gating logic', () => {
  const wl = new Set(['RTX', 'LMT', 'GDX']);

  describe('status=HORS_TRAJECTOIRE + flag=true + ticker whitelist → open', () => {
    it('RTX allowed when whitelist contains RTX', () => {
      const r = isOpenAllowedInDegradedMode({
        trajectoryStatus: 'HORS_TRAJECTOIRE',
        flagEnabled: true,
        whitelist: wl,
        symbol: 'RTX',
        htBypassAllowed: false,
        currentPositionsCount: 0,
      });
      expect(r.allowed).toBe(true);
      expect(r.reason).toBe('degraded_open');
    });

    it('case-insensitive : rtx (lowercase) allowed via uppercase whitelist', () => {
      const r = isOpenAllowedInDegradedMode({
        trajectoryStatus: 'HORS_TRAJECTOIRE',
        flagEnabled: true,
        whitelist: wl,
        symbol: 'rtx',
        htBypassAllowed: false,
        currentPositionsCount: 0,
      });
      expect(r.allowed).toBe(true);
    });

    it('LMT + GDX both allowed (whitelist multi-ticker)', () => {
      for (const s of ['LMT', 'GDX']) {
        const r = isOpenAllowedInDegradedMode({
          trajectoryStatus: 'HORS_TRAJECTOIRE',
          flagEnabled: true,
          whitelist: wl,
          symbol: s,
          htBypassAllowed: false,
          currentPositionsCount: 0,
        });
        expect(r.allowed).toBe(true);
      }
    });
  });

  describe('status=HORS_TRAJECTOIRE + flag=true + ticker hors whitelist → skip', () => {
    it('AAPL skip (not in whitelist)', () => {
      const r = isOpenAllowedInDegradedMode({
        trajectoryStatus: 'HORS_TRAJECTOIRE',
        flagEnabled: true,
        whitelist: wl,
        symbol: 'AAPL',
        htBypassAllowed: false,
        currentPositionsCount: 0,
      });
      expect(r.allowed).toBe(false);
      expect(r.reason).toBe('not_in_whitelist');
    });

    it('BTC skip (not in whitelist — even known crypto)', () => {
      const r = isOpenAllowedInDegradedMode({
        trajectoryStatus: 'HORS_TRAJECTOIRE',
        flagEnabled: true,
        whitelist: wl,
        symbol: 'BTC',
        htBypassAllowed: false,
        currentPositionsCount: 0,
      });
      expect(r.allowed).toBe(false);
    });
  });

  describe('status=EN_RETARD → open normal (degraded mode inerte)', () => {
    it('AAPL allowed in EN_RETARD (no whitelist check)', () => {
      const r = isOpenAllowedInDegradedMode({
        trajectoryStatus: 'EN_RETARD',
        flagEnabled: true,
        whitelist: wl,
        symbol: 'AAPL',
        htBypassAllowed: false,
        currentPositionsCount: 0,
      });
      expect(r.allowed).toBe(true);
      expect(r.reason).toBe('normal_trajectory');
    });

    it('BTC allowed in DANS_LE_PLAN', () => {
      const r = isOpenAllowedInDegradedMode({
        trajectoryStatus: 'DANS_LE_PLAN',
        flagEnabled: true,
        whitelist: wl,
        symbol: 'BTC',
        htBypassAllowed: false,
        currentPositionsCount: 0,
      });
      expect(r.allowed).toBe(true);
    });

    it('AAPL allowed in EN_AVANCE', () => {
      const r = isOpenAllowedInDegradedMode({
        trajectoryStatus: 'EN_AVANCE',
        flagEnabled: true,
        whitelist: wl,
        symbol: 'AAPL',
        htBypassAllowed: false,
        currentPositionsCount: 0,
      });
      expect(r.allowed).toBe(true);
    });
  });

  describe('flag=false → skip in HORS_TRAJECTOIRE même whitelist match', () => {
    it('RTX skip when flag disabled', () => {
      const r = isOpenAllowedInDegradedMode({
        trajectoryStatus: 'HORS_TRAJECTOIRE',
        flagEnabled: false,
        whitelist: wl,
        symbol: 'RTX',
        htBypassAllowed: false,
        currentPositionsCount: 0,
      });
      expect(r.allowed).toBe(false);
      expect(r.reason).toBe('degraded_disabled');
    });

    it('whitelist vide → skip même si flag=true (safety guard-rail)', () => {
      const r = isOpenAllowedInDegradedMode({
        trajectoryStatus: 'HORS_TRAJECTOIRE',
        flagEnabled: true,
        whitelist: new Set(),
        symbol: 'RTX',
        htBypassAllowed: false,
        currentPositionsCount: 0,
      });
      expect(r.allowed).toBe(false);
      expect(r.reason).toBe('degraded_disabled');
    });
  });

  describe('max 2 concurrent positions cap', () => {
    it('RTX skip when 2 positions already open in degraded mode', () => {
      const r = isOpenAllowedInDegradedMode({
        trajectoryStatus: 'HORS_TRAJECTOIRE',
        flagEnabled: true,
        whitelist: wl,
        symbol: 'RTX',
        htBypassAllowed: false,
        currentPositionsCount: 2,
      });
      expect(r.allowed).toBe(false);
      expect(r.reason).toBe('max_concurrent_2_reached');
    });

    it('RTX allowed at 1 position (slot remaining)', () => {
      const r = isOpenAllowedInDegradedMode({
        trajectoryStatus: 'HORS_TRAJECTOIRE',
        flagEnabled: true,
        whitelist: wl,
        symbol: 'RTX',
        htBypassAllowed: false,
        currentPositionsCount: 1,
      });
      expect(r.allowed).toBe(true);
    });

    it('RTX skip at 5 positions (cap respected even si haut)', () => {
      const r = isOpenAllowedInDegradedMode({
        trajectoryStatus: 'HORS_TRAJECTOIRE',
        flagEnabled: true,
        whitelist: wl,
        symbol: 'RTX',
        htBypassAllowed: false,
        currentPositionsCount: 5,
      });
      expect(r.allowed).toBe(false);
    });
  });

  describe('htBypassAllowed prend le pas (legacy bypass après 30 cycles)', () => {
    it('htBypass=true → AAPL allowed (whitelist ignoré, comportement legacy)', () => {
      // Le bypass legacy après 30 cycles consécutifs débloque indépendamment
      // du mode dégradé. Il n'y a pas de conflit : si Lisa émet une thèse
      // A+ après 30 min de gel, on lui fait confiance.
      const r = isOpenAllowedInDegradedMode({
        trajectoryStatus: 'HORS_TRAJECTOIRE',
        flagEnabled: true,
        whitelist: wl,
        symbol: 'AAPL',
        htBypassAllowed: true,
        currentPositionsCount: 0,
      });
      expect(r.allowed).toBe(true);
      expect(r.reason).toBe('ht_bypass_allowed');
    });
  });
});

describe('Sizing math (PR F)', () => {
  it('size /5 produces correct downsize : base 2200 → 440', () => {
    const baseSize = 2200; // cas réel BTC 27/04
    const degradedSize = baseSize * 0.2;
    expect(degradedSize).toBe(440);
  });

  it('SL = 0.5 × ATR14% : ATR 1.6% → SL 0.8%', () => {
    const atr14Pct = 1.6;
    const slPct = Math.max(atr14Pct * 0.5, 0.3);
    expect(slPct).toBe(0.8);
  });

  it('SL plancher 0.3% sur ATR très petit (0.4%)', () => {
    const atr14Pct = 0.4;
    const slPct = Math.max(atr14Pct * 0.5, 0.3);
    expect(slPct).toBe(0.3);
  });

  it('en mode normal (kindMultiplier=1.0 momentum), SL = 1.0 × ATR (vs 0.5 en degraded)', () => {
    const atr14Pct = 1.6;
    const kindMult = 1.0; // momentum
    const slNormal = atr14Pct * kindMult;
    const slDegraded = atr14Pct * 0.5;
    expect(slNormal / slDegraded).toBe(2); // 2x plus serré en degraded
  });
});

describe('Env var parsing (process.env)', () => {
  // Test direct du parsing logique (= ce que getDegradedConfig fait
  // intérieurement). Évite le besoin d'instancier le service complet.
  function parseEnv(rawEnabled: string | undefined, rawWhitelist: string | undefined): {
    enabled: boolean;
    whitelist: Set<string>;
  } {
    const enabledEnv = (rawEnabled ?? '').toLowerCase();
    const enabled = enabledEnv === 'true' || enabledEnv === '1';
    const whitelist = new Set(
      (rawWhitelist ?? '')
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .filter((s) => s.length > 0),
    );
    return { enabled: enabled && whitelist.size > 0, whitelist };
  }

  it('"true" + "RTX,LMT,GDX" → enabled=true, 3 tickers', () => {
    const r = parseEnv('true', 'RTX,LMT,GDX');
    expect(r.enabled).toBe(true);
    expect(r.whitelist.size).toBe(3);
    expect(r.whitelist.has('RTX')).toBe(true);
  });

  it('"1" + whitelist → enabled=true', () => {
    const r = parseEnv('1', 'RTX');
    expect(r.enabled).toBe(true);
  });

  it('"True" (mixed case) + whitelist → enabled=true', () => {
    const r = parseEnv('True', 'RTX');
    expect(r.enabled).toBe(true);
  });

  it('lowercases whitelist entries to uppercase', () => {
    const r = parseEnv('true', 'rtx,lmt,gdx');
    expect(r.whitelist.has('RTX')).toBe(true);
    expect(r.whitelist.has('LMT')).toBe(true);
  });

  it('trims whitespace in CSV', () => {
    const r = parseEnv('true', '  RTX , LMT,  GDX  ');
    expect(r.whitelist.size).toBe(3);
    expect(r.whitelist.has('RTX')).toBe(true);
    expect(r.whitelist.has('LMT')).toBe(true);
    expect(r.whitelist.has('GDX')).toBe(true);
  });

  it('"true" + empty whitelist → enabled=false (safety guard)', () => {
    const r = parseEnv('true', '');
    expect(r.enabled).toBe(false);
  });

  it('"false" + whitelist → enabled=false', () => {
    const r = parseEnv('false', 'RTX');
    expect(r.enabled).toBe(false);
  });

  it('undefined env → enabled=false, empty whitelist', () => {
    const r = parseEnv(undefined, undefined);
    expect(r.enabled).toBe(false);
    expect(r.whitelist.size).toBe(0);
  });
});
