import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../../supabase/supabase.service';
import { DecisionLogService } from './decision-log.service';
import { LisaService } from './lisa.service';
import { EodhdInsiderService } from './eodhd-insider.service';
import { BinanceLiquidationsService } from './binance-liquidations.service';
import { EodhdEnrichmentService } from './eodhd-enrichment.service';
import { EodhdTechnicalService } from './eodhd-technical.service';

/**
 * AgentLisaSyncService — P5.x : boucle réflexive agent mécanique ↔ Lisa.
 *
 * L'agent mécanique tourne chaque minute sans LLM. Pour certains signaux
 * asymétriques qu'il ne peut pas gérer seul, on "réveille" Lisa qui
 * ré-analyse le contexte et émet de nouvelles directives.
 *
 * TRIGGERS TIER 1 (urgence, cooldown 5 min) :
 *   - vix_spike              : VIX > 30 (choc marché, P5.1)
 *   - portfolio_drawdown     : drawdown intraday > 0.8% (avant kill-switch, P5.1)
 *   - position_pnl           : position unique P&L < -3% (souffrance, P5.1)
 *   - news_sentiment_shock   : news récente sur holding avec sentiment < -0.7 (P5.3)
 *
 * TRIGGERS TIER 2 (informational, cooldown 30 min) :
 *   - liquidation_wave       : LONG_PUKE/LONG_SQUEEZE sur crypto détenue (P5.2)
 *   - insider_bulk_buy       : C-suite net buy > $10M sur equity détenue (P5.2)
 *   - adx_regime_shift       : ADX14 < 15 (passage range) sur position (P5.2)
 *
 * Budget : 8 wake-ups/jour/portefeuille (toutes tiers confondues).
 * Persistence : lisa_decision_log (source de vérité, robuste aux redeploys).
 */

// Budget journalier de wake-ups Agent → Lisa. Dimensionné pour usage personnel
// intensif (sniper/actif). 20 × ~$0.2 = ~$4/jour max en coûts LLM déclenchés
// par les triggers event-driven — à additionner aux coûts des cycles réguliers.
const DAILY_WAKE_BUDGET = 20;
const TIER_1_COOLDOWN_MS = 5 * 60 * 1000;
const TIER_2_COOLDOWN_MS = 30 * 60 * 1000;
const INSIDER_BULK_BUY_THRESHOLD_USD = 10_000_000;
const NEWS_SENTIMENT_THRESHOLD = -0.7;
const NEWS_MAX_AGE_MS = 2 * 60 * 60 * 1000;  // news de moins de 2h
const ADX_RANGING_THRESHOLD = 15;

type TriggerTier = 'tier_1' | 'tier_2';

type TriggerType =
  | 'vix_spike'
  | 'portfolio_drawdown'
  | 'position_pnl'
  | 'news_sentiment_shock'
  | 'liquidation_wave'
  | 'insider_bulk_buy'
  | 'adx_regime_shift';

interface TriggerContext {
  trigger_type: TriggerType;
  tier: TriggerTier;
  trigger_value: number;
  threshold: number;
  symbol?: string;
  extra?: Record<string, unknown>;
}

interface OpenPositionMinimal {
  symbol: string;
  assetClass: string;
  direction: string;
  entryPrice: string;
}

@Injectable()
export class AgentLisaSyncService {
  private readonly logger = new Logger(AgentLisaSyncService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly decisionLog: DecisionLogService,
    private readonly lisa: LisaService,
    private readonly insider: EodhdInsiderService,
    private readonly liquidations: BinanceLiquidationsService,
    private readonly enrichment: EodhdEnrichmentService,
    private readonly technical: EodhdTechnicalService,
  ) {}

