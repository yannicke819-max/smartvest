/**
 * LlmRouter — Wrapper Anthropic single-model pour `thesis_generation`.
 *
 * **ADR-001 Phase 2 (30/04/2026)** — Cleanup dead code.
 *
 * Avant : router multi-task avec mapping `LlmTask` → modèle (Opus/Sonnet/Haiku)
 * et fallback ladder à 80%/100% budget. Audit du repo : `news_classification`,
 * `summary`, `regime_classification`, `binary_decision`, `audit_explanation`
 * étaient déclarés dans le type `LlmTask` mais **0 call site runtime**. Le
 * fallback Haiku au-dessus de 80% budget est devenu cassé après le unset des
 * env vars `CLAUDE_MODEL_HAIKU` / `CLAUDE_MODEL_SONNET` per ADR-001.
 *
 * Aujourd'hui : un seul modèle (`claude-opus-4-7`) pour la seule tâche
 * réellement appelée (`thesis_generation`). Toutes les autres tâches LLM
 * (scanner, news, summary, regime, binary, audit) sont gérées hors de ce
 * router via `MultiVendorLlmRouter` (Gemini primary + Opus fallback) — cf.
 * `ScannerLlmRouterService`. Si un nouveau call site Gemini est ajouté plus
 * tard, il NE doit PAS revenir dans ce router — il rejoint la chain Gemini.
 *
 * **Règle d'or** : tout nouvel appel direct à `anthropic.messages.create`
 * hors de ce fichier est un bug. Le grep
 * `grep -rn 'messages\.create' apps packages | grep -v __tests__` doit
 * retourner exactement 1 hit (la ligne `executeCall` ci-dessous).
 *
 * Cf. `docs/decision_records/ADR-001-llm-architecture.md`
 */

import type Anthropic from '@anthropic-ai/sdk';

// ─────────────────────────────────────────────────────────────────────────────
// Types — task, mapping, pricing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Le type `LlmTask` est volontairement réduit à un literal singleton. Il reste
 * une union dans le code pour permettre une future extension SI un call site
 * Anthropic (pas Gemini) est ajouté — auquel cas ajouter une variante ici.
 */
export type LlmTask = 'thesis_generation';

/**
 * Mapping tâche → modèle. Override possible via `CLAUDE_MODEL_OPUS` pour
 * pinner une version stable en prod ou tester une nouvelle release.
 */
export const MODEL_BY_TASK: Record<LlmTask, string> = {
  thesis_generation: process.env.CLAUDE_MODEL_OPUS ?? 'claude-opus-4-7',
};

/**
 * Pricing Anthropic — USD par 1M tokens INPUT (snapshot 30/04/2026).
 *
 * Ne tient pas compte du prompt caching (cache_read = 0.1×, cache_write =
 * 1.25×). Les économies caching sont calculées en amont par
 * `LisaClaudeClient.estimateCostUsd`. Pour le budget breaker,
 * l'approximation input-only est suffisante.
 */
export const COST_PER_1M_TOKENS_INPUT: Record<string, number> = {
  'claude-opus-4-7': 15.0,
};

/**
 * Pricing OUTPUT par 1M tokens — typiquement 5× le prix d'input.
 */
export const COST_PER_1M_TOKENS_OUTPUT: Record<string, number> = {
  'claude-opus-4-7': 75.0,
};

// ─────────────────────────────────────────────────────────────────────────────
// Erreur dédiée — distinguishable du caller pour audit hard-stop
// ─────────────────────────────────────────────────────────────────────────────

