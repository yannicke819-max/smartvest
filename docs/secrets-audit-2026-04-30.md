# Secrets audit — SmartVest prod (30/04/2026)

Inventaire exhaustif des secrets référencés dans le code (`process.env.*` +
`ConfigService.get('*')`), avec criticité, plateforme cible, usage et URL de
génération si manquant.

**Source de l'inventaire** : `grep -rE "process\.env\.[A-Z_]+|configService\.get\(['\"]"`
sur tout le repo le 30/04/2026.

**Statut "Présent ?"** : reflète l'état Fly post-merge ADR-001 Phase 1+2+4
(commits `8bc094d` + `d8f820a` + `0ed99e9`). User a confirmé via UI Fly les
actions secrets (set `SCANNER_LLM_ROUTER_ENABLED=true`, unset des 4 interdits
ADR-001 §1.3 : `OPENAI_API_KEY`, `MISTRAL_API_KEY`, `CLAUDE_MODEL_SONNET`,
`CLAUDE_MODEL_HAIKU`).

Pour re-vérifier l'état actuel : `flyctl secrets list -a smartvest` + run
`pnpm tsx scripts/test-secrets.ts` avec env Fly chargée (cf. §6.3).

---

## 1. P0 — Secrets bloquants (système ne démarre pas / mode dégradé inacceptable)

| Secret | Plateforme | Présent | Usage 1 ligne | URL génération si manquant |
|---|---|---|---|---|
| `ANTHROPIC_API_KEY` | Fly | ✅ | Lisa thesis_generation Opus 4.7 + scanner fallback ultime ADR-001 | https://console.anthropic.com/settings/keys |
| `GEMINI_API_KEY` | Fly | ✅ | Scanner LLM router primaire (Gemini 2.5 Flash Lite) ADR-001 Phase 1 | https://aistudio.google.com/apikey |
| `EODHD_API_KEY` | Fly | ✅ | Cotations US/EU/Asia, fundamentals, news (toutes données marché) | https://eodhd.com/cp/dashboard |
| `SUPABASE_URL` | Fly | ✅ | Backend Postgres + storage | https://supabase.com/dashboard/project/_/settings/api |
| `SUPABASE_SERVICE_ROLE_KEY` | Fly | ✅ | Backend RLS-bypass writes/cron/admin | idem |
| `SCANNER_LLM_ROUTER_ENABLED` | Fly | ✅ `true` | Toggle Phase 1 ADR-001 (PR #148 merged `8bc094d`) | n/a (booléen) |
| `NEXT_PUBLIC_SUPABASE_URL` | Vercel | ✅ | Front Next.js client Supabase auth | dashboard URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Vercel | ✅ | Front Supabase auth anon (RLS-protected) | dashboard URL |
| `NEXT_PUBLIC_API_URL` | Vercel | ✅ | Front → backend Fly URL | n/a (`https://smartvest.fly.dev`) |

## 2. P1 — Secrets importants (feature majeure dégradée si absent)

| Secret | Plateforme | Présent | Usage 1 ligne | URL génération si manquant |
|---|---|---|---|---|
| `SUPABASE_ACCESS_TOKEN` | GitHub Actions | ✅ (PAT `smartvest-fly-migrations`, exp. 30/05/2026) | Workflow `apply-migrations` Supabase Mgmt API | https://supabase.com/dashboard/account/tokens |
| `SUPABASE_PROJECT_REF` | GitHub Actions | ✅ `mfuutigfhrawccotinpo` | Target project ref pour le workflow | dashboard URL `…/project/<ref>` |
| `FLY_API_TOKEN` | GitHub Actions | ✅ | Deploy auto sur push main | `flyctl auth token` |
| `ADMIN_TOKEN` | Fly | ✅ | Header `x-admin-token` sur `/admin/*` (eodhd-status, logs) | rotation manuelle (UUID v4) |
| `FRED_API_KEY` | Fly | ⚠️ **MANQUANT** (P1 dégradé — feature macro indicators OFF, en cours de provisioning user) | Macro indicators St. Louis Fed (régime US) | https://fred.stlouisfed.org/docs/api/api_key.html |

## 3. P2 — Secrets optionnels (feature mineure ou feature flag-gated off)

| Secret | Plateforme | Présent | Usage 1 ligne | URL génération si manquant |
|---|---|---|---|---|
| `SNIPER_MODE_UNLOCK_CODE` | Fly | ? | Code `/sniper/unlock` (P2 tant que `FEATURE_SNIPER_MODE_ENABLED=false`) | rotation manuelle |
| `BINANCE_API_KEY` | Fly | ? | Crypto exec (off tant que `BINANCE_EXECUTION_ENABLED=false`) | https://www.binance.com/en/my/settings/api-management |
| `BINANCE_SECRET_KEY` | Fly | ? | idem | idem |
| `REDDIT_CLIENT_ID` | Fly | ? | News Reddit OAuth (fallback RSS auto si absent) | https://www.reddit.com/prefs/apps |
| `REDDIT_CLIENT_SECRET` | Fly | ? | idem | idem |
| `TWITTER_BEARER_TOKEN` | Fly | ? | Sentiment X/Twitter v2 (optionnel) | https://developer.x.com/en/portal/dashboard |
| `SENTRY_DSN` | Fly + Vercel | ? | Observability error tracking | https://sentry.io/settings/projects/_/keys/ |

## 4. P3 — Secrets INTERDITS (ADR-001 §1.3 — unset done)

