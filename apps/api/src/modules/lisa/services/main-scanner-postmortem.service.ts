/**
 * MainScannerPostMortemService — apprentissage Gemini Pro sur le scanner gainers.
 *
 * Le scanner gainers est volontairement déterministe (cf. ADR P19). Il ne s'auto-
 * corrige pas. Cette classe comble le gap en :
 *   1. Collectant chaque nuit (cron 02:30 UTC) les closed trades 24h × 4 portfolios
 *      (MAIN + HIGH + MIDDLE + SMALL)
 *   2. Récupérant le funnel stats (gainers_user_shadow_signals) — quels gates ont bloqué quoi
 *   3. Récupérant le snapshot macro du jour (régime VIX/DXY/US10Y/HY OAS/etc.)
 *   4. Demandant à Gemini Pro de générer des lessons macro-conditionnelles
 *      ("Quand VIX>25 + Korea KOSDAQ + path_eff<0.5 → 100% perdants → désactiver"
 *      avec sample_size, win_rate, proposed_config_change)
 *   5. Persistant dans `scanner_lessons` (migration 0170)
 *
 * Gating ENV (default OFF) :
 *   - MAIN_SCANNER_POSTMORTEM_ENABLED=true
 *
 * Endpoint admin pour trigger manuel : POST /admin/scanner-postmortem/run
 * (utile pour tester sur la journée en cours sans attendre 02:30 UTC).
 *
 * Consumers à wirer (follow-up) :
 *   - GeminiRiskManager : inject scanner_lessons WHERE is_active=true dans system prompt
 *   - MacroVeto : idem
 *   - TopGainersScanner signal_quality validation : idem
 */

import { Injectable, Logger, Optional } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../../supabase/supabase.service';
import { ScannerLlmRouterService } from './scanner-llm-router.service';
import { LlmABShadowService } from './llm-ab-shadow.service';
import { postmortemComparator } from './llm-shadow-comparators';
import { LisaService } from './lisa.service';

const SCANNER_PORTFOLIO_IDS = [
  { id: 'b0000001-0000-0000-0000-000000000001', name: 'trader' }, // ex-MAIN 58439d86 migré 30/05/2026
  { id: 'a0000001-0000-0000-0000-000000000001', name: 'shadow_high' },
  { id: 'a0000002-0000-0000-0000-000000000002', name: 'shadow_middle' },
  { id: 'a0000003-0000-0000-0000-000000000003', name: 'shadow_small' },
];

/**
 * 02/06/2026 — Step 4 lessons-generator-mandatory-action.
 *
 * Lessons kinds qui DOIVENT produire un `proposed_config_change` actionnable
 * (avec target_path appartenant au whitelist VALID_TARGET_PATHS). Sinon
 * rejected par le parser (Gate 3).
 *
 * Pourquoi : audit 02/06 — 162 lessons unapplied dans scanner_lessons.
 * Sur les 7 candidates strictes (n≥30, conf≥0.85), 100% avaient
 * `proposed_config_change.target = no_target` → impossibles à auto-apply.
 * Le LLM générateur produit des observations narratives faute de contrainte.
 *
 * Lessons OBSERVATIONNELLES (risk_observation, trade_metrics,
 * portfolio_diagnostic, shape_pattern) peuvent rester sans proposed_config_change
 * — elles enrichissent le contexte LLM mais ne sont pas auto-appliquables.
 */
const ACTIONABLE_LESSON_KINDS: ReadonlySet<string> = new Set<string>([
  'gate_calibration',
  'session_filter',
  'sizing_rule',
  'exit_rule',
  'losing_pattern',
  'winning_pattern',
  'entry_discipline',
]);

/**
 * Whitelist des target_path acceptés par le parser (Gate 3) + par
 * LessonAutoApplyService. Synced avec LISA_SESSION_CONFIG_AUTO_APPLY_COLUMNS
 * + env vars listées dans le system prompt POST_MORTEM_SYSTEM_PROMPT.
 */
