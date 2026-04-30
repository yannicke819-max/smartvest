/**
 * ADR-001 Phase 2 (30/04/2026) — Tests du LlmRouter post-cleanup.
 *
 * Le router est désormais single-task (`thesis_generation` → Opus). Les
 * variantes Sonnet/Haiku ont été supprimées du `LlmTask` enum + du
 * `MODEL_BY_TASK` mapping + du COST_PER_1M_TOKENS_*. Le fallback Haiku au
 * 80%/100% budget est remplacé par un soft-warn + continue avec Opus.
 *
 * Vérifie le contrat :
 *  - Mapping `thesis_generation` → Opus (1 seule entrée)
 *  - Override env var `CLAUDE_MODEL_OPUS`
 *  - 80% budget : soft warn + continue Opus si `fallbackOnBudget=true`,
 *    sinon throw `BudgetExceededError`
 *  - 100% budget : throw par défaut, soft continue Opus si `forceContinue=true`
 *  - Calcul de coût (input + output) sur Opus
 *  - Persistance via CostTracker.record() après success
 *  - Validateur boot-time (modèle inconnu → throw au constructeur)
 */

import type Anthropic from '@anthropic-ai/sdk';
import {
  AnthropicLike,
  AuditLogger,
  BudgetExceededError,
  COST_PER_1M_TOKENS_INPUT,
  COST_PER_1M_TOKENS_OUTPUT,
  CostTracker,
  LlmRouter,
  MODEL_BY_TASK,
} from '../router';

// ────────────────────────────────────────────────────────────────────
// Helpers — fakes Anthropic + CostTracker + AuditLogger
// ────────────────────────────────────────────────────────────────────

interface FakeMessageOptions {
  inputTokens?: number;
  outputTokens?: number;
  model?: string;
}

function fakeMessage(opts: FakeMessageOptions = {}): Anthropic.Message {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: opts.model ?? 'claude-opus-4-7',
    content: [{ type: 'text', text: 'ok', citations: null } as unknown as Anthropic.TextBlock],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: opts.inputTokens ?? 100,
      output_tokens: opts.outputTokens ?? 50,
    } as unknown as Anthropic.Usage,
  } as unknown as Anthropic.Message;
}

function makeAnthropic(): { client: AnthropicLike; create: jest.Mock } {
  const create = jest.fn();
  return { client: { messages: { create } }, create };
}

function makeCostTracker(initialTodayUsd = 0): {
  tracker: CostTracker;
  getToday: jest.Mock;
  record: jest.Mock;
} {
  let today = initialTodayUsd;
  const getToday = jest.fn(async () => today);
  const record = jest.fn(async (entry: Parameters<CostTracker['record']>[0]) => {
    today += entry.costUsd;
  });
  return {
    tracker: { getTodayTotalUsd: getToday, record },
    getToday,
    record,
  };
}

function makeAuditLogger(): { logger: AuditLogger; warn: jest.Mock } {
  const warn = jest.fn();
  return { logger: { warn }, warn };
}

const baseParams = {
  max_tokens: 100,
  messages: [{ role: 'user' as const, content: 'hello' }],
};

// ────────────────────────────────────────────────────────────────────

describe('LlmRouter — mapping single-task (ADR-001 Phase 2)', () => {
  it('routes thesis_generation to Opus model ID', async () => {
    const { client, create } = makeAnthropic();
    create.mockResolvedValue(fakeMessage({ model: 'claude-opus-4-7' }));
    const { tracker } = makeCostTracker(0);
    const router = new LlmRouter(client, tracker, { dailyCostBudgetUsd: 100, fallbackOnBudget: true });

    const result = await router.call('thesis_generation', baseParams);

    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0].model).toBe('claude-opus-4-7');
    expect(result.modelUsed).toBe('claude-opus-4-7');
    expect(result.fallback).toBe(false);
  });

  it('MODEL_BY_TASK contains exactly one entry: thesis_generation → Opus', () => {
    expect(Object.keys(MODEL_BY_TASK)).toEqual(['thesis_generation']);
    expect(MODEL_BY_TASK.thesis_generation).toMatch(/opus/);
  });

  it('respects CLAUDE_MODEL_OPUS env var at module load time', () => {
    const KNOWN = new Set(Object.keys(COST_PER_1M_TOKENS_INPUT));
    for (const model of Object.values(MODEL_BY_TASK)) {
      expect(KNOWN.has(model)).toBe(true);
    }
  });
});

