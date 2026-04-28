/**
 * P9 — PersistenceProbabilityService.
 *
 * Charge les poids du modèle logistic regression (table
 * `probability_model_weights`), expose `estimateProbability(features)` pour
 * le scanner, et `getEmpiricalLaw()` pour l'endpoint /persistence-empirical-law.
 *
 * Train : `trainAndPersist()` lit `paper_trades` fermées avec outcome_label,
 * fit Newton-Raphson, calcule AUC + accuracy, insert nouvelle version.
 *
 * Garde-fous :
 *   - sample_size < 30  → fallback (caller utilise seuil P8 dur)
 *   - auc < 0.55        → fit rejeté (modèle non discriminant), conservation
 *                          de la version précédente
 *
 * Cf. CLAUDE.md P9 + ticket P9.
 */

import { Injectable, Logger } from '@nestjs/common';
import {
  fitLogistic,
  predict,
  computeAuc,
  computeAccuracy,
  computeEmpiricalLaw,
  type LogisticWeights,
  type BucketStat,
  type TradeOutcome,
} from '@smartvest/ai-analyst';
import { SupabaseService } from '../../supabase/supabase.service';

const MIN_SAMPLE_SIZE = 30;
const MIN_AUC_FOR_ACCEPTANCE = 0.55;
const FEATURE_NAMES = [
  'persistenceCount',
  'volRatio',
  'rsi',
  'closeToHigh',
  'changePct',
];

export interface ProbabilityEstimate {
  pWin: number;
  confidence: number;
  sampleSize: number;
  modelVersion: string;
  /** True si le modèle est en mode dégradé (sample insuffisant ou auc bas). */
  fallback: boolean;
}

@Injectable()
export class PersistenceProbabilityService {
  private readonly logger = new Logger(PersistenceProbabilityService.name);
  private cachedWeights: LogisticWeights | null = null;
  private cachedVersion: string | null = null;
  private cachedSampleSize = 0;
  private cachedAuc = 0;
  private cachedAt = 0;
  private readonly CACHE_TTL_MS = 5 * 60_000;

  constructor(private readonly supabase: SupabaseService) {}

  /**
   * Estime P(Y=1 | features). Fallback à 0.5 si modèle indisponible.
   * Caller doit traiter `fallback=true` comme « utilise seuil P8 dur ».
   */
  async estimateProbability(features: Record<string, number>): Promise<ProbabilityEstimate> {
    const meta = await this.loadLatestModel();
    if (!meta) {
      return {
        pWin: 0.5,
        confidence: 0,
        sampleSize: 0,
        modelVersion: 'none',
        fallback: true,
      };
    }
    const pWin = predict(meta.weights, features);
    return {
      pWin,
      confidence: meta.auc, // proxy : un AUC élevé = confiance plus haute
      sampleSize: meta.sampleSize,
      modelVersion: meta.version,
      fallback: meta.sampleSize < MIN_SAMPLE_SIZE || meta.auc < MIN_AUC_FOR_ACCEPTANCE,
    };
  }

  /**
   * Loi empirique P(win) par bucket persistenceCount, sur les `lookbackDays`
   * derniers jours. Source : `paper_trades` avec status='closed' et
   * outcome_label NOT NULL.
   */
  async getEmpiricalLaw(opts: { lookbackDays: number; minSample: number }): Promise<{
    trainedOn: number;
    empiricalLaw: BucketStat[];
    coefficients: LogisticWeights | null;
    aucRoc: number | null;
    accuracy: number | null;
    modelVersion: string | null;
    fallback: boolean;
  }> {
    const trades = await this.fetchTrainingData(opts.lookbackDays);
    const empiricalLaw = computeEmpiricalLaw(trades, opts.minSample);
    const meta = await this.loadLatestModel();
    return {
      trainedOn: trades.length,
      empiricalLaw,
      coefficients: meta?.weights ?? null,
      aucRoc: meta?.auc ?? null,
      accuracy: meta?.accuracy ?? null,
      modelVersion: meta?.version ?? null,
      fallback: !meta || meta.sampleSize < MIN_SAMPLE_SIZE,
    };
  }

