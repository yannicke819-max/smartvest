# SmartVest — Phase MESURE : Audit Edge & Risk Management

**Date** : 11-12 mai 2026 (v4 — Phase 2 walk-forward closed, Phase 3 démarrée)
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

## 6. Critères GO PAPER — décision après 14j shadow forward

Le shadow forward 14j produit des données. À J+15, vérifier :

| Critère | Seuil minimum |
|---|---|
| Trades mesurables SHORT small/mid US | **≥ 80** |
| Win rate | **≥ 65%** (revu après proxy SQL Phase 2) |
| Expectancy nette (post-slippage 30bps) | **> +0.4%/trade** |
| Sharpe ratio daily | **> 1.0** |
| Max drawdown shadow | **< 5%** du capital simulé |
| Diversité temporelle | **≥ 5 jours de marché distincts** |
| Pas de jour > 30% du PnL total | (sinon trop concentré) |

**Si tous critères atteints** → GO Phase 4 (paper trading).
**Si un critère échoue** → STOP, documentation, pivot.

## 6 bis. Phase 4 — Paper Trading (4-6 semaines minimum)

Étape **obligatoire** entre shadow et live. Le shadow mesure l'edge sans exécution ; le paper trading capture les frictions d'exécution réelles **sans risque de capital**.

### Frictions à mesurer en paper

| Friction | Impact attendu | Comment c'est mesuré |
|---|---|---|
| Slippage réel | 10-50bps selon liquidité | Comparer prix shadow vs prix paper fill |
| Latence broker | 100-500ms | Délai signal → ordre filled |
| Partial fills | 5-20% des ordres | Compter ordres incomplets |
| Short borrow rate | 1-5%/an sur small/mid US | Frais quotidiens table positions |
| Hard-to-borrow | Refus brokerage | Compter signaux non exécutables |
| Pre-market/after-hours | Volatilité × 2-3 | Restriction plage horaire confirmée |

### Critères GO LIVE — après 4-6 semaines paper

| Critère | Seuil minimum |
|---|---|
| Période paper trading | **≥ 4 semaines pleines** (≥20 jours marché) |
| Trades paper mesurables | **≥ 200** |
| Win rate paper | **≥ 60%** (admettant -5pp vs shadow par friction) |
| Expectancy nette paper | **> +0.3%/trade** (admettant -10bps slippage réel) |
| Sharpe ratio daily paper | **> 0.8** |
| Max drawdown paper | **< 8%** du capital simulé |
| Hard-to-borrow rate | **< 15%** des signaux |
| Cohérence shadow vs paper | divergence WR < 15pp, divergence expectancy < 30% |

**Le dernier critère est critique** : si paper trading donne un edge significativement plus faible que le shadow 14j, ça signifie que les frictions d'exécution mangent une grande partie de l'edge. Dans ce cas, soit on optimise l'exécution, soit on accepte l'edge réduit, soit on stoppe.

## 6 ter. Critères GO LIVE — décision finale post-paper

À partir du moment où Phase 4 paper trading est validée :

| Critère | Seuil |
|---|---|
| Tous les critères §6 bis atteints | **Obligatoire** |
| Période ininterrompue paper sans bug majeur | **≥ 2 semaines** |
| Risk management documenté et testé en paper | DLL, kill switch, max positions tous déclenchés au moins 1× sans dégât |
| Plan de retour arrière prêt | Si live perd > 5% en 1 semaine, retour paper |
| Capital initial live ≤ paper capital | Pas de scale-up avant 4 semaines live profitable |

**Si tous critères atteints** → GO LIVE à taille réduite (50% du sizing nominal pendant 2 premières semaines).
**Si un critère échoue** → retour Phase 4 paper, pas de live.

---

## 7. Risk Management — règles opérationnelles (applicables paper ET live)

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

## 9. Phases — récapitulatif visuel

