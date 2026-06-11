/**
 * Phase 3 — OversoldProbabilityService : entraîne un modèle p_win oversold.
 *
 * Régression logistique (outillage P9 fitLogistic) sur les `features_at_entry` des
 * trades oversold LABELLISÉS à J+10 (fwd_outcome_10d). Un modèle PAR portefeuille
 * (edge US ≠ EU). Append-only dans probability_model_weights, version préfixée
 * `oversold_<portfolio>_` pour le distinguer du modèle de persistance P8/P9.
 *
 * Garde-fous (repris de P9) : sample ≥ 30 sinon skip ; AUC < 0.55 → fit rejeté
 * (modèle non discriminant), version précédente conservée. L2=0.01 (anti-overfit).
 *
 * ⚠️ MESURE SEULEMENT pour l'instant : ce service ENTRAÎNE et PERSISTE le modèle,
 * il ne l'utilise PAS encore pour décider (pas de gate d'entrée, pas de sizing).
 * La consommation (p_win_at_entry shadow → puis gate/sizing) est l'étape suivante,
 * à activer une fois le modèle validé (AUC ≥ 0.55 sur de vraies données J+10, ~18/06).
 *
 * Avant ~18/06 : 0 trade labellisé → 0 fit → aucun effet (sans erreur).
 *
 * Gating : OVERSOLD_PROBABILITY_ENABLED (default true — append-only, sans effet trading).
 */
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { fitLogistic, predict, computeAuc, computeAccuracy } from '@smartvest/ai-analyst';
import { SupabaseService } from '../../supabase/supabase.service';
import { buildOversoldTrainingSet, type OversoldTrainTrade } from './oversold-probability.helper';

const MIN_SAMPLE = 30;
const MIN_AUC = 0.55;

export interface OversoldFitResult {
  portfolioId: string;
  persisted: boolean;
  version: string | null;
  sampleSize: number;
  wins: number;
  aucRoc: number | null;
  accuracy: number | null;
  reason?: string;
}

@Injectable()
export class OversoldProbabilityService {
  private readonly logger = new Logger(OversoldProbabilityService.name);
  private enabled = true;

  constructor(
    private readonly config: ConfigService,
    private readonly supabase: SupabaseService,
  ) {}

  onModuleInit(): void {
    this.enabled = (this.config.get<string>('OVERSOLD_PROBABILITY_ENABLED') ?? 'true').toLowerCase() === 'true';
  }

  /** Cron hebdomadaire dimanche 03:00 UTC — ré-entraîne les modèles p_win oversold. */
  @Cron('0 0 3 * * 0', { name: 'oversold-probability-refit', timeZone: 'UTC' })
  async runWeeklyRefit(): Promise<void> {
    if (!this.enabled || !this.supabase.isReady()) return;
    const portfolios = await this.resolveOversoldPortfolios();
    let fitted = 0;
    for (const pf of portfolios) {
      try {
        const res = await this.trainAndPersist(pf);
        if (res.persisted) fitted++;
        this.logger.log(
          `[oversold-probability] ${pf.slice(0, 8)} n=${res.sampleSize} auc=${res.aucRoc?.toFixed(3) ?? '-'} → ${res.persisted ? `persisté ${res.version}` : res.reason}`,
        );
      } catch (e) {
        this.logger.warn(`[oversold-probability] ${pf.slice(0, 8)}: ${String(e).slice(0, 150)}`);
      }
    }
    if (fitted > 0) this.logger.log(`[oversold-probability] ${fitted} modèle(s) ré-entraîné(s)`);
  }

  /** Entraîne + persiste le modèle p_win d'UN portefeuille oversold. */
  async trainAndPersist(portfolioId: string): Promise<OversoldFitResult> {
    const { data } = await this.supabase
      .getClient()
      .from('paper_trades')
      .select('features_at_entry, fwd_outcome_10d')
      .eq('strategy', 'oversold')
      .eq('portfolio_id', portfolioId)
      .not('fwd_outcome_10d', 'is', null)
      .limit(5000);

    const trades: OversoldTrainTrade[] = (data ?? []).map((r: Record<string, unknown>) => ({
      features: (r.features_at_entry as Record<string, unknown> | null) ?? null,
      fwdOutcome: r.fwd_outcome_10d == null ? null : Number(r.fwd_outcome_10d),
    }));

    const ts = buildOversoldTrainingSet(trades);
    if (ts.n < MIN_SAMPLE) {
      return { portfolioId, persisted: false, version: null, sampleSize: ts.n, wins: ts.wins, aucRoc: null, accuracy: null, reason: 'insufficient_sample' };
    }
    // Garde-fou dégénéré : une seule classe (que des wins ou que des loss) → AUC indéfini.
    if (ts.wins === 0 || ts.wins === ts.n) {
      return { portfolioId, persisted: false, version: null, sampleSize: ts.n, wins: ts.wins, aucRoc: null, accuracy: null, reason: 'single_class' };
    }

    const fit = fitLogistic(ts.X, ts.y, ts.names, { maxIter: 100, l2: 0.01 });
    const scores = ts.X.map((x) => predict(fit.weights, x));
    const auc = computeAuc(scores, ts.y);
    const accuracy = computeAccuracy(scores, ts.y);

    if (auc < MIN_AUC) {
      return { portfolioId, persisted: false, version: null, sampleSize: ts.n, wins: ts.wins, aucRoc: auc, accuracy, reason: 'auc_too_low' };
    }

    const version = `oversold_${portfolioId.slice(0, 8)}_${Math.floor(Date.now() / 1000)}`;
    const { error } = await this.supabase.getClient().from('probability_model_weights').insert({
      version,
      weights: { intercept: fit.weights.intercept, ...fit.weights.coefficients },
      sample_size: ts.n,
      auc_roc: auc.toFixed(3),
      accuracy: accuracy.toFixed(3),
      notes: `oversold p_win | portfolio=${portfolioId.slice(0, 8)} | wins=${ts.wins}/${ts.n} | iter=${fit.iterations} converged=${fit.converged}`,
    });
    if (error) {
      return { portfolioId, persisted: false, version: null, sampleSize: ts.n, wins: ts.wins, aucRoc: auc, accuracy, reason: error.message };
    }
    return { portfolioId, persisted: true, version, sampleSize: ts.n, wins: ts.wins, aucRoc: auc, accuracy };
  }

  /** Portefeuilles en mode oversold (découverte dynamique, pas d'ID en dur). */
  private async resolveOversoldPortfolios(): Promise<string[]> {
    const { data } = await this.supabase
      .getClient()
      .from('lisa_session_configs')
      .select('portfolio_id')
      .eq('strategy_mode', 'oversold');
    return ((data ?? []) as Array<{ portfolio_id: string }>).map((r) => r.portfolio_id);
  }
}
