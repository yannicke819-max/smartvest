/**
 * Helpers PURS du mode OVERSOLD — extraits pour testabilité sans mock.
 *
 * Couvre :
 *   - le filtre / tri / sélection des candidats du scanner (drop band + liquidité)
 *   - le calcul de jours ouvrés (businessDaysSince) pour l'exit J+10
 *
 * Aucune dépendance NestJS / Supabase / réseau ici : 100% déterministe.
 */

/** Barre EOD minimale (close + volume) issue d'EODHD. */
export interface EodBar {
  date: string; // YYYY-MM-DD
  close: number;
  volume: number;
}

/** Config résolue du mode oversold (defaults appliqués en amont). */
export interface OversoldConfig {
  dropMinPct: number; // borne basse (ex -12) — falling-knife exclu en dessous
  dropMaxPct: number; // borne haute (ex -5)
  holdDays: number;
  stopCatastrophePct: number; // ex -15
  tpPct: number | null; // null = pas de TP
  positionNotionalUsd: number;
  maxOpenPositions: number;
  universe: string;
  capitalUsd: number; // pour le plafond du sizing dynamique (% du capital)
}

/** Candidat oversold retenu (post-filtre). */
export interface OversoldCandidate {
  symbol: string;
  closeJ: number; // dernier close
  closeJPrev: number; // avant-dernier close
  dropPct: number; // (closeJ/closeJPrev - 1) * 100, négatif
  dollarVolume: number; // closeJ * volumeJ
}

// Seuils de liquidité (spec §3.3) — durs, non configurables en v1.
const MIN_PRICE_USD = 5;
const MIN_DOLLAR_VOLUME_USD = 5_000_000;

/**
 * Calcule le dropPct 1J d'une série de barres EOD.
 * Prend close[J] (dernier) et close[J-1] (avant-dernier).
 * Retourne null si moins de 2 barres exploitables.
 */
export function computeDropPct(bars: EodBar[]): { closeJ: number; closeJPrev: number; dropPct: number } | null {
  if (!bars || bars.length < 2) return null;
  const closeJ = bars[bars.length - 1].close;
  const closeJPrev = bars[bars.length - 2].close;
  if (!Number.isFinite(closeJ) || !Number.isFinite(closeJPrev) || closeJPrev <= 0) return null;
  const dropPct = (closeJ / closeJPrev - 1) * 100;
  return { closeJ, closeJPrev, dropPct };
}

/**
 * Teste si un dropPct est DANS la bande oversold valide.
 *
 * Spec : -12% <= dropPct <= -5% (les deux bornes incluses).
 *   - dropPct < dropMinPct (ex < -12)  → falling-knife, EXCLU
 *   - dropPct > dropMaxPct (ex > -5)   → pas assez de sur-réaction, IGNORÉ
 */
export function isInDropBand(dropPct: number, cfg: OversoldConfig): boolean {
  if (!Number.isFinite(dropPct)) return false;
  return dropPct >= cfg.dropMinPct && dropPct <= cfg.dropMaxPct;
}

/** Teste les seuils de liquidité (prix + dollar-volume). */
export function passesLiquidity(closeJ: number, volumeJ: number): boolean {
  if (!Number.isFinite(closeJ) || closeJ <= MIN_PRICE_USD) return false;
  const dollarVol = closeJ * (Number.isFinite(volumeJ) ? volumeJ : 0);
  return dollarVol > MIN_DOLLAR_VOLUME_USD;
}

/**
 * Construit la liste TRIÉE des candidats oversold à partir des barres EOD.
 *
 * Filtre : drop band + liquidité (prix > $5, dollar-volume > $5M).
 * Tri : par dropPct CROISSANT (le plus négatif = drop le plus fort = meilleur
 * alpha selon le gradient confirmé 3-fold).
 */
export function buildOversoldCandidates(
  barsBySymbol: Map<string, EodBar[]>,
  cfg: OversoldConfig,
): OversoldCandidate[] {
  const out: OversoldCandidate[] = [];
  for (const [symbol, bars] of barsBySymbol.entries()) {
    const drop = computeDropPct(bars);
    if (!drop) continue;
    if (!isInDropBand(drop.dropPct, cfg)) continue;
    const volumeJ = bars[bars.length - 1].volume;
    if (!passesLiquidity(drop.closeJ, volumeJ)) continue;
    out.push({
      symbol,
      closeJ: drop.closeJ,
      closeJPrev: drop.closeJPrev,
      dropPct: drop.dropPct,
      dollarVolume: drop.closeJ * volumeJ,
    });
  }
  // Tri profondeur : dropPct croissant (plus négatif d'abord). Tie-break sur
  // dollar-volume décroissant (liquidité).
  out.sort((a, b) => {
    if (a.dropPct !== b.dropPct) return a.dropPct - b.dropPct;
    return b.dollarVolume - a.dollarVolume;
  });
  return out;
}

