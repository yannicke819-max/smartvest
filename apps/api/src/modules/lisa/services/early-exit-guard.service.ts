/**
 * EarlyExitGuardService — Miracle #3.
 *
 * Cron 1min : pour chaque position ouverte âgée 5-15 min, demande à Gemini
 * (via ScannerLlmRouterService) si la thèse momentum tient. Si verdict FADE,
 * ferme immédiatement à live price (perte limitée à ~ -0,5 % au lieu de SL -1,5 %).
 *
 * Default OFF. Best-effort : tout échec (LLM, parse, live price fallback)
 * → garde la position open (safe default).
 *
 * Coût estimé : 5 positions × 1 call/min × 10 min de fenêtre = 50 calls/jour
 *               × Gemini Flash-Lite $0.0002 = ~$0.01/jour. Marginal.
 */

import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../../supabase/supabase.service';
import { ScannerLlmRouterService } from './scanner-llm-router.service';
import { LisaService } from './lisa.service';
import { DecisionLogService } from './decision-log.service';
import {
  buildEarlyExitUserPrompt,
  parseEarlyExitVerdict,
  EARLY_EXIT_SYSTEM_PROMPT,
} from './early-exit-guard.helper';
import {
  extractEarlyExitThresholds,
  type EarlyExitThresholds,
  type LessonTargetsRow,
} from './lesson-driven-config.helper';

interface OpenPosRow {
  id: string;
  portfolio_id: string;
  symbol: string;
  direction: string;
  entry_price: number;
  entry_timestamp: string;
  stop_loss_price: number | null;
  take_profit_price: number | null;
  path_eff_at_entry: number | null;
  market_ch1m_at_entry: number | null;
}

interface PortfolioThresholdsCacheEntry {
  thresholds: EarlyExitThresholds;
  asOf: number;
}

@Injectable()
export class EarlyExitGuardService {
  private readonly logger = new Logger(EarlyExitGuardService.name);
  private enabled = false;
  private ageMinMin = 5;
  private ageMaxMin = 15;
  private maxActionsPerCycle = 2;
  /** Cache 60s du seuil per-portfolio pour éviter 1 fetch DB par position/cycle. */
  private readonly thresholdsCache = new Map<string, PortfolioThresholdsCacheEntry>();
  private static readonly THRESHOLDS_CACHE_TTL_MS = 60_000;

  constructor(
    private readonly config: ConfigService,
    private readonly supabase: SupabaseService,
    private readonly llmRouter: ScannerLlmRouterService,
    private readonly lisa: LisaService,
    private readonly decisionLog: DecisionLogService,
  ) {}

  onModuleInit(): void {
    this.enabled = (this.config.get<string>('EARLY_EXIT_GUARD_ENABLED') ?? 'false').toLowerCase() === 'true';
    const minRaw = Number.parseInt(this.config.get<string>('EARLY_EXIT_GUARD_AGE_MIN') ?? '', 10);
    const maxRaw = Number.parseInt(this.config.get<string>('EARLY_EXIT_GUARD_AGE_MAX') ?? '', 10);
    this.ageMinMin = Number.isFinite(minRaw) && minRaw >= 1 && minRaw <= 60 ? minRaw : 5;
    this.ageMaxMin = Number.isFinite(maxRaw) && maxRaw >= this.ageMinMin && maxRaw <= 120 ? maxRaw : 15;
    const actionsRaw = Number.parseInt(this.config.get<string>('EARLY_EXIT_GUARD_MAX_ACTIONS') ?? '', 10);
    this.maxActionsPerCycle = Number.isFinite(actionsRaw) && actionsRaw >= 0 && actionsRaw <= 20 ? actionsRaw : 2;
    if (this.enabled) {
      this.logger.log(
        `[early-exit-guard] ENABLED — window=[${this.ageMinMin},${this.ageMaxMin}]min maxActions/cycle=${this.maxActionsPerCycle}`,
      );
    }
  }

  @Cron(CronExpression.EVERY_MINUTE, { name: 'early-exit-guard', timeZone: 'UTC' })
  async runCycle(): Promise<void> {
    if (!this.enabled) return;
    if (!this.supabase.isReady()) return;
    if (!this.llmRouter.isEnabled()) return;
    try {
      const positions = await this.fetchEligiblePositions();
      if (positions.length === 0) return;
      let actions = 0;
      for (const pos of positions) {
        if (actions >= this.maxActionsPerCycle) {
          this.logger.log(`[early-exit-guard] max actions/cycle ${this.maxActionsPerCycle} reached — defer`);
          break;
        }
        const acted = await this.evaluateAndAct(pos).catch((e) => {
          this.logger.warn(`[early-exit-guard] eval ${pos.id} failed: ${String(e).slice(0, 150)}`);
          return false;
        });
        if (acted) actions++;
      }
    } catch (e) {
      this.logger.error(`[early-exit-guard] cycle exception: ${String(e).slice(0, 300)}`);
    }
  }

