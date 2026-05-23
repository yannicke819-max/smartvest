/**
 * Gemini Risk Manager — exit-side LLM thesis integrity check.
 *
 * Hypothèse (audit 23/05) : 94 stops historiques mean -2.63 % = -$3,503 sum.
 * Si Gemini sort 30 % d'entre eux 0.5 % plus tôt sur lecture news/macro live,
 * c'est ~+$525 économisés sur sample = +$3,000-5,000/an annualisé.
 *
 * Approche INVERSÉE : pas un signal d'entrée (saturé sur retail momentum),
 * mais un signal de SORTIE prématurée quand la thèse est cassée.
 *
 * Architecture :
 *   - Cron toutes les 5 min : pour chaque position ouverte, fetch 60min news+macro
 *   - Appel Gemini Flash Lite : "thèse encore valide ? yes/no + raison"
 *   - Si no → écrit decision_log kind='risk_manager_thesis_broken'
 *   - V1 SHADOW : log only. V2 (futur PR) : exit autom si confidence>0.8
 *
 * Coût : $0.0001 × 12/h × 24h × 3 positions = $0.09/jour max
 *
 * Gating : GEMINI_RISK_MANAGER_ENABLED (default false). Sans flag, no-op.
 */

import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../../../supabase/supabase.service';
import { ScannerLlmRouterService } from '../scanner-llm-router.service';
import { EodhdNewsService } from '../eodhd-news.service';

export type ThesisVerdict = 'valid' | 'broken' | 'unclear';

export interface RiskAssessment {
  positionId: string;
  symbol: string;
  verdict: ThesisVerdict;
  confidence: number; // 0..1
  reason: string;
  newsCount: number;
  llmCostUsd: number;
}

const SYSTEM_PROMPT = `You are a risk manager for an automated momentum trading system.
You evaluate if the original thesis behind an OPEN long position is still valid given recent news/events.

Output STRICT JSON only:
{
  "verdict": "valid" | "broken" | "unclear",
  "confidence": 0.0-1.0,
  "reason": "short sentence max 80 chars"
}

Rules:
- "broken" = clear negative catalyst (downgrade, profit warning, regulatory action, sector rout)
- "unclear" = mixed signals or no fresh news
- "valid" = positive or neutral context, no break in original thesis
- Be conservative on "broken" (false positives = early exits = losses)
- confidence < 0.7 should default to "unclear"`;

@Injectable()
export class GeminiRiskManagerService {
  private readonly logger = new Logger(GeminiRiskManagerService.name);
  private readonly enabled: boolean;

  constructor(
    private readonly config: ConfigService,
    private readonly supabase: SupabaseService,
    private readonly llm: ScannerLlmRouterService,
    private readonly eodhdNews: EodhdNewsService,
  ) {
    this.enabled = (this.config.get<string>('GEMINI_RISK_MANAGER_ENABLED') ?? 'false').toLowerCase() === 'true';
    if (this.enabled) {
      this.logger.log('[risk-manager] ENABLED — cron */5min on open positions');
    }
  }

  /** Cron toutes les 5 min — eval thèse pour chaque position open. */
  @Cron('*/5 * * * *')
  async cronEvalOpenPositions(): Promise<void> {
    if (!this.enabled) return;
    if (!this.supabase.isReady()) return;
    try {
      const positions = await this.fetchOpenPositions();
      if (positions.length === 0) return;
      this.logger.log(`[risk-manager] eval ${positions.length} open positions`);
      for (const pos of positions) {
        await this.assessThesis(pos).catch((e) => {
          this.logger.warn(`[risk-manager] ${pos.symbol} assessment failed: ${String(e).slice(0, 200)}`);
        });
      }
    } catch (e) {
      this.logger.warn(`[risk-manager] cron failed: ${String(e).slice(0, 200)}`);
    }
  }

  private async fetchOpenPositions(): Promise<Array<{ id: string; symbol: string; asset_class: string; entry_timestamp: string; entry_price: number }>> {
    const { data, error } = await this.supabase
      .getClient()
      .from('lisa_positions')
      .select('id, symbol, asset_class, entry_timestamp, entry_price')
      .eq('status', 'open')
      .limit(20);
    if (error || !data) return [];
    return data as Array<{ id: string; symbol: string; asset_class: string; entry_timestamp: string; entry_price: number }>;
  }

