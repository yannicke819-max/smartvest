# SmartVest — Phase MESURE : Audit Edge & Risk Management

**Date** : 11 mai 2026
**Auteur** : Yannick Elouard
**Statut** : Phase MESURE — pas de PR, pas de push, pas de deploy
**Cible opérationnelle** : $150-250/jour avec $10 500 de capital

---

## 1. Contexte & Cible

### 1.1 Cible initiale rejetée
Cible initiale **$400/jour** sur $10 500 = **3.8% de rendement quotidien** = ~6 800% annualisé.

Démonstration mathématique d'impossibilité fondée sur :
- Kelly criterion (sizing optimal sous incertitude paramétrique)
- Samuelson efficiency theorem (continuité du retail edge)
- Grossman-Stiglitz paradox (limite de l'arbitrage informationnel)
- Hansen-Jagannathan bounds (volatilité du stochastic discount factor)
- Almgren-Chriss optimal execution (coûts marché impliqués)

Conclusion : cible non atteignable sans levier extrême ou edge institutionnel non accessible au retail.

### 1.2 Cible recalibrée — $150-250/jour
Soit **1.4% à 2.4% de rendement quotidien** (~470% à 1100% annualisé). Reste très ambitieuse mais théoriquement atteignable sur niches microstructure documentées :
- Mean reversion intraday small/mid cap US
- Statistical arbitrage à fréquence moyenne (minutes)
- NLP event-driven trading sur news flux

---

## 2. Audit du shadow Gainers existant

### 2.1 Méthodologie

Période : 2 mai → 10 mai 2026 (9 jours)
Source : `gainers_user_shadow_signals` (4981 lignes)
Outcomes mesurés : 4 grilles de simulation (baseline 30m/60m, alt15 30m/60m)

Outcome classes :
- `TP_HIT` : take-profit atteint sur fenêtre
- `SL_HIT` : stop-loss atteint sur fenêtre
- `OFF_SESSION` : marché fermé pendant la fenêtre forward
- `NO_DATA` : EODHD n'a pas retourné les candles forward

Mesurables = TP_HIT + SL_HIT uniquement.

### 2.2 Résultat brut LONG (direction d'entrée actuelle)

| Variante | n Accept | Mesurables | Win rate | Expectancy/trade |
|---|---|---|---|---|
| baseline_60m | 246 | 15 (6%) | 33.3% | **-0.23%** |
| alt15_60m | 246 | 16 (6.5%) | 31.3% | **-0.24%** |

**Verdict LONG** : expectancy négative confirmée. La stratégie actuelle perd en moyenne $2.30 par trade de $1 000.

### 2.3 Découverte critique — direction inversée

Analyse rétroactive sur **tous les decisions confondus** (accept + reject_*), small/mid US uniquement :

| Asset class | n mesurables | Avg long pnl | Avg short proxy (× -1) |
|---|---|---|---|
| **us_equity_small_mid** | **147** | -1.18% | **+1.18%** |
| us_equity_large | 143 | -0.08% | +0.08% (flat) |

**Caveat méthodologique** : le proxy "×-1" est une approximation directionnelle, pas une simulation rigoureuse. Sur grille asymétrique 2.22:1 (TP 2% / SL 0.9%), un TP_HIT long n'implique pas un SL_HIT short symétrique (le path intra-fenêtre peut différer).

**Hypothèse pessimiste post-simulation rigoureuse** : 50% du proxy → +0.6% expectancy réelle.

### 2.4 Limite statistique reconnue

Les 147 mesurables proviennent **d'un seul jour de marché** (7 mai 2026). Le 8 mai a produit 0 mesurables suite à un bug timing du simulator (voir §4.2). Diversité temporelle insuffisante pour conclusion définitive.

Wilson IC95 sur n=147 reste mathématiquement étroit, mais ne couvre pas le biais de régime de marché.

---

## 3. Pipelines & architecture (cartographie)

Deux pipelines coexistent dans le codebase :

```
[PIPELINE LEGACY]                    [PIPELINE ALGO V1]
top-gainers-scanner.service.ts       gainers-scanner module (BLOC 1-4)
        │                                    │
        ├─ paperBroker.openPosition          ├─ shadow-run.service.ts
        │                                    │   (gate env GAINERS_V1_SHADOW=true)
        ▼                                    ▼
    lisa_positions (LIVE)            gainers_v1_shadow_signals (276959 rows)
                                             │
                                             ├─ Si GAINERS_V1_LIVE=true (jamais activé)
                                             ▼
                                     gainers_positions (0 rows, by design)
```

**Implication** : les mesures de l'audit (4981 rows `gainers_user_shadow_signals`) viennent du **pipeline legacy**. Le pipeline V1 est dormant en attendant validation shadow (critères ADR-005 step 9 non atteints).

---

## 4. Bugs identifiés en phase MESURE

### 4.1 Filtrage en cascade non discriminant

Le filtre cascade (path_eff, persistence, cooldown, post_sl_cooldown) ne distingue pas les signaux profitables des non profitables. Espérance short proxy **identique** entre accept (n=6) et reject_path_eff (n=64), reject_persistence (n=47), reject_post_sl_cooldown (n=29) : **+1.18% à +1.20% partout**.

**Implication** : le système de filtrage actuel **filtre arbitrairement** des signaux qui auraient été aussi profitables que ceux acceptés. À repenser.

### 4.2 Bug timing simulator — guard sous-dimensionné

**Root cause** : un guard `SIMULATE_AFTER_MIN = 60` existait déjà dans le code (`simulatePending`, ligne 169, filtre `.lte('created_at', cutoff)` ligne 477). Il était **trop serré** : race condition avec le lag de propagation des candles EODHD (~5min). À exactement 60min après création, certaines candles forward n'étaient pas encore disponibles → outcome marqué `OFF_SESSION` à tort.

**Preuves** :
- 7 mai 2026 : scan→sim délai ≈ 10h → 141/143 mesurables (98%) — bien au-delà du cutoff, candles présentes
- 8 mai 2026 : scan→sim délai = 0-1h → 0/503 mesurables (100% OFF_SESSION) — boundary 60min, candles encore en propagation

**Fix appliqué (commit 5835656)** : bump du guard à 65min via expression dérivée `MAX_WINDOW_MIN + SIMULATE_BUFFER_MIN` (5min). Plus robuste et traçable qu'un chiffre magique, dérive automatiquement si une grille à fenêtre plus large est ajoutée.

**Impact sans fix** : ~80% des signaux US perdus systématiquement en phase forward 14j (boundary race).

### 4.3 Direction signal hardcoded LONG

`top-gainers-scanner.service.ts:2741` : `direction: 'long'` sans logique de confirmation directionnelle. Le bot lit `change_pct_1m > seuil` et entre long immédiatement — pattern classique du "fade gainer" inversé.

### 4.4 Calibration TP/SL inadaptée à small/mid US

Grilles actuelles : TP 2% / SL 0.9% / fenêtre 60min.
Range 60m observé sur small/mid US : 0.5-1.2%.
**Conséquence** : SL touché par bruit normal, TP hors zone atteignable.

**Recalibration proposée** : TP 0.8% / SL 0.4% / fenêtre 60min (ratio 2:1, breakeven 33%).

### 4.5 Bug crypto NO_DATA 100%

13 cryptos acceptés sur 9 jours, **100% NO_DATA** alors que crypto = 24/7. Mauvais mapping symbol EODHD probable. Bug isolé, à investiguer séparément.

---

## 5. Plan opérationnel — Phase 1, 2, 3

### 5.1 Phase 1 — Code SHORT (en cours, Claude)

**Scope** :
- 6 nouvelles grilles SHORT dans `SIM_GRIDS` (uniquement pour `us_equity_small_mid`)
- Param `direction: 'long' | 'short'` dans `walkForward`
- 4 grilles : `short_baseline_30m`, `short_baseline_60m`, `short_alt15_30m`, `short_alt15_60m`
- 2 grilles calibrées : `short_calibrated_30m`, `short_calibrated_60m` (TP 0.8% / SL 0.4%)
- Tests : ~80 LoC

**Estimé** : ~150 LoC + tests, ~2h dev.

**Action** : commit local, pas de push.

### 5.2 Phase 1.5 — Fix bug timing simulator (commitée)

**Scope** : guard `SIMULATE_AFTER_MIN` passé de 60 à 65min via expression dérivée `MAX_WINDOW_MIN + SIMULATE_BUFFER_MIN`. Pas un guard manquant, un guard sous-dimensionné.

**Statut** : commit `5835656` sur branche `feature/short-shadow-grids`, commit séparé du Phase 1 (`896848e`) pour clarté review (orthogonalité SHORT-SHADOW vs TIMING-FIX). 28/28 tests PASS, typecheck clean.

**Action** : commité local, pas pushé.

### 5.3 Phase 2 — Rétroactif sur n=147 (read-only)

**Scope** :
1. Lancer simulator local contre snapshot DB (read-only) sur les 147 mesurables small/mid US du 7 mai
2. Pour chaque grille SHORT, calculer outcome rigoureux (walk-forward sur candles déjà persistées)
3. Produire tableau : grille × WR × expectancy × n mesurables

**Critère décision** :
- Si **au moins une grille SHORT a expectancy nette > +0.5%** → GO Phase 3
- Sinon → STOP, pas de deploy, documentation échec, pivot

**Action** : aucun écriture DB, aucun deploy.

### 5.4 Phase 3 — Deploy MESURE-only (conditionnel)

**Pré-requis** : Phase 2 validée par toi seul.

**Scope** :
1. Push branche `feature/short-shadow-grids`
2. Review diff sur GitHub
3. Deploy via pipeline standard (Fly.io)
4. SQL : `UPDATE gainers_user_shadow_signals SET sim_run_at = NULL WHERE asset_class = 'us_equity_small_mid' AND created_at > NOW() - INTERVAL '14 days'`
5. Shadow forward 14 jours démarre

**Caveat** : ce deploy est **additif et passif** (nouvelles clés JSON dans `sim_results`, zéro impact sur scanner LIVE, zéro nouvelle position ouverte). Pas un "deploy de trading", un "deploy de télémétrie".

---

## 6. Critères GO LIVE — décision finale après 14j shadow forward

Le shadow forward 14j produit des données. À J+15, vérifier :

| Critère | Seuil minimum |
|---|---|
| Trades mesurables SHORT small/mid US | **≥ 80** |
| Win rate | **≥ 50%** (à n=80, IC95 inférieur > 40%) |
| Expectancy nette (post-slippage 30bps) | **> +0.4%/trade** |
| Sharpe ratio daily | **> 1.0** |
| Max drawdown shadow | **< 5%** du capital simulé |
| Diversité temporelle | **≥ 5 jours de marché distincts** |
| Pas de jour > 30% du PnL total | (sinon trop concentré) |

**Si tous critères atteints** → ouverture discussion live trading.
**Si un critère échoue** → STOP, documentation, pivot.

---

## 7. Risk Management — règles opérationnelles LIVE

### 7.1 Sizing

| Paramètre | Valeur | Justification |
|---|---|---|
| Capital initial | $10 500 | Donnée |
| Fraction Kelly | 0.25 × Kelly | Kelly fractionné prudent |
| Taille par position | **$1 050** (10% capital) | Cohérent avec `notional_usd` observé |
| Positions simultanées max | **10** | Notional total = 100% capital |
| Max positions par secteur | **5** | Limite concentration sectorielle |

### 7.2 Limites & circuit breakers

| Limite | Seuil | Action |
|---|---|---|
| Daily loss limit | -$210 (-2%) | Arrêt trading journée |
| Kill switch global | -$1 050 (-10%) cumulé | Arrêt système + audit forcé |
| Max consecutive losses | 8 trades | Pause 1h forcée |

### 7.3 Plage temporelle

| Borne | Heure UTC | Heure CEST |
|---|---|---|
| Start trading | 14:00 UTC | 16:00 CEST |
| Stop new entries | 19:00 UTC | 21:00 CEST |
| Force close all | 19:30 UTC | 21:30 CEST |

**Aucun nouveau trade hors plage.** Le bug timing simulator (§4.2) devient moot avec cette règle.

### 7.4 TP/SL par trade

| Paramètre | Valeur SHORT |
|---|---|
| TP target | -0.8% (gain) |
| SL stop | +0.4% (perte) |
| Time limit | 60 min → close marché |
| Ratio R:R | 2:1 |
| Win rate breakeven | 33% |

### 7.5 Projection PnL théorique

| Expectancy mesurée | PnL/jour théorique | Annualisé (252j) |
|---|---|---|
| +0.5% | $84/jour | +20% |
| +0.7% | $117/jour | +28% |
| +1.0% | $168/jour | **+40%** ✅ cible basse |
| +1.2% | $202/jour | **+48%** ✅ cible haute |
| +1.5% | $252/jour | +60% |

Base : 16 trades mesurables/jour × $1 050/position × expectancy × win rate net.

---

## 8. Tickets dérivés à traiter

| ID | Description | Priorité | Phase |
|---|---|---|---|
| T-1 | Fix bug timing simulator (§4.2) | **P0** | Phase 1.5 |
| T-2 | Filtrage cascade non discriminant (§4.1) | P1 | Post-validation |
| T-3 | Direction signal hardcoded LONG (§4.3) | **P0** | Phase 1 (couvert) |
| T-4 | Recalibration TP/SL small/mid US (§4.4) | **P0** | Phase 1 (couvert) |
| T-5 | Bug crypto NO_DATA 100% (§4.5) | P2 | Hors scope MESURE |
| T-6 | Retry anti-pattern (000500.KO 1832×) | P2 | Hors scope MESURE |
| T-7 | NSE 404 loop (9 tickers délistés/mal mappés) | P3 | Hors scope MESURE |

---

## 9. État d'avancement

- [x] Cadrage cible recalibrée
- [x] Audit shadow LONG (verdict négatif documenté)
- [x] Découverte direction inversée (proxy à valider)
- [x] Cartographie pipelines V1 vs legacy
- [x] Identification bugs structurels
- [x] Plan Phase 1/2/3 défini
- [x] Risk management chiffré
- [x] **Phase 1 (code SHORT) — commit 896848e local**
- [x] **Phase 1.5 (fix timing simulator) — commit 5835656 local**
- [ ] Phase 2 (rétroactif sur n=147) — option 1 retenue : script Node standalone read-only
- [ ] Phase 3 (deploy MESURE-only) — conditionnel à Phase 2
- [ ] Shadow forward 14j
- [ ] Décision GO LIVE

---

**Note** : pas de PR, pas de push, pas de deploy, pas de secret. Phase MESURE intégrale.
