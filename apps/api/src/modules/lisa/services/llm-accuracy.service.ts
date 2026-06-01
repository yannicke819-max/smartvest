/**
 * LlmAccuracyService — boucle de feedback "qui a raison ?" sur les shadows LLM.
 *
 * Phase 1 : risk_monitor. Pour chaque position fermée, backfill les rows
 * llm_ab_shadow_decisions correspondantes (target_id=position.id) avec :
 *   - outcome_pnl_pct : PnL réel %
 *   - outcome_label   : win / loss / breakeven
 *
 * Ensuite computeAccuracy() agrège par provider : Brier score + Pearson
 * correlation entre verdict_score et outcome_pnl_pct.
 *
 * Endpoint : GET /admin/llm-accuracy?call_site=risk_monitor&days=14
 *
 * Phase 2 (PR follow-up) : étendre aux 3 autres call sites.
 */
import { Injectable, Logger, Optional } from '@nestjs/common';
import { SupabaseService } from '../../supabase/supabase.service';
import {
  brierScore,
  pearsonCorrelation,
  directionalAccuracy,
  parseRiskVerdictScore,
} from './llm-accuracy.helper';

interface ShadowEntry {
  provider: string;
  response_summary: string | null;
}

interface ShadowRow {
  id: string;
  applied_provider: string;
  applied_response_summary: string | null;
  shadows: ShadowEntry[] | null;
  outcome_pnl_pct: number | null;
  outcome_label: string | null;
}

export interface ProviderAccuracy {
  provider: string;
  n: number;
  brier: number | null;
  correlation: number | null;
  directional_accuracy: number | null;
  avg_score: number | null;
  avg_outcome_pct: number | null;
}

export interface CallSiteAccuracy {
  call_site: string;
  window_days: number;
  total_samples: number;
  resolved_samples: number;
  by_provider: ProviderAccuracy[];
  verdict: string;
}

@Injectable()
export class LlmAccuracyService {
  private readonly logger = new Logger(LlmAccuracyService.name);

  constructor(@Optional() private readonly supabase?: SupabaseService) {}

  /**
   * Appelé par MechanicalTradingService.closePosition après le close DB.
   * Backfill toutes les shadow rows risk_monitor associées à cette position.
   *
   * @param positionId  lisa_positions.id
   * @param pnlPct      PnL réalisé en % (positif = win, négatif = loss)
   */
  async linkPositionOutcome(positionId: string, pnlPct: number): Promise<void> {
    if (!this.supabase?.isReady()) return;
    const label = pnlPct > 0.05 ? 'win' : pnlPct < -0.05 ? 'loss' : 'breakeven';
    try {
      const { error } = await this.supabase
        .getClient()
        .from('llm_ab_shadow_decisions')
        .update({
          outcome_pnl_pct: pnlPct,
          outcome_label: label,
          outcome_resolved_at: new Date().toISOString(),
        })
        .eq('target_id', positionId)
        .is('outcome_resolved_at', null);
      if (error) {
        this.logger.debug(`[llm-accuracy] backfill ${positionId.slice(0, 8)} failed: ${error.message}`);
      }
    } catch (e) {
      this.logger.debug(`[llm-accuracy] backfill ${positionId.slice(0, 8)} exception: ${String(e).slice(0, 100)}`);
    }
  }