  /**
   * Point d'entrée principal. Évalue les triggers (Tier 1 d'abord, Tier 2 sinon)
   * et réveille Lisa si conditions remplies + budget OK.
   */
  async evaluateTriggers(input: {
    portfolioId: string;
    userId: string;
    openPositions: OpenPositionMinimal[];
    portfolioDrawdownPct: number | null;
    worstPositionPnlPct: number | null;
    worstPositionSymbol: string | null;
    vixLevel: number | null;
  }): Promise<{ woke: boolean; reason: string | null }> {
    const { portfolioId } = input;

    // 1. Tier 1 — signaux urgents en priorité
    let trigger = this.detectTier1(input);

    // 2. Tier 1 news (async fetch) si rien d'urgent pour l'instant
    if (!trigger && input.openPositions.length > 0) {
      trigger = await this.detectNewsSentimentShock(input.openPositions);
    }

    // 3. Tier 2 — signaux informationnels si rien en Tier 1
    if (!trigger && input.openPositions.length > 0) {
      trigger = await this.detectTier2(input.openPositions);
    }

    if (!trigger) return { woke: false, reason: null };

    // 4. Cooldown (différent par tier)
    const onCooldown = await this.isOnCooldown(portfolioId, trigger);
    if (onCooldown) {
      this.logger.debug(
        `[P5.x] ${portfolioId.slice(0, 8)} cooldown ${trigger.tier} actif sur ${trigger.trigger_type}, skip`,
      );
      return { woke: false, reason: 'cooldown' };
    }

    // 5. Budget journalier (global, toutes tiers)
    const wakeCountToday = await this.countWakesToday(portfolioId);
    if (wakeCountToday >= DAILY_WAKE_BUDGET) {
      this.logger.warn(
        `[P5.x] ${portfolioId.slice(0, 8)} budget ${DAILY_WAKE_BUDGET}/jour atteint, skip`,
      );
      return { woke: false, reason: 'budget_exhausted' };
    }

    // 6. Wake
    await this.wakeAndInvokeLisa(input, trigger, wakeCountToday);
    return { woke: true, reason: trigger.trigger_type };
  }

  // ─── Détection Tier 1 ──────────────────────────────────────────────────

  private detectTier1(input: {
    portfolioDrawdownPct: number | null;
    worstPositionPnlPct: number | null;
    worstPositionSymbol: string | null;
    vixLevel: number | null;
  }): TriggerContext | null {
    // Priorité 1 : VIX spike
    //
    // Sanity bound : VIX historique max ~89.5 (Oct 2008, mars 2020 ~85).
    // Une valeur > 80 est quasi-certainement une donnée corrompue (fallback
    // sentinel, parser error, source stale). Plutôt que paniquer en boucle
    // sur une fausse alerte, on ignore et on log.
    // Plancher VIX_LOW pour filtrer les valeurs nulles/zéro qui passeraient
    // le check `> 30` mais signaleraient une anomalie.
    const VIX_PLAUSIBLE_MAX = 80;
    const VIX_PLAUSIBLE_MIN = 5;
    if (
      input.vixLevel != null &&
      input.vixLevel > 30 &&
      input.vixLevel >= VIX_PLAUSIBLE_MIN &&
      input.vixLevel <= VIX_PLAUSIBLE_MAX
    ) {
      return {
        trigger_type: 'vix_spike',
        tier: 'tier_1',
        trigger_value: input.vixLevel,
        threshold: 30,
      };
    }
    if (input.vixLevel != null && input.vixLevel > VIX_PLAUSIBLE_MAX) {
      this.logger.warn(
        `[P5.1] VIX=${input.vixLevel} hors plage plausible (max ${VIX_PLAUSIBLE_MAX}) — donnée corrompue, trigger ignoré`,
      );
    }

    // Priorité 2 : drawdown portefeuille
    if (input.portfolioDrawdownPct != null && input.portfolioDrawdownPct > 0.8) {
      return {
        trigger_type: 'portfolio_drawdown',
        tier: 'tier_1',
        trigger_value: input.portfolioDrawdownPct,
        threshold: 0.8,
      };
    }

    // Priorité 3 : position en souffrance
    if (
      input.worstPositionPnlPct != null &&
      input.worstPositionPnlPct < -3 &&
      input.worstPositionSymbol
    ) {
      return {
        trigger_type: 'position_pnl',
        tier: 'tier_1',
        trigger_value: input.worstPositionPnlPct,
        threshold: -3,
        symbol: input.worstPositionSymbol,
      };
    }

    return null;
  }

