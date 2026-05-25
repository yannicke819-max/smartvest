/**
 * OpenPositionRiskMonitorService — Cron 5 min qui calcule un thesis_health_score
 * signé pour chaque position ouverte (lisa_positions WHERE status='open') et applique
 * une action proactive si nécessaire :
 *
 *   - composite < -0.60 → CLOSE_NOW    (close immédiat, perte limitée)
 *   - composite < -0.30 → TIGHTEN_SL   (move SL vers breakeven = entry_price)
 *   - composite ∈ [-0.30,+0.30] → HOLD (no-op)
 *   - composite > +0.30 → RAISE_TP     (étend TP à initial × 1.5)
 *   - composite > +0.60 → MOMENTUM_RIDE (TP à entry × 1.06, +6 % au lieu de +3 %)
 *
 * Driven par 3 sub-scores indépendants (helper pur thesis-health-score.helper.ts) :
 *   - Sub-A : market momentum delta (proxy de classe : BTCUSDT pour crypto via
 *             top_gainers_log lookup ; classes non-crypto = null pour l'instant,
 *             extension P5 ajoutera SPY/CAC/N225).
 *   - Sub-B : re-scoring pathEff + persistence multi-TF via MultiTimeframePersistenceService.
 *   - Sub-C : LLM Gemini (P5, désactivé pour l'instant).
 *
 * Gating ENV :
 *   - RISK_MONITOR_ENABLED=true (master kill, default false)
 *   - RISK_MONITOR_ENABLED_CRYPTO/US/EU/ASIA=true (par classe)
 *   - RISK_MONITOR_MAX_ACTIONS_PER_CYCLE=1 (anti-cascade)
 *
 * Audit best-effort dans lisa_decision_log (kind='risk_monitor_action').
 */

import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../../supabase/supabase.service';
import { MultiTimeframePersistenceService } from './multi-tf-persistence.service';
import { LisaService } from './lisa.service';
import { DecisionLogService } from './decision-log.service';
import { ScannerLlmRouterService } from './scanner-llm-router.service';
import {
  evaluateThesisHealth,
  type RiskVerdict,
  type ThesisHealthResult,
} from './thesis-health-score.helper';
import {
  buildGeminiVerdictUserPrompt,
  parseGeminiVerdict,
  GEMINI_VERDICT_SYSTEM_PROMPT,
} from './gemini-thesis-verdict.helper';

interface OpenPositionRow {
  id: string;
  portfolio_id: string;
  symbol: string;
  asset_class: string;
  direction: string;
  entry_price: number;
  entry_timestamp: string;
  stop_loss_price: number | null;
  take_profit_price: number | null;
  path_eff_at_entry: number | null;
  persistence_score_at_entry: number | null;
  persistence_count_at_entry: string | null;
  market_ch1m_at_entry: number | null;
}

interface PerClassEnabled {
  crypto: boolean;
  us: boolean;
  eu: boolean;
  asia: boolean;
}

@Injectable()
export class OpenPositionRiskMonitorService {
  private readonly logger = new Logger(OpenPositionRiskMonitorService.name);
  private enabled = false;
  private perClass: PerClassEnabled = { crypto: false, us: false, eu: false, asia: false };
  private maxActionsPerCycle = 1;
  private geminiEnabled = false;

  constructor(
    private readonly config: ConfigService,
    private readonly supabase: SupabaseService,
    private readonly lisa: LisaService,
    private readonly mtfPersistence: MultiTimeframePersistenceService,
    private readonly decisionLog: DecisionLogService,
    private readonly llmRouter: ScannerLlmRouterService,
  ) {}

