# ADR-004 — Articulation Lisa V3 (Copilote + Modes + Surfaces)

- **Date** : 2026-05-01
- **Owner** : Yannick (yannicke819-max)
- **Status** : ACCEPTED — articulation V3 figée par validation utilisateur
- **Sprint cible** : V3 R0-R5 (post-V2 ADR-002)
- **Suit** : ADR-002 (Grand-public-ready) en cours de livraison V2

## 1. Contexte

ADR-002 livre la V2 « Grand Public Ready » (Sprint 1 vocabulaire, Sprint 2 glossaire 80 termes, Sprint 3 RiskBadge actif, Sprint 6 polish settings… STOP avant Sprint 5 onboarding refonte). En parallèle, l'utilisateur a validé une **articulation V3** plus ambitieuse qui repense la surface produit autour d'un **Copilote** et d'un **système de Modes UI** stable.

V3 ne casse pas V2 : c'est une **évolution de surface** (URLs/IA), pas un changement métier. Le moteur Lisa et les services back restent strictement inchangés.

L'ADR-004 fige cette articulation pour éviter la dérive UX au fil des sprints. Il déclenche une roadmap R0-R5 qui démarrera **après** la livraison complète de V2 (S5 onboarding compris).

## 2. Décisions structurantes

### 2.1 Lisa = moteur back, Copilote = surface user

| Couche | Nom | Rôle | Visibilité user |
|---|---|---|---|
| Back | **Lisa** (LLM + Mechanical + Scanner) | Moteur d'analyse, propositions, exécution paper | Aucune — détail d'implémentation |
| Front | **Copilote** | Surface user qui présente les outputs Lisa | 100 % de l'UX V3 référence le Copilote |

Conséquences :
- Le mot « Lisa » disparaît de la sidebar, des titres `h1`, du `document.title` et des breadcrumbs côté V3.
- Les services back (`LisaService`, `LisaAutopilotService`, etc.) gardent leur nom — ils ne sont jamais exposés dans l'UI.
- Le Copilote devient l'**unique point d'entrée IA** côté front.

### 2.2 Mapping 3 Modes UI → 4 profils existants

V3 expose 3 modes principaux (+ 1 toggle indépendant) à l'utilisateur, qui se mappent sur les profils déjà en base (cf. CLAUDE.md §6 ter et règle opérationnelle MODES OPÉRATOIRES — P7) :

| Mode UI V3 | profile | capital_discipline_mode | autopilot_cycle_minutes |
|---|---|---|---|
| 🌿 **Sérénité** | `long_term_investor` | `NONE` | 60 min |
| ⚖️ **Équilibre** | `active_trading` | `DAILY_HARVEST` | 30 min |
| 🚀 **Pilote** | `hyper_active` | `DAILY_HARVEST` | 15 min |
| 🎯 **Sniper** *(toggle indépendant)* | `sniper_mode` (override temporaire) | inchangé | 5 min |

Notes :
- Les 3 modes principaux sont **mutuellement exclusifs** — l'utilisateur en choisit exactement un.
- **Sniper est un toggle indépendant** qui se superpose au mode courant pour une session courte (TTL obligatoire, cf. CLAUDE.md §6 bis « Mode sniper »). Ne change pas le `profile` durable.
- Le mapping est centralisé dans `MacroModeService.applyMacroMode(modeUiV3)` côté back ; aucune dérogation côté front.

### 2.3 Éclatement de `/lisa` en 6 surfaces

`/lisa` (route legacy) est **supprimée** côté V3 et redirigée en **HTTP 301 → `/copilote`** dans le middleware Next.js (préserve les bookmarks).

L'éclatement par responsabilité :

