# Cibles Trajectoire — Profil Sniper SmartVest

**Yaya obligation résultats #3** : configurer cibles daily/monthly/annual sur `lisa_session_configs.daily_harvest_config` JSONB pour permettre à Lisa de moduler `trajectory_status` (EN_AVANCE / DANS_LE_PLAN / EN_RETARD / HORS_TRAJECTOIRE).

## Profil Sniper actif

- $10k sim
- 60% deploy max
- max position 25%
- anti-consensus 8/10

## Cibles proposées (cohérentes avec profil Sniper)

| Horizon | Target | Justification |
|---|---|---|
| **Daily** | **0.15%** | $15/jour sur $10k = conservateur sniper (vs 0.30% beginner, 0.80% intermediate, 1.50% experienced, 2.50% scalper_pro) |
| **Monthly** | **3.5%** | $350/mois — compounded ~21 trading days |
| **Annual** | **25%** | $2500/an — top decile retail performance |

Coherence math :
- Daily 0.15% × 21 jours/mois = ~3.2% (proche 3.5% target)
- Monthly 3.5% × 12 mois compounded = ~51% — donc on lisse à 25% annuel pour anti-volatilité

## SQL UPDATE — à coller dans Supabase SQL editor

### Si tu connais l'email user

```sql
UPDATE lisa_session_configs
SET daily_harvest_config = COALESCE(daily_harvest_config, '{}'::jsonb) || jsonb_build_object(
  'daily_target_pct', 0.0015,
  'monthly_target_pct', 0.035,
  'annual_target_pct', 0.25,
  'profile', 'sniper',
  'target_mode', 'ANNUAL_COMPOUND',
  'target_value', 0.25
)
WHERE user_id = (SELECT id FROM auth.users WHERE email = 'TON_EMAIL@example.com' LIMIT 1);
```

### Apply sur tous les portfolios actifs (simple)

```sql
UPDATE lisa_session_configs
SET daily_harvest_config = COALESCE(daily_harvest_config, '{}'::jsonb) || jsonb_build_object(
  'daily_target_pct', 0.0015,
  'monthly_target_pct', 0.035,
  'annual_target_pct', 0.25,
  'profile', 'sniper',
  'target_mode', 'ANNUAL_COMPOUND',
  'target_value', 0.25
)
WHERE autopilot_enabled = true;

-- Vérification
SELECT
  user_id,
  daily_harvest_config->>'daily_target_pct' AS daily,
  daily_harvest_config->>'monthly_target_pct' AS monthly,
  daily_harvest_config->>'annual_target_pct' AS annual,
  daily_harvest_config->>'profile' AS profile
FROM lisa_session_configs
WHERE autopilot_enabled = true;
```

## Effet attendu

Une fois inséré, l'agent mécanique (cron 1 min) lira `lisa_mechanical_directives.trajectory_status` calculé par Lisa toutes les 30 min et pourra moduler :
- `EN_AVANCE` : élargir sélectivité (compositeScore ≥ 0.7)
- `DANS_LE_PLAN` : sélectivité standard (compositeScore ≥ 0.6)
- `EN_RETARD` : resserrer sélectivité (compositeScore ≥ 0.55)
- `HORS_TRAJECTOIRE` : STOP+DIAGNOSTIC (CLAUDE.md §1bis lock)

## Roadmap continuité

- ✅ Migrations 0051/0052 déjà appliquées
- 🟡 Migration 0110 partiellement appliquée → fix par migration 0113 (PR6.6.7)
- ⏳ SQL UPDATE manuel ci-dessus pour activer cibles
- ⏳ Lisa cycle suivant (~30 min) lira config + écrira `lisa_mechanical_directives` avec `trajectory_status` calculé
