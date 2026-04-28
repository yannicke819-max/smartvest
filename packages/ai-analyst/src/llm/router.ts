/**
 * LlmRouter — Centralisation du choix de modèle Claude par type de tâche.
 *
 * Avant ce router, chaque service Lisa choisissait son modèle "à la main".
 * Résultat : Opus 4.7 utilisé pour des tâches binaires triviales (4× plus
 * cher que Sonnet 4.6, 19× plus cher que Haiku 4.5), aucun circuit breaker
 * commun, pas de tracking unifié.
 *
 * Le router applique trois règles :
 *
 *  1. Choix du modèle par TÂCHE (pas par appelant) :
 *     - thesis_generation     → Opus    (qualité capitale, ~1 appel par cycle)
 *     - regime_classification → Sonnet  (~1 appel par cycle)
 *     - binary_decision       → Sonnet  (close/keep, ouvre/n'ouvre pas)
 *     - audit_explanation     → Sonnet  (lecture humaine post-hoc)
 *     - news_classification   → Haiku   (volume — jusqu'à 45 par cycle)
 *     - summary               → Haiku   (formatage, pas de raisonnement)
 *
 *  2. Circuit breaker budget :
 *     - todayCost ≥ 100% du budget journalier → throw BudgetExceededError
 *       quel que soit le modèle (pas de "sauvetage Haiku" miracle).
 *     - todayCost ≥ 80% ET tâche routée Opus :
 *         · fallbackOnBudget=true  → bascule vers Sonnet, audit warn.
 *         · fallbackOnBudget=false → throw BudgetExceededError pour la
 *           tâche Opus (les tâches Sonnet/Haiku continuent normalement).
 *     Cohérent avec PATCH 4 (hard-stop budget) — le router est le LAST
 *     LINE of defense après le check par-portefeuille de PATCH 4.
 *
 *  3. Comptabilisation post-success :
 *     CostTracker.record() est appelé après chaque succès Anthropic, même
 *     en fallback. Garantit que le todayCost utilisé au prochain check
 *     est à jour.
 *
 * Le router stay dans @smartvest/ai-analyst (pas de dépendance Supabase) :
 * `CostTracker` est une interface ; côté apps/api, ApiCostTrackerService
 * (PATCH 4) l'implémente.
 *
 * Cf. PATCH 6 P1 cost-01-llm-router.
 */

import type Anthropic from '@anthropic-ai/sdk';

// ─────────────────────────────────────────────────────────────────────────────
// Types — tâche, mapping, coûts
// ─────────────────────────────────────────────────────────────────────────────

export type LlmTask =
  | 'thesis_generation'      // Opus — génération de thèses Lisa (qualité critique)
  | 'regime_classification'  // Sonnet — classification du régime macro courant
  | 'binary_decision'        // Sonnet — close/keep, open/skip, simple gating
  | 'news_classification'    // Haiku — bulk (45/cycle), tag sentiment + relevance
  | 'audit_explanation'      // Sonnet — narratif humain post-hoc d'une décision
  | 'summary';               // Haiku — formatage / résumé sans raisonnement

/**
 * Mapping tâche → modèle Claude.
 *
 * Modèles réels au 27 avril 2026 (cf. system context). Override possible
 * via env vars `CLAUDE_MODEL_OPUS|SONNET|HAIKU` pour pinner une version
 * stable en prod ou tester une nouvelle release.
 */
export const MODEL_BY_TASK: Record<LlmTask, string> = {
  thesis_generation:     process.env.CLAUDE_MODEL_OPUS   ?? 'claude-opus-4-7',
  regime_classification: process.env.CLAUDE_MODEL_SONNET ?? 'claude-sonnet-4-6',
  binary_decision:       process.env.CLAUDE_MODEL_SONNET ?? 'claude-sonnet-4-6',
  news_classification:   process.env.CLAUDE_MODEL_HAIKU  ?? 'claude-haiku-4-5-20251001',
  audit_explanation:     process.env.CLAUDE_MODEL_SONNET ?? 'claude-sonnet-4-6',
  summary:               process.env.CLAUDE_MODEL_HAIKU  ?? 'claude-haiku-4-5-20251001',
};

/**
 * Pricing Anthropic au 27 avril 2026 — USD par 1M tokens d'INPUT.
 *
 * Ne tient pas compte du prompt caching (cache_read = 0.1×, cache_write =
 * 1.25×). Les économies caching sont calculées en amont par
 * `LisaClaudeClient.estimateCostUsd` quand pertinent. Pour le routing
 * budget breaker, l'approximation input-only est suffisante.
 */
