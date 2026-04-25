import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../../supabase/supabase.service';

/**
 * LisaMemoryService — Phase 3.
 *
 * Donne à Lisa un accès à la mémoire de ses propres décisions passées sur
 * ce portefeuille. Avant cette V1, Lisa avait :
 *  - corpus historique (25 events) — analogs macro
 *  - HistoryMetrics agrégés (return 7j/30j, win rate, drawdown)
 * Mais elle n'avait JAMAIS de feedback contextuel sur SES décisions :
 *  "j'ai déjà proposé GLD en regime=policy_pivot_dovish 4 fois → 3 win, 1 loss"
 *
 * V1 : agrège par detected_regime sur les N derniers jours :
 *  - count propositions générées
 *  - count exécutées (autopilot ou manual approve)
 *  - win rate + return moyen des positions issues de ces propositions
 *  - dernier rationale par regime (texte court pour rappel contextuel)
 *
 * Format retourné = texte pré-formaté à injecter sous # YOUR PAST DECISIONS
 * dans le briefing Lisa. Permet à Claude de calibrer sa confiance ("ce
 * regime j'ai déjà 70% de win rate" vs "j'ai jamais bien performé ici").
 */
@Injectable()
export class LisaMemoryService {
  private readonly logger = new Logger(LisaMemoryService.name);
  private readonly cache = new Map<string, { text: string; asOf: number }>();
  private readonly CACHE_MS = 5 * 60 * 1000; // 5 min

  constructor(private readonly supabase: SupabaseService) {}

