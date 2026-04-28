# CLAUDE.md — SmartVest

Guide de travail pour Claude Code sur ce repo.
**À lire avant toute modification non triviale.**

---

## RÈGLE OPÉRATIONNELLE — MODES OPÉRATOIRES (3) — P7

P7 introduit un toggle 3-modes opératoires en haut de `/lisa`. La source
de vérité est `lisa_session_configs.strategy_mode` (migration 0085) :

| Mode | Pipeline | Profile | Discipline | Stops | Cadence | Quand l'utiliser |
|---|---|---|---|---|---|---|
| 📈 `investment` | Lisa LLM | `long_term_investor` | `NONE` | larges (4%) | 60 min | buy-and-hold patient, long horizon |
| 🌾 `harvest` | Lisa LLM | `hyper_active` | `DAILY_HARVEST` | serrés (1.5%) | 7 min | scalping intraday, sweep auto vers vault |
| 🚀 `gainers` | Scanner momentum déterministe (bypass LLM) | inchangé | inchangé | 1.5% / TP 3% (paper-broker) | cron 15 min 24/7 | momentum cross-asset US/EU/Asia + crypto majors |

**Endpoints** :
- `GET /lisa/mode/:portfolioId` → `{ mode }`
- `POST /lisa/mode/:portfolioId` body `{ mode, reason? }` → applique preset + écrit audit `mode_change_log`
- `GET /lisa/gainers-status/:portfolioId` → countdown + open/max + session pnl + 3 derniers candidats (poll 30s)

**Garde-fou capital** : passage en `gainers` exige `capital_usd ≥ $1000` (sinon `400 BadRequestException`). Les bascules `investment`↔`harvest` sans contrainte capital.

**Side-effects par mode** :
- `investment` / `harvest` → `MacroModeService.applyMacroMode()` (preset complet : profile, capital_discipline_mode, risk_constraints, autopilot_aggressive, cycle_minutes) + `strategy_mode` écrit
- `gainers` → écrit uniquement `strategy_mode='gainers'` + `autopilot_enabled=true` + `kill_switch_active=false`. **Ne touche pas** au profile / capital_discipline_mode → revenir à investment/harvest restaure la config précédente sans perte.

**Toggle scanner sans redeploy** : `TopGainersScannerService.runScannerInner()` lit en priorité les portfolios avec `strategy_mode='gainers'` (toggle UI). L'env `STRATEGY_MODE=top_gainers` reste comme fallback global pour back-compat (s'applique uniquement si aucun portfolio n'est en gainers DB-side). Le toggle UI est immédiat au cycle suivant.

**Audit** : chaque bascule écrit une ligne `mode_change_log` (old_mode, new_mode, capital_usd, user_agent, reason) — RLS user-scoped pour SELECT.

---

## RÈGLE OPÉRATIONNELLE — CONFIG LISA P3-D

P3-D — correctifs config issus de l'analyse logs 27-28/04 :

- **Profile par défaut : `active_trading`** (cycle 30 min). `hyper_active`
  (cycle 7 min) reste autorisé **uniquement** quand
  `capital_discipline_mode = 'DAILY_HARVEST'` (scalping intraday volontaire).
- **`maxOpenPositions` default = 3** (anti-dilution). Aligné avec
  `MAX_CONCURRENT_REBOUND_POSITIONS=3`.
- **`maxExposurePerAssetClassPct` default = 40%** (déjà le cas dans
  `types/index.ts`, migration 0080 corrige les rows < 40 historiques).
- **Crypto exclu du scanner rebound-tp** (volatilité incompatible avec
  stop -4%). Lisa peut proposer BTC/ETH en thesis classique (catégorie
  `crypto`) — mais jamais via le scanner watchlist `sp500`.
