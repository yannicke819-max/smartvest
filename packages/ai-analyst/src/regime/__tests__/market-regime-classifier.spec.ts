/**
 * P1 — Tests du classifier de régime macro.
 *
 * Pure function → tests sans mock, sur la matrice de vérité des 5 régimes.
 * Vérifie l'ordre de priorité (NEWS_SHOCK > VOL_SPIKE > BULL > BEAR >
 * RANGE > NEUTRAL) et les sizing/SL/TP attendus pour chaque cas.
 */
import {
  classifyTacticalRegime,
  type RegimeInputs,
} from '../market-regime-classifier';

const NEUTRAL_INPUTS: RegimeInputs = {
  btc24hReturnPct: 0,
  btcFundingPct: 0,
  vix: 18,
  atr14BtcPct: 1.5,
  atr50BtcPct: 1.5,
  newsScore: 3,
  realized1hPct: 0.5,
  redditSpikeSigma: 1,
};

describe('classifyTacticalRegime — NEWS_SHOCK (priorité 1)', () => {
  it('matches when news_score > 7', () => {
    const r = classifyTacticalRegime({ ...NEUTRAL_INPUTS, newsScore: 8.5 });
    expect(r.regime).toBe('NEWS_SHOCK');
    expect(r.reasons.some((x) => x.includes('news_score=8.5'))).toBe(true);
    expect(r.sizingMultiplier).toBe(1.0);
    expect(r.stopLossPct).toBe(1.0);
    expect(r.takeProfitPct).toBe(3.0);
  });

  it('matches when reddit_sigma > 5', () => {
    const r = classifyTacticalRegime({ ...NEUTRAL_INPUTS, redditSpikeSigma: 6 });
    expect(r.regime).toBe('NEWS_SHOCK');
    expect(r.reasons.some((x) => x.includes('reddit_sigma=6.0'))).toBe(true);
  });

  it('takes priority over VOL_SPIKE (interrupt sémantique)', () => {
    const r = classifyTacticalRegime({
      ...NEUTRAL_INPUTS,
      newsScore: 9,
      vix: 30, // would also match VOL_SPIKE
    });
    expect(r.regime).toBe('NEWS_SHOCK');
  });

  it('does NOT match at threshold (>7 strict)', () => {
    const r = classifyTacticalRegime({ ...NEUTRAL_INPUTS, newsScore: 7 });
    expect(r.regime).not.toBe('NEWS_SHOCK');
  });
});

describe('classifyTacticalRegime — VOL_SPIKE (priorité 2)', () => {
  it('matches when VIX > 25', () => {
    const r = classifyTacticalRegime({ ...NEUTRAL_INPUTS, vix: 28 });
    expect(r.regime).toBe('VOL_SPIKE');
    expect(r.sizingMultiplier).toBe(0); // skip 30 min
    expect(r.stopLossPct).toBe(3.0);
    expect(r.takeProfitPct).toBe(2.0);
  });

  it('matches when realized_1h > 3%', () => {
    const r = classifyTacticalRegime({ ...NEUTRAL_INPUTS, realized1hPct: 4 });
    expect(r.regime).toBe('VOL_SPIKE');
  });

  it('takes priority over BULL', () => {
    const r = classifyTacticalRegime({
      ...NEUTRAL_INPUTS,
      vix: 30,
      btc24hReturnPct: 5,
      btcFundingPct: 0.05,
    });
    expect(r.regime).toBe('VOL_SPIKE');
  });

  it('takes priority over BEAR', () => {
    const r = classifyTacticalRegime({
      ...NEUTRAL_INPUTS,
      vix: 30,
      btc24hReturnPct: -5,
      btcFundingPct: -0.05,
    });
    expect(r.regime).toBe('VOL_SPIKE');
  });

  it('does NOT match at VIX exact threshold (>25 strict)', () => {
    const r = classifyTacticalRegime({ ...NEUTRAL_INPUTS, vix: 25 });
    expect(r.regime).not.toBe('VOL_SPIKE');
  });
});

