/**
 * Micro-momentum gate — pure helper, no I/O.
 *
 * Miracle #2 : utilise la vélocité 2s-bucketed du MicroMomentumProbeService
 * pour gater l'entrée. Le scanner ouvre actuellement sur ch1m >= +3 % à la
 * minute X. Mais si la vélocité aux 6 dernières secondes est NÉGATIVE,
 * c'est qu'on est sur le fade post-pump — perte SL quasi assurée.
 *
 * Modes :
 *   long  : require velocity > minVelocityPctPerS (asc nécessaire)
 *   short : require velocity < -minVelocityPctPerS (desc nécessaire — pour Miracle #1 short_only/both)
 */

export interface MicroMomentumGateConfig {
  enabled: boolean;
  minVelocityPctPerS: number;  // default 0.0001 (0.01%/s) — pump faible mais non-négatif
  minRunLength: number;        // default 2
}

export const DEFAULT_MICRO_GATE: MicroMomentumGateConfig = {
  enabled: false,
  minVelocityPctPerS: 0.0001,
  minRunLength: 2,
};

export function parseMicroMomentumGateConfig(env: {
  MICRO_MOMENTUM_GATE_ENABLED?: string | undefined;
  MICRO_MOMENTUM_GATE_MIN_VELOCITY_PCT_S?: string | undefined;
  MICRO_MOMENTUM_GATE_MIN_RUN?: string | undefined;
}): MicroMomentumGateConfig {
  const enabled = (env.MICRO_MOMENTUM_GATE_ENABLED ?? 'false').toLowerCase() === 'true';
  const vRaw = Number.parseFloat(env.MICRO_MOMENTUM_GATE_MIN_VELOCITY_PCT_S ?? '');
  const rRaw = Number.parseInt(env.MICRO_MOMENTUM_GATE_MIN_RUN ?? '', 10);
  return {
    enabled,
    minVelocityPctPerS: Number.isFinite(vRaw) && vRaw >= 0 && vRaw <= 0.01 ? vRaw : DEFAULT_MICRO_GATE.minVelocityPctPerS,
    minRunLength: Number.isFinite(rRaw) && rRaw >= 1 && rRaw <= 30 ? rRaw : DEFAULT_MICRO_GATE.minRunLength,
  };
}

export interface MicroGateInput {
  direction: 'long' | 'short';
  velocityPctPerS: number | null;  // null = probe pas dispo pour ce symbole
  runLength: number | null;
}

export interface MicroGateVerdict {
  pass: boolean;
  reason: string;
}

/**
 * Décide si on peut ouvrir une position vu la vélocité actuelle.
 *   - Velocity null (symbole hors probe scope) → pass (ne pas bloquer)
 *   - LONG : exige velocity > +minVelocity ET runLength suffisant
 *   - SHORT : exige velocity < -minVelocity ET runLength suffisant
 */
export function evaluateMicroGate(
  input: MicroGateInput,
  cfg: MicroMomentumGateConfig = DEFAULT_MICRO_GATE,
): MicroGateVerdict {
  if (!cfg.enabled) return { pass: true, reason: 'gate_disabled' };
  if (input.velocityPctPerS == null || input.runLength == null) {
    return { pass: true, reason: 'velocity_unavailable_pass_by_default' };
  }
  if (input.runLength < cfg.minRunLength) {
    return {
      pass: false,
      reason: `run_length_${input.runLength}_below_min_${cfg.minRunLength}`,
    };
  }
  if (input.direction === 'long') {
    if (input.velocityPctPerS < cfg.minVelocityPctPerS) {
      return {
        pass: false,
        reason: `long_velocity_${input.velocityPctPerS.toExponential(2)}_below_min_${cfg.minVelocityPctPerS.toExponential(2)}`,
      };
    }
    return { pass: true, reason: `long_velocity_${input.velocityPctPerS.toExponential(2)}_ok` };
  }
  // SHORT
  if (input.velocityPctPerS > -cfg.minVelocityPctPerS) {
    return {
      pass: false,
      reason: `short_velocity_${input.velocityPctPerS.toExponential(2)}_above_min_-${cfg.minVelocityPctPerS.toExponential(2)}`,
    };
  }
  return { pass: true, reason: `short_velocity_${input.velocityPctPerS.toExponential(2)}_ok` };
}
