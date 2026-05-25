/**
 * DebateGateMetricsStore — ring buffer in-memory des évaluations du debate gate.
 *
 * Pourquoi in-memory plutôt qu'une table Supabase :
 *   - Calibration courte (24-48h max), donc perte sur restart non critique
 *   - Zéro migration DB, zéro charge Supabase, zéro risque d'indispo
 *   - Aggregations rapides sans network round-trip
 *
 * Capacité : 5000 entrées (≈ 1 portfolio × 50 candidats × 100 cycles = 24h).
 * Au-delà, eviction FIFO.
 *
 * Consommateurs :
 *   - DebateGateService.evaluateCandidate() appelle record() en fire-and-forget
 *   - AdminDebateGateMetricsController appelle aggregate(hours)
 */

import { Injectable } from '@nestjs/common';

export interface DebateGateEvaluation {
  timestamp: number;
  symbol: string;
  allow: boolean;
  shadowMode: boolean;
  verdictDecision: string;
  consensusRatio: number;
  agentCount: number;
  vetoTriggered: boolean;
  rationale: string;
  /** Persistence score d'origine (pour calibration). */
  persistenceScore?: number;
  /** Path efficiency d'origine. */
  pathEfficiency?: number;
  /** Momentum changePct d'origine. */
  changePct?: number;
}

export interface AggregatedDebateMetrics {
  windowHours: number;
  windowStart: string;
  windowEnd: string;
  totalEvaluations: number;
  shadowModeCount: number;
  activeModeCount: number;
  wouldBlockCount: number;
  wouldAllowCount: number;
  blockRatio: number;
  topVerdicts: ReadonlyArray<{ decision: string; count: number; ratio: number }>;
  topBlockedSymbols: ReadonlyArray<{ symbol: string; count: number }>;
  vetoTriggers: number;
  averageAgentCount: number;
  averageConsensusRatio: number;
}

const MAX_BUFFER = 5000;

@Injectable()
export class DebateGateMetricsStore {
  private buffer: DebateGateEvaluation[] = [];

  record(evaluation: DebateGateEvaluation): void {
    this.buffer.push(evaluation);
    if (this.buffer.length > MAX_BUFFER) {
      this.buffer.splice(0, this.buffer.length - MAX_BUFFER);
    }
  }

  size(): number {
    return this.buffer.length;
  }

  clear(): void {
    this.buffer = [];
  }

  aggregate(hours: number): AggregatedDebateMetrics {
    const windowMs = Math.max(1, hours) * 3_600_000;
    const now = Date.now();
    const windowStart = now - windowMs;
    const inWindow = this.buffer.filter((e) => e.timestamp >= windowStart);

    const total = inWindow.length;
    const shadowModeCount = inWindow.filter((e) => e.shadowMode).length;
    const activeModeCount = total - shadowModeCount;

    // wouldBlock = aurait été bloqué (ou EST bloqué en mode actif)
    // - shadow mode : verdict != BUY (n'a pas bloqué, mais l'aurait fait)
    // - active mode : !allow
    const wouldBlockCount = inWindow.filter((e) =>
      e.shadowMode ? e.verdictDecision !== 'BUY' : !e.allow,
    ).length;
    const wouldAllowCount = total - wouldBlockCount;

    const blockRatio = total > 0 ? wouldBlockCount / total : 0;

    const verdictCounts = new Map<string, number>();
    for (const e of inWindow) {
      verdictCounts.set(e.verdictDecision, (verdictCounts.get(e.verdictDecision) ?? 0) + 1);
    }
    const topVerdicts = Array.from(verdictCounts.entries())
      .map(([decision, count]) => ({ decision, count, ratio: count / Math.max(1, total) }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    const symbolBlocks = new Map<string, number>();
    for (const e of inWindow) {
      const blocked = e.shadowMode ? e.verdictDecision !== 'BUY' : !e.allow;
      if (blocked) {
        symbolBlocks.set(e.symbol, (symbolBlocks.get(e.symbol) ?? 0) + 1);
      }
    }
    const topBlockedSymbols = Array.from(symbolBlocks.entries())
      .map(([symbol, count]) => ({ symbol, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    const vetoTriggers = inWindow.filter((e) => e.vetoTriggered).length;
    const averageAgentCount =
      total > 0 ? inWindow.reduce((acc, e) => acc + e.agentCount, 0) / total : 0;
    const averageConsensusRatio =
      total > 0 ? inWindow.reduce((acc, e) => acc + e.consensusRatio, 0) / total : 0;

    return {
      windowHours: hours,
      windowStart: new Date(windowStart).toISOString(),
      windowEnd: new Date(now).toISOString(),
      totalEvaluations: total,
      shadowModeCount,
      activeModeCount,
      wouldBlockCount,
      wouldAllowCount,
      blockRatio,
      topVerdicts,
      topBlockedSymbols,
      vetoTriggers,
      averageAgentCount,
      averageConsensusRatio,
    };
  }
}
