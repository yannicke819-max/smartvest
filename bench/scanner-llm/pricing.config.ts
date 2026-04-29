/**
 * P16 — Table de pricing LLM ($/M tokens, avril 2026).
 * Source : pages de pricing officielles des providers.
 *
 * Unités : USD par million de tokens d'input / output.
 */

export interface ProviderPricing {
  id: string;
  label: string;
  model: string;
  inputUsdPerMtok: number;
  outputUsdPerMtok: number;
  region: string;
  rgpdCompliant: boolean;
}

export const PROVIDERS: ProviderPricing[] = [
  {
    id: 'codestral',
    label: 'Codestral (Mistral La Plateforme)',
    model: 'codestral-latest',
    inputUsdPerMtok: 0.30,
    outputUsdPerMtok: 0.90,
    region: 'FR (GCP europe-west4)',
    rgpdCompliant: true,
  },
  {
    id: 'scaleway',
    label: 'Llama-3.3-70B (Scaleway Generative APIs)',
    model: 'llama-3.3-70b-instruct',
    inputUsdPerMtok: 0.20,
    outputUsdPerMtok: 0.20,
    region: 'FR (Paris PAR-1)',
    rgpdCompliant: true,
  },
  {
    id: 'gemini-flash',
    label: 'Gemini 2.5 Flash (Google AI)',
    model: 'gemini-2.5-flash',
    inputUsdPerMtok: 0.30,
    outputUsdPerMtok: 2.50,
    region: 'US (europe-west1 disponible)',
    rgpdCompliant: true,
  },
  {
    id: 'gpt-4.1-mini',
    label: 'GPT-4.1-mini (OpenAI)',
    model: 'gpt-4.1-mini',
    inputUsdPerMtok: 0.40,
    outputUsdPerMtok: 1.60,
    region: 'US (DPA RGPD signé)',
    rgpdCompliant: true,
  },
  {
    id: 'gpt-4.1-nano',
    label: 'GPT-4.1-nano (OpenAI)',
    model: 'gpt-4.1-nano',
    inputUsdPerMtok: 0.10,
    outputUsdPerMtok: 0.40,
    region: 'US (DPA RGPD signé)',
    rgpdCompliant: true,
  },
  {
    id: 'gemini-flash-lite',
    label: 'Gemini 2.5 Flash-Lite (Google AI)',
    model: 'gemini-2.5-flash-lite',
    inputUsdPerMtok: 0.10,
    outputUsdPerMtok: 0.40,
    region: 'US (europe-west1 disponible)',
    rgpdCompliant: true,
  },
];

export function computeCostUsd(
  pricing: ProviderPricing,
  inputTokens: number,
  outputTokens: number,
): number {
  return (
    (inputTokens / 1_000_000) * pricing.inputUsdPerMtok +
    (outputTokens / 1_000_000) * pricing.outputUsdPerMtok
  );
}

export function getProvider(id: string): ProviderPricing {
  const p = PROVIDERS.find((p) => p.id === id);
  if (!p) throw new Error(`Unknown provider: ${id}`);
  return p;
}
