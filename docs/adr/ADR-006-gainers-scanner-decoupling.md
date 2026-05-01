# ADR-005 — Gainers Scanner Decoupling

- **Date** : 2026-05-01
- **Owner** : Yannick (yannicke819-max)
- **Status** : DRAFT — en attente validation utilisateur avant tout code
- **Sprint cible** : à définir (post Sprint 10)
- **Suit** : ADR-004 articulation Lisa V3 (qui a clarifié les frontières conceptuelles Lisa, mais sans extraction physique du scanner Gainers)
- **Lié** : audit du 2026-05-01 (couplage structurel Gainers ↔ Lisa documenté en session)

---

## 1. Contexte

Le scanner Gainers (mode `strategy_mode='gainers'`) est aujourd'hui implémenté dans `apps/api/src/modules/lisa/services/top-gainers-scanner.service.ts` (1502 lignes), c'est-à-dire **à l'intérieur du module Lisa**, et utilise `LisaService` pour ouvrir les positions :

```
TopGainersScannerService.openTopGainerPosition()
  → INSERT lisa_proposals (pseudo-proposal regime='momentum_top_gainers')
  → this.lisa.approveProposal(userId, proposalId)
       → LisaService applique cooldown / max_pos / cash buffer / fallback price
       → paperBroker.openPosition() effective
```

**3 niveaux de couplage actuels :**

1. **Physique** : le fichier vit dans `modules/lisa/services/`.
2. **DI** : `LisaService` et `DecisionLogService` sont injectés dans le constructeur.
3. **Chemin d'exécution** : le scanner ne place jamais une position directement — il **synthétise une fausse proposition Lisa** et délègue à `LisaService.approveProposal`.

Conséquence : modifier la logique d'ouverture Gainers (par ex. ajouter un override TP/SL spécifique au scanner) implique de modifier `LisaService.approveProposal` qui sert aussi le mode `investment` et `harvest`. Risque de régression croisée à chaque changement.

**Note opérationnelle** : `top_gainers_log` lui-même est écrit AVANT toute interaction Lisa (`runScannerInner` L450, juste après `selectTopGainers`). Le couplage Lisa concerne uniquement le chemin d'exécution. La phase scan/score/log est déjà découplée.

---

## 2. Problème

| # | Problème | Impact |
|---|---|---|
| 1 | Évolutions Gainers (TP/SL, scoring, persistence gates) traversent `LisaService` | Changement local Gainers ⇒ risque de régression sur `investment` / `harvest` |
| 2 | Le scanner crée des **lignes fictives dans `lisa_proposals`** uniquement pour réutiliser la pipeline Lisa | Pollution sémantique : `lisa_proposals` contient des entrées qui ne sont pas des thèses Lisa |
| 3 | Tests d'intégration Gainers doivent mocker LisaService entier | Surface de test démesurée ; difficile d'isoler la logique scanner |
| 4 | Reasoning : « Gainers ≠ Lisa » (déterministe vs LLM, intraday vs multi-jour, scalping vs thèses) | Le couplage actuel masque cette distinction conceptuelle |
| 5 | Discoverability : un nouveau dev cherche `apps/api/src/modules/scanner/` → introuvable | Friction onboarding, méprise sur le périmètre Lisa |

---

## 3. Décision proposée

Extraire le scanner Gainers dans un module dédié `gainers-scanner/`, avec **un chemin d'exécution propre** qui ne passe plus par `LisaService.approveProposal`. Les règles risk communes (cooldown, max_pos, cash buffer, fallback price guard) sont extraites dans un service partagé `shared-risk/` réutilisé par Lisa ET Gainers.

```
apps/api/src/modules/
├── lisa/                      ← Lisa LLM, news, regime detection — inchangé
│   └── services/
│       └── lisa.service.ts    ← approveProposal continue de servir investment/harvest
├── gainers-scanner/           ← NOUVEAU module
│   ├── gainers-scanner.module.ts
│   ├── services/
│   │   ├── gainers-scanner.service.ts    ← fetch → score → INSERT top_gainers_log (PUR)
│   │   ├── gainers-executor.service.ts   ← lit top_gainers_log → ouvre via shared-risk
│   │   └── gainers-config.service.ts     ← read/write lisa_session_configs.gainers_*
│   └── __tests__/
└── shared-risk/               ← NOUVEAU service partagé
    ├── shared-risk.module.ts
    └── services/
        ├── cooldown.service.ts            ← extrait depuis Lisa
        ├── position-cap.service.ts        ← max_open_positions
        ├── cash-buffer.service.ts         ← min cash reserve
        └── fallback-price-guard.service.ts ← P19v sanity bound + fallback detection
```

**Interface :**
- `GainersScannerService.runCycle()` → fetch Binance + EODHD → `selectTopGainers` → `INSERT top_gainers_log` → ne connaît PAS Lisa
- `GainersExecutorService.executeFromLog(portfolioId)` → lit `top_gainers_log` non encore exécuté → applique `SharedRiskService.evaluate()` → appelle `paperBroker.openPosition()` directement → écrit `lisa_positions` + `paper_trades`
- Suppression du pseudo-INSERT dans `lisa_proposals`. Le scanner n'utilise plus la table proposals — c'est purement Lisa.