  /**
   * Charge (cache 60s) les seuils early-exit per-portfolio depuis
   * lisa_session_configs (colonnes ajoutées par migration 0172). Fail-safe :
   * en cas d'erreur DB → retour défauts neutres (null/null = aucun gate).
   */
  private async getPortfolioThresholds(portfolioId: string): Promise<EarlyExitThresholds> {
    const cached = this.thresholdsCache.get(portfolioId);
    if (cached && Date.now() - cached.asOf < EarlyExitGuardService.THRESHOLDS_CACHE_TTL_MS) {
      return cached.thresholds;
    }
    let thresholds: EarlyExitThresholds = { drawdownThresholdPct: null, minAgeSeconds: null };
    try {
      const { data } = await this.supabase.getClient()
        .from('lisa_session_configs')
        .select('gainers_early_exit_drawdown_threshold_pct, gainers_early_exit_min_age_seconds')
        .eq('portfolio_id', portfolioId)
        .maybeSingle();
      if (data) {
        thresholds = extractEarlyExitThresholds(data as LessonTargetsRow);
      }
    } catch (e) {
      this.logger.debug(`[early-exit-guard] cfg fetch fail ${portfolioId}: ${String(e).slice(0, 100)}`);
    }
    this.thresholdsCache.set(portfolioId, { thresholds, asOf: Date.now() });
    return thresholds;
  }

  private async fetchEligiblePositions(): Promise<OpenPosRow[]> {
    const now = Date.now();
    const minAgeIso = new Date(now - this.ageMaxMin * 60_000).toISOString(); // entries plus vieilles que ageMax
    const maxAgeIso = new Date(now - this.ageMinMin * 60_000).toISOString(); // entries plus récentes que ageMin
    const { data, error } = await this.supabase.getClient()
      .from('lisa_positions')
      .select('id, portfolio_id, symbol, direction, entry_price, entry_timestamp, stop_loss_price, take_profit_price, path_eff_at_entry, market_ch1m_at_entry')
      .eq('status', 'open')
      .gte('entry_timestamp', minAgeIso)
      .lte('entry_timestamp', maxAgeIso);
    if (error) {
      this.logger.warn(`[early-exit-guard] fetch positions: ${error.message}`);
      return [];
    }
    return (data ?? []) as OpenPosRow[];
  }

