# ADR-005 — Gainers Scanner Algo V1

| Champ | Valeur |
|---|---|
| **Statut** | Proposed (01/05/2026) |
| **Author** | Claude Code session 014G5f17WdhyTYUFirJBUrLb |
| **Successor of** | — |
| **Related** | ADR-006 (découplage scanner Gainers — *contraintes architecturales*) |
| **Decision-makers** | Owner SmartVest |

---

## 1. Contexte

Le scanner Gainers actuel (`apps/api/src/modules/lisa/services/top-gainers-scanner.service.ts`) sélectionne les top gainers 1-min puis applique une grille hétérogène : persistence multi-TF (P8), path quality (P9-UX), TP/SL fixes (P19x.2). L'algo n'a **jamais été spécifié comme un système de trading cohérent** — c'est un empilement de gates ajoutés au fil des incidents.

Symptômes observés en production (avril 2026) :

- Win-rate inférieur à 50 % sur les 30 derniers paper_trades fermés
- Pas de gestion explicite de la couverture des coûts (TP qu'on prend ne paie pas toujours les frais cumulés)
- Pas de mesure de qualité d'entrée (entrée tardive sur extension verticale puis mean-reversion)
- OBV / divergence baissière jamais utilisés
- Aucun trailing-stop, aucun time-stop, aucun adaptatif

**Objectif Algo V1** : poser un système de trading explicite, quantifié, testable, avec des invariants techniques traçables dans le code et un protocole de bascule live mesuré.

L'algo V1 vit obligatoirement dans le futur module `apps/api/src/modules/gainers-scanner/` (cf. ADR-006). Il n'est jamais ajouté au répertoire `lisa/services/` — toute proposition contraire viole la séparation de responsabilité.

---

## 2. Décisions arbitrées

### 2.1 — Setups d'entrée (V1) : 2 triggers seulement

| Trigger | Condition d'entrée | Origine |
|---|---|---|
| `pullback_HL` | Pullback maintenu au-dessus du dernier higher-low local sur 5m, repli ≤ 1.2 % depuis le HoD | Mean-reversion contrôlée |
| `vwap_reclaim` | Repasse au-dessus de VWAP intraday après ≥ 3 bougies 1m sous VWAP, sur volume RVOL ≥ 1.5 | Reprise structurée |

**`opening_range_breakout` (ORB)** : déféré à V1.1 post-audit (besoin baseline 20 jours pour calibrer le seuil de cassure).

### 2.2 — Couverture des coûts : 30 % strict

Pour qu'une position soit ouverte :
```
expected_net_tp_after_fees ≥ 0.30 × (broker_fee + spread_cost + slippage)
```
- `broker_fee` lu depuis `cost-engine`
- `spread_cost` = spread proxy × notionnel (cf. 2.7)
- `slippage` budget fixé à 5 bps par défaut, ajustable par `gainers_slippage_budget_bps`

Si `expected_net_tp` est < 30 % du coût total → REJECT immédiat avant même le scoring.

### 2.3 — Time-stop : 3 heures

Toute position ouverte est fermée à 3h calendaires si elle n'a pas atteint TP ni SL et reste dans la zone neutre (±0.5 % de l'entry).

Justification : éviter de tenir un trade momentum qui s'est dégradé en consolidation latérale.

### 2.4 — Trailing-stop : 40 % / 70 %

| Stade | Action |
|---|---|
| PnL ≥ 40 % du TP cible | Stop monte à breakeven (entry × 1.0001 pour couvrir frais minimaux) |
| PnL ≥ 70 % du TP cible | Stop monte à 50 % du TP cible (lock-in 50 %) |

Avant : SL fixe à -1.0 %, jamais re-pricé. Lock partiel après mouvement favorable.

### 2.5 — OBV : scoring uniquement, jamais kill

OBV (On-Balance Volume) divergence baissière contribue au score (max -5 points sur 100), **mais ne déclenche jamais un REJECT seul**.

Justification : trop de faux positifs sur small-caps illiquides — laisser le combined score arbitrer.

### 2.6 — Persistence multi-TF : seuil dynamique

Le seuil `gainers_min_persistence_score` (déjà en DB, P8) reste configurable, mais l'algo V1 ajoute un override dynamique : sur setup `pullback_HL`, seuil abaissé à 0.5 (le pullback est l'inverse de la persistence par construction).

