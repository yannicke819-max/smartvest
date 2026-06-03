# Blow-off / Pump-Fade Research — Bibliographie SmartVest

Source : web research 03/06/2026 post-mortem OKLO.US (-1.63% en 35min).
12 règles les plus actionnables sont injectées dans le TRADER prompt via
`blow-off-preamble-lessons.ts`. Les 16 autres sont documentées ici pour
référence future et tuning.

---

## A. Academic P&D detection (crypto + cross-asset)

### 1. Kamps-Kleinberg anomaly windows — HIGH (intégré priors)
- **Signature** : rolling price/volume z-score sur fenêtre 12h.
- **Filter** : flag quand price+volume > 2σ vs mean en rolling 12h.
- **Source** : [Kamps & Kleinberg 2018, Crime Science](https://link.springer.com/article/10.1186/s40163-018-0093-5)

### 2. Xu-Livshits volume-cap signature — HIGH (intégré : `small_cap_telegram_pump`)
- **Signature** : small/illiquid + 1m volume > 5× MA20 + no scheduled catalyst <24h.
- **Filter** : skip ou fade ces names sans confirmation indépendante.
- **Source** : [Xu & Livshits 2019, arXiv:1811.10109](https://arxiv.org/abs/1811.10109)

### 3. La Morgia rush-order detection — HIGH
- **Signature** : StdRushOrders + AvgRushOrders sur buckets 5s > 3σ vs mean 1h.
- **Filter** : block entry si rush-order pattern détecté (coordinated insider buys).
- **Source** : [La Morgia ICCCN 2020 / GitHub dataset](https://github.com/SystemsLab-Sapienza/pump-and-dump-dataset)

### 4. La Morgia 2024 real-time RF/AdaBoost — HIGH
- **Signature** : 9-feature vector sur tick stream (StdRushOrders, AvgRushOrders, StdVolumes, StdPrice...).
- **Filter** : RF on labelled dataset, require positive class probability < 0.5.
- **Source** : [arXiv 2412.18848](https://arxiv.org/html/2412.18848v2)

### 5. Crypto P&D economic estimate — MED
- ~$7M/mois volume artificiel sur small-cap coins via Telegram pumps.
- **Source** : [CEPR Vox](https://cepr.org/voxeu/columns/economics-cryptocurrency-pump-and-dump-schemes)

### 6. Order-book imbalance flip — MED
- **Signature** : depth bid:ask 1.5:1 → 0.6:1 en <30s.
- **Filter** : skip long si depth ratio drop > 60% sur 30s.
- **Source** : [Sling Academy](https://www.slingacademy.com/article/monitoring-order-book-imbalances-for-trading-signals-via-cryptofeed/), [Amberdata](https://blog.amberdata.io/monitoring-order-book-snapshots-to-understand-market-depth)

---

## B. Chartist exhaustion / climax patterns

### 7. Exhaustion gap on high volume — HIGH
- **Signature** : gap > 2 ATR(14) après ≥5 jours consécutifs up + volume > 3× MA20.
- **Filter** : block long, candidate short fade.
- **Source** : [Quantified Strategies](https://www.quantifiedstrategies.com/exhaustion-gap/), Zacks

### 8. Climax run (O'Neil) — HIGH (intégré : `climax_run_oneil`)
- **Signature** : +25-50% en 1-2 semaines après uptrend multi-mois.
- **Filter** : block new long si 5-day return ≥ 25% AND prior 90-day ≥ 50%.
- **Source** : O'Neil CAN SLIM / [AAII](https://www.aaii.com/journal/article/william-oneil-can-slim-approach)

### 9. Parabolic blow-off slope test — MED
- **Signature** : ROC(1m, 5 bars récentes) / ROC(1m, 20 bars antérieurs) > 2.5.
- **Filter** : chart near-vertical = late FOMO.
- **Source** : [ChartGuys](https://www.chartguys.com/chart-patterns/parabolic-blow-off-top), [QuantVPS](https://www.quantvps.com/blog/blow-off-top-chart-pattern)

### 10. Shooting star 1m/5m — MED (intégré : `shooting_star_intraday`)
- **Signature** : upper shadow ≥ 2× body, small body near low, après uptrend.
- **Source** : [Bulkowski thepatternsite](https://thepatternsite.com/ShootingStar.html)

### 11. Bearish engulfing at resistance — MED
- **Signature** : current bar body ≥ 100% prior bar range, close < open, après uptrend.
- **Stats** : 57% base, 65-75% avec volume + resistance.
- **Source** : TradingSim backtest cheat sheet, [Altrady](https://www.altrady.com/)

### 12. Gravestone / shooting-star doji — MED
- **Signature** : doji body < 10% range, all wick upper side, après rally.
- **Stats** : 57% reversal.
- **Source** : [Liberated Stock Trader 56,680-trade study](https://www.liberatedstocktrader.com/candle-patterns-reliable-profitable/)

### 13. Exhaustion volume spike — HIGH (intégré : `exhaustion_volume_spike`)
- **Signature** : volume bougie > 4× MA(20×1m volume) sur new 60-min high.
- **Filter** : never buy that tick, late FOMO bar.
- **Source** : opofinance, convergent multi-source

---

## C. Momentum trader consensus

### 14. Minervini "don't chase extended" — HIGH (intégré : `minervini_dont_chase_extended`)
- **Signature** : price > 10% above 20MA (stocks), > 20% (crypto).
- **Source** : Minervini SEPA / [TraderLion VCP](https://traderlion.com/technical-analysis/volatility-contraction-pattern/)

### 15. O'Neil "7 of 8 days up" — HIGH (intégré : `oneil_7_of_8`)
- **Signature** : stock up 7 of last 8 OR 8 of last 10 days.
- **Source** : [O'Neil sell rules Scribd](https://www.scribd.com/document/143549322/William-J-O-Neil-Sell-Rules)

### 16. O'Neil "25% in 1-2 weeks" climax — HIGH
- **Signature** : ≥ 25% advance 5-10 sessions post prior uptrend.
- **Source** : [Macro-Ops CAN SLIM](https://macro-ops.com/william-oneils-can-slim-trading-strategy-explained/)

### 17. Raschke "buy first pullback, not first push" — HIGH (intégré : `raschke_first_pullback`)
- **Signature** : entry sur new HOD sans pullback ≥ 0.38 × impulse.
- **Source** : [Raschke 12 rules newtraderu](https://www.newtraderu.com/2022/08/25/market-wizard-linda-raschke-trading-strategy/)

### 18. Raschke "no Turtle Soup vs news" — MED
- **Filter** : news catalyst < 30min → suppress both fade-shorts et chase-longs.
- **Source** : [atozmarkets Raschke](https://atozmarkets.com/strategies/linda-raschke-strategy/)

### 19. Raschke climax range expansion — HIGH
- **Signature** : ATR(5×1m) / ATR(20×1m) > 2.0 après uptrend soutenu.
- **Source** : [forex.in.rs Raschke](https://forex.in.rs/linda-raschke-strategy/)

### 20. Weinstein Stage-3 flattening — MED (long-horizon)
- **Signature intraday analog** : EMA(200×5m) flat + down-vol > up-vol sur 60min.
- **Source** : [TraderLion stage-analysis](https://traderlion.com/trading-strategies/stage-analysis/)

### 21. O'Neil 50-day break sell (intraday analog: EMA60×1m) — HIGH
- **Signature** : close < EMA(60×1m) sur volume > 2× MA20-vol après uptrend horaire.
- **Source** : [AAII O'Neil tribute](https://www.aaii.com/journal/article/68036)

---

## D. Crypto-specific operational

### 22. Telegram pump time-of-day cluster — MED
- **Signature** : organized pumps cluster ±5min round UTC hours (00:00, 12:00, 18:00).
- **Source** : [Doge of Wall Street arXiv](https://arxiv.org/html/2105.00733v2)

### 23. Pre-pump social spike — MED
- **Signature** : channel-member growth z-score > 3 sur 6h.
- **Source** : [Hamrick et al, sciencedirect](https://www.sciencedirect.com/science/article/abs/pii/S0957417421007156)

### 24. Adversarial Telegram detection 80% — LOW
- **Source** : [TNW summary](https://thenextweb.com/news/ai-pump-dump-predictor-telegram)

---

## E. Intraday fade stats (US momentum stocks)

### 25. SmallCapLab gap-fade base rate — MED
- ~63-67% fade pre-market gappers ; 85% short success après 11:00 ET sur day-1 low-float.
- **Source** : [smallcaplab.com](https://www.smallcaplab.com/), tradethematrix.net

### 26. Mid-sized opening-move reversion — MED (intégré : `opening_15min_chase`)
- ~62-67% reversion sur mid-sized 15-min moves.
- **Source** : [OptionAlpha opening-range](https://optionalpha.com/blog/opening-range-breakout)

### 27. Short-horizon asymmetric reversal — MED-LOW (intégré : `short_horizon_reversal_asymmetric`)
- Reversal robuste après DOWN > 10%, faible après UP > 10%.
- **Source** : [Mu et al arXiv cond-mat/0406696](https://arxiv.org/pdf/cond-mat/0406696)

### 28. RSI extreme + deceleration — HIGH (intégré : `rsi_extreme_deceleration`)
- **Signature** : RSI(7) ≥ 85 ET ROC(1m) < mean(ROC, 5×1m prior). LITERAL OKLO signature.
- **Source** : [Quantified Strategies RSI](https://www.quantifiedstrategies.com/rsi-trading-strategy/)

---

## Mapping cas OKLO.US 03/06/2026

Les patterns qui auraient bloqué l'entry $66.46 :

| # | Lesson | Statut SmartVest |
|---|---|---|
| 28 | RSI extreme + decel | Pas encore (TRADER prompt prior) |
| 17 | Raschke first pullback | TRADER prompt prior |
| 9 | Parabolic slope test | Implicit via tf5m/tf30m gate |
| 13 | Exhaustion volume spike | TRADER prompt prior |
| 14 | Minervini extended | TRADER prompt prior |
| 26 | Opening 15-min fade | TRADER prompt prior |
| 8 | Climax run O'Neil | **Scanner gate (CLIMAX_RUN)** + prompt prior |
| — | Vertical pump concentration | **Scanner gate (VERTICAL_PUMP)** + prompt prior |
| — | Path eff structural | **Scanner gate (CHOP_LONG_TF)** + prompt prior |
| — | Top tick drift | **Scanner gate (TOP_TICK_GUARD)** |

4 gates hardcoded au scanner (déterministe), 12 priors au TRADER (verbalisation + override).
