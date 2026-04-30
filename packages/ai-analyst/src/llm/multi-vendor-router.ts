/**
 * P17 + ADR-001 Phase 4 (30/04/2026) — MultiVendorLlmRouter, chaîne fallback
 * pour les call sites non-thèses.
 *
 * Différent du `LlmRouter` (router.ts) qui n'opère que sur Opus pour
 * `thesis_generation`. Ce router gère le CHOIX DE VENDOR :
 *
 *   primary  → Gemini Flash-Lite  (bench P16 winner — composite 0.66, $0.00011/prompt)
 *   fallback → Claude Opus 4.7    (fallback ultime per ADR-001 §1.4)
 *
 * Phase 4 cleanup : `OpenAiProvider` + `MistralProvider` supprimés (chain
 * réduite à 2 providers — Google + Anthropic — per ADR-001 §1.3).
 *
 * Pour chaque appel :
 *   1. Tente le primary avec timeout (default 5s) + retry 1× backoff 1s
 *   2. En cas d'échec définitif, passe au suivant dans la chain
 *   3. Si tous échouent, throw — le caller décide (fallback déterministe ou propagation)
 *
 * Métriques structurées via callback `onCall` (provider, latency, cost, fallbackUsed).
 *
 * Cf. `docs/decision_records/ADR-001-llm-architecture.md`
 * Cf. bench P16 : `bench/scanner-llm/REPORT.md` sur la branche
 * `bench/p16-llm-eu-providers`.
 */

import type { LlmCallParams, LlmCallResult, LlmProvider } from './providers/types';

export interface MultiVendorCallMetrics {
  /** Provider effectivement utilisé (le premier qui a réussi). */
  providerId: string;
  /** Modèle SDK-side. */
  model: string;
  /** Latence wall-clock (ms). */
  latencyMs: number;
  /** Coût USD calculé. */
  costUsd: number;
  /** True si on a dû tomber sur un fallback (primary a échoué). */
  fallbackUsed: boolean;
  /** Nombre de providers tentés avant succès. */
  attemptCount: number;
  /** Erreurs rencontrées par provider (pour audit). */
  errorsByProvider: Record<string, string>;
}

export interface MultiVendorRouterOptions {
  /** Timeout par appel provider (ms). Défaut : 5000. */
  timeoutMs?: number;
  /** Nombre de tentatives par provider avant fallback. Défaut : 1 retry = 2 tentatives. */
  retriesPerProvider?: number;
  /** Délai entre retries (ms). Défaut : 1000. */
  retryDelayMs?: number;
  /** Callback observability — appelé après chaque appel (success ou échec final). */
  onCall?: (metrics: MultiVendorCallMetrics) => void;
}

export class AllProvidersFailedError extends Error {
  readonly errorsByProvider: Record<string, string>;
  constructor(errorsByProvider: Record<string, string>) {
    const summary = Object.entries(errorsByProvider)
      .map(([id, err]) => `${id}: ${err}`)
      .join('; ');
    super(`MultiVendorLlmRouter: all providers failed — ${summary}`);
    this.name = 'AllProvidersFailedError';
    this.errorsByProvider = errorsByProvider;
  }
}

export class MultiVendorLlmRouter {
  private readonly chain: LlmProvider[];
  private readonly timeoutMs: number;
  private readonly retriesPerProvider: number;
  private readonly retryDelayMs: number;
  private readonly onCall: ((metrics: MultiVendorCallMetrics) => void) | undefined;

  /**
   * @param chain  Ordre de fallback (1er = primary). Les providers non
   *               configurés (`isConfigured() === false`) sont skip.
   */
  constructor(chain: LlmProvider[], options: MultiVendorRouterOptions = {}) {
    this.chain = chain.filter((p) => p.isConfigured());
    if (this.chain.length === 0) {
      throw new Error('MultiVendorLlmRouter: no provider is configured (check API keys)');
    }
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.retriesPerProvider = options.retriesPerProvider ?? 1;
    this.retryDelayMs = options.retryDelayMs ?? 1000;
    this.onCall = options.onCall;
  }

  /** Exposé pour tests / introspection — la chain effective après filtrage. */
  getActiveProviders(): readonly LlmProvider[] {
    return this.chain;
  }

  /**
   * Appel LLM avec fallback chain. Renvoie le résultat du premier provider
   * qui réussit, ou throw `AllProvidersFailedError` si tous échouent.
   */
  async call(params: LlmCallParams): Promise<LlmCallResult & { fallbackUsed: boolean; attemptCount: number }> {
    const errorsByProvider: Record<string, string> = {};
    let attemptCount = 0;

    for (let i = 0; i < this.chain.length; i++) {
      const provider = this.chain[i];
      attemptCount++;
      try {
        const result = await this.callWithTimeoutAndRetry(provider, params);
        const fallbackUsed = i > 0;
        this.onCall?.({
          providerId: result.providerId,
          model: result.model,
          latencyMs: result.latencyMs,
          costUsd: result.costUsd,
          fallbackUsed,
          attemptCount,
          errorsByProvider,
        });
        return { ...result, fallbackUsed, attemptCount };
      } catch (err) {
        errorsByProvider[provider.id] = err instanceof Error ? err.message : String(err);
      }
    }

    this.onCall?.({
      providerId: 'none',
      model: 'none',
      latencyMs: 0,
      costUsd: 0,
      fallbackUsed: true,
      attemptCount,
      errorsByProvider,
    });
    throw new AllProvidersFailedError(errorsByProvider);
  }

  private async callWithTimeoutAndRetry(
    provider: LlmProvider,
    params: LlmCallParams,
  ): Promise<LlmCallResult> {
    const totalAttempts = this.retriesPerProvider + 1;
    let lastErr: unknown;
    for (let attempt = 0; attempt < totalAttempts; attempt++) {
      try {
        return await this.withTimeout(provider.call(params), this.timeoutMs, provider.id);
      } catch (err) {
        lastErr = err;
        if (attempt < totalAttempts - 1) {
          await new Promise((r) => setTimeout(r, this.retryDelayMs));
        }
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  private withTimeout<T>(promise: Promise<T>, ms: number, providerId: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`${providerId}: timeout after ${ms}ms`)),
        ms,
      );
      promise
        .then((v) => { clearTimeout(timer); resolve(v); })
        .catch((e) => { clearTimeout(timer); reject(e); });
    });
  }
}
