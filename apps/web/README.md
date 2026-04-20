# @smartvest/web

Front Next.js App Router de SmartVest (Phase 1).

## Lancer en local

```bash
npm install
npm run web:dev
```

Ouvrir http://localhost:3000.

## Stack

- Next.js 14 (App Router)
- React 18 + TypeScript strict
- Tailwind CSS + design system SmartVest
- React Query (client API)
- Zustand (UI state léger)
- Supabase (auth + BDD, via `@supabase/ssr`)

Variables d'environnement : voir `.env.example` à la racine.
