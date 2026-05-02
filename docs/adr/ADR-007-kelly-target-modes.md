# ADR-007 — Kelly sizing + Target Modes (Gainers V1)

- **Date** : 2026-05-02
- **Owner** : Yannick (yannicke819-max)
- **Status** : ACCEPTED
- **PR** : #207a (backend foundations) + #207b (UI simulator) + #207c (3-tabs UI split)

## Contexte

ADR-005 §11.1 verrouille TP/SL via `path_eff` (×1.5/×1.0 equity, ×2.0/×0.8 crypto). Ce qui n'est PAS spécifié :
1. **Combien** allouer par position quand un signal ACCEPT fire ?
2. **Quel objectif monétaire** vise-t-on (daily, monthly, annual) ?
3. **Comment échelonner** sans casser l'algo si l'utilisateur veut $100/jour vs $5000/mois vs +30% annuel ?

ADR-007 répond à ces 3 questions.

## 1. Décision

### 1.1 Target Modes (4 horizons)

```
TargetMode = ABSOLUTE_USD | PCT_OF_EQUITY | MONTHLY_COMPOUND | ANNUAL_COMPOUND
```

L'utilisateur définit **un seul** mode + valeur. Le `TargetDerivationService` calcule les 3 horizons (daily/monthly/annual) via compounding géométrique :

| Conversion | Formule | Constante |
|---|---|---|
| annual → monthly | `(1+annual)^(1/12) - 1` | 12 mois calendaires |
| annual → daily | `(1+annual)^(1/252) - 1` | 252j ouvrés/an |
| monthly → daily | `(1+monthly)^(1/21) - 1` | 21j ouvrés/mois |

### 1.2 Kelly Sizing

Formule Kelly pour pari binaire :
```
f* = (b × p - q) / b
  où b = payoff_ratio = avg_gain / avg_loss
       p = probabilité de gain (winRate)
       q = 1 - p
```

**Conventions ADR-007 §3** :
- `p` = **wilson_lower_95% bound** sur l'échantillon shadow (conservateur)
- `b` = ratio `TP_pct / SL_pct` selon BLOC 4 §11.1 (= 1.5 equity, = 2.5 crypto)
- **HALF-KELLY default** (`f*/2`) per Cohen (2018) pour réduire la variance
- **Clamp [0, 0.25]** pour éviter sur-leverage extrême
- **Sample size minimum = 30** ; en dessous, retourne `null` (pas de Kelly)

### 1.3 Validation empirique (test §3.3)

Asymptote (n → ∞), winRate=55%, R/R=1.67 :
- wilson lower → 0.5402
- full Kelly = (1.67 × 0.5402 - 0.4598) / 1.67 ≈ 0.265 → **clamped à 0.25**
- half-Kelly ≈ 0.133 ≈ **13%**

Pour n=30, winRate=55% (échantillon shadow minimum ADR-005 Step 9) :
- wilson lower ≈ 0.376 (très conservateur)
- full Kelly ≈ 0.002 → half-Kelly ≈ 0.001 (≈ 0.1%, ne pas trader effectivement)

**Conclusion** : Kelly est **mathématiquement prudent** sur les premiers signaux shadow → croissance progressive de la fraction Kelly à mesure que `n` augmente. C'est le comportement souhaité.

## 2. Migrations livrées (PR #207a)

### 2.1 Migration 0105 — extension `lisa_session_configs.daily_harvest_config`

JSONB enrichi (zéro impact backward-compat) :
- `target_mode` : enum (default `ABSOLUTE_USD`)
- `target_value` : numeric
- `monthly_target_pct` : numeric NULL
- `annual_target_pct` : numeric NULL
- `derived_daily_pct` : numeric NULL (auto-calc compounding)

### 2.2 Migration 0106 — `gainers_v1_shadow_signals.kelly_fraction_suggested`

Colonne ajoutée :
- `kelly_fraction_suggested NUMERIC(5,4)` — fraction calculée
- `kelly_inputs JSONB` — audit `{win_rate_lower_wilson, payoff_ratio, equity_ref, n_sample, full_kelly, half_kelly_applied}`

## 3. Architecture

### 3.1 Pure logic services

`apps/api/src/modules/gainers-scanner/target-modes/target-derivation.service.ts` :
- `annualToMonthly`, `annualToDaily`, `monthlyToDaily`, `dailyToMonthly`, `dailyToAnnual`
- `derive(config, equityUsd)` → triple représentation `daily/monthly/annual` × `pct/usd`
- `computeDerivedDailyPct(config)` → pour pré-calcul DB

`apps/api/src/modules/gainers-scanner/kelly/kelly-sizing.service.ts` :
- `compute(input)` → `{ fractionSuggested, fullKelly, winRateLowerWilson, inputs }`
- `toPositionSizeUsd(fraction, equityUsd)` → conversion USD

### 3.2 Wiring GainersModule

Both services exportés. À consommer par :
- ShadowRunService (PR #207a — persiste `kelly_fraction_suggested` lors de `persistShadowSignal`)
- Simulator endpoint (PR #207b)
- TopGainersScannerService (post-bascule live, gating par `f* > 0`)

## 4. Tests (PR #207a)

- 16 tests `target-modes.spec.ts` : conversions math + edge cases + 4 modes
- 11 tests `kelly-sizing.spec.ts` : clamp, half-Kelly, wilson conservateur, sample < 30, edge négatif
- Boot NestJS : ✅ port 3990 bindé, GainersModule + AdminModule + LisaModule init OK
- Suite gainers totale : **332 tests / 0 failures / 2 todo legacy** (305 → 332, +27)

## 5. Out of scope ADR-007 (couvert par PR #207b et #207c)

- **PR #207b** : endpoint `POST /admin/gainers/simulate-kelly` + UI form `/dashboard/gainers/simulator` avec saisie utilisateur complète (TargetMode, capital, Kelly slider, horizon, universe, signal filters, risk caps, save preset, live shadow feed toggle)
- **PR #207c** : split UI 3 onglets (GAINERS purple / HARVEST emerald / INVESTMENT sky) avec ObjectiveEditor par mode, badges SIMULATION/LIVE
- Migration 0107 (`gainers_simulator_presets`) — dans PR #207b

## 6. Référence académique

- Kelly, J. (1956). *A New Interpretation of Information Rate*. Bell System Tech. Journal.
- Thorp, E. (1969). *Optimal Gambling Systems for Favorable Games*. Review of the International Statistical Institute.
- Cohen (2018). *The Mathematics of Money Management* (chap. half-Kelly variance reduction).
- ADR-005 §11.1 (TP/SL ratios) + ADR-005 §5 Step 9 (shadow run sample size).