  private async detectNewsSentimentShock(
    positions: OpenPositionMinimal[],
  ): Promise<TriggerContext | null> {
    // P5.3 : on fetch les news récentes pour les tickers detenus.
    // Si sentiment très négatif (< -0.7) sur news < 2h, on wake.
    const symbols = positions.map((p) => p.symbol);
    try {
      const news = await this.enrichment.fetchRecentNews(symbols, 30);
      const now = Date.now();
      for (const n of news) {
        if (n.sentiment == null || n.sentiment > NEWS_SENTIMENT_THRESHOLD) continue;
        const ts = n.date ? new Date(n.date).getTime() : 0;
        if (now - ts > NEWS_MAX_AGE_MS) continue;
        // Trouve sur quel ticker la news tape (peut être shared sur plusieurs)
        const impactedSymbol = positions.find((p) =>
          (n.symbols ?? []).includes(p.symbol),
        )?.symbol ?? symbols[0];
        return {
          trigger_type: 'news_sentiment_shock',
          tier: 'tier_1',
          trigger_value: n.sentiment,
          threshold: NEWS_SENTIMENT_THRESHOLD,
          symbol: impactedSymbol,
          extra: { title: n.title?.slice(0, 120), date: n.date },
        };
      }
    } catch (e) {
      this.logger.debug(`[P5.3] news fetch failed: ${String(e).slice(0, 80)}`);
    }
    return null;
  }

  // ─── Détection Tier 2 ──────────────────────────────────────────────────

  private async detectTier2(
    positions: OpenPositionMinimal[],
  ): Promise<TriggerContext | null> {
    // Run les 3 détecteurs Tier 2 en parallèle, on prend le plus alarmant
    const [liq, insider, adx] = await Promise.all([
      this.detectLiquidationWave(positions),
      this.detectInsiderBulkBuy(positions),
      this.detectAdxRegimeShift(positions),
    ]);

    // Priorité Tier 2 : liquidation > insider > adx
    return liq ?? insider ?? adx;
  }

  private async detectLiquidationWave(
    positions: OpenPositionMinimal[],
  ): Promise<TriggerContext | null> {
    const cryptos = positions.filter((p) =>
      p.assetClass.toLowerCase().includes('crypto'),
    );
    for (const p of cryptos) {
      try {
        const snap = await this.liquidations.getSnapshot(p.symbol);
        if (!snap) continue;
        if (snap.wavePattern === 'LONG_PUKE' || snap.wavePattern === 'LONG_SQUEEZE') {
          return {
            trigger_type: 'liquidation_wave',
            tier: 'tier_2',
            trigger_value: snap.sellNotionalUsd1h + snap.buyNotionalUsd1h,
            threshold: 20_000_000,
            symbol: p.symbol,
            extra: { pattern: snap.wavePattern, detail: snap.waveDetail },
          };
        }
      } catch { /* skip */ }
    }
    return null;
  }

  private async detectInsiderBulkBuy(
    positions: OpenPositionMinimal[],
  ): Promise<TriggerContext | null> {
    const equities = positions.filter((p) => {
      const cls = p.assetClass.toLowerCase();
      return cls.includes('equity') || cls.includes('etf') || cls.includes('stock');
    });
    for (const p of equities) {
      try {
        const signal = await this.insider.getInsiderSignal(p.symbol);
        if (!signal) continue;
        if (signal.csuiteNetBuyUsd > INSIDER_BULK_BUY_THRESHOLD_USD) {
          return {
            trigger_type: 'insider_bulk_buy',
            tier: 'tier_2',
            trigger_value: signal.csuiteNetBuyUsd,
            threshold: INSIDER_BULK_BUY_THRESHOLD_USD,
            symbol: p.symbol,
            extra: {
              transactions: signal.transactionsCount,
              top: signal.topTransaction?.ownerTitle,
            },
          };
        }
      } catch { /* skip */ }
    }
    return null;
  }