export const COST_PER_1M_TOKENS_INPUT: Record<string, number> = {
  'claude-opus-4-7': 15.0,
  'claude-sonnet-4-6': 3.0,
  'claude-haiku-4-5-20251001': 0.80,
};

/**
 * Pricing OUTPUT par 1M tokens — typiquement 5× le prix d'input.
 */
export const COST_PER_1M_TOKENS_OUTPUT: Record<string, number> = {
  'claude-opus-4-7': 75.0,
  'claude-sonnet-4-6': 15.0,
  'claude-haiku-4-5-20251001': 4.0,
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
 * Côté apps/api, peut être implémenté par DecisionLogService ou un
 * Logger NestJS standard.
 */
export interface AuditLogger {
  warn(event: string, details: Record<string, unknown>): void;
}

export interface LlmRouterConfig {
  /** Budget journalier en USD (cumul tous modèles, depuis 00:00 UTC). */
  dailyCostBudgetUsd: number;
  /** À 80% du budget, fallback Opus → Sonnet (true) ou throw (false). */
  fallbackOnBudget: boolean;
}

export interface LlmRouterCallResult {
  /** Réponse brute Anthropic (content blocks, usage, stop_reason). */
  response: Anthropic.Message;
  /** Modèle effectivement appelé (peut différer de MODEL_BY_TASK[task] si fallback). */
  modelUsed: string;
  /** True si le circuit breaker a basculé Opus → Haiku/Sonnet. */
  fallback: boolean;
  /** Raison du fallback (pour audit). */
  fallbackReason?: 'budget_80pct_haiku' | 'budget_100pct_soft_haiku';
  /** Coût de l'appel en USD (input + output, hors caching). */
  costUsd: number;
}

/**
 * P0-A — Override per-call pour le budget. Permet au caller de relire
 * `lisa_session_configs.daily_cost_budget_usd` + `cost_force_continue`
 * à chaque cycle (vs config statique au constructor du router).
 *
 * Sans override → utilise les valeurs constructor (rétrocompat PR #15).
 */
export interface LlmRouterCallOptions {
  /** Override du budget journalier USD pour CET appel uniquement. */
  budgetUsd?: number;
  /** Override du flag soft-budget pour CET appel.
   *  - `true` (default DB) : à 100% du budget, soft-warn + Haiku au lieu de throw
   *  - `false` : hard throw (comportement legacy PR #15) */
  forceContinue?: boolean;
}

// Anthropic client minimal — on n'a besoin que de messages.create. Permet
// de mocker proprement en test sans depend de l'instance Anthropic complète.
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
 * **Call sites actuels (migrés)** :
 *  - `LisaClaudeClient.call` / `callWithTool` → `'thesis_generation'`
 *    (consommé par `ThesisGeneratorService` — ~1 appel par cycle Lisa, ~$0.50)
 *
 * **Call sites réservés / à venir** — chaque tâche est PRÉ-CÂBLÉE dans
 * `MODEL_BY_TASK` pour qu'un nouveau service n'ait pas à choisir son
 * modèle. Quand l'un de ces services sera implémenté, il devra prendre un
 * `LlmRouter` en dépendance et appeler `router.call(task, params)` :
 *
 *  - `'regime_classification'` → MarketRegimeClassifier (à venir)
 *      classifie le régime macro courant en 1 des 14 valeurs `MarketRegime`.
 *      Sonnet — input court (~5k tokens), output très court (1 enum).
 *  - `'binary_decision'` → futurs gating Lisa (à venir)
 *      close/keep, open/skip, override de stop. Sonnet par défaut, Haiku
 *      possible si le contexte tient en 2k tokens.
 *  - `'audit_explanation'` → AuditService (à venir)
 *      narratif humain post-hoc d'une décision auto pour /admin/audit.
 *      Sonnet — réponse longue, lecture humaine.
 *  - `'news_classification'` → EodhdNewsService.classifyBatch (à venir)
 *      tag {sentiment, relevance, ticker_match} sur news bulk.
 *      **Volume : jusqu'à 45 appels par cycle** — Haiku obligatoire pour
 *      le ratio coût/quantité.
 *  - `'summary'` → divers (à venir)
 *      formatage de blocs (résumés portefeuille, briefings, snapshots).
 *      Haiku — pas de raisonnement.
 *
 * **Règle d'or** : tout nouvel appel direct à `anthropic.messages.create`
 * hors de ce fichier est un bug. Le grep
 * `grep -rn 'messages\.create' apps packages | grep -v __tests__` doit
 * retourner exactement 1 hit (ligne `await this.anthropic.messages.create`
 * dans la méthode `call()` ci-dessous).
 *
 * Cf. PATCH 6 P1 cost-01-llm-router.
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
          + `Set CLAUDE_MODEL_OPUS|SONNET|HAIKU env vars or update COST_PER_1M_TOKENS_* tables.`,
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
   * choix du modèle côté caller — la centralisation est imposée par le type.
   *
   * P0-A — `options.budgetUsd` / `options.forceContinue` permettent au
   * caller de relire `lisa_session_configs.daily_cost_budget_usd` +
   * `cost_force_continue` à chaque cycle plutôt que d'utiliser la config
   * statique du constructor. Si non fournis, on retombe sur la config
   * du constructor (rétrocompat PR #15).
   *
   * Matrice de comportement (`fc` = forceContinue effectif) :
   *   - todayCost <  80%             → modèle nominal (MODEL_BY_TASK[task])
   *   - todayCost ≥  80% & < 100% & opus task → fallback **Haiku** + warn
   *     (Sonnet/Haiku tasks restent inchangées)
   *   - todayCost ≥ 100% & fc=true   → soft warn + **Haiku** (toutes tâches)
   *   - todayCost ≥ 100% & fc=false  → throw `BudgetExceededError`
   */
  async call(
    task: LlmTask,
    params: Omit<Anthropic.MessageCreateParamsNonStreaming, 'model'>,
    options: LlmRouterCallOptions = {},
  ): Promise<LlmRouterCallResult> {
    const todayCost = await this.costTracker.getTodayTotalUsd();
    const budget = options.budgetUsd ?? this.config.dailyCostBudgetUsd;
    // forceContinue per-call > forceContinue inherent (= !fallbackOnBudget legacy ?
    // non — fallbackOnBudget contrôlait le 80% Opus, pas le 100% hard-stop).
    // Le default est `true` (soft mode) côté DB, `false` côté constructor pour
    // ne pas changer le comportement de tests existants qui n'utilisent pas
    // l'option per-call.
    const forceContinue = options.forceContinue ?? false;
    const haikuModel = MODEL_BY_TASK['news_classification']; // Haiku 4.5

    // 100% budget — soft warn + Haiku si forceContinue, sinon hard throw.
    if (todayCost >= budget) {
      if (forceContinue) {
        this.auditLogger?.warn('cost_budget_warn', {
          task,
          todayCostUsd: todayCost,
          budgetUsd: budget,
          originalModel: MODEL_BY_TASK[task],
          fallbackModel: haikuModel,
          reason: 'soft_haiku_100pct',
        });
        const result = await this.executeCall(task, params, haikuModel);
        return { ...result, fallback: true, fallbackReason: 'budget_100pct_soft_haiku' };
      }
      throw new BudgetExceededError(
        `Daily budget reached ($${todayCost.toFixed(2)}/${budget.toFixed(2)}), task '${task}' refused`,
        todayCost,
        budget,
        task,
      );
    }

    const nominalModel = MODEL_BY_TASK[task];

    // 80% budget + tâche Opus — fallback Haiku (économie ~19× input vs Opus).
    // Les tâches Sonnet (binary_decision, audit_explanation) restent
    // inchangées — elles consomment déjà 5× moins que Opus, le saving
    // marginal Haiku est moindre et les tâches binary_decision peuvent
    // perdre en qualité sur Haiku.
    if (todayCost >= budget * 0.8 && nominalModel.includes('opus')) {
      // Le legacy `fallbackOnBudget=false` (constructor) reste honoré pour
      // les opérateurs en mode strict — throw au lieu de fallback.
      if (!this.config.fallbackOnBudget && !forceContinue) {
        throw new BudgetExceededError(
          `Daily budget 80% reached ($${todayCost.toFixed(2)}/${budget.toFixed(2)}), Opus task '${task}' refused`,
          todayCost,
          budget,
          task,
        );
      }
      this.auditLogger?.warn('opus_haiku_fallback', {
        task,
        todayCostUsd: todayCost,
        budgetUsd: budget,
        originalModel: nominalModel,
        fallbackModel: haikuModel,
        reason: 'opus_to_haiku_80pct',
      });
      const result = await this.executeCall(task, params, haikuModel);
      return { ...result, fallback: true, fallbackReason: 'budget_80pct_haiku' };
    }

    return this.executeCall(task, params, nominalModel);
  }

  /**
   * P0-A — Helper privé pour l'exécution + tracking d'un appel Anthropic.
   * Extrait pour éviter la duplication entre le path nominal et les 2
   * paths de fallback (80% Haiku + 100% soft-Haiku).
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
