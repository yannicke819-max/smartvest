/**
 * Tests SetupClassifier — couvre les 8 setup_kind + 3 régimes + edge cases
 * dégradation gracieuse selon features disponibles.
 *
 * Sources de design pour les seuils :
 *   - Zarattini SSRN 4729284 (ORB Sharpe 2.81 sur Stocks-in-Play)
 *   - Agent 5 pseudocode (recherche web 02/06/2026)
 *   - Marton & Cakir SSRN 4290787 (Hurst)
 */
import {
  classifySetup,
  CLASSIFIER_VERSION,
  type SetupClassifierInput,
} from '../setup-classifier';

// Baseline input minimaliste — features manquent (v1 fallback path)
function baseInput(overrides: Partial<SetupClassifierInput> = {}): SetupClassifierInput {
  return {
    changePct: 3.0,
    close: 100,
    high: 100.5,
    volume: 1_000_000,
    avgVol50d: 500_000,
    persistenceScore: 0.5,
    ...overrides,
  };
}

describe('classifySetup — sortie type contract', () => {
  it('retourne classifier_version v1', () => {
    expect(classifySetup(baseInput()).classifier_version).toBe(CLASSIFIER_VERSION);
  });

  it('retourne setup_kind et regime_at_entry non vides', () => {
    const r = classifySetup(baseInput());
    expect(r.setup_kind).toBeTruthy();
    expect(r.regime_at_entry).toBeTruthy();
  });

  it('renseigne features_used pour audit', () => {
    const r = classifySetup(baseInput());
    expect(Array.isArray(r.features_used)).toBe(true);
  });
});

describe('classifySetup — features avancées (path v2 / agent 5)', () => {
  it('ORB_BREAKOUT : window <60min + volSpike + closeToHigh ≥ 0.99', () => {
    const r = classifySetup(
      baseInput({
        close: 100,
        high: 100, // closeToHigh = 1
        volume: 1_000_000,
        avgVol50d: 500_000, // volRatio = 2
        minutesSinceMarketOpen: 30,
      }),
    );
    expect(r.setup_kind).toBe('ORB_BREAKOUT');
  });

  it('VWAP_RECLAIM : above VWAP, dist<0.3 ATR, trendUp, volSpike', () => {
    const r = classifySetup(
      baseInput({
        close: 100.05,
        high: 100.06,
        vwap: 99.8,
        atr: 1.0,
        ema9: 100.1,
        ema21: 100.0,
        volume: 1_000_000,
        avgVol50d: 500_000,
        minutesSinceMarketOpen: 120, // hors fenêtre ORB
      }),
    );
    expect(r.setup_kind).toBe('VWAP_RECLAIM');
  });

  it('VWAP_FADE : below VWAP, dist<0.3 ATR, !trendUp', () => {
    const r = classifySetup(
      baseInput({
        changePct: -0.5,
        close: 99,
        vwap: 100,
        atr: 5,
        ema9: 99,
        ema21: 100,
        minutesSinceMarketOpen: 120,
      }),
    );
    expect(r.setup_kind).toBe('VWAP_FADE');
  });

  it('MOMENTUM_BREAKOUT : ADX>25 + trendUp + volSpike', () => {
    const r = classifySetup(
      baseInput({
        changePct: 3.0,
        adx: 30,
        volume: 2_000_000,
        avgVol50d: 500_000,
        minutesSinceMarketOpen: 120,
      }),
    );
    expect(r.setup_kind).toBe('MOMENTUM_BREAKOUT');
  });

  it('TREND_PULLBACK : ADX 20-25 + trendUp + persistence>0.5', () => {
    const r = classifySetup(
      baseInput({
        changePct: 1.5,
        adx: 22,
        persistenceScore: 0.7,
        minutesSinceMarketOpen: 180,
        volume: 600_000, // pas de spike pour exclure MOMENTUM_BREAKOUT
      }),
    );
    expect(r.setup_kind).toBe('TREND_PULLBACK');
  });

  it('MEAN_REVERSION : ADX<20 + RSI extreme', () => {
    const r = classifySetup(
      baseInput({
        adx: 15,
        rsi: 25,
        minutesSinceMarketOpen: 180,
      }),
    );
    expect(r.setup_kind).toBe('MEAN_REVERSION');
  });

  it('GAP_FADE : gap >2% + early session + !volSpike', () => {
    const r = classifySetup(
      baseInput({
        close: 103,
        prevClose: 100,
        volume: 400_000,
        avgVol50d: 500_000,
        minutesSinceMarketOpen: 15,
      }),
    );
    expect(r.setup_kind).toBe('GAP_FADE');
  });

  it('CHOP_NOISE : pas de signature reconnaissable', () => {
    const r = classifySetup(
      baseInput({
        changePct: 0.2,
        adx: 22, // entre les seuils
        rsi: 50, // pas extreme
        minutesSinceMarketOpen: 180,
        volume: 500_000,
        avgVol50d: 500_000, // volRatio = 1 (pas de spike)
        persistenceScore: 0.3, // sous persistence threshold trend_pullback
      }),
    );
    expect(r.setup_kind).toBe('CHOP_NOISE');
  });
});