  onModuleInit(): void {
    this.enabled = (this.config.get<string>('RISK_MONITOR_ENABLED') ?? 'false').toLowerCase() === 'true';
    this.perClass = {
      crypto: (this.config.get<string>('RISK_MONITOR_ENABLED_CRYPTO') ?? 'false').toLowerCase() === 'true',
      us:     (this.config.get<string>('RISK_MONITOR_ENABLED_US')     ?? 'false').toLowerCase() === 'true',
      eu:     (this.config.get<string>('RISK_MONITOR_ENABLED_EU')     ?? 'false').toLowerCase() === 'true',
      asia:   (this.config.get<string>('RISK_MONITOR_ENABLED_ASIA')   ?? 'false').toLowerCase() === 'true',
    };
    const maxRaw = Number.parseInt(this.config.get<string>('RISK_MONITOR_MAX_ACTIONS_PER_CYCLE') ?? '1', 10);
    this.maxActionsPerCycle = Number.isFinite(maxRaw) && maxRaw >= 0 && maxRaw <= 20 ? maxRaw : 1;
    // P5 — Gemini Sub-C : nécessite RISK_MONITOR_GEMINI_ENABLED=true ET router activé
    this.geminiEnabled = (this.config.get<string>('RISK_MONITOR_GEMINI_ENABLED') ?? 'false').toLowerCase() === 'true'
      && this.llmRouter.isEnabled();
    if (this.enabled) {
      const cls = Object.entries(this.perClass).filter(([, v]) => v).map(([k]) => k).join(',') || 'none';
      this.logger.log(`[risk-monitor] ENABLED — classes=${cls} maxActions/cycle=${this.maxActionsPerCycle} gemini=${this.geminiEnabled}`);
    }
  }

  @Cron(CronExpression.EVERY_5_MINUTES, { name: 'open-position-risk-monitor', timeZone: 'UTC' })
  async runCycle(): Promise<void> {
    if (!this.enabled) return;
    if (!this.supabase.isReady()) return;
    try {
      const positions = await this.fetchEligiblePositions();
      if (positions.length === 0) return;
      let actionsApplied = 0;
      for (const pos of positions) {
        if (actionsApplied >= this.maxActionsPerCycle) {
          this.logger.log(`[risk-monitor] max actions/cycle reached (${this.maxActionsPerCycle}) — defer remaining`);
          break;
        }
        const result = await this.evaluatePosition(pos).catch((e) => {
          this.logger.warn(`[risk-monitor] evaluate ${pos.id} failed: ${String(e).slice(0, 200)}`);
          return null;
        });
        if (!result) continue;
        this.logger.log(
          `[risk-monitor] ${pos.symbol} composite=${result.composite.toFixed(3)} ` +
          `(subA=${result.subA?.toFixed(2) ?? 'n/a'} subB=${result.subB?.toFixed(2) ?? 'n/a'} subC=${result.subC?.toFixed(2) ?? 'n/a'}) ` +
          `verdict=${result.verdict}`,
        );
        if (result.verdict === 'HOLD') continue;
        const applied = await this.applyAction(pos, result);
        if (applied) actionsApplied++;
      }
    } catch (e) {
      this.logger.error(`[risk-monitor] cycle exception: ${String(e).slice(0, 300)}`);
    }
  }

  /**
   * Récupère les positions ouvertes éligibles (asset_class activée).
   * Skip celles sans features_at_entry (positions pré-P1 ou échec capture).
   */
  private async fetchEligiblePositions(): Promise<OpenPositionRow[]> {
    const { data, error } = await this.supabase.getClient()
      .from('lisa_positions')
      .select('id, portfolio_id, symbol, asset_class, direction, entry_price, entry_timestamp, stop_loss_price, take_profit_price, path_eff_at_entry, persistence_score_at_entry, persistence_count_at_entry, market_ch1m_at_entry')
      .eq('status', 'open');
    if (error) {
      this.logger.warn(`[risk-monitor] fetch open positions: ${error.message}`);
      return [];
    }
    const rows = (data ?? []) as OpenPositionRow[];
    return rows.filter((p) => this.isClassEnabled(p.asset_class));
  }

  private isClassEnabled(assetClass: string): boolean {
    if (assetClass.startsWith('crypto')) return this.perClass.crypto;
    if (assetClass.startsWith('us_')) return this.perClass.us;
    if (assetClass === 'eu_equity') return this.perClass.eu;
    if (assetClass === 'asia_equity') return this.perClass.asia;
    return false;
  }