| Secret | Plateforme | Présent | Statut |
|---|---|---|---|
| `OPENAI_API_KEY` | Fly | ❌ absent | ✅ unset par user (Phase 1) — code provider supprimé Phase 4 PR #150 (`0ed99e9`) |
| `MISTRAL_API_KEY` | Fly | ❌ absent | ✅ unset par user (Phase 1) — code provider supprimé Phase 4 PR #150 |
| `CLAUDE_MODEL_SONNET` | Fly | ❌ absent | ✅ unset par user (Phase 1) — Sonnet hors `MODEL_BY_TASK` Phase 2 PR #149 (`d8f820a`) |
| `CLAUDE_MODEL_HAIKU` | Fly | ❌ absent | ✅ unset par user (Phase 1) — Haiku hors `MODEL_BY_TASK` Phase 2 PR #149 |

Le script `scripts/test-secrets.ts` traite l'absence de ces 4 secrets comme
**OK** (conforme ADR-001) et leur présence comme **FAIL** (regression check).

## 5. Variables non-secret (tunables, à laisser default sauf besoin spécifique)

Variables référencées dans le code mais qui sont des **tunables runtime**, pas
des secrets. Pas besoin de les set en prod sauf override délibéré :

`API_PORT`, `PORT`, `NODE_ENV`, `BUILD_TIME`, `GIT_SHA`, `FLY_*` (auto),
`STRATEGY_MODE`, `SCAN_INTERVAL_MINUTES`, `MAX_CONCURRENT_REBOUND_POSITIONS`,
`REBOUND_UNIVERSE`, `REBOUND_WATCHLIST`, `REBOUND_SECTOR_CAP_PCT`,
`REBOUND_PREFILTER_RSI_MAX`, `OHLCV_FETCH_RPS`, `HARVEST_POLL_MS`,
`DAILY_TARGET_USD`, `CASH_BUFFER_USD_OVERRIDE`, `USD_EUR_RATE`,
`GAINERS_PERSISTENCE_TOP_N`, `GAINERS_MIN_PERSISTENCE_SCORE`,
`HORS_TRAJ_DRAWDOWN_THRESHOLD_PCT`, `HORS_TRAJ_COST_SHARE_THRESHOLD`,
`MULTITF_PAUSE`, `SCANNER_PAUSE`, `MECH_DEGRADED_MODE`,
`MECH_DEGRADED_WHITELIST`, `LLM_ROUTER_DAILY_BUDGET_USD`,
`LLM_ROUTER_FALLBACK_ON_BUDGET`, `EODHD_MONTHLY_COST_USD`,
`FEES_AWARE_BUFFER`, `SNIPER_MODE_TTL_MINUTES`,
`FEATURE_*` flags (tous documentés dans `.env.example`).

---

## 6. Procédure de set en une commande (à exécuter par opérateur)

### 6.1 Activer Phase 1 ADR-001 + cleanup interdits

```bash
# Set Phase 1 toggle
flyctl secrets set SCANNER_LLM_ROUTER_ENABLED=true -a smartvest

# Cleanup ADR-001 Phase 4 (anticipé)
flyctl secrets unset OPENAI_API_KEY MISTRAL_API_KEY CLAUDE_MODEL_SONNET CLAUDE_MODEL_HAIKU -a smartvest
```

### 6.2 Si secrets P0 manquants (bootstrap from-scratch)

```bash
flyctl secrets set \
  ANTHROPIC_API_KEY=sk-ant-... \
  GEMINI_API_KEY=AIza... \
  EODHD_API_KEY=... \
  SUPABASE_URL=https://<ref>.supabase.co \
  SUPABASE_SERVICE_ROLE_KEY=eyJ... \
  SCANNER_LLM_ROUTER_ENABLED=true \
  -a smartvest
```

### 6.3 Run smoke test post-deploy

```bash
# Charger l'env Fly localement (read-only via SSH)
flyctl ssh console -a smartvest -C 'env' > /tmp/fly.env
set -a; source /tmp/fly.env; set +a
pnpm tsx scripts/test-secrets.ts
```

Exit code 0 = tous P0 OK. Exit code 1 = ≥1 P0 KO (bloquant).

---

## 7. Snapshot Fly/Vercel/GitHub (à coller par opérateur)

### 7.1 Fly secrets (`flyctl secrets list -a smartvest`)

```
<coller la sortie ici>
```

### 7.2 Vercel env (`vercel env ls`)

```
<coller la sortie ici>
```

### 7.3 GitHub Actions secrets (`gh secret list -R yannicke819-max/smartvest`)

```
<coller la sortie ici>
```

### 7.4 Smoke test output (`pnpm tsx scripts/test-secrets.ts`)

```
<coller la sortie tableau ici>
```

---

## 8. Sandbox Claude — limites connues

Le sandbox sur lequel tourne claude/review-repo-docs-f7qBN n'a **aucun** des
binaires suivants disponibles : `flyctl`, `fly`, `vercel`, `gh`. Aucune des
variables `FLY_API_TOKEN`, `VERCEL_TOKEN`, `GH_TOKEN`, `ANTHROPIC_API_KEY`,
`GEMINI_API_KEY`, `EODHD_API_KEY` n'est exposée.

→ Toute interaction live avec Fly/Vercel/GitHub Actions doit passer par
l'opérateur humain. Le script `scripts/test-secrets.ts` est conçu pour être
exécuté **en local** ou **en SSH sur la machine Fly** avec l'env chargée.

---

**Owner** : Yannick (yannicke819-max)
**Last update** : 2026-04-30 par claude/review-repo-docs-f7qBN
