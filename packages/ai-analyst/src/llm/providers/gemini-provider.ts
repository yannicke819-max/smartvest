/**
 * P17 — Adapter Google GenAI (Gemini 2.5 Flash-Lite par défaut).
 * Provider PRIMAIRE de la chaîne fallback (bench P16 winner).
 *
 * Pricing avril 2026 (par 1M tokens) :
 *   - gemini-2.5-flash-lite : $0.10 input / $0.40 output  (default, scanner fast path)
 *   - gemini-2.5-flash      : $0.30 input / $2.50 output  (grounded search)
 *   - gemini-2.5-pro        : $1.25 input / $10.00 output (raisonnement complexe, post-mortem, decisions trader)
 */

import type { LlmCallParams, LlmCallResult, LlmProvider } from './types';

const PRICE_INPUT_PER_M_FLASH_LITE = 0.10;
const PRICE_OUTPUT_PER_M_FLASH_LITE = 0.40;
const PRICE_INPUT_PER_M_FLASH = 0.30;
const PRICE_OUTPUT_PER_M_FLASH = 2.50;
const PRICE_INPUT_PER_M_PRO = 1.25;
const PRICE_OUTPUT_PER_M_PRO = 10.00;

export interface GeminiProviderConfig {
  apiKey: string | undefined;
  model?: string;
}

export class GeminiProvider implements LlmProvider {
  readonly id: string;
  readonly model: string;
  private readonly apiKey: string | undefined;

  constructor(config: GeminiProviderConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? 'gemini-2.5-flash-lite';
    // id dérivé du model pour distinguer les instances dans le router/logs.
    if (this.model.includes('pro')) this.id = 'gemini-pro';
    else if (this.model.includes('flash-lite')) this.id = 'gemini-flash-lite';
    else if (this.model.includes('flash')) this.id = 'gemini-flash';
    else this.id = `gemini-${this.model}`;
  }

  /**
   * KILL-SWITCH GLOBAL — Gemini DÉSACTIVÉ par défaut (demande user 09/06/2026 :
   * « Gemini OFF, Mistral uniquement »). Aucun appel Gemini ne passe, peu importe
   * le service appelant (risk-manager, scout, daily-brief, router…). Le router LLM
   * a Mistral en primaire → bascule transparente. Réversible UNIQUEMENT en posant
   * explicitement GEMINI_DISABLED=false.
   */
  private static isKilled(): boolean {
    return (process.env.GEMINI_DISABLED ?? 'true').toLowerCase() !== 'false';
  }

  // isConfigured reste basé sur la clé : le routeur LLM doit rester "enabled" pour
  // que le chemin Mistral (gain-picker) fonctionne. Le kill agit sur l'EXÉCUTION
  // (call() throw) : Gemini ne s'exécute jamais, mais le routeur ne se désactive
  // pas (sinon il couperait aussi Mistral).
  isConfigured(): boolean {
    return !!this.apiKey;
  }

  async call(params: LlmCallParams): Promise<LlmCallResult> {
    if (GeminiProvider.isKilled()) {
      throw new Error('GeminiProvider: Gemini désactivé globalement (GEMINI_DISABLED, défaut ON) — Mistral uniquement.');
    }
    if (!this.apiKey) throw new Error('GeminiProvider: GEMINI_API_KEY missing');

    const { GoogleGenAI } = await import('@google/genai');
    const ai = new GoogleGenAI({ apiKey: this.apiKey });

    // Google Search grounding — Gemini fetch les news/web temps réel pour
    // factual grounding. Utile pour les tickers Asia/EU où EODHD news a
    // coverage faible. Coût ajouté ~$35/1000 grounded queries.
    //
    // ⚠️ gemini-2.5-flash-lite NE SUPPORTE PAS googleSearch tool.
    // Override modèle vers flash quand grounding demandé.
    const grounded = !!params.enableSearchGrounding;
    const tools = grounded ? [{ googleSearch: {} as Record<string, never> }] : undefined;
    const effectiveModel = grounded && this.model.includes('flash-lite')
      ? this.model.replace('flash-lite', 'flash')
      : this.model;

    const t0 = Date.now();
    const res = await ai.models.generateContent({
      model: effectiveModel,
      contents: params.user,
      config: {
        systemInstruction: params.system,
        temperature: params.temperature ?? 0.2,
        maxOutputTokens: params.maxTokens ?? 2048,
        ...(tools ? { tools } : {}),
      },
    });
    const latencyMs = Date.now() - t0;

    const inputTokens = res.usageMetadata?.promptTokenCount ?? 0;
    const outputTokens = res.usageMetadata?.candidatesTokenCount ?? 0;
    // Pricing par effectiveModel (grounded override prioritaire)
    const isPro = effectiveModel.includes('pro');
    const isFlashFull = effectiveModel.includes('flash') && !effectiveModel.includes('flash-lite');
    const inputPrice = isPro
      ? PRICE_INPUT_PER_M_PRO
      : isFlashFull
        ? PRICE_INPUT_PER_M_FLASH
        : PRICE_INPUT_PER_M_FLASH_LITE;
    const outputPrice = isPro
      ? PRICE_OUTPUT_PER_M_PRO
      : isFlashFull
        ? PRICE_OUTPUT_PER_M_FLASH
        : PRICE_OUTPUT_PER_M_FLASH_LITE;
    const costUsd = (inputTokens * inputPrice + outputTokens * outputPrice) / 1_000_000;

    return {
      content: res.text ?? '',
      inputTokens,
      outputTokens,
      costUsd,
      latencyMs,
      providerId: this.id,
      model: effectiveModel,
    };
  }
}
