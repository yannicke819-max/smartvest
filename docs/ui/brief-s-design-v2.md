# Brief Sprint S-DESIGN-V2

**Owner** : Yannick (yannicke819-max)
**Date création** : 2026-05-02
**Status** : SCOPED, à démarrer Phase 3 du chantier Gainers V1 (T0+3j → T0+20j+) en parallèle du shadow run, sur des branches `ui/` et `design/` qui ne touchent PAS `apps/api/src/modules/gainers-scanner/`.

## Mission

Refonte UI/UX SmartVest "touchy + innovant", site actuel jugé trop minimal (couleurs fades, cartes symétriques, manque de micro-interactions). Audit + design + 2 livrables : page admin gainers métrics enrichie + mode "simulation live".

## Stack confirmée

- Next.js 14 App Router + Tailwind 3.4 + shadcn/ui pattern manuel
- À ajouter : **Framer Motion** (micro-interactions), **Tremor** (cards dashboard), **cmdk** (command palette ⌘K), **canvas-confetti** (milestones)
- Recharts existant pour standard, Tremor en complément pour cards fintech
- Dark mode infrastructure prête (HSL custom), switcher UI à ajouter

## Livrables A → B → C

### A. Audit visuel (T0+3j → T0+5j)

`docs/ui/audit-v2-2026-05.md` — pour chaque page : screen desktop 1440x900 + mobile 375x667.

Pages à auditer (13 + admin) : `/onboarding`, `/dashboard`, `/portfolio`, `/results`, `/lisa`, `/backtest`, `/projections`, `/optimize`, `/strategies`, `/notifications`, `/operations`, `/account`, `/help`, `/admin/gainers/*`.

Pour chaque : hiérarchie visuelle, densité info, navigation, CTA, pain points UX, comparaison concurrents (Robinhood, Revolut, Trade Republic, Nutmeg, eToro).

### B. Design system V2 (T0+5j → T0+10j)

`docs/ui/design-system-v2.md`.

- 3 options palette (bleu-violet Revolut / vert-teal fintech US / sombre premium Robinhood Gold) → tokens Tailwind
- 2 options typo (Inter+Geist vs Satoshi+Cabinet Grotesk)
- Grilles bento asymétriques (cartes 2x1, 1x2, 2x2)
- Micro-interactions Framer Motion : hover, number spring, chart tooltips, skeleton loaders
- Composants : live ticker bar, command palette ⌘K, empty states illustrés, confetti milestone
- Dark/light switcher
- Mobile-first : bottom tab bar, pull-to-refresh, swipe gestures

### C. Mode SIMULATION (T0+10j → T0+25j) — **élargi**

Page `/simulation/gainers` (backtest historique) + page `/simulation/live` (live virtual capital).

#### C.1 Backtest historique

- Budget virtuel (1k/10k/50k/100k€), période (30/90/180j), univers (US/crypto/both)
- Lance dry-run sur data historique → équivalent du shadow run mais déclenché à la demande
- Signaux affichés en card animation slide+glow, badge trigger type
- P&L cumulé vs SPY/BTC, equity curve, drawdown, Sharpe, win rate, best/worst trade
- Export CSV + Compare runs (deux runs côte à côte)
- Réutilise BLOC 1-4 en mode shadow flag, pas de vrais trades

#### C.2 SIMULATION LIVE (NOUVEAU — 02/05/2026)

**Flag** : `GAINERS_SIMULATION_LIVE=true`. Mode utilisateur-facing distinct de shadow (backend stat) et backtest (historique).

##### Capital virtuel
- Budget initial 1k / 10k / 50k / 100k / custom
- Position sizing auto selon TP/SL BLOC 4 (ADR-005 §11.1) et budget dispo
- Allocation max par position configurable (défaut **5% du capital**)

##### Data feed
- 100% vraies valeurs marché live EODHD (intraday 1min, WebSocket si dispo)
- Univers : US watchlist 215 + crypto top 12 (configurable par run)
- Réutilise scanner BLOC 1-4 prod (pas de duplication code)

##### Resets automatiques (CRITIQUE)
| Reset | Quand | Action |
|---|---|---|
| **Daily** | 00:00 UTC quotidien | SNAPSHOT P&L jour → archive `gainers_sim_daily_snapshots` + RESET compteur jour à 0. **Positions ouvertes restent ouvertes**. |
| **Monthly** | Dernier jour mois 23:59:59 UTC | SNAPSHOT P&L mois → archive `gainers_sim_monthly_snapshots` + RESET compteur mois à 0. **Positions ouvertes restent ouvertes**. |
| **Full** | Manuel (user click) | RESET capital + ferme toutes positions. Param `reset-monthly-capital-too: bool` pour scope. |

##### Métriques affichées
- **P&L aujourd'hui** (+ %) — réinit chaque minuit UTC
- **P&L ce mois-ci** (+ %) — réinit fin de mois
- **P&L cumulé** (+ %) — depuis début sim (jamais reset sauf user)
- **Equity curve live** (area chart, granularité 1min)
- **Tableau historique** : daily snapshots (30 derniers j) + monthly snapshots (12 derniers mois)
- **Positions ouvertes** temps réel (ticker, entry, current, unrealized P&L, time, trailing state)
- **Positions clôturées du jour** (exit reason, realized P&L, duration)
- **KPIs** : Sharpe (rolling 30j), Win rate (today/month/all), Max DD (today/month/all), avg hold time

