# Phase D-4 & D-5 — Mesure shadow + Promotion live (PAS DE CODE)

Cette note documente les phases **non-code** du chantier event-driven engine.
Les phases D-4 et D-5 sont des phases d'**observation prod** et de **décision
data-driven**. Aucune ligne de code à écrire ici.

## D-4 — Mesure shadow stricte (30+ jours)

### Préconditions

- D-1, D-2, D-3 mergés en prod ✅
- `EVENT_ENGINE_ENABLED=true` activé côté Fly ⏸️ (action user)
- `eodhd_economic_events` peuplée quotidiennement par cron 03:30 UTC ✅

### Critères de réussite à mesurer

Query SQL à exécuter à T+30j post-activation :

```sql
SELECT
  raw_payload->>'category_type' AS event_type,
  trigger_direction,
  COUNT(*) AS n,
  ROUND(AVG(realized_pnl_pct)::numeric, 3) AS mean_pnl_pct,
  ROUND(STDDEV(realized_pnl_pct)::numeric, 3) AS std_pnl_pct,
  ROUND((COUNT(*) FILTER (WHERE realized_pnl_pct > 0)::numeric / COUNT(*)) * 100, 1) AS win_rate_pct,
  ROUND(SUM(realized_pnl_pct)::numeric, 2) AS sum_pnl_pct
FROM event_engine_trades
WHERE status = 'force_closed'
  AND exit_taken_at > NOW() - INTERVAL '30 days'
GROUP BY event_type, trigger_direction
ORDER BY n DESC;
```

### Seuils de décision (D-5)

| Métrique | Seuil GO live | Seuil NO-GO |
|---|---|---|
| n total trades shadow | ≥ 50 | < 30 (sample trop petit) |
| Mean PnL net | ≥ +0.10% | ≤ -0.05% |
| Win rate | ≥ 50% | < 45% |
| Sharpe (mean/std) | ≥ 0.3 | ≤ 0 |
| Worst single trade | > -2.0% | ≤ -3.0% |

**Décision intermédiaire** (entre GO et NO-GO) : prolonger shadow 30j de plus
pour collecter plus de sample. Particulièrement si certains event_types ont
n < 10.

### Risques à monitorer pendant D-4

1. **Slippage simulé vs réel** : on calcule pnl avec exit_price = mid-price.
   En réalité, en post-event, le spread peut être 5-50bps. Le mean_pnl_pct
   shadow surestime probablement de 0.05-0.15%. **Décompter de la metric
   avant decision GO**.
2. **News leak** : un PCE peut sortir 30s avant 12:30 UTC. Le snapshot T-5min
   à 12:25 UTC est protégé (avant le leak), mais l'évaluation T+5min à 12:35
   capte une situation déjà digérée. À monitorer via `trigger_delta_pct`
   distribution.
3. **Coverage events** : si moins de 15 events high/medium-impact par mois,
   le sample met plus de temps à atteindre n=50. Calendrier macro 2026
   prévoit ~18 events/mois sur US+EU+JP. Plausible.
4. **Cross-events** : un FOMC + PCE le même jour → overlapping triggers sur
   SPY. À vérifier que le `UNIQUE (event_name, country, date, symbol)` ne
   crée pas de bias.

## D-5 — Promotion live (CONDITIONNELLE D-4)

**À considérer SEULEMENT si D-4 retourne GO.**

### Changements code requis (à coder en PR séparée Phase D-5)

1. **Nouvelle env `EVENT_ENGINE_LIVE_TRADING_ENABLED=false`** (default OFF,
   opt-in strict supplémentaire à `EVENT_ENGINE_ENABLED`).
2. **Modification de `evaluateTriggers`** : si trigger validé ET live enabled
   → ouvrir position réelle via `LisaService.openPosition()`.
3. **Modification de `forceCloseExpired`** : si position live existante,
   fermer via `LisaService.closePosition()` au lieu de juste compute pnl.
4. **Sizing initial conservateur** : 50% du sizing gainers scanner ($394
   au lieu de $787). Si Sharpe > 0.5 sur 60j → augmenter à 100%.
5. **Kill-switch dédié** : `EVENT_ENGINE_LIVE_KILL_SWITCH=true` arrête
   instantanément l'exécution réelle (les triggers continuent en shadow).

### Garde-fous additionnels en live

| Garde-fou | Valeur |
|---|---|
| Max positions event ouvertes simultanément | 2 |
| Stop-loss hard | event_category.slPct × 1.5 (sécurité) |
| Take-profit hard | event_category.tpPct × 0.8 (conservateur) |
| Force-close si window dépassée | T+window strict |
| Skip si VIX > 35 (panic) | À paramétrer |

### Re-mesure post-promotion live (D-5.1)

À T+30j post-go-live :

```sql
SELECT
  event_type,
  COUNT(*) AS n_live,
  AVG(realized_pnl_pct_live) AS mean_live,
  AVG(realized_pnl_pct_shadow_pred) AS mean_shadow_pred,
  -- Le live-vs-shadow gap doit être < 0.10pp. Sinon slippage trop important.
  AVG(realized_pnl_pct_live - realized_pnl_pct_shadow_pred) AS slippage_gap
FROM event_engine_trades_live JOIN event_engine_trades_shadow_pred USING(id)
WHERE exit_taken_at > NOW() - INTERVAL '30 days';
```

Si `slippage_gap < -0.15%` (live perd 15bps de plus que shadow predit) :
- Soit l'exit timing est mauvais (window trop courte/longue)
- Soit le spread post-event est plus large que prévu
- → Ajuster les seuils + re-mesure.

## D-6 (hypothétique) — Scale

Si D-5 prouvé sur 30j live → augmenter sizing × 2-3 + élargir l'univers
d'events (ECB CPI, BoJ minutes, etc.).

## Glossaire decision matrix

| Phase | État | Action |
|---|---|---|
| D-4 GO | Mean PnL +0.10%, n≥50, Sharpe≥0.3 | Lancer Phase D-5 code |
| D-4 INTERMEDIATE | Pas assez de sample OU metric border-line | Prolonger D-4 +30j |
| D-4 NO-GO | Mean PnL ≤-0.05% OR Sharpe ≤0 | Désactiver event_engine, écrire post-mortem |
| D-5.1 GO confirmé | Slippage gap < 0.15%, live conforme shadow | D-6 scale |
| D-5.1 PARTIAL | Gap 0.15-0.30% mais positif | Ajuster window + re-mesure |
| D-5.1 NO-GO | Live mean < 0 | Désactiver live, garder shadow seul |

## Timeline réaliste (jours ouvrés)

- J+0 : merge code D-1+D-2+D-3 (cette session) ✅
- J+1 : activation `EVENT_ENGINE_ENABLED=true` (user action)
- J+30 : 1ère mesure D-4 (premiers verdicts)
- J+30 → J+60 : observation continue, decision GO/NO-GO
- J+60 → J+90 : code Phase D-5 si GO, deploy avec sizing 50%
- J+120 : mesure D-5.1, scale ou ajustement

**Total** : ~4 mois entre activation et décision finale sur scale.

## Fin

Aucune action de coding à entreprendre dans cette note. Activation D-4 = single
env var côté user. Le code D-1/D-2/D-3 est complet et opérationnel en shadow.