/**
 * Filtre les candidats à ouvrir : retire ceux déjà détenus (anti-doublon).
 * Préserve l'ordre de tri.
 */
export function selectOversoldOpens(
  candidates: OversoldCandidate[],
  openSymbols: Set<string>,
): OversoldCandidate[] {
  return candidates.filter((c) => !openSymbols.has(c.symbol));
}

/**
 * Compte les jours OUVRÉS écoulés entre deux dates (week-ends exclus).
 *
 * Convention : on compte les jours ouvrés strictement APRÈS `from`, jusqu'à
 * `to` inclus. Ex : entrée vendredi, exit demande au vendredi suivant →
 * lun/mar/mer/jeu/ven = 5 jours ouvrés. Samedi/dimanche ne comptent pas.
 *
 * Jours fériés US non gérés en v1 (approximation acceptée par la spec §5.3).
 * Retourne 0 si `to <= from`.
 */
export function businessDaysSince(from: Date | string, to: Date | string): number {
  const start = typeof from === 'string' ? new Date(from) : from;
  const end = typeof to === 'string' ? new Date(to) : to;
  if (!(start instanceof Date) || isNaN(start.getTime())) return 0;
  if (!(end instanceof Date) || isNaN(end.getTime())) return 0;
  if (end.getTime() <= start.getTime()) return 0;

  // On itère par pas d'UN jour UTC à partir du lendemain de `start`.
  let count = 0;
  const cursor = new Date(
    Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()),
  );
  const endDay = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()));
  // Avance d'un jour avant de compter (jour d'entrée = J0, pas compté).
  cursor.setUTCDate(cursor.getUTCDate() + 1);
  while (cursor.getTime() <= endDay.getTime()) {
    const dow = cursor.getUTCDay(); // 0 = dimanche, 6 = samedi
    if (dow !== 0 && dow !== 6) count++;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return count;
}

// ─────────────────────────────────────────────────────────────────────────────
// Gate régime macro — décision PURE (extraite pour testabilité).
// ─────────────────────────────────────────────────────────────────────────────

/** Seuils du gate régime (région-aware : VIX/SPY US ou V2TX/SX5E EU). */
export interface RegimeThresholds {
  vixMax: number; // ex 17 (US) / 22 (EU)
  vixDeltaMax: number; // ex +10% — spike de volatilité 1 jour
  idx5dMin: number; // ex -1% (US) / -1.5% (EU) — momentum index 5 jours
}

/** Indicateurs observés (null = indisponible → la condition est ignorée). */
export interface RegimeInputs {
  vix: number | null;
  vixChg: number | null; // Δ 1 jour en %
  idx5d: number | null; // perf index 5 jours en %
}

/**
 * Décide si le régime macro BLOQUE le scan oversold.
 *
 * Block si AU MOINS UNE des 3 conditions est violée :
 *   1. vix    > vixMax       (volatilité absolue trop haute)
 *   2. vixChg > vixDeltaMax  (spike de vol 1 jour)
 *   3. idx5d  < idx5dMin      (index en chute sur 5 jours)
 *
 * Un indicateur `null` (indispo) n'enclenche jamais un block — le gate ne mord
 * que sur une donnée présente ET hostile (fail-open par indicateur). `labels`
 * ne sert qu'à formater `reason` (VIX/SPY ou V2TX/SX5E).
 *
 * Logique identique à l'ancienne version inline du service (behavior-preserving),
 * extraite ici pour être testable sans mock réseau.
 */
export function decideRegimeBlock(
  inputs: RegimeInputs,
  thresholds: RegimeThresholds,
  labels: { vix: string; idx: string },
): { block: boolean; reason: string } {
  const { vix, vixChg, idx5d } = inputs;
  const { vixMax, vixDeltaMax, idx5dMin } = thresholds;
  if (vix !== null && vix > vixMax) {
    return { block: true, reason: `${labels.vix} ${vix.toFixed(2)} > ${vixMax}` };
  }
  if (vixChg !== null && vixChg > vixDeltaMax) {
    return { block: true, reason: `Δ${labels.vix} 1d ${vixChg.toFixed(1)}% > +${vixDeltaMax}%` };
  }
  if (idx5d !== null && idx5d < idx5dMin) {
    return { block: true, reason: `${labels.idx} 5d ${idx5d.toFixed(2)}% < ${idx5dMin}%` };
  }
  return { block: false, reason: 'pass' };
}

/** Régime de rotation sectorielle offensif/défensif (cf. computeRotationRegime). */
export interface RotationRegime {
  regime: 'offensive' | 'defensive' | null;
  ratio: number | null; // dernier ratio offensif/défensif
  ma: number | null; // MM(maLen) du ratio
  spreadPct: number | null; // (ratio/ma - 1)*100 — distance au seuil
  n: number; // nb de points alignés par date
}

