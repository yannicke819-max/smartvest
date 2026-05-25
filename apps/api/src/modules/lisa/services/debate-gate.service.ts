/**
 * DebateGateService — wiring runtime des building blocks T1+T2.
 *
 * Intercepte la décision finale du scanner gainers (juste avant openPositionDirect)
 * et soumet le candidat à un débat multi-agents avant d'autoriser l'ouverture.
 *
 * Architecture :
 *   - Construit jusqu'à 6 SignalEnvelope synthétiques à partir des scores déjà
 *     calculés par le scanner (persistence, path quality, p_win, momentum,
 *     optionnel macro regime, optionnel volatility cell).
 *   - Lance resolveDebate() (T1-#1) pour produire un ConsensusVerdict.
 *   - Retourne allow + verdict + shadowMode pour permettre au caller de
 *     décider (block ou shadow log).
 *
 * Sécurité opérationnelle :
 *   - Feature flag DEBATE_GATE_ENABLED (env). Default `false` -> shadow only.
 *     Le scanner conserve son comportement actuel ; le service logge ce qu'il
 *     AURAIT décidé pour observabilité.
 *   - Catch-all error -> shadowMode allow=true (no regression in case of bug).
 *   - Pure logique, pas d'I/O Supabase ici. L'audit log est délégué au caller
 *     pour traçabilité homogène avec lisa_decision_log existant.
 *
 * Rollback en 1 clic : `fly secrets set DEBATE_GATE_ENABLED=false` ou flip via
 *   admin endpoint runtime (suit dans un PR dédié si besoin).
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  type ConsensusVerdict,
  type DebateInput,
  buildSignal,
  resolveDebate,
  type TradingDecision,
} from '@smartvest/ai-analyst';

export interface CandidateScores {
  symbol: string;
  /** Persistence score 0..1 (≥ 0.67 = strong). */
  persistenceScore: number;
  /** Path efficiency 0..1 (≥ 0.7 = smooth). Optional. */
  pathEfficiency?: number;
  /** Probability of win 0..1 (≥ 0.55 = bullish). Optional. */
  pWin?: number;
  /** Momentum (changePct) — negative = down, positive = up. */
  changePct: number;
  /** Pre-computed regime verdict (T2-C). Optional. */
  macroRegimeDecision?: TradingDecision;
  macroRegimeConfidence?: number;
  /** Pre-computed volatility cell verdict (T2-A). Optional. */
  cellDecision?: TradingDecision;
  cellConfidence?: number;
  /** Pre-computed strategy lifecycle suggestion (T1-#3). Optional. */
  strategySuggestedVerdict?: TradingDecision;
}

export interface DebateGateResult {
  /** True = autorise l'ouverture, false = block. */
  allow: boolean;
  /** Verdict du débat (pour audit / log). */
  verdict: ConsensusVerdict;
  /** True si feature flag OFF — verdict calculé mais allow toujours true. */
  shadowMode: boolean;
  /** Nombre d'agents participants. */
  agentCount: number;
  /** Erreur éventuelle pendant l'évaluation (fail-open). */
  error?: string;
}

@Injectable()
export class DebateGateService {
  private readonly logger = new Logger(DebateGateService.name);

  constructor(private readonly config: ConfigService) {}

  /**
   * True si le gate est actif (bloquant). False = shadow mode (log only).
   */
  isActive(): boolean {
    return this.config.get<string>('DEBATE_GATE_ENABLED') === 'true';
  }

  /**
   * Évalue un candidat. Pure fn sauf logger — pas d'I/O DB.
   *
   * Fail-safe : si une exception remonte, retourne `allow=true` (no regression).
   * En shadow mode (default), `allow=true` même si le débat dit non.
   */
  evaluateCandidate(scores: CandidateScores, now: number = Date.now()): DebateGateResult {
    const shadowMode = !this.isActive();
    try {
      const inputs = this.buildAgentInputs(scores, now);
      const verdict = resolveDebate(inputs, now);
      const debateAllows = verdict.decision === 'BUY';
      const allow = shadowMode ? true : debateAllows;

      if (shadowMode && !debateAllows) {
        this.logger.log(
          `[debate-gate SHADOW] ${scores.symbol} would have been blocked: ${verdict.decision} (${verdict.rationale})`,
        );
      } else if (!shadowMode && !debateAllows) {
        this.logger.warn(
          `[debate-gate ACTIVE] ${scores.symbol} blocked: ${verdict.decision} (${verdict.rationale})`,
        );
      }

      return { allow, verdict, shadowMode, agentCount: inputs.length };
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      this.logger.error(`[debate-gate] eval error for ${scores.symbol} (fail-open): ${errMsg}`);
      return {
        allow: true,
        verdict: this.failOpenVerdict(),
        shadowMode,
        agentCount: 0,
        error: errMsg,
      };
    }
  }

