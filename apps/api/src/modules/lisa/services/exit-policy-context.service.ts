/**
 * ExitPolicyContextService — distille position_close_decisions en POLITIQUE DE
 * SORTIE APPRISE, injectée dans le prompt TRADER pour qu'il agrège indicateurs
 * live + mémoire + vérité-terrain en UNE décision HOLD/TRAIL/CLOSE.
 *
 * Le cœur de l'idée user : TRADER n'apprend pas à copier l'humain, il apprend
 * QUAND une sortie est bonne (verdict counterfactuel GOOD/EARLY/OK).
 *
 * Garde-fou confidence : tant que < N closes labellisés, on retourne les
 * heuristiques par défaut (TP sweep 03/06 : laisser courir vers +3%) + un
 * marqueur confidence faible. La politique apprise PRIME sur le défaut
 * uniquement quand l'échantillon est suffisant.
 *
 * Cache 5 min (la politique évolue lentement, pas besoin de re-query/cycle).
 */
import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../../supabase/supabase.service';

interface CloseRow {
  closer_type: string;
  verdict: string | null;
  pnl_pct: number | null;
  give_back_from_mfe: number | null;
  mfe_pct: number | null;
  rsi14: number | null;
  macd_hist: number | null;
  trend_5m_pct: number | null;
  bb_pct_b: number | null;
  max_favorable_after_60m_pct: number | null;
}

export interface LearnedExitPolicy {
  sampleSize: number;
  labeledSize: number;
  confidence: number;
  /** Bloc texte prêt à injecter dans le prompt TRADER. */
  promptBlock: string;
}

@Injectable()
export class ExitPolicyContextService {
  private readonly logger = new Logger(ExitPolicyContextService.name);
  private cache = new Map<string, { at: number; policy: LearnedExitPolicy }>();
  private readonly TTL_MS = 5 * 60_000;
  private readonly MIN_SAMPLE = 20; // sous ce seuil → heuristiques défaut prime

  constructor(private readonly supabase: SupabaseService) {}

  async getLearnedExitPolicy(portfolioId: string): Promise<LearnedExitPolicy> {
    const hit = this.cache.get(portfolioId);
    if (hit && Date.now() - hit.at < this.TTL_MS) return hit.policy;

    const policy = await this.compute(portfolioId).catch((e) => {
      this.logger.debug(`[exit-policy] ${portfolioId.slice(0, 8)}: ${String(e).slice(0, 120)}`);
      return this.defaultPolicy(0, 0);
    });
    this.cache.set(portfolioId, { at: Date.now(), policy });
    return policy;
  }

  /**
   * 04/06/2026 — Variante source-scoped : distille uniquement les closes des
   * positions dont venue_fee_detail->>source matche (ex: 'scanner_oversold',
   * 'scanner_top_gainers'). Permet 2 boucles d'apprentissage SÉPARÉES sur le
   * même portfolio_id (HIGH a 28 vieux gainers shadow + N oversold ; mixer
   * biaiserait la policy oversold). Cache 5 min, clé = `${portfolioId}::${source}`.
   */
  async getLearnedExitPolicyBySource(portfolioId: string, source: string): Promise<LearnedExitPolicy> {
    const cacheKey = `${portfolioId}::${source}`;
    const hit = this.cache.get(cacheKey);
    if (hit && Date.now() - hit.at < this.TTL_MS) return hit.policy;
    const policy = await this.computeBySource(portfolioId, source).catch((e) => {
      this.logger.debug(`[exit-policy:${source}] ${portfolioId.slice(0, 8)}: ${String(e).slice(0, 120)}`);
      return this.defaultPolicy(0, 0);
    });
    this.cache.set(cacheKey, { at: Date.now(), policy });
    return policy;
  }

  private async computeBySource(portfolioId: string, source: string): Promise<LearnedExitPolicy> {
    const since = new Date(Date.now() - 30 * 86400_000).toISOString();
    const client = this.supabase.getClient();
    // Étape 1 : récupérer les position_id du portfolio qui matchent la source.
    const { data: posRows } = await client
      .from('lisa_positions')
      .select('id')
      .eq('portfolio_id', portfolioId)
      .eq('venue_fee_detail->>source', source)
      .gte('exit_timestamp', since);
    const positionIds = ((posRows ?? []) as Array<{ id: string }>).map((p) => p.id);
    if (positionIds.length === 0) return this.defaultPolicy(0, 0);
    // Étape 2 : close_decisions filtrées sur ces IDs.
    const { data } = await client
      .from('position_close_decisions')
      .select('closer_type, verdict, pnl_pct, give_back_from_mfe, mfe_pct, rsi14, macd_hist, trend_5m_pct, bb_pct_b, max_favorable_after_60m_pct')
      .in('position_id', positionIds)
      .limit(5000);
    const rows = (data ?? []) as CloseRow[];
    return this.synthesize(rows);
  }