- **Plafond retail social 30%** dans le briefing news (StockTwits + Reddit
  + Twitter combinés ≤ 30% des items envoyés à Lisa). EODHD tier 1
  (Reuters/Bloomberg/MarketWatch) reste prioritaire. Cf.
  `capRetailSocialItems` dans `news-aggregator.service.ts`.
- **Persona bloc 08-rebound-priority** ajouté au system prompt cacheable :
  Lisa doit prioriser les signaux `rebound_open_positions` sur les
  thèses narratives. Conviction ≥ 8 + catalyseur structurant requis
  pour proposer une thèse "narrative" hors scanner.

---

## RÈGLE OPÉRATIONNELLE — MODE HARVEST = REBOUND-ONLY (P4-B)

P4-B — En mode `capital_discipline_mode = 'DAILY_HARVEST'`, le pipeline
proposal court-circuite la news-aggregation et n'expose à Lisa que les
sources compatibles avec un horizon de scalping intraday :

| Mode | Sources actives |
|---|---|
| `DAILY_HARVEST` (TP 2.5% / SL 1.5%) | `rebound_tp_scanner` + `mechanical_stops` |
| `NONE` / `INVESTMENT` | `rebound_tp_scanner` + `momentum_breakout` + `narrative_stocktwits` + `sentiment_macro` + `mechanical_stops` |

Justification : narrative StockTwits / momentum breakout / sentiment macro
ont un horizon 1-4 semaines. Un stop -1.5% les ferme avant que le
catalyseur n'ait eu le temps de jouer → 40% proposal_failed observés
27-28/04. En harvest, on les exclut totalement.

**Implémentation** : `getProposalSources(mode)` + `shouldRunNewsAggregator(mode)`
dans `packages/ai-analyst/src/strategies/proposal-source-routing.ts`.
Le caller (`LisaService.generateProposal`) skip `newsAggregator.aggregate`
quand mode harvest + écrit `lisa_decision_log` kind=`news_aggregator_skipped_harvest_mode`
pour audit.

**Effets attendus** : ~600ms latence économisée par cycle, 4 calls API
news skip, biais narratif retail muté. Lisa reçoit alors uniquement le
bloc `## Positions rebound ouvertes` + indicateurs macro + tactical
regime → décisions purement mécaniques.

---

## RÈGLE OPÉRATIONNELLE — COUVERTURE H24 MULTI-BOURSES (P4-A)

P4-A — Le scanner rebound-tp couvre 5 bourses pour atteindre la couverture H24 :

| Bourse | Code | Suffixe | Session UTC | CEST été |
|---|---|---|---|---|
| Nikkei 225 | TSE | `.T` | 00:00-06:00 | 02:00-08:00 |
| Hang Seng | HKEX | `.HK` | 01:30-08:00 | 03:30-10:00 |
| CAC 40 | EURONEXT | `.PA` | 07:00-15:30 | 09:00-17:30 |
| DAX 40 | XETRA | `.DE` | 07:00-15:30 | 09:00-17:30 |
| FTSE 100 | LSE | `.L` | 08:00-16:30 | 10:00-18:30 |
| S&P 500 | NYSE | `.US` | 14:30-21:00 | 16:30-23:00 |

**Mode H24** (`OhlcvCacheService.getActiveUniverse(now)`) :
- Si `REBOUND_UNIVERSE` env set : behaviour P3-C (single watchlist par nom)
- Sinon : aggrège TOUTES les watchlists dont `[session_open_utc, session_close_utc]` inclut `now` UTC
- Fallback `sp500` (after-hours US) si rien actif

**Source de vérité TS** : `packages/ai-analyst/src/strategies/universes.ts` pour US, mais les watchlists multi-exchange sont **uniquement en DB** (table `watchlist_universe` + migration 0081). Sync manuel TS à éviter pour ces univers — la table est l'autorité.

**Crypto exclu** : aucune watchlist multi-exchange ne contient de crypto. Lisa peut toujours proposer BTC/ETH en thesis classique.

