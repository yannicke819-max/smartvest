# BRIEF CLAUDE CODE — PR-3 Régime + Score + Cooldown

**Destinataire** : Claude Code (claude.ai/code)
**Repo** : `yannicke819-max/smartvest`
**Branche** : `feat/phase5n1-pr3-regime-score`
**Type PR** : feature (10 QW filtres qualité + circuit breakers)
**Trigger** : lundi 1er juin 2026, après merge PR-2 et 5j de validation TP/SL matrix
**Mergeur** : agent Perplexity

---

## CONTEXTE BUSINESS

PR-3 cible la **qualité des signaux** : filtres régime higher-TF, score minimum, channel band, cooldowns post-TP/SL, circuit breakers drawdown. Sans toucher TP/SL (déjà calibrés en PR-2) ni sizing (réservé PR-4).

Gain attendu : **+$60 à +$100/jour cumulatif** sur top de PR-1+PR-2.

### Calibration chiffrée 16 mai 18h28 — données SQL réelles 7-14j

Mesures SQL `lisa_positions` portfolio `58439d86-3f20-4a60-82a4-307f3f252bc2` :

**C42 (meta-labeling, path_eff filter) — angle MASSIF :**

| classe | n total 14j | n si path_eff≥0.6 | PnL actuel | PnL filtré | Gain |
|---|---|---|---|---|---|
| eu_equity | 45 | 37 | -$1440 | +$66 | **+$1506 / 14j = +$107/j** |
| us_equity_large | 74 | 50 | -$183 | -$31 | +$152 / 14j = +$11/j |
| us_equity_small_mid | 40 | 27 | -$136 | -$8 | +$129 / 14j = +$9/j |
| crypto_major | 10 | 3 | -$64 | -$42 | +$22 / 14j = +$1.5/j |
| asia_equity | 118 | 118 (tous au-dessus) | -$806 | -$806 | $0 |

Total gain extrapolé filtre **path_eff ≥ 0.6 sur 4 classes (hors asia) : +$129/jour**.
→ **Impacte directement QW#27 : floors recalibrés à 0.6 sur eu/us_large/us_sm/crypto, pas 0.25-0.40.**

**C40 (régime asia_equity via NTILE volatilité) — angle CLAIR :**

| asia_equity régime | jours | PnL/jour avg | vol journalière |
|---|---|---|---|
| Tercile bas vol | 3 | -$154 | 1.03 |
| **Tercile moyen vol** | **2** | **+$76** | **1.91** |
| Tercile haut vol | 2 | -$219 | 2.17 |

Edge asia = **régime moyen vol uniquement**. Skip si vol journalière < 1.4 OU > 2.0.
→ **Impacte QW#4 : Supertrend+ADX doit gating sur régime médian, pas seulement trend.**

**Alerte indépendante — eu_equity sl_avg = -12.10% sur 7j (1 outlier) :**
Classe eu_equity a 1 trade avec SL anormal (vol 35.66 vs 2.27 médiane). À investiguer hors PR-3, possible bug R5 résiduel.

---

## OBJECTIF PR-3 (10 QW)

| QW | Description | Env flag | Coût |
|---|---|---|---|
| **#4** | Filtre régime Supertrend+ADX 30m (asia_equity initial) | `QW_4_REGIME_FILTER_CLASSES=asia_equity` | 4h |
| **#9** | Score min 1.0 | `QW_9_SCORE_MIN=1.0` | 1h |
| **#10** | Channel band 1min `[-0.5σ, +1.5σ]` rolling 20 ticks | `QW_10_CHANNEL_BAND_ENABLED=true` | 2h |
| **#7** | Cooldown 5min post-TP `us_equity_*` same symbol | `QW_7_COOLDOWN_POST_TP_MIN=5` | 2h |
| **#8** | Boost post-SL : sizing ×0.7 classe 1h | `QW_8_BOOST_POST_SL_FACTOR=0.7` + `QW_8_BOOST_DURATION_MIN=60` | 2h |
| **#24** | Score cap inversé : flag suspicion si score > 3.0 | `QW_24_SCORE_CAP_HIGH=3.0` | 1h |
| **#25** | Circuit breaker PnL_jour < -$400 → kill global 24h | `QW_25_CIRCUIT_BREAKER_USD=-400` | 2h |
| **#26** | Cap dynamique : drawdown 7j > -8% → cap 6→4 | `QW_26_DRAWDOWN_DYNAMIC_CAP=true` | 2h |
| **#27** | Path_eff floor par classe (RECALIBRÉ 16/05) | `QW_27_PATH_EFF_FLOORS=asia:0.30,eu:0.60,us_large:0.60,us_sm:0.60,crypto:0.60` | 1h |
| **#28** | Volume_z min > 1.5 | `QW_28_VOLUME_Z_MIN=1.5` | 1h |

