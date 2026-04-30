# Configurer Lisa, votre assistant IA

Lisa est l'assistant d'analyse de SmartVest. Elle observe les marchés,
analyse votre portefeuille et vous soumet des propositions. Ce guide explique
comment la configurer selon vos besoins.

---

## Ce que Lisa fait (et ne fait pas)

### Lisa analyse et propose

- Surveille les marchés et votre portefeuille en continu
- Génère des propositions de trades avec conviction, ratio R/R et raisonnement
- Alerte sur les positions à risque (stop-loss proche, catalyseur négatif)
- Contextualise ses analyses avec les données macro du moment

### Lisa ne décide pas seule

- **Mode Manuel (défaut)** : Lisa propose, vous validez chaque action manuellement
- **Mode Hybride** : Lisa propose avec une confirmation explicite requise
- **Mode Autonome** : Lisa peut agir dans des limites strictes que vous définissez

Aucun ordre réel n'est jamais transmis à un broker sans votre autorisation.

---

## Les 3 modes stratégiques

Accédez aux modes via **Mon compte → Mode stratégique** ou le bouton **Mode** du tableau de bord.

### 📈 Mode Investment

Pour une stratégie **long terme** (buy-and-hold).

- Lisa analyse toutes les 60 minutes
- Elle privilégie des thèses à horizon semaines/mois
- Stops larges (−4 %) pour laisser respirer les positions
- Profil recommandé : Équilibré ou Dynamique

### 🌾 Mode Harvest (récolte intraday)

Pour une stratégie de **scalping intraday** assistée.

- Lisa analyse toutes les 7 minutes
- Elle vise des gains rapides de 1,5 à 2,5 % par trade
- Stops serrés (−1,5 %) — clôture automatique en cas de retournement
- Les gains réalisés sont transférés dans un vault sécurisé (non réinjectables)
- Profil recommandé : Dynamique ou Offensif

### 🚀 Mode Gainers (scanner momentum)

Pour suivre automatiquement les **valeurs en forte hausse**.

- Scanner déterministe — bypass le LLM
- Détecte les hausses sur 1 minute, vérifie la persistance sur 5/15/30/60 min
- Universel : actions US, Europe, Asie + crypto
- Nécessite un capital minimum de 1 000 €

---

## Configurer l'autopilot

L'autopilot permet à Lisa d'exécuter ses propositions automatiquement
(en simulation uniquement par défaut).

### Activer l'autopilot

1. Accédez à **Mon assistant Lisa**
2. Activez le bouton **Autopilot**
3. Configurez le budget quotidien maximum (coûts API LLM)

### Garde-fous automatiques

- **Kill-switch** : arrêt immédiat, toujours accessible
- **Budget journalier** : Lisa s'arrête si le budget est atteint, reprend le lendemain
- **Max positions simultanées** : défaut 3 (anti-dilution)
- **Stop-loss obligatoire** : chaque position a un stop configuré

---

## Lire les propositions de Lisa

Chaque proposition contient :

| Champ | Signification |
|---|---|
| Ticker | L'actif concerné (ex: AAPL.US) |
| Direction | Long (achat) ou Close (fermeture) |
| Conviction | Score 1-10 de confiance de Lisa |
| R/R | Ratio risque/rendement (ex: 1:3 = risker 1 pour gagner 3) |
| TP | Take-profit : seuil de gain cible |
| SL | Stop-loss : seuil de perte maximale |
| Raisonnement | Explication de la thèse en français |

---

## FAQ Lisa

**Lisa propose des actions d'entreprises — pas de conseil personnalisé ?**
Oui. Les propositions sont générées par analyse de marché (technique + news + macro),
pas par une connaissance de votre situation personnelle complète. Ce n'est pas
un conseil MiFID.

**Puis-je demander à Lisa d'analyser un actif spécifique ?**
Oui, via le champ de message libre dans l'interface Lisa. Exemple :
"Analyse la situation de LVMH.PA sur les 3 dernières semaines."

**Comment Lisa apprend-elle ?**
Lisa dispose d'un historique de vos trades simulés fermés. Plus vous simulez,
plus elle peut calibrer ses seuils de probabilité (modèle statistique interne).

---

*Lisa est un outil d'aide à la décision. Les performances passées des propositions
générées ne préjugent pas des performances futures. Toute décision reste de votre responsabilité.*