const VALID_TARGET_PATHS: ReadonlySet<string> = new Set<string>([
  // DB columns lisa_session_configs (synced avec LessonAutoApplyService)
  'gainers_default_sl_pct',
  'gainers_default_tp_pct',
  'gainers_min_persistence_score',
  'gainers_min_path_efficiency',
  'gainers_max_change_pct',
  'gainers_min_change_pct',
  'gainers_fees_aware_buffer',
  'gainers_position_pct',
  'gainers_cycle_minutes',
  'gainers_persistence_top_n',
  'news_shock_close_max_age_minutes_lse',
  'news_shock_close_sentiment_threshold_lse',
  // Env vars (auto-apply va skip avec manual_review_needed, mais on accepte
  // pour que la lesson soit créée propre avec target_path)
  'GAINERS_TRAILING_STOP_BREAKEVEN_ENABLED',
  'GAINERS_MIN_PATH_EFFICIENCY_US',
  'GAINERS_MIN_PATH_EFFICIENCY_EU',
  'GAINERS_MIN_PATH_EFFICIENCY_ASIA',
  'GAINERS_HOUR_BLACKLIST_US_UTC',
  'GAINERS_HOUR_BLACKLIST_EU_UTC',
  'GAINERS_HOUR_BLACKLIST_ASIA_UTC',
  'GAINERS_POST_SL_COOLDOWN_MIN',
  'GAINERS_EARNINGS_FILTER_DAYS',
  'GAINERS_MAX_CHANGE_PCT_LONG',
  'GAINERS_MAX_CHANGE_PCT_LONG_US_LARGE',
  'GAINERS_MAX_CHANGE_PCT_LONG_EU',
  'GAINERS_MAX_CHANGE_PCT_LONG_ASIA',
]);

