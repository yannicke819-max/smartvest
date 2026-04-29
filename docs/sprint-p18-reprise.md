# Sprint P18 — Point de reprise (2026-04-29)

> **Objectif de ce document** : permettre à Claude (ou tout dev) de reprendre l'état du sprint P18 instantanément au prochain reboot session, sans relire l'historique de chat.

## État de prod (Fly)

| Champ | Valeur |
|---|---|
| Branch HEAD prod | `06b9f836f67560294f22d60aa6ab2656c441d4bc` (PR #86, P18h.1) |
| Fly release | v261 → v262 (un redeploy hors-CI a eu lieu, voir Anomalies) |
| Machine | `d8d4070a719018` (region `cdg` Paris) |
| Endpoints actifs | `/health`, `/version` (publics, pas d'auth) |

## ✅ PRs livrées + déployées

| PR | Commit | Branch | Scope | Tests |
|---|---|---|---|---|
| #76 | (workflow) | `bench/p16-llm-eu-providers` | Bench 6 EU LLM providers, Gemini Flash-Lite vainqueur ($0.00011/prompt, composite 0.66) | bench |
| #77 | `b843851` | `feat/p17-llm-router` | `MultiVendorLlmRouter` + 4 providers gated par `SCANNER_LLM_ROUTER_ENABLED` | 10 |
| #78 | `06d8526` | `feat/p18-router-wiring` | Wire LLM router dans TopGainersScanner (3 call sites: signal/ranking/thesis) | 14 |
| #79 | `972cb60` | `feat/p18b-fly-secrets-bootstrap` | Workflow_dispatch pour push secrets Fly | 0 |
| #80 | `7788c63` | `feat/p18c-eodhd-screener-fix` | EODHD screener URL fix (3 bugs : `change_p`→`refund_1d_p`, `close`→`adjusted_close`, exchange dans filters lowercase) | 11 |
| #82 | `19280dc` | `fix/p18d-eu-equity-scanner` | EU session-aware gating (cac40/dax40/ftse100), close issue #81 | 12 |
| #83 | `7d1f132` | `fix/p18e-mtf-log-throttle-and-prefilter` | MTF log throttle + market pre-filter + cycle skip-summary + 3 compteurs cumulatifs | 14 |
| #85 | `77f4c76` | `feat/p18h-version-endpoint` | `GET /version` controller + Dockerfile build args + fly.yml | 5 |
| #86 | `06b9f83` | `fix/p18h.1-fly-image-ref` | Replace `fly_release_id` (non auto-injecté par Fly) par `fly_image_ref` | 6 |

**Total tests scanner+MTF+version ajoutés : ~72.**

## 🔵 PRs gelées (à reprendre)

| Tag | Scope | Statut |
|---|---|---|
| **P18f** | `LisaAutopilot` Price warmer Binance WS pour `crypto_tradable` (latency improvement crypto) | gelé par instruction utilisateur |
| **P18g** | `lisa_decision_log` payload enrichment (regime + watchlist_source + market fields) | gelé par instruction utilisateur |

## 🐛 Bugs ouverts

| Issue | Sévérité | Description |
|---|---|---|
| [#84](https://github.com/yannicke819-max/smartvest/issues/84) (P19) | medium | `MarketDataScheduler` FK violation `quotes_asset_id_fkey` — 0/2 quote refresh succeeded, suspicion orphan asset_id |

## 📊 Mesures finales (en prod)

| Métrique | Avant sprint | Après sprint | Delta |
|---|---|---|---|
| Volume logs `mtf-persist` / 6m24s | ~677 lignes | 4 lignes agrégées | **−99.4%** |
| Logs legacy spam `<T> no eodhd intraday` | ~30/cycle | **0** (intentionnellement supprimé) | **−100%** |
| Bourses EU scannées | 0 (jamais retenu) | 9 gated session | ✅ activé |
| EODHD HTTP 422 | 13/13 marchés ❌ | 0/17 marchés ✅ | **−100%** |
| LLM router fallback chain | inactif | Gemini Flash-Lite primaire actif | ✅ |
| Endpoint `/version` | inexistant | live, retourne 7 champs | ✅ |
| Fly deploy time (PR → live) | ~5 min | ~3min50s | stable |

## 🔍 Visibilité runtime — `/version`

```bash
curl -s https://smartvest.fly.dev/version | jq
```

Réponse attendue :
```json
{
  "git_sha": "<commit SHA actuel>",       // null si --build-arg pas passé
  "build_time": "<ISO-8601 UTC>",         // null si --build-arg pas passé
  "node_env": "production",
  "fly_image_ref": "registry.fly.io/smartvest:deployment-<hash>",
  "fly_app_name": "smartvest",
  "fly_region": "cdg",
  "fly_machine_id": "<machine id>"
}
```

## ⚠️ Anomalies détectées en fin de sprint

### Anomalie 1 — Deploy hors CI

**Symptôme** : entre `10:46:22Z` et `10:57:20Z` (29/04/2026), `fly_image_ref` a changé de `deployment-01KQCDDVJ0FY1FDA0V47HGHH50` (ULID, build via fly.yml avec --build-arg) à `deployment-ed3dfdae1aaafd6fdeee32e3f7998bc7` (hex, build sans --build-arg). Résultat : `git_sha` et `build_time` sont passés de populés à `null`.

**Cause probable** : `flyctl deploy` manuel direct, ou retry depuis Fly UI bypassant le workflow GitHub Actions.

**Impact** : `/version` partiellement utile — `fly_image_ref` reste populé pour identifier la release, mais le commit SHA est perdu.

**Mitigation suggérée** :
- Documenter dans le runbook : "ne pas utiliser flyctl deploy direct ni Fly UI retry — toujours passer par push to main"
- OU : ajouter un wrapper `scripts/fly-deploy.sh` qui force les `--build-arg` pour les redéploiements manuels

## 🛠️ Architecture évoluée pendant le sprint

1. **`packages/ai-analyst/src/llm/`** — `MultiVendorLlmRouter` + 4 providers (`gemini-provider.ts`, `openai-provider.ts`, `mistral-provider.ts`, `claude-provider.ts`).
2. **`packages/ai-analyst/src/strategies/session-windows.ts`** — helpers `isWithinSession` + `aggregateActiveWatchlists` (réutilisés par P18d).
3. **`apps/api/src/modules/lisa/services/`** :
   - `top-gainers-scanner.service.ts` enrichi (3 call sites LLM, EODHD URL fix, EU session gating, log throttle, 3 compteurs)
   - `multi-tf-persistence.service.ts` (P18e — pre-filter `SUPPORTED_EQUITY_EXCHANGES`, log agrégé, compteurs `noIntradayCounter` + `skippedUnsupportedMarketCounter`)
   - `scanner-llm-router.service.ts` (NestJS wrapper du router, gated par feature flag)
4. **`apps/api/src/modules/version/`** — nouveau module avec `version.controller.ts` (GET /version).
5. **`Dockerfile`** — `ARG GIT_SHA`, `ARG BUILD_TIME` déclarés en builder ET runner stages.
6. **`.github/workflows/fly.yml`** — `flyctl deploy --build-arg GIT_SHA=${{ github.sha }} --build-arg BUILD_TIME=$(date)`.
7. **`.github/workflows/fly-set-router-secrets.yml`** — workflow_dispatch pour push secrets Fly (P18b).

## 📍 Tâches recommandées au prochain reboot

1. **Investiguer l'anomalie 1** (deploy hors CI) — comprendre pourquoi le redeploy a eu lieu, mitigation runbook.
2. **P19** (#84) — fix FK violation `quotes_asset_id_fkey`. Path : log asset_id en violation + cleanup ou guard upsert assets-then-quotes.
3. **P18f** — Binance WS warmer pour `crypto_tradable`.
4. **P18g** — `lisa_decision_log` payload enrichment.

## 📚 Fichiers clés à consulter

- `apps/api/src/modules/lisa/services/top-gainers-scanner.service.ts` (cœur du sprint, 900+ lignes)
- `apps/api/src/modules/lisa/services/multi-tf-persistence.service.ts` (P18e logic)
- `apps/api/src/modules/version/version.controller.ts` (visibility endpoint)
- `CLAUDE.md` (règles opérationnelles permanentes — à lire avant toute modif non triviale)
- Ce document (`docs/sprint-p18-reprise.md`) — état du sprint

---

*Généré automatiquement par Claude à la clôture de la session du 29/04/2026.*
