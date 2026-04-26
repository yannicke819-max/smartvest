import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { SupabaseService } from '../../supabase/supabase.service';
import { LisaService } from './lisa.service';
import { BinanceMarketService } from './binance-market.service';
import { NewsAggregatorService } from './news-aggregator.service';
import { NewsRankerService } from './news-ranker.service';

/**
 * MaterialChangeDetectorService — détecte si un événement matériel s'est
 * produit depuis le dernier cycle Lisa, justifiant un cycle event-driven
 * immédiat plutôt que d'attendre l'intervalle 20 min classique.
 *
 * Métriques surveillées :
 *  - VIX delta vs snapshot
 *  - Prix d'une position tenue qui bouge > 0.5 %
 *  - Funding rate crypto change > 0.3 %/an
 *  - News pertinente fraîche (< 5 min) avec score ≥ 75 sur ticker tenu
 *  - Drawdown portfolio évolue > 0.5 pt
 *
 * Seuils calibrés pour capturer les vrais changements de contexte sans
 * spam. Le rate limiter (3 min entre cycles) côté autopilot empêche les
 * tirs en rafale si VIX vacille.
 *
 * Architecture :
 *  1. Charge snapshot du dernier cycle Lisa (depuis lisa_proposals.detected_inputs)
 *  2. Calcule les inputs actuels (prix live, news scorées, etc.)
 *  3. Compare et retourne { triggered: bool, reasons: string[] }
 *  4. Si triggered, runPortfolioCycle() est appelé avec ce contexte
 */
@Injectable()
export class MaterialChangeDetectorService {
  private readonly logger = new Logger(MaterialChangeDetectorService.name);

  // Seuils de déclenchement event-driven (calibrés hyper-trading anticipatif).
  // Recalibrés 26/04 après retex : seuils trop élevés laissaient Lisa passive
  // pendant des heures (mode event-driven castré sur portefeuilles vides).
  // Trade-off : sensibilité ↑ vs bruit ↑ — la persona Lisa filtre le bruit.
  private static readonly VIX_DELTA_THRESHOLD = 0.3;        // était 0.5 — VIX 18.5 → 1.6% du niveau
  private static readonly DXY_DELTA_PCT = 0.3;              // (anciennement hardcodé en const)
  private static readonly PRICE_DELTA_PCT = 0.5;            // OK : 0.5% évite le bruit intraday
  private static readonly REFERENCE_DELTA_PCT = 0.6;        // PHASE 2 — bouge ref ETF/crypto, capte sans positions
  private static readonly FUNDING_DELTA_PCT = 0.4;          // 0.2→0.4 (26/04 soir) : ETH funding bouge en cascade -3.1→-5.4 sur 30min, chaque tick de 0.3 trigger un cycle ($0.30 chacun). 0.4 réduit cadence sans perdre signal majeur
  private static readonly DRAWDOWN_DELTA_PT = 0.5;          // OK : sur $10k = $50 réaction
  private static readonly NEWS_FRESH_MIN_SCORE = 60;        // était 75 — capte la convergence cross-source
  private static readonly NEWS_FRESH_MAX_AGE_MIN = 15;      // était 5 — la plupart des news arrivent à 10-30 min

  // PHASE 2 — Tickers de référence scannés MÊME quand 0 positions tenues.
  // Évite la castration du mode event-driven sur portefeuilles vides : si
  // SPY/BTC/GLD/etc. bouge fort, c'est un signal macro/sectoriel à
  // exploiter (Lisa scanne le marché pour ouvrir des positions).
  // Seuil 0.6% (vs 0.5% positions tenues) — légèrement plus strict pour
  // éviter le bruit sur ces tickers ultra-liquides à fort volume.
  private static readonly REFERENCE_TICKERS = [
    'SPY',   // S&P 500 — equity benchmark global
    'QQQ',   // Nasdaq 100 — tech benchmark
    'IWM',   // Russell 2000 — small cap
    'BTC',   // Bitcoin — crypto reference
    'ETH',   // Ethereum — alt crypto reference
    'GLD',   // Gold ETF — précieux + de-dollarization
    'TLT',   // 20Y bonds — taux long terme
    'HYG',   // High-yield credit — risk-on/off proxy
  ];