**Coût EODHD** : EODHD plan US-only ne couvre PAS `.PA/.DE/.L/.T/.HK`. Vérifier l'abonnement (« All World » ou « Fundamentals + EOD All World ») avant d'activer le mode H24 en prod. Sans ce plan, le fetch retourne 404 et le scanner skip silencieusement → pas de crash mais pas de signaux non-US.

**Sector cap** : actuellement global (`assets.sector` lookup). Cap par exchange = follow-up P4-B (assets.sector ne distingue pas la bourse).

---

## RÈGLE OPÉRATIONNELLE — UNIVERS WATCHLIST PAR DÉFAUT

P3-C — Le scanner rebound-tp scanne par défaut **`sp500`** (~200 mega-caps US, table `watchlist_universe`). Override possible :

- env `REBOUND_UNIVERSE=sp500|nasdaq100|mega12` → choix de la watchlist nommée
- env `REBOUND_WATCHLIST=A.US,B.US,...` → CSV ad hoc, override la table

**Source de vérité TS** : `packages/ai-analyst/src/strategies/universes.ts` (`SP500_UNIVERSE`, `NASDAQ100_UNIVERSE`, `MEGA12_UNIVERSE`). À chaque update du fichier TS, **synchroniser manuellement** la migration corrective sur `watchlist_universe` (sinon DB et TS divergent silencieusement).

**Fallback** : si la DB est inaccessible, le scanner tombe sur `mega12` (12 tickers, le plus conservateur côté coût EODHD) — pas sur les listes étendues, pour éviter saturer EODHD pendant un incident DB.

**OHLCV cache** : table `ohlcv_cache_daily` populée par `OhlcvCacheService` cron 21:30 UTC lun-ven. Le scanner phase 1 lit ce cache (RSI pré-filter, ~30-50 candidats sur 500), phase 2 fetch live uniquement les candidats. Coût EODHD : ~30 fetches/tick au lieu de 500 = **×16 économie**.

**Sector cap** : `REBOUND_SECTOR_CAP_PCT` (default 20%). Avec `MAX_CONCURRENT=5`, max 1 position par secteur. Lookup via `assets.sector` (champ existant ; `assets.industry` n'existe pas dans le schéma actuel — ne pas le référencer).

---

## RÈGLE OPÉRATIONNELLE PERMANENTE — AUTO-MERGE SUR MAIN

Pour TOUTE PR que tu ouvres sur ce repo :

1. **Tu DOIS auto-merger immédiatement sur `main`** dès que :
   - CI typecheck (TypeScript build) ✅ vert
   - CI Jest unit tests ✅ vert
   - Pas de conflit avec `main`

2. **N'attends JAMAIS** :
   - validation humaine
   - review Vercel preview
   - confirmation utilisateur
   - feedback approbation

3. **Workflow obligatoire** : poll CI status toutes les 30s → dès 4 checks verts → `gh pr merge --squash --auto --delete-branch` ou équivalent UI → enchainer ticket suivant sans pause.

4. Si CI fail : hotfix dans la même branche, push, repoll. Pas de question à l'utilisateur.

5. Cette règle s'applique à TOUS les tickets P0/P1/P2/P3 et au-delà jusqu'à instruction écrite contraire de l'utilisateur dans la session.

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

## 6 ter. Broker Connections — connexions personnelles aux brokers

Connexion lecture-seule aux comptes brokers personnels. **Ne change rien** aux règles d'exécution de la Section 2 : un broker connecté n'ouvre aucun droit d'exécution réelle.

### Règles immuables

- **Credentials en Supabase Vault uniquement.** Jamais en ligne DB en clair, jamais en logs (même pas le nom du champ), jamais dans une réponse API. Le row `broker_connections` n'expose que `credentials_vault_ref` (un UUID opaque).
- **Exposition contrôlée côté API.** `GET /brokers/connections[/:id]` fait un `SELECT` avec liste explicite de colonnes qui **exclut** `credentials_vault_ref`. Aucun endpoint ne retourne les credentials.
- **Rotation = création d'un nouveau secret + suppression de l'ancien.** L'ancien ref n'est supprimé qu'après commit du nouveau en DB (pas d'atomicité impossible sur un seul RPC).
- **Révocation toujours accessible.** `DELETE /brokers/connections/:id` n'est **jamais** gaté par un feature flag — safety wins. Supprime le secret du Vault + marque `revoked`.
- **DeGiro ne scrape pas.** Pas d'API officielle → l'adapter `DegiroAdapter` rejette toute méthode live et pointe vers `/imports` (parser CSV déjà livré). Idem pour Bourse Direct / Fortuneo.

