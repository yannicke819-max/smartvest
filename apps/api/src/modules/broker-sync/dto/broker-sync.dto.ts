export type SyncKind = 'positions' | 'transactions' | 'balance' | 'full';
export type SyncStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled';

export interface BrokerSyncJob {
  id: string;
  connectionId: string | null;
  portfolioId: string;
  userId: string;
  syncKind: SyncKind;
  status: SyncStatus;
  rowsSynced: number;
  rowsErrored: number;
  errorMessage: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface BrokerSyncResult {
  jobId: string;
  connectionId: string | null;
  syncKind: SyncKind;
  status: SyncStatus;
  rowsSynced: number;
  rowsErrored: number;
  startedAt: string;
  completedAt: string;
  errors: string[];
}
