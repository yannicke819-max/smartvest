# Autopilot — états et transitions (P8-BR)

L'autopilot SmartVest a 3 dimensions d'état orthogonales, gouvernées par
des champs distincts sur `lisa_session_configs`. Cette page documente
la matrice complète + les transitions automatiques.

## Champs source de vérité

| Champ | Type | Sémantique | Modifiable par |
|---|---|---|---|
| `autopilot_enabled` | `boolean` | Master toggle de l'autopilot. `true` = cycle cron actif | Utilisateur (UI checkbox) |
| `kill_switch_active` | `boolean` | Coupure d'urgence manuelle/critique. `true` = aucune action | Utilisateur (UI bouton rouge) ou `MechanicalTradingService` (drawdown 2j > -10%) |
| `autopilot_paused_reason` | `text NULL` | Pause réversible (P8-BR). `NULL` = pas en pause. Valeurs : `BUDGET_EXCEEDED` / `MANUAL` / `PROVIDER_OUTAGE` | `LisaService.generateProposal` (BUDGET_EXCEEDED auto) ; clear par `LisaAutopilotService.maybeResumeOrSkip` |
| `daily_cost_budget_usd` | `numeric` | Plafond journalier API en USD. `null` = pas de limite | Utilisateur (UI input) |

## Matrice des états visibles

| `enabled` | `kill_switch` | `paused_reason` | Comportement |
|:---:|:---:|:---:|---|
| `false` | * | * | Pas de cycle (autopilot OFF complet) |
| `true` | `true` | * | Aucune action — kill-switch prioritaire absolu |
| `true` | `false` | `null` | Cycle normal (cron LisaAutopilotService) |
| `true` | `false` | `'BUDGET_EXCEEDED'` | Skip cycles tant que cost ≥ 90% du budget. Auto-resume au prochain cycle dès passage sous 90% |
| `true` | `false` | `'MANUAL'` | Skip indéfini (admin pause). Resume manuel uniquement |
| `true` | `false` | `'PROVIDER_OUTAGE'` | Skip (réservé future detection automatique) |

## Transitions automatiques

```
                   budget_used >= budget_total
                   ┌───────────────────────────┐
                   │                           ▼
       ┌───────────────┐               ┌──────────────────────┐
       │ NORMAL        │               │ PAUSED               │
       │ paused = null │               │ paused = BUDGET_EXC. │
       │ enabled = T   │               │ enabled = T (toujours)│
       └───────────────┘               └──────────────────────┘
                   ▲                           │
                   │                           │
                   └───────────────────────────┘
                   budget_used < 0.9 × budget_total
                   (rollover UTC OU bump budget)
```

### Pause sur BUDGET_EXCEEDED

- **Déclenchée par** : `LisaService.generateProposal` quand `apiCostTracker.getTodayTotalUsd() >= daily_cost_budget_usd`
- **Action** : `UPDATE lisa_session_configs SET autopilot_paused_reason='BUDGET_EXCEEDED'` + log `kind='autopilot_paused'`
- **`autopilot_enabled` reste `true`** — c'est ça qui change vs comportement legacy pré-P8-BR (où on flippait `enabled=false`)

### Auto-resume sur retour < 90% du budget

- **Déclenchée par** : `LisaAutopilotService.runAutopilotCycleInner` au début de chaque cycle, via `maybeResumeOrSkip(cfg)`
- **Conditions de resume** (OR) :
  1. `daily_cost_budget_usd` est `null` (budget retiré)
  2. `getTodayTotalUsd() < 0.9 × daily_cost_budget_usd` (rollover UTC à minuit OU budget bumped)
- **Action** : `UPDATE ... SET autopilot_paused_reason=NULL` + log `kind='autopilot_resumed'` (rationale = trigger précis)

### Cas limite : passage à 90% pile

`< 0.9` strict. À 90.0% exact → encore en pause. Le seuil 90% est un tampon volontaire pour éviter le flap (resume → cycle → re-pause aussitôt si on était à 99% sans rollover).

## Endpoint observable

```
GET /autopilot/cost-status?portfolioId=...
```

Retour :
```json
{
  "daily_used_usd": 47.23,
  "daily_budget_usd": 200,
  "pct": 0.236,
  "paused_reason": null,
  "autopilot_enabled": true,
  "kill_switch_active": false,
  "next_reset_utc": "2026-04-29T00:00:00.000Z"
}
```

UI badge `<AutopilotBudgetBadge>` poll 30s, couleur :
- 🟢 vert : pct < 60%
- 🟡 ambre : pct ∈ [60%, 90%[
- 🔴 rouge : pct ≥ 90% **OU** `paused_reason !== null`

## Logs decision_log

| `kind` | Quand | `payload` clés |
|---|---|---|
| `autopilot_paused` | budget atteint | `today_cost_usd`, `budget_usd`, `paused_reason='BUDGET_EXCEEDED'` |
| `autopilot_resumed` | clear automatique | `resume_trigger` (e.g. `cost=$51 < 90% of $200`) |
| `autopilot_disabled` | (legacy, plus émis depuis P8-BR) | — |

## Backfill

Pour les rows existantes en prod où `autopilot_enabled=false` a été causé par un BudgetExceededError pré-P8-BR (incident 27-28/04), exécuter manuellement :

```bash
npx ts-node scripts/backfill-autopilot-paused-reason.ts
```

Le script identifie les configs où :
- `autopilot_enabled = false`
- ET le dernier `lisa_decision_log.kind = 'autopilot_disabled'` cite `daily_api_budget_exceeded`

…et propose : remettre `autopilot_enabled = true` + `autopilot_paused_reason = 'BUDGET_EXCEEDED'`. Le cron auto-resume se chargera de la reprise effective au prochain rollover OU bump budget.

**Idempotent** + dry-run par défaut (flag `--apply` pour exécuter).

## Tests

`apps/api/src/modules/lisa/services/__tests__/autopilot-budget-resume.spec.ts` couvre 9 scénarios : aucune pause, cost < 90% (resume), cost = 89.99 (just under), cost ≥ 90% (skip), bump budget, budget removed, MANUAL skip, PROVIDER_OUTAGE skip, intégration 3-cycle.