### Chaîne de garde-fous pour l'exécution réelle (à venir)

L'exécution réelle nécessite **toutes** les conditions réunies — aucune à elle seule n'est suffisante :

1. `DELEGATION_AUTONOMOUS_GUARDED=true`
2. `AutonomyMandate` actif + `checkMandatePermission() === null`
3. `BROKER_EXECUTION_ENABLED=true`
4. `BROKER_ADAPTER_<X>_ENABLED=true` pour le provider concerné
5. `AUTONOMY_KILL_SWITCH=false`
6. Si profil hyper-trading actif → `HyperTradingGuardrail` respectés, `HYPER_TRADING_EXECUTION_ENABLED=true`
7. `BrokerSyncService` ne trouve pas de conflit avec le kill-switch global

Dans ce commit, la méthode `placeOrder()` de chaque adapter **refuse toujours** (throw `NotSupportedError`), même si tous les flags ci-dessus sont on. L'exécution réelle sera ajoutée dans un commit dédié avec tests sur credentials live.

### Kill-switch et mandat propagent sur la sync

- `AUTONOMY_KILL_SWITCH=true` → toute nouvelle sync est immédiatement annulée (`sync_cancelled_by_kill_switch`), audit écrit.
- Mandat invalide en cours de sync : vérifié au démarrage du job uniquement dans ce commit. Annulation mid-run = future improvement (streaming nécessaire).
- `broker_sync_audit_events.kind` comprend `sync_cancelled_by_kill_switch` et `sync_cancelled_by_mandate` pour tracer ces cas.

### Provider capabilities (matrice)

| Provider | read | execution | streaming | options | crypto | csv |
|---|---|---|---|---|---|---|
| `INTERACTIVE_BROKERS` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `SAXO` | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ |
| `TRADING212` | ✅ | ✅ | ❌ | ❌ | ❌ | ✅ |
| `DEGIRO` | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| `BOURSE_DIRECT` | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| `FORTUNEO` | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| `MANUAL` | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |

Les flags `supports_*` sur la ligne `broker_connections` sont dérivés de `PROVIDER_CAPABILITIES` à la création. Ils décrivent ce que le provider **peut** faire, pas ce qui est **activé** (feature flags orthogonaux).

---

## 6 quater. Données macro EODHD — cascade & qualité tracée

Lisa raisonne sur un `MarketSnapshot` produit par `LisaService.fetchMarketSnapshot()`. Plusieurs tickers EODHD historiques sont **cassés** (HTTP 404 ou `empty_price_field`). Sans précaution, Lisa reçoit silencieusement des fallbacks hardcoded à chaque cycle et raisonne sur une photo statique.

### Règle immuable — cascade obligatoire pour tout indicateur macro

Tout ajout d'indicateur dans `fetchMarketSnapshot` doit passer par `fetchCascade(indicator, attempts[])` :

1. **Tentatives ordonnées** live → proxy ETF → fallback hardcoded (dernier recours).
2. Chaque tentative est typée `quality: 'live' | 'proxy'` ; le fallback bascule automatiquement dans `dataQuality.fallback`.
3. Un proxy ETF peut porter un `multiplier` (ex : `UUP.US × 4.1` ≈ DXY, `GLD.US × 10` ≈ Gold).
4. Toute valeur retournée alimente `MarketSnapshot.dataQuality = { live, proxy, fallback }`.

