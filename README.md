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

## Contribution

Règles de wording, feature flags, conventions de code : [`CLAUDE.md`](./CLAUDE.md).

- Branche de développement active : `feat/phase-5-hybrid-suggestive`
- Ne jamais push vers `main` sans validation explicite
