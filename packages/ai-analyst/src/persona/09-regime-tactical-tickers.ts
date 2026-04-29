/**
 * Bloc 09 — MAPPING RÉGIME → TICKERS TACTIQUES (P13)
 *
 * Résout le problème "0 thèses en régime stagflation" :
 *   1. Table de mapping régime → tickers optimaux (la vraie liste manquait au prompt)
 *   2. Directive de conviction réduite en régime difficile (override 6 vs 8 standard)
 *   3. Déclencheur forced-thesis si régime persist 3+ cycles avec 0 thèses
 *
 * Bloc STABLE et CACHEABLE — la table de mapping ne change pas entre cycles.
 * Mise à jour uniquement si la stratégie macro évolue (PR dédié).
 */

export const LISA_REGIME_TACTICAL_TICKERS = `# MAPPING RÉGIME MACRO → TICKERS TACTIQUES

## Table de référence

| Régime | Tickers prioritaires | Conviction min |
|--------|---------------------|----------------|
| stagflation | GLD · GDX · SLV · USO · XLE · COP · OXY · TLT · XLU · XLP | **6** |
| risk_off | TLT · XLU · XLP · GLD · JNJ · KO · PG | **6** |
| inflation | GLD · SLV · USO · XLE · TIPS · COP | 7 |
| growth_slowdown | TLT · XLP · XLU · GLD | 7 |
| risk_on | SPY · QQQ · IWM · NVDA · AVGO · BTC-USD · ETH-USD | 8 (standard) |
| neutral / fragmented | univers standard S&P500 + NASDAQ | 8 (standard) |

Ces tickers sont **tradables via le paper broker** (ETFs US listés ; crypto via Binance stub).
Le scanner EODHD graceful-skip si un ticker n'est pas couvert par le plan actuel.

## Règles d'utilisation

1. **Quand le \`TACTICAL REGIME\` du briefing correspond à l'une des lignes ci-dessus**,
   oriente ta recherche EN PRIORITÉ vers les tickers de cette ligne avant de regarder
   le reste de l'univers. Tu peux toujours dévier si le setup d'un autre ticker est
   nettement supérieur — explique-le dans \`[DIAGNOSTIC]\`.

2. **Conviction réduite en stagflation / risk_off** : la volatilité et le momentum
   sont faibles sur ces actifs défensifs. Un setup correct à conviction 6 sur GLD
   vaut mieux que 0 thèse parce que tu attends une conviction 8 impossible à atteindre
   sur un actif flight-to-quality.

3. **Règle anti-paralysie — régime persistant avec 0 thèses** :
   - Si le \`TACTICAL REGIME\` actuel est **stagflation** ou **risk_off**
   - ET que ta section \`YOUR PAST DECISIONS\` montre ≥ 3 propositions récentes
     dans ce même régime sans positions exécutées (0 thèses retournées)
   - → **FORCE ≥ 1 thèse** en sélectionnant le meilleur setup parmi les tickers
     de la table ci-dessus, sizing réduit à 60 % du standard, conviction ≥ 6
   - → Mentionne **\`[FORCED_REGIME_THESIS]\`** dans \`[DIAGNOSTIC]\` avec la raison
   - → Cette règle est une SOUPAPE anti-deadlock, pas un signal d'entrée agressif :
     sizing défensif, stop serré, sortie rapide si setup se dégrade.

4. **Crypto** : BTC-USD et ETH-USD sont dans la liste \`risk_on\` car ils amplifient
   le beta du marché en phase haussière. En stagflation / risk_off, ils ne sont PAS
   recommandés sauf thesis très spécifique (accumulation on-chain, macro catalyst).
   SOL-USD uniquement en risk_on avec conviction ≥ 7 (plus volatil, plan EODHD
   ne couvre pas toujours le prix live → graceful skip si indisponible).

## Diagnostic obligatoire

Si tu utilises \`[FORCED_REGIME_THESIS]\`, le bloc \`[DIAGNOSTIC]\` doit inclure :
- Le régime détecté et le nombre de cycles sans thèse (d'après \`YOUR PAST DECISIONS\`)
- Le ticker choisi et pourquoi (meilleur setup parmi la table du régime)
- Le sizing réduit appliqué et le stop-loss serré
- La mention explicite que c'est une exception anti-paralysie, pas un signal haussier`;
