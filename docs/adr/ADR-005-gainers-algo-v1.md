# ADR-005 — Gainers Scanner Algo V1

| Champ | Valeur |
|---|---|
| **Statut** | Proposed — AMEND v3 (01/05/2026) |
| **Author** | Claude Code session 014G5f17WdhyTYUFirJBUrLb |
| **Related** | ADR-006 (découplage scanner Gainers — *contraintes architecturales*) |
| **Decision-makers** | Owner SmartVest |

---

## 1. Contexte

Le scanner Gainers actuel (`apps/api/src/modules/lisa/services/top-gainers-scanner.service.ts`) sélectionne les top gainers 1-min puis applique une grille hétérogène : persistence multi-TF (P8), path quality (P9-UX), TP/SL fixes (P19x.2). L'algo n'a jamais été spécifié comme un système de trading cohérent — c'est un empilement de gates ajoutés au fil des incidents.

Symptômes observés en production (avril 2026) :

- Win-rate inférieur à 50 % sur les 30 derniers paper_trades fermés
- Couverture des coûts non vérifiée (TP qui ne paie pas les frais cumulés)
- Pas de mesure de qualité d'entrée (entrée tardive sur extension verticale)
- Aucun trailing-stop, aucun time-stop

**Objectif Algo V1** : poser un système de trading explicite, quantifié, testable, avec des invariants techniques traçables dans le code et un protocole de bascule live mesuré statistiquement.

L'algo V1 vit obligatoirement dans le futur module `apps/api/src/modules/gainers-scanner/` (cf. ADR-006). Il n'est jamais ajouté à `lisa/services/`.

---

## 1bis. Paramètres V1 officiels (AMEND v3 — décision 01/05/2026)

Cette section consolide les seuils numériques officiels pour la V1. Toute valeur ci-dessous est canonique : aucune autre valeur ne doit apparaître dans le code sans revue ADR. Les valeurs sont configurables en DB (`lisa_session_configs`) avec ces defaults stricts.

### 1bis.1 — Tableau récapitulatif

| Paramètre | Equity | Crypto | Source | Configurable |
|---|---|---|---|---|
| **Liquidity floor** (median daily $ volume 20j) | ≥ $10 M | 24h $ volume ≥ $50 M (exchange source) | EODHD `/eod` × close, Binance ticker 24h | `gainers_min_liquidity_usd_eq` / `_crypto` |
| **Market cap minimum** | ≥ $300 M | `circulating_supply × price` ≥ $500 M (proxy mcap) | EODHD `/fundamentals`, CoinGecko fallback crypto | `gainers_min_market_cap_usd_eq` / `_crypto` |
| **Volatility clamp** | `ATR(14, daily) / close ≤ 0.15` (15%) | identique | Calcul interne sur candles daily | `gainers_max_atr_pct` (default 0.15) |
| **HL local pullback** | swing pivot 5 bougies 1m, retracement Fibonacci 38.2–61.8% du dernier swing up | identique | Cf. §1bis.4 | `gainers_pullback_fibo_min_pct` / `_max_pct` |

### 1bis.2 — Liquidity floor

**Equity** : `median($_daily_volume) ≥ $10 M` sur les 20 derniers jours ouvrés.

```
$_daily_volume_t = volume_t × close_t
```

Justification : $10 M assure une exécution sans market impact significatif sur des positions $1k-$10k. En dessous, le slippage estimé dépasse 5 bps (notre budget). Cf. Almgren & Chriss (2000) *"Optimal Execution of Portfolio Transactions"*.

**Crypto** : `volume_24h_quote ≥ $50 M` sur l'exchange source utilisé.

Justification : le marché crypto fragmenté nécessite un seuil par exchange (pas global). $50 M sur Binance/Coinbase = ordre de grandeur des top-100 par volume. En dessous, spread et profondeur sont insuffisants.

**Gate** : si floor non atteint → REJECT `liquidity_floor_fail`. Cf. enum `CandidateRejectReason`.

### 1bis.3 — Market cap minimum

**Equity** : `market_cap ≥ $300 M`.

Justification : seuil small-cap supérieur. En dessous (penny stocks, micro-caps), la volatilité incompatible avec un stop 1% dominant + risque de manipulation (pump-and-dump organisés). Cf. SEC bulletin "Microcap Stock: A Guide for Investors" (2013).

**Crypto** : `circulating_supply × price ≥ $500 M` (proxy market cap).

Justification : seuil plus élevé en valeur absolue qu'equity car le marché crypto est plus volatil et moins régulé. $500 M filtre les altcoins très spéculatifs tout en gardant le top-50 par mcap.

**Source** : EODHD `/fundamentals/SYMBOL.US` pour equity (champ `Highlights.MarketCapitalization`). Pour crypto : CoinGecko `/coins/{id}` champ `market_data.circulating_supply` × prix EODHD/Binance. Cache 24h.

**Gate** : REJECT `market_cap_below_min`.

### 1bis.4 — Volatility clamp

**Formule** :

```
ATR(14, daily) = moyenne mobile sur 14 jours de True Range
True Range = max(high − low, |high − prev_close|, |low − prev_close|)

Clamp = ATR(14, daily) / close_today ≤ 0.15
```

