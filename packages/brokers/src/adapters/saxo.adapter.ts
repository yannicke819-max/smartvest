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
 * SaxoAdapter — structure prête pour Saxo OpenAPI (OAuth2).
 *
 * Flow Saxo attendu (à câbler quand les credentials seront disponibles) :
 *   1. L'utilisateur crée une app sur https://www.developer.saxo/
 *   2. Il exécute le flow OAuth2 pour obtenir access_token + refresh_token.
 *   3. SmartVest stocke les tokens dans Supabase Vault.
 *   4. À chaque sync, on refresh l'access_token si expiré (expiresAt).
 *   5. fetchPositions() → GET /openapi/port/v1/positions
 *      fetchCash()      → GET /openapi/port/v1/balances
 *      fetchTransactions() → GET /openapi/cs/v1/audit/orderactivities
 */
export class SaxoAdapter implements IBrokerAdapter {
  readonly provider: BrokerProvider = 'SAXO';
  readonly capabilities: BrokerCapabilities = PROVIDER_CAPABILITIES.SAXO;

  private _accessToken: string | null = null;

  async connect(creds: BrokerCredentials): Promise<void> {
    if (creds.provider !== 'SAXO') throw new Error('SaxoAdapter: provider mismatch');
    if (new Date(creds.expiresAt) <= new Date()) {
      throw new Error('Token Saxo expiré — utilisez le refresh_token pour en obtenir un nouveau');
    }
    this._accessToken = creds.oauthAccessToken;
    void this._accessToken;
  }

  async disconnect(): Promise<void> { this._accessToken = null; }

  async testConnection(): Promise<TestConnectionResult> {
    return {
      ok: false,
      latencyMs: null,
      message: 'Adapter Saxo câblé en interface — appel réseau non activé (voir BROKER_ADAPTER_SAXO_ENABLED).',
    };
  }

  async fetchPositions(): Promise<SyncedPosition[]> {
    throw new AdapterStubError('SAXO', 'fetchPositions non activé');
  }

  async fetchCash(): Promise<SyncedCashBalance[]> {
    throw new AdapterStubError('SAXO', 'fetchCash non activé');
  }

  async fetchTransactions(_since?: Date): Promise<SyncedTransaction[]> {
    throw new AdapterStubError('SAXO', 'fetchTransactions non activé');
  }

  async placeOrder(_draft: PlaceOrderDraft): Promise<PlaceOrderResult> {
    throw new NotSupportedError('Saxo placeOrder désactivé — requiert BROKER_EXECUTION_ENABLED + mandat valide');
  }

  async cancelOrder(_externalOrderId: string): Promise<CancelOrderResult> {
    throw new NotSupportedError('Saxo cancelOrder pas encore implémenté.');
  }
  async getOrderStatus(_externalOrderId: string): Promise<BrokerOrderState> {
    throw new NotSupportedError('Saxo getOrderStatus pas encore implémenté.');
  }
  async getFills(_externalOrderId: string): Promise<BrokerFill[]> {
    throw new NotSupportedError('Saxo getFills pas encore implémenté.');
  }
  async getAccountBalance(_accountIdExternal: string): Promise<BrokerAccountBalance> {
    throw new NotSupportedError('Saxo getAccountBalance pas encore implémenté.');
  }
}
