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

/**
 * Trading212Adapter — structure prête pour l'API officielle Trading 212.
 *
 * Flow T212 attendu (à câbler quand le compte live est disponible) :
 *   1. L'utilisateur génère une clé API depuis Settings → API (Invest/ISA seulement).
 *   2. Copie la clé dans /settings/brokers/new.
 *   3. Headers: Authorization: <apiKey>
 *      Base URL: https://live.trading212.com
 *   4. fetchPositions() → GET /api/v0/equity/portfolio
 *      fetchCash()      → GET /api/v0/equity/account/cash
 *      fetchTransactions() → GET /api/v0/equity/history/orders
 *   5. Rate-limits stricts T212 : 1 req/s pour les endpoints personnels.
 */
export class Trading212Adapter implements IBrokerAdapter {
  readonly provider: BrokerProvider = 'TRADING212';
  readonly capabilities: BrokerCapabilities = PROVIDER_CAPABILITIES.TRADING212;

  private _apiKey: string | null = null;

  async connect(creds: BrokerCredentials): Promise<void> {
    if (creds.provider !== 'TRADING212') throw new Error('Trading212Adapter: provider mismatch');
    this._apiKey = creds.apiKey;
    void this._apiKey;
  }

  async disconnect(): Promise<void> { this._apiKey = null; }

  async testConnection(): Promise<TestConnectionResult> {
    return {
      ok: false,
      latencyMs: null,
      message: 'Adapter T212 câblé en interface — appel réseau non activé (voir BROKER_ADAPTER_TRADING212_ENABLED).',
    };
  }

  async fetchPositions(): Promise<SyncedPosition[]> {
    throw new AdapterStubError('TRADING212', 'fetchPositions non activé');
  }

  async fetchCash(): Promise<SyncedCashBalance[]> {
    throw new AdapterStubError('TRADING212', 'fetchCash non activé');
  }

  async fetchTransactions(_since?: Date): Promise<SyncedTransaction[]> {
    throw new AdapterStubError('TRADING212', 'fetchTransactions non activé');
  }

  async placeOrder(_draft: PlaceOrderDraft): Promise<PlaceOrderResult> {
    throw new NotSupportedError('T212 placeOrder désactivé — requiert BROKER_EXECUTION_ENABLED + mandat valide');
  }

  async cancelOrder(_externalOrderId: string): Promise<CancelOrderResult> {
    throw new NotSupportedError('T212 cancelOrder pas encore implémenté.');
  }
  async getOrderStatus(_externalOrderId: string): Promise<BrokerOrderState> {
    throw new NotSupportedError('T212 getOrderStatus pas encore implémenté.');
  }
  async getFills(_externalOrderId: string): Promise<BrokerFill[]> {
    throw new NotSupportedError('T212 getFills pas encore implémenté.');
  }
  async getAccountBalance(_accountIdExternal: string): Promise<BrokerAccountBalance> {
    throw new NotSupportedError('T212 getAccountBalance pas encore implémenté.');
  }
}
