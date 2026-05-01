# Post-mortem — Prod figée 2h sur ESLint `no-empty` (2026-05-01)

## Symptôme

- Prod `smartvest-peach.vercel.app` figée sur le commit `385e2c4` pendant ~2h
- `/settings/donnees` (page RGPD livrée par PR #157) répondait 404 en prod
- Tous les builds Vercel rouge depuis 02:30 UTC ; GitHub CI vert sur les mêmes commits

## Cause racine

| Élément | Détail |
|---|---|
| Fichier | `apps/web/src/components/dashboard/welcome-banner.tsx` |
| Ligne | 46 |
| Code | `} catch {}` (catch vide sans commentaire) |
| Règle | `no-empty` (héritée de `eslint:recommended`) |
| Étape qui fail | `next build` (qui exécute ESLint en mode error) |
| Étape qui PASSE | `tsc -b` et Jest (CI GitHub) — d'où la zone aveugle |

**Pourquoi GitHub CI vert et Vercel rouge** : le workflow `.github/workflows/ci.yml` exécutait uniquement `npx tsc -b` + `npm test` ; il n'y avait **aucune** étape `next build` ni `eslint`. Vercel, lui, exécute `next build` qui inclut ESLint en mode error → fail → déploiement abandonné → prod figée.

## Fix

| PR | SHA | Action |
|---|---|---|
| #165 | `1c0a412` | Hotfix sur `main` : `} catch {}` → `} catch { /* localStorage indisponible (SSR, private browsing) */ }` + `.eslintrc.json` durci avec `"no-empty": ["error", { "allowEmptyCatch": true }]` |

Le hotfix a débloqué Vercel sous 3 min. Le rollup PR #164 (8 features bloquées par le bug) a ensuite pu atterrir en prod (`19c17b1`).

## Prévention

Aligner GitHub CI sur ce que Vercel exécute :

- Étape `npm run build --workspace=@smartvest/web` ajoutée au job `typecheck` de `ci.yml` (PR `chore/harden-ci-cleanup`).
- Coût : +90s par run, acceptable pour la couverture obtenue.
- Toute future erreur ESLint en mode error sera détectée au push GitHub avant d'atteindre Vercel.

Pistes complémentaires (non implémentées dans ce post-mortem) :

1. Créer un `apps/web/.eslintrc.json` qui extends `next/core-web-vitals` pour parité totale CI ↔ Vercel sur les règles Next-spécifiques.
2. Ajouter `eslint . --max-warnings 0` en CI pour catch les warnings susceptibles de basculer en error après mise à jour d'un preset.
