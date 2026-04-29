/**
 * P16 — 6 provider adapters EU-friendly.
 * Clés lues depuis .env.bench (jamais committées).
 * T=0.2, max_tokens=2048 partout.
 */

import type { ProviderAdapter } from '../runner.ts';

const T = 0.2;
const MAX_TOKENS = 2048;

// ── 1. Codestral — Mistral La Plateforme ────────────────────────────────────
export function mistralCodestral(): ProviderAdapter {
  return {
    async call(system, user) {
      const { Mistral } = await import('@mistralai/mistralai');
      const client = new Mistral({ apiKey: process.env.MISTRAL_API_KEY! });
      const res = await client.chat.complete({
        model: 'codestral-latest',
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        temperature: T,
        maxTokens: MAX_TOKENS,
      });
      return {
        content: String(res.choices?.[0]?.message?.content ?? ''),
        inputTokens: res.usage?.promptTokens ?? 0,
        outputTokens: res.usage?.completionTokens ?? 0,
      };
    },
  };
}

// ── 2. Llama-3.3-70B — Scaleway Generative APIs (OpenAI-compat) ─────────────
export function scalewayLlama(): ProviderAdapter {
  return {
    async call(system, user) {
      const OpenAI = (await import('openai')).default;
      const client = new OpenAI({
        apiKey: process.env.SCALEWAY_API_KEY!,
        baseURL: 'https://api.scaleway.ai/v1',
      });
      const res = await client.chat.completions.create({
        model: 'llama-3.3-70b-instruct',
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        temperature: T,
        max_tokens: MAX_TOKENS,
      });
      return {
        content: res.choices[0]?.message?.content ?? '',
        inputTokens: res.usage?.prompt_tokens ?? 0,
        outputTokens: res.usage?.completion_tokens ?? 0,
      };
    },
  };
}

// ── 3. Gemini 2.5 Flash — Google AI ────────────────────────────────────────
export function geminiFlash(): ProviderAdapter {
  return {
    async call(system, user) {
      const { GoogleGenAI } = await import('@google/genai');
      const ai = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY! });
      const res = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: user,
        config: { systemInstruction: system, temperature: T, maxOutputTokens: MAX_TOKENS },
      });
      return {
        content: res.text ?? '',
        inputTokens: res.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: res.usageMetadata?.candidatesTokenCount ?? 0,
      };
    },
  };
}

// ── 4. Gemini 2.5 Flash-Lite — Google AI ────────────────────────────────────
export function geminiFlashLite(): ProviderAdapter {
  return {
    async call(system, user) {
      const { GoogleGenAI } = await import('@google/genai');
      const ai = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY! });
      const res = await ai.models.generateContent({
        model: 'gemini-2.5-flash-lite',
        contents: user,
        config: { systemInstruction: system, temperature: T, maxOutputTokens: MAX_TOKENS },
      });
      return {
        content: res.text ?? '',
        inputTokens: res.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: res.usageMetadata?.candidatesTokenCount ?? 0,
      };
    },
  };
}

// ── 5. GPT-4.1-mini — OpenAI ────────────────────────────────────────────────
export function gpt41Mini(): ProviderAdapter {
  return {
    async call(system, user) {
      const OpenAI = (await import('openai')).default;
      const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
      const res = await client.chat.completions.create({
        model: 'gpt-4.1-mini',
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        temperature: T,
        max_tokens: MAX_TOKENS,
      });
      return {
        content: res.choices[0]?.message?.content ?? '',
        inputTokens: res.usage?.prompt_tokens ?? 0,
        outputTokens: res.usage?.completion_tokens ?? 0,
      };
    },
  };
}

// ── 6. GPT-4.1-nano — OpenAI ────────────────────────────────────────────────
export function gpt41Nano(): ProviderAdapter {
  return {
    async call(system, user) {
      const OpenAI = (await import('openai')).default;
      const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
      const res = await client.chat.completions.create({
        model: 'gpt-4.1-nano',
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        temperature: T,
        max_tokens: MAX_TOKENS,
      });
      return {
        content: res.choices[0]?.message?.content ?? '',
        inputTokens: res.usage?.prompt_tokens ?? 0,
        outputTokens: res.usage?.completion_tokens ?? 0,
      };
    },
  };
}