  /**
   * Récupère la mémoire de Lisa pour un portefeuille donné.
   * Cache 5 min pour éviter de re-querier à chaque cycle.
   *
   * @param portfolioId
   * @param currentRegime regime détecté au cycle en cours (mis en avant)
   * @param lookbackDays nombre de jours d'historique (défaut 30)
   */
  async getMemoryBriefing(
    portfolioId: string,
    currentRegime: string | null,
    lookbackDays = 30,
  ): Promise<string> {
    const cacheKey = `${portfolioId}:${currentRegime ?? 'unknown'}:${lookbackDays}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.asOf < this.CACHE_MS) return cached.text;

    try {
      const since = new Date(Date.now() - lookbackDays * 86_400_000).toISOString();

      // Fetch propositions récentes
      const { data: proposals } = await this.supabase.getClient()
        .from('lisa_proposals')
        .select('id, detected_regime, regime_summary, status, created_at')
        .eq('portfolio_id', portfolioId)
        .gte('created_at', since)
        .order('created_at', { ascending: false })
        .limit(200);

      // Fetch positions fermées sur la même période (pour calculer outcome)
      const { data: closedPositions } = await this.supabase.getClient()
        .from('lisa_positions')
        .select('id, proposal_id, symbol, realized_pnl_pct, status, closed_at')
        .eq('portfolio_id', portfolioId)
        .eq('status', 'closed')
        .gte('closed_at', since)
        .limit(200);

      const text = this.formatMemory(
        proposals ?? [],
        closedPositions ?? [],
        currentRegime,
        lookbackDays,
      );
      this.cache.set(cacheKey, { text, asOf: Date.now() });
      return text;
    } catch (e) {
      this.logger.warn(`memory fetch failed: ${String(e).slice(0, 120)}`);
      return '(mémoire indisponible — premier cycle ou erreur de récupération)';
    }
  }

  // ────────────────────────────────────────────────────────────────────

  private formatMemory(
    proposals: Array<Record<string, unknown>>,
    closedPositions: Array<Record<string, unknown>>,
    currentRegime: string | null,
    lookbackDays: number,
  ): string {
    if (proposals.length === 0) {
      return `(aucune proposition Lisa sur les ${lookbackDays} derniers jours — démarrage à froid, pas de feedback contextuel disponible)`;
    }

    // Group propositions par regime
    const byRegime = new Map<string, RegimeStats>();
    for (const p of proposals) {
      const r = String(p.detected_regime ?? 'unknown');
      if (!byRegime.has(r)) {
        byRegime.set(r, { regime: r, count: 0, executed: 0, proposalIds: [], lastSummary: null, lastDate: null });
      }
      const s = byRegime.get(r)!;
      s.count += 1;
      if (p.status === 'executed' || p.status === 'approved') s.executed += 1;
      s.proposalIds.push(String(p.id));
      // Garde le summary le plus récent (proposals trié desc)
      if (!s.lastSummary && p.regime_summary) {
        s.lastSummary = String(p.regime_summary).slice(0, 200);
        s.lastDate = String(p.created_at).slice(0, 10);
      }
    }

    // Match positions fermées aux propositions par proposal_id
    const proposalToPnl = new Map<string, number[]>();
    for (const pos of closedPositions) {
      const pid = String(pos.proposal_id ?? '');
      if (!pid) continue;
      const pnl = Number(pos.realized_pnl_pct);
      if (!isFinite(pnl)) continue;
      if (!proposalToPnl.has(pid)) proposalToPnl.set(pid, []);
      proposalToPnl.get(pid)!.push(pnl);
    }

    // Pour chaque regime, calcule win rate + return moyen
    for (const stats of byRegime.values()) {
      const allPnls: number[] = [];
      for (const pid of stats.proposalIds) {
        const pnls = proposalToPnl.get(pid);
        if (pnls) allPnls.push(...pnls);
      }
      stats.closedPositions = allPnls.length;
      if (allPnls.length > 0) {
        const wins = allPnls.filter((p) => p > 0).length;
        stats.winRatePct = (wins / allPnls.length) * 100;
        stats.avgReturnPct = allPnls.reduce((a, b) => a + b, 0) / allPnls.length;
      } else {
        stats.winRatePct = null;
        stats.avgReturnPct = null;
      }
    }

    // Trie : regime courant en premier, puis par count desc
    const sorted = Array.from(byRegime.values()).sort((a, b) => {
      if (currentRegime && a.regime === currentRegime) return -1;
      if (currentRegime && b.regime === currentRegime) return 1;
      return b.count - a.count;
    });

    // Format texte
    const lines: string[] = [];
    lines.push(`📚 MÉMOIRE — tes ${proposals.length} dernières propositions (${lookbackDays}j) sur ce portefeuille :`);
    lines.push(`   Total positions fermées : ${closedPositions.length} · Regime courant : ${currentRegime ?? '?'}`);
    lines.push('');
    for (const s of sorted.slice(0, 8)) {
      const isCurrent = currentRegime && s.regime === currentRegime;
      const marker = isCurrent ? '👉' : '  ';
      const winRateStr = s.winRatePct != null
        ? `${s.winRatePct.toFixed(0)}% win (${s.closedPositions ?? 0} closed)`
        : 'pas encore de fermetures';
      const avgReturnStr = s.avgReturnPct != null
        ? `${s.avgReturnPct >= 0 ? '+' : ''}${s.avgReturnPct.toFixed(2)}% avg`
        : '—';
      lines.push(
        `${marker} ${s.regime} : ${s.count} propositions (${s.executed} exec) · ${winRateStr} · ${avgReturnStr}`,
      );
      if (isCurrent && s.lastSummary) {
        lines.push(`     └─ Dernier rationale (${s.lastDate}) : ${s.lastSummary}`);
      }
    }
    lines.push('');
    lines.push(`🎯 Lecture clé : si le regime courant a un win rate < 40 % sur ≥5 fermetures, sois plus sélectif. Si > 60 % sur ≥5 fermetures, ton edge sur ce regime est confirmé — saisis les opportunités. Sans données suffisantes (< 5 closed), traite comme exploration.`);
    return lines.join('\n');
  }
}

interface RegimeStats {
  regime: string;
  count: number;
  executed: number;
  proposalIds: string[];
  lastSummary: string | null;
  lastDate: string | null;
  closedPositions?: number;
  winRatePct?: number | null;
  avgReturnPct?: number | null;
}
