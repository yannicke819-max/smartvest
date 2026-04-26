import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../../supabase/supabase.service';

/**
 * LisaPerformanceAnalyticsService — Phase 5.
 *
 * Agrège lisa_trade_outcomes pour produire un résumé contextualisé qu'on
 * injecte dans le briefing Lisa. Permet à Lisa de calibrer sa confiance
 * sur des stats EMPIRIQUES de SES propres trades, pas sur des intuitions.
 *
 * 4 dimensions agrégées :
 *  - regime (regime macro détecté au moment de l'ouverture)
 *  - VIX bucket (calme < 15, normal 15-22, élevé 22-30, extrême > 30)
 *  - conviction (bucket 5-6, 6-7, 7-8, 8+)
 *  - symbole (RTX, BTC, GLD, etc.)
 *
 * Le briefing met l'emphase sur les buckets matchant le contexte courant
 * pour que Lisa lise "dans CE regime + CE VIX bucket, voici ton track
 * record" plutôt qu'un dump global.
 */
@Injectable()
export class LisaPerformanceAnalyticsService {
  private readonly logger = new Logger(LisaPerformanceAnalyticsService.name);
  private readonly cache = new Map<string, { text: string; asOf: number }>();
  private readonly CACHE_MS = 5 * 60 * 1000;

  constructor(private readonly supabase: SupabaseService) {}

