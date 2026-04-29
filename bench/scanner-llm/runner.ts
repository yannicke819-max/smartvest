import fs from 'fs';
import path from 'path';
import { PROVIDERS, computeCostUsd, getProvider } from './pricing.config.ts';
import type { BenchPrompt, RunResult, ExpectedTicker } from './types.ts';

const SYSTEM_PROMPT =
  'Tu es un moteur d\'analyse momentum. Retourne UNIQUEMENT du JSON valide sans markdown ni explication. ' +
  'Format strict : {"tickers":[{"symbol":"...","score":8.5,"reason":"...","assetClass":"..."}]}';

export interface ProviderAdapter {
  call(systemPrompt: string, userPrompt: string): Promise<{
    content: string;
    inputTokens: number;
    outputTokens: number;
  }>;
}

async function callWithRetry(
  adapter: ProviderAdapter,
  userPrompt: string,
  maxRetries = 3,
): Promise<{ content: string; inputTokens: number; outputTokens: number }> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await adapter.call(SYSTEM_PROMPT, userPrompt);
    } catch (err) {
      lastErr = err;
      if (attempt < maxRetries - 1) {
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      }
    }
  }
  throw lastErr;
}

function tryParseJson(raw: string): ExpectedTicker[] | null {
  try {
    const cleaned = raw.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
    const parsed = JSON.parse(cleaned) as { tickers?: unknown };
    if (!Array.isArray(parsed.tickers)) return null;
    return parsed.tickers as ExpectedTicker[];
  } catch {
    return null;
  }
}

export async function run(
  providerId: string,
  adapter: ProviderAdapter,
  prompts: BenchPrompt[],
): Promise<RunResult[]> {
  const pricing = getProvider(providerId);
  const results: RunResult[] = [];

  for (const p of prompts) {
    const t0 = Date.now();
    let ok = false;
    let rawResponse = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let parsedTickers: ExpectedTicker[] | null = null;
    let error: string | undefined;

    try {
      const res = await callWithRetry(adapter, p.prompt);
      rawResponse = res.content;
      inputTokens = res.inputTokens;
      outputTokens = res.outputTokens;
      parsedTickers = tryParseJson(rawResponse);
      ok = parsedTickers !== null;
    } catch (err) {
      error = String(err);
    }

    const latencyMs = Date.now() - t0;
    const costUsd = computeCostUsd(pricing, inputTokens, outputTokens);
    const jsonStrict = parsedTickers !== null && rawResponse.trimStart().startsWith('{');

    results.push({
      promptId: p.id, provider: providerId, model: pricing.model,
      ok, rawResponse, parsedTickers, inputTokens, outputTokens,
      costUsd, latencyMs, jsonStrict, error,
    });
  }

  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outPath = path.join(import.meta.dirname, 'results', `results-${providerId}-${ts}.jsonl`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, results.map((r) => JSON.stringify(r)).join('\n') + '\n');
  console.log(`[${providerId}] wrote ${results.length} results → ${outPath}`);

  return results;
}

export { PROVIDERS };
