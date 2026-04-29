/**
 * P16 — Orchestrateur bench scanner LLM EU providers.
 * Usage : npm run bench:scanner-eu (depuis racine smartvest)
 * Prérequis : .env.bench rempli (voir .env.example).
 */

import fs from 'fs';
import path from 'path';
import { loadEnv } from './load-env.ts';
import { run } from './runner.ts';
import type { BenchPrompt } from './types.ts';
import {
  mistralCodestral,
  scalewayLlama,
  geminiFlash,
  geminiFlashLite,
  gpt41Mini,
  gpt41Nano,
} from './providers/index.ts';

loadEnv(path.join(import.meta.dirname, '.env.bench'));

const dataset = JSON.parse(
  fs.readFileSync(path.join(import.meta.dirname, 'dataset.json'), 'utf8'),
) as BenchPrompt[];

const PROVIDERS = [
  { id: 'codestral',        adapter: mistralCodestral() },
  { id: 'scaleway',         adapter: scalewayLlama()    },
  { id: 'gemini-flash',     adapter: geminiFlash()      },
  { id: 'gemini-flash-lite',adapter: geminiFlashLite()  },
  { id: 'gpt-4.1-mini',     adapter: gpt41Mini()        },
  { id: 'gpt-4.1-nano',     adapter: gpt41Nano()        },
] as const;

console.log(`\nP16 bench — ${PROVIDERS.length} providers × ${dataset.length} prompts\n`);

for (const { id, adapter } of PROVIDERS) {
  console.log(`▶ ${id} …`);
  try {
    await run(id, adapter, dataset);
  } catch (err) {
    console.error(`  ✗ ${id} failed:`, err);
  }
}

console.log('\nAll providers done. Running eval…\n');
await import('./eval.ts');
