# Brief Claude — Fix scanner SmartVest (Phase 3 bis)

**Contexte** : Phase 3 (shadow forward 14j) a été STOPPÉE le 12 mai 08:00 CEST. Phase 2b est INVALIDÉE. Le bucket « WR 71.9%, expectancy nette +0.73%, n=114 sur `path_eff<0.25` » est un mirage statistique : après déduplication par `(symbol, jour, entry_price)`, ce bucket tombe à **n=3 distincts**. Cause racine : le scanner persiste des doublons massifs en DB hors-RTH, et aucune contrainte UNIQUE ne l'empêche.

**Branche** : `feature/short-shadow-grids` (commit Fly actif `4c7b345`).
**Table** : `gainers_user_shadow_signals` (Supabase project `mfuutigfhrawccotinpo`).
**Portfolio** : `58439d86-3f20-4a60-82a4-307f3f252bc2`.
**Règles** : pas de PR, pas de push, pas de deploy, pas de secret tant que ce brief n'est pas validé point par point. Phase MESURE.

---

## TL;DR — SMOKING GUN trouvé

**Bug #1 a déjà un fix dans le code (PR #298), mais il est gardé par un feature flag env `SCANNER_SESSION_AWARE` qui n'est PAS défini dans `fly.toml`.** Conséquence : `sessionAware = false` en prod, le scanner skip la garde session, et continue à fetch les 9 EODHD screener à chaque cycle, week-end inclus, hors-RTH inclus, week-end inclus → poison des 148 lignes HRB et 87 ATEC dupliquées identiquement.

**Fix instantané** : ajouter `SCANNER_SESSION_AWARE = 'true'` dans `fly.toml` section `[env]`. **1 ligne**, redeploy, fin du bug #1.

