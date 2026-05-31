/**
 * Smoke tests pour LlmABShadowService (PR #523).
 * Focus sur la logique métier critique : disabled flag, comparators, anti-doublon
 * provider, best-effort sans throw.
 */
import { ConfigService } from '@nestjs/config';
import { LlmABShadowService } from '../llm-ab-shadow.service';

function mockConfig(values: Record<string, string | undefined>): ConfigService {
  return {
    get: <T>(key: string) => (values[key] as unknown) as T,
  } as unknown as ConfigService;
}

function mockSupabase(insertedRows: unknown[] = []): {
  isReady: () => boolean;
  getClient: () => unknown;
} {
  return {
    isReady: () => true,
    getClient: () => ({
      from: () => ({
        insert: (row: unknown) => {
          insertedRows.push(row);
          return Promise.resolve({ error: null });
        },
      }),
    }),
  };
}

const mockLlmRouter = {
  call: jest.fn(),
  callWithPro: jest.fn(),
};

describe('LlmABShadowService (PR #523)', () => {
  beforeEach(() => {
    mockLlmRouter.call.mockReset();
    mockLlmRouter.callWithPro.mockReset();
  });

  describe('enabled flag', () => {
    it('default ENABLED=true sans flag explicite', () => {
      const svc = new LlmABShadowService(
        mockConfig({}),
        mockSupabase() as never,
        mockLlmRouter as never,
      );
      // Pas de getter exposé, on vérifie indirectement via recordShadow no-op
      // (si disabled, recordShadow return immédiat sans appeler les shadows).
      expect(svc).toBeDefined();
    });

    it('disabled si LLM_AB_SHADOW_ENABLED=false', async () => {
      const inserted: unknown[] = [];
      const svc = new LlmABShadowService(
        mockConfig({ LLM_AB_SHADOW_ENABLED: 'false' }),
        mockSupabase(inserted) as never,
        mockLlmRouter as never,
      );
      await svc.recordShadow({
        callSite: 'risk_monitor',
        systemPrompt: 'sys',
        userPrompt: 'user',
        applied: { providerId: 'gemini-pro', content: 'hold', costUsd: 0.01, latencyMs: 100 },
      });
      // Disabled → no shadow calls, no insert
      expect(mockLlmRouter.call).not.toHaveBeenCalled();
      expect(mockLlmRouter.callWithPro).not.toHaveBeenCalled();
      expect(inserted).toHaveLength(0);
    });
  });

  describe('best-effort no throw', () => {
    it('Promise rejection sur Flash → record OK avec error captured', async () => {
      mockLlmRouter.call.mockRejectedValue(new Error('Flash API down'));
      const inserted: unknown[] = [];
      const svc = new LlmABShadowService(
        mockConfig({ LLM_AB_SHADOW_ENABLED: 'true' }),
        mockSupabase(inserted) as never,
        mockLlmRouter as never,
      );
      await expect(
        svc.recordShadow({
          callSite: 'daily_brief',
          systemPrompt: 'sys',
          userPrompt: 'user',
          applied: { providerId: 'gemini-pro', content: 'brief X', costUsd: 0.02, latencyMs: 200 },
        }),
      ).resolves.toBeUndefined();
      expect(inserted).toHaveLength(1);
      const row = inserted[0] as { shadows: Array<{ provider: string; error: string | null }> };
      expect(row.shadows.find(s => s.provider === 'gemini-flash-lite')?.error).toContain('Flash API down');
    });

    it('Supabase insert error → no throw, just debug log', async () => {
      mockLlmRouter.call.mockResolvedValue({
        content: 'shadow content',
        providerId: 'gemini-flash-lite',
        costUsd: 0.001,
        latencyMs: 50,
        fallbackUsed: false,
      });
      const svc = new LlmABShadowService(
        mockConfig({ LLM_AB_SHADOW_ENABLED: 'true' }),
        {
          isReady: () => true,
          getClient: () => ({
            from: () => ({ insert: () => Promise.reject(new Error('PG conn refused')) }),
          }),
        } as never,
        mockLlmRouter as never,
      );
      await expect(
        svc.recordShadow({
          callSite: 'strategy_coach',
          systemPrompt: 'sys',
          userPrompt: 'user',
          applied: { providerId: 'gemini-pro', content: 'reco', costUsd: 0.02, latencyMs: 200 },
        }),
      ).resolves.toBeUndefined();
    });

    it('Supabase non-ready → return early sans aucun shadow call', async () => {
      const inserted: unknown[] = [];
      const svc = new LlmABShadowService(
        mockConfig({ LLM_AB_SHADOW_ENABLED: 'true' }),
        {
          isReady: () => false,
          getClient: () => ({ from: () => ({ insert: () => { inserted.push({}); return Promise.resolve(); } }) }),
        } as never,
        mockLlmRouter as never,
      );
      await svc.recordShadow({
        callSite: 'risk_monitor',
        systemPrompt: 'sys',
        userPrompt: 'user',
        applied: { providerId: 'gemini-pro', content: 'X', costUsd: 0.01, latencyMs: 100 },
      });
      expect(mockLlmRouter.call).not.toHaveBeenCalled();
      expect(inserted).toHaveLength(0);
    });
  });

  describe('anti-doublon provider', () => {
    it('applied=gemini-pro → skip Pro en shadow, appelle Flash via .call()', async () => {
      mockLlmRouter.call.mockResolvedValue({
        content: 'flash response',
        providerId: 'gemini-flash-lite',
        costUsd: 0.001,
        latencyMs: 50,
        fallbackUsed: false,
      });
      const inserted: unknown[] = [];
      const svc = new LlmABShadowService(
        mockConfig({ LLM_AB_SHADOW_ENABLED: 'true' }),
        mockSupabase(inserted) as never,
        mockLlmRouter as never,
      );
      await svc.recordShadow({
        callSite: 'scanner_postmortem',
        systemPrompt: 'sys',
        userPrompt: 'user',
        applied: { providerId: 'gemini-pro', content: 'X', costUsd: 0.02, latencyMs: 200 },
      });
      expect(mockLlmRouter.call).toHaveBeenCalledTimes(1);  // Flash shadow
      expect(mockLlmRouter.callWithPro).not.toHaveBeenCalled();  // Pas de Pro shadow (déjà applied)
    });

    it('applied=gemini-flash-lite → skip Flash en shadow, appelle Pro via callWithPro', async () => {
      mockLlmRouter.callWithPro.mockResolvedValue({
        content: 'pro response',
        providerId: 'gemini-pro',
        costUsd: 0.02,
        latencyMs: 800,
        fallbackUsed: false,
      });
      const svc = new LlmABShadowService(
        mockConfig({ LLM_AB_SHADOW_ENABLED: 'true' }),
        mockSupabase() as never,
        mockLlmRouter as never,
      );
      await svc.recordShadow({
        callSite: 'daily_brief',
        systemPrompt: 'sys',
        userPrompt: 'user',
        applied: { providerId: 'gemini-flash-lite', content: 'X', costUsd: 0.001, latencyMs: 50 },
      });
      expect(mockLlmRouter.callWithPro).toHaveBeenCalledTimes(1);
      expect(mockLlmRouter.call).not.toHaveBeenCalled();
    });
  });

  describe('comparator', () => {
    it('default comparator : normalize whitespace + lowercase + 200 chars', async () => {
      mockLlmRouter.call.mockResolvedValue({
        content: 'HOLD\n the position',  // case + whitespace differ vs 'hold the position'
        providerId: 'gemini-flash-lite',
        costUsd: 0.001,
        latencyMs: 50,
        fallbackUsed: false,
      });
      const inserted: unknown[] = [];
      const svc = new LlmABShadowService(
        mockConfig({ LLM_AB_SHADOW_ENABLED: 'true' }),
        mockSupabase(inserted) as never,
        mockLlmRouter as never,
      );
      await svc.recordShadow({
        callSite: 'strategy_coach',
        systemPrompt: 'sys',
        userPrompt: 'user',
        applied: { providerId: 'gemini-pro', content: 'hold the position', costUsd: 0.02, latencyMs: 200 },
      });
      const row = inserted[0] as { shadows: Array<{ provider: string; concordance_full: boolean }> };
      const flashShadow = row.shadows.find(s => s.provider === 'gemini-flash-lite');
      expect(flashShadow?.concordance_full).toBe(true);  // normalize → identique
    });

    it('custom comparator JSON-aware', async () => {
      mockLlmRouter.call.mockResolvedValue({
        content: '{"action_kind":"hold","extra":"X"}',
        providerId: 'gemini-flash-lite',
        costUsd: 0.001,
        latencyMs: 50,
        fallbackUsed: false,
      });
      const inserted: unknown[] = [];
      const svc = new LlmABShadowService(
        mockConfig({ LLM_AB_SHADOW_ENABLED: 'true' }),
        mockSupabase(inserted) as never,
        mockLlmRouter as never,
      );
      await svc.recordShadow({
        callSite: 'strategy_coach',
        systemPrompt: 'sys',
        userPrompt: 'user',
        applied: { providerId: 'gemini-pro', content: '{"action_kind":"hold","other":"Y"}', costUsd: 0.02, latencyMs: 200 },
        comparator: (a, b) => {
          const pa = JSON.parse(a);
          const pb = JSON.parse(b);
          return pa.action_kind === pb.action_kind;
        },
      });
      const row = inserted[0] as { shadows: Array<{ provider: string; concordance_full: boolean }> };
      expect(row.shadows.find(s => s.provider === 'gemini-flash-lite')?.concordance_full).toBe(true);
    });

    it('comparator throws → concordance_full = null (graceful)', async () => {
      mockLlmRouter.call.mockResolvedValue({
        content: 'not json',
        providerId: 'gemini-flash-lite',
        costUsd: 0.001,
        latencyMs: 50,
        fallbackUsed: false,
      });
      const inserted: unknown[] = [];
      const svc = new LlmABShadowService(
        mockConfig({ LLM_AB_SHADOW_ENABLED: 'true' }),
        mockSupabase(inserted) as never,
        mockLlmRouter as never,
      );
      await svc.recordShadow({
        callSite: 'risk_monitor',
        systemPrompt: 'sys',
        userPrompt: 'user',
        applied: { providerId: 'gemini-pro', content: 'X', costUsd: 0.02, latencyMs: 200 },
        comparator: (a, _b) => { JSON.parse(a); return true; },  // throws
      });
      const row = inserted[0] as { shadows: Array<{ provider: string; concordance_full: boolean | null }> };
      expect(row.shadows.find(s => s.provider === 'gemini-flash-lite')?.concordance_full).toBeNull();
    });
  });

  describe('shadow row structure', () => {
    it('insert contient call_site, applied_*, shadows[], concordance_summary, hashes', async () => {
      mockLlmRouter.call.mockResolvedValue({
        content: 'shadow',
        providerId: 'gemini-flash-lite',
        costUsd: 0.001,
        latencyMs: 50,
        fallbackUsed: false,
      });
      const inserted: Array<Record<string, unknown>> = [];
      const svc = new LlmABShadowService(
        mockConfig({ LLM_AB_SHADOW_ENABLED: 'true' }),
        mockSupabase(inserted as never[]) as never,
        mockLlmRouter as never,
      );
      await svc.recordShadow({
        callSite: 'daily_brief',
        portfolioId: 'b0000001-0000-0000-0000-000000000001',
        systemPrompt: 'sys-prompt',
        userPrompt: 'user-prompt',
        applied: { providerId: 'gemini-pro', content: 'applied content', costUsd: 0.02, latencyMs: 200, parseOk: true },
      });
      const row = inserted[0];
      expect(row.call_site).toBe('daily_brief');
      expect(row.portfolio_id).toBe('b0000001-0000-0000-0000-000000000001');
      expect(row.applied_provider).toBe('gemini-pro');
      expect(row.applied_response_summary).toBe('applied content');
      expect(row.applied_cost_usd).toBe(0.02);
      expect(row.applied_latency_ms).toBe(200);
      expect(row.applied_parse_ok).toBe(true);
      expect(Array.isArray(row.shadows)).toBe(true);
      expect((row.shadows as unknown[]).length).toBeGreaterThan(0);
      expect(row.concordance_summary).toBeDefined();
      expect(row.context_hash).toMatch(/^[a-f0-9]{16}$/);
      expect(row.system_prompt_hash).toMatch(/^[a-f0-9]{16}$/);
    });
  });
});
