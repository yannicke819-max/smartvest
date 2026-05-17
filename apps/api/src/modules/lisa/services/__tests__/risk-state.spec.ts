import { ConfigService } from '@nestjs/config';
import { RiskStateService } from '../risk-state.service';
import type { SupabaseService } from '../../../supabase/supabase.service';

interface Stub {
  cbRow?: Record<string, unknown> | null;
  cbError?: { message: string } | null;
  recentRows?: Array<Record<string, unknown>> | null;
  count24h?: number | null;
}

function makeSupabase(stub: Stub): SupabaseService {
  return {
    isReady: () => true,
    getClient: () => ({
      from: (table: string) => {
        if (table === 'lisa_circuit_breaker_state') {
          return {
            select: () => ({
              eq: () => ({
                order: () => ({
                  limit: () => ({
                    maybeSingle: () =>
                      Promise.resolve({ data: stub.cbRow ?? null, error: stub.cbError ?? null }),
                  }),
                }),
              }),
            }),
          };
        }
        // lisa_sanity_rejections : 2 modes (recent + count head)
        return {
          select: (_cols: string, opts?: { count?: string; head?: boolean }) => {
            if (opts?.head) {
              return {
                gte: () => Promise.resolve({ count: stub.count24h ?? 0, error: null }),
              };
            }
            return {
              order: () => ({
                limit: () => Promise.resolve({ data: stub.recentRows ?? [], error: null }),
              }),
            };
          },
        };
      },
    }),
  } as unknown as SupabaseService;
}

function makeConfig(env: Record<string, string>): ConfigService {
  return { get: (k: string) => env[k] } as unknown as ConfigService;
}

const PF = '58439d86-3f20-4a60-82a4-307f3f252bc2';

describe('RiskStateService', () => {
  it('is_tripped=false si aucune ligne circuit_breaker', async () => {
    const svc = new RiskStateService(makeSupabase({ cbRow: null }), makeConfig({}));
    const r = await svc.portfolioRiskState(PF);
    expect(r.circuit_breaker.is_tripped).toBe(false);
    expect(r.circuit_breaker.triggered_at).toBeNull();
  });

  it('is_tripped=true si dernière ligne a resolved_at=null', async () => {
    const svc = new RiskStateService(
      makeSupabase({
        cbRow: {
          id: 'cb-1',
          triggered_at: '2026-05-17T10:00:00Z',
          reason: 'daily_drawdown_400',
          pnl_at_trigger: -425,
          positions_open_at_trigger: 3,
          resolved_at: null,
          notes: null,
        },
      }),
      makeConfig({}),
    );
    const r = await svc.portfolioRiskState(PF);
    expect(r.circuit_breaker.is_tripped).toBe(true);
    expect(r.circuit_breaker.pnl_at_trigger).toBe(-425);
  });

  it('is_tripped=false si dernière ligne a resolved_at non-null', async () => {
    const svc = new RiskStateService(
      makeSupabase({
        cbRow: {
          id: 'cb-1',
          triggered_at: '2026-05-16T10:00:00Z',
          reason: 'daily_drawdown_400',
          resolved_at: '2026-05-16T22:00:00Z',
        },
      }),
      makeConfig({}),
    );
    const r = await svc.portfolioRiskState(PF);
    expect(r.circuit_breaker.is_tripped).toBe(false);
  });

  it('feature_flags reflète QUICK_WINS_PIPELINE_ENABLED', async () => {
    const svcOn = new RiskStateService(
      makeSupabase({}),
      makeConfig({ QUICK_WINS_PIPELINE_ENABLED: 'true' }),
    );
    const rOn = await svcOn.portfolioRiskState(PF);
    expect(rOn.feature_flags.quick_wins_pipeline_enabled).toBe(true);

    const svcOff = new RiskStateService(makeSupabase({}), makeConfig({}));
    const rOff = await svcOff.portfolioRiskState(PF);
    expect(rOff.feature_flags.quick_wins_pipeline_enabled).toBe(false);
  });

  it('feature_flags : gainers_nse_blacklist_enabled true par défaut, false seulement si explicit', async () => {
    const def = new RiskStateService(makeSupabase({}), makeConfig({}));
    expect((await def.portfolioRiskState(PF)).feature_flags.gainers_nse_blacklist_enabled).toBe(true);

    const off = new RiskStateService(
      makeSupabase({}),
      makeConfig({ GAINERS_NSE_BLACKLIST_ENABLED: 'false' }),
    );
    expect((await off.portfolioRiskState(PF)).feature_flags.gainers_nse_blacklist_enabled).toBe(false);
  });

  it('count_24h reflète le count Supabase', async () => {
    const svc = new RiskStateService(makeSupabase({ count24h: 3 }), makeConfig({}));
    const r = await svc.portfolioRiskState(PF);
    expect(r.sanity_rejections.count_24h).toBe(3);
  });
});
