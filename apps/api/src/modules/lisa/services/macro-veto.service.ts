/**
 * PR Action 3 — Macro Veto Service.
 *
 * Cron Lisa hourly qui produit un flag global `macro_allowed` consommé
 * par TopGainersScannerService.runScannerInner avant chaque cycle.
 *
 * Quand `macro_allowed = false` ET `GAINERS_MACRO_VETO_ENABLED=true`,
 * le scanner SKIP tous les opens (économie capital + protection des
 * journées risk-off où aucune stratégie momentum ne fonctionne).
 *
 * Inputs LLM (snapshot via LisaService.fetchMarketSnapshot) :
 *   - VIX (volatility index)
 *   - SPX intraday delta
 *   - DXY (dollar index)
 *   - US10Y yield
 *   - Sentiment des conditions
 *
 * Output structuré :
 *   { macro_allowed, regime, veto_reason, confidence }
 *
 * Persistance : table `macro_veto_log` (append-only, migration 0138).
 *
 * Fail-safe : si LLM échoue ET aucune décision récente (<2h) → default ALLOW
 * (fail-open : on préfère trader avec une mauvaise journée que rater une
 * bonne journée à cause d'une panne LLM).
 */

import { Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../../supabase/supabase.service';
import { LisaService } from './lisa.service';
import { ScannerLlmRouterService } from './scanner-llm-router.service';
import { ScannerLessonsContextService } from './scanner-lessons-context.service';

/** Décision LLM parsée. */
export interface MacroVetoDecision {
  macroAllowed: boolean;
  regime: 'risk_on' | 'risk_off' | 'transitioning' | 'uncertain';
  vetoReason: string | null;
  confidence: number;
  fallbackUsed: boolean;
}

/** Cache row de la dernière décision (évite re-fetch DB à chaque scanner cycle). */
interface CachedDecision {
  decision: MacroVetoDecision;
  fetchedAt: number;
}

/** Stale threshold : si la dernière décision a plus de 2h, on considère stale et fail-open. */
const STALE_DECISION_THRESHOLD_MS = 2 * 60 * 60 * 1000;

/** Cache TTL côté scanner pour réduire les hits DB (le scanner cycle est fréquent). */
const CACHE_TTL_MS = 60 * 1000;  // 60s, suffisant car le cron LLM tourne 1×/h

@Injectable()
export class MacroVetoService {
  private readonly logger = new Logger(MacroVetoService.name);
  private cache: CachedDecision | null = null;

  constructor(
    private readonly supabase: SupabaseService,
    private readonly config: ConfigService,
    private readonly lisa: LisaService,
    private readonly llmRouter: ScannerLlmRouterService,
    @Optional() private readonly lessonsContext?: ScannerLessonsContextService,
  ) {}

  /**
   * API principale : retourne la décision courante pour le scanner.
   *
   * - Si cache <60s : return cached
   * - Sinon : fetch DB la décision la plus récente
   * - Si DB vide ou stale (>2h) : fail-open (default = allow)
   *
   * **Ne déclenche PAS de call LLM** — c'est le rôle du cron.
   */
  async getCurrentFlag(): Promise<MacroVetoDecision> {
    const now = Date.now();
    if (this.cache && now - this.cache.fetchedAt < CACHE_TTL_MS) {
      return this.cache.decision;
    }

    try {
      const { data, error } = await this.supabase.getClient()
        .from('macro_veto_log')
        .select('macro_allowed, regime, veto_reason, confidence, created_at, fallback_used')
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      if (error || !data) {
        return this.failOpenDefault('no_recent_decision');
      }

      const ageMs = now - new Date(data.created_at as string).getTime();
      if (ageMs > STALE_DECISION_THRESHOLD_MS) {
        this.logger.warn(`[macro-veto] last decision is ${Math.floor(ageMs / 60000)}min old (>2h) — fail-open default allow`);
        return this.failOpenDefault('stale_decision');
      }

      const decision: MacroVetoDecision = {
        macroAllowed: Boolean(data.macro_allowed),
        regime: String(data.regime) as MacroVetoDecision['regime'],
        vetoReason: (data.veto_reason as string | null) ?? null,
        confidence: Number(data.confidence),
        fallbackUsed: Boolean(data.fallback_used),
      };
      this.cache = { decision, fetchedAt: now };
      return decision;
    } catch (e) {
      this.logger.warn(`[macro-veto] getCurrentFlag failed: ${String(e).slice(0, 120)} — fail-open`);
      return this.failOpenDefault('exception');
    }
  }

  /** Default safe : tout autoriser. Évite de bloquer le trading sur une panne. */
  private failOpenDefault(reason: string): MacroVetoDecision {
    const decision: MacroVetoDecision = {
      macroAllowed: true,
      regime: 'uncertain',
      vetoReason: null,
      confidence: 0,
      fallbackUsed: true,
    };
    this.cache = { decision, fetchedAt: Date.now() };
    if (reason !== 'no_recent_decision') {
      this.logger.log(`[macro-veto] fail-open: ${reason}`);
    }
    return decision;
  }

  /**
   * Cron Lisa hourly — appelle le LLM, persiste la décision en DB, invalide cache.
   *
   * Tourne en début d'heure UTC. Si LLM router désactivé OU snapshot fail
   * → write fail-open allow row.
   */
  @Cron('0 * * * *', { name: 'macro-veto-hourly', timeZone: 'UTC' })
  async runHourlyDecision(): Promise<void> {
    const enabled = (this.config.get<string>('GAINERS_MACRO_VETO_ENABLED') ?? 'false').toLowerCase() === 'true';
    if (!enabled) {
      this.logger.debug('[macro-veto] cron skipped — GAINERS_MACRO_VETO_ENABLED=false');
      return;
    }

    let snapshot: Awaited<ReturnType<LisaService['fetchMarketSnapshot']>> | null = null;
    try {
      snapshot = await this.lisa.fetchMarketSnapshot();
    } catch (e) {
      this.logger.warn(`[macro-veto] fetchMarketSnapshot failed: ${String(e).slice(0, 120)} — write allow row`);
      await this.persistFailOpen('snapshot_fetch_failed', null);
      return;
    }

    const llmAvailable = this.llmRouter.isEnabled();
    if (!llmAvailable) {
      this.logger.warn('[macro-veto] scanner-llm router not enabled — write allow row (no LLM, no veto)');
      await this.persistFailOpen('llm_router_disabled', snapshot);
      return;
    }

    try {
      const decision = await this.callLlm(snapshot);
      await this.persistDecision(decision, snapshot);
      this.cache = null;  // invalider cache pour next getCurrentFlag()
      this.logger.log(
        `[macro-veto] hourly decision: allowed=${decision.macroAllowed} regime=${decision.regime} ` +
        `confidence=${decision.confidence.toFixed(2)} reason="${decision.vetoReason ?? 'n/a'}" ` +
        `fallback=${decision.fallbackUsed}`,
      );
    } catch (e) {
      this.logger.warn(`[macro-veto] LLM call failed: ${String(e).slice(0, 200)} — write allow row`);
      await this.persistFailOpen('llm_call_failed', snapshot);
    }
  }

  /**
   * Construit le prompt + appelle le LLM router. Parse la réponse JSON.
   * Si parsing fail OU réponse incoherente → fallback allow.
   */
  private async callLlm(snapshot: Awaited<ReturnType<LisaService['fetchMarketSnapshot']>>): Promise<MacroVetoDecision & { llmCostUsd: number; llmLatencyMs: number; llmProvider: string; rawResponse: string }> {
    // Phase 3 — inject scanner_lessons (lessons macro-conditionnelles).
    const lessonsBlock = this.lessonsContext
      ? await this.lessonsContext.getLessonsBlock('all_scanner').catch(() => '')
      : '';
    const baseSystem = `Tu es un analyste macro-financier conservateur. Ton job est de déterminer si les conditions macro courantes sont compatibles avec une stratégie momentum intraday sur small/mid-cap actions et crypto.

Output STRICT au format JSON :
{
  "macro_allowed": true | false,
  "regime": "risk_on" | "risk_off" | "transitioning" | "uncertain",
  "veto_reason": "<courte explication, null si allowed>",
  "confidence": <0.0 à 1.0>
}

RÈGLES STRICTES :
- macro_allowed = false si VIX > 25 OU drawdown SPX > -2% intraday OU US10Y bondit >0.15% en 1h
- macro_allowed = false si breaking news majeure (FED rate decision, geopolitical shock)
- macro_allowed = true par défaut (fail-open) — ne veto QUE quand la conviction est haute
- confidence haute (>0.7) seulement quand le signal est franc, pas borderline`;
    const system = lessonsBlock ? `${baseSystem}\n\n${lessonsBlock}` : baseSystem;

    const user = `Indicateurs macro courants :
- VIX : ${snapshot.vix.toFixed(1)}
- SPX (S&P 500) : ${snapshot.sp500.toFixed(1)}
- DXY (dollar index) : ${snapshot.usdDxy.toFixed(1)}
- US 10Y yield : ${snapshot.us10yYield.toFixed(2)}%
- US 2Y yield : ${snapshot.us2yYield.toFixed(2)}%
- Brent : $${snapshot.brentUsd.toFixed(1)}
- Gold : $${snapshot.goldUsd.toFixed(0)}
- BTC : $${snapshot.btcUsd.toFixed(0)}
- HY OAS spread : ${snapshot.creditHyOasBps}bps
- Timestamp : ${snapshot.timestamp}

Décision macro veto pour la prochaine heure de trading ?`;

    const result = await this.llmRouter.call({
      system,
      user,
      temperature: 0.2,
      maxTokens: 200,
      timeoutMs: 8000,
    });

    // Parse JSON response
    const cleaned = result.content.trim().replace(/^```json\s*/i, '').replace(/\s*```$/i, '');
    let parsed: unknown;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      throw new Error(`LLM response not valid JSON: ${result.content.slice(0, 200)}`);
    }

    // Validate shape
    const p = parsed as Record<string, unknown>;
    const macroAllowed = typeof p.macro_allowed === 'boolean' ? p.macro_allowed : true;
    const regime = ['risk_on', 'risk_off', 'transitioning', 'uncertain'].includes(String(p.regime))
      ? (p.regime as MacroVetoDecision['regime'])
      : 'uncertain';
    const vetoReason = typeof p.veto_reason === 'string' ? p.veto_reason : null;
    const confidence = typeof p.confidence === 'number' && p.confidence >= 0 && p.confidence <= 1
      ? p.confidence
      : 0.5;

    return {
      macroAllowed,
      regime,
      vetoReason: macroAllowed ? null : vetoReason,
      confidence,
      fallbackUsed: false,
      llmCostUsd: result.costUsd,
      llmLatencyMs: result.latencyMs,
      llmProvider: result.providerId,
      rawResponse: result.content,
    };
  }

  /** Persiste une décision LLM réussie. */
  private async persistDecision(
    decision: MacroVetoDecision & { llmCostUsd: number; llmLatencyMs: number; llmProvider: string; rawResponse: string },
    snapshot: Awaited<ReturnType<LisaService['fetchMarketSnapshot']>>,
  ): Promise<void> {
    await this.supabase.getClient().from('macro_veto_log').insert({
      macro_allowed: decision.macroAllowed,
      regime: decision.regime,
      veto_reason: decision.vetoReason,
      confidence: decision.confidence,
      vix: snapshot.vix,
      spx_change_pct: null,  // Calc côté caller si besoin (pas dans snapshot direct)
      dxy: snapshot.usdDxy,
      us10y_yield: snapshot.us10yYield,
      llm_provider: decision.llmProvider,
      llm_cost_usd: decision.llmCostUsd,
      llm_latency_ms: decision.llmLatencyMs,
      llm_raw_response: decision.rawResponse.slice(0, 4000),
      fallback_used: false,
    });
  }

  /** Persiste un fail-open (LLM fail ou disabled). Toujours allow. */
  private async persistFailOpen(
    reason: string,
    snapshot: Awaited<ReturnType<LisaService['fetchMarketSnapshot']>> | null,
  ): Promise<void> {
    await this.supabase.getClient().from('macro_veto_log').insert({
      macro_allowed: true,
      regime: 'uncertain',
      veto_reason: null,
      confidence: 0,
      vix: snapshot?.vix ?? null,
      spx_change_pct: null,
      dxy: snapshot?.usdDxy ?? null,
      us10y_yield: snapshot?.us10yYield ?? null,
      llm_provider: 'fallback_deterministic',
      llm_cost_usd: 0,
      llm_latency_ms: 0,
      llm_raw_response: `fail_open: ${reason}`,
      fallback_used: true,
    }).then(() => undefined, (e) => {
      this.logger.warn(`[macro-veto] persistFailOpen DB write failed: ${String(e).slice(0, 120)}`);
    });
    this.cache = null;
  }
}
