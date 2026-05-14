/**
 * Bug #R1 — Tests SL warmup 15min (skip premature stop hunt on fresh positions).
 *
 * Gate inséré dans mechanical-trading.checkStopTarget, bloc `if (hitStop)` :
 * une position fraîche (<15 min) en perte modérée (> -3%) ignore le SL
 * PRINCIPAL ; garde-fou catastrophique : perte sévère (≤ -3%) → SL honoré
 * même en warmup.
 *
 * Audit 14/05 (closed_stop bruts, 14j) : 47% des SL surviennent <15min,
 * 3/4 sont des stop hunts (rebond breakeven <30min). Voir PR Bug #R1.
 *
 * Pattern de test : reproduction en isolation de la décision warmup (norme
 * repo, cf. mechanical-trading.batch-cap.spec.ts — service trop lourd en DI
 * NestJS pour instanciation propre). La fonction `warmupDecision` ci-dessous
 * reproduit EXACTEMENT le gate de checkStopTarget.
 */

const SL_WARMUP_MIN = 15;
const SL_WARMUP_SEVERE_LOSS_PCT = -3.0;

type WarmupDecision = 'warmup_skip' | 'warmup_override_severe_loss' | 'sl_honored';

/**
 * Reproduit le gate de mechanical-trading.checkStopTarget (bloc hitStop).
 * `ageMin` : âge de la position en minutes. `unrealizedPnlPct` : P&L latent
 * direction-aware (négatif = perte, pour long ET short).
 */
function warmupDecision(ageMin: number, unrealizedPnlPct: number): {
  decision: WarmupDecision;
  closesPosition: boolean;
} {
  const inWarmupWindow = ageMin < SL_WARMUP_MIN;
  const severeLoss = unrealizedPnlPct <= SL_WARMUP_SEVERE_LOSS_PCT;
  const warmupActive = inWarmupWindow && !severeLoss;

  if (warmupActive) {
    return { decision: 'warmup_skip', closesPosition: false };
  }
  if (inWarmupWindow && severeLoss) {
    return { decision: 'warmup_override_severe_loss', closesPosition: true };
  }
  return { decision: 'sl_honored', closesPosition: true };
}

/**
 * Reproduit le calcul de P&L latent direction-aware de checkStopTarget :
 * négatif = perte, quel que soit le sens de la position.
 */
function unrealizedPnlPct(isLong: boolean, entryPrice: number, currentPrice: number): number {
  return isLong
    ? ((currentPrice - entryPrice) / entryPrice) * 100
    : ((entryPrice - currentPrice) / entryPrice) * 100;
}