  private async detectAdxRegimeShift(
    positions: OpenPositionMinimal[],
  ): Promise<TriggerContext | null> {
    // On ne check que les positions equity/ETF (ADX EODHD = actions)
    const equities = positions.filter((p) => {
      const cls = p.assetClass.toLowerCase();
      return cls.includes('equity') || cls.includes('etf') || cls.includes('stock');
    });
    for (const p of equities) {
      try {
        const toEodhd = (s: string) => (s.includes('.') ? s : `${s.toUpperCase()}.US`);
        const ind = await this.technical.getIndicators(toEodhd(p.symbol));
        if (ind.adx14 == null) continue;
        if (ind.adx14 < ADX_RANGING_THRESHOLD) {
          return {
            trigger_type: 'adx_regime_shift',
            tier: 'tier_2',
            trigger_value: ind.adx14,
            threshold: ADX_RANGING_THRESHOLD,
            symbol: p.symbol,
            extra: {
              rsi14: ind.rsi14,
              macdHist: ind.macdHist,
              regime: 'range_breakdown',
            },
          };
        }
      } catch { /* skip */ }
    }
    return null;
  }

  // ─── Cooldown & budget ──────────────────────────────────────────────────

  private async isOnCooldown(
    portfolioId: string,
    trigger: TriggerContext,
  ): Promise<boolean> {
    const cooldownMs =
      trigger.tier === 'tier_1' ? TIER_1_COOLDOWN_MS : TIER_2_COOLDOWN_MS;
    const since = new Date(Date.now() - cooldownMs).toISOString();
    const { data } = await this.supabase.getClient()
      .from('lisa_decision_log')
      .select('timestamp, payload')
      .eq('portfolio_id', portfolioId)
      .eq('kind', 'agent_wake_up_triggered')
      .gte('timestamp', since)
      .order('timestamp', { ascending: false })
      .limit(20);

    if (!data || data.length === 0) return false;
    return data.some(
      (row) => (row.payload as { trigger_type?: string })?.trigger_type === trigger.trigger_type,
    );
  }

