/**
 * Blow-off / pump-fade preamble lessons — priors injected in TRADER prompt.
 *
 * Curated from academic and consensus sources (post-mortem OKLO.US 03/06/2026).
 * The scanner already enforces gates 1-4 (CHOP_LONG_TF, CLIMAX_RUN, VERTICAL_PUMP,
 * TOP_TICK_GUARD) via blow-off-gates.helper.ts. This file gives the TRADER LLM
 * the PATTERN VOCABULARY so it can:
 *   1) recognize blow-off signatures that slip past gates (rare)
 *   2) justify a HOLD/SKIP with named, sourced pattern in its rationale
 *   3) override "size+conviction looks OK" reflexes when a fade signature appears
 *
 * Sources (full bibliography in `apps/api/docs/blow-off-research.md`) :
 *   - Xu & Livshits 2019 (arxiv:1811.10109) — Crypto P&D anatomy
 *   - Kamps & Kleinberg 2018 — "To the moon" anomaly windows
 *   - La Morgia et al. 2020/2024 — Real-time P&D ML detection
 *   - Minervini SEPA / TraderLion VCP
 *   - O'Neil CAN SLIM sell rules / AAII
 *   - Linda Raschke 12 rules
 *   - Bulkowski thepatternsite — shooting star / blow-off stats
 *
 * Confidence convention (mirrors lessons system): 0.0-1.0.
 *  - 0.90+ : peer-reviewed + numeric threshold + convergent multi-source
 *  - 0.75+ : single quantified rule with operational specificity
 *  - 0.60+ : widely cited heuristic, threshold weakly anchored
 */

export interface PreambleLesson {
  /** Stable ID for tracking which lesson influenced a decision. */
  id: string;
  /** Pattern family for filtering / grouping. */
  family: 'blow_off' | 'climax_run' | 'late_fomo' | 'concentration' | 'volume_anomaly' | 'rsi_decel' | 'pullback_discipline' | 'mean_reversion';
  /** Short human-readable name (cited by TRADER in rationale, e.g. "[OKLO_RULE_climax_run_O'Neil]"). */
  name: string;
  /** Numeric signature the TRADER can verify against candidate metrics. */
  signature: string;
  /** Action prescribed. */
  rule: string;
  /** Source citation. */
  source: string;
  /** Confidence prior. */
  confidence: number;
}

/**
 * 12 highest-impact rules (filtered from the 28 surveyed) for momentum entry
 * decisions. Kept compact to fit prompt budget — full set in research doc.
 */
