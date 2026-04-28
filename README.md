# SmartVest

Plateforme d'investissement personnel — analyses, simulations, suivi multi-comptes,
frictions d'intermédiation rendues visibles, et modèle de **délégation contrôlée**
à 3 modes (manuel / hybride / autonome sous mandat).

> SmartVest fournit des analyses et simulations à titre informatif.
> Ceci ne constitue pas un conseil en investissement personnalisé.
> Les performances passées ne préjugent pas des performances futures.

---

## Scope réel (Phase 5 en cours)

**Phases précédentes (livrées)**
- **Phase 1** — monorepo, design system, stubs portefeuille
- **Phase 2** — portefeuille multi-comptes, imports DEGIRO / Interactive Brokers, valorisation
- **Phase 3** — performance, alertes, objectifs financiers, plans d'action, scénarios
- **Phase 4** — cadre de délégation (`AutonomyMandate`, audit hash-chaîné), moteur macro / géopolitique / impact

**Phase 5 (en cours) — Mode `HYBRID_SUGGESTIVE`**
- ✅ Mandat `/settings/delegation` (CRUD, kill-switch, audit)
- ✅ `<KillSwitchBanner />` global (arrêt d'urgence en 2 clics)
- ✅ Centre de revue `/suggestions` (approuver/refuser/annuler avec audit)
- ✅ Générateur automatique de propositions (drift, concentration, goal-trigger, macro-signal, performance)
- ✅ Dashboard widgets : contexte marché · exposition · suggestions en attente
- ✅ **Module Funding / Cash** — transferts de fonds, journal de cash, réservations (voir ci-dessous)
- ⏳ Ingestion automatique RSS / webhooks (reportée — Chantier 5)

**Phase 6 (prévue)** — Mode `AUTONOMOUS_GUARDED` : exécution dans mandat + broker adapter réel.

Règles produit, architecture, garde-fous : voir [`CLAUDE.md`](./CLAUDE.md).

---

## Screenshots

> **TODO** : captures à ajouter une fois le déploiement de démo en place.
> Pages représentatives : `/dashboard`, `/settings/delegation`, `/suggestions`,
> `/market-context`, `/goals`.

```
docs/screenshots/dashboard.png          — vue principale + 3 widgets
docs/screenshots/settings-delegation.png — mandat + kill-switch
docs/screenshots/suggestions.png         — centre de revue
docs/screenshots/market-context.png      — signaux macro et conclusions
docs/screenshots/goals.png               — objectifs + plans + feasibility
```

---

## Module Funding & Cash

Suivi déclaratif des liquidités apportées sur les comptes broker.
SmartVest n'exécute aucun ordre bancaire réel — les données sont saisies par l'utilisateur.

### Modèle de données (`migration/0009_funding_module.sql`)

| Table | Rôle |
|---|---|
| `funding_sources` | Comptes bancaires sources (IBAN, BIC…) |
| `funding_destinations` | Comptes broker cibles |
| `funding_transfers` | Virements déclarés (machine à états 8 statuts) |
| `funding_transfer_audit` | Journal hash-chaîné append-only des transitions |
| `cash_balances` | Soldes par compte (settled / pending_in / reserved) |
| `cash_ledger_entries` | Journal des mouvements de cash (append-only) |
| `cash_reservations` | Cash soft-lockés pour un objectif ou une suggestion |
| `funding_allocation_links` | Liens transfert ↔ objectif / plan / suggestion |

### Machine à états des transferts

```
draft → initiated → pending_settlement → settled
               ↓              ↓
           cancelled        partially_settled → settled
                                 ↓
                               reversed / failed
```

### Endpoints API (`/funding` · `/cash`)

**Transferts** (`/funding/transfers`)
- `GET /funding/transfers` — liste filtrée (status, destinationId)
- `GET /funding/transfers/:id` — détail
- `POST /funding/transfers` — créer (draft)
- `PATCH /funding/transfers/:id` — modifier (draft uniquement)
- `POST /funding/transfers/:id/initiate` — draft → initiated (bumpe pending_in)
- `POST /funding/transfers/:id/settle` — → settled / partially_settled (crédite settled, écrit ledger)
- `POST /funding/transfers/:id/cancel` — → cancelled
- `POST /funding/transfers/:id/fail` — → failed
- `POST /funding/transfers/:id/reverse` — → reversed (décrédite settled, écrit ledger)
- `GET /funding/transfers/:id/audit` — journal hash-chaîné

**Sources / Destinations** (`/funding/sources`, `/funding/destinations`)
- `GET /funding/sources` · `POST /funding/sources`
- `GET /funding/destinations` · `POST /funding/destinations`

**Cash** (`/cash`)
- `GET /cash/balances/summary` — agrégat par devise (available, settled, reserved, pending_in)
- `GET /cash/balances` — soldes par compte
- `GET /cash/ledger` — journal append-only (filtrable par type / devise / destinationId)
- `GET /cash/reservations` — liste des réservations (filtrable par goalId / status)
- `POST /cash/reservations` — créer une réservation (vérifie la disponibilité)
- `POST /cash/reservations/:id/release` — libérer (écrit ledger reservation_release)
- `POST /cash/reservations/:id/consume` — consommer

### Pages UI

| Route | Description |
|---|---|
| `/funding` | Liste des transferts avec filtres par statut |
| `/funding/new` | Formulaire de création |
| `/funding/:id` | Détail + transitions + journal d'audit |
| `/cash` | KPIs de liquidités + balances par compte + réservations |
| `/cash/ledger` | Journal append-only avec filtres type/devise |

### Intégrations contextuelles

- `CashSummaryWidget` (dashboard) — available / settled / reserved / pending_in + liens directs
- `ReservationsPanel` sur `/cash` — liens vers l'objectif et la suggestion liés à chaque réservation
- `/goals/:id` — affiche les réservations de cash liées à l'objectif
- Boutons "Cash" et "Funding" dans la toolbar du dashboard

### Limitations connues

- Aucun ordre bancaire réel : SmartVest est déclaratif uniquement.
- Les fonds sont sur le compte broker de l'utilisateur, pas chez SmartVest.
- `settled_amount` peut être partiel (`partially_settled`) — le règlement final crédite le delta.
- Le journal de cash est append-only (pas de correction directe — passer par `reversal`).

---

## Démarrage rapide (local)

**Prérequis**
- Node.js ≥ 20
- npm ≥ 10 (le projet utilise **npm workspaces**, pas pnpm)
- Un projet Supabase (gratuit) pour `SUPABASE_URL` / `SUPABASE_ANON_KEY` / `SERVICE_ROLE_KEY`

**Installation**
```bash
git clone https://github.com/yannicke819-max/smartvest.git
cd smartvest
npm install

cp .env.example .env.local
# éditer .env.local : renseigner les 3 clés Supabase + FEATURE_DELEGATION_HYBRID_SUGGESTIVE=true
```

**Appliquer le schéma Supabase**
```bash
# via Supabase CLI (recommandé)
supabase db push

# ou via SQL éditeur Supabase — exécuter dans l'ordre :
#   supabase/migrations/0001_init_schema.sql
#   supabase/migrations/0002_quotes_and_views.sql
#   ... jusqu'à 0008_action_proposals_dedup.sql
#   supabase/seed.sql (données de démo)
```

**Données de démo (utilisateur)**
1. Créer un utilisateur dans Supabase : `Auth → Add user → demo@smartvest.fr` + mot de passe
2. Copier l'`user_id` généré
3. Dé-commenter le bloc final de `supabase/seed.sql` et remplacer `<DEMO_USER_ID>` par l'UUID
4. Ré-exécuter la section dans le SQL éditeur

**Lancement**
```bash
npm run api:dev       # API NestJS sur http://localhost:3001
npm run web:dev       # Front Next.js sur http://localhost:3000
```

Ouvrir [http://localhost:3000](http://localhost:3000), se connecter avec `demo@smartvest.fr`.

**Qualité**
```bash
npm run typecheck
npm run lint
npm run format
cd apps/api && npx jest --no-coverage    # 190 tests backend
```

---

## Arborescence

```
apps/
  web/     Next.js 14 App Router, Tailwind, shadcn-style, React Query, Zustand
  api/     NestJS 10, @supabase/supabase-js (service role), Zod
packages/
  shared-types/      Types communs (Money, ids, flags, API)
  domain/            Entités métier (User, Portfolio, Position, AutonomyMandate…)
  cost-engine/       Ventilation des frais et frictions (broker / spread / slippage / FX)
  audit/             Journal hash-chaîné
  brokers/           BrokerAdapter + simulateur
  portfolio-engine/  Profils de risque, templates d'allocation, drift
supabase/
  migrations/        Schéma SQL complet (0001 → 0009)
  seed.sql           Données démo (markets, brokers, assets, quotes, signaux, + bloc user commenté)
.claude/
  skills/            Skills SmartVest (PRD, engine, UX, compliance)
```

---

## Déploiement

Voir [`docs/DEPLOY.md`](./docs/DEPLOY.md) pour le détail.

- **Front (apps/web)** : Vercel (Next.js) — config : `apps/web/vercel.json`
- **API (apps/api)** : **Fly.io uniquement** — config : `apps/api/fly.toml`
- **BDD** : Supabase (projet hébergé)

> ⚠️ L'API NestJS ne doit **pas** être déployée sur Vercel : c'est un serveur long-running, pas une fonction serverless. Voir `docs/DEPLOY.md` pour la procédure Fly.io.

Variables d'environnement requises côté plateforme : voir `.env.example`.

---

## Rebound TP strategy (P3-A)

Stratégie mean-reversion sur tickers liquides survendus avec sortie mécanique TP1/TP2/TP3 + SL discipliné. Vise l'objectif **$100 nets/jour** en captant des rebonds courts post-capitulation, complémentaire au sizing macro de Lisa (PR #41).

### Flow

```
                  ┌──────────────────────┐
                  │  Lisa cycle (5 min)  │
                  └──────────┬───────────┘
                             │
                             ▼
          ┌──────────────────────────────────────┐
          │  scanRebound(history, cfg)           │  ← pure helper
          │  packages/ai-analyst/src/strategies/ │
          └──────────┬───────────────────────────┘
                     │
        ┌────────────┼─────────────┐
        ▼            ▼             ▼
   condition 1  condition 2  …  condition 5
   RSI<30       close<bbLower   reversal candle
        │            │             │
        └────┬───────┴─────────────┘
             ▼
    ┌────────────────────┐
    │  ReboundSignal     │  { type: 'BUY' | 'HOLD', … }
    └─────────┬──────────┘
              │ if BUY
              ▼
   ┌────────────────────────────┐
   │  INSERT rebound_positions  │  status='OPEN', filled=100%
   └────────────┬───────────────┘
                │
                ▼
   ┌────────────────────────────────┐
   │  ReboundMonitorService cron    │  every 5 min
   │  - fetch live price            │
   │  - skip if fallback source     │
   │  - SL hit  → status='SL_HIT'   │
   │  - TP1 hit → status='TP1_HIT', filled=50%  │
   │  - TP2 hit → status='TP2_HIT', filled=20%  │
   │  - TP3 hit → status='TP3_HIT', filled=0%   │
   │  - timeout → status='TIMEOUT'  │
   └────────────────────────────────┘
                │
                ▼
   ┌────────────────────────────┐
   │  GET /lisa/daily-pnl       │  PR #42 + dailyTargetHit
   │  realized + latent ≥ 100$  │  freeze nouvelles entrées
   └────────────────────────────┘
```

### Conditions BUY (TOUTES requises sur la dernière bougie close)

1. RSI(14) < `REBOUND_RSI_OVERSOLD` (default 30)
2. close < BollingerLower(20, 2)
3. drawdown 20-bar ≤ -`REBOUND_MIN_DD_PCT` (default 15%)
4. volume > `REBOUND_VOL_SPIKE` × SMA(volume, 20) (default 1.5×)
5. Bougie de retournement : close > open ET RSI[t] > RSI[t-1] ET RSI[t-1] < oversold

### Niveaux et sortie mécanique

| Palier | Niveau | Sortie qty | Status DB |
|---|---|---|---|
| TP1 | entry × 1.05 | 50% | `TP1_HIT` |
| TP2 | entry × 1.10 | 30% | `TP2_HIT` |
| TP3 | entry × 1.15 | 20% | `TP3_HIT` |
| SL  | entry × 0.96 | 100% restants | `SL_HIT` |
| Time stop | 10 jours après entrée | 100% restants | `TIMEOUT` |

### Variables d'environnement

```env
REBOUND_RSI_OVERSOLD=30
REBOUND_MIN_DD_PCT=15
REBOUND_VOL_SPIKE=1.5
REBOUND_TP1_PCT=5
REBOUND_TP2_PCT=10
REBOUND_TP3_PCT=15
REBOUND_SL_PCT=4
REBOUND_TIME_STOP_DAYS=10
DAILY_TARGET_USD=100

# P3-A.2 — Scanner watchlist
REBOUND_WATCHLIST=AAPL.US,MSFT.US,NVDA.US,...   # CSV, override default
MAX_CONCURRENT_REBOUND_POSITIONS=5
```

### Backtest validation (P3-B)

Avant de déployer du capital significatif sur la stratégie rebound-tp, valider l'expectancy via un backtest historique.

#### Lancer depuis l'UI GitHub (recommandé, P3-B.2)

1. Ouvre **GitHub → Actions → Backtest Rebound → Run workflow**
2. Sélectionne les inputs (defaults : `both`, 2 ans, `default`, auto-tune `true`)
3. Clique **Run workflow** — durée ~5-10 min
4. Le verdict GO/NO-GO + métriques apparaissent directement dans le **Job summary** (pas besoin de télécharger l'artifact)
5. Historique longitudinal : table `backtest_runs` Supabase

Pré-requis Settings → Secrets and variables → Actions :
- `EODHD_API_KEY` (clé EODHD pour fetch OHLCV)
- `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` (insert row `backtest_runs`)

Le workflow fail-fast au step `Env check` si un secret manque, avec message explicite indiquant lequel ajouter.

#### Lancer en local (alternative)

```bash
# Run par défaut (SP500 + NASDAQ100, 2 ans glissants, cfg default)
EODHD_API_KEY=... npm run backtest:rebound -w @smartvest/ai-analyst

# Args explicites + auto-tune
EODHD_API_KEY=... SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
  npm run backtest:rebound -w @smartvest/ai-analyst -- \
    --universe=both --start=2024-04-28 --end=2026-04-28 --cfg=default --auto-tune
```

**Sortie** :
- `tmp/backtest-rebound-<ts>.json` — payload complet (variants, metrics, verdict)
- `tmp/backtest-rebound-<ts>.md` — rapport humain GO/NO-GO + breakdown
- INSERT row dans `backtest_runs` (si SUPABASE_* setés)

**Verdict** : `GO` si hit-rate (TP1+TP2+TP3) ≥ 55% ET expectancy > 0. Sinon `NO-GO`.

**Auto-tune** : si NO-GO et `--auto-tune`, run 3 variantes alt (`rsi_25`, `vol_2_0`, `dd_20`) et sélectionne celle avec la meilleure expectancy. La variante gagnante est retournée mais **n'écrase PAS automatiquement les defaults env** — l'utilisateur doit ouvrir une PR manuelle pour patcher `REBOUND_*` après revue du rapport MD.

**Fail-fast** :
- `EODHD_API_KEY` manquante → exit 1
- `> 50%` des fetches échouent → throw `data provider down`

### Scanner watchlist (P3-A.2 + P3-C)

`ReboundScannerService` ferme la boucle d'entrée avec **scan 2-phase** :

- Cron `'0 */15 * * * 1-5'` toutes les 15 min, lun-ven
- Body check heures marché US (14:30-21:00 UTC) — sinon no-op
- **Watchlist** : table `watchlist_universe` (default `sp500` ~200 tickers, override env `REBOUND_UNIVERSE=sp500|nasdaq100|mega12` ou `REBOUND_WATCHLIST=CSV`)
- **Phase 1 — Pre-filter** sur cache `ohlcv_cache_daily` :
  - lecture des 30 dernières bougies par ticker (~aucun fetch réseau)
  - calc RSI(14) pur · garde si RSI < `REBOUND_PREFILTER_RSI_MAX` (default 35)
  - typique : 30-50 candidats sur 500
- **Phase 2 — Full scan** sur candidats uniquement :
  - Fetch live 60 bars EODHD si cache pas assez frais (cache 1h)
  - Run `scanRebound(bars, cfg)`
  - **Sector cap** : si secteur déjà à `REBOUND_SECTOR_CAP_PCT` × MAX (default 20% → 1 position) → skip
  - Si BUY ET pas de position OPEN ET race-condition guard → INSERT
- Garde-fous : `dailyTargetHit` freeze, `openCount >= MAX_CONCURRENT` skip
- Audit : `lisa_decision_log` kind=`rebound_scan_completed` (hash chain) avec payload `{phase1_count, phase2_count, signals, opened, skipped_reasons}`
- Lisa pipeline : `MarketSnapshot.reboundSignals` injecté dans le prompt sous `## Positions rebound ouvertes`

### OHLCV cache daily (P3-C)

`OhlcvCacheService` cron `'30 21 * * 1-5'` (21:30 UTC, post-close NYSE) :
- UPSERT `ohlcv_cache_daily` pour chaque ticker dans la watchlist active
- Throttling 10 req/sec (env `OHLCV_FETCH_RPS`)
- Fail-fast si > 50% des fetches échouent (pas de fallback synthétique)

Coût EODHD : ~500 fetches/jour (1×/jour) au lieu de 500 × 26 ticks = 13 000 fetches/jour. **×26 économie**.

### Garde-fous

- **Source fallback** : si `LisaService.getLivePrice` retourne `source` préfixé par `fallback*`, le cron skip l'évaluation pour ne pas trigger une sortie sur prix corrompu (cf. CLAUDE.md « Garde-fous prix fallback »).
- **Pas d'exécution réelle** : aucun appel `BrokerAdapter.placeOrder()`. Les positions sont simulées (paper trading), cohérent avec `MANUAL_EXPLICIT` par défaut.
- **Daily target hit** : `GET /lisa/daily-pnl` expose `dailyTargetHit: boolean`. Le scanner ne doit pas créer de nouvelles positions quand cumul ≥ target (responsabilité du caller).

### Tests

`packages/ai-analyst/src/strategies/__tests__/rebound-tp.spec.ts` — 12 specs couvrant : capitulation full setup → BUY, bull trap → HOLD (RSI), no volume spike → HOLD, reversal candle baissière → HOLD, drawdown insuffisant → HOLD, NaN/négatifs → HOLD, custom TP/SL configs, threshold strict.

Backtest hit-rate TP1 ≥ 55% : ticket P3-B séparé.

---

## Contribution

Règles de wording, feature flags, conventions de code : [`CLAUDE.md`](./CLAUDE.md).

- Branche de développement active : `feat/phase-5-hybrid-suggestive`
- Ne jamais push vers `main` sans validation explicite
