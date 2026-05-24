/**
 * Daily Retrospective — pure helper (no I/O).
 *
 * Build le prompt pour Gemini Pro et parse la réponse JSON structurée.
 * Le LLM reçoit les stats agrégées de la journée et retourne :
 *   - narrative : 1 paragraphe FR (~150 mots)
 *   - sentiment : 'positif' | 'neutre' | 'mixte' | 'negatif'
 *   - suggestions : 0-3 propositions d'amélioration concrètes
 */

export interface DailyStatsInput {
  date: string;                    // ISO "2026-05-24"
  portfolioId: string;
  capitalUsd: number;
  // Activité de la journée
  n_opens: number;
  n_closes: number;
  n_winners: number;
  n_losers: number;
  sum_pnl_usd: number;
  pnl_pct_of_capital: number;
  // Top mover (1 winner / 1 loser)
  top_winner?: { symbol: string; pnl_usd: number; pnl_pct: number } | undefined;
  top_loser?: { symbol: string; pnl_usd: number; pnl_pct: number } | undefined;
  // Risk-monitor actions (si actif)
  rm_close_now: number;
  rm_tighten_sl: number;
  rm_raise_tp: number;
  rm_momentum_ride: number;
  // Correlation guard rejections (si actif)
  cg_rejections: number;
  // Conviction sizing distribution (si actif)
  cs_skipped: number;
  cs_low_mult: number;
  cs_std: number;
  cs_high_mult: number;
  // Événements notables
  cascades_avoided?: number;       // si > 1 close groupé sur même tranche minute
  notable_events?: string[];       // ex 'kill_switch_triggered' 'budget_pause'
}

export interface DailyRetrospectiveParsed {
  narrative: string;
  sentiment: 'positif' | 'neutre' | 'mixte' | 'negatif';
  suggestions: string[];           // 0-3 items
}

export const DAILY_RETROSPECTIVE_SYSTEM_PROMPT = `Tu es l'assistant trading personnel d'un investisseur autonome qui pilote un système automatisé.
Chaque soir à 22:00 UTC, tu reçois les stats de la journée et tu écris une rétrospective courte mais riche.

Style :
- Tu parles en français, au "nous" (collaboratif), ton mesuré et honnête (pas de cheerleading)
- 1 paragraphe de ~150 mots
- Cite 1-2 highlights concrets (chiffres ou symboles)
- Si la journée est moyenne ou mauvaise, dis-le franchement
- Termine par 0 à 3 suggestions d'ajustement TESTABLES (pas de blabla générique)

Réponds STRICTEMENT en JSON sur une seule ligne, sans markdown :
{
  "narrative": "<paragraphe FR>",
  "sentiment": "<positif|neutre|mixte|negatif>",
  "suggestions": ["<idée 1>", "<idée 2>", "<idée 3>"]
}`;

export function buildDailyRetrospectiveUserPrompt(s: DailyStatsInput): string {
  const lines: string[] = [];
  lines.push(`Date : ${s.date}`);
  lines.push(`Capital portfolio : $${s.capitalUsd.toFixed(0)}`);
  lines.push('');
  lines.push(`=== Activité ===`);
  lines.push(`Opens : ${s.n_opens} | Closes : ${s.n_closes} (${s.n_winners}W / ${s.n_losers}L)`);
  const pnlSign = s.sum_pnl_usd >= 0 ? '+' : '-';
  lines.push(`PnL realized : ${pnlSign}$${Math.abs(s.sum_pnl_usd).toFixed(2)} (${(s.pnl_pct_of_capital * 100).toFixed(2)}% du capital)`);
  if (s.top_winner) {
    lines.push(`Top winner : ${s.top_winner.symbol} +$${s.top_winner.pnl_usd.toFixed(2)} (+${s.top_winner.pnl_pct.toFixed(2)}%)`);
  }
  if (s.top_loser) {
    lines.push(`Top loser : ${s.top_loser.symbol} -$${Math.abs(s.top_loser.pnl_usd).toFixed(2)} (${s.top_loser.pnl_pct.toFixed(2)}%)`);
  }
  lines.push('');
  lines.push(`=== Risk Monitor (cron 5min) ===`);
  if (s.rm_close_now + s.rm_tighten_sl + s.rm_raise_tp + s.rm_momentum_ride === 0) {
    lines.push(`Aucune action proactive déclenchée.`);
  } else {
    lines.push(`CLOSE_NOW: ${s.rm_close_now} | TIGHTEN_SL: ${s.rm_tighten_sl} | RAISE_TP: ${s.rm_raise_tp} | MOMENTUM_RIDE: ${s.rm_momentum_ride}`);
  }
  lines.push('');
  lines.push(`=== Garde-fous ===`);
  lines.push(`Correlation guard rejections : ${s.cg_rejections}`);
  lines.push(`Conviction sizing : ${s.cs_skipped} skipped / ${s.cs_low_mult} ×0.7 / ${s.cs_std} ×1.0 / ${s.cs_high_mult} ×1.5`);
  if (s.cascades_avoided != null && s.cascades_avoided > 0) {
    lines.push(`Cascades évitées : ${s.cascades_avoided}`);
  }
  if (s.notable_events && s.notable_events.length > 0) {
    lines.push('');
    lines.push(`=== Événements notables ===`);
    for (const e of s.notable_events) lines.push(`- ${e}`);
  }
  lines.push('');
  lines.push(`Écris la rétrospective en JSON strict.`);
  return lines.join('\n');
}

/**
 * Parse la réponse Gemini. Robuste : extrait le 1er JSON object balancé,
 * valide les champs, applique des fallbacks raisonnables.
 */
export function parseDailyRetrospective(content: string): DailyRetrospectiveParsed | null {
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
  const json = trimmed.slice(start, end + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  const narrative = typeof obj.narrative === 'string' ? obj.narrative.trim().slice(0, 2000) : '';
  if (!narrative) return null;
  const sentRaw = typeof obj.sentiment === 'string' ? obj.sentiment.toLowerCase().trim() : '';
  const sentiment: DailyRetrospectiveParsed['sentiment'] =
    sentRaw === 'positif' || sentRaw === 'negatif' || sentRaw === 'mixte' ? sentRaw : 'neutre';
  let suggestions: string[] = [];
  if (Array.isArray(obj.suggestions)) {
    suggestions = obj.suggestions
      .filter((x): x is string => typeof x === 'string')
      .map((s) => s.trim().slice(0, 280))
      .filter((s) => s.length > 0)
      .slice(0, 3);
  }
  return { narrative, sentiment, suggestions };
}