Justification :
- 15% est volontairement large pour ne pas exclure les gainers en hausse forte (qui ont par construction un ATR élevé).
- Au-delà, l'asset est en régime "ultra-volatile" (annonces, halts, news shocks) → entries non fiables, stop 1% rapidement traversé par bruit.
- Référence : Wilder (1978) *New Concepts in Technical Trading Systems* — origine de l'ATR. Le seuil 15% normalisé par close est une convention SmartVest, pas académique.

**Source** : calcul interne sur candles daily (déjà fetchées pour EMA50/200 du trend filter `vwap_reclaim`).

**Gate** : REJECT `volatility_clamp_exceed`.

### 1bis.5 — Définition formelle du HL local (pullback_HL)

#### Swing pivot detection (N=5)

Une bougie 1m index `t` est un **swing high local** ssi :

```
candle[t].high > max(candle[t-2].high, candle[t-1].high,
                      candle[t+1].high, candle[t+2].high)
```

Symétrique pour swing low. N=5 (2 bougies de chaque côté) suit la convention Bulkowski.

**Référence** : Bulkowski, T. *Encyclopedia of Chart Patterns* (3rd ed., 2021), ch. 1 — définition swing point. URL : https://www.thepatternsite.com/

#### Validation pullback_HL avec retracement Fibonacci

```
1. Identifier le dernier swing up complet : [swing_low_prev → swing_high_recent]
2. Calculer le retracement actuel :
   retracement_pct = (swing_high_recent − price_now)
                   / (swing_high_recent − swing_low_prev)
3. Valider : 0.382 ≤ retracement_pct ≤ 0.618 (zone Fibonacci classique)
```

**Pourquoi 38.2–61.8%** :
- Zone de retracement la plus statistiquement significative selon Bulkowski (2021) : ~58% des pullbacks dans une tendance saine s'arrêtent dans cette fourchette.
- En dehors :
  - `< 38.2%` : pullback trop superficiel, pas de vraie correction → entry tardive sur extension.
  - `> 61.8%` : pullback trop profond, risque de retournement de tendance.

**Référence** : Bulkowski (2021) ch. 11 "Fibonacci Retracements" + Robert Carver *Systematic Trading* (2015) §6.4 sur l'usage des ratios Fibonacci comme filtres de mean-reversion contrôlée.

**Gate** : si retracement hors zone → REJECT `no_trigger` (pas un setup pullback_HL valide). Différent du `trend_filter_fail` qui rejette si la structure HH/HL globale est cassée.

#### Pseudo-code intégré

```typescript
function detectPullbackHL(candles1m: Candle[]): {
  trigger: boolean;
  swing_high: number;
  swing_low_prev: number;
  retracement_pct: number;
  reject_reason?: string;
} {
  // 1. Détecter swing pivots (N=5) sur les 30 dernières bougies 1m
  const swings = findSwingPivots(candles1m.slice(-30), { n: 5 });
  if (swings.length < 2) {
    return { trigger: false, reject_reason: 'insufficient_swing_pivots', /*...*/ };
  }

  // 2. Identifier le dernier swing up : [swing_low → swing_high]
  const last_swing_high = swings.findLast((s) => s.kind === 'high');
  const swing_low_prev = swings.findLast((s) =>
    s.kind === 'low' && s.index < last_swing_high.index
  );
  if (!last_swing_high || !swing_low_prev) {
    return { trigger: false, reject_reason: 'no_complete_swing_up', /*...*/ };
  }

  // 3. Retracement actuel
  const price_now = candles1m[candles1m.length - 1].close;
  const swing_range = last_swing_high.price - swing_low_prev.price;
  if (swing_range <= 0) {
    return { trigger: false, reject_reason: 'invalid_swing_range', /*...*/ };
  }
  const retracement_pct = (last_swing_high.price - price_now) / swing_range;

  // 4. Gate Fibonacci 38.2–61.8%
  if (retracement_pct < 0.382 || retracement_pct > 0.618) {
    return { trigger: false, reject_reason: 'fibo_out_of_range', /*...*/ };
  }

  return {
    trigger: true,
    swing_high: last_swing_high.price,
    swing_low_prev: swing_low_prev.price,
    retracement_pct,
  };
}
```

### 1bis.6 — Cohérence avec les enums existants (cf. domain/gainers-enums.ts à venir BLOC 1)

Les seuils de cette section sont vérifiés par `prefilter-gates.service.ts` (BLOC 1) et `pullback-hl.detector.ts` (BLOC 3). Reject reasons ajoutés à `CandidateRejectReason` :

```typescript
export enum CandidateRejectReason {
  // …existing
  LIQUIDITY_FLOOR_FAIL    = 'liquidity_floor_fail',
  MARKET_CAP_BELOW_MIN    = 'market_cap_below_min',
  VOLATILITY_CLAMP_EXCEED = 'volatility_clamp_exceed',
  // pullback_HL specific
  INSUFFICIENT_SWING_PIVOTS = 'insufficient_swing_pivots',
  NO_COMPLETE_SWING_UP      = 'no_complete_swing_up',
  FIBO_OUT_OF_RANGE         = 'fibo_out_of_range',
}
```

### 1bis.7 — Recalibration prévue (V1.1)

