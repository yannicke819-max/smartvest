/**
 * Claude API Client — appels Anthropic avec prompt caching optimisé,
 * avec migration progressive vers Gemini 2.5 Pro (économie ×10).
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
 *
 * MIGRATION GEMINI (28/05/2026) — `callWithTool` peut désormais router vers
 * Gemini 2.5 Pro via `LISA_PROPOSAL_PROVIDER=gemini` (default si
 * `geminiApiKey` fourni). Gemini Pro est ~10× moins cher que Claude Opus
 * ($1.25/$10 vs $15/$75 par 1M tokens). Le tool input_schema (Anthropic) est
 * réinjecté dans le user prompt et Gemini est forcé en
 * `responseMimeType: 'application/json'` pour garantir un JSON parsable.
 * En cas d'échec Gemini (5xx, parse error, missing key), fallback automatique
 * sur Claude Opus si `claudeFallbackEnabled` (default true) et router
 * Anthropic dispo.
 */

import type Anthropic from '@anthropic-ai/sdk';
import type { SessionProfile } from '../types';
import { buildLisaSystemPrompt } from '../persona';
import type { LlmRouter, LlmTask } from '../llm';

export type LisaProposalProvider = 'gemini' | 'claude';

export interface LisaClaudeClientGeminiConfig {
  /** Clé API Google GenAI. Si absente, provider gemini = pas opérationnel. */
  apiKey?: string;
  /** Modèle Gemini (défaut `gemini-2.5-pro`). */
  model?: string;
  /** Provider primaire pour `callWithTool`. Défaut 'gemini' si apiKey défini, sinon 'claude'. */
  provider?: LisaProposalProvider;
  /** Si Gemini échoue, fallback sur Claude. Défaut true. */
  claudeFallbackEnabled?: boolean;
  /** Logger optionnel (warn + info). */
  logger?: { warn: (msg: string) => void; info?: (msg: string) => void };
}

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
  private readonly geminiConfig: LisaClaudeClientGeminiConfig;
  private readonly effectiveProvider: LisaProposalProvider;

  constructor(
    private readonly router: LlmRouter,
    geminiConfig: LisaClaudeClientGeminiConfig = {},
  ) {
    this.geminiConfig = geminiConfig;
    // ── KILL-SWITCH GLOBAL GEMINI (demande user 09-10/06/2026) ──────────────
    // FUITE FERMÉE 10/06 : ce client a un chemin Gemini DIRECT (callWithToolGemini)
    // qui contourne le kill de GeminiProvider — et il défaultait sur Gemini dès
    // que la clé était présente → facturation Google AI Studio observée ($3.81/j)
    // alors que l'utilisateur veut Gemini OFF. Tant que GEMINI_DISABLED != 'false'
    // (défaut ON), LisaClaudeClient n'utilise JAMAIS Gemini : tout part en Claude.
    const geminiKilled = (process.env.GEMINI_DISABLED ?? 'true').toLowerCase() !== 'false';
    const requested = geminiConfig.provider;
    if (geminiKilled) {
      this.effectiveProvider = 'claude';
      if (geminiConfig.apiKey || requested === 'gemini') {
        geminiConfig.logger?.warn(
          '[LisaClaudeClient] Gemini désactivé globalement (GEMINI_DISABLED, défaut ON) — propositions forcées en Claude',
        );
      }
    } else if (requested === 'claude') {
      this.effectiveProvider = 'claude';
    } else if (requested === 'gemini' && !geminiConfig.apiKey) {
      // Gemini explicitement demandé mais sans clé → fallback claude
      geminiConfig.logger?.warn(
        '[LisaClaudeClient] LISA_PROPOSAL_PROVIDER=gemini mais GEMINI_API_KEY absent — fallback claude',
      );
      this.effectiveProvider = 'claude';
    } else if (geminiConfig.apiKey) {
      this.effectiveProvider = 'gemini';
    } else {
      this.effectiveProvider = 'claude';
    }
  }

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
   * Appel Claude (ou Gemini) avec contrainte JSON forcée. Anthropic utilise
   * tool_use (validation server-side) ; Gemini utilise `responseMimeType:
   * 'application/json'` + instruction prompt avec le schema JSON.
   *
   * Si provider effectif = 'gemini' :
   *  - Construit un user prompt enrichi avec le tool input_schema embedded
   *  - Call Gemini Pro avec responseMimeType=application/json
   *  - Parse JSON, mappe vers ClaudeToolResult (toolUseId synthétique)
   *  - Sur erreur (5xx, parse fail), fallback Claude si activé
   */
  async callWithTool(options: ClaudeCallOptions & {
    tool: { name: string; description: string; input_schema: Record<string, unknown> };
  }): Promise<ClaudeToolResult> {
    // ─── Gemini primary path ────────────────────────────────────────────────
    if (this.effectiveProvider === 'gemini') {
      try {
        return await this.callWithToolGemini(options);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const fallbackEnabled = this.geminiConfig.claudeFallbackEnabled !== false;
        if (!fallbackEnabled) {
          throw err;
        }
        this.geminiConfig.logger?.warn(
          `[LisaClaudeClient] Gemini call failed (${msg.slice(0, 200)}) — fallback Claude Opus`,
        );
        // Continue to Claude path below
      }
    }

    // ─── Claude path (primary or fallback) ──────────────────────────────────
    return this.callWithToolClaude(options);
  }

  /**
   * Implémentation Claude (Anthropic SDK via LlmRouter) — chemin historique.
   */
  private async callWithToolClaude(options: ClaudeCallOptions & {
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

  /**
   * Pricing Gemini 2.5 Pro (snapshot 28/05/2026) :
   *  - Input : $1.25 / 1M tokens
   *  - Output : $10.00 / 1M tokens
   *  Pas de cache hit explicit côté Gemini (context caching auto par Google,
   *  pas exposé dans usageMetadata pour l'instant).
   */
  static estimateCostUsdGemini(inputTokens: number, outputTokens: number, model: string): number {
    const isPro = model.includes('pro');
    const isFlashFull = model.includes('flash') && !model.includes('flash-lite');
    const INPUT_PER_M = isPro ? 1.25 : isFlashFull ? 0.30 : 0.10;
    const OUTPUT_PER_M = isPro ? 10.0 : isFlashFull ? 2.5 : 0.40;
    return (inputTokens * INPUT_PER_M + outputTokens * OUTPUT_PER_M) / 1_000_000;
  }

  /**
   * Implémentation Gemini — convertit le tool input_schema en instruction
   * JSON-output et appelle Gemini avec `responseMimeType: 'application/json'`.
   *
   * Stratégie de robustesse : pas de tentative de mapping
   * Anthropic-input_schema → Gemini-responseSchema (les divergences entre les
   * 2 spécifications JSON Schema sont nombreuses — enums avec descriptions
   * longues, additionalProperties, $ref, etc.). À la place on injecte le
   * schema en clair dans le prompt et on s'appuie sur Gemini Pro pour
   * respecter la structure (équivalent à ce qu'on faisait avant le tool_use
   * Anthropic, qui marchait à 95%+ déjà).
   */
  private async callWithToolGemini(options: ClaudeCallOptions & {
    tool: { name: string; description: string; input_schema: Record<string, unknown> };
  }): Promise<ClaudeToolResult> {
    // Garde kill-switch (défense en profondeur) : même si on arrive ici, aucun
    // appel Gemini ne part tant que GEMINI_DISABLED != 'false'. Le caller
    // (callWithTool) fallback alors sur Claude.
    if ((process.env.GEMINI_DISABLED ?? 'true').toLowerCase() !== 'false') {
      throw new Error('LisaClaudeClient: Gemini désactivé globalement (GEMINI_DISABLED) — fallback Claude.');
    }
    const apiKey = this.geminiConfig.apiKey;
    if (!apiKey) {
      throw new Error('LisaClaudeClient.callWithToolGemini: GEMINI_API_KEY missing');
    }

    const {
      profile,
      userMessage,
      maxTokens = 16000,
      tool,
    } = options;

    const { cacheable, profileSpecific } = buildLisaSystemPrompt(profile);
    const model = this.geminiConfig.model ?? 'gemini-2.5-pro';

    // System instruction = persona Lisa (cacheable + profile-specific).
    // Gemini's implicit context caching prendra le relais pour les blocs
    // stables au-delà de quelques cycles.
    const systemInstruction = `${cacheable}\n\n${profileSpecific}`;

    // User message enrichi : on append l'instruction JSON output + le schema
    // pour que Gemini sache exactement la forme attendue.
    const schemaJson = JSON.stringify(tool.input_schema, null, 2);
    const enrichedUser = `${userMessage}

# OUTPUT FORMAT — JSON STRICTEMENT CONFORME
Tu DOIS retourner UNIQUEMENT un objet JSON valide qui respecte exactement le schema ci-dessous. Pas de markdown, pas de prose, pas d'explication hors JSON. Le JSON doit être directement parsable par JSON.parse().

## Tool name
${tool.name}

## Tool description
${tool.description}

## Tool input_schema (JSON Schema draft-07)
\`\`\`json
${schemaJson}
\`\`\`

Retourne SEULEMENT l'objet JSON conforme à input_schema (pas l'enveloppe \`{ "tool_name": ..., "input": {...} }\` — directement le contenu de "input").`;

    // Lazy import @google/genai
    const { GoogleGenAI } = await import('@google/genai');
    const ai = new GoogleGenAI({ apiKey });

    const t0 = Date.now();
    const res = await ai.models.generateContent({
      model,
      contents: enrichedUser,
      config: {
        systemInstruction,
        temperature: 0.2,
        maxOutputTokens: maxTokens,
        responseMimeType: 'application/json',
      },
    });
    const latencyMs = Date.now() - t0;

    const inputTokens = res.usageMetadata?.promptTokenCount ?? 0;
    const outputTokens = res.usageMetadata?.candidatesTokenCount ?? 0;
    const rawText = res.text ?? '';

    if (!rawText) {
      throw new Error(`Gemini returned empty response (model=${model}, latency=${latencyMs}ms)`);
    }

    // Parse JSON. Gemini avec responseMimeType=application/json renvoie
    // du JSON pur sans markdown fence — mais on garde un cleanup défensif
    // au cas où (certains modèles enveloppent malgré le mime).
    const cleaned = rawText.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(cleaned) as Record<string, unknown>;
    } catch (err) {
      const sample = cleaned.slice(0, 300);
      throw new Error(
        `Gemini JSON parse failed (model=${model}): ${(err as Error).message} · sample="${sample}"`,
      );
    }

    this.geminiConfig.logger?.info?.(
      `[LisaClaudeClient:gemini] model=${model} in=${inputTokens}t out=${outputTokens}t lat=${latencyMs}ms`,
    );

    // Mappe vers ClaudeToolResult — usage tokens compatibles, toolUseId synth.
    return {
      input: parsed,
      toolUseId: `gemini-${Date.now()}`,
      usage: {
        inputTokens,
        outputTokens,
        // Gemini ne reporte pas cache_read/cache_write — laissés undefined
      },
      model,
      stopReason: 'end_turn',
    };
  }
}

export interface ClaudeToolResult {
  input: Record<string, unknown>;
  toolUseId: string;
  usage: ClaudeCallResult['usage'];
  model: string;
  stopReason: string | null;
}
