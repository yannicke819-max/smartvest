/**
 * LlmABShadowService — service générique d'A/B shadow pour tous les call sites LLM.
 *
 * Complémente la table dédiée TRADER (`gemini_ab_decisions` via LiveTraderAgentService)
 * en couvrant les 4 autres call sites Gemini :
 *   - scanner_postmortem (cron 02:30 UTC, lessons generation)
 *   - strategy_coach (cron hourly, recommendations)
 *   - daily_brief (cron daily, news brief)
 *   - risk_monitor (cron 5min sur positions ouvertes)
 *
 * Pattern d'usage dans chaque service caller :
 *
 *   const applied = await llmRouter.callWithPro({ system, user, ... });
 *   // ... use applied.content ...
 *
 *   void llmABShadow.recordShadow({           // fire-and-forget
 *     callSite: 'risk_monitor',
 *     systemPrompt: system,
 *     userPrompt: user,
 *     applied,
 *     comparator: (appliedText, shadowText) => normalize(appliedText) === normalize(shadowText),
 *   });
 *
 * Best-effort : tous les errors capturés, n'altère JAMAIS le caller.
 */
import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../../supabase/supabase.service';
import { ScannerLlmRouterService } from './scanner-llm-router.service';
import { MistralShadowService } from './mistral-shadow.service';
import { MistralLargeShadowService } from './mistral-large-shadow.service';

export type LlmABCallSite = 'scanner_postmortem' | 'strategy_coach' | 'daily_brief' | 'risk_monitor';

export interface LlmABAppliedCall {
  /** Provider effectivement utilisé par le service (ex: 'gemini-pro' ou 'gemini-flash-lite') */
  providerId: string;
  /** Contenu retourné par le provider */
  content: string;
  /** Coût USD de l'appel */
  costUsd: number;
  /** Latence wall-clock (ms) */
  latencyMs: number;
  /** True si le parse de la réponse (côté caller) a réussi */
  parseOk?: boolean;
}

export interface LlmABRecordParams {
  callSite: LlmABCallSite;
  portfolioId?: string;
  systemPrompt: string;
  userPrompt: string;
  applied: LlmABAppliedCall;
  /**
   * Comparator pour computer concordance. Reçoit (appliedContent, shadowContent),
   * retourne true si "équivalent" selon les critères du caller (peut normaliser,
   * parser JSON, etc.). Si non fourni, fallback à string equality après trim.
   */
  comparator?: (appliedContent: string, shadowContent: string) => boolean;
  /**
   * Si true, tente aussi Mistral Large 3 (cheap tier). Sinon seulement Flash + Medium.
   * Useful pour limiter coût sur sites haute fréquence.
   */
  includeMistralLarge?: boolean;
  /**
   * Max tokens pour les shadows. Default 1500. Set plus bas pour sites avec
   * sorties courtes (ex: risk_monitor verdict) pour économiser cost.
   */
  maxTokens?: number;
  /** Override temperature pour shadows (default 0.3). */
  temperature?: number;
}

interface ShadowResult {
  provider: string;
  cost_usd: number;
  latency_ms: number;
  response_summary: string | null;
  error: string | null;
  concordance_full: boolean | null;
}

@Injectable()
export class LlmABShadowService {
  private readonly logger = new Logger(LlmABShadowService.name);
  private readonly enabled: boolean;
  private readonly summaryMaxChars = 500;

  constructor(
    private readonly config: ConfigService,
    private readonly supabase: SupabaseService,
    private readonly llmRouter: ScannerLlmRouterService,
    @Optional() private readonly mistralShadow?: MistralShadowService,
    @Optional() private readonly mistralLargeShadow?: MistralLargeShadowService,
  ) {
    this.enabled = (this.config.get<string>('LLM_AB_SHADOW_ENABLED') ?? 'true').toLowerCase() === 'true';
    if (!this.enabled) {
      this.logger.warn('[llm-ab-shadow] DISABLED (LLM_AB_SHADOW_ENABLED=false) — no shadow calls will fire');
    }
  }