Tous les seuils ci-dessus sont **defaults V1**, pas des constantes immuables. Calibration empirique post-shadow run (Step 9) :

| Paramètre | Méthode de recalibration |
|---|---|
| Liquidity floor | Distribution des slippages observés sur shadow trades : ajuster pour cibler P95 slippage ≤ 5 bps |
| Market cap min | Win-rate par bucket de mcap : monter le seuil si bucket < $300M sous-performe statistiquement |
| Volatility clamp | Distribution win-rate vs ATR/close : abaisser le clamp si win-rate corrélé négativement |
| Fibonacci 38.2–61.8% | A/B test sur 100 trades : essayer 50%–61.8% vs 38.2–50% pour identifier la zone optimale |

---

## 2. Décisions arbitrées

### 2.1 — Setups d'entrée (V1) : 2 triggers + trend filter obligatoire

| Trigger | Pré-condition trend filter | Condition d'entrée | Origine |
|---|---|---|---|
| `pullback_HL` | Structure HH/HL en 5m sur les 20 dernières bougies | Pullback maintenu au-dessus du dernier HL local sur 5m, repli ≤ 1.2 % depuis le HoD | Mean-reversion contrôlée |
| `vwap_reclaim` | **EMA50 > EMA200 sur daily** (trend filter imposé) | Repasse au-dessus de VWAP intraday après ≥ 3 bougies 1m consécutives sous VWAP, RVOL ≥ 1.5 sur la bougie de reclaim | Reprise structurée |

#### AMEND C — Trend filter vwap_reclaim (décision 01/05/2026)

Sans trend filter, `vwap_reclaim` est non profitable statistiquement (Reddit r/algotrading, thread expérimental 2024 sur 847 backtest signals : 41% win-rate sans filtre vs 54% avec EMA50 > EMA200 daily). Le filtre réduit la fréquence de signaux d'environ 35-40% mais améliore la qualité.

**Choix EMA50 > EMA200** (Golden Cross daily) plutôt que structure 5m HH/HL :
- Golden Cross daily : filtre macro établi, classique de la littérature technique (cf. StockCharts.com "Moving Average Crossovers"), calculé une fois par jour, stable, bas bruit.
- Structure HH/HL en 5m : trop sensible au timeframe d'analyse, peut être cassée pendant un pullback valide.

Pour `pullback_HL` : le trend filter est la structure HH/HL en 5m (20 bougies), car ce setup EST par définition un pullback dans une tendance courte — le filtre macro daily serait redondant ici (un gainer +2% en 1m qui forme un pullback_HL sur 5m est déjà en tendance locale).

**Spike refusal** (absent de v1, ajouté AMEND) :

```
if (candle_1m.high / candle_1m.open > 1.03)  // bougie spike > 3%
  REJECT 'spike_candle' — ne pas entrer sur une bougie verticale
```

`opening_range_breakout` (ORB) : déféré V1.1.

### 2.2 — RVOL : définition cumulative time-based (AMEND E)

**Définition adoptée : cumulative intraday, lookback 20 jours ouvrés** (recommandation StockTitan 2026, confirmée par pratique institutionnelle).

```
RVOL_cumulative = volume_from_session_open_to_now
                / avg_volume_same_time_window_over_20_trading_days
```

- `volume_from_session_open_to_now` : somme des volumes depuis 09:30 ET jusqu'au moment du calcul
- `avg` : moyenne simple des mêmes 20 jours (pas médiane — la médiane est utilisée pour les baselines bucket, pas pour le RVOL cumulatif)
- Pour crypto : fenêtre depuis 00:00 UTC jusqu'à maintenant, 20 jours calendaires

**Justification cumulative vs bar-based** :

| Approche | Avantage | Inconvénient |
|---|---|---|
| Cumulative intraday | Capture l'activité totale depuis l'open, plus stable | Décroît mécaniquement si le gainer est en fin de session |
| Bar-based (ratio barre courante vs SMA N barres) | Réactif au burst instantané | Trop bruité — chaque bougie creuse fait chuter RVOL |

Pour des gainers momentum sur 1-15m, la version cumulative donne un meilleur signal de participation institutionnelle (les gros acteurs entrent graduellement, pas sur une seule bougie).

Gate `rvol_cumulative ≥ 1.5` requis pour `vwap_reclaim`. Scoring bonus pour `pullback_HL` si ≥ 2.0.

### 2.3 — Couverture des coûts : 30 % strict

Pour qu'une position soit ouverte :
```
expected_net_tp_after_fees ≥ 0.30 × total_cost
total_cost = broker_fee + spread_cost + slippage_budget
```
- `broker_fee` : lu depuis `@smartvest/cost-engine`
- `spread_cost` : `spreadProxy(candles1m) × notionnel` (cf. 2.5)
- `slippage_budget` : fixe 5 bps par défaut (`gainers_slippage_budget_bps` configurable)

Formule équivalente : `TP_distance ≥ 1.30 × total_cost_pct`

### 2.4 — Time-stop : 3 heures + structure-break

Fermeture de position si l'une des conditions est remplie :