  /**
   * Refit du modèle. Insère une nouvelle version si AUC >= 0.55 et
   * sample_size >= 30. Sinon log + skip (la version précédente reste active).
   *
   * Idempotent : appelable manuellement (button "Refit" UI) OU via cron
   * Sunday 02:00 UTC (à wirer dans une future itération).
   */
  async trainAndPersist(opts: { lookbackDays: number } = { lookbackDays: 30 }): Promise<{
    persisted: boolean;
    version: string | null;
    sampleSize: number;
    aucRoc: number;
    accuracy: number;
    reason?: string;
  }> {
    const trades = await this.fetchTrainingData(opts.lookbackDays);
    if (trades.length < MIN_SAMPLE_SIZE) {
      this.logger.warn(
        `[probability:fit] sample_size=${trades.length} < ${MIN_SAMPLE_SIZE} → skip fit`,
      );
      return {
        persisted: false,
        version: null,
        sampleSize: trades.length,
        aucRoc: 0,
        accuracy: 0,
        reason: 'insufficient_sample',
      };
    }

    // Construit X / y. Features : extracts numériques depuis `features_at_entry`.
    const X: Array<Record<string, number>> = [];
    const y: number[] = [];
    for (const t of trades) {
      X.push(t.features);
      y.push(t.outcomeLabel);
    }

    const fit = fitLogistic(X, y, FEATURE_NAMES, { maxIter: 100, l2: 0.01 });
    const scores = X.map((x) => predict(fit.weights, x));
    const auc = computeAuc(scores, y);
    const accuracy = computeAccuracy(scores, y);

    if (auc < MIN_AUC_FOR_ACCEPTANCE) {
      this.logger.warn(
        `[probability:fit] AUC=${auc.toFixed(3)} < ${MIN_AUC_FOR_ACCEPTANCE} → fit rejeté`,
      );
      return {
        persisted: false,
        version: null,
        sampleSize: trades.length,
        aucRoc: auc,
        accuracy,
        reason: 'auc_too_low',
      };
    }

    const version = `v${Date.now()}`;
    const { error } = await this.supabase.getClient()
      .from('probability_model_weights')
      .insert({
        version,
        weights: {
          intercept: fit.weights.intercept,
          ...fit.weights.coefficients,
        },
        sample_size: trades.length,
        auc_roc: auc.toFixed(3),
        accuracy: accuracy.toFixed(3),
        notes: `lookback=${opts.lookbackDays}d, iter=${fit.iterations}, converged=${fit.converged}`,
      });
    if (error) {
      this.logger.warn(`[probability:fit] persist failed: ${error.message}`);
      return {
        persisted: false,
        version: null,
        sampleSize: trades.length,
        aucRoc: auc,
        accuracy,
        reason: error.message,
      };
    }

    // Invalide cache pour forcer reload prochain estimate
    this.cachedAt = 0;

    this.logger.log(
      `[probability:fit] persisted version=${version} n=${trades.length} auc=${auc.toFixed(3)} acc=${accuracy.toFixed(3)}`,
    );
    return { persisted: true, version, sampleSize: trades.length, aucRoc: auc, accuracy };
  }

  // ───────────────────────────────────────────────────────────────────

  private async loadLatestModel(): Promise<{
    weights: LogisticWeights;
    version: string;
    sampleSize: number;
    auc: number;
    accuracy: number;
  } | null> {
    if (this.cachedWeights && Date.now() - this.cachedAt < this.CACHE_TTL_MS) {
      return {
        weights: this.cachedWeights,
        version: this.cachedVersion ?? 'cached',
        sampleSize: this.cachedSampleSize,
        auc: this.cachedAuc,
        accuracy: 0,
      };
    }
    const { data } = await this.supabase.getClient()
      .from('probability_model_weights')
      .select('version, weights, sample_size, auc_roc, accuracy')
      .order('trained_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!data) return null;

    const raw = data.weights as Record<string, unknown>;
    const intercept = Number(raw.intercept ?? 0);
    const coefficients: Record<string, number> = {};
    for (const f of FEATURE_NAMES) {
      coefficients[f] = Number(raw[f] ?? 0);
    }
    const weights: LogisticWeights = {
      intercept,
      coefficients,
      featureNames: [...FEATURE_NAMES],
    };
    this.cachedWeights = weights;
    this.cachedVersion = String(data.version);
    this.cachedSampleSize = Number(data.sample_size ?? 0);
    this.cachedAuc = Number(data.auc_roc ?? 0);
    this.cachedAt = Date.now();
    return {
      weights,
      version: this.cachedVersion,
      sampleSize: this.cachedSampleSize,
      auc: this.cachedAuc,
      accuracy: Number(data.accuracy ?? 0),
    };
  }

  private async fetchTrainingData(
    lookbackDays: number,
  ): Promise<Array<TradeOutcome & { features: Record<string, number> }>> {
    const fromDate = new Date(Date.now() - lookbackDays * 86400_000).toISOString();
    const { data, error } = await this.supabase.getClient()
      .from('paper_trades')
      .select('persistence_count_at_entry, outcome_label, pnl_pct, features_at_entry, closed_at')
      .eq('status', 'closed')
      .not('outcome_label', 'is', null)
      .gte('closed_at', fromDate);
    if (error) {
      this.logger.warn(`[probability:fetch] paper_trades read failed: ${error.message}`);
      return [];
    }
    return (data ?? []).map((row) => {
      const featuresRaw = (row.features_at_entry as Record<string, unknown>) ?? {};
      const features: Record<string, number> = {};
      for (const f of FEATURE_NAMES) {
        const v = featuresRaw[f];
        features[f] = typeof v === 'number' && Number.isFinite(v) ? v : 0;
      }
      // persistenceCount peut être stocké en string '4/6' OU calculé numériquement
      // — on extrait la fraction si pas déjà dans features
      if (!Number.isFinite(featuresRaw.persistenceCount) && row.persistence_count_at_entry) {
        const m = String(row.persistence_count_at_entry).match(/^(\d+)\/(\d+)$/);
        if (m) {
          const num = parseInt(m[1], 10);
          const den = parseInt(m[2], 10);
          if (den > 0) features.persistenceCount = num / den;
        }
      }
      return {
        persistenceCount: String(row.persistence_count_at_entry ?? '0/6'),
        outcomeLabel: row.outcome_label === 1 ? (1 as const) : (0 as const),
        pnlPct: Number(row.pnl_pct ?? 0),
        features,
      };
    });
  }
}
