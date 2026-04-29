/**
 * P17 — Adapter Mistral La Plateforme (Codestral).
 * Fallback #2 — provider FR souverain (datacenter GCP europe-west4).
 *
 * Pricing avril 2026 : $0.30 input / $0.90 output par 1M tokens.
 */

import type { LlmCallParams, LlmCallResult, LlmProvider } from './types';

const PRICE_INPUT_PER_M = 0.30;
const PRICE_OUTPUT_PER_M = 0.90;

export interface MistralProviderConfig {
  apiKey: string | undefined;
  model?: string;
}

export class MistralProvider implements LlmProvider {
  readonly id = 'codestral';
  readonly model: string;
  private readonly apiKey: string | undefined;

  constructor(config: MistralProviderConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? 'codestral-latest';
  }

  isConfigured(): boolean {
    return !!this.apiKey;
  }

  async call(params: LlmCallParams): Promise<LlmCallResult> {
    if (!this.apiKey) throw new Error('MistralProvider: MISTRAL_API_KEY missing');

    const { Mistral } = await import('@mistralai/mistralai');
    const client = new Mistral({ apiKey: this.apiKey });

    const t0 = Date.now();
    const res = await client.chat.complete({
      model: this.model,
      messages: [
        { role: 'system', content: params.system },
        { role: 'user', content: params.user },
      ],
      temperature: params.temperature ?? 0.2,
      maxTokens: params.maxTokens ?? 2048,
    });
    const latencyMs = Date.now() - t0;

    const rawContent = res.choices?.[0]?.message?.content;
    const content = typeof rawContent === 'string' ? rawContent : '';

    const inputTokens = res.usage?.promptTokens ?? 0;
    const outputTokens = res.usage?.completionTokens ?? 0;
    const costUsd = (inputTokens * PRICE_INPUT_PER_M + outputTokens * PRICE_OUTPUT_PER_M) / 1_000_000;

    return {
      content,
      inputTokens,
      outputTokens,
      costUsd,
      latencyMs,
      providerId: this.id,
      model: this.model,
    };
  }
}
