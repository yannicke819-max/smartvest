# ADR-001 — LLM Architecture (Opus pour décision, Gemini pour le reste)

- **Date** : 2026-04-30
- **Owner** : Yannick (yannicke819-max)
- **Status** : ACCEPTED
- **Supersedes** : `MODEL_BY_TASK` mapping de PATCH 6 P1 cost-01-llm-router (Sonnet/Haiku per-task)

## 1. Décision

L'architecture LLM de SmartVest est figée comme suit :

### 1.1 Anthropic Claude Opus 4.7 — UNIQUEMENT pour la décision finale

- **`thesis_generation`** : génération de thèses Lisa, output JSON structuré, conviction ≥ 8 requis
- Tout autre call site qui touche **directement** à la création/validation d'une proposition de trade

**Justification** : la décision de trade est l'output critique du produit. Une hallucination sur structure JSON, sur stop-loss/take-profit, ou sur asset class casse la chaîne d'exécution downstream (paper-broker → mechanical → realized PnL). La prime de qualité Opus se justifie là, et seulement là.

### 1.2 Google Gemini 2.5 Flash Lite — TOUT LE RESTE

- `regime_classification` (macro state classification)
- `news_classification` (tag sentiment + relevance, ~45 articles/cycle)
- `binary_decision` (close/keep, open/skip, gating non-final)
- `audit_explanation` (narratif humain post-hoc d'une décision)
- `summary` (formatage / résumé sans raisonnement)
- Scanner gainers (signal/ranking/thesis pre-filter — la thèse finale reste Opus)
- Multi-TF analysis enrichments
- Sentiment / news ranking
- Tout autre call LLM ajouté dans le futur, sauf décision finale explicite

**Justification** : pricing Gemini Flash Lite (`$0.10/$0.40` par 1M tokens input/output) est **8× moins cher que Sonnet, 150× moins cher que Opus**. Bench P16 (commit `4928fdc..3a6fc68`) a démontré qualité composite 0.66 sur scanner avec coût $0.00011/prompt, soit -99.3 % vs Claude Sonnet 4.5. Pour les tâches non-décisionnelles, l'écart de qualité est négligeable face au coût.

### 1.3 Modèles INTERDITS

**Plus aucun appel** vers :
- `claude-sonnet-4-6`
- `claude-haiku-4-5-20251001` (et toute version Haiku)
- `gpt-4.1-nano` / OpenAI (était fallback chain P17)
- `codestral-latest` / Mistral (idem)

Code mort à supprimer dans phase 4.

### 1.4 Fallback chain simplifiée

- **Primaire** : Gemini 2.5 Flash Lite (`gemini-2.5-flash-lite`, region `europe-west1`)
- **Fallback ultime** : Claude Opus 4.7 (uniquement si Gemini API down ; pas de fallback intermédiaire)
- **Pas d'OpenAI ni Mistral** dans la chain (simplification — réduire les surface providers)

### 1.5 Cost budget par task

- `thesis_generation` (Opus) : compte vers `lisa_session_configs.daily_cost_budget_usd`
- Toutes autres tasks (Gemini) : tracking séparé, plafond 1/10 du budget Opus (typique <$1/jour)

## 2. Sources

- **Bench P16 (27/04/2026)** : workflow `bench-scanner-eu` (`.github/workflows/bench-scanner-eu.yml`). Gemini Flash-Lite vainqueur, composite 0.66, $0.00011/prompt.
  - Commits : `b9fe782`, `f0e33c0`, `a56fb34`, `38d0777`, `3a6fc68`
- **Commit P17 (29/04/2026 06:38 UTC)** : `e2f2594` `feat(p17): LLM router multi-vendor avec fallback chain (Gemini → GPT → Codestral → Claude)`. Spec originale validée.
- **`docs/sprint-p18-reprise.md`** ligne 51 : `LLM router fallback chain | inactif | Gemini Flash-Lite primaire actif | ✅`. Intention prod déclarée.
- **Commit P18 (29/04/2026)** : `8385f6e` `feat(p18): wire LLM router into TopGainersScanner`. Wiring fait, flag jamais activé en prod.
- **Audit session 30/04/2026 (Claude)** : trouvé que `MODEL_BY_TASK` (Sonnet/Haiku) défini dans `packages/ai-analyst/src/llm/router.ts:62-68` mais **0 call site runtime** réel. Code mort.

## 3. Conséquences

### 3.1 Positives

- **Coût** : ~$30-50/mois sur tâches non-décisionnelles (Gemini Flash Lite) vs ~$200-400/mois si on câblait Sonnet/Haiku per la spec PATCH 6 → **-80-90%**
- **Souveraineté EU** : Gemini Flash Lite déployé `europe-west1`, RGPD-friendly
- **Simplification chain** : 1 provider primaire + 1 fallback (vs 4 providers P17), moins de surface de bug
- **Clarté architecturale** : règle simple "Opus = décision, Gemini = reste"

### 3.2 Risques

- **Risque qualité** : Gemini sur regime_classification / binary_decision pas benché spécifiquement (P16 a benché scanner uniquement). Mitigation : feature flag par task, rollback rapide vers Opus si dégradation observable
- **Risque d'API** : dépendance à 2 providers (Anthropic + Google). Si Google down, fallback Opus prend le relais à coût élevé temporaire
- **Risque éditeur** : Google peut changer pricing/availability Gemini Flash Lite. Veille trimestrielle requise

### 3.3 Implémentation par phases

| Phase | Scope | PR | Status |
|---|---|---|---|
| **Phase 0** | ADR-001 (ce document) | commit `a55de24` direct main | ✅ |
| **Phase 1** | Scanner gainers Gemini-primaire + flag activé en prod | PR #148 squash `8bc094d` | ✅ |
| **Phase 2** | Cleanup `LlmRouter` multi-task : `LlmTask` réduit à `'thesis_generation'`, `MODEL_BY_TASK` à 1 entrée Opus, `COST_PER_1M_TOKENS_*` à Opus only, fallback Haiku 80%/100% supprimé (remplacé par soft-warn + continue Opus), `ClaudeProvider` basé sur Opus (était Sonnet) per ADR §1.4. **Note** : aucun call site `news_classification`/`summary` câblé runtime — pas de migration, juste suppression de code mort + correction du fallback Haiku cassé après Phase 1 unset. | PR `feat/llm-arch-phase2-cleanup-dead-code` | ⏳ |
| **Phase 3** | regime_classification + binary_decision + audit_explanation → Gemini si call sites apparaissent ; sinon **NO-OP** (déjà supprimés en Phase 2) | n/a | ☑️ inclus dans Phase 2 |
| **Phase 4** | Cleanup `OpenAiProvider` + `MistralProvider` classes (code mort dans `@smartvest/ai-analyst/src/llm/providers/`) | PR dédiée | ⏳ |

## 4. Migration sans downtime

Chaque phase est un **toggle réversible** :
- Phase 1 : `SCANNER_LLM_ROUTER_ENABLED=true` (rollback : `=false`)
- Phase 2 : pas de flag (cleanup code mort, pas de feature toggle). Rollback = `git revert`
- Phase 3 : NO-OP (subsumé par Phase 2). Si futur call site Gemini ajouté, il passera par `MultiVendorLlmRouter`, pas par `LlmRouter`
- Phase 4 : suppression code, plus de toggle. À ce stade, validation 7+ jours prod nécessaire

## 5. Annexes

### 5.1 Pricing comparatif (snapshot 30/04/2026)

| Modèle | Input $/1M | Output $/1M | Ratio vs Opus |
|---|---|---|---|
| Claude Opus 4.7 | $15 | $75 | 1× (référence) |
| ~~Claude Sonnet 4.6~~ | ~~$3~~ | ~~$15~~ | -80% (interdit) |
| ~~Claude Haiku 4.5~~ | ~~$0.80~~ | ~~$4~~ | -95% (interdit) |
| **Gemini 2.5 Flash Lite** | **$0.10** | **$0.40** | **-99.3% / -99.5%** |

### 5.2 Volumes estimés

- **`thesis_generation`** (Opus) : ~80 cycles/jour × 12k input + 3k output = ~36M tokens/mois → ~$596/mois (avec prompt caching -90%)
- **Tout reste** (Gemini) : ~250M tokens/mois cumulé → ~$25-50/mois

### 5.3 Feature flags Fly secrets

| Flag | Default | Effet |
|---|---|---|
| `ANTHROPIC_API_KEY` | (set) | requis Opus + fallback ultime |
| `GEMINI_API_KEY` | **à set Phase 1** | requis pour tout sauf thesis |
| `SCANNER_LLM_ROUTER_ENABLED` | `false` → `true` Phase 1 | active routing scanner |
| ~~`NEWS_LLM_PROVIDER`~~ | (Phase 2 a supprimé l'enum multi-task — flag inutile, pas de call site à toggler) | n/a |
| ~~`REGIME_LLM_PROVIDER`~~ | (idem) | n/a |
| ~~`BINARY_LLM_PROVIDER`~~ | (idem) | n/a |
| ~~`AUDIT_LLM_PROVIDER`~~ | (idem) | n/a |
| ~~`OPENAI_API_KEY`~~ | (à unset Phase 4) | code mort |
| ~~`MISTRAL_API_KEY`~~ | (à unset Phase 4) | code mort |
| ~~`CLAUDE_MODEL_SONNET`~~ | (à unset Phase 4) | code mort |
| ~~`CLAUDE_MODEL_HAIKU`~~ | (à unset Phase 4) | code mort |

## 6. Ne pas dériver

> **Règle d'or** : tout nouveau call LLM dans le code DOIT décider explicitement Opus (décision) ou Gemini (reste). Aucun appel direct à `anthropic.messages.create` en dehors de `thesis_generation`. Aucun appel direct au SDK Google sans passer par `MultiVendorLlmRouter`.

Toute PR qui dérive de cette règle doit citer explicitement cet ADR-001 et justifier l'exception.

---

**Validation** : Yannick (yannicke819-max) — 30/04/2026
