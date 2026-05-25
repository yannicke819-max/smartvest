/**
 * Helper de parse JSON robuste pour les réponses LLM (Gemini, Claude).
 *
 * Contexte : Gemini Flash-Lite ignore régulièrement l'instruction
 * "no markdown, no backticks" et retourne du JSON entouré de ` ```json ... ``` `.
 * `JSON.parse()` direct throw `SyntaxError: Unexpected token '\`'` → tombe en
 * fallback déterministe sur tous les call sites scanner-llm.
 *
 * Solution : strip backticks + extracteur balanced { ou [ en fallback.
 * Idempotent : si la chaîne est déjà du JSON propre, le 1er essai passe.
 */

/**
 * Strippe les fences markdown ` ```json ... ``` ` ou ` ``` ... ``` ` du début/fin.
 * Tolère whitespace, "json", "JSON", aucun langage. Idempotent.
 */
export function stripCodeFence(input: string): string {
  return input
    .replace(/^\s*```(?:json|JSON)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();
}

/**
 * Parse JSON LLM robuste : strip fence → JSON.parse → fallback balanced extract.
 * Retourne null si toutes les stratégies échouent. Caller doit gérer le null.
 *
 * Accepte objet `{...}` OU tableau `[...]` (utile pour ranking arrays).
 */
export function parseLlmJson<T = unknown>(content: string): T | null {
  if (!content) return null;
  const stripped = stripCodeFence(content);
  // Strat 1 : direct
  try {
    return JSON.parse(stripped) as T;
  } catch { /* fallthrough */ }
  // Strat 2 : balanced extraction (objet OU array)
  const balanced = extractFirstBalanced(content);
  if (balanced) {
    try {
      return JSON.parse(balanced) as T;
    } catch { /* fallthrough */ }
  }
  return null;
}

/**
 * Extrait le 1er bloc JSON balanced `{...}` ou `[...]`. Gère les strings/escapes
 * pour ne pas compter les délimiteurs à l'intérieur de string literals.
 */
export function extractFirstBalanced(input: string): string | null {
  // Cherche le 1er { ou [ qui ouvre
  let start = -1;
  let openChar = '';
  let closeChar = '';
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === '{' || ch === '[') {
      start = i;
      openChar = ch;
      closeChar = ch === '{' ? '}' : ']';
      break;
    }
  }
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < input.length; i++) {
    const ch = input[i];
    if (escape) { escape = false; continue; }
    if (inString) {
      if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === openChar) depth++;
    else if (ch === closeChar) {
      depth--;
      if (depth === 0) return input.slice(start, i + 1);
    }
  }
  return null;
}