  /**
   * PR #536 — Backfill outcome dans gemini_ab_decisions pour le TRADER applied trade.
   * Lié par match (portfolio_id, pro_target_symbol, pro_action_kind=open_directional,
   * decided_at ±90s de entry_timestamp).
   *
   * Permet ensuite computeTraderAccuracy() de classer les 4 providers (Pro, Flash,
   * Mistral Medium, Large) par taux de win sur les cycles où ils étaient d'accord
   * avec Pro applied (concordance perfect).
   */
  async linkTraderDecisionOutcome(args: {
    positionId: string;
    portfolioId: string;
    symbol: string;
    entryTimestamp: string;
    pnlUsd: number;
  }): Promise<void> {
    if (!this.supabase?.isReady()) return;
    const entryTs = new Date(args.entryTimestamp);
    const before = new Date(entryTs.getTime() - 90_000).toISOString();
    const after = new Date(entryTs.getTime() + 90_000).toISOString();
    try {
      const { error } = await this.supabase
        .getClient()
        .from('gemini_ab_decisions')
        .update({
          outcome_position_id: args.positionId,
          outcome_pnl_usd: args.pnlUsd,
          outcome_win: args.pnlUsd > 0,
          outcome_resolved_at: new Date().toISOString(),
        })
        .eq('portfolio_id', args.portfolioId)
        .eq('pro_target_symbol', args.symbol)
        .eq('pro_action_kind', 'open_directional')
        .gte('decided_at', before)
        .lte('decided_at', after)
        .is('outcome_resolved_at', null);
      if (error) {
        this.logger.debug(`[llm-accuracy-trader] backfill ${args.positionId.slice(0, 8)} failed: ${error.message}`);
      }
    } catch (e) {
      this.logger.debug(`[llm-accuracy-trader] backfill ${args.positionId.slice(0, 8)} exception: ${String(e).slice(0, 100)}`);
    }
  }

