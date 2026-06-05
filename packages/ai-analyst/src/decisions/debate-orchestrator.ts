/**
 * AXEES T1-#1 — Debate Orchestrator.
 *
 * Aujourd'hui chaque agent (scanner, gemini_v2_rm, gemini_scout,
 * risk_monitor, early_exit_guard, mechanical) prend ses décisions en
 * silos. Quand deux agents émettent un verdict opposé sur le même
 * symbole au même moment, il n'y a pas d'arbitrage formel — c'est le
 * dernier qui parle qui gagne (race condition), ou un caller décide
 * arbitrairement de prioriser l'un.
 *
 * Vision AXEES :
 *
 *   "Faire débattre plusieurs agents avant d'agir. Le consensus est
 *    pondéré par la fraicheur du signal (T1-#2) et la confiance de
 *    l'agent. Tout veto sécurité (STALE_PRICE, KILL_SWITCH_ACTIVE,
 *    MARKET_UNSAFE) court-circuite le vote — la sécurité gagne toujours."
 *
 * Cette couche définit :
 *   - DebateInput : un agent + son SignalEnvelope + un poids relatif
 *   - ConsensusVerdict : décision finale + agents contributing/dissenting
 *   - resolveDebate() : pure fn, déterministe, sans I/O
 *
 * Règles immuables :
 *   1. Tout verdict dans VETO_DECISIONS gagne instantanément. Si plusieurs
 *      veto coexistent, on garde celui de plus haute decayedConfidence.
 *   2. Sinon, vote pondéré par (agentWeight × decayedConfidence) groupé par
 *      decision. Le bucket gagnant doit dépasser MIN_CONSENSUS_RATIO (60%)
 *      du poids total — sinon fallback 'WAIT' (safe default).
 *   3. Aucun signal frais (decayFactor < 0.3) compte. Stale-only debate
 *      retourne 'WAIT'.
 *
 * Back-compat : ADDITIVE, no caller existant impacté. Le wiring dans
 * top-gainers-scanner / mechanical-trading suivra dans une PR dédiée.
 */

import type { TradingDecision } from './trading-decision';
import { isActionable } from './trading-decision';
import type { SignalEnvelope } from './signal-half-life';
import { decayedConfidence, signalDecayFactor } from './signal-half-life';

/**
 * Verdicts à priorité absolue. Si un agent émet l'un de ces verdicts
 * avec un signal frais, il court-circuite le vote — la sécurité gagne.
 */
export const VETO_DECISIONS: ReadonlySet<TradingDecision> = new Set<TradingDecision>([
  'KILL_SWITCH_ACTIVE',
  'STALE_PRICE',
  'MARKET_UNSAFE',
  'QUARANTINE',
  'MARKET_CLOSED',
  'HOLIDAY',
  'HORS_TRAJECTOIRE',
]);

/**
 * Seuil minimum de poids relatif pour valider un consensus actionable (offensif BUY/SELL).
 *
 * Calibration 25/05/2026 : 0.5 (vs 0.6 initial) — premier run en prod, on choisit
 * la prudence (relâcher pour éviter 0 trade le 1er jour). Ajuster après 24h
 * de métriques live (cf. /admin/debate-gate/metrics?hours=24).
 */
export const MIN_CONSENSUS_RATIO = 0.5;

/**
 * Seuil consensus réduit pour les décisions défensives (CLOSE).
 * Biais : il est plus prudent de fermer trop tôt qu'ouvrir sans conviction.
 */
export const DEFENSIVE_CONSENSUS_RATIO = 0.4;

/** Seuil minimum de decayFactor pour qu'un signal compte dans le vote. */
export const MIN_FRESHNESS_THRESHOLD = 0.3;

/**
 * Quorum minimum d'agents requis pour qu'un vote actionable passe.
 * Un agent seul ne déclenche jamais un trade — même avec 100% de "consensus".
 */
export const MIN_QUORUM = 2;

/**
 * Confidence agrégée minimum du winner. Évite les "consensus mous" :
 * 3 agents qui votent tous BUY à 0.3 → WAIT (pas assez convaincus).
 */
export const MIN_WINNER_CONFIDENCE = 0.5;

export interface DebateInput {
  /** Identifiant de l'agent (pour audit). Ex: 'scanner_gainers', 'gemini_v2_rm'. */
  agentId: string;
  /** Signal émis par cet agent. */
  signal: SignalEnvelope;
  /**
   * Poids relatif de l'agent dans le vote. Default 1.0.
   * Permet de privilégier certains agents (ex: risk_monitor=2.0, scanner=1.0).
   */
  agentWeight?: number;
}

