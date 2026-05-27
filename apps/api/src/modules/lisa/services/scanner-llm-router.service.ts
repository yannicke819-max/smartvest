/**
 * P17 + ADR-001 (30/04/2026) — ScannerLlmRouterService.
 *
 * Service injectable qui :
 *   - Lit les API keys depuis ConfigService (.env)
 *   - Construit la chain SIMPLIFIÉE per ADR-001 :
 *       Gemini 2.5 Flash Lite (primary) → Claude Opus 4.7 (fallback ultime)
 *   - Suppression OpenAI + Mistral (réduction surface providers)
 *   - Gate le routing derrière le feature flag SCANNER_LLM_ROUTER_ENABLED
 *   - Loggue chaque appel (provider, model, latencyMs, costUsd, fallbackUsed)
 *   - Auto-désactive si le flag est off OU si aucun provider n'est configuré
 *
 * Cf. bench P16 — Gemini Flash-Lite gagne avec composite 0.66, $0.00011/prompt
 * (-99.3% vs Claude Sonnet 4.5 sur la tâche de sélection scanner).
 *
 * Cf. docs/decision_records/ADR-001-llm-architecture.md
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import {
  MultiVendorLlmRouter,
  GeminiProvider,
  ClaudeProvider,
  type LlmCallParams,
  type MultiVendorCallMetrics,
} from '@smartvest/ai-analyst';

@Injectable()
export class ScannerLlmRouterService {
  private readonly logger = new Logger(ScannerLlmRouterService.name);
  private readonly enabled: boolean;
  private readonly router: MultiVendorLlmRouter | null;
  // Router dédié aux raisonnements complexes (decisions trader agent, post-mortem,
  // shadow sizing auto-correction). Chain : Gemini 2.5 Pro → Flash Lite → Claude Opus.
  // Coût ~×125 vs flash-lite mais qualité de raisonnement multi-facteurs supérieure.
  private readonly routerPro: MultiVendorLlmRouter | null;

  constructor(private readonly config: ConfigService) {
    this.enabled = (this.config.get<string>('SCANNER_LLM_ROUTER_ENABLED') ?? 'false').toLowerCase() === 'true';

    if (!this.enabled) {
      this.router = null;
      this.routerPro = null;
      this.logger.log('SCANNER_LLM_ROUTER_ENABLED=true — router inactive (legacy Claude path)');
      return;
    }

    // ADR-001 — Chain simplifiée : Gemini primary + Claude Opus fallback ultime.
    const geminiKey = this.config.get<string>('GEMINI_API_KEY');
    const anthropicKey = this.config.get<string>('ANTHROPIC_API_KEY');
    const claudeFallback = anthropicKey
      ? [new ClaudeProvider({ anthropic: new Anthropic({ apiKey: anthropicKey }) })]
      : [];

    // Chain default (fast path scanner) : Flash Lite → Claude Opus
    const chain = [
      new GeminiProvider({ apiKey: geminiKey }),
      ...claudeFallback,
    ];

    // Chain Pro (raisonnement) : Pro → Flash Lite → Claude Opus
    // Si Pro fail (quota, timeout), on dégrade automatiquement.
    const chainPro = [
      new GeminiProvider({ apiKey: geminiKey, model: 'gemini-2.5-pro' }),
      new GeminiProvider({ apiKey: geminiKey }),
      ...claudeFallback,
    ];

    try {
      this.router = new MultiVendorLlmRouter(chain, {
        timeoutMs: 30000,
        retriesPerProvider: 1,
        retryDelayMs: 1000,
        onCall: (m) => this.handleMetrics(m),
      });
      // Timeout plus large pour Pro (raisonnement plus long, jusqu'à 15s observés).
      this.routerPro = new MultiVendorLlmRouter(chainPro, {
        timeoutMs: 30000,
        retriesPerProvider: 1,
        retryDelayMs: 1000,
        onCall: (m) => this.handleMetrics(m),
      });
      const active = this.router.getActiveProviders().map((p) => p.id).join(' → ');
      const activePro = this.routerPro.getActiveProviders().map((p) => p.id).join(' → ');
      this.logger.log(`SCANNER_LLM_ROUTER_ENABLED=true — fast chain: ${active} | pro chain: ${activePro}`);
    } catch (err) {
      this.logger.warn(`Router disabled — no provider configured: ${err instanceof Error ? err.message : err}`);
      this.router = null;
      this.routerPro = null;
    }
  }

  /** True quand le flag est actif ET au moins 1 provider est configuré. */
  isEnabled(): boolean {
    return this.router !== null;
  }

  /**
   * Appel LLM via la chain rapide (Flash Lite → Opus). Pour les tâches simples /
   * volumineuses (scanner, screening, classification).
   */
  async call(params: LlmCallParams): Promise<{ content: string; providerId: string; costUsd: number; latencyMs: number; fallbackUsed: boolean }> {
    if (!this.router) {
      throw new Error('ScannerLlmRouterService.call() — router disabled (check SCANNER_LLM_ROUTER_ENABLED + GEMINI_API_KEY)');
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
   * Appel LLM via la chain Pro (Gemini 2.5 Pro → Flash Lite → Opus).
   * Pour les raisonnements multi-facteurs : décisions trader agent, post-mortem,
   * auto-correction sizing. Coût ~×125 vs call() mais qualité supérieure.
   *
   * Stratégie défensive : si la chain Pro entière fail (AllProvidersFailedError
   * ou exception non capturée), on retombe automatiquement sur la chain rapide
   * call() (Flash Lite → Opus). Garantit qu'un consumer ne se retrouve JAMAIS
   * silencieusement skipé à cause d'un quota/modèle Pro indisponible.
   */
  async callWithPro(params: LlmCallParams): Promise<{ content: string; providerId: string; costUsd: number; latencyMs: number; fallbackUsed: boolean }> {
    if (this.routerPro) {
      try {
        const res = await this.routerPro.call(params);
        return {
          content: res.content,
          providerId: res.providerId,
          costUsd: res.costUsd,
          latencyMs: res.latencyMs,
          fallbackUsed: res.fallbackUsed,
        };
      } catch (e) {
        this.logger.warn(
          `[scanner-llm] callWithPro routerPro failed → fallback to fast chain. err=${String(e).slice(0, 200)}`,
        );
        // tombe sur le fast path ci-dessous
      }
    }
    // Fallback : Flash Lite → Opus (la chain "call" classique).
    if (!this.router) {
      throw new Error('ScannerLlmRouterService.callWithPro() — both routerPro and router disabled');
    }
    const res = await this.router.call(params);
    return {
      content: res.content,
      providerId: `${res.providerId}-via-pro-fallback`,
      costUsd: res.costUsd,
      latencyMs: res.latencyMs,
      fallbackUsed: true,
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
