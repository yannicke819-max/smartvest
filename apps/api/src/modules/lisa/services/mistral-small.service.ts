/**
 * MistralSmallService — adapter Mistral "Small" dédié au TIER RAPIDE (tâches
 * simples & fréquentes : scanner signal gate, risk_monitor scoring, daily brief,
 * retrospective…).
 *
 * Rationale (06/06/2026) : ne PLUS payer du Mistral Medium ($0.40/$2.00 par MTok,
 * throttlé 0.42 RPS) sur des tâches simples à fort volume. Mistral Small 2506 =
 * ~$0.10/$0.30 par MTok ET 20.83 RPS / 5M TPM → cheap ET sans goulot. Le tier
 * RAISONNEMENT (callWithPro : décisions trader, post-mortem, lessons, coach) reste
 * sur Mistral Medium — seul le tier rapide bascule ici.
 *
 * Activé par ScannerLlmRouterService.call() quand LLM_FAST_PROVIDER=mistral-small.
 * Modèle override via MISTRAL_SMALL_MODEL. Partage MISTRAL_API_KEY + MISTRAL_FREE_TIER
 * avec les autres adapters Mistral (Medium/Large).
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const MISTRAL_API_URL = 'https://api.mistral.ai/v1/chat/completions';
const MODEL_SMALL_DEFAULT = 'mistral-small-2506';
// Pricing officiel Mistral Small (mistral.ai/pricing, ~2026). Sert au TRACKING
// du coût, pas à la facturation — ajuster si le tarif dérive durablement.
const PRICE_INPUT_PER_M = 0.1;
const PRICE_OUTPUT_PER_M = 0.3;
const PRICE_CACHED_PER_M = 0.025; // ~25% du fresh input

export interface MistralSmallResult {
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
export class MistralSmallService {
  private readonly logger = new Logger(MistralSmallService.name);
  private readonly apiKey: string | undefined;
  private readonly model: string;
  private readonly freeTier: boolean;

  constructor(private readonly config: ConfigService) {
    // 07/06 — La clé Fly est nommée MISTRAL_SMARTVEST_API_KEY (pas MISTRAL_API_KEY).
    // Nouveau nom prioritaire (fallback ancien) + nettoyage espaces/virgule de fin
    // (un secret collé avec une virgule cassait l'auth → fetch qui hang jusqu'au
    // timeout 30s, faux « Mistral down »).
    this.apiKey = (
      this.config.get<string>('MISTRAL_SMARTVEST_API_KEY') ??
      this.config.get<string>('MISTRAL_API_KEY')
    )?.trim().replace(/,+\s*$/, '').trim();
    this.model = this.config.get<string>('MISTRAL_SMALL_MODEL') ?? MODEL_SMALL_DEFAULT;
    this.freeTier = (this.config.get<string>('MISTRAL_FREE_TIER') ?? 'true').toLowerCase() === 'true';
  }

  /** Configuré dès que la clé Mistral partagée est présente. L'activation runtime
   *  est gouvernée par LLM_FAST_PROVIDER=mistral-small côté router. */
  isConfigured(): boolean {
    return !!this.apiKey;
  }

  async call(params: {
    system: string;
    user: string;
    temperature?: number;
    maxTokens?: number;
    timeoutMs?: number;
  }): Promise<MistralSmallResult> {
    const t0 = Date.now();
    const result: MistralSmallResult = {
      content: null,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      latencyMs: 0,
      providerId: 'mistral-small',
      model: this.model,
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
          model: this.model,
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
      if (this.freeTier) {
        result.costUsd = 0;
      } else {
        result.costUsd =
          (freshInputTokens / 1_000_000) * PRICE_INPUT_PER_M +
          (cachedTokens / 1_000_000) * PRICE_CACHED_PER_M +
          (result.outputTokens / 1_000_000) * PRICE_OUTPUT_PER_M;
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
