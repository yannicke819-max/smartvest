import { Injectable } from '@nestjs/common';
import type { RawProposal, ProposalSourceKind } from '../interfaces/raw-proposal';

// How long (in days) to suppress duplicate proposals per source
const DEDUP_WINDOWS: Record<ProposalSourceKind, number> = {
  drift: 7,
  concentration: 2,
  goal_trigger: 3,
  macro_signal: 2,
  drawdown: 1,
  benchmark: 7,
};

@Injectable()
export class ProposalScorerService {
  /**
   * Sort proposals by score descending, remove exact dedupKey duplicates within
   * the same run (same portfolio may produce two drift proposals for different
   * asset classes — those stay; two identical ones are collapsed).
   */
  rankAndDedup(proposals: RawProposal[]): RawProposal[] {
    const seen = new Set<string>();
    const unique = proposals.filter((p) => {
      if (seen.has(p.dedupKey)) return false;
      seen.add(p.dedupKey);
      return true;
    });
    return unique.sort((a, b) => b.score - a.score);
  }

  dedupWindowDays(sourceKind: ProposalSourceKind): number {
    return DEDUP_WINDOWS[sourceKind];
  }

  /**
   * Applies mandate guardrail filters to a set of raw proposals.
   * Returns allowed proposals and a list of { proposal, reason } for blocked ones.
   */
  applyGuardrails(
    proposals: RawProposal[],
    mandate: {
      kill_switch_active: boolean;
      status: string;
      forbidden_tickers: string[];
      allowed_asset_classes: string[];
    } | null,
  ): { allowed: RawProposal[]; blocked: Array<{ proposal: RawProposal; reason: string }> } {
    if (!mandate) return { allowed: proposals, blocked: [] };

    if (mandate.kill_switch_active) {
      return {
        allowed: [],
        blocked: proposals.map((p) => ({ proposal: p, reason: 'kill_switch_active' })),
      };
    }
    if (mandate.status !== 'active') {
      return {
        allowed: [],
        blocked: proposals.map((p) => ({
          proposal: p,
          reason: `mandat non actif (statut: ${mandate.status})`,
        })),
      };
    }

    const allowed: RawProposal[] = [];
    const blocked: Array<{ proposal: RawProposal; reason: string }> = [];

    for (const p of proposals) {
      const tickerUpper = p.ticker?.toUpperCase();
      if (tickerUpper && mandate.forbidden_tickers.map((t) => t.toUpperCase()).includes(tickerUpper)) {
        blocked.push({ proposal: p, reason: `ticker ${tickerUpper} interdit par le mandat` });
        continue;
      }
      if (
        p.assetClass &&
        mandate.allowed_asset_classes.length > 0 &&
        !mandate.allowed_asset_classes.includes(p.assetClass)
      ) {
        blocked.push({ proposal: p, reason: `classe d'actifs "${p.assetClass}" non autorisée par le mandat` });
        continue;
      }
      allowed.push(p);
    }

    return { allowed, blocked };
  }
}