  private async evaluateAndAct(pos: OpenPosRow): Promise<boolean> {
    // 1. Fetch live price + ch1m maintenant
    const live = await this.lisa.getLivePrice(pos.symbol);
    const livePx = Number(live?.price ?? 0);
    if (livePx <= 0 || (typeof live?.source === 'string' && live.source.startsWith('fallback'))) {
      this.logger.debug(`[early-exit-guard] ${pos.symbol} skip — live price fallback (${live?.source})`);
      return false;
    }
    // P19-staleness — un quote `twelvedata` / `eodhd` peut être un EOD close
    // post-cloche : prix figé = close systématique à entry_price (= break-even
    // artificiel). Si asOf > 180s, on refuse de fermer sur ce prix.
    // 180s = 3× la durée d'une candle 1m, tolère les illiquidités mais bloque
    // les EOD closes.
    if (live?.asOf) {
      const asOfMs = Date.parse(live.asOf);
      const ageSec = Number.isFinite(asOfMs) ? (Date.now() - asOfMs) / 1000 : 0;
      if (ageSec > 180) {
        this.logger.warn(
          `[early-exit-guard] ${pos.symbol} skip — STALE quote (source=${live.source} asOf=${live.asOf} age=${Math.round(ageSec)}s > 180s). Likely post-close EOD value.`,
        );
        return false;
      }
    }
    const entry = Number(pos.entry_price);
    const direction = (pos.direction === 'short') ? 'short' : 'long';
    const ageSec = Math.round((Date.now() - new Date(pos.entry_timestamp).getTime()) / 1000);
    const ageMin = Math.round(ageSec / 60);
    // Signed unrealized
    const unrealPct = direction === 'long'
      ? ((livePx - entry) / entry) * 100
      : ((entry - livePx) / entry) * 100;

    // Lesson-driven gates (migration 0172) — per-portfolio FADE calibration.
    // Gate 1 : minAgeSeconds → ne JAMAIS FADE-close avant ce seuil (les
    // U-shapes recovery se signent souvent à -0.3% / -0.7% entre 30s et 90s
    // d'âge et se redressent). Default code = aucun seuil (back-compat).
    // Gate 2 : drawdownThresholdPct → ne FADE-close que si la position est
    // au-delà de ce drawdown (= la position « mérite » d'être évaluée).
    // En deçà, on garde et on laisse les stops/TP gérer.
    const thresholds = await this.getPortfolioThresholds(pos.portfolio_id);
    if (thresholds.minAgeSeconds !== null && ageSec < thresholds.minAgeSeconds) {
      this.logger.debug(
        `[early-exit-guard] ${pos.symbol} skip — age ${ageSec}s < min ${thresholds.minAgeSeconds}s (lesson-driven)`,
      );
      return false;
    }
    if (thresholds.drawdownThresholdPct !== null && unrealPct > -thresholds.drawdownThresholdPct) {
      // unrealPct > -threshold signifie qu'on n'est PAS encore au-delà du
      // drawdown calibré (ex : threshold=1.5 → on autorise FADE seulement si
      // unrealPct ≤ -1.5%). Sinon → laisser respirer.
      this.logger.debug(
        `[early-exit-guard] ${pos.symbol} skip — unreal ${unrealPct.toFixed(2)}% > -${thresholds.drawdownThresholdPct}% (lesson-driven)`,
      );
      return false;
    }
    const slDistPct = pos.stop_loss_price != null
      ? ((Number(pos.stop_loss_price) - livePx) / livePx) * 100
      : null;
    const tpDistPct = pos.take_profit_price != null
      ? ((Number(pos.take_profit_price) - livePx) / livePx) * 100
      : null;
    // ch1m now : best-effort lookup top_gainers_log dernier snapshot du symbole
    let ch1mNow: number | null = null;
    try {
      const { data } = await this.supabase.getClient()
        .from('top_gainers_log')
        .select('change_pct')
        .eq('symbol', pos.symbol)
        .order('captured_at', { ascending: false })
        .limit(1);
      ch1mNow = data?.[0]?.change_pct != null ? Number(data[0].change_pct) : null;
    } catch { /* swallow */ }

    // 2. Build prompt + call LLM
    const prompt = buildEarlyExitUserPrompt({
      symbol: pos.symbol,
      direction,
      ageMinutes: ageMin,
      entryPrice: entry,
      livePrice: livePx,
      ch1mAtEntry: pos.market_ch1m_at_entry,
      ch1mNow,
      pathEffAtEntry: pos.path_eff_at_entry,
      unrealizedPct: unrealPct,
      slDistancePct: slDistPct,
      tpDistancePct: tpDistPct,
    });
    let resp;
    try {
      resp = await this.llmRouter.call({
        system: EARLY_EXIT_SYSTEM_PROMPT,
        user: prompt,
        temperature: 0.1,
        maxTokens: 120,
        timeoutMs: 4000,
      });
    } catch (e) {
      this.logger.debug(`[early-exit-guard] ${pos.symbol} LLM fail: ${String(e).slice(0, 100)}`);
      return false;
    }
    const verdict = parseEarlyExitVerdict(resp.content);
    if (!verdict) {
      this.logger.debug(`[early-exit-guard] ${pos.symbol} parse fail: ${resp.content.slice(0, 100)}`);
      return false;
    }
    this.logger.log(
      `[early-exit-guard] ${pos.symbol} (${direction}, age ${ageMin}min, unreal ${unrealPct.toFixed(2)}%) ${verdict.decision} — ${verdict.rationale}`,
    );
    if (verdict.decision !== 'FADE') return false;

    // 3. FADE → close immédiat
    try {
      await this.lisa.getPaperBroker().closePosition({
        positionId: pos.id,
        reason: 'closed_invalidated',
        livePrice: livePx.toFixed(8),
        livePriceSource: live?.source,
        rationale: `early-exit-guard FADE Gemini : ${verdict.rationale}`,
      });
      await this.decisionLog.append({
        portfolioId: pos.portfolio_id,
        kind: 'risk_monitor_action',
        summary: `[EARLY_EXIT] FADE ${pos.symbol} age=${ageMin}min unreal=${unrealPct.toFixed(2)}%`,
        rationale: `EarlyExitGuardService verdict Gemini : ${verdict.rationale}`,
        payload: {
          early_exit: true,
          verdict: 'EARLY_EXIT_FADE',
          symbol: pos.symbol,
          direction,
          age_min: ageMin,
          unrealized_pct: unrealPct,
          live_price: livePx,
          ch1m_now: ch1mNow,
          ch1m_at_entry: pos.market_ch1m_at_entry,
          position_id: pos.id,
        },
        triggeredBy: 'autopilot_cron',
      }).catch(() => { /* swallow audit fail */ });
      return true;
    } catch (e) {
      this.logger.warn(`[early-exit-guard] ${pos.symbol} close exception: ${String(e).slice(0, 150)}`);
      return false;
    }
  }
}
