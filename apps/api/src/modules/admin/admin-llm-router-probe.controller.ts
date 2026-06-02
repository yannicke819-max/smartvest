/**
 * /admin/llm-router-probe — diagnostic LLM router runtime state + test call.
 *
 * Créé 02/06/2026 03:30 UTC suite à constat 998 calls Gemini Flash-Lite vs
 * 1 seul Mistral en 48h alors que LLM_PRIMARY_PROVIDER=mistral-medium est
 * censé être set. Endpoint diagnostique pour confirmer :
 *   1. Valeur runtime de LLM_PRIMARY_PROVIDER lue par le service
 *   2. Si MistralShadowService a été injecté (DI Optional)
 *   3. Résultat d'un test call effectif → providerId retourné
 *
 * Permet de répondre en 1 GET à "Mistral primary est-il réellement actif ?"
 */

import { Controller, Get, Headers, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ScannerLlmRouterService } from '../lisa/services/scanner-llm-router.service';

@Controller('admin/llm-router-probe')
export class AdminLlmRouterProbeController {
  private readonly logger = new Logger(AdminLlmRouterProbeController.name);

  constructor(
    private readonly router: ScannerLlmRouterService,
    private readonly config: ConfigService,
  ) {}

  @Get()
  async probe(@Headers('x-admin-token') providedToken: string | undefined) {
    this.assertAdmin(providedToken);

    const envValue = this.config.get<string>('LLM_PRIMARY_PROVIDER') ?? null;
    const runtimeValue = this.router.getPrimaryProvider();
    const mistralInjected = this.router.hasMistralShadow();
    const routerEnabled = this.router.isEnabled();

    let testCall: Record<string, unknown> = { skipped: 'router_not_enabled' };
    if (routerEnabled) {
      try {
        const t0 = Date.now();
        const res = await this.router.call({
          system: 'You are a test responder. Reply with exactly the word PING.',
          user: 'probe',
          temperature: 0,
          maxTokens: 10,
          timeoutMs: 8000,
        });
        testCall = {
          provider_id: res.providerId,
          content: res.content.slice(0, 50),
          fallback_used: res.fallbackUsed,
          latency_ms: res.latencyMs,
          cost_usd: res.costUsd,
          total_latency_ms: Date.now() - t0,
        };
      } catch (e) {
        testCall = {
          error: String(e instanceof Error ? e.message : e).slice(0, 300),
        };
      }
    }

    return {
      env_LLM_PRIMARY_PROVIDER: envValue,
      runtime_primaryProvider: runtimeValue,
      mistral_shadow_injected: mistralInjected,
      router_enabled: routerEnabled,
      test_call: testCall,
      interpretation: this.interpret(envValue, runtimeValue, mistralInjected, testCall),
    };
  }

  private interpret(
    envValue: string | null,
    runtime: string,
    mistralInjected: boolean,
    testCall: Record<string, unknown>,
  ): string {
    if (envValue !== 'mistral-medium' && runtime !== 'mistral-medium') {
      return 'LLM_PRIMARY_PROVIDER pas set OU pas effectif sur la machine — Mistral ne peut pas être primary.';
    }
    if (!mistralInjected) {
      return 'MistralShadowService non injecté — vérifier providers du module lisa.';
    }
    const tcProvider = String((testCall as { provider_id?: string }).provider_id ?? '');
    if (tcProvider.includes('mistral')) {
      return 'OK : Mistral primary actif et test call OK.';
    }
    if (tcProvider.includes('gemini')) {
      return 'Mistral path entré mais a fail (catch fallback Gemini). Vérifier MISTRAL_API_KEY / MISTRAL_SHADOW_MODEL / throttle.';
    }
    return 'Status indéterminé — inspecter le test_call ci-dessus.';
  }

  private assertAdmin(providedToken: string | undefined): void {
    const expected = this.config.get<string>('ADMIN_TOKEN');
    if (!expected || expected.length === 0) {
      throw new HttpException(
        { message: 'Endpoint disabled (ADMIN_TOKEN not configured)', code: 'ADMIN_DISABLED' },
        HttpStatus.FORBIDDEN,
      );
    }
    if (providedToken !== expected) {
      throw new HttpException(
        { message: 'Invalid admin token', code: 'ADMIN_FORBIDDEN' },
        HttpStatus.FORBIDDEN,
      );
    }
  }
}
