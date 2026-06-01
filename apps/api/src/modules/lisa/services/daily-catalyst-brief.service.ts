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

import { Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../../supabase/supabase.service';
import { ScannerLlmRouterService } from './scanner-llm-router.service';
import { LlmABShadowService } from './llm-ab-shadow.service';
import { dailyBriefComparator } from './llm-shadow-comparators';
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
- For "macro_events" : Use ONLY events from the VERIFIED EVENTS section.
- For "tickers_to_watch" / "tickers_to_avoid" / "sectors_in_focus" :
  Tu PEUX et DOIS proposer des sector_themes/tickers même si VERIFIED EVENTS
  est vide, basés sur le contexte général de marché. Exemples valides :
    * "Tech mega-caps (AAPL.US, NVDA.US) en focus si Fed dovish attendu"
    * "Semis (SMH.US) à éviter si Asia chip news négatif"
    * "Crypto majors (BTCUSDT, ETHUSDT) si ETF flows positifs"
    * "Energy (XLE.US) si tension Moyen-Orient"
  Le but : donner au TRADER 3-5 tickers actionnables par jour MÊME sans events
  macro hard-scheduled. Sans cette liste, le TRADER manque de contexte directionnel.
- Tickers MUST use EODHD suffix format: US (AAPL.US), LSE (BARC.LSE), PA (MC.PA),
  DE (SAP.DE), KO (005930.KO), SHG (600519.SHG), SHE (000001.SHE), HK (0700.HK),
  T (7203.T). Crypto: BTCUSDT, ETHUSDT.
- Minimum requis : tickers_to_watch.length ≥ 2, sectors_in_focus.length ≥ 1.
- Maximum : 5 entries per list. No fluff.
- Pour tickers_to_avoid : si rien à éviter (marché calme), retourne [] (vide OK).
- Never invent specific earnings dates not in the verified context (mais tu PEUX
  citer des sector themes/rotations sans events spécifiques).`;

@Injectable()
export class DailyCatalystBriefService {
  private readonly logger = new Logger(DailyCatalystBriefService.name);
  private readonly enabled: boolean;

  constructor(
    private readonly config: ConfigService,
    private readonly supabase: SupabaseService,
    private readonly llm: ScannerLlmRouterService,
    private readonly economicEvents: EodhdEconomicEventsService,
    // PR #523 — A/B shadow Pro/Flash/Mistral pour brief news
    @Optional() private readonly llmABShadow?: LlmABShadowService,
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

    // PR #523 — A/B shadow fire-and-forget. Brief output = JSON macro events.
    // Comparator sémantique Jaccard sur events[].event (default text-match donnait
    // 0% concordance malgré contenu substantiellement identique, cf. audit 01/06).
    void this.llmABShadow?.recordShadow({
      callSite: 'daily_brief',
      systemPrompt: SYSTEM_PROMPT,
      userPrompt,
      applied: {
        providerId: llmResult.providerId,
        content: llmResult.content,
        costUsd: llmResult.costUsd,
        latencyMs: llmResult.latencyMs,
        parseOk: brief !== null,
      },
      maxTokens: 1200,
      temperature: 0.2,
      comparator: dailyBriefComparator,
    });

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

  /**
   * Parse JSON robuste — 2 stratégies :
   *   1) Strip fences markdown + JSON.parse direct (cas nominal du prompt)
   *   2) Fallback : extraire le 1er bloc `{...}` balanced de la réponse
   *      (cas Gemini qui ajoute prose avant/après malgré l'instruction)
   */
  parseBriefJson(content: string, dateFallback: string): DailyCatalystBrief | null {
    const candidates: string[] = [];
    const stripped = content
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```\s*$/i, '')
      .trim();
    candidates.push(stripped);
    const balanced = DailyCatalystBriefService.extractFirstBalancedObject(content);
    if (balanced && balanced !== stripped) candidates.push(balanced);

    for (const candidate of candidates) {
      try {
        const parsed = JSON.parse(candidate) as Partial<DailyCatalystBrief>;
        if (!parsed || typeof parsed !== 'object') continue;
        if (typeof parsed.summary !== 'string') continue;
        return {
          date: parsed.date ?? dateFallback,
          macro_events: Array.isArray(parsed.macro_events) ? parsed.macro_events.slice(0, 10) : [],
          tickers_to_watch: Array.isArray(parsed.tickers_to_watch) ? parsed.tickers_to_watch.slice(0, 10) : [],
          tickers_to_avoid: Array.isArray(parsed.tickers_to_avoid) ? parsed.tickers_to_avoid.slice(0, 10) : [],
          sectors_in_focus: Array.isArray(parsed.sectors_in_focus) ? parsed.sectors_in_focus.slice(0, 10) : [],
          summary: parsed.summary,
        };
      } catch {
        continue;
      }
    }
    return null;
  }

  /**
   * Extrait le 1er objet JSON balanced d'une chaîne. Gère strings/escapes pour
   * ne pas compter les `{` `}` à l'intérieur de literals string. Retourne null
   * si pas d'objet balanced trouvé.
   */
  static extractFirstBalancedObject(input: string): string | null {
    const start = input.indexOf('{');
    if (start < 0) return null;
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = start; i < input.length; i++) {
      const ch = input[i];
      if (escape) {
        escape = false;
        continue;
      }
      if (inString) {
        if (ch === '\\') escape = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) return input.slice(start, i + 1);
      }
    }
    return null;
  }
}
