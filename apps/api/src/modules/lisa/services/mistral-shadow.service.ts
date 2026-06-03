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
 * Table de prix officielle Mistral (USD per MTok, **recalibré 03/06/2026**
 * sur mistral.ai/pricing). Précédentes valeurs sur-estimaient × 3.75 pour
 * mistral-medium-2505 (1.50/7.50 vs réalité 0.40/2.00) — UI affichait
 * $2.21 vs facture réelle ≈ $1.38.
 *
 * Champ `cached` : prix réduit pour tokens en cache (Mistral applique 25%
 * du fresh sur prompt_tokens_details.cached_tokens). Si non spécifié,
 * fallback à `input` (= pas de remise = sur-estimation safe).
 *
 * Lookup par préfixe model name. Fallback Medium si inconnu.
 */
type MistralPricing = { input: number; output: number; cached?: number };
const MISTRAL_PRICING: Record<string, MistralPricing> = {
  // Mistral Medium 3.5 (mistral-medium-2505) — primary model SmartVest
  'mistral-medium': { input: 0.40, output: 2.00, cached: 0.10 },
  // Mistral Large 2.1 / Large 3 (mistral-large-2411 / mistral-large-2512)
  'mistral-large': { input: 2.00, output: 6.00, cached: 0.50 },
  // Mistral Small 3 (mistral-small-2503)
  'mistral-small': { input: 0.10, output: 0.30, cached: 0.025 },
  // Magistral series (reasoning models)
  'magistral-medium': { input: 2.00, output: 5.00, cached: 0.50 },
  'magistral-small': { input: 0.50, output: 1.50, cached: 0.125 },
  // Ministral edge series
  'ministral-3b': { input: 0.04, output: 0.04, cached: 0.01 },
  'ministral-8b': { input: 0.10, output: 0.10, cached: 0.025 },
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
  private readonly freeTier: boolean;

  // Throttling — sérialise les appels Mistral pour respecter le RPS du modèle.
  // mistral-medium-2505 = 0.42 RPS → minInterval théorique 2381ms.
  // Default 2500ms (marge anti-jitter). Override via MISTRAL_MIN_INTERVAL_MS.
  // Limite haute d'attente : si la queue accumule > MISTRAL_MAX_QUEUE_WAIT_MS,
  // le caller reçoit error='throttle_timeout' et peut fallback (Gemini Pro).
  private readonly minIntervalMs: number;
  private readonly maxQueueWaitMs: number;
  private throttleChain: Promise<void> = Promise.resolve();
  private lastCallAt = 0;

  constructor(private readonly config: ConfigService) {
    this.apiKey = this.config.get<string>('MISTRAL_API_KEY');
    this.enabled = (this.config.get<string>('MISTRAL_SHADOW_ENABLED') ?? 'false').toLowerCase() === 'true';
    this.model = this.config.get<string>('MISTRAL_SHADOW_MODEL') ?? MODEL_MEDIUM_LATEST;
    this.freeTier = (this.config.get<string>('MISTRAL_FREE_TIER') ?? 'true').toLowerCase() === 'true';
    this.minIntervalMs = Math.max(0, Number(this.config.get<string>('MISTRAL_MIN_INTERVAL_MS') ?? '2500'));
    this.maxQueueWaitMs = Math.max(1000, Number(this.config.get<string>('MISTRAL_MAX_QUEUE_WAIT_MS') ?? '15000'));
    if (this.enabled && !this.apiKey) {
      this.logger.warn('[mistral-shadow] MISTRAL_SHADOW_ENABLED=true mais MISTRAL_API_KEY absent → service inerte');
    } else if (this.enabled) {
      this.logger.log(
        `[mistral-shadow] ENABLED — model=${this.model} freeTier=${this.freeTier} minInterval=${this.minIntervalMs}ms maxQueueWait=${this.maxQueueWaitMs}ms`,
      );
    }
  }

  /**
   * Acquiert un slot dans la queue throttle. Sérialise les callers via une
   * promise chain et garantit ≥ minIntervalMs entre 2 appels successifs.
   * Retourne false si l'attente dans la queue dépasse maxQueueWaitMs
   * (caller doit fallback plutôt que de bloquer le cycle).
   */
  private async acquireSlot(): Promise<boolean> {
    const enqueuedAt = Date.now();
    const prev = this.throttleChain;
    let release: () => void = () => undefined;
    this.throttleChain = new Promise((resolve) => {
      release = resolve;
    });
    try {
      await prev;
      // Si on a déjà attendu trop longtemps en queue, abandonner.
      if (Date.now() - enqueuedAt > this.maxQueueWaitMs) {
        return false;
      }
      // Respect du min interval depuis le dernier call effectif.
      const sinceLast = Date.now() - this.lastCallAt;
      const waitMs = Math.max(0, this.minIntervalMs - sinceLast);
      if (waitMs > 0) {
        await new Promise<void>((r) => setTimeout(r, waitMs));
      }
      this.lastCallAt = Date.now();
      return true;
    } finally {
      release();
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

    // Throttle : sérialise les appels pour respecter le RPS du modèle Mistral.
    // Évite les 429 "rate_limit_exceeded" provoqués par les bursts (TRADER cron
    // 2min + risk-monitor 1min + close-gate qui convergent dans la même seconde).
    // Si la queue est trop pleine, abandonner pour laisser le caller fallback
    // sur Gemini Pro plutôt que bloquer le cycle 30s+.
    const gotSlot = await this.acquireSlot();
    if (!gotSlot) {
      result.error = 'throttle_timeout';
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
          // Mistral renvoie cached_tokens dans prompt_tokens_details (depuis 02/2026)
          prompt_tokens_details?: { cached_tokens?: number };
        };
      };

      result.content = data.choices?.[0]?.message?.content ?? null;
      result.inputTokens = data.usage?.prompt_tokens ?? 0;
      result.outputTokens = data.usage?.completion_tokens ?? 0;
      // Cached tokens (sous-ensemble de inputTokens, facturé moins cher)
      const cachedTokens = data.usage?.prompt_tokens_details?.cached_tokens ?? 0;
      const freshInputTokens = Math.max(0, result.inputTokens - cachedTokens);

      // Pricing model-aware : lookup par prefixe pour matcher la facturation
      // Mistral reelle. Fix 03/06/2026 : applique le prix cached réduit
      // (~25% du fresh) sur cached_tokens pour matcher l'invoice Mistral.
      if (this.freeTier) {
        result.costUsd = 0;
      } else {
        const pricing = lookupPricing(this.model);
        const cachedPrice = pricing.cached ?? pricing.input; // fallback safe
        result.costUsd =
          (freshInputTokens / 1_000_000) * pricing.input +
          (cachedTokens / 1_000_000) * cachedPrice +
          (result.outputTokens / 1_000_000) * pricing.output;
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