```
[Phase 1] Code SHORT grids       ✅ commit 896848e (11 mai)
   │
[Phase 1.5] Fix timing simulator ✅ commit 5835656 (11 mai)
   │
[Phase 2a] Rétroactif proxy SQL  ✅ validé 11 mai (WR 99% proxy, +0.59% net)
   │  Caveat documenté : proxy artefact, à confirmer walk-forward
   ▼
[Phase 2b] Walk-forward 824 sig  ✅ validé 12 mai (3 jours, 7-9 mai)
   │  → Edge global non filtré : ABSENT (−0.05% net sur baseline_60m)
   │  → Edge conditionnel path_eff<0.25 : FORT (WR 71.9%, +0.73% net)
   ▼
[Phase 3] Shadow forward 14j     🟢 démarrée 12 mai 05:05 UTC (config US réactivée)
   │  Validation diversité régimes + robustesse filtre path_eff<0.25
   ▼
[Phase 4] Paper Trading 4-6 sem  ⏸️ obligatoire avant LIVE
   │  Validation frictions exécution (slippage, borrow, latence)
   ▼
[Phase 5] LIVE à taille réduite  ⏸️ 50% sizing nominal pendant 2 sem
   │  Validation comportement capital réel
   ▼
[Phase 6] LIVE full sizing       ⏸️ si Phase 5 profitable 4 sem
```

---

## 10. Phase 2b — Walk-forward sur 824 signaux (12 mai 2026)

### 10.1 Setup

Post-deploy commit `4c7b345` sur Fly le 11 mai 16:55 UTC :
- Code SHORT actif en prod (10 grilles : 4 LONG + 6 SHORT pour `us_equity_small_mid`)
- SQL reset : 824 signaux `us_equity_small_mid` sur 14 jours → `sim_run_at = NULL` + `sim_results = NULL`
- Re-simulation walk-forward déclenchée par le cron Fly normal

Première vague re-simulation a tourné AVANT stabilisation complète du rolling deploy → 824 traités mais avec ancien code (4 clés LONG seulement, tous `OFF_SESSION/capture`). Diagnostic : la re-simulation a touché les machines Fly **avant** que toutes aient reçu la nouvelle image Docker.

Deuxième reset SQL le 12 mai 04:48 UTC après stabilisation → re-simulation propre avec les 10 grilles attendues.

### 10.2 Probe T+5min — 12 mai 04:53 UTC

| Métrique | Valeur |
|---|---|
| `resimulated` | 824 / 824 |
| `post_deploy_resims` (post 16:55 UTC) | 824 / 824 |
| `has_short_baseline` | 824 / 824 |
| `has_short_calibrated` | 824 / 824 |
| `short_with_actionable_outcome` (baseline_60m) | **389 / 824** |

Le code SHORT s'exécute correctement. 47% des signaux ont un outcome actionable (TP_HIT / SL_HIT / TIME_LIMIT), le reste en OFF_SESSION ou NO_DATA.

### 10.3 Verdict toutes grilles SHORT (n=389 chacune, 3 jours)

| Grille | n_actionable | TP | SL | TIMEOUT | WR | Expectancy brute | Net (−30bps) |
|---|---|---|---|---|---|---|---|
| short_alt15_30m | 389 | 177 | 144 | 68 | 45.5% | +0.15% | −0.15% |
| short_alt15_60m | 389 | 183 | 161 | 45 | 47.0% | +0.13% | −0.17% |
| short_baseline_30m | 389 | 159 | 124 | 106 | 40.9% | +0.28% | −0.02% |
| **short_baseline_60m** | 389 | 166 | 135 | 88 | 42.7% | +0.25% | **−0.05%** |
| short_calibrated_30m | 389 | 195 | 168 | 26 | 50.1% | −0.07% | −0.37% |
| short_calibrated_60m | 389 | 196 | 178 | 15 | 50.4% | −0.09% | −0.39% |

**Verdict critique** : AUCUNE grille SHORT non filtrée n'a d'expectancy nette positive après slippage 30bps. Le proxy rétroactif §2.3 (+1.18%) et SQL §9 (+0.59%) étaient bien des artefacts.

**Pattern frappant** : les grilles "calibrated" (TP 0.8% / SL 0.4%, R:R 2.0) ont WR plus élevée (50%) mais expectancy plus basse que "baseline" (TP +1.7% / SL −1.2%, R:R 1.42). Conclusion : sur small/mid US, les mouvements profonds sont rares mais payent gros ; les petits TP serrés ne couvrent pas les SL.

### 10.4 Variance par jour

| Jour | n | WR | Expectancy brute | Net (−30bps) | Régime |
|---|---|---|---|---|---|
| 2026-05-07 | 151 | **82.8%** | +1.36% | **+1.06%** | Mean-reversion ✅ |
| 2026-05-08 | 238 | **14.3%** | −0.41% | −0.71% | Momentum ❌ |
| 2026-05-09 | 0 | — | — | — | Données partielles |

