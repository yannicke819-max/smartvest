# ADR-003 — Settings V2 (information architecture)

- **Date** : 2026-05-01
- **Owner** : Yannick (yannicke819-max)
- **Status** : PROPOSED — en attente validation IA proposée
- **Sprint cible** : Sprint 10
- **Suit** : ADR-002 grand-public-ready (Sprint 6 a livré les pages squelettes profil/sécurité/notifs/abonnement/données)

## 1. Contexte

Après Sprint 6 (squelettes /settings) + PR #161 (admin gating layout) + PR #157 (RGPD endpoints), `/settings/page.tsx` est aujourd'hui un **hub à 2 sections plates** (134 lignes) listant 10 sous-pages :

```
/settings
├── /profil               — User    (prénom, niveau, langue)
├── /securite             — User    (mot de passe, sessions)
├── /notifications        — User    (alertes email, résumé hebdo)
├── /abonnement           — User    (plan, facturation, limites)
├── /donnees              — User    (RGPD : export + delete)
├── /delegation           — Admin   (mandats autonomie + kill-switch)
├── /strategy-mode        — Admin   (cadence + intensité risque)
├── /hyper-trading        — Admin   (profil scalping + garde-fous)
├── /sniper               — Admin   (sessions ciblées courtes)
└── /brokers              — Admin   (connexions brokers lecture seule)
```

Structure actuelle :

```tsx
// settings/page.tsx
PROFILE_SECTIONS = [profil, securite, notifications, abonnement, donnees]
ADVANCED_SECTIONS = [delegation, strategy-mode, hyper-trading, sniper, brokers]  // gated isAdmin
```

**Problèmes constatés :**

| # | Problème | Impact |
|---|---|---|
| 1 | "Profil & préférences" mélange identité (profil/sécurité), comms (notifs), billing (abonnement) et RGPD (données) | Charge cognitive, RGPD noyé dans le bruit |
| 2 | "Réglages avancés" empile 5 modes opérateurs (delegation, strategy-mode, hyper, sniper, brokers) sans hiérarchie d'intention | Difficile de distinguer "config stratégie" de "autorisation d'exécuter" |
| 3 | Pas de signal visuel pour les sections à fort impact (mandat autonome, kill-switch, RGPD delete) | Risque d'action accidentelle |
| 4 | Nomenclature "Réglages avancés" peu informative pour un utilisateur non-tech | Découverte limitée des modes opératoires |

## 2. Drivers de décision

