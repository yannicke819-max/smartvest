/**
 * MistralLargeShadowService — 2e adapter Mistral dédié au tier "Large 3"
 * (FLAGSHIP — le modèle Mistral le PLUS cher et le plus capable, PAS un cheap
 * tier malgré l'ancien libellé erroné corrigé le 06/06).
 *
 * Complémente MistralShadowService (Medium = mid-tier) en ajoutant un shadow sur
 * le flagship Mistral pour comparer simultanément :
 *   - Pro (decision réelle appliquée)
 *   - Flash (shadow Gemini cheap tier)
 *   - Medium (shadow Mistral mid-tier)
 *   - Large 3 (shadow Mistral FLAGSHIP, ce service)
 *
 * Pourquoi un service séparé plutôt qu'instance multiple de MistralShadowService :
 * NestJS DI inject la même instance partout par défaut. Pour avoir 2 instances
 * Mistral avec configs différentes (Medium vs Large), le plus clean est 2 classes
 * dédiées qui partagent le même fetch logic mais hardcodent leur model.
 *
 * Pricing officiel (recalibré 03/06/2026, mistral.ai/pricing) :
 *   - Mistral Large : $2.00 / MTok input, $6.00 / MTok output (≈ 7× Mistral Medium)
 *
 * Activation :
 *   - MISTRAL_API_KEY (partagé avec MistralShadowService)
 *   - MISTRAL_LARGE_SHADOW_ENABLED=true (flag dédié, default false)
 */
import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiCostTrackerService } from './api-cost-tracker.service';

const MISTRAL_API_URL = 'https://api.mistral.ai/v1/chat/completions';
const MODEL_LARGE_LATEST = 'mistral-large-latest';
// Recalibré 03/06/2026 (mistral.ai/pricing) — mistral-large-2.x facturé
// $2.00/$6.00 par MTok (anciennes valeurs 0.50/1.50 sous-estimaient × 4).
const PRICE_INPUT_PER_M = 2.00;
const PRICE_OUTPUT_PER_M = 6.00;
const PRICE_CACHED_PER_M = 0.50; // ~25% du fresh input

export interface MistralLargeShadowResult {
  content: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
  providerId: string;
  model: string;
  error: string | null;
}

@Injectable()
export class MistralLargeShadowService {
  private readonly logger = new Logger(MistralLargeShadowService.name);
  private readonly apiKey: string | undefined;
  private readonly enabled: boolean;
  private readonly freeTier: boolean;

  constructor(
    private readonly config: ConfigService,
    @Optional() private readonly costTracker?: ApiCostTrackerService,
  ) {
    // 07/06 — Clé Fly = MISTRAL_SMARTVEST_API_KEY (la nouvelle valide). MISTRAL_API_KEY
    // = ancienne clé révoquée → on lit le nouveau nom en priorité (fallback ancien)
    // + nettoyage espaces/virgule de fin.
    this.apiKey = (
      this.config.get<string>('MISTRAL_SMARTVEST_API_KEY') ??
      this.config.get<string>('MISTRAL_API_KEY')
    )?.trim().replace(/,+\s*$/, '').trim();
    this.enabled = (this.config.get<string>('MISTRAL_LARGE_SHADOW_ENABLED') ?? 'false').toLowerCase() === 'true';
    // 08/06 — Défaut FALSE : Mistral Large facturé (16,63€/mois constaté), coût zéroté en
    // free tier → panel $0 trompeur. true seulement si crédits gratuits.
    this.freeTier = (this.config.get<string>('MISTRAL_FREE_TIER') ?? 'false').toLowerCase() === 'true';
    if (this.enabled && !this.apiKey) {
      this.logger.warn('[mistral-large-shadow] ENABLED=true mais MISTRAL_API_KEY absent → service inerte');
    } else if (this.enabled) {
      this.logger.log(`[mistral-large-shadow] ENABLED — model=${MODEL_LARGE_LATEST} freeTier=${this.freeTier}`);
    }
  }

  isConfigured(): boolean {
    return this.enabled && !!this.apiKey;
  }

  async call(params: {
    system: string;
    user: string;
    temperature?: number;
    maxTokens?: number;
    timeoutMs?: number;
  }): Promise<MistralLargeShadowResult> {
    const t0 = Date.now();
    const result: MistralLargeShadowResult = {
      content: null,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      latencyMs: 0,
      providerId: 'mistral-large',
      model: MODEL_LARGE_LATEST,
      error: null,
    };

    if (!this.isConfigured()) {
      result.error = 'not_configured';
      result.latencyMs = Date.now() - t0;
      return result;
    }

    try {
      const res = await fetch(MISTRAL_API_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: MODEL_LARGE_LATEST,
          messages: [
            { role: 'system', content: params.system },
            { role: 'user', content: params.user },
          ],
          temperature: params.temperature ?? 0.3,
          max_tokens: params.maxTokens ?? 1500,
        }),
        signal: AbortSignal.timeout(params.timeoutMs ?? 30_000),
      });

      result.latencyMs = Date.now() - t0;

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        result.error = `http_${res.status}: ${body.slice(0, 200)}`;
        return result;
      }

      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: {
          prompt_tokens?: number;
          completion_tokens?: number;
          prompt_tokens_details?: { cached_tokens?: number };
        };
      };

      result.content = data.choices?.[0]?.message?.content ?? null;
      result.inputTokens = data.usage?.prompt_tokens ?? 0;
      result.outputTokens = data.usage?.completion_tokens ?? 0;
      const cachedTokens = data.usage?.prompt_tokens_details?.cached_tokens ?? 0;
      const freshInputTokens = Math.max(0, result.inputTokens - cachedTokens);
      // En free tier (default), coût réel = 0 (Experiment plan Mistral 1B tok/mois).
      // Cf. mistral-shadow.service.ts pour la rationale et MISTRAL_FREE_TIER env.
      if (this.freeTier) {
        result.costUsd = 0;
      } else {
        result.costUsd =
          (freshInputTokens / 1_000_000) * PRICE_INPUT_PER_M +
          (cachedTokens / 1_000_000) * PRICE_CACHED_PER_M +
          (result.outputTokens / 1_000_000) * PRICE_OUTPUT_PER_M;
      }

      // 08/06 — Enregistre le coût dans api_costs_daily (panel + budget). Fire-and-forget.
      if (result.content && result.costUsd > 0 && this.costTracker) {
        void this.costTracker.recordApiCost(MODEL_LARGE_LATEST, result.costUsd).catch(() => undefined);
      }

      if (!result.content) {
        result.error = 'empty_content';
      }

      return result;
    } catch (e) {
      result.latencyMs = Date.now() - t0;
      result.error = String(e).slice(0, 200);
      return result;
    }
  }
}