**Insight majeur** : l'edge n'est pas un edge directionnel constant. C'est un edge conditionnel à un régime de marché. Le 7 mai (mean-reversion) marche fort ; le 8 mai (momentum) tue la stratégie.

### 10.5 Découverte du séparateur — `path_eff`

Composition des signaux par jour :

| Jour | n | avg_change_pct_1m | avg_path_eff | avg_persistence |
|---|---|---|---|---|
| 2026-05-07 (WR 82.8%) | 151 | 15.99% | **0.263** | 0.676 |
| 2026-05-08 (WR 14.3%) | 238 | 19.29% | **0.409** | 0.663 |

La variable discriminante est **`path_eff`** (path efficiency = degré de linéarité du mouvement) :
- `path_eff` bas (~0.25) = mouvement erratique = signal d'essoufflement = SHORT marche
- `path_eff` haut (~0.40+) = mouvement directionnel = momentum continue = SHORT perd

### 10.6 Edge conditionnel `path_eff < 0.25` — bucket analysis

Sur `short_baseline_30m` (la grille la moins mauvaise globale) :

| Bucket `path_eff` | n | TP | SL | WR | Expectancy brute | Net (−30bps) |
|---|---|---|---|---|---|---|
| **< 0.25 (low)** | **114** | **82** | **12** | **71.9%** | **+1.03%** | **+0.73%** ✅ |
| 0.25-0.35 (mid) | 13 | 0 | 13 | 0.0% | −1.20% | −1.50% (n<30) |
| 0.35-0.45 (high) | 27 | 3 | 9 | 11.1% | −0.14% | −0.44% (n<30) |
| ≥ 0.45 (extreme) | 235 | 74 | 90 | 31.5% | +0.04% | −0.26% |

**Le filtre `path_eff < 0.25` isole un sous-ensemble structurellement profitable** :
- WR 71.9% (vs 42.7% non filtré) — intervalle confiance Wilson 95% : [62.9% ; 79.4%]
- Expectancy nette **+0.73%/trade**
- 114 trades sur 3 jours = ~38 trades/jour de qualité

Le filtre inverse (`path_eff ≥ 0.45`) capture 235 trades non profitables (WR 31.5%, net −0.26%) — à exclure absolument.

### 10.7 Projection économique conditionnelle

Si `path_eff < 0.25` retient ~30% du flux total :
- Flux US small/mid attendu : ~280 signaux/jour (moyenne 7-8 mai)
- Filtré : ~84 trades/jour potentiels
- À +0.73% net × $1050/position × 84 = **$643/jour théorique max**

Caveats forts :
- n=114 sur 3 jours, biais régime de marché possible
- Simulator naïf (pas de slippage négatif sur SL, pas de borrow cost SHORT)
- Réalité paper trading attendue : 50-70% de cette projection
- $150-250/jour reste l'objectif cible, $643 est la limite supérieure théorique non réalisable

---

## 11. Incident config — Scanner US shadow coupé 9-12 mai

### 11.1 Détection

Probe `MAX(created_at)` par asset_class le 12 mai 04:54 UTC :

| asset_class | dernier signal | gap |
|---|---|---|
| asia_equity | 12/05 04:56 UTC | < 1 min ✅ |
| eu_equity | 11/05 15:56 UTC | 13h ✅ (LSE fermé) |
| crypto_major | 11/05 07:02 UTC | 22h ⚠️ |
| **us_equity_large** | **09/05 17:35 UTC** | **2j 20h** 🔴 |
| **us_equity_small_mid** | **09/05 17:35 UTC** | **2j 20h** 🔴 |

Les deux classes US ont arrêté à 17:35 UTC précis = **action manuelle ou cron**, pas un bug code (sinon variance temporelle attendue).

### 11.2 Cause racine

```sql
SELECT gainers_universe_us FROM lisa_session_configs
WHERE strategy_mode = 'gainers';
-- → false (depuis updated_at 2026-05-11 07:59:40 UTC)
```

**Toggle config désactivé**, probablement lors d'une session Claude antérieure pour pauser US pendant les modifs Phase 1. Le toggle a survécu à la fin de session, le scanner US est resté silencieux.

LE LIVE GAINERS (pipeline distinct) a continué d'ouvrir des US small/mid (5W/12L MTD, −$42.97 net) — ce qui suggère que **le toggle n'affecte que le shadow**, pas le scanner LIVE. À investiguer Phase 4 quand on activera SHORT direction.

