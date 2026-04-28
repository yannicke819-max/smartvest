# Scanner Gainers — config UX + path quality (P9-UX)

Le scanner Gainers est gouverné par 4 paramètres clé sur `lisa_session_configs`, tous configurables par l'utilisateur dans le widget `GainersStatusTile` :

## Paramètres

| Champ DB | UI control | Range | Default | Sémantique |
|---|---|---|---|---|
| `gainers_cycle_minutes` | `<select>` 8 valeurs | 1..60 | 15 | Fréquence du scan (P9-UX) |
| `gainers_persistence_top_n` | Slider 5..100 | 5..100 | 20 | Nombre de candidats analysés (P8) |
| `gainers_min_persistence_score` | (env / DB) | 0..1 | 0.67 | Seuil min persistence (P8) |
| `gainers_min_path_efficiency` | (env / DB) | 0..1 ou null | 0.5 | Seuil min path efficiency (P9-UX ADD.) |

## Cycle (P9-UX)

Le scanner global tourne à `SCAN_INTERVAL_MINUTES` env (default 15). Pour chaque portfolio en mode `gainers`, le scanner gate avec :

```ts
const cycle = await getCycleMinutes(portfolioId); // DB cache 30s
if (Date.now() - lastScanByPortfolio.get(portfolioId) < cycle * 60_000) {
  continue; // skip ce cycle pour ce portfolio
}
```

L'effective cycle = `max(env SCAN_INTERVAL_MINUTES, gainers_cycle_minutes)`. Si l'utilisateur choisit un cycle plus court que l'env, le cron global limite la fréquence. Pour atteindre 1 min, l'env doit être à 1.

UI selector : 1, 5, 10, 15, 20, 30, 45, 60 min. Toast d'avertissement à 1 min (coût API ×15 vs 15 min).

## Path quality / smoothness (P9-UX ADDENDUM)

Détecte les pump-and-dump qui passent le gate persistence multi-TF mais dont le path est chaotique (rebonds violents, drawdowns profonds entre les TFs).

### Métriques (pure helper `@smartvest/ai-analyst/path-quality`)

```
pathEfficiency = |priceEnd - priceStart| / Σ|p_i - p_{i-1}|  ∈ [0, 1]
pullbackDepth  = (max - minAfterMax) / max                    ∈ [0, ∞[
monotonicity   = #candles positives / #candles totales        ∈ [0, 1]
```

### Classification (rule-based)

- 🟢 **smooth** : `efficiency ≥ 0.7 ET pullback ≤ 1%`
- 🔴 **choppy** : `efficiency < 0.4 OU pullback > 2%`
- 🟡 **mixed** : entre les deux

### Calcul backend

Pour chaque candidat × chaque TF (5/10/15/30/60m), `MultiTimeframePersistenceService.fetchAndCompute` extrait depuis les candles déjà fetchées pour persistence (1m Binance ou 5m EODHD) un slice `windowMinutes`-long, calcule les 3 métriques + classify.

`overallEfficiency` = moyenne sur TFs disponibles. `overallSmoothness` = `choppy` si ≥ 1 TF choppy, `smooth` si tous smooth, sinon `mixed`.

### Gate scanner

Optionnel. Si `lisa_session_configs.gainers_min_path_efficiency != null` :
```
if (persistence.pathQuality.overallEfficiency < min) skip
```
Default `0.5` (50% efficient). `null` désactive le gate.

### UI

- Colonne "Path" dans le tableau persistence avec badge 🟢 / 🟡 / 🔴 + tooltip `eff X% · label`
- Toggle "Cacher choppy" filtre client-side (n'affecte pas le backend)

### Cas d'usage

| Profil prix sur 30m | Path | Décision |
|---|---|---|
| Croissance linéaire +3% | 🟢 smooth | OPEN |
| Rebonds [+2%, +1%, +3%, +1%, +3%] | 🟡 mixed | OPEN (gate par défaut) |
| Pump +5% puis dump -3% (net +2%) | 🔴 choppy | SKIP avec gate à 0.5 |

Documentation complète path quality + persistence multi-TF : voir aussi `CLAUDE.md` sections P8 / P9-UX.
