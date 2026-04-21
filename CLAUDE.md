# CLAUDE.md — SmartVest

Guide de travail pour Claude Code sur ce repo.
**À lire avant toute modification non triviale.**

---

## 1. Positionnement produit (non négociable)

SmartVest est une **plateforme d'investissement personnel** opérant selon un modèle de **délégation contrôlée**.

- Jamais : "conseiller financier", "gestionnaire de patrimoine", "robo-advisor régulé".
- Jamais : promesses de rendement, recommandations personnalisées au sens MIFID, ordres automatiques sans mandat explicite.
- Toujours : aide à la décision, scénarios, simulations, analyse de frictions, délégation maîtrisée.

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

## 2. Cadre de délégation — 3 modes (immuable)

SmartVest supporte trois modes de délégation. L'architecture doit tous les prévoir, même si seul `MANUAL_EXPLICIT` est actif aujourd'hui.

### Mode 1 — MANUAL_EXPLICIT (défaut absolu)

SmartVest **analyse, explique, compare, simule, alerte, mais n'agit jamais seul**.

- Toute action reste à l'initiative exclusive de l'utilisateur.
- SmartVest peut produire : informations, analyses, simulations, suggestions, alertes.
- Aucune écriture de position, ordre ou transaction sans action UI explicite de l'utilisateur.

### Mode 2 — HYBRID_SUGGESTIVE

SmartVest **propose des changements concrets** (positions, allocations, expositions, marchés).

