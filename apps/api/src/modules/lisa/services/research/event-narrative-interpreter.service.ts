/**
 * Event Narrative Interpreter — lit le sous-texte des macro releases en temps
 * réel pour identifier le ton (hawkish/dovish/neutral) AVANT que le marché
 * digère.
 *
 * Hypothèse : 4-8 macro events majeurs/mois × edge moyen 0.4% sur la jambe
 * correcte × $5000 notional = +$80-160/mois. Edge accessible UNIQUEMENT à
 * un trader avec LLM bon marché (Gemini Flash Lite $0.0001/appel) car :
 *   - HFT : LLM trop lent (1.6s latence). Ils tradent les 100ms.
 *   - Institutionnel : compliance, processus humain
 *   - Retail : pas accès LLM bon marché en boucle automatique
 *
 * Approche : pour les événements HIGH-impact (PCE, FOMC, NFP, CPI) qui
 * viennent de publier (T+2 à T+30 min), récupérer le texte officiel +
 * réaction marché immédiate, demander à Gemini :
 *   "Au-delà du chiffre publié, le ton/contexte est-il hawkish, dovish ou neutral ?"
 *
 * Le résultat est loggué dans decision_log kind='event_narrative_interpretation'.
 * Le trader humain (ou un futur trigger automatique) peut l'utiliser pour
 * ajuster les positions macro-sensibles.
 *
 * V1 SHADOW : log uniquement. V2 : auto-action sur QQQ/TLT/DXY.
 *
 * Gating : EVENT_NARRATIVE_INTERPRETER_ENABLED (default false).
 */

import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../../../supabase/supabase.service';
import { ScannerLlmRouterService } from '../scanner-llm-router.service';
import { EodhdEconomicEventsService } from '../eodhd-economic-events.service';

export type ToneVerdict = 'hawkish' | 'dovish' | 'neutral' | 'mixed';

export interface NarrativeInterpretation {
  event_name: string;
  event_country: string;
  event_date: string;
  actual: number | null;
  estimate: number | null;
  tone: ToneVerdict;
  market_implication: string;
  confidence: number;
  llm_cost_usd: number;
}

const SYSTEM_PROMPT = `You are a senior macro analyst interpreting just-released economic data.

You receive: event name, country, actual value, estimate, previous.
You must judge the TONE beyond the simple beat/miss :
  - "hawkish" = bullish USD / bearish bonds / bearish growth assets (Fed will hike/hold)
  - "dovish" = bearish USD / bullish bonds / bullish growth assets (Fed will cut)
  - "neutral" = in-line, no policy implication
  - "mixed" = conflicting signals (e.g. headline beat but core miss)

Output STRICT JSON only:
{
  "tone": "hawkish" | "dovish" | "neutral" | "mixed",
  "market_implication": "1 sentence on which asset to favor",
  "confidence": 0.0-1.0
}

Be precise. Calibrate confidence : 0.9+ only when crystal clear.`;

@Injectable()
export class EventNarrativeInterpreterService {
  private readonly logger = new Logger(EventNarrativeInterpreterService.name);
  private readonly enabled: boolean;

  /** Cache des events déjà interprétés pour éviter doubles appels. */
  private interpretedEvents = new Set<string>();

  constructor(
    private readonly config: ConfigService,
    private readonly supabase: SupabaseService,
    private readonly llm: ScannerLlmRouterService,
    private readonly economicEvents: EodhdEconomicEventsService,
  ) {
    this.enabled = (this.config.get<string>('EVENT_NARRATIVE_INTERPRETER_ENABLED') ?? 'false').toLowerCase() === 'true';
    if (this.enabled) {
      this.logger.log('[narrative] ENABLED — scan recent events every 10min');
    }
  }

  /** Toutes les 10 min — scan events publiés dans les 60 dernières min. */
  @Cron('*/10 * * * *')
  async cronInterpretRecentEvents(): Promise<void> {
    if (!this.enabled) return;
    if (!this.supabase.isReady()) return;
    try {
      const candidates = await this.fetchRecentlyPublished();
      const newEvents = candidates.filter((e) => !this.interpretedEvents.has(this.eventKey(e)));
      if (newEvents.length === 0) return;
      this.logger.log(`[narrative] ${newEvents.length} new event(s) to interpret`);
      for (const ev of newEvents) {
        await this.interpretEvent(ev).catch((e) => {
          this.logger.warn(`[narrative] interpret failed: ${String(e).slice(0, 200)}`);
        });
      }
    } catch (e) {
      this.logger.warn(`[narrative] cron failed: ${String(e).slice(0, 200)}`);
    }
  }

