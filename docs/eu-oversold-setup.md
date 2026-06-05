# Setup EU Oversold portfolio

Cette procédure crée un nouveau portefeuille **EU_oversold** dédié au scanner mean-reversion sur l'univers STOXX 600 (518 EU large caps).

## Prérequis

1. Migration `0194_stoxx600_universe.sql` appliquée (cf. CLAUDE.md procédure migrations)
2. Code merge'd contenant le `checkRegimeGate(universe)` région-aware

## Vérification migration

Avant de créer le portfolio, vérifier que l'univers `stoxx600` existe :

```sql
SELECT name, exchange, session_open_utc, session_close_utc, array_length(tickers, 1) AS ticker_count
FROM watchlist_universe
WHERE name = 'stoxx600';
-- attendu : 1 row, ticker_count = 518
```

## Création portfolio (Supabase Studio SQL editor)

Adapter `<USER_ID>` à ton user_id Supabase. Idéalement utiliser un UUID v4 figé pour le portfolio_id (ex : `c0000001-0000-0000-0000-000000000001`) pour faciliter les overrides futurs via secrets Fly.

```sql
-- Step 1 : créer le portfolio
INSERT INTO portfolios (id, user_id, name, base_currency, created_at, updated_at)
VALUES (
  'c0000001-0000-0000-0000-000000000001',
  '<USER_ID>',
  'EU_oversold',
  'EUR',
  NOW(), NOW()
);

-- Step 2 : créer la config Lisa associée — strategy_mode='oversold' + univers stoxx600
INSERT INTO lisa_session_configs (
  user_id,
  portfolio_id,
  profile,
  capital_usd,
  base_currency,
  strategy_mode,
  autopilot_enabled,
  kill_switch_active,
  -- Oversold-specific
  oversold_universe,
  oversold_drop_min_pct,
  oversold_drop_max_pct,
  oversold_hold_days,
  oversold_stop_catastrophe_pct,
  oversold_tp_pct,
  oversold_position_notional_usd,
  oversold_max_open_positions,
  risk_constraints,
  created_at, updated_at
) VALUES (
  '<USER_ID>',
  'c0000001-0000-0000-0000-000000000001',
  'long_term_investor',
  '10000',
  'EUR',
  'oversold',
  TRUE,    -- autopilot ON
  FALSE,   -- kill switch OFF
  'stoxx600',
  -12,     -- dropMin (falling-knife exclu sous -12%)
  -5,      -- dropMax (pas assez sur-réaction au-dessus de -5%)
  10,      -- hold J+10
  -15,     -- stop catastrophe
  NULL,    -- pas de TP fixe (laisse courir)
  500,     -- notional $500/position (plus petit que HIGH car univers plus large)
  200,     -- max 200 positions ouvertes
  '{}'::jsonb,
  NOW(), NOW()
);
```

## Vérification

```sql
SELECT portfolio_id, strategy_mode, oversold_universe, autopilot_enabled
FROM lisa_session_configs
WHERE portfolio_id = 'c0000001-0000-0000-0000-000000000001';
```

## Comportement attendu

Au prochain cron `oversold-daily-scan` (21:15 UTC) ou intraday (15-19 UTC), le scanner :

1. Charge l'univers `stoxx600` (518 tickers EU)
2. Appelle `checkRegimeGate('stoxx600')` qui détecte région='EU'
3. Fetch V2TX + SX5E EOD via EODHD
4. Compare avec seuils défaut **V2TX>22 / ΔV2TX>+10% / SX5E 5d<-1.5%**
5. Si gate PASSE → scan candidats drop -5/-12% → ouvre positions
6. Si gate BLOQUE → log `oversold_scan_blocked_regime` payload `region='EU'`

## Seuils EU tunables via secret Fly

| Secret | Défaut | Rôle |
|---|---|---|
| `OVERSOLD_V2TX_MAX` | `22` | bloque si V2TX close > 22 |
| `OVERSOLD_V2TX_DELTA_MAX_PCT` | `10` | bloque si ΔV2TX 1d > +10% |
| `OVERSOLD_SX5E_5D_MIN_PCT` | `-1.5` | bloque si SX5E 5d return < -1.5% |

Master gate global (US + EU) reste : `OVERSOLD_REGIME_GATE_ENABLED=true` (défaut).

## Calibration à backtester

Les seuils EU initiaux (`V2TX>22, ΔV2TX>+10%, SX5E 5d<-1.5%`) ne sont **pas data-driven** comme les seuils US (qui ont été calibrés sur 04/06 vs 05/06). Ils sont juste un point de départ raisonnable :
- V2TX > 22 = ~1 SD au-dessus normale (V2TX historique 15-25)
- ΔV2TX > +10% = cohérent avec US (capture spike soudain)
- SX5E 5d < -1.5% = plus permissif que US (-1%) car EU index moins liquide → tolère plus de bruit

À recalibrer après N≥30 jours d'historique scanner EU.

## Suivi (admin endpoints)

- `GET /lisa/oversold-summary/c0000001-0000-0000-0000-000000000001` — book summary EU
- `lisa_decision_log` filtre `payload->>region = 'EU'` pour audit des décisions gate
- Cron logs `[oversold] portfolio=c0000001 universe=stoxx600 region=EU ...`
