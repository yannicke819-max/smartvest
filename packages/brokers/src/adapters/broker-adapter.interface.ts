import type {
  BrokerProvider,
  BrokerCredentials,
  BrokerCapabilities,
  SyncedPosition,
  SyncedCashBalance,
  SyncedTransaction,
} from '@smartvest/domain';

/**
 * Neutral, broker-agnostic order draft sent to placeOrder(). Live execution
 * is gated by BROKER_EXECUTION_ENABLED + BROKER_ADAPTER_<X>_ENABLED +
 * AUTONOMOUS_GUARDED + a valid mandate. Every adapter implementation must
 * refuse placeOrder when the aggregate gate is off.
 */
export interface PlaceOrderDraft {
  accountIdExternal: string;
  instrumentRef: string;
  side: 'buy' | 'sell';
  orderType: 'market' | 'limit';
  quantity: string;
  limitPrice?: string | null;
  timeInForce?: 'day' | 'gtc' | 'ioc' | 'fok';
}

export interface PlaceOrderResult {
  externalOrderId: string | null;
  status: 'accepted' | 'rejected' | 'queued' | 'unsupported';
  message: string;
}

/**
 * Phase A LIVE — Status d'un ordre côté broker, mappé vers le schéma
 * broker_orders.status. `unknown` est utilisé quand le broker ne renvoie
 * pas l'ordre (ex: après cancel + purge côté broker).
 */
export type BrokerOrderStatus =
  | 'submitted'
  | 'accepted'
  | 'partial_fill'
  | 'filled'
  | 'rejected'
  | 'canceled'
  | 'expired'
  | 'unknown';

export interface BrokerOrderState {
  externalOrderId: string;
  status: BrokerOrderStatus;
  filledQuantity: string;
  avgFillPrice: string | null;
  commissionUsd: string | null;
  rejectReason?: string | null;
  rawResponse?: unknown;
}

/**
 * Phase A LIVE — Un fill individuel (un ordre peut avoir 1 ou plusieurs
 * fills, surtout sur ordres market split sur plusieurs venues).
 */
export interface BrokerFill {
  externalOrderId: string;
  externalFillId: string;
  symbol: string;
  side: 'buy' | 'sell';
  quantity: string;
  price: string;
  commissionUsd: string;
  filledAt: Date;
  rawResponse?: unknown;
}

/**
 * Phase A LIVE — Snapshot du compte broker (cash + buying power).
 * Multi-currency : balances per devise. usdEquivalent calculé via FX live
 * côté caller, pas l'adapter.
 */
export interface BrokerAccountBalance {
  accountIdExternal: string;
  cashByCurrency: Array<{ currency: string; amount: string }>;
  buyingPowerUsd: string | null;
  totalEquityUsd: string | null;
  asOf: Date;
}

export interface CancelOrderResult {
  externalOrderId: string;
  status: 'canceled' | 'unsupported' | 'not_found' | 'already_filled';
  message: string;
}

export interface TestConnectionResult {
  ok: boolean;
  latencyMs: number | null;
  message: string;
}

/**
 * IBrokerAdapter — contract every live broker integration must implement.
 * All data-fetch methods MUST return normalised SmartVest shapes
 * (SyncedPosition / SyncedCashBalance / SyncedTransaction). Provider-specific
 * payloads stay inside the adapter.
 *
 * Implementations NEVER store credentials themselves — the orchestrator
 * pulls credentials from the Vault and passes them in at construction time.
 *
 * Phase A LIVE — méthodes ajoutées : cancelOrder, getOrderStatus, getFills,
 * getAccountBalance. Defaults: throw NotSupportedError sur tous les adapters
 * existants jusqu'à ce qu'une PR ultérieure les implémente per-broker.
 */
export interface IBrokerAdapter {
  readonly provider: BrokerProvider;
  readonly capabilities: BrokerCapabilities;

  connect(credentials: BrokerCredentials): Promise<void>;
  disconnect(): Promise<void>;

  testConnection(): Promise<TestConnectionResult>;

  fetchPositions(): Promise<SyncedPosition[]>;
  fetchCash(): Promise<SyncedCashBalance[]>;
  fetchTransactions(since?: Date): Promise<SyncedTransaction[]>;

  /**
   * Place an order. Default behavior of every shipped adapter in this commit:
   * throw NotSupported unless overridden by a later commit gated by all four
   * flags (BROKER_EXECUTION_ENABLED + adapter flag + AUTONOMOUS_GUARDED + mandate).
   */
  placeOrder(draft: PlaceOrderDraft): Promise<PlaceOrderResult>;

  /**
   * Phase A LIVE — Cancel an order by externalOrderId. Default: throw
   * NotSupportedError jusqu'à implémentation per-adapter.
   */
  cancelOrder(externalOrderId: string): Promise<CancelOrderResult>;

  /**
   * Phase A LIVE — Get current status of an order. Used for reconciliation
   * + post-fill commission tracking. Default: throw NotSupportedError.
   */
  getOrderStatus(externalOrderId: string): Promise<BrokerOrderState>;

  /**
   * Phase A LIVE — Get fills (executions) for an order. May return multiple
   * fills for split market orders. Default: throw NotSupportedError.
   */
  getFills(externalOrderId: string): Promise<BrokerFill[]>;

  /**
   * Phase A LIVE — Snapshot balance + buying power. Used pre-trade to verify
   * suffisant cash + post-trade pour reconciliation. Default: throw NotSupportedError.
   */
  getAccountBalance(accountIdExternal: string): Promise<BrokerAccountBalance>;
}

export class NotSupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotSupportedError';
  }
}

export class AdapterStubError extends Error {
  constructor(provider: BrokerProvider, detail: string) {
    super(`Adapter ${provider} stub : ${detail}`);
    this.name = 'AdapterStubError';
  }
}