  constructor(
    private readonly supabase: SupabaseService,
    @Inject(forwardRef(() => LisaService))
    private readonly lisa: LisaService,
    private readonly binance: BinanceMarketService,
    private readonly newsAggregator: NewsAggregatorService,
    private readonly newsRanker: NewsRankerService,
  ) {}

  /**
   * Détecte si un cycle Lisa event-driven doit être déclenché.
   * @param portfolioId
   * @param heldSymbols Symboles actuellement tenus
   * @returns { triggered, reasons, currentSnapshot }
   */
  async detect(
    portfolioId: string,
    heldSymbols: string[],
  ): Promise<DetectionResult> {
    const reasons: string[] = [];

    // 1. Charge le snapshot de référence (dernier cycle Lisa)
    const { data: lastProposal } = await this.supabase.getClient()
      .from('lisa_proposals')
      .select('detected_inputs')
      .eq('portfolio_id', portfolioId)
      .not('detected_inputs', 'is', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    const snapshot = (lastProposal?.detected_inputs as MaterialSnapshot | null) ?? null;

    // 2. Calcule les inputs actuels
    const current = await this.captureCurrentInputs(portfolioId, heldSymbols);

    // 3. Si pas de snapshot précédent (premier cycle ever), on trigger pour
    //    établir la baseline. Pas un event mais nécessaire pour bootstrap.
    if (!snapshot) {
      return {
        triggered: true,
        reasons: ['bootstrap : aucun snapshot précédent'],
        currentSnapshot: current,
      };
    }

    // 4. Compare chaque axe et collecte les reasons

    // VIX
    if (current.vix != null && snapshot.vix != null) {
      const delta = Math.abs(current.vix - snapshot.vix);
      if (delta >= MaterialChangeDetectorService.VIX_DELTA_THRESHOLD) {
        reasons.push(`VIX ${snapshot.vix.toFixed(1)} → ${current.vix.toFixed(1)} (Δ${delta.toFixed(1)})`);
      }
    }

    // DXY
    if (current.dxy != null && snapshot.dxy != null) {
      const deltaPct = Math.abs((current.dxy - snapshot.dxy) / snapshot.dxy) * 100;
      if (deltaPct >= MaterialChangeDetectorService.DXY_DELTA_PCT) {
        reasons.push(`DXY ${snapshot.dxy.toFixed(1)} → ${current.dxy.toFixed(1)} (Δ${deltaPct.toFixed(2)}%)`);
      }
    }

    // Prix des positions tenues
    for (const sym of Object.keys(current.pricesHeld)) {
      const oldPrice = snapshot.pricesHeld?.[sym];
      const newPrice = current.pricesHeld[sym];
      if (oldPrice && newPrice) {
        const deltaPct = Math.abs((newPrice - oldPrice) / oldPrice) * 100;
        if (deltaPct >= MaterialChangeDetectorService.PRICE_DELTA_PCT) {
          const direction = newPrice > oldPrice ? '+' : '-';
          reasons.push(`${sym} ${direction}${deltaPct.toFixed(2)}% (${oldPrice} → ${newPrice})`);
        }
      }
    }

    // PHASE 2 — Prix des tickers de référence (scan macro même sans positions)
    // Cap à 2 reasons pour éviter le spam si tout le marché bouge.
    const referenceReasons: string[] = [];
    for (const sym of Object.keys(current.pricesReference ?? {})) {
      const oldPrice = snapshot.pricesReference?.[sym];
      const newPrice = current.pricesReference?.[sym];
      if (oldPrice && newPrice) {
        const deltaPct = Math.abs((newPrice - oldPrice) / oldPrice) * 100;
        if (deltaPct >= MaterialChangeDetectorService.REFERENCE_DELTA_PCT) {
          const direction = newPrice > oldPrice ? '+' : '-';
          referenceReasons.push(`marché ${sym} ${direction}${deltaPct.toFixed(2)}%`);
        }
      }
    }
    // Ajoute max 2 reasons macro pour signaler "le marché bouge" sans noyer
    reasons.push(...referenceReasons.slice(0, 2));

    // Funding rates crypto
    for (const sym of Object.keys(current.fundingHeld)) {
      const oldFunding = snapshot.fundingHeld?.[sym];
      const newFunding = current.fundingHeld[sym];
      if (oldFunding != null && newFunding != null) {
        const delta = Math.abs(newFunding - oldFunding);
        if (delta >= MaterialChangeDetectorService.FUNDING_DELTA_PCT) {
          reasons.push(`${sym} funding ${oldFunding.toFixed(1)}%/an → ${newFunding.toFixed(1)}%/an`);
        }
      }
    }

    // Drawdown portfolio
    if (current.drawdownPct != null && snapshot.drawdownPct != null) {
      const delta = Math.abs(current.drawdownPct - snapshot.drawdownPct);
      if (delta >= MaterialChangeDetectorService.DRAWDOWN_DELTA_PT) {
        reasons.push(`drawdown ${snapshot.drawdownPct.toFixed(2)}% → ${current.drawdownPct.toFixed(2)}%`);
      }
    }

    // Position fermée → cash libéré → réveil immédiat pour redéployer.
    // On ne déclenche QUE sur baisse (close), pas sur hausse (open) : les
    // ouvertures sont déjà gérées par les autres triggers (price/news/etc).
    if (current.openPositionsCount < snapshot.openPositionsCount) {
      reasons.push(`position(s) fermée(s) : ${snapshot.openPositionsCount} → ${current.openPositionsCount} (cash libéré, redéploiement disponible)`);
    }

    // News fraîches haute pertinence
    if (current.freshHighScoreNews && current.freshHighScoreNews.length > 0) {
      // Vérifie si ces news étaient déjà connues du snapshot
      const oldHash = snapshot.topNewsHash ?? '';
      if (current.topNewsHash !== oldHash && current.freshHighScoreNews.length > 0) {
        const sample = current.freshHighScoreNews[0];
        reasons.push(`news catalyst score ${sample.score} sur ${sample.symbols.join(',') || 'macro'} (${sample.title.slice(0, 60)}...)`);
      }
    }

    return {
      triggered: reasons.length > 0,
      reasons,
      currentSnapshot: current,
    };
  }

  /** Capture les inputs marché actuels (utilisé comme baseline future).
   *
   * 🛡️ Garde-fou critique (incident 26/04, perte $2627) : on n'inclut PAS
   * les prix issus du fallback hardcoded (LMT=100, GLD=310, SLV=31...) dans
   * le snapshot. Sinon le delta entre snapshot N (vrai prix) et snapshot N+1
   * (fallback) génère un faux event "GLD -28%" qui réveille Lisa et propage
   * la corruption. On ignore silencieusement les fallback ; le snapshot
   * suivant aura cette case absente, le détecteur skippe le delta proprement.
   */
  async captureCurrentInputs(
    portfolioId: string,
    heldSymbols: string[],
  ): Promise<MaterialSnapshot> {
    const isFallback = (src: string | undefined): boolean =>
      !src || src.startsWith('fallback');

    // VIX + DXY (on ignore les fallback)
    const [vixQuote, dxyQuote] = await Promise.all([
      this.lisa.getLivePrice('VIX').catch(() => null),
      this.lisa.getLivePrice('DXY').catch(() => null),
    ]);
    const vixReliable = vixQuote && !isFallback(vixQuote.source) ? vixQuote : null;
    const dxyReliable = dxyQuote && !isFallback(dxyQuote.source) ? dxyQuote : null;

    // Prix de chaque position tenue — ignorer les fallback pour ne pas
    // injecter des prix factices dans le snapshot baseline.
    const pricesHeld: Record<string, number> = {};
    await Promise.all(heldSymbols.map(async (sym) => {
      const q = await this.lisa.getLivePrice(sym).catch(() => null);
      if (q && !isFallback(q.source)) pricesHeld[sym] = Number(q.price);
      else if (q) this.logger.warn(`[FALLBACK_GUARD] snapshot ${sym} ignoré — source=${q.source}`);
    }));

    // PHASE 2 — Tickers de référence (scannés MÊME sans positions tenues).
    // Évite la castration du mode event-driven sur portefeuille vide.
    // Skip ceux déjà dans pricesHeld pour ne pas double-tracker.
    const pricesReference: Record<string, number> = {};
    const referenceTickersToScan = MaterialChangeDetectorService.REFERENCE_TICKERS
      .filter((t) => !pricesHeld[t.toUpperCase()]);
    await Promise.all(referenceTickersToScan.map(async (sym) => {
      const q = await this.lisa.getLivePrice(sym).catch(() => null);
      if (q && !isFallback(q.source)) pricesReference[sym.toUpperCase()] = Number(q.price);
    }));

    // Funding rates pour positions crypto
    const fundingHeld: Record<string, number> = {};
    const cryptoNative = new Set(['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'ADA']);
    await Promise.all(heldSymbols.filter((s) => cryptoNative.has(s.toUpperCase())).map(async (sym) => {
      const stats = await this.binance.getFutureStats(`${sym.toUpperCase()}USDT`).catch(() => null);
      if (stats) fundingHeld[sym.toUpperCase()] = stats.fundingAnnualizedPct;
    }));

    // Drawdown courant (depuis lisa_portfolio_snapshots)
    const { data: lastSnap } = await this.supabase.getClient()
      .from('lisa_portfolio_snapshots')
      .select('drawdown_from_peak_pct')
      .eq('portfolio_id', portfolioId)
      .order('snapshot_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    const drawdownPct = lastSnap?.drawdown_from_peak_pct as number | null ?? null;

    // News fraîches haute pertinence
    let freshHighScoreNews: Array<{ title: string; score: number; symbols: string[] }> = [];
    let topNewsHash = '';
    try {
      const aggregate = await this.newsAggregator.aggregate(heldSymbols, 30);
      const ranked = this.newsRanker.rank(aggregate.items, heldSymbols, 3, 20);
      const fresh = ranked.filter((r) =>
        r.scores.final >= MaterialChangeDetectorService.NEWS_FRESH_MIN_SCORE
        && r.rationale.ageHours * 60 <= MaterialChangeDetectorService.NEWS_FRESH_MAX_AGE_MIN,
      );
      freshHighScoreNews = fresh.slice(0, 5).map((r) => ({
        title: r.title.slice(0, 100),
        score: r.scores.final,
        symbols: r.symbols,
      }));
      // Hash stable du top 5 pour détection delta
      const concatTitles = ranked.slice(0, 5).map((r) => r.title).join('|');
      topNewsHash = createHash('sha256').update(concatTitles).digest('hex').slice(0, 16);
    } catch (e) {
      this.logger.debug(`news capture failed: ${String(e).slice(0, 80)}`);
    }

    return {
      vix: vixReliable ? Number(vixReliable.price) : null,
      dxy: dxyReliable ? Number(dxyReliable.price) : null,
      pricesHeld,
      pricesReference,
      fundingHeld,
      drawdownPct,
      openPositionsCount: heldSymbols.length,
      topNewsHash,
      freshHighScoreNews,
      snapshotAt: new Date().toISOString(),
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface MaterialSnapshot {
  vix: number | null;
  dxy: number | null;
  pricesHeld: Record<string, number>;
  /** PHASE 2 — Tickers de référence (SPY/QQQ/BTC/ETH/GLD/TLT/HYG/IWM)
   *  scannés MÊME quand 0 positions tenues. Permet le déclenchement
   *  event-driven sur mouvements macro/sectoriels sans dépendre des
   *  positions. Évite la castration du mode event-driven sur portefeuille
   *  vide (cas observé incident 26/04 : 0 positions = 0 événement). */
  pricesReference?: Record<string, number>;
  fundingHeld: Record<string, number>;
  drawdownPct: number | null;
  /** Nombre de positions ouvertes au moment du snapshot. Une baisse entre
   *  2 snapshots = une position s'est fermée → cash libéré → trigger event
   *  pour que Lisa redéploie immédiatement, sans attendre safety_net 60min. */
  openPositionsCount: number;
  topNewsHash: string;
  /** Présent à la capture courante, pas stocké dans lisa_proposals (texte
   *  trop volumineux et déjà capturé via news pipeline). */
  freshHighScoreNews?: Array<{ title: string; score: number; symbols: string[] }>;
  snapshotAt: string;
}

export interface DetectionResult {
  triggered: boolean;
  reasons: string[];
  currentSnapshot: MaterialSnapshot;
}
