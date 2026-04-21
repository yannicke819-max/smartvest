import type {
  BrokerCredentials, BrokerCapabilities, BrokerProvider,
  SyncedPosition, SyncedCashBalance, SyncedTransaction,
} from '@smartvest/domain';
import { PROVIDER_CAPABILITIES } from '@smartvest/domain';
import {
  IBrokerAdapter, NotSupportedError, AdapterStubError,
  PlaceOrderDraft, PlaceOrderResult, TestConnectionResult,
} from './broker-adapter.interface';

/**
 * InteractiveBrokersAdapter — structure prête pour l'IB Client Portal Gateway.
 *
 * Flow IB attendu (à câbler dans un commit suivant, une fois les credentials
 * de test disponibles en local) :
 *   1. L'utilisateur démarre localement le Client Portal Gateway (IBKR fournit
 *      un binaire Java qui écoute sur https://localhost:5000).
 *   2. Il copie son sessionToken + accountId dans /settings/brokers/new.
 *   3. connect() valide la session via GET /v1/api/iserver/auth/status.
 *   4. fetchPositions() → GET /v1/api/portfolio/{accountId}/positions/0
 *      fetchCash()      → GET /v1/api/portfolio/{accountId}/ledger
 *      fetchTransactions() → GET /v1/api/iserver/account/trades
 *
 * Pour l'instant : adapter stubé côté réseau. Les méthodes renvoient un
 * résultat vide ; placeOrder refuse toujours. Tous les endpoints attendus
 * sont documentés ci-dessus pour implémentation future.
 */
export class InteractiveBrokersAdapter implements IBrokerAdapter {
  readonly provider: BrokerProvider = 'INTERACTIVE_BROKERS';
  readonly capabilities: BrokerCapabilities = PROVIDER_CAPABILITIES.INTERACTIVE_BROKERS;

  /** Stored for future live-call wiring. Prefixed with _ so unused-locals passes. */
  private _accountId: string | null = null;

  async connect(creds: BrokerCredentials): Promise<void> {
    if (creds.provider !== 'INTERACTIVE_BROKERS') {
      throw new Error('InteractiveBrokersAdapter: provider mismatch');
    }
    this._accountId = creds.accountId;
    void this._accountId;
  }

  async disconnect(): Promise<void> { this._accountId = null; }

  async testConnection(): Promise<TestConnectionResult> {
    return {
      ok: false,
      latencyMs: null,
      message: 'Adapter IB câblé en interface — appel réseau non activé (voir BROKER_ADAPTER_IB_ENABLED).',
    };
  }

  async fetchPositions(): Promise<SyncedPosition[]> {
    throw new AdapterStubError('INTERACTIVE_BROKERS', 'fetchPositions non activé (flag off ou credentials absents)');
  }

  async fetchCash(): Promise<SyncedCashBalance[]> {
    throw new AdapterStubError('INTERACTIVE_BROKERS', 'fetchCash non activé');
  }

  async fetchTransactions(_since?: Date): Promise<SyncedTransaction[]> {
    throw new AdapterStubError('INTERACTIVE_BROKERS', 'fetchTransactions non activé');
  }

  async placeOrder(_draft: PlaceOrderDraft): Promise<PlaceOrderResult> {
    throw new NotSupportedError('IB placeOrder désactivé — requiert BROKER_EXECUTION_ENABLED + mandat valide');
  }
}
