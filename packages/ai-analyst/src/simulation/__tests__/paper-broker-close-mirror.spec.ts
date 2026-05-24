/**
 * Tests du mirror update sur paper_trades lors de closePosition.
 *
 * Le mirror est best-effort : il UPDATE paper_trades WHERE scanner_position_id
 * pour qu'P9 ML refit puisse fitter. Si l'UPDATE échoue, le close lisa_positions
 * doit rester effective (try/catch isolé). Aucune régression possible sur le
 * trade réel.
 */

import { PaperBrokerService } from '../paper-broker.service';

interface MockUpdateCall {
  table: string;
  payload: Record<string, unknown>;
  filters: Array<{ field: string; value: unknown }>;
}

function makeSupabaseMock(opts: {
  positionRow: Record<string, unknown>;
  positionUpdateOk: boolean;
  paperTradesUpdateThrows?: boolean;
  paperTradesUpdateError?: { message: string };
}) {
  const updateCalls: MockUpdateCall[] = [];

  const chain = (table: string) => {
    const filters: Array<{ field: string; value: unknown }> = [];
    let updatePayload: Record<string, unknown> = {};
    const api = {
      select: () => api,
      single: async () => ({ data: opts.positionRow, error: null }),
      update: (payload: Record<string, unknown>) => {
        updatePayload = payload;
        return api;
      },
      eq: (field: string, value: unknown) => {
        filters.push({ field, value });
        return api;
      },
      then: undefined,
    };

    // Make the chain awaitable as the final query
    (api as { [k: string]: unknown }).then = (resolve: (v: unknown) => void) => {
      updateCalls.push({ table, payload: updatePayload, filters });
      if (table === 'lisa_positions') {
        resolve({
          data: opts.positionUpdateOk
            ? [{ ...opts.positionRow, status: updatePayload.status }]
            : [],
          error: null,
        });
      } else if (table === 'paper_trades') {
        if (opts.paperTradesUpdateThrows) throw new Error('mock paper_trades throw');
        resolve({ error: opts.paperTradesUpdateError ?? null });
      }
    };

    return api;
  };

  return {
    from: (table: string) => chain(table),
    _updateCalls: updateCalls,
  } as unknown as ConstructorParameters<typeof PaperBrokerService>[0]['supabase'] & {
    _updateCalls: MockUpdateCall[];
  };
}