### Mapping de référence (ne pas régresser)

| Indicateur | Live primary | Proxy ETF | Multiplier |
|---|---|---|---|
| VIX | `VIX.INDX` | `VXX.US` | — |
| DXY | `DXY.INDX` puis `USDX.INDX` | `UUP.US` | × 4.1 |
| US10Y | `TNX.INDX` | — | — |
| US2Y | `IRX.INDX` | — | — |
| Brent | `BRENT.COMM` | `USO.US` | × 1.05 |
| Gold | `XAUUSD.FOREX` | `GLD.US` | × 10 |
| Silver | `XAGUSD.FOREX` | `SLV.US` | — |
| HY OAS | — | `HYG.US` | linéaire (cf. ci-dessous) |
| IG OAS | — | `LQD.US` | linéaire (cf. ci-dessous) |

**Credit OAS — proxy linéaire ETF** : `HY OAS ≈ 320 - (HYG/78 - 1) × 100 × 30` clampé `[80, 1500]bps` ; `IG OAS ≈ 95 - (LQD/108 - 1) × 100 × 30` clampé `[30, 800]bps`. Sensibilité ~30bps par 1 % de variation de prix (approximation grossière, pas vraie OAS calc). Direction fiable, niveau ±15-25 %. À recalibrer si baseline ETF dérive durablement.

Tickers à **ne jamais utiliser** (cassés EODHD côté plan actuel) : `^VIX.INDX`, `DX-Y.NYB.FOREX`, `US10Y.BOND`, `US2Y.BOND`, `GC.COMM`, `SI.COMM`, `BZ.COMM`, `NG.COMM`, `HG.COMM`.

### Bloc `## DATA QUALITY` dans le briefing

Si `dataQuality.proxy` ou `dataQuality.fallback` n'est pas vide, `formatDataQualityBlock` injecte un bloc explicite dans le user message. Lisa doit alors :

- citer la dégradation dans `[DIAGNOSTIC]` ;
- éviter de fonder un changement de régime sur un indicateur en `fallback` ;
- privilégier l'analyse bottom-up (technique, news, options flow) si ≥ 3 indicateurs en fallback.

### Règle de comportement HORS_TRAJECTOIRE

`trajectoryStatus = 'HORS_TRAJECTOIRE'` (réalisé négatif OU coûts > 50 % des gains 7 j) déclenche un protocole **STOP + DIAGNOSTIC** non négociable :

1. Lisa renvoie `theses=[]` ce cycle (toute nouvelle ouverture aggrave le saignement).
2. `[DIAGNOSTIC]` documente la cause racine (sur-trading ? thèses sans catalyseur ? régime macro défavorable ? données macro dégradées ?).
3. Sur position ouverte avec setup cassé → propose `close_now` dans `special_actions`.
4. Le mécanique (`mechanical-trading.service.ts`) refuse déjà toute nouvelle ouverture sur ce statut — la persona doit rester alignée.

Tout wording du type "HORS_TRAJECTOIRE n'est PAS un signal de retrait" est **interdit** dans la persona — il a causé la stagnation 13-cycles d'avril 2026.

### Cron `mechanical-trading` & flag `autopilot_market_hours_only`

Le cron `MechanicalTradingService.runMechanicalCycle` tourne **toutes les 60 sec, indépendamment du cycle Lisa** (qui tourne toutes les 5-20 min). Il pilote les Steps 0-3 :

- Steps 0-2 (drawdown guard, autonomy rules, agent-Lisa sync, closes Lisa, **stop-loss & take-profit**) tournent **H24 sans condition**.
- Step 3 (ouverture de nouvelles positions par Lisa) est gaté par le flag `autopilot_market_hours_only` via `skipNewOpens`.

