# Déploiement SmartVest

Guide minimal pour déployer la démo publique.

**Architecture cible**
- Front (`apps/web`) → **Vercel** (Next.js 14)
- API (`apps/api`) → **Fly.io** (NestJS dans conteneur)
- BDD → **Supabase** (projet hébergé, Free tier suffisant pour la démo)

> ⚠️ **Ne déployez PAS `apps/api` sur Vercel.** NestJS est un serveur
> long-running (`app.listen(3001)`), pas une fonction serverless. Vercel
> cherchera un entrypoint `src/main.ts` / `api/index.ts` export-default et
> échouera (`No entrypoint found`). La seule cible officielle pour l'API est
> **Fly.io** via `apps/api/fly.toml`. Le seul projet à créer côté Vercel est
> celui du front (`apps/web`).

---

## 1. Supabase

1. Créer un projet sur [supabase.com](https://supabase.com)
2. Récupérer dans `Project Settings → API` :
   - `Project URL` → `NEXT_PUBLIC_SUPABASE_URL` / `SUPABASE_URL`
   - `anon` key → `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `service_role` key → `SUPABASE_SERVICE_ROLE_KEY` (uniquement côté API, jamais front)
3. Appliquer le schéma :
   ```bash
   supabase link --project-ref <project-ref>
   supabase db push
   ```
   ou coller les fichiers `supabase/migrations/000[1-8]*.sql` + `supabase/seed.sql`
   dans l'éditeur SQL.
4. Créer l'utilisateur de démo : `Authentication → Users → Add user` →
   `demo@smartvest.fr` + mot de passe
5. Dé-commenter la section finale de `seed.sql`, substituer `<DEMO_USER_ID>`, ré-exécuter.

---

## 2. API → Fly.io

**Installer la CLI** : [fly.io/docs/flyctl/install](https://fly.io/docs/flyctl/install/)

```bash
fly auth login
cd apps/api
fly launch --no-deploy --copy-config --name smartvest-api --region cdg
# puis depuis la racine :
fly deploy --config apps/api/fly.toml --dockerfile apps/api/Dockerfile --app smartvest-api
```

**Variables d'environnement** (à définir via `fly secrets set KEY=value`) :

| Clé | Valeur |
|---|---|
| `SUPABASE_URL` | URL projet Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key (secret) |
| `FEATURE_DELEGATION_MANUAL_EXPLICIT` | `true` |
| `FEATURE_DELEGATION_HYBRID_SUGGESTIVE` | `true` |
| `FEATURE_DELEGATION_AUTONOMOUS_GUARDED` | `false` |
| `FEATURE_AUTONOMY_KILL_SWITCH` | `false` |
| `FEATURE_READ_ONLY_BROKER_SYNC_ENABLED` | `false` |
| `FEATURE_BROKER_EXECUTION_ENABLED` | `false` |
| `EODHD_API_KEY` | `demo` (ou vraie clé si souscription) |

**Healthcheck** : `GET /health` (configuré dans `fly.toml`).

---

## 3. Front → Vercel

1. Importer le repo dans [vercel.com/new](https://vercel.com/new)
2. **Root directory** : `apps/web`
3. **Framework preset** : Next.js (auto-détecté — `vercel.json` complète)
4. **Build command** et **install command** sont définis dans `apps/web/vercel.json`
   (ils remontent à la racine pour résoudre les workspaces).

**Variables d'environnement Vercel** (Dashboard → Project → Settings → Environment Variables) :

| Clé | Valeur |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | URL projet Supabase |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | anon key (publique) |
| `NEXT_PUBLIC_API_URL` | `https://smartvest-api.fly.dev` (URL Fly.io) |
| `NEXT_PUBLIC_FEATURE_PERSONAL_MODE` | `false` |
| `NEXT_PUBLIC_FEATURE_SAFE_PUBLIC_MODE` | `true` |
| `NEXT_PUBLIC_FEATURE_REGULATED_MODE` | `false` |

**Ne pas mettre** : `SUPABASE_SERVICE_ROLE_KEY` côté Vercel — elle appartient uniquement à l'API.

---

## 4. Vérifications post-déploiement

```bash
# API vivante
curl https://smartvest-api.fly.dev/health

# Signaux macro (seedés)
curl https://smartvest-api.fly.dev/signals | jq 'length'    # 4 attendu

# Front sert bien la page dashboard après login
open https://<ton-app>.vercel.app
```

---

## 5. Points de vigilance

- **Service-role key** : strictement côté API. Fuite = accès admin à la base.
- **CORS** : côté NestJS, autoriser l'origine Vercel (`app.enableCors({ origin: [...] })` — à vérifier dans `apps/api/src/main.ts` si déploiement bloqué par CORS).
- **Feature flag `AUTONOMOUS_GUARDED`** : doit rester **`false`** en production publique tant que Phase 6 n'est pas livrée.
- **Kill-switch global** (`FEATURE_AUTONOMY_KILL_SWITCH=true`) : peut être basculé à tout moment pour geler toute exécution autonome.