**Configuration** : les colonnes `gainers_*` restent dans `lisa_session_configs` (pas de migration de table requise dans ce PR). La justification : la config par-portfolio est globale et les modes `investment/harvest/gainers` partagent le même row. À long terme on pourra envisager une table `gainers_configs` séparée si la divergence augmente, mais pas dans cette extraction.

---

## 4. Alternatives écartées

### A) Status quo + commentaire explicite

Garder le scanner dans `lisa/services/` avec un README expliquant que c'est intentionnel.
**Rejeté** : ne résout aucun des 5 problèmes ci-dessus, juste les documente.

### B) Extraction physique seule (déplacer le fichier sans changer le chemin d'exécution)

Bouger `top-gainers-scanner.service.ts` dans `modules/scanner/` mais continuer à appeler `LisaService.approveProposal`.
**Rejeté** : résout #5 (discoverability) mais laisse #1, #2, #3, #4 intacts. Le couplage DI reste circulaire (`scanner → lisa`).

### C) Découplage complet AVEC migration de table

Extraire ET séparer la config dans une nouvelle table `gainers_session_configs`.
**Rejeté pour ce PR** : double la surface de migration et complique le rollback. À garder pour follow-up si la config diverge significativement (par ex. champs propres scanner non partagés).

### D) Plugin pattern (scanner = plugin de Lisa)

Garder Lisa comme orchestrateur central, scanner devient un plugin enregistré.
**Rejeté** : introduit une abstraction prématurée (CLAUDE.md §5 "Pas d'abstraction prématurée"). On n'a qu'un seul scanner type ; un plugin pattern coûte plus que la duplication actuelle.

---

## 5. Règles risk à extraire de Lisa vers `shared-risk/`

Inventaire des garde-fous présents dans `LisaService.approveProposal` qui s'appliquent identiquement à Gainers :

| Règle | Localisation actuelle | Comportement | Extraire ? |
|---|---|---|---|
| `cooldown 30min same symbol/side` | `top-gainers-scanner.service.ts:937-962` (déjà dupliqué) | Bloque ré-ouverture < 30min same key | ✅ Consolider en `CooldownService` |
| `max_open_positions` | `lisa.service.ts approveProposal` + scanner L876 (`maxOpen=3`) | Cap conservatif positions ouvertes | ✅ `PositionCapService.canOpen(portfolioId)` |
| `cash buffer` (min cash reserve %) | `lisa.service.ts` (vérif avant size) | Refuse si cash post-trade < threshold | ✅ `CashBufferService.canAllocate(portfolioId, amount)` |
| `fallback price guard` (P19v sanity bound) | `lisa.service.ts checkStopTarget` | Skip stops si prix > 30% écart en 1 tick | ✅ `FallbackPriceGuardService.isPriceTradeable(quote)` |
| `kill_switch_active` check | `runScannerInner` L399 + `approveProposal` | Hard stop tout autopilot | ✅ Garde dans `lisa_session_configs`, lecture par les deux modules |
| `MIN_NET_PROFIT_USD` (P19x.1) | `lisa.service.ts` close path | Bloque fake TP avec net négatif | ❌ Pertinent close, pas open — laisser dans Lisa close path |
| `expectancy watchdog E<0` (P19x.4) | `top-gainers-scanner.service.ts:792-855` | Soft-disable scanner si E<0 sur 10 derniers trades | ⚠️ Scanner-spécifique — laisser dans `gainers-scanner/` |
| `regime detection / news aggregator` | `lisa.service.ts` | Briefing LLM Lisa | ❌ Lisa-spécifique, jamais Gainers |
| `cooldown_minutes_between_trades` (hyper-trading) | `hyper-trading-policy-engine.ts` | Limite fréquence | ❌ Module hyper-trading, hors scope |

**4 services à créer dans `shared-risk/`** :
1. `CooldownService` — ré-entry guard par `(portfolioId, symbol, direction)`
2. `PositionCapService` — count vs `max_open_positions` config
3. `CashBufferService` — solde restant après hypothétique allocation
4. `FallbackPriceGuardService` — refus de toute action sur prix taggé fallback ou divergence > 30%

---

## 6. Plan de migration — 4 PRs atomiques

Découpage volontairement granulaire pour éviter le big-bang (CLAUDE.md règle implicite : pas de PR de 2000+ lignes). Chaque PR est mergeable indépendamment, le scanner reste fonctionnel à chaque étape.

### PR 1/4 — `feat/shared-risk-extract`

**Périmètre** : extraire les 4 services dans `shared-risk/`, exposer via module Nest, brancher Lisa pour utiliser ces services à la place de l'inline logic. **Aucun changement de comportement externe**.

- Créer `apps/api/src/modules/shared-risk/` avec module + 4 services
- Refactor `LisaService.approveProposal` pour appeler les services partagés
- Tests unitaires pour chaque service (>80% cov)
- Tests d'intégration : `approveProposal` se comporte exactement comme avant

