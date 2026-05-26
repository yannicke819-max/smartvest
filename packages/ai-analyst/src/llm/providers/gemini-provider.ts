/**
 * P17 — Adapter Google GenAI (Gemini 2.5 Flash-Lite).
 * Provider PRIMAIRE de la chaîne fallback (bench P16 winner).
 *
 * Pricing avril 2026 : $0.10 input / $0.40 output par 1M tokens.
 */

import type { LlmCallParams, LlmCallResult, LlmProvider } from './types';

const PRICE_INPUT_PER_M = 0.10;
const PRICE_OUTPUT_PER_M = 0.40;

export interface GeminiProviderConfig {
  apiKey: string | undefined;
  model?: string;
}

export class GeminiProvider implements LlmProvider {
  readonly id = 'gemini-flash-lite';
  readonly model: string;
  private readonly apiKey: string | undefined;

  constructor(config: GeminiProviderConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? 'gemini-2.5-flash-lite';
  }

  isConfigured(): boolean {
    return !!this.apiKey;
  }

  async call(params: LlmCallParams): Promise<LlmCallResult> {
    if (!this.apiKey) throw new Error('GeminiProvider: GEMINI_API_KEY missing');

    const { GoogleGenAI } = await import('@google/genai');
    const ai = new GoogleGenAI({ apiKey: this.apiKey });

    // Google Search grounding — Gemini fetch les news/web temps réel pour
    // factual grounding. Utile pour les tickers Asia/EU où EODHD news a
    // coverage faible. Coût ajouté ~$35/1000 grounded queries.
    //
    // ⚠️ gemini-2.5-flash-lite NE SUPPORTE PAS googleSearch tool.
    // Détecté 26/05 : latency 500-900ms (vs grounded = 1.5-3s attendus) →
    // le tool est silencieusement ignoré par flash-lite. Override modèle vers
    // gemini-2.5-flash quand grounding demandé. Coût marginal :
    //   - flash-lite : $0.10 / $0.40 par 1M tokens (input/output)
    //   - flash      : $0.30 / $2.50 par 1M tokens (3× input, 6× output)
    // Pour RM V2 (~14 positions × cron 5min × ~500 tokens) ≈ +$2-5/jour.
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
    // Pricing différencié si on a switch vers flash (×3 input, ×6 output)
    const inputPrice = grounded ? 0.30 : PRICE_INPUT_PER_M;
    const outputPrice = grounded ? 2.50 : PRICE_OUTPUT_PER_M;
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
