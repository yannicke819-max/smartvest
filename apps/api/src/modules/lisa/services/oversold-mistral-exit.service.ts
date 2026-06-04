/**
 * OversoldMistralExitService — gain-picker LLM pour les positions oversold.
 *
 * Idée user 04/06/2026 : la méthode manuelle de l'user (close sur rebond intelligent
 * en temps réel) capte les outliers gagnants qu'un J+10 systématique dilue. On
 * automatise ce job avec Mistral, EN PARALLÈLE de l'OversoldExitService déterministe
 * qui reste comme filet (J+10 hard + stop catastrophe -15%).
 *
 * Pas une sortie LLM "à la place" mais "en plus" :
 *   - Mistral check toutes les 30 min : "y a-t-il une bonne raison de clore MAINTENANT
 *     plutôt que d'attendre J+10 ?" → si oui (confidence ≥ seuil) → close
 *   - Sinon : laisse tourner, OversoldExitService gère le J+10 mécanique
 *   - Stop -15% reste actif via OversoldExitService (le filet en bas)
 *
 * Économie LLM :
 *   - MFE skip : si MFE < seuil (default 1.5%), on ne brûle pas Mistral. Pas de
 *     gain à locker = pas d'évaluation. Le filet J+10 / -15% suffit.
 *   - Politique apprise injectée : Mistral lit les closes GOOD/EARLY déjà labelisés
 *     (`OversoldExitPolicyService` qui distille `position_close_decisions` filtré sur
 *     source=scanner_oversold). Cold start = MIN_SAMPLE=20, sous ce seuil les
 *     heuristiques par défaut prennent le pas.
 *
 * Activation : env `OVERSOLD_MISTRAL_EXIT_ENABLED` (default `false`, opt-in).
 */

import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../../supabase/supabase.service';
import { LisaService } from './lisa.service';
import { DecisionLogService } from './decision-log.service';
import { ScannerLlmRouterService } from './scanner-llm-router.service';
import { CloseDecisionCaptureService } from './close-decision-capture.service';
import { OversoldExitPolicyService } from './research/oversold-exit-policy.service';
import { businessDaysSince } from './oversold.helper';

interface OpenOversoldRow {
  id: string;
  portfolio_id: string;
  symbol: string;
  direction: string;
  asset_class: string | null;
  entry_price: string;
  entry_timestamp: string;
  take_profit_price: string | null;
  stop_loss_price: string | null;
}

interface MistralExitVerdict {
  action: 'HOLD' | 'CLOSE';
  confidence: number;
  rationale: string;
}

const SYSTEM_PROMPT = `Tu es un trader mean-reversion qui gère un livre de positions oversold (entrées sur drop -5% à -12%, horizon swing J+10). Ton seul rôle : décider de FERMER MAINTENANT ou ATTENDRE pour CHAQUE position évaluée.

CONTEXTE STRATÉGIQUE :
- Edge prouvé statistiquement (t=4.1, N=1416) = hold J+10 systématique donne alpha +1.4% vs SPY.
- MAIS la stat est une moyenne. Les outliers gagnants méritent d'être lockés en gain plutôt que dilués par un hold passif.
- Un filet mécanique J+10 + stop -15% est DÉJÀ en place. Ton job = locker les gains intelligemment AVANT.

RÈGLE DE DÉCISION :
- CLOSE quand : rebond solide capté (MFE significatif), momentum qui se retourne, give-back qui s'aggrave, indicateurs sur-achetés, news shock contraire imminente.
- HOLD quand : rebond pas encore mature, MFE faible, momentum encore positif, marge avant TP statistique attendu.

FORMAT RÉPONSE (JSON strict, rien d'autre) :
{"action":"HOLD"|"CLOSE","confidence":0.0-1.0,"rationale":"<60 chars max>"}

confidence ≥ 0.65 = conviction suffisante pour clore. En dessous, garde HOLD par défaut.`;

