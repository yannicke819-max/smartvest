/**
 * PositionIndicatorsTrackerService — Étape 3 (2/2) du tracker.
 *
 * Cron 2 min : pour chaque position OUVERTE (TRADER + shadows), capture un
 * snapshot complet dans position_indicators_snapshot :
 *   - prix live + PnL non réalisé
 *   - MFE/MAE PRÉCIS (cumul depuis le snapshot précédent — corrige le biais
 *     peak_pre_exit qui sous-estime via polling discret)
 *   - 18 indicateurs techniques computés sur candles 5m (helper pur)
 *   - signaux confluence (MFI/ROC) pour validation continue Phase B+
 *
 * Objectif : collecter des données PROPRES (pipeline réparé) pour A/B les
 * exits (closed_choppy afterMinutes) + calibrer les seuils indicateurs avec
 * confidence dynamique.
 *
 * Gating : POSITION_TRACKER_ENABLED=true (default false). OFF = aucune
 * écriture, aucun fetch — service inerte tant que non activé explicitement.
 *
 * Coût : 2min × ~5 positions × 4 portfolios = ~600 fetch candles/h en heures
 * marché. EODHD quota 100k/jour → ~6% max. Négligeable.
 */
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../../supabase/supabase.service';
import { LisaService } from './lisa.service';
import { IntradayProviderRouter } from './intraday-provider-router.service';
import { BinanceMarketService } from './binance-market.service';
import {
  computeIndicatorSnapshot,
  type IndicatorCandle,
} from './position-indicators.helper';

const TRACKED_PORTFOLIO_IDS = [
  'b0000001-0000-0000-0000-000000000001', // TRADER
  'a0000001-0000-0000-0000-000000000001', // HIGH
  'a0000002-0000-0000-0000-000000000002', // MIDDLE
  'a0000003-0000-0000-0000-000000000003', // SMALL
];

interface OpenPos {
  id: string;
  portfolio_id: string;
  symbol: string;
  asset_class: string | null;
  direction: string;
  entry_price: number;
  entry_timestamp: string;
  stop_loss_price: number | null;
  take_profit_price: number | null;
  persistence_score_at_entry: number | null;
  persistence_count_at_entry: string | null;
  path_eff_at_entry: number | null;
}

@Injectable()
export class PositionIndicatorsTrackerService {
  private readonly logger = new Logger(PositionIndicatorsTrackerService.name);
  private enabled = false;

  constructor(
    private readonly config: ConfigService,
    private readonly supabase: SupabaseService,
    private readonly lisa: LisaService,
    private readonly intraday: IntradayProviderRouter,
    private readonly binance: BinanceMarketService,
  ) {}

  onModuleInit(): void {
    this.enabled = (this.config.get<string>('POSITION_TRACKER_ENABLED') ?? 'false').toLowerCase() === 'true';
    if (this.enabled) {
      this.logger.log('[position-tracker] ENABLED — cron 2min, snapshot indicateurs positions ouvertes');
    }
  }

  @Cron('0 */2 * * * *', { name: 'position-indicators-tracker', timeZone: 'UTC' })
  async runCycle(): Promise<void> {
    if (!this.enabled) return;
    if (!this.supabase.isReady()) return;
    try {
      const positions = await this.fetchOpenPositions();
      if (positions.length === 0) return;
      let written = 0;
      for (const pos of positions) {
        const ok = await this.snapshotPosition(pos).catch((e) => {
          this.logger.debug(`[position-tracker] ${pos.symbol} snapshot threw: ${String(e).slice(0, 150)}`);
          return false;
        });
        if (ok) written++;
      }
      this.logger.log(`[position-tracker] cycle done — ${written}/${positions.length} snapshots written`);
    } catch (e) {
      this.logger.error(`[position-tracker] cycle exception: ${String(e).slice(0, 200)}`);
    }
  }

  private async fetchOpenPositions(): Promise<OpenPos[]> {
    const { data, error } = await this.supabase.getClient()
      .from('lisa_positions')
      .select('id, portfolio_id, symbol, asset_class, direction, entry_price, entry_timestamp, stop_loss_price, take_profit_price, persistence_score_at_entry, persistence_count_at_entry, path_eff_at_entry')
      .in('portfolio_id', TRACKED_PORTFOLIO_IDS)
      .eq('status', 'open');
    if (error) {
      this.logger.warn(`[position-tracker] fetch open positions: ${error.message}`);
      return [];
    }
    return (data ?? []) as OpenPos[];
  }

  /** Fetch candles 5m (crypto via Binance, equity via IntradayRouter). */
  private async fetchCandles(pos: OpenPos): Promise<IndicatorCandle[]> {
    const isCrypto = (pos.asset_class ?? '').startsWith('crypto');
    if (isCrypto) {
      const binSym = this.binance.toBinanceSymbol(pos.symbol);
      if (!binSym) return [];
      // 60 candles 5m = 5h d'historique (assez pour ADX/MACD/StochRSI)
      const klines = await this.binance.getKlines(binSym, '5m', 60).catch(() => null);
      if (!klines) return [];
      return klines.map((k) => ({ high: k.high, low: k.low, close: k.close, volume: k.volume }));
    }
    const series = await this.intraday.getCandles(pos.symbol, '5m', 60, { calledBy: 'position_tracker' }).catch(() => null);
    if (!series || !series.candles?.length) return [];
    return series.candles.map((c: { high: number; low: number; close: number; volume: number }) => ({ high: c.high, low: c.low, close: c.close, volume: c.volume }));
  }

