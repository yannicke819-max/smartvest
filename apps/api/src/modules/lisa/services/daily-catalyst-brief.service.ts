/**
 * DailyCatalystBriefService — couche d'intelligence dynamique via Gemini.
 *
 * Rationale : le scanner gainers est 100% mécanique (changePct + persistance +
 * pathQuality). Il ne sait pas que mercredi 28/05 le PCE sort, que SNOW
 * publie ses résultats mardi, que Memorial Day ferme NYSE lundi. Cette info
 * macro/calendaire évolue chaque jour et doit s'injecter dans la boucle SANS
 * casser le scanner mécanique existant.
 *
 * Architecture : 1 appel Gemini Flash Lite/jour (~$0.0001) à 04:00 UTC, avant
 * que l'Asie ouvre. Brief JSON structuré stocké dans lisa_decision_log (pas
 * de migration). Lisible via GET /lisa/daily-catalyst-brief.
 *
 * Phase 1 (cette PR) : brief informationnel uniquement. Le scanner n'est PAS
 * modifié — zéro risque de casser quoi que ce soit. L'utilisateur lit le brief
 * et peut décider manuellement (kill switch, durcir les seuils, etc.).
 *
 * Phase 2 (future PR, opt-in) : le scanner consultera le brief pour
 * boost/penalty de score (env-gated, default off).
 *
 * Activation : GEMINI_DAILY_BRIEF_ENABLED=true + GEMINI_API_KEY défini +
 * SCANNER_LLM_ROUTER_ENABLED=true.
 */

import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../../supabase/supabase.service';
import { ScannerLlmRouterService } from './scanner-llm-router.service';
import { EodhdEconomicEventsService } from './eodhd-economic-events.service';

export interface DailyCatalystBrief {
  date: string;
  macro_events?: Array<{ time_utc?: string; event: string; impact?: 'high' | 'medium' | 'low' }>;
  tickers_to_watch?: Array<{ ticker: string; reason: string; type?: 'earnings' | 'catalyst' | 'sector_theme' }>;
  tickers_to_avoid?: Array<{ ticker: string; reason: string; type?: 'post_event' | 'regulatory' | 'risk' }>;
  sectors_in_focus?: string[];
  summary: string;
}

const SYSTEM_PROMPT = `You are a financial markets analyst producing a daily catalyst brief for an automated momentum trading system.

You will receive VERIFIED economic events from EODHD calendar as CONTEXT.
DO NOT invent additional events. Your job is to SYNTHESIZE and STRUCTURE the
verified data, adding sector context where useful (semis, consumer, energy…).

Output STRICT JSON matching this schema (no markdown, no backticks):
{
  "date": "YYYY-MM-DD",
  "macro_events": [{"time_utc":"HH:MM","event":"...","impact":"high|medium|low"}],
  "tickers_to_watch": [{"ticker":"AAPL.US","reason":"...","type":"earnings|catalyst|sector_theme"}],
  "tickers_to_avoid": [{"ticker":"X.US","reason":"...","type":"post_event|regulatory|risk"}],
  "sectors_in_focus": ["semis","consumer discretionary"],
  "summary": "2-3 phrases max"
}

Rules:
- Use ONLY events from the VERIFIED EVENTS section provided in the user message.
- If VERIFIED EVENTS is empty, still produce a brief but be explicit in summary
  that no high-impact events are scheduled.
- Tickers MUST use EODHD suffix format: US (AAPL.US), LSE (BARC.LSE), PA (MC.PA),
  DE (SAP.DE), KO (005930.KO), SHG (600519.SHG), SHE (000001.SHE), HK (0700.HK),
  T (7203.T). Crypto: BTCUSDT, ETHUSDT.
- Be concise. Max 5 entries per list. No fluff.
- For "tickers_to_watch" / "tickers_to_avoid", use sector/macro reasoning only
  (e.g. "PCE Wednesday → rate-sensitive techs in focus"). Never invent specific
  earnings dates not in the verified context.`;

@Injectable()
export class DailyCatalystBriefService {
  private readonly logger = new Logger(DailyCatalystBriefService.name);
  private readonly enabled: boolean;

  constructor(
    private readonly config: ConfigService,
    private readonly supabase: SupabaseService,
    private readonly llm: ScannerLlmRouterService,
    private readonly economicEvents: EodhdEconomicEventsService,
  ) {
    this.enabled = (this.config.get<string>('GEMINI_DAILY_BRIEF_ENABLED') ?? 'false').toLowerCase() === 'true';
    if (this.enabled) this.logger.log('[daily-brief] enabled — cron 04:00 UTC daily');
  }

  /** 04:00 UTC daily — avant ouverture Asie (06:00 KRX, 01:30 HK, 00:00 T). */
  @Cron('0 4 * * *', { timeZone: 'UTC' })
  async cronDailyBrief(): Promise<void> {
    if (!this.enabled) return;
    try {
      await this.generateAndPersistBrief();
    } catch (e) {
      this.logger.warn(`[daily-brief] cron failed: ${String(e).slice(0, 200)}`);
    }
  }