  /**
   * Compute accuracy par provider sur gemini_ab_decisions (TRADER cycles).
   * Pour chaque provider (Pro / Flash / Mistral Medium / Large), calcule :
   *   - n_total : cycles où ce provider a été appelé
   *   - n_resolved : cycles où l'outcome est connu (Pro applied → trade fermé)
   *   - n_agreed_with_pro : cycles où ce provider matche Pro action+target
   *   - agreed_win_rate : sur les agreed, % de wins (= aurait fait pareil que Pro et gagné)
   *   - disagreed_n : cycles où le provider diffère de Pro (no hypothetical outcome yet, cf PR B)
   *
   * Verdict : ranking par agreed_win_rate (proxy : "ce provider est d'accord avec
   * Pro quand Pro gagne, désaccord quand Pro perd" = bonne discrimination).
   */
  async computeTraderAccuracy(days: number): Promise<{
    days: number;
    total_cycles: number;
    resolved_cycles: number;
    by_provider: Array<{
      provider: 'pro' | 'flash' | 'mistral-medium' | 'mistral-large';
      n_calls: number;
      n_resolved: number;
      n_agreed_with_pro: number;
      agreed_n_win: number;
      agreed_win_rate_pct: number | null;
      n_disagreed: number;
    }>;
    verdict: string;
  }> {
    if (!this.supabase?.isReady()) {
      return { days, total_cycles: 0, resolved_cycles: 0, by_provider: [], verdict: 'supabase not ready' };
    }
    const since = new Date(Date.now() - days * 24 * 3600_000).toISOString();
    interface TraderRow {
      pro_action_kind: string | null;
      pro_target_symbol: string | null;
      flash_action_kind: string | null;
      flash_target_symbol: string | null;
      mistral_action_kind: string | null;
      mistral_target_symbol: string | null;
      mistral_large_action_kind: string | null;
      mistral_large_target_symbol: string | null;
      outcome_resolved_at: string | null;
      outcome_win: boolean | null;
    }
    const { data: rowsRaw, error } = await this.supabase.getClient()
      .from('gemini_ab_decisions')
      .select(
        'pro_action_kind, pro_target_symbol, flash_action_kind, flash_target_symbol, ' +
        'mistral_action_kind, mistral_target_symbol, mistral_large_action_kind, mistral_large_target_symbol, ' +
        'outcome_resolved_at, outcome_win',
      )
      .gte('decided_at', since);
    if (error || !rowsRaw) {
      return { days, total_cycles: 0, resolved_cycles: 0, by_provider: [], verdict: `query failed: ${error?.message}` };
    }
    const rows = rowsRaw as unknown as TraderRow[];
    const total = rows.length;
    const resolved = rows.filter(r => r.outcome_resolved_at !== null);

    interface ProviderStats { n_calls: number; n_resolved: number; n_agreed: number; n_agreed_win: number; n_disagreed: number }
    const stats: Record<string, ProviderStats> = {
      pro: { n_calls: 0, n_resolved: 0, n_agreed: 0, n_agreed_win: 0, n_disagreed: 0 },
      flash: { n_calls: 0, n_resolved: 0, n_agreed: 0, n_agreed_win: 0, n_disagreed: 0 },
      'mistral-medium': { n_calls: 0, n_resolved: 0, n_agreed: 0, n_agreed_win: 0, n_disagreed: 0 },
      'mistral-large': { n_calls: 0, n_resolved: 0, n_agreed: 0, n_agreed_win: 0, n_disagreed: 0 },
    };

    const nullify = (s: string | null | undefined) => (s === '' || s == null ? null : s);
    for (const r of rows) {
      const proKey = `${r.pro_action_kind}/${nullify(r.pro_target_symbol) ?? '-'}`;
      const isResolved = r.outcome_resolved_at !== null;
      const proWin = r.outcome_win === true;

      stats.pro.n_calls++;
      if (isResolved) {
        stats.pro.n_resolved++;
        stats.pro.n_agreed++;
        if (proWin) stats.pro.n_agreed_win++;
      }

      const checks = [
        { key: 'flash', action: r.flash_action_kind, target: r.flash_target_symbol },
        { key: 'mistral-medium', action: r.mistral_action_kind, target: r.mistral_target_symbol },
        { key: 'mistral-large', action: r.mistral_large_action_kind, target: r.mistral_large_target_symbol },
      ];
      for (const c of checks) {
        if (c.action == null) continue;
        stats[c.key].n_calls++;
        if (!isResolved) continue;
        stats[c.key].n_resolved++;
        const providerKey = `${c.action}/${nullify(c.target) ?? '-'}`;
        if (providerKey === proKey) {
          stats[c.key].n_agreed++;
          if (proWin) stats[c.key].n_agreed_win++;
        } else {
          stats[c.key].n_disagreed++;
        }
      }
    }

    const byProvider = Object.entries(stats).map(([provider, s]) => ({
      provider: provider as 'pro' | 'flash' | 'mistral-medium' | 'mistral-large',
      n_calls: s.n_calls,
      n_resolved: s.n_resolved,
      n_agreed_with_pro: s.n_agreed,
      agreed_n_win: s.n_agreed_win,
      agreed_win_rate_pct: s.n_agreed > 0 ? (s.n_agreed_win / s.n_agreed) * 100 : null,
      n_disagreed: s.n_disagreed,
    }));
    byProvider.sort((a, b) => (b.agreed_win_rate_pct ?? -1) - (a.agreed_win_rate_pct ?? -1));

    const best = byProvider[0];
    const verdict =
      best && best.agreed_win_rate_pct !== null
        ? `${best.provider} agreed-with-Pro win rate ${best.agreed_win_rate_pct.toFixed(0)}% (n=${best.n_agreed_with_pro}/${best.n_resolved} ${days}d). ` +
          `Note : les cycles divergents (n=${best.n_disagreed}) nécessitent un shadow execution simulator (PR B) pour mesurer l'outcome hypothétique.`
        : `insufficient resolved samples (n=${resolved.length}) — patience requis`;

    return { days, total_cycles: total, resolved_cycles: resolved.length, by_provider: byProvider, verdict };
  }