  /**
   * Calcule l'edge contextualisé pour le cycle courant.
   *
   * @param portfolioId
   * @param currentRegime regime au cycle courant (mis en avant)
   * @param currentVix VIX au cycle courant (sert au bucket courant)
   * @param candidateSymbols symboles que Lisa pourrait proposer ce cycle
   *   (sert à highlighter leur track record si déjà tradés)
   * @param lookbackDays défaut 30
   */
  async getContextualEdge(
    portfolioId: string,
    currentRegime: string | null,
    currentVix: number | null,
    candidateSymbols: string[],
    lookbackDays = 30,
  ): Promise<string> {
    const cacheKey = `${portfolioId}:${currentRegime ?? '?'}:${currentVix?.toFixed(1) ?? '?'}:${candidateSymbols.sort().join(',')}:${lookbackDays}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.asOf < this.CACHE_MS) return cached.text;

    try {
      const since = new Date(Date.now() - lookbackDays * 86_400_000).toISOString();
      const { data: outcomes } = await this.supabase.getClient()
        .from('lisa_trade_outcomes')
        .select('open_regime, open_vix, open_conviction, symbol, return_pct, close_reason')
        .eq('portfolio_id', portfolioId)
        .gte('close_at', since)
        .limit(500);

      const records = (outcomes ?? []).map((r) => ({
        regime: r.open_regime as string | null,
        vix: r.open_vix as number | null,
        conviction: r.open_conviction as number | null,
        symbol: r.symbol as string,
        returnPct: Number(r.return_pct),
        closeReason: r.close_reason as string,
      }));

      const text = this.formatEdge(records, currentRegime, currentVix, candidateSymbols, lookbackDays);
      this.cache.set(cacheKey, { text, asOf: Date.now() });
      return text;
    } catch (e) {
      this.logger.warn(`getContextualEdge failed: ${String(e).slice(0, 120)}`);
      return '(analytics indisponibles — premier cycle ou erreur de lecture)';
    }
  }

  // ────────────────────────────────────────────────────────────────────

  private formatEdge(
    records: TradeRecord[],
    currentRegime: string | null,
    currentVix: number | null,
    candidateSymbols: string[],
    lookbackDays: number,
  ): string {
    if (records.length === 0) {
      return `(aucun trade fermé sur les ${lookbackDays} derniers jours — pas encore de feedback empirique. Continue à proposer normalement et accumule des données pour les cycles suivants.)`;
    }

    const totalWins = records.filter((r) => r.returnPct > 0).length;
    const totalReturn = records.reduce((s, r) => s + r.returnPct, 0) / records.length;

    const lines: string[] = [];
    lines.push(`📊 EDGE CONFIRMÉ sur ton portefeuille (${lookbackDays}j, ${records.length} trades fermés) :`);
    lines.push(`   Win rate global ${((totalWins / records.length) * 100).toFixed(0)}% · return moyen ${totalReturn >= 0 ? '+' : ''}${totalReturn.toFixed(2)}%`);
    lines.push('');

    // ── Par regime (current en premier) ──────────────────────────────
    const byRegime = this.groupBy(records, (r) => r.regime ?? 'unknown');
    const regimeStats = Array.from(byRegime.entries()).map(([k, rs]) => ({
      key: k,
      ...this.computeStats(rs),
    }));
    regimeStats.sort((a, b) => {
      if (currentRegime && a.key === currentRegime) return -1;
      if (currentRegime && b.key === currentRegime) return 1;
      return b.count - a.count;
    });
    lines.push(`📂 Par regime :`);
    for (const s of regimeStats.slice(0, 5)) {
      const isCurrent = currentRegime && s.key === currentRegime;
      const marker = isCurrent ? '👉' : '  ';
      lines.push(`${marker} ${s.key} : ${s.count} trades · ${s.winRate.toFixed(0)}% win · ${s.avgReturn >= 0 ? '+' : ''}${s.avgReturn.toFixed(2)}% avg`);
    }
    lines.push('');

    // ── Par bucket VIX (current en premier) ──────────────────────────
    const vixBuckets = this.bucketByVix(records);
    const currentBucket = currentVix != null ? this.vixBucketLabel(currentVix) : null;
    const vixStats = Array.from(vixBuckets.entries()).map(([k, rs]) => ({
      key: k,
      ...this.computeStats(rs),
    }));
    vixStats.sort((a, b) => {
      if (currentBucket && a.key === currentBucket) return -1;
      if (currentBucket && b.key === currentBucket) return 1;
      return b.count - a.count;
    });
    lines.push(`📂 Par bucket VIX${currentVix != null ? ` (courant : ${currentVix.toFixed(1)} = ${currentBucket})` : ''} :`);
    for (const s of vixStats.slice(0, 4)) {
      const isCurrent = currentBucket && s.key === currentBucket;
      const marker = isCurrent ? '👉' : '  ';
      lines.push(`${marker} ${s.key} : ${s.count} trades · ${s.winRate.toFixed(0)}% win · ${s.avgReturn >= 0 ? '+' : ''}${s.avgReturn.toFixed(2)}% avg`);
    }
    lines.push('');

    // ── Par bucket conviction ────────────────────────────────────────
    const convBuckets = this.bucketByConviction(records);
    const convStats = Array.from(convBuckets.entries())
      .map(([k, rs]) => ({ key: k, ...this.computeStats(rs) }))
      .sort((a, b) => a.key.localeCompare(b.key));
    if (convStats.some((s) => s.count >= 1)) {
      lines.push(`📂 Par conviction émise :`);
      for (const s of convStats) {
        const flag = s.count >= 5 && s.winRate < 40 ? ' ⚠️ edge faible'
                  : s.count >= 5 && s.winRate >= 60 ? ' ✅ edge confirmé'
                  : '';
        lines.push(`   ${s.key} : ${s.count} trades · ${s.winRate.toFixed(0)}% win · ${s.avgReturn >= 0 ? '+' : ''}${s.avgReturn.toFixed(2)}% avg${flag}`);
      }
      lines.push('');
    }

    // ── Track record des candidats du cycle ──────────────────────────
    if (candidateSymbols.length > 0) {
      const candidatesTraded = candidateSymbols.filter((s) =>
        records.some((r) => r.symbol === s),
      );
      if (candidatesTraded.length > 0) {
        lines.push(`📂 Track record des symboles candidats ce cycle :`);
        for (const sym of candidatesTraded) {
          const symRecords = records.filter((r) => r.symbol === sym);
          const stats = this.computeStats(symRecords);
          const flag = stats.count >= 3 && stats.winRate < 40 ? ' ⚠️ historique négatif'
                    : stats.count >= 3 && stats.winRate >= 67 ? ' ✅ historique gagnant'
                    : stats.count < 3 ? ' (échantillon faible)'
                    : '';
          lines.push(`   ${sym} : ${stats.count} trades · ${stats.winRate.toFixed(0)}% win · ${stats.avgReturn >= 0 ? '+' : ''}${stats.avgReturn.toFixed(2)}% avg${flag}`);
        }
        lines.push('');
      }
    }

    // ── Lecture stratégique ──────────────────────────────────────────
    lines.push(`🎯 Lecture stratégique :`);
    lines.push(`   - Si une cellule "👉 ${currentRegime ?? '?'}" affiche ≥5 trades + win rate ≥60%, ton edge sur ce regime est confirmé : sois opportuniste.`);
    lines.push(`   - Si win rate <40% sur ≥5 trades, sois plus sélectif (conviction +1, taille -25%).`);
    lines.push(`   - Si conviction 6-7 a un edge négatif, monte ton floor à 7+.`);
    lines.push(`   - Si un symbole candidat a un historique négatif, justifie pourquoi ce cycle est différent OU substitue par un autre.`);
    lines.push(`   - Échantillon <5 trades = exploration, traite comme conviction normale sans extrapoler.`);
    return lines.join('\n');
  }

  private groupBy<T, K>(arr: T[], key: (r: T) => K): Map<K, T[]> {
    const m = new Map<K, T[]>();
    for (const r of arr) {
      const k = key(r);
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(r);
    }
    return m;
  }

  private computeStats(records: TradeRecord[]): { count: number; winRate: number; avgReturn: number } {
    const count = records.length;
    if (count === 0) return { count: 0, winRate: 0, avgReturn: 0 };
    const wins = records.filter((r) => r.returnPct > 0).length;
    const sum = records.reduce((s, r) => s + r.returnPct, 0);
    return { count, winRate: (wins / count) * 100, avgReturn: sum / count };
  }

  private vixBucketLabel(vix: number): string {
    if (vix < 15) return 'calme (<15)';
    if (vix < 22) return 'normal (15-22)';
    if (vix < 30) return 'élevé (22-30)';
    return 'extrême (>30)';
  }

  private bucketByVix(records: TradeRecord[]): Map<string, TradeRecord[]> {
    const m = new Map<string, TradeRecord[]>();
    for (const r of records) {
      if (r.vix === null) continue;
      const b = this.vixBucketLabel(r.vix);
      if (!m.has(b)) m.set(b, []);
      m.get(b)!.push(r);
    }
    return m;
  }

  private convBucketLabel(c: number): string {
    if (c < 6) return '<6';
    if (c < 7) return '6-7';
    if (c < 8) return '7-8';
    return '8+';
  }

  private bucketByConviction(records: TradeRecord[]): Map<string, TradeRecord[]> {
    const m = new Map<string, TradeRecord[]>();
    for (const r of records) {
      if (r.conviction === null) continue;
      const b = this.convBucketLabel(r.conviction);
      if (!m.has(b)) m.set(b, []);
      m.get(b)!.push(r);
    }
    return m;
  }
}

interface TradeRecord {
  regime: string | null;
  vix: number | null;
  conviction: number | null;
  symbol: string;
  returnPct: number;
  closeReason: string;
}
