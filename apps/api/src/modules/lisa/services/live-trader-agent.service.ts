/**
 * LiveTraderAgentService — Trader autonome piloté par Gemini Pro.
 *
 * Portfolio dédié : "Trader Agent" (b0000001-...) — capital $10k.
 * Cron 5 min : Gemini Pro reçoit l'état complet (positions, market state,
 * candidats scanner, macro, news fraîches, mémoire des lessons) et retourne
 * une décision JSON structurée (open / close / scale_in / trail / hold).
 *
 * Cron 02:00 UTC : NightlyPostMortem — Gemini Pro analyse les 24h passées,
 * génère 5 nouvelles lessons → injectées dans la system prompt du lendemain.
 * Apprentissage continu.
 *
 * Gating ENV :
 *   - LIVE_TRADER_AGENT_ENABLED=true (default OFF — safe MVP)
 *   - SCANNER_LLM_ROUTER_ENABLED=true (chain Gemini)
 *   - GEMINI_API_KEY défini
 *
 * Safety bounds :
 *   - Max daily loss $500 → kill 24h (auto-restart minuit UTC)
 *   - Max concentration 30% capital sur 1 symbole
 *   - Correlation cap : refuse 4ème position si 3 corrélées > 0.7
 *   - Confidence min 0.65 (sinon skip + log)
 *   - Sanity check prix : si Gemini propose entry > 2% du live → refuse
 *   - Notional clamp $50 ≤ N ≤ $3000 (max 30% du capital $10k)
 */

import { Injectable, Logger, Optional } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../../supabase/supabase.service';
import { ScannerLlmRouterService } from './scanner-llm-router.service';
import { LisaService } from './lisa.service';
import { ScannerLessonsContextService } from './scanner-lessons-context.service';
import { TopGainersScannerService } from './top-gainers-scanner.service';
import { PushNotificationsService } from './push-notifications.service';
import { MistralShadowService } from './mistral-shadow.service';
import { MistralLargeShadowService } from './mistral-large-shadow.service';
import { ExitPolicyContextService } from './exit-policy-context.service';
import { formatBlowOffPreambleBlock } from './blow-off-preamble-lessons';
import { summarizeMomentumDecisions } from './scanner-momentum-shadow.helper';
import type { TopGainerCandidate } from '@smartvest/ai-analyst';

const TRADER_AGENT_PORTFOLIO_ID = 'b0000001-0000-0000-0000-000000000001';
const TRADER_AGENT_USER_ID = '5f164201-9736-4867-8756-a1653d65fd1c';
const TRADER_AGENT_CAPITAL_USD = 10000;
const MAX_DAILY_LOSS_USD = 500;
const MAX_CONCENTRATION_USD = 4500;  // 45% capital — boost 28/05/2026 pour target $400/jour
const MIN_NOTIONAL_USD = 50;
const MIN_CONFIDENCE = 0.55;  // recalibré 04/06 (user "ouvrir les vannes") : 0.75 → 0.55. Le pool était étranglé EN AMONT (persistence 0.67 bug → corrigé à 0) ; le trader holdait faute de A+ (seul candidat = SOI.PA score 0.49). On baisse la barre pour laisser passer les setups moyens et collecter de la data — le SL mécanique + le contrôle manuel par position protègent. Réversible. // [29/05 10:35 : était 0.75. 0.80 bloquait OVH.PA +9.6% conf 0.73.]
const PRICE_SANITY_MAX_DIVERGENCE_PCT = 2.0;

type TraderAction =
  | 'open_directional'
  | 'open_pairs'
  | 'close'
  | 'scale_in'
  | 'trail_stop'
  | 'hold';

interface TraderDecision {
  action_kind: TraderAction;
  symbol?: string;
  symbol_short?: string;  // pour open_pairs
  direction?: 'long' | 'short';
  notional_usd?: number;
  stop_loss_pct?: number;
  take_profit_pct?: number;
  horizon_minutes?: number;
  thesis: string;
  confidence: number;
  expected_pnl_usd?: number;
  max_loss_usd?: number;
}

const SYSTEM_PROMPT_BASE = `Tu es un trader intraday professionnel autonome qui pilote un portfolio paper-trading de $10500 sur SmartVest. Ton mandat : générer **$400/jour de PnL net** (après fees ~0.20% round-trip) = +3.8%/jour, agressif. Tu trades en momentum + retournements rapides sur US/EU/Asia equities + crypto majors.

PATTERNS VALIDÉS (priorité haute — observation 28/05/2026, à amplifier dès Asia 00:00 UTC) :

★ KOSDAQ SMALL-MID (suffix .KQ) = veine PROUVÉE : MIDDLE 28/05 a fait 2 TP clean = +$120 sur 208710.KQ (+2.10%, hold 4min) et 200470.KQ (+1.89%, hold 3min) en session asia matin. Pattern : KOSDAQ small-mid momentum 1m persistant 1-5min, TP rapide 2%. Si un .KQ apparaît dans candidates avec changePct 3-15% (recalibré 03/06 — sample initial était 3-8% mais on étend à 15% pour collecter data 1-2 sem) et persistenceScore ≥ 0.6 → setup A+, conf 0.85+, notional 3000-4000, TP 2-2.5%, SL 1.5%.

★ ORPHAN_CLOSE PRE-CLOCHE = R/R ABSURDE : TRADER 28/05 a fait +$190 net (CHRT.LSE +$105 +$37, IQE.LSE +$47) en fermant systématiquement les positions sur marchés fermant <30 min. **RÈGLE IMPÉRATIVE NON-AMBIGUË** (révisée 29/05 après incident 382840.KQ fermée à -$16.97 par erreur de discipline) :

  CAS 1 — PnL unrealized ≥ 0% (breakeven OU profit) ET marché ferme dans <30 min :
    → CLOSE OBLIGATOIRE ce cycle (lock le profit avant cloche).

  CAS 2 — PnL unrealized < 0% (en perte) ET marché ferme dans <30 min :
    → **N'UTILISE PAS l'action "close" manuellement.** Laisse le SL ou la cloche gérer.
    → Si SL est proche → il triggera automatiquement.
    → Si la cloche arrive avant SL → orphan_close automatique via mechanical-trading.
    → Tu peux utiliser "trail_stop" pour resserrer le SL si la chute s'aggrave, MAIS PAS "close".
    → Logique : fermer manuellement à -0.8% verrouille une perte qui aurait pu :
      a) être recouvrée si le marché rebondit avant cloche (rare mais arrive)
      b) être limitée naturellement par le SL existant à -1.5%
      c) être réduite par le orphan-close automatique au breakeven si remontée

  Le orphan-close DÉTERMINISTE est appliqué automatiquement avant ton cycle UNIQUEMENT
  si PnL ≥ -0.1% (proche breakeven). Si tu reçois state.orphan_closed = true, c'est fait.
  Sinon, NE PRENDS PAS L'INITIATIVE DE FERMER MANUELLEMENT EN PERTE.

  Marchés concernés et horaires de cloche : LSE 16:30 UTC, XETRA/PA 15:30 UTC,
  TSE 06:00 UTC, KRX/KQ 06:30 UTC, HK 08:00 UTC, AU 06:00 UTC, NYSE 21:00 UTC.

★ STRATÉGIE FULL-DAY (03/06/2026 décision utilisateur) — TRADE PENDANT TOUTE LA SESSION DE MARCHÉ, AUCUNE RESTRICTION HORAIRE :
- Si un candidat A+ apparaît sur un marché OUVERT (peu importe l'heure UTC), OUVRE selon les critères qualité (conf, persistenceScore, catalyseur).
- Pas de "wait until window X-Y" — chaque setup A+ pendant les heures de marché est tradable.
- **SEULE règle horaire conservée (safety)** : ne PAS ouvrir une position si le marché ferme dans **< 60 min** (pas assez de respiration pour atteindre TP, risque orphan_close prématuré).
- L'orphan_close pré-cloche (gainers_force_close_offset_min) reste actif pour harvester les positions ouvertes plus tôt.
- Cas pratique 28/05 : CHRT.LSE ouvert à 13:00 UTC → +$105 net à 16:24 (avant cloche). Reproductible — mais désormais on peut aussi ouvrir à 08:00 UTC si setup A+ avec ~8h de respiration jusqu'à cloche LSE 16:30 UTC.

⛔ INTERDICTION ABSOLUE — NE PAS HALLUCINER [END_OF_SESSION_WAIT] (FIX 03/06 audit funnel 11h sans trade) :
- Tu N'AS PAS accès au minutesToClose réel des marchés. NE L'INVENTE PAS dans tes thèses.
- N'écris JAMAIS "[END_OF_SESSION_WAIT minutesToClose=X mode=REFUSED]" ou variantes. Ce marker N'EXISTE PAS dans le système.
- La règle 60min ci-dessus est appliquée par l'INFRASTRUCTURE en amont — quand tu vois un candidat dans scanner_proposals, c'est qu'il est DÉJÀ valide niveau session/timing. Ton job = juger la qualité du setup, PAS recalculer une fermeture de marché.
- Exemples de HALLUCINATIONS À NE PLUS PRODUIRE (cf. logs 03/06 08:16-10:08 UTC, 11h gâchées) :
  · "[END_OF_SESSION_WAIT minutesToClose=124 mode=REFUSED]" → INTERDIT
  · "EU markets close at 16:30 UTC, too early to open" à 08:16 UTC → FAUX (8h de session devant)
  · "[ASIA_EARLY_SESSION] Avoid trading" → règle abandonnée 03/06, IGNORE
- Si TU es vraiment certain qu'un marché ferme dans < 60min ET que la propal est sur ce marché, hold avec marker [SESSION_END_60MIN] (préfixé par "SESSION_END_60MIN" pas "END_OF_SESSION_WAIT"), MAIS uniquement avec timestamp UTC réel cité dans state, sinon tu hallucines.

ANTI-PATTERNS À ÉVITER (priorité haute — observation 28/05/2026) :

✗ ~~ASIA EARLY SESSION 00:00-01:00 UTC~~ DÉSACTIVÉ 03/06/2026 (décision "trade large 1-2 semaines puis analyser"). On collecte data sur opening auctions Nikkei/HSI pour recalibrer. Réévaluer cette règle dans 2 semaines.

✗ ~~US SMALL_MID changePct 4-8% post 15:30 UTC~~ DÉSACTIVÉ 03/06/2026 (décision "trade large 1-2 semaines puis analyser"). On collecte data US early-session pour recalibrer dans 2 semaines.

✗ NUF.AU-type CROSS-PORTFOLIO REVENGE : NUF.AU 28/05 tradé par 3 portfolios presque simultanément en asia session, tous closed losing. Si un ticker apparaît comme top-1 mais a déjà été SL'd sur un autre portfolio dans les 2h, propose hold + thesis "[CROSS_PF_SL] {ticker} SL'd il y a Xmin sur portfolio Y → wait".

✗ XETRA SMALL-CAP <$3000 notional : SNG.XETRA -$35 + QH9.XETRA -$132 (gap polling failure). Liquidité trop mince. Le système te bloquera de toute façon mais ne perds pas de quota dessus.



ACTIONS DISPONIBLES (action_kind) :
- "open_directional" : ouvrir une position simple (long ou short) sur 1 ticker
- "open_pairs" : pair trade long A + short B (market neutral, capter alpha sans beta)
- "close" : fermer une position ouverte par symbole
- "scale_in" : augmenter taille d'une position existante (max +50% sizing)
- "trail_stop" : ajuster le SL d'une position ouverte (vers breakeven ou profit lock)
- "hold" : rien à faire ce cycle (état OK ou trop tôt pour conclure)

CONTRAINTES DURES (les viole pas) :
1. Notional par trade : $50 ≤ N ≤ $3000 (30% capital max sur 1 symbole)
2. Stop loss obligatoire pour tout open : 1.5% ≤ SL ≤ 3% (default 1.5%) — TP sweep 03/06 (n=2750 candidats marché réel) : SL-1.5% maximise l'espérance dans la zone sûre
3. Take profit obligatoire : 2.5% ≤ TP ≤ 8% (default 3%) — TP sweep 03/06 : l'espérance MONTE avec le TP sur ces setups momentum (TP+3% = +0.855%/trade vs +0.61% à TP+2.5%). Les gagnants courent, baisser le TP cape l'upside. NE PAS sous-TP.
4. AUTONOMIE CADRÉE : tu peux dévier du default 1.5%/3% si tu vois un signal LIVE non-capturé
   par le backtest (résistance proche, volatilité anormale, news imminente, microcap, etc.)
5. SI tu dévies du default de plus de 30% (ex: TP=4.5 ou TP=2.5, SL=1.0 ou SL=2.5), tu DOIS
   préfixer ton thesis avec "[TP_CUSTOM: X% / SL_CUSTOM: Y%] reason: <raison concrète>"
   Exemple: "[TP_CUSTOM: 4% / SL_CUSTOM: 2%] reason: résistance H4 à +4.2%, ATR daily 0.5%"
6. Privilégie le default 3%/1.5% (R/R 2:1) sauf raison forte — sweet spot data-optimal TP sweep 03/06.
7. Confidence ≥ 0.55 pour qu'on agisse (sinon hold)  // abaissé 04/06 0.65→0.55 (ouvrir les vannes, collecte data)
8. Pas plus de 5 positions ouvertes simultanément
9. Si daily PnL < -$300 ce jour, mode défensif : open uniquement si confidence ≥ 0.85
10. Pour les shorts : confirmer setup retournement clair (RSI > 70, distribution candle, level résistance majeur)

DISCIPLINE D'ENTRY TIMING — LEÇONS MFE/MAE 27/05 (sample 7 trades) :
A) MAE/R médian Trader Agent = 1.78 (vs MAIN 1.03, healthy 0.6-0.85) → tu entres
   QUASI-SYSTÉMATIQUEMENT au peak local du 1min. Le marché va 78% AU-DELÀ de
   ton SL avant de retracer. Cause : tu ouvres sur "persistenceScore=1" sans
   attendre un pullback.
B) **persistenceScore=1 n'est PAS un signal d'entrée immédiate**. C'est un signal
   que le titre PUMP — ce qui veut dire qu'il va probablement retracer 1-2% avant
   de continuer. Entrer au peak = MAE/R > 1.5 garanti.
C) ⚠️ RÈGLE PULLBACK — SEUIL ABSOLU 15% (RECALIBRÉE 03/06, fix audit funnel) :
   Tu DOIS attendre un retracement SEULEMENT si \`changePct > 15%\` ET
   \`persistenceScore\` ≥ 0.8. Sinon tu entres directement.
   - changePct ∈ [3% ; 15%] = momentum SAIN, OUVRE DIRECTEMENT (ne cite PAS PULLBACK_WAIT)
   - changePct ∈ [10% ; 15%] = ENCORE TRADABLE, PAS de pullback wait (sample 03/06 montrait
     RPI.LSE @ 10.27%, PRX.AS @ 10.5%, IFX.XETRA @ 9.5% rejetés à tort pendant 11h)
   - changePct > 15% = pump parabolique, attends pullback. Cite "[PULLBACK_WAIT] changePct=X.X% persistance=Y"
   ❌ INTERDIT : rejeter un candidat à 10-15% pour cause de "[PULLBACK_WAIT]". C'est un BUG, pas une discipline.
   ❌ INTERDIT : citer "[PULLBACK_WAIT_KTOS_LESSON]" ou "[PUMP_SCORE_SWEET_SPOT]" — lessons archivées.
   Rappel : la veine MIDDLE +$70/j gagne sur setups 3-9%, MIDDLE étendu à 15% pour collecter data.
C-bis) ⚠️ DÉTECTION PUMP EXHAUSTION (ajout 03/06 post-mortem RPI.LSE #1 closed_choppy break-even) :
   Distingue "pump EN COURS" vs "pump TERMINÉ flatline au top". Le code te fournit
   les enriched fields nécessaires : closeToHighRatio, momentum.gradientPctPerMin,
   momentum.acceleration. Règle anti-entry-top :
   - SI \`changePct ≥ 8%\` ET \`closeToHighRatio ≥ 0.97\` (à 3% du high jour) ET
     (\`momentum.gradientPctPerMin ≤ 0.05\` OU \`momentum.acceleration < 0\`)
     → pump TERMINÉE, NE PAS ENTRER ce cycle. Cite "[PUMP_EXHAUSTED changePct=X.X cthr=Y gradient=Z]"
   - SI \`changePct ≥ 8%\` MAIS \`closeToHighRatio < 0.95\` (pullback engagé depuis high)
     OU \`momentum.acceleration > 0\` (re-acceleration) → pump VIVANTE, entrée autorisée
   Exemple 03/06 RPI.LSE #1 : entry $882.79 @ changePct 10.27%, closeToHigh=0.987,
   gradient ≈ 0%/min → pump TERMINÉE → aurait dû hold. Peak intra-vie +0.25% confirme.
   Exemple 03/06 RPI.LSE #2 (15:44) : entry $875 = -0.88% vs précédent peak $883
   → pullback engagé → entrée légitime.
   ❌ NE PAS confondre PUMP_EXHAUSTED avec PULLBACK_WAIT (ce dernier > 15% seulement) :
   - PUMP_EXHAUSTED = "pump déjà fini au sommet, plus d'essence" → hold + cherche un autre candidat
   - PULLBACK_WAIT = "pump parabolique > 15%, retracement obligatoire avant entry"
D) ANTI-REVENGE : si tu as déjà ouvert le même ticker DANS LES 2 DERNIÈRES
   HEURES (regarde state.recent_closed_trades), tu N'OUVRES PAS À NOUVEAU même
   si persistenceScore=1. Le système te bloquera de toute façon, mais ça pollue
   les logs et brûle du quota Gemini.
E) ROTATION DE CANDIDATS : ne te focalise pas sur le top-1 du snapshot. Si le
   top-1 a déjà été tenté ou est trop "pumped" (changePct > 5%), regarde les
   candidats #3-#10 qui ont un setup plus frais.
F) CAPTURE RATE -45.8% : tu fermes systématiquement les trades qui sont en
   profit avant le TP. Si la position dépasse +1.5%, n'utilise PAS "close" sur
   un argument "persistence=0 maintenant" — utilise "trail_stop" (lock le
   breakeven ou un peu de profit) et laisse le trade respirer jusqu'au TP.

RÉPONSE JSON OBLIGATOIRE (1 seul objet, pas de markdown) :
{
  "action_kind": "open_directional|open_pairs|close|scale_in|trail_stop|hold",
  "symbol": "TICKER.US (si open/close/scale/trail)",
  "symbol_short": "TICKER si open_pairs",
  "direction": "long|short",
  "notional_usd": 1500,
  "stop_loss_pct": 1.2,
  "take_profit_pct": 2.5,
  "horizon_minutes": 60,
  "thesis": "1-3 phrases citant les chiffres concrets",
  "confidence": 0.75,
  "expected_pnl_usd": 30,
  "max_loss_usd": 18
}

CONTEXTE MACRO (input \`macro\` — snapshot LisaService) :
- VIX > 30 = panique : refuse open_directional sauf setup A+ (conf ≥ 0.85)
- VIX 20-30 = stressé : sizing -30%, privilégie close sur positions -EV
- US10Y up > +10bps en intraday = pression rates : évite small caps + REITs
- DXY spike + US10Y > 4.5% = flight from risk assets, prudence equities
- Brent up > +5% intraday = risk geopolitique : prudence aero/airlines/EU
- Gold up > +2% AVEC DXY down = flight to safety : refuse shorts risk-on
- HY OAS > 500bps OU IG OAS > 150bps = credit stress, prudence cycliques
- USDJPY breakdown < 145 = yen carry unwind, contagion risk-off (cf. août 2024)
- Si \`macro.dataQuality.fallback\` contient ≥ 3 indicateurs → photo macro
  dégradée, réduis ton sizing -30% ET ta confidence -0.05
- Si \`macro.note = 'macro_snapshot_unavailable_this_cycle'\` → contexte aveugle,
  refuse open_directional (uniquement close/trail_stop/hold autorisés)

SCANNER_PROPOSALS (input \`scanner_proposals\` — ajout 03/06/2026 décision "trade large 1-2 sem") :
- Ces candidats ont DÉJÀ passé tous les gates scanner (OVERPUMP per-class,
  dead zones, path_efficiency, persistence multi-TF, SkepticAgent, LLM_GATE).
  Ils sont PRÉ-QUALIFIÉS. Tu n'es PAS responsable de re-filtrer la qualité.
- Le champ \`scanner_proposals[i].score\` (0..1) = composite de qualité du
  scanner. **Ce N'EST PAS ta conviction**. Ne le compare PAS à
  \`suggested_conviction_floor\` (qui s'applique à TA conviction de sortie).
  Un score 0.5 du scanner = candidat valide qui a passé tous les filtres.
- DÉCISION PAR DÉFAUT en phase "trade large 1-2 sem" : **ACCEPT** (émets
  open_directional sur le top-1 proposal par score) sauf si :
  * SkepticAgent veto explicite (rare, événement listé)
  * News sentiment ≤ -0.6 sur le même ticker dans les 2h
  * Position cap déjà atteint (\`openCount >= max_concentration / notional\`)
  * Cumulative drawdown > 5% sur la journée (kill switch préventif)
- Sinon : accept avec TA conviction (0.65-0.95 selon contexte). Ne pas
  refuser sur "scanner_score trop bas" — le scanner a déjà fait son job.

CONTEXTE NEWS (input \`news_recent\` — eodhd dernières 2h) :
- Sentiment fort négatif (≤ -0.6) sur un ticker que tu DÉTIENS → propose close
- Sentiment fort positif (≥ +0.7) sur un ticker dans candidates → bonus conviction
- News macro vs news ticker : pondère la macro plus haut sur les décisions sizing
- Évite d'ouvrir 5 minutes avant un événement \`macro.upcomingEvents\`
  (FOMC, CPI, NFP) : volatilité non-directionnelle

DAILY CATALYST BRIEF (input \`daily_brief\` — généré 04:00 UTC, scope 24h, peut être null) :
- \`macro_events[]\` : événements EU/US/Asia datés avec impact (high/medium/low)
  → Si l'heure courante est dans la fenêtre ±15 min d'un event \`impact=high\`,
    HOLD plutôt qu'open_directional (volatilité non-directionnelle, gap risk)
- \`tickers_to_watch[]\` : tickers identifiés comme catalystes du jour
  → Si un candidat scanner matche un ticker_to_watch → bonus conviction +0.05
- \`tickers_to_avoid[]\` : tickers à éviter (post-event drift, regulatory risk)
  → Si un candidat matche → conf max 0.60 (reject implicit)
- \`sectors_in_focus[]\` : secteurs où chercher en priorité
  → Si plusieurs candidats équivalents, privilégier celui dans un sector_in_focus
- \`summary\` : 2-3 phrases résumé jour. Cite-le dans ton thesis si tu fais un trade
  dirigé par un event listé (e.g. "Pre-CPI defensive positioning per daily brief").
- Si \`daily_brief = null\` (brief non généré, < 24h après reset, etc.) : ignore ce bloc.

SIZING AGGRESSIF (28/05/2026) — CIBLE +$400/JOUR :
- Capital $10000, MAX par position $4500 (45%), MIN $50
- Setup A+ (conf ≥ 0.85, persistence=1.0, lesson winning_pattern qui match, news favorable)
  → notional 2500-4000 USD (large mais cadré)
- Setup standard (conf 0.70-0.84) → notional 1500-2500 USD
- Setup faible (conf 0.65-0.69) → notional 800-1500 USD ou hold
- Privilégier 3-4 positions agressives plutôt que 5 positions timides
- Sur session US (14:30-21:00 UTC) régime momentum classique :
  cible TP 2-3% scalp court (<30min, cf. lesson TP fast pattern)
- Anti-revenge : si même ticker a perdu dans 2h, NE PROPOSE PAS de re-ouvrir

Sois agressif quand le setup est A+, conservateur sinon. Le sweet spot = 3 trades A+ par session × +$50-100 = target hit.`;

@Injectable()
export class LiveTraderAgentService {
  private readonly logger = new Logger(LiveTraderAgentService.name);
  private enabled = false;
  private dailyKillUntil: number | null = null;  // timestamp epoch ms

  constructor(
    private readonly config: ConfigService,
    private readonly supabase: SupabaseService,
    private readonly llmRouter: ScannerLlmRouterService,
    private readonly lisa: LisaService,
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly topGainersScanner: TopGainersScannerService,
    @Optional() private readonly lessonsContext?: ScannerLessonsContextService,
    @Optional() private readonly pushNotifs?: PushNotificationsService,
    // 31/05/2026 — A/B shadow 4-way (Pro/Flash/Medium/Large).
    // Optional : si MISTRAL_SHADOW_ENABLED=false ou MISTRAL_API_KEY absent,
    // les colonnes mistral_* restent NULL dans gemini_ab_decisions.
    @Optional() private readonly mistralShadow?: MistralShadowService,
    // 31/05/2026 PR #521 — 2e instance Mistral dédiée au cheap tier (Large 3).
    // Permet comparaison directe cheap tiers : Flash (Google) vs Large 3 (Mistral)
    // sur les memes decisions Pro. Activation : MISTRAL_LARGE_SHADOW_ENABLED=true.
    @Optional() private readonly mistralLargeShadow?: MistralLargeShadowService,
    // Politique de sortie apprise (close decisions counterfactuel) injectée
    // dans le prompt pour décisions HOLD/TRAIL/CLOSE intelligentes. @Optional.
    @Optional() private readonly exitPolicy?: ExitPolicyContextService,
  ) {}

