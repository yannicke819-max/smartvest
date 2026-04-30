# ADR-002 — SmartVest "Grand Public Ready"

- **Date** : 2026-04-30
- **Owner** : Yannick (yannicke819-max)
- **Status** : ACCEPTED
- **Source** : `docs/audit-2026-04.md` (1117 lignes, 5 phases, 47 routes, 13 sidebar — réel ~25-30% MVP public)

## 1. Décision

SmartVest passe d'app technique devs/traders à site opérationnel grand public.
Vocabulaire humain partout, guide utilisateur intégré expliquant chaque champ
technique et les risques encourus selon les choix. **Toutes pages opérationnelles**
de l'onboarding au "Mon compte".

## 2. Plan 8 sprints

Ordre exécution (S5 remonté car bloquant parcours utilisateur, S8 ajouté pour
légal MVP) :

| # | Sprint | Durée | Scope résumé |
|---|---|---|---|
| **S1** | Renommage humain | 3j | Sidebar + titles + breadcrumbs : Tableau de bord→Mon tableau de bord, Lisa→Mon assistant Lisa, Backtest→Tester sur le passé, etc. RBAC `/admin/monitoring` masqué non-admin. |
| **S2** | `<HelpTip>` + Glossaire | 5j | Composant popover (terme→déf simple/avancée+risque+exemple). Table `glossary_terms` seed 80 entrées. Page `/aide/glossaire` recherche fuzzy + filtre niveau. |
| **S3** | `<RiskBadge>` + phrase humaine | 2j | 🟢 faible / 🟡 modéré / 🟠 élevé / 🔴 extrême. Mapping auto vol annualisée → niveau. Plug Bot Lab / Optimizer / Monte Carlo / ordres simulés. |
| **S5** | Refonte onboarding **complète** | 7j | Landing publique → sign-up email/OAuth → wizard 6 étapes (prénom, niveau, objectif, horizon, réaction risque, récap profil) → portfolio initial proposé selon profil → 1er usage guidé (tour 5-7 spots shepherd.js). Persistance mid-flow. Templates email Resend (welcome, J+1, J+7, J+30). |
| **S4** | Guide `/aide` complet | 10j | `/aide` hub + recherche, `/aide/premiers-pas` (5min), `/aide/comprendre` (12 articles), `/aide/utiliser` (13 articles 1/page sidebar), `/aide/glossaire`, `/aide/faq` (30 Q), `/aide/risques`, `/aide/contact`. |
| **S6** | Pages vides/squelettes | 5j | `/performance`, `/alerts`, `/history`, `/help`, `/settings` (profil/sécurité/notifs/abonnement/données). |
| **S7** | Empty states + first-run tour | 2j | CTA explicite + lien aide sur chaque page vide. Tour produit shepherd.js post-onboarding. |
| **S8** | Légal MVP (bloquant Go-Live) | 3j | `/legal/cgu`, `/legal/confidentialite`, `/legal/cookies` + bandeau, `/legal/mentions`. Endpoints `GET /me/export` (RGPD) et `DELETE /me` (soft-delete + double conf). |

## 3. Règles non-négociables (cf. CLAUDE.md §1 produit + §6 mandats)

1. **Français courant**, zéro anglicisme non glosé
2. Chaque champ formulaire = label clair + `<HelpTip>` + placeholder + risk hint si applicable
3. `SAFE_PUBLIC_MODE=true` : badges "🎮 Mode simulation" sur Bot Lab / Backtest / Optimizer / ordres
4. Compliance wording feature-flagged
5. Aucune action irréversible sans confirmation + résumé de l'impact
6. Mobile-first <375px sur **toutes** les pages
7. A11y WCAG AA min (focus visible, contrastes, aria-label)
8. Tests E2E Playwright 3 parcours : débutant / initié / expert

## 4. Persona-based UI (S5 + composant `useExperienceLevel`)

Source de vérité : `user_profile.experience_level ∈ { 'debutant', 'initie', 'expert' }`.

| Niveau | Sidebar visible |
|---|---|
| Débutant | Mon tableau de bord, Mon portefeuille, Mes résultats, Mon assistant Lisa, Mes notifications, Mes opérations, Mon compte, Aide |
| Initié | + Tester sur le passé, Projections futures |
| Expert | + Améliorer mon portefeuille, Mes stratégies auto |

Toggle "Afficher les fonctions avancées" dans Mon compte permet à un Débutant
de débloquer manuellement.

## 5. Mapping renommage Sprint 1

| Avant | Après | Route |
|---|---|---|
| Tableau de bord | Mon tableau de bord | `/` |
| Portefeuille | Mon portefeuille | `/portfolio` |
| Performance | Mes résultats | `/performance` |
| Lisa | Mon assistant Lisa | `/lisa` |
| Backtest | Tester sur le passé | `/backtest` |
| Monte Carlo | Projections futures | `/monte-carlo` |
| Optimizer | Améliorer mon portefeuille | `/optimizer` |
| Bot Lab | Mes stratégies auto (mode démo) | `/bot-lab` |
| Alertes | Mes notifications | `/alerts` |
| Historique | Mes opérations | `/history` |
| Paramètres | Mon compte | `/settings` |
| Aide & Docs | Aide | `/help` |
| Monitoring | (masqué non-admin via RBAC) | `/admin/monitoring` |

Routes inchangées (préservation deeplinks externes / bookmarks).

## 6. Livrables

- ADR-002 (ce document)
- 1 PR par sprint, branche `feat/ux-gp-sprint-N-<topic>`, auto-merge si CI verte
- Mise à jour `CLAUDE.md` section pages avec nouvelle nomenclature (S1)
- Tests E2E Playwright avant clôture S7
- Pages légales `/legal/*` avant Go-Live (S8)

## 7. Choix techniques

| Sujet | Choix | Justification |
|---|---|---|
| Tour produit | **shepherd.js** | Plus léger qu'`intro.js`, mieux maintenu, support React FN sans wrapper |
| Email | **Resend** | Déjà mentionné dans le brief, API REST simple, free tier 100/jour |
| Glossaire stockage | **Supabase table `glossary_terms`** | Seed via migration, indexable RLS-friendly, fuzzy via Postgres `pg_trgm` |
| Risk levels | **4 niveaux** (vert/jaune/orange/rouge) | Mapping vol annualisée déterministe (cf. S3) |

## 8. Hors scope (pour mémoire — explicitement EXCLU de cette ADR)

- Vrai déploiement live de KYC/AML (compliance produit régulé) — `REGULATED_MODE` reste `false`
- Multi-utilisateur / collaboration / partage portefeuille
- Mobile natif (responsive web suffit)
- App marketplace publique (App Store / Play Store)
- Internationalisation (FR uniquement v1)

## 9. Méta — réversibilité par sprint

Chaque sprint est **mergeable indépendamment**. Rollback = `git revert` du squash
de la PR. Aucune migration DB destructive — seules additions (nouvelles tables,
nouvelles colonnes nullable). Schemas Supabase versionnés sous `supabase/migrations/`.

---

**Validation** : Yannick (yannicke819-max) — 30/04/2026