  async generateAndPersistBrief(): Promise<DailyCatalystBrief | null> {
    const today = new Date().toISOString().slice(0, 10);

    // Grounding : injecter les economic events vérifiés EODHD (anti-hallucination).
    const upcoming = await this.economicEvents.getUpcomingEvents(48).catch(() => []);
    const verifiedSection = upcoming.length > 0
      ? upcoming
          .map((e) => `- ${e.event_date.slice(0, 16).replace('T', ' ')} UTC | ${e.country} | ${e.event_name}${e.importance ? ` (importance=${e.importance})` : ''}`)
          .join('\n')
      : '(no high/medium-impact macro events in the next 48h per EODHD calendar)';

    const userPrompt =
      `Today is ${today} (UTC). Produce the catalyst brief for the next 24-48h trading window. ` +
      `Cover US, EU (LSE/Euronext/XETRA), Asia (Korea/HK/Japan/China) and crypto majors. ` +
      `Output strict JSON only.\n\n` +
      `## VERIFIED EVENTS (source: EODHD economic-events API, do not invent more)\n` +
      verifiedSection;

    let llmResult;
    try {
      llmResult = await this.llm.call({
        system: SYSTEM_PROMPT,
        user: userPrompt,
        temperature: 0.2,
        maxTokens: 1200,
        timeoutMs: 15000,
      });
    } catch (e) {
      this.logger.warn(`[daily-brief] llm call failed: ${String(e).slice(0, 200)}`);
      return null;
    }

    const brief = this.parseBriefJson(llmResult.content, today);
    if (!brief) {
      this.logger.warn(`[daily-brief] could not parse JSON from llm content (len=${llmResult.content.length})`);
      return null;
    }

    if (!this.supabase.isReady()) {
      this.logger.warn('[daily-brief] supabase not ready, skipping persist');
      return brief;
    }

    // FIX: lisa_decision_log.portfolio_id est NOT NULL → on insère 1 ligne par
    // portfolio en mode gainers actif. Sans ça, l'insert échouait silencieusement
    // et getLatestBrief retournait toujours null malgré que Gemini réponde.
    const { data: portfolios, error: cfgErr } = await this.supabase
      .getClient()
      .from('lisa_session_configs')
      .select('portfolio_id')
      .eq('strategy_mode', 'gainers')
      .eq('autopilot_enabled', true);
    if (cfgErr) {
      this.logger.warn(`[daily-brief] cannot list gainers portfolios: ${cfgErr.message}`);
      return brief;
    }
    const targetPortfolios = (portfolios ?? []) as Array<{ portfolio_id: string }>;
    if (targetPortfolios.length === 0) {
      this.logger.log('[daily-brief] no active gainers portfolio → skip persist (brief generated but not stored)');
      return brief;
    }

    const rows = targetPortfolios.map((p) => ({
      portfolio_id: p.portfolio_id,
      kind: 'daily_catalyst_brief',
      // triggered_by est NOT NULL + CHECK constraint (valeurs limitées). On
      // utilise 'autopilot_cron' (sémantique compatible : cron périodique).
      triggered_by: 'autopilot_cron',
      summary: brief.summary.slice(0, 500),
      rationale: `Gemini daily catalyst brief — provider=${llmResult.providerId} costUsd=${llmResult.costUsd.toFixed(6)}`,
      payload: {
        ...brief,
        llm_provider: llmResult.providerId,
        llm_cost_usd: llmResult.costUsd,
        llm_latency_ms: llmResult.latencyMs,
        fallback_used: llmResult.fallbackUsed,
      },
    }));

    const { error } = await this.supabase.getClient().from('lisa_decision_log').insert(rows);
    if (error) {
      this.logger.warn(`[daily-brief] persist failed: ${error.message}`);
    } else {
      this.logger.log(
        `[daily-brief] persisted ${rows.length}× (events=${brief.macro_events?.length ?? 0} watch=${brief.tickers_to_watch?.length ?? 0} avoid=${brief.tickers_to_avoid?.length ?? 0})`,
      );
    }
    return brief;
  }

  /** Lit le dernier brief depuis decision_log. Null si aucun. */
  async getLatestBrief(): Promise<DailyCatalystBrief | null> {
    if (!this.supabase.isReady()) return null;
    const { data, error } = await this.supabase
      .getClient()
      .from('lisa_decision_log')
      .select('timestamp, payload')
      .eq('kind', 'daily_catalyst_brief')
      .order('timestamp', { ascending: false })
      .limit(1);
    if (error || !data || data.length === 0) return null;
    const p = (data[0] as { payload?: Record<string, unknown> }).payload ?? {};
    return p as unknown as DailyCatalystBrief;
  }

  /** Parse JSON robuste — tolère markdown fences si Gemini en met malgré le prompt. */
  parseBriefJson(content: string, dateFallback: string): DailyCatalystBrief | null {
    const stripped = content
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```\s*$/i, '')
      .trim();
    try {
      const parsed = JSON.parse(stripped) as Partial<DailyCatalystBrief>;
      if (!parsed || typeof parsed !== 'object') return null;
      if (typeof parsed.summary !== 'string') return null;
      return {
        date: parsed.date ?? dateFallback,
        macro_events: Array.isArray(parsed.macro_events) ? parsed.macro_events.slice(0, 10) : [],
        tickers_to_watch: Array.isArray(parsed.tickers_to_watch) ? parsed.tickers_to_watch.slice(0, 10) : [],
        tickers_to_avoid: Array.isArray(parsed.tickers_to_avoid) ? parsed.tickers_to_avoid.slice(0, 10) : [],
        sectors_in_focus: Array.isArray(parsed.sectors_in_focus) ? parsed.sectors_in_focus.slice(0, 10) : [],
        summary: parsed.summary,
      };
    } catch {
      return null;
    }
  }
}