  onModuleInit(): void {
    const raw = this.config.get<string>('LIVE_TRADER_AGENT_ENABLED');
    this.enabled = (raw ?? 'false').toLowerCase() === 'true';
    this.logger.log(
      `[trader-agent] onModuleInit fired — LIVE_TRADER_AGENT_ENABLED raw="${raw}" parsed_enabled=${this.enabled}`,
    );
    this.writeBootSentinel(raw).catch(() => null);
    if (this.enabled) {
      this.logger.log(
        `[trader-agent] ENABLED — portfolio=${TRADER_AGENT_PORTFOLIO_ID.slice(0, 8)} capital=$${TRADER_AGENT_CAPITAL_USD} cron */5min`,
      );
    }
    // Enregistrement MANUEL des crons via SchedulerRegistry (pattern exact
    // TopGainersScannerService.onModuleInit qui marche en prod depuis P5).
    // Les décorateurs @Cron sur cette classe ne tiraient pas (cause inconnue).
    // PR #543 — Cadence augmentée 5min→2min. Catch les pumps 1m ~3 min plus
    // rapidement. Mistral free tier supporte largement (2.5× = ~10% du quota).
    this.registerCron(
      'live-trader-agent-decision-manual',
      '*/2 * * * *',
      () => this.runDecisionCycle().catch((e) =>
        this.logger.error(`[trader-agent] runDecisionCycle error: ${String(e).slice(0, 200)}`),
      ),
    );
    this.registerCron(
      'live-trader-agent-post-mortem-manual',
      '0 2 * * *',
      () => this.runNightlyPostMortem().catch((e) =>
        this.logger.error(`[trader-agent] runNightlyPostMortem error: ${String(e).slice(0, 200)}`),
      ),
    );
    // B.3 (01/06) — Cleanup proposals expirées toutes les 10 min.
    // Léger (1 UPDATE indexé). Gated runtime par TRADER_ARBITRATION_ENABLED.
    this.registerCron(
      'scanner-proposals-cleanup-expired',
      '*/10 * * * *',
      () => this.cleanupExpiredProposals().catch((e) =>
        this.logger.error(`[trader-arbitration] cleanup expired error: ${String(e).slice(0, 200)}`),
      ),
    );
  }

  private registerCron(name: string, expr: string, callback: () => void): void {
    try {
      // Idempotent : si déjà enregistré (hot reload), skip
      this.schedulerRegistry.getCronJob(name);
      this.logger.log(`[trader-agent] cron '${name}' already registered, skip`);
      this.writeRegistrationSentinel(name, 'already_registered').catch(() => null);
      return;
    } catch {
      // Pas encore — on continue
    }
    try {
      // Pattern exact de TopGainersScannerService.scheduleScanner (en prod P5)
      const job = new CronJob(expr, callback);
      this.schedulerRegistry.addCronJob(name, job);
      job.start();
      this.logger.log(`[trader-agent] cron '${name}' registered manually expr='${expr}'`);
      this.writeRegistrationSentinel(name, `OK expr=${expr}`).catch(() => null);
    } catch (e) {
      const errMsg = String(e).slice(0, 200);
      this.logger.error(`[trader-agent] cron '${name}' registration FAILED: ${errMsg}`);
      this.writeRegistrationSentinel(name, `FAILED: ${errMsg}`).catch(() => null);
    }
  }

  /** Sentinel DB inconditionnel à chaque tick du cron — prouve qu'il tire. */
  private async writeCycleTickSentinel(): Promise<void> {
    if (!this.supabase.isReady()) return;
    await this.supabase.getClient().from('trader_agent_decisions').insert({
      portfolio_id: TRADER_AGENT_PORTFOLIO_ID,
      cycle_started_at: new Date().toISOString(),
      input_state: { cycle_tick_sentinel: true, ts: Date.now() },
      action_kind: 'hold',
      thesis: `[CYCLE_TICK] cron fired @ ${new Date().toISOString()}`,
      confidence: 0,
      action_applied: false,
      apply_error: '[CYCLE_TICK] proof cron fired',
    });
  }

  /** Sentinel DB pour prouver que registerCron a été appelé (success ou fail). */
  private async writeRegistrationSentinel(name: string, status: string): Promise<void> {
    if (!this.supabase.isReady()) return;
    await this.supabase.getClient().from('trader_agent_decisions').insert({
      portfolio_id: TRADER_AGENT_PORTFOLIO_ID,
      cycle_started_at: new Date().toISOString(),
      input_state: { registration_sentinel: true, cron_name: name, status },
      action_kind: 'hold',
      thesis: `[REGISTRATION_SENTINEL] cron='${name}' status='${status}'`,
      confidence: 0,
      action_applied: false,
      apply_error: `[REGISTRATION_SENTINEL] ${status}`,
    });
  }

  private async writeBootSentinel(rawFlag: string | undefined): Promise<void> {
    if (!this.supabase.isReady()) return;
    const now = new Date();
    await this.supabase.getClient().from('trader_agent_decisions').insert({
      portfolio_id: TRADER_AGENT_PORTFOLIO_ID,
      cycle_started_at: now.toISOString(),
      input_state: { boot_sentinel: true, raw_flag: rawFlag ?? 'undefined', parsed_enabled: this.enabled },
      action_kind: 'hold',
      thesis: `[BOOT_SENTINEL] onModuleInit fired @ ${now.toISOString()} — flag raw="${rawFlag}" parsed=${this.enabled}`,
      confidence: 0,
      action_applied: false,
      apply_error: '[BOOT_SENTINEL] proof onModuleInit was called',
    });
  }

  /**
   * Cron 5 min — boucle principale de décision Gemini Pro.
   * Enregistré manuellement via SchedulerRegistry dans onApplicationBootstrap
   * (cf. registerCron 'live-trader-agent-decision-manual').
   */
  async runDecisionCycle(): Promise<void> {
    // Sentinel DB inconditionnel — prouve que le cron tire vraiment.
    this.writeCycleTickSentinel().catch(() => null);
    // Log inconditionnel chaque tick pour vérifier que le cron tire vraiment.
    this.logger.log(`[trader-agent] cron tick @ ${new Date().toISOString()} enabled=${this.enabled} supabase=${this.supabase.isReady()} llmRouter=${this.llmRouter.isEnabled()}`);
    if (!this.enabled) return;
    if (!this.supabase.isReady()) return;
    if (!this.llmRouter.isEnabled()) {
      this.logger.warn('[trader-agent] LLM router disabled, skip cycle');
      return;
    }

    // Daily kill-switch check
    if (this.dailyKillUntil !== null && Date.now() < this.dailyKillUntil) {
      this.logger.debug(`[trader-agent] daily kill active until ${new Date(this.dailyKillUntil).toISOString()}`);
      return;
    }
    if (this.dailyKillUntil !== null && Date.now() >= this.dailyKillUntil) {
      this.logger.log('[trader-agent] daily kill expired, resuming');
      this.dailyKillUntil = null;
    }

    const cycleStartedAt = new Date();
    try {
      // LISA refonte B.1 — backfill outcomes des citations en attente.
      // Best-effort, ne fait jamais échouer le cycle.
      this.resolveCitationOutcomes().catch((e) =>
        this.logger.debug(`[trader-agent] resolveCitationOutcomes err: ${String(e).slice(0, 100)}`),
      );

      // 1. Read state (positions, capital, daily PnL)
      const state = await this.readState();

      // 1.1 — LISA refonte A.4.1 — Anti-spiral safety guard.
      // Si drawdown depuis le capital initial < -30%, on arme kill_switch_active=true
      // dans la DB et on skip le cycle. L'agent ne reprendra qu'après reset manuel
      // explicite côté UI (ConfirmDialog). Protège contre l'effondrement non détecté
      // par les caps daily (-$500/jour) sur une suite de mauvaises journées.
      if (state.drawdownFromInitialPct < -30 && !state.killSwitchActive) {
        this.logger.error(
          `[trader-agent] ANTI-SPIRAL armed — DD=${state.drawdownFromInitialPct.toFixed(1)}% < -30% — kill_switch_active=true`,
        );
        await this.supabase.getClient()
          .from('lisa_session_configs')
          .update({ kill_switch_active: true })
          .eq('portfolio_id', TRADER_AGENT_PORTFOLIO_ID);
        // B.4.c — push notification au user du portfolio (best-effort).
        if (this.pushNotifs) {
          const { data: portfolioRow } = await this.supabase.getClient()
            .from('portfolios')
            .select('user_id')
            .eq('id', TRADER_AGENT_PORTFOLIO_ID)
            .maybeSingle();
          const userId = (portfolioRow as { user_id?: string } | null)?.user_id;
          if (userId) {
            this.pushNotifs.notifyUser(userId, 'kill_switch_armed').catch((e) =>
              this.logger.debug(`[trader-agent] push notify err: ${String(e).slice(0, 100)}`),
            );
          }
        }
        await this.logDecision({
          cycleStartedAt, state, action: 'hold' as const,
          notionalUsd: 0, confidence: 0,
          thesis: `Anti-spirale armé : drawdown ${state.drawdownFromInitialPct.toFixed(1)}% < -30% depuis capital initial $${state.initialCapitalUsd.toFixed(0)} (current $${state.currentCapitalUsd.toFixed(0)}). Kill-switch DB activé. Reset manuel requis via UI /lisa.`,
          applied: false,
          actionKindOverride: 'kill_switch_anti_spiral',
        });
        return;
      }
      if (state.killSwitchActive) {
        this.logger.warn(
          `[trader-agent] kill_switch_active=true (DD=${state.drawdownFromInitialPct.toFixed(1)}%) — cycle skipped, manual reset required`,
        );
        return;
      }

      // 1.5 — Pre-flight ORPHAN_CLOSE déterministe (28/05/2026, ADDENDUM TRADER).
      // TRADER a généré +$190 net jour en orphan-close manuel (CHRT.LSE 2x, IQE.LSE).
      // Codification : pour chaque position ouverte sur un marché fermant <30 min
      // ET PnL unreal ≥ -0.1% (breakeven ou mieux), close maintenant. Évite que
      // Gemini oublie cette règle ou rate son cycle.
      const orphanClosed = await this.preFlightOrphanClose(state);
      if (orphanClosed.length > 0) {
        this.logger.log(
          `[trader-agent] preFlightOrphanClose closed ${orphanClosed.length} positions: ${orphanClosed.join(', ')}`,
        );
        // Re-read state — les positions fermées sont reflétées
        Object.assign(state, await this.readState());
      }

      // 1.6 — Pre-flight MAX_LOSS_CAP (28/05/2026 soirée, plancher $200/jour) :
      // hard-close toute position dont l'unreal dépasse -$50 (≈ -2% sur $2500 notional
      // standard). Plafond catastrophe — l'incident QH9.XETRA -$132 ne doit JAMAIS
      // se reproduire. Indépendant du SL pct configuré : même si le SL stop_loss_price
      // n'a pas trigger (gap, polling failure, price stale), le P&L unreal lui se
      // calcule sur le live price → on fait foi à l'unreal pour le cap.
      const maxLossCapClosed = await this.preFlightMaxLossCap(state, -50);
      if (maxLossCapClosed.length > 0) {
        this.logger.warn(
          `[trader-agent] preFlightMaxLossCap closed ${maxLossCapClosed.length} positions: ${maxLossCapClosed.join(', ')}`,
        );
        Object.assign(state, await this.readState());
      }

      // 1.7 — MFE health check (28/05/2026 soirée) : vérifie que recordMfe()
      // de MechanicalTradingService tire vraiment pour les positions TRADER.
      // Sans MFE recording, le trailing BE / trailing TP / let-run sont du
      // dead-code → fausse protection. Log warn si position > 5 min sans MFE
      // update (peak_pre_exit = entry_price OU null). Pas d'action automatique,
      // juste alerte pour intervention.
      await this.checkMfeHealth(state).catch((e) =>
        this.logger.debug(`[trader-agent] mfe health check err: ${String(e).slice(0, 100)}`),
      );

      // 2. Check daily loss limit
      if (state.dailyPnlUsd < -MAX_DAILY_LOSS_USD) {
        this.logger.warn(
          `[trader-agent] daily PnL $${state.dailyPnlUsd.toFixed(2)} < -$${MAX_DAILY_LOSS_USD} — kill 24h`,
        );
        this.dailyKillUntil = Date.now() + 24 * 60 * 60_000;
        await this.logDecision({
          cycleStartedAt, state, action: 'hold' as const,
          notionalUsd: 0, confidence: 0,
          thesis: `Daily loss limit -$${MAX_DAILY_LOSS_USD} crossed (pnl=$${state.dailyPnlUsd.toFixed(2)}). Kill 24h activated.`,
          applied: false,
          actionKindOverride: 'skip_safety_bound',
        });
        return;
      }

      // 3. Fetch candidates + macro + news + memory + lessons — chaque fetch
      // en allSettled pour qu'un échec individuel (DB query fail, API down) ne
      // stoppe pas le cycle entier. Fallback aux valeurs vides en cas de fail.
      const settled = await Promise.allSettled([
        this.fetchTopCandidates(50),  // PR #544 — élargi 20→50 pour catch pépites position #30+ (cf. commentaire L1462)
        this.fetchMacroContext(),
        this.fetchRecentNews(10),
        this.fetchActiveMemory(1000),
        this.lessonsContext?.getLessonsBlock('trader_agent_only', { assetClass: 'asia_eu_us_crypto' }) ?? Promise.resolve(''),
        // COMMIT 5 (29/05) — MIDDLE reference block
        this.fetchMiddleReference(),
        // AUTO-CORRECTION DYNAMIQUE (29/05) — self-reflection sur dernières 5 décisions
        this.computeSelfReflection(),
        // PR #536 — daily catalyst brief (cron 04:00 UTC) : événements macro du jour
        // + sectors in focus + tickers to watch/avoid. Permet à Pro/Mistral d'interpréter
        // les news EU CPI / US ISM / Fed speeches en contexte vs réagir post-event.
        this.fetchLatestDailyBrief(),
      ]);
      const candidates = settled[0].status === 'fulfilled' ? settled[0].value : [];
      const macro = settled[1].status === 'fulfilled' ? settled[1].value : { note: 'macro_fetch_failed' };
      const news = settled[2].status === 'fulfilled' ? settled[2].value : [];
      const memory = settled[3].status === 'fulfilled' ? settled[3].value : [];
      const crossScannerLessons = settled[4].status === 'fulfilled' ? (settled[4].value as string) : '';
      const middleReference = settled[5].status === 'fulfilled' ? (settled[5].value as string) : '';
      const selfReflection = settled[6].status === 'fulfilled' ? (settled[6].value as string) : '';
      const dailyBrief = settled[7].status === 'fulfilled' ? settled[7].value : null;

      // ─────────────────────────────────────────────────────────────────
      // Architecture "TRADER chef d'orchestre" (01/06/2026) — gated par
      // TRADER_ARBITRATION_ENABLED. Le scanner ne crée plus de positions
      // directement : il INSERT scanner_proposals. TRADER les lit ici, les
      // injecte dans son state, et décide accept/reject (open_directional
      // pour accept, hold/comment pour reject). Les risk advisories du
      // RiskMonitor sont aussi consommées ici (advisory mode).
      // ─────────────────────────────────────────────────────────────────
      const arbitrationEnabled = (this.config.get<string>('TRADER_ARBITRATION_ENABLED') ?? 'false').toLowerCase() === 'true';
      let scannerProposals: Array<Record<string, unknown>> = [];
      let riskAdvisories: Array<Record<string, unknown>> = [];
      if (arbitrationEnabled) {
        try {
          const { data: proposals } = await this.supabase.getClient()
            .from('scanner_proposals')
            .select('id, symbol, asset_class, exchange, direction, notional_usd_suggested, stop_loss_pct_suggested, take_profit_pct_suggested, score, change_pct, live_price_at_proposal, candidate_metrics, scanner_reasoning, created_at, expires_at')
            .eq('portfolio_id', TRADER_AGENT_PORTFOLIO_ID)
            .eq('status', 'pending')
            .gt('expires_at', new Date().toISOString())
            .order('score', { ascending: false })
            .limit(20);
          scannerProposals = (proposals ?? []) as Array<Record<string, unknown>>;
        } catch (e) {
          this.logger.debug(`[trader-agent] read scanner_proposals failed: ${String(e).slice(0, 120)}`);
        }
        try {
          // FIX 01/06 — colonne `timestamp` (pas `created_at`) cf migration 0043.
          const { data: advisories } = await this.supabase.getClient()
            .from('lisa_decision_log')
            .select('id, payload, timestamp')
            .eq('portfolio_id', TRADER_AGENT_PORTFOLIO_ID)
            .eq('kind', 'risk_advisory')
            .gte('timestamp', new Date(Date.now() - 5 * 60_000).toISOString())
            .order('timestamp', { ascending: false })
            .limit(10);
          riskAdvisories = (advisories ?? []) as Array<Record<string, unknown>>;
        } catch (e) {
          this.logger.debug(`[trader-agent] read risk_advisories failed: ${String(e).slice(0, 120)}`);
        }
        if (scannerProposals.length > 0 || riskAdvisories.length > 0) {
          this.logger.log(
            `[trader-agent] arbitration ON — ${scannerProposals.length} scanner proposals + ${riskAdvisories.length} risk advisories injectés dans le state`,
          );
        }

        // ───────────────────────────────────────────────────────────────
        // HIGH CONVICTION BYPASS — court-circuit LLM TRADER quand une
        // scanner_proposal arrive avec un score ≥ seuil (default 0.85).
        // Mission CLAUDE.md 03/06/2026 "identifier le gate qui fait rater
        // les pépites" : audit logs 04/06 17:13-17:14 a montré que TRADER
        // LLM Mistral rejetait NVTS.US (score=0.91 quality=0.90 persist=5/5)
        // avec "Aucun candidat valide". 8e gate masqué.
        // Modes :
        //   off (default — pas de changement, LLM décide comme avant)
        //   shadow — log only, LLM décide quand même (calibration)
        //   active — applyDecision direct, skip LLM
        // applyDecision conserve TOUS les garde-fous (max 5 open, kill switch,
        // US opening block, B3 hard guard) — le bypass court-circuite juste
        // la décision LLM, pas la safety.
        // ───────────────────────────────────────────────────────────────
        const bypassMode = (this.config.get<string>('TRADER_BYPASS_HIGH_CONVICTION') ?? 'off').toLowerCase();
        const bypassMinScore = Number(this.config.get<string>('TRADER_BYPASS_MIN_SCORE') ?? '0.85');
        if ((bypassMode === 'shadow' || bypassMode === 'active') && scannerProposals.length > 0) {
          const qualifying = scannerProposals
            .map((p) => ({ p, score: Number(p.score) }))
            .filter((x) => Number.isFinite(x.score) && x.score >= bypassMinScore)
            .sort((a, b) => b.score - a.score);
          if (qualifying.length > 0) {
            const top = qualifying[0].p;
            const topScore = qualifying[0].score;
            if (bypassMode === 'shadow') {
              this.logger.log(
                `[trader-bypass:shadow] ${qualifying.length} proposal(s) score≥${bypassMinScore} — top=${top.symbol} ${top.direction} score=${topScore.toFixed(2)} (LLM continues normalement, shadow only)`,
              );
            } else {
              this.logger.log(
                `[trader-bypass:active] ${top.symbol} ${top.direction} score=${topScore.toFixed(2)} ≥ ${bypassMinScore} — skip LLM, applyDecision direct`,
              );
              const syntheticDecision: TraderDecision = {
                action_kind: 'open_directional',
                symbol: String(top.symbol),
                direction: top.direction as 'long' | 'short',
                notional_usd: Number(top.notional_usd_suggested),
                stop_loss_pct: Number(top.stop_loss_pct_suggested),
                take_profit_pct: Number(top.take_profit_pct_suggested),
                thesis: `[TRADER_BYPASS_HIGH_CONVICTION] ${top.symbol} score=${topScore.toFixed(2)} ≥ ${bypassMinScore} — skip LLM, accept scanner proposal directly. Reasoning: ${String(top.scanner_reasoning ?? '').slice(0, 200)}`,
                confidence: 0.85,
              };
              let bypassApplyResult: { applied: boolean; positionId?: string; error?: string };
              try {
                bypassApplyResult = await this.applyDecision(syntheticDecision, state, []);
              } catch (e) {
                const errMsg = `bypass applyDecision throw: ${String(e).slice(0, 200)}`;
                this.logger.error(`[trader-bypass:active] ${errMsg}`);
                bypassApplyResult = { applied: false, error: errMsg };
              }
              const bypassChosenSymbol = bypassApplyResult.applied ? String(top.symbol) : null;
              const bypassChosenDirection = bypassApplyResult.applied ? (top.direction as 'long' | 'short') : null;
              await this.markNonChosenSuperseded(scannerProposals, bypassChosenSymbol, bypassChosenDirection)
                .catch((e) => this.logger.debug(`[trader-bypass:active] markNonChosenSuperseded skip: ${String(e).slice(0, 120)}`));
              if (!bypassApplyResult.applied) {
                await this.markProposalRejected(String(top.symbol), top.direction as 'long' | 'short', bypassApplyResult.error ?? 'bypass_apply_failed')
                  .catch((e) => this.logger.debug(`[trader-bypass:active] markProposalRejected skip: ${String(e).slice(0, 120)}`));
              }
              try {
                const logArgs: Parameters<typeof this.logDecision>[0] = {
                  cycleStartedAt,
                  state,
                  decision: syntheticDecision,
                  candidates: [],
                  action: 'open_directional',
                  actionKindOverride: 'open_directional',
                  notionalUsd: syntheticDecision.notional_usd ?? 0,
                  confidence: syntheticDecision.confidence,
                  thesis: syntheticDecision.thesis,
                  applied: bypassApplyResult.applied,
                };
                if (bypassApplyResult.positionId) logArgs.appliedPositionId = bypassApplyResult.positionId;
                if (bypassApplyResult.error) logArgs.applyError = bypassApplyResult.error;
                await this.logDecision(logArgs);
              } catch (e) {
                this.logger.warn(`[trader-bypass:active] logDecision failed: ${String(e).slice(0, 120)}`);
              }
              return;
            }
          }
        }
      }
      const fetchFailures = settled
        .map((s, i) => s.status === 'rejected' ? `${['candidates','macro','news','memory','lessons','middle_ref','self_reflect','daily_brief'][i]}=${String(s.reason).slice(0,80)}` : null)
        .filter((x) => x !== null);
      if (fetchFailures.length > 0) {
        this.logger.warn(`[trader-agent] fetch partial failures: ${fetchFailures.join(' | ')}`);
      }
      if (middleReference.length > 0) {
        this.logger.debug(`[trader-agent] MIDDLE reference block injected (${middleReference.length} chars)`);
      }
      if (selfReflection.length > 0) {
        this.logger.log(`[trader-agent] SELF-REFLECTION triggered : ${selfReflection.slice(0, 100)}...`);
      }

      // 31/05/2026 cost-cut (G) — Skip Gemini Pro call when no actionable candidates.
      // S'il y a 0 candidat à analyser ET 0 position ouverte (rien à fermer/trailer),
      // appeler Gemini ne génère qu'un "hold" sans valeur. Économie sur weekend
      // crypto-only où l'univers est souvent vide pendant plusieurs heures.
      // Garde-fou : on log dans trader_agent_decisions pour traçabilité du skip.
      const openPositionsCount = Array.isArray(state.openPositions) ? state.openPositions.length : 0;
      const skipForEmptyContext = (this.config.get<string>('TRADER_SKIP_LLM_WHEN_EMPTY') ?? 'true').toLowerCase() === 'true';
      // 01/06 — Ne pas skip si on a des scanner_proposals ou risk_advisories à arbitrer,
      // même avec 0 candidats live + 0 positions ouvertes.
      const hasArbitrationWork = scannerProposals.length > 0 || riskAdvisories.length > 0;
      if (skipForEmptyContext && candidates.length === 0 && openPositionsCount === 0 && !hasArbitrationWork) {
        await this.logDecision({
          cycleStartedAt, state, action: 'hold' as const,
          notionalUsd: 0, confidence: 0,
          thesis: '[SKIP_LLM_EMPTY_CONTEXT] 0 candidat in band + 0 position ouverte → skip Gemini call (cost optimization)',
          applied: false,
          actionKindOverride: 'hold',
        }).catch((e) => this.logger.warn(`[trader-agent] log skip failed: ${String(e).slice(0, 120)}`));
        this.logger.debug('[trader-agent] skip cycle — empty context (0 candidates, 0 open positions)');
        return;
      }

      // 4. Build system prompt (memory + cross-lessons + MIDDLE ref + self-reflection)
      let systemPrompt = this.buildSystemPrompt(memory, crossScannerLessons, middleReference, selfReflection);

      // 4.0bis — POLITIQUE DE SORTIE APPRISE : distille position_close_decisions
      // (verdict counterfactuel GOOD/EARLY) en framework de décision HOLD/TRAIL/
      // CLOSE. C'est le cœur de l'apprentissage : TRADER agrège indicateurs live
      // + cette politique + sa mémoire en UNE décision. Cold start = heuristiques
      // défaut (TP sweep). Best-effort, n'échoue jamais le cycle.
      if (this.exitPolicy) {
        try {
          const policy = await this.exitPolicy.getLearnedExitPolicy(TRADER_AGENT_PORTFOLIO_ID);
          systemPrompt = `${systemPrompt}\n\n${policy.promptBlock}`;
        } catch (e) {
          this.logger.debug(`[trader-agent] exit policy skip: ${String(e).slice(0, 120)}`);
        }
      }

      // 4.1 (01/06) — Wiring objectifs → state TRADER. Calcul du progress vs
      // cible jour + trajectory status. Le LLM était aveugle aux objectifs
      // jusque-là (hold systématique alors qu'à -20% de la cible $200/j).
      // Cf. section §6 quater CLAUDE.md "HORS_TRAJECTOIRE" pour la sémantique.
      const traderObjectives = await this.computeTraderObjectives(state, cycleStartedAt).catch((e) => {
        this.logger.debug(`[trader-agent] computeTraderObjectives failed: ${String(e).slice(0, 120)}`);
        return null;
      });
      // LISA refonte A.4 — Capital composé : utilise state.currentCapitalUsd
      // (= initial + Σ pnl si compound activé) au lieu du constant TRADER_AGENT_CAPITAL_USD.
      // max_concentration calculée à 45% du capital actuel (dynamic ratio).
      const dynamicMaxConcentration = Math.round(state.currentCapitalUsd * 0.45);
      const userPrompt = JSON.stringify({
        current_time_utc: cycleStartedAt.toISOString(),
        portfolio_capital_usd: state.currentCapitalUsd,
        portfolio_capital_initial_usd: state.initialCapitalUsd,
        portfolio_cumulative_pnl_usd: state.cumulativePnlUsd,
        portfolio_drawdown_pct: state.drawdownFromInitialPct,
        state,
        candidates,
        // 01/06 — TRADER chef d'orchestre : scanner_proposals = candidats que
        // le scanner a pré-qualifié et qui attendent décision TRADER.
        // Tu peux : (a) accept en émettant open_directional sur ce symbol avec
        // notional / SL / TP cohérents avec le suggested, OU (b) reject en
        // émettant hold + raison dans thesis. Une proposal non actée expire en 5min.
        scanner_proposals: scannerProposals,
        // 01/06 — RiskMonitor en mode advisory : il calcule un composite_score
        // sur tes positions ouvertes et te conseille (TIGHTEN_SL / RAISE_TP /
        // CLOSE_NOW / MOMENTUM_RIDE) avec un rationale. Tu décides : tu peux
        // appliquer (trail_stop avec le SL conseillé / close direct), ou ignorer
        // si tu juges que c'est du bruit.
        risk_advisories: riskAdvisories,
        // 01/06 — Objectives & trajectory : indique au LLM s'il est en avance,
        // dans le plan, en retard, ou hors trajectoire vs la cible jour.
        // Permet d'ajuster la risk posture (conviction threshold, sizing,
        // urgence) au lieu de hold systématique. Null si pas de cible saisie.
        objectives_progress: traderObjectives,
        macro,
        news_recent: news,
        // PR #536 — Daily catalyst brief (cron 04:00 UTC) avec events macro + tickers focus.
        // Format JSON pour facilité du LLM à parser/citer. Null si pas de brief du jour.
        daily_brief: dailyBrief,
        constraints: {
          max_concentration_usd: dynamicMaxConcentration,
          max_open_positions: 5,
          min_notional_usd: MIN_NOTIONAL_USD,
          daily_loss_limit_usd: MAX_DAILY_LOSS_USD,
        },
      }, null, 2);

      // 5. Call Gemini Pro (raisonnement multi-facteurs sur 20 candidats + macro + news + memory).
      // Auto-fallback Flash Lite → Claude Opus si Pro indisponible (cf. ScannerLlmRouter.callWithPro).
      // maxTokens=4000 : Gemini 2.5 Pro utilise des "thinking tokens" internes
      // qui se déduisent du budget. 1000 était trop bas → content vide. 4000 laisse
      // ~3000 tokens de thinking + 1000 pour la réponse JSON.
      let response: { content: string; providerId: string; costUsd: number; latencyMs: number };
      try {
        response = await this.llmRouter.callWithPro({
          system: systemPrompt,
          user: userPrompt,
          temperature: 0.3,
          maxTokens: 4000,
          timeoutMs: 30_000,
        });
      } catch (e) {
        const errMsg = `LLM call failed: ${String(e).slice(0, 200)}`;
        this.logger.warn(`[trader-agent] ${errMsg}`);
        // Persist le fail en DB pour visibilité sans accès Fly logs.
        await this.logDecision({
          cycleStartedAt, state,
          candidates, macro, news, memory,
          action: 'hold' as const,
          actionKindOverride: 'skip_safety_bound',
          notionalUsd: 0, confidence: 0,
          thesis: `LLM unavailable: ${errMsg}`,
          applied: false,
          applyError: errMsg,
        }).catch(() => null);
        return;
      }

      // 5b. Si content vide (Gemini Pro a brûlé tout son budget en thinking),
      // fallback explicite sur la chain rapide (Flash Lite — pas de thinking tokens).
      if (!response.content || response.content.trim().length === 0) {
        this.logger.warn(`[trader-agent] Gemini Pro returned empty content — fallback to fast chain. provider=${response.providerId}`);
        try {
          response = await this.llmRouter.call({
            system: systemPrompt,
            user: userPrompt,
            temperature: 0.3,
            maxTokens: 1500,
            timeoutMs: 30_000,
          });
        } catch (e) {
          const errMsg = `LLM fallback also failed: ${String(e).slice(0, 200)}`;
          this.logger.warn(`[trader-agent] ${errMsg}`);
          await this.logDecision({
            cycleStartedAt, state, candidates, macro, news, memory,
            action: 'hold' as const,
            actionKindOverride: 'skip_safety_bound',
            notionalUsd: 0, confidence: 0,
            thesis: `Pro empty + fallback failed: ${errMsg}`,
            applied: false,
            applyError: errMsg,
          }).catch(() => null);
          return;
        }
      }

      // 6. Parse decision
      let decision: TraderDecision;
      try {
        const cleaned = response.content.trim().replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
        decision = JSON.parse(cleaned);
      } catch (e) {
        const errMsg = `parse JSON failed: ${String(e).slice(0, 150)}`;
        this.logger.warn(`[trader-agent] ${errMsg} — raw: ${response.content.slice(0, 200)}`);
        // Persist DB row pour visibilité
        await this.logDecision({
          cycleStartedAt, state,
          candidates, macro, news, memory,
          rawResponse: response.content,
          provider: response.providerId,
          latencyMs: response.latencyMs,
          costUsd: response.costUsd,
          action: 'hold' as const,
          actionKindOverride: 'skip_safety_bound',
          notionalUsd: 0, confidence: 0,
          thesis: `Gemini response parse failed: ${errMsg}. Raw: ${response.content.slice(0, 200)}`,
          applied: false,
          applyError: errMsg,
        }).catch(() => null);
        return;
      }

      // PR4 (31/05/2026) — A/B shadow Pro vs Flash. Lance un appel Flash en
      // arrière-plan avec exactement le même prompt que Pro, logge les 2
      // décisions dans gemini_ab_decisions pour analyse comparative ultérieure.
      // Best-effort : n'augmente pas la latence du cycle (fire-and-forget),
      // catch toutes les erreurs (n'altère jamais le comportement TRADER).
      const abEnabled = (this.config.get<string>('GEMINI_AB_PRO_VS_FLASH_ENABLED') ?? 'true').toLowerCase() === 'true';
      if (abEnabled) {
        void this.recordAbShadow({
          cycleStartedAt,
          portfolioId: TRADER_AGENT_PORTFOLIO_ID,
          systemPrompt,
          userPrompt,
          candidatesCount: Array.isArray(candidates) ? candidates.length : 0,
          proDecision: decision,
          proResponse: response,
        }).catch((e) => this.logger.debug(`[trader-agent] ab shadow err: ${String(e).slice(0, 120)}`));
      }

      // 7. Apply decision with safety bounds — wrap dans try pour ne pas
      // silencieusement drop la décision si applyDecision throw.
      let applyResult: { applied: boolean; positionId?: string; error?: string };
      try {
        applyResult = await this.applyDecision(decision, state, candidates as Array<Record<string, unknown>>);
      } catch (e) {
        const errMsg = `applyDecision throw: ${String(e).slice(0, 200)}`;
        this.logger.error(`[trader-agent] ${errMsg}`);
        applyResult = { applied: false, error: errMsg };
      }

      // B1 + B2 (02/06/2026) — Audit scanner_proposals post-decision.
      // Sans ce wiring, les proposals visibles ce cycle restent 'pending' jusqu'à
      // expiry (5 min) — le LLM rebouclerait dessus aux cycles 2/4/6 min suivants.
      //
      // Règles :
      //   - decision = open_directional + apply success → accepted (handled by
      //     markProposalAccepted déjà appelé dans applyDecision)
      //   - decision = open_directional + apply échec  → rejected (B1)
      //   - autres proposals visibles ce cycle non choisies → superseded (B2)
      const isOpenAction = decision.action_kind === 'open_directional' || decision.action_kind === 'open_pairs';
      if (isOpenAction && !applyResult.applied && decision.symbol && decision.direction) {
        await this.markProposalRejected(decision.symbol, decision.direction, applyResult.error ?? 'apply_failed')
          .catch((e) => this.logger.debug(`[trader-agent] markProposalRejected skip: ${String(e).slice(0, 120)}`));
      }
      const chosenSymbol = isOpenAction && decision.symbol ? decision.symbol : null;
      const chosenDirection = isOpenAction && decision.direction ? decision.direction : null;
      await this.markNonChosenSuperseded(scannerProposals, chosenSymbol, chosenDirection)
        .catch((e) => this.logger.debug(`[trader-agent] markNonChosenSuperseded skip: ${String(e).slice(0, 120)}`));

      // 8. Log everything — try/catch pour ne jamais dropper silencieusement
      try {
        await this.logDecision({
          cycleStartedAt, state, decision,
          candidates, macro, news, memory,
          rawResponse: response.content,
          provider: response.providerId,
          latencyMs: response.latencyMs,
          costUsd: response.costUsd,
          action: decision.action_kind,
          notionalUsd: decision.notional_usd ?? 0,
          confidence: decision.confidence,
          thesis: decision.thesis,
          applied: applyResult.applied,
          ...(applyResult.positionId !== undefined ? { appliedPositionId: applyResult.positionId } : {}),
          ...(applyResult.error !== undefined ? { applyError: applyResult.error } : {}),
        });
      } catch (e) {
        this.logger.error(`[trader-agent] logDecision failed (cycle ran but trace lost): ${String(e).slice(0, 200)}`);
      }

      // Phase 4 refactor scanner — Momentum Shadow Comparator (env-gated, default OFF).
      // Capture bucket distribution + chosen bucket dans lisa_decision_log pour analyse
      // offline : winRate par bucket, A/B Phase 2 ON vs OFF. Aucun effet sur la décision.
      const shadowEnabled = (this.config.get<string>('SCANNER_AB_SHADOW_ENABLED') ?? 'false').toLowerCase() === 'true';
      if (shadowEnabled) {
        try {
          const chosenSymbol = decision.action_kind === 'open_directional' ? (decision.symbol ?? null) : null;
          const summary = summarizeMomentumDecisions(candidates as Array<Record<string, unknown>>, chosenSymbol);
          await this.supabase.getClient().from('lisa_decision_log').insert({
            portfolio_id: TRADER_AGENT_PORTFOLIO_ID,
            kind: 'scanner_momentum_shadow',
            payload: {
              cycle_started_at: cycleStartedAt.toISOString(),
              action_kind: decision.action_kind,
              ...summary,
            },
          });
        } catch (e) {
          this.logger.debug(`[trader-agent] momentum shadow log failed: ${String(e).slice(0, 120)}`);
        }
      }

      // LISA refonte B.1 — parse markers thèse + insert citations
      // Best-effort : catch + log, ne fait jamais échouer le cycle.
      try {
        await this.insertLessonCitations({
          thesis: decision.thesis ?? '',
          cycleStartedAt,
          actionKind: decision.action_kind,
          actionApplied: applyResult.applied,
          targetSymbol: decision.symbol ?? null,
          confidence: decision.confidence ?? null,
          positionId: applyResult.positionId ?? null,
        });
      } catch (e) {
        this.logger.warn(`[trader-agent] insertLessonCitations err: ${String(e).slice(0, 120)}`);
      }

      const tag = applyResult.applied ? '✅' : (decision.action_kind === 'hold' ? '⏸️' : '⚠️');
      this.logger.log(
        `[trader-agent] ${tag} ${decision.action_kind} ${decision.symbol ?? ''} conf=${decision.confidence?.toFixed(2)} — ${decision.thesis?.slice(0, 80) ?? ''}`,
      );
    } catch (e) {
      const errMsg = `cycle failed: ${String(e).slice(0, 200)}`;
      this.logger.error(`[trader-agent] ${errMsg}`);
      // Trace l'erreur en DB pour visibilité (best-effort).
      try {
        await this.supabase.getClient().from('trader_agent_decisions').insert({
          portfolio_id: TRADER_AGENT_PORTFOLIO_ID,
          cycle_started_at: new Date().toISOString(),
          input_state: { cycle_error_sentinel: true, error: errMsg },
          action_kind: 'hold',
          thesis: `[CYCLE_ERROR] ${errMsg}`,
          confidence: 0,
          action_applied: false,
          apply_error: errMsg,
        });
      } catch { /* swallow */ }
    }
  }

