# Roadmap V1 Gainers Scanner — État consolidé

**Source de vérité** pour la prochaine session. Décrit l'état au **2026-05-02 18:00 UTC** après **24 PRs mergées** (cumul session 02/05).

---

## TL;DR

- **Phase 1** ✅ Fermée (dette tech BLOC 3 + ETL admin endpoint + hotfixes)
- **Phase 2** ✅ Fermée (Step 10 dashboard + extended panel + shadow init)
- **Phase 3.1** ✅ Pré-flight verts (107 migrations, baselines, cron */15)
- **Phase 3.2** ✅ Daily report cron + endpoints (PR6.2 #209)
- **Phase 3.3** ✅ Wiring fixed — TopGainersScanner persiste shadow signals (PR6.3 #211 `21770a9`)
- **Phase 3.4** ✅ **Mapping enrichi V1 livré** :
  - PR6.4 #213 `45e901b` — ATR/EMA/persistence depuis cache (equity)
  - PR6.5 #214 `78ff79e` — Worker exit-simulator (cron */5 replay BLOC 4)
  - PR6.6 #215 `705ff2c` — Crypto Binance enrichment + path_eff réel P9-UX
- **Phase 3.4.1** ✅ **Hotfixes shadow architecture (Sat afternoon session)** :
  - PR6.6.1 #217 `4b7c99e` — Shadow run pipeline-agnostic (decouple from active portfolios)
  - PR6.6.2 #218 `13ead74` — Crypto asset_class propagation (Binance + EODHD upstream)
  - PR6.6.3 #219 `5d5c790` — Crypto vol24hUsd correct + marketCap CRYPTO_MARKET_CAP_USD
- **Phase 3.5** ⏳ **PR6.7** : BLOC 2 spread proxy + BLOC 3 entry triggers (PULLBACK_HL_FIBO + VWAP_RECLAIM)
- **Phase 4** ⏳ Bascule live + canary 10% (T0+30j)
- **ADR-007** ✅ Kelly + Target Modes + 12 Presets backend (PR #207a/b)
- **Brief S-DESIGN-V2** ⏳ PR #207c UI dashboard simulator (8 components + 5 deps)

---

## ✅ Phase 3.4.1 RÉSOLUE — Hotfixes shadow architecture (02/05 PM)

3 PRs hotfix livrées dans la session afternoon Sat 02/05 pour corriger les
dysfonctionnements observés post-PR6.6 :

### PR6.6.1 #217 `4b7c99e` — Shadow run pipeline-agnostic

**Diagnostic** : 0 shadow signal persisté en 30j malgré flag `GAINERS_V1_SHADOW=true`
+ 4 cycles cron par jour. Cause : early return `no_active_portfolio` AVANT
l'appel à `persistShadowSignalsBatch`. Sans portfolio en `strategy_mode=gainers`,
le shadow batch n'était jamais exécuté.

**Fix** : quand `shadowRun.isShadowEnabled()` et `configs.length === 0`, fetch +
select top + persist shadow batch quand même, puis early return. Conforme à
l'intent ADR-005 §5 Step 9 (shadow run = test pipeline indépendant des
portfolios utilisateur).

**Effet validé** : 372 signals persistés au 1er cron post-deploy.

### PR6.6.2 #218 `13ead74` — Crypto asset_class propagation

**Diagnostic** : 10 cryptos Binance étiquetés `asset_class=equity` → fail
`LIQUIDITY_FLOOR` à tort. Cause : `mapEodhdRow` + `fetchBinanceGainers` ne
set jamais `assetClass`. `selectTopGainers` le calcule via `detectAssetClass`
mais uniquement pour les top-N qui passent le filtre legacy. Les raw
candidates iterés par `persistShadowSignalsBatch` n'avaient jamais
`assetClass` → fallback `equity`.

**Fix (a)** defensive : `mapTopGainerToCandidateRaw` appelle `detectAssetClass`
quand `assetClass` undefined.
**Fix (b)** upstream : `fetchBinanceGainers` set `assetClass: 'crypto_major'`
+ `mapEodhdRow` set via `detectAssetClass`.

**Effet validé** : 10/10 crypto correctement classés `market='crypto'`.

### PR6.6.3 #219 `5d5c790` — Crypto vol24hUsd + marketCap

**Diagnostic** : Post-PR6.6.2, asset_class OK mais 10/10 cryptos REJECT avec
7×MARKET_CAP_MIN + 3×LIQUIDITY_FLOOR. Causes :
- Bug A : `vol24hUsd = volume × close` faux pour crypto (Binance quoteVolume
  déjà en USDT, multiplier par close donne USD² absurde)
- Bug B : `marketCap: 0` hardcodé dans `fetchBinanceGainers` → fail seuil 500M

**Fix (a)** : skip × close pour crypto dans mapping helper.
**Fix (b)** : table `CRYPTO_MARKET_CAP_USD` avec valeurs approximatives pour
les 10 majors whitelistés (BTC=1.3T, ETH=400B, ..., MATIC=8B).

ADR-005 §1bis seuils non touchés. Tous > seuil 500M, marge ×10 dérive marché.

**Effet validé** (run 17:45 UTC samedi) :
- 0/10 MARKET_CAP_MIN ✅
- 3 PASS liquidity (BTC, ETH, SOL — quoteVolume > 50M weekend) → fail
  PERSISTENCE_BELOW_THRESHOLD légitime
- 7 FAIL LIQUIDITY_FLOOR (BNB, XRP, ADA, AVAX, DOT, LINK, MATIC) — quoteVolume
  weekend < 50M (BNB=$36M, MATIC=$1M) — **comportement correct du gate**,
  rejets légitimes en regime low-vol weekend

### Conclusion analyse weekend

Le gate LIQUIDITY_FLOOR fonctionne **comme spec ADR-005 §1bis**. Validation
weekday attendue lundi 09:00 UTC où volumes crypto reviennent à niveau normal
(BNB ~$300-500M, ADA ~$150M). Aucune PR6.6.4 nécessaire.

---

## ✅ Phase 3.3 RÉSOLUE — PR6.3 Shadow wiring (`21770a9`)

**Mergé** : PR #211 (`feat(shadow): PR6.3 wiring`).

Implémenté :
- `LisaModule.imports += GainersModule` (no cycle, no forwardRef)
- `TopGainersScannerService` constructor 9th arg : `GainersShadowRunService`
- `persistShadowSignalsBatch(candidates, top)` private method appelée après `fetchAllCandidates`
- `mapTopGainerToCandidateRaw` helper TopGainerCandidate → GainersCandidateRaw
- 7 tests TopGainersScanner patchés (mock 9th arg)

**Endpoint admin combiné** : `POST /admin/gainers/seed-legacy-universe` :
- Lit `watchlist_universe` → upsert `gainers_legacy_snapshot` (ON CONFLICT DO NOTHING)
- Chaîne baseline refresh ETL (default ON)
- Réponse `{seed: {...}, baseline: {...}, totalDurationMs}`
- 1 seul curl extends 15→215 + populate baselines

**Mode dégradé actuel** (PR6.4 enrichira) :
- `compositeScore` = legacy/100 (pas pipeline V1 enrichi)
- `decision` = ACCEPT pour top-N, REJECT autres
- `setup_type` / `spread_proxy` / `volume_ratio` / `pivots_*` / `fibo_level` = null

---

## ✅ Phase 3.4 RÉSOLUE — Mapping enrichi V1 + Worker exit-simulator

**3 PRs mergées** : PR6.4 (#213), PR6.5 (#214), PR6.6 (#215).

### PR6.4 #213 `45e901b` — Mapping enrichi V1 (equity)
- `enrichShadowCandidate(candidate, supabase, mtfPersistence)` helper async
- Equity : fetch `ohlcv_cache_daily` ticker → 200 closes → ATR(14) + EMA50/200
- `persistenceScore` + `persistenceCount` via `mtfPersistence.analyze()`
- Replace legacy proxy par BLOC 1 réel : `runAllPrefilterGates(enriched, DEFAULT_BLOC1_CONFIG)` + `computeCompositeScore`
- Bloc3Diagnostics enrichi (volume_ratio + gateLiquidityPassed réels)

### PR6.5 #214 `78ff79e` — Worker exit-simulator (Phase 3.4 étape 5)
- `ShadowExitSimulatorService` cron `*/5` minutes
- Replay state machine BLOC 4 (TP/SL/trailing 20/50) via `applyTick`
- Fetch candles 1m EODHD (equity) ou Binance (crypto) depuis `entry_at`
- Update `simulated_exit_price/at/reason/pnl_pct/slippage_pct`
- TIME_LIMIT après MAX_HOLD_HOURS=3 (ADR-005 §2.4)
- Persist `entry_path_eff + tp_price + sl_price` au signal pour permettre le replay

### PR6.6 #215 `705ff2c` — Crypto enrichment + path_eff réel P9-UX
- `readBinanceDailyCandles(binance, symbol, 200)` : ATR/EMA pour crypto via Binance klines '1d'
- `enrichShadowCandidate` retourne `{raw, pathEff}` — pathEff = `mtfPersistence.pathQuality.overallEfficiency`
- `persistShadowSignal(candidate, legacyDecision, pathEffOverride?)` 3rd arg
- TP/SL recalc avec pathEff réel (capped à 5%) au lieu de default 0.5%
- Symbol mapping eodhd→binance : `BTC-USD.CC` → `BTCUSDT`

---

## 🟡 Phase 3.5 — PR6.7 BLOC 2 spread proxy + BLOC 3 entry triggers

**Scope estimé** : ~300-500 LoC + tests + cache layer.

### Plan d'exécution PR6.7

**Étape 1 — Cache intraday partagé** :
- Réutiliser `IntradayCacheService` (P19i) pour 1h + 1m candles
- TTL court (15 min pour 1h, 5 min pour 1m)

**Étape 2 — BLOC 2 spread proxy** :
- Fetch 1h candles (~5-20 par symbole) depuis EODHD/Binance
- Run `computeSpreadProxy(candles)` → `(H-L)/((H+L)/2)`
- Surface dans `bloc3Diagnostics.spreadProxy`

**Étape 3 — BLOC 3 trigger detection** :
- Fetch 1m candles (~60 par symbole)
- Run `evaluatePullbackHL(candles, fiboLevels)` + `evaluateVwapReclaim(candles, vwap)`
- Surface dans `entrySignal.triggerKind` ('PULLBACK_HL_FIBO' | 'VWAP_RECLAIM' | null)
- Setup_type column shadow signal alimentée

**Étape 4 — Quota EODHD** :
- 215 symbols × (1h + 1m) = ~860 calls/cycle × cron */15 = ~3440 calls/heure
- Quota ALL-IN-ONE = 100k/jour → marge x29 OK
- Surveiller via `EodhdQuotaService.dailyUsed` et back-off auto

### Risques PR6.7

- **DI failure** régression style #199/#200 : test local boot OBLIGATOIRE pré-push
- **EODHD quota burst** : back-off `EodhdQuotaService.shouldThrottle()` à intégrer
- **Performance** : sémaphore 5 concurrent par source (Binance 1200 weight/min, EODHD plan-dependent)

---

## 🟡 PR #207c — UI dashboard simulator (chantier S-DESIGN-V2 livrable C)

**Scope estimé** : ~5-10j fresh session frontend.

8 composants UI :
1. `<PresetPicker mode={...}>` — 4 cards horizontales par mode
2. `<ObjectiveEditor>` × 3 modes (Investment / Harvest / Gainers)
3. 3-tabs split GAINERS purple / HARVEST emerald / INVESTMENT sky
4. Modal warning Kamikaze (full Kelly disclaimer)
5. `/dashboard/gainers/simulator` form complet (zod + react-hook-form)
6. Live shadow feed toggle (overlay shadow signals 7d sur sim)
7. Charts Recharts (equity curve, drawdown, P&L histogram)
8. KPIs cards (total return, CAGR, Sharpe, max DD, win rate)

5 stack deps à ajouter :
- `framer-motion` (micro-interactions)
- `@tremor/react` (cards dashboard riches)
- `cmdk` (command palette ⌘K)
- `react-hook-form` + `zod` (form validation)
- `canvas-confetti` (milestones)

Migration `0109_gainers_simulator_presets` (table user save preset).

E2E Playwright : charger preset Modéré Gainers → modifier kelly_fraction → submit → vérifier graph rendu.

---

## PRs cette session (chronologique)

| # | SHA | Date | Scope | Status |
|---|---|---|---|---|
| #196 | `cba197e` | 02/05 04:06 | BLOC 4 positions + trailing 20/50 + ETL pre-req + slippage | ✅ |
| #197 | `72d8ae5` | 02/05 04:30 | hotfix migration 0097 column `market` non-existant | ✅ |
| #198 | `65ac40b` | 02/05 04:55 | hotfix fly.toml path bump (re-trigger fly.yml) | ✅ |
| #199 | `ca3f0a2` | 02/05 05:08 | feat admin endpoint `POST /admin/gainers/baseline/refresh` | ✅ |
| #200 | `aec2f6a` | 02/05 05:11 | hotfix DI export TopGainersScannerService LisaModule | ✅ |
| #201 | `6412215` | 02/05 05:43 | feat BLOC 3 observability + REJECT coverage (closes #193 #194) | ✅ |
| #202 | `821c324` | 02/05 06:02 | feat dashboard `/admin/gainers/v1-metrics` (Step 10) | ✅ |
| #203 | `6300385` | 02/05 06:12 | feat extended panel + fiboLevel tie-break (closes #195) | ✅ |
| #204 | `d9d1bdd` | 02/05 06:13 | docs brief S-DESIGN-V2 + simulation live spec | ✅ |
| #205 | `bcf2be3` | 02/05 06:18 | feat PR6 shadow run init (table + service + power analysis) | ✅ |
| #206 | `83e206a` | 02/05 06:27 | docs ROADMAP_V1_GAINERS état consolidé | ✅ |
| #207 | `3c34a19` | 02/05 07:36 | feat PR #207a Kelly + Target Modes backend (ADR-007) | ✅ |
| #208 | `600740f` | 02/05 07:46 | feat PR #207b 12 builtin presets backend (4×3 modes ADR-007) | ✅ |
| #209 | `9aae561` | 02/05 09:02 | feat PR6.2 daily report cron + endpoints (Phase 3.2) | ✅ |
| #210 | `a6b4b1f` | 02/05 09:16 | docs ROADMAP update — Phase 3.3 wiring gap diagnostic | ✅ |
| #211 | `21770a9` | 02/05 09:35 | feat PR6.3 wiring TopGainersScanner + admin seed-universe + baseline chain | ✅ |
| #212 | `f08b33e` | 02/05 09:50 | docs ROADMAP update post-#211 — Phase 3.3 résolue + PR6.4 plan | ✅ |
| #213 | `45e901b` | 02/05 11:?? | feat PR6.4 mapping enrichi V1 + ATR/EMA/persistence depuis cache (equity) | ✅ |
| #214 | `78ff79e` | 02/05 13:?? | feat PR6.5 exit-simulator worker (cron */5 replay BLOC 4 state machine) | ✅ |
| #215 | `705ff2c` | 02/05 14:08 | feat PR6.6 crypto Binance enrichment + path_eff réel P9-UX | ✅ |
| #216 | `551d0bb` | 02/05 14:30 | docs ROADMAP update post-#215 — Phase 3.4 résolue | ✅ |
| #217 | `4b7c99e` | 02/05 15:25 | fix PR6.6.1 shadow run pipeline-agnostic (decouple from portfolios) | ✅ |
| #218 | `13ead74` | 02/05 16:21 | fix PR6.6.2 crypto asset_class propagation (Binance + EODHD) | ✅ |
| #219 | `5d5c790` | 02/05 17:00 | fix PR6.6.3 crypto vol24hUsd + marketCap CRYPTO_MARKET_CAP_USD | ✅ |

---

## Phase 1 ✅ — Stabilisation post-BLOC4

### Issues GitHub closed
- **#193** (P1) — BLOC 3 dry-run observability (timestamp/resolution/session/spread/volume/pivots_reason) → PR #201
- **#194** (P1) — BLOC 3 dry-run REJECT coverage (9/9 CandidateRejectReason) → PR #201
- **#195** (P2) — BLOC 3 fiboLevel selection rule + extended panel 30+ samples → PR #203

### Hotfixes prod résolus
- Migration 0097 : column `market` n'existait pas sur `gainers_persistence_log` → fix idempotent avec `information_schema.columns` guards (PR #197)
- Fly machine stuck sur image v334 : path filter de `fly.yml` ne matchait pas migrations → bump fly.toml (PR #198)
- DI failure `AdminGainersStatusController` : `TopGainersScannerService` provider non exporté → ajout exports[] LisaModule (PR #200)

### Tests cumulés
- Pré-session : 247 (post #196)
- Post-session : **324 tests / 0 failures / 2 todo legacy**

---

## Phase 2 ✅ — Observability + shadow infrastructure

### Step 10 Dashboard `/admin/gainers/v1-metrics` (PR #202)
8 sections aggregées :
- timeBuckets 24h/7d/30d
- rejectBreakdown par filter_reason
- topRejects top 10
- compositeScoreHistogram 5 buckets
- signalCadence daily accept/reject
- recentCandidates 50 derniers
- positionsHealth (open/TP/SL/T20/T50/struct_break + slippage stats + anomalous_fill count)
- etlHealth (baselineCount + freshness + legacySnapshotCount)

UI Next.js minimal MVP avec composants shadcn — refonte Tremor+Recharts dans S-DESIGN-V2.

### Extended Panel (PR #203)
- `GET /admin/gainers/v1-metrics/signals` — per-signal détail
- `GET /admin/gainers/v1-metrics/sessions` — daily aggregation
- `GET /admin/gainers/v1-metrics/sessions.csv` — export CSV
- Golden values panel JSON 30 samples (12 buckets, 19 equity / 11 crypto)
- `nearestFiboLevel` tie-break rule lockée : "plus proche, puis plus profond" avec EPSILON 1e-9

### Shadow run init (PR #205, en cours merge)
- Migration 0104 `gainers_v1_shadow_signals` (table + 3 indexes)
- `power-analysis.ts` : proportionTest, wilsonInterval95, requiredSampleSize
- `shadow-run.service.ts` : isShadowEnabled, persistShadowSignal, getShadowMetrics, computeRequiredSampleSize
- 15 tests power analysis

---

## Phase 3 🟡 — Shadow run live (T0+1j → T0+30j)

T0 = **2026-05-02**.

### Pré-flight checklist (bloquant flip flag)

À valider **AVANT** `fly secrets set GAINERS_V1_SHADOW=true` :

| Check | Query | Attendu |
|---|---|---|
| 3a — `gainers_volume_baselines` | `SELECT COUNT(*) FROM gainers_volume_baselines;` | ≥ 200 (watchlist 215 — peut être < 215 si certains symbols fail le fetch live) |
| 3b — `gainers_legacy_snapshot` | `SELECT COUNT(*) FROM gainers_legacy_snapshot;` | ≥ 15 (mega12 + crypto seed minimum, ~215 si audit-universe-legacy --apply lancé) |
| 3c — Migrations | issue #131 dernier comment workflow apply-migrations | `103 ignorées · 0 échecs` (104 attendu post-PR #205 merge) |
| 3d — Cron scanner H24 | logs Fly `flyctl logs -a smartvest --since 1h \| grep TopGainersScanner` | Tick visible toutes les 15 min (cycle default) |

### Bootstrap actions si checks 3a/3b vides

```bash
# 3a : déclencher ETL baseline manuellement (PR #199)
curl -X POST https://smartvest.fly.dev/admin/gainers/baseline/refresh \
  -H "x-admin-token: $ADMIN_TOKEN" | jq

# 3b : déclencher audit-universe-legacy --apply (depuis ops shell avec creds Supabase)
cd /home/user/smartvest
SUPABASE_URL=$SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY=$KEY \
  pnpm tsx scripts/audit-universe-legacy.ts --apply
```

### Flip flag (PING UTILISATEUR REQUIS AVANT)

```bash
fly secrets set GAINERS_V1_SHADOW=true -a smartvest
# Auto-redeploy via fly secret change
flyctl logs -a smartvest --since 5m | grep -i "shadow"
# Confirmer le boot log mentionne "shadow mode" ou similaire
```

### Critères bascule live (ADR-005 §5 Step 9, locked)

Tous requis :
1. **≥ 30 signaux ACCEPT ET ≥ 20 sessions distinctes** (ADR-005 minimum power=0.80 pour Δ=10pp)
2. **Win-rate ≥ 45%** sur signaux fermés (vs H₀=50% baseline aléatoire)
3. **Divergence legacy ≤ 20%** sur l'overlap shadow vs algo legacy
4. **Zéro erreur critique** dans `decision_log` (`gainers_position_events.event_kind = 'STRUCTURE_BREAK'` etc., pas d'anomaly_fill > 1% systématique)
5. **Snapshot non-régression validé** (`UniverseGuardService.validateUniverse() === { coverage: 1.0 }`)

### Métriques shadow attendues (calc dashboard `/admin/gainers/v1-metrics/extended`)

| Metric | Formule | Cible bascule |
|---|---|---|
| Win-rate | wins / closedWithPnl | ≥ 0.45 |
| Profit factor | sum(gains) / abs(sum(losses)) | ≥ 1.20 |
| Expectancy | (wr × avgWin) - (lr × avgLoss) | > 0 |
| Max drawdown | max peak-to-trough sur PnL cumulé | < 10% |
| Sharpe approx | mean(daily_pnl) / std(daily_pnl) × √252 | > 1.0 |
| Slippage avg | avg(slippage_pct) | |slip| < 0.30% |
| Anomalous_fill rate | count(anomalous_fill=true) / total | < 5% |

### Phase 3.2 — Monitoring quotidien (à coder)

- Cron 23:30 UTC daily : aggregate journée → table `gainers_shadow_daily_report` (pas encore créée — followup PR6.2)
- Notification automatique si :
  - 0 signaux accept pendant 48h
  - Slippage > 2× expected
  - Cadence < 0.5 signaux/jour (risque de ne pas atteindre 30 en 28j)

---

## Phase 4 ⏳ — Bascule live + canary (T0+30j ≈ 2026-06-01)

### Pré-conditions
- Phase 3 terminée avec **tous les 5 critères validés**
- Power test recommendation = `EARLY_STOP_REJECT_NULL` OU `n ≥ 30 ET checklist 100%`
- Review utilisateur explicite sur shadow report

### Procédure bascule

```bash
# Étape 1 : flip flag
fly secrets set GAINERS_V1_LIVE=true -a smartvest

# Étape 2 : canary 10% capital
# (ajouter param GAINERS_V1_CAPITAL_FRACTION=0.10 dans lisa_session_configs)

# Étape 3 : monitor 72h
curl https://smartvest.fly.dev/admin/gainers/v1-metrics \
  -H "x-admin-token: $TOKEN" | jq '.positionsHealth'
```

### Critères canary → 100%
- 72h sans anomalie critique (anomalous_fill, structure_break > 5% des trades)
- Win-rate canary cohérent avec shadow (Δ < 10pp)
- Aucune position bloquée open > 6h sans hit stop/TP/trailing

### Rollback procedure
```bash
# Si critères canary échouent
fly secrets set GAINERS_V1_LIVE=false -a smartvest
# Toutes positions ouvertes restent gérées par le mécanique de stops/TP/trailing
# (ne sont pas force-closed — laissées vivre jusqu'à exit naturel)
```

---

## Brief S-DESIGN-V2 ⏳ — refonte UI/UX (T0+3j → T0+28j)

Voir `docs/ui/brief-s-design-v2.md` (PR #204 mergé `d9d1bdd`).

3 livrables :
- **A** Audit visuel `audit-v2-2026-05.md` — 13 pages screenshots desktop+mobile + comparaison concurrents (T0+3j → T0+5j)
- **B** Design system `design-system-v2.md` — palettes Tailwind, typo, motion Framer, components Tremor (T0+5j → T0+10j)
- **C** Mode SIMULATION étendu (10j → 13-15j) :
  - C.1 Backtest historique `/simulation/gainers` (7j)
  - C.2 **SIMULATION LIVE** `/simulation/live` — capital virtuel + data feed live + resets daily/monthly + 4 tables `gainers_sim_*` (6-8j NEW)

Stack ajouts : Framer Motion, Tremor, cmdk, canvas-confetti.
Garde-fou : branches `ui/` ou `design/` uniquement, **aucune modif** `apps/api/src/modules/gainers-scanner/`.

---

## Issues GitHub backlog post-V1 (non bloquant bascule)

- #137 → #140 : P21-P24 (multi-market expansion waves 1-5, fees, FX, calendar holidays)
- #147 : schema drift 0090 vs prod harvest_sessions
- #127 : P19z UI fix gainers tile (counter filter)

---

## Algos lockés (ADR-005)

| Bloc | Formule | Source | Statut |
|---|---|---|---|
| BLOC 1 floor equity | $\geq$ $10M median 20j | §1bis.2 | ✅ LOCKED |
| BLOC 1 floor crypto | $\geq$ $50M 24h | §1bis.2 | ✅ LOCKED |
| BLOC 1 mcap equity / crypto | ≥ $300M / $500M | §1bis.3 | ✅ LOCKED |
| BLOC 1 ATR clamp | ≤ 0.15 | §1bis.4 | ✅ LOCKED |
| BLOC 1 persistence | ≥ 0.67 | CLAUDE.md P8 | ✅ LOCKED |
| BLOC 1 composite | 0.5×P + 0.3×M + 0.2×V_inv | §1bis | ✅ LOCKED |
| BLOC 2 spread proxy | (H-L)/((H+L)/2) median 5c, p20 vol floor | synchro #9 | ✅ LOCKED |
| BLOC 2 caps | equity 0.40% / crypto 0.60% | §1bis | ✅ LOCKED |
| BLOC 3 swing N=5 | Bulkowski 2021 | §1bis.5 | ✅ LOCKED |
| BLOC 3 fibo levels | 38.2/50/61.8 + tie-break deeper wins | §1bis.5 | ✅ LOCKED |
| BLOC 4 TP/SL equity | ×1.5 / ×1.0 path_eff | §11.1 | ✅ LOCKED |
| BLOC 4 TP/SL crypto | ×2.0 / ×0.8 path_eff | §11.1 | ✅ LOCKED |
| BLOC 4 trailing | 20% MFE @ +path_eff, 50% MFE @ +2×path_eff, TP cap lifted | §11.1 | ✅ LOCKED |
| BLOC 4 slippage | (actual - theoretical) / entry, anomalous > 1% | §11.3 | ✅ LOCKED |
| Step 9 power analysis | n=(z_α/2+z_β)² × p(1-p) / δ², power=0.90 α=0.05 | §5 Step 9 | ✅ LOCKED |

**Aucune formule en validation pendante**. Reste à valider empiriquement via shadow run.

---

## Points de vigilance Phase 3 (shadow run)

1. **Cadence signaux** : 215 symboles × scanner 15min × 6.5h sessions = ~5500 ticks/jour. Avec acceptRate cible ~1-2%, attendu ~50-100 signaux/jour. Si **< 30 signaux en 28j** → trigger volatility regime trop calme, prolonger shadow.

2. **Slippage divergence** : si avg slippage > 0.30% → revoir le modèle de fill (cf. ADR §11.3). Possibilité de calibrer le tick price vs theoretical level.

3. **Volatility regime** : shadow lancé ~02/05/2026. Si VIX < 15 (régime calme) → moins de pullbacks, moins de signaux. Si VIX > 25 (régime stressé) → plus de structure_breaks. Documenter le contexte de la fenêtre shadow dans le rapport final.

4. **Anomalous_fill clusters** : si > 5% des trades trigger `anomalous_fill=true` → enquêter par symbol + session pour identifier patterns (gap-up Asian session, halt US, low-liquidity altcoin).

5. **Legacy divergence** : 20% est le cap. Si > 30% → revoir les gates BLOC 1/2 vs algo legacy pour identifier où la divergence se concentre.

---

## Next session — checklist reprise propre (UPDATED 18:00 UTC post-trilogy 6.6.x)

Au démarrage de la prochaine session :

1. `git pull origin main` — sync (HEAD = `5d5c790` post-PR6.6.3)
2. Lire ce fichier (`ROADMAP_V1_GAINERS.md`) + sections "Phase 3.4.1" (hotfixes
   shadow architecture) + "Phase 3.5 PR6.7" + "PR #207c"
3. **TASK PRIORITAIRE 1 — Bilan weekday lundi 09:00+4h UTC** :
   - Re-query A3 Supabase :
     ```sql
     SELECT symbol, asset_class, decision, reject_reason, entry_path_eff,
            composite_score, legacy_decision, created_at
     FROM gainers_v1_shadow_signals
     WHERE asset_class = 'crypto'
       AND created_at >= 'lundi 09:00:00Z'
     ORDER BY created_at DESC LIMIT 30;
     ```
   - Validation success criteria :
     - 0 rows MARKET_CAP_MIN sur les 10 majors ✅ (déjà OK PR6.6.3)
     - Volumes weekday > 50M sur ≥ 8/10 majors → 0-2 LIQUIDITY_FLOOR
     - ≥ 3-5 ACCEPT crypto attendus (sinon PERSISTENCE/VOLATILITY/TREND legitimes)
   - Si KO : drill-down ciblé selon reject_reason dominant
4. **TASK PRIORITAIRE 2 — PR6.7 BLOC 2 spread + BLOC 3 entry triggers** (post #1 OK) :
   - Cache intraday partagé (`IntradayCacheService` réutilisé)
   - BLOC 2 `computeSpreadProxy` sur 1h candles
   - BLOC 3 `evaluatePullbackHL` + `evaluateVwapReclaim` sur 1m candles
   - Surface `entrySignal.triggerKind` + `bloc3Diagnostics.spreadProxy`
   - Plan détaillé dans la section "Phase 3.5" ci-dessus
5. **TASK SECONDAIRE — UX polish** (~½ journée, post-PR6.7) :
   - Filtre "Hide choppy" toggle dans `GainersStatusTile`
   - Filtre "Hide flat 0/5" pour cacher rows weekend stale
   - Colonne `Vol $M` pour aider décision tradability
6. **OPTION C parallèle — PR #207c UI dashboard simulator** (fresh session frontend) :
   - 8 composants UI + 5 stack deps + migration 0109
   - Plan détaillé dans la section "PR #207c" ci-dessus
7. Phase 4 bascule live = T0+30j sous réserve cadence shadow OK + win-rate ≥ 45%

---

## Live prod state (2026-05-02 18:00 UTC post-PR6.6.3)

| Item | Statut |
|---|---|
| Live SHA | `5d5c790` (PR #219 PR6.6.3 crypto vol+marketCap) — confirmé `/version` |
| Fly machine | `d8d4070a719018` healthy (cdg) |
| `gainers_volume_baselines` | **215 rows** (mega12 + crypto + sp500 extended) post-seed |
| `gainers_legacy_snapshot` | **215 rows** post-seed |
| `gainers_v1_shadow_signals` | ✅ Se remplit cron `*/15` (~186 rows/cycle, validé sur 4+ cycles 17:30-17:45 UTC) |
| `simulated_exit_*` | ⏳ Se remplit cron `*/5` (ShadowExitSimulatorService) — efficace uniquement crypto weekend (equity attend lundi 13:30 UTC US open) |
| `_smartvest_migrations` | **108/108** |
| `GAINERS_V1_SHADOW` flag | ✅ activé Fly secret + wiring actif + enrichment réel + crypto fix |
| Cron */15 scanner | ✅ shadow batch tourne pipeline-agnostic |
| Cron */5 exit-simulator | ✅ schedule actif (PR #214) |
| Cron 23:30 daily-report | ✅ schedule actif (PR #209) — ⚠️ cache stale, POST recompute requis |
| ADMIN_TOKEN | 🔴 **À ROTATE** — exposé chat session ×3 |

### Bilan analyse weekend Sat 02/05 17:45 UTC

Sur 10 crypto majors fetchés, gates BLOC 1 V1 :
- ✅ 0/10 MARKET_CAP_MIN (PR6.6.3 valide)
- ✅ 3 PASS liquidity (BTC $584M, ETH $172M, SOL $88M) → fail PERSISTENCE_BELOW_THRESHOLD
- 🟡 7 FAIL LIQUIDITY_FLOOR (BNB $36M, XRP $44M, ADA $10M, AVAX $6M, DOT $3M, LINK $12M, MATIC $1M) — quoteVolume Binance weekend < 50M floor — **comportement correct du gate**, rejets légitimes

**Conclusion** : pipeline V1 fonctionne comme spec. Pas de PR6.6.4 nécessaire.
Validation weekday attendue lundi avec volumes normaux (×3-10 weekend).

---

## Action utilisateur prioritaire avant reprise

1. 🔴 **Rotate ADMIN_TOKEN** (token exposé dans logs chat session 02/05) :
   ```bash
   fly secrets set ADMIN_TOKEN=$(openssl rand -hex 32) -a smartvest
   ```
2. 🟡 (optionnel) Étendre univers à 215 symboles :
   ```bash
   SUPABASE_URL=$URL SUPABASE_SERVICE_ROLE_KEY=$KEY \
     pnpm tsx scripts/audit-universe-legacy.ts --apply
   # Puis re-trigger ETL :
   curl -X POST https://smartvest.fly.dev/admin/gainers/baseline/refresh \
     -H "x-admin-token: <NEW_TOKEN>"
   ```
3. ⚠️ **PR6.3 wiring est bloquant** pour shadow run produire des signaux. Sans ça, le flip flag est cosmétique.

---

_Document mis à jour 2026-05-02 09:50 UTC après session 17 PRs (#196 → #211)._
_main HEAD = `5d5c790` (post-PR6.6.3)._
_Source de vérité jusqu'à la session suivante._