/**
 * Régime de rotation sectorielle offensif/défensif.
 *
 * ratio = close(secteur offensif) / close(secteur défensif), aligné par date.
 * regime = 'offensive' si dernier ratio ≥ MM(maLen) du ratio, sinon 'defensive'.
 * `null` (fail-open) si < maLen+1 points alignés — le caller ne module alors rien.
 *
 * Paires validées sur 3 ans (juin 2023→2026) :
 *   US : SMH/XLP (semis vs staples)         — régime DEF → fwd20j %pos 79→59%, vol +56%
 *   EU : EXV3/EXH3 (STOXX tech vs food&bev) — régime DEF → fwd20j %pos 69→59%, vol +36%
 * Signal MODESTE, surtout utile combiné au VIX/V2TX (désambiguïse le régime
 * vol-élevé : rebond vs vrai risk-off). Biais bull market (corrections rachetées
 * sur la période) → modulateur de PRUDENCE, jamais feu vert agressif.
 */
export function computeRotationRegime(
  offBars: EodBar[],
  defBars: EodBar[],
  maLen = 50,
): RotationRegime {
  const defByDate = new Map(defBars.map((b) => [b.date, b.close]));
  const ratios: number[] = [];
  for (const b of offBars) {
    const d = defByDate.get(b.date);
    if (d != null && d > 0 && b.close > 0) ratios.push(b.close / d);
  }
  const lastRatio = ratios.length > 0 ? ratios[ratios.length - 1] : null;
  if (ratios.length < maLen + 1) {
    return { regime: null, ratio: lastRatio, ma: null, spreadPct: null, n: ratios.length };
  }
  const last = ratios[ratios.length - 1];
  const window = ratios.slice(ratios.length - maLen);
  const ma = window.reduce((s, x) => s + x, 0) / maLen;
  const regime: 'offensive' | 'defensive' = last >= ma ? 'offensive' : 'defensive';
  const spreadPct = ma > 0 ? (last / ma - 1) * 100 : null;
  return { regime, ratio: last, ma, spreadPct, n: ratios.length };
}

// ─────────────────────────────────────────────────────────────────────────
// Features d'entrée pour la boucle d'apprentissage (PR-1 fondation oversold).
// Calculées AS-OF l'entrée (uniquement barres jusqu'à entryIdx → pas de
// look-ahead). EodBar n'a pas d'OHLC → "volatilité" = réalisée (stddev des
// returns), PAS d'ATR vrai. Pures + testables, aucune dépendance réseau.
// ⚠️ Aucune de ces features ne FILTRE l'entrée (cf. backtest n=6130 : un skip
// par trend-20d détruit l'edge). Elles sont LOGGÉES pour que l'empirical law
// (PR ultérieur) mesure lesquelles méritent un sizing différencié.
// ─────────────────────────────────────────────────────────────────────────

export interface OversoldEntryFeatures {
  drop1d: number; // (close[t]/close[t-1]-1)*100 — le drop déclencheur
  drop3d: number | null; // drop cumulé 3j
  trend20: number | null; // (close[t-1]/close[t-21]-1)*100 — tendance AVANT le drop
  distMa20: number | null; // distance au MA20 en % (close vs moyenne)
  distMa50: number | null; // distance au MA50 en %
  rsi14: number | null; // RSI Wilder simplifié 14
  vol14: number | null; // volatilité réalisée 14j (stddev returns) en %
  relVol20: number | null; // volume[t] / moyenne(volume, 20j)
}

/** RSI 14 (moyenne simple des gains/pertes sur la fenêtre). closes triés ASC. */
export function computeRsi(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null;
  let gain = 0;
  let loss = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    if (ch >= 0) gain += ch;
    else loss -= ch;
  }
  const avgG = gain / period;
  const avgL = loss / period;
  if (avgL === 0) return 100;
  return 100 - 100 / (1 + avgG / avgL);
}

/**
 * Calcule le vecteur de features à l'index d'entrée `entryIdx` dans `bars`
 * (triées par date ASC). Renvoie null si pas assez de barres pour le drop 1j.
 * Chaque feature individuelle est null si la profondeur est insuffisante.
 */