  /**
   * Cron 02:00 UTC — post-mortem nightly + génération nouvelles lessons.
   * Enregistré manuellement via SchedulerRegistry.
   */
  async runNightlyPostMortem(): Promise<void> {
    if (!this.enabled) return;
    if (!this.supabase.isReady()) return;
    if (!this.llmRouter.isEnabled()) return;

    const yesterdayStart = new Date(Date.now() - 24 * 60 * 60_000);
    this.logger.log(`[trader-agent:post-mortem] running for window ${yesterdayStart.toISOString()} → now`);

    try {
      // Récupère décisions + positions des dernières 24h
      const { data: decisions } = await this.supabase.getClient()
        .from('trader_agent_decisions')
        .select('decided_at, action_kind, target_symbol, direction, confidence, thesis, action_applied, gemini_parsed')
        .eq('portfolio_id', TRADER_AGENT_PORTFOLIO_ID)
        .gte('decided_at', yesterdayStart.toISOString())
        .order('decided_at', { ascending: true });

      const { data: positions } = await this.supabase.getClient()
        .from('lisa_positions')
        .select('symbol, direction, entry_price, exit_price, entry_timestamp, exit_timestamp, status, realized_pnl_usd, exit_reason')
        .eq('portfolio_id', TRADER_AGENT_PORTFOLIO_ID)
        .gte('entry_timestamp', yesterdayStart.toISOString())
        .order('entry_timestamp', { ascending: true });

      if ((decisions?.length ?? 0) === 0 && (positions?.length ?? 0) === 0) {
        this.logger.log('[trader-agent:post-mortem] no activity in last 24h, skip');
        return;
      }

      // Boucle d'apprentissage CROSS-PORTFOLIO — feed le post-mortem avec :
      // 1. Les 4 derniers market_close_reports (Asia/EU/US/wrap) → comparatif 5 portfolios
      // 2. Le PnL de chaque shadow et du main pour la même journée → context "ce que les autres ont fait"
      // Le trader agent apprend non seulement de SES trades mais aussi de la perf relative.
      const { data: closeReports } = await this.supabase.getClient()
        .from('market_close_reports')
        .select('session_kind, captured_at, portfolio_breakdown, total_net_pnl_usd, winner_portfolio_id, loser_portfolio_id, ai_narrative')
        .gte('captured_at', yesterdayStart.toISOString())
        .order('captured_at', { ascending: true });

      // Compute daily comparative summary direct from positions (cross-portfolio)
      const PORTFOLIO_NAMES: Record<string, string> = {
        // Note: ex-MAIN '58439d86' n'existe plus en DB (migré vers b0000001 le 30/05/2026)
        'a0000001-0000-0000-0000-000000000001': 'shadow_high',
        'a0000002-0000-0000-0000-000000000002': 'shadow_middle',
        'a0000003-0000-0000-0000-000000000003': 'shadow_small',
        [TRADER_AGENT_PORTFOLIO_ID]: 'trader_agent (SELF)',
      };
      const { data: allClosed } = await this.supabase.getClient()
        .from('lisa_positions')
        .select('portfolio_id, symbol, direction, realized_pnl_usd, exit_reason')
        .in('portfolio_id', Object.keys(PORTFOLIO_NAMES))
        .gte('exit_timestamp', yesterdayStart.toISOString())
        .neq('status', 'open');

      const dailyByPortfolio: Record<string, { name: string; closed: number; wins: number; gross_pnl: number; symbols: string[] }> = {};
      for (const pid of Object.keys(PORTFOLIO_NAMES)) {
        dailyByPortfolio[pid] = { name: PORTFOLIO_NAMES[pid], closed: 0, wins: 0, gross_pnl: 0, symbols: [] };
      }
      for (const p of (allClosed ?? [])) {
        const pid = String(p.portfolio_id);
        if (!dailyByPortfolio[pid]) continue;
        const pnl = Number(p.realized_pnl_usd ?? 0);
        dailyByPortfolio[pid].closed++;
        if (pnl > 0) dailyByPortfolio[pid].wins++;
        dailyByPortfolio[pid].gross_pnl += pnl;
        if (!dailyByPortfolio[pid].symbols.includes(p.symbol as string)) {
          dailyByPortfolio[pid].symbols.push(p.symbol as string);
        }
      }

      // USER PATTERNS — stats 30j sur closed_user (autorité humaine)
      // Fournis à Mistral pour qu'il identifie patterns user récurrents.
      const since30d = new Date(Date.now() - 30 * 24 * 3600_000).toISOString();
      const { data: userCloses } = await this.supabase.getClient()
        .from('lisa_positions')
        .select('symbol, direction, entry_price, exit_price, entry_timestamp, exit_timestamp, realized_pnl_usd, realized_pnl_pct, exit_reason')
        .eq('portfolio_id', TRADER_AGENT_PORTFOLIO_ID)
        .eq('status', 'closed_user')
        .gte('exit_timestamp', since30d)
        .order('exit_timestamp', { ascending: false });
      const userStats30d = ((): {
        total_closes: number;
        winners: number;
        losers: number;
        win_rate: number;
        avg_pnl_usd: number;
        avg_pnl_pct: number;
        total_pnl_usd: number;
        recent_closes_sample: Array<{ symbol: string; pnl_usd: number; pnl_pct: number; hold_min: number; exit_reason: string }>;
      } => {
        const arr = userCloses ?? [];
        const winners = arr.filter(c => Number(c.realized_pnl_usd ?? 0) > 0).length;
        const losers = arr.filter(c => Number(c.realized_pnl_usd ?? 0) <= 0).length;
        const totalPnl = arr.reduce((s, c) => s + Number(c.realized_pnl_usd ?? 0), 0);
        return {
          total_closes: arr.length,
          winners,
          losers,
          win_rate: arr.length > 0 ? winners / arr.length : 0,
          avg_pnl_usd: arr.length > 0 ? totalPnl / arr.length : 0,
          avg_pnl_pct: arr.length > 0 ? arr.reduce((s, c) => s + Number(c.realized_pnl_pct ?? 0), 0) / arr.length : 0,
          total_pnl_usd: totalPnl,
          recent_closes_sample: arr.slice(0, 15).map(c => ({
            symbol: String(c.symbol),
            pnl_usd: Number(c.realized_pnl_usd ?? 0),
            pnl_pct: Number(c.realized_pnl_pct ?? 0),
            hold_min: c.entry_timestamp && c.exit_timestamp ? Math.round((new Date(c.exit_timestamp).getTime() - new Date(c.entry_timestamp).getTime()) / 60_000) : -1,
            exit_reason: String(c.exit_reason ?? ''),
          })),
        };
      })();

      // Macro snapshot frais — sert à corréler les outcomes (gagnant/perdant)
      // au régime du jour. Cache 2 min côté LisaService (probablement déjà chaud).
      let macroSnapshot: object;
      try {
        macroSnapshot = await this.lisa.getRecentMarketSnapshot(120);
      } catch (e) {
        this.logger.warn(`[trader-agent:post-mortem] macro fetch failed: ${String(e).slice(0, 100)}`);
        macroSnapshot = { note: 'macro_snapshot_unavailable' };
      }

      const postMortemPrompt = `Tu es un coach trader senior. Analyse la journée du Trader Agent (portfolio $10k Mistral Medium primary autonome) ET le comparatif des 5 portfolios paper (main + 3 shadows + trader_agent).

OBJECTIF : générer 5-8 lessons concrètes pour DOPER l'apprentissage du Trader Agent. Les lessons doivent :
1. Identifier ce que LE TRADER AGENT a fait de BIEN (à reproduire)
2. Identifier ce que LE TRADER AGENT a fait de MAL (à éviter)
3. **Apprendre des AUTRES portfolios** : "shadow_X a fait +$Y avec stratégie Z, le trader agent aurait dû..."
4. Référencer les market_close_reports (Asia/EU/US sessions) pour contextualiser
5. Être actionable : "Quand le contexte est X, fais Y" (pas "il faut être prudent")
6. **PRIORITÉ ABSOLUE : USER PATTERNS** — voir section dédiée ci-dessous

═══ TAXONOMY exit_reason — DISTINCTION CRITIQUE ═══
- closed_user         → 🟢 ACTION HUMAINE (intent volontaire, intuition, info contextuelle hors-modèle).
                        AUTORITÉ MAXIMALE. À traiter comme signal humain de plus haute confiance.
                        Inclut les take-profits manuels ET les stop-out volontaires (cut loss vite).
- closed_target       → TP auto déclenché (mécanique). Standard.
- closed_stop         → SL auto déclenché (mécanique). Standard.
- closed_invalidated  → trader-agent LLM décide close (machine). Standard.
- closed_orphan       → système ferme avant fin session (preflight). Standard.

═══ USER PATTERNS — INSTRUCTION SPÉCIALE ═══
L'utilisateur humain ferme MANUELLEMENT certaines positions (closed_user). Ces actions reflètent :
- Son intuition (info hors-modèle : news lue, sentiment marché, contexte invisible)
- Sa STRATÉGIE EXPLICITE : target $15-60/trade, intraday only, EU AM session
- Sa discipline (manual stop-out si setup cassé, même en perte petite)

DÉTECTION OBLIGATOIRE des USER PATTERNS :
- Cherche TOUS les trades closed_user dans la fenêtre d'analyse
- Identifie patterns récurrents : "USER a closed_user N fois sur <asset_class> à <PnL_bucket> en <session>"
- Pour CHAQUE pattern user récurrent (≥2 occurrences), génère 1 lesson avec :
  - lesson_kind = "user_pattern"
  - confidence = 0.90 (PRIORITÉ HAUTE — l'humain est l'autorité)
  - lesson_text DOIT contenir "USER" explicite + comportement + setup + cible
  - Exemple : "USER lock à +1% sur EU small cap AM session (3/3 fois) → reproduire trail_stop à +1% sur même setup"
  - Exemple : "USER stop-out à -0.5% sur LIN.PA (drift news) → 1× observé, à confirmer"

Les user_pattern lessons sont EXEMPTÉES de la clause macro-condition obligatoire (acceptées même sans VIX/DXY/etc.) car l'autorité humaine prévaut sur la condition macro.

LECTURE MACRO OBLIGATOIRE (input \`macro_snapshot_eod\`) :
Tu DOIS conditionner chaque lesson au régime macro du jour. Une lesson "ouvrir
short sur tech au open US" n'a aucune valeur si elle ne précise pas le contexte
(VIX 28 vs VIX 14, US10Y > 4.5% vs < 4.0%, etc.). Sans condition macro, la
lesson est rejetée comme "macro-blind".

Grille de lecture :
- VIX > 25 = stressé / VIX > 30 = panique
- US10Y up > +10bps = pression rates
- DXY spike + 10Y > 4.5% = flight from risk assets
- HY OAS > 500bps = credit stress
- Gold + DXY contraires = flight to safety
- Brent +5% intraday = geopolitique
- USDJPY < 145 = yen carry unwind risk

Chaque \`lesson_text\` DOIT contenir une clause "Quand <CONDITION MACRO>, alors
<ACTION>". Sinon Gemini rejette la lesson.

PATTERNS CROSS-PORTFOLIO À CHERCHER :
- "Trader Agent a passé X trades pendant Asia session alors que shadow_high
  qui était cash a évité une perte de $Y (cf. macro VIX 22 + DXY spike)"
- "Shadow_small a ouvert 8 positions avec sizing micro pendant US morning :
  $Z gain net malgré fees 30%. Le Trader Agent aurait dû en faire 4 sur
  les mêmes patterns avec sizing 2× pour battre les frais"
- "Trader Agent a ouvert 1 position à 17:00 UTC pendant la blacklist hour US,
  -$X. Shadow_middle (qui bypass blacklist) a ouvert mais avec sentiment news
  +0.8 → +$Y. Conclusion : bypass OK SI confirmation news fraîche"

RÉPONSE JSON OBLIGATOIRE :
{
  "summary": "1-2 phrases résumé journée trader_agent vs autres portfolios + régime macro dominant",
  "macro_regime_today": "ex: VIX 22 (élevé), US10Y 4.45% (rates stress), DXY 103 (USD fort), HY OAS 380bps (calme corporate)",
  "trader_agent_daily_pnl_usd": <nombre net total>,
  "winning_patterns": ["pattern + chiffres + condition macro"],
  "losing_patterns": ["pattern + chiffres + condition macro"],
  "cross_portfolio_insights": ["X a battu Y de $Z grâce à... (régime macro: ...)", ...],
  "autonomy_analysis": {
    "aligned_count": <N>,
    "aligned_wr": <0-1>,
    "aligned_avg_pnl_usd": <num>,
    "deviation_tight_count": <N>,
    "deviation_tight_wr": <0-1>,
    "deviation_tight_avg_pnl_usd": <num>,
    "deviation_wide_count": <N>,
    "deviation_wide_wr": <0-1>,
    "deviation_wide_avg_pnl_usd": <num>,
    "recommendation": "keep_default | widen_tighter | widen_wider | tighten_bounds"
  },
  "new_lessons": [
    {
      "lesson_kind": "user_pattern|winning_pattern|losing_pattern|risk_observation|market_regime_rule|sizing_rule|cross_portfolio_insight|autonomy_calibration|exit_rule",
      "lesson_text": "Quand <condition macro>, alors <action> (référence: Z trades observés). Pour user_pattern : 'USER <action> sur <setup>'",
      "confidence": 0.0-1.0,
      "macro_condition": "VIX>25|US10Y>4.5|DXY>103|GOLD+DXY-|BRENT+5%|HY_OAS>500|USDJPY<145|REGIME_CALME|REGIME_MIXED|USER_AUTHORITY"
    }
  ]
}

ANALYSE D'AUTONOMIE (autonomy_analysis section) :
Tu DOIS analyser SÉPARÉMENT 3 profils de décisions Gemini Pro :
- ALIGNED : trades avec TP ∈ [4-8] ET SL ∈ [0.5-1.5] (proche default 6/1)
- DEVIATION_TIGHT : trades avec TP < 4 OU SL > 1.5 (Gemini serre)
- DEVIATION_WIDE : trades avec TP > 8 OU SL < 0.5 (Gemini élargit)

Pour chaque profil, calcule n, win_rate (% closed_target), avg_pnl_usd.

Recommendation rules :
- Si deviation_tight WR > aligned WR * 1.3 ET sample ≥ 10 → "widen_tighter" (Gemini a raison de serrer)
- Si deviation_wide WR > aligned WR * 1.3 ET sample ≥ 10 → "widen_wider" (Gemini a raison d'élargir)
- Si toutes les deviations sous-performent → "tighten_bounds" (forcer le default)
- Sinon → "keep_default" (calibrage OK)`;

      const userPayload = JSON.stringify({
        date: new Date().toISOString().slice(0, 10),
        macro_snapshot_eod: macroSnapshot,
        trader_agent_decisions: decisions ?? [],
        trader_agent_positions: positions ?? [],
        cross_portfolio_daily_summary: dailyByPortfolio,
        market_close_reports_today: closeReports ?? [],
        user_close_stats_30d: userStats30d,
      }, null, 2);

      // Post-mortem = raisonnement sur 24h × 5 portfolios → Pro requis (qualité d'analyse).
      // maxTokens=6000 : Gemini Pro thinking budget (cf. fix 06:55 — 1500 trop bas, content vide).
      const response = await this.llmRouter.callWithPro({
        system: postMortemPrompt,
        user: userPayload,
        temperature: 0.4,
        maxTokens: 6000,
        timeoutMs: 60_000,
      });

      const cleaned = response.content.trim().replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
      const parsed = JSON.parse(cleaned);
      const newLessons = parsed.new_lessons as Array<{ lesson_kind: string; lesson_text: string; confidence: number; macro_condition?: string }>;

      if (!Array.isArray(newLessons) || newLessons.length === 0) {
        this.logger.warn('[trader-agent:post-mortem] no lessons returned');
        return;
      }

      const today = new Date().toISOString().slice(0, 10);
      const macroRegime = parsed.macro_regime_today ?? null;
      let persisted = 0;
      let rejectedMacroBlind = 0;
      for (const l of newLessons) {
        // Gate macro-condition : refuse les lessons qui n'ont pas de condition macro
        // explicite (la grille interdit les lessons "macro-blind"). On accepte aussi
        // les lessons qui contiennent "Quand" + un mot macro (VIX|DXY|10Y|HY|OAS|GOLD|BRENT|USDJPY|REGIME)
        // dans le texte si macro_condition n'est pas fourni.
        // EXCEPTION : user_pattern lessons sont exemptées (autorité humaine prévaut
        // sur la condition macro — la décision user reflète intent/intuition au-delà
        // du modèle macro).
        const isUserPattern = l.lesson_kind === 'user_pattern';
        const hasExplicitMacroCondition = !!l.macro_condition && l.macro_condition.length > 0;
        const hasInlineMacroClause = /quand\b.*\b(vix|dxy|10y|hy|oas|gold|brent|usdjpy|regime|us10y)\b/i.test(l.lesson_text);
        const hasUserKeyword = /\bUSER\b/.test(l.lesson_text);
        if (!isUserPattern && !hasExplicitMacroCondition && !hasInlineMacroClause) {
          this.logger.warn(`[trader-agent:post-mortem] reject macro-blind lesson: ${l.lesson_text.slice(0, 80)}`);
          rejectedMacroBlind++;
          continue;
        }
        if (isUserPattern && !hasUserKeyword) {
          this.logger.warn(`[trader-agent:post-mortem] reject user_pattern lesson sans 'USER' keyword: ${l.lesson_text.slice(0, 80)}`);
          rejectedMacroBlind++;
          continue;
        }
        await this.supabase.getClient().from('trader_agent_memory').insert({
          portfolio_id: TRADER_AGENT_PORTFOLIO_ID,
          lesson_kind: l.lesson_kind,
          lesson_text: l.lesson_text,
          confidence: l.confidence,
          derived_from_date: today,
          payload: {
            summary: parsed.summary,
            macro_regime_today: macroRegime,
            macro_condition: l.macro_condition ?? null,
            winning: parsed.winning_patterns,
            losing: parsed.losing_patterns,
          },
        });
        persisted++;
      }
      this.logger.log(`[trader-agent:post-mortem] persisted ${persisted} lessons (${rejectedMacroBlind} rejected macro-blind)`);
    } catch (e) {
      this.logger.warn(`[trader-agent:post-mortem] failed: ${String(e).slice(0, 200)}`);
    }
  }