  private async fetchRecentlyPublished(): Promise<Array<{ event_name: string; country: string; event_date: string; actual: number | null; estimate: number | null; previous: number | null; importance: string | null }>> {
    // Events HIGH-impact des 60 dernières minutes avec `actual` non null = publiés
    const cutoffPast = new Date(Date.now() - 60 * 60_000).toISOString();
    const now = new Date().toISOString();
    const { data, error } = await this.supabase
      .getClient()
      .from('eodhd_economic_events')
      .select('event_name, country, event_date, actual, estimate, previous, importance')
      .gte('event_date', cutoffPast)
      .lte('event_date', now)
      .in('country', ['US', 'EU', 'UK', 'JP', 'DE'])
      .not('actual', 'is', null)
      .order('event_date', { ascending: false })
      .limit(10);
    if (error || !data) return [];

    // Filtre les events qui matchent un type "high-impact" (heuristique nom)
    const HIGH_IMPACT_PATTERNS = /\b(FOMC|Fed|PCE|CPI|Non[- ]Farm|NFP|GDP|Unemployment|Retail Sales|Industrial Production|ISM|ECB Rate|BoE Rate|BoJ Rate)\b/i;
    return (data as Array<{ event_name: string; country: string; event_date: string; actual: number | null; estimate: number | null; previous: number | null; importance: string | null }>)
      .filter((e) => HIGH_IMPACT_PATTERNS.test(e.event_name));
  }

  private eventKey(e: { event_name: string; country: string; event_date: string }): string {
    return `${e.country}|${e.event_name}|${e.event_date}`;
  }

  async interpretEvent(ev: { event_name: string; country: string; event_date: string; actual: number | null; estimate: number | null; previous: number | null }): Promise<NarrativeInterpretation | null> {
    const userPrompt =
      `Macro event just released:\n` +
      `- Name: ${ev.event_name}\n` +
      `- Country: ${ev.country}\n` +
      `- Time: ${ev.event_date}\n` +
      `- Actual: ${ev.actual ?? 'n/a'}\n` +
      `- Estimate: ${ev.estimate ?? 'n/a'}\n` +
      `- Previous: ${ev.previous ?? 'n/a'}\n\n` +
      `Interpret the tone. Output strict JSON only.`;

    let llmResult;
    try {
      llmResult = await this.llm.call({
        system: SYSTEM_PROMPT,
        user: userPrompt,
        temperature: 0.1,
        maxTokens: 200,
        timeoutMs: 8000,
      });
    } catch {
      return null;
    }

    const parsed = EventNarrativeInterpreterService.parseToneJson(llmResult.content);
    if (!parsed) return null;

    const interp: NarrativeInterpretation = {
      event_name: ev.event_name,
      event_country: ev.country,
      event_date: ev.event_date,
      actual: ev.actual,
      estimate: ev.estimate,
      tone: parsed.tone,
      market_implication: parsed.market_implication,
      confidence: parsed.confidence,
      llm_cost_usd: llmResult.costUsd,
    };

    this.interpretedEvents.add(this.eventKey(ev));
    await this.persistInterpretation(interp);
    this.logger.log(`[narrative] ${ev.country} ${ev.event_name} → tone=${parsed.tone} conf=${parsed.confidence.toFixed(2)} — ${parsed.market_implication.slice(0, 60)}`);
    return interp;
  }

  static parseToneJson(content: string): { tone: ToneVerdict; market_implication: string; confidence: number } | null {
    const start = content.indexOf('{');
    if (start < 0) return null;
    let depth = 0;
    let inStr = false;
    let esc = false;
    let end = -1;
    for (let i = start; i < content.length; i++) {
      const ch = content[i];
      if (esc) { esc = false; continue; }
      if (inStr) {
        if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end < 0) return null;
    try {
      const obj = JSON.parse(content.slice(start, end + 1)) as { tone?: string; market_implication?: string; confidence?: number };
      const t = obj.tone as ToneVerdict;
      if (!['hawkish', 'dovish', 'neutral', 'mixed'].includes(t)) return null;
      const c = typeof obj.confidence === 'number' ? Math.max(0, Math.min(1, obj.confidence)) : 0;
      const m = typeof obj.market_implication === 'string' ? obj.market_implication.slice(0, 250) : '';
      return { tone: t, market_implication: m, confidence: c };
    } catch {
      return null;
    }
  }

  private async persistInterpretation(i: NarrativeInterpretation): Promise<void> {
    if (!this.supabase.isReady()) return;
    try {
      await this.supabase
        .getClient()
        .from('lisa_decision_log')
        .insert({
          portfolio_id: null,
          kind: 'event_narrative_interpretation',
          triggered_by: 'autopilot_cron',
          summary: `[NARRATIVE] ${i.event_country} ${i.event_name} → ${i.tone} conf=${i.confidence.toFixed(2)}`,
          rationale: i.market_implication,
          payload: { ...i, mode: 'shadow_v1' },
        });
    } catch (e) {
      this.logger.warn(`[narrative] persist failed: ${String(e).slice(0, 200)}`);
    }
  }
}