export function computeEntryFeatures(bars: EodBar[], entryIdx: number): OversoldEntryFeatures | null {
  if (entryIdx < 1 || entryIdx >= bars.length) return null;
  const closes = bars.map((b) => b.close);
  const vols = bars.map((b) => b.volume);
  const c = closes[entryIdx];
  if (!(c > 0)) return null;

  const drop1d = (c / closes[entryIdx - 1] - 1) * 100;
  const drop3d = entryIdx >= 3 ? (c / closes[entryIdx - 3] - 1) * 100 : null;
  const trend20 = entryIdx >= 21 ? (closes[entryIdx - 1] / closes[entryIdx - 21] - 1) * 100 : null;

  const ma = (n: number): number | null =>
    entryIdx >= n - 1
      ? closes.slice(entryIdx - n + 1, entryIdx + 1).reduce((s, x) => s + x, 0) / n
      : null;
  const ma20 = ma(20);
  const ma50 = ma(50);
  const distMa20 = ma20 ? (c / ma20 - 1) * 100 : null;
  const distMa50 = ma50 ? (c / ma50 - 1) * 100 : null;

  const rsi14 = computeRsi(closes.slice(0, entryIdx + 1), 14);

  let vol14: number | null = null;
  if (entryIdx >= 14) {
    const rets: number[] = [];
    for (let i = entryIdx - 13; i <= entryIdx; i++) rets.push(closes[i] / closes[i - 1] - 1);
    const mean = rets.reduce((s, x) => s + x, 0) / rets.length;
    const variance = rets.reduce((s, x) => s + (x - mean) ** 2, 0) / rets.length;
    vol14 = Math.sqrt(variance) * 100;
  }

  let relVol20: number | null = null;
  if (entryIdx >= 20) {
    const avg = vols.slice(entryIdx - 20, entryIdx).reduce((s, x) => s + x, 0) / 20;
    relVol20 = avg > 0 ? vols[entryIdx] / avg : null;
  }

  return { drop1d, drop3d, trend20, distMa20, distMa50, rsi14, vol14, relVol20 };
}

/**
 * Label à HORIZON FIXE (PR-4a) : rendement % à entryIdx+horizon, indépendant
 * de la sortie réelle. Neutralise la variance des sorties pour apprendre la
 * qualité d'ENTRÉE. Renvoie null si la barre entry+horizon n'existe pas encore
 * (position trop récente → à backfiller quand elle aura vieilli). Pur/testable.
 */
export function computeForwardOutcome(
  bars: EodBar[],
  entryIdx: number,
  horizon = 10,
): { fwdReturn: number; fwdOutcome: number } | null {
  if (entryIdx < 0 || entryIdx + horizon >= bars.length) return null;
  const entryClose = bars[entryIdx].close;
  const fwdClose = bars[entryIdx + horizon].close;
  if (!(entryClose > 0) || !(fwdClose > 0)) return null;
  const fwdReturn = (fwdClose / entryClose - 1) * 100;
  return { fwdReturn, fwdOutcome: fwdReturn > 0 ? 1 : 0 };
}

// ─────────────────────────────────────────────────────────────────────────
// Features news pour la boucle d'apprentissage (PR-3). Résumé des articles
// persistés (eodhd_news_articles) dans la fenêtre AVANT l'entrée — sert à
// MESURER si le sentiment news autour du drop prédit l'outcome (catalyseur
// structurel vs bruit). Étape déterministe/cheap (lecture DB, pas de LLM) :
// si le sentiment brut porte du signal, un classifieur LLM nuancé viendra
// après. Aucun filtre — feature loggée uniquement.
// ─────────────────────────────────────────────────────────────────────────

export interface OversoldNewsFeatures {
  newsCount: number; // nb d'articles dans la fenêtre [entry-72h, entry]
  newsMinSentiment: number | null; // sentiment le PLUS négatif (catalyseur structurel ?)
  newsAvgSentiment: number | null; // sentiment moyen
  newsAgeHours: number | null; // ancienneté du plus récent article vs entrée (h)
}

/**
 * Résume les articles news (déjà filtrés ≤ entrée) en features. Pur/testable.
 * `articles` : sentiment_polarity ∈ [-1, 1] (EODHD), publishedAt ISO-8601.
 */
export function summarizeEntryNews(
  articles: { publishedAt: string; sentiment: number | null }[],
  entryIso: string,
): OversoldNewsFeatures {
  const entryMs = new Date(entryIso).getTime();
  const inWindow = articles.filter((a) => {
    const t = new Date(a.publishedAt).getTime();
    return Number.isFinite(t) && t <= entryMs && t >= entryMs - 72 * 3600_000;
  });
  if (inWindow.length === 0) {
    return { newsCount: 0, newsMinSentiment: null, newsAvgSentiment: null, newsAgeHours: null };
  }
  const sents = inWindow.map((a) => a.sentiment).filter((s): s is number => s != null && Number.isFinite(s));
  const newsMinSentiment = sents.length ? Math.min(...sents) : null;
  const newsAvgSentiment = sents.length ? sents.reduce((s, x) => s + x, 0) / sents.length : null;
  const latestMs = Math.max(...inWindow.map((a) => new Date(a.publishedAt).getTime()));
  const newsAgeHours = (entryMs - latestMs) / 3600_000;
  return { newsCount: inWindow.length, newsMinSentiment, newsAvgSentiment, newsAgeHours };
}