  // ====================================================================
  // PUBLIC API — endpoint admin /admin/trader-agent/autonomy
  // ====================================================================

  /**
   * Analyse l'autonomie de Gemini Pro : compare les outcomes des trades
   * 'aligned' (TP 4-8%, SL 0.5-1.5% — proche default 6/1) vs 'deviation_tight'
   * (TP<4 ou SL>1.5%) vs 'deviation_wide' (TP>8 ou SL<0.5%).
   *
   * Si Gemini surperforme en serrant ou élargissant ses TP/SL, on saura qu'il
   * a "raison" et on peut élargir les bornes ou inversement les resserrer.
   */
  async getAutonomyAnalysis(lookbackDays: number = 7): Promise<object> {
    const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60_000).toISOString();
    const { data: decisions } = await this.supabase.getClient()
      .from('trader_agent_decisions')
      .select('decided_at, gemini_parsed, action_kind, applied_position_id, action_applied')
      .eq('portfolio_id', TRADER_AGENT_PORTFOLIO_ID)
      .eq('action_applied', true)
      .eq('action_kind', 'open_directional')
      .not('applied_position_id', 'is', null)
      .gte('decided_at', since);
    if (!decisions || decisions.length === 0) {
      return { lookback_days: lookbackDays, total_applied: 0, message: 'Pas encore assez de décisions appliquées' };
    }
    const positionIds = decisions.map((d) => d.applied_position_id).filter(Boolean);
    const { data: positions } = await this.supabase.getClient()
      .from('lisa_positions')
      .select('id, realized_pnl_usd, exit_reason, status')
      .in('id', positionIds as string[]);
    const posById = new Map((positions ?? []).map((p) => [p.id as string, p]));

    type Profile = 'aligned' | 'deviation_tight' | 'deviation_wide';
    function classify(tp: number, sl: number): Profile {
      const alignedTp = tp >= 4 && tp <= 8;
      const alignedSl = sl >= 0.5 && sl <= 1.5;
      if (alignedTp && alignedSl) return 'aligned';
      if (tp < 4 || sl > 1.5) return 'deviation_tight';
      return 'deviation_wide';
    }
    const buckets: Record<Profile, { n: number; wins: number; pnl: number; closed: number }> = {
      aligned: { n: 0, wins: 0, pnl: 0, closed: 0 },
      deviation_tight: { n: 0, wins: 0, pnl: 0, closed: 0 },
      deviation_wide: { n: 0, wins: 0, pnl: 0, closed: 0 },
    };
    for (const d of decisions) {
      const parsed = d.gemini_parsed as { take_profit_pct?: number; stop_loss_pct?: number } | null;
      if (!parsed) continue;
      const tp = Number(parsed.take_profit_pct ?? 6);
      const sl = Number(parsed.stop_loss_pct ?? 1);
      const profile = classify(tp, sl);
      buckets[profile].n++;
      const pos = posById.get(d.applied_position_id as string);
      if (pos && pos.status !== 'open') {
        buckets[profile].closed++;
        const pnl = Number(pos.realized_pnl_usd ?? 0);
        buckets[profile].pnl += pnl;
        if (pos.exit_reason === 'closed_target' || pnl > 0) buckets[profile].wins++;
      }
    }
    function summarize(b: { n: number; wins: number; pnl: number; closed: number }) {
      return {
        count: b.n,
        closed: b.closed,
        wr: b.closed > 0 ? Number((b.wins / b.closed).toFixed(3)) : null,
        avg_pnl_usd: b.closed > 0 ? Number((b.pnl / b.closed).toFixed(2)) : null,
        total_pnl_usd: Number(b.pnl.toFixed(2)),
      };
    }
    const aligned = summarize(buckets.aligned);
    const devTight = summarize(buckets.deviation_tight);
    const devWide = summarize(buckets.deviation_wide);

    // Recommendation
    let recommendation = 'keep_default';
    const minSample = 10;
    if (aligned.wr !== null) {
      if (devTight.wr !== null && devTight.closed >= minSample && devTight.wr > aligned.wr * 1.3) {
        recommendation = 'widen_tighter';
      } else if (devWide.wr !== null && devWide.closed >= minSample && devWide.wr > aligned.wr * 1.3) {
        recommendation = 'widen_wider';
      } else if (
        (devTight.wr ?? 1) < aligned.wr * 0.7 &&
        (devWide.wr ?? 1) < aligned.wr * 0.7 &&
        (devTight.closed + devWide.closed) >= minSample
      ) {
        recommendation = 'tighten_bounds';
      }
    }

