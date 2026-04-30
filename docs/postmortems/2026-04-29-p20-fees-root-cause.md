# Post-mortem — P20 fees root cause (9 losses J-7)

**Date** : 2026-04-30
**Auteur** : Claude (compilé sous direction utilisateur)
**Sévérité** : HIGH (win_rate 0/9 = 0%, P&L -$35.17 sur 7j)
**Statut** : RESOLVED — fix dans PR #130 (DRAFT, merge prévu post-FOMC J31)

## Résumé exécutif

Sur la fenêtre 2026-04-23 → 2026-04-29, les 9 trades fermés du portfolio ont
livré 0 gain et 9 pertes pour un total de **-$35.17**. Sept des neuf trades
sont des `closed_target` avec `pct_move POSITIF` (+0.003 % à +0.171 %) — la
position a atteint son TP, le prix est monté, mais le P&L net est négatif.
Cause racine : les **fees IBKR Pro** (commission $0.35 min + slippage 5bps)
représentent 0.15-0.40 % du notional sur petits volumes, soit plus que le TP
configuré.

## Données brutes (les 9 losses)

| symbol | dir | hold_min | pct_move | pnl | exit_reason |
|--------|-----|----------|----------|-----|-------------|
| SLV | long | 20.0 | +0.147 % | −1.66 | closed_target |
| LMT | long | 6.1 | +0.019 % | −5.67 | closed_target |
| XLE | long | 3.7 | −0.153 % | −6.15 | closed_invalidated |
| GDX | long | 2.2 | +0.066 % | −2.42 | closed_target |
| LMT | long | 2.2 | +0.021 % | −5.61 | closed_target |
| XLE | long | 0.1 | 0.000 % | −3.00 | closed_invalidated |
| LMT | long | 4.2 | +0.003 % | −4.93 | closed_target |
| SLV | long | 3.0 | +0.171 % | −0.92 | closed_target |
| SLV | long | 2.7 | +0.008 % | −4.81 | closed_target |

**Constats** :
- 7/9 sont `closed_target` avec `pct_move POSITIF` mais P&L NÉGATIF
- 4 tickers seulement : SLV (3) + LMT (3) + XLE (2) + GDX (1)
- Hold times 0.1 → 20 min — scalping ultra-court
- 2 `closed_invalidated` XLE avec hold ≤ 3.7 min — entries prematurées

## Cause racine

### Mécanisme

La logique d'open paper-broker calcule un TP en pourcentage du prix d'entry
(default 1.5 %). Le close mécanique vérifie `prix_live ≥ prix_TP` puis
calcule le PnL net = `(exit - entry) × qty - fees - slippage`. Pour un
notional petit, les fees fixes IBKR Pro dominent :

```
Notional : 5 sh × $508 = $2540
Commission entry : max($0.35, 5 × $0.0035) = $0.35
Commission exit  : max($0.35, 5 × $0.0035) = $0.35
SEC fee exit     : $2540 × $27.80 / 1M = $0.07
Slippage 5bps × 2 sides : $2.54
─────────────────────
Round-trip cost  : ~$3.31

TP +0.019 % → gain gross = 5 × $0.10 = $0.50
Net = $0.50 - $3.31 = -$2.81
```

### Pourquoi P19x.1 MIN_NET_PROFIT n'a pas suffi

P19x.1 (mergé matinée même journée) bloque le close si `net < max($2, 0.5%×notional)`.
Mais :
1. Les 9 losses sont **antérieures** à P19x.1 (deploy ~02:00 UTC J30)
2. Même actif, P19x.1 ne prévient pas **l'open** d'un trade dont le TP
   configuré est mécaniquement non-rentable. Il garde la position ouverte
   au lieu de la fermer à perte — ce qui est mieux mais ne résout pas le
   problème en amont.

### Pourquoi les TP étaient si serrés

`mechanical-trading.service.ts:1036` :
```ts
const tpPct = Math.max(target.takeProfitPct ?? Math.max(atrDerived.stopPct * 2, 4), 0.5);
```
Plancher 0.5 %. Pour notional $2500 avec fees ~$3.30 round-trip (slippage
inclus), break-even = $3.30 / $2500 = **0.13 %**. Donc 0.5 % laisse une
marge théorique de 0.37 % — **insuffisante** quand le scalping crée des
exits opportunistes (MACD reactive) au-delà du TP, mais pas assez au-dessus
pour absorber les fees + slippage marginaux.

### Pourquoi l'univers ultra-restreint (4 tickers)

Le scanner gainers EODHD `/api/screener` filtre `refund_1d_p > 3 AND market_cap > $50M`.
En avril 2026, peu de symboles ont gain > 3% J-1 ET passent les gates
internes (persistance multi-TF, path quality, cooldown 30min). ETFs liquides
(SLV/GDX/XLE) reviennent souvent ; large-caps comme LMT sont récurrents
sur catalyseurs défense. Pas un bug du scanner — un constat de marché.

## Impact