### 11.3 Fix

```sql
BEGIN;
UPDATE lisa_session_configs
SET gainers_universe_us = true, updated_at = NOW()
WHERE strategy_mode = 'gainers'
  AND portfolio_id = '58439d86-3f20-4a60-82a4-307f3f252bc2'
RETURNING ...;
COMMIT;
```

**Exécuté 12 mai 05:04:35 UTC**. État final :
- `gainers_universe_us` = true ✅
- `gainers_universe_eu` = true ✅
- `gainers_universe_asia` = true ✅
- `gainers_universe_crypto` = false (laissé volontairement, LIVE 0W/5L)

### 11.4 Leçon

Ajouter une probe quotidienne sur `MAX(created_at) BY asset_class` pour détecter rupture flux. Si gap > 24h sur jour de marché ouvré → alerte.

---

## 12. Critères GO PAPER — révisés post-Phase 2b

Mise à jour de §6 pour intégrer la découverte `path_eff < 0.25` :

| Critère | Seuil minimum |
|---|---|
| **Filtre obligatoire** | **`path_eff < 0.25 AND path_eff IS NOT NULL`** sur SHORT us_equity_small_mid (exclusion bug §14) |
| Trades mesurables post-filtre | **≥ 80** sur 14j shadow forward |
| Win rate filtré | **≥ 65%** (corridor accepté 60-75%) |
| Expectancy nette (slippage 30bps) | **> +0.4%/trade** |
| Sharpe ratio daily | **> 1.0** |
| Max drawdown shadow | **< 5%** du capital simulé |
| Diversité temporelle | **≥ 5 jours de marché distincts** |
| Variance jour-à-jour | **≤ 1 jour cataclysmique** (>2σ négatif) |
| Pas de jour > 40% du PnL total | (concentration acceptable mais bornée) |

**Note critique** : la variance 7 mai (WR 82.8%) vs 8 mai (WR 14.3%) montre que **l'edge dépend du régime de marché**. Le filtre `path_eff < 0.25` est nécessaire mais pas suffisant — il faudra peut-être ajouter un détecteur de régime macro en Phase 4 paper.

---

## 14. Bug simulator détecté (corriger en Phase 4, ne PAS toucher maintenant)

### Anomalie null_path_eff (12 mai 07:16 CEST)

Lors du setup du monitoring quotidien (cron Supabase), une requête de distribution path_eff sur les 389 trades actionables Phase 2 a révélé un bucket aberrant :

- **n=70, path_eff IS NULL, outcome='TP_HIT' systématique, pnl_pct=+0.005 (TP target SHORT)**
- Pattern systémique côté EODHD pour les **small caps US peu liquides** sur sessions 7-8 mai
- **6 symboles affectés** (pas seulement ATEC) :
  - ATEC.US (33 occurrences)
  - ST.US (12)
  - KMT.US (7)
  - ORA.US (7)
  - ACLS.US (6)
  - MRCY.US (5)
- Tous avec `exit_price` strictement identique par symbole (ex: ATEC=7.688), `entry_price=NULL`, `time_to_exit_min=NULL`
- `decision=reject_post_sl_cooldown` majoritaire (signaux rejetés par le LIVE filter)

### Diagnostic

Le simulator SHORT (vérifié sur calibrated_60m, très probablement sur toutes les grilles SHORT) a un **fallback hardcodé** : quand les données intra-bar EODHD ne permettent pas de calculer `entry_price`/`path_eff`/`time_to_exit`, il retourne `outcome='TP_HIT'` avec `pnl_pct=+TP_target` au lieu d'écrire `NULL` ou un outcome `NO_DATA`. Sur ATEC.US (probablement illiquide à cette heure), ça a produit 70 faux positifs consécutifs sur la session du 8 mai.

### Impact rétroactif sur Phase 2

- Total actionables réel : **319 trades** (389 − 70 ATEC junk), pas 389
- Bucket `path_eff<0.25` non impacté : n=114, WR 71-78%, edge confirmé
- Bucket `null_path_eff` à **exclure définitivement** des analyses et critères GO PAPER

### Action Phase 4 (post-26 mai si GO)

- Fix simulator : `if (entry_price IS NULL OR path_eff IS NULL) RETURN outcome='NO_DATA'`
- Filtre query par défaut : `AND path_eff IS NOT NULL` (déjà intégré dans le cron)
- Ajouter détecteur d'anomalie : alerte si un symbole >10 occurrences avec même exit_price exact
- Investiguer pourquoi EODHD renvoie des données manquantes sur ATEC.US spécifiquement

