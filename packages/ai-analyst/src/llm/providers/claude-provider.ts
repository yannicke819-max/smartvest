/**
 * P17 + ADR-001 (30/04/2026) — Adapter Claude Opus pour MultiVendorLlmRouter.
 *
 * Wrap l'Anthropic SDK existant pour exposer la même interface que les
 * autres providers EU (Gemini). Utilisé en bout de chaîne quand le
 * provider primaire (Gemini Flash Lite) est down — garantit que le scanner
 * ne tombe jamais à 0.
 *
 * **ADR-001 §1.4** : "Fallback ultime : Claude Opus 4.7 (uniquement si Gemini
 * API down)". Le fallback était `claude-sonnet-4-6` avant Phase 2 ; il est
 * désormais Opus pour préserver la qualité quand Gemini est indisponible.
 *
 * Pricing Opus 4.7 (snapshot 30/04/2026) : $15.00 input / $75.00 output par 1M.
 * Modèle pinnable via env `CLAUDE_MODEL_OPUS` (default `claude-opus-4-7`).
 */

import type Anthropic from '@anthropic-ai/sdk';
import type { LlmCallParams, LlmCallResult, LlmProvider } from './types';

const PRICE_INPUT_PER_M = 15.0;
const PRICE_OUTPUT_PER_M = 75.0;

export interface ClaudeProviderConfig {
  /** Anthropic SDK instance déjà construite (réutilise l'auth applicative). */
  anthropic: { messages: { create: Anthropic['messages']['create'] } };
  model?: string;
}

export class ClaudeProvider implements LlmProvider {
  readonly id = 'anthropic-claude-opus';
  readonly model: string;
  private readonly anthropic: ClaudeProviderConfig['anthropic'];

  constructor(config: ClaudeProviderConfig) {
    this.anthropic = config.anthropic;
    this.model = config.model ?? process.env.CLAUDE_MODEL_OPUS ?? 'claude-opus-4-7';
  }

  isConfigured(): boolean {
    return !!this.anthropic;
  }

  async call(params: LlmCallParams): Promise<LlmCallResult> {
    const t0 = Date.now();
    // PR #246 — Claude Opus 4.x déprécie `temperature` (renvoie HTTP 400
    // « temperature ... not allowed »). On l'omet pour les modèles Opus, on
    // le garde pour Sonnet/Haiku qui le supportent encore.
    const isOpus = /opus/i.test(this.model);
    const res = isOpus
      ? await this.anthropic.messages.create({
          model: this.model,
          system: params.system,
          messages: [{ role: 'user', content: params.user }],
          max_tokens: params.maxTokens ?? 2048,
        })
      : await this.anthropic.messages.create({
          model: this.model,
          system: params.system,
          messages: [{ role: 'user', content: params.user }],
          temperature: params.temperature ?? 0.2,
          max_tokens: params.maxTokens ?? 2048,
        });
    const latencyMs = Date.now() - t0;

    const block = res.content?.[0];
    const content = block && 'text' in block ? block.text : '';
    const inputTokens = res.usage?.input_tokens ?? 0;
    const outputTokens = res.usage?.output_tokens ?? 0;
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