| Route V3 | Responsabilité | Source de données |
|---|---|---|
| `/copilote` | Hub principal — résumé jour, mode actif, prochaines actions Lisa, kill-switch | `LisaService` + `MechanicalTradingService` + `MacroModeService` |
| `/opportunites` | Liste des thèses/scanners actifs (gainers, rebound, narrative) — vue cross-mode | `TopGainersScannerService` + `LisaService.proposals` |
| `/journal-marche` | Briefing macro/sectoriel + news prioritaires + indicateurs régime | `news-aggregator` + `MarketSnapshot` |
| `/pilote/*` | Outils mode-gated (ex : `/pilote/scanner-config` visible uniquement en mode Pilote/Sniper) | route gardée par `useStrategyMode()` |
| `/portefeuille` (onglet « Thèse ») | Onglet supplémentaire sur `/portefeuille` qui affiche la thèse Lisa associée à chaque position | `lisa_proposals` × `lisa_positions` |
| `/boussole` | Chat IA libre (questions ouvertes : « explique-moi ce trade », « simule sortie demain ») | nouveau endpoint `/copilote/chat` |

### 2.4 Composant `<LisaExplain target=...>` universel (R1)

Composant transverse qui, posé sur **n'importe quelle surface**, rend une explication contextuelle générée par Lisa sur l'élément ciblé.

```tsx
<LisaExplain target={{ kind: 'position', id: positionId }} />
<LisaExplain target={{ kind: 'thesis', id: thesisId }} />
<LisaExplain target={{ kind: 'metric', name: 'sharpe', value: 1.42 }} />
<LisaExplain target={{ kind: 'event', kind: 'stop_triggered', payload: {...} }} />
```

Comportement :
- Bouton « Pourquoi ? » discret (icône `Sparkles`)
- Au clic → appel `/copilote/explain` avec le `target` sérialisé
- Renvoie une explication 2-4 phrases en français courant adapté au tier d'expérience (cf. ADR-002 §4)
- Cache local (`react-query`, staleTime 10 min) pour éviter spam LLM

Doit être **plug-and-play** sur les 6 surfaces V3 + les pages V2 qui survivent (`/portfolio`, `/performance`, `/history`, `/alerts`).

### 2.5 Bottom navigation 5 onglets (mobile-first)

| # | Onglet | Route | Icône lucide |
|---|---|---|---|
| 1 | Accueil | `/` (= dashboard) | `LayoutDashboard` |
| 2 | Portefeuille | `/portefeuille` | `Wallet` |
| 3 | Opps | `/opportunites` | `Sparkles` |
| 4 | Copilote | `/copilote` | `Bot` |
| 5 | Profil | `/profil` (= `/settings` rebranded) | `User` |

Bottom nav fixe en bas sur mobile (`<md`) ; sidebar latérale conservée sur desktop (`md+`). L'onglet actif est mis en valeur par couleur primaire + label visible.

## 3. Roadmap V3 (R0 → R5)

| Phase | Scope | Livrables | Bloque sur |
|---|---|---|---|
| **R0** | Rebranding | Renommage Lisa→Copilote dans l'UI (sidebar, h1, document.title), redirect 301 `/lisa→/copilote`. Aucune nouvelle page. | V2 S5 mergée |
| **R1** | Shell + modes + LisaExplain | Bottom nav 5 onglets, sélecteur 3 modes UI, toggle Sniper, composant `<LisaExplain>` posé sur 4 surfaces pilotes. | R0 |
| **R2** | Copilote + Opps + Journal + Lisa Coach | `/copilote`, `/opportunites`, `/journal-marche` complets. « Lisa Coach » = mode tutoriel adaptatif déclenché par tier débutant. | R1 |
| **R3** | Boussole + voice | `/boussole` chat IA libre. Voice mode (audio Web Speech API → texte → Boussole). | R2 |
| **R4** | Découvrir + Communauté + Impact + Sandbox | Découvrir = explorer thèses publiques. Communauté = watchlists partagées (anonymisé). Impact = % portefeuille ESG-aligned. Sandbox = parcours guidé "investir 100 € fictifs" pour onboarding. | R3 |
| **R5** | Widgets + Wrapped | Widgets iOS/Android (PWA) pour quick view. Wrapped annuel type Spotify (récap année + insights). | R4 |

## 4. Six bonus features — priorités P0/P1/P2

Liste figée des **6 features bonus** mentionnées en validation utilisateur, classées par priorité d'impact UX. Toutes sont reportées en R3-R5 (post-V3 cœur).