**Validation** : tests Lisa existants passent sans modification + nouveaux tests `shared-risk/`.

### PR 2/4 — `feat/gainers-scanner-module-extract`

**Périmètre** : déplacer `top-gainers-scanner.service.ts` (et `multi-tf-persistence.service.ts`) du module `lisa/` vers le nouveau module `gainers-scanner/`. **Aucun changement de logique**.

- Créer `apps/api/src/modules/gainers-scanner/`
- `git mv` les 2 fichiers
- Update les imports cross-module
- Maintenir l'injection `LisaService` temporairement (PR 3 supprime)

**Validation** : tests existants passent inchangés. Le scanner continue d'appeler `lisa.approveProposal`.

### PR 3/4 — `feat/gainers-executor-direct-execution`

**Périmètre** : créer `GainersExecutorService` qui appelle `paperBroker.openPosition()` directement via `shared-risk/`, **derrière un feature flag** `GAINERS_DECOUPLED_EXECUTOR=true`. Permet rollout progressif et A/B comparison.

- `GainersExecutorService.executeFromLog()` qui ne crée plus de pseudo-proposal
- Code path conditional :
  ```ts
  if (config.gainersDecoupledExecutorEnabled) {
    return this.gainersExecutor.execute(portfolioId, candidate);
  }
  return this.lisa.approveProposal(userId, proposalId); // legacy
  ```
- Comparaison observable : decision_log enrichi de `executor_path: 'lisa'|'decoupled'`
- Tests : exécution decoupled produit le même résultat que via Lisa pour les cas standards

**Validation** : flag OFF par défaut. Activable par portfolio pour shadow-test 24h-48h en prod. Métriques : nb opens, fees moyens, % rejected by gates — comparées aux 2 paths.

### PR 4/4 — `feat/gainers-cleanup-flip-default`

**Périmètre** : flip le default à `true`, supprimer le code legacy après validation A/B.

- `GAINERS_DECOUPLED_EXECUTOR` default → `true`
- Suppression du chemin `lisa.approveProposal` dans `openTopGainerPosition`
- Suppression de l'INSERT pseudo-proposal dans `lisa_proposals`
- Suppression de l'injection `LisaService` du module `gainers-scanner/`
- Update CLAUDE.md règles opérationnelles

**Validation** : 7+ jours sur le path decoupled sans régression métrique. Si régression : revert simple en repassant le flag à `false`.

**Conditions de merge PR 4** :
- Aucun `lisa_proposals` regime=`momentum_top_gainers` créé en prod sur 7 jours
- `top_gainers_log → lisa_positions` ratio identique aux 7 jours pré-flip
- Aucun ticket utilisateur lié au mode gainers sur la période shadow

---

## 7. Risques

| # | Risque | Mitigation |
|---|---|---|
| R1 | Divergence subtile entre `lisa.approveProposal` et `gainers-executor` (gates manqués) | Feature flag PR 3 + comparison A/B sur 7+ jours, rollback trivial via flag |
| R2 | Tests Gainers existants reposent sur des mocks `LisaService` | PR 1 introduit les mocks `shared-risk` ; PR 3 réécrit les tests scanner pour pointer sur exécuteur direct |
| R3 | Ajout de modules Nest = risque circular dependency | Module `shared-risk/` exporte tout, `lisa/` et `gainers-scanner/` l'importent. Pas de référence inverse |
| R4 | `paperBroker` lui-même vit où ? | À vérifier en pré-PR 1 : si dans `lisa/services/`, le déplacer dans un module `paper-broker/` neutre (ou `shared-risk/`) avant PR 3 |
| R5 | La config `gainers_*` dans `lisa_session_configs` reste un couplage de schéma | Acceptable court terme. Migration vers table dédiée = follow-up si divergence augmente |
| R6 | `decision_log` partagé Lisa/Gainers | Inchangé : le log audit reste un canal commun. Pas un couplage applicatif |
| R7 | PR 4 supprime l'INSERT `lisa_proposals` → besoin de migration data ? | Non : les anciennes lignes restent en DB pour audit historique. Suppression du code d'écriture seulement |

---

## 8. Décisions à valider avant tout code

1. **Périmètre des shared-risk** : OK avec les 4 services listés en §5 ? Faut-il en ajouter / retirer ?
2. **`paperBroker`** : actuellement dans `lisa/`, le bouger ou pas ? (point R4)
3. **Feature flag** : `GAINERS_DECOUPLED_EXECUTOR` config DB par-portfolio OU env globale ?
4. **PR cadence** : 4 PRs atomiques en série OU peut-on paralléliser PR 1 et PR 2 ?
5. **Métriques A/B** : quelles métriques précises veux-tu suivre durant la fenêtre shadow PR 3 ?
6. **`expectancy watchdog`** : confirmer qu'il reste dans `gainers-scanner/` (non extrait shared-risk) ?

Aucun code n'est écrit tant que ces 6 points ne sont pas validés.
