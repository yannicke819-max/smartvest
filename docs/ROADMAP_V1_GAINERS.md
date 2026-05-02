# Roadmap V1 Gainers Scanner — État consolidé

**Source de vérité** pour la prochaine session. Décrit l'état au **2026-05-02 06:15 UTC** après 10 PRs mergées dans la session du jour.

---

## TL;DR

- **Phase 1** ✅ Fermée (dette tech BLOC 3 + ETL admin endpoint)
- **Phase 2** ✅ Fermée (Step 10 dashboard + extended panel + shadow init)
- **Phase 3** 🟡 Démarre — shadow run J1-J30 (ETA bascule live ~02/06/2026)
- **Phase 4** ⏳ Bascule live + canary 10% (T0+30j)
- **Brief S-DESIGN-V2** ⏳ Consigné (`docs/ui/brief-s-design-v2.md`), démarrage T0+3j en parallèle shadow run

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

## Next session — checklist reprise propre

Au démarrage de la prochaine session :

1. `git pull origin main` — sync
2. Lire ce fichier (`ROADMAP_V1_GAINERS.md`)
3. Status PR #205 : mergé ou pending ? Si pending, vérifier CI + merge si green
4. Pré-flight checklist 3a-3d : exécuter via Supabase ops + Fly logs
5. Si pré-flight tout vert : **PING UTILISATEUR pour validation flip flag**
6. Après ping + GO : `fly secrets set GAINERS_V1_SHADOW=true`
7. Monitor 24h → confirmer cadence signaux > 0.5/jour
8. Phase 3.2 monitoring cron quotidien (PR6.2) — création de `gainers_shadow_daily_report` table

---

_Document généré 2026-05-02 06:15 UTC après session 10 PRs._
_Source de vérité jusqu'à la session suivante._
