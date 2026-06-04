# CLAUDE.md — SmartVest

Guide de travail pour Claude Code sur ce repo.
**À lire avant toute modification non triviale.**

---

## 🎯 PLANNING PROCHAINE SESSION (02/06/2026 23:30 — à attaquer en priorité)

**Contexte** : session du 02/06 a livré 7 PR (#575-#581). État au coucher : système discipliné mais **possiblement sur-filtré**. L'utilisateur a exprimé sa peur que les 8 couches de filtrage étranglent l'edge — peur légitime, fondée sur son intuition de calibration 25/05 qui avait recovered +23 TP_HIT en 2j.

### 🔥 MISSION CRITIQUE — IDENTIFIER LE GATE QUI FAIT RATER LES PÉPITES (à partir de 00:00 UTC 03/06)

**Énoncé textuel de l'utilisateur, 02/06 23:55** :
> "Notre mission demain à partir de minuit, identifier le gate qui fait que l'on passe systématiquement à côté des pépites !!!! Enregistre le !!!"

**Mission** : trouver QUEL gate (parmi les 8 couches inventoriées plus bas) rejette de façon répétitive des candidats qui auraient été des **vrais winners** (pépites = TP_HIT ou +5% en <60min). C'est LE sujet #1 au réveil.

**Méthode chirurgicale** :
1. Pour chaque rejet logué dans `lisa_decision_log` ou `gainers_user_shadow_signals` (kinds : `scanner_proposal_rejected_by_llm`, `position_open_failed`, ainsi que les rejets per-gate persistance / path_eff / debate / micro_momentum / correlation / overpump / hour blacklist), capturer le symbole + timestamp + raison de rejet.
2. Pour chaque rejet, simuler walk-forward 60min via candles 5m EODHD / 1m Binance.
3. Compter, **par gate** : combien de rejets sont des **pépites** (TP +3% touché) vs noise.
4. Le gate avec le **plus haut taux de regret** (% pépites rejetées) = LE COUPABLE.

**Suspects principaux** (à explorer en priorité) :
- `persistence_score >= 0.67` (TRADER) — strict — déjà identifié 25/05 comme bloquant des KOSDAQ pépites
- `path_efficiency >= 0.70` (TRADER) — strict — déjà identifié 25/05 (relaxé à 0.30 sur US)
- `LLM gate Mistral PR #540` — refuse systématiquement `changePct > 10% pump parabolique` — vérifier si ce label rejette des vrais runners (10-20% intraday peuvent être de vrais momentum, pas que des pumps fade)
- Hour blacklists par classe (peut bloquer la "happy hour" où les pépites sortent)
- Overpump gate (changePct > 15%)
- Earnings filter — peut rejeter les meilleurs catalyseurs

**Scripts existants à réutiliser/inspirer** :
- `scripts/backtest-thu-fri-funnel.ts` — funnel complet par gate + outcomes simulés (référence 25/05)
- `scripts/persistence-distrib.ts` — distribution par score bucket
- `scripts/unset-persistence-and-analyze-patheff.ts` — UPDATE persistence + scénarios path_eff

**Verdict attendu** :
- Si 1 gate rejette > 30% des pépites → re-calibrer (relâcher seuil OU passer en SHADOW)
- Si plusieurs gates intersectent → traiter du plus restrictif au moins restrictif
- Si aucun gate ne ressort → le problème est ailleurs (univers de candidats trop pauvre, filtres upstream)

**Garde-fou** : ne pas relâcher tous les gates simultanément (overcorrection). Une gate à la fois, mesurer 24-72h post-relâchement, valider.

### Ordre d'attaque au réveil

1. **Morning brief Asia D'ABORD**
   ```bash
   npx tsx scripts/asia-morning-brief.ts
   ```
   - Résume nuit Asia 00-08h UTC
   - Alertes auto (PnL < -$100, ≥3 SL consec, .SHE trades, big losers)
   - Doit guider la première action (kill Asia si désastre, sinon continue)

2. **Funnel analysis 7 derniers jours** — le SUJET CRITIQUE
   - Compter par stage : candidats bruts → après chaque gate → ouvertures réelles
   - Stages à mesurer (pour chaque portfolio TRADER+HIGH+MIDDLE+SMALL) :
     - Total candidats scannés
     - Après persistence ≥ seuil DB
     - Après path_efficiency ≥ seuil DB
     - Après DebateGate consensus
     - Après LLM gate Mistral (PR #540)
     - Après SkepticAgent shadow (mesurer les `skeptic_verdict` blocks théoriques)
     - Après garde-fous TRADER (anti-revenge, US opening block, XETRA notional, overpump)
     - Ouvertures réelles
   - Sources : `lisa_decision_log` (kinds : `scanner_proposal_rejected_by_llm`, `position_opened`, `position_open_failed`), `trader_agent_decisions`, `paper_trades`, `lisa_positions`
   - Verdict attendu : si 200 bruts → 0-1 ouvert, ÉTRANGLÉ. Si 200 → 5-10 → 1-2, sain.

3. **Counterfactual regrets** — trades manqués qui auraient gagné
   - Pour chaque rejet de chaque gate, simuler outcome 60min via candles
   - Identifier : "% des rejets path_eff étaient des winners ?", "% des rejets debate_gate ?", etc.
   - Pattern attendu : si une gate rejette > 30% de winners → trop strict
   - Cf. méthode appliquée 25/05 : `scripts/backtest-thu-fri-funnel.ts`, `unset-persistence-and-analyze-patheff.ts`

4. **Re-calibration sélective** (pas tout à la fois — chirurgicale)
   - Identifier la gate qui rejette le plus de winners
   - Mettre en SHADOW d'abord (PR + env flag), mesurer 48-72h
   - Si confirmation → ajuster seuil OU désactiver gate
   - PRIORISER les gates JEUNES (SkepticAgent → activer en blocking règle par règle SI calibration sample suffisant)
   - GARDER les filets de sécurité catastrophe (kill switch, autonomy mandate, drawdown cap FTMO 3%)

### Risques à éviter

- **Ne PAS désactiver toutes les gates d'un coup** (overcorrection inverse)
- **Ne PAS toucher au SL mécanique** (filet de dernière instance — backtest 02/06 a montré 73% rebound à entry < 60min MAIS médiane PnL -0.24% si held = pas un edge clair)
- **Ne PAS reset paper_trades** (perd l'historique nécessaire au funnel analysis)
- **Conserver SkepticAgent en shadow** jusqu'à mesure ratio veto/total stable

### Mesures de succès

- Pré-fix : 56 trades/30j (sample insuffisant pour Wilson CI robuste)
- Cible post-recalibration : **>200 trades/30j** sur les setups validés (permet ±9% CI à n=100/cellule)
- Préserver le ratio winning portfolios (KQ KOSDAQ +75% WR, AS, SW, crypto)
- Maintenir/améliorer winRate global (45.8% baseline → cible 50%+)

### Lien aux PR livrés ce soir

- PR #575 — bridge fix (assure que agent ne contourne pas les gates)
- PR #576 — proposals hardening (rend les rejets traçables → essentiels au funnel analysis)
- PR #577 — lessons actionables (les futures calibrations seront auto-applied)
- PR #578 — setup taxonomy (permettra cellules par config quand n ≥ 100)
- PR #579 + #580 — SkepticAgent shadow (mesure veto count par règle pour calibration)
- PR #581 — Asia morning brief (étape 1 du plan)

### Fix DB déjà appliqué ce soir (réversible)

- `lisa_session_configs.gainers_hour_blacklist_eu_utc = '10,11,12'` sur les 4 portfolios
- Vise -$854/30j pattern LSE+PA 10-12h UTC
- Si funnel analysis montre que le fix est trop strict (rejets > regrets), reverter à `""`

---

## Contexte utilisateur

- **Langue de travail** : français (toujours répondre en français).
- **❌ NE SAIT PAS UTILISER LE TERMINAL** (curl, fly CLI, bash). Tout
  diagnostic doit passer par :
  1. Mon sandbox (j'exécute moi-même `curl`, `npx tsx scripts/...`,
     queries Supabase via SUPABASE_SERVICE_ROLE_KEY local .env)
  2. L'UI web (ajouter pages admin pour surfacer les diagnostics que je
     vérifierais sinon via curl)
  3. Logs Fly que l'utilisateur copie/colle depuis le panel UI
  4. **JAMAIS** demander à l'utilisateur de taper une commande shell
  - Conséquence pratique : pour tester un endpoint admin protégé par
    `x-admin-token`, soit l'utilisateur partage la valeur du token en
    chat (et je curl depuis mon sandbox), soit je crée une page UI qui
    consomme l'endpoint avec auth déjà gérée.
  - Pour modifier un secret Fly : l'utilisateur le fait via Fly UI
    (Edit/Add button), pas via `fly secrets set`. Lui donner la valeur
    à coller, pas la commande shell.
- **ADMIN_TOKEN procédure — la valeur NE DOIT JAMAIS être committée** :
  - Le token protège les endpoints `/admin/*` (`config-dump`,
    `llm-router-probe`, `eodhd-status`, etc.)
  - Quand l'utilisateur partage la valeur en chat, je l'utilise
    UNIQUEMENT dans des variables shell éphémères du sandbox
    (`export ADMIN_TOKEN=...`), JAMAIS écrit dans un fichier tracké
  - Endpoints disponibles avec ce token :
    - `GET /admin/config-dump` → tous les secrets non-sensitive (valeur + default)
    - `GET /admin/llm-router-probe` → test call Mistral + verdict primary/fallback
    - `GET /admin/eodhd-status` → quota EODHD + throttle state
  - **Toujours recommander à l'utilisateur de rotater le token** après
    chaque session où il l'a partagé en chat (set une nouvelle valeur
    dans Fly UI). C'est le prix à payer pour ne pas écrire en clair
    dans le repo.
- **Localisation** : France (Europe/Paris timezone, CEST en été = UTC+2,
  CET en hiver = UTC+1). Quand on logue / compare des heures, garder en
  tête que **les marchés sont en UTC** mais l'utilisateur raisonne en
  heure locale (Paris). Exemple : 06:00 UTC = 08:00 CEST chez l'utilisateur.
- **Habitudes de travail** : commence la journée tôt (matinées 6h-9h CEST
  intenses). Sessions Asia (00:00-06:00 UTC) tombent en début de matinée
  locale, sessions US (14:30-21:00 UTC) tombent en après-midi-soirée.
- **Style de communication** : direct, pragmatique, attend des chiffres
  et des actions concrètes. Pas de baratin. Quand il valide d'un "oui"
  ou "go", exécute sans relancer.
- **Historique projet** : ~6 semaines de réflexion commune sur SmartVest
  au moment de la rédaction (fin mai 2026). Mémoire Gemini scanner_lessons
  doit accumuler **indéfiniment** (multi-années), pas juste 24h ni
  6 semaines — cf. ScannerLessonsContextService cache 10000 lessons +
  score composite confidence × log(sample_size).

---

## ADR-002 — Nomenclature UI grand public (Sprint 1, 30/04/2026)

Toute mention texte côté front (sidebar, h1, breadcrumb, document.title) doit
utiliser le vocabulaire grand public. Routes inchangées (deeplinks préservés).

| Route | Label sidebar / h1 |
|---|---|
| `/` | Mon tableau de bord |
| `/portfolio` | Mon portefeuille |
| `/performance` | Mes résultats |
| `/lisa` | Mon assistant Lisa |
| `/backtest` | Tester sur le passé |
| `/monte-carlo` | Projections futures |
| `/optimizer` | Améliorer mon portefeuille |
| `/bot-lab` | Mes stratégies auto (mode démo) |
| `/alerts` | Mes notifications |
| `/history` | Mes opérations |
| `/settings` | Mon compte |
| `/help` | Aide |
| `/admin/monitoring` | Monitoring (masqué non-admin via `useIsAdmin()` hook) |

Nouveaux libellés interdits dans le code/UI :
- "Backtest harness", "Monte Carlo Simulation", "Strategy Optimizer",
  "Bot Profitability Lab", "AI Analyst", "Aide & Documentation"
- Tout anglicisme non glosé (cf. CLAUDE.md §1 wording)

Cf. `docs/adr/ADR-002-grand-public-ready.md` pour le plan 8 sprints complet.

---

## EODHD API Reference (OFFICIAL SKILL — vendor/eodhd-claude-skills)

P19k.2 — Le skill officiel EODHD `eodhd-claude-skills` est vendoré dans
`vendor/eodhd-claude-skills/` (copie depuis github.com/EodHistoricalData/eodhd-claude-skills,
sans submodule pour compat Fly/Vercel CI).

**Pour TOUTE implémentation touchant l'API EODHD** (intraday, eod, real-time,
fundamentals, screener, websockets, fx, crypto, news, technical indicators,
splits/dividends, exchange-symbol-list, delisted) :