describe('classifySetup — fallback v1 sur momentum/bucket (features SmartVest natives)', () => {
  it('momentum.verticality>0.7 + risingScore>0.7 + volSpike → MOMENTUM_BREAKOUT', () => {
    const r = classifySetup(
      baseInput({
        momentum: {
          gradientPctPerMin: 0.8,
          acceleration: 0.02,
          verticalityScore: 0.85,
          risingScore: 0.85,
        },
        volume: 1_000_000,
        avgVol50d: 500_000,
      }),
    );
    expect(r.setup_kind).toBe('MOMENTUM_BREAKOUT');
  });

  it('momentum.acceleration < -0.005 + persistence>0.5 + changePct>0 → TREND_PULLBACK', () => {
    const r = classifySetup(
      baseInput({
        changePct: 2.0,
        persistenceScore: 0.65,
        momentum: {
          gradientPctPerMin: 0.3,
          acceleration: -0.01, // décélération
          verticalityScore: 0.4,
          risingScore: 0.6,
        },
      }),
    );
    expect(r.setup_kind).toBe('TREND_PULLBACK');
  });

  it('momentum reversal (gradient<0 + accel<0) → MEAN_REVERSION', () => {
    const r = classifySetup(
      baseInput({
        changePct: -0.3,
        momentum: {
          gradientPctPerMin: -0.4,
          acceleration: -0.02,
          verticalityScore: 0.3,
          risingScore: 0.2,
        },
      }),
    );
    expect(r.setup_kind).toBe('MEAN_REVERSION');
  });

  it('bucket Phase 3 = sweet_spot_rising → TREND_PULLBACK', () => {
    const r = classifySetup(baseInput({ bucket: 'sweet_spot_rising' }));
    expect(r.setup_kind).toBe('TREND_PULLBACK');
  });

  it('bucket peak_parabolic → MOMENTUM_BREAKOUT', () => {
    const r = classifySetup(baseInput({ bucket: 'peak_parabolic' }));
    expect(r.setup_kind).toBe('MOMENTUM_BREAKOUT');
  });

  it('bucket reversing → MEAN_REVERSION', () => {
    const r = classifySetup(baseInput({ bucket: 'reversing' }));
    expect(r.setup_kind).toBe('MEAN_REVERSION');
  });

  it('bucket stalled → CHOP_NOISE', () => {
    const r = classifySetup(baseInput({ bucket: 'stalled' }));
    expect(r.setup_kind).toBe('CHOP_NOISE');
  });

  it('aucune feature riche → CHOP_NOISE par défaut', () => {
    const r = classifySetup(baseInput());
    expect(r.setup_kind).toBe('CHOP_NOISE');
  });
});