const POST_MORTEM_SYSTEM_PROMPT = `Tu es un coach trader senior chargé d'analyser les trades du scanner momentum gainers de SmartVest. Le scanner est déterministe (calibrage via gates : persistence multi-TF, path efficiency, hour blacklist, ATR, anti-chase, etc.) — il ne s'auto-corrige pas. Ton job est d'identifier les patterns gagnants/perdants ET de proposer des AJUSTEMENTS CONCRETS de config.

OBJECTIF : générer 5-10 lessons actionnables qui éviteront que les mêmes pertes se reproduisent.

CONTRAINTES OBLIGATOIRES :
1. Chaque lesson DOIT contenir une macro_condition (ex: VIX>25, US10Y>4.5, REGIME_CALME, ASIA_LATE_SESSION, EU_OPEN_FIRST_HOUR, KOREA_KOSDAQ, SMALL_CAP)
2. Chaque lesson DOIT avoir sample_size ≥ 5 trades observés (sinon noise statistique → reject)
3. Préférer les patterns LOCAUX (asia_only, eu_only, par classe d'asset) plutôt que all_scanner
4. Si un pattern produit 100% pertes sur N≥5 trades → propose proposed_config_change concret

CONFIG AJUSTABLES (env vars ou DB column lisa_session_configs):
- GAINERS_TRAILING_STOP_BREAKEVEN_ENABLED (true/false) — trail BE à 0.05% post-pump
- GAINERS_MIN_PATH_EFFICIENCY_US/EU/ASIA (0-1) — refuse les chaotic moves
- gainers_min_persistence_score (0-1) — minimum TF persistents
- gainers_default_tp_pct / gainers_default_sl_pct (DB par portfolio)
- gainers_max_change_pct_<class> (anti-chase cap)
- gainers_min_change_pct_<class> (anti-noise floor)
- GAINERS_HOUR_BLACKLIST_<CLASS>_UTC (heures interdites par classe)
- GAINERS_POST_SL_COOLDOWN_MIN (cooldown après SL)
- GAINERS_EARNINGS_FILTER_DAYS

CATEGORIES (lesson_kind) — 2 GROUPES :

ACTIONABLES (proposed_config_change OBLIGATOIRE avec target_path valide) :
- losing_pattern : pattern qui produit ≥80% pertes sur N≥5 → action préventive (e.g. raise gate, ban hour)
- winning_pattern : pattern qui produit ≥70% gains sur N≥5 → action favorisante (e.g. lower gate)
- gate_calibration : ajustement seuil d'un gate existant
- session_filter : filtre temporel (heure/session) → hour blacklist
- sizing_rule : règle sizing par classe → cycle/notional/persistence_top_n
- exit_rule : règle sortie (stop, trail, TP) → sl_pct/tp_pct/trailing_breakeven
- entry_discipline : règle entry → min_change_pct/max_change_pct/persistence_score/path_efficiency

OBSERVATIONNELLES (proposed_config_change peut être null) :
- risk_observation : observation risque sans action immédiate (descriptif, alimente contexte LLM)

WHITELIST target_path (pour proposed_config_change) — Si tu ne peux pas mapper sur un de ces target_path concrets, n'émets PAS de lesson actionnable (mets risk_observation à la place) :

DB columns (lisa_session_configs):
- gainers_default_sl_pct (0.5..3.0)
- gainers_default_tp_pct (1.0..8.0)
- gainers_min_persistence_score (0..1)
- gainers_min_path_efficiency (0..1)
- gainers_max_change_pct, gainers_min_change_pct (par classe via suffixe non supporté ici)
- gainers_fees_aware_buffer (1.5..5.0)
- gainers_position_pct (0.01..0.10)
- gainers_cycle_minutes (1..60)
- gainers_persistence_top_n (5..100)
- news_shock_close_max_age_minutes_lse, news_shock_close_sentiment_threshold_lse

Env vars (acceptés mais nécessitent Fly Management API + redéploiement) :
- GAINERS_TRAILING_STOP_BREAKEVEN_ENABLED ("true"/"false")
- GAINERS_MIN_PATH_EFFICIENCY_US / _EU / _ASIA (0..1)
- GAINERS_HOUR_BLACKLIST_US_UTC / _EU_UTC / _ASIA_UTC (CSV "0,1,17")
- GAINERS_POST_SL_COOLDOWN_MIN (int)
- GAINERS_EARNINGS_FILTER_DAYS (int)
- GAINERS_MAX_CHANGE_PCT_LONG / _LONG_US_LARGE / _LONG_EU / _LONG_ASIA (number)

RÉPONSE JSON OBLIGATOIRE :
{
  "summary": "1-2 phrases résumé journée 4 portfolios + régime macro dominant",
  "macro_regime_today": "ex: VIX 22 (élevé), US10Y 4.45%, DXY 103, weekend US",
  "trades_total": <N>,
  "wins": <N>,
  "losses": <N>,
  "winning_patterns": ["pattern + chiffres + macro condition"],
  "losing_patterns": ["pattern + chiffres + macro condition"],
  "new_lessons": [
    {
      "lesson_kind": "losing_pattern|winning_pattern|gate_calibration|risk_observation|sizing_rule|exit_rule|session_filter|entry_discipline",
      "lesson_text": "Quand <CONDITION MACRO>, <ACTION CONCRÈTE> (référence: N trades, WR %, avg pnl)",
      "macro_condition": "VIX>25|US10Y>4.5|DXY>103|REGIME_CALME|ASIA_LATE_SESSION|EU_OPEN_FIRST_HOUR|KOREA_KOSDAQ|...",
      "scope": "all_scanner|main_only|shadows_only|asia_only|eu_only|us_only|crypto_only",
      "confidence": 0.0-1.0,
      "sample_size": N,
      "win_rate_observed": 0.0-100.0,
      "avg_pnl_usd": <num>,
      "proposed_config_change": { "<target_path_from_whitelist>": "<new_value>", "note": "<1 phrase pourquoi>" }
    }
  ]
}

FORMAT proposed_config_change — IMPORTANT :
La clé principale DOIT être un target_path EXACT du whitelist (ex: "gainers_min_persistence_score", "GAINERS_HOUR_BLACKLIST_US_UTC"). La valeur associée est la nouvelle valeur. Tu peux optionnellement ajouter "note" pour expliquer pourquoi.

Exemples valides :
  { "gainers_min_persistence_score": 0.75, "note": "+3 lessons consécutives WR<25% sur KOSDAQ" }
  { "GAINERS_HOUR_BLACKLIST_US_UTC": "17,18,19", "note": "post-lunch US chop n=22 WR 18%" }
  { "gainers_default_sl_pct": 1.8, "note": "MAE P85 1.99% — SL 1.5% prématuré" }

Exemples INVALIDES (parser rejette) :
  { "target": "x", "value": "y" }         ← clé "target" littérale au lieu du target_path
  { "min_score": 0.75 }                    ← target_path "min_score" pas dans whitelist
  { "gainers_max_change_pct_us_large": 8 } ← suffixe par classe non supporté ici

RÈGLE STRICTE : si tu choisis un lesson_kind ACTIONABLE mais ne peux pas mapper sur un target_path précis du whitelist, EMETS LA LESSON EN risk_observation à la place (avec proposed_config_change: null). Une lesson actionable sans target_path valide est REJETÉE par le parser server-side et perdue.`;