- Toute action suggérée nécessite une **validation explicite utilisateur** (bouton de confirmation, revue de l'impact, friction volontaire).
- Les suggestions sont toujours accompagnées de : simulation de l'impact, frictions estimées, hypothèses explicitées.
- L'utilisateur peut rejeter, modifier ou différer chaque suggestion.

### Mode 3 — AUTONOMOUS_GUARDED

SmartVest **peut agir dans un mandat d'autonomie explicitement défini** à l'avance par l'utilisateur.

- Le mandat (`AutonomyMandate`) est créé manuellement par l'utilisateur, jamais généré automatiquement.
- Toute action autonome est **tracée, explicable et auditée** (hash chaîné dans `ExecutionAudit`).
- Toute action respecte des **caps, seuils, interdits et garde-fous** définis dans le mandat.
- Le mandat peut être **désactivé instantanément** via kill-switch (API + UI).
- L'autonomie n'est **jamais le comportement par défaut**.

### Règles immuables applicables aux 3 modes

1. Toute autonomie doit être **explicitement mandatée** — jamais inférée.
2. Distinguer clairement à tout moment :
   - **information** — éducatif, statique
   - **simulation** — probabiliste, hypothèses explicitées
   - **suggestion** — action concrète proposée, non validée
   - **intention d'exécution** — validée par l'utilisateur, pré-exécution
   - **exécution** — action réalisée, auditée
3. Chaque action autonome doit pouvoir être **expliquée a posteriori** (quelle règle du mandat l'a déclenchée, quel prix, quel volume).
4. Le mode autonome ne peut pas être activé sans `AutonomyMandate` valide et actif.
5. Toute feature future doit améliorer au moins un de ces axes :
   - rendement net
   - vitesse d'analyse
   - qualité de décision
   - détection d'opportunité
   - contrôle du risque
   - réduction des frictions (fees, spreads, slippage, FX cost)

---

## 3. Feature flags — modes produit et délégation

### Flags d'accès produit

| Flag | Rôle | Disclaimer requis |
|---|---|---|
| `PERSONAL_MODE` | Usage strictement personnel du développeur. UI minimaliste. | Non |
| `SAFE_PUBLIC_MODE` | Bêta publique restreinte. Simulations uniquement, pas d'exécution. | Oui, partout |
| `REGULATED_MODE` | Fonctions nécessitant agrément (RTO/CIF). **Désactivé par défaut**. | Oui + kill-switch |

### Flags de délégation

| Flag | Rôle | Activé par défaut |
|---|---|---|
| `DELEGATION_MANUAL_EXPLICIT` | Mode analyse/simulation uniquement | Oui |
| `DELEGATION_HYBRID_SUGGESTIVE` | Suggestions avec validation explicite | Non |
| `DELEGATION_AUTONOMOUS_GUARDED` | Exécution dans mandat — **jamais en prod sans mandat valide** | Non |

Source de vérité :

- Front : `apps/web/src/lib/feature-flags.ts` (variables `NEXT_PUBLIC_FEATURE_*`).
- Back : `apps/api/src/modules/feature-flags/feature-flags.service.ts`.
- Types partagés : `@smartvest/shared-types` → `feature-flags.ts`.

Ne jamais ajouter une feature "visible publiquement" sans la gater derrière le flag approprié.

---

## 4. Architecture — vue d'ensemble

```
smartvest/
├── apps/
│   ├── web/                    Next.js App Router + Tailwind + shadcn-style
│   └── api/                    NestJS (REST)
├── packages/
│   ├── shared-types/           Types communs (zod) : Money, ids, API, flags, delegation
│   ├── domain/                 Entités métier (User, Portfolio, Position, AutonomyMandate…)
│   ├── cost-engine/            Ventilation frais broker / spread / slippage / FX
│   ├── audit/                  Journal append-only avec hash chaîné
│   ├── brokers/                Abstraction BrokerAdapter + implémentation simulée
│   └── portfolio-engine/       Profils de risque, templates d'allocation, drift
├── supabase/
│   └── migrations/             Schéma SQL (à appliquer avec `supabase db push`)
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

## 5. Règles de code

- Pas de `float` pour l'argent — `Decimal` (string représentation) + `decimal.js` en runtime.
- Tout ce qui ressemble à un ordre doit passer par un `BrokerAdapter`, jamais d'appel direct.
- Toute suggestion utilisateur doit avoir une trace `ExecutionAudit` (hash chaîné).
- Toute action autonome doit vérifier le `AutonomyMandate` avant exécution et lever une exception si hors mandat.
- Séparer lisiblement :
  - **Information** (éducatif, statique).
  - **Analyse** (calculs sur données utilisateur, déterministe).
  - **Scénario** (simulation probabiliste, assumptions explicites).
  - **Suggestion** (action concrète proposée, en attente de validation).
  - **Intention** (validée, pré-exécution — HYBRID ou AUTONOMOUS uniquement).
  - **Exécution** (réalisée, toujours auditée — AUTONOMOUS_GUARDED uniquement, jamais par défaut).
- Les hypothèses d'une simulation sont **toujours** affichées à l'utilisateur.
- Pas d'abstraction prématurée. 3 lignes dupliquées valent mieux qu'une factorisation mal posée.

---

## 6. AutonomyMandate — garde-fous obligatoires

Tout mandat d'autonomie (`AutonomyMandate`) doit définir au minimum :

| Champ | Description |
|---|---|
| `maxPositionSizePct` | Taille max d'une position en % du portefeuille |
| `maxSingleTradePct` | Taille max d'une transaction unique en % du portefeuille |
| `maxDailyTradePct` | Volume max journalier en % du portefeuille |
| `allowedAssetClasses` | Classes d'actifs autorisées (whitelist) |
| `forbiddenTickers` | Tickers/ISINs interdits (blacklist explicite) |
| `requiresHumanAbovePct` | Seuil au-delà duquel validation humaine obligatoire |
| `stopLossTriggerPct` | Drawdown du portefeuille déclenchant suspension automatique |
| `expiresAt` | Date d'expiration du mandat (obligatoire, pas de mandat permanent) |
| `killSwitchActive` | Suspension immédiate de toute autonomie |

Un mandat expiré ou avec `killSwitchActive = true` interdit toute exécution autonome, sans exception.

---

## 6 bis. OperatingTempo & mode hyper-trading personnel

`OperatingTempo` est une **dimension orthogonale** au `DelegationMode`. Elle gouverne **la cadence** (à quelle fréquence SmartVest analyse, propose, et le cas échéant exécute), pas **qui agit**. Le `DelegationMode` reste seul responsable de l'autonomie d'action.

### Tempos disponibles

| Tempo | Cadence indicative | Usage |
|---|---|---|
| `LONG_HORIZON` (défaut) | analyse quotidienne | buy-and-hold, pilotage long terme |
| `ACTIVE` | analyse horaire | swing trading personnel |
| `HYPER_ACTIVE` | analyse toutes les 5 min | mode personnel très intensif, opt-in strict |

### Mode hyper-trading personnel — règles immuables

- **Strictement opt-in.** Aucun profil n'existe par défaut. La configuration crée un profil en statut `draft` ; l'activation est un acte explicite.
- **Renforce — ne relâche jamais — les garde-fous existants.** À l'évaluation, le runtime prend la valeur la plus stricte entre `MandateGuardrail` et `HyperTradingGuardrail`.
- **Kill-switch en un clic.** Le bouton kill-switch n'est jamais gaté par un feature flag. Sa réactivation requiert une réactivation explicite.
- **Expire obligatoirement.** Pas de profil hyper-trading permanent. Le champ `expiresAt` est obligatoire.
- **Ne crée AUCUNE exécution implicite.** Le `HyperTradingPolicyEngine` retourne `allow | block | require_review | kill_switch` — jamais `execute`. L'exécution réelle reste conditionnée par `AUTONOMOUS_GUARDED` + mandat valide + `BROKER_EXECUTION_ENABLED` + `HYPER_TRADING_EXECUTION_ENABLED`.
- **Audit hash-chaîné.** Toute transition (`profile_activated`, `profile_paused`, `profile_killed`, `guardrail_updated`, `guardrail_violation_blocked`, `kill_switch_armed`…) écrit un événement `hyper_trading_audit_events`.

### Garde-fous obligatoires (`HyperTradingGuardrail`)

Champs runtime-checkés par le `HyperTradingPolicyEngine` à chaque évaluation :

- `maxTradesPerDay`, `cooldownMinutesBetweenTrades`, `reviewEveryNMinutes`
- `maxNotionalPerTradePct`, `maxDailyNotionalPct`, `maxExposurePerInstrumentPct`, `maxExposurePerAssetClassPct`, `maxExposurePerSectorPct`
- `maxOpenPositions`
- `maxDailyLossPct`, `maxIntradayDrawdownPct`, `mandatoryStopLossPct` (obligatoire), `optionalTakeProfitPct`
- `maximumAllowedSpreadBps`, `maximumAllowedSlippageBps`, `minimumExpectedLiquidityAbs`, `maxAcceptableVolatilityPct`
- `allowedAssetClasses` (whitelist), `deniedTickers` (blacklist explicite)
- `requiredHumanApprovalAboveAbs`
- `killSwitchOnAbnormalLoss`, `killSwitchOnDataProviderFailure`, `killSwitchOnBrokerSyncMismatch`, `killSwitchOnVolatilityShock`

### Matrice de compatibilité `DelegationMode × HYPER_ACTIVE`

| DelegationMode | + HYPER_ACTIVE | Comportement |
|---|---|---|
| `MANUAL_EXPLICIT` | autorisé | Analyse haute fréquence + suggestions denses, aucune action sans clic utilisateur. Cas par défaut. |
| `HYBRID_SUGGESTIVE` | autorisé | Suggestions très fréquentes, validation utilisateur explicite par action. |
| `AUTONOMOUS_GUARDED` | autorisé **uniquement avec mandat valide ET garde-fous renforcés**. Tout `kill_switch` se propage immédiatement au mandat sous-jacent. |

### Feature flags

| Flag | Rôle | Défaut |
|---|---|---|
| `HYPER_TRADING_MODE_ENABLED` | Master gate (concept exposé côté API) | `false` |
| `HYPER_TRADING_UI_ENABLED` | Affichage des écrans de configuration | `false` |
| `HYPER_TRADING_RUNTIME_ENABLED` | Moteur d'évaluation actif | `false` |
| `HYPER_TRADING_EXECUTION_ENABLED` | Autorise l'exécution réelle, en sus de `BROKER_EXECUTION_ENABLED` + `AUTONOMOUS_GUARDED` + mandat valide | `false` |

Activer `HYPER_TRADING_EXECUTION_ENABLED` ne suffit jamais seul à exécuter — toutes les conditions de garde-fou doivent être réunies.

### Mode sniper — surcouche personnelle minimale

Surcouche indépendante du mode hyper-trading, pensée pour un usage strictement personnel et réversible.

- **Déverrouillage par code local.** `SNIPER_MODE_UNLOCK_CODE` est défini côté serveur uniquement. Sans code configuré, `/sniper/unlock` répond `400`.
- **TTL obligatoire.** Chaque session expire automatiquement (par défaut 15 min, max 240 min). Pas de session permanente.
- **Une seule session active à la fois** par utilisateur (contrainte DB).
- **Désactivation immédiate** jamais gatée par un feature flag — le bouton reste toujours disponible.
- **`PersonalOverrideMode`** dérivé en lecture seule : `STANDARD` / `SNIPER_LOCKED` / `SNIPER_ACTIVE`.
- **La table `sniper_sessions` est l'audit.** Chaque déverrouillage insère une ligne ; les terminaisons (`expired`, `revoked`) mettent à jour le statut + timestamps. Aucune table séparée.
- **Ne contourne JAMAIS** `checkMandatePermission()`, le kill-switch global, ni les garde-fous d'un `AutonomyMandate`. Aucun chemin d'exécution réelle n'est introduit.
- Les autres modules peuvent lire `SniperService.isActive(userId)` pour ajuster leur cadence (fréquence d'analyse, fraîcheur des suggestions, etc.) — jamais pour contourner une vérification.

| Flag | Rôle | Défaut |
|---|---|---|
| `SNIPER_MODE_ENABLED` | Master gate ; sans ce flag `/sniper/unlock` renvoie 403 | `false` |
| `SNIPER_MODE_UI_ENABLED` | Rend visible l'écran `/settings/sniper` | `false` |

### Wording

- Préférer : « mode opératoire actif », « cadence haute intensité », « garde-fous renforcés », « pause immédiate disponible ».
- Interdire : « gains rapides », « mode turbo », « booster », « battre le marché », « autopilot profits ».

---

## 7. Frictions d'intermédiation — à rendre visibles

Le moteur de coût (`@smartvest/cost-engine`) ventile chaque transaction :

- `brokerFee` : frais fixe + % du notionnel (borné min/max).
- `spreadCost` : écart spread vs mid-price.
- `slippageCost` : écart prix d'exécution vs benchmark annoncé.
- `fxMarkup` : marge appliquée sur le change (en % du notionnel).
- `taxes` : TTF, stamp duty, etc.
- `netAmount` : coût total pour l'utilisateur.

L'UI doit toujours pouvoir présenter cette ventilation si l'utilisateur clique "détail" sur une transaction.

---

## 8. Dev workflow

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

## 9. Hors scope (exécution réelle)

- Exécution réelle d'ordres sans `AUTONOMOUS_GUARDED` activé et mandat valide.
- Recommandations personnalisées basées sur la situation patrimoniale complète (sens MiFID).
- Données de marché temps réel (delayed uniquement).
- Mobile natif (responsive web suffit).
- Multi-utilisateurs / collaboration.

---

## 10. Points à faire valider par un expert juridique (pas par Claude)

- Statut exact selon les modes activés (CIF, RTO, PSI, PSAN si crypto).
- CGU et politique de confidentialité (RGPD + DSP2 éventuel).
- Wording des disclaimers en production publique.
- Qualification juridique du mode `AUTONOMOUS_GUARDED` (mandat de gestion ? RTO ?).
- Règles MiCA si support crypto étendu.
- Règles fiscales affichées (PEA, flat tax, etc.).

Claude peut repérer les zones sensibles via la skill `mapping-fintech-compliance`, mais **ne rédige pas d'avis juridique définitif**.
