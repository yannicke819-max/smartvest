import type { Broker, Transaction } from '@smartvest/domain';

export type OrderSide = 'buy' | 'sell';
export type OrderType = 'market' | 'limit';

export interface DraftOrder {
  side: OrderSide;
  orderType: OrderType;
  assetId: string;
  quantity: string;
  limitPrice: string | null;
}

export type OrderState =
  | 'draft'
  | 'pending_user_confirm'
  | 'submitted'
  | 'filled'
  | 'partially_filled'
  | 'rejected'
  | 'cancelled';

export interface BrokerAccountSnapshot {
  accountId: string;
  positions: Array<{ assetRef: string; quantity: string; avgCost: string }>;
  balances: Array<{ currency: string; amount: string }>;
  asOf: string;
}

// Abstraction broker : au MVP toutes les implémentations sont simulées.
// L'exécution réelle exige un agrément réglementaire (RTO/CIF).
export interface BrokerAdapter {
  readonly broker: Broker;
  fetchAccountSnapshot(accountId: string): Promise<BrokerAccountSnapshot>;
  importTransactions(accountId: string, since?: Date): Promise<Transaction[]>;
  previewOrder(draft: DraftOrder): Promise<{ estimatedCost: string; notes: string[] }>;
}

export class SimulatedBrokerAdapter implements BrokerAdapter {
  constructor(public readonly broker: Broker) {}

  async fetchAccountSnapshot(accountId: string): Promise<BrokerAccountSnapshot> {
    return { accountId, positions: [], balances: [], asOf: new Date().toISOString() };
  }

  async importTransactions(): Promise<Transaction[]> {
    return [];
  }

  async previewOrder(draft: DraftOrder) {
    return {
      estimatedCost: '0',
      notes: [
        'Simulation uniquement — aucun ordre envoyé.',
        `Intention: ${draft.side} ${draft.quantity} @${draft.orderType}`,
      ],
    };
  }
}
