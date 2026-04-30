/**
 * Claude API Client — appels Anthropic avec prompt caching optimisé.
 *
 * Prompt caching Anthropic (cache_control: ephemeral) :
 *  - 5 min TTL par défaut
 *  - -90% input tokens sur cache HIT
 *  - Stable system prompt (persona Lisa 4 blocs) = cached
 *  - Profile override + user query = non-cached (dépendent de la session)
 *
 * PATCH 6 P1 cost-01-llm-router : ce client ne fait plus l'appel
 * `messages.create` directement. Toutes les requêtes Anthropic transitent
 * par le `LlmRouter` injecté au constructeur. Le routeur gère le mapping
 * tâche→modèle, le circuit breaker budget et le tracking coût.
 */

import type Anthropic from '@anthropic-ai/sdk';
import type { SessionProfile } from '../types';
import { buildLisaSystemPrompt } from '../persona';
import type { LlmRouter, LlmTask } from '../llm';

export interface ClaudeCallOptions {
  /** Profile Lisa à utiliser */
  profile: SessionProfile;
  /** Message utilisateur (contexte marché + corpus + demande) */
  userMessage: string;
  /** PATCH 6 P1 — Type de tâche pour routing modèle. Default 'thesis_generation'
   *  (Opus) puisque c'est l'usage historique de ce client. */
  task?: LlmTask;
  /** Max tokens output (défaut 16000, suffisant pour 3-7 thèses JSON) */
  maxTokens?: number;
  /** @deprecated temperature n'est plus supporté par claude-opus-4-7+ */
  temperature?: number;
  /** P0-A — Override per-call du budget journalier. Permet au caller de
   *  relire `lisa_session_configs.daily_cost_budget_usd` à chaque cycle.
   *  Si undefined, fallback sur le budget constructor du LlmRouter. */
  budgetUsd?: number;
  /** P0-A + ADR-001 Phase 2 — Override per-call du flag soft-budget. À 100% du budget :
   *  - `true` (default DB) : soft warn + continue Opus (audit-flagged over-budget)
   *  - `false` : throw `BudgetExceededError`
   *  Si undefined, fallback sur la config constructor du LlmRouter.
   *  ADR-001 Phase 2 : plus de fallback Haiku (interdit), `forceContinue=true`
   *  paie le dépassement léger plutôt que dégrader la qualité de la thèse. */
  forceContinue?: boolean;
}

export interface ClaudeCallResult {
  /** Texte brut renvoyé par Claude */
  rawText: string;
  /** Metadata d'usage tokens (pour tracking coûts + cache hits) */
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens?: number;
    cacheReadInputTokens?: number;
  };
  /** Modèle effectivement utilisé (peut différer du default si fallback router) */
  model: string;
  /** Stop reason */
  stopReason: string | null;
}

/**
 * Client Lisa → Claude API.
 * Utilisé côté backend (NestJS), jamais côté client (clé API secret).
 *
 * PATCH 6 P1 — Prend désormais un `LlmRouter` au lieu d'une clé API. Le
 * routeur encapsule l'instance Anthropic et le tracking de coût.
 */
export class LisaClaudeClient {
  constructor(private readonly router: LlmRouter) {}

  /**
   * Appel Claude avec prompt caching sur le bloc stable du system prompt.
   *
   * Structure :
   *  - system[0] = cacheable (persona core + anti-consensus + flow + output)
   *  - system[1] = profile override (non-cacheable, session-dependent)
   *  - messages[0] = user query (contexte marché + corpus + demande)
   */
  async call(options: ClaudeCallOptions): Promise<ClaudeCallResult> {
    const {
      profile,
      userMessage,
      task = 'thesis_generation',
      maxTokens = 16000,
      budgetUsd,
      forceContinue,
    } = options;

    const { cacheable, profileSpecific } = buildLisaSystemPrompt(profile);

    // cache_control sur TextBlockParam est supporté par l'API mais peut
    // manquer dans les types du SDK selon la version installée. On passe
    // via un cast pour conserver les bénéfices caching sans bloquer le typecheck.
    const systemBlocks = [
      {
        type: 'text' as const,
        text: cacheable,
        cache_control: { type: 'ephemeral' as const },
      },
      {
        type: 'text' as const,
        text: profileSpecific,
      },
    ];

    const { response } = await this.router.call(
      task,
      {
        max_tokens: maxTokens,
        system: systemBlocks as unknown as Anthropic.TextBlockParam[],
        messages: [
          {
            role: 'user',
            content: userMessage,
          },
        ],
      },
      // P0-A — propagation per-call (budget + force_continue) lus depuis
      // lisa_session_configs côté caller à chaque cycle.
      {
        ...(budgetUsd !== undefined ? { budgetUsd } : {}),
        ...(forceContinue !== undefined ? { forceContinue } : {}),
      },
    );

    // Extract text content (Claude can return multiple content blocks)
    const rawText = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('\n');

    const usage = response.usage as Anthropic.Usage & {
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };

    return {
      rawText,
      usage: {
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        ...(usage.cache_creation_input_tokens !== undefined
          ? { cacheCreationInputTokens: usage.cache_creation_input_tokens }
          : {}),
        ...(usage.cache_read_input_tokens !== undefined
          ? { cacheReadInputTokens: usage.cache_read_input_tokens }
          : {}),
      },
      model: response.model,
      stopReason: response.stop_reason,
    };
  }