describe('Bug #R1 — SL warmup decision (8 cas spec)', () => {
  it('1. age 5min, pnl -1.5% → warmup_skip (SL principal ignoré, position fraîche)', () => {
    const { decision, closesPosition } = warmupDecision(5, -1.5);
    expect(decision).toBe('warmup_skip');
    expect(closesPosition).toBe(false);
  });

  it('2. age 5min, pnl -3.5% → warmup_override_severe_loss (garde-fou, SL honoré)', () => {
    const { decision, closesPosition } = warmupDecision(5, -3.5);
    expect(decision).toBe('warmup_override_severe_loss');
    expect(closesPosition).toBe(true);
  });

  it('3. age 20min, pnl -1.5% → sl_honored (warmup terminé, SL classique)', () => {
    const { decision, closesPosition } = warmupDecision(20, -1.5);
    expect(decision).toBe('sl_honored');
    expect(closesPosition).toBe(true);
  });

  it('4. age 20min, pnl -3.5% → sl_honored (warmup terminé)', () => {
    const { decision, closesPosition } = warmupDecision(20, -3.5);
    expect(decision).toBe('sl_honored');
    expect(closesPosition).toBe(true);
  });

  it('5. EDGE age exactement 15.0min → sl_honored (fenêtre warmup = ageMin < 15, exclusif)', () => {
    const { decision, closesPosition } = warmupDecision(15.0, -1.5);
    expect(decision).toBe('sl_honored');
    expect(closesPosition).toBe(true);
  });

  it('6. EDGE pnl exactement -3.0% → garde-fou actif (severeLoss = pnl <= -3.0, inclusif)', () => {
    const { decision, closesPosition } = warmupDecision(5, -3.0);
    expect(decision).toBe('warmup_override_severe_loss');
    expect(closesPosition).toBe(true);
  });

  it('7. symbol asia overnight (entry 00:00 UTC) : warmup respecté — gate hour-agnostic', () => {
    // Le warmup ne dépend QUE de l'âge et du PnL, jamais de l'heure UTC.
    // Une position asia ouverte à 00:00 UTC, 5 min plus tard, perte -1.2% →
    // warmup actif comme n'importe quelle autre heure.
    const entryAt = new Date('2026-05-14T00:00:00Z').getTime();
    const nowAt = new Date('2026-05-14T00:05:00Z').getTime();
    const ageMin = (nowAt - entryAt) / 60_000;
    const { decision, closesPosition } = warmupDecision(ageMin, -1.2);
    expect(ageMin).toBe(5);
    expect(decision).toBe('warmup_skip');
    expect(closesPosition).toBe(false);
  });

  it('8. symbol US 14h UTC (heure toxique) : warmup respecté — gate hour-agnostic', () => {
    // 14h UTC = heure toxique US large (88% SL d'après audit) mais le warmup
    // reste purement âge/PnL : une position fraîche y bénéficie du warmup.
    const entryAt = new Date('2026-05-14T14:00:00Z').getTime();
    const nowAt = new Date('2026-05-14T14:08:00Z').getTime();
    const ageMin = (nowAt - entryAt) / 60_000;
    const { decision, closesPosition } = warmupDecision(ageMin, -2.0);
    expect(ageMin).toBe(8);
    expect(decision).toBe('warmup_skip');
    expect(closesPosition).toBe(false);
  });
});

describe('Bug #R1 — P&L latent direction-aware (garde-fou correct long ET short)', () => {
  it('long : prix sous entry → pnl négatif (perte)', () => {
    // entry 5.00, current 4.85 → -3.0%
    expect(unrealizedPnlPct(true, 5.0, 4.85)).toBeCloseTo(-3.0, 5);
  });

  it('short : prix au-dessus entry → pnl négatif (perte)', () => {
    // entry 5.00, current 5.15 → short en perte de -3.0%
    expect(unrealizedPnlPct(false, 5.0, 5.15)).toBeCloseTo(-3.0, 5);
  });

  it('long fresh -1.5% → warmup_skip via pnl direction-aware', () => {
    const pnl = unrealizedPnlPct(true, 5.0, 4.925);
    expect(pnl).toBeCloseTo(-1.5, 5);
    expect(warmupDecision(5, pnl).decision).toBe('warmup_skip');
  });

  it('short fresh -3.5% → garde-fou via pnl direction-aware', () => {
    const pnl = unrealizedPnlPct(false, 5.0, 5.175);
    expect(pnl).toBeCloseTo(-3.5, 5);
    expect(warmupDecision(5, pnl).decision).toBe('warmup_override_severe_loss');
  });
});

describe('Bug #R1 — invariants warmup', () => {
  it('hors fenêtre warmup (age ≥ 15) : décision toujours sl_honored quel que soit le pnl', () => {
    for (const pnl of [-0.5, -1.5, -3.0, -5.0, -10.0]) {
      expect(warmupDecision(15, pnl).decision).toBe('sl_honored');
      expect(warmupDecision(60, pnl).decision).toBe('sl_honored');
    }
  });

  it('dans la fenêtre warmup : ferme la position SSI perte sévère (≤ -3%)', () => {
    expect(warmupDecision(5, -2.99).closesPosition).toBe(false); // modérée
    expect(warmupDecision(5, -3.0).closesPosition).toBe(true);   // seuil
    expect(warmupDecision(5, -3.01).closesPosition).toBe(true);  // sévère
  });
});
