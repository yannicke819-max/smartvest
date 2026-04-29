# EODHD Quick Reference — SmartVest

> P19k.2 — Reference rapide des endpoints EODHD utilisés dans SmartVest.
> Pour la doc complète (72 endpoints, 28 guides), voir `vendor/eodhd-claude-skills/`.
> Plan : ALL-IN-ONE $99.99/mo, 100k calls/jour.
> Auth : `?api_token=$EODHD_API_KEY` query param sur tous les endpoints.

## 0. Suffix mapping (référence absolue)

| Region / Exchange | Scanner code (notre code) | EODHD suffix | Exemple |
|---|---|---|---|
| US (NYSE/NASDAQ/AMEX) | `US` | `.US` | `AAPL.US` |
| US class shares | n/a | `.US` (hyphen) | `BRK-B.US`, `BF-B.US` |
| London | `LSE` | `.LSE` | `SHEL.LSE` |
| Frankfurt XETRA | `XETRA` | `.XETRA` | `BMW.XETRA`, `SAP.XETRA` |
| Frankfurt F | n/a | `.F` (≠ XETRA !) | `BMW.F` |
| Paris | `PA` | `.PA` | `AI.PA`, `MC.PA` |
| Amsterdam | `AS` / `AMS` | `.AS` | `ASML.AS` |
| Swiss | `SW` | `.SW` | `NESN.SW`, `NOVN.SW` |
| Milan | `MI` | `.MI` | |
| Madrid | `MC` / `BME` | `.MC` | |
| Tokyo | `T` / `TSE` | `.T` | `7203.T` (Toyota) |
| Hong Kong | `HK` | `.HK` (leading zeros !) | `0700.HK` Tencent, `9988.HK` Alibaba |
| Korea KOSPI | `KO` | **`.KO`** (PAS `.KOSE`) | `005930.KO` Samsung |
| KOSDAQ | `KQ` | `.KQ` | `035720.KQ` Kakao |
| **Shanghai** | `SS` | **`.SHG`** | `600519.SHG` Moutai |
| **Shenzhen** | `SZ` | **`.SHE`** | `000001.SHE` |
| Toronto | `TO` | `.TO` | `SHOP.TO`, `RY.TO` |
| TSX Venture | n/a | `.V` | `GOLD.V` |
| Sydney ASX | `AU` | `.AU` | `BHP.AU` |
| India NSE | `NSE` | `.NSE` | `RELIANCE.NSE` |
| India BSE | `BSE` | `.BSE` | `TCS.BSE` |
| Forex | n/a | `.FOREX` (no sep) | `EURUSD.FOREX` |
| Crypto | n/a | `.CC` (hyphen) | `BTC-USD.CC` |
| Indices | n/a | `.INDX` | `GSPC.INDX` (S&P), `VIX.INDX` |
| Commodities | n/a | `.COMM` | `BRENT.COMM`, `XAUUSD.COMM` |

⚠️ **2 mappings non-triviaux dans SmartVest** (notre scanner produit le code de gauche, EODHD attend celui de droite) :
- `SS` → `SHG` (Shanghai)
- `SZ` → `SHE` (Shenzhen)

→ Implémenté dans `EodhdIntradayService.normalizeForEodhdIntraday()` (P19k.1).

---

## 1. Intraday OHLCV — `/api/intraday/{SYMBOL}`

**Use case SmartVest** : `MultiTimeframePersistenceService` pour calculer la persistance multi-TF (5/10/15/30/60m).

```
GET https://eodhd.com/api/intraday/{SYMBOL}
  ?api_token={KEY}
  &interval={1m|5m|1h}    (default 5m)
  &fmt=json               (REQUIRED, sinon CSV)
  &from={UNIX_SECONDS}    (optionnel, default last 120 days)
  &to={UNIX_SECONDS}
```

**Time ranges max** : 1m=120 days, 5m=600 days, 1h=7200 days.

**Response shape** :
```json
[
  {"timestamp": 1627911000, "datetime": "2021-08-02 13:30:00",
   "open": 146.36, "high": 146.95, "low": 146.09, "close": 146.42, "volume": 3930530},
  ...
]
```

**Implementation TS** : `apps/api/src/modules/lisa/services/eodhd-intraday.service.ts`.

---

## 2. End-of-Day OHLCV — `/api/eod/{SYMBOL}`

**Use case SmartVest** : `EodhdEnrichmentService` (daily candles pour technical indicators).

```
GET https://eodhd.com/api/eod/{SYMBOL}
  ?api_token={KEY}&fmt=json
  &from=YYYY-MM-DD&to=YYYY-MM-DD     (note : DATE format, pas Unix !)
  &period=d|w|m                       (default d)
```

⚠️ **Différence avec intraday** : `from`/`to` ici sont en `YYYY-MM-DD`, pas Unix seconds.

---

## 3. Real-Time / Live Quote — `/api/real-time/{SYMBOL}`

**Use case SmartVest** : pourrait remplacer le polling par-ticker dans `RealtimePriceService`. Batch jusqu'à 20 symbols en 1 call avec `?s=`.

```
GET https://eodhd.com/api/real-time/{TICKER1}.{EX}
  ?api_token={KEY}&fmt=json
  &s={TICKER2},{TICKER3},...,{TICKER20}    (batch, even tickers from different exchanges)
```

**Response shape** :
```json
{"code":"AAPL.US","timestamp":1735000000,"open":...,"high":...,"low":...,"close":...,"volume":...,"change":...,"change_p":...}
```