Règle immuable : **les vérifications de stops, take-profit absolu, trailing stops et autonomy rules doivent toujours tourner**, même hors heures de marché. Toute régression qui re-couplerait `autopilot_market_hours_only` au skip total du cycle (cf. bug avr 2026, ligne `if (cfg.autopilot_market_hours_only && !inMarketHours) continue;`) crée un trou de protection 11 h/jour sur les positions crypto (24/7).

### Sensibilité des wake-up Tier 1 — `AgentLisaSyncService.evaluateTriggers`

Les triggers Tier 1 (VIX, drawdown portefeuille, position pnl) ont des seuils calibrés pour swing trading par défaut :

| Trigger | Seuil `standard` | Seuil `harvest_hyper` |
|---|---|---|
| VIX spike | > 30 | > 22 |
| Drawdown intraday | > 0.8 % | > 0.4 % |
| Position pnl | < −3 % | < −1.5 % |

Le profil `harvest_hyper` est activé automatiquement quand `capital_discipline_mode = 'DAILY_HARVEST'` ET `profile = 'hyper_active'` — mode scalping où une position à −3 % a déjà dépassé son stop. Tout nouveau trigger Tier 1 doit prévoir ces deux jeux de seuils.

### Bypass HORS_TRAJECTOIRE après gel prolongé

Le protocole STOP+DIAGNOSTIC strict peut créer un deadlock si Lisa renvoie `theses=[]` plusieurs cycles consécutifs et que les positions ouvertes stagnent. Soupape :

- **Côté mécanique** : si `consecutiveZeroOpens >= 30` cycles (= 30 min) ET `directive.trajectoryStatus = 'HORS_TRAJECTOIRE'` ET `directive.targetSymbols.length >= 1` → bypass autorisé, Step 3 débloqué pour 1 ouverture max. Tracé via `kind: 'autopilot_cycle_completed'` payload `[HT_BYPASS]`.
- **Côté persona Lisa** (`golden-trader.ts`) : autorisée à proposer **1 thèse exception** si sa mémoire montre plusieurs cycles `theses=[]` ET setup A+ (conviction ≥ 8, R/R ≥ 3, catalyseur news score ≥ 75 fraîche < 2 h) ET sizing ≤ 60 % du standard. Doit citer explicitement « HT-EXCEPTION » en `[DIAGNOSTIC]`.

C'est une **porte de sortie de deadlock**, pas un retour au business as usual. Si Lisa l'utilise sans setup A+ vérifiable, c'est un bug de discipline à corriger côté persona.

### Close réactif sur news contraires (`checkNewsShockClose`)

Mécanisme indépendant de Lisa : ferme une position long avant que Lisa ait le temps de réagir, si une news shock matche les critères stricts :

- Position **long** uniquement
- News tag explicite sur le ticker tenu (`💼SYMBOL`) — pas de match macro/secteur (trop bruyant)
- `sentiment ≤ -0.6` ET `age < 30 min` ET `position open ≥ 5 min`
- Prix live non-fallback (sinon close annulé)

Tracé comme `closed_invalidated` dans `lisa_positions`, decision_log enrichi du sentiment et du titre. Critères stricts pour éviter de tordre une thèse encore valide à cause d'une news bruyante.

### Garde-fous prix fallback — règles immuables

Tout consumer de `LisaService.getLivePrice()` doit traiter le champ `source` comme **autorité** sur la fiabilité, en plus du prix lui-même :