  /**
   * Construit jusqu'à 6 SignalEnvelope à partir des scores du candidat.
   * Exposé pour testabilité.
   */
  buildAgentInputs(scores: CandidateScores, now: number = Date.now()): DebateInput[] {
    const inputs: DebateInput[] = [];

    // Agent 1 : persistence multi-TF (T1 existing logic)
    const persistenceDecision = this.persistenceVerdict(scores.persistenceScore);
    inputs.push({
      agentId: 'persistence',
      signal: buildSignal(
        persistenceDecision,
        `persistence_score=${scores.persistenceScore.toFixed(2)}`,
        'persistence',
        'INTRADAY_5M',
        { confidence: scores.persistenceScore, emittedAt: now },
      ),
    });

    // Agent 2 : path quality (optional)
    if (typeof scores.pathEfficiency === 'number') {
      const pathDecision = this.pathQualityVerdict(scores.pathEfficiency);
      inputs.push({
        agentId: 'path_quality',
        signal: buildSignal(
          pathDecision,
          `path_eff=${scores.pathEfficiency.toFixed(2)}`,
          'path_quality',
          'INTRADAY_5M',
          { confidence: scores.pathEfficiency, emittedAt: now },
        ),
      });
    }

    // Agent 3 : ML probability (optional)
    if (typeof scores.pWin === 'number') {
      const mlDecision = this.mlVerdict(scores.pWin);
      inputs.push({
        agentId: 'ml_pwin',
        signal: buildSignal(
          mlDecision,
          `p_win=${scores.pWin.toFixed(2)}`,
          'ml_pwin',
          'INTRADAY_5M',
          { confidence: scores.pWin, emittedAt: now },
        ),
      });
    }

    // Agent 4 : momentum (anti-chase-the-top)
    const momentumDecision = this.momentumVerdict(scores.changePct);
    inputs.push({
      agentId: 'momentum',
      signal: buildSignal(
        momentumDecision,
        `changePct=${scores.changePct.toFixed(2)}%`,
        'momentum',
        'INTRADAY_5M',
        { confidence: this.momentumConfidence(scores.changePct), emittedAt: now },
      ),
    });

    // Agent 5 : macro regime (T2-C, optional, agentWeight 1.5 — c'est un veto-friendly)
    if (scores.macroRegimeDecision) {
      inputs.push({
        agentId: 'macro_regime',
        agentWeight: 1.5,
        signal: buildSignal(
          scores.macroRegimeDecision,
          `macro_regime`,
          'macro_regime',
          'INTRADAY_15M',
          { confidence: scores.macroRegimeConfidence ?? 0.5, emittedAt: now },
        ),
      });
    }

    // Agent 6 : volatility cell (T2-A, optional, agentWeight 1.5)
    if (scores.cellDecision) {
      inputs.push({
        agentId: 'vol_cell',
        agentWeight: 1.5,
        signal: buildSignal(
          scores.cellDecision,
          `vol_cell`,
          'vol_cell',
          'INTRADAY_15M',
          { confidence: scores.cellConfidence ?? 0.5, emittedAt: now },
        ),
      });
    }

    // Agent 7 : strategy lifecycle (T1-#3, optional)
    if (scores.strategySuggestedVerdict) {
      inputs.push({
        agentId: 'strategy_lifecycle',
        signal: buildSignal(
          scores.strategySuggestedVerdict,
          `strategy_lifecycle`,
          'strategy_lifecycle',
          'DAILY',
          { confidence: 0.6, emittedAt: now },
        ),
      });
    }

    return inputs;
  }

  private persistenceVerdict(score: number): TradingDecision {
    if (score >= 0.67) return 'BUY';
    if (score >= 0.5) return 'HOLD';
    return 'WAIT';
  }

  private pathQualityVerdict(eff: number): TradingDecision {
    if (eff >= 0.7) return 'BUY';
    if (eff >= 0.4) return 'HOLD';
    return 'CHASE_THE_TOP';
  }

  private mlVerdict(pWin: number): TradingDecision {
    if (pWin >= 0.55) return 'BUY';
    if (pWin >= 0.45) return 'HOLD';
    return 'WAIT';
  }

  private momentumVerdict(changePct: number): TradingDecision {
    if (changePct < 0) return 'WAIT';
    if (changePct > 15) return 'CHASE_THE_TOP';
    if (changePct >= 2) return 'BUY';
    return 'HOLD';
  }

  private momentumConfidence(changePct: number): number {
    const abs = Math.abs(changePct);
    if (abs >= 5 && abs <= 15) return 0.8;
    if (abs >= 2 && abs < 5) return 0.65;
    return 0.4;
  }

  private failOpenVerdict(): ConsensusVerdict {
    return {
      decision: 'BUY',
      confidence: 0,
      consensusRatio: 0,
      vetoTriggered: false,
      contributingAgents: [],
      dissentingAgents: [],
      rationale: 'Fail-open: debate gate error, allowing candidate (no regression).',
      staleAgents: [],
    };
  }
}
