import type {
  BrokerCredentials, BrokerCapabilities, BrokerProvider,
  SyncedPosition, SyncedCashBalance, SyncedTransaction,
} from '@smartvest/domain';
import { PROVIDER_CAPABILITIES } from '@smartvest/domain';
import {
  IBrokerAdapter, NotSupportedError, AdapterStubError,
  PlaceOrderDraft, PlaceOrderResult, TestConnectionResult,
  CancelOrderResult, BrokerOrderState, BrokerFill, BrokerAccountBalance,
} from './broker-adapter.interface';
import { IbkrClient } from './ibkr/ibkr-client';
import { IbkrSymbolMapper } from './ibkr/ibkr-symbol-mapper';
import { mapIbkrStatusToBrokerStatus } from './ibkr/ibkr-types';

/**
 * InteractiveBrokersAdapter — Phase B.1 (live REST methods wired).
 *
 * Auth flow attendu :
 *   1. L'utilisateur démarre localement le Client Portal Gateway IBKR
 *      (binaire Java IBKR sur https://localhost:5000) OU utilise le
 *      service cloud Client Portal Web API.
 *   2. Login via browser OAuth → session token.
 *   3. Token + accountId stockés dans Vault Supabase, jamais en clair.
 *   4. Cet adapter consomme ces credentials via connect().
 *
 * Phase B.1 implémente :
 *   - placeOrder()       → POST /iserver/account/{id}/orders (mapping draft → IBKR)
 *   - cancelOrder()      → DELETE /iserver/account/{id}/order/{orderId}
 *   - getOrderStatus()   → GET /iserver/account/order/status/{orderId}
 *   - getAccountBalance()→ GET /portfolio/{id}/summary (multi-currency)
 *
 * Encore stub (Phase B.2-B.3) :
 *   - fetchPositions/fetchCash/fetchTransactions → throw AdapterStubError
 *   - getFills() → throw NotSupportedError (besoin executions endpoint)
 *
 * Garde-fou : placeOrder respecte BROKER_EXECUTION_ENABLED via le
 * constructor flag (pattern identique à BinanceAdapter).
 */
export class InteractiveBrokersAdapter implements IBrokerAdapter {
  readonly provider: BrokerProvider = 'INTERACTIVE_BROKERS';
  readonly capabilities: BrokerCapabilities = PROVIDER_CAPABILITIES.INTERACTIVE_BROKERS;

  private client: IbkrClient | null = null;
  private mapper: IbkrSymbolMapper | null = null;

  constructor(
    private readonly executionEnabled: boolean,
    private readonly clientFactory?: (cfg: { sessionToken: string; accountId: string }) => IbkrClient,
  ) {}

  async connect(creds: BrokerCredentials): Promise<void> {
    if (creds.provider !== 'INTERACTIVE_BROKERS') {
      throw new Error('InteractiveBrokersAdapter: provider mismatch');
    }
    const ibkrCreds = creds as Extract<BrokerCredentials, { provider: 'INTERACTIVE_BROKERS' }>;
    const factory = this.clientFactory
      ?? ((cfg) => new IbkrClient(cfg));
    this.client = factory({
      sessionToken: ibkrCreds.sessionToken,
      accountId: ibkrCreds.accountId,
    });
    this.mapper = new IbkrSymbolMapper(this.client);
  }

  async disconnect(): Promise<void> {
    this.client = null;
    this.mapper = null;
  }

  async testConnection(): Promise<TestConnectionResult> {
    if (!this.client) {
      return {
        ok: false,
        latencyMs: null,
        message: 'IBKR adapter non connecté — appelez connect() d\'abord.',
      };
    }
    const start = Date.now();
    try {
      const valid = await this.client.validateSession();
      return {
        ok: valid,
        latencyMs: Date.now() - start,
        message: valid
          ? 'IBKR session valide.'
          : 'IBKR session expirée — re-authentification nécessaire.',
      };
    } catch (e) {
      return {
        ok: false,
        latencyMs: Date.now() - start,
        message: `IBKR testConnection failed: ${String(e).slice(0, 120)}`,
      };
    }
  }

  // ── Phase B.2 — read methods (positions / cash / transactions) ────────

