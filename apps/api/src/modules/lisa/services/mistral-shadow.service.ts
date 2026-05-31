/**
 * MistralShadowService — adapter Mistral léger pour A/B shadow PR 31/05/2026.
 *
 * Pourquoi un service séparé (pas dans `packages/ai-analyst/src/llm/providers`) :
 * ADR-001 a explicitement retiré Mistral du router principal pour simplifier
 * la surface providers (Gemini chain → Claude Opus fallback ultime). On NE
 * réintroduit PAS Mistral dans la chain prod — on le calle uniquement en
 * shadow side-by-side avec Gemini Pro pour mesurer concordance/coût avant
 * toute décision long-terme.
 *
 * Architecture :
 *   - fetch direct vers https://api.mistral.ai/v1/chat/completions
 *     (API OpenAI-compatible, pas besoin du SDK @mistralai/mistralai)
 *   - 0 dépendance npm ajoutée
 *   - Best-effort : tous les errors retournés dans `error`, jamais throw
 *
 * Pricing officiel 2026 (verified 31/05) :
 *   - Mistral Large 3 (latest) : $0.50 / MTok input, $1.50 / MTok output
 *
 * Activation :
 *   - MISTRAL_API_KEY (Fly secret) — sans cela, isConfigured() → false
 *   - MISTRAL_SHADOW_ENABLED=true (default false par prudence) — flag explicite
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const MISTRAL_API_URL = 'https://api.mistral.ai/v1/chat/completions';
const MODEL_LARGE_LATEST = 'mistral-large-latest';
const PRICE_INPUT_PER_M_LARGE = 0.50;
const PRICE_OUTPUT_PER_M_LARGE = 1.50;

export interface MistralShadowResult {
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
export class MistralShadowService {
  private readonly logger = new Logger(MistralShadowService.name);
  private readonly apiKey: string | undefined;
  private readonly enabled: boolean;
  private readonly model: string;

  constructor(private readonly config: ConfigService) {
    this.apiKey = this.config.get<string>('MISTRAL_API_KEY');
    this.enabled = (this.config.get<string>('MISTRAL_SHADOW_ENABLED') ?? 'false').toLowerCase() === 'true';
    this.model = this.config.get<string>('MISTRAL_SHADOW_MODEL') ?? MODEL_LARGE_LATEST;
    if (this.enabled && !this.apiKey) {
      this.logger.warn('[mistral-shadow] MISTRAL_SHADOW_ENABLED=true mais MISTRAL_API_KEY absent → service inerte');
    } else if (this.enabled) {
      this.logger.log(`[mistral-shadow] ENABLED — model=${this.model}`);
    }
  }

  isConfigured(): boolean {
    return this.enabled && !!this.apiKey;
  }

  /**
   * Appel Mistral. Best-effort : ne throw jamais, retourne `error` non-null
   * en cas d'échec pour que le caller puisse logger sans bloquer le cycle.
   */
  async call(params: {
    system: string;
    user: string;
    temperature?: number;
    maxTokens?: number;
    timeoutMs?: number;
  }): Promise<MistralShadowResult> {
    const t0 = Date.now();
    const result: MistralShadowResult = {
      content: null,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      latencyMs: 0,
      providerId: 'mistral-large',
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
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };

      result.content = data.choices?.[0]?.message?.content ?? null;
      result.inputTokens = data.usage?.prompt_tokens ?? 0;
      result.outputTokens = data.usage?.completion_tokens ?? 0;
      result.costUsd =
        (result.inputTokens / 1_000_000) * PRICE_INPUT_PER_M_LARGE +
        (result.outputTokens / 1_000_000) * PRICE_OUTPUT_PER_M_LARGE;

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