describe('classifySetup — regime_at_entry classification (3 buckets)', () => {
  describe('path v2 (avec ADX)', () => {
    it('TREND_PORTEUR : ADX>25 + persistence>0.55 + verticality>0.5', () => {
      const r = classifySetup(
        baseInput({
          adx: 30,
          persistenceScore: 0.7,
          momentum: {
            gradientPctPerMin: 0.5,
            acceleration: 0.01,
            verticalityScore: 0.6,
            risingScore: 0.7,
          },
        }),
      );
      expect(r.regime_at_entry).toBe('TREND_PORTEUR');
    });

    it('VOLATILE_CHOPPY : pathEfficiency<0.4', () => {
      const r = classifySetup(
        baseInput({
          adx: 22,
          pathEfficiency: 0.25,
        }),
      );
      expect(r.regime_at_entry).toBe('VOLATILE_CHOPPY');
    });

    it('RANGE_CALME : ADX<20', () => {
      const r = classifySetup(baseInput({ adx: 15, persistenceScore: 0.3 }));
      expect(r.regime_at_entry).toBe('RANGE_CALME');
    });
  });

  describe('path v1 (fallback persistence + path_eff)', () => {
    it('VOLATILE_CHOPPY : pathEfficiency<0.4 (priorité haute)', () => {
      const r = classifySetup(
        baseInput({ pathEfficiency: 0.2, persistenceScore: 0.7 }),
      );
      expect(r.regime_at_entry).toBe('VOLATILE_CHOPPY');
    });

    it('TREND_PORTEUR : persistence>=0.55 + path>=0.6 + verticality<0.85', () => {
      const r = classifySetup(
        baseInput({
          persistenceScore: 0.7,
          pathEfficiency: 0.75,
          momentum: {
            gradientPctPerMin: 0.4,
            acceleration: 0.01,
            verticalityScore: 0.5, // pas parabolic
            risingScore: 0.7,
          },
        }),
      );
      expect(r.regime_at_entry).toBe('TREND_PORTEUR');
    });

    it('TREND_PORTEUR : sans path mais persistence>=0.55', () => {
      const r = classifySetup(baseInput({ persistenceScore: 0.7 }));
      expect(r.regime_at_entry).toBe('TREND_PORTEUR');
    });

    it('RANGE_CALME : persistence<0.55, pas de path<0.4', () => {
      const r = classifySetup(baseInput({ persistenceScore: 0.4 }));
      expect(r.regime_at_entry).toBe('RANGE_CALME');
    });

    it('TREND_PORTEUR exclu si verticality≥0.85 (pump parabolic)', () => {
      const r = classifySetup(
        baseInput({
          persistenceScore: 0.7,
          pathEfficiency: 0.8,
          momentum: {
            gradientPctPerMin: 1.5,
            acceleration: 0.05,
            verticalityScore: 0.95, // parabolic
            risingScore: 0.9,
          },
        }),
      );
      // verticality élevée invalide TREND_PORTEUR fallback v1
      expect(r.regime_at_entry).toBe('RANGE_CALME');
    });
  });
});

describe('classifySetup — edge cases robustesse', () => {
  it('avgVol50d=0 ne plante pas', () => {
    const r = classifySetup(baseInput({ avgVol50d: 0 }));
    expect(r.setup_kind).toBeTruthy();
  });

  it('high=0 ne plante pas (closeToHigh=0)', () => {
    const r = classifySetup(baseInput({ high: 0 }));
    expect(r.setup_kind).toBeTruthy();
  });

  it('toutes features optionnelles undefined → fallback graceful', () => {
    const r = classifySetup({
      changePct: 5,
      close: 100,
      high: 100,
      volume: 1_000_000,
      avgVol50d: 500_000,
      persistenceScore: 0.5,
    });
    expect(['CHOP_NOISE', 'MOMENTUM_BREAKOUT', 'TREND_PULLBACK', 'ORB_BREAKOUT', 'MEAN_REVERSION']).toContain(r.setup_kind);
    expect(['TREND_PORTEUR', 'RANGE_CALME', 'VOLATILE_CHOPPY']).toContain(r.regime_at_entry);
  });

  it('classification idempotente (même input → même output)', () => {
    const input = baseInput({ adx: 30, volume: 2_000_000, avgVol50d: 500_000 });
    const r1 = classifySetup(input);
    const r2 = classifySetup(input);
    expect(r1.setup_kind).toBe(r2.setup_kind);
    expect(r1.regime_at_entry).toBe(r2.regime_at_entry);
  });
});

describe('classifySetup — priorité ordering (ORB > VWAP > ADX > GAP > fallback)', () => {
  it('ORB prend la priorité même si VWAP + ADX présents', () => {
    const r = classifySetup(
      baseInput({
        minutesSinceMarketOpen: 20,
        close: 100,
        high: 100,
        volume: 2_000_000,
        avgVol50d: 500_000,
        vwap: 99,
        atr: 1,
        ema9: 100.5,
        ema21: 99.8,
        adx: 30,
      }),
    );
    expect(r.setup_kind).toBe('ORB_BREAKOUT');
  });

  it('VWAP prend la priorité sur ADX si ORB exclu', () => {
    const r = classifySetup(
      baseInput({
        minutesSinceMarketOpen: 120, // hors ORB window
        close: 100.05,
        high: 100.06, // closeToHigh proche 1, mais ORB skip car >60min
        vwap: 99.85, // distVwapAtr = 0.20
        atr: 1,
        ema9: 100.2,
        ema21: 100.0,
        volume: 1_000_000,
        avgVol50d: 500_000,
        adx: 30,
      }),
    );
    expect(r.setup_kind).toBe('VWAP_RECLAIM');
  });
});