export const BLOW_OFF_PREAMBLE_LESSONS: ReadonlyArray<PreambleLesson> = [
  {
    id: 'climax_run_oneil',
    family: 'climax_run',
    name: 'climax_run_O\'Neil',
    signature: 'price +25% en 5-10 sessions APRÈS uptrend multi-mois, OU tf30m ≈ tf5m + tf5m ≥ 5% (intraday)',
    rule: 'SKIP nouvelle entrée long. C\'est le sommet par construction, mean reversion imminente.',
    source: 'O\'Neil CAN SLIM sell rules / AAII journal',
    confidence: 0.90,
  },
  {
    id: 'vertical_pump_last_minute',
    family: 'concentration',
    name: 'vertical_pump_concentration',
    signature: 'ch1m / tf5m > 0.5 ET tf5m ≥ 5% — la dernière minute a fait > 50% du move 5min',
    rule: 'SKIP long. Late FOMO bar = top tick. Cf. OKLO.US 03/06 : ch1m=9.84/tf5m=11.79=0.83 → -1.6% en 35min.',
    source: 'Bulkowski blow-off + Raschke "first push" axiom',
    confidence: 0.92,
  },
  {
    id: 'minervini_dont_chase_extended',
    family: 'late_fomo',
    name: 'minervini_extended',
    signature: '(price - 20MA) / 20MA > 0.10 (stocks) ou > 0.20 (crypto)',
    rule: 'BLOCK long. Attendre pullback ou prochain setup (VCP base).',
    source: 'Minervini "Trade Like a Stock Market Wizard" / TraderLion VCP',
    confidence: 0.85,
  },
  {
    id: 'raschke_first_pullback',
    family: 'pullback_discipline',
    name: 'raschke_no_first_push',
    signature: 'entry sur barre qui imprime un nouveau HOD sans pullback préalable de ≥ 38% de l\'impulsion',
    rule: 'WAIT au moins 1 candle 1m rouge (ou retrace ≥ 0.38 × impulse) avant entry sur reclaim.',
    source: 'Linda Raschke 12 rules / newtraderu.com',
    confidence: 0.88,
  },
  {
    id: 'oneil_7_of_8',
    family: 'climax_run',
    name: 'oneil_7_of_8_days',
    signature: 'stock up 7 of last 8 days OR 8 of last 10 days',
    rule: 'REFUSE nouvelles entrées long. Précurseur climax run.',
    source: 'O\'Neil sell rules / Scribd',
    confidence: 0.82,
  },
  {
    id: 'exhaustion_volume_spike',
    family: 'volume_anomaly',
    name: 'exhaustion_volume',
    signature: 'volume bougie courante > 4× MA(20×1min volume) ET porte le prix à new 60-min high',
    rule: 'NEVER buy that tick. Late-FOMO bar. Wait pullback ou skip cycle.',
    source: 'opofinance exhaustion-volume + Kamps-Kleinberg z-score',
    confidence: 0.87,
  },
  {
    id: 'rsi_extreme_deceleration',
    family: 'rsi_decel',
    name: 'rsi85_decel',
    signature: 'RSI(7) ≥ 85 sur TF entrée ET ROC(dernier 1m) < mean(ROC, 5 dernières 1m)',
    rule: 'VETO long. Overbought + momentum decelerating = climax. OKLO signature exacte.',
    source: 'Quantified Strategies RSI study',
    confidence: 0.91,
  },
  {
    id: 'shooting_star_intraday',
    family: 'blow_off',
    name: 'shooting_star_1m',
    signature: 'sur 1m close: (high - max(open,close)) ≥ 2 × |close - open| après uptrend 5min > 3%',
    rule: 'VETO new long. Reversal candle ~59% base rate Bulkowski, +20pts avec volume.',
    source: 'Bulkowski thepatternsite.com/ShootingStar',
    confidence: 0.78,
  },
  {
    id: 'opening_15min_chase',
    family: 'mean_reversion',
    name: 'us_opening_chase',
    signature: 'US equity, premiers 15 min after 14:30 UTC, ch15m > +5%',
    rule: 'NE PAS chase. Wait IB break-and-reclaim. Base rate fade 62-67%.',
    source: 'OptionAlpha opening-range research',
    confidence: 0.75,
  },
  {
    id: 'small_cap_telegram_pump',
    family: 'blow_off',
    name: 'crypto_pump_small_cap',
    signature: 'small-cap crypto + volume 1m > 5× MA20 + signal à ±5min round UTC hour',
    rule: 'TREAT adversarial. Require 2× confirmation (news / on-chain) or SKIP.',
    source: 'Xu-Livshits 2019 / La Morgia P&D dataset',
    confidence: 0.85,
  },
  {
    id: 'path_eff_long_tf',
    family: 'blow_off',
    name: 'chop_structural',
    signature: 'tf1h pathEff < threshold (default 0.30) OU tf30m pathEff < threshold',
    rule: 'SKIP. Le 1h/30m est la vue structurelle. Choppy = pas de vrai trend, bruit.',
    source: 'OKLO post-mortem 03/06 + SmartVest path-quality framework',
    confidence: 0.88,
  },
  {
    id: 'short_horizon_reversal_asymmetric',
    family: 'mean_reversion',
    name: 'extreme_up_no_guaranteed_fade',
    signature: 'stock up > +10% en 1 session intraday',
    rule: 'NE PAS shorter mécaniquement. Empirique : reversal robuste après DOWN extreme, faible après UP extreme. Combine avec exhaustion volume + RSI decel avant fade.',
    source: 'Mu et al. (cond-mat/0406696)',
    confidence: 0.70,
  },
];

/**
 * Formats the preamble lessons as a prompt block, ready to inject into TRADER
 * systemPrompt. Compact (~1200 tokens), structured for LLM verification.
 */
export function formatBlowOffPreambleBlock(
  lessons: ReadonlyArray<PreambleLesson> = BLOW_OFF_PREAMBLE_LESSONS,
): string {
  if (lessons.length === 0) return '';
  const sorted = [...lessons].sort((a, b) => b.confidence - a.confidence);
  const lines = sorted.map((l, i) => {
    return `${i + 1}. [${l.name} conf=${l.confidence.toFixed(2)}]\n   Signature : ${l.signature}\n   Règle : ${l.rule}\n   Source : ${l.source}`;
  });
  return `PRÉAMBULE BLOW-OFF / PUMP-FADE — PRIORS ACADÉMIQUES & CONSENSUS

Tu connais ces ${sorted.length} patterns nommés pour reconnaître / verbaliser les setups
à risque (top tick, climax run, late FOMO). Le scanner en bloque déjà beaucoup en amont
(CHOP_LONG_TF, CLIMAX_RUN, VERTICAL_PUMP, TOP_TICK_GUARD). Si UN candidat passe et tu
détectes l'une de ces signatures dans ses metrics → tu as autorité pour SKIP avec
citation explicite dans [DIAGNOSTIC] : '[BLOW_OFF_RULE id=<name>]'.

${lines.join('\n\n')}

RÈGLE D'OR : un setup qui matche ≥ 2 de ces 12 patterns = veto presque automatique.
Cite les IDs dans rationale. Cas réel à éviter : OKLO.US 03/06 matchait 4 patterns
(climax_run, vertical_pump, chop_structural, no_first_pullback) → -1.6% en 35min.`;
}
