export interface ExpectedTicker {
  symbol: string;
  score: number;
  reason: string;
  assetClass: string;
}

export interface BenchPrompt {
  id: string;
  prompt: string;
  expected_output: { tickers: ExpectedTicker[] };
  ground_truth_assetClass: Record<string, string>;
}

export interface RunResult {
  promptId: string;
  provider: string;
  model: string;
  ok: boolean;
  rawResponse: string;
  parsedTickers: ExpectedTicker[] | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
  jsonStrict: boolean;
  error?: string;
}

export interface BenchMetrics {
  provider: string;
  model: string;
  n: number;
  precision: number;
  recall: number;
  assetClassAccuracy: number;
  jsonStrictRate: number;
  avgCostUsd: number;
  totalCostUsd: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  compositeScore: number;
}