1. **TOUJOURS** consulter `vendor/eodhd-claude-skills/skills/eodhd-api/references/endpoints/<endpoint>.md`
   AVANT d'écrire du code (72 endpoints documentés avec params, shape réponse,
   exemples curl). Index : `endpoints/` (un fichier par endpoint).

2. **TOUJOURS** consulter `vendor/eodhd-claude-skills/skills/eodhd-api/references/general/symbol-format.md`
   pour le **suffix mapping** (autorité officielle, pas de devinette) :
     - Korea Stock Exchange = `.KO` (PAS `.KOSE` — ex: `005930.KO` Samsung)
     - KOSDAQ = `.KQ`
     - Shanghai = `.SHG` (Moutai = `600519.SHG`)
     - Shenzhen = `.SHE`
     - HK = `.HK` avec leading zeros (`0700.HK` Tencent, PAS `700.HK`)
     - LSE = `.LSE`, XETRA = `.XETRA`, Paris = `.PA`, Amsterdam = `.AS`, Swiss = `.SW`
     - Frankfurt sur F : `.F` ≠ `.XETRA` (different exchanges, BMW.F vs BMW.XETRA)
     - Forex = `EURUSD.FOREX` (pas de séparateur)
     - Crypto = `BTC-USD.CC`
     - US class shares : `BRK-B.US` (hyphen replaces dot)

