# SmartVest

Assistant personnel d'investissement — simulations, suivi, frictions d'intermédiation rendues visibles.

> SmartVest fournit des analyses et simulations à titre informatif.
> Ceci ne constitue pas un conseil en investissement personnalisé.

## Phase 1 — scope actuel

- Monorepo TypeScript (npm workspaces).
- Front Next.js 14 App Router + Tailwind + design system initial.
- API NestJS avec endpoint `/health`, flags, stubs portefeuille.
- Supabase comme backend (auth + BDD).
- Packages domaine, moteur de coût, audit append-only, abstraction broker, portfolio engine.
- Feature flags `PERSONAL_MODE`, `SAFE_PUBLIC_MODE`, `REGULATED_MODE`.

Cf. [`CLAUDE.md`](./CLAUDE.md) pour les règles produit et l'architecture détaillée.

## Démarrage rapide

```bash
npm install
cp .env.example .env.local
# renseigner Supabase URL / anon key si disponible

npm run api:dev       # API sur http://localhost:3001
npm run web:dev       # Front sur http://localhost:3000
```

## Arborescence

```
apps/
  web/     Next.js App Router (responsive desktop + mobile)
  api/     NestJS 10 + Supabase
packages/
  shared-types/      Types communs (Money, ids, flags, API)
  domain/            Entités métier
  cost-engine/       Ventilation des frais et frictions
  audit/             Journal hash-chaîné
  brokers/           BrokerAdapter + simulateur
  portfolio-engine/  Profils de risque, allocations, drift
supabase/
  migrations/        Schéma SQL initial
.claude/
  skills/            Skills SmartVest (PRD, engine, UX, compliance)
```

## Contribution

Voir [`CLAUDE.md`](./CLAUDE.md) — règles de wording, feature flags, conventions de code.