  private async compute(portfolioId: string): Promise<LearnedExitPolicy> {
    const since = new Date(Date.now() - 30 * 86400_000).toISOString();
    const { data } = await this.supabase.getClient()
      .from('position_close_decisions')
      .select('closer_type, verdict, pnl_pct, give_back_from_mfe, mfe_pct, rsi14, macd_hist, trend_5m_pct, bb_pct_b, max_favorable_after_60m_pct')
      .eq('portfolio_id', portfolioId)
      .gte('closed_at', since)
      .limit(5000);
    const rows = (data ?? []) as CloseRow[];
    return this.synthesize(rows);
  }

  /** Synthèse partagée entre compute() et computeBySource(). */
  private synthesize(rowsIn: CloseRow[]): LearnedExitPolicy {
    const rows = rowsIn;
    const labeled = rows.filter((r) => r.verdict != null);

    if (labeled.length < this.MIN_SAMPLE) {
      return this.defaultPolicy(rows.length, labeled.length);
    }

    const confidence = clamp(labeled.length / 100, 0.2, 0.95);

    // GOOD = sorties justifiées (vérité-terrain : le prix a chuté/stagné après)
    const good = labeled.filter((r) => r.verdict === 'GOOD');
    const early = labeled.filter((r) => r.verdict === 'EARLY');

    // Règle de trailing implicite : give_back médian des bonnes sorties
    const goodGiveBack = median(good.map((r) => r.give_back_from_mfe).filter(isNum));
    const goodRsi = median(good.map((r) => r.rsi14).filter(isNum));
    const goodTrend = median(good.map((r) => r.trend_5m_pct).filter(isNum));

    // Anti-pattern : ce que les sorties trop tôt avaient (à NE PAS reproduire)
    const earlyRsi = median(early.map((r) => r.rsi14).filter(isNum));
    const earlyLeftOnTable = median(early.map((r) => r.max_favorable_after_60m_pct).filter(isNum));

    // Fiabilité du closed_choppy mécanique (le levier qu'on veut A/B)
    const choppy = labeled.filter((r) => r.closer_type === 'closed_choppy');
    const choppyGoodPct = choppy.length > 0 ? choppy.filter((r) => r.verdict === 'GOOD').length / choppy.length : null;
    const choppyEarlyPct = choppy.length > 0 ? choppy.filter((r) => r.verdict === 'EARLY').length / choppy.length : null;

    // Comparaison user vs mécanique
    const userCloses = labeled.filter((r) => r.closer_type === 'user_manual');
    const userGoodPct = userCloses.length > 0 ? userCloses.filter((r) => r.verdict === 'GOOD').length / userCloses.length : null;

    const lines: string[] = [];
    lines.push(`POLITIQUE DE SORTIE APPRISE (sur ${labeled.length} closes labellisés, confidence ${(confidence * 100).toFixed(0)}%) :`);
    if (goodGiveBack != null) {
      lines.push(`- RÈGLE TRAILING APPRISE : les bonnes sorties (GOOD, n=${good.length}) avaient un give_back médian de ${goodGiveBack.toFixed(2)}% depuis le pic MFE. → Si une position rend PLUS de ${goodGiveBack.toFixed(2)}% sous son pic ET momentum faiblit → CLOSE/TRAIL.`);
    }
    if (goodRsi != null || goodTrend != null) {
      lines.push(`- Profil des GOOD : RSI médian ${goodRsi?.toFixed(0) ?? '?'}, trend_5m médian ${goodTrend?.toFixed(2) ?? '?'}%.`);
    }
    if (early.length >= 3 && earlyLeftOnTable != null) {
      lines.push(`- ⚠️ ANTI-PATTERN (EARLY, n=${early.length}) : sorties trop tôt — RSI médian ${earlyRsi?.toFixed(0) ?? '?'}, et le prix a continué +${earlyLeftOnTable.toFixed(2)}% APRÈS. NE PAS fermer dans ce profil si momentum encore vivant.`);
    }
    if (choppyGoodPct != null) {
      const verdictTxt = choppyEarlyPct != null && choppyEarlyPct > 0.5
        ? `→ closed_choppy ferme TROP TÔT ${(choppyEarlyPct * 100).toFixed(0)}% du temps (à desserrer)`
        : `→ closed_choppy fiable (${(choppyGoodPct * 100).toFixed(0)}% GOOD)`;
      lines.push(`- MÉCANIQUE : closed_choppy ${(choppyGoodPct * 100).toFixed(0)}% GOOD / ${((choppyEarlyPct ?? 0) * 100).toFixed(0)}% EARLY (n=${choppy.length}) ${verdictTxt}.`);
    }
    if (userGoodPct != null) {
      lines.push(`- USER : tes closes manuels ${(userGoodPct * 100).toFixed(0)}% GOOD (n=${userCloses.length}) — référence humaine.`);
    }
    lines.push(this.decisionFramework(goodGiveBack));

    return {
      sampleSize: rows.length,
      labeledSize: labeled.length,
      confidence,
      promptBlock: lines.join('\n'),
    };
  }