  private async countWakesToday(portfolioId: string): Promise<number> {
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);
    const { count } = await this.supabase.getClient()
      .from('lisa_decision_log')
      .select('*', { count: 'exact', head: true })
      .eq('portfolio_id', portfolioId)
      .eq('kind', 'agent_wake_up_triggered')
      .gte('timestamp', todayStart.toISOString());
    return count ?? 0;
  }

  // ─── Wake up ────────────────────────────────────────────────────────────

  private async wakeAndInvokeLisa(
    input: { portfolioId: string; userId: string },
    trigger: TriggerContext,
    wakeCountBefore: number,
  ): Promise<void> {
    const { portfolioId, userId } = input;

    this.logger.warn(
      `[P5.${trigger.tier === 'tier_1' ? 'x' : '2'}] ${portfolioId.slice(0, 8)} WAKE Lisa — ${trigger.trigger_type}=${trigger.trigger_value} (${wakeCountBefore + 1}/${DAILY_WAKE_BUDGET})`,
    );

    await this.decisionLog.append({
      portfolioId,
      kind: 'agent_wake_up_triggered',
      summary: this.summarizeTrigger(trigger),
      rationale: `[P5.x] Trigger ${trigger.tier} "${trigger.trigger_type}" franchi (${trigger.trigger_value} vs seuil ${trigger.threshold}). Réveil Lisa pour ré-analyse contextuelle.`,
      payload: {
        trigger_type: trigger.trigger_type,
        tier: trigger.tier,
        trigger_value: trigger.trigger_value,
        threshold: trigger.threshold,
        symbol: trigger.symbol ?? null,
        extra: trigger.extra ?? null,
        wake_count_today: wakeCountBefore + 1,
        daily_budget: DAILY_WAKE_BUDGET,
      },
      triggeredBy: 'risk_monitor',
    });

    // Appel Lisa async (non-bloquant). P5.4 remplacera ça par un quickOverride
    // plus léger et moins cher.
    const userFocus = this.buildUserFocus(trigger);
    setImmediate(() => {
      this.lisa.generateProposal(userId, portfolioId, userFocus).catch((e) => {
        this.logger.error(`[P5.x] Wake Lisa invocation failed: ${String(e).slice(0, 200)}`);
      });
    });
  }

  private summarizeTrigger(trigger: TriggerContext): string {
    switch (trigger.trigger_type) {
      case 'vix_spike':
        return `[P5.1] Wake — VIX ${trigger.trigger_value.toFixed(1)} > ${trigger.threshold} (choc marché)`;
      case 'portfolio_drawdown':
        return `[P5.1] Wake — drawdown portefeuille ${trigger.trigger_value.toFixed(2)}% > ${trigger.threshold}% (approche kill-switch)`;
      case 'position_pnl':
        return `[P5.1] Wake — ${trigger.symbol} P&L ${trigger.trigger_value.toFixed(2)}% < ${trigger.threshold}% (souffrance)`;
      case 'news_sentiment_shock':
        return `[P5.3] Wake — ${trigger.symbol} news sentiment ${trigger.trigger_value.toFixed(2)} < ${trigger.threshold} : "${(trigger.extra?.title ?? 'news négative').toString().slice(0, 60)}"`;
      case 'liquidation_wave':
        return `[P5.2] Wake — ${trigger.symbol} liquidation wave ${trigger.extra?.pattern} : ${(trigger.trigger_value / 1_000_000).toFixed(1)}M$ en 1h`;
      case 'insider_bulk_buy':
        return `[P5.2] Wake — ${trigger.symbol} C-suite net buy ${(trigger.trigger_value / 1_000_000).toFixed(1)}M$ > seuil ${(trigger.threshold / 1_000_000).toFixed(0)}M$`;
      case 'adx_regime_shift':
        return `[P5.2] Wake — ${trigger.symbol} ADX14 ${trigger.trigger_value.toFixed(1)} < ${trigger.threshold} (régime range, momentum trompeur)`;
    }
  }

  private buildUserFocus(trigger: TriggerContext): string {
    switch (trigger.trigger_type) {
      case 'vix_spike':
        return `WAKE-UP: VIX=${trigger.trigger_value.toFixed(1)} > 30 (choc marché). Évalue urgemment la posture de risque et émets des tactical_overrides défensifs si pertinent (pauseOpens, tightenStopsMultiplier < 1, minConvictionOverride élevé).`;
      case 'portfolio_drawdown':
        return `WAKE-UP: drawdown intraday ${trigger.trigger_value.toFixed(2)}% approche kill-switch (1%). Examine les positions : émets tactical_overrides (closeLowestConvictionIfExposureAbovePct) ou close_conditions si thèse invalidée.`;
      case 'position_pnl':
        return `WAKE-UP: position ${trigger.symbol} à ${trigger.trigger_value.toFixed(2)}% P&L. Réévalue la thèse : si invalidée, émets close_conditions immediate ; sinon maintiens et laisse le stop ATR faire son travail.`;
      case 'news_sentiment_shock':
        return `WAKE-UP: news très négative sur ${trigger.symbol} (sentiment ${trigger.trigger_value.toFixed(2)}). Titre: "${trigger.extra?.title ?? 'n/a'}". Décide si la thèse reste valide. Si invalidée → close_conditions immediate. Si transitoire → tightenStopsMultiplier pour limiter le risque.`;
      case 'liquidation_wave':
        return `WAKE-UP: liquidation wave ${trigger.extra?.pattern} détectée sur ${trigger.symbol} (${(trigger.trigger_value / 1_000_000).toFixed(1)}M$ en 1h). Pattern LONG_PUKE = reversal haussier probable, LONG_SQUEEZE = reversal baissier probable. Adapte ta conviction et considère tightenStopsMultiplier ou add-on thèse.`;
      case 'insider_bulk_buy':
        return `WAKE-UP: C-suite a acheté ${(trigger.trigger_value / 1_000_000).toFixed(1)}M$ sur ${trigger.symbol} (${trigger.extra?.top ?? 'insider'}). Signal fort golden-trader. Évalue si tu renforces la position (add-on) ou si tu laisses courir avec stops plus larges.`;
      case 'adx_regime_shift':
        return `WAKE-UP: ADX14 sur ${trigger.symbol} = ${trigger.trigger_value.toFixed(1)} (< 15 = régime range). Les signaux momentum (MACD, RSI directionnel) sont moins fiables. Envisage de switcher vers mean-reversion (CCI, BB_%B) ou sortir si la thèse était trend-following.`;
    }
  }
}