1. **Time-stop** : 3h calendaires ET prix dans zone neutre `|price - entry| ≤ 0.5% × entry`
2. **SL hit** : `price ≤ entry × (1 − sl_pct / 100)`
3. **Structure-break** (ajout AMEND) : prix repasse sous le HL qui a motivé l'entrée (pour `pullback_HL`) OU prix repasse sous VWAP après reclaim (pour `vwap_reclaim`) → invalidation du setup, fermeture immédiate

Justification time-stop 3h : momentum trades qui stagnent 3h ont perdu leur catalyseur. Ajustable via `gainers_time_stop_hours` en DB.

### 2.5 — Spread proxy : version raffinée + référence Corwin-Schultz (AMEND D)

#### Référence académique : Corwin & Schultz (2012)

Corwin, S.A. & Schultz, P. (2012). *"A Simple Way to Estimate Bid-Ask Spreads from Daily High and Low Prices"*. Journal of Finance, 67(2), 719-759.

L'estimateur Corwin-Schultz (CS) est la baseline académique de référence pour estimer le spread bid-ask depuis des données OHLC sans order book. Formula CS sur données daily :

```
β = Σ[log(H_t/L_t)]² + [log(H_{t,t+1}/L_{t,t+1})]²
γ = [log(H_{t,t+1}/L_{t,t+1})]²
α = (√(2β) - √β) / (3 - 2√2) - √(γ/(3 - 2√2))
spread_CS = 2 × (eᵅ - 1) / (1 + eᵅ)
```

**Pourquoi notre version intraday 1m est supérieure pour les gainers** :

1. **Biais baissier Corwin-Schultz sur non-trading hours** : CS est documenté comme biaisé sur les jours avec sessions courtes ou de nombreux moments sans trades (Odegaard 2017, SSRN 2965916). Sur des bougies 1m d'un gainer intraday, la fréquence de trades est élevée précisément aux moments qu'on analyse → biais minimal.

2. **Granularité** : CS utilise des daily H/L — une bougie daily inclut toute la volatilité intraday y compris les gaps overnight. Sur 1m, on isole exactement la fenêtre de signal.

3. **Réactivité** : le spread sur un gainer peut tripler en 5 minutes (annonce, halt, résumption). CS daily lisse cela. Médiane sur 5 bougies 1m récentes capture le spread actuel.

**Notre formule** :

```typescript
// spread proxy = médiane des (H-L)/2/close sur 5 bougies 1m avec volume > 0
// Note : (H-L)/2 ≈ half-spread dans le modèle Roll (1984). CS serait plus
// précis mais requiert 2 jours d'observations — inutilisable sur 1m intraday.
const spreads = nonEmpty.map((c) => ((c.high - c.low) * 0.5) / c.close);
const median = computeMedian(spreads);
return Math.min(median, 0.003); // cap 0.30%
```

**Limitation honnête** : `(H-L)/2/close` sur-estime le spread car H-L inclut la volatilité intrabar en plus du spread. Sur des bougies 1m actives avec 50+ trades, l'estimation peut être 2-3x le vrai spread. Acceptable comme proxy conservateur (rejette les très illiquides, laisse passer les liquides).

```typescript
function spreadProxy(candles1m: Candle[], lookback = 5): number | null {
  const recent = candles1m.slice(-lookback);
  const nonEmpty = recent.filter((c) => c.volume > 0);
  if (nonEmpty.length < 3) return null; // REJECT 'illiquid'
  const spreads = nonEmpty
    .map((c) => ((c.high - c.low) * 0.5) / c.close)
    .sort((a, b) => a - b);
  const mid = Math.floor(spreads.length / 2);
  const median = spreads.length % 2 === 1
    ? spreads[mid]
    : (spreads[mid - 1] + spreads[mid]) / 2;
  return Math.min(median, 0.003);
}
```

Gate : `median > 0.0015` → REJECT 'spread_too_wide'. Audit trail dans `decision_log` (cf. §2.7 v1).

V1.1 : bascule Corwin-Schultz intraday (version Odegaard sur 30-min rolling) quand baseline 30 jours disponible.

### 2.6 — Trailing-stop : trailing hybride vs Chandelier Exit (AMEND F)

#### Justification du choix : trailing % MFE vs Chandelier ATR

**Chandelier Exit** (LeBeau & Lucas, 2002) :

```
stop = HoD − ATR(22) × 3.0
```

Avantages : volatility-adaptive, reconnu en littérature. Inconvénient pour notre cas : ATR(22) est un indicateur daily — sur un gainer intraday 15-minute, ATR daily peut représenter 3-5% alors que notre trade entier dure < 3h. Avec un TP de 1.5% et ATR daily de 2%, le Chandelier stop serait **en dessous de l'entry dès l'ouverture**, rendant la formule inutilisable sur des horizons intraday courts.

**Notre trailing hybride % MFE** :

```
MFE = max(unrealized_pnl_pct) depuis entry

Stade 1 : MFE ≥ 40% × TP_target%
  → stop = entry × (1 + 0.0001)  [breakeven + 0.01% pour couvrir frais]

Stade 2 : MFE ≥ 70% × TP_target%
  → stop = entry × (1 + 0.5 × TP_target%)  [lock 50% du TP]

Stade 3 : prix ≥ entry × (1 + TP_target%)
  → fermeture (TP hit)
```