  /** Heuristiques par défaut (cold start ou sample insuffisant). */
  private defaultPolicy(sampleSize: number, labeledSize: number): LearnedExitPolicy {
    const block = [
      `POLITIQUE DE SORTIE (heuristiques défaut — ${labeledSize} closes labellisés, pas encore assez pour apprentissage ; collecte en cours) :`,
      `- TP sweep 03/06 (n=2750 marché réel) : l'espérance MONTE avec le TP. Les gagnants courent. NE PAS sous-fermer.`,
      this.decisionFramework(null),
    ].join('\n');
    return { sampleSize, labeledSize, confidence: 0.1, promptBlock: block };
  }

  /**
   * Framework de décision structuré — c'est CE QUE TRADER doit suivre pour
   * agréger tous les signaux en UNE décision HOLD/TRAIL_STOP/CLOSE.
   */
  private decisionFramework(learnedGiveBack: number | null): string {
    const gbThreshold = learnedGiveBack != null ? `${learnedGiveBack.toFixed(2)}%` : '0.8% (défaut)';
    return [
      ``,
      `FRAMEWORK DE DÉCISION SORTIE (agrège indicateurs live + politique apprise + mémoire en UNE décision) :`,
      `Pour CHAQUE position ouverte, raisonne dans cet ordre :`,
      `1. MOMENTUM VIVANT ? (macd_hist > 0 ET prix > vwap ET rsi NON en chute depuis >70) → HOLD vers le TP. Les gagnants courent (TP sweep +EV jusqu'à +3%). Ne ferme PAS un trend sain.`,
      `2. MOMENTUM FAIBLIT (macd_hist < 0 OU rsi chute depuis >70 OU prix < vwap OU trend_5m < 0) :`,
      `   a. pnl > +1% ET give_back_from_mfe < ${gbThreshold} → TRAIL_STOP (lock breakeven+, laisse une dernière chance vers TP).`,
      `   b. pnl > +1% ET give_back_from_mfe >= ${gbThreshold} → CLOSE (la politique apprise dit que rendre plus = perdre le gain). Cite "[EXIT_LEARNED give_back=X%]".`,
      `   c. pnl <= 0 → HOLD, laisse le SL gérer. Ne coupe PAS en perte sur du bruit (sauf news shock / thesis cassée).`,
      `3. APPROCHE TP (dist_to_tp < 0.5%) → HOLD, le TP va se déclencher seul.`,
      `4. EN DOUTE entre 2 options → consulte ta mémoire (lessons winning_pattern) + le profil GOOD/EARLY appris ci-dessus. Choisis l'action qui ressemble aux GOOD, évite le profil EARLY.`,
      `IMPÉRATIF : UNE seule décision par position, justifiée par les chiffres concrets (cite rsi, macd_hist, give_back, vwap dans ta thesis). C'est décisif — ne ferme ni trop tôt (EARLY) ni trop tard (give-back total).`,
    ].join('\n');
  }
}

function median(arr: number[]): number | null {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function isNum(n: number | null): n is number { return n != null && Number.isFinite(n); }
function clamp(n: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, n)); }