  /**
   * Calcule sub-A/B/C → composite → verdict pour une position.
   */
  private async evaluatePosition(pos: OpenPositionRow): Promise<ThesisHealthResult | null> {
    // Sub-A : market momentum delta (BTC ch1m pour crypto, null pour autres pour l'instant)
    const { atEntry: marketAtEntry, now: marketNow } = await this.computeMarketMomentum(pos);

    // Sub-B : re-scoring path/persistence via mtfPersistence
    let pathEffNow: number | null = null;
    let persistenceNow: number | null = null;
    try {
      const live = await this.lisa.getLivePrice(pos.symbol);
      const livePrice = Number(live?.price ?? 0);
      const live2: { price: string; source: string } | null = live as { price: string; source: string } | null;
      const isFallback = live2 != null && typeof live2.source === 'string' && live2.source.startsWith('fallback');
      if (livePrice > 0 && !isFallback) {
        const analyzed = await this.mtfPersistence.analyze({
          symbol: pos.symbol,
          currentPrice: livePrice,
        });
        if (analyzed) {
          pathEffNow = analyzed.pathQuality?.overallEfficiency ?? null;
          persistenceNow = analyzed.persistenceScore ?? null;
        }
      }
    } catch (e) {
      this.logger.debug(`[risk-monitor] mtfPersistence ${pos.symbol}: ${String(e).slice(0, 150)}`);
    }

    // Sub-C : Gemini Flash-Lite (P5). Désactivé par défaut, opt-in via env.
    // Coût ~$0.0002/call, donc 12 calls/h × N positions ≈ marginal.
    const llmScore = this.geminiEnabled
      ? await this.computeGeminiScore(pos, {
          marketAtEntry,
          marketNow,
          pathEffNow,
          persistenceNow,
        })
      : null;

    return evaluateThesisHealth({
      marketCh1mAtEntry: marketAtEntry,
      marketCh1mNow: marketNow,
      pathEffAtEntry: pos.path_eff_at_entry,
      pathEffNow,
      persistenceAtEntry: pos.persistence_score_at_entry,
      persistenceNow,
      llmScore,
    });
  }

  /**
   * P5 — Sub-C Gemini. Construit le prompt avec le contexte enrichi, appelle
   * le router (timeout 4s, 1 retry), parse le JSON verdict. Best-effort :
   * tout échec → return null → poids re-normalisé sur A+B.
   */
  private async computeGeminiScore(
    pos: OpenPositionRow,
    ctx: { marketAtEntry: number | null; marketNow: number | null; pathEffNow: number | null; persistenceNow: number | null },
  ): Promise<number | null> {
    try {
      const live = await this.lisa.getLivePrice(pos.symbol);
      const livePx = Number(live?.price ?? 0);
      if (livePx <= 0 || (typeof live?.source === 'string' && live.source.startsWith('fallback'))) {
        return null;
      }
      const entry = Number(pos.entry_price);
      const unrealPct = entry > 0 ? ((livePx - entry) / entry) * 100 : 0;
      const ageMin = Math.round((Date.now() - new Date(pos.entry_timestamp).getTime()) / 60_000);
      const tpDistPct = pos.take_profit_price != null
        ? ((Number(pos.take_profit_price) - livePx) / livePx) * 100
        : null;
      const slDistPct = pos.stop_loss_price != null
        ? ((Number(pos.stop_loss_price) - livePx) / livePx) * 100
        : null;
      const userPrompt = buildGeminiVerdictUserPrompt({
        symbol: pos.symbol,
        assetClass: pos.asset_class,
        openedAt: pos.entry_timestamp,
        ageMinutes: ageMin,
        entryPrice: entry,
        livePrice: livePx,
        unrealPnlPct: unrealPct,
        pathEffAtEntry: pos.path_eff_at_entry,
        pathEffNow: ctx.pathEffNow,
        persistenceAtEntry: pos.persistence_score_at_entry,
        persistenceNow: ctx.persistenceNow,
        marketCh1mAtEntry: ctx.marketAtEntry,
        marketCh1mNow: ctx.marketNow,
        tpDistancePct: tpDistPct,
        slDistancePct: slDistPct,
      });
      const resp = await this.llmRouter.call({
        system: GEMINI_VERDICT_SYSTEM_PROMPT,
        user: userPrompt,
        temperature: 0.2,
        maxTokens: 120,
        timeoutMs: 4000,
      });
      const parsed = parseGeminiVerdict(resp.content);
      if (!parsed) {
        this.logger.debug(`[risk-monitor] Gemini ${pos.symbol} parse failed: ${resp.content.slice(0, 100)}`);
        return null;
      }
      this.logger.debug(`[risk-monitor] Gemini ${pos.symbol} score=${parsed.score.toFixed(2)} (${parsed.rationale})`);
      return parsed.score;
    } catch (e) {
      this.logger.debug(`[risk-monitor] Gemini ${pos.symbol} exception: ${String(e).slice(0, 150)}`);
      return null;
    }
  }

