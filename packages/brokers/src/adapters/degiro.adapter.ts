import type {
  BrokerCredentials, BrokerCapabilities, BrokerProvider,
  SyncedPosition, SyncedCashBalance, SyncedTransaction,
} from '@smartvest/domain';
import { PROVIDER_CAPABILITIES } from '@smartvest/domain';
import {
  IBrokerAdapter, NotSupportedError,
  PlaceOrderDraft, PlaceOrderResult, TestConnectionResult,
  CancelOrderResult, BrokerOrderState, BrokerFill, BrokerAccountBalance,
} from './broker-adapter.interface';

/**
 * DegiroAdapter — DeGiro n'expose PAS d'API publique officielle.
 *
 * Décision architecturale : SmartVest NE scrape PAS DeGiro.
 * - Fragilité (le site change, casse la sync à chaque déploiement).
 * - CGU DeGiro à risque.
 * - Scrape = forme de détection-évasion déguisée.
 *
 * Voie officielle SmartVest pour DeGiro : export CSV depuis le portail
 * DeGiro, puis import via le flow existant `/imports` (parsers déjà livrés).
 *
 * Cet adapter existe uniquement pour satisfaire l'interface et pour
 * normaliser les messages d'erreur côté UI. Toute méthode live rejette
 * en pointant vers /imports.
 */
export class DegiroAdapter implements IBrokerAdapter {
  readonly provider: BrokerProvider = 'DEGIRO';
  readonly capabilities: BrokerCapabilities = PROVIDER_CAPABILITIES.DEGIRO;

  private static readonly CSV_REDIRECT_MESSAGE =
    'DeGiro ne fournit pas d\'API officielle. Utilisez l\'import CSV depuis /imports ' +
    '(flow DeGiro déjà livré dans le module broker-import).';

  async connect(_creds: BrokerCredentials): Promise<void> {
    throw new NotSupportedError(DegiroAdapter.CSV_REDIRECT_MESSAGE);
  }

  async disconnect(): Promise<void> { /* no-op */ }

  async testConnection(): Promise<TestConnectionResult> {
    return {
      ok: false,
      latencyMs: null,
      message: DegiroAdapter.CSV_REDIRECT_MESSAGE,
    };
  }

  async fetchPositions(): Promise<SyncedPosition[]> {
    throw new NotSupportedError(DegiroAdapter.CSV_REDIRECT_MESSAGE);
  }

  async fetchCash(): Promise<SyncedCashBalance[]> {
    throw new NotSupportedError(DegiroAdapter.CSV_REDIRECT_MESSAGE);
  }

  async fetchTransactions(_since?: Date): Promise<SyncedTransaction[]> {
    throw new NotSupportedError(DegiroAdapter.CSV_REDIRECT_MESSAGE);
  }

  async placeOrder(_draft: PlaceOrderDraft): Promise<PlaceOrderResult> {
    throw new NotSupportedError('DeGiro placeOrder indisponible — pas d\'API officielle.');
  }

  async cancelOrder(_externalOrderId: string): Promise<CancelOrderResult> {
    throw new NotSupportedError('DeGiro cancelOrder indisponible — pas d\'API officielle.');
  }
  async getOrderStatus(_externalOrderId: string): Promise<BrokerOrderState> {
    throw new NotSupportedError('DeGiro getOrderStatus indisponible — pas d\'API officielle.');
  }
  async getFills(_externalOrderId: string): Promise<BrokerFill[]> {
    throw new NotSupportedError('DeGiro getFills indisponible — pas d\'API officielle.');
  }
  async getAccountBalance(_accountIdExternal: string): Promise<BrokerAccountBalance> {
    throw new NotSupportedError('DeGiro getAccountBalance indisponible — pas d\'API officielle.');
  }
}
