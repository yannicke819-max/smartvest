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

/**
 * Default model : Mistral Medium 3.5 (PAS Large 3).
 *
 * Pourquoi Medium et pas Large :
 * Source artificialanalysis.ai (verified 31/05/2026) :
 *   - Gemini 2.5 Pro (TRADER actuel) : Intelligence Index = 35, TTFT 23.3s
 *   - Mistral Large 3                 : Intelligence Index = 23 (-34%, MOINS bon)
 *   - Mistral Medium 3.5              : Intelligence Index = 39 (+11%, MEILLEUR), TTFT 1.83s
 *
 * L'equivalent qualite de Gemini Pro chez Mistral est Medium 3.5, pas Large.
 * Tester Large 3 en shadow biaiserait la mesure de concordance (Large emettrait
 * des decisions divergentes parce qu'il est objectivement moins capable, pas
 * parce que Mistral est moins bon que Gemini en general).
 *
 * Override possible via env MISTRAL_SHADOW_MODEL (ex : 'mistral-large-latest'
 * pour tester le bottom-tier, 'magistral-medium-latest' pour reasoning).
 */
const MODEL_MEDIUM_LATEST = 'mistral-medium-latest';

/**
 * Table de prix officielle Mistral (USD per MTok, verified 31/05/2026 sur
 * mistral.ai/pricing). Lookup par préfixe model name. Fallback Medium si
 * model name inconnu (defensive : on prefere sur-estimer le cout que crash).
 */
type MistralPricing = { input: number; output: number };
const MISTRAL_PRICING: Record<string, MistralPricing> = {
  'mistral-large': { input: 0.50, output: 1.50 },
  'mistral-medium': { input: 1.50, output: 7.50 },
  'mistral-small': { input: 0.10, output: 0.30 },
  'magistral-medium': { input: 2.00, output: 5.00 },
  'magistral-small': { input: 0.50, output: 1.50 },
  'ministral-3b': { input: 0.10, output: 0.10 },
  'ministral-8b': { input: 0.15, output: 0.15 },
};

function lookupPricing(model: string): MistralPricing {
  const m = model.toLowerCase();
  for (const [prefix, pricing] of Object.entries(MISTRAL_PRICING)) {
    if (m.startsWith(prefix)) return pricing;
  }
  // Fallback : Medium pricing (cher du tier mid) plutot que Large (cheap).
  // Si on connait pas le modele, mieux vaut sur-estimer pour eviter mauvaise
  // surprise de facturation. La string 'unknown' permet d'identifier au debug.
  return MISTRAL_PRICING['mistral-medium'];
}

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
    this.model = this.config.get<string>('MISTRAL_SHADOW_MODEL') ?? MODEL_MEDIUM_LATEST;
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
    // providerId derived from model prefix : 'mistral-medium', 'mistral-large',
    // 'magistral-medium', etc. Permet de distinguer dans les logs / DB rows
    // quel tier a ete teste sans depends du nom complet versioned.
    const providerId = this.model.toLowerCase().split('-').slice(0, 2).join('-');
    const result: MistralShadowResult = {
      content: null,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      latencyMs: 0,
      providerId,
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
      // Pricing model-aware : lookup par prefixe pour matcher la facturation
      // Mistral reelle (Medium != Large != Magistral != Ministral).
      const pricing = lookupPricing(this.model);
      result.costUsd =
        (result.inputTokens / 1_000_000) * pricing.input +
        (result.outputTokens / 1_000_000) * pricing.output;

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
