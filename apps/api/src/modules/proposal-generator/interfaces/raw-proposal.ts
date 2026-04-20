export type ProposalSourceKind =
  | 'drift'
  | 'concentration'
  | 'goal_trigger'
  | 'macro_signal'
  | 'drawdown'
  | 'benchmark';

export interface RawProposal {
  action: 'buy' | 'sell' | 'rebalance' | 'contribute' | 'withdraw' | 'other';
  ticker?: string;
  assetClass?: string;
  notional?: string;
  currency: string;
  rationale: string;
  assumptions: string[];
  sourceKind: ProposalSourceKind;
  sourceId?: string;
  /** 0–1 urgency score — higher is more urgent */
  score: number;
  expiresInDays: number;
  /** Fingerprint for deduplication check */
  dedupKey: string;
}

export interface GenerationResult {
  generated: number;
  skipped: number;
  blocked: number;
  reason?: string;
  proposalIds: string[];
}