Tout le reste (bug #6 UNIQUE en DB, bugs #4/#5 doc) est garde-fou et hygiène, pas urgent.

---

## Investigation détaillée — les 6 bugs après audit code

### Bug #1 — CRITIQUE / SMOKING GUN env manquante

**Diagnostic exact** :
- `apps/api/src/modules/lisa/services/top-gainers-scanner.service.ts` ligne 1059 :
  `const sessionAware = this.config.get('SCANNER_SESSION_AWARE') === 'true';`
- `fly.toml` `[env]` actuel : `NODE_ENV='production', API_PORT='3001', PORT='3001'`. Aucun `SCANNER_SESSION_AWARE`.
- Conséquence : `sessionAware` reste `false` → la garde session est skip → le scanner continue à appeler EODHD screener même quand toutes les sessions configurées sont fermées (US/EU/Asia weekend).

**Test associé existant** :
`apps/api/src/modules/lisa/__tests__/scanner-session-aware.spec.ts` (PR #298) décrit textuellement le bug observé en prod 09/05/2026 08:20 UTC : « avec `gainers_session_filter_enabled=true` en DB, le scanner continue à fetch les 9 EODHD screener à chaque cycle samedi ».

**Le filtre `usOpen`/`euOpen`/`asiaOpen` lignes 1633-1644 reste actif** mais agit post-fetch — il filtre les candidats parmi le pool déjà ramené par EODHD. Le poison des doublons est en amont : EODHD screener renvoie les MÊMES snapshots fig**és quand le marché est fermé**. Le scanner persiste ces snapshots en DB (`recordDecision`) avant que `usOpen` ne puisse filtrer en aval, et même quand `usOpen=false` les rejets sont quand même écrits via `recordShadowDecision`.

**Probe SQL discriminante (12 mai 2026)** : sur 148 lignes HRB sur 23h10 → `COUNT(DISTINCT entry_price) = 1` (36.29), `COUNT(DISTINCT change_pct_1m) = 1`. Donc vrais doublons, pas faux positifs.

**Fix proposé immédiat** :
```toml
# fly.toml, dans [env]
SCANNER_SESSION_AWARE = 'true'
```

`fly deploy` puis 1 cycle scanner (5 min) suffit pour vérifier en logs que la garde session se déclenche hors-RTH.

### Bug #6 — Important garde-fou : aucune contrainte UNIQUE en DB

`supabase/migrations/0134_gainers_user_shadow_signals.sql` confirmée : 3 index simples (portfolio, symbol, sim_run_at), zéro UNIQUE. `recordDecision` ligne 462 de `gainers-user-shadow.service.ts` = `supabase.from(...).insert(...)` brut, sans `ON CONFLICT`.

Même bug #1 corrigé, un retry réseau Supabase ou un rejouage de cycle peut réintroduire des doublons. Une contrainte UNIQUE en DB est un garde-fou essentiel à long terme.

**Difficulté Postgres** : on ne peut pas mettre `UNIQUE (..., DATE(created_at), ...)` directement. Deux options :
1. **Colonne générée** : `ALTER TABLE gainers_user_shadow_signals ADD COLUMN created_date DATE GENERATED ALWAYS AS (DATE(created_at)) STORED;` puis `CREATE UNIQUE INDEX ... ON gainers_user_shadow_signals (portfolio_id, symbol, asset_class, created_date, entry_price);`
2. **Index unique partiel avec expression** : `CREATE UNIQUE INDEX uniq_decision_per_day ON gainers_user_shadow_signals (portfolio_id, symbol, asset_class, (DATE(created_at)), entry_price) WHERE entry_price IS NOT NULL;`

Option 2 plus simple, option 1 plus performante en read. À ton choix Claude.

**Attention** : `recordDecision` doit alors gérer le conflict via `.upsert({...}, { onConflict: 'portfolio_id,symbol,asset_class,...', ignoreDuplicates: true })` pour ne pas crasher en cas de retry réseau. Sinon ajouter try/catch silencieux sur erreur 23505.

### Bug #2 — Faux bug (RECLASSIFIÉ doc manquante)

L'incohérence apparente « `fetch_diag.outcome=ok` mais `path_eff=NULL` » s'explique par la chronologie :
1. `recordDecision` insère avec `path_eff = pers?.pathQuality?.overallEfficiency ?? null` au moment de la décision scanner.
2. `simulatePending` met à jour `fetch_diag` ~65 min plus tard, indépendamment.

Quand la decision est `reject_cooldown` ou `reject_post_sl_cooldown` (lignes 1898 et 1912 du scanner), `pers` est passé `undefined` par design → `path_eff = null`. Le marché peut très bien être ouvert 60 min plus tard → `fetch_diag.outcome = ok`. Pas un bug.

**Probe SQL (7 derniers jours)** confirme 100% des cas `path_eff IS NULL AND fetch_diag.outcome='ok'` (88/88) sont des `reject_cooldown` / `reject_post_sl_cooldown`.

**Action** : `COMMENT ON COLUMN gainers_user_shadow_signals.path_eff IS '... NULL légitime pour decisions cooldown (pers undefined avant calcul persistence)';`

### Bug #3 — Faux bug (CONSÉQUENCE de #1+#4)

Lignes 380-437 de `gainers-user-shadow.service.ts`, walkForward :
- SHORT TP : `c.low <= tpPrice` avec `tpPrice = entry × (1 − tpPct)`
- SHORT SL : `c.high >= slPrice` avec `slPrice = entry × (1 + slPct)`
- `pnl_pct: closePnl − SLIPPAGE_TOTAL` (ligne 433)

Exemple ATEC entry 7.75 SHORT, TP 0.8% : `tpPrice = 7.75 × 0.992 = 7.688`. Le exit observé à 7.688 EST exactement le TP. La logique est correcte. Ce qui m'avait alerté = le `pnl_pct = -0.005` (0.5% — slippage 30 bps déjà appliqué). Donc c'est bug #4 mal compris, pas bug #3.

À retester après fix #1 quand les inputs prix seront propres.

### Bug #4 — Confirmation : `pnl_pct` est NET de 30 bps slippage

Migration 0134 ligne 68-69 le documentait déjà : « pnl_pct = NET (slippage 30bps round-trip déjà soustrait) ». Je ne l'avais pas lu en Phase 2b → toutes mes soustractions « -30 bps » comptaient 2 fois → edge net réel encore plus faible que -0.05%.

**Pas une modif de code requise**, juste une mise à jour de mes analyses Phase 2b et un commentaire SQL plus visible :
```sql
COMMENT ON COLUMN gainers_user_shadow_signals.sim_results IS
  '... sim_results.{grille}.pnl_pct = (exit_price/entry_price ± 1) − 0.003 (NET de slippage 30bps round-trip)';
```

### Bug #5 — Doc DB obsolète sur `OFF_SESSION` et `fetch_diag.outcome`

- Migration 0134 ligne 68 documente `outcome ∈ TP_HIT | SL_HIT | TIME_LIMIT | NO_DATA` seulement.
- PR #289 a ajouté `OFF_SESSION` côté code TS (lignes 209, 637, 911 de `gainers-user-shadow.service.ts`) avec sub-classification via colonne `off_session_reason` ∈ `capture | stale_data` (PR #296).
- Migration 0136 ligne 30 documente `fetch_diag.outcome ∈ ok | no_data | error` seulement, alors que ligne 645 du service produit aussi `off_session`.

**Fix** : migration `COMMENT ON COLUMN` consolidée mettant à jour les docs DB pour les 3 champs (`sim_results.outcome`, `fetch_diag.outcome`, `path_eff`).

---

## Reclassement par sévérité

| # | Bug | Sévérité reclassée | Effort fix |
|---|---|---|---|
| 1 | `SCANNER_SESSION_AWARE` absent fly.toml | **CRITIQUE** | 1 ligne fly.toml + redeploy |
| 6 | Aucun UNIQUE en DB | Important / garde-fou | 1 migration + .upsert dans recordDecision |
| 4 | `pnl_pct` net 30 bps non visible côté analyse | Doc | COMMENT ON COLUMN |
| 5 | `OFF_SESSION` non documenté en migration | Doc | COMMENT ON COLUMN |
| 2 | `path_eff NULL` vs `fetch_diag.outcome=ok` | **Annulé (faux bug)** | COMMENT explicatif |
| 3 | `TP_HIT` exit hors target | **Conséquence #1+#4** | Re-tester après #1 |

---

## Ordre de priorité fix

1. **fly.toml `SCANNER_SESSION_AWARE='true'`** (Bug #1, 1 ligne, redeploy). Vérifier en logs Fly que `[top-gainers] session-aware skip cycle` apparaît hors-RTH.
2. **Migration UNIQUE + .upsert** (Bug #6, garde-fou DB et applicatif).
3. **Migration `COMMENT ON COLUMN` consolidée** (Bugs #2, #4, #5, doc DB).
4. **Re-test** : laisser le scanner tourner 24h avec session-aware activé, puis SQL `SELECT symbol, COUNT(*) FROM gainers_user_shadow_signals WHERE created_at > NOW() - INTERVAL '24h' GROUP BY symbol HAVING COUNT(*) > 5;` doit retourner 0 lignes sur le week-end / hors-RTH.
5. **Relancer Phase 2 walk-forward propre** sur la nouvelle fenêtre 7+ jours sans contamination.

---

## Plan de validation post-fix

### Étape 1 — Fix #1 en isolation
- [ ] Ajouter `SCANNER_SESSION_AWARE = 'true'` dans `fly.toml [env]`
- [ ] `fly deploy`
- [ ] Vérifier en `fly logs` qu'au premier cycle hors-RTH le scanner log explicitement `session-aware skip`
- [ ] Attendre 6h post-deploy puis SQL `SELECT created_at::date, COUNT(*) FROM gainers_user_shadow_signals WHERE created_at > NOW() - INTERVAL '6h' GROUP BY 1;` doit montrer 0 lignes hors-RTH (sauf cycles intra-marché)

### Étape 2 — Fix #6 garde-fou
- [ ] Migration UNIQUE option 1 ou 2
- [ ] Adapter `recordDecision` en `.upsert({...}, { onConflict: '...', ignoreDuplicates: true })` ou try/catch 23505
- [ ] Test unitaire : inserer 2× la même clé → 2ᵉ insert doit silencieusement no-op
- [ ] Vérifier en prod après 24h : `SELECT COUNT(*) FROM gainers_user_shadow_signals WHERE created_at > NOW() - INTERVAL '24h';` doit être stable cycle-à-cycle

### Étape 3 — Migration COMMENT doc
- [ ] Migration `0139_gainers_shadow_doc_consolidation.sql` (numéro à confirmer, dernière est 0138)
- [ ] COMMENT sur `path_eff`, `sim_results`, `fetch_diag`

### Étape 4 — Re-test Phase 2 propre
- [ ] Laisser tourner 7 jours après tous fixes mergés
- [ ] Relancer le walk-forward sur `gainers_user_shadow_signals` filtré `created_at > <fix-merge-date>`
- [ ] Réévaluer §12 critères GO PAPER de MEASURE.md

---

## PROMPT FINAL À COPIER-COLLER À CLAUDE

Texte ci-dessous à coller dans Claude Code (Comet) pour qu'il vérifie le diagnostic et propose les modifs précises.

---

**Mission — vérification diagnostic et fix scanner SmartVest** (branche `feature/short-shadow-grids`, commit Fly `4c7b345`)

Yannick a STOPPÉ Phase 3 (shadow forward 14j) le 12 mai 08:00 CEST après découverte que `gainers_user_shadow_signals` contient des doublons massifs (148 lignes HRB, 87 ATEC, etc.) avec `entry_price` strictement identique sur des spans de 23h+. Phase 2b "WR 71.9% n=114 path_eff<0.25" est INVALIDÉE — après dédup ce bucket tombe à n=3 distincts.

Une investigation code a remonté un smoking gun : le fix scanner (PR #298, test `scanner-session-aware.spec.ts`) est gardé par un feature flag env `SCANNER_SESSION_AWARE` (ligne 1059 de `apps/api/src/modules/lisa/services/top-gainers-scanner.service.ts`) qui **n'est PAS défini dans fly.toml** → fix désactivé en prod.

Je te demande **3 choses, dans cet ordre, sans pousser ni déployer tant que Yannick n'a pas validé chaque section** :

### 1. Vérifications de code à confirmer ou infirmer

a. Ligne 1059 de `top-gainers-scanner.service.ts` : `sessionAware = this.config.get('SCANNER_SESSION_AWARE') === 'true'` — confirme la présence et l'usage exact (où la valeur sessionAware est-elle ensuite testée pour skip ou autoriser le cycle ?).
b. `fly.toml` section `[env]` : confirme l'absence de `SCANNER_SESSION_AWARE`. Si présent, dans quel fichier env override ?
c. Migration `supabase/migrations/0134_gainers_user_shadow_signals.sql` : confirme l'absence totale de contrainte UNIQUE (juste 3 index simples portfolio/symbol/sim_run_at).
d. Ligne 462 de `gainers-user-shadow.service.ts` `recordDecision` : confirme insert brut sans `.upsert` ni `ON CONFLICT`.
e. Lignes 1898 et 1912 `recordShadowDecision(cand, 'reject_cooldown', undefined)` et `'reject_post_sl_cooldown', undefined` — confirme que `pers=undefined` quand decision = cooldown (donc path_eff=null par design).
f. Ligne 433 `gainers-user-shadow.service.ts` `pnl_pct: closePnl − SLIPPAGE_TOTAL` avec `SLIPPAGE_TOTAL=0.003` (en tête de fichier) — confirme que `pnl_pct` stocké est NET de slippage 30 bps.
g. Lignes 1287-1289 scanner `close = adjusted_close ?? last_price` — confirme que la valeur close persistée provient du screener EODHD et est figée hors-RTH.

### 2. Modifications proposées (chiffrées et localisées)

a. **Fix #1 (instantané)** : éditer `fly.toml`. Insérer dans `[env]` la ligne `SCANNER_SESSION_AWARE = 'true'`. Donne-moi le diff exact attendu.

b. **Fix #6 (garde-fou DB+app)** : propose la migration la plus simple pour `UNIQUE (portfolio_id, symbol, asset_class, DATE(created_at), entry_price)`. Tu peux choisir entre :
   - Option A : colonne générée `created_date DATE GENERATED ALWAYS AS (DATE(created_at)) STORED` + `CREATE UNIQUE INDEX ...`
   - Option B : `CREATE UNIQUE INDEX ... ON ... ((DATE(created_at))) WHERE entry_price IS NOT NULL`
   
   Donne ton choix avec justification (performance vs simplicité). Donne aussi le diff exact à appliquer à `gainers-user-shadow.service.ts` ligne 462 pour transformer `.insert(...)` en `.upsert(..., { onConflict: '<liste>', ignoreDuplicates: true })` ou ajouter un try/catch silencieux sur erreur Postgres 23505.

c. **Fix #2+#4+#5 (doc DB)** : génère une migration `0139_gainers_shadow_doc_consolidation.sql` (vérifie le prochain numéro disponible) avec uniquement des `COMMENT ON COLUMN` :
   - `path_eff` : « NULL légitime pour decisions cooldown (pers=undefined avant calcul persistence) »
   - `sim_results` : décrit `outcome ∈ TP_HIT | SL_HIT | TIME_LIMIT | NO_DATA | OFF_SESSION` et `pnl_pct = NET 30bps slippage round-trip`
   - `fetch_diag` : décrit `outcome ∈ ok | no_data | error | off_session`

### 3. Questions ouvertes à trancher avec Yannick avant tout deploy

a. Le filtre `usOpen` ligne 1633-1644 du scanner agit post-fetch. Est-ce que `SCANNER_SESSION_AWARE=true` empêche bien le **fetch initial** (les 9 calls EODHD screener), ou est-ce qu'il ne fait que skip une partie aval du pipeline ? Vérifie le flow exact en remontant depuis ligne 1059 jusqu'au call EODHD.

b. La contrainte UNIQUE va casser tout cycle de retry réseau Supabase actuel — `recordDecision` deviendra silencieusement no-op sur duplicate. Est-ce que ça pose problème pour le système d'audit / debug ? Faut-il logger les duplicates pour observabilité ?

c. Refactor direction LONG/SHORT (ligne 2741 `top-gainers-scanner.service.ts`) — Yannick mentionne dans son backlog Phase 4 qu'il faut refacto LONG vers SHORT. Est-ce que c'est en cours, ou bloqué par bug #1 ? Si bug #1 corrigé suffit pour la grille SHORT calibrée, est-ce que le refacto direction est encore urgent ?

**Format de réponse attendu** : 3 sections distinctes (Vérifications / Modifs / Questions), pas de PR ni de push tant que Yannick n'a pas répondu point par point. Pas de fichier modifié physiquement, uniquement des diffs proposés en bloc. Pas d'emoji. Français.