export interface ConsensusVerdict {
  /** Décision finale après débat. */
  decision: TradingDecision;
  /** Confidence agrégée du consensus (0..1). */
  confidence: number;
  /** Ratio du poids gagnant sur le poids total (0..1). 1.0 = unanimité. */
  consensusRatio: number;
  /** True si un veto sécurité a court-circuité le vote. */
  vetoTriggered: boolean;
  /** Agents alignés sur la décision finale. */
  contributingAgents: ReadonlyArray<string>;
  /** Agents qui ont voté différemment (audit + debug). */
  dissentingAgents: ReadonlyArray<{ agentId: string; decision: TradingDecision; weight: number }>;
  /** Raison human-readable du verdict. */
  rationale: string;
  /** Signaux ignorés car trop stales (decayFactor < MIN_FRESHNESS_THRESHOLD). */
  staleAgents: ReadonlyArray<string>;
}

/**
 * Options de calibration pour resolveDebate. Default = constantes globales
 * (back-compat). Permet au caller (ex: DebateGateService lisant env vars)
 * d'ajuster les seuils par contexte (TRADER mode plus permissif).
 */
export interface ResolveDebateOptions {
  /** Override MIN_QUORUM (default 2). Set à 1 pour autoriser solo BUY. */
  minQuorum?: number;
  /** Override MIN_CONSENSUS_RATIO (default 0.5 pour BUY/SELL). */
  minConsensusRatio?: number;
  /** Override MIN_WINNER_CONFIDENCE (default 0.5). */
  minWinnerConfidence?: number;
}

/**
 * Résout un débat multi-agents en consensus déterministe.
 *
 * Algorithme :
 *   1. Filtre signaux stales (decayFactor < 0.3) — log dans staleAgents
 *   2. Cherche veto sécurité (KILL_SWITCH / STALE_PRICE / MARKET_UNSAFE / ...).
 *      Si trouvé, retourne immédiatement le veto avec plus haute confidence.
 *   3. Vote pondéré par (agentWeight × decayedConfidence) groupé par decision.
 *   4. Bucket gagnant doit dépasser le seuil consensus :
 *      - CLOSE (défensif) : 40% suffit (protect first)
 *      - BUY/SELL (offensif) : 60% requis
 *   5. Quorum : actions actionable exigent ≥ MIN_QUORUM (2) agents alignés.
 *   6. Confidence floor : winner actionable doit avoir conviction ≥ 0.5.
 *      Évite les "consensus mous" (3 agents BUY à 0.3 chacun → WAIT).
 *
 * Cas limites :
 *   - inputs = [] → 'WAIT' avec consensus=0, rationale="no agents"
 *   - tous stales → 'WAIT' avec consensus=0, rationale="all signals decayed"
 *   - tie 50/50 → 'WAIT' (consensus < seuil)
 *   - solo BUY 100% → 'WAIT' (quorum insuffisant)
 *   - unanimité 0.3 conf → 'WAIT' (confidence floor)
 *
 * Pure fn, déterministe pour `now` fixe — testable sans mocks.
 */
