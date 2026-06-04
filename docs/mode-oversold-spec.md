# Spec — Mode OVERSOLD (mean-reversion swing) — v1

**Statut** : design validé, à implémenter. 04/06/2026.
**Auteur** : session research SmartVest (9 backtests prix réels).

---

## 0. Pourquoi ce mode existe (le fondement empirique)

Le mode `gainers` (scalp momentum top-gainers) a été **prouvé sans edge** sur 5 backtests prix réels (expectancy -0.13%/trade, validé 3 échantillons disjoints). Cause racine identifiée : **le point de départ "ce qui a déjà monté" = chasser le passé = être la liquidité de sortie du smart money.**

À l'inverse, l'**oversold mean-reversion** a été **validé 3-fold** sur prix réels EODHD :

| Échantillon | Univers | N | Alpha vs SPY (J+10) | t-stat |
|---|---|---|---|---|
| #1 | SP500 (200) | 175 | +2.78% | 3.96 |
| #2 | Mid-cap (285) | 343 | +1.55% | 2.39 |
| #3 | Russell large (793) | 898 | +1.05% | 2.33 |
| **Combiné** | disjoints | **1416** | **+1.38%** | **≈4.10** |

**Signal de référence** : drop 1J entre **-5% et -8%** → hold **J+10** → alpha +1.4% vs SPY, t=4.1.