  /** Lit le dernier snapshot pour cumuler MFE/MAE. */
  private async lastSnapshot(positionId: string): Promise<{ mfe_pct: number | null; mae_pct: number | null } | null> {
    const { data } = await this.supabase.getClient()
      .from('position_indicators_snapshot')
      .select('mfe_pct, mae_pct')
      .eq('position_id', positionId)
      .order('captured_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    return data ? { mfe_pct: data.mfe_pct as number | null, mae_pct: data.mae_pct as number | null } : null;
  }

  private async snapshotPosition(pos: OpenPos): Promise<boolean> {
    const entry = Number(pos.entry_price);
    const sign = pos.direction === 'short' ? -1 : 1;

    // 1. Prix live
    let livePrice: number | null = null;
    let source = 'fallback_unknown';
    try {
      const q = await this.lisa.getLivePrice(pos.symbol);
      source = q.source;
      const px = Number(q.price);
      if (Number.isFinite(px) && px > 0 && !q.source.startsWith('fallback')) livePrice = px;
    } catch { /* livePrice null */ }

    const pnlPct = livePrice !== null && entry > 0 ? (((livePrice - entry) / entry) * 100) * sign : null;
    const ageMin = (Date.now() - new Date(pos.entry_timestamp).getTime()) / 60_000;

    // 2. MFE/MAE cumulés (corrige peak_pre_exit sous-estimé)
    const prev = await this.lastSnapshot(pos.id);
    let mfePct = prev?.mfe_pct ?? null;
    let maePct = prev?.mae_pct ?? null;
    if (pnlPct !== null) {
      mfePct = mfePct === null ? pnlPct : Math.max(mfePct, pnlPct);
      maePct = maePct === null ? pnlPct : Math.min(maePct, pnlPct);
    }
    const sl = pos.stop_loss_price !== null ? Number(pos.stop_loss_price) : null;
    const slDistPct = sl !== null && entry > 0 ? Math.abs(((entry - sl) / entry) * 100) : null;
    const maeR = maePct !== null && slDistPct && slDistPct > 0 ? Math.abs(maePct) / slDistPct : null;

    // 3. Indicateurs (best-effort — NULL si candles indispo)
    const candles = await this.fetchCandles(pos);
    const ind = candles.length >= 15 ? computeIndicatorSnapshot(candles) : null;

    // 4. INSERT snapshot
    const { error } = await this.supabase.getClient()
      .from('position_indicators_snapshot')
      .insert({
        position_id: pos.id,
        portfolio_id: pos.portfolio_id,
        symbol: pos.symbol,
        live_price: livePrice,
        live_price_source: source,
        entry_price: entry,
        pnl_pct: pnlPct !== null ? round2(pnlPct) : null,
        pnl_usd: null, // notional non chargé ici (UI le calcule) — optionnel
        age_minutes: round2(ageMin),
        mfe_pct: mfePct !== null ? round2(mfePct) : null,
        mae_pct: maePct !== null ? round2(maePct) : null,
        mae_r_ratio: maeR !== null ? round2(maeR) : null,
        rsi14: ind?.rsi14 ?? null,
        macd: ind?.macd ?? null,
        macd_signal: ind?.macd_signal ?? null,
        macd_hist: ind?.macd_hist ?? null,
        atr14: ind?.atr14 ?? null,
        atr14_pct: ind?.atr14_pct ?? null,
        bb_upper: ind?.bb_upper ?? null,
        bb_middle: ind?.bb_middle ?? null,
        bb_lower: ind?.bb_lower ?? null,
        bb_pct_b: ind?.bb_pct_b ?? null,
        stoch_rsi_k: ind?.stoch_rsi_k ?? null,
        stoch_rsi_d: ind?.stoch_rsi_d ?? null,
        adx14: ind?.adx14 ?? null,
        cci20: ind?.cci20 ?? null,
        obv: ind?.obv ?? null,
        obv_trend_pct: ind?.obv_trend_pct ?? null,
        vwap: ind?.vwap ?? null,
        ema9: ind?.ema9 ?? null,
        ema21: ind?.ema21 ?? null,
        mfi14: ind?.mfi14 ?? null,
        roc5: ind?.roc5 ?? null,
        persistence_score: pos.persistence_score_at_entry,
        persistence_count: pos.persistence_count_at_entry,
        path_efficiency: pos.path_eff_at_entry,
        raw_payload: { candle_count: candles.length },
      });
    if (error) {
      this.logger.warn(`[position-tracker] ${pos.symbol} insert failed: ${error.message}`);
      return false;
    }
    return true;
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