describe('classifyTacticalRegime — BULL (priorité 3)', () => {
  it('matches when btc_24h > +2% AND funding > 0.01%', () => {
    const r = classifyTacticalRegime({
      ...NEUTRAL_INPUTS,
      btc24hReturnPct: 3,
      btcFundingPct: 0.02,
    });
    expect(r.regime).toBe('BULL');
    expect(r.sizingMultiplier).toBe(1.2);
    expect(r.stopLossPct).toBe(2.0);
    expect(r.takeProfitLadderPct).toEqual([1.5, 2.5, 4.0]);
  });

  it('does NOT match when only btc_24h > +2% (funding low)', () => {
    const r = classifyTacticalRegime({
      ...NEUTRAL_INPUTS,
      btc24hReturnPct: 3,
      btcFundingPct: 0.005, // sous le threshold
    });
    expect(r.regime).not.toBe('BULL');
  });

  it('does NOT match when only funding > 0.01% (btc flat)', () => {
    const r = classifyTacticalRegime({
      ...NEUTRAL_INPUTS,
      btc24hReturnPct: 0.5, // sous le +2%
      btcFundingPct: 0.02,
    });
    expect(r.regime).not.toBe('BULL');
  });

  it('takes priority over BEAR (mutually exclusive on direction)', () => {
    // Impossible cas physique mais testons : BTC up + funding up bat un
    // hypothétique BEAR sur autre indicateur. NEUTRAL_INPUTS funding=0
    // donc pas de conflit en pratique.
    const r = classifyTacticalRegime({
      ...NEUTRAL_INPUTS,
      btc24hReturnPct: 3,
      btcFundingPct: 0.02,
    });
    expect(r.regime).toBe('BULL');
  });
});

describe('classifyTacticalRegime — BEAR (priorité 4)', () => {
  it('matches when btc_24h < -2% AND funding < -0.005%', () => {
    const r = classifyTacticalRegime({
      ...NEUTRAL_INPUTS,
      btc24hReturnPct: -3,
      btcFundingPct: -0.01,
    });
    expect(r.regime).toBe('BEAR');
    expect(r.sizingMultiplier).toBe(0.7);
    expect(r.stopLossPct).toBe(2.0);
    expect(r.takeProfitPct).toBe(1.5);
  });

  it('does NOT match when only btc_24h < -2% (funding ok)', () => {
    const r = classifyTacticalRegime({
      ...NEUTRAL_INPUTS,
      btc24hReturnPct: -3,
      btcFundingPct: 0,
    });
    expect(r.regime).not.toBe('BEAR');
  });

  it('does NOT match when only funding < -0.005% (btc up)', () => {
    const r = classifyTacticalRegime({
      ...NEUTRAL_INPUTS,
      btc24hReturnPct: 1,
      btcFundingPct: -0.01,
    });
    expect(r.regime).not.toBe('BEAR');
  });
});

describe('classifyTacticalRegime — RANGE (priorité 5)', () => {
  it('matches when ATR14 < 0.8*ATR50 AND |btc_24h| < 1%', () => {
    const r = classifyTacticalRegime({
      ...NEUTRAL_INPUTS,
      atr14BtcPct: 0.5,
      atr50BtcPct: 1.0, // ratio 0.5 < 0.8
      btc24hReturnPct: 0.3, // |0.3| < 1
    });
    expect(r.regime).toBe('RANGE');
    expect(r.sizingMultiplier).toBe(1.0);
    expect(r.stopLossPct).toBe(1.2);
    expect(r.takeProfitPct).toBe(0.8);
  });

  it('does NOT match when ATR ratio is high (> 0.8)', () => {
    const r = classifyTacticalRegime({
      ...NEUTRAL_INPUTS,
      atr14BtcPct: 1.0,
      atr50BtcPct: 1.0, // ratio = 1.0
      btc24hReturnPct: 0.3,
    });
    expect(r.regime).not.toBe('RANGE');
  });

  it('does NOT match when btc_24h moves > 1%', () => {
    const r = classifyTacticalRegime({
      ...NEUTRAL_INPUTS,
      atr14BtcPct: 0.5,
      atr50BtcPct: 1.0,
      btc24hReturnPct: 1.5, // |1.5| > 1
    });
    expect(r.regime).not.toBe('RANGE');
  });

  it('does NOT match when ATR50 is 0 (avoid div by 0)', () => {
    const r = classifyTacticalRegime({
      ...NEUTRAL_INPUTS,
      atr14BtcPct: 0.5,
      atr50BtcPct: 0,
      btc24hReturnPct: 0.3,
    });
    expect(r.regime).not.toBe('RANGE');
  });
});

