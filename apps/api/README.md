# @smartvest/api

API NestJS de SmartVest (Phase 1).

## Lancer en local

```bash
npm install
npm run api:dev
```

Endpoints disponibles :

- `GET /health` — status du service.
- `GET /feature-flags` — mode produit actif (PERSONAL_MODE, SAFE_PUBLIC_MODE, REGULATED_MODE).
- `GET /portfolios` — stub, renvoie une liste vide.

Variables d'environnement : voir `.env.example` à la racine.
