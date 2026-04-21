# Guide de connexion — brokers SmartVest

Guide pratique pour connecter chaque broker supporté. Toutes les credentials
saisies ici sont chiffrées dans Supabase Vault dès réception côté API.

> **Important : aucun ordre réel n'est envoyé dans cette version.**
> Les adapters live sont câblés en interface ; leurs méthodes `placeOrder`
> refusent systématiquement tant que `BROKER_EXECUTION_ENABLED` + un mandat
> d'autonomie valide + `BROKER_ADAPTER_<X>_ENABLED` ne sont pas tous actifs.

---

## Pré-requis (une seule fois)

Dans Supabase :

1. **Activer l'extension Vault** : Dashboard → Database → Extensions → `vault`.
2. Vérifier que le service role key est bien défini côté API
   (`SUPABASE_SERVICE_ROLE_KEY`) — le service ne peut pas écrire dans le Vault
   sans cette clé.
3. Appliquer la migration `0012_broker_connections.sql`.

Côté variables d'environnement (`.env.local`) :

```bash
FEATURE_BROKER_CONNECTIONS_ENABLED=true    # déjà on par défaut
FEATURE_BROKER_SYNC_READ_ONLY_ENABLED=true # déjà on par défaut
# Activer uniquement le provider que tu utilises, un par un :
FEATURE_BROKER_ADAPTER_IB_ENABLED=false
FEATURE_BROKER_ADAPTER_SAXO_ENABLED=false
FEATURE_BROKER_ADAPTER_TRADING212_ENABLED=false
```

---

## Interactive Brokers

**Mode** : API HTTPS locale via le **Client Portal Gateway** (Java, fourni par IBKR).

### Où trouver les credentials

1. Télécharger le **Client Portal Gateway** :
   https://www.interactivebrokers.com/en/trading/ib-api.php (section "Client Portal API").
2. Lancer localement (Java 8+ requis) :
   ```bash
   cd clientportal.gw
   bin/run.sh root/conf.yaml
   ```
   Le gateway écoute sur `https://localhost:5000`.
3. Ouvrir `https://localhost:5000` dans un navigateur, accepter le certificat
   auto-signé, se connecter avec tes identifiants IBKR. Une session est créée.
4. Trouver ton **accountId** : visible dans le portail IBKR (format `U1234567`).
5. Récupérer le **session token** : via l'endpoint
   `GET https://localhost:5000/v1/api/iserver/auth/status` — le cookie `API`
   ou le token de session retourné sert de `sessionToken`.

### Connexion dans SmartVest