| # | Feature | Phase cible | Priorité | Justification |
|---|---|---|---|---|
| 1 | **Sandbox éducatif** (parcours « 100 € fictifs ») | R4 | **P0** | Bloquant grand-public débutant (taux d'activation post-onboarding) |
| 2 | **Voice mode** (Boussole audio) | R3 | **P1** | Différenciateur fort, faible coût (Web Speech API native) |
| 3 | **Widgets PWA** (iOS/Android) | R5 | **P1** | Multiplie la fréquence d'usage sans demander de visite app |
| 4 | **Wrapped annuel** (récap Spotify-style) | R5 | **P2** | Effet viral / partage, faible blocant business |
| 5 | **Communauté (watchlists anonymisées)** | R4 | **P2** | Risque modération + RGPD ; à gater sous flag avant publication |
| 6 | **Impact ESG (dashboard)** | R4 | **P2** | Demande données externes ESG (provider à choisir) ; valeur principalement signaling |

P0 = bloquant pour la cible grand-public. P1 = fort différenciateur. P2 = nice-to-have, peut glisser entre phases.

## 5. Hors scope (V3 strict)

- ❌ Exécution réelle d'ordres broker (cf. CLAUDE.md §6 ter — chaîne de garde-fous toujours valide).
- ❌ Versions natives iOS/Android (PWA suffit pour widgets en R5).
- ❌ Multi-utilisateurs / collaboration directe (Communauté reste anonymisée en R4).
- ❌ Refonte du modèle de données back (Lisa/Mechanical inchangés — ADR-004 ne touche QUE les surfaces).

## 6. Lien avec V2 (ADR-002)

| ADR-002 livre | Statut | Conservé en V3 ? |
|---|---|---|
| Sprint 1 — vocabulaire grand public | ✅ mergé | Oui (renommages V3 le complètent — Lisa→Copilote) |
| Sprint 2 — glossaire 80 termes | ✅ mergé (`e8b6fff`) | Oui (alimente `<LisaExplain>` et `/aide/glossaire`) |
| Sprint 3 — `<AssetRiskLevel>` | 🟡 PR #171 en cours | Oui (utilisé partout en V3) |
| Sprint 6 — polish settings | ✅ mergé (`b21cffc`) | Oui (page `/profil` = `/settings` rebranded) |
| Sprint 5 — onboarding refonte | ⏸ STOP avant validation | **Pré-requis R0** — V3 ne démarre pas avant que S5 soit livré |
| Sprint 4 — `/aide` hub | ⏸ Non démarré | Préservé tel quel en V3 |
| Sprint 7-8 — empty states + légal | ⏸ Non démarré | Préservé tel quel en V3 |

## 7. Risques

| Risque | Sévérité | Mitigation |
|---|---|---|
| Confusion utilisateur entre « Lisa » (back, jamais visible) et « Copilote » (front) | Moyen | R0 fait un rebranding complet en une PR — pas de coexistence |
| Bottom nav cache du contenu sur petits écrans | Faible | Padding bottom global `pb-16` sur layout mobile |
| `<LisaExplain>` spam LLM si abusé | Moyen | Cache 10 min côté front + rate-limit serveur 30 req/h/user |
| `/pilote/*` mode-gated invisible aux débutants → effet « features cachées » | Faible | Onboarding R1 explique le système de modes ; tooltip sur sélecteur |
| Mode Sniper + Mode Pilote simultanés ambigus | Moyen | `MacroModeService` rejette toute combinaison invalide ; UI gris-out incompatibilités |

## 8. Décision

> Articulation V3 figée par cet ADR. Implémentation **bloquée** jusqu'à livraison complète de V2 (incluant Sprint 5 onboarding refonte validé par utilisateur).
>
> Lorsque V2 est complète, R0 (rebranding) démarre en première PR `feat/v3-r0-rebranding`. Les phases suivantes (R1-R5) suivent dans l'ordre, chacune en PR isolée auto-mergée si CI verte.

Toute dérogation au mapping Modes UI ↔ profils, à l'éclatement des routes, ou à la roadmap R0-R5 nécessite un **ADR follow-up** (ADR-005+) et la validation explicite de l'utilisateur. L'autonomie d'exécution accordée pour V2 ne couvre pas V3.
