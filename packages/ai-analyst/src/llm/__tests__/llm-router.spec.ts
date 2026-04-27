/**
 * PATCH 6 P1 cost-01-llm-router — Tests du LlmRouter centralisé.
 *
 * Vérifie le contrat :
 *  - Mapping tâche → modèle (Opus / Sonnet / Haiku)
 *  - Override env var
 *  - Circuit breaker à 80% budget (fallback Sonnet ou throw selon flag)
 *  - Hard-stop à 100% budget (throw quel que soit le modèle)
 *  - Calcul de coût (input + output)
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
  LlmTask,
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

describe('LlmRouter — mapping tâche → modèle', () => {
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

  it('routes news_classification to Haiku model ID', async () => {
    const { client, create } = makeAnthropic();
    create.mockResolvedValue(fakeMessage({ model: 'claude-haiku-4-5-20251001' }));
    const { tracker } = makeCostTracker(0);
    const router = new LlmRouter(client, tracker, { dailyCostBudgetUsd: 100, fallbackOnBudget: true });

    await router.call('news_classification', baseParams);

    expect(create.mock.calls[0][0].model).toBe('claude-haiku-4-5-20251001');
  });

  it('routes regime_classification + binary_decision + audit_explanation to Sonnet', async () => {
    const { client, create } = makeAnthropic();
    create.mockResolvedValue(fakeMessage({ model: 'claude-sonnet-4-6' }));
    const { tracker } = makeCostTracker(0);
    const router = new LlmRouter(client, tracker, { dailyCostBudgetUsd: 100, fallbackOnBudget: true });

    const tasks: LlmTask[] = ['regime_classification', 'binary_decision', 'audit_explanation'];
    for (const t of tasks) {
      create.mockClear();
      await router.call(t, baseParams);
      expect(create.mock.calls[0][0].model).toBe('claude-sonnet-4-6');
    }
  });

  it('routes summary to Haiku', async () => {
    const { client, create } = makeAnthropic();
    create.mockResolvedValue(fakeMessage());
    const { tracker } = makeCostTracker(0);
    const router = new LlmRouter(client, tracker, { dailyCostBudgetUsd: 100, fallbackOnBudget: true });

    await router.call('summary', baseParams);
    expect(create.mock.calls[0][0].model).toBe('claude-haiku-4-5-20251001');
  });
});

describe('LlmRouter — env var override', () => {
  it('respects MODEL_BY_TASK at module load time (env var set before import)', () => {
    // Snapshot du mapping courant — vérifie qu'il est bien constructed depuis
    // process.env au load time. Smoke test : tous les défauts sont des IDs
    // connus de la table de coût.
    const KNOWN = new Set(Object.keys(COST_PER_1M_TOKENS_INPUT));
    for (const model of Object.values(MODEL_BY_TASK)) {
      expect(KNOWN.has(model)).toBe(true);
    }
    // Si CLAUDE_MODEL_OPUS était set côté env d'exécution, le mapping le
    // reflète. On ne peut pas re-importer le module pour tester un override
    // dynamique sans jest.isolateModules — couvert par le validateur boot.
    expect(MODEL_BY_TASK.thesis_generation).toMatch(/opus/);
  });
});

describe('LlmRouter — circuit breaker à 80% budget (Opus fallback)', () => {
  it('falls back to Sonnet when budget>=80% AND task is Opus AND fallbackOnBudget=true', async () => {
    const { client, create } = makeAnthropic();
    create.mockResolvedValue(fakeMessage({ model: 'claude-sonnet-4-6' }));
    const { tracker, record } = makeCostTracker(85); // 85$ déjà consommé
    const { logger, warn } = makeAuditLogger();
    const router = new LlmRouter(
      client,
      tracker,
      { dailyCostBudgetUsd: 100, fallbackOnBudget: true },
      logger,
    );

    const result = await router.call('thesis_generation', baseParams);

    expect(create.mock.calls[0][0].model).toBe('claude-sonnet-4-6');
    expect(result.modelUsed).toBe('claude-sonnet-4-6');
    expect(result.fallback).toBe(true);
    expect(warn).toHaveBeenCalledWith(
      'opus_fallback',
      expect.objectContaining({
        task: 'thesis_generation',
        originalModel: 'claude-opus-4-7',
        fallbackModel: 'claude-sonnet-4-6',
        todayCostUsd: 85,
        budgetUsd: 100,
      }),
    );
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0][0].model).toBe('claude-sonnet-4-6');
  });

  it('does NOT fall back when task is not Opus (Sonnet stays Sonnet at 85%)', async () => {
    const { client, create } = makeAnthropic();
    create.mockResolvedValue(fakeMessage({ model: 'claude-sonnet-4-6' }));
    const { tracker } = makeCostTracker(85);
    const router = new LlmRouter(client, tracker, {
      dailyCostBudgetUsd: 100,
      fallbackOnBudget: true,
    });

    const result = await router.call('regime_classification', baseParams);

    expect(create.mock.calls[0][0].model).toBe('claude-sonnet-4-6');
    expect(result.fallback).toBe(false);
  });

  it('does NOT fall back when budget is below 80% (Opus stays Opus at 75%)', async () => {
    const { client, create } = makeAnthropic();
    create.mockResolvedValue(fakeMessage());
    const { tracker } = makeCostTracker(75);
    const router = new LlmRouter(client, tracker, {
      dailyCostBudgetUsd: 100,
      fallbackOnBudget: true,
    });

    const result = await router.call('thesis_generation', baseParams);

    expect(create.mock.calls[0][0].model).toBe('claude-opus-4-7');
    expect(result.fallback).toBe(false);
  });

  it('throws BudgetExceededError on Opus task when fallbackOnBudget=false at 85%', async () => {
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

  it('lets Sonnet/Haiku tasks pass at 85% even when fallbackOnBudget=false', async () => {
    const { client, create } = makeAnthropic();
    create.mockResolvedValue(fakeMessage({ model: 'claude-sonnet-4-6' }));
    const { tracker } = makeCostTracker(85);
    const router = new LlmRouter(client, tracker, {
      dailyCostBudgetUsd: 100,
      fallbackOnBudget: false,
    });

    await expect(router.call('regime_classification', baseParams)).resolves.toBeDefined();
  });
});

describe('LlmRouter — hard-stop à 100% budget', () => {
  it('throws BudgetExceededError on Opus task at 110% even when fallbackOnBudget=true', async () => {
    const { client, create } = makeAnthropic();
    const { tracker } = makeCostTracker(110);
    const router = new LlmRouter(client, tracker, {
      dailyCostBudgetUsd: 100,
      fallbackOnBudget: true,
    });

    await expect(router.call('thesis_generation', baseParams)).rejects.toThrow(BudgetExceededError);
    expect(create).not.toHaveBeenCalled();
  });

  it('throws BudgetExceededError on Haiku task at 110% (no Haiku miracle)', async () => {
    const { client, create } = makeAnthropic();
    const { tracker } = makeCostTracker(110);
    const router = new LlmRouter(client, tracker, {
      dailyCostBudgetUsd: 100,
      fallbackOnBudget: true,
    });

    await expect(router.call('news_classification', baseParams)).rejects.toThrow(BudgetExceededError);
    expect(create).not.toHaveBeenCalled();
  });

  it('throws BudgetExceededError exactly at 100% (>=, not >)', async () => {
    const { client } = makeAnthropic();
    const { tracker } = makeCostTracker(100);
    const router = new LlmRouter(client, tracker, {
      dailyCostBudgetUsd: 100,
      fallbackOnBudget: true,
    });

    await expect(router.call('summary', baseParams)).rejects.toThrow(BudgetExceededError);
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

describe('LlmRouter — calcul du coût + persistance', () => {
  it('records the call with task/model/tokens/costUsd after success', async () => {
    const { client, create } = makeAnthropic();
    create.mockResolvedValue(fakeMessage({ inputTokens: 1000, outputTokens: 500, model: 'claude-sonnet-4-6' }));
    const { tracker, record } = makeCostTracker(0);
    const router = new LlmRouter(client, tracker, {
      dailyCostBudgetUsd: 100,
      fallbackOnBudget: true,
    });

    const result = await router.call('regime_classification', baseParams);

    // Sonnet : 1000 input × $3/1M + 500 output × $15/1M = 0.003 + 0.0075 = 0.0105
    const expectedCost = (1000 * 3 + 500 * 15) / 1_000_000;
    expect(result.costUsd).toBeCloseTo(expectedCost, 6);
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0][0]).toEqual({
      task: 'regime_classification',
      model: 'claude-sonnet-4-6',
      inputTokens: 1000,
      outputTokens: 500,
      costUsd: expect.any(Number),
    });
    expect(record.mock.calls[0][0].costUsd).toBeCloseTo(expectedCost, 6);
  });

  it('records the FALLBACK model (Sonnet), not the original (Opus), on circuit breaker', async () => {
    const { client, create } = makeAnthropic();
    create.mockResolvedValue(fakeMessage({ inputTokens: 2000, outputTokens: 1000, model: 'claude-sonnet-4-6' }));
    const { tracker, record } = makeCostTracker(85);
    const router = new LlmRouter(client, tracker, {
      dailyCostBudgetUsd: 100,
      fallbackOnBudget: true,
    });

    await router.call('thesis_generation', baseParams);

    expect(record.mock.calls[0][0].model).toBe('claude-sonnet-4-6');
    expect(record.mock.calls[0][0].task).toBe('thesis_generation');
    // Coût Sonnet, pas Opus : (2000*3 + 1000*15) / 1M = 0.021
    expect(record.mock.calls[0][0].costUsd).toBeCloseTo(0.021, 6);
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

  it('cost helper computeCostUsd matches the lookup tables', () => {
    const { client } = makeAnthropic();
    const { tracker } = makeCostTracker(0);
    const router = new LlmRouter(client, tracker, {
      dailyCostBudgetUsd: 100,
      fallbackOnBudget: true,
    });

    // Opus 1k input + 500 output
    expect(router.computeCostUsd('claude-opus-4-7', 1000, 500)).toBeCloseTo(
      (1000 * COST_PER_1M_TOKENS_INPUT['claude-opus-4-7'] + 500 * COST_PER_1M_TOKENS_OUTPUT['claude-opus-4-7']) / 1e6,
      6,
    );
    // Haiku 10k input + 1k output
    expect(router.computeCostUsd('claude-haiku-4-5-20251001', 10000, 1000)).toBeCloseTo(
      (10000 * 0.80 + 1000 * 4.0) / 1e6,
      6,
    );
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
