/**
 * P17 — Vendor-agnostic LLM provider interface.
 *
 * Permet au router de basculer entre Gemini / OpenAI / Mistral / Claude
 * sans connaître les détails de chaque SDK. Chaque adapter normalise
 * son API native vers ce contrat unique.
 *
 * Inputs/outputs uniquement texte+JSON. Pas de tool-use, pas de
 * multi-turn, pas de streaming — le scanner Gainers est strictement
 * single-turn JSON-output.
 */

export interface LlmCallParams {
  /** System prompt (consigne stable, mise en cache provider-side si possible). */
  system: string;
  /** User message — typiquement le snapshot de candidats à analyser. */
  user: string;
  /** Sampling temperature (0-2). */
  temperature?: number;
  /** Max output tokens. */
  maxTokens?: number;
  /** Hard timeout côté router (ms). Défaut : 5000. */
  timeoutMs?: number;
}

export interface LlmCallResult {
  /** Réponse brute (texte). Le caller fait le JSON.parse. */
  content: string;
  /** Tokens facturés en input (si rapportés par le provider). */
  inputTokens: number;
  /** Tokens facturés en output. */
  outputTokens: number;
  /** Coût USD calculé via la table de pricing du provider. */
  costUsd: number;
  /** Latence wall-clock côté router (ms). */
  latencyMs: number;
  /** ID du provider effectivement appelé (ex: 'gemini-flash-lite'). */
  providerId: string;
  /** Modèle identifiant SDK-side (ex: 'gemini-2.5-flash-lite'). */
  model: string;
}

export interface LlmProvider {
  /** Identifiant stable utilisé pour logs / config / fallback chain. */
  readonly id: string;
  /** Modèle SDK-side ciblé. */
  readonly model: string;
  /**
   * True si le provider est configuré (clé API présente).
   * Permet au router de skip silencieusement les providers non configurés.
   */
  isConfigured(): boolean;
  /**
   * Appel LLM single-turn. Lève une erreur en cas d'échec — le router
   * gère retry + fallback.
   */
  call(params: LlmCallParams): Promise<LlmCallResult>;
}
