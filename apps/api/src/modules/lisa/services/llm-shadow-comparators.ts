/**
 * Comparators sémantiques pour LlmABShadowService.
 *
 * Le default comparator (string normalize + first 200 chars exact match) est
 * trop strict pour comparer des outputs LLM structurés (JSON, listes d'events,
 * lessons). Cas observé 01/06 : Mistral Medium 3.5 + Large 3 retournent une
 * analyse macro events SUBSTANTIELLEMENT IDENTIQUE au primary Gemini mais le
 * formatting JSON diffère (ordre champs, whitespace) → faux négatif 100%.
 *
 * Solution : extraire un set de tokens sémantiques et comparer Jaccard.
 */

/**
 * Jaccard similarity entre 2 sets : |A∩B| / |A∪B|.
 * Retourne 0 si les 2 sets sont vides.
 */
export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1; // both empty → trivially concordant
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const item of a) if (b.has(item)) intersection++;
  const union = a.size + b.size - intersection;
  return intersection / union;
}

/**
 * Extrait un set de tokens normalisés (lowercase, alphanumeric only) depuis un texte.
 * Utile pour comparer du texte libre (lessons, recommendations narratives).
 */
function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const word of text.toLowerCase().match(/[a-z0-9_]+/g) ?? []) {
    if (word.length >= 3) tokens.add(word);
  }
  return tokens;
}

/**
 * Tente de parser le JSON depuis un output LLM. Gère :
 * - JSON brut
 * - JSON dans ```json fences
 * - JSON dans ```text fences
 * - JSON wrapper avec préfixe textuel
 */
export function parseLooseJson(content: string): unknown | null {
  if (!content) return null;
  const trimmed = content.trim();

  // Tentative 1 : JSON brut
  try { return JSON.parse(trimmed); } catch { /* continue */ }

  // Tentative 2 : extraire entre ``` fences
  const fenceMatch = trimmed.match(/```(?:json|text)?\s*([\s\S]*?)\s*```/);
  if (fenceMatch) {
    try { return JSON.parse(fenceMatch[1].trim()); } catch { /* continue */ }
  }

  // Tentative 3 : find first { ... } block
  const braceStart = trimmed.indexOf('{');
  const braceEnd = trimmed.lastIndexOf('}');
  if (braceStart !== -1 && braceEnd > braceStart) {
    try { return JSON.parse(trimmed.slice(braceStart, braceEnd + 1)); } catch { /* continue */ }
  }

  return null;
}

/**
 * Comparator pour daily_brief : extrait les noms d'events macro et compare Jaccard.
 * Concordant si similarity >= 0.6 (60% des events partagés).
 *
 * Format attendu : { macro_events: [{ event: string, ... }, ...] }
 */
export function dailyBriefComparator(a: string, b: string): boolean {
  const pa = parseLooseJson(a) as { macro_events?: Array<{ event?: string }> } | null;
  const pb = parseLooseJson(b) as { macro_events?: Array<{ event?: string }> } | null;
  if (!pa || !pb) return false;

  const eventsA = new Set<string>();
  const eventsB = new Set<string>();
  for (const e of pa.macro_events ?? []) {
    if (e.event) {
      // Normalize : keep only keywords (3-letter codes + main words)
      for (const word of e.event.toLowerCase().match(/[a-z]{3,}/g) ?? []) {
        eventsA.add(word);
      }
    }
  }
  for (const e of pb.macro_events ?? []) {
    if (e.event) {
      for (const word of e.event.toLowerCase().match(/[a-z]{3,}/g) ?? []) {
        eventsB.add(word);
      }
    }
  }

  return jaccardSimilarity(eventsA, eventsB) >= 0.6;
}

/**
 * Comparator pour scanner_postmortem : extrait les keywords des lessons proposées
 * et compare Jaccard. Concordant si similarity >= 0.5 (50% keywords partagés).
 *
 * Format flexible : tente { lessons: [...] } d'abord, fallback sur full text.
 */
export function postmortemComparator(a: string, b: string): boolean {
  const pa = parseLooseJson(a) as { lessons?: Array<{ macro_condition?: string; lesson_text?: string }> } | null;
  const pb = parseLooseJson(b) as { lessons?: Array<{ macro_condition?: string; lesson_text?: string }> } | null;

  // Cas 1 : JSON structuré avec lessons[].macro_condition
  if (pa?.lessons && pb?.lessons) {
    const conditionsA = new Set(pa.lessons.map(l => (l.macro_condition || '').toUpperCase()).filter(Boolean));
    const conditionsB = new Set(pb.lessons.map(l => (l.macro_condition || '').toUpperCase()).filter(Boolean));
    return jaccardSimilarity(conditionsA, conditionsB) >= 0.5;
  }

  // Cas 2 : fallback texte → tokenize les premiers 800 chars (résumé exécutif)
  const tokensA = tokenize(a.slice(0, 800));
  const tokensB = tokenize(b.slice(0, 800));
  return jaccardSimilarity(tokensA, tokensB) >= 0.4;
}