- Aller sur `/settings/brokers/new`
- Provider : **Interactive Brokers**
- Account ID : `U1234567`
- Session token : (le jeton retourné par l'étape 5)
- Puis activer `FEATURE_BROKER_ADAPTER_IB_ENABLED=true` côté serveur.

### Limitations

- La session IB expire après ~24h d'inactivité → penser à réactiver la session
  via le portail ou via un cron local.
- Rate-limit IB : ~5 req/s par session.

---

## Saxo (OpenAPI)

**Mode** : OAuth2 live via l'OpenAPI Saxo.

### Où trouver les credentials

1. Créer un compte développeur sur https://www.developer.saxo/
2. Onglet **Apps** → **Create App** (type : *personal*).
3. Récupérer `client_id` + `client_secret`.
4. Exécuter le flow OAuth2 Authorization Code :
   - Redirection vers `https://sim.logonvalidation.net/authorize` (ou `live.logonvalidation.net`)
   - Callback avec `code` → échange contre `access_token` + `refresh_token`
     à `/token` endpoint.
   - Noter `expiresAt` (ISO 8601) à partir de `expires_in` (secondes).

### Connexion dans SmartVest

- Provider : **Saxo**
- OAuth access token : (récupéré à l'étape 4)
- OAuth refresh token : idem
- Expiration du token : datetime-local
- Account ID (optionnel) : ton `ClientKey` ou `AccountKey` Saxo

### Limitations

- Token access expire généralement sous 1 heure — SmartVest devra rafraîchir
  via `refresh_token` (à implémenter dans l'adapter quand `*_IB_ENABLED` sera on).
- Env **SIM** (simulation) et **LIVE** ont des URLs différentes — par défaut
  l'adapter pointe sur live.

---

## Trading 212

**Mode** : API officielle via clé API personnelle.

### Où trouver les credentials

1. Ouvrir Trading 212 (app ou web).
2. **Settings** → **API** (visible uniquement pour les comptes **Invest**
   ou **ISA**, pas sur les comptes **CFD**).
3. **Generate API Key** → choisir les scopes :
   - `account` (lecture compte / positions)
   - `history` (historique ordres)
   - **ne pas cocher** les scopes d'exécution tant que SmartVest reste read-only.
4. Copier la clé (format long alphanumérique).

### Connexion dans SmartVest

- Provider : **Trading 212**
- API key : (la clé copiée)
- Account ID (optionnel)
- Activer `FEATURE_BROKER_ADAPTER_TRADING212_ENABLED=true`.

### Limitations

- Rate-limit strict : **1 req / seconde** par clé sur les endpoints persos.
- Les comptes **CFD** ne supportent pas l'API — seuls Invest et ISA.

---

## DeGiro, Bourse Direct, Fortuneo → CSV uniquement

**Aucune API publique officielle.** SmartVest ne scrape pas ces services.

### Procédure

1. Dans SmartVest, créer une connexion de type **DeGiro** (ou Bourse Direct /
   Fortuneo) via `/settings/brokers/new`. La connexion se crée sans
   credentials — c'est une entrée déclarative.
2. Exporter depuis le portail broker un CSV de transactions :
   - **DeGiro** : Activité → Transactions → Export (format CSV).
   - **Bourse Direct** : Historique → Export.
   - **Fortuneo** : Historique → Export CSV.
3. Utiliser `/imports` (module `broker-import` existant, parsers déjà livrés
   pour DeGiro et IB) pour importer le CSV.
4. Les transactions apparaissent ensuite dans le portefeuille normal.

Activer ou non les flags `BROKER_ADAPTER_DEGIRO_ENABLED` etc. ne change rien —
ces adapters redirigent toujours vers le CSV import.

---

## Manuel

Provider fallback. Crée une connexion vide sans aucune credentials. Sert de
regroupement logique pour des positions saisies manuellement via l'UI
portefeuille ou importées par CSV générique.

---

## Vérifier qu'une connexion fonctionne

Depuis `/settings/brokers/:id` :

1. **Tester la connectivité** : bouton en haut. Appelle `adapter.testConnection()`.
   - `ok: true` pour MANUAL (pas de réseau).
   - `ok: false` avec message explicite pour les stubs tant que le flag adapter
     est off, ou tant que les credentials ne sont pas validées contre l'endpoint live.
2. **Sync now** : déclenche un job `broker_sync_jobs`. Apparaît dans l'historique
   en bas de page. Statuts possibles : `running` / `success` / `partial` /
   `failed` / `cancelled` (kill-switch).
3. **Audit** : `GET /brokers/connections/:id/audit` renvoie la chaîne de
   hash-chained events.

---

## Prochaine étape logique — activer l'exécution réelle

**Ne pas flipper ces flags avant d'avoir testé la sync read-only sur un compte
live pendant au moins quelques jours et audité le Vault.**

Dans l'ordre :

1. `FEATURE_BROKER_ADAPTER_<X>_ENABLED=true` (par provider, un à la fois).
2. Vérifier qu'une sync read-only sur ce provider renvoie des positions
   cohérentes (comparer au portail broker).
3. Créer un `AutonomyMandate` en mode brouillon dans `/settings/delegation`,
   valider les `guardrail` (caps de position, caps journalières, stop-loss,
   allowed asset classes).
4. `FEATURE_DELEGATION_AUTONOMOUS_GUARDED=true` côté serveur.
5. Activer le mandat : statut `active`, `killSwitchActive=false`.
6. Éventuellement `FEATURE_HYPER_TRADING_EXECUTION_ENABLED=true` si usage
   hyper-trading envisagé.
7. `FEATURE_BROKER_EXECUTION_ENABLED=true` en dernier. Réserver pour un commit
   dédié où `placeOrder()` est effectivement implémenté (pas le cas dans
   la version courante).

**À aucune étape** le `FEATURE_AUTONOMY_KILL_SWITCH=true` ne doit être nécessaire
pour fonctionner — c'est un frein d'urgence, pas une clé de mise en route.