  /**
   * Best-effort recording. Ne throw jamais — tous errors capturés en log debug.
   * Fire-and-forget : caller peut faire `void this.shadow.recordShadow(...)`.
   */
  async recordShadow(params: LlmABRecordParams): Promise<void> {
    if (!this.enabled) return;
    if (!this.supabase.isReady()) return;

    try {
      // Lance Flash + Mistral Medium en parallèle (best-effort).
      // Si applied = Flash déjà (cas daily_brief utilisant llmRouter.call qui prend
      // la chain fast Flash-Lite), on ne refait pas Flash en shadow — on ferait
      // doublon. À la place on shadow uniquement Mistral + Pro.
      const appliedIsFlashTier = params.applied.providerId.includes('flash');

      const flashPromise = appliedIsFlashTier
        ? Promise.resolve(null)  // skip — pas de doublon
        : this.llmRouter
            .call({
              system: params.systemPrompt,
              user: params.userPrompt,
              temperature: params.temperature ?? 0.3,
              maxTokens: params.maxTokens ?? 1500,
              timeoutMs: 30_000,
            })
            .then(r => ({ ok: true as const, ...r }))
            .catch(e => ({ ok: false as const, error: String(e).slice(0, 200) }));

      // Si applied = Gemini Pro, on ne refait pas Pro en shadow (pas de doublon).
      // Mais si applied = Flash (chain fast), on appelle Pro en shadow.
      //
      // ⚠️ Gemini 2.5 Pro = modèle THINKING : consomme 1000-2000 tokens en
      // reasoning AVANT de produire du content. Si maxTokens < 2000, tout
      // passe en thinking → content vide. Floor 4000 pour Pro shadow
      // (2000 thinking + 1500 content + buffer). Autres shadows (Flash,
      // Mistral) gardent le maxTokens du caller car ils ne thinking pas.
      const proMaxTokens = Math.max(params.maxTokens ?? 1500, 4000);
      const proPromise = !appliedIsFlashTier
        ? Promise.resolve(null)
        : this.llmRouter
            .callWithPro({
              system: params.systemPrompt,
              user: params.userPrompt,
              temperature: params.temperature ?? 0.3,
              maxTokens: proMaxTokens,
              timeoutMs: 30_000,
            })
            .then(r => ({ ok: true as const, ...r }))
            .catch(e => ({ ok: false as const, error: String(e).slice(0, 200) }));

      const mistralPromise = this.mistralShadow
        ? this.mistralShadow.call({
            system: params.systemPrompt,
            user: params.userPrompt,
            temperature: params.temperature ?? 0.3,
            maxTokens: params.maxTokens ?? 1500,
            timeoutMs: 30_000,
          })
        : Promise.resolve(null);

      const mistralLargePromise =
        params.includeMistralLarge !== false && this.mistralLargeShadow
          ? this.mistralLargeShadow.call({
              system: params.systemPrompt,
              user: params.userPrompt,
              temperature: params.temperature ?? 0.3,
              maxTokens: params.maxTokens ?? 1500,
              timeoutMs: 30_000,
            })
          : Promise.resolve(null);

      const [flashSettled, proSettled, mistralSettled, mistralLargeSettled] = await Promise.all([
        flashPromise,
        proPromise,
        mistralPromise,
        mistralLargePromise,
      ]);

      const comparator = params.comparator ?? this.defaultComparator;
      const shadows: ShadowResult[] = [];
      const concordanceSummary: Record<string, boolean | null> = {};

      // Helper to convert a settled call to ShadowResult.
      const toShadow = (
        provider: string,
        settled: { ok: true; content: string; providerId: string; costUsd: number; latencyMs: number } | { ok: false; error: string } | null,
      ): ShadowResult | null => {
        if (settled === null) return null;
        if (!settled.ok) {
          return {
            provider,
            cost_usd: 0,
            latency_ms: 0,
            response_summary: null,
            error: settled.error,
            concordance_full: null,
          };
        }
        const concord = (() => {
          try {
            return comparator(params.applied.content, settled.content);
          } catch {
            return null;
          }
        })();
        return {
          provider: settled.providerId,
          cost_usd: settled.costUsd,
          latency_ms: settled.latencyMs,
          response_summary: this.truncate(settled.content),
          error: null,
          concordance_full: concord,
        };
      };

      const flashShadow = toShadow('gemini-flash-lite', flashSettled);
      if (flashShadow) {
        shadows.push(flashShadow);
        concordanceSummary[flashShadow.provider] = flashShadow.concordance_full;
      }

      const proShadow = toShadow('gemini-pro', proSettled);
      if (proShadow) {
        shadows.push(proShadow);
        concordanceSummary[proShadow.provider] = proShadow.concordance_full;
      }

      // Mistral instances retournent un format légèrement différent
      const toMistralShadow = (
        provider: string,
        settled: { content: string | null; costUsd: number; latencyMs: number; providerId: string; error: string | null } | null,
      ): ShadowResult | null => {
        if (settled === null) return null;
        if (settled.error) {
          return {
            provider,
            cost_usd: settled.costUsd,
            latency_ms: settled.latencyMs,
            response_summary: null,
            error: settled.error,
            concordance_full: null,
          };
        }
        if (!settled.content) return null;
        const concord = (() => {
          try {
            return comparator(params.applied.content, settled.content);
          } catch {
            return null;
          }
        })();
        return {
          provider: settled.providerId,
          cost_usd: settled.costUsd,
          latency_ms: settled.latencyMs,
          response_summary: this.truncate(settled.content),
          error: null,
          concordance_full: concord,
        };
      };

      const mediumShadow = toMistralShadow('mistral-medium', mistralSettled);
      if (mediumShadow) {
        shadows.push(mediumShadow);
        concordanceSummary[mediumShadow.provider] = mediumShadow.concordance_full;
      }

      const largeShadow = toMistralShadow('mistral-large', mistralLargeSettled);
      if (largeShadow) {
        shadows.push(largeShadow);
        concordanceSummary[largeShadow.provider] = largeShadow.concordance_full;
      }

      // Compute hashes pour audit + drift detection
      const crypto = await import('node:crypto');
      const contextHash = crypto.createHash('sha256').update(params.userPrompt).digest('hex').slice(0, 16);
      const systemPromptHash = crypto.createHash('sha256').update(params.systemPrompt).digest('hex').slice(0, 16);

      await this.supabase.getClient().from('llm_ab_shadow_decisions').insert({
        decided_at: new Date().toISOString(),
        call_site: params.callSite,
        portfolio_id: params.portfolioId ?? null,
        applied_provider: params.applied.providerId,
        applied_response_summary: this.truncate(params.applied.content),
        applied_cost_usd: params.applied.costUsd,
        applied_latency_ms: params.applied.latencyMs,
        applied_parse_ok: params.applied.parseOk ?? null,
        shadows: shadows,
        concordance_summary: concordanceSummary,
        context_hash: contextHash,
        system_prompt_hash: systemPromptHash,
      });

      const concordances = Object.entries(concordanceSummary)
        .map(([p, c]) => `${p}=${c === null ? '?' : c ? '✓' : '✗'}`)
        .join(' ');
      this.logger.debug(
        `[llm-ab-shadow] ${params.callSite} applied=${params.applied.providerId} shadows=${shadows.length} ${concordances}`,
      );
    } catch (e) {
      this.logger.debug(`[llm-ab-shadow] recordShadow ${params.callSite} failed: ${String(e).slice(0, 100)}`);
    }
  }

  /**
   * Comparator par défaut : normalise whitespace + lowercase + first 200 chars.
   * Suffisant pour text responses (lessons, briefs, coach recommendations).
   * Pour JSON/structured outputs (risk_monitor verdict), caller doit fournir
   * son propre comparator parseur.
   */
  private defaultComparator(a: string, b: string): boolean {
    const normalize = (s: string) =>
      s.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 200);
    return normalize(a) === normalize(b);
  }

  private truncate(s: string | null): string | null {
    if (s === null) return null;
    return s.length > this.summaryMaxChars ? s.slice(0, this.summaryMaxChars) + '…' : s;
  }
}