1. **Charge cognitive minimale** : grouper par intention métier, pas par "user vs admin"
2. **RGPD visible** : conformité = signal de transparence à mettre en avant, pas à enfouir
3. **Distinguer config vs autorisation** : strategy-mode (préférence) ≠ delegation/brokers (autorisation d'agir)
4. **No breaking change** : toutes les URLs `/settings/*` existantes restent fonctionnelles
5. **Cohérence avec ADR-002 §3** : français courant, zéro anglicisme non glosé
6. **Scalabilité** : la nouvelle IA doit accommoder l'ajout futur de pages sans devenir une liste plate à 15+ items

## 3. Options considérées

### Option A — Proposition utilisateur (4 sections fonctionnelles)

| Section | Pages |
|---|---|
| 🎯 Mon objectif | strategy-mode, hyper-trading, sniper |
| 👤 Mon compte | profil, sécurité, notifications |
| 🗂️ Mes données | données (RGPD), abonnement |
| ⚙️ Avancé / Admin | delegation, brokers (+ wrapper admin) |

**Pros :**
- "Mon objectif" capture l'intention métier (cadence, mode opérationnel)
- "Mes données" valorise RGPD en regroupant avec billing (souveraineté financière)
- 4 sections = scannable

**Cons :**
- "Mon objectif" mélange préférence (strategy-mode) et garde-fous serrés (hyper-trading) sans nuance — un débutant pourrait activer hyper-trading en pensant régler un objectif
- "Mes données" + abonnement = couplage forcé : l'abonnement n'est pas vraiment de la "donnée", c'est du contractuel
- "Avancé / Admin" devient fourre-tout : delegation (mandat) ≠ brokers (lecture seule connexions)

### Option B — Challenger : 4 sections par axe d'impact

| Section | Pages | Justification |
|---|---|---|
| 👤 Mon profil & accès | profil, sécurité, notifications, abonnement | Tout ce qui touche à l'identité utilisateur + canaux de communication + contrat |
| 🔒 Mes données & confidentialité | données (RGPD) | Section dédiée — un seul item mais signal RGPD maximal |
| 🎯 Stratégie & objectifs | strategy-mode, hyper-trading, sniper | Modes opératoires Lisa, par intensité croissante |
| 🛡️ Délégation & exécution | delegation, brokers | Autorisation d'agir : qui (mandat) + où (broker) |

**Pros :**
- RGPD a sa propre section = visibilité conformité
- "Stratégie & objectifs" classe par intensité (LONG_HORIZON → ACTIVE → HYPER_ACTIVE → SNIPER session-based)
- "Délégation & exécution" sépare clairement "à qui je donne le pouvoir de trader" (delegation) et "où l'argent vit" (brokers)
- Découverte progressive : utilisateur novice voit profil + données ; admin/avancé voit stratégie + délégation

**Cons :**
- Section RGPD à 1 item est visuellement faible (à compenser via UI : illustration / lien export rapide)
- Plus de sections que dans l'Option A → plus à scroller (mitigation : layout responsive 2 colonnes desktop)

### Option C — Status quo + améliorations marginales

Garde la structure actuelle (Profile/Avancé), mais :
- Renomme "Profil & préférences" → "Mon compte"
- Renomme "Réglages avancés" → "Stratégie & automatisation"
- Ajoute des sub-headers dans chaque section pour grouper visuellement

**Pros :** zéro refactor, minimal friction.

**Cons :** ne résout aucun des 4 problèmes du §1. Risque de devoir y revenir au prochain sprint quand on ajoutera /settings/api-keys ou /settings/webhooks.

## 4. Décision proposée

**Option B retenue** (4 sections par axe d'impact), avec 2 nuances par rapport au challenger pur :

1. **`/settings/abonnement`** reste sous "Mon profil & accès" plutôt que sous "Mes données" (l'abonnement décrit ce que l'utilisateur peut faire dans la plateforme, pas ses données personnelles).
2. **Section "Mes données"** garde un seul item RGPD mais le hub `/settings` affiche un aperçu rapide (« Exporter mes données » / « Supprimer mon compte ») directement dans la card de section pour compenser le faible volume.

### IA finale (à implémenter en Phase f.2)

```
/settings (hub redesigné)
├─ 👤 Mon profil & accès          [4 items]
│  ├─ /settings/profil             — Prénom, niveau, langue
│  ├─ /settings/securite           — Mot de passe, sessions
│  ├─ /settings/notifications      — Alertes email, résumés
│  └─ /settings/abonnement         — Plan, facturation, limites
│
├─ 🔒 Mes données & confidentialité [1 item, prominent]
│  └─ /settings/donnees             — Export RGPD + suppression compte
│
├─ 🎯 Stratégie & objectifs        [3 items, admin-gated]
│  ├─ /settings/strategy-mode      — Cadence + intensité risque
│  ├─ /settings/hyper-trading      — Scalping (opt-in strict)
│  └─ /settings/sniper              — Sessions ciblées courtes
│
└─ 🛡️ Délégation & exécution       [2 items, admin-gated]
   ├─ /settings/delegation          — Mandats autonomie + kill-switch
   └─ /settings/brokers             — Connexions brokers
```

**Wording final** (conforme ADR-002 §3) :

| Avant | Après |
|---|---|
| "Profil & préférences" | "Mon profil & accès" |
| "Réglages avancés" | (split) "Stratégie & objectifs" + "Délégation & exécution" |
| "Mes données" (sous Profil) | "Mes données & confidentialité" (section autonome) |

## 5. Migration

### 5.1 Aucun breaking change URL

Toutes les routes `/settings/*` actuelles **restent fonctionnelles**. Un utilisateur arrivant via un bookmark ou un email atterrit sur la même page.

### 5.2 Refactor `/settings/page.tsx`

Phase f.2 (PR séparée) :
- Remplacer `PROFILE_SECTIONS` + `ADVANCED_SECTIONS` (arrays plats) par 4 arrays nommées
- Conserver le composant `SectionList` existant
- Ajouter un composant `SectionCard` enrichi pour la section RGPD (illustration + actions rapides)
- Wrapper les 2 dernières sections dans `{isAdmin && (...)}` (déjà géré par les `layout.tsx` `AdminGuard` au niveau des sous-pages — la racine ajoute juste un masquage visuel cohérent)

### 5.3 Ordre d'affichage

L'ordre des sections suit la **fréquence d'usage utilisateur lambda** :
1. Mon profil & accès — utilisé occasionnellement (réglages compte)
2. Mes données & confidentialité — visible mais usage rare (export annuel, ou avant suppression)
3. Stratégie & objectifs — ne s'affiche que si admin (UX inchangée pour user lambda)
4. Délégation & exécution — ne s'affiche que si admin

### 5.4 Tests requis (Phase f.2)

- [ ] Snapshot test du rendu hub avec/sans `isAdmin`
- [ ] Tests E2E Playwright : navigation `/settings` → chaque sous-page (10 routes)
- [ ] A11y : focus order sur les 4 cards, screen reader annonce les 4 sections distinctement
- [ ] Mobile-first <375px : sections empilées proprement

## 6. Risques + alternatives

### 6.1 Risques

| Risque | Sévérité | Mitigation |
|---|---|---|
| User déjà familier avec l'IA actuelle confused | Faible | Routes inchangées, redirections automatiques pour pages bookmarkées |
| Section RGPD à 1 item paraît "vide" | Moyen | UI enrichie avec actions inline (export rapide en 1 clic) |
| "Mon profil & accès" devient surchargé si on ajoute notifications push, 2FA, etc. | Moyen | Sub-grouping intra-section possible (e.g. "Identité" + "Sécurité" + "Notifications") |
| Future feature ne rentre dans aucune des 4 sections | Faible | Critère de design : toute nouvelle page doit pouvoir être rattachée à une section existante OU justifier une 5ème section avec ADR follow-up |

### 6.2 Alternatives non retenues

- **Tabs horizontaux** au lieu de sections empilées : moins scannable sur mobile, abandon WCAG 2.1.1 (keyboard nav).
- **Sidebar permanente** dans /settings : ajoute du chrome UI mais OK desktop. Reportée à un éventuel ADR-005 si l'IA grandit au-delà de 4 sections.
- **Search bar dans le hub** : intéressante mais sur-engineering pour 10 items aujourd'hui.

## 7. Phases d'exécution

| Phase | Scope | Status |
|---|---|---|
| **f.1** | ADR-003 + IA proposée + validation utilisateur | **Cette PR** |
| **f.2** | Implémentation /settings/page.tsx refactor + tests | Bloquée par f.1 GO |

**Cette PR ne contient AUCUN changement de code applicatif** — uniquement le document ADR. La validation de l'IA proposée (§4) déclenche la Phase f.2 via une PR séparée `feat(settings): rollout V2 information architecture`.

## 8. Décision

> Phase f.1 livrée — STOP. Attente du GO utilisateur sur l'IA proposée (§4) avant d'engager Phase f.2.

Si l'IA proposée nécessite des ajustements (sections renommées, items déplacés), itérer dans cette PR avant validation. Une fois validée, le commit Phase f.2 cite ce ADR comme `Implements: ADR-003`.
