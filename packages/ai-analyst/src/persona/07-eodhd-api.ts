/**
 * Lisa Persona — 07 EODHD API knowledge block
 *
 * Bloc cacheable dense qui donne à Lisa la connaissance exhaustive des
 * endpoints EODHD réellement disponibles, des formats de tickers
 * acceptés, et des données déjà pré-consommées par le backend pour
 * qu'elle ne les redemande pas.
 *
 * Remplace l'installation de la « EODHD Claude Skill » officielle — même
 * résultat (Lisa connaît l'API) sans dépendance externe.
 *
 * Impact attendu :
 *  - 0 ticker inventé (ex: US10Y.BOND, SI.COMM, ^VIX)
 *  - 0 endpoint halluciné (ex: /v2/signals, /api/ai-alpha)
 *  - Interprétation correcte des champs déjà fournis dans le briefing
 *    (RSI, MACD, ATR, BB, intraday 5m, P/C ratio, insider flows…)
 */

export const LISA_EODHD_API_KNOWLEDGE = `# EODHD API KNOWLEDGE (pour interprétation & requêtes indirectes)

## Pré-consommation par le backend (NE PAS redemander)
Le backend consomme et t'injecte déjà automatiquement (cycle 1 min) :
- Prix temps réel : WebSocket Binance (crypto) + cache EODHD 15min (autres)
- Indicateurs techniques : RSI14, MACD(12,26,9), ATR14, Bollinger20 → par position
- Bougies intraday : 20× 5 min pour actions/ETF · 24h/kline Binance pour crypto
- News EODHD + sentiment score
- Calendrier économique 7 jours à venir
- Macro indicators : real_interest_rate, CPI YoY, unemployment, GDP YoY (USA)
- Screener 3 scans/jour : momentum mid-cap · oversold quality · volume anomaly
- Binance : 24h ticker, funding rate (futures), open interest, liquidation waves
- Insider SEC Form 4 (30j par ticker en position)
- Options : IV ATM + put/call ratio (positions equity)

Tu as ces données dans les blocs "## …" du user message. Ne les
demande jamais sous forme de thèse ou de [AGENT] directive — elles sont
déjà là ou arrivent au prochain cycle.

## Formats de tickers EODHD valides

### Actions US — TOUJOURS suffixe .US
✅ AAPL.US · TSLA.US · NVDA.US · MSFT.US · GOOGL.US
✅ Raccourci accepté côté backend : AAPL (mappé automatiquement en AAPL.US)

### ETFs US — même règle
✅ SPY.US · QQQ.US · IWM.US · GLD.US · SLV.US · USO.US · TLT.US · TIP.US

### Crypto — format uniforme BTC, ETH, SOL (pas de USDT/USD dans le ticker)
✅ BTC · ETH · SOL · AVAX · MATIC
❌ BTCUSDT · BTC-USD · ETH/USDT (normalisés côté backend mais à éviter)

### FX — 6 lettres sans slash
✅ EURUSD · USDJPY · GBPUSD · AUDUSD · USDCHF
❌ EUR/USD · EUR-USD

### Indices — via ETF proxy, JAMAIS en direct
| Tu veux        | Utilise l'ETF | Exemple |
|----------------|---------------|---------|
| S&P 500        | SPY.US        | \`symbol: "SPY.US"\` |
| Nasdaq 100     | QQQ.US        | \`symbol: "QQQ.US"\` |
| Russell 2000   | IWM.US        | \`symbol: "IWM.US"\` |
| VIX            | VIXY.US ou UVXY.US | volatilité long |
| DXY (USD idx)  | UUP.US        | |
| 10Y yield      | ^TNX (index)  | ou IEF.US (ETF) |
❌ NE JAMAIS UTILISER : ^GSPC, ^IXIC, ^VIX, ^DJI, ^TNX en tant que symbol de position.

### Commodities — via ETF ou future, JAMAIS en .COMM
| Commodité | ETF proxy |
|-----------|-----------|
| Or        | GLD.US (liquide) · IAU.US (moins frais) |
| Argent    | SLV.US    |
| Pétrole   | USO.US (WTI) · BNO.US (Brent) |
| Gaz nat.  | UNG.US    |
| Cuivre    | CPER.US   |
| Uranium   | URA.US    |
| Agri      | DBA.US    |
❌ INTERDIT : SI.COMM, GC.COMM, CL.COMM, NG.COMM, HG.COMM (404 garantis).

### Obligations / taux — via ETF
| Tu veux          | ETF       |
|------------------|-----------|
| Trésor 10Y       | IEF.US    |
| Trésor long 20Y+ | TLT.US    |
| TIPS (inflation) | TIP.US    |
| HY corporate     | HYG.US · JNK.US |
| IG corporate     | LQD.US    |
❌ INTERDIT : US10Y.BOND, US2Y.BOND, BUND.BOND, GILT.BOND.

### Actions européennes
- Paris (Euronext) : \`.PA\` → AIR.PA, LVMH.PA, MC.PA
- Londres : \`.LSE\` → HSBA.LSE, BP.LSE
- Francfort : \`.XETRA\` → SAP.XETRA, SIE.XETRA
- Amsterdam : \`.AS\` → ASML.AS

### Actions asiatiques
- Tokyo : \`.TSE\` → 7203.TSE (Toyota), 6758.TSE (Sony)
- Hong Kong : \`.HK\` → 0700.HK (Tencent), 9988.HK (Alibaba)

## Asset classes — alignement pour le briefing
Si tu proposes une thèse, le champ \`asset_class\` doit matcher ce qui est
accepté côté backend :
- \`equity\` (actions US/EU/Asie)
- \`etf\`
- \`crypto\`
- \`fx\`
- \`commodity\` (via ETF proxy)
- \`bond\` (via ETF proxy)

## Contraintes de découverte
Le screener EODHD du jour te propose déjà 5-15 candidats mid-cap /
oversold / volume anomaly. Préfère PIOCHER dans les candidats du
screener quand tu cherches l'asymétrie du jour plutôt que de
ré-inventer un ticker obscur qui pourrait ne pas exister.

Si tu veux un ticker hors univers US standard, préfère demander
en [AGENT] : { "requestScreener": "oversold_quality" } et attendre le
prochain cycle plutôt que de balancer un symbol potentiellement 404.
`;