1. **`getFallbackPrice(symbol)` retourne `null`** quand le symbole n'est pas dans la table de fallback statique. Tout caller qui reçoit `null` doit traiter comme « pas de prix disponible ». Anti-pattern interdit : retourner $100 par défaut (incident 27/04/2026 — LMT $513 → $100 → stop trigger fake → liquidation -80 %).
2. **`source = 'fallback_unknown'`** signale ce cas. Sentinel price `'0'`. Aucune action destructive (close, stop, take-profit) ne doit jamais être prise sur ce source.
3. **`isFallbackSource(source)`** doit catcher tout préfixe `fallback*` (incluant `fallback_unknown`, `fallback_quota_cap`).
4. **Sanity bound 30 %** dans `checkStopTarget` : tout prix divergeant > 30 % de l'entry en un seul tick est skippé avec log `[SANITY_BOUND]`. Une variation > 30 % en 60 s sur un actif liquide est presque toujours une corruption (cache pollué, parser glitch, source aberrante non taggée fallback). Cette double protection est nécessaire — ne pas la retirer sous prétexte qu'elle « bloque » un vrai mouvement violent ; un vrai krash sera capté au tick suivant.

Tout nouveau symbole pertinent (LMT, NOC, GD, etc.) doit être ajouté à la table `getFallbackPrice` avec une valeur réaliste pour éviter de bloquer la simulation pendant une indisponibilité EODHD.

### Daily Harvest accounting — resync depuis `lisa_positions` (pas d'incrémentation)

Les métriques de session Harvest (`realized_pnl_today_usd`, `trades_count`, `winning/losing_trades_count`) **ne sont PAS incrémentées** au close — elles sont **dérivées** par `DailySessionService.resyncSessionFromPositions()` à chaque appel de `onTradeClosed`. Source unique de vérité : la table `lisa_positions` (positions fermées sur la journée UTC).

Pourquoi : un hook `onTradeClosed` qui silently échoue (fire-and-forget swallowed) provoquait un drift permanent entre l'UI Harvest et la réalité du portfolio (incident 27/04/2026 — LMT close raté, Harvest affichait −$0.91 alors que portfolio réel −$1450).

Règle immuable : tout nouveau champ de session aggregé (somme/count) doit être recalculé dans `resyncSessionFromPositions`, pas incrémenté à la volée. Tout échec du hook `onTradeClosed` se logge en `error` (pas `debug`/`warn`) pour qu'il soit visible.

### `resetSimulation` — efface TOUTES les tables d'état

`LisaService.resetSimulation()` doit effacer **toutes** les tables qui portent un état du portfolio. Incident 27/04/2026 : l'ancien reset oubliait `daily_trading_sessions` et `secured_profit_balance` → l'UI Harvest gardait −$0.91 et vault $7.09 même après reset → utilisateur voyait des données fantômes sur un capital propre.

Liste actuelle (à étendre dès qu'une nouvelle table porte de l'état) :

- `lisa_positions`
- `lisa_portfolio_snapshots`
- `lisa_decision_log`
- `lisa_proposals`
- `daily_trading_sessions`
- `secured_profit_balance`
- `lisa_mechanical_directives`
- `lisa_mechanical_cycle_summary`

Et lève `kill_switch_active = false` sur `lisa_session_configs`. Toute nouvelle table d'état d'un portfolio (compteurs, vaults, sessions, directives, audits scopés) doit être ajoutée à cette liste — sinon le reset laisse de la pollution UI.

### Filet de garantie autopilot — preset HARVEST = 7 min

Le filet de garantie (`autopilot_cycle_minutes`) force un cycle Lisa même si aucun event matériel n'est détecté. Clamp UI : 5-60 min, modifiable par utilisateur. Defaults par preset :

- Preset **INVESTMENT** : 60 min (passif, swing trading)
- Preset **HARVEST** : 7 min (réactif, scalping intraday)
- Aucun preset : 30 min (legacy)

Note coût : 7 min en HARVEST ≈ 8 cycles/h vs 3 cycles/h en INVESTMENT — coût LLM ~3× supérieur. À assumer en HARVEST où la cadence d'analyse compte plus que les frais marginaux. L'utilisateur reste maître via le champ UI ; le preset n'est qu'une suggestion sensée.

Toute régression qui imposerait un cap dur en HARVEST hyper-active doit être évitée — la modifiabilité du filet est un invariant.

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