  /**
   * Appel Claude avec tool_use forcé. Garantit une sortie JSON conforme au
   * input_schema du tool — Anthropic valide côté serveur, plus aucune chance
   * de parse failure côté client.
   */
  async callWithTool(options: ClaudeCallOptions & {
    tool: { name: string; description: string; input_schema: Record<string, unknown> };
  }): Promise<ClaudeToolResult> {
    const {
      profile,
      userMessage,
      task = 'thesis_generation',
      maxTokens = 16000,
      tool,
      budgetUsd,
      forceContinue,
    } = options;

    const { cacheable, profileSpecific } = buildLisaSystemPrompt(profile);
    const systemBlocks = [
      { type: 'text' as const, text: cacheable, cache_control: { type: 'ephemeral' as const } },
      { type: 'text' as const, text: profileSpecific },
    ];

    const { response } = await this.router.call(
      task,
      {
        max_tokens: maxTokens,
        system: systemBlocks as unknown as Anthropic.TextBlockParam[],
        tools: [tool] as unknown as Anthropic.Tool[],
        tool_choice: { type: 'tool', name: tool.name },
        messages: [{ role: 'user', content: userMessage }],
      },
      {
        ...(budgetUsd !== undefined ? { budgetUsd } : {}),
        ...(forceContinue !== undefined ? { forceContinue } : {}),
      },
    );

    const toolBlock = response.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
    );
    if (!toolBlock) {
      const stopReason = response.stop_reason;
      throw new Error(
        `Claude n'a pas appelé le tool ${tool.name} (stop_reason=${stopReason}). `
        + `Content blocks: ${response.content.map((b) => b.type).join(',')}`,
      );
    }

    const usage = response.usage as Anthropic.Usage & {
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };

    return {
      input: toolBlock.input as Record<string, unknown>,
      toolUseId: toolBlock.id,
      usage: {
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        ...(usage.cache_creation_input_tokens !== undefined
          ? { cacheCreationInputTokens: usage.cache_creation_input_tokens }
          : {}),
        ...(usage.cache_read_input_tokens !== undefined
          ? { cacheReadInputTokens: usage.cache_read_input_tokens }
          : {}),
      },
      model: response.model,
      stopReason: response.stop_reason,
    };
  }

  /**
   * Estime le coût d'un appel (USD), en tenant compte du caching.
   * Le routeur calcule déjà le coût "raw" pour son budget breaker ;
   * cette méthode reste utile aux callers qui veulent un coût précis
   * incluant les économies cache_read/cache_write.
   *
   * **ADR-001 Phase 2 (30/04/2026)** : `LisaClaudeClient` n'est utilisé que
   * pour `thesis_generation` (Opus 4.7). Le pricing reflète Opus.
   *
   * Pricing Opus 4.7 (snapshot 30/04/2026) :
   *  - Input : $15 / 1M tokens
   *  - Output : $75 / 1M tokens
   *  - Cache write : $18.75 / 1M tokens (1.25× input)
   *  - Cache read : $1.50 / 1M tokens (0.1× input — économie ~90%)
   */
  static estimateCostUsd(usage: ClaudeCallResult['usage']): number {
    const INPUT_PER_M = 15;
    const OUTPUT_PER_M = 75;
    const CACHE_WRITE_PER_M = 18.75;
    const CACHE_READ_PER_M = 1.50;

    const nonCachedInput = usage.inputTokens;
    const cacheWrite = usage.cacheCreationInputTokens ?? 0;
    const cacheRead = usage.cacheReadInputTokens ?? 0;

    const cost =
      (nonCachedInput * INPUT_PER_M) / 1_000_000 +
      (usage.outputTokens * OUTPUT_PER_M) / 1_000_000 +
      (cacheWrite * CACHE_WRITE_PER_M) / 1_000_000 +
      (cacheRead * CACHE_READ_PER_M) / 1_000_000;

    return cost;
  }
}

export interface ClaudeToolResult {
  input: Record<string, unknown>;
  toolUseId: string;
  usage: ClaudeCallResult['usage'];
  model: string;
  stopReason: string | null;
}