interface PostMortemPayload {
  date: string;
  macro: object;
  trades_by_portfolio: Record<string, Array<{
    symbol: string;
    portfolio: string;
    asset_class: string | null;
    entry_price: number;
    exit_price: number;
    entry_notional_usd: number;
    sl_pct: number | null;
    tp_pct: number | null;
    realized_pnl_usd: number;
    pnl_pct: number;
    hold_minutes: number;
    exit_reason: string;
    entry_timestamp: string;
    exit_timestamp: string;
  }>>;
  funnel_stats: object;
}

@Injectable()
export class MainScannerPostMortemService {
  private readonly logger = new Logger(MainScannerPostMortemService.name);
  private enabled = false;

  constructor(
    private readonly config: ConfigService,
    private readonly supabase: SupabaseService,
    private readonly llmRouter: ScannerLlmRouterService,
    private readonly lisa: LisaService,
    private readonly schedulerRegistry: SchedulerRegistry,
    // PR #523 — A/B shadow contre Flash + Mistral Medium/Large pour comparer
    // la qualité des lessons générées (cron 02:30 UTC daily, ~1 call/jour).
    @Optional() private readonly llmABShadow?: LlmABShadowService,
  ) {}

  onModuleInit(): void {
    // Default ON depuis 27/05/2026 — pipeline d'amélioration continue exige
    // régénération nightly automatique. Override possible via Fly secret
    // `MAIN_SCANNER_POSTMORTEM_ENABLED=false` pour désactiver en cas de bug.
    this.enabled =
      (this.config.get<string>('MAIN_SCANNER_POSTMORTEM_ENABLED') ?? 'true').toLowerCase() === 'true';
    this.logger.log(
      `[scanner-postmortem] onModuleInit fired — enabled=${this.enabled}`,
    );
    if (this.enabled) {
      // Registration manuelle via SchedulerRegistry (pattern TopGainersScanner / LiveTraderAgent).
      // 2 crons :
      //   - 02:30 UTC : full 24h post US close (baseline). Génère lessons pour le jour suivant.
      //   - 14:00 UTC : delta 12h post Asia+EU close (pré-US open). Propage lessons Asia/EU
      //     fraîches dans le prompt Gemini AVANT que les patterns ne contaminent la session US.
      //     Cadence alignée tempo TRADER scalp 5min (vs feedback loop 24h trop lent).
      try {
        const jobNightly = new CronJob('30 2 * * *', () => {
          this.runPostMortem(24).catch((e) =>
            this.logger.error(`[scanner-postmortem] cron 02:30 failed: ${String(e).slice(0, 200)}`),
          );
        });
        this.schedulerRegistry.addCronJob('main-scanner-postmortem', jobNightly);
        jobNightly.start();

        const jobMidday = new CronJob('0 14 * * *', () => {
          this.runPostMortem(12).catch((e) =>
            this.logger.error(`[scanner-postmortem] cron 14:00 failed: ${String(e).slice(0, 200)}`),
          );
        });
        this.schedulerRegistry.addCronJob('main-scanner-postmortem-midday', jobMidday);
        jobMidday.start();

        this.logger.log('[scanner-postmortem] ENABLED — crons 02:30 UTC (24h) + 14:00 UTC (12h)');
      } catch (e) {
        this.logger.error(`[scanner-postmortem] cron register failed: ${String(e).slice(0, 200)}`);
      }
    }
  }