@Injectable()
export class OversoldMistralExitService {
  private readonly logger = new Logger(OversoldMistralExitService.name);
  private readonly FETCH_TIMEOUT_MS = 8000;

  constructor(
    private readonly config: ConfigService,
    private readonly supabase: SupabaseService,
    private readonly lisa: LisaService,
    private readonly decisionLog: DecisionLogService,
    private readonly llmRouter: ScannerLlmRouterService,
    private readonly exitPolicy: OversoldExitPolicyService,
    private readonly closeCapture: CloseDecisionCaptureService,
  ) {}

  private isEnabled(): boolean {
    return (this.config.get<string>('OVERSOLD_MISTRAL_EXIT_ENABLED') ?? 'false').toLowerCase() === 'true';
  }

  private minMfePct(): number {
    return Number(this.config.get<string>('OVERSOLD_MISTRAL_EXIT_MIN_MFE_PCT') ?? '1.5');
  }

  private confidenceThreshold(): number {
    return Number(this.config.get<string>('OVERSOLD_MISTRAL_EXIT_CONFIDENCE_MIN') ?? '0.65');
  }

  /**
   * Cron toutes les 15 minutes. Plus réactif que l'OversoldExitService déterministe
   * (30min) pour capter les rebonds intelligents en cours de journée. Coût LLM
   * borné par MFE skip (positions underwater = pas évaluées).
   */
  @Cron('0 */15 * * * *', { name: 'oversold-mistral-exit', timeZone: 'UTC' })
  async runExitCycle(): Promise<void> {
    try {
      if (!this.isEnabled()) {
        this.logger.debug('[oversold-mistral-exit] OVERSOLD_MISTRAL_EXIT_ENABLED=false → skip');
        return;
      }
      const positions = await this.loadOpenPositions();
      if (positions.length === 0) return;

      const policyCache = new Map<string, string>();
      let evaluated = 0;
      let closed = 0;
      let skippedMfe = 0;

      for (const pos of positions) {
        try {
          const result = await this.evaluatePosition(pos, policyCache);
          if (result === 'closed') closed++;
          else if (result === 'evaluated') evaluated++;
          else if (result === 'skipped_mfe') skippedMfe++;
        } catch (err) {
          this.logger.warn(
            `[oversold-mistral-exit] ${pos.symbol} (${pos.id.slice(0, 8)}) échoué: ${String(err).slice(0, 200)}`,
          );
        }
      }

      this.logger.log(
        `[oversold-mistral-exit] cycle done — positions=${positions.length} evaluated=${evaluated} closed=${closed} skipped_mfe=${skippedMfe}`,
      );
    } catch (err) {
      this.logger.error(`[oversold-mistral-exit] runExitCycle exception: ${String(err).slice(0, 300)}`);
    }
  }

