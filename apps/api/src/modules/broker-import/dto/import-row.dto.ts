export type ImportRowStatus = 'pending' | 'valid' | 'invalid' | 'duplicate' | 'committed' | 'skipped';

export interface NormalizedImportRow {
  rowNumber: number;
  rawPayload: Record<string, unknown>;
  tradeDate: string | null;         // ISO date YYYY-MM-DD
  action: string | null;            // 'buy' | 'sell' | 'dividend' | ...
  ticker: string | null;
  isin: string | null;
  quantity: string | null;          // decimal string
  unitPrice: string | null;
  currency: string | null;
  brokerFee: string | null;
  tax: string | null;
  fxRate: string | null;
  assetId: string | null;
  matchedAssetConfidence: number | null;
  status: ImportRowStatus;
  validationErrors: string[];
}

export interface ImportPreviewResult {
  jobId: string;
  brokerFormat: string;
  filename: string | null;
  rowsDetected: number;
  rowsValid: number;
  rowsInvalid: number;
  rowsDuplicate: number;
  rows: NormalizedImportRow[];
}

export interface ImportCommitResult {
  jobId: string;
  rowsCommitted: number;
  rowsSkipped: number;
  transactionsCreated: number;
  positionsUpdated: number;
}