export function resolveDebate(
  inputs: ReadonlyArray<DebateInput>,
  now: number = Date.now(),
  options?: ResolveDebateOptions,
): ConsensusVerdict {
  const minQuorum = options?.minQuorum ?? MIN_QUORUM;
  const minConsensusRatio = options?.minConsensusRatio ?? MIN_CONSENSUS_RATIO;
  const minWinnerConfidence = options?.minWinnerConfidence ?? MIN_WINNER_CONFIDENCE;
  if (inputs.length === 0) {
    return emptyConsensus('no agents');
  }

  // Étape 1 : tri stales vs actifs
  const fresh: Array<{ input: DebateInput; decay: number; weightedConfidence: number }> = [];
  const stale: string[] = [];
  for (const inp of inputs) {
    const decay = signalDecayFactor(inp.signal, now);
    if (decay < MIN_FRESHNESS_THRESHOLD) {
      stale.push(inp.agentId);
      continue;
    }
    const baseConf = decayedConfidence(inp.signal, now) ?? decay;
    const agentWeight = inp.agentWeight ?? 1.0;
    fresh.push({ input: inp, decay, weightedConfidence: agentWeight * baseConf });
  }

  if (fresh.length === 0) {
    return { ...emptyConsensus('all signals decayed below freshness threshold'), staleAgents: stale };
  }

  // Étape 2 : veto sécurité
  const vetoCandidates = fresh.filter((f) => VETO_DECISIONS.has(f.input.signal.context.decision));
  if (vetoCandidates.length > 0) {
    vetoCandidates.sort((a, b) => b.weightedConfidence - a.weightedConfidence);
    const winner = vetoCandidates[0];
    const contributing = vetoCandidates
      .filter((v) => v.input.signal.context.decision === winner.input.signal.context.decision)
      .map((v) => v.input.agentId);
    const dissenting = fresh
      .filter((f) => f.input.signal.context.decision !== winner.input.signal.context.decision)
      .map((f) => ({
        agentId: f.input.agentId,
        decision: f.input.signal.context.decision,
        weight: f.weightedConfidence,
      }));
    return {
      decision: winner.input.signal.context.decision,
      confidence: Math.min(1, winner.weightedConfidence),
      consensusRatio: 1.0,
      vetoTriggered: true,
      contributingAgents: contributing,
      dissentingAgents: dissenting,
      rationale: `Veto sécurité par ${winner.input.agentId} (${winner.input.signal.context.decision}): ${winner.input.signal.context.reason}`,
      staleAgents: stale,
    };
  }

  // Étape 3 : vote pondéré
  const buckets = new Map<TradingDecision, { weight: number; agents: string[]; confidences: number[] }>();
  let totalWeight = 0;
  for (const f of fresh) {
    const dec = f.input.signal.context.decision;
    const w = f.weightedConfidence;
    totalWeight += w;
    const bucket = buckets.get(dec);
    if (bucket) {
      bucket.weight += w;
      bucket.agents.push(f.input.agentId);
      bucket.confidences.push(w);
    } else {
      buckets.set(dec, { weight: w, agents: [f.input.agentId], confidences: [w] });
    }
  }

  // Étape 4 : bucket gagnant
  let winnerDecision: TradingDecision = 'WAIT';
  let winnerBucket: { weight: number; agents: string[]; confidences: number[] } | undefined;
  for (const [dec, bucket] of buckets.entries()) {
    if (!winnerBucket || bucket.weight > winnerBucket.weight) {
      winnerDecision = dec;
      winnerBucket = bucket;
    }
  }

  const consensusRatio = winnerBucket ? winnerBucket.weight / totalWeight : 0;
  // Biais défensif : CLOSE peut passer à 40% de consensus (protect first),
  // BUY/SELL exigent minConsensusRatio (default 0.5, override possible).
  const requiredRatio = winnerDecision === 'CLOSE' ? DEFENSIVE_CONSENSUS_RATIO : minConsensusRatio;

  const allDissenting = () => fresh.map((f) => ({
    agentId: f.input.agentId,
    decision: f.input.signal.context.decision,
    weight: f.weightedConfidence,
  }));

  if (!winnerBucket || consensusRatio < requiredRatio) {
    return {
      decision: 'WAIT',
      confidence: 0,
      consensusRatio,
      vetoTriggered: false,
      contributingAgents: [],
      dissentingAgents: allDissenting(),
      rationale: `Pas de consensus (${(consensusRatio * 100).toFixed(0)}% < ${requiredRatio * 100}%). Fallback WAIT.`,
      staleAgents: stale,
    };
  }

  // Quorum minimum : un agent seul ne déclenche jamais une action (sauf veto safety).
  if (isActionable(winnerDecision) && winnerBucket.agents.length < minQuorum) {
    return {
      decision: 'WAIT',
      confidence: 0,
      consensusRatio,
      vetoTriggered: false,
      contributingAgents: [],
      dissentingAgents: allDissenting(),
      rationale: `Quorum insuffisant (${winnerBucket.agents.length} agent(s) < ${minQuorum} requis pour action ${winnerDecision}). Fallback WAIT.`,
      staleAgents: stale,
    };
  }

  const avgConfidence = winnerBucket.weight / winnerBucket.agents.length;

  // Confidence floor : même unanimité, si conviction faible -> WAIT.
  if (isActionable(winnerDecision) && avgConfidence < minWinnerConfidence) {
    return {
      decision: 'WAIT',
      confidence: avgConfidence,
      consensusRatio,
      vetoTriggered: false,
      contributingAgents: [],
      dissentingAgents: allDissenting(),
      rationale: `Conviction trop faible (avg ${avgConfidence.toFixed(2)} < ${minWinnerConfidence}). Consensus mou rejeté. Fallback WAIT.`,
      staleAgents: stale,
    };
  }

  const dissenting = fresh
    .filter((f) => f.input.signal.context.decision !== winnerDecision)
    .map((f) => ({
      agentId: f.input.agentId,
      decision: f.input.signal.context.decision,
      weight: f.weightedConfidence,
    }));

  return {
    decision: winnerDecision,
    confidence: Math.min(1, avgConfidence),
    consensusRatio,
    vetoTriggered: false,
    contributingAgents: winnerBucket.agents,
    dissentingAgents: dissenting,
    rationale: `Consensus ${(consensusRatio * 100).toFixed(0)}% sur ${winnerDecision} (${winnerBucket.agents.length}/${fresh.length} agents${isActionable(winnerDecision) ? ', actionable' : ''}).`,
    staleAgents: stale,
  };
}

function emptyConsensus(reason: string): ConsensusVerdict {
  return {
    decision: 'WAIT',
    confidence: 0,
    consensusRatio: 0,
    vetoTriggered: false,
    contributingAgents: [],
    dissentingAgents: [],
    rationale: reason,
    staleAgents: [],
  };
}
