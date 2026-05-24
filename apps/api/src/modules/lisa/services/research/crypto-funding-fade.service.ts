/**
 * Crypto Funding Rate Fade — squeeze detection sur perpetuals Binance.
 *
 * Hypothèse : funding rate > +0.05 % (longs paient shorts >0.15 %/jour) signale
 * un over-leverage long → squeeze imminent à la moindre baisse. Edge documenté
 * sur BTC/ETH/SOL, ~2-4 setups par mois, edge moyen 0.8-1.5 %.
 *
 * V1 SHADOW : log uniquement, pas de short live. Permet de valider l'edge
 * sur 30 jours avant d'autoriser l'exécution. V2 (futur PR) : entry SHORT
 * via paper-broker quand funding > threshold ET RSI(1h) > 70.
 *
 * Gating : CRYPTO_FUNDING_FADE_ENABLED (default false). Endpoint Binance
 * public, pas de clé API requise.
 */

import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../../../supabase/supabase.service';

const FUNDING_API = 'https://fapi.binance.com/fapi/v1/premiumIndex';
const FETCH_TIMEOUT_MS = 5000;
const TRACKED_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT'];

export interface FundingSignal {
  symbol: string;
  funding_rate: number;
  mark_price: number;
  estimated_apr_pct: number;
  trigger: 'above_threshold' | 'below_threshold' | 'neutral';
  fetched_at: string;
}

interface BinancePremiumIndex {
  symbol: string;
  lastFundingRate: string;
  markPrice: string;
  nextFundingTime: number;
}

@Injectable()
export class CryptoFundingFadeService {
  private readonly logger = new Logger(CryptoFundingFadeService.name);
  private readonly enabled: boolean;
  private readonly threshold: number;

  constructor(
    private readonly config: ConfigService,
    private readonly supabase: SupabaseService,
  ) {
    this.enabled = (this.config.get<string>('CRYPTO_FUNDING_FADE_ENABLED') ?? 'false').toLowerCase() === 'true';
    const tRaw = this.config.get<string>('CRYPTO_FUNDING_FADE_THRESHOLD');
    const t = tRaw != null ? Number.parseFloat(tRaw) : NaN;
    this.threshold = Number.isFinite(t) ? t : 0.0005; // 0.05 % per 8h cycle
    if (this.enabled) {
      this.logger.log(`[funding-fade] ENABLED — threshold=${(this.threshold * 100).toFixed(4)}% per cycle, ${TRACKED_SYMBOLS.length} symbols`);
    }
  }

  /** Cron toutes les 10 min — funding rate refresh + signal detection. */
  @Cron('*/10 * * * *')
  async cronCheckFunding(): Promise<void> {
    if (!this.enabled) return;
    try {
      const signals = await this.fetchAndAnalyze();
      const triggers = signals.filter((s) => s.trigger !== 'neutral');
      if (triggers.length > 0) {
        await this.persistSignals(triggers);
        this.logger.log(`[funding-fade] ${triggers.length} signal(s) detected (out of ${signals.length} checked)`);
      }
    } catch (e) {
      this.logger.warn(`[funding-fade] cron failed: ${String(e).slice(0, 200)}`);
    }
  }

  async fetchAndAnalyze(): Promise<FundingSignal[]> {
    const results: FundingSignal[] = [];
    for (const symbol of TRACKED_SYMBOLS) {
      const sig = await this.fetchOne(symbol).catch((): null => null);
      if (sig) results.push(sig);
    }
    return results;
  }

  private async fetchOne(symbol: string): Promise<FundingSignal | null> {
    const url = `${FUNDING_API}?symbol=${encodeURIComponent(symbol)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return null;
    const data = (await res.json()) as BinancePremiumIndex;
    const fundingRate = Number.parseFloat(data.lastFundingRate);
    const markPrice = Number.parseFloat(data.markPrice);
    if (!Number.isFinite(fundingRate) || !Number.isFinite(markPrice)) return null;

    // APR estim = funding rate × 3 cycles/jour × 365 jours
    const apr = fundingRate * 3 * 365 * 100;
    const trigger = CryptoFundingFadeService.classifyTrigger(fundingRate, this.threshold);

    return {
      symbol,
      funding_rate: fundingRate,
      mark_price: markPrice,
      estimated_apr_pct: Math.round(apr * 100) / 100,
      trigger,
      fetched_at: new Date().toISOString(),
    };
  }

  /**
   * Pure classifier — exposable pour tests.
   * trigger:
   *   above_threshold : funding > +threshold → longs over-leveraged, fade SHORT
   *   below_threshold : funding < -threshold → shorts over-leveraged, fade LONG (rare)
   *   neutral : entre les deux bornes
   */
  static classifyTrigger(rate: number, threshold: number): FundingSignal['trigger'] {
    if (rate > threshold) return 'above_threshold';
    if (rate < -threshold) return 'below_threshold';
    return 'neutral';
  }

  private async persistSignals(signals: FundingSignal[]): Promise<void> {
    if (!this.supabase.isReady()) return;
    // Reuse lisa_decision_log avec kind dédié plutôt qu'une nouvelle migration.
    // Si volume devient gros (>1k/jour), créer crypto_funding_signals table.
    const rows = signals.map((s) => ({
      portfolio_id: null,
      kind: 'crypto_funding_signal',
      triggered_by: 'autopilot_cron',
      summary: `[FUNDING_FADE] ${s.symbol} rate=${(s.funding_rate * 100).toFixed(4)}% APR=${s.estimated_apr_pct}% trigger=${s.trigger}`,
      rationale: `Shadow v1 — fade signal detected. mark=$${s.mark_price.toFixed(2)}`,
      payload: { ...s, mode: 'shadow_v1' },
    }));
    const { error } = await this.supabase.getClient().from('lisa_decision_log').insert(rows);
    if (error) {
      this.logger.warn(`[funding-fade] persist failed: ${error.message}`);
    }
  }
}
