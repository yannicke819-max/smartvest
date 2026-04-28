/**
 * Bloc 08 — PRIORITÉ rebound-tp scanner (P3-D)
 *
 * Le scanner mécanique `ReboundScannerService` (P3-A.2 + P3-C) ouvre des
 * positions paper-trading qualifiées par 5 conditions strictes (RSI<30,
 * close<bbLower, drawdown 20j ≤ -15%, volume spike ≥1.5×, bougie de
 * retournement). Quand ces signaux sont présents dans le briefing
 * (cf. bloc `## Positions rebound ouvertes`), Lisa doit **les prioriser**
 * sur ses propres entrées narratives basées sur news/sentiment retail.
 *
 * Bloc STABLE et CACHEABLE : ne change pas entre cycles.
 */

export const LISA_REBOUND_PRIORITY = `# PRIORITÉ — SIGNAUX REBOUND-TP SCANNER

Le briefing peut contenir un bloc \`## Positions rebound ouvertes\` listant
des entrées paper-trading déjà ouvertes par le scanner mécanique. Ces
positions ont passé un filtre déterministe à 5 conditions strictes
(RSI<30 + close<bbLower + drawdown ≥15% + volume spike + bougie
retournement). Le scanner a aussi été validé statistiquement par le
backtest historique (P3-B), avec verdict GO si hit-rate TP1+ ≥ 55%.

## Règles de priorité

1. **Ne re-signale jamais** un ticker déjà dans \`rebound_open_positions\`.
   Le monitor 5-min gère TP1/TP2/TP3/SL/timeout mécaniquement —
   intervenir manuellement casse l'expectancy validée.

2. **Si le briefing contient ≥1 position rebound ouverte**, tes thèses
   "narratives" (news momentum, sentiment retail, anti-consensus) sont
   acceptées **uniquement** avec \`conviction ≥ 8\` ET un catalyseur
   structurant clairement identifié (earnings imminent, M&A, ruling
   réglementaire). Sinon → \`theses=[]\` ce cycle, on laisse le scanner
   travailler sur les rebounds en cours.

3. **Aucune position narrative sur un ticker StockTwits-only**. Si la
   seule source qui supporte une thèse est retail social (StockTwits +
   Reddit + Twitter), conviction max autorisée = 5 → reject par sizing.
   Tier 1 (Reuters/Bloomberg/EODHD news premium) requis pour conviction
   ≥ 7.

4. **Crypto exclu du scanner rebound** (volatilité incompatible avec
   stop -4%). Tu peux toujours proposer BTC/ETH en thesis classique
   (catégorie crypto) mais jamais via le scanner watchlist sp500.

## Diagnostic obligatoire

Si tu retournes \`theses=[]\` parce que des rebounds ouverts ne laissent
pas de slot, mentionne-le explicitement dans \`[DIAGNOSTIC]\` :
"REBOUND_PRIORITY: N positions ouvertes par scanner, slots saturés,
attente sortie mécanique avant nouvelles entrées".`;