  async fetchPositions(): Promise<SyncedPosition[]> {
    if (!this.client) {
      throw new AdapterStubError('INTERACTIVE_BROKERS', 'connect() requis avant fetchPositions');
    }
    const acctId = this.client.getAccountId();
    const raw = await this.client.getPositions(acctId);
    return raw
      .filter((p) => p.position !== 0) // skip closed positions
      .map((p) => {
        const synced: SyncedPosition = {
          accountIdExternal: acctId,
          // SmartVest format: TICKER (sans suffix EODHD pour cohérence avec
          // le reste du code qui utilise IbkrConid via le mapper inverse)
          instrumentRef: p.ticker ?? p.contractDesc,
          quantity: String(p.position),
          avgCost: p.avgCost != null ? String(p.avgCost) : null,
          currency: p.currency,
          meta: {
            conid: p.conid,
            asset_class: p.assetClass,
            mkt_value: p.mktValue ?? null,
            mkt_price: p.mktPrice ?? null,
            unrealized_pnl: p.unrealizedPnl ?? null,
            realized_pnl: p.realizedPnl ?? null,
          },
        };
        return synced;
      });
  }

  async fetchCash(): Promise<SyncedCashBalance[]> {
    if (!this.client) {
      throw new AdapterStubError('INTERACTIVE_BROKERS', 'connect() requis avant fetchCash');
    }
    const acctId = this.client.getAccountId();
    const ledger = await this.client.getLedger(acctId);
    const out: SyncedCashBalance[] = [];
    for (const [currency, entry] of Object.entries(ledger)) {
      // IBKR retourne aussi un "BASE" key qui est l'agrégat — on le skip
      // pour ne pas dédupliquer (la consommation aval re-aggrège via FX)
      if (currency === 'BASE') continue;
      if (entry.cashbalance === 0) continue;
      out.push({
        accountIdExternal: acctId,
        currency: entry.currency || currency,
        amount: String(entry.cashbalance),
      });
    }
    return out;
  }

  async fetchTransactions(since?: Date): Promise<SyncedTransaction[]> {
    if (!this.client) {
      throw new AdapterStubError('INTERACTIVE_BROKERS', 'connect() requis avant fetchTransactions');
    }
    const acctId = this.client.getAccountId();
    const raw = await this.client.getTrades();
    const sinceMs = since ? since.getTime() : 0;

    return raw
      .filter((t) => {
        // Filter par date si since fourni
        if (sinceMs === 0) return true;
        const tradeMs = t.trade_time_r ?? new Date(t.trade_time).getTime();
        return Number.isFinite(tradeMs) && tradeMs >= sinceMs;
      })
      .map((t): SyncedTransaction => {
        // IBKR side : 'B' / 'S' / 'BUY' / 'SELL' selon endpoint
        const sideRaw = String(t.side).toUpperCase();
        const side: SyncedTransaction['side'] =
          sideRaw === 'B' || sideRaw === 'BUY' ? 'buy'
          : sideRaw === 'S' || sideRaw === 'SELL' ? 'sell'
          : 'other';

        const tradeIso = t.trade_time_r
          ? new Date(t.trade_time_r).toISOString()
          : new Date(t.trade_time).toISOString();

        const totalAmount = t.net_amount != null
          ? String(t.net_amount)
          : String(Math.abs(t.size) * t.price);

        return {
          accountIdExternal: t.account ?? acctId,
          externalId: t.execution_id,
          tradeDate: tradeIso,
          side,
          instrumentRef: t.symbol,
          quantity: String(Math.abs(t.size)),
          unitPrice: String(t.price),
          totalAmount,
          currency: t.currency ?? 'USD',
          meta: {
            conid: t.conid,
            order_id: t.order_id ?? null,
            commission: t.commission ?? null,
            commission_currency: t.commission_currency ?? null,
            asset_class: t.asset_class ?? null,
          },
        };
      });
  }

  // ── Phase B.1 — live execution methods ────────────────────────────────

