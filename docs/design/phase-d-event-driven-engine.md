# Phase D2 — Event-Driven Alpha Engine (DESIGN — pas encore codé)

## Problème

Le scanner actuel est **réactif au pop 1-min** : il détecte un mouvement
APRÈS qu'il ait commencé. Sur les events programmés (FOMC, PCE, NFP,
earnings), les meilleurs setups sont :
- Pré-event : positions à T-5min pour capter le gap directionnel
- Post-event : fenêtre serrée T+5min → T+30min sur le mouvement de réaction

Les data 15j montrent un drag systématique le mercredi/jeudi (jour FOMC/PCE
typique) où le scanner entre AU MOMENT du choc → slippage massif.

## Objectif

Construire un **2e moteur orthogonal au scanner gainers** qui :
1. Lit `eodhd_economic_events` (PR #398, déjà en DB)
2. Snapshot prix T-5min sur tickers macro-sensibles
3. Trade dans fenêtre stricte post-event
4. Force-close à T+30min

## Architecture

### Composants nécessaires

| Composant | Status | Effort |
|---|---|---|
| Calendrier events DB | ✅ `eodhd_economic_events` | OK |
| Sentiment events (high/medium impact) | ✅ via EODHD | OK |
| Mapping event → tickers impactés | ❌ MISSING (PCE → tech rate-sensitive ?) | ~80 LoC config |
| Pre-event snapshot service | ❌ MISSING | ~150 LoC |
| Event-driven trade engine | ❌ MISSING (scanner momentum ≠ engine) | ~300 LoC |
| Force-close à T+window | ❌ MISSING | ~50 LoC |
| Shadow sim event-specific | ❌ MISSING | ~100 LoC |
| Tests | — | ~150 LoC |
| **Total** | | **~830 LoC** |

### Flux de données

```
03:30 UTC daily       : Cron pull events J→J+7 (déjà actif PR #398)
04:00 UTC daily       : Gemini brief synthétise + ranks events (déjà actif)
                      
T-30min event         : EventEngine charge events scheduled in next 30min
                      : Pre-warm prix actuel de tickers cibles
                      
T-5min event          : Snapshot OHLCV + spread + vol des tickers cibles
                      : (state preserved en DB pour replay/audit)
                      
T event (e.g. 12:30 UTC PCE)
                      : Wait window — pas de trade pendant T-5 → T+5
                      : Volatilité maximale, slippage incontrôlable
                      
T+5min                : Direction confirmation (close vs T-5 snapshot)
                      : Si delta directionnel > X% → trigger trade
                      : TP/SL = function(volatility, event type)
                      
T+30min               : Force-close (mandatory exit window)
                      : Lock profit ou cut loss, mesure outcome
```

### Mapping event → tickers (config)

```typescript
// data/event-ticker-map.json (config, pas migration)
{
  "PCE Price Index": {
    "watch": ["SPY.US", "QQQ.US", "TLT.US"],
    "type": "macro_rate"
  },
  "FOMC Rate Decision": {
    "watch": ["SPY.US", "QQQ.US", "TLT.US", "USDXM.FOREX"],
    "type": "macro_rate"
  },
  "Non-Farm Payrolls": {
    "watch": ["SPY.US", "DIA.US"],
    "type": "macro_jobs"
  }
  // ...
}
```

### TP/SL adaptatif par event

```typescript
const EVENT_TP_SL: Record<string, { tp: number; sl: number; windowMin: number }> = {
  macro_rate:     { tp: 0.015, sl: 0.010, windowMin: 30 },  // PCE, FOMC
  macro_jobs:     { tp: 0.012, sl: 0.008, windowMin: 20 },  // NFP, unemployment
  macro_cpi:      { tp: 0.020, sl: 0.012, windowMin: 30 },
  earnings_premarket: { tp: 0.025, sl: 0.015, windowMin: 45 },
};
```

### Env vars

- `EVENT_ENGINE_ENABLED=false` (default OFF — opt-in strict)
- `EVENT_ENGINE_DRY_RUN=true` (default true — shadow uniquement)
- `EVENT_ENGINE_MIN_IMPACT=high` (skip medium-impact pour V1)

## Edge estimé (sceptique)

| Source | Estimation |
|---|---|
| Events high-impact / mois | 15-20 (FOMC × 1, PCE × 1, NFP × 1, CPI × 1, ECB × 1, etc.) |
| Win-rate event-driven historical (literature) | 50-55% |
| Mean gain / event | 0.5-1.0% |
| Mean loss / event | -0.6-0.8% |
| Expected value / event | 0.05-0.15% × $787 = $40-120 |
| **EV / mois** | **$600-2400** |
| **EV / jour ouvré** | **$28-110/jour** |

**Note** : très très théorique. L'event-driven alpha est documenté en
littérature institutionnelle, mais à notre échelle (sizing $787, pas L2
book, latency Fly→EODHD ~500ms) on captera un fraction de l'edge potentiel.
Estimation prudente : **$10-50/jour ouvré**.

## Risques majeurs

1. **Slippage massif** sur les events high-impact (spread 10-100bps × 10).
   Mitigation : opérer sur tickers très liquides (SPY, QQQ, TLT — pas
   small-caps).
2. **News flash uncertainty** : un PCE peut sortir 30s avant 12:30 UTC sur
   leak. Mitigation : entrée à T+5min strict, jamais avant.
3. **Concurrence avec scanner momentum** : si à 12:35 le scanner détecte un
   pop sur SPY et l'EventEngine veut aussi entrer → race condition.
   Mitigation : flag `event_active` mute le scanner pendant la fenêtre.
4. **Coverage events** : EODHD economic-events ne couvre pas tous les events
   majeurs (notamment géopolitiques). Mitigation : V1 cible uniquement les
   events macro programmés.
5. **Walk-forward biaisé** : impossible de backtester proprement sur historique
   (les events sont rares, sample limité). Mitigation : 60 jours shadow strict
   avant promotion live.

## Plan de phase

### Phase D2-1 (3 jours) — Config + scaffolding
- Migration `event_engine_trades` (audit table)
- Service `EventEngineService` + cron T-30min
- Endpoint `/event-engine/upcoming` pour lister events watchés
- Tests scaffold

### Phase D2-2 (3 jours) — Trigger logic + shadow sim
- Detection direction post-event
- TP/SL adaptatif
- Shadow sim (jamais real trade en Phase D2)
- Endpoint `/event-engine/recent-evaluations`

### Phase D2-3 (3 jours) — Force-close + audit
- Cron force-close à T+window
- Audit complet (replay possible)
- Tests intégration

### Phase D2-4 (15-30 jours) — Mesure shadow stricte
- Run en shadow uniquement
- Collecter ~20-40 events
- Cross-réf outcome vs prédiction
- Decision : promotion live OU enterrement

### Phase D2-5 (conditionnel) — Live trading
- Si shadow montre EV > 0.1% × event positive
- Activer avec sizing très conservateur (50% du gainers)
- Re-mesure 30 jours

## Total effort estimé

- Code : **~830 LoC** (5-6 jours de coding focus)
- Shadow measurement : **30 jours minimum** avant decision
- Soit **~6 semaines** entre décision de coder et activation live

## Décision

À CODER quand :
- Les filtres actuels (PR #400 gate horaire, #402 trailing) sont mergés + observés 7j
- L'analyse Day-of-week confirme un edge sur PCE/FOMC (peut être pré-mesuré)
- Capacité de focus dev disponible (chantier de 1 semaine continue idéalement)

Pas une priorité court-terme. Plus haut ROI = optimiser ce qui existe.

## Alternative simple écartée

"Bloquer le scanner sur fenêtre event ±30min" — protège mais ne capture pas
l'edge. Pourrait être intermédiaire low-cost (~30 LoC) si on veut juste
éviter le drag. À considérer comme Phase D2-0.