  /**
   * Sub-A — momentum delta du SYMBOLE LUI-MÊME (toutes classes : crypto, US, EU, Asia).
   *
   * Approche directe : compare le ch1m du symbole à l'open vs maintenant via top_gainers_log
   * (le scanner capture ~6 snapshots/min pour TOUS les symboles qui apparaissent dans
   * les classements top movers, donc couvre les positions actives quel que soit l'asset class).
   *
   * Avantages vs proxy de classe :
   *   - Pas d'hypothèse de corrélation (AAPL ne suit pas toujours SPY 1:1)
   *   - Unique source pour toutes les classes
   *   - Aucune dépendance externe (data déjà capturée par scanner)
   *
   * Si le symbole n'a aucune capture dans top_gainers_log (rare : LLM thèse sur small-cap
   * non-scannée), Sub-A retourne null et le composite repose sur B+C.
   */
  private async computeMarketMomentum(pos: OpenPositionRow): Promise<{ atEntry: number | null; now: number | null }> {
    // ch1m @ entry : valeur stockée si dispo (capturée à l'open), sinon lookup top_gainers_log
    let atEntry = pos.market_ch1m_at_entry;
    if (atEntry == null) {
      const { data } = await this.supabase.getClient()
        .from('top_gainers_log')
        .select('change_pct, captured_at')
        .eq('symbol', pos.symbol)
        .lte('captured_at', pos.entry_timestamp)
        .order('captured_at', { ascending: false })
        .limit(1);
      atEntry = data?.[0]?.change_pct != null ? Number(data[0].change_pct) : null;
    }
    // ch1m now : dernier snapshot du symbole
    const { data: latest } = await this.supabase.getClient()
      .from('top_gainers_log')
      .select('change_pct, captured_at')
      .eq('symbol', pos.symbol)
      .order('captured_at', { ascending: false })
      .limit(1);
    const now = latest?.[0]?.change_pct != null ? Number(latest[0].change_pct) : null;
    return { atEntry, now };
  }

  /**
   * Applique l'action selon le verdict. Best-effort : log et audit même si échec.
   * Retourne true si une action a été effectivement appliquée (pour le compteur cycle).
   */
  private async applyAction(pos: OpenPositionRow, result: ThesisHealthResult): Promise<boolean> {
    const { verdict, composite } = result;
    try {
      switch (verdict) {
        case 'CLOSE_NOW':
          return await this.applyClose(pos, composite);
        case 'TIGHTEN_SL':
          return await this.applyTightenSl(pos, composite);
        case 'RAISE_TP':
          return await this.applyRaiseTp(pos, composite, 1.5);
        case 'MOMENTUM_RIDE':
          return await this.applyRaiseTp(pos, composite, 2.0);
        default:
          return false;
      }
    } catch (e) {
      this.logger.warn(`[risk-monitor] applyAction ${verdict} ${pos.symbol} failed: ${String(e).slice(0, 200)}`);
      return false;
    }
  }

  private async applyClose(pos: OpenPositionRow, composite: number): Promise<boolean> {
    const live = await this.lisa.getLivePrice(pos.symbol);
    const livePrice = Number(live?.price ?? 0);
    // P19-staleness — catche aussi `stale_*` : TD `/quote` retourne EOD close
    // post-cloche → close se faisait à entry = break-even artificiel.
    const srcUnusable = typeof live?.source === 'string'
      && (live.source.startsWith('fallback') || live.source.startsWith('stale_'));
    if (livePrice <= 0 || srcUnusable) {
      this.logger.warn(`[risk-monitor] ${pos.symbol} CLOSE_NOW skipped — live price unavailable/stale (source=${live?.source})`);
      return false;
    }
    const broker = this.lisa.getPaperBroker();
    await broker.closePosition({
      positionId: pos.id,
      reason: 'closed_invalidated',
      livePrice: livePrice.toFixed(8),
      livePriceSource: live?.source,
      rationale: `risk_monitor CLOSE_NOW composite=${composite.toFixed(3)} (thèse cassée)`,
    });
    await this.auditAction(pos, 'CLOSE_NOW', composite, { live_price: livePrice });
    this.logger.log(`[risk-monitor] ${pos.symbol} CLOSED at $${livePrice} (composite=${composite.toFixed(3)})`);
    return true;
  }