##### UI
- Page `/simulation/live` distincte de `/simulation/gainers`
- **Hero section** : gros chiffre P&L aujourd'hui + **countdown** prochain reset (`Reset dans 14h 23min`)
- Badge mode actif : `LIVE · Capital virtuel X€`
- Toggle pause/resume simulation (stoppe exécution sans reset)
- Bouton "Commencer une nouvelle simulation" → modal config (budget, univers, dates)
- Notifications toast temps réel : `Signal PULLBACK_HL_FIBO sur NVDA — position ouverte`
- Graph 3 courbes superposées : P&L today / month / all-time
- **Mobile** : vue swipeable (today / month / all-time)

##### Architecture backend
**Tables** :
- `gainers_sim_runs (id, user_id, config_json, started_at, status, capital_initial, capital_current)`
- `gainers_sim_positions (id, run_id, ticker, entry_price, quantity, tp, sl, trailing_state, entry_at, exit_price, exit_at, exit_reason, pnl_realized)`
- `gainers_sim_daily_snapshots (id, run_id, date, pnl_daily, trades_count, win_rate_daily, positions_open_eod)`
- `gainers_sim_monthly_snapshots (id, run_id, yyyy_mm, pnl_monthly, trades_count, win_rate_monthly, sharpe_monthly, max_dd_monthly)`

**Cron** :
- Quotidien 00:00 UTC : flush daily snapshot + reset compteur
- Dernier jour mois 23:59:59 UTC : flush monthly + reset compteur

**Realtime** : Supabase Realtime ou Socket.io pour push backend → frontend.

##### Comportement positions lors des resets
- Reset daily/monthly **ne ferme PAS** les positions ouvertes. Archive juste le P&L cumulé de la période et remet le compteur période à 0.
- Positions ouvertes continuent leur vie (TP/SL/trailing) entre périodes.
- P&L all-time = somme de tous snapshots + unrealized des positions ouvertes.

##### Isolation vs autres modes
| Mode | Flag | Données | Trades réels |
|---|---|---|---|
| Live | `GAINERS_V1_LIVE=true` | `gainers_positions` | OUI (post-shadow validé) |
| Shadow | `GAINERS_V1_SHADOW=true` | `gainers_v1_shadow_signals` | NON (validation stat) |
| Backtest | `GAINERS_BACKTEST_ENABLED=true` | éphémère in-memory + export CSV | NON (data historique) |
| **Simulation live** | `GAINERS_SIMULATION_LIVE=true` | `gainers_sim_*` | NON (data live, capital virtuel) |

Aucune interférence : 4 modes orthogonaux. User peut avoir plusieurs `gainers_sim_runs` actifs en parallèle (compare budget 10k vs 100k, univers US vs crypto).

##### Scope restriction
- Pas de monétisation tant que V1 live pas validée
- Activation derrière flag user (feature toggle admin) pour beta interne

#### Estimation C élargie

| Sous-livrable | Avant | Après |
|---|---|---|
| C.1 Backtest historique | 7j | 7j (inchangé) |
| C.2 Simulation live | — | **+6-8j** |
| **Total C** | **10j** | **13-15j** |

Dépendances : PR6 shadow run infra (PR à venir Phase 2.3) + admin/gainers/v1-metrics dashboard (PR #202 mergé) pour wiring data + observability.

## Garde-fous

- Branches `ui/` ou `design/` uniquement
- Aucune modif backend gainers pendant shadow run (4 sem T0→T0+30j)
- Review utilisateur OBLIGATOIRE à chaque livrable A, B, C
- Accessibilité WCAG AA, ARIA, keyboard nav
- Test local NestJS boot avant chaque push (règle session)

## Roadmap chantier S-DESIGN-V2

| Phase | Dates | Livrable |
|---|---|---|
| Audit | T0+3j → T0+5j | A — `audit-v2-2026-05.md` (13 pages screened + concurrents) |
| Design system | T0+5j → T0+10j | B — `design-system-v2.md` (palette, typo, components, motion) |
| Backtest UI | T0+10j → T0+17j | C.1 — `/simulation/gainers` |
| Simulation live | T0+17j → T0+25j | C.2 — `/simulation/live` + tables `gainers_sim_*` + cron resets |
| Buffer review | T0+25j → T0+28j | itérations review user |

T0 = 2026-05-02 (aujourd'hui). Fin estimée : ~30/05/2026, en parallèle du shadow run qui se termine ~02/06/2026.

## Liens

- ADR-002 grand public ready (S1-S8 complete) : `docs/adr/ADR-002-grand-public-ready.md`
- ADR-005 gainers algo V1 : `docs/adr/ADR-005-gainers-algo-v1.md`
- Roadmap gainers : §11 ADR-005
- Issue tech debt restantes : #193 #194 #195 (tous closes par PR #201/#203)
