# Lire votre tableau de bord

Le tableau de bord SmartVest centralise la situation de votre portefeuille actif.
Ce guide explique chaque indicateur affiché.

---

## Les 4 indicateurs clés (KPI)

### Valeur de marché

La valeur totale de toutes vos positions, calculée au cours actuel.

```
Valeur de marché = Σ (quantité × cours actuel) pour chaque position
```

- Se met à jour à chaque rechargement (données en différé 15 min)
- En simulation, les cours sont réels mais les positions sont virtuelles
- L'icône ⓘ affiche l'heure de la dernière valorisation

### P&L latent (Profit & Loss non réalisé)

Le gain ou la perte potentiel sur vos positions **encore ouvertes**.

```
P&L latent = Valeur de marché actuelle - Coût d'achat total
```

- 🟢 Positif : vos positions valent plus que ce que vous avez payé
- 🔴 Négatif : vos positions valent moins — perte non encore encaissée
- Le P&L devient **réalisé** uniquement quand vous vendez

> Important : un P&L latent positif n'est pas de l'argent en poche.
> Le marché peut évoluer dans les deux sens avant votre vente.

### Positions ouvertes

Le nombre d'actifs différents détenus dans le portefeuille actif,
toutes classes confondues (actions, ETF, crypto, obligations…).

### Alertes actives

Le nombre de notifications déclenchées sur vos positions :

- 🔴 **Critique** : une position a atteint son seuil de stop-loss
- 🟡 **Avertissement** : une position approche d'un seuil configuré

Cliquez sur **Mes notifications** pour voir le détail et agir.

---

## Les widgets latéraux

### Connexions brokers

Liste vos comptes brokers connectés en lecture seule. Un point vert indique
une synchronisation récente. Un point rouge signale un problème de connexion.

### Résumé cash

Liquidités disponibles dans votre portefeuille (non investies).

### Contexte de marché

Indicateurs macro du moment : VIX, DXY, US10Y, cours du pétrole.
Aide Lisa à contextualiser ses analyses. Les indicateurs en fallback sont
marqués d'un badge pour indiquer une données moins fiable.

### Exposition

Répartition de votre portefeuille par classe d'actifs (actions, ETF, crypto…).
Compare votre allocation actuelle avec votre profil cible.

### Suggestions de Lisa

Propositions récentes non encore validées. Cliquez pour les consulter.

### Profil de simulation

Votre profil de risque calculé lors du questionnaire d'onboarding.
Module les paramètres des simulations Lisa. Révisable dans **Mon compte**.

### Allocation

Donut chart de votre répartition par classe d'actifs.

### Coûts de friction

Estimation des frais de transaction sur la période :
frais broker, spreads, coûts FX, slippage. Ces montants sont estimatifs.

---

## Navigation rapide

Depuis le tableau de bord, les boutons du haut permettent d'accéder aux sections clés :

| Bouton | Destination |
|---|---|
| Alertes | Toutes vos notifications avec filtre par sévérité |
| Performance | Courbe de performance historique du portefeuille |
| Objectifs | Vos objectifs financiers et leur probabilité d'atteinte |
| Macro | Tableau de bord macro-économique complet |
| Suggestions | Toutes les propositions de Lisa en attente |
| Cash | Gestion des liquidités et des virements |
| Mon assistant Lisa | Interface de dialogue avec Lisa |

---

*Les données affichées sont en différé de 15 minutes. Elles sont à titre informatif
et ne constituent pas un conseil financier.*