  private async applyTightenSl(pos: OpenPositionRow, composite: number): Promise<boolean> {
    const breakeven = Number(pos.entry_price);
    const currentSl = pos.stop_loss_price != null ? Number(pos.stop_loss_price) : null;
    // No-op si le SL est déjà ≥ breakeven (déjà en profit lock)
    if (currentSl != null && currentSl >= breakeven) {
      this.logger.log(`[risk-monitor] ${pos.symbol} TIGHTEN_SL no-op — current SL ${currentSl} déjà ≥ breakeven ${breakeven}`);
      return false;
    }
    const { error } = await this.supabase.getClient()
      .from('lisa_positions')
      .update({ stop_loss_price: breakeven.toFixed(8), updated_at: new Date().toISOString() })
      .eq('id', pos.id)
      .eq('status', 'open'); // safety : ne pas update une position déjà fermée
    if (error) {
      this.logger.warn(`[risk-monitor] ${pos.symbol} TIGHTEN_SL update failed: ${error.message}`);
      return false;
    }
    await this.auditAction(pos, 'TIGHTEN_SL', composite, { previous_sl: currentSl, new_sl: breakeven });
    this.logger.log(`[risk-monitor] ${pos.symbol} SL → breakeven ${breakeven} (was ${currentSl}, composite=${composite.toFixed(3)})`);
    return true;
  }

  /**
   * RAISE_TP / MOMENTUM_RIDE : étend le TP d'un multiplicateur sur la distance entry→TP initial.
   * mult=1.5 → TP_new = entry + 1.5×(TP_initial - entry) = +50 % de marge en plus
   * mult=2.0 → +100 % = TP doublé
   */
  private async applyRaiseTp(pos: OpenPositionRow, composite: number, mult: number): Promise<boolean> {
    if (pos.take_profit_price == null) {
      this.logger.log(`[risk-monitor] ${pos.symbol} RAISE_TP skipped — no current TP set`);
      return false;
    }
    const entry = Number(pos.entry_price);
    const currentTp = Number(pos.take_profit_price);
    const tpDistance = currentTp - entry;
    const newTp = entry + tpDistance * mult;
    // Safety : ne pas raise si déjà passé le TP initial (sinon on chase le prix)
    const live = await this.lisa.getLivePrice(pos.symbol);
    const livePrice = Number(live?.price ?? 0);
    if (livePrice > currentTp) {
      this.logger.log(`[risk-monitor] ${pos.symbol} RAISE_TP no-op — live ${livePrice} déjà > TP initial ${currentTp} (laisse trailing standard agir)`);
      return false;
    }
    const { error } = await this.supabase.getClient()
      .from('lisa_positions')
      .update({ take_profit_price: newTp.toFixed(8), updated_at: new Date().toISOString() })
      .eq('id', pos.id)
      .eq('status', 'open');
    if (error) {
      this.logger.warn(`[risk-monitor] ${pos.symbol} RAISE_TP update failed: ${error.message}`);
      return false;
    }
    const kind: RiskVerdict = mult >= 2.0 ? 'MOMENTUM_RIDE' : 'RAISE_TP';
    await this.auditAction(pos, kind, composite, { previous_tp: currentTp, new_tp: newTp, mult });
    this.logger.log(`[risk-monitor] ${pos.symbol} TP ${currentTp} → ${newTp.toFixed(4)} (×${mult}, ${kind}, composite=${composite.toFixed(3)})`);
    return true;
  }

  private async auditAction(
    pos: OpenPositionRow,
    verdict: RiskVerdict,
    composite: number,
    extra: Record<string, unknown>,
  ): Promise<void> {
    await this.decisionLog.append({
      portfolioId: pos.portfolio_id,
      kind: 'risk_monitor_action', // ajouté par migration 0158
      summary: `[RISK_MONITOR] ${verdict} ${pos.symbol} composite=${composite.toFixed(3)}`,
      rationale: `OpenPositionRiskMonitorService verdict mécanique sur thesis_health_score signé.`,
      payload: {
        risk_monitor: true,
        verdict,
        composite,
        symbol: pos.symbol,
        asset_class: pos.asset_class,
        position_id: pos.id,
        ...extra,
      },
      triggeredBy: 'autopilot_cron',
    }).catch((e) => this.logger.debug(`[risk-monitor] audit ${pos.symbol}: ${String(e).slice(0, 100)}`));
  }
}
