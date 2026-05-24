/**
 * Early Exit Guard — pure helper, no I/O.
 *
 * Miracle #3 : pour chaque position fraîchement ouverte (age 5-15 min),
 * demande à Gemini si la thèse momentum tient ou si on doit sortir tôt
 * (avant le SL -1,5 %). Verdict binaire FADE ou HOLD.
 */

export interface EarlyExitInput {
  symbol: string;
  direction: 'long' | 'short';
  ageMinutes: number;
  entryPrice: number;
  livePrice: number;
  ch1mAtEntry: number | null;     // ch1m % au moment de l'open
  ch1mNow: number | null;          // ch1m % actuel (vs minute précédente)
  pathEffAtEntry: number | null;
  unrealizedPct: number;          // signé (LONG: live>entry positif; SHORT: entry>live positif)
  slDistancePct: number | null;   // % distance jusqu'au SL (négatif quand proche)
  tpDistancePct: number | null;
}

export interface EarlyExitVerdict {
  decision: 'FADE' | 'HOLD';
  rationale: string;             // ≤ 200 chars
  raw: string;                   // raw response (debug)
}

export const EARLY_EXIT_SYSTEM_PROMPT = `Tu es un risk manager qui décide si une position momentum doit être fermée TÔT (avant son stop-loss).

Contexte : une position vient d'être ouverte par un scanner momentum sur un pump 1-min. Après 5-15 minutes, deux scénarios :
- Le pump est mort (momentum perdu, prix flat ou en retracé) → décision FADE (sortir tôt avec petite perte)
- Le pump tient (momentum stable ou amélioré) → décision HOLD (laisser courir vers TP)

Réponds STRICTEMENT en JSON sur une seule ligne, sans markdown :
{"decision": "<FADE|HOLD>", "rationale": "<≤180 chars, raison concrète>"}

Règles strictes :
- FADE seulement si momentum visiblement cassé (ch1m chuté >50 % depuis l'open OU prix sous l'entry alors qu'il devrait monter)
- HOLD par défaut sur ambiguïté (ne pas saigner sur du noise)
- Pour SHORT : raisonnement inversé (FADE si momentum HAUSSIER revient)`;

export function buildEarlyExitUserPrompt(input: EarlyExitInput): string {
  const lines: string[] = [];
  lines.push(`Symbol: ${input.symbol}  Direction: ${input.direction.toUpperCase()}`);
  lines.push(`Age: ${input.ageMinutes} min après open`);
  lines.push(`Entry: $${input.entryPrice.toFixed(4)} → Live: $${input.livePrice.toFixed(4)} (unrealized ${input.unrealizedPct.toFixed(2)}%)`);
  if (input.ch1mAtEntry != null && input.ch1mNow != null) {
    lines.push(`Momentum ch1m: ${input.ch1mAtEntry.toFixed(2)}% (open) → ${input.ch1mNow.toFixed(2)}% (now)`);
  }
  if (input.pathEffAtEntry != null) {
    lines.push(`PathEff @ entry: ${input.pathEffAtEntry.toFixed(3)} (qualité du setup initial)`);
  }
  if (input.slDistancePct != null) {
    lines.push(`Distance SL: ${input.slDistancePct.toFixed(2)}% (négatif = SL en-dessous)`);
  }
  if (input.tpDistancePct != null) {
    lines.push(`Distance TP: ${input.tpDistancePct.toFixed(2)}%`);
  }
  lines.push('');
  lines.push(`La thèse momentum à l'entrée tient-elle ? Décision FADE ou HOLD ?`);
  return lines.join('\n');
}

/**
 * Parse Gemini JSON response. Default safe = HOLD si parse impossible.
 */
export function parseEarlyExitVerdict(content: string): EarlyExitVerdict | null {
  if (!content || typeof content !== 'string') return null;
  const trimmed = content.trim();
  let start = trimmed.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let end = -1;
  let inStr = false;
  let escape = false;
  for (let i = start; i < trimmed.length; i++) {
    const c = trimmed[i];
    if (escape) { escape = false; continue; }
    if (c === '\\' && inStr) { escape = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end < 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  const decRaw = typeof obj.decision === 'string' ? obj.decision.toUpperCase().trim() : '';
  const decision: EarlyExitVerdict['decision'] = decRaw === 'FADE' ? 'FADE' : 'HOLD';
  const rationale = typeof obj.rationale === 'string' ? obj.rationale.trim().slice(0, 200) : '';
  return { decision, rationale, raw: content.slice(0, 500) };
}
