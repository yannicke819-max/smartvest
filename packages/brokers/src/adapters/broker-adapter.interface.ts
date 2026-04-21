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
