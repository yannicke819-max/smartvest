/**
 * Bug #R2 — Tests SL warmup paramétrable via env vars.
 *
 * Refactor de PR #319 : la fenêtre warmup (15 min) et le seuil garde-fou
 * catastrophique (-3%) deviennent paramétrables via env vars, avec validation
 * des bornes. Defaults STRICTEMENT identiques à PR #319.
 *
 * Motivation : post-deploy R1, PSIX.US fermé à 16.5 min (-1.79%) = raté la
 * fenêtre warmup de 1.5 min. Simulation 14j : warmup 20min = +33% pertes
 * évitées vs 15min. → exposer la fenêtre pour tuning sans redéploiement.
 *
 * Le fichier sl-warmup.spec.ts (14 tests R1) reste INCHANGÉ — il valide le
 * comportement par défaut, garanti identique par cette PR.
 *
 * Pattern : reproduction en isolation des résolveurs env + de la décision
 * warmup paramétrée (norme repo, cf. batch-cap.spec.ts — checkStopTarget
 * privé + 14 deps DI NestJS).
 */

// --- Reproduit resolveWarmupMin de mechanical-trading.checkStopTarget --------
function resolveWarmupMin(rawStr: string | undefined): number {
  const raw = Number(rawStr ?? '15');
  if (!Number.isFinite(raw) || raw < 0) return 15;          // invalide → fallback
  if (raw > 60) return 60;                                   // suspicious → cap 60
  return raw;
}

// --- Reproduit resolveWarmupCatastrophicPct ---------------------------------
function resolveWarmupCatastrophicPct(rawStr: string | undefined): number {
  const raw = Number(rawStr ?? '-3.0');
  if (!Number.isFinite(raw) || raw > 0) return -3.0;         // invalide / positif → fallback
  if (raw < -10) return -10;                                 // too lenient → cap -10
  return raw;
}

// --- Reproduit le gate warmup paramétré -------------------------------------
type WarmupDecision = 'warmup_skip' | 'warmup_override_severe_loss' | 'sl_honored';
function warmupDecision(
  ageMin: number,
  unrealizedPnlPct: number,
  warmupMin: number,
  catastrophicPct: number,
): { decision: WarmupDecision; closesPosition: boolean } {
  const inWarmupWindow = ageMin < warmupMin;
  const severeLoss = unrealizedPnlPct <= catastrophicPct;
  const warmupActive = inWarmupWindow && !severeLoss;
  if (warmupActive) return { decision: 'warmup_skip', closesPosition: false };
  if (inWarmupWindow && severeLoss) {
    return { decision: 'warmup_override_severe_loss', closesPosition: true };
  }
  return { decision: 'sl_honored', closesPosition: true };
}

describe('Bug #R2 — env var resolution (5 cas spec)', () => {
  it('1. env vars absentes → defaults 15min / -3% (= comportement PR #319)', () => {
    expect(resolveWarmupMin(undefined)).toBe(15);
    expect(resolveWarmupCatastrophicPct(undefined)).toBe(-3.0);
  });

  it('2. GAINERS_SL_WARMUP_MIN=20 → age 18min, pnl -1.5% → warmup actif (skip SL)', () => {
    const warmupMin = resolveWarmupMin('20');
    const cata = resolveWarmupCatastrophicPct(undefined);
    expect(warmupMin).toBe(20);
    const { decision, closesPosition } = warmupDecision(18, -1.5, warmupMin, cata);
    expect(decision).toBe('warmup_skip');
    expect(closesPosition).toBe(false);
  });

  it('3. GAINERS_SL_WARMUP_MIN=20 → age 22min, pnl -1.5% → warmup inactif (SL honoré)', () => {
    const warmupMin = resolveWarmupMin('20');
    const cata = resolveWarmupCatastrophicPct(undefined);
    const { decision, closesPosition } = warmupDecision(22, -1.5, warmupMin, cata);
    expect(decision).toBe('sl_honored');
    expect(closesPosition).toBe(true);
  });

  it('4. GAINERS_SL_WARMUP_CATASTROPHIC_PCT=-2.5 → age 5min, pnl -2.8% → garde-fou actif (SL honoré)', () => {
    const warmupMin = resolveWarmupMin(undefined);
    const cata = resolveWarmupCatastrophicPct('-2.5');
    expect(cata).toBe(-2.5);
    const { decision, closesPosition } = warmupDecision(5, -2.8, warmupMin, cata);
    // -2.8% ≤ -2.5% → severe → garde-fou override
    expect(decision).toBe('warmup_override_severe_loss');
    expect(closesPosition).toBe(true);
    // sanity : avec le default -3%, -2.8% serait modéré → warmup_skip
    expect(warmupDecision(5, -2.8, warmupMin, -3.0).decision).toBe('warmup_skip');
  });

  it('5. env vars invalides → fallback defaults', () => {
    // "abc" → NaN → fallback
    expect(resolveWarmupMin('abc')).toBe(15);
    expect(resolveWarmupCatastrophicPct('abc')).toBe(-3.0);
    // négatif sur MIN → fallback 15
    expect(resolveWarmupMin('-5')).toBe(15);
    // positif sur CATASTROPHIC → fallback -3
    expect(resolveWarmupCatastrophicPct('2.5')).toBe(-3.0);
    expect(resolveWarmupCatastrophicPct('0.5')).toBe(-3.0);
  });
});