  /**
   * Compute accuracy metrics par provider pour un call_site donné sur les
   * N derniers jours. Ne prend que les rows avec outcome_resolved_at set.
   */
  async computeAccuracy(callSite: string, days: number): Promise<CallSiteAccuracy> {
    if (!this.supabase?.isReady()) {
      return {
        call_site: callSite,
        window_days: days,
        total_samples: 0,
        resolved_samples: 0,
        by_provider: [],
        verdict: 'supabase not ready',
      };
    }

    const since = new Date(Date.now() - days * 24 * 3600_000).toISOString();
    const { data: rows, error } = await this.supabase
      .getClient()
      .from('llm_ab_shadow_decisions')
      .select('id, applied_provider, applied_response_summary, shadows, outcome_pnl_pct, outcome_label')
      .eq('call_site', callSite)
      .gte('created_at', since);
    if (error || !rows) {
      return {
        call_site: callSite,
        window_days: days,
        total_samples: 0,
        resolved_samples: 0,
        by_provider: [],
        verdict: `query failed: ${error?.message ?? 'unknown'}`,
      };
    }

    const totalSamples = rows.length;
    const resolved = rows.filter((r: ShadowRow) => r.outcome_pnl_pct !== null);
    if (resolved.length === 0) {
      return {
        call_site: callSite,
        window_days: days,
        total_samples: totalSamples,
        resolved_samples: 0,
        by_provider: [],
        verdict: `no resolved outcomes yet (need positions to close)`,
      };
    }

    // Phase 1 : risk_monitor only — extract score via parseRiskVerdictScore.
    // (Phase 2 : autres call sites auront leur propre extracteur.)
    const extractScore = callSite === 'risk_monitor' ? parseRiskVerdictScore : () => null;

    // Aggregate per provider
    const byProvider = new Map<string, { scores: number[]; outcomesPct: number[]; outcomesBin: number[] }>();
    const ensure = (p: string) => {
      if (!byProvider.has(p)) byProvider.set(p, { scores: [], outcomesPct: [], outcomesBin: [] });
      return byProvider.get(p)!;
    };

    for (const r of resolved as ShadowRow[]) {
      const outcomePct = Number(r.outcome_pnl_pct);
      const outcomeBin = outcomePct > 0 ? 1 : 0;

      // Applied provider
      const appliedScore = extractScore(r.applied_response_summary);
      if (appliedScore !== null) {
        const b = ensure(r.applied_provider);
        b.scores.push(appliedScore);
        b.outcomesPct.push(outcomePct);
        b.outcomesBin.push(outcomeBin);
      }

      // Shadow providers
      for (const s of r.shadows ?? []) {
        const sScore = extractScore(s.response_summary);
        if (sScore !== null) {
          const b = ensure(s.provider);
          b.scores.push(sScore);
          b.outcomesPct.push(outcomePct);
          b.outcomesBin.push(outcomeBin);
        }
      }
    }

    const byProviderArr: ProviderAccuracy[] = [];
    for (const [provider, b] of byProvider.entries()) {
      byProviderArr.push({
        provider,
        n: b.scores.length,
        brier: brierScore(b.scores, b.outcomesBin),
        correlation: pearsonCorrelation(b.scores, b.outcomesPct),
        directional_accuracy: directionalAccuracy(b.scores, b.outcomesPct),
        avg_score: b.scores.length > 0 ? b.scores.reduce((s, v) => s + v, 0) / b.scores.length : null,
        avg_outcome_pct:
          b.outcomesPct.length > 0 ? b.outcomesPct.reduce((s, v) => s + v, 0) / b.outcomesPct.length : null,
      });
    }

    // Sort by Brier (lower = better)
    byProviderArr.sort((a, b) => (a.brier ?? Infinity) - (b.brier ?? Infinity));
    const best = byProviderArr[0];
    const verdict =
      best && best.brier !== null
        ? `${best.provider} is best on ${callSite} (Brier=${best.brier.toFixed(3)}, n=${best.n}/${resolved.length} samples ${days}d)`
        : `insufficient resolved samples for ranking (n=${resolved.length})`;

    return {
      call_site: callSite,
      window_days: days,
      total_samples: totalSamples,
      resolved_samples: resolved.length,
      by_provider: byProviderArr,
      verdict,
    };
  }
}