describe('classifyTacticalRegime — NEUTRAL (default)', () => {
  it('falls through to NEUTRAL when no condition matches', () => {
    const r = classifyTacticalRegime(NEUTRAL_INPUTS);
    expect(r.regime).toBe('NEUTRAL');
    expect(r.sizingMultiplier).toBe(1.0);
    expect(r.reasons).toContain('no_threshold_matched');
  });

  it('returns NEUTRAL with inputs_unavailable reason when all critical inputs are null', () => {
    const r = classifyTacticalRegime({
      btc24hReturnPct: null,
      btcFundingPct: null,
      vix: null,
      atr14BtcPct: null,
      atr50BtcPct: null,
      newsScore: null,
    });
    expect(r.regime).toBe('NEUTRAL');
    expect(r.reasons).toContain('inputs_unavailable');
  });
});

describe('classifyTacticalRegime — sizing/SL/TP coherence (matrix)', () => {
  it('NEWS_SHOCK : sizing 1.0 / SL 1% / TP 3%', () => {
    const r = classifyTacticalRegime({ ...NEUTRAL_INPUTS, newsScore: 9 });
    expect(r.sizingMultiplier).toBe(1.0);
    expect(r.stopLossPct).toBe(1.0);
    expect(r.takeProfitPct).toBe(3.0);
  });

  it('VOL_SPIKE : sizing 0 (skip) / SL 3% / TP 2%', () => {
    const r = classifyTacticalRegime({ ...NEUTRAL_INPUTS, vix: 30 });
    expect(r.sizingMultiplier).toBe(0);
    expect(r.stopLossPct).toBe(3.0);
    expect(r.takeProfitPct).toBe(2.0);
  });

  it('BULL : sizing +20% / TP étagé / SL trail 2%', () => {
    const r = classifyTacticalRegime({
      ...NEUTRAL_INPUTS,
      btc24hReturnPct: 3,
      btcFundingPct: 0.02,
    });
    expect(r.sizingMultiplier).toBe(1.2);
    expect(r.takeProfitLadderPct).toEqual([1.5, 2.5, 4.0]);
    expect(r.stopLossPct).toBe(2.0);
  });

  it('BEAR : sizing -30% / SL 2% / TP 1.5%', () => {
    const r = classifyTacticalRegime({
      ...NEUTRAL_INPUTS,
      btc24hReturnPct: -3,
      btcFundingPct: -0.01,
    });
    expect(r.sizingMultiplier).toBe(0.7);
    expect(r.stopLossPct).toBe(2.0);
    expect(r.takeProfitPct).toBe(1.5);
  });

  it('RANGE : sizing 1.0 / SL 1.2% / TP 0.8% (scalping)', () => {
    const r = classifyTacticalRegime({
      ...NEUTRAL_INPUTS,
      atr14BtcPct: 0.5,
      atr50BtcPct: 1.0,
      btc24hReturnPct: 0.3,
    });
    expect(r.sizingMultiplier).toBe(1.0);
    expect(r.stopLossPct).toBe(1.2);
    expect(r.takeProfitPct).toBe(0.8);
  });

  it('NEUTRAL : sizing 1.0 / SL 2% / TP 2.5% (nominal)', () => {
    const r = classifyTacticalRegime(NEUTRAL_INPUTS);
    expect(r.sizingMultiplier).toBe(1.0);
    expect(r.stopLossPct).toBe(2.0);
    expect(r.takeProfitPct).toBe(2.5);
  });
});

describe('classifyTacticalRegime — reasons text quality', () => {
  it('includes the actual values in reasons (audit-friendly)', () => {
    const r = classifyTacticalRegime({
      ...NEUTRAL_INPUTS,
      btc24hReturnPct: 2.55,
      btcFundingPct: 0.0123,
    });
    expect(r.regime).toBe('BULL');
    expect(r.reasons.some((x) => x.includes('2.55%'))).toBe(true);
    expect(r.reasons.some((x) => x.includes('0.0123%'))).toBe(true);
  });

  it('emits ratio in RANGE reasons', () => {
    const r = classifyTacticalRegime({
      ...NEUTRAL_INPUTS,
      atr14BtcPct: 0.6,
      atr50BtcPct: 1.0,
      btc24hReturnPct: 0.5,
    });
    expect(r.regime).toBe('RANGE');
    expect(r.reasons.some((x) => x.includes('atr14/atr50=0.60'))).toBe(true);
  });
});
