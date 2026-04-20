# CLAUDE.md — SmartVest

Guide de travail pour Claude Code sur ce repo.
**À lire avant toute modification non triviale.**

---

## 1. Positionnement produit (non négociable)

SmartVest est un **assistant personnel d'investissement** et un **simulateur**.

- Jamais : "conseiller financier", "gestionnaire de patrimoine", "robo-advisor régulé".
- Jamais : promesses de rendement, recommandations personnalisées au sens MIFID, ordres automatiques par défaut.
- Toujours : aide à la décision, scénarios, simulations, analyse de frictions.

### Wording interdit dans le code, les commentaires, l'UI et la doc

- `guaranteed return`, `profit guaranteed`, `best investment`
- `you should buy`, `our recommendation is`, `recommended asset`
- `riskless`, `sans risque`, `rendement garanti`, `performance garantie`

Une règle ESLint (`no-restricted-syntax`) bloque ces patterns dans les string literals.

### Wording préféré

- "simulation", "scénario", "analyse", "projection"
- "hypothèse", "fourchette", "écart vs cible"
- "les performances passées ne préjugent pas des performances futures"

---

## 2. Feature flags — modes produit

Trois modes coexistent et pilotent le comportement de l'UI et de l'API :

| Flag | Rôle | Disclaimer requis |
|---|---|---|
| `PERSONAL_MODE` | Usage strictement personnel du développeur. UI minimaliste. | Non |
| `SAFE_PUBLIC_MODE` | Bêta publique restreinte. Simulations uniquement, pas d'exécution. | Oui, partout |
| `REGULATED_MODE` | Fonctions nécessitant agrément (RTO/CIF). **Désactivé par défaut**. | Oui + kill-switch |

Source de vérité :

- Front : `apps/web/src/lib/feature-flags.ts` (variables `NEXT_PUBLIC_FEATURE_*`).
- Back : `apps/api/src/modules/feature-flags/feature-flags.service.ts`.
- Types partagés : `@smartvest/shared-types`.

Ne jamais ajouter une feature "visible publiquement" sans la gater derrière le flag approprié.

---

## 3. Architecture — vue d'ensemble

```
smartvest/
├── apps/
│   ├── web/                    Next.js App Router + Tailwind + shadcn-style
│   └── api/                    NestJS (REST)
├── packages/
│   ├── shared-types/           Types communs (zod) : Money, ids, API, flags
│   ├── domain/                 Entités métier (User, Portfolio, Position, etc.)
│   ├── cost-engine/            Ventilation frais broker / spread / slippage / FX
│   ├── audit/                  Journal append-only avec hash chaîné
│   ├── brokers/                Abstraction BrokerAdapter + implémentation simulée
│   └── portfolio-engine/       Profils de risque, templates d'allocation, drift
├── supabase/
│   └── migrations/             Schéma SQL initial (à appliquer avec `supabase db push`)
└── .claude/skills/             Skills SmartVest (PRD, engine, UX, compliance)
```

### Stack

- TypeScript strict partout, monorepo via npm workspaces.
- Front : Next.js 14 App Router, React 18, Tailwind, React Query, Zustand.
- Back : NestJS 10, `@supabase/supabase-js` (service role).
- Validation : Zod (types = source de vérité).
- Montants : **toujours** en `string` (Decimal.js en interne). **Jamais** `number` pour de l'argent.
- IDs : UUID côté DB, ISIN/MIC/Ticker validés par regex au niveau type.

### Évolution prévue (ne pas anticiper maintenant)

- PostgreSQL + TimescaleDB pour séries temporelles historiques.
- Redis pour cache quotes chaudes.
- S3/Parquet pour backtests long terme.
- CDC vers data warehouse pour analytics.

---

## 4. Règles de code

- Pas de `float` pour l'argent — `Decimal` (string représentation) + `decimal.js` en runtime.
- Tout ce qui ressemble à un ordre doit passer par un `BrokerAdapter`, jamais d'appel direct.
- Toute suggestion utilisateur doit avoir une trace `ExecutionAudit` (hash chaîné).
- Séparer lisiblement :
  - **Information** (éducatif, statique).
  - **Analyse** (calculs sur données utilisateur, déterministe).
  - **Scénario** (simulation probabiliste, assumptions explicites).
- Les hypothèses d'une simulation sont **toujours** affichées à l'utilisateur.
- Pas d'abstraction prématurée. 3 lignes dupliquées valent mieux qu'une factorisation mal posée.

---

## 5. Frictions d'intermédiation — à rendre visibles

Le moteur de coût (`@smartvest/cost-engine`) ventile chaque transaction :

- `brokerFee` : frais fixe + % du notionnel (borné min/max).
- `spreadCost` : écart spread vs mid-price.
- `slippageCost` : écart prix d'exécution vs benchmark annoncé.
- `fxMarkup` : marge appliquée sur le change (en % du notionnel).
- `taxes` : TTF, stamp duty, etc.
- `netAmount` : coût total pour l'utilisateur.

L'UI doit toujours pouvoir présenter cette ventilation si l'utilisateur clique "détail" sur une transaction.

---

## 6. Dev workflow

```bash
# Installation
npm install

# Dev front + back (2 terminaux)
npm run web:dev
npm run api:dev

# Typecheck / lint / format
npm run typecheck
npm run lint
npm run format
```

### Branches

- Développement : `claude/smartvest-ai-investment-KkDgO`.
- Ne jamais pousser vers `main` sans validation explicite.

### Commits

- Convention : message clair, impératif, explique le "pourquoi".
- Jamais de `--no-verify`.
- Jamais d'amend sur un commit déjà poussé.

---

## 7. Ce qui est **hors scope Phase 1**

- Exécution réelle d'ordres (nécessite agrément).
- Recommandations personnalisées basées sur la situation patrimoniale complète.
- Données de marché temps réel (delayed uniquement).
- Mobile natif (responsive web suffit).
- Multi-utilisateurs / collaboration.

Ces items sont documentés dans la feuille de route produit (voir conversation initiale).

---

## 8. Points à faire valider par un expert juridique (pas par Claude)

- Statut exact (CIF, RTO, PSI, PSAN si crypto).
- CGU et politique de confidentialité (RGPD + DSP2 éventuel).
- Wording des disclaimers en production publique.
- Règles MiCA si support crypto étendu.
- Règles fiscales affichées (PEA, flat tax, etc.).

Claude peut repérer les zones sensibles via la skill `mapping-fintech-compliance`, mais **ne rédige pas d'avis juridique définitif**.