export class BudgetExceededError extends Error {
  readonly todayCostUsd: number;
  readonly budgetUsd: number;
  readonly task: LlmTask;
  constructor(message: string, todayCostUsd: number, budgetUsd: number, task: LlmTask) {
    super(message);
    this.name = 'BudgetExceededError';
    this.todayCostUsd = todayCostUsd;
    this.budgetUsd = budgetUsd;
    this.task = task;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Interfaces injectables — pas de dépendance Supabase ici
// ─────────────────────────────────────────────────────────────────────────────

export interface CostTracker {
  /** USD cumulés depuis 00:00 UTC aujourd'hui (tous modèles confondus). */
  getTodayTotalUsd(): Promise<number>;
  /** Persiste le coût d'un appel après réponse Anthropic (success uniquement). */
  record(entry: {
    task: LlmTask;
    model: string;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
  }): Promise<void>;
}

/**
 * Logger optionnel pour audit. Si non fourni, fallback silencieux.
 */
export interface AuditLogger {
  warn(event: string, details: Record<string, unknown>): void;
}

export interface LlmRouterConfig {
  /** Budget journalier en USD (cumul tous modèles, depuis 00:00 UTC). */
  dailyCostBudgetUsd: number;
  /**
   * À 80% du budget pour une tâche Opus :
   *  - `true`  → soft warn + continue avec Opus (caller paie le dépassement
   *               léger pour ne pas bloquer le cycle)
   *  - `false` → throw `BudgetExceededError` strict
   *
   * ADR-001 Phase 2 — il n'y a plus de "fallback Haiku" : Haiku est interdit.
   * Le seul choix à 80% est continue-or-stop sur Opus.
   */
  fallbackOnBudget: boolean;
}

export interface LlmRouterCallResult {
  /** Réponse brute Anthropic (content blocks, usage, stop_reason). */
  response: Anthropic.Message;
  /** Modèle effectivement appelé. ADR-001 Phase 2 : toujours Opus. */
  modelUsed: string;
  /**
   * `false` en steady state. `true` quand `forceContinue=true` au-dessus de
   * 100% budget — le router a choisi de continuer plutôt que throw, le
   * caller doit traiter ça comme un signal d'audit (over-budget).
   */
  fallback: boolean;
  /** Raison du soft-continue (over-budget, audit only — pas un vrai fallback model). */
  fallbackReason?: 'budget_100pct_soft_continue';
  /** Coût de l'appel en USD (input + output, hors caching). */
  costUsd: number;
}

/**
 * P0-A — Override per-call pour le budget. Permet au caller de relire
 * `lisa_session_configs.daily_cost_budget_usd` + `cost_force_continue`
 * à chaque cycle (vs config statique au constructor du router).
 */
export interface LlmRouterCallOptions {
  /** Override du budget journalier USD pour CET appel uniquement. */
  budgetUsd?: number;
  /**
   * Override du flag soft-budget pour CET appel.
   *  - `true` (default DB) : à 100% du budget, soft-warn + continue (over-budget toléré ce call)
   *  - `false` : hard throw `BudgetExceededError`
   */
  forceContinue?: boolean;
}

// Anthropic client minimal — on n'a besoin que de messages.create. Permet
// de mocker proprement en test sans dépendre de l'instance Anthropic complète.
export interface AnthropicLike {
  messages: {
    create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Router
// ─────────────────────────────────────────────────────────────────────────────

/**
 * LlmRouter — point d'entrée unique pour toute requête Anthropic.
 *
 * **Call site** (1, unique) :
 *  - `LisaClaudeClient.call` / `callWithTool` → `'thesis_generation'`
 *    (consommé par `ThesisGeneratorService` — ~1 appel par cycle Lisa)
 *
 * Tout autre call LLM (scanner, news, regime, binary, audit, summary) doit
 * passer par `MultiVendorLlmRouter` avec Gemini primary + Opus fallback,
 * **PAS** par ce router. Cf. `ScannerLlmRouterService`.
 */
export class LlmRouter {
  constructor(
    private readonly anthropic: AnthropicLike,
    private readonly costTracker: CostTracker,
    private readonly config: LlmRouterConfig,
    private readonly auditLogger?: AuditLogger,
  ) {
    // Validateur boot-time : tout modèle dans MODEL_BY_TASK doit avoir un
    // pricing connu. Empêche un typo `CLAUDE_MODEL_OPUS=opsu-4-7` de passer
    // jusqu'au premier appel Anthropic en prod.
    const KNOWN_MODELS = new Set(Object.keys(COST_PER_1M_TOKENS_INPUT));
    for (const [task, model] of Object.entries(MODEL_BY_TASK)) {
      if (!KNOWN_MODELS.has(model)) {
        throw new Error(
          `LlmRouter: unknown model "${model}" for task "${task}". `
          + `Known models: ${[...KNOWN_MODELS].join(', ')}. `
          + `Set CLAUDE_MODEL_OPUS env var or update COST_PER_1M_TOKENS_* tables.`,
        );
      }
    }
    // Cohérence INPUT/OUTPUT — chaque modèle pricé en input doit l'être en output.
    for (const model of KNOWN_MODELS) {
      if (!(model in COST_PER_1M_TOKENS_OUTPUT)) {
        throw new Error(`LlmRouter: model "${model}" has INPUT price but no OUTPUT price.`);
      }
    }
  }

  /**
   * Appel Claude pour une tâche typée. Le modèle est décidé par le routeur.
   *
   * Le caller fournit `params` SANS le champ `model` (le routeur l'écrase
   * de toute façon). Cette API rend impossible un override silencieux du
   * choix du modèle côté caller.
   *
   * Matrice de comportement (ADR-001 Phase 2 — fallback Haiku supprimé) :
   *   - todayCost <  80%               → modèle nominal (Opus)
   *   - todayCost ≥  80% & < 100%
   *       · fallbackOnBudget=true      → soft warn + continue Opus
   *       · fallbackOnBudget=false     → throw `BudgetExceededError`
   *   - todayCost ≥ 100% & fc=true     → soft warn + continue Opus (audit flag fallback=true)
   *   - todayCost ≥ 100% & fc=false    → throw `BudgetExceededError`
   */
  async call(
    task: LlmTask,
    params: Omit<Anthropic.MessageCreateParamsNonStreaming, 'model'>,
    options: LlmRouterCallOptions = {},
  ): Promise<LlmRouterCallResult> {
    const todayCost = await this.costTracker.getTodayTotalUsd();
    const budget = options.budgetUsd ?? this.config.dailyCostBudgetUsd;
    const forceContinue = options.forceContinue ?? false;
    const nominalModel = MODEL_BY_TASK[task];

    // 100% budget — soft continue si forceContinue, sinon hard throw.
    if (todayCost >= budget) {
      if (forceContinue) {
        this.auditLogger?.warn('cost_budget_warn', {
          task,
          todayCostUsd: todayCost,
          budgetUsd: budget,
          model: nominalModel,
          reason: 'soft_continue_100pct',
        });
        const result = await this.executeCall(task, params, nominalModel);
        return { ...result, fallback: true, fallbackReason: 'budget_100pct_soft_continue' };
      }
      throw new BudgetExceededError(
        `Daily budget reached ($${todayCost.toFixed(2)}/${budget.toFixed(2)}), task '${task}' refused`,
        todayCost,
        budget,
        task,
      );
    }

    // 80% budget — soft warn + continue Opus (fallbackOnBudget=true)
    // ou throw strict (fallbackOnBudget=false). Plus de fallback Haiku
    // (interdit per ADR-001, et `claude-haiku-4-5-*` n'est plus dans
    // COST_PER_1M_TOKENS de toute façon).
    if (todayCost >= budget * 0.8) {
      if (!this.config.fallbackOnBudget && !forceContinue) {
        throw new BudgetExceededError(
          `Daily budget 80% reached ($${todayCost.toFixed(2)}/${budget.toFixed(2)}), task '${task}' refused`,
          todayCost,
          budget,
          task,
        );
      }
      this.auditLogger?.warn('cost_budget_warn_80pct', {
        task,
        todayCostUsd: todayCost,
        budgetUsd: budget,
        model: nominalModel,
        reason: 'soft_continue_80pct',
      });
      // Pas de marquage `fallback: true` ici — on est sous 100%, c'est juste
      // un warning. Le caller continue son cycle normalement.
    }

    return this.executeCall(task, params, nominalModel);
  }

  /**
   * Helper privé pour l'exécution + tracking d'un appel Anthropic.
   */
  private async executeCall(
    task: LlmTask,
    params: Omit<Anthropic.MessageCreateParamsNonStreaming, 'model'>,
    model: string,
  ): Promise<LlmRouterCallResult> {
    const response = await this.anthropic.messages.create({ ...params, model });

    const inputTokens = response.usage?.input_tokens ?? 0;
    const outputTokens = response.usage?.output_tokens ?? 0;
    const costUsd = this.computeCostUsd(model, inputTokens, outputTokens);

    await this.costTracker.record({ task, model, inputTokens, outputTokens, costUsd });

    return { response, modelUsed: model, fallback: false, costUsd };
  }

  /**
   * Pure helper exposé pour test + introspection.
   */
  computeCostUsd(model: string, inputTokens: number, outputTokens: number): number {
    const inputPerM = COST_PER_1M_TOKENS_INPUT[model] ?? 0;
    const outputPerM = COST_PER_1M_TOKENS_OUTPUT[model] ?? 0;
    return (inputTokens * inputPerM + outputTokens * outputPerM) / 1_000_000;
  }
}