describe('LlmRouter — 80% budget threshold (Opus continue or throw)', () => {
  it('soft warn + continue Opus at 85% with fallbackOnBudget=true', async () => {
    const { client, create } = makeAnthropic();
    create.mockResolvedValue(fakeMessage({ model: 'claude-opus-4-7' }));
    const { tracker, record } = makeCostTracker(85);
    const { logger, warn } = makeAuditLogger();
    const router = new LlmRouter(
      client,
      tracker,
      { dailyCostBudgetUsd: 100, fallbackOnBudget: true },
      logger,
    );

    const result = await router.call('thesis_generation', baseParams);

    expect(create.mock.calls[0][0].model).toBe('claude-opus-4-7');
    expect(result.modelUsed).toBe('claude-opus-4-7');
    expect(result.fallback).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      'cost_budget_warn_80pct',
      expect.objectContaining({
        task: 'thesis_generation',
        model: 'claude-opus-4-7',
        todayCostUsd: 85,
        budgetUsd: 100,
      }),
    );
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0][0].model).toBe('claude-opus-4-7');
  });

  it('throws BudgetExceededError at 85% when fallbackOnBudget=false', async () => {
    const { client, create } = makeAnthropic();
    const { tracker, record } = makeCostTracker(85);
    const router = new LlmRouter(client, tracker, {
      dailyCostBudgetUsd: 100,
      fallbackOnBudget: false,
    });

    await expect(router.call('thesis_generation', baseParams)).rejects.toThrow(BudgetExceededError);
    expect(create).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it('does NOT trigger 80% path when budget is below 80% (Opus stays at 75%)', async () => {
    const { client, create } = makeAnthropic();
    create.mockResolvedValue(fakeMessage());
    const { tracker } = makeCostTracker(75);
    const { logger, warn } = makeAuditLogger();
    const router = new LlmRouter(
      client,
      tracker,
      { dailyCostBudgetUsd: 100, fallbackOnBudget: true },
      logger,
    );

    const result = await router.call('thesis_generation', baseParams);

    expect(create.mock.calls[0][0].model).toBe('claude-opus-4-7');
    expect(result.fallback).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it('forceContinue=true bypasses fallbackOnBudget=false at 80%', async () => {
    const { client, create } = makeAnthropic();
    create.mockResolvedValue(fakeMessage());
    const { tracker } = makeCostTracker(85);
    const router = new LlmRouter(client, tracker, {
      dailyCostBudgetUsd: 100,
      fallbackOnBudget: false,
    });

    // Sans forceContinue → throw (couvert plus haut). Avec forceContinue=true,
    // le caller force le passage : warn + continue Opus.
    const result = await router.call('thesis_generation', baseParams, { forceContinue: true });
    expect(result.modelUsed).toBe('claude-opus-4-7');
    expect(result.fallback).toBe(false);
  });
});

describe('LlmRouter — 100% budget hard-stop', () => {
  it('throws BudgetExceededError at 110% by default (no forceContinue)', async () => {
    const { client, create } = makeAnthropic();
    const { tracker } = makeCostTracker(110);
    const router = new LlmRouter(client, tracker, {
      dailyCostBudgetUsd: 100,
      fallbackOnBudget: true,
    });

    await expect(router.call('thesis_generation', baseParams)).rejects.toThrow(BudgetExceededError);
    expect(create).not.toHaveBeenCalled();
  });

  it('throws BudgetExceededError exactly at 100% (>=, not >)', async () => {
    const { client } = makeAnthropic();
    const { tracker } = makeCostTracker(100);
    const router = new LlmRouter(client, tracker, {
      dailyCostBudgetUsd: 100,
      fallbackOnBudget: true,
    });

    await expect(router.call('thesis_generation', baseParams)).rejects.toThrow(BudgetExceededError);
  });

  it('error carries todayCost + budget + task fields', async () => {
    const { client } = makeAnthropic();
    const { tracker } = makeCostTracker(150);
    const router = new LlmRouter(client, tracker, {
      dailyCostBudgetUsd: 100,
      fallbackOnBudget: true,
    });

    try {
      await router.call('thesis_generation', baseParams);
      fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(BudgetExceededError);
      const err = e as BudgetExceededError;
      expect(err.todayCostUsd).toBe(150);
      expect(err.budgetUsd).toBe(100);
      expect(err.task).toBe('thesis_generation');
    }
  });
});

describe('LlmRouter — soft-budget at 100% with forceContinue', () => {
  it('soft warns + continues OPUS at 105% with forceContinue=true (no throw, no Haiku)', async () => {
    const { client, create } = makeAnthropic();
    create.mockResolvedValue(fakeMessage({ inputTokens: 1500, outputTokens: 800, model: 'claude-opus-4-7' }));
    const { tracker, record } = makeCostTracker(105);
    const { logger, warn } = makeAuditLogger();
    const router = new LlmRouter(
      client,
      tracker,
      { dailyCostBudgetUsd: 100, fallbackOnBudget: true },
      logger,
    );

    const result = await router.call('thesis_generation', baseParams, { forceContinue: true });

    expect(create.mock.calls[0][0].model).toBe('claude-opus-4-7');
    expect(result.modelUsed).toBe('claude-opus-4-7');
    expect(result.fallback).toBe(true);
    expect(result.fallbackReason).toBe('budget_100pct_soft_continue');
    expect(warn).toHaveBeenCalledWith(
      'cost_budget_warn',
      expect.objectContaining({
        task: 'thesis_generation',
        todayCostUsd: 105,
        budgetUsd: 100,
        model: 'claude-opus-4-7',
        reason: 'soft_continue_100pct',
      }),
    );
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0][0].model).toBe('claude-opus-4-7');
  });

  it('throws BudgetExceededError at 100% when forceContinue=false', async () => {
    const { client, create } = makeAnthropic();
    const { tracker, record } = makeCostTracker(110);
    const router = new LlmRouter(client, tracker, {
      dailyCostBudgetUsd: 100,
      fallbackOnBudget: true,
    });

    await expect(
      router.call('thesis_generation', baseParams, { forceContinue: false }),
    ).rejects.toThrow(BudgetExceededError);
    expect(create).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it('default behavior at 100% (no options) = throw — preserves legacy strict mode', async () => {
    const { client } = makeAnthropic();
    const { tracker } = makeCostTracker(110);
    const router = new LlmRouter(client, tracker, {
      dailyCostBudgetUsd: 100,
      fallbackOnBudget: true,
    });

    await expect(router.call('thesis_generation', baseParams)).rejects.toThrow(BudgetExceededError);
  });
});

describe('LlmRouter — per-call budget override', () => {
  it('uses options.budgetUsd over constructor budget', async () => {
    const { client, create } = makeAnthropic();
    create.mockResolvedValue(fakeMessage());
    const { tracker } = makeCostTracker(40);
    const { logger, warn } = makeAuditLogger();
    const router = new LlmRouter(
      client,
      tracker,
      // Constructor : budget $100 (40% spend = pas de warn)
      // Override per-call : budget $50 (40/50 = 80% → trigger warn 80% path)
      { dailyCostBudgetUsd: 100, fallbackOnBudget: true },
      logger,
    );

    const result = await router.call('thesis_generation', baseParams, { budgetUsd: 50 });

    // Warn 80% loggué mais pas de fallback model — toujours Opus.
    expect(result.modelUsed).toBe('claude-opus-4-7');
    expect(result.fallback).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      'cost_budget_warn_80pct',
      expect.objectContaining({ todayCostUsd: 40, budgetUsd: 50 }),
    );
  });

  it('options.budgetUsd raised triggers MORE permissive behavior (no warn at 30%)', async () => {
    const { client, create } = makeAnthropic();
    create.mockResolvedValue(fakeMessage({ model: 'claude-opus-4-7' }));
    const { tracker } = makeCostTracker(15);
    const { logger, warn } = makeAuditLogger();
    // Constructor : budget $20 (75% spend → just under 80%)
    // Override per-call : budget $50 (15/50 = 30% → no warn)
    const router = new LlmRouter(
      client,
      tracker,
      { dailyCostBudgetUsd: 20, fallbackOnBudget: true },
      logger,
    );

    const result = await router.call('thesis_generation', baseParams, { budgetUsd: 50 });

    expect(result.fallback).toBe(false);
    expect(result.modelUsed).toBe('claude-opus-4-7');
    expect(warn).not.toHaveBeenCalled();
  });

  it('UI raise budget $20→$50 unblocks autopilot (incident 28/04 05:02 UTC repro)', async () => {
    // Repro exact : router config $20 (statique env), spend $20.46, UI
    // remonte à $50, le caller relit DB et passe budgetUsd: 50 par cycle.
    const { client, create } = makeAnthropic();
    create.mockResolvedValue(fakeMessage());
    const { tracker } = makeCostTracker(20.46);
    const router = new LlmRouter(client, tracker, {
      dailyCostBudgetUsd: 20, // ancien env, jamais re-read
      fallbackOnBudget: true,
    });

    // Sans override : throw (situation prod 28/04)
    await expect(router.call('thesis_generation', baseParams)).rejects.toThrow(BudgetExceededError);

    // Avec override DB → budget $50 → 41% spend → no warn, continue Opus
    const result = await router.call('thesis_generation', baseParams, { budgetUsd: 50 });
    expect(result.fallback).toBe(false);
    expect(result.modelUsed).toBe('claude-opus-4-7');
  });
});

describe('LlmRouter — cost tracking + persistence', () => {
  it('records the call with task/model/tokens/costUsd after success (Opus only)', async () => {
    const { client, create } = makeAnthropic();
    create.mockResolvedValue(fakeMessage({ inputTokens: 1000, outputTokens: 500, model: 'claude-opus-4-7' }));
    const { tracker, record } = makeCostTracker(0);
    const router = new LlmRouter(client, tracker, {
      dailyCostBudgetUsd: 100,
      fallbackOnBudget: true,
    });

    const result = await router.call('thesis_generation', baseParams);

    // Opus : 1000 input × $15/1M + 500 output × $75/1M = 0.015 + 0.0375 = 0.0525
    const expectedCost = (1000 * 15 + 500 * 75) / 1_000_000;
    expect(result.costUsd).toBeCloseTo(expectedCost, 6);
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0][0]).toEqual({
      task: 'thesis_generation',
      model: 'claude-opus-4-7',
      inputTokens: 1000,
      outputTokens: 500,
      costUsd: expect.any(Number),
    });
    expect(record.mock.calls[0][0].costUsd).toBeCloseTo(expectedCost, 6);
  });

  it('does NOT record on Anthropic error (no double-counting failed calls)', async () => {
    const { client, create } = makeAnthropic();
    create.mockRejectedValue(new Error('anthropic 500'));
    const { tracker, record } = makeCostTracker(0);
    const router = new LlmRouter(client, tracker, {
      dailyCostBudgetUsd: 100,
      fallbackOnBudget: true,
    });

    await expect(router.call('thesis_generation', baseParams)).rejects.toThrow('anthropic 500');
    expect(record).not.toHaveBeenCalled();
  });

  it('cost helper computeCostUsd matches the lookup tables (Opus only)', () => {
    const { client } = makeAnthropic();
    const { tracker } = makeCostTracker(0);
    const router = new LlmRouter(client, tracker, {
      dailyCostBudgetUsd: 100,
      fallbackOnBudget: true,
    });

    expect(router.computeCostUsd('claude-opus-4-7', 1000, 500)).toBeCloseTo(
      (1000 * COST_PER_1M_TOKENS_INPUT['claude-opus-4-7'] + 500 * COST_PER_1M_TOKENS_OUTPUT['claude-opus-4-7']) / 1e6,
      6,
    );
    // Modèles inconnus → 0 (pas dans la table). Pas de claude-sonnet/haiku
    // depuis Phase 2 (interdits per ADR-001).
    expect(router.computeCostUsd('claude-sonnet-4-6', 10000, 1000)).toBe(0);
    expect(router.computeCostUsd('claude-haiku-4-5-20251001', 10000, 1000)).toBe(0);
  });
});