  /**
   * Lance un post-mortem manuel sur les dernières N heures.
   * Appelable via cron OU endpoint admin /admin/scanner-postmortem/run.
   */
  async runPostMortem(windowHours: number = 24): Promise<{
    success: boolean;
    lessonsPersisted: number;
    rejectedNoMacro: number;
    rejectedSmallSample: number;
    rejectedNoActionableTarget: number;
    geminiCostUsd: number;
    error?: string;
  }> {
    if (!this.supabase.isReady()) {
      return { success: false, lessonsPersisted: 0, rejectedNoMacro: 0, rejectedSmallSample: 0, rejectedNoActionableTarget: 0, geminiCostUsd: 0, error: 'supabase not ready' };
    }
    if (!this.llmRouter.isEnabled()) {
      return { success: false, lessonsPersisted: 0, rejectedNoMacro: 0, rejectedSmallSample: 0, rejectedNoActionableTarget: 0, geminiCostUsd: 0, error: 'llm router disabled' };
    }

    const since = new Date(Date.now() - windowHours * 60 * 60_000);
    this.logger.log(`[scanner-postmortem] running for window ${since.toISOString()} → now`);

    // 1. Fetch closed trades 4 portfolios
    const tradesByPortfolio: Record<string, PostMortemPayload['trades_by_portfolio'][string]> = {};
    let totalTrades = 0;
    for (const p of SCANNER_PORTFOLIO_IDS) {
      const { data } = await this.supabase.getClient()
        .from('lisa_positions')
        .select('symbol, asset_class, entry_price, exit_price, entry_notional_usd, stop_loss_price, take_profit_price, realized_pnl_usd, exit_reason, entry_timestamp, exit_timestamp')
        .eq('portfolio_id', p.id)
        .neq('status', 'open')
        .gte('exit_timestamp', since.toISOString())
        .order('exit_timestamp', { ascending: true });
      const rows = (data ?? []).map((r) => {
        const entry = Number(r.entry_price);
        const exit = Number(r.exit_price);
        const sl = Number(r.stop_loss_price);
        const tp = Number(r.take_profit_price);
        const slPct = Number.isFinite(entry) && entry > 0 && Number.isFinite(sl) ? Number(((sl / entry - 1) * 100).toFixed(2)) : null;
        const tpPct = Number.isFinite(entry) && entry > 0 && Number.isFinite(tp) ? Number(((tp / entry - 1) * 100).toFixed(2)) : null;
        const pnlPct = Number.isFinite(entry) && entry > 0 && Number.isFinite(exit) ? Number(((exit / entry - 1) * 100).toFixed(2)) : 0;
        const holdMin = Math.round(
          (new Date(r.exit_timestamp as string).getTime() - new Date(r.entry_timestamp as string).getTime()) / 60000,
        );
        return {
          symbol: r.symbol as string,
          portfolio: p.name,
          asset_class: r.asset_class as string | null,
          entry_price: entry,
          exit_price: exit,
          entry_notional_usd: Number(r.entry_notional_usd ?? 0),
          sl_pct: slPct,
          tp_pct: tpPct,
          realized_pnl_usd: Number(r.realized_pnl_usd ?? 0),
          pnl_pct: pnlPct,
          hold_minutes: holdMin,
          exit_reason: String(r.exit_reason ?? '').slice(0, 200),
          entry_timestamp: r.entry_timestamp as string,
          exit_timestamp: r.exit_timestamp as string,
        };
      });
      tradesByPortfolio[p.name] = rows;
      totalTrades += rows.length;
    }

    if (totalTrades === 0) {
      this.logger.log('[scanner-postmortem] no trades in window, skip');
      return { success: true, lessonsPersisted: 0, rejectedNoMacro: 0, rejectedSmallSample: 0, rejectedNoActionableTarget: 0, geminiCostUsd: 0 };
    }

    // 2. Macro snapshot
    let macro: object;
    try {
      macro = await this.lisa.getRecentMarketSnapshot(180);
    } catch (e) {
      this.logger.warn(`[scanner-postmortem] macro fetch failed: ${String(e).slice(0, 100)}`);
      macro = { note: 'macro_snapshot_unavailable' };
    }

    // 3. Funnel stats (gainers_user_shadow_signals) — quelles gates ont bloqué quoi
    let funnelStats: object = {};
    try {
      const { data: funnel } = await this.supabase.getClient()
        .from('gainers_user_shadow_signals')
        .select('decision, asset_class')
        .gte('captured_at', since.toISOString());
      const agg: Record<string, Record<string, number>> = {};
      for (const r of funnel ?? []) {
        const cls = String(r.asset_class ?? 'unknown');
        const dec = String(r.decision ?? 'unknown');
        agg[cls] = agg[cls] ?? {};
        agg[cls][dec] = (agg[cls][dec] ?? 0) + 1;
      }
      funnelStats = { by_class: agg };
    } catch (e) {
      this.logger.warn(`[scanner-postmortem] funnel fetch failed: ${String(e).slice(0, 100)}`);
    }

    // 4. Build payload
    const payload: PostMortemPayload = {
      date: new Date().toISOString().slice(0, 10),
      macro,
      trades_by_portfolio: tradesByPortfolio,
      funnel_stats: funnelStats,
    };

    // 5. Call Gemini Pro
    let response: { content: string; providerId: string; costUsd: number; latencyMs: number };
    try {
      response = await this.llmRouter.callWithPro({
        system: POST_MORTEM_SYSTEM_PROMPT,
        user: JSON.stringify(payload, null, 2),
        temperature: 0.3,
        maxTokens: 8000,
        timeoutMs: 60_000,
      });
    } catch (e) {
      const errMsg = `LLM call failed: ${String(e).slice(0, 200)}`;
      this.logger.error(`[scanner-postmortem] ${errMsg}`);
      return { success: false, lessonsPersisted: 0, rejectedNoMacro: 0, rejectedSmallSample: 0, rejectedNoActionableTarget: 0, geminiCostUsd: 0, error: errMsg };
    }

    this.logger.log(
      `[scanner-postmortem] Gemini provider=${response.providerId} latency=${response.latencyMs}ms cost=$${response.costUsd.toFixed(4)}`,
    );

    // PR #523 — A/B shadow fire-and-forget contre Flash + Mistral Medium/Large.
    // Cron 02:30 UTC quotidien → 1 call/jour, coût additionnel shadows ~$0.05/jour.
    // Comparator sémantique Jaccard sur lessons[].macro_condition (fallback tokens
    // si JSON parse fail). Default text-match donnait 0% concordance.
    void this.llmABShadow?.recordShadow({
      callSite: 'scanner_postmortem',
      systemPrompt: POST_MORTEM_SYSTEM_PROMPT,
      userPrompt: JSON.stringify(payload, null, 2),
      applied: {
        providerId: response.providerId,
        content: response.content,
        costUsd: response.costUsd,
        latencyMs: response.latencyMs,
      },
      maxTokens: 8000,
      comparator: postmortemComparator,
    });

    if (!response.content || response.content.trim().length === 0) {
      const errMsg = 'Gemini returned empty content (thinking tokens exhausted?)';
      this.logger.error(`[scanner-postmortem] ${errMsg}`);
      return { success: false, lessonsPersisted: 0, rejectedNoMacro: 0, rejectedSmallSample: 0, rejectedNoActionableTarget: 0, geminiCostUsd: response.costUsd, error: errMsg };
    }

    // 6. Parse JSON
    let parsed: {
      summary?: string;
      macro_regime_today?: string;
      trades_total?: number;
      wins?: number;
      losses?: number;
      winning_patterns?: string[];
      losing_patterns?: string[];
      new_lessons?: Array<{
        lesson_kind: string;
        lesson_text: string;
        macro_condition?: string;
        scope?: string;
        confidence?: number;
        sample_size?: number;
        win_rate_observed?: number;
        avg_pnl_usd?: number;
        proposed_config_change?: object | null;
      }>;
    };
    try {
      const cleaned = response.content.trim().replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
      parsed = JSON.parse(cleaned);
    } catch (e) {
      const errMsg = `parse JSON failed: ${String(e).slice(0, 150)}`;
      this.logger.error(`[scanner-postmortem] ${errMsg} — raw start: ${response.content.slice(0, 300)}`);
      return { success: false, lessonsPersisted: 0, rejectedNoMacro: 0, rejectedSmallSample: 0, rejectedNoActionableTarget: 0, geminiCostUsd: response.costUsd, error: errMsg };
    }

    const newLessons = parsed.new_lessons ?? [];
    if (!Array.isArray(newLessons) || newLessons.length === 0) {
      this.logger.warn('[scanner-postmortem] no lessons returned by Gemini');
      return { success: true, lessonsPersisted: 0, rejectedNoMacro: 0, rejectedSmallSample: 0, rejectedNoActionableTarget: 0, geminiCostUsd: response.costUsd };
    }

    // 7. Validation + persistance
    const today = new Date().toISOString().slice(0, 10);
    let persisted = 0;
    let rejectedNoMacro = 0;
    let rejectedSmallSample = 0;
    let rejectedNoActionableTarget = 0;
    for (const l of newLessons) {
      // Gate 1 : macro_condition obligatoire
      const hasMacro = !!l.macro_condition && l.macro_condition.length > 0;
      const inlineMacro = /quand\b.*\b(vix|dxy|10y|hy|oas|gold|brent|usdjpy|regime|us10y|asia|eu|us|korea|kosdaq|crypto|session)/i.test(l.lesson_text);
      if (!hasMacro && !inlineMacro) {
        this.logger.warn(`[scanner-postmortem] reject macro-blind: ${l.lesson_text.slice(0, 100)}`);
        rejectedNoMacro++;
        continue;
      }
      // Gate 2 : sample_size ≥ 5
      const sampleSize = Number(l.sample_size ?? 0);
      if (!Number.isFinite(sampleSize) || sampleSize < 5) {
        this.logger.warn(`[scanner-postmortem] reject small-sample n=${sampleSize}: ${l.lesson_text.slice(0, 100)}`);
        rejectedSmallSample++;
        continue;
      }
      // Gate 3 (02/06/2026) : si lesson_kind ∈ ACTIONABLE, proposed_config_change
      // doit contenir au moins une clé qui est un target_path du whitelist VALID_TARGET_PATHS.
      // Sans cette gate, le LLM générateur produit des observations narratives taggées
      // 'gate_calibration' qui ne sont jamais auto-appliquées (162 lessons orphelines
      // observées 02/06). Risk_observation et autres OBSERVATIONNELLES restent libres
      // (proposed_config_change null OK).
      //
      // Format attendu (synced avec LessonAutoApplyService) :
      //   { "<target_path>": "<value>", "note": "<optional>" }
      // La clé EST le target. Méta-clés ('note', 'comment', 'table',
      // 'portfolio_id_only') sont ignorées pour la détection.
      if (ACTIONABLE_LESSON_KINDS.has(l.lesson_kind)) {
        const cc = l.proposed_config_change as Record<string, unknown> | null | undefined;
        const META_KEYS = new Set(['note', 'comment', 'reason', 'table', 'portfolio_id_only']);
        const validTargets = cc && typeof cc === 'object'
          ? Object.keys(cc).filter((k) => !META_KEYS.has(k.toLowerCase()) && VALID_TARGET_PATHS.has(k))
          : [];
        if (validTargets.length === 0) {
          const rawKeys = cc && typeof cc === 'object' ? Object.keys(cc).join(',') : 'null';
          this.logger.warn(
            `[scanner-postmortem] reject actionable lesson without valid target_path: kind=${l.lesson_kind} raw_keys='${rawKeys}' text="${l.lesson_text.slice(0, 100)}"`,
          );
          rejectedNoActionableTarget++;
          continue;
        }
      }
      try {
        await this.supabase.getClient().from('scanner_lessons').insert({
          derived_from_date: today,
          lesson_kind: l.lesson_kind,
          lesson_text: l.lesson_text,
          macro_condition: l.macro_condition ?? null,
          scope: l.scope ?? 'all_scanner',
          confidence: typeof l.confidence === 'number' ? Math.max(0, Math.min(1, l.confidence)) : 0.7,
          proposed_config_change: l.proposed_config_change ?? null,
          sample_size: sampleSize,
          win_rate_observed: typeof l.win_rate_observed === 'number' ? l.win_rate_observed : null,
          avg_pnl_usd: typeof l.avg_pnl_usd === 'number' ? l.avg_pnl_usd : null,
          payload: {
            summary: parsed.summary,
            macro_regime_today: parsed.macro_regime_today,
            trades_total: parsed.trades_total,
            wins: parsed.wins,
            losses: parsed.losses,
            winning_patterns: parsed.winning_patterns,
            losing_patterns: parsed.losing_patterns,
            llm_meta: { providerId: response.providerId, latencyMs: response.latencyMs, costUsd: response.costUsd },
          },
        });
        persisted++;
      } catch (e) {
        this.logger.warn(`[scanner-postmortem] insert failed: ${String(e).slice(0, 150)}`);
      }
    }

    this.logger.log(
      `[scanner-postmortem] done — persisted=${persisted} rejected_macro=${rejectedNoMacro} rejected_sample=${rejectedSmallSample} rejected_no_action_target=${rejectedNoActionableTarget}`,
    );
    return {
      success: true,
      lessonsPersisted: persisted,
      rejectedNoMacro,
      rejectedSmallSample,
      rejectedNoActionableTarget,
      geminiCostUsd: response.costUsd,
    };
  }

  /** Status pour endpoint admin */
  async getStatus(): Promise<object> {
    const { data: recent } = await this.supabase.getClient()
      .from('scanner_lessons')
      .select('id, created_at, derived_from_date, lesson_kind, lesson_text, macro_condition, scope, confidence, sample_size, win_rate_observed, avg_pnl_usd, applied, proposed_config_change')
      .eq('is_active', true)
      .order('created_at', { ascending: false })
      .limit(50);
    return {
      enabled: this.enabled,
      active_lessons: recent ?? [],
    };
  }
}
