/**
 * P19-staleness — paper-broker R5 sanity rejette les closes sur source
 * `stale_*` ou `fallback_*`.
 *
 * Smoking gun 25/05/2026 : 8 positions Asia fermées avec exit_price = entry_price
 * (TD `/quote` post-cloche retourne data.close = EOD close = même value pour
 * tous les appels jusqu'au lendemain). LisaService.tagStaleness rebaptise
 * désormais source en `stale_twelvedata` quand asOf > 180s ; paper-broker
 * doit refuser de fermer sur ce source.
 */

import { PaperBrokerService } from '../paper-broker.service';

function makeSupabaseMock(positionRow: Record<string, unknown>) {
  const chain = () => {
    const api = {
      select: () => api,
      single: async () => ({ data: positionRow, error: null }),
      eq: () => api,
      update: () => api,
      then: undefined,
    };
    (api as { [k: string]: unknown }).then = (resolve: (v: unknown) => void) => {
      resolve({ data: [], error: null });
    };
    return api;
  };
  return { from: () => chain() } as unknown as ConstructorParameters<typeof PaperBrokerService>[0]['supabase'];
}

const baseRow = {
  id: 'pos-stale',
  portfolio_id: 'pf-1',
  user_id: 'u-1',
  symbol: '002254.SHE',
  asset_class: 'asia_equity',
  venue: 'SHE',
  direction: 'long',
  quantity: '24.71',
  entry_price: '15.93',
  entry_notional_usd: '394.00',
  entry_timestamp: new Date(Date.now() - 10 * 60_000).toISOString(),
  estimated_entry_cost_usd: '0.40',
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

describe('PaperBrokerService.closePosition — P19-staleness R5 reject', () => {
  beforeEach(() => {
    process.env.R5_SANITY_ENABLED = 'true';
  });

  function makeBroker(row = baseRow) {
    return new PaperBrokerService({
      supabase: makeSupabaseMock(row),
      fetchLivePrice: async () => ({ price: '15.93', source: 'stale_twelvedata', age_ms: 0 }) as unknown as { price: string; source: 'stale_twelvedata'; age_ms: number },
    } as unknown as ConstructorParameters<typeof PaperBrokerService>[0]);
  }

  it('reject close avec source=stale_twelvedata (EOD close post-cloche)', async () => {
    const broker = makeBroker();
    await expect(
      broker.closePosition({
        positionId: 'pos-stale',
        reason: 'closed_invalidated',
        livePrice: '15.93',
        livePriceSource: 'stale_twelvedata',
        rationale: '[FORCE_CLOSE] test',
      }),
    ).rejects.toThrow(/R5_LIVE_PRICE_(STALE|FALLBACK)/);
  });

  it('reject close avec source=stale_eodhd', async () => {
    const broker = makeBroker();
    await expect(
      broker.closePosition({
        positionId: 'pos-stale',
        reason: 'closed_invalidated',
        livePrice: '15.93',
        livePriceSource: 'stale_eodhd',
        rationale: 'test',
      }),
    ).rejects.toThrow(/R5_LIVE_PRICE_(STALE|FALLBACK)/);
  });

  it('reject close avec source=fallback_unknown', async () => {
    const broker = makeBroker();
    await expect(
      broker.closePosition({
        positionId: 'pos-stale',
        reason: 'closed_invalidated',
        livePrice: '15.93',
        livePriceSource: 'fallback_unknown',
        rationale: 'test',
      }),
    ).rejects.toThrow(/R5_LIVE_PRICE_(STALE|FALLBACK)/);
  });

  it('accepte close avec source=twelvedata (frais, non-stale)', async () => {
    // Source non-stale doit passer R5 mais peut throw plus loin (e.g.
    // mock supabase update qui retourne []). Le test vérifie SEULEMENT
    // que R5 ne rejette PAS sur le source check — pas le path complet.
    const broker = makeBroker();
    try {
      await broker.closePosition({
        positionId: 'pos-stale',
        reason: 'closed_invalidated',
        livePrice: '16.50',  // exit > entry, sanity ratio OK
        livePriceSource: 'twelvedata',
        rationale: 'test',
      });
    } catch (e) {
      // Ne doit PAS être un R5_LIVE_PRICE_(STALE|FALLBACK)
      expect(String(e)).not.toMatch(/R5_LIVE_PRICE_(STALE|FALLBACK)/);
    }
  });

  it('back-compat : closePosition sans livePriceSource ne déclenche pas le check', async () => {
    const broker = makeBroker();
    try {
      await broker.closePosition({
        positionId: 'pos-stale',
        reason: 'closed_invalidated',
        livePrice: '16.50',
        rationale: 'test legacy caller without source',
      });
    } catch (e) {
      // Ne doit PAS être un R5_LIVE_PRICE_(STALE|FALLBACK)
      expect(String(e)).not.toMatch(/R5_LIVE_PRICE_(STALE|FALLBACK)/);
    }
  });
});

/**
 * P19-staleness-OPEN (25/05) — fix(open) bd266478 :
 * openPositionDirect doit rejeter les opens sur source stale ou fallback.
 * Symétrique du check close R5 ci-dessus. Sans ce guard, le scanner ouvrait
 * NANO.PA paire LONG/SHORT au prix figé vendredi (age=282381s = 3.27j).
 */
describe('PaperBrokerService.openPositionDirect — P19-staleness-OPEN reject', () => {
  function makeBroker() {
    return new PaperBrokerService({
      supabase: makeSupabaseMock({ id: 'new-pos' }),
      fetchLivePrice: async () => ({ price: '36.46', source: 'twelvedata' }) as unknown as { price: string; source: string },
    } as unknown as ConstructorParameters<typeof PaperBrokerService>[0]);
  }

  const baseOpenCmd = {
    portfolioId: '58439d86-3f20-4a60-82a4-307f3f252bc2',
    symbol: 'NANO.PA',
    assetClass: 'eu_equity',
    direction: 'long' as const,
    venue: 'PA',
    capitalAllocationUsd: '394.00',
    livePrice: '36.46',
    stopLossPrice: '35.81',
    takeProfitPrice: '37.65',
    horizonDays: 1,
    source: 'scanner_top_gainers',
  };

  it('reject open avec livePriceSource=stale_twelvedata (incident 25/05 NANO.PA)', async () => {
    const broker = makeBroker();
    await expect(
      broker.openPositionDirect({ ...baseOpenCmd, livePriceSource: 'stale_twelvedata' }),
    ).rejects.toThrow(/stale\/fallback/);
  });

  it('reject open avec livePriceSource=stale_eodhd', async () => {
    const broker = makeBroker();
    await expect(
      broker.openPositionDirect({ ...baseOpenCmd, livePriceSource: 'stale_eodhd' }),
    ).rejects.toThrow(/stale\/fallback/);
  });

  it('reject open avec livePriceSource=fallback_unknown', async () => {
    const broker = makeBroker();
    await expect(
      broker.openPositionDirect({ ...baseOpenCmd, livePriceSource: 'fallback_unknown' }),
    ).rejects.toThrow(/stale\/fallback/);
  });

  it('reject open avec livePriceSource=fallback_quota_cap', async () => {
    const broker = makeBroker();
    await expect(
      broker.openPositionDirect({ ...baseOpenCmd, livePriceSource: 'fallback_quota_cap' }),
    ).rejects.toThrow(/stale\/fallback/);
  });

  it('back-compat : open SANS livePriceSource ne déclenche pas le guard (legacy callers)', async () => {
    const broker = makeBroker();
    // Note : peut échouer ailleurs (mock supabase incomplet), mais PAS sur le guard.
    try {
      await broker.openPositionDirect(baseOpenCmd);
    } catch (e) {
      expect(String(e)).not.toMatch(/stale\/fallback/);
    }
  });
});
