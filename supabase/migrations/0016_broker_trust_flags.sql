-- Migration 0016 — broker trust model : exposer les conflits d'intérêt
--
-- Ajoute à la table `brokers` des colonnes descriptives sur les pratiques
-- qui impactent l'utilisateur final :
--   - pfof : broker reçoit du payment-for-order-flow → ordre retail routé
--            vers le MM qui paie le plus, pas le best execution
--   - is_b_book : broker prend l'autre côté du trade retail (CFD, forex).
--                 Conflit structurel : son PnL = -PnL utilisateur
--   - fx_markup_bps_estimate : surcoût FX typique en basis points
--                              vs mid ECB (observation terrain)
--   - execution_quality_notes : commentaire qualitatif
--
-- Ces flags alimentent l'UX : warning visible quand l'utilisateur
-- crée une connexion avec un broker à risque, et pris en compte par
-- l'AI Autopilot pour préférer les brokers A-book sans PFOF.

alter table if exists public.brokers
  add column if not exists pfof boolean not null default false,
  add column if not exists is_b_book boolean not null default false,
  add column if not exists fx_markup_bps_estimate integer,
  add column if not exists execution_quality_notes text;

-- Upsert des metadata sur les brokers connus — sources publiques :
-- rapports 606 (US), documentation broker, études Better Markets,
-- enquêtes FCA/BaFin/AMF.

update public.brokers set
  pfof = true,
  is_b_book = false,
  fx_markup_bps_estimate = 50,
  execution_quality_notes = 'PFOF confirmé (ordres vendus aux MMs). Pas de B-book actions/ETF. FX markup ~0.50% sur cross-currency. Crypto : spread élevé. À éviter pour volume significatif.'
where slug = 'trading212';

update public.brokers set
  pfof = true,
  is_b_book = false,
  fx_markup_bps_estimate = 100,
  execution_quality_notes = 'PFOF confirmé. FX markup ~1% inclus dans le spread (non visible). Pas d''exposition à l''ordre réel — tout routé en internalisation via MM partenaires.'
where slug = 'trade_republic';

update public.brokers set
  pfof = false,
  is_b_book = true,
  fx_markup_bps_estimate = 150,
  execution_quality_notes = 'Modèle B-book sur CFD (eToro prend l''autre côté). Conflit d''intérêt structurel : maison gagne si tu perds. FX markup ~1.5%. Copy-trading ≠ exécution réelle des top traders. À éviter pour investissement sérieux.'
where slug = 'etoro';

update public.brokers set
  pfof = false,
  is_b_book = false,
  fx_markup_bps_estimate = 50,
  execution_quality_notes = 'Pas de PFOF. Exposition limitée aux ordres réels — néobanque, pas broker pure-play. FX markup ~0.5% weekdays, 1%+ weekends. OK pour petites positions ponctuelles, pas pour trading actif.'
where slug = 'revolut';

update public.brokers set
  pfof = false,
  is_b_book = false,
  fx_markup_bps_estimate = 2,
  execution_quality_notes = 'Référence qualité d''exécution. Pas de PFOF (Pro). Smart Order Routing (SMART) aux meilleures venues. FX IdealPro ~0.002% (quasi-gratuit). API mature. Le broker à privilégier pour trading sérieux.'
where slug = 'interactive_brokers';

update public.brokers set
  pfof = false,
  is_b_book = false,
  fx_markup_bps_estimate = 15,
  execution_quality_notes = 'Pas de PFOF. FX mid+1.5bps à partir d''un certain tier, 10-15bps sinon. Plateforme premium. Options/futures globaux. Frais actions plus élevés qu''IBKR pour petit volume.'
where slug = 'saxo';

update public.brokers set
  pfof = false,
  is_b_book = false,
  fx_markup_bps_estimate = 10,
  execution_quality_notes = 'Pas de PFOF. FX spread 10bps environ. Frais low-cost actions EU. Pas d''API officielle, import CSV obligatoire.'
where slug = 'degiro';

update public.brokers set
  pfof = false,
  is_b_book = false,
  fx_markup_bps_estimate = 40,
  execution_quality_notes = 'Broker français PEA/CTO. Pas de PFOF. FX markup ~0.4%. Frais forfaitaires — compétitif sur volumes moyens, cher sur petits ordres. Pas d''API.'
where slug = 'bourse_direct';

update public.brokers set
  pfof = false,
  is_b_book = false,
  fx_markup_bps_estimate = 45,
  execution_quality_notes = 'Banque en ligne française. Pas de PFOF. FX markup ~0.45%. PEA/CTO accessibles. Tarification forfaitaire par tranche. Pas d''API.'
where slug = 'fortuneo';

-- Crypto
update public.brokers set
  pfof = false,
  is_b_book = false,
  fx_markup_bps_estimate = 10,
  execution_quality_notes = 'Exchange spot + derivatives crypto. Frais maker 0.10% / taker 0.10% (réduits avec BNB et volume). Pas de B-book mais profite du spread. Fundings futures à surveiller. Largement le plus liquide pour la plupart des paires.'
where slug = 'binance';

update public.brokers set
  pfof = false,
  is_b_book = false,
  fx_markup_bps_estimate = 15,
  execution_quality_notes = 'Exchange US réputé sécurité. Frais 0.16% maker / 0.26% taker (Pro). Liquidité correcte EUR/USD/BTC/ETH, plus faible sur altcoins. Pas de B-book, fonctionne en carnet d''ordres.'
where slug = 'kraken';

update public.brokers set
  pfof = false,
  is_b_book = false,
  fx_markup_bps_estimate = 50,
  execution_quality_notes = 'Exchange US coté NASDAQ. Frais Advanced Trade 0.40%/0.60% (maker/taker) — élevés. Pas de B-book. Plus cher que Kraken/Binance mais réglementation stricte et assurances.'
where slug = 'coinbase';

update public.brokers set
  pfof = false,
  is_b_book = true,
  fx_markup_bps_estimate = 250,
  execution_quality_notes = 'Exchange centralisé + super app. Spreads larges (2-5% sur certaines paires), frais cachés dans les quotes. Carte Visa = gamification (staking CRO). À éviter pour trading sérieux — rester sur Binance/Kraken.'
where slug = 'crypto_com';
