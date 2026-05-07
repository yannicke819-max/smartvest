# PRD — SmartVest LIVE Trading via IBKR + Binance (LLC Delaware)

**Date** : 2026-05-07
**Status** : Draft — pending stakeholder approval
**Owner** : geckoai.app LLC (Delaware)
**Lead** : claude code agent + user
**Target deploy** : T+6 semaines après merge PRD (~mi-juin 2026)

---

## 1. Contexte & Objectif

SmartVest tourne aujourd'hui en **paper trading** (PaperBroker simulé). Le scanner gainers + Lisa LLM ouvre/ferme des positions virtuelles dans `lisa_positions`, calcule un PnL théorique avec `cost-engine`.

Objectif : **basculer vers du trading réel** sur un compte LLC Delaware (geckoai.app), sans casser le mode paper et sans relâcher les garde-fous de l'autonomie (cf. CLAUDE.md §6 ter).

### Volumétrie cible

```
Capital initial LIVE      : $10k
Position size moyenne     : $200-400 ($200/jour × 250j = $50k/an)
Cible gains annuels       : $50-100k
Trades/jour estimés       : 5-10 (scalping intraday)
Markets cibles            : US (NYSE/NASDAQ) + EU (LSE/XETRA/PA) + Asia (KRX/KOSDAQ/SSE/SZSE) + Crypto majors
```

### Hors scope (deferred)

