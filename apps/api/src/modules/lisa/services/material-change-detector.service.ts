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

  // Seuils de déclenchement (calibrés conservateur — peuvent être ajustés)
  private static readonly VIX_DELTA_THRESHOLD = 0.5;
  private static readonly PRICE_DELTA_PCT = 0.5;
  private static readonly FUNDING_DELTA_PCT = 0.3;
  private static readonly DRAWDOWN_DELTA_PT = 0.5;
  private static readonly NEWS_FRESH_MIN_SCORE = 75;
  private static readonly NEWS_FRESH_MAX_AGE_MIN = 5;

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
      if (deltaPct >= 0.3) {
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

  /** Capture les inputs marché actuels (utilisé comme baseline future). */
  async captureCurrentInputs(
    portfolioId: string,
    heldSymbols: string[],
  ): Promise<MaterialSnapshot> {
    // VIX + DXY
    const [vixQuote, dxyQuote] = await Promise.all([
      this.lisa.getLivePrice('VIX').catch(() => null),
      this.lisa.getLivePrice('DXY').catch(() => null),
    ]);

    // Prix de chaque position tenue
    const pricesHeld: Record<string, number> = {};
    await Promise.all(heldSymbols.map(async (sym) => {
      const q = await this.lisa.getLivePrice(sym).catch(() => null);
      if (q) pricesHeld[sym] = Number(q.price);
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
      vix: vixQuote ? Number(vixQuote.price) : null,
      dxy: dxyQuote ? Number(dxyQuote.price) : null,
      pricesHeld,
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
