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

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  MultiVendorLlmRouter,
  GeminiProvider,
  type LlmCallParams,
  type MultiVendorCallMetrics,
} from '@smartvest/ai-analyst';
import { GeminiBudgetGuardService } from './gemini-budget-guard.service';
import { MistralShadowService } from './mistral-shadow.service';

@Injectable()
export class ScannerLlmRouterService {
  private readonly logger = new Logger(ScannerLlmRouterService.name);
  private readonly enabled: boolean;
  private readonly router: MultiVendorLlmRouter | null;
  // Router dédié aux raisonnements complexes (decisions trader agent, post-mortem,
  // shadow sizing auto-correction). Chain : Gemini 2.5 Pro → Flash Lite → Claude Opus.
  // Coût ~×125 vs flash-lite mais qualité de raisonnement multi-facteurs supérieure.
  private readonly routerPro: MultiVendorLlmRouter | null;
  /**
   * PR #538 — Décideur principal switchable Gemini Pro → Mistral Medium 3.5.
   * Env LLM_PRIMARY_PROVIDER : 'gemini-pro' (default) | 'mistral-medium'
   * Free tier Mistral 1G tokens/mois + 97% concordance avec Pro déjà mesurée.
   * Si Mistral fail (rate limit, API down), fallback automatique vers Gemini Pro.
   */
  private readonly primaryProvider: string;

  constructor(
    private readonly config: ConfigService,
    // Optional injection : si le module ne wire pas le guard, le router fonctionne
    // sans hard cap (comportement pré-PR2 préservé). En prod, le guard est toujours
    // injecté.
    @Optional() @Inject(GeminiBudgetGuardService) private readonly budgetGuard?: GeminiBudgetGuardService,
    @Optional() private readonly mistralShadow?: MistralShadowService,
  ) {
    this.enabled = (this.config.get<string>('SCANNER_LLM_ROUTER_ENABLED') ?? 'false').toLowerCase() === 'true';
    this.primaryProvider = (this.config.get<string>('LLM_PRIMARY_PROVIDER') ?? 'gemini-pro').toLowerCase();
    if (this.primaryProvider === 'mistral-medium') {
      this.logger.log('[scanner-llm] LLM_PRIMARY_PROVIDER=mistral-medium → Mistral Medium 3.5 décideur principal, Gemini Pro en fallback automatique');
    }

    if (!this.enabled) {
      this.router = null;
      this.routerPro = null;
      this.logger.log('SCANNER_LLM_ROUTER_ENABLED=true — router inactive (legacy Claude path)');
      return;
    }

    // Architecture Gemini-only (décision utilisateur 27/05 — éviter coûts Anthropic
    // qui ne sont qu'un filet ultime jamais nécessaire si Gemini répond).
    // Plus de ClaudeProvider dans la chain : si Gemini Pro + Flash Lite tous deux
    // fail, le service skip son cycle. Coût zéro Anthropic en contrepartie.
    const geminiKey = this.config.get<string>('GEMINI_API_KEY');

    // Chain default (fast path scanner) : Flash Lite seul
    const chain = [
      new GeminiProvider({ apiKey: geminiKey }),
    ];

    // Chain Pro (raisonnement) : Pro → Flash Lite (auto-dégradation interne Gemini)
    const chainPro = [
      new GeminiProvider({ apiKey: geminiKey, model: 'gemini-2.5-pro' }),
      new GeminiProvider({ apiKey: geminiKey }),
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
   *
   * 01/06/2026 — Si LLM_PRIMARY_PROVIDER=mistral-medium, essaie Mistral en
   * priorité (free tier, throttle client-side garantit pas de 429). Fallback
   * automatique vers la chain Gemini Flash si Mistral fail (timeout, parse
   * error, throttle_timeout). Aligne le comportement de call() avec
   * callWithPro() pour que TOUT le système (scout, helpers scanner,
   * post-mortem, Strategy Coach) passe par Mistral en primary quand activé.
   */
  async call(params: LlmCallParams): Promise<{ content: string; providerId: string; costUsd: number; latencyMs: number; fallbackUsed: boolean }> {
    // Mistral primary path (gated par env)
    if (this.primaryProvider === 'mistral-medium' && this.mistralShadow) {
      try {
        const res = await this.mistralShadow.call({
          system: params.system,
          user: params.user,
          temperature: params.temperature ?? 0.3,
          maxTokens: params.maxTokens ?? 1500,
          timeoutMs: params.timeoutMs ?? 30_000,
        });
        if (!res.content) {
          throw new Error(`Mistral primary (fast chain) returned empty content (error=${res.error ?? 'unknown'})`);
        }
        return {
          content: res.content,
          providerId: res.providerId,
          costUsd: res.costUsd,
          latencyMs: res.latencyMs,
          fallbackUsed: false,
        };
      } catch (e) {
        this.logger.debug(
          `[scanner-llm] Mistral primary (fast) failed → fallback Gemini chain. err=${String(e).slice(0, 150)}`,
        );
        // tombe sur Gemini ci-dessous
      }
    }

    if (!this.router) {
      throw new Error('ScannerLlmRouterService.call() — router disabled (check SCANNER_LLM_ROUTER_ENABLED + GEMINI_API_KEY)');
    }
    // PR2 cost-cuts (H) — kill-switch hard cap quotidien Gemini avec override manuel.
    if (this.budgetGuard) {
      await this.budgetGuard.assertAllowed();
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
    // PR2 cost-cuts (H) — kill-switch hard cap quotidien Gemini avec override manuel.
    if (this.budgetGuard) {
      await this.budgetGuard.assertAllowed();
    }

    // PR #538 — Si LLM_PRIMARY_PROVIDER=mistral-medium, essaie Mistral Medium 3.5
    // en priorité (free tier 1G tokens/mois + 97% concordance Pro confirmée).
    // Fallback automatique vers Gemini Pro si Mistral fail (rate limit, API down).
    if (this.primaryProvider === 'mistral-medium' && this.mistralShadow) {
      try {
        const res = await this.mistralShadow.call({
          system: params.system,
          user: params.user,
          temperature: params.temperature ?? 0.3,
          maxTokens: params.maxTokens ?? 4000,
          timeoutMs: params.timeoutMs ?? 30_000,
        });
        if (!res.content) {
          throw new Error(`Mistral primary returned empty content (error=${res.error ?? 'unknown'})`);
        }
        return {
          content: res.content,
          providerId: res.providerId,
          costUsd: res.costUsd,
          latencyMs: res.latencyMs,
          fallbackUsed: false,
        };
      } catch (e) {
        this.logger.warn(
          `[scanner-llm] Mistral primary failed → fallback vers Gemini Pro. err=${String(e).slice(0, 200)}`,
        );
        // tombe sur Gemini Pro ci-dessous
      }
    }

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