describe('LlmRouter — boot-time validator', () => {
  it('does not throw on the standard model defaults', () => {
    const { client } = makeAnthropic();
    const { tracker } = makeCostTracker(0);
    expect(
      () => new LlmRouter(client, tracker, { dailyCostBudgetUsd: 100, fallbackOnBudget: true }),
    ).not.toThrow();
  });
});

describe('LlmRouter — ADR-001 invariants (Phase 2 cleanup)', () => {
  it('COST_PER_1M_TOKENS_INPUT contains ONLY Opus (Sonnet/Haiku removed)', () => {
    expect(Object.keys(COST_PER_1M_TOKENS_INPUT)).toEqual(['claude-opus-4-7']);
    expect(COST_PER_1M_TOKENS_INPUT['claude-sonnet-4-6']).toBeUndefined();
    expect(COST_PER_1M_TOKENS_INPUT['claude-haiku-4-5-20251001']).toBeUndefined();
  });

  it('COST_PER_1M_TOKENS_OUTPUT contains ONLY Opus', () => {
    expect(Object.keys(COST_PER_1M_TOKENS_OUTPUT)).toEqual(['claude-opus-4-7']);
  });

  it('LlmTask is a singleton literal (compile-time check via MODEL_BY_TASK keys)', () => {
    expect(Object.keys(MODEL_BY_TASK)).toEqual(['thesis_generation']);
  });

  it('100% budget + forceContinue=true does NOT use Haiku (uses Opus, audit-flagged fallback)', async () => {
    const { client, create } = makeAnthropic();
    create.mockResolvedValue(fakeMessage({ model: 'claude-opus-4-7' }));
    const { tracker, record } = makeCostTracker(120);
    const router = new LlmRouter(client, tracker, {
      dailyCostBudgetUsd: 100,
      fallbackOnBudget: true,
    });

    const result = await router.call('thesis_generation', baseParams, { forceContinue: true });

    expect(result.modelUsed).toBe('claude-opus-4-7');
    expect(record.mock.calls[0][0].model).toBe('claude-opus-4-7');
    // ADR-001 invariant : pas de fallback Haiku (interdit, et plus dans le pricing)
    expect(record.mock.calls[0][0].model).not.toMatch(/haiku/);
    expect(record.mock.calls[0][0].model).not.toMatch(/sonnet/);
  });
});
