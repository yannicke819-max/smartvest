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

    const t0 = Date.now();
    const res = await ai.models.generateContent({
      model: this.model,
      contents: params.user,
      config: {
        systemInstruction: params.system,
        temperature: params.temperature ?? 0.2,
        maxOutputTokens: params.maxTokens ?? 2048,
      },
    });
    const latencyMs = Date.now() - t0;

    const inputTokens = res.usageMetadata?.promptTokenCount ?? 0;
    const outputTokens = res.usageMetadata?.candidatesTokenCount ?? 0;
    const costUsd = (inputTokens * PRICE_INPUT_PER_M + outputTokens * PRICE_OUTPUT_PER_M) / 1_000_000;

    return {
      content: res.text ?? '',
      inputTokens,
      outputTokens,
      costUsd,
      latencyMs,
      providerId: this.id,
      model: this.model,
    };
  }
}
