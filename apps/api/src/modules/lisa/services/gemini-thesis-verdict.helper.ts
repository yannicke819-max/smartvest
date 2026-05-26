/**
 * Gemini Thesis Verdict — pure helper, no I/O.
 *
 * Construit le prompt + parse la réponse pour le Sub-C du thesis_health_score.
 *
 * Le LLM doit retourner un score continu signé ∈ [-1, +1] :
 *   -1.0 : thèse complètement cassée (close_now nécessaire)
 *   -0.5 : dégradation modérée (tighten recommandé)
 *    0.0 : neutre (rien à signaler)
 *   +0.5 : thèse confirmée + force légère (raise_tp envisageable)
 *   +1.0 : forte conviction de continuation (momentum_ride)
 *
 * Format JSON strict imposé pour parsing déterministe.
 */

export interface GeminiVerdictInput {
  symbol: string;
  assetClass: string;
  openedAt: string; // ISO
  ageMinutes: number;
  entryPrice: number;
  livePrice: number;
  unrealPnlPct: number;
  pathEffAtEntry: number | null;
  pathEffNow: number | null;
  persistenceAtEntry: number | null;
  persistenceNow: number | null;
  marketCh1mAtEntry: number | null;
  marketCh1mNow: number | null;
  tpDistancePct: number | null;
  slDistancePct: number | null;
  /**
   * PR #465 — direction de la position. Default 'long' si non fourni
   * (back-compat). Le prompt expose la direction explicitement à Gemini
   * pour qu'il raisonne avec la bonne convention (short: prix qui monte = bad).
   */
  direction?: 'long' | 'short';
}

export interface GeminiVerdictParsed {
  score: number;                // ∈ [-1, +1] clampé
  rationale: string;            // 1 ligne, ≤ 200 chars
  raw: string;                  // raw text pour debug
}

export const GEMINI_VERDICT_SYSTEM_PROMPT = `Tu es un risk manager quantitatif pour un scanner momentum crypto/equity.
On te donne le contexte d'une position OUVERTE (LONG ou SHORT, précisé en input) et tu dois évaluer si la thèse à l'entrée tient toujours.

Convention DIRECTION (cruciale) :
 - LONG  : thèse = "le prix va monter". Momentum/path/persistence qui SE RENFORCENT = thèse confirmée. unrealPnlPct > 0 = en profit.
 - SHORT : thèse = "le prix va baisser" (fade momentum, mean reversion). Momentum qui S'EFFRITE = thèse CONFIRMÉE (fade fonctionne). Si momentum REPREND vers le haut = thèse cassée. unrealPnlPct est DÉJÀ signé pour la direction (> 0 = en profit).

Réponds STRICTEMENT en JSON sur une seule ligne, sans markdown :
{"score": <float dans [-1, +1]>, "rationale": "<1 ligne, max 180 chars>"}

Échelle (même sens des deux côtés grâce au signage upstream) :
 -1.0 = thèse cassée, fermer maintenant (catalyseur disparu, momentum inversé contre la position)
 -0.5 = dégradation modérée (perte de momentum favorable, mais SL pas atteint — tighten suggéré)
  0.0 = neutre, indéterminé (tenir)
 +0.5 = thèse confirmée + légère force supplémentaire
 +1.0 = très forte conviction de continuation favorable à la position

Ne propose JAMAIS d'action explicite (le système décide en aval). Juste un score numérique.`;

export function buildGeminiVerdictUserPrompt(input: GeminiVerdictInput): string {
  const lines: string[] = [];
  const direction = input.direction === 'short' ? 'SHORT' : 'LONG';
  lines.push(`Direction: ${direction}${direction === 'SHORT' ? ' (fade — thèse confirmée si momentum BAISSE)' : ' (trend — thèse confirmée si momentum MONTE)'}`);
  lines.push(`Symbol: ${input.symbol}`);
  lines.push(`Asset class: ${input.assetClass}`);
  lines.push(`Opened: ${input.openedAt} (age ${input.ageMinutes} min)`);
  lines.push(`Entry: $${input.entryPrice.toFixed(4)} / Live: $${input.livePrice.toFixed(4)} (unrealized ${input.unrealPnlPct.toFixed(2)}% — déjà signé pour la direction)`);
  if (input.pathEffAtEntry != null && input.pathEffNow != null) {
    lines.push(`PathEff: ${input.pathEffAtEntry.toFixed(3)} → ${input.pathEffNow.toFixed(3)}`);
  }
  if (input.persistenceAtEntry != null && input.persistenceNow != null) {
    lines.push(`Persistence: ${input.persistenceAtEntry.toFixed(2)} → ${input.persistenceNow.toFixed(2)}`);
  }
  if (input.marketCh1mAtEntry != null && input.marketCh1mNow != null) {
    lines.push(`Market proxy ch1m: ${input.marketCh1mAtEntry.toFixed(2)}% → ${input.marketCh1mNow.toFixed(2)}%`);
  }
  if (input.tpDistancePct != null) lines.push(`Distance to TP: ${input.tpDistancePct.toFixed(2)}%`);
  if (input.slDistancePct != null) lines.push(`Distance to SL: ${input.slDistancePct.toFixed(2)}%`);
  lines.push('');
  lines.push('La thèse de momentum à l\'entrée tient-elle toujours ? Réponds en JSON {"score":..., "rationale":"..."}.');
  return lines.join('\n');
}

/**
 * Parse la réponse Gemini. Robust : extrait le premier objet JSON valide
 * trouvé, clamp le score à [-1, +1], coupe rationale à 200 chars.
 * Retourne null si parsing impossible (caller traite comme sub-C = null).
 */
export function parseGeminiVerdict(content: string): GeminiVerdictParsed | null {
  if (!content || typeof content !== 'string') return null;
  // Extract JSON: cherche le 1er {...} balancé
  const trimmed = content.trim();
  let start = trimmed.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let end = -1;
  for (let i = start; i < trimmed.length; i++) {
    if (trimmed[i] === '{') depth++;
    else if (trimmed[i] === '}') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end < 0) return null;
  const json = trimmed.slice(start, end + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  const scoreRaw = obj.score;
  if (typeof scoreRaw !== 'number' || !Number.isFinite(scoreRaw)) return null;
  const score = Math.max(-1, Math.min(1, scoreRaw));
  const rationaleRaw = typeof obj.rationale === 'string' ? obj.rationale : '';
  const rationale = rationaleRaw.slice(0, 200);
  return { score, rationale, raw: content.slice(0, 500) };
}