### 2.7 — Spread proxy : version raffinée (décision 01/05/2026)

```typescript
// apps/api/src/modules/gainers-scanner/services/spread-proxy.service.ts
function spreadProxy(candles1m: Candle[], lookback = 5): number | null {
  // Pré-condition : volume floor — au moins 3 bougies sur 5 doivent
  // avoir un volume > 0. Sinon le proxy est meaningless (bougies creuses).
  const recent = candles1m.slice(-lookback);
  const nonEmpty = recent.filter((c) => c.volume > 0);
  if (nonEmpty.length < 3) return null; // gate REJECT 'illiquid'

  // Médiane des spreads (H-L) × 0.5 / close, robuste aux outliers.
  const spreads = nonEmpty
    .map((c) => ((c.high - c.low) * 0.5) / c.close)
    .sort((a, b) => a - b);
  const mid = Math.floor(spreads.length / 2);
  const median = spreads.length % 2 === 1
    ? spreads[mid]
    : (spreads[mid - 1] + spreads[mid]) / 2;

  // Cap dur 0.30 % (au-delà = aberration, on rejette).
  return Math.min(median, 0.003);
}
```

**Audit trail** : chaque rejection liée au spread écrit dans `decision_log` :
```json
{
  "kind": "gainers_v1_reject",
  "reason": "spread_too_wide",
  "spread_proxy": 0.0024,
  "gate": 0.0015,
  "candles_sampled": 5,
  "candles_with_volume": 4,
  "method": "median_5_volume_floor"
}
```

**Gate scanner** : par défaut 0.15 % (`gainers_max_spread_proxy_bps = 15`). Configurable.

**V1.1 post-audit** : bascule sur EODHD `/real-time` natif quand baseline 30 jours validée. Le proxy reste comme fallback.

---

## 3. Décisions techniques détaillées

### 3.1 — Migration `gainers_volume_baselines` (décision 01/05/2026)

```sql
-- supabase/migrations/0101_gainers_volume_baselines.sql
CREATE TABLE gainers_volume_baselines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol TEXT NOT NULL,
  exchange TEXT NOT NULL,                 -- 'NYSE' | 'NASDAQ' | 'BINANCE' | …
  asset_class TEXT NOT NULL,              -- 'equity' | 'crypto'
  bucket_5min_est INT NOT NULL,           -- bucket 0..287 (5-min slot du jour US/East)
  median_volume NUMERIC(20, 4) NOT NULL,  -- médiane sur 20 jours ouvrés
  p90_volume NUMERIC(20, 4) NOT NULL,     -- 90e percentile
  sample_size INT NOT NULL,               -- nombre de jours utilisés
  last_nonzero_at TIMESTAMPTZ,            -- dernier observation > 0 (détecte symbol mort)
  computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT asset_class_valid CHECK (asset_class IN ('equity', 'crypto'))
);

CREATE UNIQUE INDEX gainers_volume_baselines_pk_idx
  ON gainers_volume_baselines (symbol, exchange, bucket_5min_est);

CREATE INDEX gainers_volume_baselines_last_nonzero_idx
  ON gainers_volume_baselines (last_nonzero_at);
```

**Logique baseline différenciée** :
- `equity` : baseline same-time-of-day (US/Eastern, exclut weekends + holidays NYSE)
- `crypto` : baseline same-time-of-day UTC (24/7, fenêtre glissante 20 jours)

**Détection symbol mort** : si `last_nonzero_at` > 5 jours → exclu du scoring (le symbol est vraisemblablement délisté ou suspendu).

**Sizing estimatif** :
- ~500 symbols × 288 buckets × 50 octets ≈ 7.2 Mo (+ index ~30 % → ~9.5 Mo)
- Cron pre-market : 500 symbols × 5 endpoints EODHD × 1 fetch = 2 500 calls/jour (well below 100k/jour ALL-IN-ONE)

### 3.2 — RVOL (Relative Volume)

```
rvol = volume_5min_current / median_volume_baseline_same_5min_bucket
```

Lookup atomique (1 requête par candidat) sur `gainers_volume_baselines`.

Gate : `rvol ≥ 1.5` requis pour `vwap_reclaim`. Optionnel pour `pullback_HL` (intervient comme +10 pts au score si ≥ 2.0).

### 3.3 — Score composite (V1)