### Règles confirmées par le 3-fold
- **Gradient profondeur→alpha** : -3/-5% (~0%) < -5/-8% (+1%) < -8/-12% (+2.45%). Plus la chute est forte (dans la fenêtre), meilleur le rebond.
- **Falling-knife <-12% : EXCLU** (alpha -1.97% J+10, N=142 sur #3). Les crashs >-12% ne rebondissent pas (news structurelles : downgrade, fraude, guidance).
- **Définition 1J >> 5J** : le crash brutal d'UN jour capte le rebond ; le drift baissier 5J est du momentum baissier (à éviter).
- **Horizon J+10** robuste (J+5 fragile en out-of-sample, t<2).

### Caveats assumés
- **1 seul régime testé** (fév-juin 2026, anti-momentum). Robustesse cross-régime NON démontrée → c'est précisément ce que le paper trading live doit valider.
- **Alpha vs SPY ≠ cash net** : exposition bêta ~1.0-1.2. Un marché baissier sur la fenêtre de hold efface l'alpha en absolu.
- **Médiane J+10 négative, WR ~52%** : P&L lumpy (queue droite de gros rebonds), pas un revenu régulier.

---

## 1. Principe en une phrase

> Chaque jour après la clôture US, scanner un large univers d'actions liquides, sélectionner celles qui ont **chuté de -5% à -12% sur la journée** (hors falling-knife <-12%), ouvrir une position **long**, et la tenir **10 jours de bourse** — pariant sur la sur-réaction et le rebond.

C'est l'**opposé exact** du mode gainers : on part de ce qui a chuté (pas monté), en swing (pas scalp), 1×/jour (pas 5min).

---

## 2. Architecture — réutilisation vs nouveau

| Composant | Réutilise l'existant ? | Détail |
|---|---|---|
| Paper-broker (`openPositionDirect`) | ✅ | identique |
| `lisa_positions` (state) | ✅ | identique, + champs hold |
| Portfolio + `lisa_session_configs` | ✅ | nouveau `strategy_mode='oversold'` |
| Tracker + close-decision-capture | ✅ | identique (mesure le swing) |
| Audit hash-chain, kill-switch, mandate | ✅ | identiques |
| EODHD EOD fetch | ✅ | `ohlcv_cache_daily` existe déjà |
| **Screener** | ❌ NOUVEAU | losers EOD au lieu de gainers intraday |
| **Cadence** | ❌ NOUVEAU | 1×/jour post-close US au lieu de 5min |
| **Logique d'exit** | ❌ NOUVEAU | hold J+10 par durée au lieu de scalp TP/SL |
| Gates anti-pump (persistence, CHOP_NOISE, anti-OKLO) | ❌ N/A | non pertinents (on ne chasse pas un pump) |

**Conclusion : ~70% réutilisé. Le vrai dev = screener losers + cadence quotidienne + exit par durée.**

---

## 3. Le screener OVERSOLD

### 3.1 Univers
- **Source** : Russell 1000 / large+mid cap US liquides (~800-1000 symboles).
- Construit depuis `exchange-symbol-list/US` filtré common stocks NYSE+NASDAQ, OU une watchlist `oversold_universe` en table `watchlist_universe` (cohérent avec l'archi multi-watchlist existante).
- **Pas de crypto** (mean-reversion non validée crypto, MFE 0.8%).
- Extensible plus tard (small-caps : asymétrie probablement plus violente, à valider séparément).

### 3.2 Détection (post-close US, ~21:15 UTC)
Pour chaque symbole de l'univers :
```
dropPct = (close_J / close_J-1) - 1
```
- **Signal valide si** `-12% <= dropPct <= -5%` (les deux bornes incluses côté -5, exclues côté -12).
- **EXCLURE** `dropPct < -12%` (falling-knife, alpha négatif confirmé).
- **IGNORER** `dropPct > -5%` (pas assez de sur-réaction).

### 3.3 Filtres
| Filtre | Seuil | Raison |
|---|---|---|
| Liquidité prix | close > $5 | éviter penny stocks |
| Liquidité volume | dollar-volume_J > $5M | exécutabilité |
| Falling-knife | dropPct >= -12% | confirmé négatif 3-fold |
| **Catalyseur structurel (Lisa LLM)** | voir §6 | distinguer chute technique (rebond) vs news structurelle (continue) |

### 3.4 Priorisation (si plus de candidats que de slots)
Trier par **profondeur du drop** (les -8/-12% ont le meilleur alpha) puis par dollar-volume (liquidité). Le gradient confirmé dit : privilégier les chutes les plus fortes dans la fenêtre [-12%, -5%].

---

## 4. Entrée

- **Timing** : le scan tourne post-close US (~21:15 UTC). On connaît le `close_J`. **Entry = open de J+1** (le lendemain ouvré).
  - Rationale : en paper comme en réel, on ne peut pas exécuter au close_J déjà passé. L'open J+1 est le 1er point exécutable. Léger écart vs backtest (qui entrait au close_J) — à mesurer en paper, mais conservateur.
  - Alternative testable : MOC (market-on-close) le jour J si l'infra le permet — plus proche du backtest.
- **Prix d'entrée** : open J+1 (ou close_J en simulation/paper si on veut coller au backtest).
- **Direction** : LONG only (compatible pipeline, pas de borrow).

---

## 5. Sortie — LE morceau de dev central

Le `MechanicalTradingService` actuel gère SL/TP/trailing **scalp** (cron 60s). Le mode oversold a besoin d'une **sortie par durée** :

### 5.1 Règle de sortie principale
- **Exit au close de J+10** (10 jours de bourse après l'entrée). Hold temporel fixe.
- Implémentation : ajouter dans `lisa_positions` (ou réutiliser `horizon_target_date`) un champ `hold_until_bar` ou exploiter `horizon_target_date = entry + 10 jours ouvrés`.
- Le cron mécanique vérifie : `if (mode==='oversold' && businessDaysSince(entry) >= 10) → close('oversold_hold_expired')`.

### 5.2 Garde-fous (pas de TP/SL scalp serré)
- **Stop catastrophe large** : SL à -15% (pas -1.5%) — seulement pour couper une 2e jambe de chute structurelle (le falling-knife qu'on n'aurait pas filtré). Pas un stop de bruit.
- **Take-profit optionnel** : TP +10% (si le rebond est violent et rapide, sécuriser). Optionnel, à A/B tester (le backtest dit hold J+10 sans TP, mais sécuriser un +10% tôt peut réduire la variance).
- **Pas de trailing scalp.**

### 5.3 Business-days
Attention au calcul J+10 **jours ouvrés** (pas calendaires) : exclure week-ends + jours fériés US. Réutiliser un helper de calendrier marché (ou approximation : 10 jours ouvrés ≈ 14 jours calendaires).

---

## 6. Intégration Lisa LLM — le filtre catalyseur

Le risque #1 du oversold = **acheter un falling-knife à catalyseur structurel** (la chute continue). Le filtre <-12% en attrape une partie, mais une chute de -7% sur une fraude/downgrade rebondira pas non plus.

**Lisa valide chaque candidat** (1 appel LLM/candidat, ~quelques/jour donc coût négligeable) :
- Input : symbole, dropPct, news récentes (EODHD news), contexte
- Question : *"Cette chute est-elle (a) technique/sentiment (rebond probable) ou (b) structurelle — guidance coupée, downgrade fondamental, fraude, dilution (pas de rebond) ?"*
- Si (b) structurel → **skip** (même si dans la bande -5/-12%)
- Si (a) technique → **keep**

C'est exactement le type de jugement qualitatif où le LLM ajoute de la valeur (vs un seuil mécanique). Et la cadence quotidienne (pas 5min) rend le coût LLM trivial.

---

## 7. Sizing & capital

- **Capital paper** : `capital_usd = 150000` (book réaliste pour mesurer l'edge à plein débit).
- **Book steady-state** : ~12-15 events/jour × 10 jours hold = ~120-150 positions simultanées.
- **Notionnel/position** : `capital / max_concurrent_positions`. À 150 positions → **~$1000/position**. Configurable.
- **Cap positions** : `max_open_positions` élevé (ex 200) — contrairement au gainers (5), le oversold est un book diversifié, la diversification EST le risk management.
- **Diversification** = le garde-fou principal : 150 petites positions non corrélées > 5 grosses. Un falling-knife isolé ne fait pas mal.

---

## 8. Schéma DB & migration

### 8.1 `strategy_mode`
Migration : étendre le CHECK de `lisa_session_configs.strategy_mode` pour accepter `'oversold'` (à côté de `investment`/`harvest`/`gainers`).

### 8.2 Nouveaux champs config (optionnels, defaults)
```sql
ALTER TABLE lisa_session_configs
  ADD COLUMN IF NOT EXISTS oversold_drop_min_pct NUMERIC DEFAULT -12,  -- borne basse (falling-knife)
  ADD COLUMN IF NOT EXISTS oversold_drop_max_pct NUMERIC DEFAULT -5,   -- borne haute
  ADD COLUMN IF NOT EXISTS oversold_hold_days INT DEFAULT 10,
  ADD COLUMN IF NOT EXISTS oversold_stop_catastrophe_pct NUMERIC DEFAULT -15,
  ADD COLUMN IF NOT EXISTS oversold_tp_pct NUMERIC DEFAULT NULL,        -- null = pas de TP
  ADD COLUMN IF NOT EXISTS oversold_position_notional_usd NUMERIC DEFAULT 1000,
  ADD COLUMN IF NOT EXISTS oversold_lisa_catalyst_filter BOOLEAN DEFAULT true;
```

### 8.3 `lisa_positions`
Réutiliser `horizon_target_date` (déjà nullable) = `entry + oversold_hold_days` jours ouvrés. Ajouter `exit_reason='oversold_hold_expired'` aux valeurs possibles.

---

## 9. Cadence & cron

- **Nouveau cron quotidien** : `OversoldScannerService.runDailyScan()` à **21:15 UTC** (15 min après close US 21:00, pour que l'EOD soit dispo).
  - 1 fetch EOD/symbole sur l'univers (~800-1000 calls EOD = 1 call chacun, PAS ×5 comme intraday → ~1000 quota/jour, négligeable).
- **Exit cron** : le `MechanicalTradingService` existant (cron 60s) ajoute la vérif hold-expired pour les positions mode oversold. Tourne déjà H24.

---

## 10. Plan d'implémentation (PRs découpées)

| PR | Contenu | Risque |
|---|---|---|
| **PR-1** | Migration `strategy_mode='oversold'` + champs config + `watchlist_universe` oversold | faible (additif) |
| **PR-2** | `OversoldScannerService` : screener losers EOD + cron quotidien 21:15 UTC + sélection/filtres (sans Lisa) | moyen |
| **PR-3** | Exit par durée dans `MechanicalTradingService` (hold J+10 + stop catastrophe) | moyen (touche le cron critique) |
| **PR-4** | Intégration Lisa catalyst filter (§6) | faible |
| **PR-5** | UI : retirer shadows désactivés, ajouter mode oversold au toggle | faible (front) |
| **PR-6** | Recycler HIGH (a0000001) → `strategy_mode='oversold'`, `capital_usd=150000`, autopilot ON | config |

**Ordre** : PR-1 → PR-2 → PR-3 (cœur) → activer en paper sur HIGH → observer → PR-4 (Lisa) → PR-5 (UI).

---

## 11. Observabilité & métriques de succès

### Métriques live (paper, sur HIGH recyclé)
- **Alpha vs SPY** par cohorte d'entrée (le chiffre de référence backtest = +1.4% J+10)
- WR, expectancy, distribution P&L
- Drift réalisé par bande de drop (-5/-8 vs -8/-12) — le gradient tient-il en live ?
- **% falling-knife échappés** (positions qui touchent le stop catastrophe -15%) → calibre le filtre <-12% + Lisa
- Comparaison régime : si SPY baisse pendant une cohorte, l'alpha tient-il ? (test cross-régime)

### Critère GO/PIVOT (après 4-6 semaines paper)
- **GO réel** : alpha live > +0.8% J+10 ET drawdown contrôlé ET le filtre catalyseur réduit les falling-knives
- **PIVOT** : si l'edge s'évapore en live (régime changé) ou si le bêta efface l'alpha net → neutraliser bêta (short SPY hedge) ou ranger

---

## 12. Ce que ce mode n'est PAS (garde-fous conceptuels)

- ❌ Pas du scalp (on tient 10 jours, pas 2h)
- ❌ Pas du momentum (on achète ce qui chute, pas ce qui monte)
- ❌ Pas un revenu régulier (P&L lumpy, médiane négative, queue droite)
- ❌ Pas market-neutral en v1 (exposition bêta assumée — hedge SPY = v2 si besoin)
- ❌ Pas validé cross-régime (1 trimestre testé — le paper live est le vrai juge)

---

## Annexe — Bibliographie edge

Les 9 backtests de la session (momentum × scalp/swing/short + PEAD + oversold ×3) sont la source primaire. Littérature de support :
- Short-term reversal (Lehmann 1990, Jegadeesh 1990) — l'oversold rebound est documenté
- Overreaction hypothesis (De Bondt & Thaler 1985)
- Le falling-knife / momentum baissier sur news structurelles (asymétrie confirmée empiriquement #3)
