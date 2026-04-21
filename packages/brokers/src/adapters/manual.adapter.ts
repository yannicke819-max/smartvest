import type {
  BrokerCredentials, BrokerCapabilities, BrokerProvider,
  SyncedPosition, SyncedCashBalance, SyncedTransaction,
} from '@smartvest/domain';
import { PROVIDER_CAPABILITIES } from '@smartvest/domain';
import {
  IBrokerAdapter, NotSupportedError,
  PlaceOrderDraft, PlaceOrderResult, TestConnectionResult,
} from './broker-adapter.interface';

/**
 * ManualAdapter — fallback provider, always available.
 * Doesn't talk to any external service. Returns empty datasets on sync;
 * the real data entry happens via the existing /imports CSV flow or manual
 * portfolio edits. Useful as a placeholder so users can create a connection
 * row even without a supported broker.
 */
export class ManualAdapter implements IBrokerAdapter {
  readonly provider: BrokerProvider = 'MANUAL';
  readonly capabilities: BrokerCapabilities = PROVIDER_CAPABILITIES.MANUAL;

  async connect(creds: BrokerCredentials): Promise<void> {
    if (creds.provider !== 'MANUAL') {
      throw new Error(`ManualAdapter received non-MANUAL credentials: ${creds.provider}`);
    }
  }

  async disconnect(): Promise<void> { /* no-op */ }

  async testConnection(): Promise<TestConnectionResult> {
    return { ok: true, latencyMs: 0, message: 'Manuel — pas de connexion externe à tester.' };
  }

  async fetchPositions(): Promise<SyncedPosition[]> { return []; }
  async fetchCash(): Promise<SyncedCashBalance[]> { return []; }
  async fetchTransactions(_since?: Date): Promise<SyncedTransaction[]> { return []; }

  async placeOrder(_draft: PlaceOrderDraft): Promise<PlaceOrderResult> {
    throw new NotSupportedError('ManualAdapter ne supporte aucune exécution — utilisez /imports pour saisir vos transactions.');
  }
}
