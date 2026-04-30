-- Migration 0095 : glossaire public des termes financiers et plateforme
-- Table lecture publique (pas d'auth requise pour consulter le glossaire)

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS glossary_terms (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        TEXT NOT NULL UNIQUE,
  term        TEXT NOT NULL,
  definition  TEXT NOT NULL,
  example     TEXT,
  related_slugs TEXT[] DEFAULT '{}',
  category    TEXT NOT NULL CHECK (category IN ('finance', 'risque', 'plateforme', 'strategie')),
  listed      BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index GIN pour recherche floue full-text
CREATE INDEX IF NOT EXISTS idx_glossary_terms_trgm
  ON glossary_terms USING gin (
    (term || ' ' || definition) gin_trgm_ops
  );

CREATE INDEX IF NOT EXISTS idx_glossary_terms_category ON glossary_terms (category);
CREATE INDEX IF NOT EXISTS idx_glossary_terms_slug     ON glossary_terms (slug);

-- RLS : lecture publique, écriture admin uniquement
ALTER TABLE glossary_terms ENABLE ROW LEVEL SECURITY;

CREATE POLICY "glossary_read_public"
  ON glossary_terms FOR SELECT
  USING (listed = true);

-- Trigger updated_at
CREATE OR REPLACE FUNCTION update_glossary_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

CREATE TRIGGER trg_glossary_updated_at
  BEFORE UPDATE ON glossary_terms
  FOR EACH ROW EXECUTE FUNCTION update_glossary_updated_at();

-- Seed initial (42 termes — source : apps/web/src/lib/glossary-terms.ts)
INSERT INTO glossary_terms (slug, term, definition, example, related_slugs, category) VALUES
  ('portefeuille','Portefeuille','L''ensemble de vos actifs financiers (actions, obligations, ETF, crypto…) détenus dans un ou plusieurs comptes.','Un portefeuille de 10 000 € peut contenir 60 % d''actions, 30 % d''obligations et 10 % de liquidités.',ARRAY['allocation','diversification'],'finance'),
  ('action','Action','Titre représentant une part de propriété d''une entreprise. Détenir une action donne droit aux dividendes et à une fraction des bénéfices.','Acheter 10 actions Apple à 180 $ = détenir 0,0000001 % d''Apple.',ARRAY['dividende','plus-value'],'finance'),
  ('obligation','Obligation','Titre de dette émis par une entreprise ou un État. L''émetteur s''engage à rembourser le capital et à verser des intérêts périodiques (coupon).','Obligation d''État français à 10 ans : coupon 3 %, remboursée à 100 % à l''échéance.',ARRAY['rendement','risque-de-marche'],'finance'),
  ('etf','ETF (Fonds indiciel coté)','Fonds coté en bourse qui réplique un indice (CAC 40, S&P 500…). Permet une diversification instantanée à faible coût.','Un ETF S&P 500 expose à 500 entreprises américaines avec un seul achat.',ARRAY['diversification','allocation'],'finance'),
  ('dividende','Dividende','Part des bénéfices d''une entreprise reversée aux actionnaires, généralement trimestriellement ou annuellement.','Total Energies verse ~8 % de dividende annuel. 1 000 € investi rapporte ~80 €/an sans compter la variation de cours.',ARRAY['action','rendement'],'finance'),
  ('rendement','Rendement','Gain ou perte généré par un investissement sur une période, exprimé en pourcentage du capital investi.','1 000 € → 1 080 € en un an = rendement de +8 %.',ARRAY['plus-value','dividende'],'finance'),
  ('plus-value','Plus-value','Gain réalisé lors de la vente d''un actif à un prix supérieur à son prix d''achat.','Achat à 50 €, vente à 65 € = plus-value de 15 € (30 %).',ARRAY['moins-value','rendement'],'finance'),
  ('moins-value','Moins-value','Perte réalisée lors de la vente d''un actif à un prix inférieur à son prix d''achat.','Achat à 50 €, vente à 40 € = moins-value de 10 € (−20 %).',ARRAY['plus-value','stop-loss'],'finance'),
  ('liquidite','Liquidité','Facilité à convertir un actif en argent rapidement sans perte de valeur significative.','Apple est très liquide (millions de titres échangés/jour). Une petite foncière est peu liquide.',ARRAY['portefeuille'],'finance'),
  ('interets-composes','Intérêts composés','Mécanisme où les rendements générés s''ajoutent au capital et génèrent eux-mêmes des rendements. L''effet s''accélère dans le temps.','10 000 € à 8 %/an pendant 30 ans = 100 627 € sans apport supplémentaire.',ARRAY['rendement'],'finance'),
  ('cours','Cours (prix de marché)','Prix actuel auquel un actif s''échange sur le marché. Fluctue en continu pendant les heures d''ouverture.','Le cours d''Apple à 10h32 EST est 187,40 $. Dans 5 minutes, il peut être 187,80 $.',ARRAY['volatilite'],'finance'),
  ('capitalisation-boursiere','Capitalisation boursière','Valeur totale d''une entreprise selon les marchés : nombre d''actions × cours actuel.','Apple à 3 000 Mds$ = entreprise la plus valorisée au monde.',ARRAY['action'],'finance'),
  ('drawdown','Drawdown (baisse maximale)','Baisse maximale depuis un pic de valeur jusqu''au creux suivant. Mesure l''ampleur d''une perte temporaire pendant une phase baissière.','Portefeuille à 12 000 € → chute à 9 600 € = drawdown de −20 %.',ARRAY['volatilite','stop-loss'],'risque'),
  ('volatilite','Volatilité','Amplitude des variations de prix d''un actif sur une période. Une forte volatilité signifie des fluctuations importantes, à la hausse comme à la baisse.','Le Bitcoin peut varier de ±10 % en une journée. L''OR varie rarement de plus de ±2 %.',ARRAY['drawdown','risque-de-marche'],'risque'),
  ('risque-de-marche','Risque de marché','Perte potentielle liée aux fluctuations générales des marchés financiers, indépendamment de la qualité de l''actif choisi.','En 2022, même les meilleures entreprises ont chuté de 20-40 % avec la hausse des taux.',ARRAY['diversification','volatilite'],'risque'),
  ('stop-loss','Stop-loss (seuil de perte)','Ordre automatique de vente d''un actif lorsque son prix baisse jusqu''à un niveau défini. Protège contre les pertes excessives.','Position achetée à 100 €, stop-loss à −5 % = vente automatique à 95 €.',ARRAY['take-profit','drawdown'],'risque'),
  ('take-profit','Take-profit (seuil de gain)','Ordre automatique de vente d''un actif lorsque son prix atteint un niveau de gain défini. Matérialise les profits avant un éventuel retournement.','Position achetée à 100 €, take-profit à +10 % = vente automatique à 110 €.',ARRAY['stop-loss','rendement'],'risque'),
  ('profil-de-risque','Profil de risque','Classification de votre tolérance aux pertes et de votre horizon d''investissement. Détermine les types d''actifs et de stratégies adaptés.','Profil Prudent : peu de volatilité, beaucoup d''obligations. Profil Offensif : forte expo actions, accepte −50 %.',ARRAY['drawdown','allocation'],'risque'),
  ('pnl-latent','P&L latent','Gain ou perte non encore réalisé sur des positions encore ouvertes. Disparaît si le cours revient à l''entrée, se matérialise à la clôture.','Position ouverte à 100 €, cours actuel 115 € → P&L latent +15 € (non encaissé).',ARRAY['plus-value','moins-value'],'risque'),
  ('vix','VIX (indice de volatilité)','Indice mesurant la volatilité implicite du marché américain S&P 500 pour les 30 prochains jours. Souvent appelé « thermomètre de la peur ».','VIX < 15 = marché calme. VIX > 30 = stress important. VIX > 50 = panique (mars 2020).',ARRAY['volatilite','risque-de-marche'],'risque'),
  ('correlation','Corrélation','Mesure statistique (−1 à +1) de la relation entre deux actifs. +1 = évoluent en même temps, −1 = évoluent en sens inverse, 0 = indépendants.','Or et dollar USD ont souvent une corrélation négative : quand le dollar baisse, l''or monte.',ARRAY['diversification','allocation'],'risque'),
  ('simulation','Simulation (portefeuille virtuel)','Portefeuille 100 % virtuel : aucun argent réel engagé, aucun ordre transmis à un broker. Permet de tester des stratégies sans risque financier.',NULL,ARRAY['capital-de-travail'],'plateforme'),
  ('lisa','Lisa (assistant IA)','L''assistant d''analyse de SmartVest. Lisa analyse les marchés, génère des scénarios et des suggestions. Elle ne prend jamais de décision autonome sans votre autorisation explicite.',NULL,ARRAY['mode-delegation','mandat'],'plateforme'),
  ('mode-delegation','Mode de délégation','Niveau d''autonomie accordé à Lisa : Manuel (analyse seule), Hybride (suggestions à valider), Autonome gardé (agit dans un mandat strictement défini).',NULL,ARRAY['mandat','kill-switch'],'plateforme'),
  ('mandat','Mandat d''autonomie','Règles définissant les limites dans lesquelles Lisa peut agir de façon autonome : taille max des positions, classes d''actifs autorisées, stop-loss obligatoire, date d''expiration.',NULL,ARRAY['kill-switch','mode-delegation'],'plateforme'),
  ('kill-switch','Kill-switch (arrêt d''urgence)','Bouton d''arrêt immédiat de tout automatisme. Ferme toutes les positions simulées et désactive l''autopilot. Toujours accessible, jamais masqué.',NULL,ARRAY['mandat','mode-delegation'],'plateforme'),
  ('mode-investment','Mode Investment','Stratégie long terme (buy-and-hold). Lisa analyse les marchés toutes les 60 minutes et privilégie des thèses à horizon semaines/mois. Stops larges (4 %).',NULL,ARRAY['mode-harvest','mode-gainers'],'plateforme'),
  ('mode-harvest','Mode Harvest (récolte intraday)','Stratégie de scalping intraday. Lisa analyse toutes les 7 minutes, vise des gains de 1,5-2,5 % par trade, avec un stop serré à 1,5 %. Les gains réalisés sont transférés dans un vault sécurisé.',NULL,ARRAY['mode-investment','vault-securise','capital-de-travail'],'plateforme'),
  ('mode-gainers','Mode Gainers (scanner momentum)','Scanner automatique de valeurs en forte hausse sur 1 minute, vérifié sur plusieurs horizons (5, 15, 30, 60 min). Purement déterministe, bypass le LLM.',NULL,ARRAY['mode-harvest','mode-investment'],'plateforme'),
  ('capital-de-travail','Capital de travail','Montant alloué aux positions actives de Lisa. Reste fixe en mode Harvest : les gains réalisés partent dans le vault et ne sont pas réinjectés.',NULL,ARRAY['vault-securise','mode-harvest'],'plateforme'),
  ('vault-securise','Vault sécurisé (gains préservés)','Compartiment de gains réalisés non réinjectables dans le capital de trading. En mode Harvest, chaque trade gagnant verse immédiatement ses profits dans le vault.',NULL,ARRAY['capital-de-travail','mode-harvest'],'plateforme'),
  ('autopilot','Autopilot','Mode où Lisa exécute automatiquement ses propositions dans le cadre du mandat. Uniquement en simulation paper — aucun ordre réel sans configuration broker dédiée.',NULL,ARRAY['mandat','kill-switch'],'plateforme'),
  ('allocation','Allocation d''actifs','Répartition du portefeuille entre différentes classes d''actifs (actions, obligations, immobilier, liquidités…). Détermine le couple rendement/risque global.','Allocation 60/40 : 60 % actions, 40 % obligations. Typique d''un profil équilibré.',ARRAY['diversification','rééquilibrage'],'strategie'),
  ('diversification','Diversification','Répartir ses investissements sur différents actifs, secteurs et géographies pour réduire le risque global sans nécessairement réduire le rendement attendu.','Ne pas mettre tous ses œufs dans le même panier : 1 seule action = risque max. 50 actions = risque fortement réduit.',ARRAY['allocation','correlation'],'strategie'),
  ('rééquilibrage','Rééquilibrage','Ajustement périodique du portefeuille pour restaurer l''allocation cible, après que les variations de cours ont déformé les proportions initiales.','Cible 60/40 → après hausse des actions : 70/30. Rééquilibrage = vendre des actions, acheter des obligations.',ARRAY['allocation'],'strategie'),
  ('horizon-investissement','Horizon d''investissement','Durée pendant laquelle vous prévoyez de conserver vos investissements avant d''en avoir besoin. Plus l''horizon est long, plus vous pouvez accepter de volatilité.','Retraite dans 25 ans = horizon long, actions agressives acceptables. Achat immobilier dans 2 ans = horizon court, capital à protéger.',ARRAY['profil-de-risque','volatilite'],'strategie'),
  ('levier','Levier financier','Multiplication de l''exposition d''un investissement par rapport au capital réellement investi. Amplifie gains et pertes de façon symétrique.','Levier 2× sur 1 000 € = exposition de 2 000 €. Si l''actif monte de 10 % → +200 €. S''il baisse de 10 % → −200 €.',ARRAY['drawdown','risque-de-marche'],'strategie'),
  ('momentum','Momentum','Tendance d''un actif à poursuivre sa direction récente. Stratégie basée sur l''achat d''actifs en hausse et la vente d''actifs en baisse.',NULL,ARRAY['mode-gainers'],'strategie'),
  ('scalping','Scalping','Stratégie à très court terme visant des gains rapides et faibles (0,5-2,5 %) sur de nombreuses transactions. Requiert une forte discipline sur les stops.',NULL,ARRAY['mode-harvest','stop-loss','take-profit'],'strategie'),
  ('position','Position','Détention d''un actif financier (long = acheté, short = vendu à découvert). Une position ouverte expose au risque de marché jusqu''à sa clôture.',NULL,ARRAY['pnl-latent','stop-loss'],'strategie'),
  ('hedging','Hedging (couverture)','Stratégie consistant à prendre une position compensatrice pour réduire le risque d''une position existante. Réduit les gains potentiels, mais limite les pertes.','Détenir des actions technologiques + acheter des options put sur le Nasdaq = couverture contre une chute du secteur tech.',ARRAY['risque-de-marche','correlation'],'strategie')
ON CONFLICT (slug) DO NOTHING;
