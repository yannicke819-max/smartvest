# FRED_API_KEY — Usage doc

**Statut actuel** : ⚠️ MANQUANT (Fly secret non set au 30/04/2026 14:30 UTC).
Le système fonctionne mais en **mode dégradé** sur 3 indicateurs macro.

## 1. Comment obtenir la clé

1. Aller sur https://fred.stlouisfed.org/docs/api/api_key.html
2. Cliquer "Request or View Your API Key"
3. Login Google/email + valider compte
4. Demander une clé (justifier "personal investment research" — approbation instantanée)
5. Copier la clé (string 32 chars hex, ex. `abcdef1234567890abcdef1234567890`)

**Plan** : free tier — **120 requests / minute**. SmartVest call FRED ~3 fois par
cycle Lisa (DGS10 + DGS2 + VIXCLS), cycle min 5 min en `harvest`, max 60 min en
`investment` → consommation peak ~36/h, **largement sous la limite**.

## 2. Set Fly secret

```bash
flyctl secrets set FRED_API_KEY=<la-clé-32-chars> -a smartvest
# Auto-redeploy déclenché. ~40s.
```

Pas besoin de set sur Vercel ni GitHub Actions — la clé est consommée
**uniquement par le backend Nest** (`apps/api`).

## 3. Où la clé est consommée — call sites runtime

Tous les call sites passent par `fetchFred()` dans
`apps/api/src/modules/lisa/services/lisa.service.ts:2742`.

| Indicateur macro | Série FRED | Position dans cascade | Comportement sans clé |
|---|---|---|---|
| `vix` | `VIXCLS` | #2 (après yahoo `^VIX`) | Skip silencieux, fallback `eodhd:VIX.INDX` (souvent 404) → `stooq:^vix` → `eodhd:VXX.US` (proxy ETF, decay) |
| `us10y` | `DGS10` | #3 (après yahoo `^TNX`, eodhd `TNX.INDX`) | Skip silencieux, fallback `stooq:us10yb.u` (CSV public) ou hardcoded |
| `us2y` | `DGS2` | #3 (après yahoo `^IRX`, eodhd `IRX.INDX`) | Skip silencieux, **PAS** de stooq fallback → tombe sur hardcoded |

**Code clé** :
```typescript
// apps/api/src/modules/lisa/services/lisa.service.ts:2742
const fredKey = this.config.get<string>('FRED_API_KEY') ?? null;
const fetchFred = async (seriesId) => {
  const url = buildFredObservationsUrl(seriesId, fredKey);
  if (!url) return null;  // ← skip silencieux si pas de clé
  // ... fetch + retry 2× + parse
};
```

```typescript
// apps/api/src/modules/lisa/helpers/macro-fallback.helper.ts:306
export function buildFredObservationsUrl(seriesId, apiKey) {
  if (!apiKey) return null;  // ← null URL = skip côté caller
  return `https://api.stlouisfed.org/fred/series/observations?series_id=${s}&api_key=${k}&file_type=json&sort_order=desc&limit=5`;
}
```

## 4. Dégradation actuelle (sans `FRED_API_KEY`)

### 4.1 VIX (volatilité S&P 500)

- Cascade actuelle : `yahoo:^VIX` → `eodhd:VIX.INDX` → `stooq:^vix` → `eodhd:VXX.US` proxy
- Yahoo `^VIX` est généralement OK mais a des outages réguliers (rate limit, 503)
- EODHD `VIX.INDX` a souvent `empty_price_field` (cassé per CLAUDE.md "Tickers à ne jamais utiliser")
- Stooq fonctionne mais c'est du EOD only (pas intraday)
- **Sans FRED**, en cas de panne yahoo simultanée, on tombe sur stooq (EOD) ou VXX proxy (decay structurel)
- Avec FRED : tier 1 backup officiel Fed, EOD aussi mais source de vérité absolue

### 4.2 US10Y (taux 10 ans Trésor US)

- Cascade actuelle : `yahoo:^TNX` → `eodhd:TNX.INDX` → `stooq:us10yb.u`
- `^TNX` Yahoo est correct mais souffre des mêmes outages
- `eodhd:TNX.INDX` souvent cassé
- Stooq EOD only
- **Sans FRED**, idem VIX : panne yahoo = on tombe sur stooq EOD ou hardcoded
- Avec FRED `DGS10` : data Fed officielle, EOD cohérente avec le marché bond US

### 4.3 US2Y (taux 2 ans Trésor US — proxy short rate)

- Cascade actuelle : `yahoo:^IRX` (13-week T-Bill, **pas vraiment 2y**) → `eodhd:IRX.INDX`
- **Pas de stooq fallback** pour us2y → si yahoo + eodhd down, **fallback hardcoded direct**
- C'est l'indicateur **le plus fragile** sans FRED
- Avec FRED `DGS2` : vraie série 2-year Treasury Constant Maturity

## 5. Impact business

`MarketSnapshot.dataQuality.fallback` se peuple avec ces indicateurs quand
toutes les sources sont down. Per CLAUDE.md §6 quater "Bloc DATA QUALITY dans
le briefing" :

> Si `dataQuality.fallback` n'est pas vide, Lisa doit éviter de fonder un
> changement de régime sur un indicateur en `fallback`. Privilégier
> l'analyse bottom-up si ≥3 indicateurs en fallback.

→ Plus de fallbacks = plus de cycles où Lisa **renonce à fonder une thèse macro**
ou doit downgrade ses convictions. Avec FRED set, on rajoute une 3e source live
fiable EOD pour 3 indicateurs critiques.

## 6. Vérification post-set

```bash
# 1. Vérifier que la clé est bien set
flyctl secrets list -a smartvest | grep FRED_API_KEY

# 2. Smoke test direct (curl avec la clé)
curl -s "https://api.stlouisfed.org/fred/series?series_id=GDP&api_key=<la-clé>&file_type=json" | jq '.seriess[0].title'
# Attendu : "Gross Domestic Product"

# 3. Test runtime via le smoke-test script
ANTHROPIC_API_KEY=... GEMINI_API_KEY=... EODHD_API_KEY=... \
SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... FRED_API_KEY=<la-clé> \
pnpm tsx scripts/test-secrets.ts
# Attendu : `FRED_API_KEY ✅ OK 200 OK series=GDP`

# 4. Vérifier dans les logs admin que la cascade utilise FRED
curl -sH "x-admin-token: $ADMIN_TOKEN" \
  "https://smartvest.fly.dev/admin/logs/recent?pattern=source=fred&limit=20"
# Attendu : entries avec "ticker=VIXCLS source=fred success=true"
#                        "ticker=DGS10  source=fred success=true"
#                        "ticker=DGS2   source=fred success=true"
```

## 7. Rollback

Si la clé pose problème (rate limit, key révoquée, etc.) :
```bash
flyctl secrets unset FRED_API_KEY -a smartvest
```
→ retour silencieux à l'état actuel (cascade sans FRED). Pas de crash, juste
qualité dégradée.

## 8. Monitoring continu

À surveiller post-set via `/admin/logs/recent` :
- Pattern `source=fred success=false` répété → Fed API outage ou rate limit
- Pattern `source=fred.*HTTP_429` → on dépasse 120 req/min (improbable)
- Pattern `fred_parser_returned_null` → réponse FRED contenait `error_code`
  (clé invalide ?)

Si > 5% des calls FRED échouent sur 1h → investiguer.

---
**Owner** : Yannick (yannicke819-max)
**Last update** : 2026-04-30 — claude/feat session ADR-001 cleanup
