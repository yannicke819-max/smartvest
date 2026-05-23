# Phase E — ATR/Regime gate par symbole (DESIGN — pas encore codé)

## Problème

Les filtres existants (changePct, persistence, path_eff, plafond A) sont
**réactifs au pop 1-min**. Ils ne savent rien de la **volatilité native** du
symbole. Conséquence : un small-cap structurellement volatil (ATR/prix ~5%)
qui pop +3% passe les filtres, mais son setup de stop -1.5% est cassé par le
bruit normal → SL hit dans 2-5 min sans raison fondamentale.

Mesure data 15j (n=20 stops avec peak) : MFE +0.48% / exit -1.98% → 86% des
stops EU/Asia small-cap proviennent de tickers dont l'ATR daily > 3%.

## Objectif

Skip les tickers dont l'**ATR/close** dépasse un seuil (default 2.5%).
Aligné avec la "Stratégie 2 — LSTM Proxy / Regime Detection" du brief externe.

## Architecture proposée

### 1. Cache ATR par symbole

Nouvelle table `symbol_atr_cache` (migration 0154) :

```sql
CREATE TABLE symbol_atr_cache (
  symbol            TEXT PRIMARY KEY,
  atr_14d           NUMERIC(12,6) NOT NULL,
  close_at_compute  NUMERIC(12,6) NOT NULL,
  atr_ratio_pct     NUMERIC(8,4) NOT NULL,  -- (atr / close) × 100
  computed_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_symbol_atr_cache_computed ON symbol_atr_cache (computed_at DESC);
```

TTL cache : 24h (re-compute daily via cron).

### 2. Service `SymbolAtrCacheService`

```typescript
@Injectable()
export class SymbolAtrCacheService {
  // Cron daily 21:30 UTC (après US close) : pull EODHD EOD pour chaque
  // symbole de l'univers (~200 tickers), compute ATR(14), persist.
  @Cron('30 21 * * 1-5', { timeZone: 'UTC' })
  async refreshDaily() { ... }

  async getAtrRatio(symbol: string): Promise<number | null> {
    // Lit DB cache. Si null ou stale (>48h), renvoie null → filter no-op
    // (fail-open conservateur).
  }
}
```

### 3. Gate dans scanner candidate loop

```typescript
const maxAtrRatio = Number(this.config.get('GAINERS_MAX_ATR_RATIO') ?? '0');
if (maxAtrRatio > 0) {
  const atrRatio = await this.symbolAtrCache.getAtrRatio(cand.symbol);
  if (atrRatio !== null && atrRatio > maxAtrRatio) {
    recordShadowDecision(cand, 'reject_volatile_regime', undefined);
    continue;
  }
}
```

### 4. Env vars

- `GAINERS_MAX_ATR_RATIO=0` (default OFF, conseil 0.025 = 2.5%)
- `SYMBOL_ATR_CACHE_REFRESH_ENABLED=true` (cron refresh)

## Coût implementation

- Migration : ~20 LoC
- Service cache + cron : ~100 LoC
- Gate scanner : ~10 LoC
- Tests : ~80 LoC
- **Total** : ~200 LoC, ~3-4h de travail

## Coût opérationnel

- EODHD EOD : ~200 tickers × 1 call/jour = 6k calls/mois (1% quota)
- DB : 1 table petite (~200 rows persistées), refresh quotidien

## Edge estimé

| Hypothèse | Estimation |
|---|---|
| 15-20% des signaux EU/Asia small-cap ont ATR > 2.5% | Mean perdu sur ces -0.5 à -0.8% |
| Volume sur 15j : ~60 trades EU+Asia rejetés | ~$70-100/15j = $5-7/jour |
| Annualisé | **~$1 800-2 500/an** |

## Risques

1. **Faux positifs** : un small-cap legitimately trending peut avoir ATR élevé
   → on rate le bon trade. À mesurer via shadow.
2. **Cache stale** : si refresh cron fail 3 jours, cache obsolète. Le service
   fail-open (renvoie null → no filter) protège.
3. **EODHD EOD coverage** : Asia tickers (.KO, .SHG, .SHE) couverts mais ATR
   calc nécessite ≥14 jours d'historique. Si ticker fraîchement listé, skip.

## Décision

À CODER quand :
- A (signal age cut) est mergé + observé 3j
- Données suggèrent que la volatilité native est un driver des stops EU/Asia

## Alternatives écartées

- Compute ATR live dans le scanner (sans cache) : coûte 1 fetch EODHD par
  candidat à chaque cycle = 50× plus cher que cache + lent.
- Use intraday range comme proxy : déjà partiellement via `close_to_high_min`.
- Skip via mcap-class : trop grossier (un mid-cap peut être stable).

<!-- ci: retrigger on empty push, see PR #403 -->