describe('PaperBrokerService.closePosition — paper_trades mirror', () => {
  const baseRow = {
    id: 'pos-123',
    portfolio_id: 'pf-1',
    user_id: 'u-1',
    symbol: 'AAPL.US',
    asset_class: 'us_equity_large',
    venue: 'NYSE',
    direction: 'long',
    quantity: '10',
    entry_price: '100.00',
    entry_notional_usd: '1000.00',
    entry_timestamp: '2026-05-23T10:00:00.000Z',
    estimated_entry_cost_usd: '1.00',
    status: 'open',
    venue_fee_detail: null,
    horizon_target_date: null,
    themes: null,
    stop_loss_price: null,
    take_profit_price: null,
    proposal_id: null,
    thesis_id: null,
    autonomy_rules: null,
    fees_in_usd: '0',
    actual_entry_fees_usd: null,
    actual_entry_slippage_bps: null,
    broker_connection_id: null,
    broker_order_id_entry: null,
    source: 'scanner',
    conviction_score: null,
    peak_pre_exit: null,
    post_sl_path: null,
  };

  it('au close, UPDATE est tenté sur paper_trades avec scanner_position_id', async () => {
    const sb = makeSupabaseMock({ positionRow: baseRow, positionUpdateOk: true });
    const broker = new PaperBrokerService({
      supabase: sb,
      fetchLivePrice: async () => ({ price: '100', source: 'test' as const, age_ms: 0 }) as unknown as { price: string; source: 'test'; age_ms: number },
    } as unknown as ConstructorParameters<typeof PaperBrokerService>[0]);

    await broker.closePosition({
      positionId: 'pos-123',
      reason: 'closed_target',
      rationale: 'TP hit',
      livePrice: "103",
    });

    const ptCall = sb._updateCalls.find((c) => c.table === 'paper_trades');
    expect(ptCall).toBeDefined();
    expect(ptCall!.payload.status).toBe('closed'); // paper_trades CHECK : 'open'/'closed'/'cancelled'
    expect(ptCall!.payload.outcome_label).toBe(1); // SMALLINT : 1 = win
    expect(ptCall!.payload.hold_duration_seconds).toBeGreaterThan(0);
    expect(ptCall!.filters).toEqual(
      expect.arrayContaining([
        { field: 'scanner_position_id', value: 'pos-123' },
        { field: 'status', value: 'open' },
      ]),
    );
  });

  it('outcome_label=0 quand pnl_pct < 0', async () => {
    const sb = makeSupabaseMock({ positionRow: baseRow, positionUpdateOk: true });
    const broker = new PaperBrokerService({
      supabase: sb,
      fetchLivePrice: async () => ({ price: '100', source: 'test' as const, age_ms: 0 }) as unknown as { price: string; source: 'test'; age_ms: number },
    } as unknown as ConstructorParameters<typeof PaperBrokerService>[0]);

    await broker.closePosition({
      positionId: 'pos-123',
      reason: 'closed_stop',
      rationale: 'SL hit',
      livePrice: "95",
    });

    const ptCall = sb._updateCalls.find((c) => c.table === 'paper_trades');
    expect(ptCall!.payload.outcome_label).toBe(0); // SMALLINT : 0 = loss
  });

  it('mirror échoue → close lisa_positions reste effective (no throw)', async () => {
    const sb = makeSupabaseMock({
      positionRow: baseRow,
      positionUpdateOk: true,
      paperTradesUpdateError: { message: 'simulated DB error' },
    });
    const broker = new PaperBrokerService({
      supabase: sb,
      fetchLivePrice: async () => ({ price: '100', source: 'test' as const, age_ms: 0 }) as unknown as { price: string; source: 'test'; age_ms: number },
    } as unknown as ConstructorParameters<typeof PaperBrokerService>[0]);

    // Ne doit pas throw — le close lisa_positions est déjà effective
    await expect(
      broker.closePosition({
        positionId: 'pos-123',
        reason: 'closed_invalidated',
        rationale: 'news shock',
        livePrice: "100",
      }),
    ).resolves.toBeDefined();

    // Vérifie que les 2 UPDATEs ont été tentés (lisa_positions OK + paper_trades fail-silent)
    const lpCall = sb._updateCalls.find((c) => c.table === 'lisa_positions');
    expect(lpCall).toBeDefined();
    expect(lpCall!.payload.status).toBe('closed_invalidated');
  });

  it('mirror jette une exception → close lisa_positions reste effective (catché)', async () => {
    const sb = makeSupabaseMock({
      positionRow: baseRow,
      positionUpdateOk: true,
      paperTradesUpdateThrows: true,
    });
    const broker = new PaperBrokerService({
      supabase: sb,
      fetchLivePrice: async () => ({ price: '100', source: 'test' as const, age_ms: 0 }) as unknown as { price: string; source: 'test'; age_ms: number },
    } as unknown as ConstructorParameters<typeof PaperBrokerService>[0]);

    await expect(
      broker.closePosition({
        positionId: 'pos-123',
        reason: 'closed_stop',
        rationale: 'SL',
        livePrice: "95",
      }),
    ).resolves.toBeDefined();
  });

  it("race detected (0 rows updated sur lisa_positions) → pas de tentative miroir", async () => {
    const sb = makeSupabaseMock({ positionRow: baseRow, positionUpdateOk: false });
    const broker = new PaperBrokerService({
      supabase: sb,
      fetchLivePrice: async () => ({ price: '100', source: 'test' as const, age_ms: 0 }) as unknown as { price: string; source: 'test'; age_ms: number },
    } as unknown as ConstructorParameters<typeof PaperBrokerService>[0]);

    await broker.closePosition({
      positionId: 'pos-123',
      reason: 'closed_target',
      rationale: 'TP',
      livePrice: "103",
    });

    // Race detected → return position d'avant, sans tenter le miroir
    const ptCall = sb._updateCalls.find((c) => c.table === 'paper_trades');
    expect(ptCall).toBeUndefined();
  });

  describe('R5 sanity inline (issue #409)', () => {
    it('exit_price=0 → throw R5_EXIT_PRICE_ZERO, position kept open', async () => {
      // Reproduit le bug SEE.LSE : entry=5.02 → exit=0 → pnl_pct ≈ -100%
      const sb = makeSupabaseMock({
        positionRow: { ...baseRow, entry_price: '5.02', entry_notional_usd: '1574' },
        positionUpdateOk: true,
      });
      const broker = new PaperBrokerService({
        supabase: sb,
        fetchLivePrice: async () => ({ price: '5.02', source: 'test' as const, age_ms: 0 }) as unknown as { price: string; source: 'test'; age_ms: number },
      } as unknown as ConstructorParameters<typeof PaperBrokerService>[0]);

      await expect(
        broker.closePosition({
          positionId: 'pos-see-lse',
          reason: 'closed_stop',
          rationale: 'Stop-loss 4.89 triggered at live price 0.0000',
          livePrice: '0',
        }),
      ).rejects.toThrow(/R5_EXIT_PRICE_ZERO|Invalid live price/);

      // Vérif que l'UPDATE lisa_positions n'a JAMAIS été appelé
      const lpCall = sb._updateCalls.find((c) => c.table === 'lisa_positions');
      expect(lpCall).toBeUndefined();
    });

    it('exit_price < entry × 0.5 → throw R5_EXIT_BELOW_RATIO', async () => {
      const sb = makeSupabaseMock({
        positionRow: { ...baseRow, entry_price: '100.00' },
        positionUpdateOk: true,
      });
      const broker = new PaperBrokerService({
        supabase: sb,
        fetchLivePrice: async () => ({ price: '100', source: 'test' as const, age_ms: 0 }) as unknown as { price: string; source: 'test'; age_ms: number },
      } as unknown as ConstructorParameters<typeof PaperBrokerService>[0]);

      // exit=40 → ratio 0.4 < 0.5 → block
      await expect(
        broker.closePosition({
          positionId: 'pos-ratio',
          reason: 'closed_stop',
          rationale: 'fake price corruption',
          livePrice: '40',
        }),
      ).rejects.toThrow(/R5_EXIT_BELOW_RATIO/);

      const lpCall = sb._updateCalls.find((c) => c.table === 'lisa_positions');
      expect(lpCall).toBeUndefined();
    });

    it('R5_SANITY_ENABLED=false → bypass complet (back-compat opt-out, le bug peut récidiver)', async () => {
      // Quand R5 est OFF, le close s'exécute MÊME avec exit_price=0. Ce test
      // prouve que R5 EST l'unique protection (le check `Invalid live price`
      // n'existe que dans openPosition, pas closePosition).
      const sb = makeSupabaseMock({
        positionRow: { ...baseRow, entry_price: '5.02' },
        positionUpdateOk: true,
      });
      const broker = new PaperBrokerService({
        supabase: sb,
        fetchLivePrice: async () => ({ price: '5.02', source: 'test' as const, age_ms: 0 }) as unknown as { price: string; source: 'test'; age_ms: number },
      } as unknown as ConstructorParameters<typeof PaperBrokerService>[0]);

      const orig = process.env.R5_SANITY_ENABLED;
      process.env.R5_SANITY_ENABLED = 'false';
      try {
        // Avec R5 OFF, le close avec exit=0 PASSE (bug récidive).
        const result = await broker.closePosition({
          positionId: 'pos-disabled',
          reason: 'closed_stop',
          rationale: 'test bypass',
          livePrice: '0',
        });
        expect(result.exitPrice).toBe('0.0000000000');
        // UPDATE lisa_positions s'est produit (le bug aurait corrompu la DB)
        const lpCall = sb._updateCalls.find((c) => c.table === 'lisa_positions');
        expect(lpCall).toBeDefined();
      } finally {
        if (orig === undefined) delete process.env.R5_SANITY_ENABLED;
        else process.env.R5_SANITY_ENABLED = orig;
      }
    });

    it('close normal (exit cohérent) → passe R5 et complète', async () => {
      const sb = makeSupabaseMock({
        positionRow: { ...baseRow, entry_price: '100.00' },
        positionUpdateOk: true,
      });
      const broker = new PaperBrokerService({
        supabase: sb,
        fetchLivePrice: async () => ({ price: '102', source: 'test' as const, age_ms: 0 }) as unknown as { price: string; source: 'test'; age_ms: number },
      } as unknown as ConstructorParameters<typeof PaperBrokerService>[0]);

      // exit=102 > entry*0.5=50 OK, pnl_pct ≈ +2 % OK → close se produit
      await broker.closePosition({
        positionId: 'pos-ok',
        reason: 'closed_target',
        rationale: 'TP hit',
        livePrice: '102',
      });

      const lpCall = sb._updateCalls.find((c) => c.table === 'lisa_positions');
      expect(lpCall).toBeDefined();
      expect(lpCall!.payload.status).toBe('closed_target');
    });
  });
});