3. Respecter `references/general/` pour : auth (`api_token` query param),
   `fmt=json` obligatoire (sinon CSV → parse error), pagination, rate limits
   (notre plan ALL-IN-ONE = 100k calls/jour, pas de limite pratique).

4. `vendor/eodhd-claude-skills/skills/eodhd-api/scripts/eodhd_client.py` est
   le client de référence Python ; reproduire la même logique en TS.

5. **Plan SmartVest** = ALL-IN-ONE $99.99/mo (cf. `references/general/pricing-and-plans.md`).
   100 000 calls/jour. Aucune contrainte budgétaire en pratique.

6. Quick reference SmartVest-spécifique (10 endpoints qu'on utilise) :
   `docs/EODHD_QUICK_REFERENCE.md` — avec URL canonique, params, response
   shape, suffix mapping appliqué, snippet code TS.

7. Définition complète du skill : `vendor/eodhd-claude-skills/skills/eodhd-api/SKILL.md`.

---

## Plans market data — quotas (note budget)

| Provider | Plan SmartVest | Quota | Contrainte pratique |
|---|---|---|---|
| EODHD | ALL-IN-ONE $99.99/mo | 100k calls/jour | aucune |
| TwelveData | **$229/mo** | **infini (quota illimité)** | **aucune — ne pas optimiser le volume de calls par souci de coût** |
| Binance | public market data | gratuit | géo-block sandbox locale (HTTP 451), OK depuis Fly |
| FRED | gratuit | 120 req/min | non bloquant |

**Conséquence opérationnelle** : le volume de calls TwelveData (`daily_usage` qui grimpe à 3000+/h) **n'est PAS un problème de quota** — le plan $229 est illimité. Si on optimise les calls TD, c'est uniquement pour **latence** (pression sur le rate-limit instantané, pas le quota journalier) ou **fraîcheur** (éviter de payer un round-trip pour une quote `STALE` qu'on va re-tagger). Ne PAS proposer de réduire la fréquence du price warmer ou les dual-calls IntradayRouter pour économiser du quota — c'est zéro impact budget.

---

## RÈGLE OPÉRATIONNELLE — GAINERS UX + PATH QUALITY — P9-UX

P9-UX livre 2 features UX critiques + 1 dimension qualité (addendum) sur le scanner Gainers :

### 1. Cycle scanner configurable par portfolio

`lisa_session_configs.gainers_cycle_minutes` (1..60, default 15). UI `<select>` dans `GainersStatusTile` (8 valeurs : 1, 5, 10, 15, 20, 30, 45, 60). Toast warn à 1 min (coût API ×15).

`TopGainersScannerService.runScannerInner()` lit ce champ avec cache 30s + tracking `lastScanByPortfolio` Map en mémoire. Skip portfolios dont le cycle n'est pas écoulé. Effective cycle = max(env SCAN_INTERVAL_MINUTES, DB cycle).

### 2. Slider topN dynamique avec debounce

Slider `<input type="range" min=5 max=100 step=5>` avec ticks visuels [5, 10, 20, 50, 100]. **Debounce 300ms** avant refetch backend pour éviter spam pendant le drag. Titre tableau "Top {N} candidats" + sous-titre "Top {N} en hausse 1min" interpolés. Tableau slicé à `topN`, summary counters utilisent `topN` comme denominator.

### 3. Path quality / smoothness (ADDENDUM)

Détecte les pump-and-dump qui passent le gate persistence mais dont le path est chaotique.

```
pathEfficiency = |end - start| / Σ|p_i - p_{i-1}|     ∈ [0, 1]
pullbackDepth  = (max - minAfterMax) / max
classification : smooth (eff≥0.7 AND pullback≤1%) / choppy (eff<0.4 OR pullback>2%) / mixed
```

Calculé pour chaque TF (5/10/15/30/60m) à partir des candles 1m (Binance) ou 5m (EODHD) déjà fetchées pour persistence. `overallEfficiency` = moyenne, `overallSmoothness` = choppy si ≥1 TF choppy, smooth si tous smooth, sinon mixed.

**Gate scanner optionnel** : `gainers_min_path_efficiency` (0..1 ou null pour désactiver, default 0.5). Skip si `overallEfficiency < min`.

**UI** : colonne "Path" avec badge 🟢/🟡/🔴 + tooltip `eff X% · label`. Toggle "Cacher choppy" filtre client-side.

### Endpoint snapshot enrichi

`GET /lisa/gainers-persistence-snapshot/:portfolioId?topN=20&markets=crypto,us` retourne désormais `pathQuality` par candidat avec `overallEfficiency`, `overallSmoothness`, et metrics par TF (`pathEfficiency`, `pullbackDepth`, `monotonicity`, `smoothnessLabel`, `n`).

### Migration `0089_gainers_cycle_minutes`

```sql
ADD COLUMN gainers_cycle_minutes INT DEFAULT 15 CHECK (1..60);
ADD COLUMN gainers_min_path_efficiency NUMERIC(3,2) DEFAULT 0.5 CHECK (NULL OR 0..1);
```

Doc complète : `docs/scanner-gainers.md`.

---

## RÈGLE OPÉRATIONNELLE — PROBABILITÉ BAYESIENNE — P9

P9 transforme P8 (mesure de persistance multi-TF) en moteur probabiliste : `P(trade gagnant | features)` via régression logistique entraînée sur l'historique `paper_trades`. Implémentation maison (Newton-Raphson + L2, ~50 LoC), pas de dépendance ML externe.

### Pure helpers (`@smartvest/ai-analyst`)

- `logistic-regression.ts` : `fitLogistic(X, y, names, opts)`, `predict(weights, features)`, `computeAuc`, `computeAccuracy`, `wilsonInterval` (95%)
- `empirical-law.ts` : `computeEmpiricalLaw(trades, minSample)` retourne buckets `persistenceCount → { n, wins, pWinObserved, avgPnlPct, ciLow, ciHigh }`

### Service `PersistenceProbabilityService`

- `estimateProbability(features)` : charge weights (cache 5min), retourne `{ pWin, confidence, sampleSize, modelVersion, fallback }`
- `getEmpiricalLaw({ lookbackDays, minSample })` : alimente l'endpoint UI dashboard
- `trainAndPersist({ lookbackDays })` : fit Newton-Raphson + AUC + INSERT nouvelle version (`probability_model_weights`)

### Garde-fous statistiques

- `sample_size < 30` → fallback (caller utilise seuil P8 dur, marqueur `fallback=true`)
- `auc < 0.55` → fit rejeté, version précédente conservée
- L2 régularisation `λ=0.01` par défaut (mitigation overfit petit sample)

### Endpoints

```
GET  /lisa/persistence-empirical-law?lookback_days=30&min_sample=20
POST /lisa/persistence-empirical-law/refit  body { lookback_days?: number }
```

Retour empirical law :
```json
{
  "trainedOn": 487,
  "empiricalLaw": [
    { "persistenceCount": "0/6", "n": 23, "pWinObserved": 0.13, "ciLow": 0.05, "ciHigh": 0.31 },
    { "persistenceCount": "6/6", "n": 52, "pWinObserved": 0.78, "ciLow": 0.65, "ciHigh": 0.87 }
  ],
  "fittedCurve": "logistic",
  "coefficients": { "intercept": -1.8, "persistenceCount": 0.62, ... },
  "aucRoc": 0.71,
  "accuracy": 0.68,
  "modelVersion": "v1730000000",
  "fallback": false
}
```

### Migration `0088_probability_model_weights`

Append-only : id, version (UNIQUE), weights JSONB, sample_size, auc_roc, accuracy, trained_at. Version courante = `trained_at MAX`.

### Out of scope ce PR (deferred follow-up)

- Cron Sunday 02:00 UTC (à wirer dans `LisaAutopilotService` ou nouveau service `ProbabilityRefitCron`)
- Scanner integration `pWin` gate (dépend de données collectées sur quelques jours minimum)
- UI dashboard (graph empirique + table coefficients + bouton refit)
- Backtest CLI offline `pnpm backtest:persistence`

L'endpoint `POST /persistence-empirical-law/refit` est utilisable manuellement pour bootstrapper le premier fit dès qu'il y a 30+ trades fermés.

---

## RÈGLE OPÉRATIONNELLE — PERSISTANCE MULTI-TF — P8

P8 ajoute une **dimension qualité** sur le scanner Gainers : avant d'ouvrir une position sur un top-1m gainer, on vérifie que la hausse est **persistante sur plusieurs timeframes** (1m / 5m / 10m / 15m / 30m / 1h) — pas juste un flash.

### Règle métier

```
persistenceScore = #TF positifs / #TF disponibles  ∈ [0, 1]
```

- Un TF est "positif" si `(currentPrice - openAtTFAgo) / openAtTFAgo > 0`
- TF non disponible (provider down, série trop courte, EODHD plan sans 1m) → exclu du denominator
- Score normalisé sur les TFs disponibles uniquement (denominator dynamique)

**Gate scanner** : `if (persistenceScore < gainers_min_persistence_score) skip`. Default 0.67 (≥ 4/6 TF positifs). Configurable :
1. `lisa_session_configs.gainers_min_persistence_score` (DB par-portfolio)
2. `GAINERS_MIN_PERSISTENCE_SCORE` (env global)
3. Default `0.67`

### Sources de prix multi-TF

| Asset class | Service | Resolution native | TFs derivés |
|---|---|---|---|
| Crypto | `BinanceMarketService.getKlines(sym, '1m', 61)` | 1m | 1m, 5m, 10m, 15m, 30m, 1h depuis offsets candles |
| Equities | `EodhdIntradayService.getCandles(ticker, '5m', 13)` | 5m | 5m, 10m, 15m, 30m, 1h (1m=null, plan EODHD intraday-1m payant) |

Cap concurrence : 5 fetches parallèles par source (rate-limit guard Binance 1200 weight/min, EODHD plan-dependent).

### Endpoint snapshot

```
GET /lisa/gainers-persistence-snapshot/:portfolioId?topN=20&markets=crypto,us
```

**Réponse littérale à la question utilisateur** : « 20 valeurs en hausse 1min — combien sont aussi en hausse 5/10/15/30/60min ? ». Renvoie les `tfXm` par symbole + `summary` agrégé (counts par TF) + `persistenceScore`/`persistenceCount`. Cache 30s côté service. Audit append-only dans `gainers_persistence_log` (rétention 7j cron à venir).

### topN configurable — priorité de lecture

1. Query string `?topN=` (override ad-hoc, range 5..100)
2. `lisa_session_configs.gainers_persistence_top_n` (DB par-portfolio)
3. `GAINERS_PERSISTENCE_TOP_N` (env global)
4. Default `20`

### Schema forward-compatible — `paper_trades` (P6 + P8 + P9)

Migration `0086` crée `paper_trades` avec **toutes** les colonnes futures dès maintenant pour éviter ALTER TABLE à chaque PR :
- P6 logique paper-broker : `entry_price`, `exit_price`, `size_usd`, `stop_loss`, `take_profit`, `status`, `pnl_usd`, `pnl_pct`, `hold_duration_seconds`
- P8 persistance : `persistence_score_at_entry`, `persistence_count_at_entry`, `tf_changes_at_entry JSONB`
- P9 ML (forward-compat, peuplé par PR ultérieur) : `features_at_entry JSONB`, `p_win_at_entry`, `outcome_label`, `model_version_at_entry`

### UI — slider topN + summary counters

`GainersStatusTile` (P7) embarque un `PersistencePanel` (P8) avec :
- Slider `<input type="range" min=5 max=100 step=5>` ; refetch 60s sur changement
- 6 cellules `summary` : "1m / 5m / 10m / 15m / 30m / 1h" → "20 / 17 / 14 / 12 / 9 / 7" (réponse user)
- Tableau détaillé top-N × 6 TFs (cellules vert/rouge selon signe)

---

## RÈGLE OPÉRATIONNELLE — AUTOPILOT BUDGET RESILIENCE — P8-BR

P8-BR découple **kill-switch** (manuel/critique) de **budget-pause** (réversible). Avant : `autopilot_enabled` flippait à `false` sur `BudgetExceededError` → autopilot OFF silencieusement, intervention manuelle requise. Constat live 27-28/04 : 6h sans cycle, 0 trade.

### Source de vérité

`lisa_session_configs.autopilot_paused_reason TEXT NULL` (migration 0087) avec valeurs : `'BUDGET_EXCEEDED'` / `'MANUAL'` / `'PROVIDER_OUTAGE'`. **`autopilot_enabled` n'est plus jamais flippé par le hard-stop budget.**

### Cycle de vie

1. **Pause** (`LisaService.generateProposal`) : si `getTodayTotalUsd() >= daily_cost_budget_usd` → `UPDATE paused_reason='BUDGET_EXCEEDED'` + log `kind='autopilot_paused'` + throw `BudgetExceededError`.
2. **Auto-resume** (`LisaAutopilotService.maybeResumeOrSkip`) au début de chaque cycle :
   - `daily_cost_budget_usd IS NULL` → resume (budget retiré)
   - `getTodayTotalUsd() < 0.9 × budget` → resume (rollover UTC à minuit OU bump budget)
   - sinon → skip ce cycle pour ce portfolio (log discret)
3. Le seuil **90%** est volontaire pour éviter le flap (resume → re-pause aussitôt si on était à 99% sans rollover).

### Endpoint observable

`GET /autopilot/cost-status?portfolioId=...` → `{ daily_used_usd, daily_budget_usd, pct, paused_reason, autopilot_enabled, kill_switch_active, next_reset_utc }`. Polling 30s côté UI.

UI badge `<AutopilotBudgetBadge>` dans `/lisa` avec couleurs : 🟢 < 60% / 🟡 60-90% / 🔴 ≥ 90% ou paused.

### Logs decision_log

| `kind` | Quand | Résultat |
|---|---|---|
| `autopilot_paused` | budget atteint | Pause active, autopilot_enabled reste `true` |
| `autopilot_resumed` | clear automatique | Reprise sans intervention manuelle, payload cite trigger |
| `autopilot_disabled` | (legacy, plus émis depuis P8-BR) | — |

### Backfill prod

Pour les rows qui ont `autopilot_enabled=false` causé par BudgetExceededError pré-P8-BR, exécuter `pnpm tsx scripts/backfill-autopilot-paused-reason.ts --apply` (dry-run par défaut). Le script restore `enabled=true` + set `paused_reason='BUDGET_EXCEEDED'`, l'auto-resume prend le relais.

Doc complète : `docs/autopilot.md` (matrice états × transitions × endpoint).

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

## RÈGLE OPÉRATIONNELLE PERMANENTE — APPLIQUER UNE MIGRATION SUPABASE

Source de vérité unique : `.github/workflows/apply-supabase-migrations.yml`.
Le secret `SUPABASE_ACCESS_TOKEN` (PAT Supabase, type `sbp_*`) vit côté
GitHub Actions, jamais en clair localement ni côté Fly. **Ne JAMAIS demander
au user d'appliquer la migration manuellement** tant qu'on a accès au repo.

### Le chemin qui marche

1. Migration `supabase/migrations/NNNN_xxx.sql` mergée sur `main` (idempotente :
   `CREATE TABLE IF NOT EXISTS`, `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, etc.).
2. Push une branche `migrations-trigger-<slug>` depuis `origin/main` :
   ```bash
   git fetch origin main
   git checkout -b migrations-trigger-<NNNN>-<slug> origin/main
   git push -u origin migrations-trigger-<NNNN>-<slug>
   ```
3. Le workflow `Apply Supabase migrations (manual)` se déclenche sur le
   pattern `migrations-trigger-*`, exécute `scripts/apply-migrations.mjs`
   contre la Management API Supabase, et **poste le résultat en commentaire
   sur Issue #131**.
4. Vérifier le résultat via `mcp__github__issue_read get_comments` sur Issue
   #131 (commentaire le plus récent avec `(sha <head-sha>)`). Chercher
   `0 échecs` et la ligne `NNNN_xxx.sql OK` (ou `SKIP` si déjà appliquée).
5. **Cleanup** : `git push origin :migrations-trigger-<NNNN>-<slug>` puis
   `git branch -D <slug>` local. La branche n'a aucune raison de rester
   après que le workflow a tourné.

### Ce qu'on n'a PAS le droit d'oublier

- **La migration DOIT être sur `main` AVANT de pusher la branche trigger** :
  le workflow checkout `ref: main`, il ne lira jamais la branche trigger
  elle-même. Workflow ordering : migration merge → main → trigger push.
- **Triggers acceptés** : `workflow_dispatch` (UI bouton) OU push de
  `migrations-trigger-*` OU tag `apply-migrations-*`. Le push de branche
  est la voie programmatique préférée pour les agents.
- **Auto-apply au boot Fly** : le Dockerfile lance déjà `apply-migrations.mjs`
  au démarrage du container, donc si le déploiement Fly tourne après le merge
  de la migration, elle peut déjà avoir été appliquée. Le trigger workflow
  reste idempotent (SKIP), aucun risque de double-apply.
- **Ne pas tenter d'appliquer via `SUPABASE_SERVICE_ROLE_KEY`** : ce JWT
  fonctionne pour PostgREST (rows) mais PAS pour DDL. Seul le PAT
  `SUPABASE_ACCESS_TOKEN` (Management API, type `sbp_*`) peut faire du DDL.
- **Ne pas demander au user d'appliquer manuellement** tant que cette procédure
  est disponible. Si elle échoue, fallback Supabase Studio SQL editor (manuel
  utilisateur), mais c'est la solution de dernier recours, pas la première option.

Cas vérifié 23/05/2026 : migration `0153_eodhd_news_persistence.sql` appliquée
en ~10 secondes via push branche `migrations-trigger-0153-eodhd-news`, résultat
posté Issue #131 commentaire 4524443665 (`149 migrations · 149 appliquées · 0 échecs`).

---

## RÈGLE OPÉRATIONNELLE PERMANENTE — DEPLOY FLY (P18h.2)

**Ne jamais utiliser `flyctl deploy` directement** — toujours :

1. **Préféré** : push to `main` → workflow `.github/workflows/fly.yml` se déclenche et passe `--build-arg GIT_SHA=${{ github.sha }}` + `--build-arg BUILD_TIME=$(date -u +...)` automatiquement.
2. **Manuel uniquement si CI cassée ou redeploy urgent** : `./scripts/deploy.sh` qui auto-extrait `git rev-parse HEAD` + `date -u +...` et appelle `flyctl deploy --build-arg ...`.

`flyctl deploy` direct sans build args casse `/version` (P18h endpoint) → `git_sha:null` + `build_time:null` en prod → on perd la traçabilité du commit déployé. Cas vérifié 29/04/2026 11:04 UTC + 13:38 CEST. Ne pas répéter l'erreur.

Re-trigger d'un workflow Actions Fly Deploy (workflow_dispatch sur `fly.yml`) est aussi acceptable et préserve les build args.

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

## RÈGLE OPÉRATIONNELLE — CALIBRATION GATES SCANNER (25/05/2026)

Décisions prises soir 25/05 après backtest funnel sur shadow signals Thu+Fri
(`scripts/backtest-thu-fri-funnel.ts`, `persistence-distrib.ts`,
`unset-persistence-and-analyze-patheff.ts`). Sample 2j = 786 candidats.

### Persistence multi-TF — DÉSACTIVÉ pour mode `gainers`

`lisa_session_configs.gainers_min_persistence_score = 0` appliqué sur les 4
portfolios actifs : `a0000001-a0000003` (shadows) ET `b0000001` (TRADER,
ex-`58439d86` migré 30/05).

⚠️ **BUG LATENT — migration portfolio IDs** : le 30/05/2026 le portfolio
principal `58439d86-3f20-4a60-82a4-307f3f252bc2` a été migré vers
`b0000001-0000-0000-0000-000000000001` (TRADER). **Toutes les calibrations
DB-side appliquées à l'ancien ID doivent être ré-appliquées au nouveau**.
Vérifié 03/06/2026 — l'oubli a coûté 8h+ de pipeline starved (TRADER avait
encore persist=0.67 + pathEff=0.7 par défaut DB, alors que les shadows
étaient à 0). Quand on documente une UPDATE prod `lisa_session_configs`
appliquée à un portfolio, **toujours documenter le portfolio_id complet
courant**, pas juste un prefix qui peut devenir obsolète après migration.

**Rationale** : le concept de persistence multi-TF (1m/5m/10m/15m/30m/1h) est
solide pour swing trades 3-7j mais **inadapté au scalp 60min top-gainers**. Par
construction, un pump explosif sur la 1m (la signature exacte des pépites)
donne `persistenceScore ≈ 0` car les TF longs sont encore flats au moment de
la détection.

**Donnée** : sur 310 candidats `reject_persistence` Thu+Fri, 82% ont score=0.00
(0/6 TF) — bucket qui contient ~47 TP_HIT cachés (winRate global rejected = 75%,
+67% sum pnl). Les pépites MKA.LSE (+16.85% en 1m) et IES.LSE (+38.67% en 1m)
auraient été bloquées sans ce unset.

**Garde-fou** : le gate reste opérationnel en infra (code path intact). Réactivable
en passant le seuil > 0 si l'aval (DebateGate + Gemini Risk Manager + ConvictionSizing)
ne filtre pas suffisamment le surplus de bruit. Ne PAS retirer la mécanique persistence
du code — elle reste utile pour les modes `investment`/`harvest` futurs (Lisa LLM
swing 3-7j) si on les active à seuil 0.67.

### Path efficiency US — seuil 0.40 → 0.30

`GAINERS_MIN_PATH_EFFICIENCY_US=0.30` (Fly secret).

**Rationale** : path_eff filtre correctement le chop / pump-and-dump (gate sain
sous 0.30 : winRate ≤ 33%, sumPnl -17 à -24%) MAIS le seuil 0.40 coupait la
veine des gagnants propres.

**Donnée** : bucket 0.40-0.50 = 87 candidats Thu+Fri rejetés à tort — 14 TP_HIT
+ 9 SL_HIT, winRate **53%**, sumPnl **+11.88%**. À 0.30 : +92 candidats/j
récupérés, +23 TP_HIT en 2j équivalents, sumPnl sauvés +10.75%. À 0.20 ça bascule
négatif (-6.73%), à 0.10 toxique (-30%) — DONC 0.30 est le sweet spot.

**Note** : seul `us_equity_large` + `us_equity_small_mid` impactés par cette
valeur. EU/Asia/crypto restent au default code (probablement 0.5) — à monitorer
sur quelques jours avant d'étendre. Le bucket 0.40-0.50 contient toutes classes
confondues donc des pépites EU/Asia/crypto sont probablement aussi ratées au
default 0.5 — à valider via per-class breakdown si besoin.

### Caveat méthodologique

Sample 2j (Thu+Fri 22-23/05) → trends indicatifs uniquement, pas significatif
statistiquement. La table `gainers_user_shadow_signals` ne capture **qu'une partie
des gates** (persistence / path_eff / cooldown / RSI / opening_buffer) — les
gates en aval (DebateGate, ConvictionSizing, MicroMomentumGate, StaleGuard,
ConvictionSizing veto, MacroVeto Gemini) ne sont pas dans le funnel shadow et
restent à mesurer via cross-check `lisa_decision_log`.

### À monitorer 24-72h post-changement

1. Volume `accept` daily : attendu ~20/j → ~40/j (doublé)
2. Win rate `paper_trades` closed : surveiller si effondrement < 30%
3. `[risk-manager-v2] THESIS_BROKEN` auto-closes : doivent monter mécaniquement
4. `/admin/debate-gate/metrics?hours=24` block ratio : si > 60% sur Asia/EU c'est
   le filet qui prend le relais correctement
5. Si winRate paper s'effondre OU drawdown jour > 5% → rollback persistence
   (`gainers_min_persistence_score = 0.33`) en priorité, path_eff en second.

### Fichiers de référence

- `scripts/backtest-thu-fri-funnel.ts` — funnel complet par gate + outcomes simulés
- `scripts/persistence-distrib.ts` — distribution par score bucket
- `scripts/unset-persistence-and-analyze-patheff.ts` — UPDATE persistence + scénarios path_eff

---

## RÈGLE OPÉRATIONNELLE — CALIBRATION SEUILS & BLACKLIST (audit 03/06/2026)

Audit complet du funnel scanner gainers (script `scripts/backtest-overextended-by-band.ts`
+ analyse frontière accept/reject sur `gainers_user_shadow_signals`). Décisions :

### Seuils overextended par classe (gate maxChangeLong, change_pct 1min)

Backtest band-by-band (TP+3/SL-1.5, 60min, marché réel) → seuils data-optimaux :

| Classe | Seuil | Bandes gagnantes (data) | Bandes rejetées |
|---|---|---|---|
| us_small_mid | **10** | 3-8% (+0.42%), 8-10% (+0.97%) | 10-15% breakeven, 15-25% perdant |
| us_large | 15 | (large caps moins volatiles) | — |
| eu | 15 | — | — |
| asia | **30** | 15-25% (+0.54%), 25-100% (+0.93%) | — laisser la bande LARGE |
| crypto | 30 | non-validé (Binance géo-bloqué backtest) | — |

**Fix code 03/06 (`max-change-per-class.helper.ts`)** : `DEFAULT_MAX_CHANGE_PER_CLASS`
n'est plus `null` partout (asia 30, eu 15, us_large 15, us_small_mid 10, crypto 30).
Avant, les classes sans secret Fly tombaient sur le **fallback global**
`GAINERS_MAX_CHANGE_PCT_LONG` qui les écrasait silencieusement — asia capé à ~12
au lieu de 30 = **edge asia détruit** (bug constaté). Un secret per-class
`GAINERS_MAX_CHANGE_PCT_LONG_<CLASS>` prime toujours sur le défaut.

⚠️ **2e gate** : si asia reste capé après deploy, c'est `GAINERS_OVERPUMP_THRESHOLD_PCT`
(global descending-min sur gate #2) qui mord → setter `GAINERS_OVERPUMP_THRESHOLD_PCT_ASIA=30`.
Vérifier via re-run de l'analyse frontière à l'ouverture Asia (00:00 UTC).

### Venue blacklist STALE_GUARD (`GAINERS_VENUE_BLACKLIST`)

Audit 48 échecs `position_open_failed` STALE_GUARD/24h (source `stale_eodhd`=42) :

| Venue | Échecs | Verdict |
|---|---|---|
| **WAR** (Varsovie) | 23 (48%) | 🔴 **0 trade jamais ouvert** → blacklist (EODHD pas de live Varsovie) |
| LSE | 7 (GABI uniquement) | ⚠️ NE PAS blacklister — EZJ/RPI gagnants sont sur LSE |
| KQ (KOSDAQ) | 5 | ⚠️ NE PAS blacklister — veine prouvée, juste thin stocks |
| AU/SHE/TO | 2-3 chacun | faible couverture EODHD — surveiller, optionnel |

**Recommandation** : `GAINERS_VENUE_BLACKLIST=KO,WAR` (garder KO existant + ajouter WAR).
NE JAMAIS blacklister LSE/KQ (winners). Pas de blacklist par symbole (venue only) —
GABI.LSE reste filtré safe par STALE_GUARD (juste du bruit log).

### Crypto live price = Binance WS + fallback REST (chicken-egg FIXÉ 03/06)

`fetchLivePriceInner` lit `realtimePrice.getCached()` = cache WebSocket Binance.

**CHICKEN-EGG historique (fixé db097ab)** : le WS Binance ne souscrit QUE les
positions crypto **déjà ouvertes** (`lisa-autopilot.updateActiveCryptoSymbols`
lit `lisa_positions WHERE status=open`). Conséquence : un NOUVEAU candidat crypto
(NEAR, OP...) n'avait pas de cache WS → `getLivePrice` tombait en `stale_eodhd`
→ STALE_GUARD bloquait l'open → position jamais ouverte → WS jamais souscrit →
**boucle infinie**. Seuls 2 BNBUSDT ont jamais ouvert (30-31/05), NEAR/OP bloqués.

**Fix** : `fetchLivePriceInner` fait désormais, après cache WS et AVANT EODHD,
un fetch Binance REST direct (`getTicker24h().lastPrice`, `source='binance_rest'`,
non-stale) pour tout symbole convertible en paire Binance (`toBinanceSymbol`
non-null = crypto uniquement ; equities → null → inchangés). Casse la boucle :
les candidats crypto ont enfin un prix frais à l'entrée.

**Binance & Fly** : market data = endpoints PUBLICS (PAS de clé API requise).
Binance EST joignable depuis Fly cdg (BNBUSDT a ouvert avec vrais prix = preuve).
Les clés `BINANCE_API_KEY/SECRET` ne servent QU'à l'exécution réelle
(`BINANCE_EXECUTION_ENABLED`), inutiles en paper. ⚠️ Sandbox locale géo-bloquée
(HTTP 451 IP datacenter) → backtests crypto via Binance impossibles en local,
utiliser EODHD `.CC` (NEARUSDT → NEAR-USD.CC) ou tourner sur Fly.

**Edge crypto NON prouvé** : backtest band-by-band (EODHD .CC, n=155) montre
crypto faible partout (3-8% breakeven, 8-15% perdant). Le fix chicken-egg rend
le crypto *tradable* mais ne prouve pas qu'il *faut* le trader. Refaire un vrai
backtest Binance sur Fly avant d'investir sur le crypto.

### Pattern horaire US (confirmé 03/06)

Creux post-lunch US **17-18h UTC** (13-14h ET) = chop/léthargie → déjà couvert par
`GAINERS_HOUR_BLACKLIST_US_UTC=17,18`. Le marché US **repart ~19h UTC**. Alignement
correct : le système s'abstient 17-18 et reprend 19h automatiquement.

---

## RÈGLE OPÉRATIONNELLE — INVENTAIRE FLY SECRETS (état prod 25/05/2026)

Source de vérité = `fly secrets list -a smartvest`. Cette section documente la
**rationale** des secrets non-évidents, pas leurs valeurs (volatiles).

### `GAINERS_HOUR_BLACKLIST_<CLASS>_UTC` — calibration HourlyEdgeAnalyzer

Heures UTC bloquées par classe×marché, **issues de l'analyse horaire historique
base** (HourlyEdgeAnalyzer). Ne PAS interpréter comme des bugs ni les retirer
sans nouvelle analyse — ce sont des fenêtres identifiées comme historiquement
déficitaires sur ce(s) marché(s).

| Secret | Valeur typique | Raison |
|---|---|---|
| `GAINERS_HOUR_BLACKLIST_US_UTC` | `17,18` | Post-lunch US (13h–14h ET) — chop / lethargy |
| `GAINERS_HOUR_BLACKLIST_ASIA_UTC` | `0,1` | Opening auctions Nikkei (09:00 JST) + Hang Seng (08–09:30 HKT) — volatilité non-directionnelle |
| `GAINERS_HOUR_BLACKLIST_EU_UTC` | (calibré) | Issues même analyse — préserver tel quel |
| `GAINERS_LONG_HOUR_BLACKLIST_UTC` | (calibré global) | Long side global, distinct du per-class |
| `GAINERS_HOUR_GATE_PER_CLASS_OVERRIDES_GLOBAL` | `true` | Per-class blacklist remplace toujours global (cf. fix #11a3051) |

Si l'utilisateur demande à neutraliser ces filtres, **demander confirmation explicite**
— c'est rarement le bon move sans re-analyse historique.

### Catégories de secrets actifs prod

**Core infra** : `SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
`SUPABASE_ANON_KEY`, `SUPABASE_ACCESS_TOKEN` (PAT pour DDL via Management API),
`CORS_ORIGIN`, `ADMIN_TOKEN`, `NO_CACHE`.

**Market data providers** : `EODHD_API_KEY`, `BINANCE_API_KEY`/`BINANCE_SECRET_KEY`,
`TWELVEDATA_API_KEY`, `FRED_API_KEY`. Exécution : `BINANCE_EXECUTION_ENABLED`.

**LLM** : `ANTHROPIC_API_KEY` (Claude Opus persona Lisa), `GEMINI_API_KEY` (Risk
Manager + Opportunity Scout + Daily Brief news), `CLAUDE_MODEL_OPUS`,
`LLM_ROUTER_ENABLED` + `LLM_ROUTER_DAILY_BUDGET_USD` + `LLM_ROUTER_FALLBACK_ON_BUDGET`,
`SCANNER_LLM_ROUTER_ENABLED`.

**Scanner gainers (gating fonctionnel)** :
- Source : `STRATEGY_MODE`, `SCAN_INTERVAL_MINUTES`
- Risque/sizing : `GAINERS_SL_ATR_MULTIPLIER`, `GAINERS_SL_ATR_MAX_PCT`, `GAINERS_MAX_ATR_RATIO_PCT`, `GAINERS_OPEN_BUFFER_MIN`, `GAINERS_MAX_SIGNAL_AGE_SEC`
- Caps : `GAINERS_MAX_CHANGE_PCT_LONG`, `GAINERS_MAX_CHANGE_PCT_LONG_US_LARGE`, `GAINERS_MAX_CHANGE_PCT_LONG_EU`, `GAINERS_MAX_CHANGE_PCT_LONG_ASIA`
- Earnings : `GAINERS_EARNINGS_FILTER_DAYS`
- News : `GAINERS_NEWS_AGE_FILTER_HOURS`, `GAINERS_NEWS_AGE_FILTER_MIN_SENTIMENT`, `GAINERS_CONSUME_DAILY_BRIEF`
- Path qualité : `GAINERS_MIN_PATH_EFFICIENCY_US`
- High-grading & rotation : `GAINERS_HIGH_GRADING_ENABLED`, `GAINERS_CAPITAL_ROTATION_ENABLED`, `GAINERS_PREFERRED_TICKERS_SIZE_MULT`, `GAINERS_LEVERAGED_PROXIES_ENABLED`
- Macro veto : `GAINERS_MACRO_VETO_ENABLED`
- Trailing : `GAINERS_TRAILING_TP_ENABLED`, `GAINERS_TRAILING_STOP_BREAKEVEN_ENABLED`
- Shadow legacy : `GAINERS_V1_SHADOW`

**Risk monitors** (par classe + global Gemini) : `RISK_MONITOR_ENABLED`,
`RISK_MONITOR_ENABLED_US/EU/ASIA/CRYPTO`, `RISK_MONITOR_GEMINI_ENABLED`,
`GEMINI_RISK_MANAGER_ENABLED`.

**Features Tier 1+2** (active toggles 24-25/05) : `EARLY_EXIT_GUARD_ENABLED`,
`MICRO_MOMENTUM_ENABLED`, `MICRO_MOMENTUM_GATE_ENABLED`, `REVERSE_MOMENTUM_MODE`,
`ADAPTIVE_COOLDOWN_ENABLED`, `CORRELATION_GUARD_ENABLED`, `CONVICTION_SIZING_ENABLED`
(+ `CONVICTION_SIZING_MULT_HIGH/LOW`, `CONVICTION_SIZING_SKIP_IF_NEGATIVE`),
`CONTINUOUS_SCORING_ENABLED`, `STAGFLATION_HEDGE_GUARD_ENABLED`,
`CRYPTO_FUNDING_FADE_ENABLED`, `FEATURE_AB_TUNING_ENABLED`,
`DEBATE_GATE_ENABLED` (T1 wired 25/05), `DAILY_RETROSPECTIVE_ENABLED`,
`HOURLY_EDGE_ANALYZER_ENABLED`, `EVENT_ENGINE_ENABLED`,
`EVENT_NARRATIVE_INTERPRETER_ENABLED`, `SYMBOL_ATR_CACHE_REFRESH_ENABLED`.

**A/B testing** (sizing notionnel ÷ max_pos par bucket) : `SIZING_AB_TEST_ENABLED`,
`SIZING_AB_BUCKET_A_NOTIONAL`, `SIZING_AB_BUCKET_A_MAX_POS`,
`SIZING_AB_BUCKET_B_NOTIONAL`, `SIZING_AB_BUCKET_B_MAX_POS`.

**TwelveData filters** (PRO + AB ratio + shadow legacy) : `TWELVEDATA_PRO_ENABLED`,
`TWELVEDATA_AB_TEST_ENABLED`, `TWELVEDATA_INTRADAY_AB_RATIO`,
`TWELVEDATA_INTRADAY_AB_TEST_RATIO`, `TWELVEDATA_INTRADAY_SCANNER_ENABLED`,
`TWELVEDATA_SCANNER_ENABLED`, `TWELVEDATA_FILTER_CRYPTO_RSI_ENABLED`,
`TWELVEDATA_FILTER_US_SUPERTREND_ENABLED` (+ `_SHADOW`),
`TWELVEDATA_FILTER_EU_SUPERTREND_ENABLED` (+ `_SHADOW`),
`TWELVEDATA_FILTER_ASIA_SUPERTREND_ENABLED`.

**Quick Wins pipeline** : `QUICK_WINS_PIPELINE_ENABLED`,
`QUICK_WINS_TWELVEDATA_RSI_CRYPTO`, `QUICK_WINS_TWELVEDATA_SUPERTREND_US_LARGE`,
`QW_7_COOLDOWN_MIN`, `QW_8_MULTIPLIER`.

**Marché/scanner avancé** : `MARKET_SNAPSHOT_CRYPTO_VIA_LIVE_PRICE`,
`MARKET_SNAPSHOT_WEEKEND_SKIP_ENABLED`, `SCANNER_SESSION_AWARE`,
`SCANNER_SCREENER_PAGE_SIZE`, `SCANNER_UNIVERSE_MAX_TICKERS`,
`CRYPTO_SIMULATOR_ENABLED`, `BINANCE_WS_HEALTH_LOG_ENABLED`,
`ENABLE_REACTIVE_EXITS`, `RUN_BACKFILL_POST_SL_ON_BOOT`.

**Other** : `SNIPER_MODE_UNLOCK_CODE` (Section 6 bis), `EODHD_NEWS_PERSIST_ENABLED`,
`EODHD_ECONOMIC_EVENTS_ENABLED`, `GEMINI_DAILY_BRIEF_ENABLED`.

### Secrets explicitement ABSENTS de la prod (à ne pas réintroduire sans raison)

- `TWELVEDATA_FILTER_CRYPTO_RSI_SHADOW` — non setté (PR-shadow non déployé)
- `GAINERS_LIQUIDITY_FAIL_CLOSED` — non setté (mode liquidity policy = open par défaut)
- `GAINERS_CONVICTION_SIZING_ENABLED` — n'existe pas avec ce nom : utiliser `CONVICTION_SIZING_ENABLED` (sans préfixe GAINERS_)

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