  async assessThesis(pos: { id: string; symbol: string; asset_class: string; entry_timestamp: string }): Promise<RiskAssessment | null> {
    // Pull news des 60 dernières min sur le ticker
    const news = await this.eodhdNews.getRecentNewsForTicker(pos.symbol, 1).catch(() => []);
    const newsBlock = news.length > 0
      ? news.slice(0, 5).map((n) => {
          const pol = typeof n.sentiment_polarity === 'number' ? `pol=${n.sentiment_polarity.toFixed(2)}` : '';
          return `- ${n.title.slice(0, 100)} ${pol}`;
        }).join('\n')
      : '(no recent news)';

    const ageMin = Math.floor((Date.now() - new Date(pos.entry_timestamp).getTime()) / 60_000);
    const userPrompt =
      `Open long position: ${pos.symbol} (${pos.asset_class}), opened ${ageMin}min ago.\n\n` +
      `Recent news (last 60min):\n${newsBlock}\n\n` +
      `Is the original momentum thesis still valid? Output strict JSON only.`;

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

    const parsed = GeminiRiskManagerService.parseVerdict(llmResult.content);
    if (!parsed) return null;

    const assessment: RiskAssessment = {
      positionId: pos.id,
      symbol: pos.symbol,
      verdict: parsed.verdict,
      confidence: parsed.confidence,
      reason: parsed.reason,
      newsCount: news.length,
      llmCostUsd: llmResult.costUsd,
    };

    // Log SHADOW : juste audit, pas d'action sur le trade en V1
    if (parsed.verdict === 'broken' && parsed.confidence >= 0.7) {
      await this.persistAssessment(assessment);
      this.logger.warn(`[risk-manager] ${pos.symbol} THESIS_BROKEN conf=${parsed.confidence.toFixed(2)} — ${parsed.reason}`);
    }
    return assessment;
  }

  static parseVerdict(content: string): { verdict: ThesisVerdict; confidence: number; reason: string } | null {
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
      const obj = JSON.parse(content.slice(start, end + 1)) as { verdict?: string; confidence?: number; reason?: string };
      const v = obj.verdict as ThesisVerdict;
      if (v !== 'valid' && v !== 'broken' && v !== 'unclear') return null;
      const c = typeof obj.confidence === 'number' ? Math.max(0, Math.min(1, obj.confidence)) : 0;
      const r = typeof obj.reason === 'string' ? obj.reason.slice(0, 200) : '';
      return { verdict: v, confidence: c, reason: r };
    } catch {
      return null;
    }
  }

  private async persistAssessment(a: RiskAssessment): Promise<void> {
    if (!this.supabase.isReady()) return;
    try {
      // Use a portfolio_id : on récupère le portfolio_id de la position
      const { data: pos } = await this.supabase
        .getClient()
        .from('lisa_positions')
        .select('portfolio_id')
        .eq('id', a.positionId)
        .single();
      const portfolioId = (pos as { portfolio_id?: string } | null)?.portfolio_id;
      if (!portfolioId) return;
      await this.supabase
        .getClient()
        .from('lisa_decision_log')
        .insert({
          portfolio_id: portfolioId,
          kind: 'risk_manager_thesis_broken',
          triggered_by: 'autopilot_cron',
          summary: `[RISK_MGR] ${a.symbol} thèse cassée conf=${a.confidence.toFixed(2)}`,
          rationale: `${a.reason} (newsCount=${a.newsCount}, cost=$${a.llmCostUsd.toFixed(6)})`,
          payload: {
            position_id: a.positionId,
            symbol: a.symbol,
            verdict: a.verdict,
            confidence: a.confidence,
            reason: a.reason,
            news_count: a.newsCount,
            llm_cost_usd: a.llmCostUsd,
            mode: 'shadow_v1',
          },
        });
    } catch (e) {
      this.logger.warn(`[risk-manager] persist failed: ${String(e).slice(0, 200)}`);
    }
  }
}