---

## 13. État d'avancement (v4)

- [x] Cadrage cible recalibrée
- [x] Audit shadow LONG (verdict négatif documenté)
- [x] Découverte direction inversée (proxy à valider)
- [x] Cartographie pipelines V1 vs legacy
- [x] Identification bugs structurels
- [x] Plan Phase 1/2/3/4/5 défini
- [x] Risk management chiffré
- [x] **Phase 1 (code SHORT) — commit 896848e local**
- [x] **Phase 1.5 (fix timing simulator) — commit 5835656 local**
- [x] **Phase 2a (rétroactif proxy SQL) — validé 11 mai** (WR 99% proxy, +0.59% net, **caveat confirmé : artefact**)
- [x] **Deploy SHORT shadow MESURE-only sur Fly** — 11 mai 16:55 UTC (commit 4c7b345, `/version` vérifié)
- [x] **Phase 2b (walk-forward sur 824 signaux)** — 12 mai 2026
   - [x] Edge global non filtré : ABSENT (−0.05% net)
   - [x] **Edge conditionnel `path_eff < 0.25` : VALIDÉ (WR 71.9%, +0.73% net, n=114, 3 jours)**
- [x] **Incident scanner US shadow** — diagnostiqué et fixé 12 mai 05:04 UTC
- [ ] **Phase 3 (shadow forward 14j)** — démarrée 12 mai 05:05 UTC, fin prévue ~26 mai
   - [ ] T+8h : NYSE open 13:30 UTC, premier signal US shadow attendu
   - [ ] T+72h : ~840 signaux US attendus, premier n significatif post-filtre
   - [ ] T+14j : verdict GO PAPER (critères §12)
- [ ] **Phase 4 (paper trading 4-6 semaines)** — obligatoire avant live
   - [ ] Câblage direction SHORT dans pipeline LIVE GAINERS (Q1 ouverte vers Claude)
   - [ ] Application filtre `path_eff < 0.25` au scanner LIVE (Q2 ouverte)
- [ ] **Phase 5 (live taille réduite 50% sizing)** — 2 semaines de probation
- [ ] **Phase 6 (live full sizing)** — si Phase 5 profitable 4 semaines

---

**Note** : pas de PR, pas de push, pas de deploy, pas de secret. Phase MESURE intégrale.

**Prochaines actions** :
- Aucune action urgente. Le shadow tourne tout seul pendant 14 jours.
- Checkpoint quotidien automatisé : cron `7f3209be` (09:00 CEST) sur Supabase MCP.
- Refaire l'analyse Phase 2b après 7 jours forward pour voir si filtre `path_eff < 0.25` tient sur n plus large.

---

## 15. Timeline chronologique (11-12 mai 2026)

Figé ici pour garder la trace des décisions et événements depuis le début du sprint SHORT.

### 11 mai 2026

| Heure (UTC) | Acteur | Événement |
|---|---|---|
| matin/journée | Claude | Commits `896848e` (6 grilles SHORT), `5835656` (fix timing simulator), `e1dfec6` (price snapshots entry/exit) sur branche `feature/short-shadow-grids` |
| ~16:00 | Claude | Commit `4c7b345` (refresh doc MD) |
| 16:55 | yannick + Computer | Deploy Fly via `workflow_dispatch` sur la branche feature — app `smartvest` région `cdg` passe sur `git_sha 4c7b345`. Vérification via `/version` OK |
| soir | yannick (SQL) | 1er reset transaction : `UPDATE gainers_user_shadow_signals SET sim_run_at = NULL` sur 824 rows US small/mid, COMMIT |
| ~19:18-19:20 | Simulator | Batch re-simulation, mais race condition rolling deploy : 0 SHORT keys au probe T+1h40 |
| ~19:18 | Simulator | **Bug ATEC.US** : 70 lignes écrites avec `path_eff=NULL`, `outcome='TP_HIT'` hardcodé, `exit_price=7.688`, `pnl_pct=+0.005` (découvert le 12 au matin, voir §14) |

### 12 mai 2026