```
score = base_persistence_score × 30
      + base_path_efficiency × 20
      + (rvol >= 2 ? 10 : rvol >= 1.5 ? 5 : 0)
      + (obv_divergence_bearish ? -5 : 0)
      + (sector_alignment_positive ? 5 : 0)
      + (cost_coverage_ratio - 0.30) × 30   // bonus si net plus que 30%
```

Score sur 100. Seuil ACCEPT : ≥ 60. Tracé dans `decision_log` avec décomposition par composant.

---

## 4. Plan d'implémentation — Steps 6 à 10

**Préfix `feat/gainers-v1-`** systématique. Chaque PR auto-merge sur main dès CI verte (cf. CLAUDE.md règle opérationnelle).

### Step 6 — Volume baselines + RVOL (6-7 jours, ajusté)

Périmètre élargi vs estimation initiale :

- Migration `0101_gainers_volume_baselines` (1j)
- `GainersVolumeBaselineService` lecture/écriture (1j)
- Cron pre-market (US 09:00 EST = 13:00 UTC, ajustement DST automatique) (1j)
- **Backfill initial 20 jours** (sinon scanner tourne à vide jusqu'à J+20) — script `scripts/backfill-gainers-baselines.ts` (1j)
- Gestion holidays NYSE (table `nyse_market_holidays` à seeder, sinon baseline computation skippe les jours férié US par erreur) (0.5j)
- Gestion DST US (Eastern → +5h hiver / +4h été) — utiliser `Intl.DateTimeFormat` avec `timeZone: 'America/New_York'` (0.5j)
- Tests unitaires service baseline + script backfill (1-2j)

**Bloquant** : Step 4 (squelette module + shared-risk extract) doit être mergé avant.

### Step 7 — Setups + scoring V1 (3 jours)

- `apps/api/src/modules/gainers-scanner/services/setups/pullback-hl-detector.ts`
- `apps/api/src/modules/gainers-scanner/services/setups/vwap-reclaim-detector.ts`
- `apps/api/src/modules/gainers-scanner/services/scoring/composite-scorer.ts`
- **Tests unitaires obligatoires sur fixtures candles 1m réelles** capturées sur RTX et GDX (cas historiques smooth/choppy/pump-and-dump)
  - Pas de fixtures synthétiques — capturer 5 cas réels minimum par setup
  - Stockage `apps/api/src/modules/gainers-scanner/__tests__/fixtures/candles/`

### Step 8 — Entry trigger + viability + exit manager (3 jours)

- `evaluateEntryTrigger(candidate, candles)` → `'pullback_HL' | 'vwap_reclaim' | null`
- `checkNetTpViability(candidate, costs)` → `{ accept: boolean, reason: string, ratio: number }`
- `manageExit(position, marketState)` → `'hold' | 'tp_hit' | 'sl_hit' | 'time_stop' | 'trail_to_be' | 'trail_to_50'`
- **Tests d'intégration bout-en-bout** : pipeline `scoreCandidate → evaluateEntryTrigger → checkNetTpViability → manageExit` sur fixtures complètes (ouverture jusqu'à fermeture)
  - Au moins 3 scénarios complets : winner-by-tp, loser-by-sl, time-stop-zero

### Step 9 — Shadow run + bascule live (2j code + 10 jours observation)

**Shadow run** : algo V1 calcule signaux mais ne place pas d'orders. Logge dans `gainers_v1_shadow_signals` (nouvelle table, append-only) en parallèle de l'algo legacy.

**Bascule live** conditionnée par tous les critères :

1. **≥ 30 signaux ACCEPT générés** par l'algo V1 sur la fenêtre 10 jours (sinon échantillon trop petit pour conclure)
2. **Win-rate ≥ 45 %** sur les signaux ACCEPT (mesure : si algo V1 avait été live, ratio paper_trades fermés en gain)
3. **Divergence avec legacy ≤ 20 %** sur l'overlap : sur les candidats que les deux scorent, ≤ 20 % d'écart d'ACCEPT/REJECT — au-delà = différence trop grande, bug suspect plutôt qu'amélioration
4. **Zéro erreur critique** dans `decision_log` kind `gainers_v1_error`

Si critères tous remplis → flip flag `GAINERS_V1_LIVE=true`. Sinon, prolonger observation 5 jours et réévaluer.