→ Source idéale pour les colonnes UI Top 20 (Score / %change / etc.) — beaucoup moins cher qu'intraday.

---

## 4. Stock Screener — `/api/screener`

**Use case SmartVest** : `TopGainersScannerService` (P18c) — sélection candidats Top Gainers.

```
GET https://eodhd.com/api/screener
  ?api_token={KEY}&fmt=json
  &filters=[["exchange","=","us"],["refund_1d_p",">",3],["adjusted_close",">",1],["avgvol_200d",">",100000]]
  &sort=refund_1d_p.desc
  &limit=20
  &offset=0
```

**Filters disponibles** : `exchange`, `refund_1d_p` (1-day %), `adjusted_close`, `avgvol_200d`, `market_capitalization`, `avgvol_50d`, `dividend_yield`, etc.

⚠️ **Pièges** (cf. P18c) :
- `change_p` n'est PAS un filter field valide → utiliser `refund_1d_p`
- `close` n'est PAS valide → utiliser `adjusted_close`
- `exchange` doit être DANS le tableau filters (lowercase), PAS un query param séparé

---

## 5. Fundamentals — `/api/fundamentals/{SYMBOL}`

**Use case SmartVest** : enrichissement Lisa briefing (PE, market cap, sector, balance sheet).

```
GET https://eodhd.com/api/fundamentals/{SYMBOL}?api_token={KEY}&fmt=json
```

Réponse très riche : `General`, `Highlights` (PE, market cap, EPS, dividend), `Valuation`, `Technicals`, `SplitsDividends`, `Earnings`, `Financials.Balance_Sheet`, `Financials.Income_Statement`, `Financials.Cash_Flow`.

---

## 6. Exchange Symbol List — `/api/exchange-symbol-list/{EXCHANGE_CODE}`

**Use case SmartVest** : populate `watchlist_universe` (CAC40, DAX40, FTSE100, NIKKEI, etc.).

```
GET https://eodhd.com/api/exchange-symbol-list/PA?api_token={KEY}&fmt=json
```

Retourne la liste complète des tickers cotés sur l'exchange demandé.

---

## 7. Calendar Earnings — `/api/calendar/earnings`

**Use case SmartVest** : `EodhdCalendarService` pour skip les positions près de earnings.

```
GET https://eodhd.com/api/calendar/earnings
  ?api_token={KEY}&fmt=json
  &from=YYYY-MM-DD&to=YYYY-MM-DD
  &symbols=AAPL.US,MSFT.US,...
```

---

## 8. News API — `/api/news`

**Use case SmartVest** : `NewsAggregatorService` (combiné avec StockTwits / Reddit).

```
GET https://eodhd.com/api/news
  ?api_token={KEY}&fmt=json
  &s={SYMBOL}
  &t={TOPIC}                         (e.g. "monetary policy", "earnings")
  &from=...&to=...&limit=50&offset=0
```

Response : `[{date, title, content, link, symbols, tags, sentiment}]`.

---

## 9. Technical Indicators — `/api/technical/{SYMBOL}`

**Use case SmartVest potential** : remplacer calculs RSI/MACD/EMA maison par EODHD-side compute.

```
GET https://eodhd.com/api/technical/{SYMBOL}
  ?api_token={KEY}&fmt=json
  &function={rsi|macd|ema|sma|atr|bbands|stoch|...}
  &period=14
  &from=YYYY-MM-DD&to=YYYY-MM-DD
```

---

## 10. WebSockets Real-Time — `wss://ws.eodhistoricaldata.com/ws/{TYPE}`

**Use case SmartVest future (P20)** : scanner v2 sub-second au lieu de cron 15min.

```
wss://ws.eodhistoricaldata.com/ws/us         (US trades)
wss://ws.eodhistoricaldata.com/ws/forex
wss://ws.eodhistoricaldata.com/ws/crypto
```

Subscribe via JSON message après auth :
```json
{"action":"subscribe","symbols":"AAPL,MSFT,NVDA"}
```

---

## Auth pattern (TS NestJS)

```ts
import { ConfigService } from '@nestjs/config';

const key = this.config.get<string>('EODHD_API_KEY');
if (!key || key === 'demo') return null;     // Guard cf. P19j boot log

const url = `https://eodhd.com/api/intraday/${encodeURIComponent(symbol)}` +
  `?api_token=${encodeURIComponent(key)}&fmt=json&interval=5m&from=${from}&to=${to}`;

const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
if (!res.ok) {
  this.logger.warn(`[eodhd] ${symbol} HTTP ${res.status}`);
  return null;
}
const data = await res.json();
```

## Logs structurés appliqués (P19j)

- `[eodhd] provider initialized, key=***XXXX (length=N)` — boot
- `[eodhd] X HTTP {status} ({Nms}) body=...` — error (warn)
- `[eodhd] X empty response (Nms)` — empty (debug)
- `[provider-router] yahoo null for X, falling back to EODHD` — chain bascule
- `[provider-router] eodhd OK for X (N candles), coverage=eodhd` — success

## Liens directs

- Skill complet : `vendor/eodhd-claude-skills/skills/eodhd-api/SKILL.md`
- Endpoints : `vendor/eodhd-claude-skills/skills/eodhd-api/references/endpoints/`
- General guides : `vendor/eodhd-claude-skills/skills/eodhd-api/references/general/`
- Workflows : `vendor/eodhd-claude-skills/skills/eodhd-api/references/workflows.md`
- Doc en ligne : https://eodhd.com/financial-apis
