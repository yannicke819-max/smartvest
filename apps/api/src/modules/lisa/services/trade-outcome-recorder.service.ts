import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../../supabase/supabase.service';

/**
 * TradeOutcomeRecorderService — Phase 5.
 *
 * À chaque fermeture de position, capture le contexte d'ouverture
 * (regime, VIX, DXY, conviction émise par Lisa, news catalyst) et le
 * résultat (return %, durée, raison) dans lisa_trade_outcomes.
 *
 * Cette table est ensuite agrégée par LisaPerformanceAnalyticsService
 * pour produire des stats contextuelles ("conv 7-8 sur ce regime → 67%
 * win sur 15 trades") injectées dans le briefing Lisa.
 *
 * Idempotent par UNIQUE(position_id) : si appelé 2× sur la même position,
 * la 2e tentative est silencieusement ignorée par DB constraint.
 */
@Injectable()
export class TradeOutcomeRecorderService {
  private readonly logger = new Logger(TradeOutcomeRecorderService.name);

  constructor(private readonly supabase: SupabaseService) {}

  /**
   * Enregistre l'outcome d'une position fermée.
   * Charge la position + sa proposal source pour récupérer le contexte
   * d'ouverture, puis INSERT dans lisa_trade_outcomes.
   *
   * Async fire-and-forget côté caller — ne doit JAMAIS bloquer le close.
   */
  async recordOutcome(positionId: string, exitPrice: string, exitReason: string): Promise<void> {
    try {
      const client = this.supabase.getClient();

      // 1. Charge la position fermée + ses métadonnées
      const { data: pos } = await client
        .from('lisa_positions')
        .select('id, portfolio_id, proposal_id, thesis_id, symbol, asset_class, direction, entry_price, entry_timestamp, entry_notional_usd, conviction_score')
        .eq('id', positionId)
        .maybeSingle();

      if (!pos) {
        this.logger.debug(`recordOutcome: position ${positionId} not found, skip`);
        return;
      }

      // 2. Charge la proposal source pour le regime + le snapshot detected_inputs
      const { data: proposal } = await client
        .from('lisa_proposals')
        .select('detected_regime, detected_inputs')
        .eq('id', pos.proposal_id as string)
        .maybeSingle();

      const regime = (proposal?.detected_regime as string | null) ?? null;
      const detectedInputs = (proposal?.detected_inputs as Record<string, unknown> | null) ?? null;

      const openVix = detectedInputs?.['vix'] as number | null ?? null;
      const openDxy = detectedInputs?.['dxy'] as number | null ?? null;

      // 3. News catalyst au moment de l'ouverture (depuis last_event_trigger)
      // Best-effort : on lit la session config pour voir si le trigger source
      // était une news catalyst au moment proche de l'ouverture.
      let openNewsTopScore: number | null = null;
      let openNewsTopCatalyst: string | null = null;
      try {
        const { data: cfg } = await client
          .from('lisa_session_configs')
          .select('last_event_trigger_reason, last_event_trigger_at')
          .eq('portfolio_id', pos.portfolio_id as string)
          .maybeSingle();

        const triggerAt = cfg?.last_event_trigger_at as string | null;
        const triggerReason = cfg?.last_event_trigger_reason as string | null;
        if (triggerAt && triggerReason && triggerReason.includes('news catalyst')) {
          // Match "[event] news catalyst score 78 sur RTX (...)"
          const scoreMatch = triggerReason.match(/score (\d+)/);
          if (scoreMatch) openNewsTopScore = parseInt(scoreMatch[1], 10);
          const catalystMatch = triggerReason.match(/sur (\w+)/);
          if (catalystMatch) openNewsTopCatalyst = catalystMatch[1];
        }
      } catch { /* best-effort */ }

      // 4. Calcul return + durée
      const entryPrice = Number(pos.entry_price);
      const exitPriceNum = Number(exitPrice);
      const isLong = (pos.direction as string).startsWith('long');
      const returnPct = entryPrice > 0
        ? (isLong ? (exitPriceNum - entryPrice) / entryPrice : (entryPrice - exitPriceNum) / entryPrice) * 100
        : 0;
      const notional = Number(pos.entry_notional_usd ?? 0);
      const returnUsd = (notional * returnPct) / 100;

      const openAt = new Date(pos.entry_timestamp as string);
      const closeAt = new Date();
      const durationMinutes = Math.max(1, Math.round((closeAt.getTime() - openAt.getTime()) / 60_000));

      // 5. INSERT dans lisa_trade_outcomes (idempotent via UNIQUE)
      const { error } = await client
        .from('lisa_trade_outcomes')
        .insert({
          portfolio_id: pos.portfolio_id,
          position_id: pos.id,
          proposal_id: pos.proposal_id,
          thesis_id: pos.thesis_id,
          symbol: pos.symbol,
          asset_class: pos.asset_class,
          direction: pos.direction,
          open_regime: regime,
          open_vix: openVix,
          open_dxy: openDxy,
          open_conviction: pos.conviction_score,
          open_news_top_score: openNewsTopScore,
          open_news_top_catalyst: openNewsTopCatalyst,
          open_at: pos.entry_timestamp,
          close_at: closeAt.toISOString(),
          duration_minutes: durationMinutes,
          entry_price: pos.entry_price,
          exit_price: exitPrice,
          return_pct: returnPct,
          return_usd: returnUsd,
          close_reason: exitReason,
        });

      if (error && !error.message.includes('outcomes_position_unique')) {
        this.logger.warn(`recordOutcome insert failed for ${pos.symbol}: ${error.message}`);
      }
    } catch (e) {
      // Fire-and-forget — ne JAMAIS bloquer un close de position
      this.logger.warn(`recordOutcome unexpected error for ${positionId}: ${String(e).slice(0, 120)}`);
    }
  }
}
