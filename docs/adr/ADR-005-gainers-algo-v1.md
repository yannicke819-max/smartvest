# ADR-005 — Gainers Scanner Algo V1

| Champ | Valeur |
|---|---|
| **Statut** | Proposed — AMEND v2 (01/05/2026) |
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