**Total** : ~18h de code

---

## CONTRAINTES IMMUABLES (rappel)

Règles A, B, C, D, E préservées. **Nouvelle Règle F** : aucun circuit breaker (QW#25, #26) ne doit interrompre une position déjà ouverte — seulement bloquer les nouvelles entrées. Les positions ouvertes sont gérées par leur SL/TP existant.

---

## ARCHITECTURE

Étendre dossier `apps/api/src/modules/scanner/quick-wins/` :

```
quick-wins/
├── (existing PR-1 services)
├── qw-4-regime-filter.service.ts          # Supertrend + ADX 30m
├── qw-9-score-min.service.ts
├── qw-10-channel-band.service.ts
├── qw-7-cooldown-post-tp.service.ts
├── qw-8-boost-post-sl.service.ts
├── qw-24-score-cap-high.service.ts
├── qw-25-circuit-breaker.service.ts       # PnL_jour kill switch
├── qw-26-drawdown-dynamic-cap.service.ts
├── qw-27-path-eff-floor.service.ts
├── qw-28-volume-z-min.service.ts
└── __tests__/ (10 nouveaux specs + intégration cascade étendue)
```

---

## CASCADE ORDRE FINAL (post-PR-3)

Le pipeline `quick-wins-pipeline.service.ts` doit étendre la cascade dans cet ordre :

```typescript
async evaluate(signal: Signal): Promise<QwResult> {
  // BLOCKS DURS (entrées impossibles)
  // 1. QW#25 circuit breaker global (vérif PnL_jour)
  if (await qw25.isCircuitBreakerActive()) return block('QW_25', 'pnl_day_under_400');

  // 2. QW#1 session filter
  // 3. QW#6 symbol blacklist
  // 4. QW#11 asset class gate
  // (existing PR-1)

  // 5. QW#26 cap dynamique (vérif drawdown 7j)
  const dynamicCap = await qw26.getEffectiveCap();
  if (await this.openPositionsCount() >= dynamicCap) return block('QW_26', `dynamic_cap_${dynamicCap}_reached`);

  // 6. QW#9 score min
  if (signal.score < qw9.scoreMin) return block('QW_9', 'score_below_min');

  // 7. QW#27 path_eff floor par classe
  if (signal.pathEff < qw27.getFloor(signal.assetClass)) return block('QW_27', 'path_eff_below_floor');

  // 8. QW#28 volume_z min
  if (signal.volumeZ < qw28.volumeZMin) return block('QW_28', 'volume_z_below_min');

  // 9. QW#10 channel band 1min
  if (!qw10.inBand(signal.ch1m)) return block('QW_10', 'ch1m_out_of_band');

  // 10. QW#4 régime higher-TF (Supertrend + ADX)
  if (qw4.appliesTo(signal.assetClass)) {
    const regime = await qw4.evaluate(signal);
    if (regime.decision === 'block') return block('QW_4', regime.reason);
  }

  // 11. QW#7 cooldown post-TP same symbol
  if (await qw7.inCooldown(signal.symbol, signal.assetClass)) return block('QW_7', 'cooldown_post_tp');

  // 12. QW#17 repeat cap (existing PR-1)
  // 13. QW#18 exchange multiplier (existing PR-1)

  // MULTIPLIERS sizing
  let sizingMultiplier = 1.0;
  // 14. QW#8 boost post-SL (réduction sizing si SL récent)
  const postSlMultiplier = await qw8.getSizingMultiplier(signal.assetClass);
  sizingMultiplier *= postSlMultiplier;

  // 15. QW#18 exchange multiplier (déjà appliqué via cascade PR-1)
  // 16. QW#24 score cap high (warning seul, pas de block)
  if (signal.score > qw24.scoreCapHigh) {
    qwTrace.push({ qwId: 'QW_24', decision: 'warn', reason: 'score_suspicion_overfitting' });
  }

  return { decision: 'modify', sizingMultiplier, qwTrace };
}
```

---

## SPÉCIFICATIONS DÉTAILLÉES

### QW#4 — Filtre régime Supertrend + ADX 30m

```typescript
@Injectable()
export class Qw4RegimeFilterService {
  private readonly enabledClasses: Set<string>;
  private readonly adxThreshold: number = 25;
  private readonly cache: Map<string, { result: any; expiresAt: number }> = new Map();
  private readonly cacheTtlMs: number = 30 * 60_000; // 30min match candle TF

  constructor(
    private config: ConfigService,
    private eodhdClient: EodhdClient,
    private decisionLogger: QwDecisionLoggerService,
  ) {
    const raw = config.get<string>('QW_4_REGIME_FILTER_CLASSES', 'asia_equity');
    this.enabledClasses = new Set(raw.split(',').map(s => s.trim()).filter(Boolean));
  }

  appliesTo(assetClass: string): boolean {
    return this.enabledClasses.has(assetClass);
  }

  async evaluate(signal: Signal): Promise<{ decision: 'pass' | 'block'; reason: string }> {
    if (!this.appliesTo(signal.assetClass)) {
      return { decision: 'pass', reason: 'class_not_enabled' };
    }

    const cacheKey = `${signal.symbol}_30m`;
    const cached = this.cache.get(cacheKey);
    let candles30m: Candle[];
    
    if (cached && cached.expiresAt > Date.now()) {
      candles30m = cached.result;
    } else {
      candles30m = await this.eodhdClient.getIntradayCandles({
        symbol: signal.symbol,
        interval: '30m',
        limit: 50, // suffisant pour Supertrend(10) + ADX(14)
      });
      this.cache.set(cacheKey, { result: candles30m, expiresAt: Date.now() + this.cacheTtlMs });
    }

    if (candles30m.length < 20) {
      return { decision: 'pass', reason: 'insufficient_data' }; // fail-open
    }

    const supertrend = this.computeSupertrend(candles30m, 10, 3.0);
    const adx = this.computeAdx(candles30m, 14);

    // Bloquer LONG si Supertrend bearish ET ADX > 25 (trend bearish fort)
    if (!supertrend.bullish && adx > this.adxThreshold) {
      await this.decisionLogger.log({
        qwId: 'QW_4',
        symbol: signal.symbol,
        assetClass: signal.assetClass,
        decision: 'block',
        reason: 'supertrend_bearish_adx_strong',
        wouldHavePassedWithoutFlag: true,
        details: { supertrendValue: supertrend.value, adx, candles30mCount: candles30m.length },
      });
      return { decision: 'block', reason: 'supertrend_bearish_adx_strong' };
    }

    return { decision: 'pass', reason: 'regime_favorable' };
  }

  private computeSupertrend(candles: Candle[], period: number, multiplier: number): { value: number; bullish: boolean } {
    // Standard ATR(period) + (high+low)/2 ± multiplier × ATR
    // À implémenter, ~30 lignes
    // Référence : github.com/twopirllc/pandas-ta/blob/main/pandas_ta/overlap/supertrend.py
    // ...
    return { value: 0, bullish: false }; // placeholder
  }

  private computeAdx(candles: Candle[], period: number): number {
    // Standard Welles Wilder ADX
    // À implémenter, ~40 lignes
    // ...
    return 0; // placeholder
  }
}
```

**Note pour Claude** : utiliser la librairie `technicalindicators` (npm) si déjà dans le package.json, sinon implémenter Supertrend et ADX manuellement (~70 lignes total). Pas de Python.

**Coût quota EODHD** : ~50 nouveaux accepts/jour × 1 call 30m = 50 calls/jour. Avec cache 30min, plusieurs accepts du même symbol dans la fenêtre = 1 seul fetch. Estimation < 100 calls/jour additionnels = négligeable.

---

### QW#9 — Score min

```typescript
@Injectable()
export class Qw9ScoreMinService {
  readonly scoreMin: number;
  constructor(private config: ConfigService) {
    this.scoreMin = parseFloat(config.get<string>('QW_9_SCORE_MIN', '1.0'));
  }
}
```

Test : score=0.9 → block, score=1.0 → pass, score=1.5 → pass.

---

### QW#10 — Channel band 1min

```typescript
@Injectable()
export class Qw10ChannelBandService {
  private readonly enabled: boolean;
  private readonly bandLower: number = -0.5; // sigma
  private readonly bandUpper: number = 1.5;
  // Rolling 20 ticks ch1m par asset_class (in-memory ring buffer)
  private readonly history: Map<string, number[]> = new Map();

  constructor(private config: ConfigService) {
    this.enabled = config.get<string>('QW_10_CHANNEL_BAND_ENABLED', 'true') === 'true';
  }

  inBand(ch1m: number, symbol?: string): boolean {
    if (!this.enabled) return true;
    if (!symbol) return ch1m >= this.bandLower && ch1m <= this.bandUpper; // fallback statique

    const hist = this.history.get(symbol) || [];
    hist.push(ch1m);
    if (hist.length > 20) hist.shift();
    this.history.set(symbol, hist);

    if (hist.length < 10) return true; // pas assez d'historique → fail-open

    const mean = hist.reduce((a, b) => a + b, 0) / hist.length;
    const stddev = Math.sqrt(hist.reduce((a, b) => a + (b - mean) ** 2, 0) / hist.length);
    if (stddev === 0) return true;

    const z = (ch1m - mean) / stddev;
    return z >= this.bandLower && z <= this.bandUpper;
  }
}
```

---

### QW#7 — Cooldown post-TP

```typescript
@Injectable()
export class Qw7CooldownPostTpService {
  private readonly cooldownMin: number;
  private readonly cooldownEntries: Map<string, number> = new Map(); // symbol+class → expiresAt

  constructor(private config: ConfigService) {
    this.cooldownMin = parseInt(config.get<string>('QW_7_COOLDOWN_POST_TP_MIN', '5'), 10);
  }

  recordTp(symbol: string, assetClass: string): void {
    if (!assetClass.startsWith('us_equity_')) return; // QW#7 = us_equity_* uniquement
    const key = `${symbol}__${assetClass}`;
    this.cooldownEntries.set(key, Date.now() + this.cooldownMin * 60_000);
  }

  async inCooldown(symbol: string, assetClass: string): Promise<boolean> {
    if (this.cooldownMin === 0) return false;
    if (!assetClass.startsWith('us_equity_')) return false;
    const key = `${symbol}__${assetClass}`;
    const expiresAt = this.cooldownEntries.get(key);
    if (!expiresAt) return false;
    if (Date.now() > expiresAt) {
      this.cooldownEntries.delete(key);
      return false;
    }
    return true;
  }
}
```

**Intégration** : hooker sur l'event de close `closed_target` :
```typescript
// Dans le service qui close les positions, après UPDATE atomic réussi
if (closedStatus === 'closed_target' && assetClass.startsWith('us_equity_')) {
  this.qw7Cooldown.recordTp(symbol, assetClass);
}
```

---

### QW#8 — Boost post-SL (sizing reduction)

```typescript
@Injectable()
export class Qw8BoostPostSlService {
  private readonly factor: number;
  private readonly durationMin: number;
  private readonly entries: Map<string, number> = new Map(); // asset_class → expiresAt

  constructor(private config: ConfigService) {
    this.factor = parseFloat(config.get<string>('QW_8_BOOST_POST_SL_FACTOR', '0.7'));
    this.durationMin = parseInt(config.get<string>('QW_8_BOOST_DURATION_MIN', '60'), 10);
  }

  recordSl(assetClass: string): void {
    this.entries.set(assetClass, Date.now() + this.durationMin * 60_000);
  }

  getSizingMultiplier(assetClass: string): number {
    const expiresAt = this.entries.get(assetClass);
    if (!expiresAt) return 1.0;
    if (Date.now() > expiresAt) {
      this.entries.delete(assetClass);
      return 1.0;
    }
    return this.factor;
  }
}
```

**Intégration** : hooker sur close `closed_stop` :
```typescript
if (closedStatus === 'closed_stop') {
  this.qw8BoostPostSl.recordSl(assetClass);
}
```

---

### QW#25 — Circuit breaker global

```typescript
@Injectable()
export class Qw25CircuitBreakerService {
  private readonly enabled: boolean;
  private readonly thresholdUsd: number;
  private cachedActive: boolean = false;
  private cachedAt: number = 0;
  private readonly cacheTtlMs: number = 60_000; // re-check 1min

  constructor(
    private config: ConfigService,
    private supabase: SupabaseService,
  ) {
    this.thresholdUsd = parseFloat(config.get<string>('QW_25_CIRCUIT_BREAKER_USD', '-400'));
    this.enabled = this.thresholdUsd !== 0;
  }

  async isCircuitBreakerActive(): Promise<boolean> {
    if (!this.enabled) return false;
    if (Date.now() - this.cachedAt < this.cacheTtlMs) return this.cachedActive;

    const { data } = await this.supabase.client.rpc('compute_pnl_today_paris', {
      portfolio_id: process.env.PORTFOLIO_ID,
    });
    const pnlToday = data?.[0]?.pnl_total_usd ?? 0;

    this.cachedActive = pnlToday < this.thresholdUsd;
    this.cachedAt = Date.now();
    return this.cachedActive;
  }
}
```

Migration RPC Supabase :
```sql
CREATE OR REPLACE FUNCTION compute_pnl_today_paris(portfolio_id uuid)
RETURNS TABLE(pnl_total_usd numeric) LANGUAGE sql STABLE AS $$
  SELECT COALESCE(SUM(realized_pnl_usd), 0)::numeric AS pnl_total_usd
  FROM lisa_positions
  WHERE lisa_positions.portfolio_id = compute_pnl_today_paris.portfolio_id
    AND created_at >= (CURRENT_DATE AT TIME ZONE 'Europe/Paris')::timestamp AT TIME ZONE 'Europe/Paris';
$$;
```

---

### QW#26 — Cap dynamique drawdown

```typescript
@Injectable()
export class Qw26DrawdownDynamicCapService {
  private readonly enabled: boolean;
  private readonly normalCap: number = 6;
  private readonly reducedCap: number = 4;
  private readonly drawdownThresholdPct: number = -8;
  private cachedCap: number = 6;
  private cachedAt: number = 0;
  private readonly cacheTtlMs: number = 5 * 60_000;

  constructor(private config: ConfigService, private supabase: SupabaseService) {
    this.enabled = config.get<string>('QW_26_DRAWDOWN_DYNAMIC_CAP', 'true') === 'true';
  }

  async getEffectiveCap(): Promise<number> {
    if (!this.enabled) return this.normalCap;
    if (Date.now() - this.cachedAt < this.cacheTtlMs) return this.cachedCap;

    const { data } = await this.supabase.client.rpc('compute_drawdown_7d_pct', {
      portfolio_id: process.env.PORTFOLIO_ID,
    });
    const drawdownPct = data?.[0]?.drawdown_pct ?? 0;

    this.cachedCap = drawdownPct < this.drawdownThresholdPct ? this.reducedCap : this.normalCap;
    this.cachedAt = Date.now();
    return this.cachedCap;
  }
}
```

---

### QW#27 — Path_eff floor par classe

```typescript
@Injectable()
export class Qw27PathEffFloorService {
  private readonly floors: Map<string, number>;
  constructor(private config: ConfigService) {
    // 'asia:0.30,eu:0.25,us:0.35,crypto:0.40'
    const raw = config.get<string>('QW_27_PATH_EFF_FLOORS', 'asia:0.30,eu:0.25,us:0.35,crypto:0.40');
    this.floors = new Map();
    raw.split(',').forEach(pair => {
      const [classKey, floorStr] = pair.split(':').map(s => s.trim());
      const fullClass = this.mapClassKey(classKey);
      const floor = parseFloat(floorStr);
      if (fullClass && !isNaN(floor)) this.floors.set(fullClass, floor);
    });
  }

  getFloor(assetClass: string): number {
    return this.floors.get(assetClass) ?? 0;
  }

  private mapClassKey(short: string): string | null {
    const m: Record<string, string> = {
      'asia': 'asia_equity', 'eu': 'eu_equity',
      'us': 'us_equity_large', 'us_large': 'us_equity_large',
      'us_sm': 'us_equity_small_mid', 'crypto': 'crypto_major',
    };
    return m[short] || null;
  }
}
```

### QW#28 — Volume_z min, QW#24 — Score cap high
Triviaux, sur le modèle de QW#9.

---

## TESTS

Pour chaque QW, spec dédié. Intégration pipeline cascade complète vérifie l'ordre.

Test critique `qw-25-circuit-breaker.spec.ts` :
- PnL today = -$500 → isCircuitBreakerActive = true
- PnL today = -$200 → false
- Cache fonctionne (RPC appelée 1×/min max)
- Flag false → false toujours

---

## CHECKLIST AVANT PUSH

- [ ] 10 services + 10 spec + intégration pipeline
- [ ] 2 RPC SQL Supabase (compute_pnl_today_paris, compute_drawdown_7d_pct)
- [ ] Cascade ordre respectée (block durs → multipliers)
- [ ] Hooks recordTp et recordSl branchés sur close events
- [ ] Tests >= 85% coverage
- [ ] Env vars dans `.env.example`
- [ ] CI green
- [ ] Draft PR ouverte

## MÉTRIQUES J+5

```sql
-- Top reasons blocked QW#4-28
SELECT qw_id, reason, COUNT(*) FROM qw_decision_log
WHERE created_at >= NOW() - INTERVAL '5 days'
  AND qw_id IN ('QW_4','QW_7','QW_8','QW_9','QW_10','QW_24','QW_25','QW_26','QW_27','QW_28')
GROUP BY qw_id, reason ORDER BY COUNT(*) DESC;
```

Cibles : QW#4 bloque >= 10 signaux asia bearish/5j, QW#9 bloque >= 50 signaux score<1.0/5j, QW#25 activé 0 fois (sinon = pertes lourdes), QW#26 cap réduit déclenché 0-1 fois (drawdown sous contrôle), PnL/jour +$60-100 cumulé.

Go.
