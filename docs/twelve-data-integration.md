# TwelveData integration (PR #342 POC)

Service `TwelveDataService` (lecture seule) qui fournit les indicateurs natifs
TwelveData (Supertrend, RSI, ATR) en complément d'EODHD / Binance.

## Plan TwelveData actuel

- **Basic gratuit** : 800 credits/jour, 8 credits/minute
- Dashboard : https://twelvedata.com/account/api-keys
- Trial Pro $229/mois prévu au 25 mai si POC concluant
- Décision GO/NO_GO Pro le 1er juin selon métriques de gain mesurées

## Configuration

Pose la clé sur Fly secrets (NE PAS commit) :

```bash
flyctl secrets set TWELVEDATA_API_KEY=xxxxxxxx -a smartvest
```

Sans clé, le service warn une fois au boot et toutes les méthodes retournent
`null` (zéro impact runtime). Pattern défensif identique à `EodhdIntradayService`
quand `EODHD_API_KEY` est absent.

## Rate-limiter interne `CreditTracker`

Le service tient ses propres compteurs (marge vs limites officielles) :

| Limite TwelveData | Cap interne service | Raison |
|---|---|---|
| 8 credits/min | **7 credits/min** | Marge 12 % vs HTTP 429 |
| 800 credits/jour | **750 credits/jour** | Marge 6 % vs cap dur |

Au-delà du cap interne, le service ne fait **aucun appel HTTP** et retourne
`null` silencieusement (log warn). Logged aussi dans `twelve_data_request_log`
avec `error_message='rate_limit_internal'`.

## Activation des consumers

Les 2 consumers POC sont gated par feature flag, default **OFF** :

```bash
# Filtre Supertrend 30min sur us_equity_large (REJECT si direction=down)
# Coût estimé : ~50 appels/jour
flyctl secrets set QUICK_WINS_TWELVEDATA_SUPERTREND_US_LARGE=true -a smartvest

# Filtre RSI overbought (>75) sur 10 paires crypto
# Coût estimé : ~150 appels/jour
flyctl secrets set QUICK_WINS_TWELVEDATA_RSI_CRYPTO=true -a smartvest
```

**Note** : l'intégration scanner (qui consomme `TwelveDataService` selon ces
flags) sera livrée dans une PR de suivi. Le présent PR #342 ship uniquement
le service + tests + migration log. Avec les flags OFF (ou la clé absente),
ce PR n'a aucun impact runtime.

## Monitoring

Toutes les requêtes sont loguées dans `twelve_data_request_log` (Supabase,
migration 0144). Query d'audit type :

```sql
-- Usage daily groupé par consumer
SELECT
  DATE(timestamp) AS jour,
  called_by,
  COUNT(*) AS calls,
  COUNT(*) FILTER (WHERE success) AS ok,
  COUNT(*) FILTER (WHERE NOT success) AS errors,
  COUNT(*) FILTER (WHERE error_message = 'rate_limit_internal') AS rate_limited,
  SUM(credits_used) AS credits_consumed,
  ROUND(AVG(latency_ms)::numeric, 0) AS avg_latency_ms
FROM twelve_data_request_log
WHERE timestamp >= NOW() - INTERVAL '7 days'
GROUP BY jour, called_by
ORDER BY jour DESC, calls DESC;
```

Logs JSON structurés sur stdout (compatibles VictoriaLogs grep) :

```
{"event":"twelvedata_call","endpoint":"rsi","symbol":"BTC/USD","interval":"5min",
 "status":"ok","credits_used":1,"latency_ms":234,"daily_usage":42}
```

## Mapping crypto Binance → TwelveData

Helper statique `TwelveDataService.binanceToTwelveDataCrypto()` :

| Binance pair | TwelveData symbol |
|---|---|
| `BTCUSDT` | `BTC/USD` |
| `ETHUSDC` | `ETH/USD` |
| `POLUSDT` | `POL/USD` |
| `BNBBUSD` | `BNB/USD` |
| (pair invalide) | `null` |

Source TwelveData crypto : Coinbase Pro (fonctionne 24/7, données fraîches même
weekend — contrairement à Binance REST qui retourne souvent vide hors heures
de pointe US).

## Couverture plan Basic vs Pro

| Asset class | Basic | Pro |
|---|---|---|
| Actions US + ETFs | ✅ | ✅ |
| Crypto (Coinbase Pro) | ✅ | ✅ |
| Forex | ✅ | ✅ |
| Actions EU | ❌ | ✅ |
| Actions Asia (.KO, .HK, .T, ...) | ❌ | ✅ |
| Commodities | ❌ | ✅ |

Quand on appelle un symbole non couvert (ex `005930.KO` en Basic), TwelveData
renvoie `{"code":404,"message":"...Pro plan..."}` que le service détecte et
log explicitement `TwelveData: plan upgrade required for symbol X`. Le caller
reçoit `null` sans crash.

## Erreurs gérées

| Cas | Comportement |
|---|---|
| Clé absente | warn boot + return null |
| Rate limit interne (>7/min ou >750/jour) | warn + return null + log Supabase |
| HTTP 429 | retry 1× après 8s, sinon null |
| HTTP 5xx ou timeout | retry 1× après 2s, sinon null |
| HTTP 4xx (non-429) | log warn + return null (pas de retry) |
| Réponse `code:404` "Pro plan" | log error explicite + return null |
| Parsing valeurs invalides | return null silencieux |

Toutes les méthodes retournent `null` au lieu de throw — fallback gracieux
pour les callers pipeline (un null = "pas de signal Supertrend disponible →
laisser passer", comme pour les sources EODHD).