  private async evaluatePosition(
    pos: OpenOversoldRow,
    policyCache: Map<string, string>,
  ): Promise<'closed' | 'evaluated' | 'skipped_mfe' | 'skipped_no_price'> {
    const price = await this.fetchLastClose(pos.symbol);
    if (price == null) return 'skipped_no_price';

    const entry = parseFloat(pos.entry_price);
    if (!Number.isFinite(entry) || entry <= 0) return 'skipped_no_price';

    const sign = pos.direction === 'short' ? -1 : 1;
    const unrealPnlPct = ((price - entry) / entry) * 100 * sign;
    const ageDays = businessDaysSince(pos.entry_timestamp, new Date());

    // MFE depuis le snapshot tracker (le plus fiable). Fallback PnL courant si absent.
    const { data: snap } = await this.supabase.getClient()
      .from('position_indicators_snapshot')
      .select('mfe_pct, mae_pct')
      .eq('position_id', pos.id)
      .order('captured_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    const mfePct = (snap?.mfe_pct as number | null) ?? unrealPnlPct;
    const maePct = (snap?.mae_pct as number | null) ?? unrealPnlPct;
    const giveBack = mfePct - unrealPnlPct;

    // MFE skip : on ne brûle pas Mistral sur une position underwater ou MFE faible.
    if (mfePct < this.minMfePct()) {
      return 'skipped_mfe';
    }

    // Politique apprise (cache par portfolio dans cette boucle pour éviter N appels).
    let policyBlock = policyCache.get(pos.portfolio_id);
    if (policyBlock === undefined) {
      const policy = await this.exitPolicy.getLearnedPolicy(pos.portfolio_id).catch(() => null);
      policyBlock = policy?.promptBlock ?? '';
      policyCache.set(pos.portfolio_id, policyBlock);
    }

    const userPrompt = JSON.stringify({
      symbol: pos.symbol,
      asset_class: pos.asset_class,
      direction: pos.direction,
      entry_price: entry,
      current_price: price,
      unrealized_pnl_pct: Number(unrealPnlPct.toFixed(2)),
      mfe_pct: Number(mfePct.toFixed(2)),
      mae_pct: Number(maePct.toFixed(2)),
      give_back_pct: Number(giveBack.toFixed(2)),
      held_business_days: ageDays,
      hold_target_days: 10,
      days_remaining: Math.max(0, 10 - ageDays),
      learned_policy: policyBlock || '(échantillon insuffisant — heuristique défaut)',
    });

    const resp = await this.llmRouter.call({
      system: SYSTEM_PROMPT,
      user: userPrompt,
      temperature: 0.2,
      maxTokens: 200,
      timeoutMs: 8000,
    }).catch((e) => {
      this.logger.debug(`[oversold-mistral-exit] LLM ${pos.symbol} err: ${String(e).slice(0, 150)}`);
      return null;
    });

    if (!resp || !resp.content) return 'evaluated';

    const verdict = this.parseVerdict(resp.content);
    if (!verdict) {
      this.logger.debug(`[oversold-mistral-exit] ${pos.symbol} parse failed: ${resp.content.slice(0, 100)}`);
      return 'evaluated';
    }

    this.logger.log(
      `[oversold-mistral-exit] ${pos.symbol} pnl=${unrealPnlPct.toFixed(2)}% mfe=${mfePct.toFixed(2)}% age=J+${ageDays} → ${verdict.action} (conf=${verdict.confidence.toFixed(2)}) ${verdict.rationale}`,
    );

    if (verdict.action === 'CLOSE' && verdict.confidence >= this.confidenceThreshold()) {
      await this.closePosition(pos, price, mfePct, unrealPnlPct, ageDays, verdict);
      return 'closed';
    }

    return 'evaluated';
  }

  private async closePosition(
    pos: OpenOversoldRow,
    price: number,
    mfePct: number,
    unrealPnlPct: number,
    ageDays: number,
    verdict: MistralExitVerdict,
  ): Promise<void> {
    const rationale = `[oversold_mistral_gain_pick] ${verdict.rationale} — pnl=${unrealPnlPct.toFixed(2)}% mfe=${mfePct.toFixed(2)}% J+${ageDays}/10 conf=${verdict.confidence.toFixed(2)}`;

    const result = await this.lisa.getPaperBroker().closePosition({
      positionId: pos.id,
      reason: 'closed_target',
      livePrice: String(price),
      rationale,
      livePriceSource: 'eodhd_eod',
      marketClosed: true,
    });

    // Apprentissage long terme — closerType custom pour distinguer des user_manual
    // (= permettra plus tard d'évaluer la qualité de Mistral vs l'humain).
    const ageMin = (Date.now() - new Date(pos.entry_timestamp).getTime()) / 60_000;
    this.closeCapture.captureClose({
      positionId: pos.id,
      portfolioId: pos.portfolio_id,
      symbol: pos.symbol,
      direction: pos.direction,
      assetClass: pos.asset_class,
      closerType: 'risk_monitor',
      entryPrice: parseFloat(pos.entry_price),
      exitPrice: price,
      pnlPct: result.realizedPnlPct ?? null,
      pnlUsd: result.realizedPnlUsd != null ? Number(result.realizedPnlUsd) : null,
      ageMinutes: Number.isFinite(ageMin) ? ageMin : 0,
      takeProfitPrice: pos.take_profit_price != null ? Number(pos.take_profit_price) : null,
      stopLossPrice: pos.stop_loss_price != null ? Number(pos.stop_loss_price) : null,
    });

    await this.decisionLog.append({
      portfolioId: pos.portfolio_id,
      kind: 'oversold_mistral_gain_pick',
      summary: `Mistral close ${pos.symbol} @ $${price.toFixed(4)} (pnl=${unrealPnlPct.toFixed(2)}%, J+${ageDays})`,
      rationale,
      payload: {
        symbol: pos.symbol,
        position_id: pos.id,
        exit_price: price,
        entry_price: parseFloat(pos.entry_price),
        mfe_pct: mfePct,
        unrealized_pnl_pct: unrealPnlPct,
        held_business_days: ageDays,
        mistral_action: verdict.action,
        mistral_confidence: verdict.confidence,
        mistral_rationale: verdict.rationale,
      },
      triggeredBy: 'autopilot_cron',
      watchlistSource: 'mechanical',
      market: 'us_equity',
    }).catch((e) => this.logger.warn(`[oversold-mistral-exit] decision_log append failed: ${String(e).slice(0, 160)}`));
  }

  private parseVerdict(content: string): MistralExitVerdict | null {
    try {
      const cleaned = content.trim().replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
      const parsed = JSON.parse(cleaned) as Partial<MistralExitVerdict>;
      const action = parsed.action === 'CLOSE' || parsed.action === 'HOLD' ? parsed.action : null;
      const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : NaN;
      const rationale = typeof parsed.rationale === 'string' ? parsed.rationale : '';
      if (!action || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) return null;
      return { action, confidence, rationale: rationale.slice(0, 200) };
    } catch {
      return null;
    }
  }

  private async loadOpenPositions(): Promise<OpenOversoldRow[]> {
    const { data, error } = await this.supabase.getClient()
      .from('lisa_positions')
      .select('id, portfolio_id, symbol, direction, asset_class, entry_price, entry_timestamp, take_profit_price, stop_loss_price')
      .eq('venue_fee_detail->>source', 'scanner_oversold')
      .eq('status', 'open');
    if (error) {
      this.logger.warn(`[oversold-mistral-exit] load positions failed: ${error.message}`);
      return [];
    }
    return (data ?? []) as unknown as OpenOversoldRow[];
  }

  private async fetchLastClose(symbol: string): Promise<number | null> {
    const apiKey = this.config.get<string>('EODHD_API_KEY');
    if (!apiKey) return null;
    const to = new Date();
    const from = new Date(to.getTime() - 8 * 86_400_000);
    const fromStr = from.toISOString().slice(0, 10);
    const toStr = to.toISOString().slice(0, 10);
    const url =
      `https://eodhd.com/api/eod/${encodeURIComponent(symbol)}` +
      `?from=${fromStr}&to=${toStr}&api_token=${apiKey}&fmt=json`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) return null;
      const json = (await res.json()) as Array<Record<string, unknown>>;
      if (!Array.isArray(json) || json.length === 0) return null;
      const sorted = json
        .map((b) => ({
          date: String(b.date ?? ''),
          close: Number(b.close ?? b.adjusted_close ?? NaN),
        }))
        .filter((b) => b.date.length > 0 && Number.isFinite(b.close) && b.close > 0)
        .sort((a, b) => a.date.localeCompare(b.date));
      if (sorted.length === 0) return null;
      return sorted[sorted.length - 1].close;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}
