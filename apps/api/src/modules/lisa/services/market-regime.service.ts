import { Injectable, Logger } from '@nestjs/common';
import {
  classifyTacticalRegime,
  type RegimeClassification,
  type RegimeInputs,
  type TacticalRegime,
} from '@smartvest/ai-analyst';
import { SupabaseService } from '../../supabase/supabase.service';

/**
 * MarketRegimeService — classifie le régime tactique du marché toutes les
 * 5 min (cache TTL) et persiste chaque classification dans
 * `market_regimes_log` pour audit + backtest.
 *
 * P1 (28/04/2026) — feat/market-regime.
 *
 * Le classifier est PUR (`classifyTacticalRegime` dans ai-analyst). Ce
 * service est l'orchestrateur côté NestJS qui :
 *   1. Lit les inputs (BTC 24h return, funding, VIX, ATR ratio, news score)
 *      depuis le `MarketSnapshot` courant
 *   2. Délègue au classifier pur
 *   3. Cache 5 min en mémoire (évite de re-classifier à chaque cycle 60s)
 *   4. Persiste dans `market_regimes_log` (best-effort, fail-soft)
 *
 * Lisa (LisaService.fetchMarketSnapshot) appelle `getCurrentRegime()` pour
 * enrichir le briefing prompt + le RiskEnforcer applique le `sizingMultiplier`
 * sur les nouvelles ouvertures.
 */
@Injectable()
export class MarketRegimeService {
  private readonly logger = new Logger(MarketRegimeService.name);
  private readonly CACHE_MS = 5 * 60 * 1000;
  private cached: { result: RegimeClassification; asOf: number; inputs: RegimeInputs } | null = null;

  constructor(private readonly supabase: SupabaseService) {}

  /**
   * Classifie + cache + persiste. Si le cache est encore valide (< 5 min),
   * retourne directement sans recalcul ni nouvelle écriture DB.
   */
  async getCurrentRegime(inputs: RegimeInputs): Promise<RegimeClassification> {
    const now = Date.now();
    if (this.cached && now - this.cached.asOf < this.CACHE_MS) {
      return this.cached.result;
    }

    const result = classifyTacticalRegime(inputs);
    this.cached = { result, asOf: now, inputs };

    // Persistence best-effort — un fail DB ne doit pas bloquer le cycle Lisa.
    void this.persist(result, inputs).catch((e) => {
      this.logger.warn(`[regime] persist failed (non-blocking): ${String(e).slice(0, 120)}`);
    });

    return result;
  }

  /**
   * Snapshot du régime courant SANS recalcul. Retourne null si pas encore
   * classifié dans le cycle de vie du process. Utile pour les call sites
   * qui veulent juste lire (ex: UI status sans déclencher une classif).
   */
  peekCurrentRegime(): RegimeClassification | null {
    if (!this.cached) return null;
    if (Date.now() - this.cached.asOf >= this.CACHE_MS) return null;
    return this.cached.result;
  }

  /**
   * Test helper / admin manual reset.
   */
  invalidateCache(): void {
    this.cached = null;
  }

  /**
   * Persiste dans market_regimes_log. Idempotent — on insère une ligne par
   * classification (chaque transition de régime devient une ligne).
   */
  private async persist(result: RegimeClassification, inputs: RegimeInputs): Promise<void> {
    if (!this.supabase.isReady()) return;
    const { error } = await this.supabase
      .getClient()
      .from('market_regimes_log')
      .insert({
        regime: result.regime,
        inputs: inputs as unknown as Record<string, unknown>,
        reasons: result.reasons,
        sizing_multiplier: result.sizingMultiplier,
        stop_loss_pct: result.stopLossPct,
        take_profit_pct: result.takeProfitPct,
        take_profit_ladder_pct: result.takeProfitLadderPct,
      });
    if (error) {
      // Si la migration 0075 n'a pas encore été appliquée, l'erreur
      // contient `does not exist` — on log debug (pas warn, c'est attendu
      // pendant la transition de déploiement).
      const isMissingTable = /market_regimes_log.*does not exist/i.test(error.message);
      if (isMissingTable) {
        this.logger.debug('[regime] market_regimes_log table missing (migration 0075 not yet applied)');
      } else {
        this.logger.warn(`[regime] insert failed: ${error.message}`);
      }
    }
  }
}

// Re-export types for convenience (callers can import from here directly).
export type { TacticalRegime, RegimeInputs, RegimeClassification };