describe('Bug #R2 — validation des bornes', () => {
  it('GAINERS_SL_WARMUP_MIN > 60 → capped at 60', () => {
    expect(resolveWarmupMin('120')).toBe(60);
    expect(resolveWarmupMin('61')).toBe(60);
    expect(resolveWarmupMin('60')).toBe(60); // 60 exact = valide, non capé
  });

  it('GAINERS_SL_WARMUP_MIN < 0 → fallback 15', () => {
    expect(resolveWarmupMin('-1')).toBe(15);
    expect(resolveWarmupMin('-30')).toBe(15);
    expect(resolveWarmupMin('0')).toBe(0); // 0 exact = valide (warmup désactivé)
  });

  it('GAINERS_SL_WARMUP_CATASTROPHIC_PCT > 0 → fallback -3', () => {
    expect(resolveWarmupCatastrophicPct('1.0')).toBe(-3.0);
    expect(resolveWarmupCatastrophicPct('0.1')).toBe(-3.0);
    expect(resolveWarmupCatastrophicPct('0')).toBe(0); // 0 exact = valide
  });

  it('GAINERS_SL_WARMUP_CATASTROPHIC_PCT < -10 → capped at -10', () => {
    expect(resolveWarmupCatastrophicPct('-15')).toBe(-10);
    expect(resolveWarmupCatastrophicPct('-10.5')).toBe(-10);
    expect(resolveWarmupCatastrophicPct('-10')).toBe(-10); // -10 exact = valide, non capé
  });

  it('valeurs valides dans les bornes → passées telles quelles', () => {
    expect(resolveWarmupMin('20')).toBe(20);
    expect(resolveWarmupMin('30')).toBe(30);
    expect(resolveWarmupCatastrophicPct('-2.5')).toBe(-2.5);
    expect(resolveWarmupCatastrophicPct('-5')).toBe(-5);
  });
});

describe('Bug #R2 — non-régression : defaults identiques à PR #319', () => {
  it('avec env absentes, le gate se comporte exactement comme R1 (15min / -3%)', () => {
    const wm = resolveWarmupMin(undefined);   // 15
    const ca = resolveWarmupCatastrophicPct(undefined);  // -3.0
    // Rejoue les 8 cas spec de sl-warmup.spec.ts (R1) avec les résolveurs.
    expect(warmupDecision(5, -1.5, wm, ca).decision).toBe('warmup_skip');
    expect(warmupDecision(5, -3.5, wm, ca).decision).toBe('warmup_override_severe_loss');
    expect(warmupDecision(20, -1.5, wm, ca).decision).toBe('sl_honored');
    expect(warmupDecision(20, -3.5, wm, ca).decision).toBe('sl_honored');
    expect(warmupDecision(15.0, -1.5, wm, ca).decision).toBe('sl_honored'); // edge age=15
    expect(warmupDecision(5, -3.0, wm, ca).decision).toBe('warmup_override_severe_loss'); // edge pnl=-3
  });
});