### Step 10 — Observability dashboard (1j) — BLOQUANT pour bascule live

Page admin `/admin/gainers/v1-metrics`, protégée par `x-admin-token` (pattern AdminEodhdStatusController).

Affichage temps réel :

- Signals generated (count par jour, ligne par jour)
- ACCEPT vs REJECT breakdown par step (cost coverage, persistence, path, RVOL, spread)
- Win-rate sur signaux ACCEPT (rolling 10 jours)
- Drawdown cumulé shadow
- Divergence vs legacy (% ACCEPT/REJECT divergent)
- Last 50 signals tableau : timestamp, symbol, score, decision, reason, current PnL si position open

Sans ce dashboard, impossible de trancher objectivement la bascule live. Donc **bloquant**.

---

## 5. Total révisé

| Étape | Effort code |
|---|---|
| Step 6 — Volume baselines | 6-7j |
| Step 7 — Setups + scoring | 3j |
| Step 8 — Entry/viability/exit | 3j |
| Step 9 — Shadow run | 2j code + 10j observation |
| Step 10 — Dashboard obs | 1j |
| **Total** | **~15 dev-jours + 2 semaines observation** |

**Calendrier estimé : ~5 semaines** (pas 4) en série séquentielle. Parallélisation difficile : Step 7 dépend de Step 6 (RVOL nécessite baselines), Step 8 dépend de Step 7 (manageExit consomme score), Step 9 dépend de Step 8 (signaux complets).

---

## 6. Dépendances dures

```
ADR-006 (découplage)  →  Step 4 (module skeleton + shared-risk)  →  Steps 6, 7, 8  →  Step 9  →  Step 10
                                                                                       ↑
                                                                                       (concurrent avec Step 9)
```

- **Step 6 bloqué** tant que Step 4 (squelette `gainers-scanner/` module + extraction shared-risk) non mergé
- **Step 4 bloqué** tant qu'ADR-006 (découplage) validé
- **Steps 6-10 ne démarrent qu'après Step 4** = ~2 semaines minimum d'attente sur le chemin critique

---

## 7. Risques

| Risque | Probabilité | Impact | Mitigation |
|---|---|---|---|
| Baseline volume insuffisante (< 20 jours) | Haute (J+0) | Algo V1 tourne à vide | Backfill initial 20 jours dans Step 6 |
| Win-rate < 45 % en shadow | Moyenne | Pas de bascule live, retour planche à dessin | 10 jours d'observation = échantillon assez gros pour décider |
| Divergence > 20 % avec legacy | Moyenne | Bug ou changement de comportement non documenté | Audit signal-par-signal sur les divergents avant bascule |
| OBV scoring trop pénalisant | Basse | Faux REJECT | Cap à -5 pts (ne kill jamais), monitoring sur dashboard |
| Time-stop 3h trop court (US small-cap) | Basse | Ferme winners potentiels | Ajustable par config DB (`gainers_time_stop_hours`) |
| EODHD `/real-time` non couvert plan ALL-IN-ONE | Basse | Spread proxy reste seul | Spread proxy déjà robuste avec volume floor + median |

---

## 8. Hors scope (V1)

Reportés en V1.1 ou V2 :

- ORB (opening range breakout) — défié J+30 post-baseline
- EODHD `/real-time` natif pour spread — défié post-audit V1
- ML-based scoring (gradient boosting on close trade outcomes) — V2
- Cross-asset signals (BTC.D → equity tech rotation) — V2
- News-driven blackout window (skip 5 min après events macro) — V1.1

---

## 9. Validation

- [ ] PR ADR-006 mergé (renumbering découplage)
- [ ] PR Step 4 (`feat/shared-risk-extract`) mergé
- [ ] PR Step 6 (`feat/gainers-v1-volume-baselines`) mergé
- [ ] PR Step 7 (`feat/gainers-v1-setups-scoring`) mergé
- [ ] PR Step 8 (`feat/gainers-v1-entry-exit`) mergé
- [ ] PR Step 9 (`feat/gainers-v1-shadow-run`) mergé
- [ ] PR Step 10 (`feat/gainers-v1-observability`) mergé
- [ ] 10 jours observation complets
- [ ] Critères bascule live tous validés (30 signals, win-rate ≥ 45 %, divergence ≤ 20 %, zéro erreur critique)
- [ ] Flag `GAINERS_V1_LIVE=true` activé
