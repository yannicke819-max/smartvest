/**
 * Phase D-1 — Mapping event-type → tickers watchés + TP/SL adaptatif.
 *
 * Source : design doc docs/design/phase-d-event-driven-engine.md
 *
 * Catégorisation manuelle des events EODHD economic-events par "type" interne :
 *  - macro_rate : PCE, FOMC, CPI, taux directeurs ECB/BoE/BoJ
 *  - macro_jobs : NFP, unemployment, ADP
 *  - macro_cpi  : inflation reports specific
 *  - macro_gdp  : GDP releases
 *
 * Heuristique : match par regex sur event.event_name (case-insensitive).
 * Si aucun match → ignored par l'engine (event watch=false).
 */

export interface EventCategory {
  type: 'macro_rate' | 'macro_jobs' | 'macro_cpi' | 'macro_gdp';
  watch: string[];      // tickers à snapshot/trader sur cet event
  tpPct: number;        // take-profit % à partir de snapshot
  slPct: number;        // stop-loss % à partir de snapshot
  windowMin: number;    // fenêtre exit forcée (min post-event)
}

const PATTERN_TO_CATEGORY: Array<{ regex: RegExp; cat: EventCategory }> = [
  {
    regex: /\b(FOMC|Federal Open Market|Fed Rate|Fed Funds Rate|ECB Rate|BoE Rate|BoJ Rate)\b/i,
    cat: {
      type: 'macro_rate',
      watch: ['SPY.US', 'QQQ.US', 'TLT.US'],
      tpPct: 0.015, slPct: 0.010, windowMin: 30,
    },
  },
  {
    regex: /\b(PCE Price|Personal Consumption Expenditures|Core PCE)\b/i,
    cat: {
      type: 'macro_rate',
      watch: ['SPY.US', 'QQQ.US', 'TLT.US'],
      tpPct: 0.015, slPct: 0.010, windowMin: 30,
    },
  },
  {
    regex: /\b(CPI|Consumer Price|Inflation)\b/i,
    cat: {
      type: 'macro_cpi',
      watch: ['SPY.US', 'QQQ.US', 'TLT.US', 'GLD.US'],
      tpPct: 0.020, slPct: 0.012, windowMin: 30,
    },
  },
  {
    regex: /\b(Non[- ]Farm Payrolls|NFP|Unemployment Rate|ADP Employment)\b/i,
    cat: {
      type: 'macro_jobs',
      watch: ['SPY.US', 'DIA.US'],
      tpPct: 0.012, slPct: 0.008, windowMin: 20,
    },
  },
  {
    regex: /\b(GDP|Gross Domestic Product)\b/i,
    cat: {
      type: 'macro_gdp',
      watch: ['SPY.US', 'DIA.US', 'TLT.US'],
      tpPct: 0.015, slPct: 0.010, windowMin: 30,
    },
  },
];

/** Renvoie la catégorie applicable OU null si event hors scope D-1. */
export function categorizeEvent(eventName: string): EventCategory | null {
  if (!eventName) return null;
  for (const { regex, cat } of PATTERN_TO_CATEGORY) {
    if (regex.test(eventName)) return cat;
  }
  return null;
}
