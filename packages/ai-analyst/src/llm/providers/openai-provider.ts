/**
 * P17 — Adapter OpenAI (GPT-4.1-nano).
 * Fallback #1 si Gemini Flash-Lite indisponible.
 *
 * Pricing avril 2026 : $0.10 input / $0.40 output par 1M tokens.
 */

import type { LlmCallParams, LlmCallResult, LlmProvider } from './types';

const PRICE_INPUT_PER_M = 0.10;
const PRICE_OUTPUT_PER_M = 0.40;

export interface OpenAiProviderConfig {
  apiKey: string | undefined;
  model?: string;
}

export class OpenAiProvider implements LlmProvider {
  readonly id = 'gpt-4.1-nano';
  readonly model: string;
  private readonly apiKey: string | undefined;

  constructor(config: OpenAiProviderConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? 'gpt-4.1-nano';
  }

  isConfigured(): boolean {
    return !!this.apiKey;
  }

  async call(params: LlmCallParams): Promise<LlmCallResult> {
    if (!this.apiKey) throw new Error('OpenAiProvider: OPENAI_API_KEY missing');

    const OpenAI = (await import('openai')).default;
    const client = new OpenAI({ apiKey: this.apiKey });

    const t0 = Date.now();
    const res = await client.chat.completions.create({
      model: this.model,
      messages: [
        { role: 'system', content: params.system },
        { role: 'user', content: params.user },
      ],
      temperature: params.temperature ?? 0.2,
      max_tokens: params.maxTokens ?? 2048,
    });
    const latencyMs = Date.now() - t0;

    const inputTokens = res.usage?.prompt_tokens ?? 0;
    const outputTokens = res.usage?.completion_tokens ?? 0;
    const costUsd = (inputTokens * PRICE_INPUT_PER_M + outputTokens * PRICE_OUTPUT_PER_M) / 1_000_000;

    return {
      content: res.choices[0]?.message?.content ?? '',
      inputTokens,
      outputTokens,
      costUsd,
      latencyMs,
      providerId: this.id,
      model: this.model,
    };
  }
}