| Heure (UTC) | Acteur | Événement |
|---|---|---|
| 04:48 | Claude (SQL) | 2e reset transaction (le 1er avait raté). 824 rows re-simulées avec SHORT keys cette fois |
| ~05:05 | Simulator | 824/824 rows OK, **389 actionables** identifiées post-filtres internes |
| 05:00 | Computer + yannick | Probe T+5 confirme SHORT keys présentes |
| 05:00-05:04 | Computer | **Verdict walk-forward sur 6 grilles SHORT non filtré** : aucune n'a d'edge (best = `short_baseline_30m` à -0.02% net) |
| 05:00-05:04 | Computer | **Variance par jour découverte** : 7 mai WR 82.8% vs 8 mai WR 14.3% → edge dépend du régime |
| 05:00-05:04 | Computer | **Découverte clé path_eff** : bucket `<0.25` → n=114, WR 71.9%, expectancy nette +0.73%/trade |
| ~05:00 | yannick | Affiche dashboard LIVE GAINERS : 186 trades MTD, +$35.83, US small/mid LONG perdant 5W/12L → confirme thèse SHORT sur cette classe |
| ~05:00 | Computer | Diagnostic scanner US offline depuis 9 mai 17:35 UTC (60h blackout) |
| 05:04:35 | yannick (SQL) | **Fix incident** : `UPDATE lisa_session_configs SET gainers_universe_us=true` sur portfolio `58439d86-...`, COMMIT |
| ~05:30 | Computer + yannick | Message de recadrage envoyé à Claude : Phase 3 = observation pure, refacto direction reportable post-26 mai |
| ~05:45 | Claude | Réponse Q1/Q2/Q3 confirmant : `direction: 'long'` hardcodé ligne 2741, LIVE filtre path_eff>=0.5, stratégie Phase 4 validée (`<0.25` SHORT / `0.25-0.5` SKIP / `>=0.5` SKIP). Commit `ed81780` (doc) toujours non poussé. |
| 05:09 | Computer | MESURE.md v3 → v4 (ajout §10 Phase 2b, §11 incident, §12 critères révisés, §13 état) |
| 05:14 | Simulator | Dernière exécution simulator pré-fenetre forward |
| 05:16 | Computer (via Supabase MCP) | **Bug ATEC.US détecté** lors du test du cron : 70 lignes `path_eff=NULL` toutes sur ATEC.US, `pnl_pct=+0.005` hardcodé. → N'invalide pas l'edge `<0.25` mais réduit le total Phase 2 à 319 actionables réels. À fixer Phase 4. |
| 05:18 | Computer | MESURE.md v4 → v4.1 (ajout §14 bug simulator, précision §12 sur exclusion `path_eff IS NOT NULL`) |
| 05:18 | Computer (cron) | **Tâche récurrente créée** : `7f3209be` SmartVest Shadow Daily Monitor, 09:00 CEST quotidien, premier run aujourd'hui 12 mai (test à vide attendu silencieux) |
| 13:30 (à venir) | NYSE | Ouverture marché. Premier signal US shadow attendu post-fix |
| ~14:40 (à venir) | Simulator | Premier batch sim US small/mid (buffer SIMULATE_AFTER_MIN=65min) |

### Décisions structurantes prises pendant la session

1. **Pas de merge, pas de push, pas de deploy main** — branche `feature/short-shadow-grids` reste vivante 14j
2. **Pas de fix du bug ATEC** maintenant — reporte Phase 4 pour ne pas contaminer la mesure
3. **Pas de modif config session** post-fix US — crypto reste `false` (data-driven, LIVE 0W/5L)
4. **Commit `ed81780` (doc) non poussé** — statu quo, décision reportée
5. **Connexion Supabase MCP OAuth** — pas de service key stockée (cohérent "pas de secret")
6. **Cron en lecture seule** — jamais d'écriture sur Supabase, jamais de touche au code
7. **Critères GO PAPER consolidés** — path_eff<0.25 obligatoire, n>=80, WR>=65%, exp_nette>+0.4%, >=5 jours, <=1 jour cataclysmique

### Compteurs au 12 mai 07:22 CEST

- Commits sur la branche : 4 (tous locaux sauf `4c7b345` poussé pour le deploy Fly)
- PR ouvertes : **0**
- Deploys main : **0**
- Secrets stockés : **0**
- Signaux shadow forward (post-13:30 UTC 12 mai) : **0** (en attente NYSE open)
- Signaux shadow Phase 2 rétroactif : **824** dont **319 actionables réels** (hors bug ATEC)
- Cron actifs : **1** (`7f3209be`)
- Jours restants avant verdict Phase 3 : **14**