**Exprimé en R-multiple** (avec R = SL% comme unité) :

```
R = sl_pct  (ex: R = 1.0%)
TP = tp_pct  (ex: TP = 1.5% = 1.5R)

Stade 1 se déclenche à MFE = 0.40 × 1.5R = 0.6R
Stade 2 se déclenche à MFE = 0.70 × 1.5R = 1.05R
```

**Justification des seuils 40/70** :
- 40% : protéger contre un retournement après un bon départ. Van Tharp recommande de monter à breakeven dès R:R 1:1 atteint ; 40% du TP (≈ 0.6R avec TP=1.5R) est plus agressif → on lock le breakeven plus tôt, ce qui est cohérent avec un setup momentum court.
- 70% : lock 50% du TP à ce stade garantit une espérance positive même si le trade finit entre stade 2 et TP.

**Limitation** : ancré sur TP cible — si le TP est sous-calibré, le trailing se déclenche trop tôt. Le TP devra être recalibré sur données shadow (Step 9).

**V1.1** : ATR intraday 1h pour adapter le trailing à la volatilité du jour, une fois suffisamment de données accumulées.

### 2.7 — OBV : scoring uniquement, jamais kill

OBV divergence baissière : max −5 points sur 100. Jamais REJECT seul (trop de faux positifs sur small-caps illiquides). Combined score arbitre.

### 2.8 — Persistence multi-TF : seuil dynamique

`gainers_min_persistence_score` configurable (P8). Override pour `pullback_HL` : seuil abaissé à 0.5 (le pullback est structurellement opposé à la persistence multi-TF).

---

## 3. Décisions techniques détaillées

### 3.1 — Migration `gainers_volume_baselines`

```sql
CREATE TABLE gainers_volume_baselines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol TEXT NOT NULL,
  exchange TEXT NOT NULL,
  asset_class TEXT NOT NULL CHECK (asset_class IN ('equity', 'crypto')),
  bucket_5min_est INT NOT NULL,
  median_volume NUMERIC(20, 4) NOT NULL,
  p90_volume NUMERIC(20, 4) NOT NULL,
  sample_size INT NOT NULL,
  last_nonzero_at TIMESTAMPTZ,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX gainers_volume_baselines_pk_idx
  ON gainers_volume_baselines (symbol, exchange, bucket_5min_est);

CREATE INDEX gainers_volume_baselines_last_nonzero_idx
  ON gainers_volume_baselines (last_nonzero_at);
```

Logique différenciée :
- `equity` : cumulative volume same-time-of-day US/Eastern, exclut weekends + NYSE holidays
- `crypto` : cumulative volume same-time-of-day UTC, fenêtre glissante 20 jours calendaires

### 3.2 — Score composite (V1)

```
score = persistence_score × 30
      + path_efficiency × 20
      + (rvol_cumulative ≥ 2.0 ? 10 : rvol_cumulative ≥ 1.5 ? 5 : 0)
      + (obv_divergence_bearish ? -5 : 0)
      + (sector_alignment_positive ? +5 : 0)
      + (cost_coverage_ratio - 0.30) × 30
```

Seuil ACCEPT : ≥ 60 / 100. Pondérations provisoires — à recalibrer sur données shadow Step 9 (régression logistique sur paper_trades).

---

## 4. Non-régression univers (AMEND A)

### 4.1 — Problème

Durant le shadow run (Step 9), l'algo V1 tourne en parallèle de l'algo legacy. Si l'univers de scanning change entre les deux (ajout/retrait de symbols, changement de watchlist), la divergence mesurée n'est plus imputable à l'algo — elle peut être due à un changement d'univers.

### 4.2 — Snapshot legacy verrouillé

Au démarrage du shadow run (Step 9, premier jour), capturer et verrouiller :

```sql
CREATE TABLE gainers_legacy_snapshot (
  snapshot_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  portfolio_id UUID NOT NULL,
  symbols TEXT[] NOT NULL,               -- univers exact au démarrage shadow
  watchlist_hash TEXT NOT NULL,          -- SHA256(sorted symbols) pour détection drift
  gainers_threshold_pct NUMERIC(5,2),
  persistence_score_min NUMERIC(3,2),
  path_efficiency_min NUMERIC(3,2),
  tp_pct NUMERIC(5,2),
  sl_pct NUMERIC(5,2),
  scan_interval_minutes INT,
  algo_version TEXT NOT NULL DEFAULT 'legacy'
);
```

