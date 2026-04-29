/**
 * P17 — ScannerLlmRouterService — wrapping NestJS du MultiVendorLlmRouter.
 *
 * Service injectable qui :
 *   - Lit les API keys depuis ConfigService (.env)
 *   - Construit la chaîne fallback : Gemini Flash-Lite → GPT-4.1-nano → Codestral → Claude
 *   - Gate le routing derrière le feature flag SCANNER_LLM_ROUTER_ENABLED
 *   - Loggue chaque appel (provider, model, latencyMs, costUsd, fallbackUsed)
 *   - Auto-désactive si le flag est off OU si aucun provider n'est configuré
 *
 * Cf. bench P16 — Gemini Flash-Lite gagne avec composite 0.66, $0.00011/prompt
 * (-99.3% vs Claude Sonnet 4.5 sur la tâche de sélection scanner).
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import {
  MultiVendorLlmRouter,
  GeminiProvider,
  OpenAiProvider,
  MistralProvider,
  ClaudeProvider,
  type LlmCallParams,
  type MultiVendorCallMetrics,
} from '@smartvest/ai-analyst';

@Injectable()
export class ScannerLlmRouterService {
  private readonly logger = new Logger(ScannerLlmRouterService.name);
  private readonly enabled: boolean;
  private readonly router: MultiVendorLlmRouter | null;

  constructor(private readonly config: ConfigService) {
    this.enabled = (this.config.get<string>('SCANNER_LLM_ROUTER_ENABLED') ?? 'false').toLowerCase() === 'true';

    if (!this.enabled) {
      this.router = null;
      this.logger.log('SCANNER_LLM_ROUTER_ENABLED=false — router inactive (legacy Claude path)');
      return;
    }

    const anthropicKey = this.config.get<string>('ANTHROPIC_API_KEY');
    const claudeChain = anthropicKey
      ? [new ClaudeProvider({ anthropic: new Anthropic({ apiKey: anthropicKey }) })]
      : [];

    const chain = [
      new GeminiProvider({ apiKey: this.config.get<string>('GEMINI_API_KEY') }),
      new OpenAiProvider({ apiKey: this.config.get<string>('OPENAI_API_KEY') }),
      new MistralProvider({ apiKey: this.config.get<string>('MISTRAL_API_KEY') }),
      ...claudeChain,
    ];

    try {
      this.router = new MultiVendorLlmRouter(chain, {
        timeoutMs: 5000,
        retriesPerProvider: 1,
        retryDelayMs: 1000,
        onCall: (m) => this.handleMetrics(m),
      });
      const active = this.router.getActiveProviders().map((p) => p.id).join(' → ');
      this.logger.log(`SCANNER_LLM_ROUTER_ENABLED=true — chain: ${active}`);
    } catch (err) {
      this.logger.warn(`Router disabled — no provider configured: ${err instanceof Error ? err.message : err}`);
      this.router = null;
    }
  }

  /** True quand le flag est actif ET au moins 1 provider est configuré. */
  isEnabled(): boolean {
    return this.router !== null;
  }

  /**
   * Appel LLM via la chain. Ne lance jamais d'erreur de connectivité
   * silencieuse — si tous les providers échouent, throw `AllProvidersFailedError`
   * et le caller décide (fallback déterministe ou propagation).
   */
  async call(params: LlmCallParams): Promise<{ content: string; providerId: string; costUsd: number; latencyMs: number; fallbackUsed: boolean }> {
    if (!this.router) {
      throw new Error('ScannerLlmRouterService.call() — router disabled (check SCANNER_LLM_ROUTER_ENABLED + API keys)');
    }
    const res = await this.router.call(params);
    return {
      content: res.content,
      providerId: res.providerId,
      costUsd: res.costUsd,
      latencyMs: res.latencyMs,
      fallbackUsed: res.fallbackUsed,
    };
  }

  /**
   * Observability — log structuré stable pour grep/Datadog.
   * Audit decision_log non câblé v1 — l'enum `triggeredBy` ne contient pas
   * encore 'scanner_llm_router'. À ajouter via migration si besoin.
   */
  private handleMetrics(m: MultiVendorCallMetrics): void {
    this.logger.log(
      `[scanner-llm] provider=${m.providerId} model=${m.model} latencyMs=${m.latencyMs} costUsd=${m.costUsd.toFixed(6)} fallbackUsed=${m.fallbackUsed}`,
    );
    if (m.fallbackUsed && Object.keys(m.errorsByProvider).length > 0) {
      this.logger.warn(`[scanner-llm] fallback triggered — failed providers: ${JSON.stringify(m.errorsByProvider)}`);
    }
  }
}