    return {
      lookback_days: lookbackDays,
      total_applied: decisions.length,
      aligned,
      deviation_tight: devTight,
      deviation_wide: devWide,
      recommendation,
      explanation: {
        keep_default: 'Calibrage 1%/6% OK, conserver les bornes actuelles',
        widen_tighter: 'Gemini surperforme quand il serre les TP/SL — autoriser SL>1.5% et TP<4% plus librement',
        widen_wider: 'Gemini surperforme quand il élargit — autoriser TP>8% et SL<0.5% plus librement',
        tighten_bounds: 'Toutes les deviations sous-performent — forcer le default 6%/1% en clampant les bornes',
      }[recommendation],
    };
  }

  // ====================================================================
  // Helpers
  // ====================================================================

  /**
   * Pre-flight MAX_LOSS_CAP (28/05/2026 soirée) — plafond catastrophe.
   * Hard-close toute position dont l'unreal P&L dépasse `capUsd` (négatif).
   * Indépendant du SL configuré : même si le SL n'a pas trigger (gap, polling
   * failure, prix stale), on close au unreal. Évite QH9.XETRA-like -$132.
   */
  private async preFlightMaxLossCap(
    state: { openPositions: Array<{ symbol: string; direction: string; entry_price: number; entry_notional_usd: number; entry_timestamp: string }> },
    capUsd: number,
  ): Promise<string[]> {
    if (state.openPositions.length === 0 || capUsd >= 0) return [];
    const closed: string[] = [];
    for (const pos of state.openPositions) {
      const livePriceData = await this.lisa.getLivePrice(pos.symbol).catch(() => null);
      if (!livePriceData?.price) continue;
      const livePrice = Number(livePriceData.price);
      if (!Number.isFinite(livePrice) || livePrice <= 0) continue;
      const src = String(livePriceData.source ?? '');
      if (src.startsWith('fallback')) continue; // ne jamais close sur fallback price corrompu

      const qty = pos.entry_notional_usd / pos.entry_price;
      const unrealUsd = pos.direction === 'short'
        ? qty * (pos.entry_price - livePrice)
        : qty * (livePrice - pos.entry_price);

      if (unrealUsd <= capUsd) {
        const { data: row } = await this.supabase.getClient()
          .from('lisa_positions')
          .select('id')
          .eq('portfolio_id', TRADER_AGENT_PORTFOLIO_ID)
          .eq('symbol', pos.symbol)
          .eq('status', 'open')
          .order('entry_timestamp', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (!row?.id) continue;

        const res = await this.lisa.closeForOpportunityScout({
          positionId: row.id,
          symbol: pos.symbol,
          livePrice,
          livePriceSource: src,
          reason: 'closed_stop',
          rationale: `[trader-agent preflight-maxloss] unreal $${unrealUsd.toFixed(2)} ≤ cap $${capUsd} — hard close anti-catastrophe (plancher $200/jour)`,
        });
        if (res.closed) closed.push(`${pos.symbol} (unreal $${unrealUsd.toFixed(2)})`);
      }
    }
    return closed;
  }

  /**
   * MFE health check (28/05/2026 soirée) — verify MechanicalTradingService.recordMfe()
   * fires for TRADER positions. Without MFE recording, trailing BE/TP/let-run
   * (commit 5600b83) are dead code. Log warn if position > 5 min has peak_pre_exit
   * = entry_price (= never updated). No auto-action, alert only.
   */
  private async checkMfeHealth(
    state: { openPositions: Array<{ symbol: string; direction: string; entry_price: number; entry_timestamp: string }> },
  ): Promise<void> {
    if (state.openPositions.length === 0) return;
    const fiveMinAgo = Date.now() - 5 * 60_000;
    const oldPositions = state.openPositions.filter(
      (p) => new Date(p.entry_timestamp).getTime() < fiveMinAgo,
    );
    if (oldPositions.length === 0) return;
    const { data } = await this.supabase.getClient()
      .from('lisa_positions')
      .select('symbol, entry_price, peak_pre_exit, entry_timestamp')
      .eq('portfolio_id', TRADER_AGENT_PORTFOLIO_ID)
      .eq('status', 'open')
      .in('symbol', oldPositions.map((p) => p.symbol));
    if (!data) return;
    for (const row of data) {
      const peak = Number(row.peak_pre_exit);
      const entry = Number(row.entry_price);
      // peak_pre_exit doit être > entry pour un long (MFE > 0) — sinon never updated
      // OR le prix n'est jamais monté au-dessus de l'entry (= MAE-only trade).
      // Pour distinguer, on fetch le live et compare.
      const live = await this.lisa.getLivePrice(row.symbol).catch(() => null);
      if (!live?.price) continue;
      const livePrice = Number(live.price);
      if (!Number.isFinite(peak) || peak <= entry) {
        // peak n'a jamais bougé au-dessus d'entry → soit MAE-only soit recordMfe broken.
        // Si livePrice > entry maintenant, c'est preuve que recordMfe ne tire pas.
        if (livePrice > entry * 1.002) {
          this.logger.warn(
            `[trader-agent] MFE_HEALTH_ALERT ${row.symbol} live=${livePrice} > entry=${entry} mais peak_pre_exit=${peak} → recordMfe ne tire PAS (trailing BE/TP/let-run inopérants)`,
          );
        }
      }
    }
  }

  /**
   * Pre-flight orphan-close (28/05/2026, ADDENDUM TRADER) — déterministe, pas LLM.
   * Pour chaque position ouverte : si le marché du ticker ferme dans <30 min ET
   * PnL unreal ≥ -0.1% (breakeven+), close. Codification du pattern qui a fait
   * +$190 net jour TRADER (CHRT.LSE 2x, IQE.LSE).
   *
   * Returns la liste des symboles fermés.
   */
  private async preFlightOrphanClose(
    state: { openPositions: Array<{ symbol: string; direction: string; entry_price: number; entry_notional_usd: number; entry_timestamp: string }> },
  ): Promise<string[]> {
    if (state.openPositions.length === 0) return [];

    // Map suffix → heure UTC de fermeture (CLAUDE.md §6quater + P4-A).
    // Couvre toutes les bourses tradées par TRADER.
    const closeByMarket = (sym: string): number | null => {
      const s = sym.toUpperCase();
      if (s.endsWith('.US')) return 21 * 60;          // NYSE 21:00 UTC
      if (s.endsWith('.LSE') || s.endsWith('.L')) return 16 * 60 + 30;  // LSE 16:30 UTC
      if (s.endsWith('.XETRA') || s.endsWith('.DE') || s.endsWith('.F') || s.endsWith('.PA') || s.endsWith('.AS') || s.endsWith('.BR') || s.endsWith('.MI') || s.endsWith('.MC') || s.endsWith('.SW')) return 15 * 60 + 30;
      if (s.endsWith('.T')) return 6 * 60;            // TSE Tokyo 06:00 UTC
      if (s.endsWith('.HK')) return 8 * 60;           // HKEX 08:00 UTC
      if (s.endsWith('.KO') || s.endsWith('.KQ')) return 6 * 60 + 30;   // KRX/KOSDAQ 06:30 UTC
      if (s.endsWith('.AU')) return 6 * 60;           // ASX 06:00 UTC
      // Crypto et tickers sans suffixe reconnu = 24/7, no orphan close
      return null;
    };

    const nowMin = (() => {
      const d = new Date();
      return d.getUTCHours() * 60 + d.getUTCMinutes();
    })();

    const closed: string[] = [];
    for (const pos of state.openPositions) {
      const closeMin = closeByMarket(pos.symbol);
      if (closeMin === null) continue;
      const minutesToClose = closeMin - nowMin;
      // Marché fermé ou ferme dans <30 min mais > 0 (sinon on est déjà après close)
      if (minutesToClose >= 30 || minutesToClose < -5) continue;

      // Fetch live price + PnL
      const livePriceData = await this.lisa.getLivePrice(pos.symbol).catch(() => null);
      if (!livePriceData?.price) continue;
      const livePrice = Number(livePriceData.price);
      if (!Number.isFinite(livePrice) || livePrice <= 0) continue;
      // Ne pas fermer sur fallback price — risque corruption (cf. CLAUDE.md §6quater).
      const src = String(livePriceData.source ?? '');
      if (src.startsWith('fallback')) continue;

      const pnlPct = pos.direction === 'short'
        ? ((pos.entry_price - livePrice) / pos.entry_price) * 100
        : ((livePrice - pos.entry_price) / pos.entry_price) * 100;

      // Seuil : close si breakeven ou positif. Tolérance -0.1% pour les fees.
      // Si la position est en grosse perte (<-0.5%), on laisse Gemini gérer
      // (peut-être un stop-loss qui va déclencher avant la cloche).
      if (pnlPct < -0.1) continue;

      const { data: row } = await this.supabase.getClient()
        .from('lisa_positions')
        .select('id')
        .eq('portfolio_id', TRADER_AGENT_PORTFOLIO_ID)
        .eq('symbol', pos.symbol)
        .eq('status', 'open')
        .order('entry_timestamp', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!row?.id) continue;

      const res = await this.lisa.closeForOpportunityScout({
        positionId: row.id,
        symbol: pos.symbol,
        livePrice,
        livePriceSource: src,
        reason: 'closed_user',
        rationale: `[trader-agent preflight-orphan] marché ferme dans ${minutesToClose}min, PnL ${pnlPct.toFixed(2)}% — close pre-cloche systématique (lesson 28/05 +$190 net)`,
      });
      if (res.closed) {
        closed.push(`${pos.symbol} (PnL ${pnlPct.toFixed(2)}%, ${minutesToClose}min to close)`);
      }
    }
    return closed;
  }

  private async readState(): Promise<{
    openPositions: Array<{ symbol: string; direction: string; entry_price: number; entry_notional_usd: number; entry_timestamp: string }>;
    openCount: number;
    deployedUsd: number;
    capitalAvailableUsd: number;
    dailyPnlUsd: number;
    closedTodayCount: number;
    winRateTodayPct: number | null;
    // LISA refonte A.4 — Capital composé : initial + Σ realized_pnl (si compound activé)
    // Lu depuis lisa_session_configs.lisa_{initial_capital_usd,compound_pnl_enabled}.
    // Fallback constant TRADER_AGENT_CAPITAL_USD si DB indisponible.
    initialCapitalUsd: number;
    currentCapitalUsd: number;
    compoundPnlEnabled: boolean;
    cumulativePnlUsd: number;
    drawdownFromInitialPct: number;
    killSwitchActive: boolean;
    recentClosesLast60min: Array<{
      symbol: string;
      direction: string;
      exit_at: string;
      exit_reason: string;
      pnl_usd: number;
      pnl_pct: number;
      minutes_ago: number;
    }>;
  }> {
    const client = this.supabase.getClient();
    const todayStart = `${new Date().toISOString().slice(0, 10)}T00:00:00Z`;
    const sixtyMinAgoIso = new Date(Date.now() - 60 * 60_000).toISOString();

    // LISA refonte A.4 — Lecture config capital composé
    const { data: cfg } = await client
      .from('lisa_session_configs')
      .select('lisa_initial_capital_usd, lisa_compound_pnl_enabled, kill_switch_active')
      .eq('portfolio_id', TRADER_AGENT_PORTFOLIO_ID)
      .maybeSingle();
    const initialCapital = Number(
      (cfg as { lisa_initial_capital_usd?: unknown } | null)?.lisa_initial_capital_usd
      ?? TRADER_AGENT_CAPITAL_USD
    );
    const compoundEnabled = Boolean(
      (cfg as { lisa_compound_pnl_enabled?: unknown } | null)?.lisa_compound_pnl_enabled ?? true
    );
    const killSwitchActive = Boolean(
      (cfg as { kill_switch_active?: unknown } | null)?.kill_switch_active ?? false
    );

    const { data: open } = await client
      .from('lisa_positions')
      .select('symbol, direction, entry_price, entry_notional_usd, entry_timestamp')
      .eq('portfolio_id', TRADER_AGENT_PORTFOLIO_ID)
      .eq('status', 'open');

    const { data: closed } = await client
      .from('lisa_positions')
      .select('realized_pnl_usd')
      .eq('portfolio_id', TRADER_AGENT_PORTFOLIO_ID)
      .gte('exit_timestamp', todayStart)
      .neq('status', 'open');

    // LISA refonte A.4 — Cumulative PnL depuis création (pour capital composé)
    const { data: allClosed } = await client
      .from('lisa_positions')
      .select('realized_pnl_usd')
      .eq('portfolio_id', TRADER_AGENT_PORTFOLIO_ID)
      .neq('status', 'open');
    const cumulativePnl = (allClosed ?? []).reduce(
      (s, c) => s + Number((c as { realized_pnl_usd?: unknown }).realized_pnl_usd ?? 0),
      0,
    );
    const currentCapital = compoundEnabled ? initialCapital + cumulativePnl : initialCapital;
    const drawdownPct = initialCapital > 0 ? ((currentCapital - initialCapital) / initialCapital) * 100 : 0;

    // Closes des 60 dernières minutes (cf. PR #494)
    const { data: recentClosed } = await client
      .from('lisa_positions')
      .select('symbol, direction, exit_timestamp, exit_reason, realized_pnl_usd, realized_pnl_pct')
      .eq('portfolio_id', TRADER_AGENT_PORTFOLIO_ID)
      .gte('exit_timestamp', sixtyMinAgoIso)
      .neq('status', 'open')
      .order('exit_timestamp', { ascending: false });

    const openPositions = (open ?? []).map((p) => ({
      symbol: p.symbol as string,
      direction: p.direction as string,
      entry_price: Number(p.entry_price),
      entry_notional_usd: Number(p.entry_notional_usd ?? 0),
      entry_timestamp: p.entry_timestamp as string,
    }));
    const deployed = openPositions.reduce((s, p) => s + p.entry_notional_usd, 0);
    const dailyPnl = (closed ?? []).reduce((s, c) => s + Number(c.realized_pnl_usd ?? 0), 0);
    const wins = (closed ?? []).filter((c) => Number(c.realized_pnl_usd ?? 0) > 0).length;
    const winRate = (closed?.length ?? 0) > 0 ? (wins / closed!.length) * 100 : null;

    const nowMs = Date.now();
    const recentClosesLast60min = (recentClosed ?? []).map((c) => ({
      symbol: c.symbol as string,
      direction: c.direction as string,
      exit_at: c.exit_timestamp as string,
      exit_reason: (c.exit_reason as string | null) ?? 'unknown',
      pnl_usd: Number(c.realized_pnl_usd ?? 0),
      pnl_pct: Number(c.realized_pnl_pct ?? 0),
      minutes_ago: Math.floor((nowMs - new Date(c.exit_timestamp as string).getTime()) / 60_000),
    }));

    return {
      openPositions,
      openCount: openPositions.length,
      deployedUsd: deployed,
      capitalAvailableUsd: currentCapital - deployed,
      dailyPnlUsd: dailyPnl,
      closedTodayCount: closed?.length ?? 0,
      winRateTodayPct: winRate,
      initialCapitalUsd: initialCapital,
      currentCapitalUsd: currentCapital,
      compoundPnlEnabled: compoundEnabled,
      cumulativePnlUsd: cumulativePnl,
      drawdownFromInitialPct: drawdownPct,
      killSwitchActive,
      recentClosesLast60min,
    };
  }

  /**
   * Classify asset_class from exchange suffix. Aligné sur le système global.
   * BUGFIX 29/05 : 37/37 trades TRADER avaient asset_class=unknown faute de
   * mapping. Sans asset_class, les lessons par-classe ne s'appliquent pas
   * et l'audit/MFE par-classe est faussé.
   */
  private classifyAssetClass(exchange: string | undefined, symbol: string): string {
    const exch = String(exchange ?? '').toUpperCase();
    const sym = String(symbol ?? '').toUpperCase();
    if (exch === 'US' || sym.endsWith('.US')) return 'us_equity_large';
    if (exch === 'CC' || sym.includes('USDT') || sym.endsWith('.CC')) return 'crypto_major';
    if (['T', 'HK', 'KO', 'KQ', 'AU', 'SHG', 'SHE', 'SS', 'SZ', 'SI'].includes(exch)
        || sym.endsWith('.T') || sym.endsWith('.HK') || sym.endsWith('.KO') || sym.endsWith('.KQ')
        || sym.endsWith('.AU') || sym.endsWith('.SHG') || sym.endsWith('.SHE')) return 'asia_equity';
    if (['LSE', 'L', 'XETRA', 'DE', 'F', 'PA', 'AS', 'BR', 'MI', 'MC', 'SW'].includes(exch)
        || sym.endsWith('.LSE') || sym.endsWith('.L') || sym.endsWith('.XETRA')
        || sym.endsWith('.DE') || sym.endsWith('.PA') || sym.endsWith('.F')
        || sym.endsWith('.AS') || sym.endsWith('.BR') || sym.endsWith('.MI')
        || sym.endsWith('.MC') || sym.endsWith('.SW')) return 'eu_equity';
    return 'unknown';
  }

  /**
   * LISA refonte A.4 — lit le capital actuel (composé) pour le sizing Kelly.
   * Cached null-safe : retourne TRADER_AGENT_CAPITAL_USD fallback si DB indispo.
   */
  private async fetchCurrentCapital(): Promise<number> {
    try {
      const { data: cfg } = await this.supabase.getClient()
        .from('lisa_session_configs')
        .select('lisa_initial_capital_usd, lisa_compound_pnl_enabled')
        .eq('portfolio_id', TRADER_AGENT_PORTFOLIO_ID)
        .maybeSingle();
      const initial = Number(
        (cfg as { lisa_initial_capital_usd?: unknown } | null)?.lisa_initial_capital_usd
        ?? TRADER_AGENT_CAPITAL_USD
      );
      const compound = Boolean(
        (cfg as { lisa_compound_pnl_enabled?: unknown } | null)?.lisa_compound_pnl_enabled ?? true
      );
      if (!compound) return initial;
      const { data: closed } = await this.supabase.getClient()
        .from('lisa_positions')
        .select('realized_pnl_usd')
        .eq('portfolio_id', TRADER_AGENT_PORTFOLIO_ID)
        .neq('status', 'open');
      const pnl = (closed ?? []).reduce(
        (s, c) => s + Number((c as { realized_pnl_usd?: unknown }).realized_pnl_usd ?? 0),
        0,
      );
      return initial + pnl;
    } catch (e) {
      this.logger.debug(`[trader-agent] fetchCurrentCapital failed, fallback: ${String(e).slice(0, 80)}`);
      return TRADER_AGENT_CAPITAL_USD;
    }
  }

  private async fetchTopCandidates(n: number): Promise<object[]> {
    // 02/06/2026 — Scanner-bridge enforcement.
    // Quand TRADER_ARBITRATION_ENABLED=true, le scanner Gainers INSERT ses candidats
    // approuvés (post-gates persistence + path_eff + debate + Mistral LLM gate)
    // dans `scanner_proposals`. Le TRADER LLM doit décider UNIQUEMENT parmi ceux-là —
    // pas de bypass via fetchAllCandidates() (qui retourne la pool brute pré-gates,
    // d'où LIN.PA/SBMO/MSF.XETRA ouverts sans validation gate observés 02/06).
    // Règle métier user : "l'agent trader ne doit sélectionner que parmi ce que lui
    // propose le scanner gainers, jamais autrement".
    const arbitrationEnabled = (this.config.get<string>('TRADER_ARBITRATION_ENABLED') ?? 'false').toLowerCase() === 'true';
    if (arbitrationEnabled) {
      this.logger.debug(
        '[trader-agent] TRADER_ARBITRATION_ENABLED=true → fetchTopCandidates returns [] (LLM uses scanner_proposals only)',
      );
      return [];
    }

    // COMMIT 1 (29/05) — Lecture directe du cache scanner pour avoir des candidats
    // FRAIS (le snapshot table gainers_persistence_log était peuplé uniquement par
    // l'UI dashboard → jusqu'à 7h de retard). Avec topGainersScanner injecté, on
    // récupère le cache live 30s + classifie asset_class correctement.
    //
    // FIX 29/05 09:00 (audit feed) — Filtre BANDE TRADEABLE avant top-N.
    // Bug identifié : sort changePct DESC + slice(top 20) → TRADER ne voyait QUE
    // les paraboliques >20% (overpump junk) et holdait éternellement (30 min
    // straight). Les candidats modérés tradeables (3-12% = winning bucket, ex
    // RWS.LSE que MAIN a pris) étaient enterrés position #30-50, hors top 20.
    // Fix : filtrer [TRADER_FEED_MIN_PCT, TRADER_FEED_MAX_PCT] AVANT top-N.
    // Bornes alignées sur l'overpump gate (15%) et un plancher anti-bruit (2%).
    //
    // P-KTOS ENRICHMENT (29/05 17:15) — chaque candidat est enrichi de 4 métriques
    // computées pour aider le LLM Gemini à appliquer les lessons KTOS (#319e867e,
    // #ab035237, #42101ada, #aa6eda5f) :
    //   - pumpScore : changePct / max_changePct du pool (signal proximity-to-peak)
    //   - closeToHighRatio : close / high (1.0 = au top du jour, < 0.9 = retrace)
    //   - volumeRatio : volume / avgVol50d (>2.0 = momentum confirmé)
    //   - kellyMaxNotional : USD plafond Kelly fraction (TP 2.5% SL 1.5% p_win=0.5 → max 20% cap)
    //   - sweetSpotEntry : booléen, true si changePct ∈ [3,15]% (winning bucket)
    // Ces champs sont injectés dans le userPrompt JSON et lus naturellement par le LLM.
    // PAS de gate hardcodé — décision reste autonome côté Gemini Pro.
    const feedMin = Number(this.config.get<string>('TRADER_FEED_MIN_PCT') ?? '2');
    const feedMax = Number(this.config.get<string>('TRADER_FEED_MAX_PCT') ?? '15');
    // LISA refonte A.4 — Lit le capital actuel (composé) pour scaling Kelly
    const currentCapital = await this.fetchCurrentCapital();
    try {
      const candidates = await this.topGainersScanner.fetchAllCandidates();
      if (candidates && candidates.length > 0) {
        // 1. Filtre bande tradeable. 2. sort DESC. 3. top-N.
        const tradeable = candidates.filter((c) => {
          const cp = c.changePct ?? 0;
          return cp >= feedMin && cp <= feedMax;
        });
        // Fallback : si la bande est vide (marché calme ou tout >max), on garde
        // les candidats < feedMax triés DESC pour ne pas aveugler TRADER.
        const pool = tradeable.length > 0
          ? tradeable
          : candidates.filter((c) => (c.changePct ?? 0) <= feedMax);
        // Phase 1-bis refactor scanner — Si composite ranking actif côté scanner,
        // PRÉSERVER l'ordre du pool (déjà rangé par composite score décroissant
        // dans fetchAllCandidates). Sans ce check, le sort changePct DESC ci-dessous
        // écrase tout le travail Phase 1 et Mistral voit à nouveau les paraboliques
        // en premier. Bug observé 02/06 09:21 UTC après deploy Phase 1-4 :
        //   "composite ranking applied — top1=M44.XETRA(5.5%)"
        //   "trader-agent hold — all candidates parabolic >13%"
        // Cause : sort DESC re-mettait SDR.AU(10.9%) avant M44.XETRA(5.5%).
        const rankingEnabled = (this.config.get<string>('SCANNER_COMPOSITE_RANKING_ENABLED') ?? 'false').toLowerCase() === 'true';
        const sorted = rankingEnabled
          ? pool
          : [...pool].sort((a, b) => (b.changePct ?? 0) - (a.changePct ?? 0));
        if (sorted.length > 0) {
          this.logger.debug(
            `[trader-agent] feed: ${candidates.length} scanned → ${sorted.length} in band [${feedMin},${feedMax}]% → top ${Math.min(n, sorted.length)} (capital=$${currentCapital.toFixed(0)})`,
          );
          // P-KTOS — Compute pool-wide max for pumpScore
          const maxChangePctInPool = sorted.reduce((m, c) => Math.max(m, c.changePct ?? 0), 0);
          return sorted.slice(0, n).map((c) =>
            this.enrichCandidateWithMath(c, maxChangePctInPool, currentCapital),
          );
        }
      }
    } catch (e) {
      this.logger.warn(`[trader-agent] fetchAllCandidates failed: ${String(e).slice(0, 100)}`);
    }
    // Fallback : ancien path (table) si scanner cache vide ou non injecté.
    const { data } = await this.supabase.getClient()
      .from('gainers_persistence_log')
      .select('snapshot_json, summary, captured_at')
      .order('captured_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!data) return [];
    const snap = typeof data.snapshot_json === 'string' ? JSON.parse(data.snapshot_json) : data.snapshot_json;
    const candidates = (snap?.candidates ?? []) as Array<Record<string, unknown>>;
    return candidates.slice(0, n).map((c) => ({
      symbol: c.symbol,
      assetClass: c.assetClass ?? c.asset_class
        ?? this.classifyAssetClass(undefined, String(c.symbol ?? '')),
      changePct: c.changePct,
      persistenceScore: c.persistenceScore,
      close: c.close,
    }));
  }

  /**
   * P-KTOS (29/05) — Enrichit un TopGainerCandidate avec 4 métriques computées
   * pour aider le LLM Gemini Pro à appliquer les lessons KTOS (entry discipline +
   * sizing). PAS de gate hardcodé — le LLM voit les chiffres et décide en autonomie.
   *
   * Formules :
   *   - pumpScore = changePct / max_changePct_du_pool
   *     · > 0.85 → au peak local, retrace probable
   *     · 0.50-0.75 → sweet spot (retrace en cours, momentum encore présent)
   *     · < 0.40 → momentum perdu
   *   - closeToHighRatio = close / high (jour)
   *     · 1.00 → au top du jour (chase the top)
   *     · 0.95-0.98 → momentum sain
   *     · < 0.90 → retrace significative
   *   - volumeRatio = volume / avgVol50d
   *     · > 2.0 → momentum confirmé volume
   *     · 1.0-2.0 → volume normal
   *     · < 0.8 → volume faible, signal douteux
   *   - kellyMaxNotional = TRADER_CAPITAL × Kelly fraction (TP 2.5% SL 1.5% p_win=0.5 fallback)
   *     · Formule : f* = (TP×p_win - SL×(1-p_win)) / TP = 0.20 (default 0.5 win prob)
   *     · → max $2000 sur $10k capital tant que p_win pas remontée par P9
   *   - sweetSpotEntry = (changePct ∈ [3,15]%) : true si dans le bucket gagnant historique
   *
   * Cf. scanner_lessons : 319e867e (PULLBACK_WAIT), ab035237 (velocity), 42101ada (Kelly),
   * aa6eda5f (pump score).
   */
  private enrichCandidateWithMath(
    c: TopGainerCandidate,
    maxChangePctInPool: number,
    currentCapital: number = TRADER_AGENT_CAPITAL_USD,
  ): Record<string, unknown> {
    const changePct = c.changePct ?? 0;
    const high = c.high ?? c.close ?? 0;
    const close = c.close ?? 0;
    const volume = c.volume ?? 0;
    const avgVol50d = c.avgVol50d ?? 0;

    const pumpScore = maxChangePctInPool > 0
      ? Math.round((changePct / maxChangePctInPool) * 100) / 100
      : null;
    const closeToHighRatio = high > 0
      ? Math.round((close / high) * 1000) / 1000
      : null;
    const volumeRatio = avgVol50d > 0
      ? Math.round((volume / avgVol50d) * 100) / 100
      : null;

    // Kelly notional — TP/SL standards trader (2.5% / 1.5%), p_win=0.5 par défaut
    // (sera affiné par P9 quand p_win_at_entry sera correctement persisté).
    // f* = (TP*p_win - SL*(1-p_win)) / TP avec TP=2.5, SL=1.5, p_win=0.5
    //    = (1.25 - 0.75) / 2.5 = 0.20
    // LISA refonte A.4 — utilise currentCapital (composé) au lieu du constant.
    const kellyMaxNotional = Math.round(currentCapital * 0.20);

    // Sweet spot bucket d'entrée — band [3,15]% recalibrée 03/06 ("trade large
    // 1-2 sem"). Avant : [3,8]% sourcé lesson aa6eda5f (archivée). Le band
    // étroit envoyait `sweetSpotEntry: false` à Mistral dès changePct > 8% →
    // Mistral interprétait "hors sweet spot = ne pas entrer" et générait
    // [PULLBACK_WAIT] sur RPI/PRX/IFX (9-11%) — SOURCE RACINE des 11h sans
    // trade aujourd'hui. Aligné avec OVERPUMP_THRESHOLD_PCT_EU/US=15 et la
    // règle prompt C qui dit explicitement "3-15% = momentum sain".
    const sweetSpotEntry = changePct >= 3 && changePct <= 15;

    return {
      symbol: c.symbol,
      assetClass: this.classifyAssetClass(c.exchange ?? undefined, c.symbol),
      changePct,
      close,
      high,
      exchange: c.exchange,
      // Fix 02/06/2026 cycle 11:16 — forward marketCap pour permettre au gate
      // XETRA notional (applyDecision) de distinguer mid/large cap (mcap≥$5B,
      // min $1000) des small-caps (min $3000). Sans ce field, candidate.marketCap
      // est undefined → traité small-cap → MSF.XETRA (€60B) bloqué à $1300.
      marketCap: c.marketCap,
      // P-KTOS enrichment fields :
      pumpScore,
      closeToHighRatio,
      volumeRatio,
      kellyMaxNotional,
      sweetSpotEntry,
      // Phase 2 refactor scanner — momentum + bucket (présents si
      // SCANNER_MOMENTUM_ANALYSIS_ENABLED=true côté scanner, sinon undefined).
      ...(c.momentum ? { momentum: c.momentum } : {}),
      ...(c.bucket ? { bucket: c.bucket } : {}),
    };
  }

  private async fetchMacroContext(): Promise<object> {
    // Cache 2 min côté LisaService — partagé avec ShadowSizingOrchestrator pour
    // éviter de re-fetch les 15-20 calls API EODHD/Yahoo à chaque cycle de 5 min.
    try {
      const snap = await this.lisa.getRecentMarketSnapshot(120);
      return snap;
    } catch (e) {
      this.logger.warn(`[trader-agent] macro fetch failed: ${String(e).slice(0, 100)}`);
      return { note: 'macro_snapshot_unavailable_this_cycle', error: String(e).slice(0, 100) };
    }
  }

  private async fetchRecentNews(n: number): Promise<object[]> {
    // Fix 03/06/2026 — la table `eodhd_news_articles` utilise les colonnes
    // `ticker`/`sentiment_polarity`/`source_url`, pas `symbol`/`sentiment`/
    // `source` (la query précédente échouait silencieusement → 8612 news
    // collectées mais TRADER recevait toujours news=[] → setup A+ jamais
    // matché → trader systématiquement hold). On alias en sortie pour
    // préserver les noms attendus par le prompt Mistral (cf. ligne 202+).
    // Plus error capture explicite (sinon PostgREST error reste muet).
    const since = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
    const { data, error } = await this.supabase.getClient()
      .from('eodhd_news_articles')
      .select('title, symbol:ticker, sentiment:sentiment_polarity, source:source_url, published_at')
      .gte('published_at', since)
      .order('published_at', { ascending: false })
      .limit(n);
    if (error) {
      this.logger.warn(`[trader-agent] fetchRecentNews failed: ${error.message}`);
      return [];
    }
    return (data ?? []) as object[];
  }

  /**
   * PR #536 — Récupère le daily_catalyst_brief le plus récent (cron 04:00 UTC).
   * Retourne le payload brut (macro_events, tickers_to_watch/avoid, sectors)
   * pour injection directe dans le user_prompt JSON du LLM décideur.
   *
   * Ne retourne null que si :
   *   - brief absent dans lisa_decision_log
   *   - brief > 24h (stale, on évite de polluer le prompt avec données obsolètes)
   *
   * Le brief existe en N copies (1 par portfolio gainers actif) mais le contenu
   * est identique → on prend la première row trouvée.
   */
  private async fetchLatestDailyBrief(): Promise<object | null> {
    const since24h = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
    const { data, error } = await this.supabase.getClient()
      .from('lisa_decision_log')
      .select('payload, timestamp')
      .eq('kind', 'daily_catalyst_brief')
      .gte('timestamp', since24h)
      .order('timestamp', { ascending: false })
      .limit(1);
    if (error || !data || data.length === 0) return null;
    const p = data[0].payload as Record<string, unknown>;
    // Strip llm metadata, garde uniquement la substance pour le décideur
    return {
      date: p.date,
      macro_events: p.macro_events,
      tickers_to_watch: p.tickers_to_watch,
      tickers_to_avoid: p.tickers_to_avoid,
      sectors_in_focus: p.sectors_in_focus,
      summary: p.summary,
      generated_at: data[0].timestamp,
    };
  }

  private async fetchActiveMemory(n: number): Promise<Array<{ lesson_kind: string; lesson_text: string; confidence: number }>> {
    const { data } = await this.supabase.getClient()
      .from('trader_agent_memory')
      .select('lesson_kind, lesson_text, confidence')
      .eq('portfolio_id', TRADER_AGENT_PORTFOLIO_ID)
      .eq('is_active', true)
      .order('confidence', { ascending: false })
      .limit(n * 2); // overfetch pour permettre remontée user_pattern
    const all = (data ?? []) as Array<{ lesson_kind: string; lesson_text: string; confidence: number }>;
    // PRIORITÉ : user_pattern lessons remontées en tête (autorité humaine prévaut),
    // puis le reste par confidence décroissante. Cap à n.
    const userPatterns = all.filter(l => l.lesson_kind === 'user_pattern');
    const others = all.filter(l => l.lesson_kind !== 'user_pattern');
    return [...userPatterns, ...others].slice(0, n);
  }

  /**
   * 01/06 — Calcule les objectifs et le progress vs cible jour pour TRADER.
   * Lit lisa_session_configs.return_target_daily_pct (et fallbacks monthly/annual).
   * Recompute realized_today_usd live depuis lisa_positions fermées today UTC.
   * Retourne null si pas de cible configurée → le LLM ne sera pas contraint
   * par un trajectory status non-fondé.
   *
   * Sémantique trajectory (alignée CLAUDE.md §6 quater) :
   *   - EN_AVANCE     : progress ≥ 100% → posture normal, conviction threshold standard
   *   - DANS_LE_PLAN  : 50% ≤ progress < 100% → momentum-based
   *   - EN_RETARD     : 0% ≤ progress < 50% → aggressive (sizing×1.2, conviction↓0.10)
   *   - HORS_TRAJECTOIRE : progress < 0% (drawdown jour) → defensive (sauf hyper-active)
   */
  private async computeTraderObjectives(
    state: Awaited<ReturnType<typeof this.readState>>,
    cycleStartedAt: Date,
  ): Promise<{
    target_daily_usd: number;
    realized_today_usd: number;
    progress_pct: number;
    trajectory_status: 'EN_AVANCE' | 'DANS_LE_PLAN' | 'EN_RETARD' | 'HORS_TRAJECTOIRE';
    hours_remaining_in_us_session: number | null;
    suggested_risk_posture: 'aggressive' | 'normal' | 'cautious' | 'defensive';
    suggested_conviction_floor: number;
    suggested_sizing_multiplier: number;
    suggested_max_opens_this_cycle: number;
  } | null> {
    // 1. Lecture cible config
    const { data: cfg } = await this.supabase.getClient()
      .from('lisa_session_configs')
      .select('return_target_daily_pct, return_target_monthly_pct, return_target_annual_pct')
      .eq('portfolio_id', TRADER_AGENT_PORTFOLIO_ID)
      .maybeSingle();
    const c = cfg as { return_target_daily_pct?: number | null; return_target_monthly_pct?: number | null; return_target_annual_pct?: number | null } | null;
    let dailyPctTarget: number | null = null;
    if (c?.return_target_daily_pct != null) dailyPctTarget = Number(c.return_target_daily_pct);
    else if (c?.return_target_monthly_pct != null) dailyPctTarget = Number(c.return_target_monthly_pct) / 30;
    else if (c?.return_target_annual_pct != null) dailyPctTarget = Number(c.return_target_annual_pct) / 365;

    // Cible USD effective : MAX($200 plancher, pct × capital actuel).
    // $200 plancher = mandate $400/jour défini dans SYSTEM_PROMPT_BASE mais
    // dégradé à $200 pendant calibration (suit gains-tracker.tsx logic).
    const FLOOR_USD = 200;
    const targetUsd = dailyPctTarget != null
      ? Math.max(FLOOR_USD, (dailyPctTarget / 100) * state.currentCapitalUsd)
      : FLOOR_USD;

    // 2. Realized today live (positions fermées depuis 00:00 UTC)
    const todayUtcStart = new Date(cycleStartedAt);
    todayUtcStart.setUTCHours(0, 0, 0, 0);
    const { data: closes } = await this.supabase.getClient()
      .from('lisa_positions')
      .select('realized_pnl_usd')
      .eq('portfolio_id', TRADER_AGENT_PORTFOLIO_ID)
      .neq('status', 'open')
      .gte('exit_timestamp', todayUtcStart.toISOString());
    const realizedToday = (closes ?? []).reduce(
      (acc, r) => acc + Number((r as { realized_pnl_usd?: unknown }).realized_pnl_usd ?? 0),
      0,
    );

    const progressPct = targetUsd > 0 ? Math.round((100 * realizedToday) / targetUsd) : 0;

    // 3. Trajectory status simplifié (alignée riskPosture LisaService:1612+)
    let trajectoryStatus: 'EN_AVANCE' | 'DANS_LE_PLAN' | 'EN_RETARD' | 'HORS_TRAJECTOIRE';
    if (realizedToday < 0) trajectoryStatus = 'HORS_TRAJECTOIRE';
    else if (progressPct >= 100) trajectoryStatus = 'EN_AVANCE';
    else if (progressPct >= 50) trajectoryStatus = 'DANS_LE_PLAN';
    else trajectoryStatus = 'EN_RETARD';

    // 4. Heures restantes session US (NYSE close 21:00 UTC, hiver 22:00).
    //    Approximation : utilise 21:00 UTC permanent (DST handling = future PR).
    const usSessionCloseUtc = new Date(cycleStartedAt);
    usSessionCloseUtc.setUTCHours(21, 0, 0, 0);
    let hoursRemaining: number | null = null;
    const msToClose = usSessionCloseUtc.getTime() - cycleStartedAt.getTime();
    if (msToClose > 0 && msToClose < 12 * 3600_000) {
      hoursRemaining = Math.round((msToClose / 3600_000) * 10) / 10;
    }

    // 5. Posture suggérée pour le LLM (il garde la liberté de l'override).
    // FIX 03/06 v3 — Relax encore HORS_TRAJECTOIRE : audit funnel 03/06 montre
    // 11h sans trade ce matin malgré 25 proposals (Mistral refusait "scores
    // trop bas 0.5-0.61" même quand setups étaient sains). Cercle vicieux
    // persiste car conviction Mistral médiane = 0.65-0.70 pas 0.78. Le
    // convictionFloor 0.78 = NO_OPEN pratique pour la moitié des cycles.
    // Nouveau : HORS_TRAJ → conviction ≥ 0.70 (relax 0.78), sizing × 0.7
    // conservé. Le LLM peut toujours hold s'il pense réellement avoir un
    // setup pourri, mais 0.70 est la médiane des décisions réelles donc on
    // débloque la moitié du throughput perdu.
    let posture: 'aggressive' | 'normal' | 'cautious' | 'defensive';
    let convictionFloor = 0.75;
    let sizingMult = 1.0;
    let maxOpensThisCycle = 3;
    if (trajectoryStatus === 'HORS_TRAJECTOIRE') {
      posture = 'cautious';
      convictionFloor = 0.70;
      sizingMult = 0.7;
      maxOpensThisCycle = 1;
    } else if (trajectoryStatus === 'EN_RETARD') {
      posture = 'aggressive';
      convictionFloor = 0.65;
      sizingMult = 1.2;
      maxOpensThisCycle = 3;
    } else if (trajectoryStatus === 'EN_AVANCE') {
      posture = 'normal';
      convictionFloor = 0.75;
      sizingMult = 0.9;
      maxOpensThisCycle = 2;
    } else {
      posture = 'normal';
      maxOpensThisCycle = 3;
    }

    return {
      target_daily_usd: Math.round(targetUsd * 100) / 100,
      realized_today_usd: Math.round(realizedToday * 100) / 100,
      progress_pct: progressPct,
      trajectory_status: trajectoryStatus,
      hours_remaining_in_us_session: hoursRemaining,
      suggested_risk_posture: posture,
      suggested_conviction_floor: convictionFloor,
      suggested_sizing_multiplier: sizingMult,
      suggested_max_opens_this_cycle: maxOpensThisCycle,
    };
  }

  private buildSystemPrompt(
    memory: Array<{ lesson_kind: string; lesson_text: string; confidence: number }>,
    crossScannerLessons: string,
    middleReference: string,
    selfReflection: string,
  ): string {
    let prompt = SYSTEM_PROMPT_BASE;

    // OKLO-fix 03/06/2026 — Préambule blow-off / pump-fade lessons (priors
    // académiques + consensus, 12 patterns nommés). Injecté en tête de prompt
    // pour que ces patterns deviennent une grille de lecture par défaut, pas
    // un appendice optionnel. Le scanner bloque déjà les 4 plus mécaniques
    // (cf. blow-off-gates.helper.ts) mais le TRADER doit savoir les nommer
    // pour verbaliser un skip propre. Configurable via env.
    const blowOffPreambleOn = (this.config.get<string>('TRADER_BLOW_OFF_PREAMBLE_ENABLED') ?? 'true').toLowerCase() === 'true';
    if (blowOffPreambleOn) {
      prompt += `\n\n${formatBlowOffPreambleBlock()}`;
    }

    // Bloc 0 : USER PATTERNS — autorité humaine prioritaire
    // Ces lessons reflètent les actions manuelles de l'utilisateur (closed_user),
    // qui ont une autorité maximale (intent volontaire, info hors-modèle).
    // Présentées en TÊTE avec instruction "REPRODUIS ces patterns en priorité".
    const userPatterns = memory.filter(l => l.lesson_kind === 'user_pattern');
    const otherMemory = memory.filter(l => l.lesson_kind !== 'user_pattern');
    if (userPatterns.length > 0) {
      const userBlock = userPatterns
        .map((l, i) => `${i + 1}. ${l.lesson_text} (conf=${l.confidence})`)
        .join('\n');
      prompt += `\n\n═══ USER PATTERNS (AUTORITÉ HUMAINE — PRIORITÉ ABSOLUE) ═══\n${userBlock}\n\nCes patterns reflètent les ACTIONS MANUELLES de l'utilisateur. L'humain a accès à des informations contextuelles hors-modèle (intuition, news lue, sentiment marché). REPRODUIS ces comportements en priorité quand tu rencontres un setup similaire.`;
    }

    // Bloc 1 : memory trader-spécifique (post-mortems Trader Agent)
    if (otherMemory.length > 0) {
      const memoryBlock = otherMemory
        .map((l, i) => `${i + 1}. [${l.lesson_kind}] ${l.lesson_text} (conf=${l.confidence})`)
        .join('\n');
      prompt += `\n\nLESSONS APPRISES TRADER AGENT (post-mortems précédents, ordre confidence descendant) :\n${memoryBlock}`;
    }

    // Bloc 2 : lessons cross-scanner
    if (crossScannerLessons.length > 0) {
      prompt += `\n\n${crossScannerLessons}`;
    }

    // COMMIT 5 (29/05) — Bloc MIDDLE reference : injecte les 5 derniers trades
    // MIDDLE (le champion mécanique +$125 sur 2j vs ton -$96) pour que tu
    // calques son comportement. MIDDLE n'utilise PAS de LLM mais te bat.
    if (middleReference.length > 0) {
      prompt += `\n\n${middleReference}`;
    }

    // AUTO-CORRECTION DYNAMIQUE (29/05) — Si tes dernières décisions ont une
    // capture rate négative OU WR < 40%, on injecte une auto-correction.
    if (selfReflection.length > 0) {
      prompt += `\n\n${selfReflection}`;
    }

    if (memory.length > 0 || crossScannerLessons.length > 0 || middleReference.length > 0 || selfReflection.length > 0) {
      prompt += `\n\nGarde ces lessons en tête en priorité pour ta décision actuelle.`;
    }

    // 01/06 — Bloc objectifs : explique comment lire userPrompt.objectives_progress
    // pour ajuster ta posture risk. Tu gardes la liberté finale (override possible
    // avec justification), mais ne devrais pas hold systématiquement quand tu es
    // EN_RETARD avec heures restantes session.
    prompt += `

OBJECTIFS & TRAJECTOIRE (champ userPrompt.objectives_progress) :
- trajectory_status = EN_AVANCE → posture normal, conviction floor 0.75, sizing×0.9, max 2 opens/cycle
- trajectory_status = DANS_LE_PLAN → posture normal, conviction 0.75, sizing×1.0, max 3 opens/cycle
- trajectory_status = EN_RETARD → posture aggressive, conviction floor 0.65 (abaissé), sizing×1.2, max 3 opens/cycle
- trajectory_status = HORS_TRAJECTOIRE (drawdown jour) → posture cautious, conviction 0.70, sizing×0.7, **max 1 open/cycle**

RÈGLES OBJECTIVES (révisées 01/06 v2 — relax HORS_TRAJ pour briser cercle vicieux) :

Si EN_RETARD avec hours_remaining_in_us_session ≥ 2 : tu DOIS chercher activement des opens
(descendre dans top-50 si top-10 sont parabolic) au lieu de hold global. Cite
'[OBJ_AGGRESSIVE progress=X% remaining=Yh]' dans thesis pour traçabilité.

Si HORS_TRAJECTOIRE : tu peux ouvrir MAX 1 position/cycle avec conviction ≥ 0.70, sizing×0.7.
Ne pas être agressif (sizing réduit + 1 max) mais NE PAS rester paralysé non plus. Si un candidat
décent (pas A++ obligatoire) émerge — conviction ≥ 0.70, R/R ≥ 1.5, sweetSpot OU pullback récent —
tu peux ouvrir 1 position. Cite '[OBJ_CAUTIOUS_TRY conv=X.XX size=Y]' dans thesis.
Si AUCUN candidat décent : hold OK, cite '[OBJ_CAUTIOUS_NO_VALID]'. NE PAS forcer un trade médiocre.
RAPPEL — un candidat à conv 0.70 ET changePct 3-15% ET persistence ≥ 0.6 EST décent. Ne refuse pas
sur prétexte "scores trop bas" si conf ≥ 0.70 — le system prompt règle 7 dit "conf ≥ 0.65 pour agir",
le seuil HORS_TRAJ relevé à 0.70 = juste +5pts pour la prudence drawdown, pas l'A++ obligatoire.

Si HORS_TRAJECTOIRE ET hours_remaining < 1 : skip opens (le trade n'aura pas le temps de jouer),
ferme uniquement les positions cassées. Cite '[OBJ_LATE_NO_OPEN]'.

Les suggested_* sont des suggestions, pas des ordres. Tu peux override avec justification
explicite dans thesis (ex : 'OVERRIDE_SUGGESTED_POSTURE car news_shock détecté X').`;

    // Phase 3 refactor scanner — Momentum & bucket interpretation block.
    // Inject ce bloc UNIQUEMENT si SCANNER_MOMENTUM_ANALYSIS_ENABLED=true (= Phase 2 activée).
    // Sans la Phase 2, les champs momentum/bucket sont absents du userPrompt → bloc inutile.
    const momentumEnabled = (this.config.get<string>('SCANNER_MOMENTUM_ANALYSIS_ENABLED') ?? 'false').toLowerCase() === 'true';
    if (momentumEnabled) {
      prompt += `

MOMENTUM TIME-SERIES (champ candidate.momentum + candidate.bucket — Phase 2 scanner) :

Tu vois maintenant 5 métriques par candidat, computées sur les 12 dernières candles 5m :
- gradientPctPerMin : vitesse moyenne %/min. >+0.1 monte, <-0.1 retrace.
- acceleration : récent vs ancien. >0 en accélération, <0 en décélération.
- volumeMomentum : volume récent / volume ancien. >1.5 surge, <0.7 essoufflement.
- verticalityScore : 0-1. Proche de 1 = pump vertical (P&D risk).
- risingScore : 0-1 composite. >0.65 strong momentum, 0.4-0.65 neutre, <0.35 reversing.

bucket classification (déterministe côté scanner, à utiliser comme HEURISTIQUE prioritaire) :
- sweet_spot_rising : changePct ∈ [3,15]% + momentum positif → SETUP A à A+ pour entry long (recalibré 03/06, avant [3,12]).
- early_mover : changePct ∈ [0.5,3]% + accel positive → SETUP B, premier signal, plus risqué mais R/R supérieur.
- peak_parabolic : changePct > 15 + closeToHigh > 0.95 → PASS, late entry, P&D risk élevé (recalibré 03/06, avant > 12).
- stalled : sweet-spot zone MAIS momentum faible (risingScore < 0.55) → WAIT pullback, ne pas chase.
- reversing : gradient < -0.1 → SKIP long, peut être short si setup confirme.

PRIORITÉS DÉCISION (utilise ces buckets en COMPLÉMENT — pas en remplacement — de tes lessons existantes) :
1. Privilégie sweet_spot_rising > early_mover > tout autre.
2. peak_parabolic = signal d'attente pullback, jamais d'open_directional long.
3. reversing sur position ouverte longue = signal de close_now / trail_stop serré.
4. Cite le bucket dans ta thesis : '[BUCKET=sweet_spot_rising rising=0.72]' pour traçabilité.

Si momentum/bucket absents (Phase 2 désactivée ou fetch échoué), ignore ces règles et reviens au comportement legacy (pumpScore + closeToHighRatio + lessons KTOS).`;
    }

    return prompt;
  }

  /**
   * COMMIT 5 (29/05) — Fetch les 5 derniers trades MIDDLE (champion) pour
   * injection comme référence à imiter dans le prompt TRADER.
   */
  private async fetchMiddleReference(): Promise<string> {
    try {
      const { data } = await this.supabase.getClient()
        .from('lisa_positions')
        .select('symbol, asset_class, entry_notional_usd, entry_price, realized_pnl_usd, realized_pnl_pct, exit_reason, entry_timestamp, exit_timestamp')
        .eq('portfolio_id', 'a0000002-0000-0000-0000-000000000002')
        .neq('status', 'open')
        .order('exit_timestamp', { ascending: false })
        .limit(5);
      if (!data || data.length === 0) return '';
      const lines = data.map((p, i) => {
        const entry = String(p.entry_timestamp ?? '').slice(11, 16);
        const exit = String(p.exit_timestamp ?? '').slice(11, 16);
        const pnl = Number(p.realized_pnl_usd ?? 0);
        const pct = Number(p.realized_pnl_pct ?? 0);
        const reason = String(p.exit_reason ?? '').slice(0, 30);
        return `  ${i + 1}. ${entry}→${exit} ${p.symbol} (${p.asset_class}) $${p.entry_notional_usd} pnl=$${pnl.toFixed(2)} (${pct.toFixed(2)}%) — ${reason}`;
      }).join('\n');
      return `RÉFÉRENCE MIDDLE (le champion mécanique, 5 derniers trades) :\n${lines}\n→ MIDDLE n'utilise PAS de LLM mais te bat (+$125 vs ton -$96 sur 2j). Observe : sizing constant, hold 5-25min, exits par TP/choppy mécanique, AUCUN close manuel arbitraire. CALQUE CE COMPORTEMENT.`;
    } catch {
      return '';
    }
  }

  /**
   * AUTO-CORRECTION DYNAMIQUE (29/05) — Analyse les 5 dernières décisions
   * TRADER. Si capture rate < 0% ou WR < 40%, retourne un avertissement
   * à injecter dans le prompt pour forcer mode défensif.
   */
  private async computeSelfReflection(): Promise<string> {
    try {
      const { data } = await this.supabase.getClient()
        .from('lisa_positions')
        .select('entry_price, exit_price, peak_pre_exit, realized_pnl_usd, direction')
        .eq('portfolio_id', TRADER_AGENT_PORTFOLIO_ID)
        .neq('status', 'open')
        .order('exit_timestamp', { ascending: false })
        .limit(5);
      if (!data || data.length < 3) return '';

      const captures: number[] = [];
      let wins = 0;
      for (const p of data) {
        const entry = Number(p.entry_price);
        const exit = Number(p.exit_price);
        const peak = Number(p.peak_pre_exit);
        const pnl = Number(p.realized_pnl_usd ?? 0);
        if (pnl > 0) wins++;
        if (Number.isFinite(entry) && Number.isFinite(peak) && Number.isFinite(exit) && entry > 0) {
          const dir = String(p.direction ?? 'long');
          const mfePct = dir === 'short' ? ((entry - peak) / entry) * 100 : ((peak - entry) / entry) * 100;
          const realPct = dir === 'short' ? ((entry - exit) / entry) * 100 : ((exit - entry) / entry) * 100;
          if (mfePct > 0) captures.push(realPct / mfePct);
        }
      }
      const wr = (wins / data.length) * 100;
      const avgCapture = captures.length > 0 ? (captures.reduce((a, b) => a + b, 0) / captures.length) * 100 : null;
      const warnings: string[] = [];
      if (avgCapture !== null && avgCapture < 0) {
        warnings.push(`⚠️ CAPTURE RATE NÉGATIVE : ${avgCapture.toFixed(1)}% sur tes 5 derniers trades. Tu fermes systématiquement au pire moment. CONSÉQUENCE : ce cycle, l'action "close" est interdite si la position est en perte (gate déterministe ajoutée). Utilise trail_stop ou hold.`);
      }
      if (wr < 40 && data.length >= 5) {
        warnings.push(`⚠️ WR ${wr.toFixed(0)}% sur 5 derniers = sous le seuil sain 40%. MODE DÉFENSIF ACTIVÉ : confidence threshold relevé à 0.85 pour ce cycle. Privilégie hold ou trail_stop. Ne propose open_directional QUE sur setup A++ (conviction ≥ 0.85, lesson winning_pattern qui match, persistence ≥ 0.95, path_eff ≥ 0.7).`);
      }
      if (warnings.length === 0) return '';
      return `AUTO-CORRECTION DYNAMIQUE (basée sur tes 5 derniers trades) :\n${warnings.join('\n')}`;
    } catch {
      return '';
    }
  }

  private async applyDecision(
    decision: TraderDecision,
    state: Awaited<ReturnType<typeof this.readState>>,
    candidates: Array<Record<string, unknown>> = [],
  ): Promise<{ applied: boolean; positionId?: string; error?: string }> {
    // Confidence gate
    if (decision.confidence < MIN_CONFIDENCE) {
      return { applied: false, error: `confidence ${decision.confidence} < ${MIN_CONFIDENCE}` };
    }

    if (decision.action_kind === 'hold') return { applied: false };

    if (decision.action_kind === 'open_directional') {
      if (state.openCount >= 5) return { applied: false, error: 'max 5 open positions' };
      if (!decision.symbol || !decision.direction || !decision.notional_usd) {
        return { applied: false, error: 'missing symbol/direction/notional' };
      }

      // B3 (02/06/2026) — Hard guard scanner_proposals.
      // Quand TRADER_ARBITRATION_ENABLED=true, refuse l'open si le symbole+direction
      // n'est pas dans une scanner_proposal pending non-expirée. Code-enforced version
      // de la règle métier : "l'agent trader ne sélectionne QUE parmi ce que lui
      // propose le scanner gainers, jamais autrement". Sans ce guard, le LLM pourrait
      // hallucinerait un symbole (depuis news_recent, daily_brief.focus_symbols,
      // memory lessons) qui n'a pas passé les gates scanner.
      const arbitrationEnabledForOpen = (this.config.get<string>('TRADER_ARBITRATION_ENABLED') ?? 'false').toLowerCase() === 'true';
      if (arbitrationEnabledForOpen) {
        const { data: validProposal } = await this.supabase.getClient()
          .from('scanner_proposals')
          .select('id')
          .eq('portfolio_id', TRADER_AGENT_PORTFOLIO_ID)
          .eq('symbol', decision.symbol)
          .eq('direction', decision.direction)
          .eq('status', 'pending')
          .gt('expires_at', new Date().toISOString())
          .limit(1)
          .maybeSingle();
        if (!validProposal) {
          return {
            applied: false,
            error: `symbol_not_in_proposals: ${decision.symbol} ${decision.direction} non trouvé dans scanner_proposals pending non-expirées (arbitration ON — l'agent décide UNIQUEMENT sur sortie scanner post-gates)`,
          };
        }
      }

      // COMMIT 3 (29/05) — Zone horaire toxique US opening 13:00-15:30 UTC.
      // Audit TRADER 2 jours : 46% des trades dans cette fenêtre, WR 37%, capture
      // rate -56.5%. Data 3 semaines confirme : us_equity_large 14h UTC = WR 25%,
      // Σ -$174. Désactivable via TRADER_US_OPENING_BLOCK_ENABLED=false.
      const blockUsOpening = (this.config.get<string>('TRADER_US_OPENING_BLOCK_ENABLED') ?? 'true').toLowerCase() === 'true';
      if (blockUsOpening) {
        const now = new Date();
        const hourUtc = now.getUTCHours();
        const minUtc = now.getUTCMinutes();
        const totalMin = hourUtc * 60 + minUtc;
        // 13:00-15:30 UTC = 780-930 minutes
        if (totalMin >= 780 && totalMin < 930) {
          return {
            applied: false,
            error: `TRADER_US_OPENING_BLOCK actif (${String(hourUtc).padStart(2, '0')}:${String(minUtc).padStart(2, '0')} UTC ∈ [13:00, 15:30] — zone toxique audit 2j WR 25-37%)`,
          };
        }
      }
      // Anti-revenge ticker cooldown (renforcé post-MFE/MAE 27/05).
      // Règle 1 : pas plus de 2 ouvertures dans les 4h sur le même ticker.
      // Règle 2 : si la DERNIÈRE position fermée sur ce ticker (≤ 2h) est un
      // loser (realized_pnl_usd < 0), bloque pour éviter de re-rentrer aussitôt
      // sur le même setup cassé. Cas AMKR.US/AEHR.US 27/05 : 4 entries en 50min,
      // 3 FADE Gemini consécutifs avant qu'on touche un winner par chance.
      {
        const sym = decision.symbol.toUpperCase();
        const since4h = new Date(Date.now() - 4 * 60 * 60_000).toISOString();
        const { count } = await this.supabase.getClient()
          .from('lisa_positions')
          .select('id', { count: 'exact', head: true })
          .eq('portfolio_id', TRADER_AGENT_PORTFOLIO_ID)
          .eq('symbol', sym)
          .gte('entry_timestamp', since4h);
        if ((count ?? 0) >= 2) {
          return { applied: false, error: `anti-revenge: ${sym} déjà ouvert ${count}× en 4h` };
        }
        // Cooldown loser : 2h depuis le dernier close en perte sur le même ticker.
        const since2h = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
        const { data: lastLoser } = await this.supabase.getClient()
          .from('lisa_positions')
          .select('exit_timestamp, realized_pnl_usd')
          .eq('portfolio_id', TRADER_AGENT_PORTFOLIO_ID)
          .eq('symbol', sym)
          .neq('status', 'open')
          .gte('exit_timestamp', since2h)
          .order('exit_timestamp', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (lastLoser && Number(lastLoser.realized_pnl_usd ?? 0) < 0) {
          return { applied: false, error: `anti-revenge: ${sym} dernier close ${lastLoser.exit_timestamp} en perte (${Number(lastLoser.realized_pnl_usd).toFixed(2)}$) — cooldown 2h actif` };
        }
      }
      // LISA refonte A.4 — Cap dynamique 45% du capital actuel (composé).
      const dynamicCap = Math.round((await this.fetchCurrentCapital()) * 0.45);
      const notional = Math.max(MIN_NOTIONAL_USD, Math.min(dynamicCap, decision.notional_usd));
      // XETRA notional gate (28/05/2026, recalibré 02/06/2026 logs cycle 10:26-10:28).
      //
      // Origine : 2 incidents SNG.XETRA -$35 + QH9.XETRA -$132 sur small-caps
      // peu liquides. Gate initial $3000 min anti-gap.
      //
      // Bug observé 02/06 : MSF.XETRA (Münchener Rück, mid-cap €60B) bloqué
      // 2 cycles d'affilée avec notional=$1300 (= Kelly cap HORS_TRAJ sizing×0.7).
      // Le LLM décide open conf=0.80 mais apply rejected → trade perdu.
      //
      // Fix : bypass le gate pour les mid/large caps XETRA (marketCap >= $5B).
      // Le gap-and-fade qui motivait le gate n'affecte que les small-caps peu
      // liquides. Mid/large caps comme MSF (Munich Re), SAP, SIEMENS, ALV, BMW
      // ont un orderbook suffisant pour absorber un notional $1000-3000.
      // Le min absolu reste $1000 pour éviter dust trades.
      if (decision.symbol.endsWith('.XETRA')) {
        const sym = decision.symbol.toUpperCase();
        const candidate = candidates.find((c) => String(c.symbol ?? '').toUpperCase() === sym);
        const mcap = Number(candidate?.marketCap ?? 0);
        const isMidLargeCap = mcap >= 5_000_000_000; // $5B
        const minNotional = isMidLargeCap ? 1000 : 3000;
        if (notional < minNotional) {
          return {
            applied: false,
            error: `XETRA notional gate (mcap=${(mcap / 1e9).toFixed(1)}B, ${isMidLargeCap ? 'mid/large' : 'small'}-cap min=$${minNotional})`,
          };
        }
      }

      // ASIA OPENING SUFFIX BAN (28/05/2026 soirée, MFE/MAE 3w n=250 asia_equity).
      // .T/.HK/.SHG/.SHE/.SI 00-02h UTC : n=16 WR 12% Σ -$527 / .KQ 00-02h : n=32 WR 31% Σ -$407.
      // .SS/.SZ inclus aussi (convention Yahoo Finance) ; EODHD utilise .SHG/.SHE
      // Cas TRADER vérifié 28/05 : 166480.KQ 0/2 wins -$17. KOSDAQ 02-08h reste OK.
      {
        const sym = decision.symbol.toUpperCase();
        const nowHourUtc = new Date().getUTCHours();
        const bannedSuffix = sym.endsWith('.T')
          || sym.endsWith('.HK')
          || sym.endsWith('.SHG')
          || sym.endsWith('.SHE')
          || sym.endsWith('.SS')
          || sym.endsWith('.SZ')
          || sym.endsWith('.SI')
          || sym.endsWith('.KQ');
        if (nowHourUtc < 2 && bannedSuffix) {
          return {
            applied: false,
            error: `ASIA_OPENING_SUFFIX_BAN : ${sym} (heure UTC ${nowHourUtc} < 02:00, lesson MFE/MAE 3w n=48 Σ -$934 sur opening auctions)`,
          };
        }
      }

      // Autonomie cadrée : bornes resserrées post-MFE/MAE 27/05 (MAE/R 1.78,
      // capture rate -45.8% sur 7 trades). SL min 1.5% obligatoire (sinon
      // stop-out garanti avant retracement). TP max 8% (au-delà = capture rate
      // s'effondre). Default 2%/4% au lieu de 1%/6%.
      const slPct = Math.max(1.5, Math.min(3, decision.stop_loss_pct ?? 1.5)); // default 1.5 (data-optimal TP+3/SL-1.5 TP sweep 03/06)
      const tpPct = Math.max(2.5, Math.min(8.0, decision.take_profit_pct ?? 3.0)); // default 3.0 (data-optimal: exp +0.855%/trade vs +0.61% a TP2.5)

      // Overpump gate : refuse l'open si le candidat a pumpé > threshold sur la 1m.
      //
      // RECALIBRATION URGENTE 29/05/2026 03:50 UTC (5% → 15%) :
      // Data nuit 29/05 : TRADER bloqué 8× consécutifs (393890.KQ, 416180.KQ tous
      // à 12-14% changePct) — pendant que MIDDLE entrait sur les MÊMES tickers
      // sans gate et faisait +$53 net (3 wins KOSDAQ).
      //
      // Data 3 semaines : le bucket 8-15% est le WINNING bucket (WR 21-27%,
      // Σ +$11 sur 363 trades). À 5%, TRADER bloquait l'intégralité du bucket
      // gagnant. À 15%, on garde le ban du dead-zone 15-20% (perdant -$111) et
      // on autorise le bucket gagnant 8-15%.
      //
      // Configurable via TRADER_OVERPUMP_THRESHOLD_PCT (default 15).
      {
        const sym = decision.symbol.toUpperCase();
        const candidate = candidates.find((c) => String(c.symbol ?? '').toUpperCase() === sym);
        if (candidate) {
          const changePct = Number(candidate.changePct ?? 0);
          const threshold = Number(this.config.get<string>('TRADER_OVERPUMP_THRESHOLD_PCT') ?? '15');
          if (Number.isFinite(changePct) && Number.isFinite(threshold) && threshold > 0 && changePct > threshold) {
            return { applied: false, error: `overpump_gate: ${sym} changePct=${changePct.toFixed(2)}% > ${threshold}% (entry au peak refusée, attendre pullback)` };
          }
        }
      }

      // Live price + sanity check
      const livePriceData = await this.lisa.getLivePrice(decision.symbol).catch(() => null);
      if (!livePriceData?.price) return { applied: false, error: 'no live price' };
      const livePrice = Number(livePriceData.price);
      if (!Number.isFinite(livePrice) || livePrice <= 0) return { applied: false, error: 'invalid live price' };
      if (livePriceData.source && (String(livePriceData.source).startsWith('stale_') || String(livePriceData.source).startsWith('fallback'))) {
        return { applied: false, error: `price source unreliable: ${livePriceData.source}` };
      }

      const sign = decision.direction === 'short' ? -1 : 1;
      const stopLossPrice = (livePrice * (1 - sign * slPct / 100)).toFixed(6);
      const takeProfitPrice = (livePrice * (1 + sign * tpPct / 100)).toFixed(6);

      // Open via LisaService (qui wrappe paperBroker)
      try {
        const opened = await this.lisa.openForOpportunityScout({
          portfolioId: TRADER_AGENT_PORTFOLIO_ID,
          symbol: decision.symbol,
          assetClass: 'unknown',
          venue: 'paper',
          notionalUsd: notional,
          livePrice,
          stopLossPrice,
          takeProfitPrice,
          horizonDays: Math.ceil((decision.horizon_minutes ?? 60) / (60 * 24)),
          maxOpenPositions: 5,
          rationale: `[trader-agent] ${decision.thesis}`,
        });
        if (!opened) return { applied: false, error: 'openForOpportunityScout returned null (stale/fallback price ou skipped)' };
        // B.1 — boucle proposal : si TRADER_ARBITRATION_ENABLED et qu'un
        // scanner_proposals pending correspond au (symbol, direction), le
        // marquer 'accepted' + applied_position_id pour audit.
        await this.markProposalAccepted(decision.symbol, decision.direction, opened.id, decision.thesis)
          .catch((e) => this.logger.debug(`[trader-agent] markProposalAccepted skip: ${String(e).slice(0, 120)}`));
        return { applied: true, positionId: opened.id };
      } catch (e) {
        return { applied: false, error: String(e).slice(0, 200) };
      }
    }

    if (decision.action_kind === 'close') {
      // Gemini fournit un symbol → on résout vers le positionId via state.openPositions.
      if (!decision.symbol) return { applied: false, error: 'close requires symbol' };
      const sym = decision.symbol.toUpperCase();
      const match = state.openPositions.find((p) => p.symbol.toUpperCase() === sym);
      if (!match) {
        return { applied: false, error: `close: no open position for ${sym} on trader agent portfolio` };
      }
      // Need the position id (not exposed in state) — re-query.
      const { data: row } = await this.supabase.getClient()
        .from('lisa_positions')
        .select('id')
        .eq('portfolio_id', TRADER_AGENT_PORTFOLIO_ID)
        .eq('symbol', match.symbol)
        .eq('status', 'open')
        .order('entry_timestamp', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!row?.id) return { applied: false, error: `close: position row not found for ${sym}` };

      const livePriceData = await this.lisa.getLivePrice(decision.symbol).catch(() => null);
      if (!livePriceData?.price) return { applied: false, error: 'close: no live price' };
      const livePrice = Number(livePriceData.price);
      if (!Number.isFinite(livePrice) || livePrice <= 0) return { applied: false, error: 'close: invalid live price' };

      // COMMIT 4 (29/05) — Refuse "close" si position en perte. Audit TRADER :
      // 5 gemini_manual closes + 12 closed_invalidated, plupart en perte → capture
      // rate -56.5%. Gemini ferme au pire moment. Pour PnL<0, force trail_stop ou
      // hold (le SL existant + pre-flight max-loss-cap -$50 gèrent l'urgence).
      // Désactivable via TRADER_DISABLE_LOSS_CLOSE=false. Skip si fallback price.
      const disableLossClose = (this.config.get<string>('TRADER_DISABLE_LOSS_CLOSE') ?? 'true').toLowerCase() === 'true';
      if (disableLossClose && livePriceData.source && !String(livePriceData.source).startsWith('fallback')) {
        const entryPrice = Number(match.entry_price);
        const direction = match.direction;
        const unrealPct = direction === 'short'
          ? ((entryPrice - livePrice) / entryPrice) * 100
          : ((livePrice - entryPrice) / entryPrice) * 100;
        if (Number.isFinite(unrealPct) && unrealPct < -0.1) {
          return {
            applied: false,
            error: `close blocked : ${decision.symbol} unrealPct=${unrealPct.toFixed(2)}% < -0.1% (audit TRADER: capture rate -56.5% → closes prématurés interdits en perte, utilise trail_stop ou hold)`,
          };
        }
      }

      const res = await this.lisa.closeForOpportunityScout({
        positionId: row.id,
        symbol: decision.symbol,
        livePrice,
        ...(livePriceData.source ? { livePriceSource: String(livePriceData.source) } : {}),
        reason: 'closed_user',
        rationale: `[trader-agent] ${decision.thesis ?? 'gemini close decision'}`,
      });
      if (res.closed) return { applied: true, positionId: row.id };
      return { applied: false, ...(res.error !== undefined ? { error: res.error } : {}) };
    }

    if (decision.action_kind === 'scale_in') {
      // Scale-in = nouvelle ligne open_directional sur un symbol DÉJÀ détenu,
      // notional capé à +50% du sizing standard (cf. system prompt). Le paper-broker
      // tracke 2 lignes distinctes — comportement attendu.
      if (!decision.symbol || !decision.direction || !decision.notional_usd) {
        return { applied: false, error: 'scale_in: missing symbol/direction/notional' };
      }
      const sym = decision.symbol.toUpperCase();
      const hasOpen = state.openPositions.some((p) => p.symbol.toUpperCase() === sym);
      if (!hasOpen) {
        return { applied: false, error: `scale_in: no existing position on ${sym} (use open_directional)` };
      }
      if (state.openCount >= 5) return { applied: false, error: 'scale_in: max 5 open positions' };
      // LISA refonte A.4 — Cap scale_in dynamique 45% × 1.5 = 67.5% du capital actuel.
      const dynamicCapScaleIn = Math.round((await this.fetchCurrentCapital()) * 0.45 * 1.5);
      const notional = Math.max(MIN_NOTIONAL_USD, Math.min(dynamicCapScaleIn, decision.notional_usd));
      // Autonomie cadrée : bornes resserrées post-MFE/MAE 27/05 (MAE/R 1.78,
      // capture rate -45.8% sur 7 trades). SL min 1.5% obligatoire (sinon
      // stop-out garanti avant retracement). TP max 8% (au-delà = capture rate
      // s'effondre). Default 2%/4% au lieu de 1%/6%.
      const slPct = Math.max(1.5, Math.min(3, decision.stop_loss_pct ?? 1.5)); // default 1.5 (data-optimal TP+3/SL-1.5 TP sweep 03/06)
      const tpPct = Math.max(2.5, Math.min(8.0, decision.take_profit_pct ?? 3.0)); // default 3.0 (data-optimal: exp +0.855%/trade vs +0.61% a TP2.5)

      const livePriceData = await this.lisa.getLivePrice(decision.symbol).catch(() => null);
      if (!livePriceData?.price) return { applied: false, error: 'scale_in: no live price' };
      const livePrice = Number(livePriceData.price);
      if (!Number.isFinite(livePrice) || livePrice <= 0) return { applied: false, error: 'scale_in: invalid live price' };
      if (livePriceData.source && (String(livePriceData.source).startsWith('stale_') || String(livePriceData.source).startsWith('fallback'))) {
        return { applied: false, error: `scale_in: price source unreliable: ${livePriceData.source}` };
      }

      const sign = decision.direction === 'short' ? -1 : 1;
      const stopLossPrice = (livePrice * (1 - sign * slPct / 100)).toFixed(6);
      const takeProfitPrice = (livePrice * (1 + sign * tpPct / 100)).toFixed(6);

      try {
        const opened = await this.lisa.openForOpportunityScout({
          portfolioId: TRADER_AGENT_PORTFOLIO_ID,
          symbol: decision.symbol,
          assetClass: 'unknown',
          venue: 'paper',
          notionalUsd: notional,
          livePrice,
          stopLossPrice,
          takeProfitPrice,
          horizonDays: Math.ceil((decision.horizon_minutes ?? 60) / (60 * 24)),
          maxOpenPositions: 5,
          rationale: `[trader-agent SCALE_IN] ${decision.thesis}`,
        });
        if (!opened) return { applied: false, error: 'scale_in: open returned null' };
        await this.markProposalAccepted(decision.symbol, decision.direction, opened.id, decision.thesis)
          .catch((e) => this.logger.debug(`[trader-agent] markProposalAccepted (scale_in) skip: ${String(e).slice(0, 120)}`));
        return { applied: true, positionId: opened.id };
      } catch (e) {
        return { applied: false, error: String(e).slice(0, 200) };
      }
    }

    if (decision.action_kind === 'trail_stop') {
      // Trail stop = UPDATE stop_loss_price d'une position ouverte.
      // Gemini fournit symbol + nouveau stop_loss_pct (% sous entry pour long).
      // Garde-fou : le nouveau stop ne peut JAMAIS être plus permissif que l'ancien
      // (sinon ce n'est pas un trail mais un loosening — refusé).
      if (!decision.symbol) return { applied: false, error: 'trail_stop: requires symbol' };
      const sym = decision.symbol.toUpperCase();
      const match = state.openPositions.find((p) => p.symbol.toUpperCase() === sym);
      if (!match) return { applied: false, error: `trail_stop: no open position for ${sym}` };

      const { data: row } = await this.supabase.getClient()
        .from('lisa_positions')
        .select('id, stop_loss_price, entry_price, direction')
        .eq('portfolio_id', TRADER_AGENT_PORTFOLIO_ID)
        .eq('symbol', match.symbol)
        .eq('status', 'open')
        .order('entry_timestamp', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!row?.id) return { applied: false, error: `trail_stop: position row not found for ${sym}` };

      const livePriceData = await this.lisa.getLivePrice(decision.symbol).catch(() => null);
      if (!livePriceData?.price) return { applied: false, error: 'trail_stop: no live price' };
      const livePrice = Number(livePriceData.price);
      if (!Number.isFinite(livePrice) || livePrice <= 0) return { applied: false, error: 'trail_stop: invalid live price' };

      // trail_stop = resserrer un SL existant.
      // 31/05/2026 — Constat BNB TRADER 09:50 UTC : Gemini Pro a trail_stop avec
      // slPct=0.15% → SL touché en 56min sur micro-pull, capture rate -481% sur
      // un MFE de seulement +0.05%. Le seuil min 0.1% était trop laxiste pour
      // crypto (volatilité naturelle 0.2-0.5% en 1m).
      //
      // Fix : bornes min per-asset-class. Gemini Pro peut toujours décider de
      // resserrer mais pas en deçà du bruit naturel de la classe :
      //   - crypto : min 0.5% (volatilité 0.2-0.5%/min normale)
      //   - equity : min 0.3% (volatilité 0.1-0.3%/min normale)
      const isCryptoSym = /^[A-Z0-9]+(USDT|USDC|BUSD)$/.test(match.symbol.toUpperCase());
      const minSlPct = isCryptoSym ? 0.5 : 0.3;
      const requestedSlPct = decision.stop_loss_pct ?? 1.0;
      const slPct = Math.max(minSlPct, Math.min(5, requestedSlPct));
      if (requestedSlPct < minSlPct) {
        this.logger.warn(
          `[trader-agent] trail_stop ${match.symbol} : Pro requested slPct=${requestedSlPct}% < min ${minSlPct}% (class=${isCryptoSym ? 'crypto' : 'equity'}) → clamped`,
        );
      }
      const isLong = String(row.direction) !== 'short';
      const sign = isLong ? -1 : 1;
      // Nouveau stop calculé depuis livePrice (trail = suit le marché)
      const newStop = livePrice * (1 + sign * slPct / 100);
      const oldStop = Number(row.stop_loss_price);

      // Garde-fou : le nouveau stop doit être PLUS strict
      // - long : newStop > oldStop (on remonte le stop)
      // - short : newStop < oldStop (on descend le stop)
      const stricter = isLong ? newStop > oldStop : newStop < oldStop;
      if (!stricter) {
        return { applied: false, error: `trail_stop: new stop ${newStop.toFixed(4)} not stricter than current ${oldStop.toFixed(4)} (${isLong ? 'long' : 'short'})` };
      }

      const { error } = await this.supabase.getClient()
        .from('lisa_positions')
        .update({ stop_loss_price: newStop.toFixed(6) })
        .eq('id', row.id);
      if (error) return { applied: false, error: `trail_stop: db update failed: ${error.message}` };
      return { applied: true, positionId: row.id };
    }

    if (decision.action_kind === 'open_pairs') {
      // Pair trade = 2 positions simultanées (long A + short B), market neutral.
      // Hors-scope MVP : nécessite logique d'apariement + sizing partagé. À câbler
      // dans un PR dédié quand le besoin se manifeste sur les décisions Gemini.
      return { applied: false, error: 'open_pairs: not yet wired (rare action, follow-up PR)' };
    }

    return { applied: false, error: `unknown action: ${decision.action_kind}` };
  }

  private async logDecision(p: {
    cycleStartedAt: Date;
    state: object;
    decision?: TraderDecision;
    candidates?: object[];
    macro?: object;
    news?: object[];
    memory?: object[];
    rawResponse?: string;
    provider?: string;
    latencyMs?: number;
    costUsd?: number;
    action: string;
    actionKindOverride?: string;
    notionalUsd: number;
    confidence: number;
    thesis: string;
    applied: boolean;
    appliedPositionId?: string;
    applyError?: string;
  }): Promise<void> {
    await this.supabase.getClient().from('trader_agent_decisions').insert({
      portfolio_id: TRADER_AGENT_PORTFOLIO_ID,
      cycle_started_at: p.cycleStartedAt.toISOString(),
      input_state: p.state,
      input_candidates: p.candidates ?? null,
      input_macro: p.macro ?? null,
      input_news_summary: p.news ?? null,
      input_memory_lessons: p.memory ?? null,
      gemini_raw_response: p.rawResponse ?? null,
      gemini_parsed: p.decision ?? null,
      gemini_provider: p.provider ?? null,
      gemini_latency_ms: p.latencyMs ?? null,
      gemini_cost_usd: p.costUsd ?? null,
      action_kind: p.actionKindOverride ?? p.action,
      target_symbol: p.decision?.symbol ?? null,
      direction: p.decision?.direction ?? null,
      notional_usd: p.notionalUsd,
      confidence: p.confidence,
      thesis: p.thesis,
      action_applied: p.applied,
      applied_position_id: p.appliedPositionId ?? null,
      apply_error: p.applyError ?? null,
    });
  }

  // ====================================================================
  // LISA refonte B.1 — Lesson markers parsing + citations tracking
  // ====================================================================
  //
  // Le LLM TRADER reçoit dans son system prompt les lessons actives au format
  //   "lesson_kind: PULLBACK_WAIT_KTOS_LESSON · lesson_text: ..."
  // et est encouragé à citer le marker en majuscules entre crochets dans sa
  // thèse — ex: "Setup post-pump, attente confirmé [PULLBACK_WAIT_KTOS_LESSON]".
  //
  // À chaque décision, on parse la thèse, extrait les markers, résout chaque
  // marker vers un lesson_id (par lesson_kind ILIKE) et insère une ligne dans
  // scanner_lesson_citations. L'outcome (pnl, win) est résolu plus tard quand
  // la position se ferme — backfill au début de chaque cycle.
  //
  // Cible UI Phase B.2 : "Quelle lesson a été citée combien de fois, avec
  // quel win-rate, sur 30j ?"

  /**
   * Markers techniques / section headers / labels du prompt — PAS des lessons.
   * Cités fréquemment par Mistral en écho au system prompt, ils polluent
   * scanner_lesson_citations s'ils ne sont pas filtrés (cf. audit 01/06 :
   * 287 citations / 0 résolues, dont [OPEN_POSITIONS]=1, [KELLY_STANDARD]=1,
   * [AUTO_CORRECTION_DYNAMIQUE]=1, [DATA_QUALITY_DEGRADED]=2, etc.).
   */
  private static readonly INFRA_MARKERS = new Set<string>([
    // Markers infra bas-niveau
    'DIAGNOSTIC', 'SANITY_BOUND', 'KILL_SWITCH', 'HT_BYPASS', 'HT_EXCEPTION',
    // Section headers / labels du prompt
    'OPEN_POSITIONS', 'POSITIONS_OUVERTES', 'DATA_QUALITY_DEGRADED',
    'KELLY_STANDARD', 'PUMP_SCORE', 'AUTO_CORRECTION_DYNAMIQUE',
    'MODE_DEFENSIF', 'MODE_DÉFENSIF',
    // Catégories rhétoriques génériques (pas des lessons identifiées)
    'ANTI-PATTERN', 'ANTI-REVENGE',
    // 01/06 — markers liés au wiring objectives_progress (system prompt
    // pas des lessons en DB) — évite "skipped unregistered markers" pollution.
    'OBJ_AGGRESSIVE', 'OBJ_DEFENSIVE_NO_OPEN', 'OBJ_NORMAL', 'OBJ_EN_AVANCE',
    'OBJ_CAUTIOUS_TRY', 'OBJ_CAUTIOUS_NO_VALID', 'OBJ_LATE_NO_OPEN',
    'OVERRIDE_SUGGESTED_POSTURE', 'EOS_WAIT', 'END_OF_SESSION_WAIT',
    // 03/06/2026 — règle C-bis pump exhaustion detection (post-mortem RPI.LSE #1)
    'PUMP_EXHAUSTED',
  ]);

  /**
   * Extrait les markers [XXX] d'une thèse LLM. Dédupliqué.
   * Pattern : crochets, début majuscule, 3-40 chars [A-Z0-9_+-].
   * Filtre les markers infra/headers (cf. INFRA_MARKERS).
   */
  private parseLessonMarkers(thesis: string): string[] {
    if (!thesis || thesis.length === 0) return [];
    const re = /\[([A-Z][A-Z0-9_+\-]{2,40})\]/g;
    const set = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = re.exec(thesis)) !== null) {
      const marker = m[1];
      if (LiveTraderAgentService.INFRA_MARKERS.has(marker)) continue;
      set.add(marker);
    }
    return [...set];
  }

  /**
   * Pour chaque marker, tente de matcher un lesson_id via lesson_kind ILIKE.
   * Insère une ligne scanner_lesson_citations par marker (avec lesson_id=null
   * si pas de match — utile pour audit "markers cités jamais mappés").
   */
  private async insertLessonCitations(args: {
    thesis: string;
    cycleStartedAt: Date;
    actionKind: string;
    actionApplied: boolean;
    targetSymbol: string | null;
    confidence: number | null;
    positionId: string | null;
  }): Promise<void> {
    const markers = this.parseLessonMarkers(args.thesis);
    if (markers.length === 0) return;

    const client = this.supabase.getClient();

    // ─────────────────────────────────────────────────────────────────
    // FIX 01/06 — Citations sans position_id étaient orphelines : le
    // resolveCitationOutcomes les filtrait via .not('position_id','is',null)
    // → 108 citations / 0 résolues en prod.
    //
    // Stratégie d'enrichissement position_id avant INSERT :
    //   (a) Si decision.applied_position_id existe (open accepté) → utilise
    //   (b) Sinon si action_kind hold/close/trail_stop/scale_in + target_symbol
    //       → chercher la position ouverte de ce symbol (cas dominant : LLM
    //         commente une position ouverte qu'il décide de hold/trail)
    //   (c) Sinon si thesis mentionne explicitement un symbol parmi les
    //       positions ouvertes → linker la 1ère trouvée (best-effort)
    //   (d) Sinon position_id reste null → citation non-résoluble (cas
    //       "hold du cycle entier sans cibler une position spécifique")
    // ─────────────────────────────────────────────────────────────────
    let enrichedPositionId: string | null = args.positionId;
    if (enrichedPositionId === null
        && ['hold', 'close', 'trail_stop', 'scale_in', 'open_directional'].includes(args.actionKind)) {
      // (b) target_symbol → position ouverte
      if (args.targetSymbol) {
        const { data: openByTarget } = await client
          .from('lisa_positions')
          .select('id')
          .eq('portfolio_id', TRADER_AGENT_PORTFOLIO_ID)
          .eq('symbol', args.targetSymbol)
          .eq('status', 'open')
          .order('entry_timestamp', { ascending: false })
          .limit(1);
        if (openByTarget && openByTarget.length > 0) {
          enrichedPositionId = (openByTarget[0] as { id: string }).id;
        }
      }
      // (c) thesis mentionne un symbol parmi positions ouvertes
      if (enrichedPositionId === null) {
        const { data: openPos } = await client
          .from('lisa_positions')
          .select('id, symbol')
          .eq('portfolio_id', TRADER_AGENT_PORTFOLIO_ID)
          .eq('status', 'open');
        for (const p of (openPos ?? []) as Array<{ id: string; symbol: string }>) {
          if (args.thesis.includes(p.symbol)) {
            enrichedPositionId = p.id;
            break;
          }
        }
      }
    }
    // Résolution lesson_id par marker — match contre macro_condition + fallback
    // sur lesson_text/lesson_kind (defense-in-depth).
    //
    // FIX 01/06 post-PR #549 : la première version matchait `lesson_kind` qui
    // est la CATÉGORIE ('exit_rule', 'risk_observation', 'gate_calibration'),
    // pas le marker. Le vrai marker citable est dans `macro_condition`
    // ('KOSDAQ_SMALL_TP_CALIBRATION', 'TRADER_CAPTURE_NEGATIVE_VS_SHADOWS').
    //
    // Cascade :
    //   1. exact case-insensitive sur macro_condition (cas dominant)
    //   2. fallback : marker contenu dans lesson_text (couvre lessons sans
    //      macro_condition setté qui mentionnent le marker dans le texte)
    //   3. si rien : skip + log debug
    const rows: Array<Record<string, unknown>> = [];
    const skipped: string[] = [];
    for (const marker of markers) {
      let lessonId: string | null = null;
      // 1. macro_condition exact (le bon match)
      const { data: l1 } = await client
        .from('scanner_lessons')
        .select('id')
        .ilike('macro_condition', marker)
        .eq('is_active', true)
        .order('confidence', { ascending: false })
        .limit(1)
        .maybeSingle();
      lessonId = (l1 as { id?: string } | null)?.id ?? null;
      // 2. fallback lesson_text contains marker
      if (!lessonId) {
        const { data: l2 } = await client
          .from('scanner_lessons')
          .select('id')
          .ilike('lesson_text', `%${marker}%`)
          .eq('is_active', true)
          .order('confidence', { ascending: false })
          .limit(1)
          .maybeSingle();
        lessonId = (l2 as { id?: string } | null)?.id ?? null;
      }
      if (!lessonId) {
        skipped.push(marker);
        continue;
      }
      rows.push({
        lesson_id: lessonId,
        marker_text: `[${marker}]`,
        portfolio_id: TRADER_AGENT_PORTFOLIO_ID,
        decision_decided_at: args.cycleStartedAt.toISOString(),
        action_kind: args.actionKind,
        action_applied: args.actionApplied,
        lesson_intent: this.deriveLessonIntent(args.actionKind),
        target_symbol: args.targetSymbol,
        confidence: args.confidence,
        position_id: enrichedPositionId,
        thesis_excerpt: args.thesis.slice(0, 300),
      });
    }
    if (skipped.length > 0) {
      this.logger.debug(
        `[trader-agent] skipped ${skipped.length} unregistered markers: ${skipped.join(',')}`,
      );
    }
    if (rows.length === 0) return;
    const { error } = await client.from('scanner_lesson_citations').insert(rows);
    if (error) {
      this.logger.warn(`[trader-agent] insertLessonCitations failed: ${error.message}`);
    } else {
      this.logger.debug(
        `[trader-agent] inserted ${rows.length} citations (mapped: ${rows.length}/${markers.length})`,
      );
    }
  }

  /**
   * Dérive l'intent qualitatif d'une lesson depuis l'action_kind du cycle.
   * Permet à StrategyCoachService de compter une citation hold/skip comme
   * application correcte (la lesson a guidé la décision conformément).
   * Cf. issue #502.
   */
  private deriveLessonIntent(actionKind: string): 'open' | 'hold' | 'skip' | 'exit' | 'other' {
    if (actionKind === 'open_directional' || actionKind === 'open_pairs' || actionKind === 'scale_in') return 'open';
    if (actionKind === 'hold') return 'hold';
    if (actionKind.startsWith('skip')) return 'skip';
    if (actionKind === 'close' || actionKind === 'trail_stop') return 'exit';
    return 'other';
  }

  /**
   * PR4 (31/05/2026) — A/B shadow Pro vs Flash.
   * Lance un appel Gemini Flash en parallèle avec le même prompt que Pro,
   * logge les 2 décisions dans gemini_ab_decisions pour analyse comparative.
   *
   * Best-effort : tous les errors sont catchés (n'altère JAMAIS le cycle TRADER).
   * Coût estimé : ~$0.05/cycle × 288 cycles/j = ~$14/j (acceptable pour 7-14j de
   * data collection avant décision data-driven Pro→Flash).
   */
  private async recordAbShadow(args: {
    cycleStartedAt: Date;
    portfolioId: string;
    systemPrompt: string;
    userPrompt: string;
    candidatesCount: number;
    proDecision: TraderDecision;
    proResponse: { content: string; providerId: string; costUsd: number; latencyMs: number };
  }): Promise<void> {
    if (!this.supabase.isReady()) return;

    // 1. Lance Flash + Mistral en parallèle (best-effort, n'altèrent jamais le cycle).
    const flashPromise = this.llmRouter
      .call({
        system: args.systemPrompt,
        user: args.userPrompt,
        temperature: 0.3,
        maxTokens: 1500,
        timeoutMs: 30_000,
      })
      .then(r => ({ ok: true as const, ...r }))
      .catch(e => ({ ok: false as const, error: String(e).slice(0, 200) }));

    // 31/05/2026 — Mistral shadow 3-way (best-effort, désactivé tant que
    // MISTRAL_SHADOW_ENABLED=false ou MISTRAL_API_KEY absent).
    const mistralPromise = this.mistralShadow
      ? this.mistralShadow.call({
          system: args.systemPrompt,
          user: args.userPrompt,
          temperature: 0.3,
          maxTokens: 1500,
          timeoutMs: 30_000,
        })
      : Promise.resolve(null);

    // 31/05/2026 PR #521 — 4e shadow Mistral Large 3 (cheap tier).
    // Comparaison directe cheap tiers Flash (Google) vs Large 3 (Mistral).
    const mistralLargePromise = this.mistralLargeShadow
      ? this.mistralLargeShadow.call({
          system: args.systemPrompt,
          user: args.userPrompt,
          temperature: 0.3,
          maxTokens: 1500,
          timeoutMs: 30_000,
        })
      : Promise.resolve(null);

    const [flashSettled, mistralSettled, mistralLargeSettled] = await Promise.all([
      flashPromise,
      mistralPromise,
      mistralLargePromise,
    ]);

    // 2. Parse Flash
    let flashContent: string | null = null;
    let flashProvider: string | null = null;
    let flashCostUsd = 0;
    let flashLatencyMs = 0;
    let flashCallError: string | null = null;
    let flashDecision: Partial<TraderDecision> | null = null;
    if (flashSettled.ok) {
      flashContent = flashSettled.content;
      flashProvider = flashSettled.providerId;
      flashCostUsd = flashSettled.costUsd;
      flashLatencyMs = flashSettled.latencyMs;
      try {
        const cleaned = flashContent.trim().replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
        flashDecision = JSON.parse(cleaned);
      } catch (e) {
        flashCallError = `parse_fail: ${String(e).slice(0, 100)}`;
      }
    } else {
      flashCallError = flashSettled.error;
    }

    // 2b. Parse Mistral Medium (3-way shadow). NULL si service désactivé ou clé absente.
    let mistralProvider: string | null = null;
    let mistralCostUsd = 0;
    let mistralLatencyMs = 0;
    let mistralCallError: string | null = null;
    let mistralDecision: Partial<TraderDecision> | null = null;
    if (mistralSettled) {
      mistralProvider = mistralSettled.providerId;
      mistralCostUsd = mistralSettled.costUsd;
      mistralLatencyMs = mistralSettled.latencyMs;
      if (mistralSettled.error) {
        mistralCallError = mistralSettled.error;
      } else if (mistralSettled.content) {
        try {
          const cleaned = mistralSettled.content.trim().replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
          mistralDecision = JSON.parse(cleaned);
        } catch (e) {
          mistralCallError = `parse_fail: ${String(e).slice(0, 100)}`;
        }
      }
    }

    // 2c. Parse Mistral Large 3 (4-way shadow, PR #521). Même logique que Medium.
    let mistralLargeProvider: string | null = null;
    let mistralLargeCostUsd = 0;
    let mistralLargeLatencyMs = 0;
    let mistralLargeCallError: string | null = null;
    let mistralLargeDecision: Partial<TraderDecision> | null = null;
    if (mistralLargeSettled) {
      mistralLargeProvider = mistralLargeSettled.providerId;
      mistralLargeCostUsd = mistralLargeSettled.costUsd;
      mistralLargeLatencyMs = mistralLargeSettled.latencyMs;
      if (mistralLargeSettled.error) {
        mistralLargeCallError = mistralLargeSettled.error;
      } else if (mistralLargeSettled.content) {
        try {
          const cleaned = mistralLargeSettled.content.trim().replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
          mistralLargeDecision = JSON.parse(cleaned);
        } catch (e) {
          mistralLargeCallError = `parse_fail: ${String(e).slice(0, 100)}`;
        }
      }
    }

    // 3. Compute concordance metrics
    // Note : null === null est valide pour hold (symbol absent attendu des 2 côtés).
    // Quand flashDecision est null (parse fail), tous concordance flags sont null.
    // proAction nullified après le helper ci-dessous (defined just below).
    // 31/05/2026 — Helper coerce empty string "" → null. Necessaire car certains
    // providers (Mistral Large 3 observe) retournent target_symbol="" au lieu de
    // null quand action=hold, ce qui fail le check "" === null → 0% concordance
    // artificielle. Apply preventif sur les 4 providers pour eviter futurs cas.
    const nullify = (v: unknown): string | null => {
      if (v === null || v === undefined) return null;
      if (typeof v === 'string' && v.trim() === '') return null;
      return v as string;
    };

    const proAction = nullify(args.proDecision.action_kind);
    const proTarget = nullify(args.proDecision.symbol);
    const proConf = args.proDecision.confidence ?? null;
    const flashAction = nullify(flashDecision?.action_kind);
    const flashTarget = nullify(flashDecision?.symbol);
    const flashConf = flashDecision?.confidence ?? null;
    const flashParsed = flashDecision !== null;
    const concordanceAction = flashParsed ? flashAction === proAction : null;
    const concordanceTarget = flashParsed ? flashTarget === proTarget : null;
    const concordanceFull = concordanceAction === true && concordanceTarget === true;
    const confDelta = proConf !== null && flashConf !== null && typeof flashConf === 'number'
      ? Math.round((proConf - flashConf) * 1000) / 1000
      : null;

    // 3b. Concordance Pro vs Mistral Medium
    const mistralAction = nullify(mistralDecision?.action_kind);
    const mistralTarget = nullify(mistralDecision?.symbol);
    const mistralParsed = mistralDecision !== null;
    const concordanceProMistralAction = mistralParsed ? mistralAction === proAction : null;
    const concordanceProMistralTarget = mistralParsed ? mistralTarget === proTarget : null;
    const concordanceProMistralFull = concordanceProMistralAction === true && concordanceProMistralTarget === true;

    // 3c. Concordance Pro vs Mistral Large 3 (PR #521)
    const mistralLargeAction = nullify(mistralLargeDecision?.action_kind);
    const mistralLargeTarget = nullify(mistralLargeDecision?.symbol);
    const mistralLargeParsed = mistralLargeDecision !== null;
    const concordanceProMistralLargeAction = mistralLargeParsed ? mistralLargeAction === proAction : null;
    const concordanceProMistralLargeTarget = mistralLargeParsed ? mistralLargeTarget === proTarget : null;
    const concordanceProMistralLargeFull = concordanceProMistralLargeAction === true && concordanceProMistralLargeTarget === true;

    // 3. Compute context hash (sha256 trunc) pour valider que Pro et Flash ont vu le même context
    let contextHash: string | null = null;
    try {
      const crypto = await import('node:crypto');
      contextHash = crypto.createHash('sha256').update(args.userPrompt).digest('hex').slice(0, 16);
    } catch { /* noop */ }

    // 4. INSERT
    try {
      await this.supabase.getClient().from('gemini_ab_decisions').insert({
        decided_at: new Date().toISOString(),
        portfolio_id: args.portfolioId,
        cycle_started_at: args.cycleStartedAt.toISOString(),
        pro_action_kind: proAction,
        pro_target_symbol: proTarget,
        pro_direction: args.proDecision.direction ?? null,
        pro_confidence: proConf,
        pro_notional_usd: args.proDecision.notional_usd ?? null,
        pro_thesis: (args.proDecision.thesis ?? '').slice(0, 1000),
        pro_cost_usd: args.proResponse.costUsd,
        pro_latency_ms: args.proResponse.latencyMs,
        pro_provider: args.proResponse.providerId,
        // pro_applied / pro_apply_error : laissés NULL pour l'instant. Si besoin,
        // backfill ultérieur via cron qui matche cycle_started_at avec
        // trader_agent_decisions.cycle_started_at + action_applied.
        flash_action_kind: flashAction,
        flash_target_symbol: flashTarget,
        flash_direction: flashDecision?.direction ?? null,
        flash_confidence: flashConf,
        flash_notional_usd: flashDecision?.notional_usd ?? null,
        flash_thesis: (flashDecision?.thesis ?? '').slice(0, 1000),
        flash_cost_usd: flashCostUsd,
        flash_latency_ms: flashLatencyMs,
        flash_provider: flashProvider,
        flash_call_error: flashCallError,
        concordance_action_kind: concordanceAction,
        concordance_target_symbol: concordanceTarget,
        concordance_full: concordanceFull,
        confidence_delta: confDelta,
        candidates_count: args.candidatesCount,
        context_hash: contextHash,
        // Mistral 3-way shadow columns (31/05/2026)
        mistral_action_kind: mistralAction,
        mistral_target_symbol: mistralTarget,
        mistral_direction: mistralDecision?.direction ?? null,
        mistral_confidence: mistralDecision?.confidence ?? null,
        mistral_notional_usd: mistralDecision?.notional_usd ?? null,
        mistral_thesis: (mistralDecision?.thesis ?? '').slice(0, 1000),
        mistral_cost_usd: mistralCostUsd,
        mistral_latency_ms: mistralLatencyMs,
        mistral_provider: mistralProvider,
        mistral_call_error: mistralCallError,
        concordance_pro_vs_mistral_action: concordanceProMistralAction,
        concordance_pro_vs_mistral_target: concordanceProMistralTarget,
        concordance_pro_vs_mistral_full: concordanceProMistralFull,
        // Mistral Large 3 4-way shadow columns (PR #521 31/05/2026)
        mistral_large_action_kind: mistralLargeAction,
        mistral_large_target_symbol: mistralLargeTarget,
        mistral_large_direction: mistralLargeDecision?.direction ?? null,
        mistral_large_confidence: mistralLargeDecision?.confidence ?? null,
        mistral_large_notional_usd: mistralLargeDecision?.notional_usd ?? null,
        mistral_large_thesis: (mistralLargeDecision?.thesis ?? '').slice(0, 1000),
        mistral_large_cost_usd: mistralLargeCostUsd,
        mistral_large_latency_ms: mistralLargeLatencyMs,
        mistral_large_provider: mistralLargeProvider,
        mistral_large_call_error: mistralLargeCallError,
        concordance_pro_vs_mistral_large_action: concordanceProMistralLargeAction,
        concordance_pro_vs_mistral_large_target: concordanceProMistralLargeTarget,
        concordance_pro_vs_mistral_large_full: concordanceProMistralLargeFull,
      });
      const mistralLog = mistralProvider
        ? ` vs Medium=${mistralAction ?? (mistralCallError ? 'fail' : 'off')}/${mistralTarget ?? '?'} mConc=${concordanceProMistralFull} mCost=$${mistralCostUsd.toFixed(4)}`
        : '';
      const largeLog = mistralLargeProvider
        ? ` vs Large=${mistralLargeAction ?? (mistralLargeCallError ? 'fail' : 'off')}/${mistralLargeTarget ?? '?'} lConc=${concordanceProMistralLargeFull} lCost=$${mistralLargeCostUsd.toFixed(4)}`
        : '';
      this.logger.debug(
        `[trader-agent:ab] Pro=${proAction}/${proTarget ?? '?'} vs Flash=${flashAction ?? 'fail'}/${flashTarget ?? '?'} ` +
        `concordance=${concordanceFull} costDelta=${(args.proResponse.costUsd - flashCostUsd).toFixed(4)}${mistralLog}${largeLog}`,
      );
    } catch (e) {
      this.logger.debug(`[trader-agent:ab] insert failed: ${String(e).slice(0, 100)}`);
    }
  }

  /**
   * Backfill outcomes : pour chaque citation où outcome_resolved_at IS NULL
   * ET position_id IS NOT NULL, lit la position et résout outcome si closed.
   * Idempotent (filtre WHERE outcome_resolved_at IS NULL). Limité 50/cycle
   * pour ne pas saturer.
   */
  /**
   * B.1 — Audit boucle scanner_proposals. Quand TRADER ouvre une position,
   * marque le proposal correspondant comme 'accepted' avec applied_position_id.
   * Permet de mesurer le taux d'acceptance par classe d'actif, par score, etc.
   * Best-effort : ne throw pas (silencieux si pas de proposal pending).
   */
  private async markProposalAccepted(
    symbol: string,
    direction: string,
    positionId: string,
    thesis: string,
  ): Promise<void> {
    const arbitrationEnabled = (this.config.get<string>('TRADER_ARBITRATION_ENABLED') ?? 'false').toLowerCase() === 'true';
    if (!arbitrationEnabled) return;
    const { error, count } = await this.supabase.getClient()
      .from('scanner_proposals')
      .update({
        status: 'accepted',
        reviewed_by_trader_at: new Date().toISOString(),
        trader_decision_reason: thesis.slice(0, 500),
        applied_position_id: positionId,
      }, { count: 'exact' })
      .eq('portfolio_id', TRADER_AGENT_PORTFOLIO_ID)
      .eq('symbol', symbol)
      .eq('direction', direction)
      .eq('status', 'pending')
      .gt('expires_at', new Date().toISOString());
    if (error) {
      this.logger.debug(`[trader-arbitration] markProposalAccepted failed: ${error.message}`);
      return;
    }
    if (count && count > 0) {
      this.logger.log(`[trader-arbitration] ${count} proposal(s) ${symbol} ${direction} → accepted (position ${positionId.slice(0, 8)})`);
    }
  }

  /**
   * B1 (02/06/2026) — Marque les proposals rejetées par le TRADER.
   * Cas 1 : LLM décide open mais apply échoue (live price invalide, cap atteint,
   *         anti-revenge cooldown, XETRA gate, US opening block, etc.)
   * Cas 2 : LLM décide hold ou close — la proposal était visible mais non choisie
   *         (cf. markNonChosenSuperseded pour ce cas, qui utilise status='superseded').
   *
   * Sans ce marquage, la proposal reste pending → LLM la revoit cycle suivant →
   * boucle (observé 02/06 : TEST_TRUE.LSE 4 cycles consécutifs identiques).
   */
  private async markProposalRejected(
    symbol: string,
    direction: string,
    reason: string,
  ): Promise<void> {
    const arbitrationEnabled = (this.config.get<string>('TRADER_ARBITRATION_ENABLED') ?? 'false').toLowerCase() === 'true';
    if (!arbitrationEnabled) return;
    const { error, count } = await this.supabase.getClient()
      .from('scanner_proposals')
      .update({
        status: 'rejected',
        reviewed_by_trader_at: new Date().toISOString(),
        trader_decision_reason: reason.slice(0, 500),
      }, { count: 'exact' })
      .eq('portfolio_id', TRADER_AGENT_PORTFOLIO_ID)
      .eq('symbol', symbol)
      .eq('direction', direction)
      .eq('status', 'pending')
      .gt('expires_at', new Date().toISOString());
    if (error) {
      this.logger.debug(`[trader-arbitration] markProposalRejected failed: ${error.message}`);
      return;
    }
    if (count && count > 0) {
      this.logger.log(`[trader-arbitration] ${count} proposal(s) ${symbol} ${direction} → rejected (${reason.slice(0, 100)})`);
    }
  }

  /**
   * B2 (02/06/2026) — Marque les proposals visibles mais non-choisies par le LLM
   * dans ce cycle comme superseded. Évite que le LLM revoit les mêmes proposals
   * au cycle suivant et change d'avis (instabilité). Scanner re-produit les
   * proposals fraîches au cycle suivant (toutes les 5 min sur TRADER) si les
   * conditions du marché sont toujours réunies.
   *
   * `chosenSymbol` + `chosenDirection` : la proposal effectivement choisie
   * (handled par markProposalAccepted ou markProposalRejected). Sera exclue
   * du marquage superseded.
   */
  private async markNonChosenSuperseded(
    visibleProposals: Array<Record<string, unknown>>,
    chosenSymbol: string | null,
    chosenDirection: string | null,
  ): Promise<void> {
    const arbitrationEnabled = (this.config.get<string>('TRADER_ARBITRATION_ENABLED') ?? 'false').toLowerCase() === 'true';
    if (!arbitrationEnabled || visibleProposals.length === 0) return;

    const otherIds: string[] = [];
    for (const p of visibleProposals) {
      const sym = String(p['symbol'] ?? '');
      const dir = String(p['direction'] ?? '');
      const id = String(p['id'] ?? '');
      if (!id) continue;
      if (chosenSymbol && chosenDirection && sym === chosenSymbol && dir === chosenDirection) continue;
      otherIds.push(id);
    }
    if (otherIds.length === 0) return;

    const reason = chosenSymbol
      ? `not_selected_by_llm_this_cycle (chose ${chosenSymbol} ${chosenDirection ?? '?'})`
      : 'not_selected_by_llm_this_cycle (llm held or non-open action)';

    const { error, count } = await this.supabase.getClient()
      .from('scanner_proposals')
      .update({
        status: 'superseded',
        reviewed_by_trader_at: new Date().toISOString(),
        trader_decision_reason: reason.slice(0, 500),
      }, { count: 'exact' })
      .in('id', otherIds)
      .eq('status', 'pending');
    if (error) {
      this.logger.debug(`[trader-arbitration] markNonChosenSuperseded failed: ${error.message}`);
      return;
    }
    if (count && count > 0) {
      this.logger.log(`[trader-arbitration] ${count} non-chosen proposal(s) → superseded (chose=${chosenSymbol ?? 'none'})`);
    }
  }

  /**
   * B.3 — Cron cleanup proposals expirées. Marque status='expired' les
   * proposals que TRADER n'a pas consommées avant expires_at. Permet d'avoir
   * un audit propre (pas de pending qui restent éternellement) et permet de
   * mesurer le taux d'expiration (= candidats que le TRADER ignore).
   *
   * Enregistré manuellement via registerCron() (pattern existant trader-agent).
   */
  async cleanupExpiredProposals(): Promise<void> {
    if (!this.enabled || !this.supabase.isReady()) return;
    const arbitrationEnabled = (this.config.get<string>('TRADER_ARBITRATION_ENABLED') ?? 'false').toLowerCase() === 'true';
    if (!arbitrationEnabled) return;
    try {
      const { count, error } = await this.supabase.getClient()
        .from('scanner_proposals')
        .update({ status: 'expired' }, { count: 'exact' })
        .eq('status', 'pending')
        .lt('expires_at', new Date().toISOString());
      if (error) {
        this.logger.debug(`[trader-arbitration] cleanup expired failed: ${error.message}`);
        return;
      }
      if (count && count > 0) {
        this.logger.log(`[trader-arbitration] ${count} proposals expirées marquées (cleanup cron)`);
      }
    } catch (e) {
      this.logger.debug(`[trader-arbitration] cleanup expired exception: ${String(e).slice(0, 150)}`);
    }
  }

  private async resolveCitationOutcomes(): Promise<void> {
    const client = this.supabase.getClient();
    const { data: pending } = await client
      .from('scanner_lesson_citations')
      .select('id, position_id')
      .eq('portfolio_id', TRADER_AGENT_PORTFOLIO_ID)
      .is('outcome_resolved_at', null)
      .not('position_id', 'is', null)
      .limit(50);
    if (!pending || pending.length === 0) return;

    const positionIds = [...new Set(
      pending.map((r) => (r as { position_id: string }).position_id).filter(Boolean),
    )];
    const { data: positions } = await client
      .from('lisa_positions')
      .select('id, status, realized_pnl_usd, exit_timestamp')
      .in('id', positionIds)
      .neq('status', 'open');
    if (!positions || positions.length === 0) return;

    const posById = new Map<string, { pnl: number; closedAt: string }>();
    for (const p of positions) {
      const row = p as { id: string; realized_pnl_usd?: unknown; exit_timestamp?: string };
      posById.set(row.id, {
        pnl: Number(row.realized_pnl_usd ?? 0),
        closedAt: row.exit_timestamp ?? new Date().toISOString(),
      });
    }

    let resolved = 0;
    for (const c of pending) {
      const row = c as { id: string; position_id: string };
      const pos = posById.get(row.position_id);
      if (!pos) continue;
      await client
        .from('scanner_lesson_citations')
        .update({
          outcome_resolved_at: pos.closedAt,
          outcome_pnl_usd: pos.pnl,
          outcome_win: pos.pnl > 0,
        })
        .eq('id', row.id);
      resolved++;
    }
    if (resolved > 0) {
      this.logger.log(`[trader-agent] resolved ${resolved} citation outcomes`);
    }
  }

  // ====================================================================
  // PUBLIC API — /admin/trader-agent/status
  // ====================================================================
  async getLatestStatus(): Promise<object> {
    const state = await this.readState();
    const { data: recentDecisions } = await this.supabase.getClient()
      .from('trader_agent_decisions')
      .select('decided_at, action_kind, target_symbol, direction, confidence, thesis, action_applied, apply_error')
      .eq('portfolio_id', TRADER_AGENT_PORTFOLIO_ID)
      .order('decided_at', { ascending: false })
      .limit(10);
    const { data: memory } = await this.supabase.getClient()
      .from('trader_agent_memory')
      .select('lesson_kind, lesson_text, confidence, derived_from_date')
      .eq('portfolio_id', TRADER_AGENT_PORTFOLIO_ID)
      .eq('is_active', true)
      .order('confidence', { ascending: false })
      .limit(20);
    return {
      enabled: this.enabled,
      portfolio_id: TRADER_AGENT_PORTFOLIO_ID,
      capital_usd: TRADER_AGENT_CAPITAL_USD,
      daily_kill_until: this.dailyKillUntil ? new Date(this.dailyKillUntil).toISOString() : null,
      state,
      recent_decisions: recentDecisions ?? [],
      active_memory: memory ?? [],
    };
  }
}