Ce snapshot est immuable (pas d'UPDATE). Si la watchlist change pendant le shadow run → log `gainers_universe_drift` dans `decision_log` + alerte dans le dashboard Step 10.

### 4.3 — Test d'intégration non-régression

Avant bascule live, test obligatoire :

```
1. Lancer algo legacy sur snapshot verrouillé → capturer output (ACCEPT/REJECT par symbol)
2. Lancer algo V1 sur le même snapshot (mêmes candles, même timestamp)
3. Vérifier que la divergence ACCEPT/REJECT est ≤ 20% (critère bascule)
4. Pour chaque divergence > attendu : audit manuel du signal divergent
```

Ce test tourne en CI via fixtures de candles capturées (Step 7 — fixtures RTX/GDX).

### 4.4 — Garde-fou runtime

Si `watchlist_hash` calculé au tick courant ≠ `watchlist_hash` du snapshot → le comparateur de divergence legacy/V1 est automatiquement suspendu et log une alerte. La bascule live ne peut pas avoir lieu tant que l'alerte n'est pas résolue.

---

## 5. Plan d'implémentation — Steps 6 à 10

**Préfix `feat/gainers-v1-`** systématique. Chaque PR auto-merge sur main dès CI verte.

### Step 6 — Volume baselines + RVOL (6-7 jours)

- Migration `0101_gainers_volume_baselines` (1j)
- `GainersVolumeBaselineService` lecture/écriture avec logique equity vs crypto (1j)
- Cron pre-market US 09:00 EST = 13:00 UTC, `Intl.DateTimeFormat` timeZone `America/New_York` pour DST automatique (1j)
- Backfill initial 20 jours — `scripts/backfill-gainers-baselines.ts` (sinon scanner à vide J+20) (1j)
- Table `nyse_market_holidays` seeder (0.5j)
- Tests unitaires baseline + backfill (1-2j)

**Bloquant** : Step 4 (module skeleton + shared-risk) mergé.

### Step 7 — Setups + scoring V1 (3 jours)

- `setups/pullback-hl-detector.ts` avec trend filter HH/HL 5m
- `setups/vwap-reclaim-detector.ts` avec EMA50 > EMA200 daily gate
- `scoring/composite-scorer.ts`
- Fixtures candles 1m **réelles** : RTX, GDX, au minimum 5 cas par setup (smooth/choppy/pump-and-dump/trend-filter-reject/spike-reject)
- Stockage `__tests__/fixtures/candles/`

### Step 8 — Entry + viability + exit (3 jours)

- `evaluateEntryTrigger` → `'pullback_HL' | 'vwap_reclaim' | null`
- `checkNetTpViability` → `{ accept, reason, cost_coverage_ratio }`
- `manageExit` → `'hold' | 'tp_hit' | 'sl_hit' | 'time_stop' | 'structure_break' | 'trail_to_be' | 'trail_to_50'`
- Tests E2E pipeline complet sur fixtures : winner-by-tp, loser-by-sl, time-stop, structure-break, trail-to-be→tp

### Step 9 — Shadow run + bascule live (AMEND B)

**Durée minimale : MAX(20 sessions de trading, 30 signaux ACCEPT)**

Si 30 signaux ne sont pas générés en 20 sessions → prolonger jusqu'à atteinte. Pas de bascule live avec < 30 signaux, quelle que soit la durée.

**Justification power analysis** (G*Power, test de proportion deux queues) :

```
H₀ : win_rate = 0.50 (aléatoire)
H₁ : win_rate = 0.55 (gain modeste)
α = 0.05, power = 0.80
→ n_min = 30 trades (Cohen 1988, arrondi au-dessus)

Pour détecter H₁ win_rate = 0.60 vs H₀ = 0.50 :
→ n_min = 19 trades

Choix conservateur : 30 signaux pour couvrir les deux niveaux d'effet.
```

Note : 30 trades ne permettent pas de rejeter H₀ à puissance 90% si l'effet réel est petit (Δ = 5 pts). La bascule à 30 trades est un **seuil minimal opérationnel**, pas un test statistique complet. Le monitoring post-bascule continue 30 jours supplémentaires.

**Critères bascule live** (tous requis) :

1. ≥ 30 signaux ACCEPT ET ≥ 20 sessions
2. Win-rate ≥ 45 % sur signaux ACCEPT (shadow simulation)
3. Divergence legacy ≤ 20 % sur l'overlap
4. Zéro erreur critique `decision_log`
5. Snapshot non-régression validé (§4.3)

**Métriques shadow** calculées dans dashboard Step 10 :

| Metric | Formule |
|---|---|
| Win-rate | wins / total_closed |
| Profit factor | gross_gain / gross_loss |
| Expectancy | (win_rate × avg_win) - (loss_rate × avg_loss) |
| Max drawdown | max peak-to-trough sur PnL cumulé shadow |
| Sharpe approx | mean(daily_pnl) / std(daily_pnl) × √252 |

**Table shadow** :

```sql
CREATE TABLE gainers_v1_shadow_signals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  symbol TEXT NOT NULL,
  setup_type TEXT NOT NULL,  -- 'pullback_HL' | 'vwap_reclaim'
  score NUMERIC(5,2),
  decision TEXT NOT NULL,    -- 'ACCEPT' | 'REJECT'
  reject_reason TEXT,
  entry_price NUMERIC(18,8),
  tp_price NUMERIC(18,8),
  sl_price NUMERIC(18,8),
  simulated_exit_price NUMERIC(18,8),
  simulated_exit_reason TEXT,
  simulated_pnl_pct NUMERIC(8,4),
  legacy_decision TEXT,      -- décision algo legacy au même instant
  diverges_from_legacy BOOLEAN GENERATED ALWAYS AS (decision != legacy_decision) STORED
);
```

### Step 10 — Observability dashboard (1j) — BLOQUANT pour bascule live

Page admin `/admin/gainers/v1-metrics`, `x-admin-token` auth.

Métriques affichées :
- Signals generated / ACCEPT / REJECT par jour
- REJECT breakdown par step (trend_filter, spread, rvol, cost, score)
- Win-rate rolling 20 sessions + profit factor + expectancy + max DD + Sharpe approx
- Divergence legacy : % sur l'overlap, liste des 10 derniers divergents
- Snapshot non-régression : hash univers + alerte si drift
- Last 50 signals tableau complet

---

## 6. Total révisé

| Étape | Effort |
|---|---|
| Step 6 — Volume baselines | 6-7j |
| Step 7 — Setups + scoring | 3j |
| Step 8 — Entry/viability/exit | 3j |
| Step 9 — Shadow run | 2j code + MAX(20 sessions, 30 signaux) |
| Step 10 — Dashboard | 1j |
| **Total** | **~15 dev-jours + observation variable** |

**Calendrier** : ~5 semaines calendaires en séquence.

---

## 7. Dépendances dures

```
ADR-006 (découplage)  →  Step 4 (module skeleton)  →  Steps 6, 7, 8  →  Step 9  →  Step 10
                                                                          ↑
                                                               (concurrent avec Step 9)
```

---

## 8. Risques

| Risque | P | Impact | Mitigation |
|---|---|---|---|
| < 30 signaux en 20 sessions | Haute | Pas de bascule — observation prolongée | Durée variable par design |
| Win-rate < 45% shadow | Moyenne | Retour planche à dessin | Audit signal divergents, ajustement seuils score |
| Trend filter EMA50/200 trop restrictif | Moyenne | Trop peu de signaux vwap_reclaim | Monitor REJECT ratio 'trend_filter', ajuster si > 70% des rejets |
| Univers drift pendant shadow | Basse | Divergence non imputable à l'algo | Garde-fou watchlist_hash §4.4 |
| Pondérations score non calibrées | Haute | Score non discriminant | Recalibrage par régression logistique sur shadow data Step 9 |

---

## 9. Hors scope (V1)

- ORB — V1.1 post-baseline 30 jours
- EODHD `/real-time` spread natif — V1.1 post-audit
- Chandelier Exit ATR intraday — V1.1
- ML scoring (gradient boosting) — V2
- Cross-asset signals — V2
- News blackout window — V1.1

---

## 10. Validation

- [ ] ADR-006 (découplage) mergé
- [ ] Step 4 (`feat/shared-risk-extract`) mergé
- [ ] Steps 6-10 implémentés et mergés
- [ ] MAX(20 sessions, 30 signaux ACCEPT) atteint
- [ ] Critères bascule tous validés (win-rate ≥ 45%, divergence ≤ 20%, zéro erreur, snapshot OK)
- [ ] Dashboard Step 10 livré et opérationnel
- [ ] Flag `GAINERS_V1_LIVE=true` activé

---

## 11. AMEND PR5 — BLOC 4 spec lock + dette technique BLOC 3

### 11.1 — Trailing item #18 sémantique officielle locked (02/05/2026)

Décision maître d'œuvre 02/05/2026 — l'ancien naming `TRAILING_BREAKEVEN` /
`TRAILING_LOCK_50` est remplacé par `TRAILING_20` / `TRAILING_50` reflétant la
fraction du MFE_gain lockée. **Tableau décisionnel officiel** :

| État courant | Condition tick | Action |
|---|---|---|
| `OPEN` | `price ≤ sl_price` | → CLOSED (`SL`) |
| `OPEN` | `price ≥ tp_price` | → CLOSED (`TP_FULL`) **immédiatement** — pas de promotion trailing |
| `OPEN` | `gain ≥ +path_eff` ET `price < tp_price` | → `TRAILING_20` (promotion précoce) |
| `TRAILING_20` | `price ≤ trailing_stop` | → CLOSED (`TRAILING_20_HIT`) |
| `TRAILING_20` | `gain ≥ +2×path_eff` | → `TRAILING_50` (promotion) |
| `TRAILING_20` | tick non-terminal | ratchet `stop = max(stop, entry × (1 + 0.20 × MFE_gain%))` |
| `TRAILING_50` | `price ≤ trailing_stop` | → CLOSED (`TRAILING_50_HIT`) |
| `TRAILING_50` | tick non-terminal | ratchet `stop = max(stop, entry × (1 + 0.50 × MFE_gain%))` |
| `TRAILING_*` | n'importe quel prix ≥ TP | **TP cap LEVÉ** — pas de close au TP, on laisse courir sous trailing |

**Clé de la sémantique** :

1. Le TP initial (`+path_eff × 1.5` equity / `× 2.0` crypto) est **actif uniquement
   en état `OPEN`**. Un gap-up dans la même candle qui dépasse TP ferme au TP.
2. Une montée graduelle à `+path_eff` (= 67% du TP equity) déclenche la
   **promotion précoce vers `TRAILING_20`** AVANT que le TP soit atteint. Le
   TP cap est alors annulé — la position court jusqu'au trailing stop ou
   `TRAILING_50` puis trailing stop.
3. Sans cette règle, `TRAILING_50` (activation ≥ `+2×path_eff` = 133% du TP
   equity) serait inatteignable car le TP ferme avant.

**Trade-off assumé** : on capture les TP fulgurants par gap-up (momentum violent),
ET on laisse courir les ascensions graduelles via trailing — au prix de quelques
sorties trailing en-dessous d'un TP cap qui aurait pu être atteint si maintenu.

**Tests de référence** (gainers-bloc4.spec.ts) :
- SCENARIO 4 `GAP_UP_TP_HIT` : tick unique 101.08 (= +1.8×path_eff) → TP_FULL en OPEN
- SCENARIO 5 `T20 wins, TP cap lifted` : montée graduelle 100.65→100.78→101.00
  (price 101 > TP 100.90 mais en T20 → reste open) → reversal 100.10 →
  TRAILING_20_HIT à 100.10 (locked +0.1%)

### 11.2 — Math validation BLOC 3 par maître d'œuvre (02/05/2026)

Dry-run validé 3/3 symboles :

| Symbol | Trigger | Valeurs vérifiées |
|---|---|---|
| AAPL.US (equity) | `PULLBACK_HL_FIBO` fiboLevel=50 | range 14pts, 38.2%=199.65, 50%=198.00, 61.8%=196.35 ✅ |
| CRWD.US (equity) | `VWAP_RECLAIM` | prev<VWAP, curr>VWAP, golden cross, surge ✅ |
| BTC-USD.CC (crypto) | `PULLBACK_HL_FIBO` fiboLevel=61.8 | range 3700pts, 38.2%=60086.60, 50%=59650, 61.8%=59213.40 ✅ |

Math Fibonacci confirmée correcte sur les 2 cas pullback. Distance VWAP au
fiboLevel sélectionné cohérente avec la règle `nearestFiboLevel` (distance
absolue minimale).

### 11.3 — Modèle de fill (synchro PR5, 02/05/2026)

**Décision maître d'œuvre** : les ordres TP/SL/trailing sont modélisés **MARKET au
premier tick qui cross le niveau** (pas LIMIT). Réalisme prod : un broker fill
au prochain prix disponible après cassure du stop, pas au niveau théorique.

**Règles** :

1. **Fill = tick price brut** : exit_price = prix de la candle qui a cross le niveau.
   - SL/trailing : tick souvent ≤ stop level (slippage négatif sur gaps et faible liquidité).
   - TP_FULL : tick souvent ≥ tp_price (slippage positif sur gap-up favorable).
2. **Slippage tracé** : `slippage_pct = (exit_actual - exit_theoretical) / entry`
   où :
   - `theoretical = tp_price` pour TP_FULL
   - `theoretical = currentStopPrice` pour SL / TRAILING_*_HIT
3. **Audit decision_log** : chaque close écrit `slippage_pct` et `anomalous_fill`
   dans `gainers_position_events.payload`.

**Garde-fous** :

| Condition | Niveau | Action |
|---|---|---|
| `\|slippage_pct\| > 1%` | error | flag `anomalous_fill=true`, log ERROR — review post-hoc |
| equity ET `\|slippage_pct\| > 5%` | warn | log WARNING (contexte halt/gap) — pas de bloc |

**Cohérence backtest/prod** : en shadow mode, slippage est enregistré pour stat
post-hoc. En prod live, on compare réel vs simulé pour détecter dérive (cf.
PR6 Step 9 shadow analysis).

**Tests de référence** (gainers-bloc4.spec.ts §"slippage tracking") :
- TP_FULL gap-up favorable → slippage positif
- SL exact → slippage = 0
- Gap-up 2% (massive) → anomalous_fill=true
- Gap-down 1.4% (halt) → anomalous_fill=true

### 11.4 — Dette technique BLOC 3 ouverte (à traiter avant merge PR5/PR6)

Trois dettes identifiées par revue maître d'œuvre PR #192, tracées dans
GitHub :

- **Issue #193** (P1, avant PR5 merge) — Dry-run observability : ajouter
  `timestamp`, `resolution`, `session`, `spread_proxy`, `volume_ratio`,
  `gate_liquidity_passed`, `pivots_detected/reason` aux logs trigger.
- **Issue #194** (P1, avant PR5 merge) — Dry-run REJECT coverage : exercer
  chaque `rejectReason` avec ≥2 symboles attendus REJECT (penny stock, spread
  trop large, altcoin illiquide, etc.).
- **Issue #195** (P2, avant PR6 shadow mode) — Extended panel + fiboLevel
  selection rule : règle officielle "niveau le plus proche, tie-break sur le
  plus profond" + harnais 30+ symboles golden values historiques.

### 11.5 — BLOC 4.0 ETL pre-req (réparé en PR5)

Dette critique découverte : `gainers_volume_baselines` restait vide en prod
car aucun caller de `upsertBaselines()` n'existait. Le cron
`handleDailyBaselinesRefresh` ne faisait que recharger un cache vide.

Fix livré commit 1 PR5 :
- `VolumeBaselineCalculatorService` ajouté (lit `ohlcv_cache_daily` source
  primaire, fallback live EODHD/Binance per-row)
- Garde-fous : fraîcheur cache 26h, fallback per-symbol, TZ UTC asserted,
  crypto = Binance systématique, idempotence via `onConflict='symbol,exchange'`
- Wiring cron : ETL exécuté **avant** `reloadCache()` via `setEtlRunner()`