- **Direct** : -$35.17 réalisé sur 7j
- **Indirect** : 8 positions ouvertes additionnelles entre 22:17 UTC J-1 et
  05:04 UTC J30 (autopilot tournait toujours malgré win_rate 0%) avec ratio
  R/R = 0.5 (TP 2.5% / SL ~5%) — risque corrélé pré-FOMC
- **Tokens LLM** : ~16 `position_skipped_fallback_price` × 12 `position_opened`
  = 133 % skip/open ratio → coût Claude gaspillé sur signaux non exécutés

## Actions correctives

### Immédiat (J30 06:05 UTC)

- [x] **Kill-switch armé** par utilisateur :
  ```sql
  UPDATE lisa_session_configs
  SET kill_switch_active=true, autopilot_paused_reason='MANUAL'
  WHERE portfolio_id='58439d86-...';
  ```
- [x] Décision : ne pas close les 8 positions avant FOMC (SL armés ~4-5%
  sous entry, downside borné, ETFs macro tenable)
- [ ] **Monitoring dashboard** active 13:30 UTC (US open) → 20:00 UTC, refresh 15 min

### Code fix (PR #130)

- [x] **P20** — `paper-broker.openPosition` reject si `expected_gain < 2 × round_trip_fees`
  (couvre Lisa proposal + scanner gainers)
- [x] **P20.1** — Mirror guard dans `mechanical-trading.service.ts:1100`
  (couvre INSERT direct qui bypass paperBroker)
- [x] **P20.2** — Inclut slippage 5bps dans `roundTripFees` (catch SLV
  qty=39 +0.171 % qui passait P20 v1)
- [x] Helper `resolveFeesAwareBuffer()` exposé via env var `FEES_AWARE_BUFFER`,
  default 2.0, clamp [1.0, 5.0]
- [x] Tests : 19/19 verts (LMT regression, SLV regression, buffer
  sensitivity, direction-aware long/short, crypto edge cases)
- [x] Suite complète API : 815/815 ✓
- [ ] **Merge prévu post-FOMC J31** — pas pré-open J30

### Follow-up

- [ ] **Issue #131** — P20.2 tracking : valider 7j prod post-merge que le
  `mechanical_open_skipped_fees_aware` decision_log volume est cohérent
- [ ] **P20.3 potentiel** — slippage asset-class-aware (5bps US large,
  10bps small-cap, 2bps crypto liquide) si observation prod montre
  divergence
- [ ] **P20.4 potentiel** — exposer `gainers_min_tp_pct` configurable par
  portfolio dans `lisa_session_configs` au lieu du plancher hardcoded 0.5%
- [ ] Décision Gemini activation post-FOMC (séparée du fix P20)

## Lessons learned

1. **Les guards de close (P19x.1) protègent partiellement mais ne
   remplacent pas les guards d'open**. Une stratégie ne doit pas seulement
   refuser de matérialiser une perte — elle doit refuser de prendre un
   trade dont le TP n'est pas mathématiquement profitable.

2. **Le slippage doit être modélisé partout où les fees le sont**. P20 v1
   ne le faisait pas, P20.2 le corrige. Cohérence entre paths
   (mechanical-trading entry/exit + paper-broker entry/exit) critique.

3. **Le min commission IBKR Pro ($0.35/side) crée un effet de seuil** :
   pour notional < ~$1000, fees fixes dominent. La stratégie doit soit
   augmenter le sizing, soit accepter des TP plus larges, soit refuser
   le trade. P20 implémente la 3ème option.

4. **L'autopilot ne doit pas tourner sans expectancy positive vérifiée**.
   P19x.4 watchdog skip les opens si E < 0 sur 10 derniers trades, mais
   J-7 = 9 trades = sous le seuil n=10. Considérer baisser à n=5 dans un
   follow-up.

5. **Les ETFs macro liquides (SLV/GDX/XLE) ont un comportement
   intraday peu volatile** — les top gainers à +3% sur ces tickers sont
   souvent des micro-spikes éphémères qui retracent. La stratégie gagnerait
   à exclure ou sous-pondérer cette catégorie pour le momentum 1m.

## Liens

- **PR #130** : [P20+P20.1+P20.2] DRAFT fees-aware target guard
- **Issue #131** : P20.2 tracking 5bps slippage
- **Issue #128** : Gainers 6/6 strict operational test (lié — P20 protègera aussi cette mécanique)
- **PR #123** : P19x.11 paper-broker MIN_NET_PROFIT mirror (companion)
- **Branch test** : `fix/p20-fees-aware-target` commit `09136e5`

## Validation post-merge (à compléter J31+)

- [ ] Compter `mechanical_open_skipped_fees_aware` dans decision_log sur 24h post-merge
- [ ] Compter `position_opened` sur 24h post-merge → comparer à baseline J-7
- [ ] Re-baseline `win_rate_7d` sur 7j post-merge — viser ≥ 30 % minimum,
  ≥ 55 % cible
- [ ] Si `mechanical_open_skipped_fees_aware` > 90 % du volume → buffer 2.0
  trop strict, réduire à 1.5 via env var
- [ ] Si win_rate reste < 30 % malgré P20 → root cause additionnelle
  (qualité signal, regime de marché)