- Order types complexes (OCO, brackets, trailing stops broker-side) — V2
- Options trading — V3
- Margin trading — non envisagé
- Mobile app native — pas de scope mobile
- Multi-comptes (autre user qu'admin) — V2

---

## 2. Architecture overview

```
┌──────────────────────────────────────────────────────────────────┐
│                       SmartVest API                              │
│                                                                  │
│   ┌──────────────┐    ┌──────────────────┐  ┌─────────────┐      │
│   │ TopGainers   │───▶│ Pre-execution    │─▶│ BrokerAdapter│     │
│   │ Scanner      │    │ Guard chain      │  │ (interface) │      │
│   └──────────────┘    └──────────────────┘  └─────┬───────┘      │
│                              │                    │              │
│                              ▼                    ▼              │
│                       ┌──────────────┐    ┌──────────────┐       │
│                       │ AutonomyMandate│  │ PaperBroker  │       │
│                       │ kill-switch    │  │ (simu)       │       │
│                       │ daily caps     │  └──────────────┘       │
│                       └──────────────┘                           │
└──────────────────────────────────────────────────────────────────┘
                                                  │
                                                  ▼
                                      ┌──────────────────────┐
                                      │ IBKRAdapter (NEW)    │
                                      │ ├── REST Client      │
                                      │ ├── WebSocket fills  │
                                      │ └── Order tracking   │
                                      ├──────────────────────┤
                                      │ BinanceAdapter (NEW) │
                                      │ ├── Spot trade API   │
                                      │ ├── User Data Stream │
                                      │ └── My Trades        │
                                      └──────────────────────┘
                                                  │
                                                  ▼
                                ┌──────────────────────────────────┐
                                │ Reconciliation Service (NEW)     │
                                │ ├── Cron 5min : compare DB vs    │
                                │ │   broker positions             │
                                │ ├── Drift detection → kill-switch│
                                │ └── Audit log                    │
                                └──────────────────────────────────┘
```

### Flow d'un trade LIVE

```
1. Scanner détecte candidat A+ (BLDP.US, score=1.0, persistence=6/6)
2. Pre-execution guard chain valide :
   - DELEGATION_AUTONOMOUS_GUARDED=true
   - AutonomyMandate actif + valide
   - BROKER_EXECUTION_ENABLED=true
   - BROKER_ADAPTER_IBKR_ENABLED=true
   - AUTONOMY_KILL_SWITCH=false
   - daily_traded_amount < daily_cap_usd
   - position_size < max_position_size_pct × portfolio
3. brokerAdapter.placeOrder({symbol: 'BLDP', qty: 10, side: 'BUY', type: 'MARKET'})
4. IBKR retourne orderId → INSERT lisa_positions status='pending_fill'
5. WebSocket fill notification → UPDATE status='open' + actual_fill_price + actual_commission
6. Mechanical service surveille SL/TP → trigger
7. brokerAdapter.placeOrder(side='SELL') → close position
8. Reconciliation cron 5min vérifie cohérence broker vs DB
```

---

## 3. Phases d'implémentation

Découpage incrémental — chaque phase **mergeable indépendamment**, **back-compat préservée** (paper continue de fonctionner pendant tout le développement).

### Phase A — Foundations (Semaine 1)

**Migration 0128** :
- `broker_connections` (déjà existe via #6 ter, vérifier schéma)
- `broker_orders` table : tracking orderId broker, status, fills, commissions
- `broker_reconciliation_log` table : audit hash-chaîné des comparaisons DB↔broker

**Code** :
- Interface `BrokerAdapter` étendue (déjà partielle dans `packages/brokers/`)
  - `placeOrder()` / `cancelOrder()` / `getOrderStatus()`
  - `getPositions()` / `getAccountBalance()` / `getMyTrades()`
- Type `BrokerOrderEvent` (FILL / PARTIAL_FILL / REJECTED / CANCELED)
- `BrokerConnectionService` (lecture credentials Vault, rotation)

**Feature flags ajoutés** :
- `BROKER_EXECUTION_ENABLED=false` (master gate)
- `BROKER_ADAPTER_IBKR_ENABLED=false`
- `BROKER_ADAPTER_BINANCE_ENABLED=false`
- `BROKER_RECONCILIATION_ENABLED=false`

**Acceptance** : tests unitaires interface, aucun comportement runtime modifié, paper continue.

---

### Phase B — IBKR Adapter (Semaines 2-3)

**Code** :
- `IBKRAdapter` complet :
  - REST Client (TWS API ou Client Portal Web API)
  - Auth flow OAuth2 (Client Portal) ou client cert (TWS)
  - `placeOrder()` → market/limit avec gestion currency (EUR/USD/HKD/KRW...)
  - WebSocket pour fills temps réel (tickByTick + executionDetails)
  - Mapping symboles SmartVest ↔ IBKR (`AAPL.US` → `AAPL@SMART/USD`)
- Gestion **multi-currency** : balance USD/EUR/HKD/KRW... portfolio.usd_value calculé via FX live
- Retry logic + circuit breaker (similaire YahooIntradayService PR #268)

**Tests** :
- Mock IBKR REST + WebSocket
- Sandbox IBKR paper trading account (gratuit, 1M USD virtuel) pour tests intégration
- Reproduire les 4 SL chains de cette nuit en sandbox → vérifier que les guards bloquent

**Acceptance** :
- Adapter compile + tests passent
- Sandbox IBKR : ouvre 10 positions test, observe fills, ferme
- `BROKER_ADAPTER_IBKR_ENABLED=true` mais `BROKER_EXECUTION_ENABLED=false` → adapter dispo mais inert

---

### Phase C — Binance Adapter (Semaine 4)

**Code** :
- `BinanceAdapter` (extension du wrapper read-only existant) :
  - `placeOrder()` → SPOT trade endpoint
  - WebSocket User Data Stream → balance + position updates
  - `MyTrades` endpoint pour reconciliation fills
- Gestion testnet → mainnet flag
- Mapping `BTC-USD.CC` ↔ `BTCUSDT`

**Tests** :
- Binance Testnet (gratuit) pour tests intégration
- Reproduire 5 trades crypto en testnet

**Acceptance** : adapter compile + sandbox testnet OK + fills tracking fonctionnel.

---

### Phase D — Pre-execution Guard Chain (Semaine 4-5)

**Code** :
- `PreExecutionGuardService` :
  - Vérifie ALL conditions avant placeOrder (cf. flow §2)
  - Throw `BrokerExecutionBlockedException` avec raison explicite
  - Audit `lisa_decision_log` chaque blockage
- Intégration dans `paper-broker.service.ts` :
  - Si `BROKER_EXECUTION_ENABLED=true` → délégué à BrokerAdapter
  - Sinon → comportement paper actuel (back-compat)

**Garde-fous additionnels** :
- `daily_traded_notional_usd_today` tracker en mémoire + DB
- `max_open_positions_live` séparé du paper (ex : paper=5, live=2)
- `kill_switch_propagation` : kill-switch UI → cancel tous les open orders broker

**Tests** :
- 12 specs guard chain :
  - 1 par condition de gate
  - 2 multi-condition
  - 3 race conditions (kill-switch pendant placeOrder)

**Acceptance** : tous les gates testés, pas de bypass possible.

---

### Phase E — Reconciliation Service (Semaine 5)

**Code** :
- `BrokerReconciliationService` :
  - Cron toutes les 5 min (`@Cron('*/5 * * * *')`)
  - Pour chaque portfolio en mode LIVE :
    - Fetch broker positions
    - Compare avec `lisa_positions` (status='open')
    - Détecte 3 types de drift :
      - Position broker manquante côté DB → INSERT manquante
      - Position DB manquante côté broker → ALERT + kill-switch
      - Quantity/price mismatch → ALERT
  - Cas extrême : drift détecté → AUTONOMY_KILL_SWITCH activé automatiquement
- Logs hash-chaînés dans `broker_reconciliation_log` (append-only, audit)

**Tests** :
- Mock 3 scénarios drift
- Test edge case : broker down (timeout) → grace period 15 min puis alert

**Acceptance** : drift détecté en < 5 min, kill-switch fired si critique.

---

### Phase F — Real Costs Calibration (Semaine 5)

**Code** :
- Nouvelles colonnes `lisa_positions` (migration 0129) :
  - `actual_entry_fees_usd NUMERIC(28,4)`
  - `actual_exit_fees_usd NUMERIC(28,4)`
  - `actual_slippage_bps INT` (entry vs theoretical mid-price)
  - `broker_order_id_entry TEXT`
  - `broker_order_id_exit TEXT`
- `RealCostCalibratorService` :
  - À chaque close, compare `cost-engine` théorique vs broker actual
  - Log écart > 10% pour calibration manuelle des coefficients
- Dashboard admin : "Theoretical vs actual fees over 30 days"

**Acceptance** : 50+ trades LIVE → écart moyen calibré < 5%.

---

### Phase G — UI LIVE controls (Semaine 6)

**Code** :
- Nouvelle section `/lisa` "Mode trading" :
  - Toggle `MODE: paper | live` (gated par `BROKER_EXECUTION_ENABLED`)
  - Affichage AutonomyMandate actif (caps, expiration)
  - Bouton "Kill switch" toujours visible (jamais gated)
  - Bouton "Bascule paper" (revert vers paper sans tout perdre)
- Page `/settings/brokers` :
  - Form connexion IBKR (clés API → Vault)
  - Form connexion Binance
  - Status connexion (connecté/déconnecté/erreur)
  - Liste open orders broker live (lecture seule)

**Tests** : E2E Playwright sur les flows toggle paper↔live + kill-switch.

---

### Phase H — Bascule LIVE progressive (Semaine 6+)

**Plan déploiement** :
1. **T0** : Phase A-G mergées, `BROKER_EXECUTION_ENABLED=false` → tout en paper, infrastructure prête
2. **T+3j** : Active IBKR sandbox → 30 trades simulés, 0 erreur tracking
3. **T+7j** : Bascule LIVE micro avec `AutonomyMandate` ultra-serré :
   ```
   maxPositionSizePct=2%        ($200/trade max)
   maxSingleTradePct=2%
   maxDailyTradePct=10%         ($1000/jour max)
   forbiddenTickers=[NSE,BSE]
   stopLossTriggerPct=5%        (drawdown portfolio = pause auto)
   expiresAt=T+30j
   ```
4. **T+30j** : Si zéro incident + expectancy positive → relâche caps (5% pos, 20% daily)
5. **T+60j** : Full deploy mandate normal (5% pos, 30% daily, expires renouvelé)

---

## 4. Garde-fous obligatoires (immuables)

Conditions cumulatives pour qu'un `placeOrder()` réel s'exécute (cf. CLAUDE.md §6 ter chaîne de garde) :

```
✅ DELEGATION_AUTONOMOUS_GUARDED=true
✅ AutonomyMandate actif + valide :
   - expiresAt > NOW()
   - killSwitchActive=false
   - position size < maxPositionSizePct × portfolio
   - position size < maxSingleTradePct × portfolio
   - daily traded < maxDailyTradePct × portfolio
   - asset_class ∈ allowedAssetClasses
   - ticker NOT IN forbiddenTickers
   - notional < requiresHumanAbovePct → sinon attente validation manuelle
   - portfolio drawdown < stopLossTriggerPct
✅ BROKER_EXECUTION_ENABLED=true
✅ BROKER_ADAPTER_<X>_ENABLED=true
✅ AUTONOMY_KILL_SWITCH=false
✅ Reconciliation last drift < 5 min
✅ Broker connection healthy (last ping < 60s)
```

**Si ANY condition fail** → ordre rejeté + audit `lisa_decision_log` kind=`broker_execution_blocked`.

**Kill-switch UI** : toujours visible, **jamais** gated par feature flag. 1 clic →
1. `AUTONOMY_KILL_SWITCH=true`
2. Cancel tous les open orders sur tous les brokers connectés
3. Audit hash-chaîné de la séquence

---

## 5. Sécurité & Compliance

### Credentials brokers (cf. CLAUDE.md §6 ter)

- **Stockage** : Supabase Vault uniquement. JAMAIS en DB en clair, JAMAIS en logs.
- **Exposition API** : `GET /brokers/connections` retourne uniquement `{id, provider, label, status, last_sync_at}` (jamais `credentials_vault_ref`).
- **Rotation** : nouveau secret + suppression ancien après commit DB.
- **Révocation** : `DELETE /brokers/connections/:id` toujours dispo, jamais gated.

### Fiscalité (info, hors scope code)

- LLC Delaware **geckoai.app** dépose **W-8BEN-E** chez IBKR + Binance
- Claim treaty France-US (1994) :
  - Withholding dividendes 30% → 15%
  - Withholding intérêts 30% → 0%
  - Plus-values trading : pas de withholding US, taxées en France au PFU 30% (ou IS si geckoai.app opte pour C-Corp)
- IBKR fournit Annual Statement IRS-ready
- CPA français requis pour intégration BIC/BNC dans la déclaration de geckoai.app

### Audit & traçabilité

- Toute action LIVE écrit dans `broker_orders` (append-only) + `lisa_decision_log` (hash-chaîné)
- Reconciliation logs append-only `broker_reconciliation_log`
- Pas de delete possible sur ces tables (RLS + DB-level constraint)

---

## 6. Tests strategy

| Niveau | Outils | Coverage cible |
|---|---|---|
| Unit | Jest + mocks broker | 90% code coverage IBKRAdapter / BinanceAdapter / GuardService |
| Integration | IBKR Sandbox + Binance Testnet | 30 trades successful round-trip / broker |
| E2E | Playwright | 5 scénarios UI (toggle, kill-switch, drift detection, broker error, mandate expiration) |
| Load | Artillery | 100 placeOrder/min sustained 10 min sans dégradation |
| Chaos | Manuel | Coupure réseau pendant fill, kill-switch race, mandate expiration mid-trade |

---

## 7. Dépendances externes

- **IBKR Pro account ouvert pour geckoai.app LLC** (5-10 jours onboarding)
  - Documents : Operating Agreement, Articles of Organization Delaware, EIN, W-8BEN-E, beneficial owners W-8BEN
  - Capital initial recommandé : $10k (Pro tier API)
- **Binance.US ou Binance.com** account business pour LLC (3-5 jours KYC)
- **CPA français** pour intégration fiscale (à choisir)
- Vault Supabase opérationnel (déjà en place)

---

## 8. Risques & mitigations

| Risque | Impact | Probabilité | Mitigation |
|---|---|---|---|
| IBKR API rate limit pendant burst trade | Trade rejeté | Modérée | Queue interne + retry exponential backoff |
| WebSocket fill notification dropped | Position status incohérent | Faible | Reconciliation 5min rattrape |
| Drift broker vs DB > $1k | Capital fantôme | Faible | Auto kill-switch + alert immédiat |
| LLC fiscal qualification "abus de droit" | Redressement FR | Très faible (geckoai.app a substance) | Documentation activité B2B + facturation IA apps |
| Slippage > 1% sur ordres market sur stocks petites caps | Pertes inattendues | Modérée | Limit orders en priorité, market en fallback uniquement |
| Bug code → ordre erroné LIVE | Perte capital | Faible (tests) | Mandate caps stricts T+0 → T+30j puis relâche progressive |
| IBKR account froid (pas Pro tier) | API limitée | Faible | $10k déposés dès onboarding |

---

## 9. Open questions (à résoudre avant Phase A)

1. **IBKR API choix** : TWS REST (port 4001) vs Client Portal Web API (cloud) ?
   - TWS = nécessite IB Gateway running 24/7 (sur Fly ou VPS dédié)
   - CP Web API = OAuth, pas de gateway, mais latence ~200ms vs ~50ms TWS
   - **Reco** : démarrer Client Portal Web API (simpler ops), migrer TWS si besoin latence
2. **Binance.com vs Binance.US** pour LLC Delaware ?
   - Binance.com : meilleur orderbook, plus de pairs
   - Binance.US : compliance US clean (préférable pour LLC Delaware)
   - **Reco** : Binance.US pour LLC, Binance.com en backup perso
3. **Notification utilisateur** : email vs SMS vs Telegram quand fill / SL hit / kill-switch ?
   - Hors scope V1 — on log dans decision_log, le user check le dashboard

---

## 10. Acceptance criteria globaux (Go/No-Go LIVE)

Avant T+7j (bascule LIVE micro) :

- [ ] Phases A-G mergées sur main
- [ ] 30 trades sandbox IBKR sans erreur tracking
- [ ] 30 trades testnet Binance sans erreur tracking
- [ ] Reconciliation 0 drift sur 7 jours sandbox
- [ ] Kill-switch testé manuellement (cancel all orders en < 2s)
- [ ] AutonomyMandate strict configuré + signé par owner
- [ ] CPA français consulté pour structure fiscale
- [ ] $10k déposés sur IBKR LLC + sur Binance LLC

---

## 11. Suivi

- **Branche** : `feat/ibkr-live-trading-prd-v1` (cette PR)
- **Suivi journalier** : commentaires dans cette PR + decision_log
- **Stand-up async** : update status à chaque phase mergée
- **Go/No-Go T+7j** : checkpoint formel avec stakeholder

---

_Document vivant — toute modification structurelle requiert update du PRD avant implémentation._