  async placeOrder(draft: PlaceOrderDraft): Promise<PlaceOrderResult> {
    if (!this.executionEnabled) {
      return {
        externalOrderId: null,
        status: 'unsupported',
        message: 'Execution disabled — BROKER_EXECUTION_ENABLED=false or mandate inactive',
      };
    }
    if (!this.client || !this.mapper) {
      throw new Error('IBKRAdapter: call connect() before placeOrder()');
    }

    const conid = await this.mapper.resolve(draft.instrumentRef);
    if (conid === null) {
      return {
        externalOrderId: null,
        status: 'rejected',
        message: `IBKR: contract introuvable pour ${draft.instrumentRef}`,
      };
    }

    const tifMap: Record<string, 'DAY' | 'GTC' | 'IOC' | 'FOK'> = {
      day: 'DAY', gtc: 'GTC', ioc: 'IOC', fok: 'FOK',
    };

    try {
      const orderReq: import('./ibkr/ibkr-types').IbkrOrderRequest = {
        acctId: draft.accountIdExternal || this.client.getAccountId(),
        conid,
        orderType: draft.orderType === 'limit' ? 'LMT' : 'MKT',
        side: draft.side === 'buy' ? 'BUY' : 'SELL',
        quantity: parseFloat(draft.quantity),
        tif: tifMap[draft.timeInForce ?? 'day'] ?? 'DAY',
      };
      if (draft.limitPrice) orderReq.price = parseFloat(draft.limitPrice);
      const res = await this.client.placeOrder(orderReq);
      return {
        externalOrderId: res.order_id,
        status: 'accepted',
        message: res.order_status,
      };
    } catch (e) {
      return {
        externalOrderId: null,
        status: 'rejected',
        message: String(e).slice(0, 200),
      };
    }
  }

  async cancelOrder(externalOrderId: string): Promise<CancelOrderResult> {
    if (!this.client) {
      return {
        externalOrderId,
        status: 'unsupported',
        message: 'IBKR adapter non connecté',
      };
    }
    try {
      const ok = await this.client.cancelOrder(externalOrderId);
      return {
        externalOrderId,
        status: ok ? 'canceled' : 'already_filled',
        message: ok
          ? 'IBKR cancel accepté'
          : 'IBKR refuse cancel (déjà fillé ou non trouvé)',
      };
    } catch (e) {
      return {
        externalOrderId,
        status: 'unsupported',
        message: `IBKR cancelOrder error: ${String(e).slice(0, 120)}`,
      };
    }
  }

  async getOrderStatus(externalOrderId: string): Promise<BrokerOrderState> {
    if (!this.client) {
      throw new Error('IBKRAdapter: call connect() before getOrderStatus()');
    }
    const raw = await this.client.getOrderStatus(externalOrderId);
    if (raw === null) {
      return {
        externalOrderId,
        status: 'unknown',
        filledQuantity: '0',
        avgFillPrice: null,
        commissionUsd: null,
      };
    }
    return {
      externalOrderId,
      status: mapIbkrStatusToBrokerStatus(raw.status),
      filledQuantity: String(raw.filled_quantity ?? 0),
      avgFillPrice: raw.avg_price != null ? String(raw.avg_price) : null,
      commissionUsd: raw.commission != null ? String(raw.commission) : null,
      rawResponse: raw,
    };
  }

  async getFills(_externalOrderId: string): Promise<BrokerFill[]> {
    throw new NotSupportedError(
      'IBKR getFills activé en Phase B.3 (executions endpoint + WebSocket).',
    );
  }

  async getAccountBalance(accountIdExternal: string): Promise<BrokerAccountBalance> {
    if (!this.client) {
      throw new Error('IBKRAdapter: call connect() before getAccountBalance()');
    }
    const summary = await this.client.getAccountSummary(accountIdExternal);

    const cashByCurrency: Array<{ currency: string; amount: string }> = [];
    if (summary.totalcashvalue) {
      cashByCurrency.push({
        currency: summary.totalcashvalue.currency,
        amount: String(summary.totalcashvalue.amount),
      });
    }

    return {
      accountIdExternal,
      cashByCurrency,
      buyingPowerUsd: summary.buyingpower ? String(summary.buyingpower.amount) : null,
      totalEquityUsd: summary.netliquidation ? String(summary.netliquidation.amount) : null,
      asOf: new Date(),
    };
  }
}
